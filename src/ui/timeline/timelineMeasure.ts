import type {
  RunEvent,
  ShellEvent,
  RunProgressBlock,
  RunResponseSegment,
  RunToolActivity,
} from "../../session/types.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { getAssistantContent, getResponseSegmentText, getRunPlanText } from "../../session/types.js";
import { normalizeCommand, getFriendlyActionLabel } from "../input/commandNormalize.js";
import { formatTerminalAnswerInline } from "../render/terminalAnswerFormat.js";
import { RUN_OUTPUT_TRUNCATION_NOTICE } from "../../session/chatLifecycle.js";
import { sanitizeTerminalLines, sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { clampVisualText, transcriptContentIndent } from "../layout.js";
import type { Segment } from "../render/Markdown.js";
import { classifyOutput, formatForBox, normalizeOutput, sanitizeOutput, sanitizeStreamChunk } from "../render/outputPipeline.js";
import { maybeRenderDiff, type DiffRenderLineType } from "../render/diffRenderer.js";
import {
  formatProgressBlockBodyLines,
  getProgressUpdateCount,
  selectVisibleProgressBlocks,
  type VisibleProgressBlock,
} from "./progressEntries.js";
import { selectVisibleRunActivity } from "./runActivityView.js";
import { coalesceConsecutiveThinking } from "./streamCoalesce.js";
import { getTextUnits, getTextWidth, wrapPlainText, wrapCommandText, splitTextAtColumn } from "../render/textLayout.js";
import type { RenderTimelineItem } from "./Timeline.js";
import { normalizePlanReviewMarkdown } from "../../core/workspace/planStorage.js";
import { LOGO_COMPACT, LOGO_COMPACT_MIN_COLS, LOGO_LARGE_MIN_COLS, selectLogoVariant } from "../render/logoVariants.js";

// ─── Exported types ───────────────────────────────────────────────────────────

export type TimelineTone =
  | "text"
  | "dim"
  | "muted"
  | "accent"
  | "info"
  | "error"
  | "warning"
  | "success"
  | "borderSubtle"
  | "borderActive"
  | "panel"
  | "star"
  | "logoPrimary"
  | "logoSecondary"
  | "logoShadow";

export interface TimelineRowSpan {
  text: string;
  tone?: TimelineTone;
  bold?: boolean;
  backgroundTone?: TimelineTone;
}

export interface TimelineRow {
  key: string;
  spans: TimelineRowSpan[];
}

export interface BuiltTimelineItem {
  key: string;
  rows: TimelineRow[];
  rowCount: number;
}

export interface TimelineSnapshot {
  items: BuiltTimelineItem[];
  rows: TimelineRow[];
  totalRows: number;
  itemCount: number;
}

export interface StableTimelineSnapshot {
  snapshot: TimelineSnapshot;
  frozenRows: TimelineRow[];
  liveRows: TimelineRow[];
}

export interface NativeTranscriptRowItem {
  key: string;
  rows: TimelineRow[];
}

export interface NativeTranscriptParts {
  staticItems: NativeTranscriptRowItem[];
  liveRows: TimelineRow[];
}

// ─── Internal types & constants ──────────────────────────────────────────────

interface MarkdownInlinePart {
  kind: "text" | "code" | "bold";
  text: string;
}

const MAX_SHELL_FAILURE_EXCERPT_LINES = 3;
const MAX_VISIBLE_PROGRESS_ENTRIES = 3;
const COMPACT_PROCESSING_BODY_LINE_CAP = 4;
const COMPACT_STREAMING_TAIL_CAP = 6;
const VISIBLE_THINKING_SOURCES = new Set(["reasoning", "todo"]);
// Logo rows for the intro item — selected dynamically from logoVariants.ts so
// the dead-code intro path stays consistent with the live TopHeader rendering.

// Matches sentence-ending punctuation followed (optionally after whitespace) by
// a capital letter starting a new word. Requires [A-Z] to be followed by [a-z]
// OR to be a standalone "I" (I'm / I've / I ) so abbreviations like U.S.A.
// and Python class names like foo.BarClass are left alone — the lookahead
// fails when the capital is followed by another uppercase or punctuation.
const SENTENCE_WALL_SPLIT_RE = /([.!?])\s*(?=(?:I(?:['\u2019]|\s)|[A-Z][a-z]))/g;

function splitSentenceWall(text: string): string {
  if (!text) return text;
  // Preserve code fences: only transform outside ``` regions.
  const parts = text.split("```");
  return parts
    .map((part, index) => (index % 2 === 0 ? part.replace(SENTENCE_WALL_SPLIT_RE, "$1\n\n") : part))
    .join("```");
}

// ─── Span & row primitives ────────────────────────────────────────────────────

function createSpan(
  text: string,
  tone?: TimelineTone,
  options: Pick<TimelineRowSpan, "bold" | "backgroundTone"> = {},
): TimelineRowSpan {
  return {
    text,
    tone,
    bold: options.bold,
    backgroundTone: options.backgroundTone,
  };
}

function spansEqual(left: TimelineRowSpan | undefined, right: TimelineRowSpan): boolean {
  return left?.tone === right.tone
    && left?.bold === right.bold
    && left?.backgroundTone === right.backgroundTone;
}

function appendSpan(target: TimelineRowSpan[], span: TimelineRowSpan) {
  if (!span.text) return;
  const previous = target[target.length - 1];
  if (previous && spansEqual(previous, span)) {
    previous.text += span.text;
    return;
  }
  target.push({ ...span });
}

function cloneSpan(span: TimelineRowSpan, text = span.text): TimelineRowSpan {
  return {
    text,
    tone: span.tone,
    bold: span.bold,
    backgroundTone: span.backgroundTone,
  };
}

function getSpansWidth(spans: TimelineRowSpan[]): number {
  return spans.reduce((width, span) => width + getTextWidth(span.text), 0);
}

function padSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  const safeWidth = Math.max(0, width);
  const next = spans.map((span) => ({ ...span }));
  const currentWidth = getSpansWidth(next);
  if (currentWidth < safeWidth) {
    appendSpan(next, createSpan(" ".repeat(safeWidth - currentWidth)));
  }
  return next;
}

/**
 * Truncates a span list to at most `width` display columns, cutting the
 * overflowing span on a grapheme/display-width boundary. Used as a safety net so
 * a too-wide content row can never push a card border past its declared width.
 */
function clampSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  const safeWidth = Math.max(0, width);
  const result: TimelineRowSpan[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= safeWidth) break;
    const spanWidth = getTextWidth(span.text);
    if (used + spanWidth <= safeWidth) {
      result.push({ ...span });
      used += spanWidth;
      continue;
    }
    const fitted = splitTextAtColumn(span.text, safeWidth - used).before;
    if (fitted) {
      result.push(cloneSpan(span, fitted));
    }
    break;
  }
  return result;
}

/** Clamp a row to `width` then pad it back out so it occupies exactly `width`. */
function fitSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  return padSpansToWidth(clampSpansToWidth(spans, width), width);
}

const ROW_CONTENT_CACHE_LIMIT = 2500;
const _rowContentCache = new Map<string, TimelineRow>();

function spanCacheToken(span: TimelineRowSpan): string {
  return [
    span.text,
    span.tone ?? "",
    span.backgroundTone ?? "",
    span.bold ? "1" : "0",
  ].join("\u001f");
}

function rememberRow(cacheKey: string, row: TimelineRow): TimelineRow {
  if (_rowContentCache.has(cacheKey)) {
    _rowContentCache.delete(cacheKey);
  }
  _rowContentCache.set(cacheKey, row);
  if (_rowContentCache.size > ROW_CONTENT_CACHE_LIMIT) {
    const oldestKey = _rowContentCache.keys().next().value;
    if (oldestKey !== undefined) {
      _rowContentCache.delete(oldestKey);
    }
  }
  return row;
}

function createRow(key: string, spans: TimelineRowSpan[], width: number): TimelineRow {
  const paddedSpans = padSpansToWidth(spans, width);
  const cacheKey = `${key}:${width}:${paddedSpans.map(spanCacheToken).join("\u001e")}`;
  const cached = _rowContentCache.get(cacheKey);
  if (cached) {
    _rowContentCache.delete(cacheKey);
    _rowContentCache.set(cacheKey, cached);
    return cached;
  }

  return rememberRow(cacheKey, {
    key,
    spans: paddedSpans,
  });
}

const _blankRowCache = new Map<string, TimelineRow>();

function createBlankRow(key: string, width: number): TimelineRow {
  const cacheKey = `${key}:${width}`;
  let row = _blankRowCache.get(cacheKey);
  if (!row) {
    row = createRow(key, [createSpan(" ".repeat(Math.max(0, width)))], width);
    _blankRowCache.set(cacheKey, row);
  }
  return row;
}

interface StyledToken {
  text: string;
  isWhitespace: boolean;
  isNewline: boolean;
  tone?: TimelineTone;
  bold?: boolean;
  backgroundTone?: TimelineTone;
}

function flattenSpansToTokens(spans: TimelineRowSpan[]): StyledToken[] {
  const tokens: StyledToken[] = [];
  for (const span of spans) {
    const parts = span.text.split(/([ \t\n]+)/);
    for (const part of parts) {
      if (part === "") continue;
      const isNewline = part === "\n" || (part.includes("\n") && /^[\s]+$/.test(part));
      const isWhitespace = /^[ \t\n]+$/.test(part);
      tokens.push({
        text: part,
        isWhitespace,
        isNewline,
        tone: span.tone,
        bold: span.bold,
        backgroundTone: span.backgroundTone,
      });
    }
  }
  return tokens;
}

function wrapStyledSpans(spans: TimelineRowSpan[], width: number): TimelineRowSpan[][] {
  const safeWidth = Math.max(1, width);
  const rows: TimelineRowSpan[][] = [];
  let currentRow: TimelineRowSpan[] = [];
  let currentWidth = 0;

  const pushRow = () => {
    rows.push(currentRow.length > 0 ? currentRow : [createSpan("")]);
    currentRow = [];
    currentWidth = 0;
  };

  const spanFor = (token: StyledToken, text: string): TimelineRowSpan => ({
    text,
    ...(token.tone !== undefined ? { tone: token.tone } : {}),
    ...(token.bold ? { bold: token.bold } : {}),
    ...(token.backgroundTone !== undefined ? { backgroundTone: token.backgroundTone } : {}),
  });

  for (const token of flattenSpansToTokens(spans)) {
    if (token.isNewline) {
      pushRow();
      continue;
    }

    const tokenWidth = getTextWidth(token.text);

    if (token.isWhitespace) {
      if (currentWidth === 0) continue; // skip leading whitespace on a new row
      if (currentWidth + tokenWidth > safeWidth) {
        pushRow();
        continue; // drop whitespace that pushes us over the edge
      }
      appendSpan(currentRow, spanFor(token, token.text));
      currentWidth += tokenWidth;
      continue;
    }

    // Word token
    if (currentWidth + tokenWidth > safeWidth && currentWidth > 0) {
      pushRow();
    }

    // Overlong token: character-split across as many rows as needed
    if (tokenWidth > safeWidth) {
      let remaining = token.text;
      let remainingWidth = tokenWidth;
      while (remainingWidth > safeWidth - currentWidth) {
        const available = safeWidth - currentWidth;
        const split = splitTextAtColumn(remaining, available);
        if (split.before) {
          appendSpan(currentRow, spanFor(token, split.before));
        }
        pushRow();
        remaining = split.current + split.after;
        remainingWidth = getTextWidth(remaining);
      }
      if (remaining) {
        appendSpan(currentRow, spanFor(token, remaining));
        currentWidth += getTextWidth(remaining);
      }
      continue;
    }

    appendSpan(currentRow, spanFor(token, token.text));
    currentWidth += tokenWidth;
  }

  if (currentRow.length === 0 && rows.length === 0) {
    rows.push([createSpan("")]);
  } else if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function buildPrefixedContentRows(
  keyPrefix: string,
  marker: TimelineRowSpan[],
  continuationMarker: TimelineRowSpan[],
  content: TimelineRowSpan[],
  width: number,
): TimelineRow[] {
  const markerWidth = Math.max(0, getSpansWidth(marker));
  const bodyWidth = Math.max(1, width - markerWidth);
  const wrappedRows = wrapStyledSpans(content, bodyWidth);

  return wrappedRows.map((row, index) => createRow(
    `${keyPrefix}-${index}`,
    [
      ...(index === 0 ? marker : continuationMarker),
      ...padSpansToWidth(row, bodyWidth),
    ],
    width,
  ));
}

// ─── Border & card builders ───────────────────────────────────────────────────

function buildIndentedRows(
  keyPrefix: string,
  rows: TimelineRowSpan[][],
  width: number,
  indent: number,
): TimelineRow[] {
  const safeIndent = Math.max(0, indent);
  const contentWidth = Math.max(1, width - safeIndent);
  return rows.map((row, index) => createRow(
    `${keyPrefix}-${index}`,
    [
      createSpan(" ".repeat(safeIndent)),
      ...padSpansToWidth(row, contentWidth),
    ],
    width,
  ));
}

function buildPlainRows(
  keyPrefix: string,
  lines: string[],
  width: number,
  tone?: TimelineTone,
): TimelineRowSpan[][] {
  return lines.flatMap((line, index) => wrapPlainText(line, Math.max(1, width)).map((row, rowIndex) => (
    [createSpan(row || " ", tone)]
  )));
}

function buildTopBorder(width: number, title: string, rightBadge?: string): TimelineRowSpan[] {
  const safeWidth = Math.max(4, width);
  const prefixWidth = 4;
  const titleWidth = getTextWidth(title);
  const badgeWidth = rightBadge ? getTextWidth(rightBadge) : 0;
  const suffixWidth = rightBadge ? 4 : 3;
  const fillSpacerWidth = rightBadge ? 2 : 1;
  const fillCount = Math.max(1, safeWidth - prefixWidth - titleWidth - badgeWidth - suffixWidth - fillSpacerWidth);

  const spans: TimelineRowSpan[] = [
    createSpan("╭── ", "borderSubtle"),
    createSpan(title, "muted", { bold: true }),
    createSpan(rightBadge ? ` ${"─".repeat(fillCount)} ` : ` ${"─".repeat(fillCount)}`, "borderSubtle"),
  ];

  if (rightBadge) {
    spans.push(createSpan(rightBadge, "dim"));
    spans.push(createSpan(" ──╮", "borderSubtle"));
  } else {
    spans.push(createSpan("──╮", "borderSubtle"));
  }

  return spans;
}

function buildDashCardRows(params: {
  keyPrefix: string;
  width: number;
  title: string;
  rightBadge?: string;
  borderTone?: TimelineTone;
  titleTone?: TimelineTone;
  badgeTone?: TimelineTone;
  contentRows: TimelineRowSpan[][];
}): TimelineRow[] {
  const width = Math.max(4, params.width);
  const contentWidth = Math.max(1, width - 4);
  const borderTone = params.borderTone ?? "borderSubtle";
  const titleTone = params.titleTone ?? "muted";
  const badgeTone = params.badgeTone ?? "dim";
  const topBase = buildTopBorder(width, params.title, params.rightBadge);
  const topRow = topBase.map((span) => {
    if (span.tone === "muted") return { ...span, tone: titleTone };
    if (span.tone === "dim") return { ...span, tone: badgeTone };
    return { ...span, tone: borderTone };
  });

  const rows: TimelineRow[] = [createRow(`${params.keyPrefix}-top`, fitSpansToWidth(topRow, width), width)];

  params.contentRows.forEach((row, index) => {
    rows.push(createRow(
      `${params.keyPrefix}-content-${index}`,
      [
        createSpan("│ ", borderTone),
        ...fitSpansToWidth(row, contentWidth),
        createSpan(" │", borderTone),
      ],
      width,
    ));
  });

  rows.push(createRow(
    `${params.keyPrefix}-bottom`,
    [createSpan(`╰${"─".repeat(Math.max(1, width - 2))}╯`, borderTone)],
    width,
  ));

  return rows;
}

function buildPanelRows(params: {
  keyPrefix: string;
  width: number;
  title: string;
  rightTitle?: string;
  contentRows: TimelineRowSpan[][];
}): TimelineRow[] {
  const width = Math.max(10, params.width);
  const leftLabel = ` ${params.title} `;
  const rightLabel = params.rightTitle ? ` ${params.rightTitle} ` : "";
  const dashCount = Math.max(0, width - 3 - getTextWidth(leftLabel) - getTextWidth(rightLabel));
  const rows: TimelineRow[] = [
    createRow(
      `${params.keyPrefix}-top`,
      [
        createSpan("╭─", "borderActive"),
        createSpan(leftLabel, "text"),
        createSpan("─".repeat(dashCount), "borderActive"),
        ...(params.rightTitle ? [createSpan(rightLabel, "dim")] : []),
        createSpan("╮", "borderActive"),
      ],
      width,
    ),
  ];

  const contentWidth = Math.max(1, width - 4);
  params.contentRows.forEach((row, index) => {
    rows.push(createRow(
      `${params.keyPrefix}-content-${index}`,
      [
        createSpan("│ ", "borderActive"),
        ...fitSpansToWidth(row, contentWidth),
        createSpan(" │", "borderActive"),
      ],
      width,
    ));
  });

  rows.push(createRow(
    `${params.keyPrefix}-bottom`,
    [createSpan(`╰${"─".repeat(Math.max(1, width - 2))}╯`, "borderActive")],
    width,
  ));

  return rows;
}

// ─── Turn content builders ────────────────────────────────────────────────────

function buildUserInputRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow[] {
  const dim = item.renderState.opacity === "dim";
  const contentWidth = Math.max(1, width - 4);
  const lines = wrapPlainText(sanitizeTerminalOutput(item.item.user?.prompt ?? ""), Math.max(1, contentWidth - 2))
    .map((line, index) => [
      createSpan(index === 0 ? "❯ " : "  ", dim ? "dim" : "text"),
      createSpan(line || " ", dim ? "dim" : "text"),
    ]);

  return buildDashCardRows({
    keyPrefix: `${item.key}-user`,
    width,
    title: "PROMPT",
    borderTone: "borderSubtle",
    contentRows: lines,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildTaskStatusRow(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow {
  const run = item.item.run!;
  // PERF: Do NOT call Date.now() here — this function runs inside buildTimelineSnapshot
  // which is computed inside a useMemo in Timeline.tsx.  Using Date.now() prevents the
  // snapshot from ever fully stabilising, causing unnecessary downstream invalidation.
  // We use a static frame so the data-layer row is deterministic and memo-stable.
  const spinnerPlaceholder = "⠿";
  const isActive = run.status === "running";

  if (!isActive) {
    // Completed state — clean summary line
    const icon = run.status === "failed" ? "✕" : "✔";
    const iconTone: TimelineTone = run.status === "failed" ? "error" : "success";
    const label = run.status === "failed" ? "Failed" : run.status === "canceled" ? "Canceled" : "Complete";
    const durationText = run.durationMs != null ? ` • ${formatDuration(run.durationMs)}` : "";
    return createRow(
      `${item.key}-status`,
      [
        createSpan(" "),
        createSpan(`${icon} `, iconTone),
        createSpan(`${label}${durationText}`, "dim"),
      ],
      width,
    );
  }

  // Active state — static concise status. The bottom status slot owns the
  // live busy animation so transcript rows do not repaint on animation ticks.
  const statusText = item.renderState.runPhase === "streaming"
    ? "Codexa is streaming"
    : item.renderState.runPhase === "final"
      ? "Codexa response complete"
      : "Codexa is thinking";

  return createRow(
    `${item.key}-status`,
    [
      createSpan(" "),
      createSpan(`${spinnerPlaceholder} `, "info"),
      createSpan(statusText, "muted"),
    ],
    width,
  );
}

function getShellFailureExcerpt(event: ShellEvent): string[] {
  const source = event.stderrLines.length > 0 ? event.stderrLines : event.lines;
  const summary = sanitizeTerminalOutput(event.summary ?? "").trim().toLowerCase();
  return sanitizeTerminalLines(source)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && summary && line.toLowerCase() === summary))
    .slice(0, MAX_SHELL_FAILURE_EXCERPT_LINES);
}

function getProgressBlockMarker(isLive: boolean): { text: string; tone: TimelineTone } {
  if (isLive) {
    return { text: "▸ ", tone: "accent" };
  }
  return { text: "• ", tone: "info" };
}

function getCurrentProgressText(block: VisibleProgressBlock | null, latestTool: RunEvent["toolActivities"][number] | null): string | null {
  if (latestTool?.status === "running") {
    return latestTool.command;
  }

  if (!block) {
    return null;
  }

  return block.headline.replace(/^Current:\s*/i, "");
}

/**
 * Verbose mode renders the full reasoning card.
 * Default mode renders a compact live-activity card only when there are
 * meaningful progress, tool, or file signals to show.
 */
function buildThinkingRows(run: RunEvent, width: number, verbose: boolean): TimelineRow[] {
  const latestTool = run.toolActivities[run.toolActivities.length - 1] ?? null;
  const progressEntries = run.progressEntries ?? [];
  const recentActivity = run.activity.slice(-2);
  const contentWidth = Math.max(1, width - 4);
  const contentRows: TimelineRowSpan[][] = [];
  const totalProgressBlocks = getProgressUpdateCount(progressEntries);
  const maxVisibleEntries = verbose ? totalProgressBlocks : MAX_VISIBLE_PROGRESS_ENTRIES;
  const {
    blocks: visibleBlocks,
    hiddenCount,
    totalCount,
    latestBlock,
    latestActiveBlock,
  } = selectVisibleProgressBlocks(progressEntries, maxVisibleEntries);
  const updateCount = totalCount || totalProgressBlocks;
  const currentProgressText = getCurrentProgressText(latestActiveBlock ?? latestBlock, latestTool);

  if (currentProgressText && run.status === "running") {
    contentRows.push([
      createSpan("Current: ", "info", { bold: true }),
      createSpan(clampVisualText(currentProgressText, Math.max(1, contentWidth - 9)), "text"),
    ]);
  }

  if (hiddenCount > 0) {
    if (contentRows.length > 0) contentRows.push([createSpan(" ", "dim")]);
    contentRows.push([createSpan(`... ${hiddenCount} earlier update${hiddenCount === 1 ? "" : "s"}`, "dim")]);
  }

  visibleBlocks.forEach((block, blockIndex) => {
    const isLive = run.status === "running" && block.isActive;
    if (contentRows.length > 0 && (blockIndex > 0 || hiddenCount > 0)) {
      contentRows.push([createSpan(" ", "dim")]);
    }

    const marker = getProgressBlockMarker(isLive);
    const label = isLive ? "Live" : block.label;
    contentRows.push([
      createSpan(marker.text, marker.tone),
      createSpan(label, isLive ? "accent" : "info", { bold: isLive }),
    ]);

    const bodyLines = formatProgressBlockBodyLines(block.text, Math.max(1, contentWidth - 4));
    const lineCap = verbose ? bodyLines.length : COMPACT_PROCESSING_BODY_LINE_CAP;
    const visibleBodyLines = bodyLines.slice(0, lineCap);
    const overflowCount = bodyLines.length - visibleBodyLines.length;

    visibleBodyLines.forEach((line) => {
      contentRows.push([
        createSpan(isLive ? "  │ " : "    ", isLive ? "accent" : undefined),
        createSpan(line || " ", "dim"),
      ]);
    });

    if (overflowCount > 0) {
      contentRows.push([
        createSpan("    "),
        createSpan(`… (${overflowCount} more line${overflowCount === 1 ? "" : "s"})`, "dim"),
      ]);
    }
  });

  if (run.status === "running" && latestTool) {
    const toolPrefix = latestTool.status === "failed" ? "✕ " : latestTool.status === "completed" ? "✓ " : "• ";
    const toolTone = latestTool.status === "failed" ? "error" : latestTool.status === "completed" ? "success" : "info";
    const toolText = latestTool.status === "running"
      ? latestTool.command
      : latestTool.summary ?? latestTool.command;
    const clampedTool = clampVisualText(toolText, Math.max(1, contentWidth - 2));
    if (clampedTool.trim()) {
      if (contentRows.length > 0) contentRows.push([createSpan(" ", "dim")]);
      contentRows.push([
        createSpan(toolPrefix, toolTone),
        createSpan(clampedTool, toolTone),
      ]);
    }
  }

  if (run.status === "running") {
    recentActivity.forEach((file, index) => {
      const prefix = file.operation === "created" ? "+ " : file.operation === "deleted" ? "- " : "~ ";
      const tone = file.operation === "created" ? "success" : file.operation === "deleted" ? "error" : "info";
      const text = clampVisualText(file.path, Math.max(1, contentWidth - 2));
      if (!text.trim()) return;
      if (contentRows.length > 0 && index === 0) contentRows.push([createSpan(" ", "dim")]);
      contentRows.push([
        createSpan(prefix, tone),
        createSpan(text, tone),
      ]);
    });
  }

  if (contentRows.length === 0) {
    return [];
  }

  return buildDashCardRows({
    keyPrefix: `${run.turnId}-thinking`,
    width,
    title: "Processing",
    rightBadge: run.status === "running"
      ? "active"
      : `${updateCount} update${updateCount === 1 ? "" : "s"}`,
    borderTone: run.status === "running" ? "borderActive" : "borderSubtle",
    contentRows,
  });
}

/**
 * Compact impact summary for completed runs (default mode).
 * Shows file changes and a summary footer.
 */
function buildImpactSummaryRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow[] {
  const run = item.item.run!;
  const summary = run.activitySummary;
  const hasFiles = run.touchedFileCount > 0;
  const streamItemTools = new Set((run.streamItems ?? []).filter((i) => i.kind === "action").map((i) => i.refId));
  const unstreamedTools = run.toolActivities.filter((t) => !streamItemTools.has(t.id));
  const hasUnstreamedTools = unstreamedTools.length > 0;
  if (!hasFiles && !hasUnstreamedTools) return [];

  const rows: TimelineRow[] = [];
  const recentFiles = summary?.recent ?? run.activity.slice(-6);
  const hasDeletes = (summary?.deleted ?? 0) > 0;

  const opLabel = (op: string) => {
    switch (op) {
      case "created": return "CREATED ";
      case "modified": return "MODIFIED";
      case "deleted": return "DELETED ";
      default: return op.toUpperCase().padEnd(8);
    }
  };
  const opTone = (op: string): TimelineTone => {
    switch (op) {
      case "created": return "success";
      case "deleted": return "error";
      default: return "info";
    }
  };

  // Warning banner for destructive changes
  if (hasDeletes) {
    rows.push(createRow(
      `${item.key}-impact-warn`,
      [createSpan(" "), createSpan("⚠ Destructive changes detected:", "warning")],
      width,
    ));
  }

  // "Changes:" label
  if (hasFiles) {
    rows.push(createRow(
      `${item.key}-impact-label`,
      [createSpan("   "), createSpan("Changes:", "dim")],
      width,
    ));

    // File list
    recentFiles.forEach((file, index) => {
      const diffInfo = file.addedLines != null || file.removedLines != null
        ? ` (+${file.addedLines ?? 0} -${file.removedLines ?? 0})`
        : "";
      rows.push(createRow(
        `${item.key}-impact-file-${index}`,
        [
          createSpan("     "),
          createSpan(opLabel(file.operation), opTone(file.operation)),
          createSpan(` ${file.path}`, "text"),
          createSpan(diffInfo, "dim"),
        ],
        width,
      ));
    });
  }

  // Summary footer
  const parts: string[] = [];
  if (run.touchedFileCount > 0) parts.push(`${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`);
  if (hasUnstreamedTools) parts.push(`${unstreamedTools.length} action${unstreamedTools.length === 1 ? "" : "s"}`);
  if (run.durationMs != null) parts.push(formatDuration(run.durationMs));

  rows.push(createRow(
    `${item.key}-impact-summary`,
    [
      createSpan("   "),
      createSpan("✔ ", "success"),
      createSpan(parts.join(" • "), "dim"),
    ],
    width,
  ));

  return rows;
}

// ─── Markdown rendering ───────────────────────────────────────────────────────

function normalizeMarkdownParts(parts: unknown): MarkdownInlinePart[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part): part is MarkdownInlinePart => (
      typeof part === "object"
      && part !== null
      && ("kind" in part)
      && ("text" in part)
      && typeof (part as { kind: unknown }).kind === "string"
      && typeof (part as { text: unknown }).text === "string"
    ))
    .map((part) => ({
      kind: part.kind,
      text: part.text,
    }));
}

function inlinePartsToSpans(parts: MarkdownInlinePart[], tone: TimelineTone): TimelineRowSpan[] {
  const spans: TimelineRowSpan[] = [];
  parts.forEach((part) => {
    if (part.kind === "code") {
      appendSpan(spans, createSpan(part.text, "info"));
      return;
    }
    if (part.kind === "bold") {
      appendSpan(spans, createSpan(part.text, tone, { bold: true }));
      return;
    }
    appendSpan(spans, createSpan(part.text, tone));
  });
  return spans;
}

function buildWrappedMarkdownLine(
  keyPrefix: string,
  parts: MarkdownInlinePart[],
  width: number,
  tone: TimelineTone,
): TimelineRowSpan[][] {
  return wrapStyledSpans(inlinePartsToSpans(parts, tone), width)
    .map((row, index) => padSpansToWidth(row, width));
}

function getDiffTone(kind: DiffRenderLineType): TimelineTone {
  switch (kind) {
    case "add":
      return "success";
    case "remove":
      return "error";
    case "hunk":
      return "accent";
    case "file":
    case "meta":
      return "info";
    case "context":
    default:
      return "muted";
  }
}

function buildCodePanelRows(keyPrefix: string, segment: Extract<Segment, { type: "code" }>, width: number): TimelineRowSpan[][] {
  let title = segment.lang || "code";
  let codeLines = segment.lines;
  const firstLine = codeLines[0]?.trim() ?? "";
  if (/^[a-zA-Z0-9_.\-\/]+\.[a-zA-Z0-9]+$/.test(firstLine)) {
    title = firstLine;
    codeLines = codeLines.slice(1);
  }

  const rightTitle = segment.lang ? `${segment.lang.toUpperCase()} ⎘ Copy Code` : "⎘ Copy Code";
  const panelWidth = Math.max(10, width - 2);
  const panelContentWidth = Math.max(1, panelWidth - 4);

  const diffLines = maybeRenderDiff(codeLines.join("\n"), {
    force: segment.lang.toLowerCase() === "diff",
  });
  const contentRows: TimelineRowSpan[][] = [];

  if (diffLines) {
    diffLines.forEach((line) => {
      wrapPlainText(line.text, panelContentWidth).forEach((wrapped) => {
        contentRows.push([createSpan(wrapped || " ", getDiffTone(line.type))]);
      });
    });
  } else {
    codeLines.forEach((line, index) => {
      const wrappedRows = wrapPlainText(line, Math.max(1, panelContentWidth - 4));
      wrappedRows.forEach((wrapped, rowIndex) => {
        contentRows.push([
          createSpan(rowIndex === 0 ? `${String(index + 1).padStart(3, " ")} ` : "    ", "dim"),
          createSpan(wrapped || " ", "muted"),
        ]);
      });
    });
  }

  const panelRows = buildPanelRows({
    keyPrefix,
    width: panelWidth,
    title,
    rightTitle,
    contentRows,
  });

  return panelRows.map((row) => [
    createSpan("  "),
    ...padSpansToWidth(row.spans, panelWidth),
  ]);
}

function buildMarkdownRows(segments: Segment[], width: number): TimelineRowSpan[][] {
  const rows: TimelineRowSpan[][] = [];

  segments.forEach((segment, segmentIndex) => {
    const marginTop = segmentIndex > 0 ? 1 : 0;
    if (marginTop > 0) {
      rows.push([createSpan("")]);
    }

    if (segment.type === "code") {
      rows.push(...buildCodePanelRows(`code-${segmentIndex}`, segment, width));
      return;
    }

    if (segment.type === "header") {
      const parts = normalizeMarkdownParts(segment.parts);
      const prefix = segment.level <= 2 ? "✧ " : "• ";
      const prefixTone = segment.level === 1 ? "accent" : segment.level === 2 ? "text" : "muted";
      if (segment.level <= 2) {
        rows.push([createSpan("───", "borderSubtle")]);
      }
      rows.push(...buildPrefixedContentRows(
        `header-${segmentIndex}`,
        [createSpan(prefix, prefixTone)],
        [createSpan("  ", prefixTone)],
        inlinePartsToSpans(parts, prefixTone),
        width,
      ).map((row) => row.spans));
      return;
    }

    if (segment.type === "list") {
      segment.items.forEach((item, itemIndex) => {
        const prefix = segment.ordered ? `${item.num}. ` : "• ";
        rows.push(...buildPrefixedContentRows(
          `list-${segmentIndex}-${itemIndex}`,
          [createSpan(prefix, "accent")],
          [createSpan(" ".repeat(getTextWidth(prefix)), "accent")],
          inlinePartsToSpans(normalizeMarkdownParts(item.parts), "text"),
          width,
        ).map((row) => row.spans));
      });
      return;
    }

    // Paragraph segment — check if it looks like a unified diff so we can
    // apply colour-coded tones instead of the flat 'text' tone.
    const rawParaLines = segment.lines.map((parts) =>
      normalizeMarkdownParts(parts).map((p) => p.text).join(""),
    );
    const diffLines = maybeRenderDiff(rawParaLines.join("\n"));
    const diffLineByIndex = new Map<number, NonNullable<ReturnType<typeof maybeRenderDiff>>[number]>();
    diffLines?.forEach((line, index) => {
      diffLineByIndex.set(index, line);
    });

    segment.lines.forEach((parts, lineIndex) => {
      const normalizedParts = normalizeMarkdownParts(parts);
      const isBlank = normalizedParts.length === 1
        && normalizedParts[0]?.kind === "text"
        && !normalizedParts[0].text.trim();
      if (isBlank) {
        return;
      }

      const diffLine = diffLineByIndex.get(lineIndex);
      if (diffLine) {
        wrapStyledSpans([createSpan(diffLine.text, getDiffTone(diffLine.type))], width)
          .forEach((row) => rows.push(padSpansToWidth(row, width)));
        return;
      }

      rows.push(...buildWrappedMarkdownLine(`para-${segmentIndex}-${lineIndex}`, normalizedParts, width, "text"));
    });
  });

  return rows.length > 0 ? rows : [];
}

// ─── Row cache ────────────────────────────────────────────────────────────────
// During streaming, we cache previously computed markdown rows and only re-run
// the pipeline on new content from the last safe paragraph boundary onward.
// This reduces per-frame work from O(total_content) to O(new_delta + tail_paragraph).
interface StreamingRowCache {
  turnKey: string;
  width: number;
  /** Content length up to the last safe boundary that produced cachedRows. */
  safeBoundaryOffset: number;
  /** Rows computed for content up to safeBoundaryOffset. */
  cachedRows: TimelineRowSpan[][];
  /** Total content length when this cache was last updated. */
  contentLength: number;
}

let _streamingRowCache: StreamingRowCache | null = null;

// Per-entry row cache for completed (non-streaming) timeline entries.
// Key: `${item.key}:${width}:${verboseMode}` — automatically invalidated when
// width or verboseMode changes because those are baked into the key.  Entries
// for completed turns are immutable so cached rows are always valid for the
// same (key, width, verboseMode) triple.
const _staticRowCache = new Map<string, TimelineRow[]>();
const STREAMING_BLOCK_ROW_CACHE_LIMIT = 200;
let _streamingBlockRowCache = new Map<string, TimelineRow[]>();
const _completedActionRowCache = new Map<string, TimelineRow[]>();
const _completedActionTokenById = new Map<string, string>();
const FROZEN_ROW_GROUP_CACHE_LIMIT = 1200;
const _frozenRowGroupCache = new Map<string, TimelineRow[]>();
let _wrappedRowCache = new WeakMap<TimelineRow, Map<string, TimelineRow>>();
const _wrappedBlankRowCache = new Map<string, TimelineRow>();
interface ActionDisplayDescriptor {
  id: string;
  status: RunToolActivity["status"];
  label: string | null;
  command: string;
  duration: string;
  summary: string;
  icon: string;
  iconTone: TimelineTone;
  showLiveCursor: boolean;
  borderTone: TimelineTone;
  width: number;
  verbose: boolean;
}

const _actionDisplayCache = new Map<string, ActionDisplayDescriptor>();

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function textCacheToken(value: string | null | undefined): string {
  const text = value ?? "";
  return `${text.length}:${hashString(text)}`;
}

function rowCacheKey(parts: unknown[]): string {
  return JSON.stringify(parts);
}

function getCachedStreamingBlockRows(cacheKey: string, build: () => TimelineRow[]): TimelineRow[] {
  const cached = _streamingBlockRowCache.get(cacheKey);
  if (cached) {
    _streamingBlockRowCache.delete(cacheKey);
    _streamingBlockRowCache.set(cacheKey, cached);
    return cached;
  }

  const rows = build();
  _streamingBlockRowCache.set(cacheKey, rows);
  while (_streamingBlockRowCache.size > STREAMING_BLOCK_ROW_CACHE_LIMIT) {
    const oldestKey = _streamingBlockRowCache.keys().next().value;
    if (oldestKey === undefined) break;
    _streamingBlockRowCache.delete(oldestKey);
  }
  return rows;
}

function getCachedFrozenRows(cacheKey: string, build: () => TimelineRow[]): TimelineRow[] {
  const cached = _frozenRowGroupCache.get(cacheKey);
  if (cached) {
    _frozenRowGroupCache.delete(cacheKey);
    _frozenRowGroupCache.set(cacheKey, cached);
    return cached;
  }

  const rows = build();
  _frozenRowGroupCache.set(cacheKey, rows);
  while (_frozenRowGroupCache.size > FROZEN_ROW_GROUP_CACHE_LIMIT) {
    const oldestKey = _frozenRowGroupCache.keys().next().value;
    if (oldestKey === undefined) break;
    _frozenRowGroupCache.delete(oldestKey);
  }
  return rows;
}

export function __clearTimelineMeasureCachesForTests(): void {
  _streamingRowCache = null;
  _rowContentCache.clear();
  _staticRowCache.clear();
  _blankRowCache.clear();
  _streamingBlockRowCache.clear();
  _completedActionRowCache.clear();
  _completedActionTokenById.clear();
  _frozenRowGroupCache.clear();
  _wrappedRowCache = new WeakMap<TimelineRow, Map<string, TimelineRow>>();
  _wrappedBlankRowCache.clear();
  _actionDisplayCache.clear();
}

export function __getStreamingBlockRowCacheSizeForTests(): number {
  return _streamingBlockRowCache.size;
}

export function __wrapStyledSpansForTests(spans: TimelineRowSpan[], width: number): TimelineRowSpan[][] {
  return wrapStyledSpans(spans, width);
}

/** Find the last safe paragraph boundary (double newline or closed code fence)
 *  that we can split content at for incremental rendering. */
function findSafeBoundary(content: string, searchFrom: number): number {
  // Look for the last double-newline before the end of content
  let boundary = content.lastIndexOf("\n\n", content.length - 1);
  // Only accept boundaries past the previous safe offset
  if (boundary > searchFrom) return boundary + 2; // include the \n\n

  // Fallback: look for single newline that's past searchFrom
  boundary = content.lastIndexOf("\n", content.length - 1);
  if (boundary > searchFrom) return boundary + 1;

  // No safe boundary found — must re-process from searchFrom
  return searchFrom;
}

// ─── Agent & action builders ──────────────────────────────────────────────────

function buildAgentRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number, verbose = false): TimelineRow[] {
  const run = item.item.run!;
  const assistant = item.item.assistant;
  const streaming = item.renderState.runPhase === "streaming";
  const dim = item.renderState.opacity !== "active";
  const contentWidth = Math.max(1, width - 4);
  const rawContent = splitSentenceWall(getAssistantContent(assistant));

  let contentRows: TimelineRowSpan[][];

  if (streaming && rawContent.length > 0) {
    // During streaming, content was already sanitized in onAssistantDelta (app.tsx).
    // Skip redundant sanitizeStreamChunk call — pass directly to normalize.
    const turnKey = item.key;
    const cache = _streamingRowCache;

    if (
      cache
      && cache.turnKey === turnKey
      && cache.width === contentWidth
      && rawContent.length >= cache.contentLength
    ) {
      // Content is a strict extension of what we cached — incremental update.
      const newBoundary = findSafeBoundary(rawContent, cache.safeBoundaryOffset);

      // Re-process only content from the last safe boundary onward
      const tailContent = rawContent.slice(cache.safeBoundaryOffset);
      const tailNormalized = normalizeOutput(tailContent);
      const tailSegments = formatForBox(classifyOutput(tailNormalized), contentWidth);
      const tailRows = buildMarkdownRows(tailSegments, contentWidth);
      contentRows = [...cache.cachedRows, ...tailRows];

      if (newBoundary > cache.safeBoundaryOffset) {
        // New safe boundary found — compute cached rows up to boundary
        const safePart = rawContent.slice(cache.safeBoundaryOffset, newBoundary);
        const safeNormalized = normalizeOutput(safePart);
        const safeSegments = formatForBox(classifyOutput(safeNormalized), contentWidth);
        const safeRows = buildMarkdownRows(safeSegments, contentWidth);

        _streamingRowCache = {
          turnKey,
          width: contentWidth,
          safeBoundaryOffset: newBoundary,
          cachedRows: [...cache.cachedRows, ...safeRows],
          contentLength: rawContent.length,
        };
      } else {
        // No new safe boundary — keep cache as-is, just update content length
        _streamingRowCache = {
          ...cache,
          contentLength: rawContent.length,
        };
      }
    } else {
      // Cache miss — full rebuild and seed the cache
      const normalized = normalizeOutput(rawContent);
      const segments = formatForBox(classifyOutput(normalized), contentWidth);
      contentRows = buildMarkdownRows(segments, contentWidth);

      const boundary = findSafeBoundary(rawContent, 0);
      if (boundary > 0 && boundary < rawContent.length) {
        const safeNormalized = normalizeOutput(rawContent.slice(0, boundary));
        const safeSegments = formatForBox(classifyOutput(safeNormalized), contentWidth);
        const safeRows = buildMarkdownRows(safeSegments, contentWidth);

        _streamingRowCache = {
          turnKey,
          width: contentWidth,
          safeBoundaryOffset: boundary,
          cachedRows: safeRows,
          contentLength: rawContent.length,
        };
      } else {
        _streamingRowCache = {
          turnKey,
          width: contentWidth,
          safeBoundaryOffset: 0,
          cachedRows: [],
          contentLength: rawContent.length,
        };
      }
    }
  } else {
    // Not streaming or empty — full pipeline, invalidate cache
    if (!streaming) _streamingRowCache = null;
    const sanitized = sanitizeOutput(rawContent);
    const normalized = normalizeOutput(sanitized);
    const segments = formatForBox(classifyOutput(normalized), contentWidth);
    contentRows = buildMarkdownRows(segments, contentWidth);
  }

  if (!streaming && run.status === "failed") {
    const failureMessage = sanitizeTerminalOutput(run.errorMessage ?? run.summary);
    const failureRows: TimelineRowSpan[][] = [];
    wrapPlainText(failureMessage, Math.max(1, contentWidth - 2)).forEach((row, index) => {
      failureRows.push([
        createSpan(index === 0 ? "✕ " : "  ", "error"),
        createSpan(row || " ", "error"),
      ]);
    });
    contentRows = [...failureRows, ...contentRows];
  }

  if (streaming && !verbose && contentRows.length > COMPACT_STREAMING_TAIL_CAP) {
    const hiddenRowCount = contentRows.length - COMPACT_STREAMING_TAIL_CAP;
    contentRows = [
      [createSpan(`… (${hiddenRowCount} line${hiddenRowCount === 1 ? "" : "s"} above)`, "dim")],
      ...contentRows.slice(-COMPACT_STREAMING_TAIL_CAP),
    ];
  }

  if (streaming) {
    contentRows.push([
      createSpan("  "),
      createSpan("▌", "accent"),
    ]);
  }

  if (!streaming && run.status !== "running") {
    if (run.status === "canceled") {
      wrapPlainText(sanitizeTerminalOutput(run.summary), contentWidth).forEach((wrapped) => {
        contentRows.push([createSpan(wrapped || " ", "warning")]);
      });
    } else if (run.status === "completed" && rawContent.trim().length === 0) {
      contentRows.push([createSpan("(no output)", "dim")]);
    }

    if (run.truncatedOutput) {
      contentRows.push([createSpan(RUN_OUTPUT_TRUNCATION_NOTICE, "dim")]);
    }
  }

  const heading = run.runtime.model ? run.runtime.model.toUpperCase().replace(/-/g, " ") : "Codex";
  const runStatus = streaming
    ? "streaming"
    : run.status === "completed"
      ? "complete"
      : run.status ?? "running";
  const rightBadge = run.durationMs != null && !streaming
    ? `${runStatus} • ${formatDuration(run.durationMs)}`
    : runStatus;

  const borderTone = dim ? "borderSubtle" : streaming ? "borderActive" : "borderSubtle";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";

  const rows: TimelineRow[] = [];

  // 1. Add top margin for separation from the task status line above.
  rows.push(createBlankRow(`${item.key}-agent-top-gap`, width));

  // 2. Render the Codex output inside a DashCard — visually consistent with
  //    every other block in the timeline: USER INPUT, Processing, File Scan,
  //    and Activity all use the same ╭──...──╮ frame.  The title is the model
  //    name (e.g. "GPT 4O") or the generic "Codex" fallback.
  rows.push(...buildDashCardRows({
    keyPrefix: `${item.key}-agent`,
    width,
    title: heading,
    rightBadge,
    borderTone,
    contentRows,
  }));

  return rows;
}

function buildFileScanRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow[] {
  const run = item.item.run!;
  const { visible, hiddenCount } = selectVisibleRunActivity(run);
  const contentRows: TimelineRowSpan[][] = [];

  if (hiddenCount > 0) {
    contentRows.push([createSpan(`... ${hiddenCount} more`, "dim")]);
  }

  visible.forEach((file) => {
    contentRows.push([
      createSpan("● ", "success"),
      createSpan(file.path, "text"),
    ]);
  });

  return buildDashCardRows({
    keyPrefix: `${item.key}-files`,
    width,
    title: "Scanning workspace ...",
    rightBadge: `${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`,
    contentRows,
  });
}

function buildActivityRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow[] {
  const run = item.item.run!;
  const contentWidth = Math.max(1, width - 4);
  const contentRows: TimelineRowSpan[][] = [];

  run.toolActivities.forEach((tool, index) => {
    const icon = tool.status === "failed" ? "✕" : "✓";
    const iconTone = tool.status === "failed" ? "error" : "success";
    const duration = tool.completedAt && tool.startedAt
      ? ` • ${formatDuration(tool.completedAt - tool.startedAt)}`
      : "";
    const headRows = wrapPlainText(tool.command, Math.max(1, contentWidth - 2));
    headRows.forEach((row, rowIndex) => {
      contentRows.push([
        createSpan(rowIndex === 0 ? `${icon} ` : "  ", iconTone),
        createSpan(row || " ", "text"),
        ...(rowIndex === 0 && duration ? [createSpan(duration, "dim")] : []),
      ]);
    });
    if (tool.summary) {
      wrapPlainText(tool.summary, Math.max(1, contentWidth - 2)).forEach((row) => {
        contentRows.push([
          createSpan("  "),
          createSpan(row || " ", "muted"),
        ]);
      });
    }
    if (index < run.toolActivities.length - 1) {
      contentRows.push([createSpan("")]);
    }
  });

  return buildDashCardRows({
    keyPrefix: `${item.key}-activity`,
    width,
    title: "Activity",
    rightBadge: "done",
    contentRows,
  });
}

function buildActionRequiredRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number): TimelineRow[] {
  const question = item.renderState.question;
  if (!question) return [];

  const contentWidth = Math.max(1, width - 4);
  const wrappedQuestion = question
    .split("\n")
    .flatMap((line) => {
      const rows = wrapPlainText(line, contentWidth);
      return rows.length > 0 ? rows : [""];
    });

  const rows: TimelineRow[] = [
    createRow(`${item.key}-question-top`, [createSpan(`┌${"─".repeat(Math.max(1, width - 2))}┐`, "borderActive")], width),
  ];

  const title = `[${item.item.turnIndex}] ACTION REQUIRED`;
  const titleWidth = getTextWidth(title) + getTextWidth("⚡");
  const padding = Math.max(1, contentWidth - titleWidth);
  rows.push(createRow(
    `${item.key}-question-title`,
    [
      createSpan("│ ", "borderActive"),
      createSpan(title, "text", { bold: true }),
      createSpan(" ".repeat(padding)),
      createSpan("⚡", "text", { bold: true }),
      createSpan(" │", "borderActive"),
    ],
    width,
  ));
  rows.push(createBlankRow(`${item.key}-question-gap`, width));
  rows.push(createRow(
    `${item.key}-question-label`,
    [
      createSpan("│ ", "borderActive"),
      createSpan("Verification Question", "text", { bold: true }),
      createSpan(" ".repeat(Math.max(0, contentWidth - getTextWidth("Verification Question")))),
      createSpan(" │", "borderActive"),
    ],
    width,
  ));

  wrappedQuestion.forEach((row, index) => {
    rows.push(createRow(
      `${item.key}-question-row-${index}`,
      [
        createSpan("│ ", "borderActive"),
        createSpan(row || " ", "text"),
        createSpan(" ".repeat(Math.max(0, contentWidth - getTextWidth(row || " ")))),
        createSpan(" │", "borderActive"),
      ],
      width,
    ));
  });

  rows.push(createBlankRow(`${item.key}-question-end-gap`, width));
  rows.push(createRow(`${item.key}-question-bottom`, [createSpan(`└${"─".repeat(Math.max(1, width - 2))}┘`, "borderActive")], width));
  return rows;
}

