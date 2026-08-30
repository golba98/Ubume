import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import type { TimelineEvent, UIState } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { AppShell } from "./AppShell.js";
import { Timeline } from "../timeline/Timeline.js";
import { BottomComposer, measureBottomComposerRows } from "./BottomComposer.js";
import { createLayoutSnapshot } from "../layout.js";
import { ThemeProvider } from "../theme.js";

class TestInput extends PassThrough {
  readonly isTTY = true;

  setRawMode(): this {
    return this;
  }

  override resume(): this {
    return this;
  }

  override pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function countMatching(records: Array<Record<string, unknown>>, predicate: (record: Record<string, unknown>) => boolean): number {
  return records.filter(predicate).length;
}

type ActionStatus = "running" | "completed";

function makeToolActivity(id: string, command: string, status: ActionStatus, streamSeq: number) {
  return {
    id,
    command,
    status,
    startedAt: streamSeq + 1,
    completedAt: status === "completed" ? streamSeq + 3 : null,
    summary: status === "completed" ? "Read 12 lines" : null,
    streamSeq,
  };
}

function makeActiveEvents(actionStatus: ActionStatus | null = "completed", secondActionStatus?: ActionStatus): TimelineEvent[] {
  const toolActivities = actionStatus === null
    ? []
    : [
        makeToolActivity("tool-1", "Get-Content README.md", actionStatus, 2),
        ...(secondActionStatus ? [makeToolActivity("tool-2", "Get-Content package.json", secondActionStatus, 3)] : []),
      ];
  return [
    {
      id: 1,
      type: "user",
      createdAt: 1,
      prompt: "What is the point of 5-Date Verification",
      turnId: 1,
    },
    {
      id: 2,
      type: "run",
      createdAt: 2,
      startedAt: 2,
      durationMs: null,
      backendId: "codex-subprocess",
      backendLabel: "Codexa",
      runtime: TEST_RUNTIME,
      prompt: "What is the point of 5-Date Verification",
      progressEntries: [{
        id: "thinking-1",
        source: "reasoning",
        text: "Checking the verification rule.",
        sequence: 1,
        createdAt: 2,
        updatedAt: 2,
        pendingNewlineCount: 0,
        blocks: [{
          id: "thinking-1-block-1",
          text: "Checking the verification rule.",
          sequence: 1,
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
          streamSeq: 1,
        }],
      }],
      status: "running",
      summary: "Running",
      truncatedOutput: false,
      toolActivities,
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 1,
      streamItems: [
        { kind: "thinking", streamSeq: 1, refId: "thinking-1-block-1" },
        ...toolActivities.map((tool) => ({ kind: "action" as const, streamSeq: tool.streamSeq, refId: tool.id })),
      ],
      responseSegments: [],
      lastStreamSeq: toolActivities.at(-1)?.streamSeq ?? 1,
      activeResponseSegmentId: null,
    },
  ];
}

function Harness({
  actionStatus = "completed",
  secondActionStatus,
}: {
  actionStatus?: ActionStatus | null;
  secondActionStatus?: ActionStatus;
}) {
  const layout = createLayoutSnapshot(120, 40);
  const uiState: UIState = { kind: "THINKING", turnId: 1 };
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "suggest",
    model: "gpt-5.4",
    reasoningLevel: "balanced",
    value: "",
    cursor: 0,
  });

  return (
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="main"
        authState="authenticated"
        workspaceLabel="workspace"
        runtimeSummary={null}
        staticEvents={[]}
        activeEvents={makeActiveEvents(actionStatus, secondActionStatus)}
        uiState={uiState}
        composerRows={composerRows}
        panel={null}
        composer={(
          <BottomComposer
            layout={layout}
            uiState={uiState}
            mode="suggest"
            model="gpt-5.4"
            reasoningLevel="balanced"
            tokensUsed={100}
            value=""
            cursor={0}
            onChangeInput={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onChangeValue={() => {}}
            onChangeCursor={() => {}}
            onHistoryUp={() => {}}
            onHistoryDown={() => {}}
            onOpenBackendPicker={() => {}}
            onOpenModelPicker={() => {}}
            onOpenModePicker={() => {}}
            onOpenThemePicker={() => {}}
            onOpenAuthPanel={() => {}}
            onTogglePlanMode={() => {}}
            onClear={() => {}}
            onCycleMode={() => {}}
            onQuit={() => {}}
          />
        )}
      />
    </ThemeProvider>
  );
}

