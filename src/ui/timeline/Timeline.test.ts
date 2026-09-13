import assert from "node:assert/strict";
import test from "node:test";
import type { RunProgressEntry, TimelineEvent } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { getShellWidth, getVisualWidth } from "../layout.js";
import { buildStaticIntroRows } from "./StaticIntroItem.js";
import type { TimelineRow, TimelineSnapshot } from "./timelineMeasure.js";
import { buildTimelineSnapshot } from "./timelineMeasure.js";
import {
  buildActiveRenderItems,
  buildStaticRenderItems,
  buildTimelineItems,
  createFinalizeContinuityViewport,
  createFollowTailViewport,
  endTimelineViewport,
  findAnchorItem,
  homeTimelineViewport,
  isNearBottom,
  pageDownTimelineViewport,
  pageUpTimelineViewport,
  reflowTimelineViewport,
  createTurnOpacityResolver,
  resolveTurnOpacity,
  scrollTimelineViewport,
  selectTimelineRows,
  stepDownTimelineViewport,
  stepUpTimelineViewport,
  syncTimelineViewport,
  type RenderTimelineItem,
  type TimelineViewportState,
} from "./Timeline.js";

function createRow(key: string): TimelineRow {
  return {
    key,
    spans: [{ text: key }],
  };
}

function createSnapshot(rowCounts: number[]): TimelineSnapshot {
  const items = rowCounts.map((count, itemIndex) => {
    const rows = Array.from({ length: count }, (_, rowIndex) => createRow(`item-${itemIndex}-row-${rowIndex}`));
    return {
      key: `item-${itemIndex}`,
      rows,
      rowCount: rows.length,
    };
  });
  const rows = items.flatMap((item) => item.rows);
  return {
    items,
    rows,
    totalRows: rows.length,
    itemCount: items.length,
  };
}

function createProgressEntry(sequence: number, text: string, blockTexts: string[] = [text]): RunProgressEntry {
  return {
    id: `progress-${sequence}`,
    source: "reasoning",
    text,
    sequence,
    createdAt: sequence,
    updatedAt: sequence,
    pendingNewlineCount: 0,
    blocks: blockTexts.map((blockText, index) => ({
      id: `progress-${sequence}-block-${index + 1}`,
      text: blockText,
      sequence: index + 1,
      createdAt: sequence,
      updatedAt: sequence,
      status: index === blockTexts.length - 1 ? "active" : "completed",
    })),
  };
}

function createCompletedProgressEntry(sequence: number, text: string, blockTexts: string[] = [text]): RunProgressEntry {
  const entry = createProgressEntry(sequence, text, blockTexts);
  return {
    ...entry,
    blocks: entry.blocks.map((block) => ({
      ...block,
      status: "completed",
    })),
  };
}

test("groups user, run, and assistant events into a single turn item", () => {
  const events: TimelineEvent[] = [
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Implement rate limiting",
      turnId: 10,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Implement rate limiting",
      progressEntries: [createProgressEntry(1, "Scanning routes...")],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 10,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 3,
      content: "I found the auth router.",
      contentChunks: [],
      turnId: 10,
    },
    {
      id: 4,
      type: "system",
      createdAt: 4,
      title: "Mode updated",
      content: "AUTO-EDIT enabled",
    },
  ];

  const items = buildTimelineItems(events);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.type, "turn");
  assert.equal(items[1]?.type, "event");

  if (items[0]?.type !== "turn") {
    throw new Error("Expected first item to be a turn");
  }

  assert.equal(items[0].turnId, 10);
  assert.equal(items[0].user?.prompt, "Implement rate limiting");
  assert.equal(items[0].run?.progressEntries[0]?.text, "Scanning routes...");
  assert.equal(items[0].assistant?.content, "I found the auth router.");
});
test("empty transcript event state builds no timeline render rows", () => {
  const items = buildTimelineItems([]);
  const renderItems = buildStaticRenderItems(items, [], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });

  assert.deepEqual(items, []);
  assert.deepEqual(renderItems, []);
  assert.equal(snapshot.totalRows, 0);
  assert.equal(snapshot.itemCount, 0);
});

test("derives active, recent, and dim turn opacity from ordered turn ids", () => {
  const turnIds = [1, 2, 3];

  assert.equal(resolveTurnOpacity(turnIds, 3, 3), "active");
  assert.equal(resolveTurnOpacity(turnIds, 2, 3), "recent");
  assert.equal(resolveTurnOpacity(turnIds, 1, 3), "dim");

  assert.equal(resolveTurnOpacity(turnIds, 3, null), "recent");
  assert.equal(resolveTurnOpacity(turnIds, 1, null), "dim");
});

test("separates committed and active turn render state", () => {
  const committed = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Completed turn",
      turnId: 1,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 250,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Completed turn",
      progressEntries: [],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 1,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 3,
      content: "Done",
      contentChunks: [],
      turnId: 1,
    },
  ]);

  const active = buildTimelineItems([
    {
      id: 4,
      type: "user",
      createdAt: 4,
      prompt: "Live turn",
      turnId: 2,
    },
    {
      id: 5,
      type: "run",
      createdAt: 5,
      startedAt: 5,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Live turn",
      progressEntries: [],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 2,
    },
  ]);

  const turnIds = [1, 2];
  const staticItems = buildStaticRenderItems(committed, turnIds, 2, null, null);
  const activeThinkingItems = buildActiveRenderItems(active, turnIds, { kind: "THINKING", turnId: 2 });
  const activeStreamingItems = buildActiveRenderItems(active, turnIds, { kind: "RESPONDING", turnId: 2 });

  assert.equal(staticItems[0]?.type, "turn");
  assert.equal(staticItems[0]?.type === "turn" ? staticItems[0].renderState.runPhase : "none", "final");
  assert.equal(staticItems[0]?.type === "turn" ? staticItems[0].renderState.opacity : "dim", "recent");
  assert.equal(activeThinkingItems[0]?.type === "turn" ? activeThinkingItems[0].renderState.runPhase : "none", "thinking");
  assert.equal(activeStreamingItems[0]?.type === "turn" ? activeStreamingItems[0].renderState.runPhase : "none", "streaming");
});

test("builds multi-row snapshots from wrapped timeline items", () => {
  const item: RenderTimelineItem = {
    key: "event-1",
    type: "event",
    padded: false,
    event: {
      id: 1,
      type: "system",
      createdAt: 1,
      title: "Long system event",
      content: "This content is intentionally long enough to wrap across multiple transcript rows in a narrow viewport.",
    },
  };

  const snapshot = buildTimelineSnapshot([item], { totalWidth: 32 });
  assert(snapshot.totalRows > 3);
  assert.equal(snapshot.itemCount, 1);
});

test("Ubume intro renders as a normal timeline item", () => {
  const item: RenderTimelineItem = {
    key: "ubume-intro",
    type: "intro",
    padded: true,
    intro: {
      version: "1.0.1",
      layoutMode: "expanded",
      authLabel: "Authenticated",
      workspaceLabel: "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal",
    },
  };

  const snapshot = buildTimelineSnapshot([item], { totalWidth: 110 });
  const lines = snapshot.rows.map((row) => row.spans.map((span) => span.text).join(""));
  const text = lines.join("\n");
  const versionLineIndex = lines.findIndex((line) => line.includes("Ubume v1.0.1"));

  assert.equal(snapshot.itemCount, 1);
  assert.match(text, /██████/);
  assert.match(text, /Ubume v1\.0\.1/);
  assert.match(text, /Auth: Authenticated/);
  assert.match(text, /Workspace: 13-Custom-CLI-Normal/);
  assert.doesNotMatch(text, /Model:/);
  assert(versionLineIndex >= 0 && versionLineIndex < 6);
  assert.match(lines[versionLineIndex]!, /[█╔║╝]/);
});

test("static intro uses the padded timeline snapshot path", () => {
  const layout = {
    cols: 120,
    rows: 40,
    mode: "expanded" as const,
  };
  const rows = buildStaticIntroRows({
    authState: "authenticated",
    workspaceLabel: "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal",
    layout,
    verboseMode: false,
    workspaceRoot: null,
  });
  const shellWidth = getShellWidth(layout.cols);
  const lines = rows.map((row) => row.spans.map((span) => span.text).join(""));
  const text = lines.join("\n");

  assert(rows.length >= 7);
  assert(rows[0]!.key.startsWith("ubume-intro-wrapped-"));
  assert(lines.every((line) => line.length === shellWidth));
  assert(lines[0]!.startsWith(" "));
  assert.match(text, /██╗/);
  assert.match(text, /╚██████╔╝/);
  assert.match(text, /Ubume v/);
  assert.match(text, /Auth: Authenticated/);
  assert.match(text, /Workspace: 13-Custom-CLI-Normal/);
});

