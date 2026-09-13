import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { RunEvent, UserPromptEvent } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { ThemeProvider } from "../theme.js";
import { TurnGroup } from "../timeline/TurnGroup.js";

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

test("prompt card top border stays closed at the top-right corner across rerenders", async () => {
  const turnId = 14;
  const user = makeUser(turnId);
  const run = makeRunningRun(turnId);

  const harness = renderTurnGroup(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={80}
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
  let topBorder = frame.split("\n").find((line) => line.includes("╭── PROMPT"));
  assert.ok(topBorder, "expected prompt top border line");
  assert.match(topBorder!, /──╮$/);
  assert.doesNotMatch(topBorder!, / ──╮$/);

  harness.resetOutput();
  harness.instance.rerender(
    <ThemeProvider theme="purple">
      <TurnGroup
        cols={56}
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
  frame = harness.readOutput();
  topBorder = frame.split("\n").find((line) => line.includes("╭── PROMPT"));
  assert.ok(topBorder, "expected prompt top border line after resize rerender");
  assert.match(topBorder!, /──╮$/);
  assert.doesNotMatch(topBorder!, / ──╮$/);

  harness.instance.unmount();
});