// ─── Standalone event & intro rows ───────────────────────────────────────────

export function buildStandaloneEventRows(item: Extract<RenderTimelineItem, { type: "event" }>, width: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const event = item.event;

  if (event.type === "shell") {
    const command = sanitizeTerminalOutput(event.command);
    const summary = sanitizeTerminalOutput(event.summary ?? "");
    const marker = event.status === "failed" ? "✕ " : "✧ ";
    const markerTone = event.status === "failed" ? "error" : "accent";
    const verb = event.status === "running"
      ? "Executing shell"
      : event.status === "completed"
        ? "Executed shell"
        : "Shell failed";
    const statusBits = [
      event.exitCode !== null && event.status !== "running" ? `exit ${event.exitCode}` : null,
      event.durationMs !== null ? `${(event.durationMs / 1000).toFixed(2)}s` : null,
    ].filter(Boolean).join(" • ");
    const heading = `${verb}: ${command}${statusBits ? `  •  ${statusBits}` : ""}`;

    rows.push(...buildPrefixedContentRows(
      `${item.key}-shell`,
      [createSpan(marker, markerTone)],
      [createSpan("  ", markerTone)],
      [createSpan(heading, "text")],
      width,
    ));

    if (summary && event.status !== "running") {
      const summaryRows = wrapPlainText(summary, Math.max(1, width - 2));
      rows.push(...buildIndentedRows(
        `${item.key}-summary`,
        summaryRows.map((row) => [createSpan(row || " ", event.status === "failed" ? "error" : "muted")]),
        width,
        2,
      ));
    }

    if (event.status === "failed") {
      const failureExcerpt = getShellFailureExcerpt(event);
      rows.push(...buildIndentedRows(
        `${item.key}-stderr`,
        failureExcerpt.map((line) => [createSpan(line, "error")]),
        width,
        2,
      ));
    }

    return rows;
  }

  if (event.type === "error") {
    rows.push(...buildPrefixedContentRows(
      `${item.key}-error`,
      [createSpan("✕ ", "error")],
      [createSpan("  ", "error")],
      [createSpan(sanitizeTerminalOutput(event.title), "error")],
      width,
    ));

    // Show the full content — not just the first line.  Error messages can span
    // multiple lines (stack traces, multi-step explanations) and silently
    // truncating to line 1 hides important diagnostic information.
    const errorContentLines = sanitizeTerminalOutput(event.content)
      .split("\n")
      .filter((line) => line.trim());
    if (errorContentLines.length > 0) {
      const wrappedRows = errorContentLines.flatMap((line) =>
        wrapPlainText(line, Math.max(1, width - 2)).map((row) => [createSpan(row || " ", "muted")])
      );
      rows.push(...buildIndentedRows(
        `${item.key}-error-content`,
        wrappedRows,
        width,
        2,
      ));
    }
    return rows;
  }

  rows.push(...buildPrefixedContentRows(
    `${item.key}-system`,
    [createSpan("• ", "info")],
    [createSpan("  ", "info")],
    [createSpan(sanitizeTerminalOutput(event.title), "text")],
    width,
  ));

  // Show the full content — not just the first line.  System events carry
  // rich multi-line payloads: /help output, auth status, model listings,
  // workspace summaries, etc.  Limiting to line 1 silently hides all of it.
  const systemContentLines = sanitizeTerminalOutput(event.content)
    .split("\n")
    .filter((line) => line.trim());
  if (systemContentLines.length > 0) {
    const wrappedRows = systemContentLines.flatMap((line) =>
      wrapPlainText(line, Math.max(1, width - 2)).map((row) => [createSpan(row || " ", "dim")])
    );
    rows.push(...buildIndentedRows(
      `${item.key}-system-content`,
      wrappedRows,
      width,
      2,
    ));
  }

  return rows;
}

