import type { ChildProcess } from "child_process";
import {
  runCommand,
  runShellCommand,
  type CommandResult,
  type CommandSpec,
  type CommandStreamHandlers,
} from "../process/CommandRunner.js";
import { UBUME_NPM_PACKAGE } from "./updateCheck.js";

export type GlobalPackageManager = "npm" | "pnpm" | "yarn" | "bun";

const UPDATE_TIMEOUT_MS = 300_000;

const PACKAGE_SPEC = `${UBUME_NPM_PACKAGE}@latest`;

// Yarn Classic only — Yarn Berry (v2+) removed `yarn global`, but Berry installs
// don't produce the global launcher paths we detect, so Classic is the only case.
const UPDATE_ARGV: Record<GlobalPackageManager, readonly string[]> = {
  npm: ["npm", "install", "-g", PACKAGE_SPEC],
  pnpm: ["pnpm", "add", "-g", PACKAGE_SPEC],
  yarn: ["yarn", "global", "add", PACKAGE_SPEC],
  bun: ["bun", "add", "-g", PACKAGE_SPEC],
};

/**
 * Infers which package manager owns the global Ubume install from the
 * launcher script location (UBUME_LAUNCHER_SCRIPT / CODEXA_LAUNCHER_SCRIPT, set by bin/ubume.js).
 */
export function detectGlobalPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  launcherPathOverride?: string,
): GlobalPackageManager {
  const launcherPath = launcherPathOverride ?? env.UBUME_LAUNCHER_SCRIPT ?? env.CODEXA_LAUNCHER_SCRIPT ?? process.argv[1] ?? "";
  const normalized = launcherPath.toLowerCase().replace(/\\/g, "/");
  if (!normalized) return "npm";

  if (normalized.includes("pnpm")) return "pnpm";
  if (normalized.includes("/.bun/") || normalized.includes("/bun/install/global/")) return "bun";
  if (normalized.includes("/.yarn/") || normalized.includes("/yarn/") || normalized.includes(".config/yarn")) {
    return "yarn";
  }
  return "npm";
}

export function getUpdateCommand(pm: GlobalPackageManager): {
  displayCommand: string;
  argv: readonly string[];
} {
  const argv = UPDATE_ARGV[pm];
  return { displayCommand: argv.join(" "), argv };
}

export interface RunUpdateCommandDeps {
  platform?: NodeJS.Platform;
  cwd?: string;
  runCommandFn?: (
    spec: CommandSpec,
    handlers?: CommandStreamHandlers,
  ) => { child: ChildProcess; result: Promise<CommandResult>; cancel: () => void };
  runShellCommandFn?: (
    command: string,
    options: Pick<CommandSpec, "cwd" | "env" | "timeoutMs">,
    handlers?: CommandStreamHandlers,
  ) => { child: ChildProcess; result: Promise<CommandResult>; cancel: () => void };
}

/**
 * Runs the global update command for the detected package manager.
 * POSIX spawns the argv directly; Windows routes the constant, whitelisted
 * command string through cmd.exe so .cmd shims (npm.cmd, pnpm.cmd) resolve —
 * spawning them without a shell throws EINVAL on Node >= 18.20.
 */
export function runUpdateCommand(
  pm: GlobalPackageManager,
  handlers: CommandStreamHandlers = {},
  deps: RunUpdateCommandDeps = {},
): { result: Promise<CommandResult>; cancel: () => void } {
  const platform = deps.platform ?? process.platform;
  const cwd = deps.cwd ?? process.cwd();
  const { displayCommand, argv } = getUpdateCommand(pm);

  if (platform === "win32") {
    const runShell = deps.runShellCommandFn ?? runShellCommand;
    const { result, cancel } = runShell(displayCommand, { cwd, timeoutMs: UPDATE_TIMEOUT_MS }, handlers);
    return { result, cancel };
  }

  const run = deps.runCommandFn ?? runCommand;
  const { result, cancel } = run(
    { executable: argv[0]!, args: [...argv.slice(1)], cwd, timeoutMs: UPDATE_TIMEOUT_MS },
    handlers,
  );
  return { result, cancel };
}

const PERMISSION_STDERR_RE = /EACCES|EPERM|permission denied/i;

/** npm reports EACCES via stderr with a nonzero exit, not as a spawn error. */
export function isPermissionError(result: CommandResult): boolean {
  if (result.errorCode === "EACCES" || result.errorCode === "EPERM") return true;
  return result.exitCode !== 0 && PERMISSION_STDERR_RE.test(result.stderr);
}

export function formatPermissionGuidance(pm: GlobalPackageManager): string {
  const { displayCommand } = getUpdateCommand(pm);
  const lines = [
    `${pm} could not write to its global package directory, so the update was not installed.`,
  ];
  if (pm === "npm") {
    lines.push(
      "Check where global packages are installed with `npm config get prefix` and make sure that directory is writable by your user, or switch to a user-writable prefix (for example `npm config set prefix ~/.npm-global`, then add its bin directory to PATH).",
    );
  } else {
    lines.push(`Make sure the ${pm} global package directory is writable by your user.`);
  }
  lines.push(`You can also run the command manually in a terminal with the right permissions: ${displayCommand}`);
  return lines.join("\n");
}