function AppShellHarness({
  staticEvents,
  activeEvents,
  uiState,
  workspaceLabel = "13-Custom-CLI-Normal",
}: {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  workspaceLabel?: string;
}) {
  const layout = createLayoutSnapshot(120, 40);
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "suggest",
    model: "gpt-5.4",
    reasoningLevel: "balanced",
    value: "",
    cursor: 0,
  });

  return (
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="main"
        authState="authenticated"
        workspaceLabel={workspaceLabel}
        runtimeSummary={null}
        staticEvents={staticEvents}
        activeEvents={activeEvents}
        uiState={uiState}
        composerRows={composerRows}
        panel={null}
        composer={(
          <BottomComposer
            layout={layout}
            uiState={uiState}
            mode="suggest"
            model="gpt-5.4"
            reasoningLevel="balanced"
            tokensUsed={100}
            value=""
            cursor={0}
            onChangeInput={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onChangeValue={() => {}}
            onChangeCursor={() => {}}
            onHistoryUp={() => {}}
            onHistoryDown={() => {}}
            onOpenBackendPicker={() => {}}
            onOpenModelPicker={() => {}}
            onOpenModePicker={() => {}}
            onOpenThemePicker={() => {}}
            onOpenAuthPanel={() => {}}
            onTogglePlanMode={() => {}}
            onClear={() => {}}
            onCycleMode={() => {}}
            onQuit={() => {}}
          />
        )}
      />
    </ThemeProvider>
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("status dot ticks do not invalidate timeline rendering", async () => {
  const logPath = join(tmpdir(), `codexa-status-isolation-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_DEBUG_RENDER_TRACE: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });

  const stdin = new TestInput();
  const stdout = new TestOutput();
  const instance = render(<Harness />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  try {
    await sleep(100);
    const beforeTick = readRecords(logPath);

    await sleep(950);
    const afterTick = readRecords(logPath);
    const tickWindow = afterTick.slice(beforeTick.length);

    assert.equal(countMatching(tickWindow, (record) => record.kind === "status" && record.event === "tick"), 1);
    assert(countMatching(tickWindow, (record) => record.kind === "render" && record.component === "Status") >= 1);
    assert.equal(countMatching(tickWindow, (record) => record.kind === "render" && record.component === "Timeline"), 0);
    assert.equal(countMatching(tickWindow, (record) => record.kind === "timeline" && record.event === "rowGeneration"), 0);
    assert.equal(countMatching(tickWindow, (record) => record.kind === "viewport" && record.event === "slice"), 0);
    assert.equal(countMatching(tickWindow, (record) => record.kind === "render" && record.component === "ActionLog"), 0);
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("app-scroll action rows update without remounting when a running action completes", async () => {
  const logPath = join(tmpdir(), `codexa-action-remount-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_DEBUG_RENDER_TRACE: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });

  const stdin = new TestInput();
  const stdout = new TestOutput();
  const instance = render(<Harness actionStatus="running" />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  try {
    await sleep(100);
    const beforeCompletion = readRecords(logPath);
    const mountedActionRows = beforeCompletion
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowMount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-"));

    assert.ok(mountedActionRows.length > 0, "expected action rows to mount in the initial frame");

    instance.rerender(<Harness actionStatus="completed" />);
    await sleep(100);

    const afterCompletion = readRecords(logPath).slice(beforeCompletion.length);
    const unmountedActionRows = afterCompletion
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowUnmount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-"));

    assert.deepEqual(unmountedActionRows, []);
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("first action activity keeps the shell frame mounted and visible", async () => {
  const logPath = join(tmpdir(), `codexa-first-action-shell-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_RENDER_DEBUG: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(<Harness actionStatus={null} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  try {
    await sleep(100);
    instance.rerender(<Harness actionStatus="running" />);
    await sleep(100);

    const frame = stripAnsi(output);
    assert.match(frame, /workspace/);
    assert.match(frame, /What is the point of 5-Date Verification/);
    assert.match(frame, /Codexa is thinking/i);
    assert.match(frame, /Get-Content README\.md/);

    const records = readRecords(logPath);
    const unexpectedUnmounts = records
      .filter((record) => record.kind === "lifecycle" && record.event === "unmount")
      .map((record) => String(record.component ?? ""))
      .filter((component) => ["AppShell", "Timeline", "Header", "Composer", "Status"].includes(component));
    assert.deepEqual(unexpectedUnmounts, []);
    assert.equal(
      countMatching(records, (record) =>
        record.kind === "blankFrame" && record.reason === "visible-rows-zero-with-events"
      ),
      0,
    );
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("appending a second action does not remount existing action rows", async () => {
  const logPath = join(tmpdir(), `codexa-action-append-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_DEBUG_RENDER_TRACE: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });

  const stdin = new TestInput();
  const stdout = new TestOutput();
  const instance = render(<Harness actionStatus="running" />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  try {
    await sleep(100);
    const beforeUpdates = readRecords(logPath);
    const firstActionMounts = beforeUpdates
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowMount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-2-"));

    assert.ok(firstActionMounts.length > 0, "expected first action rows to mount in the initial frame");

    instance.rerender(<Harness actionStatus="completed" />);
    await sleep(100);
    const beforeAppend = readRecords(logPath);

    instance.rerender(<Harness actionStatus="completed" secondActionStatus="running" />);
    await sleep(100);

    const appendWindow = readRecords(logPath).slice(beforeAppend.length);
    const firstActionUnmounts = appendWindow
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowUnmount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-2-"));

    assert.deepEqual(firstActionUnmounts, []);
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});

test("native AppShell finalize keeps transcript rows in one keyed tree", async () => {
  const logPath = join(tmpdir(), `codexa-native-finalize-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_DEBUG_RENDER_TRACE: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });

  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const runningEvents = makeActiveEvents("completed");
  const completedEvents = JSON.parse(JSON.stringify(runningEvents)) as TimelineEvent[];
  const completedRun = completedEvents.find((event): event is Extract<TimelineEvent, { type: "run" }> => event.type === "run");
  assert.ok(completedRun);
  completedRun.status = "completed";
  completedRun.durationMs = 1234;
  completedRun.responseSegments = [{
    id: "response-2-3",
    streamSeq: 3,
    chunks: ["Hello"],
    status: "completed",
    startedAt: 5,
  }];
  completedRun.streamItems = [
    ...(completedRun.streamItems ?? []),
    { kind: "response", streamSeq: 3, refId: "response-2-3" },
  ];
  completedEvents.push({
    id: 3,
    type: "assistant",
    createdAt: 6,
    content: "Hello",
    contentChunks: [],
    turnId: 1,
  });

  const instance = render(
    <AppShellHarness
      staticEvents={[]}
      activeEvents={runningEvents}
      uiState={{ kind: "THINKING", turnId: 1 }}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  try {
    await sleep(100);
    const beforeFinalize = readRecords(logPath);

    instance.rerender(
      <AppShellHarness
        staticEvents={completedEvents}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
      />,
    );
    await sleep(100);

    const finalizeWindow = readRecords(logPath).slice(beforeFinalize.length);
    const unmountedActionRows = finalizeWindow
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowUnmount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-"));
    const majorUnmounts = finalizeWindow
      .filter((record) => record.kind === "lifecycle" && record.event === "unmount")
      .map((record) => String(record.component ?? ""))
      .filter((component) => ["AppShell", "Header", "Composer"].includes(component));

    assert.deepEqual(unmountedActionRows, []);
    assert.deepEqual(majorUnmounts, []);
    const frame = stripAnsi(output);
    assert.match(frame, /13-Custom-CLI-Normal/);
    assert.match(frame, /Hello/);
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});


test("THINKING -> RESPONDING -> FINALIZE_RUN preserves action rows and renders response below", async () => {
  const logPath = join(tmpdir(), `codexa-action-response-finalize-${process.pid}.jsonl`);
  rmSync(logPath, { force: true });
  renderDebug.configureRenderDebug({
    CODEXA_DEBUG_RENDER_TRACE: "1",
    CODEXA_RENDER_DEBUG_FILE: logPath,
  });

  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  let runningEvents: TimelineEvent[] = makeActiveEvents("running");
  let uiState: UIState = { kind: "THINKING", turnId: 1 };
  
  const TestTimeline = (props: {
    staticEvents: TimelineEvent[];
    activeEvents: TimelineEvent[];
    uiState: UIState;
  }) => {
    const layout = createLayoutSnapshot(120, 40);
    return <Timeline
      staticEvents={props.staticEvents}
      activeEvents={props.activeEvents}
      layout={layout}
      uiState={props.uiState}
      viewportRows={30}
      verboseMode={true}
    />;
  };

  const instance = render(<TestTimeline staticEvents={[]} activeEvents={runningEvents} uiState={uiState} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  try {
    await sleep(100);
    const beforeUpdates = readRecords(logPath);
    
    // RESPONDING
    let streamingEvents = JSON.parse(JSON.stringify(runningEvents)) as TimelineEvent[];
    let streamingTurn = streamingEvents[1] as Extract<TimelineEvent, { type: "run" }>;
    streamingTurn.toolActivities[0].status = "completed";
    streamingTurn.responseSegments = [{
      id: "resp-1",
      streamSeq: 3,
      chunks: ["Final response text"],
      status: "active",
      startedAt: 5,
    }];
    streamingTurn.streamItems = [
      ...(streamingTurn.streamItems ?? []),
      { kind: "response", streamSeq: 3, refId: "resp-1" },
    ];
    uiState = { kind: "RESPONDING", turnId: 1 };
    
    instance.rerender(<TestTimeline staticEvents={[]} activeEvents={streamingEvents} uiState={uiState} />);
    await sleep(100);

    // FINALIZE_RUN
    let completedEvents = JSON.parse(JSON.stringify(streamingEvents)) as TimelineEvent[];
    let completedTurn = completedEvents[1] as Extract<TimelineEvent, { type: "run" }>;
    completedTurn.status = "completed";
    completedTurn.responseSegments = (completedTurn.responseSegments ?? []).map((segment, index) =>
      index === 0 ? { ...segment, status: "completed" } : segment
    );
    uiState = { kind: "IDLE" };
    
    instance.rerender(<TestTimeline staticEvents={completedEvents} activeEvents={[]} uiState={uiState} />);
    await sleep(100);

    const frame = stripAnsi(output);
    
    const unmounts = readRecords(logPath)
      .filter((record) => record.kind === "flicker" && record.event === "timelineRowUnmount")
      .map((record) => String(record.rowKey ?? ""))
      .filter((rowKey) => rowKey.includes("-action-"));
      
    assert.deepEqual(unmounts, [], "Action rows should not unmount during response and finalize");
    assert.match(frame, /Final response text/i, "Answer text should appear");
    assert.match(frame, /Read file/i, "Action row should remain");
    
  } finally {
    instance.unmount();
    renderDebug.configureRenderDebug({});
    rmSync(logPath, { force: true });
  }
});