export function buildIntroRows(item: Extract<RenderTimelineItem, { type: "intro" }>, width: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const { intro } = item;
  const safeWidth = Math.max(10, width);
  const startupHeaderMode = intro.startupHeaderMode
    ?? (intro.layoutMode === "expanded" ? "large" : "compact");
  const workspaceName = getWorkspaceDisplayName(intro.workspaceLabel);
  if (startupHeaderMode === "tiny") {
    const messageRows = [
      `Codexa v${intro.version}`,
      workspaceName ? `Workspace: ${workspaceName}` : null,
      intro.providerLabel ? `Provider: ${intro.providerLabel}` : `Auth: ${intro.authLabel}`,
    ].filter((line): line is string => Boolean(line));
    messageRows.forEach((line, index) => {
      rows.push(createRow(
        `${item.key}-resize-${index}`,
        [createSpan(clampVisualText(line, safeWidth), index === 0 ? "text" : "muted", { bold: index === 0 })],
        safeWidth,
      ));
    });
    return rows;
  }

  // Compact startup mode deliberately uses the one-line mark even when the
  // terminal is wide: its row budget is what made the full logo unsafe.
  const logoRows = startupHeaderMode === "large"
    ? selectLogoVariant(safeWidth)
    : safeWidth >= LOGO_COMPACT_MIN_COLS ? LOGO_COMPACT : [];
  const effectiveLogoRows = logoRows.length > 0 ? logoRows : ["CODEXA"];
  if (startupHeaderMode === "large") {
    rows.push(createBlankRow(`${item.key}-top-gap`, safeWidth));
  }
  const logoWidth = effectiveLogoRows.reduce((maxWidth, line) => Math.max(maxWidth, getTextWidth(line)), 0);
  const metaLines = [
    `Codexa v${intro.version}`,
    workspaceName ? `Workspace: ${workspaceName}` : null,
    intro.providerLabel ? `Provider: ${intro.providerLabel}` : `Auth: ${intro.authLabel}`,
  ].filter((line): line is string => Boolean(line));
  const gapWidth = 2;
  const widestMetaLine = metaLines.reduce((maxWidth, line) => Math.max(maxWidth, getTextWidth(line)), 0);
  const canRenderSideBySide = metaLines.length > 0
    && safeWidth >= logoWidth + gapWidth + widestMetaLine;

  if (canRenderSideBySide) {
    const metaStartRow = Math.max(0, Math.floor((effectiveLogoRows.length - metaLines.length) / 2));
    const rowCount = Math.max(effectiveLogoRows.length, metaStartRow + metaLines.length);
    const metaWidth = Math.max(1, safeWidth - logoWidth - gapWidth);

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const logoLine = effectiveLogoRows[rowIndex] ?? "";
      const logoPadding = Math.max(0, logoWidth - getTextWidth(logoLine));
      const metaIndex = rowIndex - metaStartRow;
      const metaLine = metaIndex >= 0 && metaIndex < metaLines.length
        ? sanitizeTerminalOutput(metaLines[metaIndex]!)
        : "";
      let logoTone: TimelineTone = "logoPrimary";
      if (effectiveLogoRows.length === 6) {
        if (rowIndex === 2 || rowIndex === 3) logoTone = "logoSecondary";
        else if (rowIndex === 4 || rowIndex === 5) logoTone = "logoShadow";
      } else if (effectiveLogoRows === LOGO_COMPACT) {
        logoTone = "accent";
      }
      // No bold on logo spans — bold on block/box-drawing chars causes spacing artifacts.
      const spans = [
        createSpan(`${logoLine}${" ".repeat(logoPadding)}`, logoTone),
        createSpan(" ".repeat(gapWidth)),
      ];

      if (metaLine) {
        spans.push(createSpan(clampVisualText(metaLine, metaWidth), metaIndex === 0 ? "text" : "muted", { bold: metaIndex === 0 }));
      }

      rows.push(createRow(
        `${item.key}-intro-row-${rowIndex}`,
        spans,
        safeWidth,
      ));
    }
  } else {
    effectiveLogoRows.forEach((line, index) => {
      let logoTone: TimelineTone = "logoPrimary";
      if (effectiveLogoRows.length === 6) {
        if (index === 2 || index === 3) logoTone = "logoSecondary";
        else if (index === 4 || index === 5) logoTone = "logoShadow";
      } else if (effectiveLogoRows === LOGO_COMPACT) {
        logoTone = "accent";
      }
      rows.push(createRow(
        `${item.key}-logo-${index}`,
        [createSpan(clampVisualText(line, safeWidth), logoTone)],
        safeWidth,
      ));
    });

    metaLines.forEach((line, index) => {
      const wrapped = wrapPlainText(sanitizeTerminalOutput(line), safeWidth);
      wrapped.forEach((row, rowIndex) => {
        rows.push(createRow(
          `${item.key}-meta-${index}-${rowIndex}`,
          [createSpan(row || " ", index === 0 ? "text" : "muted", { bold: index === 0 })],
          safeWidth,
        ));
      });
    });
  }

  rows.push(createBlankRow(`${item.key}-gap`, safeWidth));
  return rows;
}

