import { useCallback, useRef, useState } from "react";
import type { BackendProgressUpdate } from "../core/providers/types.js";
import type { AssistantEvent, ExternalCliStatus, RunEvent, ShellEvent, TimelineEvent, UIState, UserPromptEvent } from "./types.js";
import { getAssistantContent, getRunPlanText } from "./types.js";
import {
  appendRunActivity,
  appendRunPlanChunk,
  appendRunResponseChunk,
  appendRunThinking,
  appendStaticEvents,
  cancelRunEvent,
  completeRunEvent,
  failRunEvent,
  finalizePlanBlock,
  finalizeResponseSegments,
  markResponseSegmentsCompleted,
  reduceUIState,
  upsertRunToolActivity,
  type UIStateAction,
} from "./chatLifecycle.js";
import type { RunFileActivity } from "../core/workspace/workspaceActivity.js";
import type { RunToolActivity } from "./types.js";
import type { LiveRenderUpdate } from "./liveRenderScheduler.js";
import * as renderDebug from "../core/perf/renderDebug.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionState {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  externalCliStatus: ExternalCliStatus;
  inputValue: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  clearCount: number;
  clearEpoch: number; // Incremented on each /clear to suppress stale async events
}

export type SessionAction =
  | { type: "APPEND_STATIC_EVENT"; event: TimelineEvent }
  | { type: "APPEND_STATIC_EVENTS"; events: TimelineEvent[] }
  | { type: "SET_INPUT"; value: string; cursor?: number }
  | { type: "RESET_INPUT" }
  | { type: "PUSH_HISTORY"; value: string }
  | { type: "SUBMIT_PROMPT_RUN"; historyValue?: string; events: TimelineEvent[]; turnId: number; runId: number }
  | { type: "HISTORY_UP" }
  | { type: "HISTORY_DOWN" }
  | { type: "CLEAR_TRANSCRIPT"; seedEvents?: TimelineEvent[] }
  | { type: "SET_ACTIVE_EVENTS"; events: TimelineEvent[] }
  | { type: "RUN_APPEND_ACTIVITY"; runId: number; activity: RunFileActivity[] }
  | { type: "RUN_APPLY_PROGRESS_UPDATES"; runId: number; updates: BackendProgressUpdate[] }
  | { type: "RUN_UPSERT_TOOL_ACTIVITY"; runId: number; activity: RunToolActivity }
  | {
    type: "RUN_APPEND_PLAN_DELTA";
    turnId: number;
    runId: number;
    chunk: string;
  }
  | {
    type: "RUN_APPEND_ASSISTANT_DELTA";
    turnId: number;
    runId: number;
    chunk: string;
    eventFactory: () => AssistantEvent;
  }
  | {
    type: "RUN_MARK_FINAL_ANSWER_OBSERVED";
    runId: number;
    turnId: number;
    response?: string;
  }
  | {
    type: "RUN_APPLY_LIVE_UPDATES";
    turnId: number;
    runId: number;
    updates: LiveRenderUpdate[];
    assistantEventFactory: (chunk: string) => AssistantEvent;
  }
  | {
    type: "FINALIZE_RUN";
    runId: number;
    turnId: number;
    status: "completed" | "failed" | "canceled";
    message?: string;
    response?: string;
    durationMs?: number;
    responsePresentation?: "assistant" | "plan";
    question?: string | null;
    assistantFactory: () => AssistantEvent;
  }
  | { type: "FINALIZE_SHELL"; shellId: number; finalEvent: ShellEvent }
  | { type: "UPDATE_SHELL_LINES"; shellId: number; stream: "stdout" | "stderr"; lines: string[] }
  | { type: "REMOVE_ACTIVE_RUNTIME"; runId: number; turnId?: number | null }
  | { type: "UI_ACTION"; action: UIStateAction }
  | { type: "SET_EXTERNAL_CLI_STATUS"; status: ExternalCliStatus };

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function createInitialSessionState(options: { staticEvents?: TimelineEvent[] } = {}): SessionState {
  return {
    staticEvents: options.staticEvents ?? [],
    activeEvents: [],
    uiState: { kind: "IDLE" },
    externalCliStatus: "idle",
    inputValue: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    clearCount: 0,
    clearEpoch: 0,
  };
}

function updateShellLines(event: ShellEvent, action: Extract<SessionAction, { type: "UPDATE_SHELL_LINES" }>): ShellEvent {
  if (action.stream === "stdout") {
    return { ...event, lines: [...event.lines, ...action.lines] };
  }
  return { ...event, stderrLines: [...event.stderrLines, ...action.lines] };
}

