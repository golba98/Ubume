import { APP_NAME, type TerminalTitleMode, formatTerminalTitlePath } from "../../config/settings.js";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as renderDebug from "../perf/renderDebug.js";
import { resolveUbumeDebugLogPath } from "../workspace/appData.js";

export const DEFAULT_TERMINAL_TITLE = APP_NAME;

// ─── Constants & diagnostics ──────────────────────────────────────────────────

const DEBUG_TERMINAL_TITLE = Boolean(process.env["UBUME_DEBUG_TERMINAL_TITLE"]);

/** Hard cap applied at every entry-point to prevent O(n²) scanning cost on adversarial input. */
const MAX_TERMINAL_TITLE_INPUT_LENGTH = 65536;

// Returns start index of the next ESC]0; or ESC]2; header at/after `from`, or -1.
function findNextOscTitleStart(text: string, from: number): number {
  const limit = text.length - 3;
  for (let i = from; i <= limit; i++) {
    if (
      text.charCodeAt(i) === 0x1b &&
      text.charCodeAt(i + 1) === 0x5d &&
      (text.charCodeAt(i + 2) === 0x30 || text.charCodeAt(i + 2) === 0x32) &&
      text.charCodeAt(i + 3) === 0x3b
    ) return i;
  }
  return -1;
}

// Finds the first BEL (0x07) or ST (ESC \) at/after `from`.
// Returns { contentEnd: terminator-start, seqEnd: after-terminator } or null.
function findOscSequenceEnd(text: string, from: number): { contentEnd: number; seqEnd: number } | null {
  for (let i = from; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x07) return { contentEnd: i, seqEnd: i + 1 };
    if (text.charCodeAt(i) === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c)
      return { contentEnd: i, seqEnd: i + 2 };
  }
  return null;
}

// Returns the start of the first unterminated OSC 0/2 sequence, or -1 if none.
function findIncompleteOscTitleStart(text: string): number {
  let pos = 0;
  while (pos < text.length) {
    const start = findNextOscTitleStart(text, pos);
    if (start === -1) return -1;
    const term = findOscSequenceEnd(text, start + 4);
    if (term === null) return start;
    pos = term.seqEnd;
  }
  return -1;
}

const TERMINAL_TITLE_DEBUG_LOG_PATH = process.env["UBUME_TERMINAL_TITLE_DEBUG_FILE"]?.trim()
  || process.env["UBUME_RENDER_DEBUG_FILE"]?.trim()
  || resolveUbumeDebugLogPath();

let terminalTitleLifecycleState = "unknown";

function debugLog(msg: string): void {
  if (DEBUG_TERMINAL_TITLE) {
    writeTerminalTitleDebugRecord({ event: "debug", message: msg });
  }
}