function getWorkspaceDisplayName(workspaceLabel: string): string {
  const sanitized = sanitizeTerminalOutput(workspaceLabel).trim();
  if (!sanitized) return "";
  const segments = sanitized.split(/[\\/]+/).map((segment) => segment.trim()).filter(Boolean);
  return segments[segments.length - 1] ?? sanitized;
}

function applyTurnOpacity(rows: TimelineRow[], opacity: "active" | "recent" | "dim"): TimelineRow[] {
  if (opacity === "active") {
    return rows;
  }

  if (opacity === "recent") {
    return rows.map((row) => {
      if (row.key.includes("-action-")) return row;
      return {
        ...row,
        spans: row.spans.map((span) => {
          if (span.tone === "borderActive") {
            return { ...span, tone: "borderSubtle" as TimelineTone };
          }
          return { ...span };
        }),
      };
    });
  }

  return rows.map((row) => {
    if (row.key.includes("-action-")) return row;
    return {
      ...row,
      spans: row.spans.map((span) => {
        if (
          span.tone === "text"
          || span.tone === "muted"
          || span.tone === "info"
          || span.tone === "warning"
        ) {
          return { ...span, tone: "dim" as TimelineTone };
        }
        if (span.tone === "accent") {
          return { ...span, tone: "muted" as TimelineTone };
        }
        if (span.tone === "borderActive") {
          return { ...span, tone: "borderSubtle" as TimelineTone };
        }
        return { ...span };
      }),
    };
  });
}


