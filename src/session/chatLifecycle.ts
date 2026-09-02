import { MAX_CHAT_LINES } from "../config/settings.js";
import type { AvailableBackend } from "../config/settings.js";
import type { ResolvedRuntimeConfig } from "../config/runtimeConfig.js";
import type { BackendProgressUpdate } from "../core/providers/types.js";
import { summarizeRunActivity, type RunFileActivity } from "../core/workspace/workspaceActivity.js";
import * as renderDebug from "../core/perf/renderDebug.js";
import type {
  RunEvent,
  RunPlanBlock,
  RunProgressBlock,
  RunProgressEntry,
  RunResponseSegment,
  RunStreamItem,
  RunToolActivity,
  SystemEvent,
  ErrorEvent,
  TimelineEvent,
  UIState,
} from "./types.js";
import { getRunPlanText } from "./types.js";

// ─── Types & constants ────────────────────────────────────────────────────────

export const RUN_OUTPUT_TRUNCATION_NOTICE = "Older output was truncated to keep the UI responsive.";
const ACTION_REQUIRED_BLOCK_PATTERN = /\*{0,2}=+\*{0,2}\s*\n\*{0,2}\[ACTION REQUIRED\]\*{0,2}\s*\n\*{0,2}Verification Question:\*{0,2}\s*\n([\s\S]*?)\n\*{0,2}=+\*{0,2}/i;

export type ConfigMutationKind = "backend" | "model" | "mode" | "reasoning" | "permissions" | "theme";
export type UIStateAction =
  | { type: "PROMPT_RUN_STARTED"; turnId: number }
  | { type: "FIRST_ASSISTANT_DELTA"; turnId: number }
  | { type: "FINAL_ANSWER_VISIBLE"; turnId: number }
  | { type: "RUN_COMPLETED"; turnId: number }
  | { type: "RUN_FAILED"; turnId: number; message: string }
  | { type: "RUN_CANCELED"; turnId: number }
  | { type: "AWAITING_USER_ACTION"; turnId: number; question: string }
  | { type: "DISMISS_TRANSIENT" }
  | { type: "SHELL_STARTED"; shellId: number }
  | { type: "SHELL_FINISHED"; shellId: number };

const BUSY_NOTICE_BY_KIND: Record<ConfigMutationKind, string> = {
  backend: "Finish the current run before changing the backend.",
  model: "Finish the current run before changing the model.",
  mode: "Finish the current run before changing the mode.",
  reasoning: "Finish the current run before changing the reasoning level.",
  permissions: "Finish the current run before changing permissions.",
  theme: "Finish the current run before changing the theme.",
};

// ─── Agent question detection ─────────────────────────────────────────────────
// Called on the final response text after a run completes.
// Returns the question string if detected, null otherwise.
//
// Detection order:
//   1. Explicit marker  [QUESTION]: <text>
//
// Ordinary assistant prose must never enter blocking-question mode just because it
// ends with a question mark. Only explicit hard-block markers should do that.

export function detectAgentQuestion(text: string): string | null {
  const explicit = text.match(/\[QUESTION\]:\s*(.+)/);
  if (explicit) return explicit[1]!.trim();

  return null;
}

function stripBoldMarkers(text: string): string {
  return text.replace(/\*\*/g, "").trim();
}

