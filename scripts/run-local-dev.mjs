#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(currentFile));
const forwardArgs = process.argv.slice(2);
export const DEFAULT_NATIVE_MODEL_ROOT = join(homedir(), "Development", "2-Python", "31-LLM (PyTorch)");

/**
 * Resolves which local-repo source file the dev launcher runs, and the args to
 * forward to it. Interactive launches run src/index.tsx; `exec` and
 * `--headless-benchmark` run the headless src/exec.ts. Exported so tests can
 * prove the dev launcher always resolves to the LOCAL checkout.
 */
export function resolveLocalDevEntry(root, args) {
  const isHeadlessExec = args[0] === "exec";
  const isHeadlessBenchmark = args[0] === "--headless-benchmark";
  const isHeadlessMode = isHeadlessExec || isHeadlessBenchmark;
  return {
    isHeadlessMode,
    isHeadlessExec,
    isHeadlessBenchmark,
    entry: isHeadlessMode
      ? join(root, "src", "exec.ts")
      : join(root, "src", "index.tsx"),
    entryArgs: isHeadlessMode ? args.slice(1) : args,
  };
}

/** Resolve the native Codexa model chat command used by `ubume-dev native`. */
export function resolveNativeChatCommand(env = process.env) {
  const modelRoot = env.CODEXA_NATIVE_MODEL_ROOT?.trim()
    || DEFAULT_NATIVE_MODEL_ROOT;
  const executable = env.CODEXA_NATIVE_PYTHON?.trim()
    || join(modelRoot, ".venv", "bin", "python");
  const script = join(modelRoot, "scripts", "chat_native.py");
  const checkpoint = env.CODEXA_NATIVE_CHECKPOINT?.trim()
    || join(modelRoot, "checkpoints", "codexa-900m-sft-v2", "latest.pt");
  const tokenizer = env.CODEXA_NATIVE_TOKENIZER?.trim()
    || join(modelRoot, "checkpoints", "tokenizer-base-v1", "tokenizer.json");
  const device = env.CODEXA_NATIVE_DEVICE?.trim() || "cuda";
  return {
    executable,
    cwd: modelRoot,
    requiredPaths: [executable, script, checkpoint, tokenizer],
    args: [
      script,
      "--checkpoint", checkpoint,
      "--tokenizer", tokenizer,
      "--device", device,
    ],
  };
}

/** Resolve the NumPy Codexa checkpoint chat command used by `ubume-dev numpy`. */
export function resolveNumpyChatCommand(env = process.env) {
  const modelRoot = env.CODEXA_NUMPY_MODEL_ROOT?.trim()
    || join(homedir(), "Development", "2-Python", "32-LLM (NumPy)");
  const executable = env.CODEXA_NUMPY_PYTHON?.trim() || "python3";
  const script = join(modelRoot, "scripts", "chat_codexa.py");
  const checkpoint = env.CODEXA_NUMPY_CHECKPOINT?.trim()
    || join(modelRoot, "runs", "pretraining", "pretrain_250m_fineweb_followup_10m", "target_final.npz");
  const tokenizer = env.CODEXA_NUMPY_TOKENIZER?.trim()
    || join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json");
  const device = env.CODEXA_NUMPY_DEVICE?.trim() || "auto";
  return {
    executable,
    cwd: modelRoot,
    requiredPaths: [script, checkpoint, tokenizer],
    args: [script, "--checkpoint", checkpoint, "--tokenizer", tokenizer, "--device", device],
  };
}

const { isHeadlessMode, isHeadlessBenchmark, entry, entryArgs } = resolveLocalDevEntry(repoRoot, forwardArgs);
const isNativeChat = forwardArgs[0] === "native";
const isNumpyChat = forwardArgs[0] === "numpy";
const bunExecutable = process.env.UBUME_BUN_EXECUTABLE?.trim() || process.env.CODEXA_BUN_EXECUTABLE?.trim()
  || (process.platform === "win32" ? "bun.exe" : "bun");

function hasFlag(args, longFlag, shortFlag) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === longFlag || arg === shortFlag) return true;
  }
  return false;
}

