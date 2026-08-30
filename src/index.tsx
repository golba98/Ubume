import React from "react";
import { render, type Instance, type RenderOptions } from "ink";
import { App } from "./app.js";
import { parseLaunchArgs, type LaunchArgs } from "./config/launchArgs.js";
import { loadSettings } from "./config/persistence.js";
import { APP_NAME, formatTerminalTitlePath } from "./config/settings.js";
import { getTerminalCapability } from "./core/terminal/terminalCapabilities.js";
import * as renderDebug from "./core/perf/renderDebug.js";
import { MIN_VIEWPORT_COLS, MIN_VIEWPORT_ROWS } from "./ui/layout.js";
import {
  setIntendedTerminalTitle,
} from "./core/terminal/terminalTitle.js";
import { resolveWorkspaceRoot } from "./core/workspace/workspaceRoot.js";
import {
  createTerminalModeController,
  writeTerminalControl,
} from "./core/terminal/terminalControl.js";
import { resolveInkRenderInstance, type InkRenderInstance } from "./core/terminal/inkRenderReset.js";
import { resetFrameLockForResize, wrapStdoutWithFrameLock } from "./core/terminal/frameLock.js";

type RenderHandle = Pick<Instance, "clear" | "cleanup" | "waitUntilExit">;

export function resolveKittyKeyboardOptions(
  env: Record<string, string | undefined>,
): RenderOptions["kittyKeyboard"] | undefined {
  // Ink's auto mode probes with CSI ? u. Kitty's response can race Ink's
  // regular input listeners and leak into both the first frame and composer.
  // A direct Kitty session is already known to support the protocol, so enable
  // it without probing. Avoid protocol negotiation in all other terminals.
  if ((env.TERM ?? "").toLowerCase() !== "xterm-kitty") {
    return undefined;
  }

  return {
    mode: "enabled",
    flags: ["disambiguateEscapeCodes"],
  };
}

export interface AppStdout {
  isTTY: boolean;
  write: (chunk: string) => boolean;
  on: (event: "resize" | string, listener: (...args: unknown[]) => void) => void;
  off: (event: "resize" | string, listener: (...args: unknown[]) => void) => void;
  columns?: number;
  rows?: number;
}

export interface StartAppDependencies {
  stdin: Pick<NodeJS.ReadStream, "isTTY">;
  stdout: AppStdout;
  stderr: Pick<NodeJS.WriteStream, "write"> & Partial<Pick<NodeJS.WriteStream, "isTTY">>;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  argv: string[];
  renderApp: (node: React.ReactElement, options?: RenderOptions) => RenderHandle;
  resolveInkInstanceForStdout: (stdout: AppStdout) => InkRenderInstance | null;
  registerExitHandler: (handler: () => void) => void;
}

export interface StartAppResult {
  started: boolean;
  exitCode: number;
}

interface ActiveRootState {
  cleanup: () => void;
}

let activeRoot: ActiveRootState | null = null;

function debugLaunch(env: Record<string, string | undefined>, write: (chunk: string, source: string) => boolean, fields: Record<string, unknown>): void {
  if (env.CODEXA_DEBUG_LAUNCH !== "1") {
    return;
  }

  write(`[codexa:launch] ${JSON.stringify(fields)}\n`, "src/index.tsx:launchDebug");
}

function hasInvalidRestoreDimensions(stdout: Pick<AppStdout, "columns" | "rows">): boolean {
  const cols = stdout.columns;
  const rows = stdout.rows;
  return !Number.isFinite(cols) || !Number.isFinite(rows)
    || (cols ?? 0) < MIN_VIEWPORT_COLS || (rows ?? 0) < MIN_VIEWPORT_ROWS;
}