export function extractAssistantActionRequired(text: string): { content: string; question: string | null } {
  const normalized = text ?? "";
  const blockMatch = ACTION_REQUIRED_BLOCK_PATTERN.exec(normalized);

  if (blockMatch) {
    const question = stripBoldMarkers(blockMatch[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    const content = normalized.replace(blockMatch[0], "").trim();
    return {
      content,
      question: question || null,
    };
  }

  return {
    content: normalized,
    question: detectAgentQuestion(normalized),
  };
}

export function buildFollowUpPrompt(params: {
  originalPrompt: string;
  assistantQuestion: string;
  userAnswer: string;
}): string {
  return [
    "You are continuing an earlier task after pausing for one genuinely blocking clarification.",
    "",
    "Original task:",
    params.originalPrompt,
    "",
    "Your blocking question:",
    params.assistantQuestion,
    "",
    "User answer:",
    params.userAnswer,
    "",
    "Continue the task using that answer.",
    "Default to best-effort continuation instead of stopping for clarification.",
    "If another detail is missing but non-critical, make the most reasonable assumption and state it briefly.",
    "Only ask another blocking question if proceeding would likely use the wrong file, wrong command, destructive behavior, or produce fundamentally incorrect output.",
    "If you are still truly blocked on one critical missing fact, end the response with exactly one [QUESTION]: line.",
  ].join("\n");
}

// ─── UI state reducer ────────────────────────────────────────────────────────

function stateMatchesTurn(state: UIState, turnId: number): boolean {
  return "turnId" in state && state.turnId === turnId;
}

export function reduceUIState(state: UIState, action: UIStateAction): UIState {
  switch (action.type) {
    case "PROMPT_RUN_STARTED":
      return { kind: "THINKING", turnId: action.turnId };
    case "FIRST_ASSISTANT_DELTA":
      if (state.kind === "THINKING" && state.turnId === action.turnId) {
        return { kind: "RESPONDING", turnId: action.turnId };
      }
      return state;
    case "FINAL_ANSWER_VISIBLE":
      if (stateMatchesTurn(state, action.turnId)) {
        return { kind: "ANSWER_VISIBLE", turnId: action.turnId };
      }
      return state;
    case "RUN_COMPLETED":
      if (stateMatchesTurn(state, action.turnId)) {
        return { kind: "IDLE" };
      }
      return state;
    case "RUN_FAILED":
      if (stateMatchesTurn(state, action.turnId)) {
        return { kind: "ERROR", turnId: action.turnId, message: action.message };
      }
      return state;
    case "RUN_CANCELED":
      if (stateMatchesTurn(state, action.turnId)) {
        return { kind: "IDLE" };
      }
      return state;
    case "AWAITING_USER_ACTION":
      return { kind: "AWAITING_USER_ACTION", turnId: action.turnId, question: action.question };
    case "DISMISS_TRANSIENT":
      if (state.kind === "ERROR" || state.kind === "AWAITING_USER_ACTION") {
        return { kind: "IDLE" };
      }
      return state;
    case "SHELL_STARTED":
      return { kind: "SHELL_RUNNING", shellId: action.shellId };
    case "SHELL_FINISHED":
      if (state.kind === "SHELL_RUNNING" && state.shellId === action.shellId) {
        return { kind: "IDLE" };
      }
      return state;
    default:
      return state;
  }
}

// ─── Run event creation ───────────────────────────────────────────────────────

export function createRunEvent(params: {
  id: number;
  backendId: AvailableBackend;
  backendLabel: string;
  runtime: ResolvedRuntimeConfig;
  prompt: string;
  turnId: number;
  startedAtMs?: number;
  approvedPlan?: string;
  responsePresentation?: "assistant" | "plan";
}): RunEvent {
  const now = params.startedAtMs ?? Date.now();
  const plan: RunPlanBlock | null = params.approvedPlan
    ? {
      id: `plan-${params.id}`,
      streamSeq: 1,
      chunks: [params.approvedPlan],
      status: "completed",
      startedAt: now,
    }
    : null;
  return {
    id: params.id,
    type: "run",
    createdAt: now,
    startedAt: now,
    durationMs: null,
    backendId: params.backendId,
    backendLabel: params.backendLabel,
    runtime: params.runtime,
    prompt: params.prompt,
    progressEntries: [],
    status: "running",
    summary: "starting...",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId: params.turnId,
    streamItems: plan
      ? [{ streamSeq: plan.streamSeq, kind: "plan" as const, refId: plan.id }]
      : [],
    responseSegments: [],
    lastStreamSeq: plan ? plan.streamSeq : 0,
    activeResponseSegmentId: null,
    plan,
    approvedPlan: params.approvedPlan,
    responsePresentation: params.responsePresentation ?? "assistant",
  };
}

function appendStreamItem(items: RunStreamItem[], item: RunStreamItem): RunStreamItem[] {
  return [...items, item];
}

function maxStreamSeq(event: RunEvent, items: RunStreamItem[] = event.streamItems ?? []): number {
  return Math.max(event.lastStreamSeq ?? 0, ...items.map((item) => item.streamSeq));
}

function createPlanBlock(event: RunEvent, text = "", status: RunPlanBlock["status"] = "active"): RunPlanBlock {
  const streamSeq = maxStreamSeq(event) + 1;
  return {
    id: `plan-${event.id}`,
    streamSeq,
    chunks: text ? [text] : [],
    status,
    startedAt: Date.now(),
  };
}

export function appendRunPlanChunk(event: RunEvent, chunk: string): RunEvent {
  if (!chunk) return event;

  if (event.plan) {
    return {
      ...event,
      plan: {
        ...event.plan,
        chunks: [...event.plan.chunks, chunk],
        status: "active",
      },
      activeResponseSegmentId: null,
      summary: "planning...",
    };
  }

  const plan = createPlanBlock(event, chunk);
  return {
    ...event,
    plan,
    streamItems: appendStreamItem(event.streamItems ?? [], {
      streamSeq: plan.streamSeq,
      kind: "plan",
      refId: plan.id,
    }),
    lastStreamSeq: plan.streamSeq,
    activeResponseSegmentId: null,
    summary: "planning...",
  };
}

export function finalizePlanBlock(event: RunEvent, finalPlan?: string): RunEvent {
  const text = finalPlan ?? event.plan?.chunks.join("") ?? "";

  if (event.plan) {
    const streamItemsWithoutPlan = (event.streamItems ?? []).filter((item) =>
      !(item.kind === "plan" && item.refId === event.plan?.id)
    );
    const streamSeq = maxStreamSeq(event, streamItemsWithoutPlan) + 1;
    return {
      ...event,
      plan: {
        ...event.plan,
        streamSeq,
        chunks: text ? [text] : event.plan.chunks,
        status: "completed",
      },
      streamItems: appendStreamItem(streamItemsWithoutPlan, {
        streamSeq,
        kind: "plan",
        refId: event.plan.id,
      }),
      lastStreamSeq: streamSeq,
      activeResponseSegmentId: null,
    };
  }

  if (!text.trim()) {
    return { ...event, activeResponseSegmentId: null };
  }

  const plan = createPlanBlock(event, text, "completed");
  return {
    ...event,
    plan,
    streamItems: appendStreamItem(event.streamItems ?? [], {
      streamSeq: plan.streamSeq,
      kind: "plan",
      refId: plan.id,
    }),
    lastStreamSeq: plan.streamSeq,
    activeResponseSegmentId: null,
  };
}

/**
 * Plan-mode runs stream every assistant delta into the run's single plan block.
 * When a tool call starts while that block is still active, the text streamed
 * so far was the model's exploration commentary, not the plan. Demote it in
 * place into a completed ordinary response segment (same streamSeq, so the
 * transcript does not reorder) and drop the plan block; the next plan delta
 * then opens a fresh block at the tail. Approved plans are never demoted.
 */
export function demoteActivePlanToResponseSegment(event: RunEvent): RunEvent {
  const plan = event.plan;
  if (!plan || plan.status !== "active" || event.approvedPlan) return event;

  const streamItems = (event.streamItems ?? []).filter((item) =>
    !(item.kind === "plan" && item.refId === plan.id)
  );
  const text = getRunPlanText(plan);
  if (!text.trim()) {
    return { ...event, plan: null, streamItems, activeResponseSegmentId: null };
  }

  const id = `response-${event.id}-${plan.streamSeq}`;
  renderDebug.traceEvent("action", "planDemoted", {
    runId: event.id,
    turnId: event.turnId,
    streamSeq: plan.streamSeq,
    chars: text.length,
  });
  return {
    ...event,
    plan: null,
    responseSegments: [
      ...(event.responseSegments ?? []),
      { id, streamSeq: plan.streamSeq, chunks: [text], status: "completed", startedAt: plan.startedAt },
    ],
    streamItems: appendStreamItem(streamItems, { streamSeq: plan.streamSeq, kind: "response", refId: id }),
    activeResponseSegmentId: null,
  };
}

// ─── Tool activities ─────────────────────────────────────────────────────────

export function upsertRunToolActivity(inputEvent: RunEvent, activity: RunToolActivity): RunEvent {
  const existingIndex = inputEvent.toolActivities.findIndex((item) => item.id === activity.id);
  if (existingIndex < 0) {
    const event = demoteActivePlanToResponseSegment(inputEvent);
    const streamSeq = (event.lastStreamSeq ?? 0) + 1;
    const enriched: RunToolActivity = { ...activity, streamSeq };
    renderDebug.traceEvent("action", "normalized", {
      runId: event.id,
      turnId: event.turnId,
      actionId: enriched.id,
      status: enriched.status,
      streamSeq,
      operation: "insert",
      stableKeyPreserved: true,
    });
    return {
      ...event,
      toolActivities: [...event.toolActivities, enriched],
      streamItems: appendStreamItem(event.streamItems ?? [], {
        streamSeq,
        kind: "action",
        refId: enriched.id,
      }),
      lastStreamSeq: streamSeq,
      // A new tool interrupts the current response segment; the next assistant
      // delta will start a fresh segment with a larger streamSeq.
      activeResponseSegmentId: null,
    };
  }

  const event = inputEvent;
  const existing = event.toolActivities[existingIndex]!;
  const merged: RunToolActivity = {
    ...existing,
    ...activity,
    streamSeq: existing.streamSeq, // preserve original assignment
  };
  renderDebug.traceEvent("action", "normalized", {
    runId: event.id,
    turnId: event.turnId,
    actionId: merged.id,
    previousStatus: existing.status,
    status: merged.status,
    streamSeq: merged.streamSeq,
    operation: "merge",
    stableKeyPreserved: existing.streamSeq === merged.streamSeq,
  });
  const nextToolActivities = [...event.toolActivities];
  nextToolActivities[existingIndex] = merged;
  return {
    ...event,
    toolActivities: nextToolActivities,
  };
}

function finalizePendingToolActivities(
  toolActivities: RunToolActivity[],
  finalStatus: "completed" | "failed" | "canceled",
): RunToolActivity[] {
  const fallbackStatus = finalStatus === "completed" ? "completed" : "failed";
  const fallbackSummary = finalStatus === "completed"
    ? "Completed"
    : finalStatus === "canceled"
      ? "Canceled"
      : "Failed";

  return toolActivities.map((item) => (
    item.status === "running"
      ? {
        ...item,
        status: fallbackStatus,
        completedAt: item.completedAt ?? Date.now(),
        summary: item.summary ?? fallbackSummary,
      }
      : item
  ));
}

function mergeRunActivity(existing: RunFileActivity[], additions: RunFileActivity[]): RunFileActivity[] {
  const merged = [...existing];

  for (const item of additions) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.path === item.path &&
      last.operation === item.operation &&
      item.operation === "modified"
    ) {
      merged[merged.length - 1] = item;
      continue;
    }

    merged.push(item);
  }

  return merged;
}

