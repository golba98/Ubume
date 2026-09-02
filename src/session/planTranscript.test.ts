import assert from "node:assert/strict";
import test from "node:test";
import { TEST_RUNTIME } from "../test/runtimeTestUtils.js";
import type { RunEvent, TimelineEvent } from "./types.js";
import { hasFinalizedTranscriptPlan } from "./planTranscript.js";

function makeRun(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: 1,
    type: "run",
    createdAt: 1,
    startedAt: 1,
    durationMs: 10,
    backendId: "codex-subprocess",
    backendLabel: "Codexa",
    runtime: TEST_RUNTIME,
    prompt: "Plan work",
    progressEntries: [],
    status: "completed",
    summary: "completed",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId: 1,
    streamItems: [{ kind: "plan", streamSeq: 1, refId: "plan-1" }],
    responseSegments: [],
    lastStreamSeq: 1,
    activeResponseSegmentId: null,
    plan: {
      id: "plan-1",
      streamSeq: 1,
      chunks: ["1. Inspect\n2. Update"],
      status: "completed",
      startedAt: 1,
    },
    ...overrides,
  };
}

test("approval visibility requires a non-empty finalized transcript plan", () => {
  assert.equal(hasFinalizedTranscriptPlan([], "1. Inspect"), false);
  assert.equal(hasFinalizedTranscriptPlan([makeRun()], ""), false);
  assert.equal(hasFinalizedTranscriptPlan([makeRun({ plan: null })], "1. Inspect"), false);
  assert.equal(
    hasFinalizedTranscriptPlan([
      makeRun({
        status: "running",
        plan: {
          id: "plan-1",
          streamSeq: 1,
          chunks: ["1. Inspect"],
          status: "active",
          startedAt: 1,
        },
      }),
    ], "1. Inspect"),
    false,
  );
  assert.equal(
    hasFinalizedTranscriptPlan([makeRun()] satisfies TimelineEvent[], "1. Inspect\n2. Update"),
    true,
  );
});

test("approval visibility matches the transcript plan under whitespace normalization", () => {
  assert.equal(
    hasFinalizedTranscriptPlan([makeRun()], "1. Inspect\r\n\r\n2. Update  "),
    true,
  );
  assert.equal(hasFinalizedTranscriptPlan([makeRun()], "1. Inspect\n2. Update the cache"), false);
});
