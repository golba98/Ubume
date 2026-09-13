import { statSync } from "fs";
import { basename, join, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveWorkspacePath } from "./workspaceGuard.js";
import { normalizeWorkspaceRoot } from "./workspaceRoot.js";
import { UBUME_CHANNEL_ENV, LOCAL_DEV_CHANNEL, isLocalDevChannel } from "../version/channel.js";

export type LaunchKind = "installed-bin" | "dev-run";

export interface LaunchContext {
  workspaceRoot: string;
  packageRoot: string;
  launchKind: LaunchKind;
  launcherScriptPath?: string;
  relaunchExecutable: string;
  relaunchArgs: string[];
}

export interface ResolveLaunchContextOptions {
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  packageRoot?: string;
  execPath?: string;
  hasBunRuntime?: boolean;
  forwardArgs?: string[];
}

export interface WorkspaceCommandContext {
  root: string;
  summaryMessage: string;
}

export interface WorkspaceRelaunchPlan {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  targetWorkspaceRoot: string;
}

export type WorkspaceRelaunchPlanResult =
  | { ok: true; plan: WorkspaceRelaunchPlan }
  | { ok: false; message: string };

const ENV_KEYS = {
  workspaceRoot: "CODEX_WORKSPACE_ROOT",
  launchKind: "UBUME_LAUNCH_KIND",
  packageRoot: "UBUME_PACKAGE_ROOT",
  launcherScript: "UBUME_LAUNCHER_SCRIPT",
  relaunchExecutable: "UBUME_RELAUNCH_EXECUTABLE",
  relaunchArgs: "UBUME_RELAUNCH_ARGS",
} as const;

function getDefaultPackageRoot(): string {
  return normalizeWorkspaceRoot(resolve(fileURLToPath(new URL(".", import.meta.url)), "..", ".."));
}

function parseRelaunchArgs(raw: string | undefined): string[] | null {
  const value = raw?.trim();
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isBunExecutable(execPath: string): boolean {
  return basename(execPath).toLowerCase().startsWith("bun");
}

function getDevRelaunchExecutable(execPath: string, hasBunRuntime: boolean): string {
  if (hasBunRuntime || isBunExecutable(execPath)) {
    return execPath;
  }

  return "bun";
}

function buildInstalledRelaunchArgs(launcherScriptPath: string, forwardArgs: readonly string[]): string[] {
  return [launcherScriptPath, ...forwardArgs];
}

function buildDevRelaunchArgs(packageRoot: string, forwardArgs: readonly string[]): string[] {
  const args = ["run", "--silent", join(packageRoot, "src", "index.tsx")];
  if (forwardArgs.length > 0) {
    args.push("--", ...forwardArgs);
  }
  return args;
}

export function resolveLaunchContext(options: ResolveLaunchContextOptions = {}): LaunchContext {
  const env = options.env ?? process.env;
  const workspaceRoot = normalizeWorkspaceRoot(
    options.workspaceRoot ?? env[ENV_KEYS.workspaceRoot] ?? process.cwd(),
  );
  const packageRoot = normalizeWorkspaceRoot(
    env[ENV_KEYS.packageRoot] ?? options.packageRoot ?? getDefaultPackageRoot(),
  );
  const launchKind = env[ENV_KEYS.launchKind] === "installed-bin" ? "installed-bin" : "dev-run";
  const launcherScriptPath = env[ENV_KEYS.launcherScript]?.trim() || undefined;
  const envRelaunchExecutable = env[ENV_KEYS.relaunchExecutable]?.trim();
  const envRelaunchArgs = parseRelaunchArgs(env[ENV_KEYS.relaunchArgs]);
  const execPath = options.execPath ?? process.execPath;
  const hasBunRuntime = options.hasBunRuntime ?? Boolean(process.versions.bun);
  const forwardArgs = options.forwardArgs ?? process.argv.slice(2);

  if (launchKind === "installed-bin") {
    const resolvedLauncherScript = launcherScriptPath ?? join(packageRoot, "bin", "ubume.js");

    return {
      workspaceRoot,
      packageRoot,
      launchKind,
      launcherScriptPath: resolvedLauncherScript,
      relaunchExecutable: envRelaunchExecutable || execPath,
      relaunchArgs: envRelaunchArgs && envRelaunchArgs.length > 0
        ? envRelaunchArgs
        : buildInstalledRelaunchArgs(resolvedLauncherScript, forwardArgs),
    };
  }

  return {
    workspaceRoot,
    packageRoot,
    launchKind: "dev-run",
    launcherScriptPath,
    relaunchExecutable: envRelaunchExecutable || getDevRelaunchExecutable(execPath, hasBunRuntime),
    relaunchArgs: envRelaunchArgs && envRelaunchArgs.length > 0
      ? envRelaunchArgs
      : buildDevRelaunchArgs(packageRoot, forwardArgs),
  };
}

export function buildWorkspaceCommandContext(launchContext: LaunchContext): WorkspaceCommandContext {
  return {
    root: launchContext.workspaceRoot,
    summaryMessage: buildWorkspaceStatusMessage(launchContext),
  };
}

export function buildWorkspaceStatusMessage(launchContext: LaunchContext): string {
  const lines = [
    "Active workspace:",
    `  ${launchContext.workspaceRoot}`,
    "",
    `Launch mode: ${launchContext.launchKind === "installed-bin" ? "installed ubume" : "dev/repo launch"}`,
    "",
  ];

  if (launchContext.launchKind === "dev-run") {
    lines.push(
      "This session was started from a local dev launch.",
      "Recommended setup:",
      "  npm run install:dev-bin",
      "  which ubume-dev",
      "  cd <target-folder>",
      "  ubume-dev",
      "",
      "Quick recovery from here:",
      "  /workspace relaunch <path>",
    );
  } else {
    lines.push(
      "This session is locked to the folder where you launched ubume.",
      "Use /workspace relaunch <path> to restart into another folder from inside this UI.",
    );
  }

  return lines.join("\n");
}

export function buildDevLaunchNotice(launchContext: LaunchContext): string | null {
  if (launchContext.launchKind !== "dev-run") {
    return null;
  }

  return [
    "Ready. Type a prompt, run !shell, or use /command.",
    "Tip: /workspace relaunch <path>",
  ].join("\n");
}

export function guardWorkspaceRelaunch(busy: boolean): { allowed: boolean; message?: string } {
  if (!busy) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message: "Finish the current run before relaunching into another workspace.",
  };
}

