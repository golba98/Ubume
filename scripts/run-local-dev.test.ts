import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_NATIVE_MODEL_ROOT, resolveLocalDevEntry, resolveNativeChatCommand, resolveNumpyChatCommand } from "./run-local-dev.mjs";
import { createUbumeDevShim, SHIM_NAMES } from "./install-local-dev-bin.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

test("resolveLocalDevEntry resolves interactive launches to the local repo src/index.tsx", () => {
  const resolved = resolveLocalDevEntry(repoRoot, []);
  assert.equal(resolved.isHeadlessMode, false);
  assert.equal(resolved.entry, join(repoRoot, "src", "index.tsx"));
  assert.deepEqual(resolved.entryArgs, []);
});

test("resolveLocalDevEntry forwards interactive prompt args to src/index.tsx", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["explain this repo", "--model", "x"]);
  assert.equal(resolved.entry, join(repoRoot, "src", "index.tsx"));
  assert.deepEqual(resolved.entryArgs, ["explain this repo", "--model", "x"]);
});

test("resolveLocalDevEntry resolves `exec` to the headless src/exec.ts", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["exec", "print the dir"]);
  assert.equal(resolved.isHeadlessMode, true);
  assert.equal(resolved.isHeadlessExec, true);
  assert.equal(resolved.entry, join(repoRoot, "src", "exec.ts"));
  assert.deepEqual(resolved.entryArgs, ["print the dir"]);
});

test("resolveLocalDevEntry resolves --headless-benchmark to src/exec.ts", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["--headless-benchmark", "x"]);
  assert.equal(resolved.isHeadlessMode, true);
  assert.equal(resolved.isHeadlessBenchmark, true);
  assert.equal(resolved.entry, join(repoRoot, "src", "exec.ts"));
});

test("resolveNativeChatCommand targets the native SFT v2 checkpoint", () => {
  const modelRoot = join(tmpdir(), "Ubume model");
  const resolved = resolveNativeChatCommand({
    CODEXA_NATIVE_MODEL_ROOT: modelRoot,
    CODEXA_NATIVE_DEVICE: "cpu",
  });

  assert.equal(resolved.cwd, modelRoot);
  assert.equal(resolved.executable, join(modelRoot, ".venv", "bin", "python"));
  assert.deepEqual(resolved.args, [
    join(modelRoot, "scripts", "chat_native.py"),
    "--checkpoint", join(modelRoot, "checkpoints", "codexa-900m-sft-v2", "latest.pt"),
    "--tokenizer", join(modelRoot, "checkpoints", "tokenizer-base-v1", "tokenizer.json"),
    "--device", "cpu",
  ]);
});

test("resolveNativeChatCommand defaults to the canonical PyTorch checkout", () => {
  const resolved = resolveNativeChatCommand({});
  assert.equal(resolved.cwd, DEFAULT_NATIVE_MODEL_ROOT);
  assert.equal(resolved.executable, join(DEFAULT_NATIVE_MODEL_ROOT, ".venv", "bin", "python"));
  assert.deepEqual(resolved.requiredPaths, [
    join(DEFAULT_NATIVE_MODEL_ROOT, ".venv", "bin", "python"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "scripts", "chat_native.py"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "checkpoints", "codexa-900m-sft-v2", "latest.pt"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "checkpoints", "tokenizer-base-v1", "tokenizer.json"),
  ]);
});

test("resolveNumpyChatCommand targets the trained NumPy follow-up checkpoint", () => {
  const modelRoot = join(tmpdir(), "NumPy model");
  const resolved = resolveNumpyChatCommand({
    CODEXA_NUMPY_MODEL_ROOT: modelRoot,
    CODEXA_NUMPY_DEVICE: "cpu",
  });

  assert.equal(resolved.cwd, modelRoot);
  assert.equal(resolved.executable, "python3");
  assert.deepEqual(resolved.args, [
    join(modelRoot, "scripts", "chat_codexa.py"),
    "--checkpoint", join(modelRoot, "runs", "pretraining", "pretrain_250m_fineweb_followup_10m", "target_final.npz"),
    "--tokenizer", join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json"),
    "--device", "cpu",
  ]);
});

test("createUbumeDevShim installs both ubume-dev and cxd pointing at the local launcher", () => {
  const binDir = mkdtempSync(join(tmpdir(), "ubume-dev-shim-"));
  try {
    const result = createUbumeDevShim({ binDir });
    const launcherPath = join(repoRoot, "scripts", "run-local-dev.mjs");

    assert.equal(result.launcherPath, launcherPath);
    assert.equal(result.shimPaths.length, SHIM_NAMES.length);
    assert.deepEqual([...SHIM_NAMES].sort(), ["codexa-dev", "cxd", "ubd", "ubume-dev"]);

    for (const shimPath of result.shimPaths) {
      // Each shim exists and references the LOCAL run-local-dev.mjs launcher.
      assert.ok(statSync(shimPath).isFile(), `${shimPath} should be a file`);
      const contents = readFileSync(shimPath, "utf8");
      assert.ok(
        contents.includes(launcherPath),
        `${shimPath} should invoke the local launcher (${launcherPath})`,
      );
    }
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
