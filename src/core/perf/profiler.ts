import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PerfSession {
  runId: string;
  marks: Record<string, number>;
  counters: Record<string, number>;
  accumulations: Record<string, number>;
  metadata: Record<string, unknown>;
}

let _enabled: boolean | null = null;
let _session: PerfSession | null = null;

export function isEnabled(): boolean {
  if (_enabled === null) {
    _enabled = process.env["UBUME_PERF"] === "1";
  }
  return _enabled;
}

export function startSession(runId: string): void {
  if (!isEnabled()) return;
  _session = { runId, marks: {}, counters: {}, accumulations: {}, metadata: {} };
}

export function mark(label: string): void {
  if (_session) _session.marks[label] = performance.now();
}

export function inc(counter: string, by = 1): void {
  if (_session) _session.counters[counter] = (_session.counters[counter] ?? 0) + by;
}

export function accumulate(key: string, ms: number): void {
  if (_session) _session.accumulations[key] = (_session.accumulations[key] ?? 0) + ms;
}

export function setMeta(key: string, value: unknown): void {
  if (_session) _session.metadata[key] = value;
}

export function getSession(): PerfSession | null {
  return _session;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function dur(session: PerfSession, from: string, to: string): string {
  const a = session.marks[from];
  const b = session.marks[to];
  if (a === undefined || b === undefined) return "   ?";
  return String(Math.round(b - a)).padStart(4);
}

const STAGE_ROWS: Array<[from: string, to: string, label: string, note?: string]> = [
  ["submit", "dispatch_start", "submit → dispatch_start", "pre-dispatch overhead"],
  ["dispatch_start", "provider_run_start", "dispatch_start → provider_run_start", "orchestration setup"],
  ["exec_resolve_start", "exec_resolve_end", "exec_resolve", "cached after first run"],
  ["caps_probe_start", "caps_probe_end", "caps_probe", "cached after first run"],
  ["provider_run_start", "spawn_done", "provider_run_start → spawn_done", "spawn overhead"],
  ["spawn_done", "first_chunk", "spawn_done → first_chunk  (TTFT)", "← backend latency"],
  ["first_chunk", "first_render", "first_chunk → first_render", "render dispatch"],
  ["first_chunk", "last_chunk", "streaming duration", "total stream time"],
  ["last_chunk", "response_cb_start", "last_chunk → response_cb", ""],
  ["snapshot_start", "snapshot_end", "workspace_snapshot  (blocking)", "← post-run overhead"],
  ["finalize_start", "finalize_done", "finalize_start → finalize_done", ""],
];

export function buildSummary(session: PerfSession): string {
  const lines: string[] = [
    "┌── UBUME PERF REPORT ─────────────────────────────────────────",
    "│ Stage                                         ms",
  ];

  const durations: Array<{ label: string; ms: number }> = [];

  for (const [from, to, label, note] of STAGE_ROWS) {
    const a = session.marks[from];
    const b = session.marks[to];
    const ms = a !== undefined && b !== undefined ? Math.round(b - a) : null;
    const msStr = ms !== null ? String(ms).padStart(4) : "   ?";
    const noteStr = note ? `  ${note}` : "";
    lines.push(`│  ${label.padEnd(44)} ${msStr}ms${noteStr}`);
    if (ms !== null) durations.push({ label, ms });
  }

  const c = session.counters;
  const a = session.accumulations;
  lines.push("│");
  lines.push(
    `│  Counters   chunks=${c["chunks"] ?? 0}  flushes=${c["flushes"] ?? 0}  progress_updates=${c["progress_updates"] ?? 0}`,
  );
  lines.push(`│  Sanitise   accumulated ${Math.round(a["sanitize_ms"] ?? 0)}ms across ${c["chunks"] ?? 0} chunks`);

  const metaEntries = Object.entries(session.metadata);
  if (metaEntries.length > 0) {
    lines.push("│");
    for (const [k, v] of metaEntries) {
      lines.push(`│  ${k}: ${String(v)}`);
    }
  }

  // Bottleneck: largest duration stage
  if (durations.length > 0) {
    const top = durations.reduce((a, b) => (b.ms > a.ms ? b : a));
    lines.push("│");
    lines.push(`│  ► BOTTLENECK: ${top.label} = ${top.ms}ms`);
  }

  lines.push("└───────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

// Sessions are appended as JSONL to ~/.ubume-perf.jsonl for offline analysis.
export function persistSession(session: PerfSession): void {
  try {
    const logPath = join(homedir(), ".ubume-perf.jsonl");
    const line = JSON.stringify({ ...session, ts: Date.now() }) + "\n";
    appendFileSync(logPath, line, "utf8");
  } catch {
    // Profiling must never crash the app.
  }
}