export function appendRunActivity(event: RunEvent, additions: RunFileActivity[]): RunEvent {
  if (additions.length === 0) return event;

  const activity = mergeRunActivity(event.activity, additions);
  const touchedFileCount = new Set(activity.map((item) => item.path)).size;

  return {
    ...event,
    activity,
    touchedFileCount,
    activitySummary: summarizeRunActivity(activity),
    summary: touchedFileCount > 0
      ? `${touchedFileCount} file${touchedFileCount === 1 ? "" : "s"} modified`
      : "working...",
  };
}

// ─── Progress blocks ─────────────────────────────────────────────────────────

function trimProgressText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

function createProgressBlock(entryId: string, sequence: number, createdAt: number): RunProgressBlock {
  return {
    id: `${entryId}-block-${sequence}`,
    text: "",
    sequence,
    createdAt,
    updatedAt: createdAt,
    status: "active",
  };
}

// Split streaming progress blocks at readable sentence and list boundaries.
const MIN_PROGRESS_BLOCK_CHARS = 36;
const TRANSITION_PHRASE_PATTERN = String.raw`(?:I(?:'|’)m going to|I(?:'|’)ll|I found|I(?:'|’)m checking|I'm checking|I am checking|Next(?:,|\s)|The highest-value improvements|The highest value improvements)`;
const INLINE_TRANSITION_PATTERN = new RegExp(String.raw`[.!?]\s+(?=${TRANSITION_PHRASE_PATTERN}\b)`, "i");
const NEWLINE_TRANSITION_PATTERN = new RegExp(String.raw`\n(?=${TRANSITION_PHRASE_PATTERN}\b)`, "i");
const LIST_MARKER_PATTERN = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const NEWLINE_LIST_MARKER_PATTERN = /\n(?=\s*(?:[-*+]\s+|\d+[.)]\s+))/;

