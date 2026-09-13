import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  configureRenderDebug,
  getRenderDebugLogPath,
  traceBlankFrame,
  traceEvent,
  traceLayoutValidity,
  traceLifecycleEvent,
  traceLifecycleTransition,
  traceFlickerEvent,
  traceStatusTick,
  traceRender,
  traceTerminalWrite,
} from "./renderDebug.js";

function clean(path: string): void {
  rmSync(path, { force: true });
}

test("render debug stays quiet by default", () => {
  const logPath = join(tmpdir(), `ubume-render-debug-quiet-${process.pid}.jsonl`);
  clean(logPath);

  configureRenderDebug({ UBUME_RENDER_DEBUG_FILE: logPath });
  traceEvent("test", "quiet");
  traceRender("QuietComponent", "test");

  assert.equal(existsSync(logPath), false);
});

test("render debug writes JSONL only when explicitly enabled", () => {
  const logPath = join(tmpdir(), `ubume-render-debug-enabled-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_RENDER_DEBUG: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceRender("EnabledComponent", "unit");

    assert.equal(getRenderDebugLogPath(), logPath);
    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0]?.kind, "session");
    assert.equal(records[1]?.kind, "render");
    assert.equal(records[1]?.component, "EnabledComponent");
    assert.equal(records[1]?.reason, "unit");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("render debug defaults to user-data diagnostic logs", () => {
  configureRenderDebug({ UBUME_DATA_DIR: "/custom/ubume" });
  assert.equal(getRenderDebugLogPath(), join("/custom/ubume", "debug", "render-status.log"));
});

test("model state debug alias enables the render status log", () => {
  const logPath = join(tmpdir(), `ubume-model-state-render-debug-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_DEBUG_MODEL_STATE: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceEvent("model", "alias");

    assert.equal(getRenderDebugLogPath(), logPath);
    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0]?.kind, "session");
    assert.equal(records[1]?.kind, "model");
    assert.equal(records[1]?.event, "alias");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("render debug creates missing log directories", () => {
  const logPath = join(tmpdir(), `ubume-render-debug-nested-${process.pid}`, "render-debug.log");
  rmSync(join(tmpdir(), `ubume-render-debug-nested-${process.pid}`), { force: true, recursive: true });

  try {
    configureRenderDebug({
      UBUME_RENDER_DEBUG: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    assert.equal(existsSync(logPath), true);
  } finally {
    configureRenderDebug({});
    rmSync(join(tmpdir(), `ubume-render-debug-nested-${process.pid}`), { force: true, recursive: true });
  }
});

test("render debug records lifecycle, layout, and blank-frame diagnostics", () => {
  const logPath = join(tmpdir(), `ubume-render-diagnostics-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_RENDER_DEBUG: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceLifecycleEvent("Timeline", "mount", { viewportRows: 12 });
    traceLayoutValidity("Timeline", { viewportRows: 0, cols: 120 });
    traceBlankFrame("Timeline", { reason: "visible-rows-zero-with-events" });

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[1]?.kind, "lifecycle");
    assert.equal(records[1]?.component, "Timeline");
    assert.equal(records[1]?.event, "mount");
    assert.equal(records[2]?.kind, "layout");
    assert.equal(records[2]?.event, "invalidLayout");
    assert.deepEqual(records[2]?.invalidValues, [{ key: "viewportRows", value: 0 }]);
    assert.equal(records[3]?.kind, "blankFrame");
    assert.equal(records[3]?.reason, "visible-rows-zero-with-events");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("terminal writes are classified for clear and reset diagnosis", () => {
  const logPath = join(tmpdir(), `ubume-terminal-classification-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_RENDER_DEBUG: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceTerminalWrite(
      "stdout",
      "unit",
      "\x1b[2J\x1b[3J\x1b[H\x1bc\x1b[?1049h\x1b]0;UBUME\x07\x1b[?2004h\x1b[?1000h",
    );

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[1]?.kind, "stdout");
    assert.equal(records[1]?.containsViewportClear, true);
    assert.equal(records[1]?.containsScrollbackClear, true);
    assert.equal(records[1]?.containsCursorHome, true);
    assert.equal(records[1]?.containsTerminalReset, true);
    assert.equal(records[1]?.containsAlternateScreen, true);
    assert.equal(records[1]?.containsTitleSequence, true);
    assert.equal(records[1]?.containsBracketedPaste, true);
    assert.equal(records[1]?.containsMouseMode, true);
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("UBUME_DEBUG_RENDER aliases render debug logging", () => {
  const logPath = join(tmpdir(), `ubume-debug-render-alias-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_DEBUG_RENDER: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceRender("AliasComponent", "unit");

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0]?.kind, "session");
    assert.equal(records[1]?.kind, "render");
    assert.equal(records[1]?.component, "AliasComponent");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("render trace flag enables compact render diagnostics", () => {
  const logPath = join(tmpdir(), `ubume-render-trace-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_DEBUG_RENDER_TRACE: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceRender("TraceComponent", "unit");
    traceFlickerEvent("viewportSlice", { reason: "unit" });

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0]?.kind, "session");
    assert.equal(records[1]?.kind, "render");
    assert.equal(records[1]?.component, "TraceComponent");
    assert.equal(records[2]?.kind, "flicker");
    assert.equal(records[2]?.event, "viewportSlice");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("lifecycle trace is gated by UBUME_DEBUG_LIFECYCLE", () => {
  const logPath = join(tmpdir(), `ubume-lifecycle-debug-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_DEBUG_LIFECYCLE: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceLifecycleTransition({
      prevKind: "THINKING",
      nextKind: "IDLE",
      reason: "unit",
    });

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "lifecycle");
    assert.equal(records[0]?.reason, "unit");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});

test("flicker trace is gated by UBUME_DEBUG_FLICKER", () => {
  const logPath = join(tmpdir(), `ubume-flicker-debug-${process.pid}.jsonl`);
  clean(logPath);

  try {
    configureRenderDebug({
      UBUME_DEBUG_FLICKER: "1",
      UBUME_RENDER_DEBUG_FILE: logPath,
    });
    traceFlickerEvent("timelineRender", { reason: "unit" });
    traceStatusTick({ owner: "Status", label: "Codex is thinking" });

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0]?.kind, "flicker");
    assert.equal(records[0]?.event, "timelineRender");
    assert.equal(records[1]?.kind, "flicker");
    assert.equal(records[1]?.event, "statusTick");
  } finally {
    configureRenderDebug({});
    clean(logPath);
  }
});