function writeTerminalTitleDebugRecord(fields: Record<string, unknown>): void {
  if (!DEBUG_TERMINAL_TITLE) return;
  try {
    mkdirSync(dirname(TERMINAL_TITLE_DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(
      TERMINAL_TITLE_DEBUG_LOG_PATH,
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        lifecycleState: terminalTitleLifecycleState,
        ...fields,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Diagnostics must never disturb the TUI.
  }
}

// ─── Title write helpers ──────────────────────────────────────────────────────

let lastWrittenTerminalTitle = "";
let intendedTerminalTitle = DEFAULT_TERMINAL_TITLE;

/** FOR TESTING ONLY: Reset the cached title. */
export function __resetTerminalTitleCache() {
  lastWrittenTerminalTitle = "";
  intendedTerminalTitle = DEFAULT_TERMINAL_TITLE;
}

export function setTerminalTitleLifecycleState(state: string): void {
  terminalTitleLifecycleState = state;
}

export interface TerminalTitleOptions {
  force?: boolean;
  /** Optional custom write function, e.g. for testing or using a specific stdout/stderr instance. */
  write?: (chunk: string) => void;
  reason?: string;
}

function looksLikeRawWindowsPath(title: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(title.trim()) || /^\\\\/.test(title.trim());
}

export function normalizeTerminalTitle(title: string | null | undefined): string {
  const cleanTitle = sanitizeTerminalTitle(title ?? "");
  if (!cleanTitle || looksLikeRawWindowsPath(cleanTitle)) {
    return DEFAULT_TERMINAL_TITLE;
  }
  return cleanTitle;
}

export function setIntendedTerminalTitle(title: string | null | undefined, options?: TerminalTitleOptions): string {
  intendedTerminalTitle = normalizeTerminalTitle(title);
  writeUbumeTerminalTitle(intendedTerminalTitle, {
    ...options,
    reason: options?.reason ?? "set-intended-title",
  });
  return intendedTerminalTitle;
}

export function getIntendedTerminalTitle(): string {
  return intendedTerminalTitle;
}

export function reassertIntendedTerminalTitle(options?: TerminalTitleOptions): void {
  writeUbumeTerminalTitle(intendedTerminalTitle, {
    force: true,
    ...options,
    reason: options?.reason ?? "reassert-intended-title",
  });
}

export function writeUbumeTerminalTitle(title: string, options?: TerminalTitleOptions) {
  const cleanTitle = normalizeTerminalTitle(title);

  if (!options?.force && cleanTitle === lastWrittenTerminalTitle) {
    debugLog(`skipped title="${cleanTitle}" reason=${options?.reason ?? "unknown"} (unchanged)`);
    return;
  }

  lastWrittenTerminalTitle = cleanTitle;

  const sequence = buildTerminalTitleSequence(cleanTitle);
  renderDebug.traceTerminalWrite("stdout", `terminalTitle:${options?.reason ?? "unknown"}`, sequence);
  writeTerminalTitleDebugRecord({
    event: "ubumeTitleWrite",
    title: cleanTitle,
    reason: options?.reason ?? "unknown",
    force: !!options?.force,
    bytes: Buffer.byteLength(sequence),
  });

  if (options?.write) {
    options.write(sequence);
    debugLog(`write(custom) title="${cleanTitle}" force=${!!options?.force} reason=${options?.reason ?? "unknown"}`);
    return;
  }

  const stdoutIsTTY = Boolean(process.stdout?.isTTY);
  const stderrIsTTY = Boolean(process.stderr?.isTTY);

  debugLog(`writeUbumeTerminalTitle("${cleanTitle}") force=${!!options?.force} reason=${options?.reason ?? "unknown"} stdoutIsTTY=${stdoutIsTTY} stderrIsTTY=${stderrIsTTY}`);

  if (stderrIsTTY) {
    process.stderr.write(sequence);
    debugLog(`write(stderr) sequence length=${sequence.length}`);
  } else if (stdoutIsTTY) {
    process.stdout.write(sequence);
    debugLog(`write(stdout) sequence length=${sequence.length}`);
  } else {
    // Fallback if neither is explicitly a TTY but we might still be in a terminal (e.g. Bun quirk)
    process.stdout.write(sequence);
    debugLog(`write(stdout-fallback) sequence length=${sequence.length} (no TTY detected)`);
  }
}

/**
 * Directly writes the terminal title escape sequence to process.stdout or process.stderr,
 * bypassing any Ink/React state management to ensure it reaches the terminal.
 */
export const writeCodexaTerminalTitle = writeUbumeTerminalTitle;

export function setTerminalTitle(title: string, options?: TerminalTitleOptions) {
  writeUbumeTerminalTitle(title, options);
}

/**
 * Pure mapper that converts terminal title mode and workspace into a displayable string.
 */
export function computeTerminalTitle(options: {
  terminalTitleMode: "dir" | "name" | "simple";
  workspaceName?: string;
  appName?: string;
}) {
  const appName = options.appName || APP_NAME;

  if (options.terminalTitleMode === "dir") {
    return options.workspaceName || appName;
  }

  return appName;
}

/**
 * Force a refresh of the terminal title using current settings and workspace.
 */
export function refreshTerminalTitle(options: {
  terminalTitleMode: "dir" | "name" | "simple";
  workspaceName?: string;
  appName?: string;
  force?: boolean;
  write?: (chunk: string) => void;
  debugEventName?: string;
  busyState?: boolean;
}) {
  const title = normalizeTerminalTitle(computeTerminalTitle(options));
  if (DEBUG_TERMINAL_TITLE) {
    debugLog(
      `refreshTerminalTitle(event=${options.debugEventName || "unknown"}, mode=${options.terminalTitleMode}, workspace=${options.workspaceName}, busy=${!!options.busyState}) -> "${title}"`,
    );
  }
  setIntendedTerminalTitle(title, {
    force: options.force,
    write: options.write,
    reason: options.debugEventName ?? "refreshTerminalTitle",
  });
}

// ─── Sequence stripping ───────────────────────────────────────────────────────

export interface TerminalTitleSequenceTraceContext {
  source: string;
  stream: "stdout" | "stderr" | "unknown";
  origin: "ubume" | "child" | "shell" | "codex-cli" | "unknown";
  action?: "observed" | "stripped" | "allowed";
  lifecycleState?: string;
}

export function traceTerminalTitleSequences(
  input: Buffer | string,
  context: TerminalTitleSequenceTraceContext,
): boolean {
  const raw = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const text = raw.slice(0, MAX_TERMINAL_TITLE_INPUT_LENGTH);
  if (!text) return false;

  let found = false;
  let pos = 0;

  while (pos < text.length) {
    const start = findNextOscTitleStart(text, pos);
    if (start === -1) break;
    const term = findOscSequenceEnd(text, start + 4);
    if (term === null) break; // unterminated — nothing to trace

    found = true;
    const title = text.slice(start + 4, term.contentEnd);
    const oscCode = text.charCodeAt(start + 2); // 0x30='0', 0x32='2'
    writeTerminalTitleDebugRecord({
      event: "terminalTitleSequence",
      source: context.source,
      stream: context.stream,
      origin: context.origin,
      action: context.action ?? "observed",
      lifecycleState: context.lifecycleState ?? terminalTitleLifecycleState,
      osc: oscCode === 0x32 ? "OSC 2" : "OSC 0",
      title,
      containsWindowsSystem: title.toLowerCase().includes("c:\\windows\\system"),
      bytes: Buffer.byteLength(text.slice(start, term.seqEnd)),
    });

    pos = term.seqEnd;
  }

  return found;
}

export function stripTerminalTitleSequences(input: string): string {
  const text = input.slice(0, MAX_TERMINAL_TITLE_INPUT_LENGTH);
  if (!text) return "";

  let result = "";
  let pos = 0;

  while (pos < text.length) {
    const start = findNextOscTitleStart(text, pos);
    if (start === -1) { result += text.slice(pos); break; }
    result += text.slice(pos, start);
    const term = findOscSequenceEnd(text, start + 4);
    if (term === null) { result += text.slice(start); break; } // unterminated: pass through unchanged
    pos = term.seqEnd;
  }

  return result;
}

export function stripTerminalTitleSequencesFromChunk(chunk: Buffer | string): string {
  return stripTerminalTitleSequences(
    Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk,
  );
}

// Each stripper maintains a carryover buffer so that a title escape sequence
// split across two Node `data` events is still detected and stripped correctly.
export function createTerminalTitleSequenceStripper(context: TerminalTitleSequenceTraceContext): {
  process(chunk: Buffer | string): string;
  flush(): string;
} {
  let carryover = "";

  const strip = (text: string): string => {
    if (!text) return "";
    const found = traceTerminalTitleSequences(text, { ...context, action: "stripped" });
    return found ? stripTerminalTitleSequences(text) : text;
  };

  return {
    process(chunk: Buffer | string): string {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const input = carryover + text;
      carryover = "";

      const incompleteStart = findIncompleteOscTitleStart(input.slice(0, MAX_TERMINAL_TITLE_INPUT_LENGTH));
      if (incompleteStart !== -1) {
        carryover = input.slice(incompleteStart);
        return strip(input.slice(0, incompleteStart));
      }

      return strip(input);
    },

    flush(): string {
      const remaining = carryover;
      carryover = "";
      return strip(remaining);
    },
  };
}

export function writeGuardedTerminalOutput(
  write: (chunk: string) => boolean | void,
  chunk: Buffer | string,
  context: TerminalTitleSequenceTraceContext,
): boolean {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  if (context.action === "allowed") {
    return write(text) !== false;
  }
  const found = traceTerminalTitleSequences(text, { ...context, action: "stripped" });
  const safeText = found ? stripTerminalTitleSequences(text) : text;
  if (!safeText) return true;
  return write(safeText) !== false;
}

export function sanitizeTerminalTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\u001b/g, "")
    .trim();
}

export function buildTerminalTitleSequence(title: string): string {
  const safeTitle = normalizeTerminalTitle(title);
  // \x1b]0; sets both icon name and window title.
  // \x1b]2; sets window title.
  // We use both for compatibility.
  return `\x1b]0;${safeTitle}\x07\x1b]2;${safeTitle}\x07`;
}

export function formatTerminalTitleLabel(
  workspaceRoot: string,
  terminalTitleMode: TerminalTitleMode,
): string {
  return formatTerminalTitlePath(workspaceRoot, terminalTitleMode);
}

export function deriveTerminalTitle(
  workspaceRoot: string,
  terminalTitleMode: TerminalTitleMode,
): string {
  return formatTerminalTitlePath(workspaceRoot, terminalTitleMode) || DEFAULT_TERMINAL_TITLE;
}

/** Write the title sequence to stdout to (re-)assert the window title. */
export function reassertTerminalTitle(
  title: string = DEFAULT_TERMINAL_TITLE,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): void {
  write(buildTerminalTitleSequence(title));
}