function hasCommittedBlockText(blocks: RunProgressBlock[]): boolean {
  return blocks.some((block) => block.text.length > 0);
}

function hasMeaningfulBlockText(text: string): boolean {
  return text.trim().length >= MIN_PROGRESS_BLOCK_CHARS;
}

function findReadableBoundary(text: string): { splitAt: number; trimLeft: boolean } | null {
  if (!hasMeaningfulBlockText(text)) {
    return null;
  }

  const transitionMatch = INLINE_TRANSITION_PATTERN.exec(text);
  if (transitionMatch && transitionMatch.index + transitionMatch[0].length < text.length) {
    const splitAt = transitionMatch.index + transitionMatch[0].length;
    if (hasMeaningfulBlockText(text.slice(0, splitAt))) {
      return { splitAt, trimLeft: false };
    }
  }

  const newlineTransitionMatch = NEWLINE_TRANSITION_PATTERN.exec(text);
  if (newlineTransitionMatch && newlineTransitionMatch.index > 0) {
    const splitAt = newlineTransitionMatch.index;
    if (hasMeaningfulBlockText(text.slice(0, splitAt))) {
      return { splitAt, trimLeft: true };
    }
  }

  const newlineListMatch = NEWLINE_LIST_MARKER_PATTERN.exec(text);
  if (newlineListMatch && newlineListMatch.index > 0) {
    const before = text.slice(0, newlineListMatch.index);
    const after = text.slice(newlineListMatch.index + 1);
    if (
      hasMeaningfulBlockText(before)
      && !LIST_MARKER_PATTERN.test(before.split("\n").findLast((line) => line.trim()) ?? "")
      && LIST_MARKER_PATTERN.test(after)
    ) {
      return { splitAt: newlineListMatch.index, trimLeft: true };
    }
  }

  return null;
}

