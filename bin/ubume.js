#!/usr/bin/env node

import { spawn } from "child_process";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

process.title = "UBUME";

// Pre-rename CODEXA_* variables keep working: copy each into its unset UBUME_* name.
// The Codexa model family keeps its CODEXA_NATIVE_/CUPY_/NUMPY_ names.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("CODEXA_") || /^CODEXA_(NATIVE|CUPY|NUMPY)_/.test(key)) continue;
  const ubumeKey = `UBUME_${key.slice("CODEXA_".length)}`;
  if (process.env[ubumeKey] === undefined) process.env[ubumeKey] = value;
}

function resolveLauncherDebugDir() {
  const dataDir = process.env.UBUME_DATA_DIR?.trim()
    || process.env.CODEXA_DATA_DIR?.trim()
    || (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA?.trim() || process.env.APPDATA?.trim() || join(homedir(), "AppData", "Local"), "Ubume")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Ubume")
        : join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "ubume"));
  return join(dataDir, "debug");
}

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(currentFile));
const forwardArgs = process.argv.slice(2);
const workspaceRoot = process.cwd();
const launcherStartTimeMs = Number(process.env.UBUME_EXEC_TIMING_EPOCH_MS || process.env.CODEXA_EXEC_TIMING_EPOCH_MS) || Date.now();
let launcherPreviousElapsedMs = 0;
let intendedTerminalTitle = "Ubume";

function writeRenderDebugRecord(kind, fields) {
  if (
    process.env.UBUME_RENDER_DEBUG !== "1"
    && process.env.UBUME_DEBUG_RENDER !== "1"
    && process.env.CODEXA_RENDER_DEBUG !== "1"
    && process.env.CODEXA_DEBUG_RENDER !== "1"
  ) {
    return;
  }

  try {
    const debugDir = resolveLauncherDebugDir();
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      process.env.UBUME_RENDER_DEBUG_FILE?.trim()
        || process.env.CODEXA_RENDER_DEBUG_FILE?.trim()
        || join(debugDir, "render-status.log"),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        sessionId: `launcher-${Date.now()}-${process.pid}`,
        kind,
        ...fields,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Debug logging must never disturb launcher startup.
  }
}

function debugLaunch(message, fields = {}) {
  if (process.env.UBUME_DEBUG_LAUNCH !== "1" && process.env.CODEXA_DEBUG_LAUNCH !== "1") {
    return;
  }

  const serializedFields = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  process.stderr.write(`[ubume:launch] ${message}${serializedFields ? ` ${serializedFields}` : ""}\n`);
}

function writeTerminalTitleDebugRecord(fields) {
  if (process.env.UBUME_DEBUG_TERMINAL_TITLE !== "1" && process.env.CODEXA_DEBUG_TERMINAL_TITLE !== "1") {
    return;
  }

  try {
    const debugDir = resolveLauncherDebugDir();
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      process.env.UBUME_TERMINAL_TITLE_DEBUG_FILE?.trim()
        || process.env.CODEXA_TERMINAL_TITLE_DEBUG_FILE?.trim()
        || process.env.UBUME_RENDER_DEBUG_FILE?.trim()
        || process.env.CODEXA_RENDER_DEBUG_FILE?.trim()
        || join(debugDir, "render-status.log"),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        lifecycleState: "launcher",
        ...fields,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Debug logging must never disturb launcher startup.
  }
}

function sanitizeTerminalTitle(title) {
  return String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\x1b/g, "")
    .trim();
}

function normalizeTerminalTitle(title) {
  const cleanTitle = sanitizeTerminalTitle(title);
  if (!cleanTitle || /^[a-zA-Z]:[\\/]/.test(cleanTitle) || /^\\\\/.test(cleanTitle)) {
    return "Ubume";
  }
  return cleanTitle;
}

function recordIntendedTitle(reason, force = true) {
  writeTerminalTitleDebugRecord({
    event: "ubumeTitleSkipped",
    source: `bin/ubume.js:${reason}`,
    title: intendedTerminalTitle,
    reason,
    force,
  });
  writeRenderDebugRecord("title", {
    event: "launcherTitleSkipped",
    source: `bin/ubume.js:${reason}`,
    title: intendedTerminalTitle,
    reason,
    force,
  });
}