export function startApp({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  platform = process.platform,
  argv = process.argv.slice(2),
  renderApp = render,
  resolveInkInstanceForStdout = resolveInkRenderInstance,
  registerExitHandler = (handler) => {
    process.on("exit", handler);
  },
}: Partial<StartAppDependencies> = {}): StartAppResult {
  renderDebug.configureRenderDebug(env);

  if (activeRoot) {
    return { started: true, exitCode: 0 };
  }

  // Wrap stdout to implement frame locking, deduplication, and width-safe row
  // padding via \x1b[K injection across the entire TUI.
  const wrappedStdout = wrapStdoutWithFrameLock({ stdout, env });

  const terminal = createTerminalModeController((chunk) => wrappedStdout.write(chunk));
  const writeStdout = (chunk: string, source: string): boolean => terminal.write(chunk, source);

  const writeStderr = (chunk: string, source: string): boolean => {
    return writeTerminalControl((value) => stderr.write(value), "stderr", source, chunk);
  };

  debugLaunch(env, writeStderr, {
    phase: "startApp",
    resolvedLaunchMode: "interactive-ui",
    stdinIsTTY: Boolean(stdin.isTTY),
    stdoutIsTTY: Boolean(stdout.isTTY),
    stderrIsTTY: Boolean(stderr.isTTY),
    TERM: env.TERM,
    WT_SESSION: env.WT_SESSION,
    TERM_PROGRAM: env.TERM_PROGRAM,
    argv,
  });

  const capability = getTerminalCapability({
    stdinIsTTY: Boolean(stdin.isTTY),
    stdoutIsTTY: Boolean(stdout.isTTY),
    platform,
    env,
  });

  if (!capability.supported) {
    writeStderr(`${capability.message}\n`, "src/index.tsx:unsupportedTerminal");
    return { started: false, exitCode: 1 };
  }
  if (capability.warning) {
    writeStderr(`${capability.warning}\n`, "src/index.tsx:terminalCapabilityWarning");
  }

  const parsedLaunchArgs = parseLaunchArgs(argv);
  if (!parsedLaunchArgs.ok) {
    writeStderr(`${parsedLaunchArgs.error}\n`, "src/index.tsx:launchArgs");
    return { started: false, exitCode: 1 };
  }
  const launchArgs: LaunchArgs = parsedLaunchArgs.value;
  // Main chat starts in the normal screen buffer so the startup frame and later
  // transcript rows are owned by native terminal scrollback. Overlay screens
  // enter alternate-screen mode from app.tsx only while an overlay is active.
  const startupWorkspaceRoot = resolveWorkspaceRoot();
  const startupSettings = loadSettings();
  const startupTitle =
    formatTerminalTitlePath(startupWorkspaceRoot, startupSettings.ui.terminalTitleMode) || APP_NAME;
  setIntendedTerminalTitle(startupTitle, {
    force: true,
    reason: "startup-title",
    write: (chunk) => writeStdout(chunk, "src/index.tsx:startup.title"),
  });
  terminal.setMouseReporting(false, "src/index.tsx:startup.nativeScroll");
  terminal.setBracketedPaste(true, "src/index.tsx:startup.bracketedPaste");

  let cleanupDone = false;
  let repaintArmed = false;
  let renderHandle: RenderHandle | null = null;
  let inkInstance: InkRenderInstance | null = null;
  let previousResizeCols = stdout.columns;
  let previousResizeRows = stdout.rows;

  const onResize = () => {
    resetFrameLockForResize(wrappedStdout);
    renderDebug.traceEvent("terminal", "resize", {
      previousCols: previousResizeCols,
      previousRows: previousResizeRows,
      cols: stdout.columns,
      rows: stdout.rows,
      invalid: hasInvalidRestoreDimensions(stdout),
    });
    previousResizeCols = stdout.columns;
    previousResizeRows = stdout.rows;

    if (hasInvalidRestoreDimensions(stdout)) {
      // Transient invalid dimensions (e.g. during maximize/restore on
      // Windows). Keep the previous frame visible and let useTerminalViewport
      // preserve the last renderable layout until valid dimensions return.
      repaintArmed = true;
      return;
    }

    if (repaintArmed) {
      repaintArmed = false;
    }

    // useTerminalViewport owns resize-driven React state. Do not clear the
    // terminal, reset Ink output caches, or force Ink renders here; those
    // imperative paths can produce a transient empty frame during streaming.
  };

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    stdout.off("resize", onResize);
    renderHandle?.cleanup();
    // Restore terminal state: disable mouse reporting and bracketed paste.
    terminal.setMouseReporting(false, "src/index.tsx:cleanup.mouse");
    terminal.setBracketedPaste(false, "src/index.tsx:cleanup.bracketedPaste");
    terminal.setAlternateScreen(false, "src/index.tsx:cleanup.alternateScreen");
    terminal.resetModes();
    activeRoot = null;
  };

  const handleFatal = (error: unknown) => {
    cleanup();
    if (error instanceof Error) {
      writeStderr(`${error.stack || error.message}\n`, "src/index.tsx:fatalError");
    } else if (error) {
      writeStderr(`${String(error)}\n`, "src/index.tsx:fatalUnknown");
    }
    process.exit(1);
  };

  const handleSignal = () => {
    cleanup();
    process.exit(0);
  };

  stdout.on("resize", onResize);
  registerExitHandler(cleanup);

  // Ensure clean teardown on signals and unhandled failures to prevent
  // leaving the terminal in mouse-reporting mode.
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);

  const kittyKeyboard = resolveKittyKeyboardOptions(env);
  renderHandle = renderApp(<App launchArgs={launchArgs} />, {
    ...(kittyKeyboard ? { kittyKeyboard } : {}),
    stdout: wrappedStdout as any,
  });

  // Resolve the real Ink class instance to get access to lastOutput,
  // onRender, calculateLayout, etc.  Gracefully degrades to null in tests.
  inkInstance = resolveInkInstanceForStdout(wrappedStdout);

  // Remove Ink's own resize handler so the app is the sole resize handler.
  // This eliminates the race where Ink's resized() fires alongside our
  // onResize, causing interleaved renders that desync logUpdate.
  if (inkInstance?.unsubscribeResize) {
    inkInstance.unsubscribeResize();
  }

  void renderHandle.waitUntilExit().finally(cleanup);

  activeRoot = { cleanup };
  return { started: true, exitCode: 0 };
}

const isMainModule = Boolean((import.meta as ImportMeta & { main?: boolean }).main);

if (isMainModule) {
  const result = startApp();
  if (!result.started) {
    process.exitCode = result.exitCode;
  }
}