function appendDeltaToProgressEntry(
  entry: RunProgressEntry,
  delta: string,
  updatedAt: number,
): Pick<RunProgressEntry, "blocks" | "pendingNewlineCount"> {
  let blocks = entry.blocks.slice();
  let pendingNewlineCount = entry.pendingNewlineCount;

  const ensureActiveBlock = (): number => {
    const last = blocks[blocks.length - 1];
    if (last?.status === "active") {
      return blocks.length - 1;
    }

    const nextSequence = last?.sequence ?? 0;
    blocks.push(createProgressBlock(entry.id, nextSequence + 1, updatedAt));
    return blocks.length - 1;
  };

  const updateBlock = (index: number, updater: (block: RunProgressBlock) => RunProgressBlock) => {
    blocks[index] = updater(blocks[index]!);
  };

  const splitActiveBlockAtReadableBoundary = () => {
    let activeIndex = -1;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index]?.status === "active") {
        activeIndex = index;
        break;
      }
    }
    if (activeIndex < 0) return;

    const block = blocks[activeIndex]!;
    const boundary = findReadableBoundary(block.text);
    if (!boundary) return;

    const completedText = block.text.slice(0, boundary.splitAt).trimEnd();
    const activeText = block.text.slice(boundary.splitAt + (boundary.trimLeft ? 1 : 0)).trimStart();
    if (!completedText || !activeText) return;

    blocks[activeIndex] = {
      ...block,
      text: completedText,
      status: "completed",
      updatedAt,
    };
    blocks.splice(activeIndex + 1, 0, {
      ...createProgressBlock(entry.id, block.sequence + 1, updatedAt),
      text: activeText,
    });
    blocks = blocks.map((candidate, index) => ({
      ...candidate,
      sequence: index + 1,
      id: `${entry.id}-block-${index + 1}`,
    }));
  };

  for (const char of delta) {
    if (char === "\n") {
      pendingNewlineCount += 1;
      continue;
    }

    if (pendingNewlineCount >= 2) {
      const last = blocks[blocks.length - 1];
      if (last?.status === "active") {
        updateBlock(blocks.length - 1, (block) => ({ ...block, status: "completed", updatedAt }));
      }
    } else if (pendingNewlineCount === 1 && hasCommittedBlockText(blocks)) {
      const activeIndex = ensureActiveBlock();
      updateBlock(activeIndex, (block) => ({
        ...block,
        text: `${block.text}\n`,
        updatedAt,
      }));
    }

    pendingNewlineCount = 0;
    const activeIndex = ensureActiveBlock();
    updateBlock(activeIndex, (block) => ({
      ...block,
      text: `${block.text}${char}`,
      updatedAt,
    }));
    splitActiveBlockAtReadableBoundary();
  }

  if (pendingNewlineCount >= 2) {
    const last = blocks[blocks.length - 1];
    if (last?.status === "active") {
      updateBlock(blocks.length - 1, (block) => ({ ...block, status: "completed", updatedAt }));
    }
  }

  return { blocks, pendingNewlineCount };
}

