import assert from "node:assert/strict";
import test from "node:test";
import type { BackendProgressUpdate } from "../core/providers/types.js";
import type { AssistantEvent, RunEvent, TimelineEvent, UserPromptEvent } from "./types.js";
import { getRunPlanText, isBusy } from "./types.js";
import { createInitialSessionState, reduceSessionState, type SessionState } from "./appSession.js";
import { TEST_RUNTIME } from "../test/runtimeTestUtils.js";
import { isAnimatedBusyState } from "../ui/chrome/busyStatusAnimation.js";

function makeUserEvent(turnId: number): UserPromptEvent {
  return { id: 1, type: "user", createdAt: 1, prompt: "Do work", turnId };
}

function makeRunEvent(turnId: number): RunEvent {
  return {
    id: 2,
    type: "run",
    createdAt: 2,
    startedAt: 2,
    durationMs: null,
    backendId: "codex-subprocess",
    backendLabel: "Codexa",
    runtime: TEST_RUNTIME,
    prompt: "Do work",
    progressEntries: [],
    status: "running",
    summary: "Running",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId,
  };
}

function makeAssistantEvent(turnId: number, content: string): AssistantEvent {
  return { id: 3, type: "assistant", createdAt: 3, content, contentChunks: [], turnId };
}

function makeSystemEvent(id: number, title = "Launch mode", content = "Ready"): TimelineEvent {
  return { id, type: "system", createdAt: id, title, content };
}

function makeProgressUpdate(
  id: string,
  text: string,
  source: BackendProgressUpdate["source"] = "reasoning",
): BackendProgressUpdate {
  return {
    id,
    source,
    text,
  };
}

function stateWithActiveRun(turnId: number): SessionState {
  const state = createInitialSessionState();
  return {
    ...state,
    activeEvents: [
      makeUserEvent(turnId),
      makeRunEvent(turnId),
    ],
  };
}

test("initial session state can seed static home events", () => {
  const homeEvent = makeSystemEvent(99);
  const state = createInitialSessionState({ staticEvents: [homeEvent] });

  assert.deepEqual(state.staticEvents, [homeEvent]);
  assert.deepEqual(state.activeEvents, []);
  assert.deepEqual(state.uiState, { kind: "IDLE" });
  assert.equal(state.inputValue, "");
});

test("SUBMIT_PROMPT_RUN atomically clears composer, records history, appends one turn, and enters thinking", () => {
  const turnId = 50;
  const runId = 2;
  const initial: SessionState = {
    ...createInitialSessionState(),
    inputValue: "hello",
    cursor: 5,
    history: ["older"],
  };

  const state = reduceSessionState(initial, {
    type: "SUBMIT_PROMPT_RUN",
    historyValue: "hello",
    turnId,
    runId,
    events: [makeUserEvent(turnId), makeRunEvent(turnId)],
  });

  assert.equal(state.inputValue, "");
  assert.equal(state.cursor, 0);
  assert.deepEqual(state.history, ["hello", "older"]);
  assert.deepEqual(state.activeEvents.map((event) => event.type), ["user", "run"]);
  assert.equal(state.activeEvents.filter((event) => event.type === "user").length, 1);
  assert.equal(state.activeEvents.filter((event) => event.type === "run").length, 1);
  assert.deepEqual(state.uiState, { kind: "THINKING", turnId });
  assert.deepEqual(state.staticEvents, []);
});

test("busy lifecycle preserves one canonical active turn until finalization", () => {
  const turnId = 51;
  let state = reduceSessionState(createInitialSessionState(), {
    type: "SUBMIT_PROMPT_RUN",
    historyValue: "hello",
    turnId,
    runId: 2,
    events: [makeUserEvent(turnId), makeRunEvent(turnId)],
  });

  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Hello",
    eventFactory: () => makeAssistantEvent(turnId, "Hello"),
  });
  state = reduceSessionState(state, {
    type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
    runId: 2,
    turnId,
    response: "Hello",
  });

  assert.deepEqual(state.activeEvents.map((event) => event.type), ["user", "run", "assistant"]);
  assert.equal(state.activeEvents.filter((event) => event.type === "user").length, 1);
  assert.equal(state.activeEvents.filter((event) => event.type === "assistant").length, 1);
  assert.deepEqual(state.staticEvents, []);

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: undefined,
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  assert.deepEqual(state.activeEvents, []);
  assert.deepEqual(state.staticEvents.map((event) => event.type), ["user", "run", "assistant"]);
  assert.equal(state.staticEvents.filter((event) => event.type === "user").length, 1);
  assert.equal(state.staticEvents.filter((event) => event.type === "assistant").length, 1);
  assert.equal(state.uiState.kind, "IDLE");
});

