import assert from "node:assert/strict";
import test from "node:test";
import { getTerminalCapability } from "./terminalCapabilities.js";

test("allows Windows Terminal", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: { WT_SESSION: "1" },
  });

  assert.equal(result.supported, true);
  assert.equal(result.reason, "supported");
  assert.equal(result.warning, undefined);
});

test("allows the VS Code terminal", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: { TERM_PROGRAM: "vscode" },
  });

  assert.equal(result.supported, true);
  assert.equal(result.reason, "supported");
  assert.equal(result.warning, undefined);
});

test("allows modern Windows TTY when TERM is missing but warns", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: {},
  });

  assert.equal(result.supported, true);
  assert.equal(result.reason, "supported");
  assert.match(result.warning ?? "", /continue/i);
});

test("UBUME_FORCE_VT bypasses VT compatibility detection", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: { UBUME_FORCE_VT: "1", TERM: "dumb" },
  });

  assert.equal(result.supported, true);
  assert.equal(result.reason, "supported");
  assert.equal(result.warning, undefined);
});

test("UBUME_REQUIRE_VT hard-fails when Windows VT support is not detected", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "win32",
    env: { UBUME_REQUIRE_VT: "1" },
  });

  assert.equal(result.supported, false);
  assert.equal(result.reason, "unsupported-terminal");
  assert.match(result.message, /UBUME_FORCE_VT=1/i);
});

test("rejects a dumb terminal even when it is interactive", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "linux",
    env: { TERM: "dumb" },
  });

  assert.equal(result.supported, false);
  assert.equal(result.reason, "unsupported-terminal");
});

test("rejects redirected or non-interactive output", () => {
  const result = getTerminalCapability({
    stdinIsTTY: true,
    stdoutIsTTY: false,
    platform: "linux",
    env: { TERM: "xterm-256color" },
  });

  assert.equal(result.supported, false);
  assert.equal(result.reason, "notty");
  assert.match(result.message, /interactive terminal/i);
});