function materializeProgressEntry(
  entry: RunProgressEntry,
  nextText: string,
  updatedAt: number,
  source: BackendProgressUpdate["source"],
): RunProgressEntry {
  if (nextText === entry.text) {
    return {
      ...entry,
      source,
      updatedAt,
    };
  }

  if (nextText.startsWith(entry.text)) {
    const delta = nextText.slice(entry.text.length);
    const next = appendDeltaToProgressEntry(entry, delta, updatedAt);
    return {
      ...entry,
      source,
      text: nextText,
      updatedAt,
      blocks: next.blocks,
      pendingNewlineCount: next.pendingNewlineCount,
    };
  }

  const rebuiltSeed: RunProgressEntry = {
    ...entry,
    source,
    text: "",
    updatedAt,
    blocks: [],
    pendingNewlineCount: 0,
  };
  const rebuilt = appendDeltaToProgressEntry(rebuiltSeed, nextText, updatedAt);

  const blocks = rebuilt.blocks.map((block, index) => {
    const existing = entry.blocks[index];
    if (
      existing
      && existing.sequence === block.sequence
      && existing.text === block.text
      && existing.status === block.status
    ) {
      return existing;
    }

    return {
      ...block,
      id: existing?.id ?? block.id,
      createdAt: existing?.createdAt ?? block.createdAt,
    };
  });

  return {
    ...entry,
    source,
    text: nextText,
    updatedAt,
    blocks,
    pendingNewlineCount: rebuilt.pendingNewlineCount,
  };
}

/** Sources that surface as user-facing thinking items. */
const THINKING_SOURCES = new Set(["reasoning", "todo", "transcript"]);

