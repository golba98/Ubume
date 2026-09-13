import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { ThemeProvider } from "../theme.js";
import { getHorizontalArrowDirection, UpdatePromptPanel, type RunUpdateFn } from "./UpdatePromptPanel.js";
import type { CommandResult } from "../../core/process/CommandRunner.js";
import type { GlobalPackageManager } from "../../core/version/packageManager.js";

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this { return this; }
  override resume(): this { return this; }
  override pause(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

test("recognizes VTE, application-cursor, and modified horizontal arrows", () => {
  const ESC = String.fromCharCode(27);
  assert.equal(getHorizontalArrowDirection(`${ESC}[D`), "left");
  assert.equal(getHorizontalArrowDirection(`${ESC}OC`), "right");
  // Kitty encodes arrows as ordinary CSI finals with modifier parameters; its
  // CSI-u codepoint space covers printscreen/pause, not the arrow keys.
  assert.equal(getHorizontalArrowDirection(`${ESC}[1;5C`), "right");
  assert.equal(getHorizontalArrowDirection(`${ESC}[1;2D`), "left");
});

interface Harness {
  stdin: TestInput;
  output: () => string;
  cleanup: () => void;
  onSkipCalls: () => number;
  onRestartCalls: () => number;
}

function renderPanel(options: {
  packageManager?: GlobalPackageManager;
  runUpdate?: RunUpdateFn;
} = {}): Harness {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  let skipCalls = 0;
  let restartCalls = 0;

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <UpdatePromptPanel
        focusId="update-prompt-test"
        currentVersion="1.0.4"
        latestVersion="1.0.5"
        packageManager={options.packageManager ?? "npm"}
        runUpdate={options.runUpdate}
        onSkip={() => { skipCalls += 1; }}
        onRestart={() => { restartCalls += 1; }}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  return {
    stdin,
    output: () => stripAnsi(output),
    cleanup: () => instance.cleanup(),
    onSkipCalls: () => skipCalls,
    onRestartCalls: () => restartCalls,
  };
}

test("prompt shows exact versions, actions, and the detected package manager command", async () => {
  const harness = renderPanel({ packageManager: "bun" });
  await sleep();
  harness.cleanup();

  assert.match(harness.output(), /Update available: Ubume 1\.0\.5/);
  assert.match(harness.output(), /Current version: 1\.0\.4/);
  assert.match(harness.output(), /❯ \[ Update now \]\s+\[ Later \]/);
  assert.match(harness.output(), /←\/→ to choose · Enter to confirm · Esc to close/);
  assert.match(harness.output(), /bun add -g ubume@latest/);
  assert.doesNotMatch(harness.output(), /npm install -g/);
});

test("Update now with a successful runner reaches the done phase", async () => {
  const calls: GlobalPackageManager[] = [];
  const runUpdate: RunUpdateFn = (pm) => {
    calls.push(pm);
    return { result: Promise.resolve(makeResult()), cancel: () => {} };
  };

  const harness = renderPanel({ packageManager: "pnpm", runUpdate });
  await sleep();
  const availableOutputLength = harness.output().length;
  harness.stdin.write("\r"); // Enter on "Update now"
  await sleep();

  const installAndSuccessOutput = harness.output().slice(availableOutputLength);
  assert.deepEqual(calls, ["pnpm"]);
  assert.match(installAndSuccessOutput, /Installing Ubume 1\.0\.5/);
  assert.match(installAndSuccessOutput, /Ubume v1\.0\.5 installed successfully\./);
  assert.match(installAndSuccessOutput, /Restart Ubume to use the new version\./);
  assert.match(installAndSuccessOutput, /❯ \[ Restart now \]/);
  assert.match(installAndSuccessOutput, /Enter to restart · Esc to stay in Ubume/);

  harness.stdin.write("\r");
  await sleep(20);
  assert.equal(harness.onRestartCalls(), 1);
  assert.equal(harness.onSkipCalls(), 0);
  harness.cleanup();
});

test("permission failure shows guidance without sudo", async () => {
  const runUpdate: RunUpdateFn = () => ({
    result: Promise.resolve(makeResult({
      status: "failed",
      exitCode: 243,
      stderr: "npm ERR! Error: EACCES: permission denied, access '/usr/local/lib/node_modules'",
      userMessage: "npm ERR! Error: EACCES: permission denied",
    })),
    cancel: () => {},
  });

  const harness = renderPanel({ packageManager: "npm", runUpdate });
  await sleep();
  harness.stdin.write("\r");
  await sleep();
  harness.cleanup();

  assert.match(harness.output(), /Update failed\./);
  assert.match(harness.output(), /npm config get prefix/);
  assert.doesNotMatch(harness.output(), /sudo/i);
});

test("non-permission failure surfaces the runner's user message", async () => {
  const runUpdate: RunUpdateFn = () => ({
    result: Promise.resolve(makeResult({
      status: "failed",
      exitCode: 1,
      stderr: "npm ERR! network request failed",
      userMessage: "npm ERR! network request failed",
    })),
    cancel: () => {},
  });

  const harness = renderPanel({ runUpdate });
  await sleep();
  harness.stdin.write("\r");
  await sleep();
  harness.cleanup();

  assert.match(harness.output(), /Update failed\./);
  assert.match(harness.output(), /network request failed/);
});

test("Right arrow selects Later and Esc also skips without running an update", async () => {
  const runUpdate: RunUpdateFn = () => {
    throw new Error("runner must not be invoked for skip");
  };

  const skipHarness = renderPanel({ runUpdate });
  await sleep();
  skipHarness.stdin.write("[C"); // right to "Later"
  await sleep(20);
  assert.match(skipHarness.output(), /\[ Update now \]\s+❯ \[ Later \]/);
  skipHarness.stdin.write("\r");
  await sleep(20);
  skipHarness.cleanup();
  assert.equal(skipHarness.onSkipCalls(), 1);

  const escHarness = renderPanel({ runUpdate });
  await sleep();
  escHarness.stdin.write(""); // Esc
  await sleep(150);
  escHarness.cleanup();
  assert.equal(escHarness.onSkipCalls(), 1);
});

test("installing replaces the available card and Esc cancels back to a clean available state", async () => {
  const resolvers: Array<(result: CommandResult) => void> = [];
  let cancelCalls = 0;
  let runCalls = 0;
  const runUpdate: RunUpdateFn = (_pm, handlers) => {
    runCalls += 1;
    handlers?.onStdout?.("downloading package\n");
    return {
      result: new Promise<CommandResult>((resolve) => resolvers.push(resolve)),
      cancel: () => { cancelCalls += 1; },
    };
  };

  const harness = renderPanel({ runUpdate });
  await sleep();
  const beforeInstall = harness.output().length;

  harness.stdin.write("\r");
  await sleep();

  const installingFrame = harness.output().slice(beforeInstall);
  assert.equal(runCalls, 1);
  assert.match(installingFrame, /Installing Ubume 1\.0\.5/);
  assert.match(installingFrame, /downloading package/);
  assert.match(installingFrame, /Esc to cancel/);
  assert.doesNotMatch(installingFrame, /Update available: Ubume/);
  assert.doesNotMatch(installingFrame, /Current version:/);
  assert.doesNotMatch(installingFrame, /Run: npm install/);

  const beforeCancel = harness.output().length;
  harness.stdin.write("\u001b");
  await sleep(150);

  const availableAgainFrame = harness.output().slice(beforeCancel);
  assert.equal(cancelCalls, 1);
  assert.equal(harness.onSkipCalls(), 0);
  assert.match(availableAgainFrame, /Update available: Ubume 1\.0\.5/);
  assert.match(availableAgainFrame, /Current version: 1\.0\.4/);
  assert.doesNotMatch(availableAgainFrame, /Installing Ubume/);
  assert.doesNotMatch(availableAgainFrame, /downloading package/);

  // A canceled attempt may resolve later; it must not replace the restored
  // available state with stale success or failure UI.
  resolvers[0]?.(makeResult());
  await sleep();
  assert.doesNotMatch(harness.output().slice(beforeCancel), /installed successfully/);

  // The cancellation fully resets the attempt lifecycle, so retry works.
  harness.stdin.write("\r");
  await sleep(200);
  assert.equal(runCalls, 2);
  harness.stdin.write("\u001b");
  await sleep(150);
  assert.equal(cancelCalls, 2);
  assert.equal(harness.onSkipCalls(), 0);
  harness.cleanup();
});

test("Escape immediately after install starts cannot surface stale installer state", async () => {
  let cancelCalls = 0;
  const runUpdate: RunUpdateFn = () => ({
    result: new Promise<CommandResult>(() => {}),
    cancel: () => { cancelCalls += 1; },
  });
  const harness = renderPanel({ runUpdate });
  await sleep();
  const transitionStart = harness.output().length;

  harness.stdin.write("\r");
  harness.stdin.write("\u001b");
  await sleep(180);

  const transitionOutput = harness.output().slice(transitionStart);
  assert.match(transitionOutput, /Update available: Ubume 1\.0\.5/);
  assert.doesNotMatch(transitionOutput.slice(transitionOutput.lastIndexOf("Update available")), /Installing Ubume/);
  assert.ok(cancelCalls <= 1, "an attempt that reached the runner is canceled at most once");
  assert.equal(harness.onSkipCalls(), 0);
  harness.cleanup();
});