// ─── Stream event types ───────────────────────────────────────────────────────

export type StreamEvent =
  | { kind: "thinking"; streamSeq: number; block: RunProgressBlock }
  | { kind: "response"; streamSeq: number; segment: RunResponseSegment }
  | { kind: "action"; streamSeq: number; tool: RunToolActivity }
  | { kind: "actionSummary"; streamSeq: number; id: string; label: string; count: number }
  | { kind: "plan"; streamSeq: number; planText: string; approved: boolean };

const ACTION_COMPACT_KEEP_HEAD = 2;
const ACTION_COMPACT_KEEP_TAIL = 2;
const ACTION_COMPACT_MIN_COUNT = ACTION_COMPACT_KEEP_HEAD + ACTION_COMPACT_KEEP_TAIL + 2;

function getCompactableActionLabel(event: StreamEvent): string | null {
  if (event.kind !== "action") return null;
  if (event.tool.status !== "completed") return null;
  const label = getFriendlyActionLabel(normalizeCommand(event.tool.command));
  return label === "Read file" || label === "List files" ? label : null;
}

/**
 * Collapse bursts of same-label completed action cards into a single summary
 * line. This is a *height-reducing* transform, so it must only run for a
 * FINISHED turn: applying it while the run is still live shrinks the turn's
 * total height mid-stream, and the bottom-anchored viewport then re-reveals
 * earlier (already-scrolled-off) content — the "old states come back" glitch.
 *
 * Callers pass `finalized = run.status !== "running"`. We deliberately key off
 * `run.status` rather than the render phase: `resolveTurnRunPhase` reports
 * "final" during the ANSWER_VISIBLE window while the run is still running, so a
 * phase-based gate would compact during that intermediate, still-active frame.
 */
export function compactActionBursts(
  events: StreamEvent[],
  verbose: boolean,
  finalized: boolean,
): StreamEvent[] {
  if (verbose || !finalized) return events;

  const compacted: StreamEvent[] = [];
  for (let index = 0; index < events.length;) {
    const label = getCompactableActionLabel(events[index]!);
    if (!label) {
      compacted.push(events[index]!);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < events.length && getCompactableActionLabel(events[end]!) === label) {
      end += 1;
    }

    const group = events.slice(index, end);
    if (group.length < ACTION_COMPACT_MIN_COUNT) {
      compacted.push(...group);
      index = end;
      continue;
    }

    const hidden = group.slice(ACTION_COMPACT_KEEP_HEAD, group.length - ACTION_COMPACT_KEEP_TAIL);
    compacted.push(...group.slice(0, ACTION_COMPACT_KEEP_HEAD));
    compacted.push({
      kind: "actionSummary",
      streamSeq: hidden[0]?.streamSeq ?? group[ACTION_COMPACT_KEEP_HEAD]?.streamSeq ?? group[0]!.streamSeq,
      id: `${label.toLowerCase().replace(/\s+/g, "-")}-${group[0]!.streamSeq}-${group[group.length - 1]!.streamSeq}`,
      label,
      count: hidden.length,
    });
    compacted.push(...group.slice(group.length - ACTION_COMPACT_KEEP_TAIL));
    index = end;
  }

  return compacted;
}

// ─── Codex stream block builders ─────────────────────────────────────────────

function buildCodexPlainRows(
  keyPrefix: string,
  width: number,
  contentRows: TimelineRowSpan[][],
  label = "Codexa",
): TimelineRow[] {
  const indent = " ".repeat(transcriptContentIndent);
  const rows: TimelineRow[] = [
    createRow(`${keyPrefix}-label`, [createSpan(indent), createSpan(label, "muted", { bold: true })], width),
  ];

  contentRows.forEach((row, index) => {
    rows.push(createRow(`${keyPrefix}-content-${index}`, [createSpan(indent), ...(row.length > 0 ? row : [createSpan(" ")])], width));
  });

  return rows;
}

function buildCodexThinkingRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "thinking" }>;
  verbose: boolean;
}): TimelineRow[] {
  renderDebug.traceRender("ThinkingBlock", params.event.block.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    textLength: params.event.block.text.length,
  });

  const block = params.event.block;
  const cacheKey = rowCacheKey([
    "thinking",
    params.keyPrefix,
    block.id,
    block.status,
    block.updatedAt,
    textCacheToken(block.text),
    params.width,
    params.verbose,
  ]);

  return getCachedStreamingBlockRows(cacheKey, () => {
    const contentRows: TimelineRowSpan[][] = [];
    const contentWidth = Math.max(1, params.width - transcriptContentIndent);
    const bodyLines = formatProgressBlockBodyLines(params.event.block.text, contentWidth);
    const lineCap = params.verbose ? bodyLines.length : COMPACT_PROCESSING_BODY_LINE_CAP;
    const visibleBodyLines = bodyLines.slice(0, lineCap);
    const overflowCount = bodyLines.length - visibleBodyLines.length;

    visibleBodyLines.forEach((line) => {
      contentRows.push([createSpan(line || " ", "dim")]);
    });

    if (overflowCount > 0) {
      contentRows.push([
        createSpan(`… (${overflowCount} more line${overflowCount === 1 ? "" : "s"})`, "dim"),
      ]);
    }

    return buildCodexPlainRows(params.keyPrefix, params.width, contentRows, "Reasoning");
  });
}

function actionDisplayToken(descriptor: ActionDisplayDescriptor): string {
  return rowCacheKey([
    descriptor.id,
    descriptor.status,
    descriptor.label,
    descriptor.command,
    descriptor.duration,
    descriptor.summary,
    descriptor.icon,
    descriptor.iconTone,
    descriptor.showLiveCursor,
    descriptor.borderTone,
    descriptor.width,
    descriptor.verbose,
  ]);
}

function getActionDisplayDescriptor(params: {
  keyPrefix: string;
  tool: RunToolActivity;
  width: number;
  verbose: boolean;
  isLive: boolean;
  borderTone: TimelineTone;
}): ActionDisplayDescriptor {
  // Strip ANSI/control sequences before measuring or wrapping: string-width only
  // collapses *complete* escape sequences, so leftover bytes would otherwise be
  // counted (and wrapped) character-by-character and corrupt the card width.
  const command = normalizeCommand(sanitizeTerminalOutput(params.tool.command));
  const label = getFriendlyActionLabel(command);
  // Bare label (no leading gap) — the head-row builder right-aligns it and owns
  // the spacing, so the gap can never get baked into a width calculation.
  const duration = params.tool.completedAt != null
    ? formatDuration(params.tool.completedAt - params.tool.startedAt)
    : "";
  const summary = params.verbose ? params.tool.summary ?? "" : "";
  const showLiveCursor = params.isLive && params.tool.status === "running";
  const descriptor: ActionDisplayDescriptor = {
    id: params.tool.id,
    status: params.tool.status,
    label,
    command,
    duration,
    summary,
    icon: params.tool.status === "failed" ? "✕" : params.tool.status === "completed" ? "✓" : "•",
    iconTone: params.tool.status === "failed" ? "error" : params.tool.status === "completed" ? "success" : "info",
    showLiveCursor,
    borderTone: params.borderTone,
    width: params.width,
    verbose: params.verbose,
  };
  const cacheKey = `${params.keyPrefix}:${params.tool.id}`;
  const cached = _actionDisplayCache.get(cacheKey);
  if (cached && actionDisplayToken(cached) === actionDisplayToken(descriptor)) {
    return cached;
  }
  _actionDisplayCache.set(cacheKey, descriptor);
  return descriptor;
}