test("CLEAR_TRANSCRIPT removes all rendered transcript event state and preserves prompt history", () => {
  const turnId = 7;
  const shellEvent: TimelineEvent = {
    id: 10,
    type: "shell",
    createdAt: 10,
    command: "echo stale",
    lines: ["stale shell output"],
    stderrLines: [],
    summary: "Executed shell",
    status: "completed",
    exitCode: 0,
    durationMs: 20,
  };
  const state: SessionState = {
    ...createInitialSessionState(),
    staticEvents: [
      makeUserEvent(turnId),
      { ...makeRunEvent(turnId), status: "completed", durationMs: 100 },
      makeAssistantEvent(turnId, "stale assistant"),
      shellEvent,
      { id: 11, type: "system", createdAt: 11, title: "Mode", content: "Updated" },
    ],
    activeEvents: [
      makeUserEvent(turnId + 1),
      makeRunEvent(turnId + 1),
      makeAssistantEvent(turnId + 1, "streaming"),
    ],
    uiState: { kind: "RESPONDING", turnId: turnId + 1 },
    inputValue: "/clear",
    cursor: 6,
    history: ["Hello"],
  };

  const cleared = reduceSessionState(state, { type: "CLEAR_TRANSCRIPT" });

  assert.deepEqual(cleared.staticEvents, []);
  assert.deepEqual(cleared.activeEvents, []);
  assert.deepEqual(cleared.uiState, { kind: "IDLE" });
  assert.equal(cleared.clearCount, state.clearCount + 1);
  assert.equal(cleared.clearEpoch, state.clearEpoch + 1);
  assert.deepEqual(cleared.history, ["Hello"]);
});

test("CLEAR_TRANSCRIPT can seed the clean home screen events", () => {
  const state: SessionState = {
    ...createInitialSessionState(),
    staticEvents: [makeUserEvent(1), makeAssistantEvent(1, "old answer")],
    activeEvents: [makeUserEvent(2), makeRunEvent(2)],
    uiState: { kind: "THINKING", turnId: 2 },
    inputValue: "/clear",
    cursor: 6,
    history: ["old prompt"],
  };
  const launchEvent = makeSystemEvent(20, "Launch mode", "Ready");
  const migrationEvent = makeSystemEvent(21, "Provider migrated", "Reverted to Local.");

  const cleared = reduceSessionState(state, {
    type: "CLEAR_TRANSCRIPT",
    seedEvents: [launchEvent, migrationEvent],
  });

  assert.deepEqual(cleared.staticEvents, [launchEvent, migrationEvent]);
  assert.deepEqual(cleared.activeEvents, []);
  assert.deepEqual(cleared.uiState, { kind: "IDLE" });
  assert.equal(cleared.clearCount, state.clearCount + 1);
  assert.equal(cleared.clearEpoch, state.clearEpoch + 1);
  assert.deepEqual(cleared.history, ["old prompt"]);
});

test("FINALIZE_RUN preserves streamed content when response is undefined", () => {
  const turnId = 1;
  let state = stateWithActiveRun(turnId);

  // Simulate streaming: append assistant delta
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Streamed response text",
    eventFactory: () => makeAssistantEvent(turnId, "Streamed response text"),
  });

  // Finalize with undefined response — should preserve streamed content
  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: undefined,
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  const assistantEvent = state.staticEvents.find(
    (e): e is AssistantEvent => e.type === "assistant",
  );
  assert.ok(assistantEvent, "Assistant event should exist in static events");
  assert.equal(assistantEvent.content, "Streamed response text");
});

