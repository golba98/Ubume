import assert from "node:assert/strict";
import test from "node:test";
import { appendRunPlanChunk, appendStaticEvents, createRunEvent, upsertRunToolActivity } from "./chatLifecycle.js";
import { getRunPlanText, type RunEvent, type RunToolActivity, type TimelineEvent } from "./types.js";
import { TEST_RUNTIME } from "../test/runtimeTestUtils.js";

test("appendStaticEvents deduplicates consecutive identical system events", () => {
  const events: TimelineEvent[] = [
    { id: 1, type: "system", createdAt: 100, title: "T1", content: "C1" },
  ];
  const additions: TimelineEvent[] = [
    { id: 2, type: "system", createdAt: 200, title: "T1", content: "C1" }, // Duplicate
    { id: 3, type: "system", createdAt: 300, title: "T2", content: "C2" }, // Different
  ];

  const result = appendStaticEvents(events, additions);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, 1);
  assert.equal(result[1]?.id, 3);
});

test("appendStaticEvents deduplicates consecutive identical error events", () => {
  const events: TimelineEvent[] = [
    { id: 1, type: "error", createdAt: 100, title: "E1", content: "M1" },
  ];
  const additions: TimelineEvent[] = [
    { id: 2, type: "error", createdAt: 200, title: "E1", content: "M1" }, // Duplicate
    { id: 3, type: "error", createdAt: 300, title: "E2", content: "M2" }, // Different
  ];

  const result = appendStaticEvents(events, additions);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, 1);
  assert.equal(result[1]?.id, 3);
});

test("appendStaticEvents does not deduplicate different event types with same content", () => {
  const events: TimelineEvent[] = [
    { id: 1, type: "system", createdAt: 100, title: "Same", content: "Same" },
  ];
  const additions: TimelineEvent[] = [
    { id: 2, type: "error", createdAt: 200, title: "Same", content: "Same" },
  ];

  const result = appendStaticEvents(events, additions);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, 1);
  assert.equal(result[1]?.id, 2);
});

test("appendStaticEvents does not deduplicate non-consecutive duplicates", () => {
  const events: TimelineEvent[] = [
    { id: 1, type: "system", createdAt: 100, title: "T1", content: "C1" },
  ];
  const additions: TimelineEvent[] = [
    { id: 2, type: "system", createdAt: 200, title: "T2", content: "C2" },
    { id: 3, type: "system", createdAt: 300, title: "T1", content: "C1" }, // Identical to first, but not consecutive
  ];

  const result = appendStaticEvents(events, additions);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.id, 1);
  assert.equal(result[1]?.id, 2);
  assert.equal(result[2]?.id, 3);
});

// ─── Plan-mode demotion ───────────────────────────────────────────────────────

function makePlanRun(overrides: Partial<Parameters<typeof createRunEvent>[0]> = {}): RunEvent {
  return createRunEvent({
    id: 7,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt: "Plan it",
    turnId: 11,
    startedAtMs: 5,
    responsePresentation: "plan",
    ...overrides,
  });
}

function runningTool(id: string): RunToolActivity {
  return { id, command: `cmd ${id}`, status: "running", startedAt: 10 };
}

test("createRunEvent stores responsePresentation on the run event", () => {
  assert.equal(makePlanRun().responsePresentation, "plan");
  assert.equal(makePlanRun({ responsePresentation: undefined }).responsePresentation, "assistant");
});

test("an execution run seeded without approvedPlan carries no plan block to re-render", () => {
  // Approved-plan execution deliberately omits `approvedPlan` (see
  // startApprovedPlanExecution): the plan is already finalized in the
  // transcript, so seeding one here would print the whole plan a second time
  // directly under the "Plan approved" line.
  const run = makePlanRun({ responsePresentation: undefined, approvedPlan: undefined });

  assert.equal(run.plan, null);
  assert.equal(run.approvedPlan, undefined);
  assert.deepEqual(run.streamItems, []);
  assert.equal(run.lastStreamSeq, 0);
});

test("a tool insert demotes an active plan block into a completed response segment at the same streamSeq", () => {
  let run = appendRunPlanChunk(makePlanRun(), "Let me look");
  run = upsertRunToolActivity(run, runningTool("tool-1"));

  assert.equal(run.plan, null);
  assert.deepEqual(run.responseSegments, [{
    id: "response-7-1",
    streamSeq: 1,
    chunks: ["Let me look"],
    status: "completed",
    startedAt: run.responseSegments?.[0]?.startedAt,
  }]);
  assert.deepEqual(run.streamItems?.map((item) => item.kind), ["response", "action"]);
  assert.deepEqual(run.streamItems?.map((item) => item.streamSeq), [1, 2]);
  assert.equal(run.lastStreamSeq, 2);
  assert.equal(run.activeResponseSegmentId, null);
});

test("a plan delta after a tool starts a fresh plan block at the tail", () => {
  let run = appendRunPlanChunk(makePlanRun(), "Let me look");
  run = upsertRunToolActivity(run, runningTool("tool-1"));
  run = appendRunPlanChunk(run, "1. Do X");

  assert.deepEqual(run.streamItems?.map((item) => item.kind), ["response", "action", "plan"]);
  assert.equal(run.plan?.streamSeq, 3);
  assert.equal(getRunPlanText(run.plan), "1. Do X");
  assert.equal(run.responseSegments?.[0]?.chunks.join(""), "Let me look");
});

test("demotion drops an empty active plan block instead of creating an empty segment", () => {
  let run = appendRunPlanChunk(makePlanRun(), "   ");
  run = upsertRunToolActivity(run, runningTool("tool-1"));

  assert.equal(run.plan, null);
  assert.deepEqual(run.responseSegments, []);
  assert.deepEqual(run.streamItems?.map((item) => item.kind), ["action"]);
});

test("demotion skips approved plan blocks", () => {
  const run = upsertRunToolActivity(
    makePlanRun({ approvedPlan: "1. Inspect", responsePresentation: "assistant" }),
    runningTool("tool-1"),
  );

  assert.equal(getRunPlanText(run.plan), "1. Inspect");
  assert.deepEqual(run.streamItems?.map((item) => item.kind), ["plan", "action"]);
  assert.deepEqual(run.responseSegments, []);
});

test("merging an existing tool activity does not demote a plan block a second time", () => {
  let run = appendRunPlanChunk(makePlanRun(), "Let me look");
  run = upsertRunToolActivity(run, runningTool("tool-1"));
  run = appendRunPlanChunk(run, "1. Do X");
  run = upsertRunToolActivity(run, { ...runningTool("tool-1"), status: "completed", completedAt: 20 });

  assert.deepEqual(run.streamItems?.map((item) => item.kind), ["response", "action", "plan"]);
  assert.equal(getRunPlanText(run.plan), "1. Do X");
  assert.equal(run.responseSegments?.length, 1);
});