function buildPlainActionDebugRows(params: {
  keyPrefix: string;
  width: number;
  descriptor: ActionDisplayDescriptor;
}): TimelineRow[] {
  const statusText = params.descriptor.label
    ? `${params.descriptor.label}: ${params.descriptor.command}`
    : params.descriptor.command;
  const suffix = params.descriptor.duration ? `  ${params.descriptor.duration}` : "";
  const text = clampVisualText(`${params.descriptor.icon} ${statusText}${suffix}`, Math.max(1, params.width - 1));
  renderDebug.traceEvent("action", "plainActionRow", {
    actionId: params.descriptor.id,
    status: params.descriptor.status,
    keyPrefix: params.keyPrefix,
    width: params.width,
  });
  return [
    createRow(
      `${params.keyPrefix}-plain`,
      [
        createSpan(text || " ", params.descriptor.iconTone),
      ],
      params.width,
    ),
  ];
}

function compactActionText(descriptor: ActionDisplayDescriptor): string {
  const command = descriptor.command.replace(/^([a-z][a-z0-9_]*):\s+/i, "$1 ");
  return descriptor.label && command === descriptor.command
    ? `${descriptor.label} ${command}`
    : command;
}

function buildCompactActionRows(params: {
  keyPrefix: string;
  width: number;
  descriptor: ActionDisplayDescriptor;
}): TimelineRow[] {
  const durationSuffix = params.descriptor.duration ? `  ${params.descriptor.duration}` : "";
  const liveSuffix = params.descriptor.showLiveCursor ? "  ▌" : "";
  const availableWidth = Math.max(1, params.width - getTextWidth(params.descriptor.icon) - 1 - getTextWidth(durationSuffix) - getTextWidth(liveSuffix));
  const text = clampVisualText(compactActionText(params.descriptor), availableWidth);
  const rows: TimelineRow[] = [
    createRow(
      `${params.keyPrefix}-plain`,
      [
        createSpan(`${params.descriptor.icon} `, params.descriptor.iconTone),
        createSpan(text || " ", "text"),
        ...(durationSuffix ? [createSpan(durationSuffix, "dim")] : []),
        ...(liveSuffix ? [createSpan(liveSuffix, "accent")] : []),
      ],
      params.width,
    ),
  ];

  if (params.descriptor.verbose) {
    const detail = params.descriptor.showLiveCursor
      ? "running"
      : params.descriptor.summary.trim() || "completed";
    rows.push(createRow(
      `${params.keyPrefix}-detail`,
      [
        createSpan("  "),
        createSpan(clampVisualText(detail, Math.max(1, params.width - 2)), "muted"),
      ],
      params.width,
    ));
  }

  return rows;
}

export function buildActionEventRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "action" }>;
  borderTone: TimelineTone;
  verbose: boolean;
  isLive: boolean;
}): TimelineRow[] {
  const tool = params.event.tool;
  const descriptor = getActionDisplayDescriptor({
    keyPrefix: params.keyPrefix,
    tool,
    width: params.width,
    verbose: params.verbose,
    isLive: params.isLive,
    borderTone: params.borderTone,
  });
  renderDebug.traceRender("ActionLog", params.event.tool.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    isLive: params.isLive,
    commandLength: params.event.tool.command.length,
    displayedToken: actionDisplayToken(descriptor),
  });

  if (renderDebug.isPlainActionsDebugEnabled()) {
    return buildPlainActionDebugRows({
      keyPrefix: params.keyPrefix,
      width: params.width,
      descriptor,
    });
  }

  const cacheKey = rowCacheKey([
    "action",
    params.keyPrefix,
    actionDisplayToken(descriptor),
  ]);

  const isCompleted = tool.status !== "running";
  if (isCompleted) {
    const cached = _completedActionRowCache.get(cacheKey);
    const completedActionTokenKey = `${params.keyPrefix}:${tool.id}`;
    const displayedToken = actionDisplayToken(descriptor);
    const previousCompletedToken = _completedActionTokenById.get(completedActionTokenKey);
    if (previousCompletedToken && previousCompletedToken !== displayedToken) {
      renderDebug.traceEvent("action", "completedSnapshotInvalidation", {
        actionId: tool.id,
        status: tool.status,
        rowKey: params.keyPrefix,
      });
    }
    renderDebug.traceFlickerEvent("actionRowBuild", {
      cache: cached ? "hit-completed" : "miss-completed",
      actionId: tool.id,
      status: tool.status,
      rowKey: params.keyPrefix,
      displayedToken,
    });
    if (cached) return cached;
  } else {
    const cached = _streamingBlockRowCache.get(cacheKey);
    renderDebug.traceFlickerEvent("actionRowBuild", {
      cache: cached ? "hit-streaming" : "miss-streaming",
      actionId: tool.id,
      status: tool.status,
      rowKey: params.keyPrefix,
      displayedToken: actionDisplayToken(descriptor),
    });
  }

  const buildActionRows = () => buildCompactActionRows({
    keyPrefix: params.keyPrefix,
    width: params.width,
    descriptor,
  });

  if (isCompleted) {
    const rows = buildActionRows();
    _completedActionRowCache.set(cacheKey, rows);
    _completedActionTokenById.set(`${params.keyPrefix}:${tool.id}`, actionDisplayToken(descriptor));
    return rows;
  }

  return getCachedStreamingBlockRows(cacheKey, buildActionRows);
}

function buildActionSummaryRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "actionSummary" }>;
  borderTone: TimelineTone;
}): TimelineRow[] {
  const label = params.event.label === "Read file" ? "read activity" : "list activity";
  const cacheKey = rowCacheKey([
    "action-summary",
    params.keyPrefix,
    params.width,
    params.event.id,
    params.event.label,
    params.event.count,
    params.borderTone,
  ]);

  return getCachedFrozenRows(cacheKey, () => buildDashCardRows({
    keyPrefix: params.keyPrefix,
    width: params.width,
    title: "action",
    borderTone: params.borderTone,
    contentRows: [[
      createSpan("✓ ", "success"),
      createSpan(`${params.event.count} repeated ${label}`, "text"),
      createSpan(" summarized", "dim"),
    ]],
  }));
}

function buildCodexResponseRows(params: {
  keyPrefix: string;
  width: number;
  run: RunEvent;
  event: Extract<StreamEvent, { kind: "response" }>;
  streaming: boolean;
  isLastEvent: boolean;
  isLive: boolean;
  verbose: boolean;
}): TimelineRow[] {
  renderDebug.traceRender("ActiveMessage", params.event.segment.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    streaming: params.streaming,
    isLive: params.isLive,
    chunkCount: params.event.segment.chunks.length,
    textLength: getResponseSegmentText(params.event.segment).length,
  });

  const segmentText = getResponseSegmentText(params.event.segment);
  const segmentStreaming = params.event.segment.status === "active";

  const buildRows = (): TimelineRow[] => {
    let responseRows: TimelineRowSpan[][] = [];
    const contentWidth = Math.max(1, params.width - transcriptContentIndent);
    const rawContent = splitSentenceWall(formatTerminalAnswerInline(segmentText));

    if (!params.streaming) _streamingRowCache = null;
    const sanitized = segmentStreaming ? sanitizeStreamChunk(rawContent) : sanitizeOutput(rawContent);
    const normalized = normalizeOutput(sanitized);
    const segments = formatForBox(classifyOutput(normalized), contentWidth);
    responseRows = buildMarkdownRows(segments, contentWidth);

    if (!params.streaming && params.run.status === "failed" && params.isLastEvent) {
      const failureMessage = sanitizeTerminalOutput(params.run.errorMessage ?? params.run.summary);
      const failureRows: TimelineRowSpan[][] = [];
      wrapPlainText(failureMessage, Math.max(1, contentWidth - 2)).forEach((row, index) => {
        failureRows.push([
          createSpan(index === 0 ? "✕ " : "  ", "error"),
          createSpan(row || " ", "error"),
        ]);
      });
      responseRows = [...failureRows, ...responseRows];
    }

    if (segmentStreaming && !params.verbose && responseRows.length > COMPACT_STREAMING_TAIL_CAP) {
      const hiddenRowCount = responseRows.length - COMPACT_STREAMING_TAIL_CAP;
      responseRows = [
        [createSpan(`… (${hiddenRowCount} line${hiddenRowCount === 1 ? "" : "s"} above)`, "dim")],
        ...responseRows.slice(-COMPACT_STREAMING_TAIL_CAP),
      ];
    }

    return buildCodexPlainRows(params.keyPrefix, params.width, responseRows);
  };

  if (!segmentStreaming) {
    const failureMessage = !params.streaming && params.run.status === "failed" && params.isLastEvent
      ? params.run.errorMessage ?? params.run.summary
      : "";
    const cacheKey = rowCacheKey([
      "response",
      params.keyPrefix,
      params.event.segment.id,
      params.event.segment.status,
      textCacheToken(segmentText),
      params.width,
      params.verbose,
      params.streaming,
      params.run.status,
      params.isLastEvent,
      textCacheToken(failureMessage),
    ]);
    return getCachedStreamingBlockRows(cacheKey, buildRows);
  }

  return buildRows();
}

// ─── Plan & unified stream rendering ─────────────────────────────────────────

function buildApprovedPlanRows(params: {
  keyPrefix: string;
  width: number;
  planText: string;
  approved: boolean;
  workspaceRoot?: string | null;
}): TimelineRow[] {
  const contentWidth = Math.max(1, params.width - 4);
  const normalized = normalizePlanReviewMarkdown(params.planText, params.workspaceRoot);
  const classified = classifyOutput(normalized);
  const formatted = formatForBox(classified, contentWidth);
  const contentRows = buildMarkdownRows(formatted, contentWidth);

  return buildDashCardRows({
    keyPrefix: params.keyPrefix,
    width: params.width,
    title: "Plan",
    rightBadge: params.approved ? "approved" : undefined,
    borderTone: "accent",
    titleTone: "text",
    badgeTone: "success",
    contentRows,
  });
}

function buildUnifiedStreamRows(item: Extract<RenderTimelineItem, { type: "turn" }>, width: number, options: { verbose?: boolean; workspaceRoot?: string | null }): TimelineRow[] {
  const run = item.item.run!;
  const streaming = item.renderState.runPhase === "streaming";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const verbose = options.verbose ?? false;
  const finalized = run.status !== "running";
  const events = compactActionBursts(collectStreamEvents(item), verbose, finalized);

  const rows: TimelineRow[] = [];

  events.forEach((event, index) => {
    const isLastEvent = index === events.length - 1;
    const isLive = run.status === "running" && isLastEvent; // The cursor is on the last event

    if (index > 0) {
      // Key the gap by the stable creation-order streamSeq, not the array
      // index, so gaps don't remount/reorder when the event set changes.
      rows.push(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, width));
    }

    if (event.kind === "thinking") {
      rows.push(...buildCodexThinkingRows({
        keyPrefix: `${item.key}-codex-thinking-${event.streamSeq}`,
        width,
        event,
        verbose,
      }));
    } else if (event.kind === "action") {
      rows.push(...buildActionEventRows({
        keyPrefix: `${item.key}-action-${event.streamSeq}`,
        width,
        event,
        borderTone: actionBorderTone,
        verbose,
        isLive,
      }));
    } else if (event.kind === "actionSummary") {
      rows.push(...buildActionSummaryRows({
        keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
        width,
        event,
        borderTone: actionBorderTone,
      }));
    } else if (event.kind === "response") {
      rows.push(...buildCodexResponseRows({
        keyPrefix: `${item.key}-codex-response-${event.streamSeq}`,
        width,
        run,
        event,
        streaming,
        isLastEvent,
        isLive,
        verbose,
      }));
    } else if (event.kind === "plan") {
      rows.push(...buildApprovedPlanRows({
        keyPrefix: `${item.key}-plan-${event.streamSeq}`,
        width,
        planText: event.planText,
        approved: event.approved,
        workspaceRoot: options.workspaceRoot,
      }));
    }
  });

  if (!streaming && finalized) {
    if (run.status === "canceled") {
      rows.push(createBlankRow(`${item.key}-cancel-gap`, width));
      rows.push(...buildCodexPlainRows(
        `${item.key}-cancel`,
        width,
        wrapPlainText(sanitizeTerminalOutput(run.summary), width).map((wrapped) => [createSpan(wrapped || " ", "warning")]),
      ));
    } else if (
      run.status === "completed"
      && !events.some((event) => event.kind === "response" && getResponseSegmentText(event.segment).trim())
    ) {
      // Keep empty completed turns quiet.
    }

    if (run.truncatedOutput) {
      rows.push(...buildCodexPlainRows(`${item.key}-truncated`, width, [[createSpan(RUN_OUTPUT_TRUNCATION_NOTICE, "dim")]]));
    }

    if (verbose) {
      if (run.touchedFileCount > 0) {
        const fileScanRows = buildFileScanRows(item, width);
        if (fileScanRows.length > 0) {
          rows.push(createBlankRow(`${item.key}-files-gap`, width));
          rows.push(...fileScanRows);
        }
      }
    } else {
      const impactRows = buildImpactSummaryRows(item, width);
      if (impactRows.length > 0) {
        rows.push(createBlankRow(`${item.key}-impact-gap`, width));
        rows.push(...impactRows);
      }
    }
  }

  return rows;
}