test("FINALIZE_RUN stores the fixed elapsed duration supplied by the app", () => {
  const turnId = 11;
  const state = reduceSessionState(stateWithActiveRun(turnId), {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    durationMs: 9876,
    response: "Done",
    assistantFactory: () => makeAssistantEvent(turnId, "Done"),
  });

  const runEvent = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(runEvent);
  assert.equal(runEvent.durationMs, 9876);
});

test("FINALIZE_RUN replaces streamed content when response differs", () => {
  const turnId = 2;
  let state = stateWithActiveRun(turnId);

  // Simulate streaming
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Partial streamed text",
    eventFactory: () => makeAssistantEvent(turnId, "Partial streamed text"),
  });

  // Finalize with different response — should replace
  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "Full sanitized response with additional content",
    assistantFactory: () => makeAssistantEvent(turnId, "Full sanitized response with additional content"),
  });

  const assistantEvent = state.staticEvents.find(
    (e): e is AssistantEvent => e.type === "assistant",
  );
  assert.ok(assistantEvent, "Assistant event should exist in static events");
  assert.equal(assistantEvent.content, "Full sanitized response with additional content");
});

test("RUN_APPEND_ASSISTANT_DELTA transitions UI state to RESPONDING", () => {
  const turnId = 3;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  assert.equal(state.uiState.kind, "THINKING");

  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "First chunk",
    eventFactory: () => makeAssistantEvent(turnId, "First chunk"),
  });

  assert.equal(state.uiState.kind, "RESPONDING");
});

test("FINALIZE_RUN after assistant delta transitions UI state to IDLE", () => {
  const turnId = 35;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Done.",
    eventFactory: () => makeAssistantEvent(turnId, "Done."),
  });

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: undefined,
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  assert.equal(state.uiState.kind, "IDLE");
  assert.equal(isAnimatedBusyState(state.uiState.kind), false);
});

test("RUN_MARK_FINAL_ANSWER_OBSERVED completes visible answer without thinking animation", () => {
  const turnId = 36;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "READY",
    eventFactory: () => makeAssistantEvent(turnId, "READY"),
  });

  state = reduceSessionState(state, {
    type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
    runId: 2,
    turnId,
    response: "READY",
  });

  assert.equal(state.uiState.kind, "ANSWER_VISIBLE");
  assert.equal(isAnimatedBusyState(state.uiState.kind), false);
  assert.equal(isBusy(state.uiState), true);
  const run = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(run);
  assert.equal(run.responseSegments?.[0]?.status, "completed");
});

function makePlanRunEvent(turnId: number): RunEvent {
  return {
    ...makeRunEvent(turnId),
    responsePresentation: "plan",
    streamItems: [],
    responseSegments: [],
    lastStreamSeq: 0,
    activeResponseSegmentId: null,
    plan: null,
  };
}

test("plan-mode chatter before a tool is demoted to prose and the plan block re-opens after the tool", () => {
  const turnId = 37;
  let state = createInitialSessionState();
  state = {
    ...state,
    activeEvents: [makeUserEvent(turnId), makePlanRunEvent(turnId)],
  };
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });

  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "Let me check.",
  });
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: {
      id: "tool-1",
      command: "Get-Content src/app.tsx",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    },
  });

  let activeRun = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(activeRun);
  assert.deepEqual(activeRun.streamItems?.map((item) => item.kind), ["response", "action"]);
  assert.equal(activeRun.plan, null);
  assert.equal(activeRun.responseSegments?.[0]?.chunks.join(""), "Let me check.");

  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "1. Inspect\n",
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "2. Render panel",
  });

  activeRun = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(activeRun);
  assert.deepEqual(activeRun.streamItems?.map((item) => item.kind), ["response", "action", "plan"]);
  assert.equal(getRunPlanText(activeRun.plan), "1. Inspect\n2. Render panel");

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "Let me check.\n1. Inspect\n2. Render panel",
    responsePresentation: "plan",
    assistantFactory: () => makeAssistantEvent(turnId, "should not render"),
  });

  const finalizedRun = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(finalizedRun);
  assert.equal(finalizedRun.plan?.status, "completed");
  assert.equal(getRunPlanText(finalizedRun.plan), "1. Inspect\n2. Render panel");
  assert.deepEqual(finalizedRun.streamItems?.map((item) => item.kind), ["response", "action", "plan"]);
  assert.deepEqual(finalizedRun.streamItems?.map((item) => item.streamSeq), [1, 2, 4]);
  assert.equal(finalizedRun.responseSegments?.[0]?.chunks.join(""), "Let me check.");
  assert.equal(state.staticEvents.some((event) => event.type === "assistant"), false);
});

