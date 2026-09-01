import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createClearFrameBoundaryController } from "./clearFrameBoundary.js";
import type { InkRenderInstance } from "./inkRenderReset.js";
import { configureRenderDebug } from "../perf/renderDebug.js";

function createHarness(overrides: {
  onWidthResizeRefresh?: () => void;
  isOverlayActive?: () => boolean;
  getRenderedRepaintGeneration?: () => number;
  getRenderedLayoutCols?: () => number | undefined;
} = {}) {
  const events: string[] = [];
  const stdout = { columns: 120, rows: 40 };
  const calls = { logReset: 0, logSync: 0, throttledOnRenderCancel: 0, throttledLogCancel: 0 };

  const instance: InkRenderInstance = {
    lastOutput: "old-frame",
    lastOutputToRender: "old-frame\n",
    lastOutputHeight: 10,
    fullStaticOutput: "",
    log: {
      reset() {
        calls.logReset += 1;
        events.push("log.reset");
      },
      sync(output: string) {
        calls.logSync += 1;
        events.push(`log.sync:${output}`);
      },
    } as { reset?: () => void },
    throttledOnRender: {
      cancel() {
        calls.throttledOnRenderCancel += 1;
        events.push("throttledOnRender.cancel");
      },
    },
    throttledLog: {
      cancel() {
        calls.throttledLogCancel += 1;
        events.push("throttledLog.cancel");
      },
    },
    renderInteractiveFrame(output: string, outputHeight: number, staticOutput: string) {
      events.push(`write:${output}:${outputHeight}:${staticOutput.length}`);
      this.lastOutput = output;
      this.lastOutputToRender = `${output}\n`;
      this.lastOutputHeight = outputHeight;
    },
  };

  const terminalControl = {
    clearTranscript(source: string) {
      events.push(`clear:${source}`);
    },
    clearViewport(source: string) {
      events.push(`clearViewport:${source}`);
    },
    setAlternateScreen(enabled: boolean, source: string) {
      events.push(`altScreen:${enabled ? "on" : "off"}:${source}`);
    },
  };

  const controller = createClearFrameBoundaryController({
    instance,
    terminalControl,
    stdout,
    source: "test:clearBoundary",
    ...overrides,
  });

  assert.ok(controller, "controller should be created");

  return {
    instance,
    stdout,
    calls,
    events,
    controller,
  };
}

test("suppresses stale pre-clear frames while clear is pending and commits one authoritative post-clear frame", () => {
  const harness = createHarness();
  const { controller, instance, calls, events } = harness;

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 2,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  assert.equal(controller.beginClearGeneration(1), true);

  instance.renderInteractiveFrame?.("old-frame", 10, "");
  assert.equal(events.length, 0, "stale pre-clear frame should be dropped without writes");
  assert.equal(controller.getState().clearPending, true);

  controller.syncRenderState({
    generation: 1,
    staticEventsLength: 0,
    activeEventsLength: 0,
    transcriptCleared: true,
    uiStateKind: "IDLE",
  });
  instance.renderInteractiveFrame?.("fresh-post-clear", 6, "");

  assert.equal(events[0]?.startsWith("clear:test:clearBoundary:firstPostClearFrame"), true);
  assert.equal(events.includes("throttledOnRender.cancel"), true);
  assert.equal(events.includes("throttledLog.cancel"), true);
  assert.equal(events.includes("log.reset"), true);
  assert.equal(events.some((entry) => entry.startsWith("write:fresh-post-clear")), true);
  assert.equal(calls.logReset, 1);
  assert.equal(calls.throttledOnRenderCancel, 1);
  assert.equal(calls.throttledLogCancel, 1);
  assert.equal(controller.getState().clearPending, false);
  assert.equal(controller.getState().committedGeneration, 1);
});

test("drops stale frames by snapshot hash even after app generation has advanced", () => {
  const harness = createHarness();
  const { controller, instance, events } = harness;

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 1,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  assert.equal(controller.beginClearGeneration(1), true);
  controller.syncRenderState({
    generation: 1,
    staticEventsLength: 1,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });

  instance.renderInteractiveFrame?.("old-frame", 10, "");
  assert.equal(events.length, 0, "stale pre-clear frame should still be suppressed until transcript clears");

  controller.syncRenderState({
    generation: 1,
    staticEventsLength: 0,
    activeEventsLength: 0,
    transcriptCleared: true,
    uiStateKind: "IDLE",
  });
  instance.renderInteractiveFrame?.("new-frame", 5, "");
  assert.equal(events.some((entry) => entry.startsWith("clear:")), true);
  assert.equal(events.some((entry) => entry.startsWith("write:new-frame")), true);
});