function hasFlag(args, longFlag, shortFlag) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === longFlag || arg === shortFlag) return true;
  }
  return false;
}

function readPackageVersion() {
  try {
    const raw = readFileSync(join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function printHelp() {
  const version = readPackageVersion();
  const versionLine = version ? `ubume ${version}` : "ubume";
  console.log(`${versionLine}

Usage:
  ubume
  ubume "explain this repo"
  ubume exec "print the current directory"
  ubume --headless-benchmark "print the current directory"
  ubume [options] [prompt]

Options:
  -h, --help              Show this help text and exit.
  -v, --version           Show the installed Ubume version and exit.
      --headless-benchmark
                           Run Ubume through the headless benchmark path.
      --profile <name>    Load a profile from config.
  -m, --model <name>      Select the model for this launch.
      --reasoning <effort>
                           Reasoning effort for ubume exec: none, minimal, low, medium, high, xhigh.
  -c, --config <key=val>  Override a runtime config value.

Inside Ubume:
  /help                   Show interactive commands.
  /model                  Open model selection.
  /mode                   Open mode selection.
  /exit                   Exit the interactive UI.
`);
}

const isHeadlessExec = forwardArgs[0] === "exec";
const isHeadlessBenchmark = forwardArgs[0] === "--headless-benchmark";
const isHeadlessMode = isHeadlessExec || isHeadlessBenchmark;
const execTimingEnabled = isHeadlessMode
  && (
    process.env.UBUME_EXEC_TIMING === "1"
    || process.env.CODEXA_EXEC_TIMING === "1"
    || forwardArgs.includes("--timing")
    || forwardArgs.includes("--benchmark-diagnostics")
  );
const parentStdinIsTTY = Boolean(process.stdin.isTTY);
const parentStdoutIsTTY = Boolean(process.stdout.isTTY);
const parentStderrIsTTY = Boolean(process.stderr.isTTY);
const parentHasTTY = parentStdinIsTTY && parentStdoutIsTTY;

function markExecTiming(phase, fields = {}) {
  if (!execTimingEnabled) return;
  const elapsedMs = Date.now() - launcherStartTimeMs;
  const deltaMs = elapsedMs - launcherPreviousElapsedMs;
  launcherPreviousElapsedMs = elapsedMs;
  const formattedFields = Object.entries(fields)
    .map(([key, value]) => {
      const serialized = Array.isArray(value) || typeof value === "string"
        ? JSON.stringify(value)
        : String(value);
      return `${key}=${serialized}`;
    })
    .join(" ");
  process.stderr.write(`[ubume exec timing] phase=${phase} elapsed_ms=${elapsedMs} delta_ms=${deltaMs}${formattedFields ? ` ${formattedFields}` : ""}\n`);
}

markExecTiming("launcher_start", { pid: process.pid });

if (!isHeadlessMode && parentHasTTY) {
  intendedTerminalTitle = normalizeTerminalTitle(
    process.env.UBUME_INITIAL_TERMINAL_TITLE
      || process.env.CODEXA_INITIAL_TERMINAL_TITLE
      || "Ubume",
  );
  recordIntendedTitle("launcher-startup-title-disabled");
}

if (!isHeadlessMode && hasFlag(forwardArgs, "--help", "-h")) {
  printHelp();
  process.exit(0);
}

if (!isHeadlessMode && hasFlag(forwardArgs, "--version", "-v")) {
  console.log(readPackageVersion() ?? "unknown");
  process.exit(0);
}

/**
 * Filters out terminal mouse reporting escape sequences from stdin data.
 * Prevents SGR mouse clicks and scroll events from leaking into the TUI app.
 */
function createMouseFilter() {
  let buffer = "";
  let timer = null;

  return (data) => {
    buffer += data;

    // Clear existing timer
    if (timer) clearTimeout(timer);

    // Check for complete SGR mouse sequences: ESC [ < button ; x ; y M/m
    // Also handle scroll events: button 64/96 (scroll up), 65/97 (scroll down)
    const sgrMouseRegex = /\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]/g;
    let hasFullSequence = sgrMouseRegex.test(buffer);

    // If we have a complete sequence, filter and emit immediately
    if (hasFullSequence) {
      buffer = buffer.replace(sgrMouseRegex, "");
      return buffer;
    }

    // If we have partial SGR start, wait for completion or timeout
    if (/\x1b\[<[0-9]*;?[0-9]*;?[0-9]*$/.test(buffer)) {
      timer = setTimeout(() => {
        // Timeout: assume incomplete mouse sequence, just emit filtered buffer
        timer = null;
      }, 50);
      return null; // Wait for more data
    }

    // Otherwise, emit immediately (normal input)
    return buffer;
  };
}

const bunExecutable = process.env.UBUME_BUN_EXECUTABLE?.trim()
  || process.env.CODEXA_BUN_EXECUTABLE?.trim()
  || (process.platform === "win32" ? "bun.exe" : "bun");

const appEntry = join(packageRoot, "src", "index.tsx");
const execEntry = join(packageRoot, "src", "exec.ts");
const bunEntry = isHeadlessMode ? execEntry : appEntry;
const bunForwardArgs = isHeadlessMode ? forwardArgs.slice(1) : forwardArgs;

// Detect if parent process has a real TTY
const childStdio = isHeadlessMode
  ? ["ignore", "inherit", "inherit"]
  : parentHasTTY
    ? ["inherit", "inherit", "inherit"]
    : ["pipe", "pipe", "pipe"];

debugLaunch("resolved launch mode", {
  mode: isHeadlessMode ? "headless" : "interactive-ui",
  stdinIsTTY: parentStdinIsTTY,
  stdoutIsTTY: parentStdoutIsTTY,
  stderrIsTTY: parentStderrIsTTY,
  TERM: process.env.TERM,
  WT_SESSION: process.env.WT_SESSION,
  TERM_PROGRAM: process.env.TERM_PROGRAM,
  argv: process.argv,
  childStdio,
});

markExecTiming("bun_spawn_start", { executable: bunExecutable });
if (!isHeadlessMode && parentHasTTY) {
  recordIntendedTitle("before-bun-spawn-disabled");
}

const child = spawn(
  bunExecutable,
  ["run", "--silent", bunEntry, ...(bunForwardArgs.length > 0 ? ["--", ...bunForwardArgs] : [])],
  {
    cwd: workspaceRoot,
    stdio: childStdio,
    env: {
      ...process.env,
      CODEX_WORKSPACE_ROOT: workspaceRoot,
      UBUME_LAUNCH_KIND: "installed-bin",
      UBUME_PACKAGE_ROOT: packageRoot,
      UBUME_LAUNCHER_SCRIPT: currentFile,
      UBUME_RELAUNCH_EXECUTABLE: process.execPath,
      UBUME_RELAUNCH_ARGS: JSON.stringify([currentFile, ...forwardArgs]),
      UBUME_PARENT_HAS_TTY: parentHasTTY ? "1" : "0",
      UBUME_HEADLESS_BENCHMARK: isHeadlessBenchmark ? "1" : "0",
      UBUME_EXEC_TIMING_EPOCH_MS: String(launcherStartTimeMs),
      UBUME_INITIAL_TERMINAL_TITLE: intendedTerminalTitle,
    },
  },
);

child.once("spawn", () => {
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("after-bun-spawn-disabled");
  }
});

if (!isHeadlessMode && !parentHasTTY) {
  const mouseFilter = createMouseFilter();

  process.stdin.on("data", (data) => {
    const filtered = mouseFilter(data);
    if (filtered) {
      child.stdin.write(filtered);
    }
  });

  process.stdin.on("end", () => {
    child.stdin.end();
  });

  process.stdin.on("error", (error) => {
    console.error(`stdin error: ${error.message}`);
  });

  child.stdin.on("error", (error) => {
    // Ignore broken pipe errors
    if (error.code !== "EPIPE") {
      console.error(`child stdin error: ${error.message}`);
    }
  });
}

if (!isHeadlessMode) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
}

child.on("error", (error) => {
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("bun-spawn-error-disabled");
  }
  markExecTiming("bun_spawn_error", { message: error.message });
  console.error(`Failed to launch Bun: ${error.message}`);
  console.error("Bun is required to launch ubume. Install Bun, then run this command again.");
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("bun-close-disabled");
  }
  markExecTiming("launcher_exit", { exit_code: code ?? 0, signal: signal ?? null });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