test("RUN_MARK_FINAL_ANSWER_OBSERVED on a plan run does not synthesize a response segment", () => {
  const turnId = 40;
  let state = createInitialSessionState();
  state = {
    ...state,
    activeEvents: [makeUserEvent(turnId), makePlanRunEvent(turnId)],
  };
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "1. Inspect",
  });
  state = reduceSessionState(state, {
    type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
    runId: 2,
    turnId,
    response: "1. Inspect",
  });

  const activeRun = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(activeRun);
  assert.deepEqual(activeRun.responseSegments, []);
  assert.deepEqual(activeRun.streamItems?.map((item) => item.kind), ["plan"]);
  assert.equal(getRunPlanText(activeRun.plan), "1. Inspect");
});

test("RUN_MARK_FINAL_ANSWER_OBSERVED on a plan run keeps demoted chatter intact", () => {
  const turnId = 41;
  let state = createInitialSessionState();
  state = {
    ...state,
    activeEvents: [makeUserEvent(turnId), makePlanRunEvent(turnId)],
  };
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "Let me check.",
  });
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: { id: "tool-1", command: "ls", status: "completed", startedAt: 10, completedAt: 20 },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_PLAN_DELTA",
    turnId,
    runId: 2,
    chunk: "1. Inspect",
  });
  state = reduceSessionState(state, {
    type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
    runId: 2,
    turnId,
    response: "Let me check.\n1. Inspect",
  });

  const activeRun = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(activeRun);
  assert.equal(activeRun.responseSegments?.length, 1);
  assert.equal(activeRun.responseSegments?.[0]?.chunks.join(""), "Let me check.");
  assert.deepEqual(activeRun.streamItems?.map((item) => item.kind), ["response", "action", "plan"]);
  assert.equal(getRunPlanText(activeRun.plan), "1. Inspect");
});

test("FINALIZE_RUN with plan presentation creates visible plan from final response without deltas", () => {
  const turnId = 38;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: {
      id: "tool-1",
      command: "rg --files",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    },
  });

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "1. Inspect files\n2. Update the timeline cache",
    responsePresentation: "plan",
    assistantFactory: () => makeAssistantEvent(turnId, "should not render"),
  });

  const finalizedRun = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(finalizedRun);
  assert.equal(finalizedRun.plan?.status, "completed");
  assert.equal(getRunPlanText(finalizedRun.plan), "1. Inspect files\n2. Update the timeline cache");
  assert.deepEqual(finalizedRun.streamItems?.map((item) => item.kind), ["action", "plan"]);
  assert.equal(state.staticEvents.some((event) => event.type === "assistant"), false);
});

test("FINALIZE_RUN for approved plan execution keeps approved plan and records assistant response", () => {
  const turnId = 39;
  let state = createInitialSessionState();
  const approvedPlan = "1. Inspect files\n2. Render panel";
  state = {
    ...state,
    activeEvents: [
      makeUserEvent(turnId),
      {
        ...makeRunEvent(turnId),
        plan: {
          id: "plan-2",
          streamSeq: 1,
          chunks: [approvedPlan],
          status: "completed",
          startedAt: 2,
        },
        approvedPlan,
        streamItems: [{ streamSeq: 1, kind: "plan", refId: "plan-2" }],
        responseSegments: [],
        lastStreamSeq: 1,
        activeResponseSegmentId: null,
      },
    ],
  };

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "Implemented the approved plan.",
    assistantFactory: () => makeAssistantEvent(turnId, "Implemented the approved plan."),
  });

  const finalizedRun = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  const finalizedAssistant = state.staticEvents.find((event): event is AssistantEvent => event.type === "assistant");
  assert.ok(finalizedRun);
  assert.ok(finalizedAssistant);
  assert.equal(getRunPlanText(finalizedRun.plan), approvedPlan);
  assert.deepEqual(finalizedRun.streamItems?.map((item) => item.kind), ["plan", "response"]);
  assert.equal(finalizedAssistant.content, "Implemented the approved plan.");
});