function collectStreamEvents(item: Extract<RenderTimelineItem, { type: "turn" }>): StreamEvent[] {
  const run = item.item.run!;
  const assistant = item.item.assistant;
  const streaming = item.renderState.runPhase === "streaming";
  const blocksById = new Map<string, RunProgressBlock>();
  for (const entry of run.progressEntries ?? []) {
    for (const block of entry.blocks) blocksById.set(block.id, block);
  }
  const toolsById = new Map(run.toolActivities.map((tool) => [tool.id, tool] as const));
  const segmentsById = new Map((run.responseSegments ?? []).map((seg) => [seg.id, seg] as const));

  const events: StreamEvent[] = [];
  const sortedItems = (run.streamItems ?? []).slice().sort((a, b) => a.streamSeq - b.streamSeq);
  for (const it of sortedItems) {
    if (it.kind === "thinking") {
      // Active-turn topology stability: while the run is live we never surface
      // reasoning blocks. A thinking block is assigned its streamSeq early (when
      // its reasoning first streams) but only *completes* later — revealing it
      // mid-stream slots it in at that early streamSeq, ABOVE answer/action
      // blocks that have already streamed at higher streamSeqs. That late
      // insert-above is what reorders the live turn. Defer all reasoning to
      // finalize, where the full streamSeq order (reasoning included) reflows
      // atomically. (Height grows when it appears — never shrinks mid-stream.)
      if (run.status !== "running") {
        const block = blocksById.get(it.refId);
        if (block && block.text.trim().length > 0) {
          events.push({
            kind: "thinking",
            streamSeq: it.streamSeq,
            block,
          });
        }
      }
    } else if (it.kind === "action") {
      const tool = toolsById.get(it.refId);
      if (tool) events.push({ kind: "action", streamSeq: it.streamSeq, tool });
    } else if (it.kind === "response") {
      const segment = segmentsById.get(it.refId);
      if (segment) events.push({ kind: "response", streamSeq: it.streamSeq, segment });
    } else if (it.kind === "plan") {
      const planText = run.plan?.id === it.refId
        ? getRunPlanText(run.plan)
        : run.approvedPlan ?? "";
      if (planText.trim()) {
        events.push({
          kind: "plan",
          streamSeq: it.streamSeq,
          planText,
          approved: Boolean(run.approvedPlan),
        });
      }
    }
  }

  // Backward-compat fallback for older session data that predates streamItems.
  // New runs always use the streamItems path above.
  if (events.length === 0 && sortedItems.length === 0) {
    let legacySeq = 0;
    for (const entry of run.progressEntries ?? []) {
      if (!VISIBLE_THINKING_SOURCES.has(entry.source)) continue;
      for (const block of entry.blocks) {
        if (!block.text.trim()) continue;
        // Same active-turn topology rule as the streamItems path: defer all
        // reasoning while the run is live so it cannot insert above already
        // streamed answer/action blocks. Reveal only once finalized.
        if (run.status === "running") continue;
        legacySeq += 1;
        events.push({
          kind: "thinking",
          streamSeq: legacySeq,
          block,
        });
      }
    }

    for (const tool of run.toolActivities ?? []) {
      legacySeq += 1;
      events.push({ kind: "action", streamSeq: legacySeq, tool });
    }

    for (const segment of run.responseSegments ?? []) {
      if (!getResponseSegmentText(segment).trim() && !streaming) continue;
      legacySeq += 1;
      events.push({ kind: "response", streamSeq: legacySeq, segment });
    }
  }

  // First-render fallback: nothing resolvable yet but assistant text exists.
  if (events.length === 0 && (getAssistantContent(assistant).length > 0 || streaming)) {
    const synthetic: RunResponseSegment = {
      id: `synthetic-${run.id}`,
      streamSeq: 1,
      chunks: [getAssistantContent(assistant)],
      status: streaming ? "active" : "completed",
      startedAt: run.startedAt,
    };
    events.push({ kind: "response", streamSeq: 1, segment: synthetic });
  }

  return coalesceConsecutiveThinking(events);
}

// ─── Turn assembly & static caching ──────────────────────────────────────────

function buildTurnRows(
  item: Extract<RenderTimelineItem, { type: "turn" }>,
  width: number,
  options: { verbose?: boolean; workspaceRoot?: string | null } = {},
): TimelineRow[] {
  const verbose = options.verbose ?? false;
  const rows: TimelineRow[] = [];

  rows.push(...buildUserInputRows(item, width));
  rows.push(createBlankRow(`${item.key}-prompt-gap`, width));

  if (item.item.run) {
    rows.push(...buildUnifiedStreamRows(item, width, options));
  }

  rows.push(...buildActionRequiredRows(item, width));
  rows.push(createBlankRow(`${item.key}-turn-end-gap`, width));
  return applyTurnOpacity(rows, item.renderState.opacity);
}

function wrapRows(
  rows: TimelineRow[],
  totalWidth: number,
  padded: boolean,
  keyPrefix: string,
  includeMargin: boolean,
): TimelineRow[] {
  const leftPad = padded ? 1 : 0;
  const innerWidth = Math.max(1, totalWidth - (leftPad * 2));
  const prefixedRows = rows.map((row) => {
    const cacheKey = `${keyPrefix}:${row.key}:${totalWidth}:${innerWidth}:${leftPad}`;
    let rowCache = _wrappedRowCache.get(row);
    if (!rowCache) {
      rowCache = new Map<string, TimelineRow>();
      _wrappedRowCache.set(row, rowCache);
    }

    const cached = rowCache.get(cacheKey);
    if (cached) return cached;

    const wrapped = createRow(
      `${keyPrefix}-wrapped-${row.key}`,
      [
        ...(leftPad > 0 ? [createSpan(" ".repeat(leftPad))] : []),
        ...padSpansToWidth(row.spans, innerWidth),
        ...(leftPad > 0 ? [createSpan(" ".repeat(leftPad))] : []),
      ],
      totalWidth,
    );
    rowCache.set(cacheKey, wrapped);
    return wrapped;
  });

  if (includeMargin) {
    const marginKey = `${keyPrefix}:${totalWidth}:margin`;
    let margin = _wrappedBlankRowCache.get(marginKey);
    if (!margin) {
      margin = createBlankRow(`${keyPrefix}-margin`, totalWidth);
      _wrappedBlankRowCache.set(marginKey, margin);
    }
    prefixedRows.push(margin);
  }
  return prefixedRows;
}

function wrapItemRows(rows: TimelineRow[], totalWidth: number, padded: boolean, keyPrefix: string): TimelineRow[] {
  return wrapRows(rows, totalWidth, padded, keyPrefix, true);
}

function rowsToSnapshot(items: BuiltTimelineItem[]): TimelineSnapshot {
  const rows = items.flatMap((item) => item.rows);
  return {
    items,
    rows,
    totalRows: rows.length,
    itemCount: items.length,
  };
}

function buildStableEventRows(item: Extract<RenderTimelineItem, { type: "event" }>, innerWidth: number): TimelineRow[] {
  const cacheKey = rowCacheKey([
    "stable-event",
    item.key,
    item.event.type,
    item.event.id,
    innerWidth,
    textCacheToken("title" in item.event ? item.event.title : item.event.command),
    textCacheToken("content" in item.event ? item.event.content : item.event.summary ?? ""),
    "status" in item.event ? item.event.status : "",
    "durationMs" in item.event ? item.event.durationMs : "",
  ]);
  return getCachedFrozenRows(cacheKey, () => buildStandaloneEventRows(item, innerWidth));
}

function buildStableIntroRows(item: Extract<RenderTimelineItem, { type: "intro" }>, innerWidth: number): TimelineRow[] {
  const cacheKey = rowCacheKey([
    "stable-intro",
    item.key,
    innerWidth,
    item.intro.version,
    item.intro.layoutMode,
    item.intro.startupHeaderMode ?? "",
    item.intro.authLabel,
    textCacheToken(item.intro.workspaceLabel),
    item.intro.providerLabel ?? "",
  ]);
  return getCachedFrozenRows(cacheKey, () => buildIntroRows(item, innerWidth));
}

function buildPlanCacheSignature(run: RunEvent | null | undefined): string {
  if (!run) return "";
  const plan = run.plan;
  return rowCacheKey([
    "plan",
    plan?.id ?? "",
    plan?.status ?? "",
    plan?.streamSeq ?? "",
    (plan?.chunks ?? []).map((chunk) => textCacheToken(chunk)),
    textCacheToken(run.approvedPlan),
    (run.streamItems ?? []).map((item) => `${item.streamSeq}:${item.kind}:${item.refId}`),
  ]);
}

function buildStableFrozenTurnRows(
  item: Extract<RenderTimelineItem, { type: "turn" }>,
  innerWidth: number,
  options: { verbose?: boolean; workspaceRoot?: string | null },
): TimelineRow[] {
  const verbose = options.verbose ?? false;
  const run = item.item.run;
  const user = item.item.user;
  const cacheKey = rowCacheKey([
    "stable-turn",
    item.key,
    innerWidth,
    verbose,
    item.renderState.opacity,
    item.renderState.runPhase,
    user?.id,
    textCacheToken(user?.prompt),
    run?.id,
    run?.status,
    buildPlanCacheSignature(run),
    run?.durationMs,
    textCacheToken(run?.summary),
    textCacheToken(item.item.assistant?.content),
    textCacheToken(item.item.assistant?.contentChunks.join("")),
    run?.toolActivities.map((tool) => `${tool.id}:${tool.status}:${tool.startedAt}:${tool.completedAt ?? ""}:${textCacheToken(tool.command)}:${textCacheToken(tool.summary)}`).join("|"),
    run?.responseSegments?.map((segment) => `${segment.id}:${segment.status}:${textCacheToken(getResponseSegmentText(segment))}`).join("|"),
    run?.progressEntries.map((entry) => `${entry.id}:${entry.blocks.map((block) => `${block.id}:${block.status}:${block.updatedAt}:${textCacheToken(block.text)}`).join(",")}`).join("|"),
    options.workspaceRoot ?? "",
  ]);
  return getCachedFrozenRows(cacheKey, () => buildTurnRows(item, innerWidth, options));
}

function isLiveStreamEvent(event: StreamEvent, run: RunEvent): boolean {
  if (run.status !== "running") return false;
  if (event.kind === "response") return event.segment.status === "active";
  if (event.kind === "action") return event.tool.status === "running";
  if (event.kind === "actionSummary") return false;
  return false;
}

function buildStableActiveTurnGroups(
  item: Extract<RenderTimelineItem, { type: "turn" }>,
  innerWidth: number,
  options: { verbose?: boolean; workspaceRoot?: string | null },
): { frozenRows: TimelineRow[]; liveRows: TimelineRow[] } {
  const verbose = options.verbose ?? false;
  const run = item.item.run;
  if (!run || (item.renderState.runPhase !== "streaming" && item.renderState.runPhase !== "thinking")) {
    return {
      frozenRows: buildStableFrozenTurnRows(item, innerWidth, options),
      liveRows: [],
    };
  }

  const streaming = item.renderState.runPhase === "streaming";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const finalized = run.status !== "running";
  const events = compactActionBursts(collectStreamEvents(item), verbose, finalized);
  let orderedRows = [...getCachedFrozenRows(rowCacheKey([
    "stable-active-user",
    item.key,
    innerWidth,
    item.renderState.opacity,
    textCacheToken(item.item.user?.prompt),
  ]), () => buildUserInputRows(item, innerWidth))];
  orderedRows.push(createBlankRow(`${item.key}-active-prompt-gap`, innerWidth));

  events.forEach((event, index) => {
    const liveEvent = isLiveStreamEvent(event, run);
    const targetRows: TimelineRow[] = [];
    const isLastEvent = index === events.length - 1;

    if (index > 0) {
      // Stable creation-order key (streamSeq), not array index — matches the
      // native path and avoids index-based remount when events change.
      targetRows.push(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, innerWidth));
    }

    if (event.kind === "thinking") {
      const build = () => buildCodexThinkingRows({
        keyPrefix: `${item.key}-codex-thinking-${event.streamSeq}`,
        width: innerWidth,
        event,
        verbose,
      });
      targetRows.push(...(liveEvent ? build() : getCachedFrozenRows(rowCacheKey([
        "stable-thinking",
        item.key,
        innerWidth,
        verbose,
        event.block.id,
        event.block.status,
        event.block.updatedAt,
        textCacheToken(event.block.text),
      ]), build)));
    } else if (event.kind === "action") {
      const build = () => buildActionEventRows({
        keyPrefix: `${item.key}-action-${event.streamSeq}`,
        width: innerWidth,
        event,
        borderTone: actionBorderTone,
        verbose,
        isLive: liveEvent,
      });
      targetRows.push(...(liveEvent ? build() : getCachedFrozenRows(rowCacheKey([
        "stable-action",
        item.key,
        innerWidth,
        verbose,
        event.tool.id,
        event.tool.status,
        event.tool.startedAt,
        event.tool.completedAt ?? "",
        textCacheToken(event.tool.command),
      ]), build)));
    } else if (event.kind === "actionSummary") {
      targetRows.push(...buildActionSummaryRows({
        keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
        width: innerWidth,
        event,
        borderTone: actionBorderTone,
      }));
    } else if (event.kind === "response") {
      const build = () => buildCodexResponseRows({
        keyPrefix: `${item.key}-codex-response-${event.streamSeq}`,
        width: innerWidth,
        run,
        event,
        streaming,
        isLastEvent,
        isLive: liveEvent,
        verbose,
      });
      targetRows.push(...(liveEvent ? build() : getCachedFrozenRows(rowCacheKey([
        "stable-response",
        item.key,
        innerWidth,
        verbose,
        run.status,
        event.segment.id,
        event.segment.status,
        textCacheToken(getResponseSegmentText(event.segment)),
      ]), build)));
    } else if (event.kind === "plan") {
      const build = () => buildApprovedPlanRows({
        keyPrefix: `${item.key}-plan-${event.streamSeq}`,
        width: innerWidth,
        planText: event.planText,
        approved: event.approved,
        workspaceRoot: options.workspaceRoot,
      });
      targetRows.push(...getCachedFrozenRows(rowCacheKey([
        "stable-plan",
        item.key,
        innerWidth,
        textCacheToken(event.planText),
        event.approved ? "approved" : "draft",
        options.workspaceRoot ?? "",
      ]), build));
    }

    orderedRows = [...orderedRows, ...targetRows];
  });

  const questionRows = buildActionRequiredRows(item, innerWidth);
  if (questionRows.length > 0) {
    orderedRows = [...orderedRows, ...questionRows];
  }

  orderedRows.push(createBlankRow(`${item.key}-active-turn-end-gap`, innerWidth));

  return {
    frozenRows: applyTurnOpacity(orderedRows, item.renderState.opacity),
    liveRows: [],
  };
}

