import assert from "node:assert/strict";
import test from "node:test";
import { completeRunEvent, createRunEvent, upsertRunToolActivity } from "../../session/chatLifecycle.js";
import type { RunEvent, TimelineEvent, UserPromptEvent } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { buildStaticRenderItems, buildTimelineItems, type RenderTimelineItem } from "./Timeline.js";
import {
  MAX_RETAINED_STATIC_TURNS,
  buildStaticTranscript,
  createStaticTranscriptCache,
} from "./staticTranscriptCache.js";
import {
  __getNativeTurnBuildCountForTests,
  __resetNativeTurnBuildCountForTests,
  buildNativeTranscriptParts,
} from "./timelineMeasure.js";

const OPTIONS = { totalWidth: 100, verboseMode: false, workspaceRoot: "/workspace/ubume" };

function finalizedTurn(turnId: number): TimelineEvent[] {
  const user: UserPromptEvent = { id: turnId * 10, type: "user", createdAt: turnId, prompt: `task ${turnId}`, turnId };
  let run: RunEvent = createRunEvent({
    id: turnId * 10 + 1,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt: `task ${turnId}`,
    turnId,
    startedAtMs: turnId,
  });
  run = upsertRunToolActivity(run, {
    id: `tool-${turnId}`,
    command: `cat file-${turnId}.txt`,
    status: "completed",
    startedAt: turnId,
    completedAt: turnId + 1,
  });
  run = completeRunEvent(run, 5);
  return [user, run];
}

function finalizedTurns(count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) => finalizedTurn(index + 1)).flat();
}

function renderItems(events: TimelineEvent[], activeTurnId: number | null = null): RenderTimelineItem[] {
  const items = buildTimelineItems(events);
  const turnIds = items.flatMap((item) => item.type === "turn" ? [item.turnId] : []);
  return buildStaticRenderItems(items, turnIds, activeTurnId, null, null);
}

function stripRows(items: { key: string; rows: unknown[] }[]) {
  return items.map((item) => ({ key: item.key, rows: item.rows }));
}

test("builds byte-identical rows to the batched native build", () => {
  const events = finalizedTurns(5);
  const items = renderItems(events);
  const cache = createStaticTranscriptCache();

  const incremental = buildStaticTranscript(cache, items, OPTIONS);
  const batched = buildNativeTranscriptParts(items, { ...OPTIONS, debugLabel: "test" });

  assert.deepEqual(stripRows(incremental.staticItems), stripRows(batched.staticItems));
  assert.deepEqual(incremental.liveRows, batched.liveRows);
});

test("reuses cached rows for unchanged finalized turns and rebuilds only the affected ones", () => {
  const events = finalizedTurns(30);
  const items = renderItems(events);
  const cache = createStaticTranscriptCache();

  buildStaticTranscript(cache, items, OPTIONS);
  __resetNativeTurnBuildCountForTests();
  const second = buildStaticTranscript(cache, renderItems(events), OPTIONS);
  assert.equal(__getNativeTurnBuildCountForTests(), 0, "identical events must not rebuild any turn");
  assert.equal(second.staticItems.length, 30 * 4);

  // Appending a turn: the new turn builds, and the previous last turn flips recent -> dim.
  const grown = [...events, ...finalizedTurn(31)];
  __resetNativeTurnBuildCountForTests();
  const third = buildStaticTranscript(cache, renderItems(grown), OPTIONS);
  assert.ok(__getNativeTurnBuildCountForTests() <= 2, `expected <= 2 rebuilds, got ${__getNativeTurnBuildCountForTests()}`);
  assert.deepEqual(
    stripRows(third.staticItems),
    stripRows(buildNativeTranscriptParts(renderItems(grown), { ...OPTIONS, debugLabel: "test" }).staticItems),
  );
});

test("drops the cache when width, verbose mode, or workspace root changes", () => {
  const events = finalizedTurns(3);
  const cache = createStaticTranscriptCache();
  buildStaticTranscript(cache, renderItems(events), OPTIONS);
  assert.equal(cache.entries.size, 3);

  __resetNativeTurnBuildCountForTests();
  buildStaticTranscript(cache, renderItems(events), { ...OPTIONS, totalWidth: 80 });
  assert.equal(__getNativeTurnBuildCountForTests(), 3);
  assert.equal(cache.entries.size, 3);

  __resetNativeTurnBuildCountForTests();
  buildStaticTranscript(cache, renderItems(events), { ...OPTIONS, totalWidth: 80, verboseMode: true });
  assert.equal(__getNativeTurnBuildCountForTests(), 3);
});

