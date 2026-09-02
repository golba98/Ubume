import assert from "node:assert/strict";
import test from "node:test";
import { appendRunResponseChunk, createRunEvent, upsertRunToolActivity } from "../../session/chatLifecycle.js";
import type { RunEvent, RunToolActivity, UserPromptEvent } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import type { RenderTimelineItem } from "./Timeline.js";
import {
  __clearTimelineMeasureCachesForTests,
  buildStableTimelineSnapshot,
  buildTimelineSnapshot,
  compactActionBursts,
  type StreamEvent,
} from "./timelineMeasure.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// These tests guard the live-generation invariant: while a run is still
// `status: "running"`, its measured/rendered height must be MONOTONIC (it may
// grow but must never shrink). A mid-stream shrink lets the bottom-anchored
// timeline viewport re-reveal already-scrolled-off content — the "old states
// come back" glitch. The dominant shrink source was `compactActionBursts`
// collapsing a burst of same-label action cards while the run was still live.
//
// One sanctioned exception: plan-mode demotion (chatLifecycle
// `demoteActivePlanToResponseSegment`) turns a bordered Plan card into plain
// prose at the same streamSeq when the first tool call starts, which drops the
// card's border rows. TranscriptShell tail-windows live rows to the terminal
// height, so that shrink can no longer re-reveal scrolled-off content.

function makeUser(turnId: number): UserPromptEvent {
  return { id: turnId, type: "user", createdAt: 1, prompt: "read files", turnId };
}

function newRun(turnId: number): RunEvent {
  return createRunEvent({
    id: turnId,
    backendId: "codex-subprocess",
    backendLabel: "Test",
    runtime: TEST_RUNTIME,
    prompt: "read files",
    turnId,
  });
}

/** A completed "Read file" tool — `cat` normalizes to the compactable label. */
function readFileTool(i: number): RunToolActivity {
  return {
    id: `tool-${i}`,
    command: `cat file${i}.txt`,
    status: "completed",
    startedAt: i,
    completedAt: i + 1,
    summary: `Read file${i}`,
  };
}

type TurnRenderItem = Extract<RenderTimelineItem, { type: "turn" }>;

function makeTurnItem(
  run: RunEvent,
  user: UserPromptEvent,
  runPhase: TurnRenderItem["renderState"]["runPhase"],
): RenderTimelineItem {
  return {
    key: `turn-${run.turnId}`,
    type: "turn",
    padded: true,
    item: { type: "turn", turnId: run.turnId, turnIndex: 1, user, run, assistant: null },
    renderState: { opacity: "active", question: null, runPhase },
  };
}

function hasActionSummary(rows: { key: string }[]): boolean {
  return rows.some((row) => row.key.includes("-action-summary-"));
}

// ─── Monotonic height while running ─────────────────────────────────────────────

test("native snapshot: a streaming turn's height never shrinks while the run is running", () => {
  __clearTimelineMeasureCachesForTests();
  const user = makeUser(1);
  let run = newRun(1);

  // A consecutive burst of >= ACTION_COMPACT_MIN_COUNT same-label cards is what
  // triggers compaction; keep them consecutive so the unfixed code would shrink
  // the turn at the 6th card. A trailing response chunk extends the turn further.
  const heights: number[] = [];
  for (let i = 1; i <= 8; i += 1) {
    run = upsertRunToolActivity(run, readFileTool(i));
    const item = makeTurnItem(run, user, "streaming");
    heights.push(buildTimelineSnapshot([item], { totalWidth: 120 }).totalRows);
  }
  run = appendRunResponseChunk(run, "streamed answer begins\n");
  heights.push(buildTimelineSnapshot([makeTurnItem(run, user, "streaming")], { totalWidth: 120 }).totalRows);

  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(
      heights[i]! >= heights[i - 1]!,
      `height shrank at step ${i}: ${heights[i - 1]} -> ${heights[i]} (heights=${heights.join(",")})`,
    );
  }
});

test("stable (live) snapshot: a streaming turn's height never shrinks while the run is running", () => {
  __clearTimelineMeasureCachesForTests();
  const user = makeUser(1);
  let run = newRun(1);

  const heights: number[] = [];
  for (let i = 1; i <= 8; i += 1) {
    run = upsertRunToolActivity(run, readFileTool(i));
    const item = makeTurnItem(run, user, "streaming");
    heights.push(buildStableTimelineSnapshot([item], { totalWidth: 120 }).snapshot.totalRows);
  }
  run = appendRunResponseChunk(run, "streamed answer begins\n");
  heights.push(buildStableTimelineSnapshot([makeTurnItem(run, user, "streaming")], { totalWidth: 120 }).snapshot.totalRows);

  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(
      heights[i]! >= heights[i - 1]!,
      `live-path height shrank at step ${i}: ${heights[i - 1]} -> ${heights[i]} (heights=${heights.join(",")})`,
    );
  }
});

// ─── Compaction only for finished turns ─────────────────────────────────────────

test("action-burst compaction is suppressed while running and applied once finalized", () => {
  __clearTimelineMeasureCachesForTests();
  const user = makeUser(1);
  let run = newRun(1);
  for (let i = 1; i <= 7; i += 1) {
    run = upsertRunToolActivity(run, readFileTool(i));
  }

  const running = buildTimelineSnapshot([makeTurnItem(run, user, "streaming")], { totalWidth: 120 });
  assert.equal(hasActionSummary(running.rows), false, "no action-summary while the run is running");

  // FINALIZE_RUN flips run.status to completed and moves the turn to history.
  const finalizedRun: RunEvent = { ...run, status: "completed", durationMs: 100 };
  const finalized = buildTimelineSnapshot([makeTurnItem(finalizedRun, user, "none")], { totalWidth: 120 });
  assert.equal(hasActionSummary(finalized.rows), true, "action-summary appears once finalized");
  assert.ok(
    finalized.totalRows < running.totalRows,
    `finalized turn should be shorter (cards collapsed): finalized=${finalized.totalRows} running=${running.totalRows}`,
  );
});

test("compaction is gated on run.status, not render phase (ANSWER_VISIBLE while still running)", () => {
  __clearTimelineMeasureCachesForTests();
  const user = makeUser(1);
  let run = newRun(1);
  for (let i = 1; i <= 7; i += 1) {
    run = upsertRunToolActivity(run, readFileTool(i));
  }

  // resolveTurnRunPhase returns "final" during ANSWER_VISIBLE even though
  // run.status is still "running". The gate must NOT compact in this window.
  const item = makeTurnItem(run, user, "final");
  const snapshot = buildTimelineSnapshot([item], { totalWidth: 120 });
  assert.equal(
    hasActionSummary(snapshot.rows),
    false,
    "runPhase=final must not trigger compaction while run.status is running",
  );
});

// ─── compactActionBursts unit gate ──────────────────────────────────────────────

test("compactActionBursts only collapses bursts for finalized, non-verbose turns", () => {
  const events: StreamEvent[] = [];
  for (let i = 1; i <= 7; i += 1) {
    events.push({ kind: "action", streamSeq: i, tool: readFileTool(i) });
  }

  // Live (not finalized) → identity, no collapse.
  assert.strictEqual(compactActionBursts(events, false, false), events);
  // Verbose → identity even when finalized.
  assert.strictEqual(compactActionBursts(events, true, true), events);

  // Finalized + non-verbose → collapse the burst into a summary.
  const compacted = compactActionBursts(events, false, true);
  assert.ok(compacted.length < events.length, "burst should collapse when finalized");
  assert.ok(
    compacted.some((event) => event.kind === "actionSummary"),
    "compacted output includes an actionSummary",
  );
});
