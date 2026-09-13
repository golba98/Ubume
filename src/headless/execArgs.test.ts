import assert from "node:assert/strict";
import test from "node:test";
import { parseHeadlessExecArgs } from "./execArgs.js";

test("parses ubume exec positional prompt", () => {
  const parsed = parseHeadlessExecArgs(["Print", "the", "directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
  assert.equal(parsed.value.promptPolicy, "raw");
  assert.equal(parsed.value.launchArgs.initialPrompt, "Print the directory");
});

test("parses ubume exec --prompt value", () => {
  const parsed = parseHeadlessExecArgs(["--prompt", "Print the directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
});

test("parses ubume exec --prompt=value", () => {
  const parsed = parseHeadlessExecArgs(["--prompt=Print the directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
});

test("rejects missing and empty prompts", () => {
  const missing = parseHeadlessExecArgs([]);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.error, /missing prompt/i);
  }

  const empty = parseHeadlessExecArgs(["--prompt", "   "]);
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.error, /--prompt/i);
  }
});

test("parses ubume exec --reasoning value", () => {
  const parsed = parseHeadlessExecArgs(["--reasoning", "medium", "Print files"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, ["model_reasoning_effort=medium"]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, ["--reasoning", "medium"]);
});

test("parses ubume exec --reasoning=value", () => {
  const parsed = parseHeadlessExecArgs(["--reasoning=high", "Print files"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, ["model_reasoning_effort=high"]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, ["--reasoning=high"]);
});

test("parses timing and prompt policy flags without forwarding them to Codex", () => {
  const parsed = parseHeadlessExecArgs([
    "--timing",
    "--ubume-prompt-policy",
    "wrapped",
    "Print files",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.timing, true);
  assert.equal(parsed.value.promptPolicy, "wrapped");
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, []);
});

test("rejects invalid prompt policy values", () => {
  const parsed = parseHeadlessExecArgs(["--ubume-prompt-policy", "verbose", "Prompt"]);

  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.error, /ubume-prompt-policy/i);
  }
});

test("accepts the pre-rename --codexa-prompt-policy spelling", () => {
  for (const argv of [["--codexa-prompt-policy", "wrapped", "Prompt"], ["--codexa-prompt-policy=wrapped", "Prompt"]]) {
    const parsed = parseHeadlessExecArgs(argv);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.promptPolicy, "wrapped");
  }
});

test("parses ubume exec --model and --reasoning together", () => {
  const parsed = parseHeadlessExecArgs([
    "--model", "gpt-5.4-mini",
    "--reasoning", "medium",
    "Reply with exactly: UBUME_READY",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Reply with exactly: UBUME_READY");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, [
    "model=\"gpt-5.4-mini\"",
    "model_reasoning_effort=medium",
  ]);
});

test("preserves profile and repeated config overrides", () => {
  const parsed = parseHeadlessExecArgs([
    "--benchmark-diagnostics",
    "--skip-git-repo-check",
    "--profile",
    "bench",
    "--model",
    "gpt-5.4-mini",
    "-c",
    "model_reasoning_effort=medium",
    "--config",
    "sandbox_mode=\"workspace-write\"",
    "--config=approval_policy=\"never\"",
    "Print",
    "files",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.benchmarkDiagnostics, true);
  assert.equal(parsed.value.timing, true);
  assert.equal(parsed.value.prompt, "Print files");
  assert.equal(parsed.value.launchArgs.profile, "bench");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, [
    "model=\"gpt-5.4-mini\"",
    "model_reasoning_effort=medium",
    "sandbox_mode=\"workspace-write\"",
    "approval_policy=\"never\"",
  ]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, [
    "--skip-git-repo-check",
    "--profile",
    "bench",
    "--model",
    "gpt-5.4-mini",
    "-c",
    "model_reasoning_effort=medium",
    "--config",
    "sandbox_mode=\"workspace-write\"",
    "--config=approval_policy=\"never\"",
  ]);
});
