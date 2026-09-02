import assert from "node:assert/strict";
import test from "node:test";
import {
  approvePlanExecution,
  beginPlanFeedback,
  cancelPlanFeedback,
  createInitialPlanFlowState,
  finishPlanGeneration,
  resetPlanFlow,
  resolvePlanExecutionMode,
  startPlanGeneration,
  submitPlanFeedback,
} from "./planFlow.js";

test("starts a fresh plan generation flow from idle", () => {
  const state = startPlanGeneration("Build a hello world script", "auto-edit");

  assert.deepEqual(createInitialPlanFlowState(), { kind: "idle" });
  assert.equal(state.kind, "generating");
  assert.equal(state.originalPrompt, "Build a hello world script");
  assert.equal(state.executionMode, "auto-edit");
  assert.deepEqual(state.constraints, []);
  assert.equal(state.planFilePath, null);
  assert.equal(state.currentPlan, null);
  assert.equal(state.pendingFeedback, null);
});

test("finishes plan generation into an awaiting-action state with a plan file path", () => {
  const state = finishPlanGeneration(
    startPlanGeneration("Build a hello world script", "auto-edit"),
    "## Files\n- hello_world.py",
    "C:\\Workspace\\.codexa\\last-plan.md",
  );

  assert.equal(state.kind, "awaiting_action");
  assert.equal(state.currentPlan, "## Files\n- hello_world.py");
  assert.equal(state.planFilePath, "C:\\Workspace\\.codexa\\last-plan.md");
});

test("revising the plan keeps constraints and records revision feedback", () => {
  const awaiting = finishPlanGeneration(
    startPlanGeneration("Build a hello world script", "auto-edit"),
    "Plan v1",
    "C:\\Workspace\\.codexa\\last-plan.md",
  );
  const collecting = beginPlanFeedback(awaiting, "revise");
  const generating = submitPlanFeedback(collecting, "Keep it to a single file.");

  assert.equal(collecting.kind, "collecting_feedback");
  assert.equal(collecting.mode, "revise");
  assert.equal(generating.kind, "generating");
  assert.equal(generating.currentPlan, "Plan v1");
  assert.equal(generating.planFilePath, "C:\\Workspace\\.codexa\\last-plan.md");
  assert.deepEqual(generating.constraints, []);
  assert.deepEqual(generating.pendingFeedback, {
    mode: "revise",
    text: "Keep it to a single file.",
  });
});

test("adding constraints accumulates them before the next plan pass", () => {
  const awaiting = finishPlanGeneration(
    startPlanGeneration("Build a hello world script", "auto-edit"),
    "Plan v1",
    "C:\\Workspace\\.codexa\\last-plan.md",
  );
  const collecting = beginPlanFeedback(awaiting, "constraints");
  const generating = submitPlanFeedback(collecting, "Do not touch any other files.");

  assert.equal(generating.kind, "generating");
  assert.deepEqual(generating.constraints, ["Do not touch any other files."]);
  assert.deepEqual(generating.pendingFeedback, {
    mode: "constraints",
    text: "Do not touch any other files.",
  });
});

test("canceling feedback returns to the action picker without losing the plan", () => {
  const awaiting = finishPlanGeneration(
    startPlanGeneration("Build a hello world script", "auto-edit"),
    "Plan v1",
    "C:\\Workspace\\.codexa\\last-plan.md",
  );
  const collecting = beginPlanFeedback(awaiting, "revise");
  const canceled = cancelPlanFeedback(collecting);

  assert.equal(canceled.kind, "awaiting_action");
  assert.equal(canceled.currentPlan, "Plan v1");
  assert.equal(canceled.planFilePath, "C:\\Workspace\\.codexa\\last-plan.md");
});

test("approving execution moves to executing and reset returns to idle", () => {
  const awaiting = finishPlanGeneration(
    startPlanGeneration("Build a hello world script", "auto-edit"),
    "Plan v1",
    "C:\\Workspace\\.codexa\\last-plan.md",
  );
  const executing = approvePlanExecution(awaiting);

  assert.equal(executing.kind, "executing");
  assert.equal(executing.executionMode, "auto-edit");
  assert.equal(executing.planFilePath, "C:\\Workspace\\.codexa\\last-plan.md");
  assert.deepEqual(resetPlanFlow(), { kind: "idle" });
});

test("plan generation upgrades a read-only suggest mode to auto-edit for execution", () => {
  assert.equal(resolvePlanExecutionMode("suggest"), "auto-edit");
  assert.equal(resolvePlanExecutionMode("auto-edit"), "auto-edit");
  assert.equal(resolvePlanExecutionMode("full-auto"), "full-auto");

  assert.equal(startPlanGeneration("Build it", "suggest").executionMode, "auto-edit");
  assert.equal(startPlanGeneration("Build it", "full-auto").executionMode, "full-auto");
});