test("marks only the first committed post-clear frame as authoritative", () => {
  const harness = createHarness();
  const { controller, instance } = harness;

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 2,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  controller.beginClearGeneration(1);
  controller.syncRenderState({
    generation: 1,
    staticEventsLength: 0,
    activeEventsLength: 0,
    transcriptCleared: true,
    uiStateKind: "IDLE",
  });

  instance.renderInteractiveFrame?.("first-post-clear", 4, "");
  assert.equal(controller.getState().lastFrameWasAuthoritative, true);

  instance.renderInteractiveFrame?.("later-frame", 4, "");
  assert.equal(controller.getState().lastFrameWasAuthoritative, false);
});

test("syncRenderState signals a post-clear repaint until the authoritative frame commits", () => {
  const harness = createHarness();
  const { controller, instance, events } = harness;

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 2,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  controller.beginClearGeneration(1);

  // The cleared render state hasn't been synced yet: the frame must stay
  // suppressed and no repaint should be requested.
  const beforeCleared = controller.syncRenderState({
    generation: 0,
    staticEventsLength: 2,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  assert.equal(beforeCleared, false, "no repaint requested before the transcript clears");

  // Mirrors the post-CLEAR_TRANSCRIPT passive effect: generation advanced and
  // events empty. Ink already wrote/suppressed the cleared frame during the
  // commit, so the boundary must now ask the host to force one more render.
  const afterCleared = controller.syncRenderState({
    generation: 1,
    staticEventsLength: 0,
    activeEventsLength: 0,
    transcriptCleared: true,
    uiStateKind: "IDLE",
  });
  assert.equal(afterCleared, true, "host must be told to force a repaint once the cleared frame is ready");

  // The forced repaint runs renderInteractiveFrame again, which now commits the
  // authoritative frame instead of leaving it stuck behind the stale gate.
  instance.renderInteractiveFrame?.("fresh-post-clear", 6, "");
  assert.equal(controller.getState().clearPending, false, "post-clear frame committed");
  assert.equal(events.some((entry) => entry.startsWith("write:fresh-post-clear")), true, "authoritative frame is written");

  // Once committed, no further repaint should be requested (no render loop).
  const afterCommit = controller.syncRenderState({
    generation: 1,
    staticEventsLength: 0,
    activeEventsLength: 0,
    transcriptCleared: true,
    uiStateKind: "IDLE",
  });
  assert.equal(afterCommit, false, "no repeated repaint once the post-clear frame is committed");
});

test("seeded post-clear launch frame is ready even when static events are not empty", () => {
  const harness = createHarness();
  const { controller, instance, events } = harness;

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 4,
    activeEventsLength: 2,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  controller.beginClearGeneration(1);

  const repaintRequested = controller.syncRenderState({
    generation: 1,
    staticEventsLength: 1,
    activeEventsLength: 0,
    transcriptCleared: false,
    clearGenerationReady: true,
    uiStateKind: "IDLE",
  });

  assert.equal(repaintRequested, true, "seeded launch frame should be eligible for the authoritative post-clear repaint");

  instance.renderInteractiveFrame?.("██████\nLaunch mode\n│ ❯", 8, "");

  assert.equal(events[0]?.startsWith("clear:test:clearBoundary:firstPostClearFrame"), true);
  assert.equal(events.some((entry) => entry.startsWith("write:██████\nLaunch mode\n│ ❯")), true);
  assert.equal(controller.getState().clearPending, false);
  assert.equal(controller.getState().committedGeneration, 1);
});

test("replays suppressed static intro rows into the first authoritative post-clear frame", () => {
  const harness = createHarness();
  const { controller, instance, events } = harness;
  const staticIntro = "██╔════╝██╔═══██╗\nCodexa v1.0.4-dev local\nProvider: Local\n";

  controller.syncRenderState({
    generation: 0,
    staticEventsLength: 3,
    activeEventsLength: 1,
    transcriptCleared: false,
    uiStateKind: "RESPONDING",
  });
  controller.beginClearGeneration(1);

  instance.renderInteractiveFrame?.("│ ❯ Ask Codexa\nContext: 0 / ~200K", 4, staticIntro);
  assert.equal(events.length, 0, "first post-clear commit is still behind the stale gate");

  const repaintRequested = controller.syncRenderState({
    generation: 1,
    staticEventsLength: 2,
    activeEventsLength: 0,
    transcriptCleared: false,
    clearGenerationReady: true,
    uiStateKind: "IDLE",
  });
  assert.equal(repaintRequested, true);

  instance.renderInteractiveFrame?.("│ ❯ Ask Codexa\nContext: 0 / ~200K", 4, "");

  assert.equal(events[0]?.startsWith("clear:test:clearBoundary:firstPostClearFrame"), true);
  assert.ok(
    events.some((entry) => entry === `write:│ ❯ Ask Codexa\nContext: 0 / ~200K:4:${staticIntro.length}`),
    "authoritative frame should replay the static intro that Ink consumed during the suppressed frame",
  );
  assert.equal(controller.getState().clearPending, false);
});

test("defers the width repaint until the re-flushed static frame arrives, then commits it atomically", () => {
  // A width change reflows the frame already on screen, but the commit that
  // first observes the new width was still built from pre-resize React state,
  // and <Static> never re-emits flushed content on its own. The boundary must
  // therefore suppress that stale frame, ask the host for a fresh <Static>
  // (onWidthResizeRefresh), and only then clear scrollback and write the
  // rebuilt frame — clear and content land atomically, so no intermediate
  // "composer-only" frame is ever visible or stranded in scrollback.
  let renderedGeneration = 0;
  let resizeRefreshCount = 0;
  const harness = createHarness({
    onWidthResizeRefresh: () => {
      resizeRefreshCount += 1;
      renderedGeneration += 1;
    },
    getRenderedRepaintGeneration: () => renderedGeneration,
  });
  const { controller, instance, stdout, calls, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;
  const resetBeforeResize = calls.logReset;

  stdout.columns = 180;
  stdout.rows = 50;
  instance.renderInteractiveFrame?.("stale-width-frame", 4, "");
  assert.equal(resizeRefreshCount, 1, "width change should request the <Static> re-flush");
  assert.equal(controller.getState().widthRepaintPending, true);
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "the stale-state frame must be suppressed, not written");
  assert.equal(events.some((entry) => entry.startsWith("clear:")), false, "no physical clear before the rebuilt frame exists");

  instance.renderInteractiveFrame?.("rebuilt-frame", 6, "██ re-flushed static\n");
  const clearIndex = events.findIndex((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh"));
  const writeIndex = events.findIndex((entry) => entry.startsWith("write:rebuilt-frame"));
  assert.ok(clearIndex >= 0, "the repaint must use the scrollback-inclusive transcript clear");
  assert.ok(writeIndex > clearIndex, "clear must immediately precede the rebuilt frame write");
  assert.equal(
    events.some((entry) => entry === `write:rebuilt-frame:6:${"██ re-flushed static\n".length}`),
    true,
    "the rebuilt frame must carry the full re-flushed static content",
  );
  assert.equal(controller.getState().widthRepaintPending, false);
  assert.equal(controller.getState().lastFrameWasAuthoritative, true);
  assert.equal(calls.logReset, resetBeforeResize + 1, "the repaint resets Ink's caches exactly once");
});

test("a width shrink (maximize→restore) also repaints atomically instead of stranding the wider frame", () => {
  // Restoring a maximized window shrinks the width; without the repaint the
  // old wider frame stays burned into the screen and the smaller live region
  // redraw leaves duplicated composer boxes behind.
  let renderedGeneration = 0;
  const harness = createHarness({
    onWidthResizeRefresh: () => {
      renderedGeneration += 1;
    },
    getRenderedRepaintGeneration: () => renderedGeneration,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;

  stdout.columns = 80;
  stdout.rows = 24;
  instance.renderInteractiveFrame?.("stale-wide-frame", 4, "");
  assert.equal(controller.getState().widthRepaintPending, true, "a shrink must arm the width repaint");
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "the stale wide frame must be suppressed");

  instance.renderInteractiveFrame?.("narrow-frame", 5, "narrow static\n");
  const clearIndex = events.findIndex((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh"));
  const writeIndex = events.findIndex((entry) => entry.startsWith("write:narrow-frame"));
  assert.ok(clearIndex >= 0, "the shrink repaint must use the scrollback-inclusive transcript clear");
  assert.ok(writeIndex > clearIndex, "clear must immediately precede the narrow frame write");
  assert.equal(controller.getState().widthRepaintPending, false);
});

test("waits for the committed layout to match the new width before requesting the <Static> re-flush", () => {
  // The viewport hook commits new dimensions on a trailing settle (~100ms), so
  // frames observing the new stdout.columns can still be laid out at the old
  // width. Remounting <Static> against that stale layout would re-flush the
  // logo/transcript at the wrong width — exactly the stale-variant home screen
  // the VTE startup settle used to produce.
  let renderedLayoutCols = 120;
  let renderedGeneration = 0;
  let resizeRefreshCount = 0;
  const harness = createHarness({
    onWidthResizeRefresh: () => {
      resizeRefreshCount += 1;
      renderedGeneration += 1;
    },
    getRenderedRepaintGeneration: () => renderedGeneration,
    getRenderedLayoutCols: () => renderedLayoutCols,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;

  // stdout reports the new width but the committed layout is still 120-col.
  stdout.columns = 180;
  instance.renderInteractiveFrame?.("stale-layout-frame", 4, "");
  instance.renderInteractiveFrame?.("still-stale-layout-frame", 4, "");
  assert.equal(resizeRefreshCount, 0, "no <Static> remount while the committed layout lags the terminal width");
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "stale-layout frames stay suppressed");

  // The viewport settle lands: the committed layout now matches the terminal.
  renderedLayoutCols = 180;
  instance.renderInteractiveFrame?.("settled-layout-frame", 4, "");
  assert.equal(resizeRefreshCount, 1, "the re-flush is requested from the first width-correct commit");
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "the pre-remount frame is still suppressed");

  instance.renderInteractiveFrame?.("rebuilt-frame", 6, "width-correct static\n");
  assert.equal(
    events.some((entry) => entry === `write:rebuilt-frame:6:${"width-correct static\n".length}`),
    true,
    "the repaint commits with static rebuilt at the settled width",
  );
  assert.equal(controller.getState().widthRepaintPending, false);
});

test("does not mistake a pre-resize static chunk for the rebuilt frame", () => {
  // Incremental static chunks (e.g. a system event flushed by the old <Static>
  // instance) can land between the resize and the re-flush commit. Committing
  // one of those after the clear would wipe scrollback and leave only that
  // chunk on screen.
  let renderedGeneration = 0;
  const harness = createHarness({
    getRenderedRepaintGeneration: () => renderedGeneration,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;

  stdout.columns = 180;
  instance.renderInteractiveFrame?.("stale-width-frame", 4, "");
  instance.renderInteractiveFrame?.("chunk-frame", 4, "incremental chunk\n");
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "pre-re-flush static chunks must stay suppressed");
  assert.equal(controller.getState().widthRepaintPending, true);

  renderedGeneration = 1;
  instance.renderInteractiveFrame?.("rebuilt-frame", 6, "full re-flush\n");
  assert.equal(
    events.some((entry) => entry === `write:rebuilt-frame:6:${"full re-flush\n".length}`),
    true,
    "only the post-bump re-flush frame commits the repaint",
  );
  assert.equal(controller.getState().widthRepaintPending, false);
});

test("repaints on every width change, and a settled width never re-arms", () => {
  let renderedGeneration = 0;
  let resizeRefreshCount = 0;
  const harness = createHarness({
    onWidthResizeRefresh: () => {
      resizeRefreshCount += 1;
      renderedGeneration += 1;
    },
    getRenderedRepaintGeneration: () => renderedGeneration,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");

  stdout.columns = 180;
  instance.renderInteractiveFrame?.("stale-one", 4, "");
  instance.renderInteractiveFrame?.("rebuilt-one", 6, "static one\n");

  // Another commit at the settled width: no new repaint.
  instance.renderInteractiveFrame?.("steady-frame", 6, "");
  assert.equal(resizeRefreshCount, 1, "a commit at the settled width must not re-arm the repaint");
  assert.equal(controller.getState().lastFrameWasAuthoritative, false, "steady frames are diffed, not authoritative");

  // A second, later width change repaints again.
  stdout.columns = 101;
  instance.renderInteractiveFrame?.("stale-two", 6, "");
  instance.renderInteractiveFrame?.("rebuilt-two", 7, "static two\n");
  assert.equal(resizeRefreshCount, 2);
  assert.equal(
    events.filter((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh")).length,
    2,
    "each width change should emit its own transcript clear",
  );
});

test("does not repaint on a height-only resize (no width change)", () => {
  let resizeRefreshCount = 0;
  const harness = createHarness({ onWidthResizeRefresh: () => { resizeRefreshCount += 1; } });
  const { controller, instance, stdout, calls, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  const resetAfterFirstFrame = calls.logReset;

  // Only the row count changes — no reflow risk, so no authoritative repaint.
  stdout.rows = 60;
  instance.renderInteractiveFrame?.("taller-frame", 5, "");
  assert.equal(resizeRefreshCount, 0, "height-only resize should not trigger the re-flush callback");
  assert.equal(controller.getState().lastFrameWasAuthoritative, false);
  assert.equal(calls.logReset, resetAfterFirstFrame, "height-only resize should not force a reset");
  assert.equal(
    events.some((entry) => entry.startsWith("write:taller-frame")),
    true,
    "height-only resize frames are written normally",
  );
  assert.equal(
    events.filter((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh")).length,
    0,
    "height-only resize should not emit a resize repaint clear",
  );
});

test("width repaint safety valve commits after the suppression cap instead of freezing", () => {
  // If the re-flushed frame never arrives (render stall, hidden transcript),
  // the gate must open rather than suppress frames forever.
  const harness = createHarness({
    getRenderedRepaintGeneration: () => 0,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  instance.fullStaticOutput = "accumulated static\n";
  events.length = 0;

  stdout.columns = 180;
  for (let index = 0; index < 9; index += 1) {
    instance.renderInteractiveFrame?.(`stalled-frame-${index}`, 4, "");
  }

  assert.equal(controller.getState().widthRepaintPending, false, "the safety valve must resolve the pending repaint");
  const fallbackClear = events.findIndex((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefreshFallback"));
  assert.ok(fallbackClear >= 0, "the fallback still clears before repainting");
  assert.equal(
    events.some((entry) => entry === `write:stalled-frame-8:4:${"accumulated static\n".length}`),
    true,
    "the fallback repaints with the static content Ink accumulated",
  );
});

test("enters the alternate screen atomically before the first overlay frame write", () => {
  let overlayActive = false;
  const harness = createHarness({ isOverlayActive: () => overlayActive });
  const { controller, instance, events } = harness;

  instance.renderInteractiveFrame?.("main-frame", 4, "");
  events.length = 0;

  overlayActive = true;
  instance.renderInteractiveFrame?.("overlay-frame", 40, "");

  const altOnIndex = events.findIndex((entry) => entry.startsWith("altScreen:on"));
  const viewportClearIndex = events.findIndex((entry) => entry.startsWith("clearViewport:test:clearBoundary:overlayEnter"));
  const writeIndex = events.findIndex((entry) => entry.startsWith("write:overlay-frame"));
  assert.ok(altOnIndex >= 0, "the overlay transition must enter the alternate screen");
  assert.ok(viewportClearIndex > altOnIndex, "the alternate buffer is homed before the frame");
  assert.ok(writeIndex > viewportClearIndex, "the overlay frame must be written after the buffer switch, never into the normal buffer");
  assert.equal(events.includes("log.reset"), true, "Ink caches reset so the first overlay frame is written in full");
  assert.equal(controller.getState().overlayActive, true);
});

test("holds transcript static flushed during an overlay and replays it into the normal buffer on exit", () => {
  let overlayActive = false;
  const harness = createHarness({ isOverlayActive: () => overlayActive });
  const { controller, instance, events } = harness;

  instance.renderInteractiveFrame?.("main-frame", 4, "");
  const savedLastOutputToRender = instance.lastOutputToRender;

  overlayActive = true;
  // Ink's onRender appends the static chunk to fullStaticOutput before calling
  // renderInteractiveFrame — mirror that for fidelity.
  instance.fullStaticOutput = `${instance.fullStaticOutput ?? ""}chunk-a\n`;
  instance.renderInteractiveFrame?.("overlay-frame", 40, "chunk-a\n");

  instance.fullStaticOutput = `${instance.fullStaticOutput ?? ""}chunk-b\n`;
  instance.renderInteractiveFrame?.("overlay-frame-2", 40, "chunk-b\n");
  assert.equal(
    events.some((entry) => entry.includes(":overlay-frame") && !entry.endsWith(":0")),
    false,
    "no static content may be written into the alternate buffer",
  );

  events.length = 0;
  overlayActive = false;
  instance.fullStaticOutput = `${instance.fullStaticOutput ?? ""}chunk-c\n`;
  instance.renderInteractiveFrame?.("main-frame-2", 5, "chunk-c\n");

  const altOffIndex = events.findIndex((entry) => entry.startsWith("altScreen:off"));
  const syncIndex = events.findIndex((entry) => entry.startsWith("log.sync:"));
  const writeIndex = events.findIndex((entry) => entry.startsWith("write:main-frame-2"));
  assert.ok(altOffIndex >= 0, "exit must leave the alternate screen");
  assert.ok(syncIndex > altOffIndex, "the normal buffer's log state is restored after the buffer switch");
  assert.equal(events[syncIndex], `log.sync:${savedLastOutputToRender}`, "log state must be restored to the saved normal-buffer frame");
  const expectedStatic = "chunk-a\nchunk-b\nchunk-c\n";
  assert.ok(writeIndex > syncIndex, "the exit frame is written after the caches are restored");
  assert.equal(
    events[writeIndex],
    `write:main-frame-2:5:${expectedStatic.length}`,
    "all static held during the overlay must replay above the exit frame",
  );
  assert.equal(controller.getState().overlayActive, false);
});

test("a width change while an overlay is open repaints the alt buffer, then re-arms the transcript repaint on exit", () => {
  let overlayActive = false;
  let renderedGeneration = 0;
  let resizeRefreshCount = 0;
  const harness = createHarness({
    isOverlayActive: () => overlayActive,
    onWidthResizeRefresh: () => {
      resizeRefreshCount += 1;
      renderedGeneration += 1;
    },
    getRenderedRepaintGeneration: () => renderedGeneration,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("main-frame", 4, "");
  overlayActive = true;
  instance.renderInteractiveFrame?.("overlay-frame", 40, "");
  events.length = 0;

  // Resize while the overlay is open: the alternate buffer has no scrollback,
  // so a viewport clear plus a full rewrite is a complete repaint.
  stdout.columns = 180;
  instance.renderInteractiveFrame?.("overlay-frame-wide", 40, "");
  const overlayResizeClear = events.findIndex((entry) => entry.startsWith("clearViewport:test:clearBoundary:overlayResize"));
  const overlayResizeWrite = events.findIndex((entry) => entry.startsWith("write:overlay-frame-wide"));
  assert.ok(overlayResizeClear >= 0, "overlay resize should clear the alternate viewport");
  assert.ok(overlayResizeWrite > overlayResizeClear);

  // On exit the restored normal buffer reflowed under the new width; it must go
  // through the deferred transcript repaint rather than a diffed write.
  events.length = 0;
  overlayActive = false;
  instance.renderInteractiveFrame?.("main-frame-exit", 5, "");
  assert.equal(controller.getState().widthRepaintPending, true);
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "the stale restored frame must not be written");

  instance.renderInteractiveFrame?.("main-frame-stale", 5, "");
  assert.equal(resizeRefreshCount, 1, "the repaint must request the <Static> re-flush once the layout is ready");
  assert.equal(events.some((entry) => entry.startsWith("write:")), false, "pre-re-flush frames stay suppressed");

  instance.renderInteractiveFrame?.("main-frame-rebuilt", 6, "re-flushed transcript\n");
  assert.equal(
    events.some((entry) => entry === `write:main-frame-rebuilt:6:${"re-flushed transcript\n".length}`),
    true,
    "the rebuilt transcript frame commits the repaint after the overlay exit",
  );
  assert.equal(controller.getState().widthRepaintPending, false);
});

test("logs clear generation, stale suppression, and first committed post-clear frame fields for terminal tracing", () => {
  const logPath = join(tmpdir(), `codexa-clear-boundary-${process.pid}-${Date.now()}.jsonl`);
  rmSync(logPath, { force: true });

  try {
    configureRenderDebug({
      CODEXA_TERMINAL_TRACE: "1",
      CODEXA_RENDER_DEBUG_FILE: logPath,
    });

    const harness = createHarness();
    const { controller, instance } = harness;

    controller.syncRenderState({
      generation: 0,
      staticEventsLength: 2,
      activeEventsLength: 1,
      transcriptCleared: false,
      uiStateKind: "RESPONDING",
    });
    controller.beginClearGeneration(1);
    instance.renderInteractiveFrame?.("old-frame", 10, "");
    controller.syncRenderState({
      generation: 1,
      staticEventsLength: 0,
      activeEventsLength: 0,
      transcriptCleared: true,
      uiStateKind: "IDLE",
    });
    instance.renderInteractiveFrame?.("post-clear-frame", 6, "");
    harness.stdout.columns = 160;
    harness.stdout.rows = 52;
    instance.renderInteractiveFrame?.("post-clear-resize-frame", 7, "");
    instance.renderInteractiveFrame?.("post-clear-resize-reflush", 7, "re-flushed static\n");

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
    const frameRecords = records.filter((entry) => entry.kind === "terminal" && entry.event === "clearBoundaryFrame");
    const firstCommit = records.find((entry) => entry.kind === "terminal" && entry.event === "firstCommittedPostClearFrame");
    const repaintArmed = records.find((entry) => entry.kind === "terminal" && entry.event === "widthRepaintArmed");
    const resizeCommit = records.find((entry) => entry.kind === "terminal" && entry.event === "resizeRefreshCommitted");
    assert.ok(frameRecords.some((entry) => entry.staleFrameSuppressed === true), "stale pre-clear suppression should be traced");
    assert.ok(frameRecords.some((entry) => entry.frameClassification === "post-clear"), "post-clear frame classification should be traced");
    assert.ok(repaintArmed, "width-change repaint arming should be traced");
    assert.ok(resizeCommit, "resize refresh commit should be traced");
    assert.ok(firstCommit, "first committed post-clear frame should be traced");
    assert.equal(typeof firstCommit.frameHash, "string");
    assert.equal(firstCommit.firstFrameAuthoritative, true);
  } finally {
    configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("terminal trace marker counts include Ink static output from the startup frame", () => {
  const logPath = join(tmpdir(), `codexa-clear-boundary-markers-${process.pid}-${Date.now()}.jsonl`);
  rmSync(logPath, { force: true });

  try {
    configureRenderDebug({
      CODEXA_TERMINAL_TRACE: "1",
      CODEXA_RENDER_DEBUG_FILE: logPath,
    });

    const harness = createHarness();
    const { instance } = harness;

    instance.renderInteractiveFrame?.(
      [
        "│ ❯",
        "Local / qwen/qwen3.6-35b-a3b (High)",
        "Context: 115 / 262K",
      ].join("\n"),
      9,
      [
        "██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝██╔══██╗",
        "Launch mode",
        "Provider migrated",
      ].join("\n"),
    );

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
    const frame = records.find((entry) => entry.kind === "terminal" && entry.event === "clearBoundaryFrame");
    assert.ok(frame, "startup frame should be traced");
    assert.equal(frame.codexaLogoCount, 1);
    assert.equal(frame.providerMigratedCount, 1);
    assert.equal(frame.launchModeCount, 1);
    assert.equal(frame.composerCount, 1);
    assert.equal(frame.footerCount, 1);
    assert.equal(frame.currentCols, 120);
    assert.equal(frame.currentRows, 40);
  } finally {
    configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("returns null when no live Ink instance is available", () => {
  const controller = createClearFrameBoundaryController({
    instance: null,
    terminalControl: { clearTranscript() {}, clearViewport() {} },
    stdout: { columns: 100, rows: 30 },
  });
  assert.equal(controller, null);
});
