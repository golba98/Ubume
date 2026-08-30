import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createClearFrameBoundaryController } from "./clearFrameBoundary.js";
import type { InkRenderInstance } from "./inkRenderReset.js";
import { configureRenderDebug } from "../perf/renderDebug.js";

function createHarness(overrides: {
  isOverlayActive?: () => boolean;
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

test("writes a resized main frame without clearing native scrollback", () => {
  // A width change reflows the frame already on screen, but the commit that
  // first observes the new width was still built from pre-resize React state,
  // and <Static> never re-emits flushed content on its own. The boundary must
  // therefore suppress that stale frame, ask the host for a fresh <Static>
  // (onWidthResizeRefresh), and only then clear scrollback and write the
  // rebuilt frame — clear and content land atomically, so no intermediate
  // "composer-only" frame is ever visible or stranded in scrollback.
  const harness = createHarness();
  const { controller, instance, stdout, calls, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;
  const resetBeforeResize = calls.logReset;

  stdout.columns = 180;
  stdout.rows = 50;
  instance.renderInteractiveFrame?.("rebuilt-frame", 6, "");
  const clearIndex = events.findIndex((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh"));
  const writeIndex = events.findIndex((entry) => entry.startsWith("write:rebuilt-frame"));
  assert.equal(clearIndex, -1, "resize must preserve native scrollback");
  assert.ok(writeIndex >= 0, "the resized live frame is written normally");
  assert.equal(
    events.some((entry) => entry === "write:rebuilt-frame:6:0"),
    true,
    "the unified frame contains the complete resized transcript",
  );
  assert.equal(controller.getState().lastFrameWasAuthoritative, false);
  assert.equal(calls.logReset, resetBeforeResize, "resize must not reset committed static history");
});

test("does not suppress frames while the React layout settles after resize", () => {
  // The viewport hook commits new dimensions on a trailing settle (~100ms), so
  // frames observing the new stdout.columns can still be laid out at the old
  // width. Remounting <Static> against that stale layout would re-flush the
  // logo/transcript at the wrong width — exactly the stale-variant home screen
  // the VTE startup settle used to produce.
  let renderedLayoutCols = 120;
  const harness = createHarness({
    getRenderedLayoutCols: () => renderedLayoutCols,
  });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;

  // stdout reports the new width but the committed layout is still 120-col.
  stdout.columns = 180;
  instance.renderInteractiveFrame?.("stale-layout-frame", 4, "");
  instance.renderInteractiveFrame?.("still-stale-layout-frame", 4, "");
  assert.equal(events.some((entry) => entry.startsWith("write:")), true, "native mode keeps writing without a resize gate");

  // The viewport settle lands: the committed layout now matches the terminal.
  renderedLayoutCols = 180;
  instance.renderInteractiveFrame?.("settled-layout-frame", 4, "");
  assert.equal(
    events.some((entry) => entry === "write:settled-layout-frame:4:0"),
    true,
    "the width-correct unified frame commits immediately",
  );
});

test("repaints on every width change, and a settled width never re-arms", () => {
  // Incremental static chunks (e.g. a system event flushed by the old <Static>
  // instance) can land between the resize and the re-flush commit. Committing
  // one of those after the clear would wipe scrollback and leave only that
  // chunk on screen.
  const harness = createHarness();
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  events.length = 0;

  stdout.columns = 180;
  instance.renderInteractiveFrame?.("rebuilt-one", 6, "");

  // Another commit at the settled width: no new repaint.
  instance.renderInteractiveFrame?.("steady-frame", 6, "");
  assert.equal(controller.getState().lastFrameWasAuthoritative, false, "steady frames are diffed, not authoritative");

  // A second, later width change repaints again.
  stdout.columns = 101;
  instance.renderInteractiveFrame?.("rebuilt-two", 7, "");
  assert.equal(
    events.filter((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefresh")).length,
    0,
    "width changes must not clear native transcript history",
  );
});

test("does not repaint on a height-only resize (no width change)", () => {
  const harness = createHarness();
  const { controller, instance, stdout, calls, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  const resetAfterFirstFrame = calls.logReset;

  // Only the row count changes — no reflow risk, so no authoritative repaint.
  stdout.rows = 60;
  instance.renderInteractiveFrame?.("taller-frame", 5, "");
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

test("repeated width-change frames remain writable without a suppression gate", () => {
  // If the re-flushed frame never arrives (render stall, hidden transcript),
  // the gate must open rather than suppress frames forever.
  const harness = createHarness({ getRenderedLayoutCols: () => 120 });
  const { controller, instance, stdout, events } = harness;

  instance.renderInteractiveFrame?.("initial-frame", 4, "");
  instance.fullStaticOutput = "accumulated static\n";
  events.length = 0;

  stdout.columns = 180;
  for (let index = 0; index < 9; index += 1) {
    instance.renderInteractiveFrame?.(`stalled-frame-${index}`, 4, "");
  }

  const fallbackClear = events.findIndex((entry) => entry.startsWith("clear:test:clearBoundary:resizeRefreshFallback"));
  assert.equal(fallbackClear, -1, "native resize never clears scrollback");
  assert.equal(
    events.some((entry) => entry === "write:stalled-frame-8:4:0"),
    true,
    "the live frame continues through normal Ink rendering",
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
  const harness = createHarness({
    isOverlayActive: () => overlayActive,
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
  assert.equal(events.some((entry) => entry.startsWith("write:main-frame-exit")), true, "restored native buffer receives the exit frame");

  instance.renderInteractiveFrame?.("main-frame-rebuilt", 6, "");
  assert.equal(
    events.some((entry) => entry === "write:main-frame-rebuilt:6:0"),
    true,
    "the rebuilt transcript frame commits the repaint after the overlay exit",
  );
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
    assert.equal(repaintArmed, undefined, "native width changes do not arm transcript repaint");
    assert.equal(resizeCommit, undefined, "native width changes do not clear and recommit history");
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
