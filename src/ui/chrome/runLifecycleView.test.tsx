import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import type { UIState } from "../../session/types.js";
import { isBusy } from "../../session/types.js";
import { BottomComposer } from "./BottomComposer.js";
import { createLayoutSnapshot } from "../layout.js";
import { getRunFooterStatus, RunFooter } from "./RunFooter.js";
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

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEST_LAYOUT = createLayoutSnapshot(120, 40);

test("idle footer status is empty by contract", () => {
  assert.equal(getRunFooterStatus({ kind: "IDLE" }), "");
});

function LifecycleHarness({ uiState, value, showBusyLoader = true }: { uiState: UIState; value: string; showBusyLoader?: boolean }) {
  const showComposer = !isBusy(uiState);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column" width="100%">
        {showComposer ? (
          <BottomComposer
            layout={TEST_LAYOUT}
            uiState={uiState}
            mode="suggest"
            model="gpt-5.4"
            reasoningLevel="balanced"
            tokensUsed={100}
            value={value}
            cursor={value.length}
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
        ) : (
          <RunFooter uiState={uiState} showBusyLoader={showBusyLoader} onCancel={() => {}} onQuit={() => {}} />
        )}
      </Box>
    </ThemeProvider>
  );
}

test("collapses composer during thinking so input buffer artifacts are removed", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <LifecycleHarness uiState={{ kind: "IDLE" }} value="draft prompt" />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  await sleep();
  let frame = stripAnsi(output);
  assert.match(frame, /draft prompt/i);

  output = "";
  instance.rerender(<LifecycleHarness uiState={{ kind: "THINKING", turnId: 1 }} value="draft prompt" />);
  await sleep();
  frame = stripAnsi(output);
  assert.doesNotMatch(frame, /draft prompt/i);
  assert.match(frame, /Ubume is thinking/i);

  instance.unmount();
});

test("busy footer advances from local status state without a parent rerender", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <LifecycleHarness uiState={{ kind: "THINKING", turnId: 1 }} value="" />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  await sleep();
  let frame = stripAnsi(output);
  assert.match(frame, /Ubume is thinking \./);

  output = "";
  await sleep(950);
  frame = stripAnsi(output);
  assert.match(frame, /Ubume is thinking \.\./);

  instance.unmount();
});

test("busy footer omits loader frames when disabled", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <LifecycleHarness uiState={{ kind: "THINKING", turnId: 1 }} value="" showBusyLoader={false} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  try {
    await sleep();
    let frame = stripAnsi(output);
    assert.match(frame, /Ubume is thinking/);
    assert.doesNotMatch(frame, /Ubume is thinking \./);

    output = "";
    await sleep(950);
    frame = stripAnsi(output);
    assert.equal(frame, "");
  } finally {
    instance.unmount();
  }
});

test("static status debug flag reserves status text without dot ticks", async () => {
  const previous = process.env.UBUME_DEBUG_STATIC_STATUS;
  process.env.UBUME_DEBUG_STATIC_STATUS = "1";
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <LifecycleHarness uiState={{ kind: "THINKING", turnId: 1 }} value="" />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  try {
    await sleep();
    let frame = stripAnsi(output);
    assert.match(frame, /Ubume is thinking \.\.\./);

    output = "";
    await sleep(950);
    frame = stripAnsi(output);
    assert.equal(frame, "");
  } finally {
    instance.unmount();
    if (previous === undefined) {
      delete process.env.UBUME_DEBUG_STATIC_STATUS;
    } else {
      process.env.UBUME_DEBUG_STATIC_STATUS = previous;
    }
  }
});