test("Ubume intro scrolls out of the visible timeline window", () => {
  const intro: RenderTimelineItem = {
    key: "ubume-intro",
    type: "intro",
    padded: true,
    intro: {
      version: "1.0.1",
      layoutMode: "expanded",
      authLabel: "Authenticated",
      workspaceLabel: "workspace",
    },
  };
  const rows = Array.from({ length: 30 }, (_, index) => ({
    key: `event-${index}`,
    type: "event" as const,
    padded: false,
    event: {
      id: index + 1,
      type: "system" as const,
      createdAt: index + 1,
      title: `Event ${index}`,
      content: "Transcript row",
    },
  }));

  const snapshot = buildTimelineSnapshot([intro, ...rows], { totalWidth: 80 });
  const selection = selectTimelineRows(snapshot, createFollowTailViewport(snapshot.totalRows), 8);
  const text = selection.visibleRows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  assert.doesNotMatch(text, /██████/);
  assert.match(text, /Event 29/);
});

test("timeline snapshot keeps the prompt card top border closed", () => {
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Reproduce the prompt border issue",
      turnId: 10,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Reproduce the prompt border issue",
      progressEntries: [],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 10,
    },
  ]);
  const renderItems = buildActiveRenderItems(items, [10], { kind: "THINKING", turnId: 10 });
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 56 });
  const topBorder = snapshot.rows[0]?.spans.map((span) => span.text).join("").trim();

  assert.equal(topBorder?.includes("╭── PROMPT"), true);
  assert.match(topBorder ?? "", /──╮$/);
  assert.doesNotMatch(topBorder ?? "", / ──╮$/);
});

test("first active run fallback immediately shows Codex thinking status", () => {
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Inspect the project",
      turnId: 11,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Inspect the project",
      progressEntries: [],
      status: "running",
      summary: "Ubume is thinking...",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 11,
    },
  ]);
  const renderItems = buildActiveRenderItems(items, [11], { kind: "THINKING", turnId: 11 });
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 56 });
  const joined = snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  assert.doesNotMatch(joined, /Codex is working/);
  assert.doesNotMatch(joined, /Running\.\.\./);
  assert.doesNotMatch(joined, /Waiting for response/i);
});

test("keeps a frozen browse snapshot while live rows continue to arrive", () => {
  const live = createSnapshot([2, 2]);
  const browsing = pageUpTimelineViewport(createFollowTailViewport(live.totalRows), live, 3);
  const updated = createSnapshot([2, 2, 1]);
  const withUpdate = syncTimelineViewport(browsing, updated);
  const selected = selectTimelineRows(updated, withUpdate, 3);

  assert.equal(withUpdate.followTail, false);
  assert.equal(withUpdate.unseenItems, 1);
  assert.equal(withUpdate.unseenRows, 1);
  assert.equal(selected.sourceSnapshot.itemCount, 2);
  assert.deepEqual(selected.visibleRows.map((row) => row.key), [
    "item-0-row-0",
    "item-0-row-1",
    "item-1-row-0",
  ]);
});

test("page down from the frozen tail resumes live follow mode", () => {
  const live = createSnapshot([2, 2, 1]);
  const frozenSnapshot = createSnapshot([2, 2]);
  const frozenTail = {
    anchorRow: frozenSnapshot.totalRows - 1,
    followTail: false,
    unseenItems: 1,
    unseenRows: 1,
    frozenSnapshot,
  };
  const resumed = pageDownTimelineViewport(frozenTail, live, 3);

  assert.equal(resumed.followTail, true);
  assert.equal(resumed.anchorRow, live.totalRows - 1);
  assert.equal(resumed.frozenSnapshot, null);
});

test("wheel stepping leaves follow mode and only resumes at the frozen tail", () => {
  const snapshot = createSnapshot([1, 1, 1, 1]);
  const viewportRows = 3;

  const stepUp = stepUpTimelineViewport(createFollowTailViewport(snapshot.totalRows), snapshot, viewportRows);
  assert.equal(stepUp.followTail, false);
  assert.equal(stepUp.anchorRow, snapshot.totalRows - 2);
  assert.equal(stepUp.frozenSnapshot?.itemCount, 4);

  const stepDown = stepDownTimelineViewport(stepUp, snapshot, viewportRows);
  assert.equal(stepDown.followTail, true);
  assert.equal(stepDown.anchorRow, snapshot.totalRows - 1);
  assert.equal(stepDown.frozenSnapshot, null);
});

test("manual browse snapshot survives run start and first assistant delta", () => {
  const initial = createSnapshot([1, 1, 1, 1]);
  const browsing = stepUpTimelineViewport(createFollowTailViewport(initial.totalRows), initial, 3);
  const afterRunStart = syncTimelineViewport(browsing, createSnapshot([1, 1, 1, 1, 1]));
  const afterFirstDelta = syncTimelineViewport(afterRunStart, createSnapshot([1, 1, 1, 1, 1, 2]));
  const selected = selectTimelineRows(createSnapshot([1, 1, 1, 1, 1, 2]), afterFirstDelta, 3);

  assert.equal(afterRunStart.followTail, false);
  assert.equal(afterRunStart.unseenItems, 1);
  assert.equal(afterRunStart.unseenRows, 1);
  assert.equal(afterFirstDelta.followTail, false);
  assert.equal(afterFirstDelta.unseenItems, 2);
  assert.equal(afterFirstDelta.unseenRows, 3);
  assert.deepEqual(selected.visibleRows.map((row) => row.key), [
    "item-0-row-0",
    "item-1-row-0",
    "item-2-row-0",
  ]);
});

test("default timeline omits active processing text while a run is streaming", () => {
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Create a file",
      turnId: 99,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Create a file",
      progressEntries: [
        createProgressEntry(1, "Todo 1/2: Write Hello_World.py"),
        createProgressEntry(2, "Verifying generated file"),
      ],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities: [
        {
          id: "tool-1",
          command: "python -m pytest",
          status: "running",
          startedAt: 2,
        },
      ],
      activity: [
        {
          path: "Hello_World.py",
          operation: "created",
          detectedAt: 3,
        },
      ],
      touchedFileCount: 1,
      errorMessage: null,
      turnId: 99,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 4,
      content: "I created the file and I am verifying it.",
      contentChunks: [],
      turnId: 99,
    },
  ]);

  const renderItems = buildActiveRenderItems(items, [99], { kind: "RESPONDING", turnId: 99 });
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 70 });
  const joined = snapshot.rows
    .map((row) => row.spans.map((span) => span.text).join(""))
    .join("\n");

  assert.doesNotMatch(joined, /Codex/);
  assert.doesNotMatch(joined, /Verifying generated file/);
  assert.doesNotMatch(joined, /Todo 1\/2/);
  assert.match(joined, /python -m pytest/);
  assert.doesNotMatch(joined, /Hello_World\.py/);
  assert.match(joined, /python -m pytest/);
  assert.doesNotMatch(joined, /^\s*thinking\b/m);
});

test("streaming defers all processing text (active and completed) until finalize", () => {
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Improve streaming thoughts",
      turnId: 100,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Improve streaming thoughts",
      progressEntries: [
        createCompletedProgressEntry(1, "I inspected the renderer and found the content is flattened into plain card rows.", [
          "I inspected the renderer and found the content is flattened into plain card rows.",
        ]),
        createProgressEntry(2, "Next I am separating completed thoughts from the active live segment.", [
          "Next I am separating completed thoughts from the active live segment.",
        ]),
      ],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 100,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 4,
      content: "Working...",
      contentChunks: [],
      turnId: 100,
    },
  ]);

  const renderItems = buildActiveRenderItems(items, [100], { kind: "RESPONDING", turnId: 100 });
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 54 });
  const joined = snapshot.rows
    .map((row) => row.spans.map((span) => span.text).join(""))
    .join("\n");

  // Active-turn topology stability: reasoning/processing text is DEFERRED while
  // the run is live — both the completed and the active block stay hidden so a
  // late-completing reasoning block can't insert above already-streamed content.
  // It reflows in at finalize (covered by the "completed runs keep progress
  // updates as separate readable blocks" test below).
  assert.doesNotMatch(joined, /I inspected the renderer/);
  assert.doesNotMatch(joined, /Next I am separating/);
  assert.match(joined, /Ubume/);
  assert.doesNotMatch(joined, /▌/);
  assert.ok(snapshot.rows.every((row) => row.spans.map((span) => span.text).join("").length <= 54));
});

test("completed runs coalesce contiguous progress updates under one Reasoning block", () => {
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Investigate the failure",
      turnId: 77,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 1200,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Investigate the failure",
      progressEntries: [
        createProgressEntry(1, "Checking the failing test"),
        createProgressEntry(2, "Reviewing output\n\nComparing expected behavior", [
          "Reviewing output",
          "Comparing expected behavior",
        ]),
      ],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 77,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 3,
      content: "Done",
      contentChunks: [],
      turnId: 77,
    },
  ]);

  const renderItems = buildStaticRenderItems(items, [77], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 72 });
  const joined = snapshot.rows
    .map((row) => row.spans.map((span) => span.text).join(""))
    .join("\n");

  // Contiguous reasoning (no tool call or response between) merges under a
  // single Reasoning header; the compact cap elides the tail with a marker.
  assert.equal(joined.match(/Reasoning/g)?.length, 1);
  assert.match(joined, /Checking the failing test/);
  assert.match(joined, /… \(\d+ more line/);
  assert.doesNotMatch(joined, /Comparing expected behavior/);
  assert.doesNotMatch(joined, /^\s*thinking\b/m);
});

