import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRunResponseChunk,
  completeRunEvent,
  createRunEvent,
  upsertRunToolActivity,
} from "../../session/chatLifecycle.js";
import type {
  RunEvent,
  RunProgressBlock,
  RunProgressEntry,
  RunToolActivity,
  UserPromptEvent,
} from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import type { RenderTimelineItem } from "./Timeline.js";
import {
  __clearTimelineMeasureCachesForTests,
  buildNativeTranscriptParts,
  type NativeTranscriptParts,
  type TimelineRow,
} from "./timelineMeasure.js";

// ─── Live-turn topology invariant ───────────────────────────────────────────────
//
// Companion to streamingHeightStability.test.ts. The height invariant says a live
// turn may grow but never shrink. This file guards the *ordering/topology*
// invariant: while a turn is `status: "running"`, the relative order of its
// visible blocks must be APPEND-ONLY — a block that has appeared must not move,
// and no block may insert ABOVE blocks that already streamed.
//
// Root cause this regresses: a reasoning ("thinking") block is assigned its
// streamSeq early (low) but only completes later. The old collector revealed a
// completed thinking block at its early streamSeq slot mid-run, slotting it ABOVE
// answer/action blocks that already streamed — reordering the live turn (and, with
// bottom-anchoring, making old states appear to "come back"). The fix defers all
// reasoning while running; it reflows in atomically at finalize.

const TURN_ID = 1;
const REASONING_ENTRY_ID = "entry-reasoning-1";
const REASONING_BLOCK_ID = "reasoning-block-1";

function makeUser(turnId: number): UserPromptEvent {
  return { id: turnId, type: "user", createdAt: 1, prompt: "do the task", turnId };
}

function newRun(turnId: number): RunEvent {
  return createRunEvent({
    id: turnId,
    backendId: "codex-subprocess",
    backendLabel: "Test",
    runtime: TEST_RUNTIME,
    prompt: "do the task",
    turnId,
  });
}

function runningTool(i: number): RunToolActivity {
  return { id: `tool-${i}`, command: `cat file${i}.txt`, status: "running", startedAt: i };
}

function completedTool(i: number): RunToolActivity {
  return {
    id: `tool-${i}`,
    command: `cat file${i}.txt`,
    status: "completed",
    startedAt: i,
    completedAt: i + 1,
    summary: `Read file${i}`,
  };
}

/**
 * Attach an *active* reasoning block created at the next (low) streamSeq. Built
 * by hand so the test can deterministically flip it active→completed mid-run,
 * exactly as the backend does when a reasoning section ends — the precise
 * trigger for the historical insert-above reorder.
 */
function addActiveReasoning(run: RunEvent, text: string): RunEvent {
  const streamSeq = (run.lastStreamSeq ?? 0) + 1;
  const block: RunProgressBlock = {
    id: REASONING_BLOCK_ID,
    text,
    sequence: 1,
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    streamSeq,
  };
  const entry: RunProgressEntry = {
    id: REASONING_ENTRY_ID,
    source: "reasoning",
    text,
    sequence: 1,
    createdAt: 1,
    updatedAt: 1,
    blocks: [block],
    pendingNewlineCount: 0,
  };
  return {
    ...run,
    progressEntries: [...run.progressEntries, entry],
    streamItems: [...(run.streamItems ?? []), { streamSeq, kind: "thinking", refId: REASONING_BLOCK_ID }],
    lastStreamSeq: streamSeq,
  };
}

