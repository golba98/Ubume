import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { useEffect, useRef } from "react";
import { resolveUbumeDebugLogPath } from "../workspace/appData.js";

type DebugEnv = Record<string, string | undefined>;

// Global debug state — populated lazily on first check, or eagerly via configureRenderDebug().
let configured = false;
let enabled = false;
let renderTraceEnabled = false;
let lifecycleEnabled = false;
let flickerEnabled = false;
let plainActionsEnabled = false;
let logPath = resolveUbumeDebugLogPath();
let sessionId = `${Date.now()}-${process.pid}`;
const counters = new Map<string, number>();

function configureFromEnv(env: DebugEnv = process.env): void {
  renderTraceEnabled = env["UBUME_DEBUG_RENDER_TRACE"] === "1" || env["CODEXA_DEBUG_RENDER_TRACE"] === "1";
  // Both UBUME_RENDER_DEBUG and UBUME_DEBUG_RENDER activate render debugging —
  // two names exist for historical reasons; either one is sufficient.
  // UBUME_TERMINAL_TRACE is a focused alias for diagnosing terminal/clear/resize
  // render-state issues; it lights up the same `terminal` trace channel.
  enabled = env["UBUME_RENDER_DEBUG"] === "1"
    || env["UBUME_DEBUG_MODEL_STATE"] === "1"
    || env["UBUME_DEBUG_RENDER"] === "1"
    || env["UBUME_TERMINAL_TRACE"] === "1"
    || env["CODEXA_RENDER_DEBUG"] === "1"
    || env["CODEXA_DEBUG_MODEL_STATE"] === "1"
    || env["CODEXA_DEBUG_RENDER"] === "1"
    || env["CODEXA_TERMINAL_TRACE"] === "1"
    || renderTraceEnabled;
  lifecycleEnabled = env["UBUME_DEBUG_LIFECYCLE"] === "1" || env["CODEXA_DEBUG_LIFECYCLE"] === "1";
  flickerEnabled = env["UBUME_DEBUG_FLICKER"] === "1" || env["CODEXA_DEBUG_FLICKER"] === "1";
  plainActionsEnabled = env["UBUME_DEBUG_PLAIN_ACTIONS"] === "1" || env["CODEXA_DEBUG_PLAIN_ACTIONS"] === "1";
  logPath = env["UBUME_RENDER_DEBUG_FILE"]?.trim()
    || env["CODEXA_RENDER_DEBUG_FILE"]?.trim()
    || resolveUbumeDebugLogPath(env);
  sessionId = `${Date.now()}-${process.pid}`;
  configured = true;
}

export function configureRenderDebug(env: DebugEnv = process.env): void {
  configureFromEnv(env);
  counters.clear();
  if (enabled) {
    writeRecord("session", { event: "start" });
  }
}

export function isRenderDebugEnabled(): boolean {
  if (!configured) {
    configureFromEnv();
  }
  return enabled;
}

export function isRenderTraceEnabled(): boolean {
  if (!configured) {
    configureFromEnv();
  }
  return renderTraceEnabled;
}

export function isLifecycleDebugEnabled(): boolean {
  if (!configured) {
    configureFromEnv();
  }
  return lifecycleEnabled;
}

export function isFlickerDebugEnabled(): boolean {
  if (!configured) {
    configureFromEnv();
  }
  return flickerEnabled;
}

export function isPlainActionsDebugEnabled(): boolean {
  if (!configured) {
    configureFromEnv();
  }
  return plainActionsEnabled;
}

export function getRenderDebugLogPath(): string {
  if (!configured) {
    configureFromEnv();
  }
  return logPath;
}

function nextCounter(name: string, by = 1): number {
  const next = (counters.get(name) ?? 0) + by;
  counters.set(name, next);
  return next;
}

function sanitizeValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      record[key] = sanitizeValue(nested);
    }
    return record;
  }
  return String(value);
}

function writeRecord(kind: string, fields: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        sessionId,
        kind,
        ...(sanitizeValue(fields) as Record<string, unknown>),
      }) + "\n",
      "utf8",
    );
  } catch {
    // Debug logging must never disturb the TUI.
  }
}

export function traceLifecycleEvent(
  component: string,
  event: "mount" | "unmount" | "blankFrame" | "emptyFrame" | "stateTransition" | string,
  fields: Record<string, unknown> = {},
): void {
  if (!isRenderDebugEnabled()) return;
  const count = nextCounter(`lifecycle.${component}.${event}`);
  writeRecord("lifecycle", { component, event, count, ...fields });
}

export function useLifecycleDebug(
  component: string,
  fields: Record<string, unknown> = {},
): void {
  useEffect(() => {
    traceLifecycleEvent(component, "mount", fields);
    return () => {
      traceLifecycleEvent(component, "unmount", fields);
    };
  }, []);
}

export function traceBlankFrame(
  component: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isRenderDebugEnabled()) return;
  const count = nextCounter(`blankFrame.${component}`);
  writeRecord("blankFrame", { component, event: "blankFrame", count, ...fields });
}

export function traceLayoutValidity(
  component: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isRenderDebugEnabled()) return;
  const values = Object.entries(fields).filter(([, value]) => typeof value === "number") as Array<[string, number]>;
  const invalidValues = values
    .filter(([, value]) => !Number.isFinite(value) || value <= 0)
    .map(([key, value]) => ({ key, value }));
  const count = nextCounter(`layoutValidity.${component}`);
  writeRecord("layout", {
    event: invalidValues.length > 0 ? "invalidLayout" : "validLayout",
    component,
    count,
    invalidValues,
    ...fields,
  });
}

export function traceStateTransition(fields: Record<string, unknown>): void {
  if (!isRenderDebugEnabled() && !isLifecycleDebugEnabled()) return;
  writeRecord("state", { event: "transition", ...fields });
}