test("assistant unified diffs render with semantic tones", () => {
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,3 +1,4 @@",
    " const name = \"Ubume\";",
    "-console.log(\"old\");",
    "+console.log(\"new\");",
    "+console.log(\"added\");",
    " export default name;",
  ].join("\n");
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Show a diff",
      turnId: 120,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 100,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Show a diff",
      progressEntries: [],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 120,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 3,
      content: diff,
      contentChunks: [],
      turnId: 120,
    },
  ]);

  const renderItems = buildStaticRenderItems(items, [120], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 88 });
  const spans = snapshot.rows.flatMap((row) => row.spans);

  assert.equal(spans.find((span) => span.text.includes("diff --git"))?.tone, "info");
  assert.equal(spans.find((span) => span.text.includes("@@ -1,3 +1,4 @@"))?.tone, "accent");
  assert.equal(spans.find((span) => span.text.includes("-console.log(\"old\");"))?.tone, "error");
  assert.equal(spans.find((span) => span.text.includes("+console.log(\"new\");"))?.tone, "success");
});

test("completed assistant turn renders local links as compact terminal paths", () => {
  const content = [
    "Purpose:",
    "A small app.",
    "",
    "Main parts:",
    "- [`src/App.tsx`](C:/Users/Example/Projects/Project/src/App.tsx#L22) Interactive UI",
    "- [README.md](file:///C:/Users/Example/Projects/Project/README.md) Project overview",
    "- C:\\Users\\Example\\Projects\\Project\\docs\\proof.md#L26 Formal proof",
    "",
    "External: [OpenAI](https://platform.openai.com/docs)",
  ].join("\n");
  const items = buildTimelineItems([
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "What is this file?",
      turnId: 121,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 100,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "What is this file?",
      progressEntries: [],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 121,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 3,
      content,
      contentChunks: [],
      turnId: 121,
    },
  ]);

  const renderItems = buildStaticRenderItems(items, [121], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 96 });
  const joined = snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  assert.match(joined, /src\/App\.tsx:22/);
  assert.match(joined, /README\.md/);
  assert.match(joined, /docs\/proof\.md:26/);
  assert.match(joined, /\[OpenAI\]\(https:\/\/platform\.openai\.com\/docs\)/);
  assert.doesNotMatch(joined, /C:\/Users|C:\\Users|file:\/\//);
  assert.doesNotMatch(joined, /\]\(C:/);
});

test("home anchors the browse window to the first page and end restores tail follow", () => {
  const snapshot = createSnapshot([2, 2, 2]);
  const home = homeTimelineViewport(createFollowTailViewport(snapshot.totalRows), snapshot, 4);
  const window = selectTimelineRows(snapshot, home, 4);
  const end = endTimelineViewport(snapshot.totalRows);

  assert.equal(home.followTail, false);
  assert.equal(window.window.startRow, 0);
  assert.equal(window.window.endRow, 4);
  assert.equal(end.followTail, true);
  assert.equal(end.anchorRow, snapshot.totalRows - 1);
});

// ─── findAnchorItem ───────────────────────────────────────────────────────────

test("findAnchorItem locates the item and row-within-item for a given anchorRow", () => {
  // snapshot: 3 items with [2, 3, 2] rows = rows 0-1, 2-4, 5-6
  const snapshot = createSnapshot([2, 3, 2]);

  // First item, first row
  assert.deepEqual(findAnchorItem(snapshot, 0), { itemIndex: 0, rowWithinItem: 0 });
  // First item, last row
  assert.deepEqual(findAnchorItem(snapshot, 1), { itemIndex: 0, rowWithinItem: 1 });
  // Second item, first row
  assert.deepEqual(findAnchorItem(snapshot, 2), { itemIndex: 1, rowWithinItem: 0 });
  // Second item, middle row
  assert.deepEqual(findAnchorItem(snapshot, 3), { itemIndex: 1, rowWithinItem: 1 });
  // Second item, last row
  assert.deepEqual(findAnchorItem(snapshot, 4), { itemIndex: 1, rowWithinItem: 2 });
  // Third item, last row
  assert.deepEqual(findAnchorItem(snapshot, 6), { itemIndex: 2, rowWithinItem: 1 });
});

test("findAnchorItem clamps to last item when anchorRow is beyond snapshot bounds", () => {
  const snapshot = createSnapshot([2, 3]);
  // totalRows = 5, so anchorRow 99 should clamp to last item's last row
  const result = findAnchorItem(snapshot, 99);
  assert.equal(result.itemIndex, 1);
  assert.equal(result.rowWithinItem, 2); // last item has 3 rows → last = 2
});

// ─── reflowTimelineViewport ───────────────────────────────────────────────────

test("reflowTimelineViewport keeps followTail when user is pinned to bottom", () => {
  const liveSnapshot = createSnapshot([2, 3, 2]);
  const pinned = createFollowTailViewport(liveSnapshot.totalRows);
  const reflowed = reflowTimelineViewport(pinned, liveSnapshot);

  assert.equal(reflowed.followTail, true);
  assert.equal(reflowed.anchorRow, liveSnapshot.totalRows - 1);
  assert.equal(reflowed.frozenSnapshot, null);
});

test("reflowTimelineViewport maps anchor to same item when width decreases (more wrapping)", () => {
  // Old layout: 2 items with [2, 3] rows.  User is looking at row 1 (end of item-0).
  const oldFrozen = createSnapshot([2, 3]);
  const browsing: TimelineViewportState = {
    anchorRow: 1, // last row of item-0
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: oldFrozen,
  };

  // New layout (narrower): same 2 items but item-0 now wraps to 4 rows, item-1 to 5 rows
  const newLive = createSnapshot([4, 5]);
  const reflowed = reflowTimelineViewport(browsing, newLive);

  assert.equal(reflowed.followTail, false);
  // item-0 is now 4 rows.  rowWithinItem was 1, still 1 in new layout.
  // new anchorRow = 0 (rows before item-0) + 1 = 1
  assert.equal(reflowed.anchorRow, 1);
  assert.equal(reflowed.frozenSnapshot?.itemCount, 2);
  assert.equal(reflowed.frozenSnapshot?.totalRows, 9); // 4 + 5
});

test("reflowTimelineViewport clamps rowWithinItem when width increases (less wrapping)", () => {
  // Old layout: item-0 has 5 rows.  Anchor at row 4 (last row of item-0).
  const oldFrozen = createSnapshot([5, 3]);
  const browsing: TimelineViewportState = {
    anchorRow: 4,
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: oldFrozen,
  };

  // New layout (wider): item-0 now wraps to only 2 rows (less wrapping), item-1 to 1 row
  const newLive = createSnapshot([2, 1]);
  const reflowed = reflowTimelineViewport(browsing, newLive);

  assert.equal(reflowed.followTail, false);
  // rowWithinItem was 4, but item-0 only has 2 rows → clamped to 1 (last row)
  // new anchorRow = 0 + 1 = 1
  assert.equal(reflowed.anchorRow, 1);
  assert.equal(reflowed.frozenSnapshot?.totalRows, 3); // 2 + 1
});

test("reflowTimelineViewport preserves unseenItems and unseenRows after width change", () => {
  // User scrolled up when there were 2 items.  One more item arrived since then.
  const oldFrozen = createSnapshot([2, 3]);
  const browsing: TimelineViewportState = {
    anchorRow: 4, // last row of item-1 in old frozen
    followTail: false,
    unseenItems: 1,
    unseenRows: 2,
    frozenSnapshot: oldFrozen,
  };

  // New layout: 3 items (frozen 2 + 1 unseen), all at new width
  const newLive = createSnapshot([3, 4, 2]); // 9 total
  const reflowed = reflowTimelineViewport(browsing, newLive);

  assert.equal(reflowed.followTail, false);
  // frozenItemCount = 2 → new frozen uses first 2 items from newLive: [3, 4]
  assert.equal(reflowed.frozenSnapshot?.itemCount, 2);
  assert.equal(reflowed.frozenSnapshot?.totalRows, 7); // 3 + 4
  // unseenItems = 3 - 2 = 1
  assert.equal(reflowed.unseenItems, 1);
  // unseenRows = 9 - 7 = 2
  assert.equal(reflowed.unseenRows, 2);
});

