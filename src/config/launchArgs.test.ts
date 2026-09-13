import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunchArgs } from "./launchArgs.js";

test("parses profile and repeated config overrides", () => {
  const parsed = parseLaunchArgs([
    "--profile",
    "review",
    "--config",
    "model=\"gpt-5.4\"",
    "-c",
    "ubume.mode=\"suggest\"",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, false);
  assert.equal(parsed.value.version, false);
  assert.equal(parsed.value.initialPrompt, null);
  assert.equal(parsed.value.profile, "review");
  assert.deepEqual(parsed.value.configOverrides, [
    "model=\"gpt-5.4\"",
    "ubume.mode=\"suggest\"",
  ]);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--profile",
    "review",
    "--config",
    "model=\"gpt-5.4\"",
    "-c",
    "ubume.mode=\"suggest\"",
  ]);
});

test("rejects missing profile values", () => {
  const parsed = parseLaunchArgs(["--profile"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /--profile/i);
});

test("rejects malformed config payloads", () => {
  const parsed = parseLaunchArgs(["--config", "model"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /key=value/i);
});

test("parses inline profile and config assignments", () => {
  const parsed = parseLaunchArgs([
    "--profile=review",
    "--config=model=\"gpt-5.4-mini\"",
    "-c=ubume.mode=\"auto-edit\"",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.profile, "review");
  assert.deepEqual(parsed.value.configOverrides, [
    "model=\"gpt-5.4-mini\"",
    "ubume.mode=\"auto-edit\"",
  ]);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--profile=review",
    "--config=model=\"gpt-5.4-mini\"",
    "-c=ubume.mode=\"auto-edit\"",
  ]);
});

test("parses model flags as runtime config overrides", () => {
  const parsed = parseLaunchArgs([
    "--model",
    "gpt-5.3-codex",
    "-m",
    "gpt-5.4-mini",
    "Say",
    "READY",
    "only.",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.initialPrompt, "Say READY only.");
  assert.deepEqual(parsed.value.configOverrides, [
    "model=\"gpt-5.3-codex\"",
    "model=\"gpt-5.4-mini\"",
  ]);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--model",
    "gpt-5.3-codex",
    "-m",
    "gpt-5.4-mini",
  ]);
  // Last --model flag wins (same order as layered config)
  assert.equal(parsed.value.modelOverride, "gpt-5.4-mini");
});

test("parses inline model flag assignment", () => {
  const parsed = parseLaunchArgs(["--model=gpt-5.5", "compare", "this"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.initialPrompt, "compare this");
  assert.deepEqual(parsed.value.configOverrides, ["model=\"gpt-5.5\""]);
  assert.deepEqual(parsed.value.passthroughArgs, ["--model=gpt-5.5"]);
  assert.equal(parsed.value.modelOverride, "gpt-5.5");
});

test("modelOverride is null when no --model flag is given", () => {
  const parsed = parseLaunchArgs(["--profile", "review", "some", "prompt"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.modelOverride, null);
});

test("rejects missing model flag values", () => {
  const parsed = parseLaunchArgs(["--model"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /--model/i);
});

test("parses help and version flags without passthrough", () => {
  const parsed = parseLaunchArgs(["--help", "-v"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, true);
  assert.equal(parsed.value.version, true);
  assert.equal(parsed.value.initialPrompt, null);
  assert.deepEqual(parsed.value.passthroughArgs, []);
});

test("parses positional arguments as an initial prompt", () => {
  const parsed = parseLaunchArgs(["--profile", "review", "explain", "this", "repo"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.profile, "review");
  assert.equal(parsed.value.initialPrompt, "explain this repo");
  assert.deepEqual(parsed.value.passthroughArgs, ["--profile", "review"]);
});

test("parses arguments after -- as an initial prompt", () => {
  const parsed = parseLaunchArgs(["--", "--help", "as", "text"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, false);
  assert.equal(parsed.value.initialPrompt, "--help as text");
  assert.deepEqual(parsed.value.passthroughArgs, []);
});

test("--no-clear sets noClear to true", () => {
  const parsed = parseLaunchArgs(["--no-clear"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
});

test("noClear defaults to false when --no-clear is absent", () => {
  const parsed = parseLaunchArgs(["--profile", "review"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, false);
});

test("--no-clear does not consume the next argument as a value", () => {
  const parsed = parseLaunchArgs(["--no-clear", "my prompt here"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
  assert.equal(parsed.value.initialPrompt, "my prompt here");
});

test("--no-clear can be combined with other flags", () => {
  const parsed = parseLaunchArgs(["--no-clear", "--profile", "fast", "do something"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
  assert.equal(parsed.value.profile, "fast");
  assert.equal(parsed.value.initialPrompt, "do something");
});