export function appendRunThinking(event: RunEvent, updates: BackendProgressUpdate[]): RunEvent {
  if (updates.length === 0) return event;
  renderDebug.traceEvent("transcript", "progressBatchNormalize", {
    runId: event.id,
    turnId: event.turnId,
    updateCount: updates.length,
    previousProgressEntries: event.progressEntries.length,
  });

  let nextSequence = event.progressEntries[event.progressEntries.length - 1]?.sequence ?? 0;
  let progressEntries = [...event.progressEntries];
  let truncatedOutput = event.truncatedOutput;

  for (const update of updates) {
    const text = trimProgressText(update.text ?? "");
    if (!text.trim()) continue;
    const updatedAt = Date.now();

    const existingIndex = progressEntries.findIndex((entry) => entry.id === update.id);
    if (existingIndex >= 0) {
      const existing = progressEntries[existingIndex]!;
      progressEntries[existingIndex] = materializeProgressEntry(existing, text, updatedAt, update.source);
      continue;
    }

    nextSequence += 1;
    const createdAt = updatedAt;
    const seed: RunProgressEntry = {
      id: update.id,
      source: update.source,
      sequence: nextSequence,
      createdAt,
      updatedAt,
      text: "",
      blocks: [],
      pendingNewlineCount: 0,
    };
    progressEntries.push(materializeProgressEntry(seed, text, updatedAt, update.source));
  }

  // Assign turn-global streamSeq to newly visible thinking blocks. Only
  // reasoning/todo entries surface as thinking — tool/stderr/transcript
  // text is diagnostic and never becomes a stream item.
  let streamItems = event.streamItems ?? [];
  let lastStreamSeq = event.lastStreamSeq ?? 0;
  let activeResponseSegmentId = event.activeResponseSegmentId ?? null;
  let anyVisibleNewBlock = false;

  progressEntries = progressEntries.map((entry) => {
    if (!THINKING_SOURCES.has(entry.source)) return entry;
    let entryChanged = false;
    const blocks = entry.blocks.map((block) => {
      if (block.streamSeq != null) return block;
      if (block.text.trim().length === 0) return block;
      anyVisibleNewBlock = true;
      lastStreamSeq += 1;
      const next: RunProgressBlock = { ...block, streamSeq: lastStreamSeq };
      streamItems = appendStreamItem(streamItems, {
        streamSeq: lastStreamSeq,
        kind: "thinking",
        refId: block.id,
      });
      entryChanged = true;
      return next;
    });
    return entryChanged ? { ...entry, blocks } : entry;
  });

  if (anyVisibleNewBlock) {
    activeResponseSegmentId = null;
  }

  if (progressEntries.length > MAX_CHAT_LINES) {
    progressEntries = progressEntries.slice(-MAX_CHAT_LINES);
    truncatedOutput = true;
  }

  return {
    ...event,
    progressEntries,
    truncatedOutput,
    streamItems,
    lastStreamSeq,
    activeResponseSegmentId,
    summary: "processing...",
  };
}

// ─── Assistant response segments ─────────────────────────────────────────────

/**
 * Append a response chunk. Extends the currently active response segment if
 * one exists (`activeResponseSegmentId`); otherwise opens a new segment with
 * a freshly allocated streamSeq, becoming the new active segment.
 *
 * A thinking or action event between deltas clears `activeResponseSegmentId`,
 * which is what produces correct response → action → response interleaving.
 */
export function appendRunResponseChunk(event: RunEvent, chunk: string): RunEvent {
  if (!chunk) return event;

  const segments = event.responseSegments ?? [];
  const activeId = event.activeResponseSegmentId ?? null;

  if (activeId) {
    const index = segments.findIndex((segment) => segment.id === activeId);
    if (index >= 0) {
      const existing = segments[index]!;
      const updated: RunResponseSegment = { ...existing, chunks: [...existing.chunks, chunk] };
      const nextSegments = [...segments];
      nextSegments[index] = updated;
      return { ...event, responseSegments: nextSegments };
    }
  }

  const streamSeq = (event.lastStreamSeq ?? 0) + 1;
  const segmentId = `response-${event.id}-${streamSeq}`;
  const newSegment: RunResponseSegment = {
    id: segmentId,
    streamSeq,
    chunks: [chunk],
    status: "active",
    startedAt: Date.now(),
  };

  return {
    ...event,
    responseSegments: [...segments, newSegment],
    streamItems: appendStreamItem(event.streamItems ?? [], {
      streamSeq,
      kind: "response",
      refId: segmentId,
    }),
    lastStreamSeq: streamSeq,
    activeResponseSegmentId: segmentId,
  };
}

/**
 * Mark all response segments completed. Optionally rewrite the trailing
 * segment's chunks to an authoritative final response (e.g. when the
 * backend returns a different response than what was streamed).
 */