test("FINALIZE_RUN for canceled thinking-only run transitions UI state to IDLE", () => {
  const turnId = 36;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "canceled",
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  assert.equal(state.uiState.kind, "IDLE");
  assert.equal(isAnimatedBusyState(state.uiState.kind), false);
});

test("FINALIZE_RUN for failed run records error and exits busy animation", () => {
  const turnId = 37;
  let state = stateWithActiveRun(turnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "failed",
    message: "Provider exploded",
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  const runEvent = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(runEvent);
  assert.equal(runEvent.status, "failed");
  assert.equal(runEvent.errorMessage, "Provider exploded");
  assert.deepEqual(state.uiState, { kind: "ERROR", turnId, message: "Provider exploded" });
  assert.equal(isAnimatedBusyState(state.uiState.kind), false);
});

test("stale RUN_APPEND_ASSISTANT_DELTA does not mutate current UI state", () => {
  const currentTurnId = 38;
  let state = stateWithActiveRun(currentTurnId);
  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId: currentTurnId },
  });

  const afterStaleDelta = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId: currentTurnId - 1,
    runId: 2,
    chunk: "late chunk",
    eventFactory: () => makeAssistantEvent(currentTurnId - 1, "late chunk"),
  });

  assert.strictEqual(afterStaleDelta, state);
  assert.deepEqual(afterStaleDelta.uiState, { kind: "THINKING", turnId: currentTurnId });
});

test("RUN_APPLY_PROGRESS_UPDATES preserves separate entries and updates by id", () => {
  const turnId = 30;
  let state = stateWithActiveRun(turnId);

  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [
      makeProgressUpdate("progress-1", "Checking files"),
      makeProgressUpdate("progress-2", "Comparing snapshots"),
    ],
  });

  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [
      makeProgressUpdate("progress-1", "Checking files\n\nFound two candidates"),
    ],
  });

  const runEvent = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(runEvent);
  assert.equal(runEvent.progressEntries.length, 2);
  assert.equal(runEvent.progressEntries[0]?.text, "Checking files\n\nFound two candidates");
  assert.equal(runEvent.progressEntries[0]?.blocks.length, 2);
  assert.equal(runEvent.progressEntries[0]?.blocks[0]?.text, "Checking files");
  assert.equal(runEvent.progressEntries[0]?.blocks[0]?.status, "completed");
  assert.equal(runEvent.progressEntries[0]?.blocks[1]?.text, "Found two candidates");
  assert.equal(runEvent.progressEntries[1]?.text, "Comparing snapshots");
  assert.equal(runEvent.progressEntries[1]?.blocks[0]?.text, "Comparing snapshots");
});

test("RUN_APPLY_PROGRESS_UPDATES keeps completed block identities stable while the active block grows", () => {
  const turnId = 31;
  let state = stateWithActiveRun(turnId);

  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [
      makeProgressUpdate("progress-1", "Inspecting workspace\n\nSwitching to scratch files"),
    ],
  });

  const afterFirstUpdate = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(afterFirstUpdate);
  const completedBlock = afterFirstUpdate.progressEntries[0]?.blocks[0];
  const activeBlock = afterFirstUpdate.progressEntries[0]?.blocks[1];

  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [
      makeProgressUpdate("progress-1", "Inspecting workspace\n\nSwitching to scratch files in repo root"),
    ],
  });

  const afterSecondUpdate = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(afterSecondUpdate);
  assert.strictEqual(afterSecondUpdate.progressEntries[0]?.blocks[0], completedBlock);
  assert.notStrictEqual(afterSecondUpdate.progressEntries[0]?.blocks[1], activeBlock);
  assert.equal(afterSecondUpdate.progressEntries[0]?.blocks[1]?.text, "Switching to scratch files in repo root");
});