// ─── Native transcript builders ───────────────────────────────────────────────

function isNativeLiveStreamEvent(event: StreamEvent, run: RunEvent): boolean {
  if (run.status !== "running") return false;
  if (event.kind === "action") return event.tool.status === "running";
  if (event.kind === "response") return event.segment.id === (run.activeResponseSegmentId ?? null);
  if (event.kind === "plan") return run.plan?.status === "active";
  return false;
}

function buildNativeStreamEventRows(params: {
  item: Extract<RenderTimelineItem, { type: "turn" }>;
  event: StreamEvent;
  eventIndex: number;
  innerWidth: number;
  verbose: boolean;
  workspaceRoot?: string | null;
  forceStable?: boolean;
}): TimelineRow[] {
  const { item, event, eventIndex, innerWidth, verbose } = params;
  const run = item.item.run!;
  const streaming = item.renderState.runPhase === "streaming";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const rows: TimelineRow[] = [];

  if (eventIndex > 0) {
    rows.push(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, innerWidth));
  }

  if (event.kind === "thinking") {
    rows.push(...buildCodexThinkingRows({
      keyPrefix: `${item.key}-codex-thinking-${event.streamSeq}`,
      width: innerWidth,
      event,
      verbose,
    }));
  } else if (event.kind === "action") {
    rows.push(...buildActionEventRows({
      keyPrefix: `${item.key}-action-${event.streamSeq}`,
      width: innerWidth,
      event,
      borderTone: actionBorderTone,
      verbose,
      isLive: !params.forceStable && isNativeLiveStreamEvent(event, run),
    }));
  } else if (event.kind === "actionSummary") {
    rows.push(...buildActionSummaryRows({
      keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
      width: innerWidth,
      event,
      borderTone: actionBorderTone,
    }));
  } else if (event.kind === "response") {
    const stableEvent = params.forceStable
      ? { ...event, segment: { ...event.segment, status: "completed" as const } }
      : event;
    rows.push(...buildCodexResponseRows({
      keyPrefix: `${item.key}-codex-response-${event.streamSeq}`,
      width: innerWidth,
      run,
      event: stableEvent,
      streaming,
      isLastEvent: false,
      isLive: !params.forceStable && isNativeLiveStreamEvent(event, run),
      verbose,
    }));
  } else if (event.kind === "plan") {
    rows.push(...buildApprovedPlanRows({
      keyPrefix: `${item.key}-plan-${event.streamSeq}`,
      width: innerWidth,
      planText: event.planText,
      approved: event.approved,
      workspaceRoot: params.workspaceRoot,
    }));
  }

  return rows;
}

function wrapNativeRows(
  rows: TimelineRow[],
  totalWidth: number,
  padded: boolean,
  keyPrefix: string,
): TimelineRow[] {
  return wrapRows(rows, totalWidth, padded, keyPrefix, false);
}

function appendNativeTurnParts(
  output: NativeTranscriptParts,
  item: Extract<RenderTimelineItem, { type: "turn" }>,
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    workspaceRoot?: string | null;
  },
): void {
  const run = item.item.run;
  const innerWidth = Math.max(10, options.totalWidth - (item.padded ? 2 : 0));
  const verbose = options.verboseMode ?? false;
  const running = run?.status === "running";

  if (item.item.user) {
    const userRows = wrapNativeRows(
      buildUserInputRows(item, innerWidth),
      options.totalWidth,
      item.padded,
      item.key,
    );
    const promptGapRow = createBlankRow(`${item.key}-prompt-gap-row`, options.totalWidth);
    if (running) {
      output.liveRows.push(...userRows, promptGapRow);
    } else {
      output.staticItems.push({ key: `${item.key}-user`, rows: userRows });
      output.staticItems.push({ key: `${item.key}-prompt-gap`, rows: [promptGapRow] });
    }
  }

  if (!run) return;

  const events = compactActionBursts(
    collectStreamEvents(item),
    verbose,
    run.status !== "running",
  );
  events.forEach((event, eventIndex) => {
    // Ink <Static> is append-only and cannot reflow after a terminal resize.
    // Keep the complete active turn live, then commit it atomically on finalize.
    const placeAsLive = running;
    // Rendering: only the event that is currently active gets a live indicator
    // (spinner / streaming cursor). Completed events render in stable form even
    // while their parent run is still running.
    const isLiveRender = placeAsLive && isNativeLiveStreamEvent(event, run);
    const rows = buildNativeStreamEventRows({
      item,
      event,
      eventIndex,
      innerWidth,
      verbose,
      workspaceRoot: options.workspaceRoot,
      forceStable: !isLiveRender,
    });

    const wrappedRows = wrapNativeRows(rows, options.totalWidth, item.padded, item.key);
    if (placeAsLive) {
      output.liveRows.push(...wrappedRows);
    } else {
      output.staticItems.push({
        key: `${item.key}-stream-${event.streamSeq}`,
        rows: wrappedRows,
      });
    }
  });

  const questionRows = buildActionRequiredRows(item, innerWidth);
  if (questionRows.length > 0) {
    output.liveRows.push(...wrapNativeRows(questionRows, options.totalWidth, item.padded, item.key));
  }

  const endGapRow = createBlankRow(`${item.key}-turn-end-gap-row`, options.totalWidth);
  if (run && run.status === "running") {
    output.liveRows.push(endGapRow);
  } else {
    output.staticItems.push({
      key: `${item.key}-turn-end-gap`,
      rows: [endGapRow],
    });
  }
}

export function buildNativeTranscriptParts(
  items: RenderTimelineItem[],
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    debugLabel?: string;
    workspaceRoot?: string | null;
  },
): NativeTranscriptParts {
  renderDebug.traceEvent("timeline", "buildNativeTranscriptParts", {
    debugLabel: options.debugLabel ?? "native",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose: options.verboseMode ?? false,
  });

  const output: NativeTranscriptParts = {
    staticItems: [],
    liveRows: [],
  };

  for (const item of items) {
    if (item.type === "turn") {
      appendNativeTurnParts(output, item, options);
      continue;
    }

    output.staticItems.push({
      key: item.key,
      rows: buildTimelineSnapshot([item], options).rows,
    });
  }

  return output;
}

// ─── Public snapshot builders ─────────────────────────────────────────────────

export function buildStableTimelineSnapshot(
  items: RenderTimelineItem[],
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    debugLabel?: string;
    workspaceRoot?: string | null;
  },
): StableTimelineSnapshot {
  const verbose = options.verboseMode ?? false;
  renderDebug.traceFlickerEvent("snapshotBuild", {
    reason: options.debugLabel ?? "stable",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
    stable: true,
  });

  const builtItems: BuiltTimelineItem[] = [];
  const frozenRows: TimelineRow[] = [];
  const liveRows: TimelineRow[] = [];

  for (const item of items) {
    const innerWidth = Math.max(10, options.totalWidth - (item.padded ? 2 : 0));
    let itemFrozenRows: TimelineRow[];
    let itemLiveRows: TimelineRow[];

    if (item.type === "intro") {
      itemFrozenRows = buildStableIntroRows(item, innerWidth);
      itemLiveRows = [];
    } else if (item.type === "event") {
      itemFrozenRows = buildStableEventRows(item, innerWidth);
      itemLiveRows = [];
    } else {
      const groups = buildStableActiveTurnGroups(item, innerWidth, {
        verbose,
        workspaceRoot: options.workspaceRoot,
      });
      itemFrozenRows = groups.frozenRows;
      itemLiveRows = groups.liveRows;
    }

    const hasLiveRows = itemLiveRows.length > 0;
    const wrappedFrozenRows = wrapRows(itemFrozenRows, options.totalWidth, item.padded, item.key, !hasLiveRows);
    const wrappedLiveRows = hasLiveRows
      ? wrapRows(itemLiveRows, options.totalWidth, item.padded, item.key, true)
      : [];
    const rows = [...wrappedFrozenRows, ...wrappedLiveRows];
    frozenRows.push(...wrappedFrozenRows);
    liveRows.push(...wrappedLiveRows);
    builtItems.push({
      key: item.key,
      rows,
      rowCount: rows.length,
    });
  }

  return {
    snapshot: rowsToSnapshot(builtItems),
    frozenRows,
    liveRows,
  };
}

export function buildTimelineSnapshot(
  items: RenderTimelineItem[],
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    debugLabel?: string;
    workspaceRoot?: string | null;
  },
): TimelineSnapshot {
  const verbose = options.verboseMode ?? false;
  renderDebug.traceEvent("timeline", "buildSnapshot", {
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
  });
  renderDebug.traceFlickerEvent("snapshotBuild", {
    reason: options.debugLabel ?? "unknown",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
  });

  const builtItems = items.map((item) => {
    const innerWidth = Math.max(10, options.totalWidth - (item.padded ? 2 : 0));

    let builtRows: TimelineRow[];

    if (item.type === "intro") {
      const cacheKey = `i:${item.key}:${innerWidth}:${item.intro.version}:${item.intro.layoutMode}:${item.intro.startupHeaderMode ?? ""}:${item.intro.authLabel}:${item.intro.workspaceLabel}:${item.intro.providerLabel ?? ""}:v${LOGO_LARGE_MIN_COLS}`;
      const cached = _staticRowCache.get(cacheKey);
      if (cached) {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "intro",
          cache: "hit",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "staticCacheHit", { cacheKey, itemType: "intro" });
        builtRows = cached;
      } else {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "intro",
          cache: "miss",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "staticCacheMiss", { cacheKey, itemType: "intro" });
        const r = buildIntroRows(item, innerWidth);
        _staticRowCache.set(cacheKey, r);
        builtRows = r;
      }
    } else if (item.type === "event") {
      // Standalone events are immutable for a given event payload, not just id.
      const cacheKey = rowCacheKey([
        "event",
        item.key,
        item.event.type,
        item.event.id,
        innerWidth,
        textCacheToken("title" in item.event ? item.event.title : item.event.command),
        textCacheToken("content" in item.event ? item.event.content : item.event.summary ?? ""),
        "status" in item.event ? item.event.status : "",
        "durationMs" in item.event ? item.event.durationMs : "",
      ]);
      const cached = _staticRowCache.get(cacheKey);
      if (cached) {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "event",
          cache: "hit",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "staticCacheHit", { cacheKey, itemType: "event" });
        builtRows = cached;
      } else {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "event",
          cache: "miss",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "staticCacheMiss", { cacheKey, itemType: "event" });
        const r = buildStandaloneEventRows(item, innerWidth);
        _staticRowCache.set(cacheKey, r);
        builtRows = r;
      }
    } else {
      const { runPhase, opacity } = item.renderState;
      // Only cache completed turns (runPhase "none"/"final") at a stable
      // opacity.  Streaming and thinking items change every tick and use the
      // _streamingRowCache instead.
      const cacheable = runPhase !== "streaming" && runPhase !== "thinking";
      if (cacheable) {
        const cacheKey = rowCacheKey([
          "turn",
          item.key,
          innerWidth,
          verbose,
          runPhase,
          opacity,
          options.workspaceRoot ?? "",
          buildPlanCacheSignature(item.item.run),
        ]);
        const cached = _staticRowCache.get(cacheKey);
        if (cached) {
          renderDebug.traceEvent("timeline", "rowGeneration", {
            itemKey: item.key,
            itemType: "turn",
            runPhase,
            opacity,
            cache: "hit",
            innerWidth,
          });
          renderDebug.traceEvent("timeline", "staticCacheHit", { cacheKey, itemType: "turn", runPhase, opacity });
          builtRows = cached;
        } else {
          renderDebug.traceEvent("timeline", "rowGeneration", {
            itemKey: item.key,
            itemType: "turn",
            runPhase,
            opacity,
            cache: "miss",
            innerWidth,
          });
          renderDebug.traceEvent("timeline", "staticCacheMiss", { cacheKey, itemType: "turn", runPhase, opacity });
          const r = buildTurnRows(item, innerWidth, {
            verbose,
            workspaceRoot: options.workspaceRoot,
          });
          _staticRowCache.set(cacheKey, r);
          builtRows = r;
        }
      } else {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "turn",
          runPhase,
          opacity,
          cache: "active",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "activeBuild", { itemKey: item.key, runPhase, opacity });
        builtRows = buildTurnRows(item, innerWidth, {
          verbose,
          workspaceRoot: options.workspaceRoot,
        });
      }
    }

    const rows = wrapItemRows(builtRows, options.totalWidth, item.padded, item.key);
    return {
      key: item.key,
      rows,
      rowCount: rows.length,
    };
  });

  return rowsToSnapshot(builtItems);
}