/** Flip the reasoning block to completed without touching the run's status. */
function completeReasoning(run: RunEvent): RunEvent {
  return {
    ...run,
    progressEntries: run.progressEntries.map((entry) =>
      entry.id === REASONING_ENTRY_ID
        ? {
            ...entry,
            blocks: entry.blocks.map((block) =>
              block.id === REASONING_BLOCK_ID ? { ...block, status: "completed" as const } : block,
            ),
          }
        : entry,
    ),
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

function nativeParts(run: RunEvent, user: UserPromptEvent, runPhase: TurnRenderItem["renderState"]["runPhase"]): NativeTranscriptParts {
  return buildNativeTranscriptParts([makeTurnItem(run, user, runPhase)], { totalWidth: 120 });
}

/** Rows for a finalized (non-running) turn live in `staticItems`, not `liveRows`. */
function staticRows(parts: NativeTranscriptParts): TimelineRow[] {
  return parts.staticItems.flatMap((item) => item.rows);
}

// Block identity embedded in every row key: `…-<kind>-<streamSeq>-…`. One block
// spans several rows; dedupe preserving first-seen order to recover block order.
const BLOCK_KEY_RE = /-(action-summary|codex-response|codex-thinking|plan|action)-(\d+)(?=-|$)/;

function blockIdFromKey(key: string): string | null {
  const match = BLOCK_KEY_RE.exec(key);
  if (!match) return null;
  const kind = match[1] === "codex-response" ? "response" : match[1] === "codex-thinking" ? "thinking" : match[1];
  return `${kind}-${match[2]}`;
}

function blockOrder(rows: TimelineRow[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    const id = blockIdFromKey(row.key);
    if (id && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}

function rowText(row: TimelineRow): string {
  return row.spans.map((span) => span.text).join("");
}

/** earlier must be an order-preserving prefix of later (append-only, no reorder). */
function assertAppendOnly(earlier: string[], later: string[], label: string): void {
  assert.ok(
    later.length >= earlier.length,
    `${label}: blocks disappeared: [${earlier.join(", ")}] -> [${later.join(", ")}]`,
  );
  for (let i = 0; i < earlier.length; i += 1) {
    assert.equal(
      later[i],
      earlier[i],
      `${label}: live block order changed at position ${i}: [${earlier.join(", ")}] -> [${later.join(", ")}]`,
    );
  }
}

test("a streaming turn never reorders its live blocks; reasoning reflows in only at finalize", () => {
  __clearTimelineMeasureCachesForTests();
  const user = makeUser(TURN_ID);

  // 1) prompt submit + an early *active* reasoning block (lowest streamSeq).
  let run = newRun(TURN_ID);
  run = addActiveReasoning(run, "weighing the available options");

  // 2) action-card burst (running tools) → streamSeq 2, 3.
  run = upsertRunToolActivity(run, runningTool(1));
  run = upsertRunToolActivity(run, runningTool(2));
  const nativeOrder = (currentRun: RunEvent) => {
    const parts = nativeParts(currentRun, user, "streaming");
    return blockOrder([
      ...parts.staticItems.flatMap((item) => item.rows),
      ...parts.liveRows,
    ]);
  };
  const f1 = nativeOrder(run);

  // 3) stream assistant text → streamSeq 4.
  run = appendRunResponseChunk(run, "Here is the answer ");
  const f2 = nativeOrder(run);

  // 4) the reasoning block completes WHILE the run is still running. This is the
  //    historical trigger: the old collector would now reveal it at the top.
  run = completeReasoning(run);
  const f3 = nativeOrder(run);

  // 5) update action statuses (running → completed) and stream more text.
  run = upsertRunToolActivity(run, completedTool(1));
  run = upsertRunToolActivity(run, completedTool(2));
  run = appendRunResponseChunk(run, "with more detail.");
  const f4 = nativeOrder(run);

  const runningFrames = [f1, f2, f3, f4];

  // ── No reasoning is surfaced while the run is live ──────────────────────────
  runningFrames.forEach((frame, index) => {
    assert.ok(
      !frame.some((id) => id.startsWith("thinking-")),
      `reasoning must stay deferred while running (frame ${index + 1}): [${frame.join(", ")}]`,
    );
  });

  // ── The top of the active turn never changes (no old state reappears on top) ─
  runningFrames.forEach((frame, index) => {
    assert.equal(
      frame[0],
      "action-2",
      `live turn top block changed at frame ${index + 1}: [${frame.join(", ")}]`,
    );
  });

  // ── Order is append-only across consecutive frames (no mid-stream flip) ──────
  assertAppendOnly(f1, f2, "f1->f2");
  assertAppendOnly(f2, f3, "f2->f3 (reasoning completion must not insert above)");
  assertAppendOnly(f3, f4, "f3->f4");
  assert.deepEqual(f4, ["action-2", "action-3", "response-4"], "final live order");

  // ── No clipped/empty bordered action-card fragment at the static/live seam ──
  const currentParts = nativeParts(run, user, "streaming");
  const orderedRows = [
    ...currentParts.staticItems.flatMap((item) => item.rows),
    ...currentParts.liveRows,
  ];
  assert.equal(
    blockOrder(orderedRows)[0],
    "action-2",
    "first stream block must be the top action card, not a stray fragment",
  );
  const topCardRows = orderedRows.filter((row) => blockIdFromKey(row.key) === "action-2");
  assert.ok(
    topCardRows.some((row) => /[A-Za-z0-9]/.test(rowText(row))),
    "top action card must render content, not an empty border",
  );

  // 6) finish the turn → reasoning reflows in atomically at its creation slot.
  run = completeRunEvent(run);
  const finalOrder = blockOrder(staticRows(nativeParts(run, user, "none")));
  assert.equal(finalOrder[0], "thinking-1", "reasoning appears at its creation slot once finalized");
  assert.deepEqual(
    finalOrder,
    ["thinking-1", "action-2", "action-3", "response-4"],
    "finalized turn shows full streamSeq order including reasoning",
  );
});