export function finalizeResponseSegments(event: RunEvent, finalResponse?: string): RunEvent {
  renderDebug.traceEvent("action", "regroupedForFinalize", {
    runId: event.id,
    turnId: event.turnId,
    toolActivities: event.toolActivities.length,
    streamItems: event.streamItems?.length ?? 0,
    responseSegments: event.responseSegments?.length ?? 0,
    hasFinalResponseOverride: Boolean(finalResponse),
  });
  const segments = event.responseSegments ?? [];
  if (segments.length === 0) {
    if (!finalResponse) return event;
    const seq = (event.lastStreamSeq ?? 0) + 1;
    const id = `response-final-${event.id}-${seq}`;
    return {
      ...event,
      responseSegments: [{
        id,
        streamSeq: seq,
        chunks: [finalResponse],
        status: "completed",
        startedAt: Date.now(),
      }],
      streamItems: appendStreamItem(event.streamItems ?? [], {
        streamSeq: seq,
        kind: "response",
        refId: id,
      }),
      lastStreamSeq: seq,
      activeResponseSegmentId: null,
    };
  }

  const nextSegments = segments.map((segment, index) => {
    if (index === segments.length - 1 && finalResponse != null) {
      return { ...segment, chunks: [finalResponse], status: "completed" as const };
    }
    return segment.status === "active" ? { ...segment, status: "completed" as const } : segment;
  });
  return { ...event, responseSegments: nextSegments, activeResponseSegmentId: null };
}

export function markResponseSegmentsCompleted(event: RunEvent, finalResponse?: string): RunEvent {
  return finalizeResponseSegments(event, finalResponse);
}

export const appendRunOutput = appendRunThinking;

// ─── Run lifecycle ────────────────────────────────────────────────────────────

export function completeRunEvent(event: RunEvent, durationMs = Date.now() - event.startedAt): RunEvent {
  const touchedSuffix = event.touchedFileCount > 0
    ? ` · ${event.touchedFileCount} file${event.touchedFileCount === 1 ? "" : "s"} touched`
    : "";

  return {
    ...event,
    status: "completed",
    durationMs,
    activitySummary: summarizeRunActivity(event.activity),
    toolActivities: finalizePendingToolActivities(event.toolActivities, "completed"),
    errorMessage: null,
    summary: event.progressEntries.length > 0 || event.activity.length > 0
      ? `Run completed successfully${touchedSuffix}`
      : "Run completed with no visible output",
  };
}

export function failRunEvent(
  event: RunEvent,
  summary = "Run failed",
  errorMessage?: string,
  durationMs = Date.now() - event.startedAt,
): RunEvent {
  return {
    ...event,
    status: "failed",
    durationMs,
    activitySummary: summarizeRunActivity(event.activity),
    toolActivities: finalizePendingToolActivities(event.toolActivities, "failed"),
    errorMessage: errorMessage ?? summary,
    summary: event.touchedFileCount > 0
      ? `${summary} · ${event.touchedFileCount} file${event.touchedFileCount === 1 ? "" : "s"} touched`
      : summary,
  };
}

export function cancelRunEvent(event: RunEvent, durationMs = Date.now() - event.startedAt): RunEvent {
  return {
    ...event,
    status: "canceled",
    durationMs,
    activitySummary: summarizeRunActivity(event.activity),
    toolActivities: finalizePendingToolActivities(event.toolActivities, "canceled"),
    errorMessage: null,
    summary: event.touchedFileCount > 0
      ? `Run canceled · ${event.touchedFileCount} file${event.touchedFileCount === 1 ? "" : "s"} touched`
      : "Run canceled",
  };
}

// ─── Event routing ───────────────────────────────────────────────────────────

export function appendStaticEvents(events: TimelineEvent[], additions: TimelineEvent[]): TimelineEvent[] {
  const result = [...events];
  for (const addition of additions) {
    const last = result[result.length - 1];
    let isDuplicate = false;
    if (last && last.type === addition.type) {
      if (addition.type === "system" || addition.type === "error") {
        const lastTyped = last as SystemEvent | ErrorEvent;
        const additionTyped = addition as SystemEvent | ErrorEvent;
        isDuplicate = lastTyped.title === additionTyped.title && lastTyped.content === additionTyped.content;
      }
    }

    if (!isDuplicate) {
      result.push(addition);
    }
  }
  return result;
}

export function trimStaticEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events;
}

export function guardConfigMutation(kind: ConfigMutationKind, busy: boolean): { allowed: boolean; message?: string } {
  if (!busy) return { allowed: true };
  return { allowed: false, message: BUSY_NOTICE_BY_KIND[kind] };
}

export function isCurrentRun(activeRunId: number | null, runId: number): boolean {
  return activeRunId === runId;
}