function diffKeys(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string {
  if (!previous) return "mount";
  const changed: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      changed.push(key);
    }
  }
  return changed.length > 0 ? changed.join(",") : "parent";
}

function summarizeWatchedValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const reactType = record["type"];
    if ("$$typeof" in record) {
      return {
        type: "reactElement",
        name: typeof reactType === "string"
          ? reactType
          : typeof reactType === "function"
            ? reactType.name
            : "unknown",
      };
    }
    if (typeof record["kind"] === "string") {
      return { type: "object", kind: record["kind"] };
    }
    if (typeof record["key"] === "string") {
      return { type: "object", key: record["key"] };
    }
    return { type: "object", keys: Object.keys(record).slice(0, 8) };
  }
  return String(value);
}

function summarizeWatched(watched: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(watched)) {
    summary[key] = summarizeWatchedValue(value);
  }
  return summary;
}

export function traceRender(
  component: string,
  reason = "unknown",
  fields: Record<string, unknown> = {},
): void {
  if (!isRenderDebugEnabled()) return;
  const count = nextCounter(`render.${component}`);
  writeRecord("render", { component, count, reason, ...fields });
}

export function useRenderDebug(
  component: string,
  watched: Record<string, unknown> = {},
): void {
  const renderCount = useRef(0);
  const previous = useRef<Record<string, unknown> | null>(null);
  renderCount.current += 1;
  const reason = diffKeys(previous.current, watched);
  if (isRenderDebugEnabled()) {
    writeRecord("render", {
      component,
      count: renderCount.current,
      reason,
      watched: summarizeWatched(watched),
    });
  }
  previous.current = watched;
}

export function useFlickerDebug(
  event: string,
  watched: Record<string, unknown> = {},
): void {
  const renderCount = useRef(0);
  const previous = useRef<Record<string, unknown> | null>(null);
  renderCount.current += 1;
  const reason = diffKeys(previous.current, watched);
  if (isFlickerDebugEnabled() || isRenderTraceEnabled()) {
    writeRecord("flicker", {
      event,
      count: renderCount.current,
      reason,
      watched: summarizeWatched(watched),
    });
  }
  previous.current = watched;
}

export function traceEvent(
  channel: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isRenderDebugEnabled()) return;
  const count = nextCounter(`${channel}.${event}`);
  writeRecord(channel, { event, count, ...fields });
}

/**
 * Like traceEvent, but the field object is only built when tracing is on.
 * Use it wherever computing the payload is expensive (hashing or scanning
 * output), so a disabled trace costs nothing on the render hot path.
 */
export function traceEventLazy(
  channel: string,
  event: string,
  buildFields: () => Record<string, unknown>,
): void {
  if (!isRenderDebugEnabled()) return;
  traceEvent(channel, event, buildFields());
}

export function traceSchedulerFlush(fields: Record<string, unknown>): void {
  traceEvent("scheduler", "flush", fields);
}

export function traceStatusTick(fields: Record<string, unknown>): void {
  traceEvent("status", "tick", fields);
  traceFlickerEvent("statusTick", fields);
}

export function traceTimelineUpdate(fields: Record<string, unknown>): void {
  traceEvent("timeline", "update", fields);
}

/**
 * Set UBUME_DEBUG_LIFECYCLE=1 to write one JSONL record for every UIState
 * transition, including the derived composer and animation state.
 */
export function traceLifecycleTransition(fields: Record<string, unknown>): void {
  if (!isLifecycleDebugEnabled()) return;
  writeRecord("lifecycle", fields);
}

export function traceFlickerEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (!isRenderDebugEnabled() && !isFlickerDebugEnabled() && !isRenderTraceEnabled()) return;
  const count = nextCounter(`flicker.${event}`);
  writeRecord("flicker", { event, count, ...fields });
}

export function traceTerminalWrite(
  stream: "stdout" | "stderr",
  source: string,
  chunk: unknown,
): void {
  if (!isRenderDebugEnabled()) return;
  const text = typeof chunk === "string"
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString("utf8")
      : String(chunk ?? "");
  writeRecord(stream, {
    event: "directWrite",
    count: nextCounter(`${stream}.directWrite`),
    source,
    bytes: Buffer.byteLength(text),
    containsViewportClear: text.includes("\x1b[2J"),
    containsScrollbackClear: text.includes("\x1b[3J"),
    containsCursorHome: text.includes("\x1b[H"),
    containsTerminalReset: text.includes("\x1bc"),
    containsAlternateScreen: text.includes("\x1b[?1049h"),
    containsTitleSequence: text.includes("\x1b]0;") || text.includes("\x1b]2;"),
    containsBracketedPaste: text.includes("\x1b[?2004h") || text.includes("\x1b[?2004l"),
    containsMouseMode: text.includes("\x1b[?1000h") || text.includes("\x1b[?1000l")
      || text.includes("\x1b[?1002h") || text.includes("\x1b[?1002l")
      || text.includes("\x1b[?1003h") || text.includes("\x1b[?1003l")
      || text.includes("\x1b[?1006h") || text.includes("\x1b[?1006l")
      || text.includes("\x1b[?1015h") || text.includes("\x1b[?1015l"),
  });
}

export function traceTerminalClear(source: string, fields: Record<string, unknown> = {}): void {
  traceEvent("terminal", "clearScreen", { source, ...fields });
}

/**
 * Returns accumulated render counts for all tracked components.
 * Useful with `/debug renders` to verify that Header/Composer/Footer
 * stay low during streaming while Timeline updates frequently.
 */
export function dumpRenderCounts(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of counters) {
    if (key.startsWith("render.")) {
      result[key.slice("render.".length)] = value;
    }
  }
  return result;
}