function readPackageVersion() {
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function formatLocalDevVersion() {
  const version = readPackageVersion();
  return version ? `${version}-dev local` : "unknown-dev local";
}

function printHelp() {
  console.log(`ubume-dev ${formatLocalDevVersion()}

Usage:
  ubume-dev
  ubume-dev native
  ubume-dev numpy
  ubume-dev "explain this repo"
  ubume-dev exec "print the current directory"
  ubume-dev [options] [prompt]

This command runs the local repository source with UBUME_CHANNEL=local-dev.
It does not replace or modify the published ubume command.

ubume-dev native talks directly to the local Codexa 900M SFT checkpoint
through native PyTorch inference. It does not use LM Studio or GGUF.
ubume-dev numpy talks directly to the local NumPy 250M checkpoint.
`);
}

function launch() {
  if (process.env.UBUME_DEBUG_LAUNCH === "1" || process.env.CODEXA_DEBUG_LAUNCH === "1") {
    process.stderr.write(
      `[ubume-dev:launch] source=local-repo channel=local-dev version=${formatLocalDevVersion()} entry=${entry}\n`,
    );
  }

  if (!isHeadlessMode && hasFlag(forwardArgs, "--help", "-h")) {
    printHelp();
    process.exit(0);
  }

  if (!isHeadlessMode && hasFlag(forwardArgs, "--version", "-v")) {
    console.log(formatLocalDevVersion());
    process.exit(0);
  }

  if (isNativeChat) {
    const native = resolveNativeChatCommand();
    const missing = native.requiredPaths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      console.error("Codexa native chat is not available because required files are missing:");
      for (const path of missing) console.error(`  ${path}`);
      console.error("Set CODEXA_NATIVE_MODEL_ROOT if the model repository moved.");
      process.exit(1);
    }
    const child = spawn(native.executable, [...native.args, ...forwardArgs.slice(1)], {
      cwd: native.cwd,
      stdio: "inherit",
      env: { ...process.env, UBUME_CHANNEL: "local-dev-native" },
    });
    child.on("error", (error) => {
      console.error(`Failed to launch Codexa native chat: ${error.message}`);
      process.exit(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (isNumpyChat) {
    const numpy = resolveNumpyChatCommand();
    const missing = numpy.requiredPaths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      console.error("Codexa NumPy chat is not available because required files are missing:");
      for (const path of missing) console.error(`  ${path}`);
      console.error("Set CODEXA_NUMPY_MODEL_ROOT if the model repository moved.");
      process.exit(1);
    }
    const child = spawn(numpy.executable, [...numpy.args, ...forwardArgs.slice(1)], {
      cwd: numpy.cwd,
      stdio: "inherit",
      env: { ...process.env, UBUME_CHANNEL: "local-dev-numpy" },
    });
    child.on("error", (error) => {
      console.error(`Failed to launch Codexa NumPy chat: ${error.message}`);
      process.exit(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  const child = spawn(
    bunExecutable,
    ["run", "--silent", entry, ...(entryArgs.length > 0 ? ["--", ...entryArgs] : [])],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_WORKSPACE_ROOT: process.cwd(),
        UBUME_CHANNEL: "local-dev",
        UBUME_LAUNCH_KIND: "dev-run",
        UBUME_PACKAGE_ROOT: repoRoot,
        UBUME_LAUNCHER_SCRIPT: currentFile,
        UBUME_RELAUNCH_EXECUTABLE: process.execPath,
        UBUME_RELAUNCH_ARGS: JSON.stringify([currentFile, ...forwardArgs]),
        UBUME_HEADLESS_BENCHMARK: isHeadlessBenchmark ? "1" : "0",
      },
    },
  );

  child.on("error", (error) => {
    console.error(`Failed to launch local Ubume: ${error.message}`);
    console.error("Bun is required to launch ubume-dev. Install Bun, then run this command again.");
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

// Only launch when executed directly (not when imported by tests).
if (currentFile === process.argv[1]) {
  launch();
}
