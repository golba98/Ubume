import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexCliCapabilities } from "./codexCapabilities.js";

test("detects exec help flags and strips ANSI noise", () => {
  const capabilities = parseCodexCliCapabilities(
    "\u001B[32mOptions:\u001B[0m\n  --ask-for-approval <policy>\n  --sandbox <mode>\n  -c, --config <key=value>\n  -i, --image <file>\n",
    "Global options:\n  --ask-for-approval <policy>\n",
  );

  assert.deepEqual(capabilities, {
    askForApproval: true,
    sandbox: true,
    config: true,
    fullAuto: false,
    image: true,
  });
});

test("does not promote top-level approval flags into exec capabilities", () => {
  const capabilities = parseCodexCliCapabilities(
    "Usage: codex exec [OPTIONS]\n  --sandbox <mode>\n  --full-auto\n",
    "Global options:\n  --ask-for-approval <policy>\n  --sandbox <mode>\n  --full-auto\n",
  );

  assert.deepEqual(capabilities, {
    askForApproval: false,
    sandbox: true,
    config: false,
    fullAuto: true,
    image: false,
  });
});

test("requires exact option tokens instead of prose guesses", () => {
  const capabilities = parseCodexCliCapabilities(
    "This build documents ask-for-approval compatibility in prose only.\nIt also mentions sandbox_mode in config docs.\n",
    "Use full auto mode for trusted environments.\n",
  );

  assert.deepEqual(capabilities, {
    askForApproval: false,
    sandbox: false,
    config: false,
    fullAuto: false,
    image: false,
  });
});