export function findUserPrompt(events: TimelineEvent[], turnId: number): UserPromptEvent | null {
  const event = events.find((entry): entry is UserPromptEvent => entry.type === "user" && entry.turnId === turnId);
  return event ?? null;
}

function reconcileAssistantContent(
  streamed: string | undefined,
  response: string | undefined,
  status: "completed" | "failed" | "canceled",
): string {
  if (status !== "completed") return streamed?.trim() ? streamed : "";
  if (!response?.trim()) return streamed ?? "";
  if (!streamed?.trim()) return response;

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const sNorm = norm(streamed);
  const rNorm = norm(response);

  if (sNorm === rNorm) return streamed;   // exact match → keep streamed formatting
  // streamed is a prefix of response, or they differ — authoritative response wins either way
  return response;
}

function isAnimatedLifecycleKind(kind: UIState["kind"]): boolean {
  return kind === "THINKING" || kind === "RESPONDING" || kind === "SHELL_RUNNING";
}

function stateMatchesTurn(state: UIState, turnId: number): boolean {
  return "turnId" in state && state.turnId === turnId;
}

function getUIActionTurnId(action: UIStateAction): number | null {
  return "turnId" in action ? action.turnId : null;
}

function getUIStateTurnId(state: UIState): number | null {
  return "turnId" in state ? state.turnId : null;
}

function traceUITransition(params: {
  previous: UIState;
  next: UIState;
  reason: string;
  runId?: number;
  turnId?: number | null;
}): void {
  if (params.previous === params.next) return;

  renderDebug.traceLifecycleTransition({
    runId: params.runId,
    turnId: params.turnId ?? getUIStateTurnId(params.next) ?? getUIStateTurnId(params.previous),
    prevKind: params.previous.kind,
    nextKind: params.next.kind,
    reason: params.reason,
    composerEnabled: !isAnimatedLifecycleKind(params.next.kind),
    animationActive: isAnimatedLifecycleKind(params.next.kind),
    ts: Date.now(),
  });
}

function reduceTracedUIState(
  state: UIState,
  action: UIStateAction,
  options: { reason?: string; runId?: number } = {},
): UIState {
  const next = reduceUIState(state, action);
  traceUITransition({
    previous: state,
    next,
    reason: options.reason ?? action.type,
    runId: options.runId,
    turnId: getUIActionTurnId(action),
  });
  return next;
}

function terminalActionForFinalize(action: Extract<SessionAction, { type: "FINALIZE_RUN" }>): UIStateAction {
  if (action.status === "completed") {
    return action.question
      ? { type: "AWAITING_USER_ACTION", turnId: action.turnId, question: action.question }
      : { type: "RUN_COMPLETED", turnId: action.turnId };
  }

  if (action.status === "failed") {
    return { type: "RUN_FAILED", turnId: action.turnId, message: action.message ?? "Run failed" };
  }

  return { type: "RUN_CANCELED", turnId: action.turnId };
}

function enforceFinalizePostCondition(
  previous: UIState,
  reduced: UIState,
  action: Extract<SessionAction, { type: "FINALIZE_RUN" }>,
): UIState {
  if (!stateMatchesTurn(previous, action.turnId)) {
    return reduced;
  }

  const forced: UIState = action.status === "completed" && action.question
    ? { kind: "AWAITING_USER_ACTION", turnId: action.turnId, question: action.question }
    : action.status === "failed"
      ? { kind: "ERROR", turnId: action.turnId, message: action.message ?? "Run failed" }
      : { kind: "IDLE" };

  if (
    reduced.kind === forced.kind
    && getUIStateTurnId(reduced) === getUIStateTurnId(forced)
    && (!("message" in forced) || ("message" in reduced && reduced.message === forced.message))
    && (!("question" in forced) || ("question" in reduced && reduced.question === forced.question))
  ) {
    return reduced;
  }

  traceUITransition({
    previous: reduced,
    next: forced,
    reason: "FINALIZE_RUN_POST_CONDITION",
    runId: action.runId,
    turnId: action.turnId,
  });
  return forced;
}

function reduceFinalizeUIState(
  state: UIState,
  action: Extract<SessionAction, { type: "FINALIZE_RUN" }>,
): UIState {
  const reduced = reduceTracedUIState(
    state,
    terminalActionForFinalize(action),
    { reason: `FINALIZE_RUN:${action.status}`, runId: action.runId },
  );
  return enforceFinalizePostCondition(state, reduced, action);
}

