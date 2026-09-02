import type {
  AuthPreference,
  AvailableBackend,
} from "../config/settings.js";
import type { ResolvedRuntimeConfig } from "../config/runtimeConfig.js";
import type { RunActivitySummary, RunFileActivity } from "../core/workspace/workspaceActivity.js";

// ─── Screen routing ──────────────────────────────────────────────────────────

export type Screen =
  | "main"
  | "resume-picker"
  | "model-picker"
  | "mode-picker"
  | "backend-picker"
  | "provider-picker"
  | "provider-setup"
  | "auth-panel"
  | "reasoning-picker"
  | "theme-picker"
  | "settings-panel"
  | "permissions-panel"
  | "permissions-approval-picker"
  | "permissions-sandbox-picker"
  | "permissions-network-picker"
  | "permissions-add-writable-root"
  | "permissions-remove-writable-root"
  | "import-confirmation"
  | "tool-approval"
  | "update-prompt";

// ─── Provider readiness ───────────────────────────────────────────────────────

export type ExternalCliStatus = "idle" | "starting" | "ready" | "failed";

// ─── UI State Machine ─────────────────────────────────────────────────────────
// Drives all visual decisions: border colors, input persona, turn opacity.
//
//  IDLE ──submit──▶ THINKING ──first token──▶ RESPONDING ──answer visible──▶ ANSWER_VISIBLE ──complete──▶ IDLE
//   ▲                  │                           │                     │
//   │                  └──error──▶ ERROR           └──question──▶ AWAITING
//   └──────────────────────────────────────── dismiss / answer ──────────┘

export type UIState =
  | { kind: "IDLE" }
  | { kind: "THINKING"; turnId: number }
  | { kind: "RESPONDING"; turnId: number }
  | { kind: "ANSWER_VISIBLE"; turnId: number }
  | { kind: "AWAITING_USER_ACTION"; turnId: number; question: string }
  | { kind: "ERROR"; turnId: number; message: string }
  | { kind: "SHELL_RUNNING"; shellId: number };

/** Derive the legacy busy flag from UIState for guard functions. */
export function isBusy(state: UIState): boolean {
  return state.kind === "THINKING"
    || state.kind === "RESPONDING"
    || state.kind === "ANSWER_VISIBLE"
    || state.kind === "SHELL_RUNNING";
}

// ─── Timeline events ─────────────────────────────────────────────────────────

export interface TimelineBaseEvent {
  id: number;
  createdAt: number;
}

export interface UserPromptEvent extends TimelineBaseEvent {
  type: "user";
  prompt: string;
  /** Links this user prompt to its run and assistant response in a TurnGroup. */
  turnId: number;
}

export interface AssistantEvent extends TimelineBaseEvent {
  type: "assistant";
  content: string;
  /** Accumulated chunks during streaming — avoids O(n²) string concatenation. */
  contentChunks: string[];
  /** Links this response back to the originating user prompt + run. */
  turnId: number;
}

/**
 * Returns the full assistant content string. During streaming, joins the
 * accumulated chunks (single O(n) allocation). After finalization, returns
 * the pre-joined `content` field directly.
 */
export function getAssistantContent(event: AssistantEvent | null | undefined): string {
  if (!event) return "";
  if (event.contentChunks.length > 0) return event.contentChunks.join("");
  return event.content;
}

export function getResponseSegmentText(segment: RunResponseSegment | null | undefined): string {
  if (!segment) return "";
  return segment.chunks.join("");
}

export interface RunToolActivity {
  id: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number | null;
  summary?: string | null;
  /** Turn-global ordering against thinking blocks and response segments. */
  streamSeq?: number;
}

export type RunProgressSource =
  | "reasoning"
  | "todo"
  | "stdout"
  | "tool"
  | "activity"
  | "stderr"
  | "transcript";

export interface RunProgressBlock {
  id: string;
  text: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  status: "active" | "completed";
  /** Turn-global ordering against tools and response segments. Set when block first becomes visible. */
  streamSeq?: number;
}

export interface RunResponseSegment {
  id: string;
  streamSeq: number;
  chunks: string[];
  status: "active" | "completed";
  startedAt: number;
}

export interface RunPlanBlock {
  id: string;
  streamSeq: number;
  chunks: string[];
  status: "active" | "completed";
  startedAt: number;
}

export function getRunPlanText(plan: RunPlanBlock | null | undefined): string {
  if (!plan) return "";
  return plan.chunks.join("");
}

export interface RunStreamItem {
  streamSeq: number;
  kind: "thinking" | "action" | "response" | "plan";
  /** block.id, tool.id, response-segment id, or plan.id depending on kind. */
  refId: string;
}

export interface RunProgressEntry {
  id: string;
  source: RunProgressSource;
  /** Latest normalized full text received for this upstream progress item. */
  text: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  /** Structured visible blocks derived from `text` with stable identities. */
  blocks: RunProgressBlock[];
  /**
   * Count of trailing newlines that have not yet been committed into a block.
   * This keeps single-newline vs double-newline boundaries streaming-safe.
   */
  pendingNewlineCount: number;
}

export interface SystemEvent extends TimelineBaseEvent {
  type: "system";
  title: string;
  content: string;
}

export interface ErrorEvent extends TimelineBaseEvent {
  type: "error";
  title: string;
  content: string;
}

export interface RunEvent extends TimelineBaseEvent {
  type: "run";
  backendId: AvailableBackend;
  backendLabel: string;
  runtime: ResolvedRuntimeConfig;
  prompt: string;
  progressEntries: RunProgressEntry[];
  status: "running" | "completed" | "failed" | "canceled";
  summary: string;
  truncatedOutput: boolean;
  startedAt: number;
  durationMs: number | null;
  toolActivities: RunToolActivity[];
  activity: RunFileActivity[];
  touchedFileCount: number;
  activitySummary?: RunActivitySummary;
  errorMessage?: string | null;
  /** Links this run to its user prompt for TurnGroup rendering. */
  turnId: number;
  /** Chronologically ordered references to thinking/action/response items. */
  streamItems?: RunStreamItem[];
  /** Discrete response segments — interrupted by thinking/action events. */
  responseSegments?: RunResponseSegment[];
  /** Monotonic counter the reducer uses to assign streamSeq across all events. */
  lastStreamSeq?: number;
  /** When set, the next assistant delta extends this segment; cleared by thinking/action. */
  activeResponseSegmentId?: string | null;
  /** First-class plan content rendered as a stable stream item. */
  plan?: RunPlanBlock | null;
  /** The approved plan text, injected at the start of execution turns. */
  approvedPlan?: string;
  /** How the final assistant text of this run is presented. Set at run creation. */
  responsePresentation?: "assistant" | "plan";
}

export interface ShellEvent extends TimelineBaseEvent {
  type: "shell";
  command: string;
  lines: string[];
  stderrLines: string[];
  summary?: string | null;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  durationMs: number | null;
}

export type TimelineEvent = UserPromptEvent | AssistantEvent | SystemEvent | ErrorEvent | RunEvent | ShellEvent;