test("reducer preserves response action response ordering across dispatched callbacks", () => {
  const turnId = 32;
  let state = stateWithActiveRun(turnId);

  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "First segment.",
    eventFactory: () => makeAssistantEvent(turnId, "First segment."),
  });
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: {
      id: "tool-1",
      command: "Get-Content README.md",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Second segment.",
    eventFactory: () => makeAssistantEvent(turnId, "Second segment."),
  });

  const runEvent = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(runEvent);
  assert.deepEqual(runEvent.streamItems?.map((item) => item.kind), ["response", "action", "response"]);
  assert.equal(runEvent.responseSegments?.[0]?.chunks.join(""), "First segment.");
  assert.equal(runEvent.responseSegments?.[1]?.chunks.join(""), "Second segment.");
});

test("RUN_APPLY_LIVE_UPDATES applies ordered busy updates in one reducer action", () => {
  const turnId = 34;
  let state = stateWithActiveRun(turnId);

  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPLY_LIVE_UPDATES",
    turnId,
    runId: 2,
    updates: [
      { type: "progress", update: makeProgressUpdate("think-1", "Inspecting files") },
      {
        type: "tool",
        activity: {
          id: "tool-1",
          command: "Get-Content README.md",
          status: "running",
          startedAt: 10,
        },
      },
      { type: "assistant", chunk: "First segment." },
      {
        type: "tool",
        activity: {
          id: "tool-1",
          command: "Get-Content README.md",
          status: "completed",
          startedAt: 10,
          completedAt: 20,
        },
      },
      { type: "assistant", chunk: "Second segment." },
    ],
    assistantEventFactory: (chunk) => ({
      ...makeAssistantEvent(turnId, ""),
      contentChunks: [chunk],
    }),
  });

  const runEvent = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  const assistantEvent = state.activeEvents.find((event): event is AssistantEvent => event.type === "assistant");
  assert.ok(runEvent);
  assert.ok(assistantEvent);
  assert.equal(state.uiState.kind, "RESPONDING");
  assert.deepEqual(
    runEvent.streamItems?.map((item) => item.kind),
    ["thinking", "action", "response"],
  );
  assert.equal(assistantEvent.id, 3);
  assert.deepEqual(assistantEvent.contentChunks, ["First segment.", "Second segment."]);
  assert.equal(runEvent.toolActivities[0]?.status, "completed");
});

test("first prompt lifecycle exposes progress before finalization and preserves chronological stream order", () => {
  const turnId = 33;
  const userEvent = makeUserEvent(turnId);
  const runEvent = { ...makeRunEvent(turnId), summary: "Codex is starting..." };
  let state = createInitialSessionState();

  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "SET_ACTIVE_EVENTS",
    events: [userEvent, runEvent],
  });

  assert.equal(state.uiState.kind, "THINKING");
  assert.deepEqual(state.activeEvents.map((event) => event.type), ["user", "run"]);
  assert.equal((state.activeEvents[1] as RunEvent).summary, "Codex is starting...");

  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [makeProgressUpdate("think-1", "Codex is checking project structure.")],
  });
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: {
      id: "tool-1",
      command: "Get-ChildItem",
      status: "running",
      startedAt: 10,
    },
  });
  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [makeProgressUpdate("think-2", "Codex is validating the startup flow.")],
  });
  state = reduceSessionState(state, {
    type: "RUN_APPEND_ASSISTANT_DELTA",
    turnId,
    runId: 2,
    chunk: "Final answer.",
    eventFactory: () => makeAssistantEvent(turnId, "Final answer."),
  });

  const activeRun = state.activeEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(activeRun);
  assert.deepEqual(
    activeRun.streamItems?.map((item) => item.kind),
    ["thinking", "action", "thinking", "response"],
  );

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: undefined,
    assistantFactory: () => makeAssistantEvent(turnId, ""),
  });

  const finalizedRun = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  const finalizedAssistant = state.staticEvents.find((event): event is AssistantEvent => event.type === "assistant");
  assert.ok(finalizedRun);
  assert.ok(finalizedAssistant);
  assert.deepEqual(
    finalizedRun.streamItems?.map((item) => item.kind),
    ["thinking", "action", "thinking", "response"],
  );
  assert.equal(finalizedAssistant.content, "Final answer.");
});