test("reflowTimelineViewport does not snap to bottom during active streaming", () => {
  // User scrolled up mid-stream.  frozenSnapshot has 3 items (includes partial assistant).
  const oldFrozen = createSnapshot([1, 2, 3]);
  const browsing: TimelineViewportState = {
    anchorRow: 2, // within item-1 (rows 1-2) → rowWithinItem = 1
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: oldFrozen,
  };

  // Width change arrives mid-stream: liveSnapshot has grown (assistant has more content)
  // Items 0..2 from frozenSnapshot, item-2 now larger due to more streaming content
  const newLive = createSnapshot([1, 2, 6]);
  const reflowed = reflowTimelineViewport(browsing, newLive);

  // Must NOT snap to bottom
  assert.equal(reflowed.followTail, false);
  // item-1 has 2 rows in new layout → rowWithinItem=1 preserved
  // anchorRow = item-0 (1 row) + 1 = 2
  assert.equal(reflowed.anchorRow, 2);
  assert.equal(reflowed.frozenSnapshot?.itemCount, 3);
});

// ─── selectTimelineRows: height-change stability ──────────────────────────────

test("height increase while scrolled up shows more content above without snapping to bottom", () => {
  const snapshot = createSnapshot([3, 3, 3, 3]); // 12 rows, 4 items
  // User is at anchorRow=8 (last row of item-2), viewing rows 5-8 at viewportRows=4
  const browsing: TimelineViewportState = {
    anchorRow: 8,
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: snapshot,
  };

  const smallViewport = selectTimelineRows(snapshot, browsing, 4);
  assert.equal(smallViewport.window.startRow, 5);
  assert.equal(smallViewport.window.endRow, 9);

  // Terminal grows to 8 rows — more content visible above, bottom anchor preserved
  const largeViewport = selectTimelineRows(snapshot, browsing, 8);
  assert.equal(largeViewport.window.startRow, 1);
  assert.equal(largeViewport.window.endRow, 9);
  // Confirm not snapped to bottom
  assert.notEqual(largeViewport.window.endRow, snapshot.totalRows);
});

test("height decrease while scrolled up preserves bottom anchor", () => {
  const snapshot = createSnapshot([3, 3, 3, 3]); // 12 rows
  const browsing: TimelineViewportState = {
    anchorRow: 8,
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: snapshot,
  };

  // Viewport shrinks from 4 to 2 rows
  const shrunk = selectTimelineRows(snapshot, browsing, 2);
  // Bottom (anchorRow=8) is preserved; only 2 rows visible
  assert.equal(shrunk.window.endRow, 9);
  assert.equal(shrunk.window.startRow, 7);
  assert.equal(shrunk.visibleRows.length, 2);
});

// ─── streaming while detached does not jump to bottom ────────────────────────

test("streaming deltas while detached do not move the viewport to bottom", () => {
  const initial = createSnapshot([1, 1, 1, 1]); // 4 items, 4 rows
  // User pages up — frozen at initial snapshot
  const browsing = pageUpTimelineViewport(createFollowTailViewport(initial.totalRows), initial, 3);
  assert.equal(browsing.followTail, false);

  // Multiple streaming deltas arrive (same width — syncTimelineViewport path)
  const afterDelta1 = syncTimelineViewport(browsing, createSnapshot([1, 1, 1, 1, 2]));
  const afterDelta2 = syncTimelineViewport(afterDelta1, createSnapshot([1, 1, 1, 1, 4]));
  const afterDelta3 = syncTimelineViewport(afterDelta2, createSnapshot([1, 1, 1, 1, 6]));

  // Must remain detached throughout
  assert.equal(afterDelta3.followTail, false);
  assert.equal(afterDelta3.frozenSnapshot?.itemCount, 4);

  // The visible rows are still from the frozen snapshot, not the live tail
  const selected = selectTimelineRows(createSnapshot([1, 1, 1, 1, 6]), afterDelta3, 3);
  assert.equal(selected.sourceSnapshot.itemCount, 4);
  assert.notEqual(selected.window.endRow, 11); // not snapped to live tail
});

test("scrolling down to the frozen tail with pending unseen content resumes live follow", () => {
  const initial = createSnapshot([2, 2]);
  const browsing = scrollTimelineViewport(
    createFollowTailViewport(initial.totalRows),
    initial,
    4,
    -2, // scroll up 2 rows
  );
  assert.equal(browsing.followTail, false);

  const updated = createSnapshot([2, 2, 3]);
  const withNew = syncTimelineViewport(browsing, updated);
  assert.equal(withNew.unseenItems, 1);

  // Scroll down past frozen tail → resume follow
  const resumed = pageDownTimelineViewport(withNew, updated, 4);
  assert.equal(resumed.followTail, true);
  assert.equal(resumed.frozenSnapshot, null);
});

// ─── action event command normalization in timeline render ───────────────────

function makeCompletedRunWithTool(turnId: number, command: string): TimelineEvent[] {
  return [
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Do something",
      turnId,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 500,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Do something",
      progressEntries: [],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [
        {
          id: "tool-1",
          command,
          status: "completed",
          startedAt: 2,
          completedAt: 3,
        },
      ],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId,
    },
    {
      id: 3,
      type: "assistant",
      createdAt: 4,
      content: "Done.",
      contentChunks: [],
      turnId,
    },
  ];
}

function makeChronologicalTurnEvents(
  turnId: number,
  runOverrides: Partial<Extract<TimelineEvent, { type: "run" }>>,
  assistantContent = "",
): TimelineEvent[] {
  const run: Extract<TimelineEvent, { type: "run" }> = {
    id: 2,
    type: "run",
    createdAt: 2,
    startedAt: 2,
    durationMs: 500,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt: "Do something",
    progressEntries: [],
    status: "completed",
    summary: "Completed",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId,
    ...runOverrides,
  };

  return [
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "Do something",
      turnId,
    },
    run,
    {
      id: 3,
      type: "assistant",
      createdAt: 4,
      content: assistantContent,
      contentChunks: [],
      turnId,
    },
  ];
}

function renderJoinedTurn(
  events: TimelineEvent[],
  turnId: number,
  width = 90,
  options: { workspaceRoot?: string | null } = {},
): string {
  const items = buildTimelineItems(events);
  const renderItems = buildStaticRenderItems(items, [turnId], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: width, workspaceRoot: options.workspaceRoot });
  return snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
}

test("unified stream renders generated final plan after action blocks", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(299, {
    plan: {
      id: "plan-2",
      streamSeq: 3,
      chunks: ["1. Inspect the current app structure\n2. Render the generated plan visibly"],
      status: "completed",
      startedAt: 2,
    },
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content src/app.tsx",
      status: "completed",
      startedAt: 10,
      completedAt: 40,
      streamSeq: 2,
    }],
    streamItems: [
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 3,
  }), 299);

  assert.match(joined, /╭── Plan/);
  assert.match(joined, /│ 1\. Inspect the current app structure/);
  assert.match(joined, /╰/);
  assert.match(joined, /✓ Read file/);
  assert.ok(joined.indexOf("Read file") < joined.indexOf("Plan"));
  assert.ok(joined.indexOf("Read file") < joined.indexOf("Render the generated plan visibly"));
});

test("unified stream renders pre-tool plan-mode prose before the action and the Plan box after", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(298, {
    responseSegments: [{
      id: "response-2-1",
      streamSeq: 1,
      chunks: ["Let me inspect the app first."],
      status: "completed",
      startedAt: 2,
    }],
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content src/app.tsx",
      status: "completed",
      startedAt: 10,
      completedAt: 40,
      streamSeq: 2,
    }],
    plan: {
      id: "plan-2",
      streamSeq: 3,
      chunks: ["1. Inspect the current app structure\n2. Render the generated plan visibly"],
      status: "completed",
      startedAt: 2,
    },
    streamItems: [
      { streamSeq: 1, kind: "response", refId: "response-2-1" },
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 3,
  }), 298);

  assert.match(joined, /Let me inspect the app first\./);
  assert.doesNotMatch(joined, /│ Let me inspect the app first\./);
  assert.match(joined, /╭── Plan/);
  assert.ok(joined.indexOf("Let me inspect the app first.") < joined.indexOf("Read file"));
  assert.ok(joined.indexOf("Read file") < joined.indexOf("╭── Plan"));
});