function buildRelaunchEnv(
  launchContext: LaunchContext,
  targetWorkspaceRoot: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [ENV_KEYS.workspaceRoot]: targetWorkspaceRoot,
    [ENV_KEYS.launchKind]: launchContext.launchKind,
    [ENV_KEYS.packageRoot]: launchContext.packageRoot,
    [ENV_KEYS.launcherScript]: launchContext.launcherScriptPath ?? "",
    [ENV_KEYS.relaunchExecutable]: launchContext.relaunchExecutable,
    [ENV_KEYS.relaunchArgs]: JSON.stringify(launchContext.relaunchArgs),
    [UBUME_CHANNEL_ENV]: isLocalDevChannel(baseEnv) ? LOCAL_DEV_CHANNEL : baseEnv[UBUME_CHANNEL_ENV],
  };
}

export function createWorkspaceRelaunchPlan(
  targetInput: string,
  launchContext: LaunchContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): WorkspaceRelaunchPlanResult {
  const trimmedTarget = targetInput.trim();
  if (!trimmedTarget) {
    return { ok: false, message: "Usage: /workspace relaunch <path>" };
  }

  const targetWorkspaceRoot = normalizeWorkspaceRoot(
    resolveWorkspacePath(trimmedTarget, launchContext.workspaceRoot),
  );

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(targetWorkspaceRoot);
  } catch {
    return {
      ok: false,
      message: `Workspace relaunch failed: ${targetWorkspaceRoot} does not exist.`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      message: `Workspace relaunch failed: ${targetWorkspaceRoot} is not a directory.`,
    };
  }

  return {
    ok: true,
    plan: {
      executable: launchContext.relaunchExecutable,
      args: launchContext.relaunchArgs,
      cwd: targetWorkspaceRoot,
      env: buildRelaunchEnv(launchContext, targetWorkspaceRoot, baseEnv),
      targetWorkspaceRoot,
    },
  };
}