function preserveUIStateIdentity(previous: UIState, next: UIState): UIState {
  if (previous === next) return previous;
  if (previous.kind !== next.kind) return next;
  if ("message" in previous && "message" in next && previous.message !== next.message) return next;
  if ("question" in previous && "question" in next && previous.question !== next.question) return next;
  if ("turnId" in previous && "turnId" in next && previous.turnId !== next.turnId) return next;
  return previous;
}

function eventCount(state: SessionState): number {
  return state.staticEvents.length + state.activeEvents.length;
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "APPEND_STATIC_EVENT":
      return { ...state, staticEvents: appendStaticEvents(state.staticEvents, [action.event]) };
    case "APPEND_STATIC_EVENTS":
      return { ...state, staticEvents: appendStaticEvents(state.staticEvents, action.events) };
    case "SET_INPUT":
      return {
        ...state,
        inputValue: action.value,
        cursor: Math.max(0, Math.min(action.cursor ?? action.value.length, action.value.length)),
      };
    case "RESET_INPUT":
      return { ...state, inputValue: "", cursor: 0, historyIndex: -1 };
    case "PUSH_HISTORY":
      return {
        ...state,
        history: [action.value, ...state.history.filter((entry) => entry !== action.value)].slice(0, 50),
        historyIndex: -1,
      };
    case "SUBMIT_PROMPT_RUN": {
      const nextHistory = action.historyValue
        ? [action.historyValue, ...state.history.filter((entry) => entry !== action.historyValue)].slice(0, 50)
        : state.history;
      return {
        ...state,
        activeEvents: action.events,
        uiState: reduceTracedUIState(
          state.uiState,
          { type: "PROMPT_RUN_STARTED", turnId: action.turnId },
          { reason: "SUBMIT_PROMPT_RUN", runId: action.runId },
        ),
        inputValue: "",
        cursor: 0,
        history: nextHistory,
        historyIndex: -1,
      };
    }
    case "HISTORY_UP": {
      if (state.history.length === 0) return state;
      const nextIndex = Math.min(state.historyIndex + 1, state.history.length - 1);
      const nextValue = state.history[nextIndex] ?? "";
      return { ...state, historyIndex: nextIndex, inputValue: nextValue, cursor: nextValue.length };
    }
    case "HISTORY_DOWN": {
      if (state.historyIndex <= 0) {
        return { ...state, historyIndex: -1, inputValue: "", cursor: 0 };
      }
      const nextIndex = state.historyIndex - 1;
      const nextValue = state.history[nextIndex] ?? "";
      return { ...state, historyIndex: nextIndex, inputValue: nextValue, cursor: nextValue.length };
    }
    case "CLEAR_TRANSCRIPT":
      renderDebug.traceEvent("transcript", "clear", {
        previousStaticEventsLength: state.staticEvents.length,
        previousActiveEventsLength: state.activeEvents.length,
        seedEventsLength: action.seedEvents?.length ?? 0,
        uiStateKind: state.uiState.kind,
      });
      return {
        ...state,
        staticEvents: action.seedEvents ?? [],
        activeEvents: [],
        uiState: { kind: "IDLE" },
        clearCount: state.clearCount + 1,
        clearEpoch: state.clearEpoch + 1,
      };
    case "SET_ACTIVE_EVENTS":
      renderDebug.traceEvent("transcript", "activeEventsReplace", {
        previousLength: state.activeEvents.length,
        nextLength: action.events.length,
        uiStateKind: state.uiState.kind,
        preventedEmptyIntermediate: action.events.length === 0 && state.activeEvents.length > 0 && isAnimatedLifecycleKind(state.uiState.kind),
      });
      if (action.events.length === 0 && state.activeEvents.length > 0 && isAnimatedLifecycleKind(state.uiState.kind)) {
        renderDebug.traceBlankFrame("Session", {
          reason: "prevented-empty-active-events-replacement",
          previousActiveEventsLength: state.activeEvents.length,
          uiStateKind: state.uiState.kind,
        });
        return state;
      }
      return { ...state, activeEvents: action.events };
    case "RUN_APPEND_ACTIVITY": {
      if (!state.activeEvents.some((event) => event.id === action.runId && event.type === "run")) {
        return state;
      }
      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.runId && event.type === "run"
            ? appendRunActivity(event as RunEvent, action.activity)
            : event
        ),
      };
    }
    case "RUN_APPLY_PROGRESS_UPDATES": {
      if (!state.activeEvents.some((event) => event.id === action.runId && event.type === "run")) {
        return state;
      }
      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.runId && event.type === "run"
            ? appendRunThinking(event as RunEvent, action.updates)
            : event
        ),
      };
    }
    case "RUN_UPSERT_TOOL_ACTIVITY": {
      if (!state.activeEvents.some((event) => event.id === action.runId && event.type === "run")) {
        return state;
      }
      renderDebug.traceEvent("action", "upsert", {
        runId: action.runId,
        actionId: action.activity.id,
        status: action.activity.status,
      });
      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.runId && event.type === "run"
            ? upsertRunToolActivity(event as RunEvent, action.activity)
            : event
        ),
      };
    }
    case "RUN_APPEND_PLAN_DELTA": {
      const existingRun = state.activeEvents.find(
        (event): event is RunEvent =>
          event.type === "run" && event.id === action.runId && event.turnId === action.turnId,
      );
      if (!existingRun) {
        return state;
      }

      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.runId && event.type === "run"
            ? appendRunPlanChunk(event as RunEvent, action.chunk)
            : event
        ),
        uiState: reduceTracedUIState(
          state.uiState,
          { type: "FIRST_ASSISTANT_DELTA", turnId: action.turnId },
          { runId: action.runId },
        ),
      };
    }
    case "RUN_APPEND_ASSISTANT_DELTA": {
      const existingRun = state.activeEvents.find(
        (event): event is RunEvent =>
          event.type === "run" && event.id === action.runId && event.turnId === action.turnId,
      );
      if (!existingRun) {
        return state;
      }

      const existingAssistant = state.activeEvents.find(
        (event): event is AssistantEvent => event.type === "assistant" && event.turnId === action.turnId,
      );

      const updateRun = (event: TimelineEvent): TimelineEvent => (
        event.id === action.runId && event.type === "run"
          ? appendRunResponseChunk(event as RunEvent, action.chunk)
          : event
      );

      if (existingAssistant) {
        return {
          ...state,
          activeEvents: state.activeEvents.map((event) => {
            if (event.type === "assistant" && event.turnId === action.turnId) {
              return { ...event, contentChunks: [...(event as AssistantEvent).contentChunks, action.chunk] };
            }
            return updateRun(event);
          }),
          uiState: reduceTracedUIState(
            state.uiState,
            { type: "FIRST_ASSISTANT_DELTA", turnId: action.turnId },
            { runId: action.runId },
          ),
        };
      }

      return {
        ...state,
        activeEvents: [...state.activeEvents.map(updateRun), action.eventFactory()],
        uiState: reduceTracedUIState(
          state.uiState,
          { type: "FIRST_ASSISTANT_DELTA", turnId: action.turnId },
          { runId: action.runId },
        ),
      };
    }
    case "RUN_APPLY_LIVE_UPDATES": {
      const existingRun = state.activeEvents.find(
        (event): event is RunEvent =>
          event.type === "run" && event.id === action.runId && event.turnId === action.turnId,
      );
      if (!existingRun) {
        return state;
      }

      const existingAssistant = state.activeEvents.find(
        (event): event is AssistantEvent => event.type === "assistant" && event.turnId === action.turnId,
      );
      let nextRun = existingRun;
      let nextAssistant: AssistantEvent | null = existingAssistant ?? null;
      let assistantCreated = false;
      let sawAssistantOrPlanDelta = false;

      for (const update of action.updates) {
        if (update.type === "activity") {
          nextRun = appendRunActivity(nextRun, update.activity);
        } else if (update.type === "progress") {
          nextRun = appendRunThinking(nextRun, [update.update]);
        } else if (update.type === "tool") {
          renderDebug.traceEvent("action", "upsert", {
            runId: action.runId,
            actionId: update.activity.id,
            status: update.activity.status,
          });
          nextRun = upsertRunToolActivity(nextRun, update.activity);
        } else if (update.type === "plan") {
          sawAssistantOrPlanDelta = true;
          nextRun = appendRunPlanChunk(nextRun, update.chunk);
        } else {
          sawAssistantOrPlanDelta = true;
          nextRun = appendRunResponseChunk(nextRun, update.chunk);
          if (nextAssistant) {
            nextAssistant = {
              ...nextAssistant,
              contentChunks: [...nextAssistant.contentChunks, update.chunk],
            };
          } else {
            nextAssistant = action.assistantEventFactory(update.chunk);
            assistantCreated = true;
          }
        }
      }

      const activeEvents = state.activeEvents.map((event) => {
        if (event.type === "run" && event.id === action.runId) {
          return nextRun;
        }
        if (nextAssistant && event.type === "assistant" && event.turnId === action.turnId) {
          return nextAssistant;
        }
        return event;
      });

      const withAssistant = assistantCreated && nextAssistant
        ? [...activeEvents, nextAssistant]
        : activeEvents;

      return {
        ...state,
        activeEvents: withAssistant,
        uiState: sawAssistantOrPlanDelta
          ? reduceTracedUIState(
            state.uiState,
            { type: "FIRST_ASSISTANT_DELTA", turnId: action.turnId },
            { runId: action.runId },
          )
          : state.uiState,
      };
    }
    case "RUN_MARK_FINAL_ANSWER_OBSERVED": {
      const existingRun = state.activeEvents.find(
        (event): event is RunEvent =>
          event.type === "run" && event.id === action.runId && event.turnId === action.turnId,
      );
      if (!existingRun) {
        return state;
      }

      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.runId && event.type === "run"
            ? markResponseSegmentsCompleted(
              event as RunEvent,
              // Plan runs keep their text in the plan block; passing the final
              // response here would synthesize a duplicate response segment.
              (event as RunEvent).responsePresentation === "plan" ? undefined : action.response,
            )
            : event
        ),
        uiState: reduceTracedUIState(
          state.uiState,
          { type: "FINAL_ANSWER_VISIBLE", turnId: action.turnId },
          { runId: action.runId },
        ),
      };
    }
    case "FINALIZE_RUN": {
      const userEvent = state.activeEvents.find(
        (event): event is UserPromptEvent => event.type === "user" && event.turnId === action.turnId,
      );
      const runEvent = state.activeEvents.find(
        (event): event is RunEvent => event.type === "run" && event.id === action.runId,
      );
      const assistantEvent = state.activeEvents.find(
        (event): event is AssistantEvent => event.type === "assistant" && event.turnId === action.turnId,
      );

      const remainingEvents = state.activeEvents.filter((event) =>
        !(event.type === "run" && event.id === action.runId)
        && !(event.type === "assistant" && event.turnId === action.turnId)
        && !(event.type === "user" && event.turnId === action.turnId),
      );

      if (!runEvent) {
        renderDebug.traceEvent("transcript", "finalizeWithoutRunEvent", {
          runId: action.runId,
          turnId: action.turnId,
          remainingEventsLength: remainingEvents.length,
        });
        return {
          ...state,
          activeEvents: remainingEvents,
          uiState: reduceFinalizeUIState(state.uiState, action),
        };
      }

      const baseFinalizedRun =
        action.status === "completed"
          ? completeRunEvent(runEvent, action.durationMs)
          : action.status === "failed"
            ? failRunEvent(runEvent, action.message ?? "Run failed", action.message ?? "Run failed", action.durationMs)
            : cancelRunEvent(runEvent, action.durationMs);

      const planPresentation = action.responsePresentation === "plan";
      if (planPresentation) {
        // The plan is the text streamed after the last tool call (earlier text
        // was demoted to prose segments). The backend's final response contains
        // that chatter too, so only fall back to it when nothing was streamed.
        const streamedPlan = getRunPlanText(runEvent.plan);
        const planContent = streamedPlan.trim()
          ? streamedPlan
          : reconcileAssistantContent("", action.response, action.status);
        const finalizedRun = finalizePlanBlock(finalizeResponseSegments(baseFinalizedRun), planContent);

        const additions: TimelineEvent[] = [];
        if (userEvent) additions.push(userEvent);
        additions.push(finalizedRun);

        return {
          ...state,
          staticEvents: appendStaticEvents(state.staticEvents, additions),
          activeEvents: remainingEvents,
          uiState: reduceFinalizeUIState(state.uiState, action),
        };
      }

      const streamedContent = getAssistantContent(assistantEvent);
      const assistantContent = reconcileAssistantContent(
        streamedContent,
        action.response,
        action.status,
      );

      // Reconcile response segments with the authoritative final text.
      // If the authoritative text differs from streamed (or no segments exist),
      // rewrite/synthesize the trailing segment so the rendered timeline
      // shows the final answer in chronological position.
      const trimmedFinal = assistantContent.trim();
      const streamedTrim = streamedContent.trim();
      const overrideSegmentText = trimmedFinal && trimmedFinal !== streamedTrim
        ? assistantContent
        : undefined;
      const finalizedRun = finalizeResponseSegments(baseFinalizedRun, overrideSegmentText);

      const additions: TimelineEvent[] = [];
      if (userEvent) additions.push(userEvent);
      additions.push(finalizedRun);
      if (assistantContent.trim()) {
        additions.push(
          assistantEvent
            ? { ...assistantEvent, content: assistantContent, contentChunks: [] }
            : action.assistantFactory(),
        );
      }

      return {
        ...state,
        staticEvents: appendStaticEvents(state.staticEvents, additions),
        activeEvents: remainingEvents,
        uiState: reduceFinalizeUIState(state.uiState, action),
      };
    }
    case "FINALIZE_SHELL":
      return {
        ...state,
        staticEvents: appendStaticEvents(state.staticEvents, [action.finalEvent]),
        activeEvents: state.activeEvents.filter((event) => !(event.type === "shell" && event.id === action.shellId)),
        uiState: reduceTracedUIState(state.uiState, { type: "SHELL_FINISHED", shellId: action.shellId }),
      };
    case "UPDATE_SHELL_LINES":
      return {
        ...state,
        activeEvents: state.activeEvents.map((event) =>
          event.id === action.shellId && event.type === "shell"
            ? updateShellLines(event as ShellEvent, action)
            : event
        ),
      };
    case "REMOVE_ACTIVE_RUNTIME":
      return {
        ...state,
        activeEvents: state.activeEvents.filter((event) =>
          !(event.type === "run" && event.id === action.runId)
          && !(event.type === "assistant" && action.turnId != null && event.turnId === action.turnId)
          && !(event.type === "shell" && event.id === action.runId)
          && !(event.type === "user" && action.turnId != null && event.turnId === action.turnId),
        ),
      };
    case "UI_ACTION":
      return { ...state, uiState: reduceTracedUIState(state.uiState, action.action) };
    case "SET_EXTERNAL_CLI_STATUS":
      if (state.externalCliStatus === action.status) return state;
      return { ...state, externalCliStatus: action.status };
    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppSessionState(initialStaticEvents?: () => TimelineEvent[]) {
  const [state, setState] = useState<SessionState>(() =>
    createInitialSessionState({ staticEvents: initialStaticEvents?.() ?? [] }),
  );
  const queueRef = useRef<SessionAction[]>([]);
  const scheduledRef = useRef(false);

  const dispatch = useCallback((action: SessionAction) => {
    queueRef.current.push(action);
    if (scheduledRef.current) return;

    scheduledRef.current = true;
    queueMicrotask(() => {
      scheduledRef.current = false;
      const queued = queueRef.current.splice(0, queueRef.current.length);
      if (queued.length === 0) return;

      renderDebug.traceTimelineUpdate({
        queuedActions: queued.length,
        actionTypes: queued.map((item) => item.type),
      });
      setState((current) => {
        const next = queued.reduce(reduceSessionState, current);
        const previousCount = eventCount(current);
        const nextCount = eventCount(next);
        if (
          previousCount !== nextCount
          || current.staticEvents.length !== next.staticEvents.length
          || current.activeEvents.length !== next.activeEvents.length
        ) {
          renderDebug.traceEvent("transcript", "eventArrayLengthChange", {
            actionTypes: queued.map((item) => item.type),
            previousTotalLength: previousCount,
            nextTotalLength: nextCount,
            previousStaticEventsLength: current.staticEvents.length,
            nextStaticEventsLength: next.staticEvents.length,
            previousActiveEventsLength: current.activeEvents.length,
            nextActiveEventsLength: next.activeEvents.length,
            previousUiStateKind: current.uiState.kind,
            nextUiStateKind: next.uiState.kind,
          });
        }
        if (previousCount > 0 && nextCount === 0) {
          renderDebug.traceBlankFrame("Session", {
            reason: "transcript-length-dropped-to-zero",
            actionTypes: queued.map((item) => item.type),
            previousTotalLength: previousCount,
            previousStaticEventsLength: current.staticEvents.length,
            previousActiveEventsLength: current.activeEvents.length,
            nextUiStateKind: next.uiState.kind,
          });
        }
        // Preserve uiState identity when nothing meaningful changed,
        // so AppShell's memo check (prev.uiState === next.uiState) can bail out.
        if (next !== current && next.uiState !== current.uiState) {
          const preserved = preserveUIStateIdentity(current.uiState, next.uiState);
          if (preserved === current.uiState) {
            return { ...next, uiState: preserved };
          }
        }
        return next;
      });
    });
  }, []);

  return { state, dispatch };
}