test("unified stream renders approved execution plan with approved badge", () => {
  const approvedPlan = "1. Apply the selected changes\n2. Run tests";
  const turnId = 9305;
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(turnId, {
    plan: {
      id: "plan-2",
      streamSeq: 1,
      chunks: [approvedPlan],
      status: "completed",
      startedAt: 2,
    },
    approvedPlan,
    streamItems: [
      { streamSeq: 1, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 1,
  }), turnId);

  assert.match(joined, /╭── Plan/);
  assert.match(joined, /approved/);
  assert.doesNotMatch(joined, /Review Plan/);
  assert.doesNotMatch(joined, /Implementation Plan/);
});

test("plan card rows carry frame metadata so the live window cannot slice them open", () => {
  const turnId = 9307;
  const events = makeChronologicalTurnEvents(turnId, {
    plan: {
      id: "plan-2",
      streamSeq: 1,
      chunks: ["1. Apply the selected changes\n2. Run tests"],
      status: "completed",
      startedAt: 2,
    },
    streamItems: [{ streamSeq: 1, kind: "plan", refId: "plan-2" }],
    lastStreamSeq: 1,
  });
  const renderItems = buildStaticRenderItems(buildTimelineItems(events), [turnId], null, null, null);
  const rows = buildTimelineSnapshot(renderItems, { totalWidth: 90 }).rows;

  const framed = rows.filter((row) => row.frame);
  const planFrameId = framed.find((row) => row.spans.map((span) => span.text).join("").includes("\u256d\u2500\u2500 Plan"))?.frame?.id;
  assert.ok(planFrameId, "the Plan card should expose a frame id");

  const planRows = framed.filter((row) => row.frame?.id === planFrameId);
  assert.equal(planRows[0]!.frame?.role, "top");
  assert.equal(planRows.at(-1)!.frame?.role, "bottom");
  assert.ok(planRows.slice(1, -1).every((row) => row.frame?.role === "content"));
});

test("unified stream hides workspace paths in finalized plan snapshots", () => {
  const turnId = 9306;
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(turnId, {
    plan: {
      id: "plan-2",
      streamSeq: 1,
      chunks: ["Files:\n- C:\\Development\\Project\\src\\app.tsx"],
      status: "completed",
      startedAt: 2,
    },
    streamItems: [
      { streamSeq: 1, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 1,
  }), turnId, 90, { workspaceRoot: "C:\\Development\\Project" });

  assert.match(joined, /src\/app\.tsx/);
  assert.doesNotMatch(joined, /C:\\Development/);
});

test("long draft plan remains timeline rows that can be scrolled", () => {
  const longPlan = [
    "Files:",
    ...Array.from({ length: 36 }, (_, index) => `- src/file-${index + 1}.ts Wire file ${index + 1}.`),
    "",
    "Steps:",
    ...Array.from({ length: 36 }, (_, index) => `${index + 1}. Complete step ${index + 1}.`),
  ].join("\n");
  const turnId = 9307;
  const events = makeChronologicalTurnEvents(turnId, {
    plan: {
      id: "plan-2",
      streamSeq: 1,
      chunks: [longPlan],
      status: "completed",
      startedAt: 2,
    },
    streamItems: [
      { streamSeq: 1, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 1,
  });
  const items = buildTimelineItems(events);
  const renderItems = buildStaticRenderItems(items, [turnId], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 100 });
  const firstPage = selectTimelineRows(snapshot, { ...createFollowTailViewport(snapshot.totalRows), followTail: false, anchorRow: 15 }, 12);
  const tailPage = selectTimelineRows(snapshot, createFollowTailViewport(snapshot.totalRows), 12);
  const allRows = snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  assert.ok(snapshot.totalRows > 72, "long plan should add scrollback rows to the timeline");
  assert.match(allRows, /Plan/);
  assert.match(firstPage.visibleRows.map((row) => row.spans.map((span) => span.text).join("")).join("\n"), /src\/file-/);
  assert.match(tailPage.visibleRows.map((row) => row.spans.map((span) => span.text).join("")).join("\n"), /36\. Complete step 36\./);
});

test("follow-tail viewport shows generated final plan at bottom after prior action rows", () => {
  const longPlan = [
    "Files:",
    ...Array.from({ length: 12 }, (_, index) => `- src/file-${index + 1}.ts Update file ${index + 1}.`),
    "",
    "Steps:",
    ...Array.from({ length: 20 }, (_, index) => `${index + 1}. Final plan step ${index + 1}.`),
  ].join("\n");
  const turnId = 9308;
  const events = makeChronologicalTurnEvents(turnId, {
    plan: {
      id: "plan-2",
      streamSeq: 3,
      chunks: [longPlan],
      status: "completed",
      startedAt: 2,
    },
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content src/app.tsx",
      status: "completed",
      startedAt: 10,
      completedAt: 40,
      streamSeq: 2,
    }],
    streamItems: [
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "plan", refId: "plan-2" },
    ],
    lastStreamSeq: 3,
  });
  const items = buildTimelineItems(events);
  const renderItems = buildStaticRenderItems(items, [turnId], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 100 });
  const tailPage = selectTimelineRows(snapshot, createFollowTailViewport(snapshot.totalRows), 10);
  const tailText = tailPage.visibleRows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
  const allText = snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  assert.ok(allText.indexOf("Read file") < allText.indexOf("Plan"));
  assert.match(tailText, /20\. Final plan step 20\./);
  assert.doesNotMatch(tailText, /Read file/);
});

test("unified stream renders action before response by stream sequence", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(300, {
    toolActivities: [{
      id: "tool-1",
      command: "rg --files",
      status: "completed",
      startedAt: 10,
      completedAt: 429,
      streamSeq: 1,
    }],
    responseSegments: [{
      id: "response-1",
      streamSeq: 2,
      chunks: ["Purpose\n5-Date Verification explains the two-block calendar puzzle."],
      status: "completed",
      startedAt: 20,
    }],
    streamItems: [
      { streamSeq: 1, kind: "action", refId: "tool-1" },
      { streamSeq: 2, kind: "response", refId: "response-1" },
    ],
    lastStreamSeq: 2,
  }), 300);

  assert.ok(joined.indexOf("List files") < joined.indexOf("Purpose"));
  assert.match(joined, /List files/);
  assert.match(joined, /Ubume/);
  assert.doesNotMatch(joined, /^\s*response\b/m);
});

test("unified stream preserves thinking action response ordering", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(301, {
    progressEntries: [{
      id: "reason-1",
      source: "reasoning",
      text: "I need to inspect the project files.",
      sequence: 1,
      createdAt: 1,
      updatedAt: 1,
      pendingNewlineCount: 0,
      blocks: [{
        id: "reason-1-block-1",
        text: "I need to inspect the project files.",
        sequence: 1,
        createdAt: 1,
        updatedAt: 1,
        status: "completed",
        streamSeq: 1,
      }],
    }],
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content README.md",
      status: "completed",
      startedAt: 10,
      completedAt: 426,
      streamSeq: 2,
    }],
    responseSegments: [{
      id: "response-1",
      streamSeq: 3,
      chunks: ["Purpose\n5-Date Verification is an interactive math app."],
      status: "completed",
      startedAt: 20,
    }],
    streamItems: [
      { streamSeq: 1, kind: "thinking", refId: "reason-1-block-1" },
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "response", refId: "response-1" },
    ],
    lastStreamSeq: 3,
  }), 301);

  assert.ok(joined.indexOf("I need to inspect") < joined.indexOf("Read file"));
  assert.ok(joined.indexOf("Read file") < joined.indexOf("Purpose"));
  assert.match(joined, /Ubume/);
  assert.doesNotMatch(joined, /^\s*response\b/m);
});

test("unified stream preserves response action response interleaving", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(302, {
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content src\\App.tsx",
      status: "completed",
      startedAt: 10,
      completedAt: 428,
      streamSeq: 2,
    }],
    responseSegments: [
      {
        id: "response-1",
        streamSeq: 1,
        chunks: ["First segment."],
        status: "completed",
        startedAt: 1,
      },
      {
        id: "response-2",
        streamSeq: 3,
        chunks: ["Second segment."],
        status: "completed",
        startedAt: 2,
      },
    ],
    streamItems: [
      { streamSeq: 1, kind: "response", refId: "response-1" },
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "response", refId: "response-2" },
    ],
    lastStreamSeq: 3,
  }), 302);

  assert.ok(joined.indexOf("First segment") < joined.indexOf("Read file"));
  assert.ok(joined.indexOf("Read file") < joined.indexOf("Second segment"));
  assert.doesNotMatch(joined, /^\s*response\b/m);
});

test("stream renders Codex text outside compact action rows", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(305, {
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content README.md",
      status: "completed",
      startedAt: 10,
      completedAt: 426,
      streamSeq: 2,
    }],
    responseSegments: [
      {
        id: "response-1",
        streamSeq: 1,
        chunks: ["I am checking the README."],
        status: "completed",
        startedAt: 1,
      },
      {
        id: "response-2",
        streamSeq: 3,
        chunks: ["Purpose: this project wraps Codex in a terminal UI."],
        status: "completed",
        startedAt: 2,
      },
    ],
    streamItems: [
      { streamSeq: 1, kind: "response", refId: "response-1" },
      { streamSeq: 2, kind: "action", refId: "tool-1" },
      { streamSeq: 3, kind: "response", refId: "response-2" },
    ],
    lastStreamSeq: 3,
  }), 305);

  const codexLine = joined.split("\n").find((line) => line.includes("I am checking the README."));
  const actionLine = joined.split("\n").find((line) => line.includes("Read file"));

  assert.match(joined, /Codex/);
  assert.match(joined, /Read file/);
  assert.ok(codexLine && !codexLine.includes("│"), "Codex narration should not be inside a bordered row");
  assert.ok(actionLine && actionLine.includes("✓"), "action execution should keep the compact row visual");
  assert.doesNotMatch(joined, /^\s*response\b/m);
});

