import assert from "node:assert/strict";
import test from "node:test";
import React, { useEffect } from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render, useFocus, useInput, useStdin } from "ink";
import { useStdinRawModeLease } from "./useStdinRawModeLease.js";

// Deliberately does NOT stub resume()/pause(): the bug under test is Node/Bun
// streams flipping stdin into flowing mode, which those stubs would mask.
class TestInput extends PassThrough {
  isTTY = true;
  setRawModeCalls: boolean[] = [];
  readableRemovals = 0;

  setRawMode(enabled: boolean): this {
    this.setRawModeCalls.push(enabled);
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  override removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === "readable") this.readableRemovals += 1;
    return super.removeListener(event, listener);
  }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

const noop = () => {};

/** Mirrors BottomComposer's three stdin holders: useFocus, active useInput, raw 'data' sniffer. */
function Probe({ onInput }: { onInput: (input: string) => void }) {
  const { isFocused } = useFocus({ id: "probe", autoFocus: true });
  const { stdin } = useStdin();
  useEffect(() => {
    stdin.on("data", noop);
    return () => {
      stdin.off("data", noop);
    };
  }, [stdin]);
  useInput((input) => onInput(input), { isActive: isFocused });
  return <Text>{`probe focused=${isFocused}`}</Text>;
}

/** Mirrors App: the same composer element moves between AppShell and TranscriptShell. */
function Host({
  overlay,
  instanceKey,
  lease,
  onInput,
}: {
  overlay: boolean;
  instanceKey: number;
  lease: boolean;
  onInput: (input: string) => void;
}) {
  if (lease) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useStdinRawModeLease();
  }
  const probe = <Probe key={instanceKey} onInput={onInput} />;
  return (
    <Box flexDirection="column">
      {!overlay && <Box key="main">{probe}</Box>}
      {overlay && <Box key="overlay">{probe}</Box>}
    </Box>
  );
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runSwapScenario(lease: boolean) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.on("data", noop);
  const received: string[] = [];
  const onInput = (input: string) => received.push(input);
  const host = (overlay: boolean, instanceKey: number) => (
    <Host overlay={overlay} instanceKey={instanceKey} lease={lease} onInput={onInput} />
  );

  const instance = render(host(true, 0), {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stdout as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await wait(30);
  stdin.readableRemovals = 0;

  // Overlay exit: shell swap (commit B) then the composer instance key bump
  // (commit C), flushed back-to-back so both remounts land in one tick batch,
  // exactly as App does on the startup update overlay exit.
  instance.rerender(host(false, 0));
  instance.rerender(host(false, 1));
  instance.rerender(host(false, 1));
  await tick();
  await tick();

  const readableRemovals = stdin.readableRemovals;
  const flowingAfterSwap = stdin.readableFlowing;
  stdin.write("x");
  await wait(30);

  instance.unmount();
  await wait(10);
  return { readableRemovals, flowingAfterSwap, received, stdin };
}

test("raw-mode lease keeps Ink's readable listener attached across composer shell swaps", async () => {
  const result = await runSwapScenario(true);
  assert.equal(result.readableRemovals, 0, "Ink must never detach its 'readable' listener while the app runs");
  assert.equal(result.flowingAfterSwap, false, "stdin must stay in paused (readable) mode");
  assert.deepEqual(result.received, ["x"], "useInput must still receive keys after the swap");
});

test("without the lease a shell swap plus key bump detaches Ink's readable listener", async () => {
  const result = await runSwapScenario(false);
  assert.ok(result.readableRemovals >= 2, `expected >= 2 readable removals, got ${result.readableRemovals}`);
  assert.equal(result.flowingAfterSwap, true, "two remove/add cycles in one tick flip stdin into flowing mode");
  assert.deepEqual(result.received, [], "Ink's readable consumer is starved once stdin is flowing");
});

test("raw-mode lease is a no-op when raw mode is unsupported", async () => {
  const stdin = new TestInput();
  stdin.isTTY = false;
  const stdout = new TestOutput();
  stdout.on("data", noop);

  function LeaseOnly() {
    useStdinRawModeLease();
    return <Text>lease</Text>;
  }

  const instance = render(<LeaseOnly />, {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stdout as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await wait(20);
  instance.unmount();
  assert.deepEqual(stdin.setRawModeCalls, []);
});
