import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { AssistantEvent, RunEvent, UIState, UserPromptEvent } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { ThemeProvider } from "../theme.js";
import { TurnGroup, resolveTurnRunPhase } from "./TurnGroup.js";

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

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRunningRun(turnId: number): RunEvent {
  return {
    id: 2,
    type: "run",
    createdAt: 2,
    startedAt: 2,
    durationMs: null,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt: "Do work",
    progressEntries: [],
    status: "running",
    summary: "Running",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId,
  };
}

function makeUser(turnId: number): UserPromptEvent {
  return {
    id: 1,
    type: "user",
    createdAt: 1,
    prompt: "Do work",
    turnId,
  };
}

function makeAssistant(turnId: number, content: string): AssistantEvent {
  return {
    id: 3,
    type: "assistant",
    createdAt: 3,
    content,
    contentChunks: [],
    turnId,
  };
}

function renderTurnGroup(node: React.ReactElement) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });

  return {
    instance,
    readOutput: () => stripAnsi(output),
    resetOutput: () => {
      output = "";
    },
  };
}

test("does not render duplicate transcript working placeholder before streaming appears", async () => {
  const turnId = 10;
  const user = makeUser(turnId);
  const run = makeRunningRun(turnId);
  const assistant = makeAssistant(turnId, "Streaming line");

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={null}
        opacity="active"
        question={null}
        runPhase="thinking"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  let frame = harness.readOutput();
  assert.doesNotMatch(frame, /Codex is working/i);

  harness.resetOutput();
  harness.instance.rerender(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  frame = harness.readOutput();
  assert.match(frame, /Ubume/);
  assert.match(frame, /Streaming line/i);

  harness.instance.unmount();
});

test("renders progressive content updates during streaming", async () => {
  const turnId = 12;
  const user = makeUser(turnId);
  const run = makeRunningRun(turnId);

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={makeAssistant(turnId, "First chunk")}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  let frame = harness.readOutput();
  assert.match(frame, /first chunk/i);

  // Update with more content — should render incrementally
  harness.resetOutput();
  harness.instance.rerender(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={makeAssistant(turnId, "First chunk\nSecond chunk")}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  frame = harness.readOutput();
  assert.match(frame, /second chunk/i);

  harness.instance.unmount();
});

test("finalization with same content does not cause visual flash", async () => {
  const turnId = 13;
  const user = makeUser(turnId);
  const run = makeRunningRun(turnId);
  const content = "The response content stays the same";
  const assistant = makeAssistant(turnId, content);

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  let streamingFrame = harness.readOutput();
  assert.match(streamingFrame, /response content stays/i);

  // Transition to final with same content
  harness.resetOutput();
  harness.instance.rerender(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={{ ...run, status: "completed", durationMs: 800 }}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="final"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  let finalFrame = harness.readOutput();
  // Content should still be present — no flash/disappearance
  assert.match(finalFrame, /response content stays/i);
  assert.match(finalFrame, /Ubume/);

  harness.instance.unmount();
});

test("assistant output 'Ubume' label is indented by transcriptContentIndent", async () => {
  const turnId = 100;
  const user = makeUser(turnId);
  const run = makeRunningRun(turnId);
  const assistant = makeAssistant(turnId, "Indented response");

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  const frame = harness.readOutput();
  const lines = frame.split("\n");
  const ubumeLine = lines.find((l) => l.includes("Ubume"));
  assert.ok(ubumeLine, "expected Ubume label");
  // Check that the line starts with exactly 4 spaces (transcriptContentIndent = 4)
  assert.match(ubumeLine, /^    Ubume/);

  harness.instance.unmount();
});

test("renders accumulated Local reasoning once and keeps the final response separate", async () => {
  const turnId = 101;
  const user = makeUser(turnId);
  const run: RunEvent = {
    ...makeRunningRun(turnId),
    status: "completed",
    durationMs: 500,
    progressEntries: [{
      id: "local-reasoning-session-1-1-0",
      source: "reasoning",
      text: "The user said Hi. I should answer helpfully.",
      sequence: 1,
      createdAt: 2,
      updatedAt: 3,
      pendingNewlineCount: 0,
      blocks: [{
        id: "local-reasoning-session-1-1-0-block-1",
        text: "The user said Hi. I should answer helpfully.",
        sequence: 1,
        createdAt: 2,
        updatedAt: 3,
        status: "completed",
        streamSeq: 1,
      }],
    }],
    responseSegments: [{
      id: "response-1",
      streamSeq: 2,
      chunks: ["Hi! How can I help?"],
      status: "completed",
      startedAt: 4,
    }],
    streamItems: [
      { streamSeq: 1, kind: "thinking", refId: "local-reasoning-session-1-1-0-block-1" },
      { streamSeq: 2, kind: "response", refId: "response-1" },
    ],
  };
  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={makeAssistant(turnId, "Hi! How can I help?")}
        opacity="active"
        question={null}
        runPhase="final"
        streamPreviewRows={8}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  const frame = harness.readOutput();
  assert.equal(frame.match(/Reasoning/g)?.length, 1);
  assert.equal(frame.match(/^    Ubume$/gm)?.length, 1);
  assert.match(frame, /The user said Hi/);
  assert.match(frame, /Hi! How can I help/);
  harness.instance.unmount();
});

test("consecutive Local reasoning fragments coalesce under a single Reasoning header", async () => {
  const turnId = 102;
  const user = makeUser(turnId);
  const thinkingEntry = (n: number, text: string) => ({
    id: `local-reasoning-session-1-1-${n}`,
    source: "reasoning" as const,
    text,
    sequence: n,
    createdAt: n,
    updatedAt: n,
    pendingNewlineCount: 0,
    blocks: [{
      id: `local-reasoning-session-1-1-${n}-block-1`,
      text,
      sequence: 1,
      createdAt: n,
      updatedAt: n,
      status: "completed" as const,
      streamSeq: n + 1,
    }],
  });
  const run: RunEvent = {
    ...makeRunningRun(turnId),
    status: "completed",
    durationMs: 500,
    progressEntries: [
      thinkingEntry(0, "We need to interpret the conversation."),
      thinkingEntry(1, "The user says Hi."),
      thinkingEntry(2, "We should respond with a greeting."),
    ],
    responseSegments: [{
      id: "response-1",
      streamSeq: 4,
      chunks: ["Hi! How can I help?"],
      status: "completed",
      startedAt: 5,
    }],
    streamItems: [
      { streamSeq: 1, kind: "thinking", refId: "local-reasoning-session-1-1-0-block-1" },
      { streamSeq: 2, kind: "thinking", refId: "local-reasoning-session-1-1-1-block-1" },
      { streamSeq: 3, kind: "thinking", refId: "local-reasoning-session-1-1-2-block-1" },
      { streamSeq: 4, kind: "response", refId: "response-1" },
    ],
  };
  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={1}
        user={user}
        run={run}
        assistant={makeAssistant(turnId, "Hi! How can I help?")}
        opacity="active"
        question={null}
        runPhase="final"
        streamPreviewRows={8}
        streamMode="assistant-first"
        verboseMode
      />
    </ThemeProvider>,
  );

  await sleep();
  const frame = harness.readOutput();
  assert.equal(frame.match(/Reasoning/g)?.length, 1, "contiguous fragments must share one header");
  assert.match(frame, /We need to interpret the conversation/);
  assert.match(frame, /We should respond with a greeting/);
  assert.match(frame, /Hi! How can I help/);
  harness.instance.unmount();
});


test("snaps cleanly from streaming cursor view to completion view", async () => {
  const turnId = 11;
  const user = makeUser(turnId);
  const running = makeRunningRun(turnId);
  const assistant = makeAssistant(turnId, "Final response text");

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={2}
        user={user}
        run={running}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="streaming"
        streamPreviewRows={6}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  let frame = harness.readOutput();
  assert.match(frame, /final response text/i);
  assert.match(frame, /▌/);

  harness.resetOutput();
  harness.instance.rerender(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={120}
        turnIndex={2}
        user={user}
        run={{ ...running, status: "completed", durationMs: 1200 }}
        assistant={assistant}
        opacity="active"
        question={null}
        runPhase="final"
        streamPreviewRows={6}
        streamMode="assistant-first"
      />
    </ThemeProvider>,
  );

  await sleep();
  frame = harness.readOutput();
  assert.match(frame, /final response text/i);
  assert.doesNotMatch(frame, /▌/);

  harness.instance.unmount();
});