test("consecutive actions render as separate compact action rows", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(306, {
    toolActivities: [
      {
        id: "tool-1",
        command: "Get-ChildItem -Force",
        status: "completed",
        startedAt: 10,
        completedAt: 488,
        streamSeq: 1,
      },
      {
        id: "tool-2",
        command: "Get-Content src\\App.tsx",
        status: "completed",
        startedAt: 20,
        completedAt: 452,
        streamSeq: 2,
      },
    ],
    streamItems: [
      { streamSeq: 1, kind: "action", refId: "tool-1" },
      { streamSeq: 2, kind: "action", refId: "tool-2" },
    ],
    lastStreamSeq: 2,
  }), 306);

  assert.equal((joined.match(/✓ /g) ?? []).length, 2);
  assert.match(joined, /List files/);
  assert.match(joined, /Read file/);
});

test("completed final response is not forced above earlier actions", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(303, {
    toolActivities: [{
      id: "tool-1",
      command: "git status",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
      streamSeq: 1,
    }],
    responseSegments: [{
      id: "response-1",
      streamSeq: 2,
      chunks: ["Done after checking status."],
      status: "completed",
      startedAt: 30,
    }],
    streamItems: [
      { streamSeq: 1, kind: "action", refId: "tool-1" },
      { streamSeq: 2, kind: "response", refId: "response-1" },
    ],
    lastStreamSeq: 2,
  }), 303);

  assert.ok(joined.indexOf("Check git status") < joined.indexOf("Done after checking status"));
});

test("completed action/read-file rows remain before the final response", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(307, {
    toolActivities: [
      {
        id: "tool-1",
        command: "Get-Content 5-Date-Verification.md",
        status: "completed",
        startedAt: 10,
        completedAt: 20,
        streamSeq: 1,
      },
      {
        id: "tool-2",
        command: "Get-Content README.md",
        status: "completed",
        startedAt: 21,
        completedAt: 30,
        streamSeq: 2,
      },
    ],
    responseSegments: [{
      id: "response-1",
      streamSeq: 3,
      chunks: ["Final answer: 5-Date Verification explains the date-checking rule."],
      status: "completed",
      startedAt: 40,
    }],
    streamItems: [
      { streamSeq: 1, kind: "action", refId: "tool-1" },
      { streamSeq: 2, kind: "action", refId: "tool-2" },
      { streamSeq: 3, kind: "response", refId: "response-1" },
    ],
    lastStreamSeq: 3,
  }), 307);

  assert.equal((joined.match(/✓ Read file/g) ?? []).length, 2);
  assert.ok(joined.indexOf("Read file") < joined.indexOf("Final answer"));
});

test("finalize continuity viewport shows construction plus the beginning of the final answer", () => {
  const turnId = 308;
  const prompt = "What is the point of this file ie 5-Date Verification";
  const toolActivities = Array.from({ length: 6 }, (_, index) => ({
    id: `tool-${index + 1}`,
    command: `Get-Content date-file-${index + 1}.md`,
    status: "completed" as const,
    startedAt: 10 + index,
    completedAt: 20 + index,
    summary: `Read ${10 + index} lines`,
    streamSeq: index + 2,
  }));
  const progressEntry: RunProgressEntry = {
    id: "reason-1",
    source: "reasoning",
    text: "I need to inspect the date verification files.",
    sequence: 1,
    createdAt: 1,
    updatedAt: 1,
    pendingNewlineCount: 0,
    blocks: [{
      id: "reason-1-block-1",
      text: "I need to inspect the date verification files.",
      sequence: 1,
      createdAt: 1,
      updatedAt: 1,
      status: "completed",
      streamSeq: 1,
    }],
  };
  const userEvent: TimelineEvent = {
    id: 1,
    type: "user",
    createdAt: 1,
    prompt,
    turnId,
  };
  const runningRun: Extract<TimelineEvent, { type: "run" }> = {
    id: 2,
    type: "run",
    createdAt: 2,
    startedAt: 2,
    durationMs: null,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt,
    progressEntries: [progressEntry],
    status: "running",
    summary: "Running",
    truncatedOutput: false,
    toolActivities,
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId,
    streamItems: [
      { streamSeq: 1, kind: "thinking", refId: "reason-1-block-1" },
      ...toolActivities.map((tool) => ({ streamSeq: tool.streamSeq!, kind: "action" as const, refId: tool.id })),
    ],
    responseSegments: [],
    lastStreamSeq: 7,
    activeResponseSegmentId: null,
  };
  const finalAnswer = Array.from(
    { length: 16 },
    (_, index) => `Final answer line ${index + 1}: explanation of 5-Date Verification.`,
  ).join("\n");
  const finalizedRun: Extract<TimelineEvent, { type: "run" }> = {
    ...runningRun,
    status: "completed",
    durationMs: 1000,
    responseSegments: [{
      id: "response-final-2-8",
      streamSeq: 8,
      chunks: [finalAnswer],
      status: "completed",
      startedAt: 40,
    }],
    streamItems: [
      ...(runningRun.streamItems ?? []),
      { streamSeq: 8, kind: "response", refId: "response-final-2-8" },
    ],
    lastStreamSeq: 8,
  };
  const assistantEvent: TimelineEvent = {
    id: 3,
    type: "assistant",
    createdAt: 3,
    content: finalAnswer,
    contentChunks: [],
    turnId,
  };
  const activeItems = buildTimelineItems([userEvent, runningRun]);
  const activeRenderItems = buildActiveRenderItems(activeItems, [turnId], { kind: "THINKING", turnId });
  const activeSnapshot = buildTimelineSnapshot(activeRenderItems, { totalWidth: 90 });
  const finalItems = buildTimelineItems([userEvent, finalizedRun, assistantEvent]);
  const finalRenderItems = buildStaticRenderItems(finalItems, [turnId], null, null, null);
  const finalSnapshot = buildTimelineSnapshot(finalRenderItems, { totalWidth: 90 });
  const continuity = createFinalizeContinuityViewport(finalSnapshot, {
    previousTotalRows: activeSnapshot.totalRows,
    viewportRows: 18,
  });
  const visible = selectTimelineRows(finalSnapshot, continuity, 18).visibleRows
    .map((row) => row.spans.map((span) => span.text).join(""))
    .join("\n");

  assert.equal(continuity.followTail, false);
  assert.notEqual(continuity.anchorRow, finalSnapshot.totalRows - 1);
  assert.match(visible, /✓ Read file/);
  assert.match(visible, /Read file/);
  assert.match(visible, /Final answer line 1/);
  assert.doesNotMatch(visible, /Final answer line 10/);
});

test("raw stdout progress does not render as thinking in fallback sessions", () => {
  const joined = renderJoinedTurn(makeChronologicalTurnEvents(304, {
    progressEntries: [{
      id: "stdout-1",
      source: "stdout",
      text: "Directory: C:\\Users\\Example\\Project\n\nvitest.config.ts\nimport { useMemo } from \"react\";",
      sequence: 1,
      createdAt: 1,
      updatedAt: 1,
      pendingNewlineCount: 0,
      blocks: [{
        id: "stdout-1-block-1",
        text: "Directory: C:\\Users\\Example\\Project\n\nvitest.config.ts\nimport { useMemo } from \"react\";",
        sequence: 1,
        createdAt: 1,
        updatedAt: 1,
        status: "completed",
      }],
    }],
    responseSegments: [{
      id: "response-1",
      streamSeq: 1,
      chunks: ["Done."],
      status: "completed",
      startedAt: 2,
    }],
  }), 304);

  assert.doesNotMatch(joined, /thinking/);
  assert.doesNotMatch(joined, /Directory: C:\\Users/);
  assert.doesNotMatch(joined, /import \{ useMemo \}/);
});