test("FINALIZE_RUN preserves construction trail and appends final response after actions", () => {
  const turnId = 34;
  const userEvent = makeUserEvent(turnId);
  const runEvent = { ...makeRunEvent(turnId), summary: "Codex is starting..." };
  let state = createInitialSessionState();

  state = reduceSessionState(state, {
    type: "UI_ACTION",
    action: { type: "PROMPT_RUN_STARTED", turnId },
  });
  state = reduceSessionState(state, {
    type: "SET_ACTIVE_EVENTS",
    events: [userEvent, runEvent],
  });
  state = reduceSessionState(state, {
    type: "RUN_APPLY_PROGRESS_UPDATES",
    runId: 2,
    updates: [makeProgressUpdate("think-1", "Inspecting 5-Date Verification.")],
  });
  state = reduceSessionState(state, {
    type: "RUN_UPSERT_TOOL_ACTIVITY",
    runId: 2,
    activity: {
      id: "tool-1",
      command: "Get-Content 5-Date-Verification.md",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
      summary: "Read 42 lines",
    },
  });
  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "Final answer.",
    assistantFactory: () => makeAssistantEvent(turnId, "Final answer."),
  });

  const finalizedRun = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  const finalizedAssistant = state.staticEvents.find((event): event is AssistantEvent => event.type === "assistant");
  assert.ok(finalizedRun);
  assert.ok(finalizedAssistant);
  assert.deepEqual(
    finalizedRun.streamItems?.map((item) => item.kind),
    ["thinking", "action", "response"],
  );
  assert.equal(finalizedRun.toolActivities[0]?.status, "completed");
  assert.equal(finalizedRun.responseSegments?.[0]?.chunks.join(""), "Final answer.");
  assert.equal(finalizedAssistant.content, "Final answer.");
});

test("finalized runs retain their runtime snapshot after unrelated state changes", () => {
  const turnId = 4;
  let state = stateWithActiveRun(turnId);

  state = reduceSessionState(state, {
    type: "FINALIZE_RUN",
    runId: 2,
    turnId,
    status: "completed",
    response: "Done",
    assistantFactory: () => makeAssistantEvent(turnId, "Done"),
  });

  const runEvent = state.staticEvents.find((event): event is RunEvent => event.type === "run");
  assert.ok(runEvent);
  assert.equal(runEvent.runtime.model, TEST_RUNTIME.model);
  assert.equal(runEvent.runtime.policy.sandboxMode, TEST_RUNTIME.policy.sandboxMode);
});

// ─── externalCliStatus state machine ─────────────────────────────────────────

test("initial session state has externalCliStatus 'idle'", () => {
  const state = createInitialSessionState();
  assert.equal(state.externalCliStatus, "idle");
});

test("SET_EXTERNAL_CLI_STATUS transitions idle → starting", () => {
  const state = createInitialSessionState();
  const next = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "starting" });
  assert.equal(next.externalCliStatus, "starting");
});

test("SET_EXTERNAL_CLI_STATUS transitions starting → ready", () => {
  let state = createInitialSessionState();
  state = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "starting" });
  const next = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
  assert.equal(next.externalCliStatus, "ready");
});

test("SET_EXTERNAL_CLI_STATUS is a no-op when status is already the same (returns same object)", () => {
  let state = createInitialSessionState();
  state = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
  const again = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
  assert.strictEqual(again, state, "should return the exact same state reference");
});

test("SUBMIT_PROMPT_RUN does not change externalCliStatus when provider is already ready", () => {
  let state = createInitialSessionState();
  state = reduceSessionState(state, { type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });

  const userEvent = makeUserEvent(99);
  const runEvent = makeRunEvent(99);
  const next = reduceSessionState(state, {
    type: "SUBMIT_PROMPT_RUN",
    turnId: 99,
    runId: 2,
    events: [userEvent, runEvent],
  });

  assert.equal(next.externalCliStatus, "ready", "externalCliStatus must remain 'ready' across prompts");
});