test("prunes cache entries for items that disappeared", () => {
  const events = finalizedTurns(4);
  const cache = createStaticTranscriptCache();
  buildStaticTranscript(cache, renderItems(events), OPTIONS);
  assert.equal(cache.entries.size, 4);

  buildStaticTranscript(cache, renderItems(events.slice(0, 4)), OPTIONS);
  assert.equal(cache.entries.size, 2);
});

test("does not cache a turn that is still running", () => {
  const events = finalizedTurns(2);
  const runningUser: UserPromptEvent = { id: 900, type: "user", createdAt: 9, prompt: "live", turnId: 90 };
  const runningRun = createRunEvent({
    id: 901, backendId: "codex-subprocess", backendLabel: "Ubume", runtime: TEST_RUNTIME, prompt: "live", turnId: 90,
  });
  const cache = createStaticTranscriptCache();
  const parts = buildStaticTranscript(cache, renderItems([...events, runningUser, runningRun]), OPTIONS);
  assert.equal(cache.entries.size, 2);
  assert.ok(parts.liveRows.length > 0, "a running turn's rows stay live");
});

test("retains rows only for the newest MAX_RETAINED_STATIC_TURNS turns", () => {
  assert.equal(MAX_RETAINED_STATIC_TURNS, 200);
  const trimmed = 50;
  const total = MAX_RETAINED_STATIC_TURNS + trimmed;
  const events = finalizedTurns(total);
  const items = renderItems(events);
  const cache = createStaticTranscriptCache();

  const windowed = buildStaticTranscript(cache, items, OPTIONS);
  const full = buildNativeTranscriptParts(items, { ...OPTIONS, debugLabel: "test" });
  const itemsPerTurn = full.staticItems.length / total;
  assert.ok(itemsPerTurn > 1, "a finalized turn produces several static items");

  // Turns first seen outside the window emit one empty placeholder each.
  const placeholders = windowed.staticItems.slice(0, trimmed);
  assert.ok(placeholders.every((item) => item.rows.length === 0));
  assert.deepEqual(
    stripRows(windowed.staticItems.slice(trimmed)),
    stripRows(full.staticItems.slice(trimmed * itemsPerTurn)),
  );
  assert.equal(cache.entries.size, MAX_RETAINED_STATIC_TURNS);
});

test("a turn leaving the retention window keeps its item count so the <Static> list never shrinks", () => {
  const events = finalizedTurns(MAX_RETAINED_STATIC_TURNS);
  const cache = createStaticTranscriptCache();
  const before = buildStaticTranscript(cache, renderItems(events), OPTIONS);
  const firstTurnKeys = before.staticItems.slice(0, 4).map((item) => item.key);

  const grown = [...events, ...finalizedTurn(MAX_RETAINED_STATIC_TURNS + 1)];
  const after = buildStaticTranscript(cache, renderItems(grown), OPTIONS);

  assert.deepEqual(after.staticItems.slice(0, 4).map((item) => item.key), firstTurnKeys);
  assert.ok(after.staticItems.slice(0, 4).every((item) => item.rows.length === 0));
  assert.ok(after.staticItems.length > before.staticItems.length, "appending a turn must grow the item list");
  assert.equal(cache.entries.size, MAX_RETAINED_STATIC_TURNS);

  // Placeholder keys survive a generation change (e.g. width resize).
  const resized = buildStaticTranscript(cache, renderItems(grown), { ...OPTIONS, totalWidth: 80 });
  assert.deepEqual(resized.staticItems.slice(0, 4).map((item) => item.key), firstTurnKeys);
});

test("a keystroke-equivalent rebuild costs no turn builds regardless of transcript length", () => {
  for (const size of [20, 400]) {
    const events = finalizedTurns(size);
    const cache = createStaticTranscriptCache();
    buildStaticTranscript(cache, renderItems(events), OPTIONS);
    __resetNativeTurnBuildCountForTests();
    const started = performance.now();
    buildStaticTranscript(cache, renderItems(events), OPTIONS);
    const elapsed = performance.now() - started;
    assert.equal(__getNativeTurnBuildCountForTests(), 0, `${size} turns: no rebuilds`);
    assert.ok(elapsed < 250, `${size} turns: cached pass took ${elapsed.toFixed(1)}ms`);
  }
});