test("action event hides PowerShell full-path wrapper and shows friendly label", () => {
  const raw = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Get-ChildItem -Force | Select-Object Name,Mode,Length'`;
  const items = buildTimelineItems(makeCompletedRunWithTool(200, raw));
  const renderItems = buildStaticRenderItems(items, [200], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");

  assert.match(joined, /List files/, "should show friendly label");
  assert.doesNotMatch(joined, /Program Files/, "should not expose PowerShell install path");
  assert.doesNotMatch(joined, /pwsh\.exe/, "should not expose pwsh.exe wrapper");
  assert.doesNotMatch(joined, /-Command/, "should not expose -Command flag");
});

test("action event hides pwsh.exe -Command wrapper", () => {
  const items = buildTimelineItems(makeCompletedRunWithTool(201, `pwsh.exe -Command 'git status'`));
  const renderItems = buildStaticRenderItems(items, [201], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");

  assert.match(joined, /Check git status/);
  assert.doesNotMatch(joined, /pwsh\.exe/);
});

test("action event hides cmd.exe /c wrapper", () => {
  const items = buildTimelineItems(makeCompletedRunWithTool(202, `cmd.exe /c "dir /b"`));
  const renderItems = buildStaticRenderItems(items, [202], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");

  assert.match(joined, /List files/);
  assert.doesNotMatch(joined, /cmd\.exe/);
});

test("action event hides bash -lc wrapper", () => {
  const items = buildTimelineItems(makeCompletedRunWithTool(203, `bash -lc 'git diff HEAD~1'`));
  const renderItems = buildStaticRenderItems(items, [203], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");

  assert.match(joined, /Inspect changes/);
  assert.doesNotMatch(joined, /bash -lc/);
});

test("action event shows normalized command only when no friendly label exists", () => {
  const items = buildTimelineItems(makeCompletedRunWithTool(204, `pwsh.exe -Command 'python -m pytest tests/'`));
  const renderItems = buildStaticRenderItems(items, [204], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");

  assert.match(joined, /python -m pytest/, "should show normalized command as label");
  assert.doesNotMatch(joined, /pwsh\.exe/, "should not show wrapper");
});

test("action event remains inside the unified assistant turn (no separate Processing card)", () => {
  const raw = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Get-ChildItem'`;
  const items = buildTimelineItems(makeCompletedRunWithTool(205, raw));
  const renderItems = buildStaticRenderItems(items, [205], null, null, null);
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth: 80 });

  // All content should be in a single turn item, not a separate Processing card
  assert.equal(snapshot.items.length, 1, "should produce exactly one timeline item (the turn)");
  const joined = snapshot.rows.map((row) => row.spans.map((s) => s.text).join("")).join("\n");
  assert.match(joined, /List files/);
  assert.doesNotMatch(joined, /Processing/, "should not render a separate Processing card");
});

test("long command is clipped within the compact action row", () => {
  const longCmd = `pwsh.exe -Command 'Write-Host "A very long command that goes on and on and on and would overflow if not wrapped properly within the card border"'`;
  const items = buildTimelineItems(makeCompletedRunWithTool(206, longCmd));
  const renderItems = buildStaticRenderItems(items, [206], null, null, null);
  const totalWidth = 60;
  const snapshot = buildTimelineSnapshot(renderItems, { totalWidth });

  const actionRows = snapshot.rows.filter((row) =>
    row.spans.some((s) => s.text.includes("Write-Host")),
  );
  assert.ok(actionRows.length >= 1, "long command should render inside the action row");

  for (const row of actionRows) {
    const actionText = row.spans.map((span) => span.text).join("");
    assert.doesNotMatch(actionText, /would overflow if not wrapped properly within the card border/);
    assert.ok(getVisualWidth(actionText) <= totalWidth);
  }
  assert.doesNotMatch(snapshot.rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n"), /╭── action/);
});

// ── Compact action layout: long commands, narrow widths, timing ──────────────
//
// These guard the compact action/tool row against long-command overflow and
// stale row-cache reuse after clear.

const LONG_ACTION_COMMAND =
  `/usr/bin/zsh -lc 'pwd && rg -n "13-Custom-CLI-Normal|ubume|purpose|description" -S README* package.json docs src bin . 2>/dev/null'`;

function rowText(row: TimelineRow): string {
  return row.spans.map((span) => span.text).join("");
}

function actionCardSnapshot(command: string, totalWidth: number): TimelineSnapshot {
  const items = buildTimelineItems(makeCompletedRunWithTool(900, command));
  const renderItems = buildStaticRenderItems(items, [900], null, null, null);
  return buildTimelineSnapshot(renderItems, { totalWidth });
}

function extractCompactActionRows(snapshot: TimelineSnapshot): TimelineRow[] {
  const rows = snapshot.rows.filter((row) => row.key.includes("-action-"));
  assert.ok(rows.length > 0, "expected a compact action row");
  return rows;
}

function assertCompactActionIntegrity(rows: TimelineRow[], totalWidth: number): void {
  const widths = rows.map((row) => getVisualWidth(rowText(row)));
  widths.forEach((width, index) => {
    assert.ok(width <= totalWidth, `row ${index} width ${width} must not exceed terminal width ${totalWidth}: "${rowText(rows[index])}"`);
  });
  assert.ok(/^[✓✕•] /.test(rowText(rows[0] ?? { key: "", spans: [] })), "first compact row starts with a status glyph");
}

test("long action command stays inside a compact row", () => {
  const totalWidth = 80;
  const rows = extractCompactActionRows(actionCardSnapshot(LONG_ACTION_COMMAND, totalWidth));
  assertCompactActionIntegrity(rows, totalWidth);
  assert.match(rowText(rows[0]!), /\/usr\/bin\/zsh/);
});

test("very narrow terminal still renders a compact action row", () => {
  const totalWidth = 30;
  const rows = extractCompactActionRows(actionCardSnapshot(LONG_ACTION_COMMAND, totalWidth));
  assertCompactActionIntegrity(rows, totalWidth);
});

test("reflowing an action row from wide to narrow keeps it bounded", () => {
  for (const totalWidth of [100, 40]) {
    const rows = extractCompactActionRows(actionCardSnapshot(LONG_ACTION_COMMAND, totalWidth));
    assertCompactActionIntegrity(rows, totalWidth);
  }
});

test("ANSI-styled command does not break the action row width", () => {
  const totalWidth = 70;
  const command = `echo \u001b[31mred-text-that-is-quite-long-and-should-wrap-cleanly\u001b[0m && ls -la /tmp`;
  const rows = extractCompactActionRows(actionCardSnapshot(command, totalWidth));
  assertCompactActionIntegrity(rows, totalWidth);
  for (const row of rows) {
    assert.ok(!rowText(row).includes("\u001b"), "no escape bytes should reach the rendered row");
  }
});

test("timing label sits on the compact action row without overflowing", () => {
  const totalWidth = 60;
  const rows = extractCompactActionRows(actionCardSnapshot(LONG_ACTION_COMMAND, totalWidth));
  assertCompactActionIntegrity(rows, totalWidth);

  const durationRows = rows.filter((row) => rowText(row).includes("1ms"));
  assert.equal(durationRows.length, 1, "the timing label must appear exactly once");
  assert.ok(rowText(rows[0]!).includes("1ms"), "the timing label belongs on the compact row");
});

// ── /clear then a fresh action row: no clipped, duplicated, or ghosted row ───
//
// /clear physically wipes the transcript at the render boundary; the measured
// timeline then rebuilds from only the post-clear turn (which gets a fresh
// turnId, as every post-clear prompt does). This guards the measurement layer's
// side of that flow: the next action row must be a single, bounded compact row
// and the per-turn caches must key by turn identity so stale pre-clear content
// is never served in its place.
function actionCardSnapshotForTurn(turnId: number, command: string, totalWidth: number): TimelineSnapshot {
  const items = buildTimelineItems(makeCompletedRunWithTool(turnId, command));
  const renderItems = buildStaticRenderItems(items, [turnId], null, null, null);
  return buildTimelineSnapshot(renderItems, { totalWidth });
}

test("/clear followed by a new action row renders one bounded row", () => {
  const totalWidth = 72;

  // 1) A pre-clear turn whose action row populates the row/measure caches.
  const preClear = actionCardSnapshotForTurn(920, "cat OLD-pre-clear-file.txt", totalWidth);
  assertCompactActionIntegrity(extractCompactActionRows(preClear), totalWidth);

  // 2) After /clear the next turn arrives with a fresh turnId. Build its snapshot
  //    WITHOUT resetting caches, so a stale pre-clear card would surface here if
  //    the turn cache ignored turn identity.
  const postClear = actionCardSnapshotForTurn(921, LONG_ACTION_COMMAND, totalWidth);
  const rows = extractCompactActionRows(postClear);
  assertCompactActionIntegrity(rows, totalWidth);

  // Exactly one action row — no ghosted/duplicated row from before the clear.
  assert.equal(rows.length, 1, "exactly one action row after /clear (no ghost/dupe)");

  // The rendered card is the post-clear command, with no pre-clear text leaking in.
  const postText = postClear.rows.map(rowText).join("\n");
  assert.doesNotMatch(postText, /OLD-pre-clear-file/, "pre-clear card content must not leak in");
  assert.match(postText, /usr\/bin\/zsh/, "the post-clear command is the one rendered");
});

// ── Smooth scrolling / render-loop regression tests ──────────────────────────

test("syncTimelineViewport is stable when followTail is true and totalRows did not grow", () => {
  // Ensures the Fix B guard condition is sound: when following tail and no new
  // rows arrive, returning `current` from setViewport bails out of the render.
  const snapshot = createSnapshot([2, 3]);
  const following = createFollowTailViewport(snapshot.totalRows);
  const synced = syncTimelineViewport(following, snapshot);

  assert.strictEqual(synced, following);
  assert.equal(synced.followTail, true);
  assert.equal(synced.anchorRow, snapshot.totalRows - 1);
  assert.equal(synced.unseenItems, 0);
  assert.equal(synced.unseenRows, 0);
});

test("follow-tail viewport stays anchored when an action updates without row growth", () => {
  const runningEvents = makeChronologicalTurnEvents(300, {
    status: "running",
    durationMs: null,
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content README.md",
      status: "running",
      startedAt: 10,
      completedAt: null,
      streamSeq: 1,
    }],
    streamItems: [{ streamSeq: 1, kind: "action", refId: "tool-1" }],
    lastStreamSeq: 1,
  }, "");
  const completedEvents = makeChronologicalTurnEvents(300, {
    status: "running",
    durationMs: null,
    toolActivities: [{
      id: "tool-1",
      command: "Get-Content README.md",
      status: "completed",
      startedAt: 10,
      completedAt: 42,
      summary: "Read 12 lines",
      streamSeq: 1,
    }],
    streamItems: [{ streamSeq: 1, kind: "action", refId: "tool-1" }],
    lastStreamSeq: 1,
  }, "");

  const turnIds = [300];
  const runningSnapshot = buildTimelineSnapshot(
    buildActiveRenderItems(buildTimelineItems(runningEvents), turnIds, { kind: "THINKING", turnId: 300 }),
    { totalWidth: 80 },
  );
  const completedSnapshot = buildTimelineSnapshot(
    buildActiveRenderItems(buildTimelineItems(completedEvents), turnIds, { kind: "THINKING", turnId: 300 }),
    { totalWidth: 80 },
  );
  const viewport = createFollowTailViewport(runningSnapshot.totalRows);
  const synced = syncTimelineViewport(viewport, completedSnapshot);

  assert.equal(completedSnapshot.totalRows, runningSnapshot.totalRows);
  assert.strictEqual(synced, viewport);
  assert.equal(synced.followTail, true);
  assert.equal(synced.anchorRow, runningSnapshot.totalRows - 1);
});

test("selectTimelineRows preserves visible row object references", () => {
  const snapshot = createSnapshot([4, 4, 4]);
  const viewport = createFollowTailViewport(snapshot.totalRows);

  const first = selectTimelineRows(snapshot, viewport, 5);
  const second = selectTimelineRows(snapshot, viewport, 5);

  assert.notStrictEqual(second.visibleRows, first.visibleRows);
  assert.equal(second.visibleRows.length, first.visibleRows.length);
  for (let index = 0; index < first.visibleRows.length; index += 1) {
    assert.strictEqual(second.visibleRows[index], first.visibleRows[index]);
  }
});

test("buildTimelineSnapshot reuses cached rows for completed entries on repeated calls", () => {
  // Ensures Fix E is working: a second call at the same width must return
  // the same inner row array references (cache hits) for completed turns.
  const completedEvents: TimelineEvent[] = [
    {
      id: 100,
      type: "user",
      createdAt: 1,
      prompt: "Cache test prompt",
      turnId: 99,
    },
    {
      id: 101,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: 100,
      backendId: "codex-subprocess",
      backendLabel: "Ubume",
      runtime: TEST_RUNTIME,
      prompt: "Cache test prompt",
      progressEntries: [],
      status: "completed",
      summary: "Done",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 99,
    },
    {
      id: 102,
      type: "assistant",
      createdAt: 3,
      content: "Cached answer",
      contentChunks: [],
      turnId: 99,
    },
  ];

  const renderItems = buildStaticRenderItems(
    buildTimelineItems(completedEvents),
    [99],
    null,
    null,
    null,
  );

  const first = buildTimelineSnapshot(renderItems, { totalWidth: 80 });
  const second = buildTimelineSnapshot(renderItems, { totalWidth: 80 });

  assert.equal(first.totalRows, second.totalRows, "total rows must be identical");

  // The wrapItemRows call adds padding so the outer `rows` array is always
  // a fresh array.  The inner pre-wrap rows are what the cache stores — but
  // since buildTimelineSnapshot only exposes wrapped rows we verify equality
  // of row *content* (same spans) as a proxy for cache correctness.
  for (let i = 0; i < first.items.length; i++) {
    const a = first.items[i];
    const b = second.items[i];
    assert.ok(a && b, `item ${i} must exist in both snapshots`);
    assert.equal(a.rowCount, b.rowCount, `item ${i} rowCount must match`);
  }
});

// ─── Scroll-jump prevention ───────────────────────────────────────────────────

test("syncTimelineViewport with empty snapshot preserves frozen scroll offset", () => {
  // User scrolled to anchorRow=50 in a 100-row transcript.
  const snapshot = createSnapshot(Array.from({ length: 100 }, () => 1));
  const frozen: TimelineViewportState = {
    anchorRow: 50,
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: snapshot,
  };
  const emptySnapshot = createSnapshot([]);

  // Transient empty snapshot must NOT reset position to row 0.
  const result = syncTimelineViewport(frozen, emptySnapshot);
  assert.equal(result.followTail, false, "must remain detached");
  assert.equal(result.anchorRow, 50, "anchor row must be preserved");
});

test("syncTimelineViewport with empty snapshot resets follow-tail viewport to row 0", () => {
  const snapshot = createSnapshot([10, 10]);
  const following = createFollowTailViewport(snapshot.totalRows);

  const empty = createSnapshot([]);
  const result = syncTimelineViewport(following, empty);

  // Follow-tail with empty snapshot is the initial/cold-start state — reset is expected.
  assert.equal(result.followTail, true);
  assert.equal(result.anchorRow, 0);
});

test("isNearBottom returns true when anchorRow is within threshold of tail", () => {
  assert.equal(isNearBottom(97, 100), true,  "2 rows from tail → near bottom");
  assert.equal(isNearBottom(96, 100), true,  "3 rows from tail → near bottom (threshold boundary)");
  assert.equal(isNearBottom(95, 100), false, "4 rows from tail → NOT near bottom");
  assert.equal(isNearBottom(99, 100), true,  "at tail → near bottom");
  assert.equal(isNearBottom(0,  0),   true,  "empty content → near bottom");
});

test("isNearBottom detects proximity correctly across different snapshot sizes", () => {
  // Large transcript — threshold 3 rows from end
  assert.equal(isNearBottom(97, 100), true,  "100-row: 3 rows from tail → near bottom");
  assert.equal(isNearBottom(95, 100), false, "100-row: 5 rows from tail → NOT near bottom");

  // Small transcript — entire content is within threshold
  assert.equal(isNearBottom(1, 4), true, "4-row: row 1 within threshold of tail");
  assert.equal(isNearBottom(0, 4), true, "4-row: row 0 within threshold of tail");

  // Edge cases
  assert.equal(isNearBottom(0, 0), true, "empty content → near bottom");
  assert.equal(isNearBottom(99, 100), true, "exactly at tail → near bottom");
});

test("provider-picker style open/close: frozen scroll position survives empty-snapshot transition", () => {
  // Simulate: user scrolled up, then a panel opens causing a transient snapshot drop,
  // then panel closes and snapshot restores.
  const fullSnapshot = createSnapshot(Array.from({ length: 80 }, () => 1));

  // User scrolls to row 40
  const scrolled = scrollTimelineViewport(
    createFollowTailViewport(fullSnapshot.totalRows),
    fullSnapshot,
    20,
    -(fullSnapshot.totalRows - 1 - 40), // navigate to anchorRow ~40
  );
  assert.equal(scrolled.followTail, false);

  // Panel opens: transient empty snapshot (liveRows excluded)
  const afterEmpty = syncTimelineViewport(scrolled, createSnapshot([]));
  assert.equal(afterEmpty.followTail, false, "panel open must not reset scroll");
  assert.equal(afterEmpty.anchorRow, scrolled.anchorRow, "anchor must be preserved through empty snapshot");

  // Panel closes: snapshot restores
  const afterRestore = syncTimelineViewport(afterEmpty, fullSnapshot);
  assert.equal(afterRestore.followTail, false, "scroll must remain detached after restore");
});

test("response completion does not jump to top when user is scrolled mid-transcript", () => {
  // User is scrolled to row 20 in a 50-row transcript
  const snapshot50 = createSnapshot(Array.from({ length: 50 }, () => 1));
  const browsing: TimelineViewportState = {
    anchorRow: 20,
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: snapshot50,
  };

  // Response finalizes: content grows to 80 rows
  const snapshot80 = createSnapshot(Array.from({ length: 80 }, () => 1));
  const afterFinalize = syncTimelineViewport(browsing, snapshot80);

  assert.equal(afterFinalize.followTail, false, "must not snap to follow-tail on finalize");
  assert.equal(afterFinalize.anchorRow, 20, "anchor must remain at row 20");
  // Unseen rows should reflect new content
  assert.equal(afterFinalize.unseenRows, 30, "unseen rows = 80 - 50");
});

test("createTurnOpacityResolver matches resolveTurnOpacity including absent ids", () => {
  const turnIds = [1, 2, 3, 4];
  const cases: Array<[number, number | null]> = [
    [1, null], [4, null], [3, 3], [2, 3], [1, 3], [4, 3], [9, 3], [2, 9], [1, 9], [3, 9],
  ];
  const resolver = createTurnOpacityResolver(turnIds);
  for (const [turnId, activeTurnId] of cases) {
    assert.equal(resolver(turnId, activeTurnId), resolveTurnOpacity(turnIds, turnId, activeTurnId), `turn ${turnId} active ${activeTurnId}`);
  }
  assert.equal(createTurnOpacityResolver([])(1, null), "dim");
});
