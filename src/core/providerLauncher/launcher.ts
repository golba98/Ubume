import { spawn, type ChildProcess } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { delimiter, join } from "path";
import { buildSpawnSpec } from "../executables/executableResolver.js";
import { normalizeExecutableValue } from "../process/processValidation.js";
import type { ProviderConfig, ProviderLaunchCommand } from "./types.js";

export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
}

export type ProviderLaunchResult =
  | { status: "completed"; exitCode: number | null; signal: NodeJS.Signals | null; message: string }
  | { status: "disabled"; message: string }
  | { status: "missing-command"; message: string }
  | { status: "spawn-error"; message: string; errorCode?: string };

interface RawModeStream {
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
}

export interface LaunchProviderCliOptions {
  cwd: string;
  stdin?: RawModeStream | null;
  beforeLaunch?: () => void;
  afterLaunch?: () => void;
  spawnImpl?: typeof spawn;
  commandExists?: (executable: string) => Promise<boolean> | boolean;
}

function formatCommand(command: ProviderLaunchCommand): string {
  return [command.executable, ...command.args].join(" ");
}

export function buildProviderLaunchSpec(provider: ProviderConfig, cwd: string): ProviderLaunchSpec | ProviderLaunchResult {
  if (!provider.enabled) {
    return {
      status: "disabled",
      message: `${provider.displayName} is disabled. Configure a command in Ubume's provider settings before launching it.`,
    };
  }

  if (!provider.launchCommand?.executable.trim()) {
    return {
      status: "missing-command",
      message: `${provider.displayName} does not have a launch command configured.`,
    };
  }

  try {
    return {
      executable: normalizeExecutableValue(provider.launchCommand.executable, {
        label: `${provider.displayName} launch command`,
        cwd,
      }),
      args: provider.launchCommand.args,
      cwd,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid launch command.";
    return {
      status: "spawn-error",
      message: `${provider.displayName} has an unsafe launch command. ${message}`,
    };
  }
}

function setRawMode(stdin: RawModeStream | null | undefined, enabled: boolean): void {
  try {
    stdin?.setRawMode?.(enabled);
  } catch {
    // Some test streams and redirected terminals do not support raw-mode changes.
  }
}

function executableLooksLikePath(executable: string): boolean {
  return /[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable);
}

function canAccessExecutable(path: string): boolean {
  try {
    if (process.platform === "win32") {
      return existsSync(path);
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathExecutableCandidates(executable: string): string[] {
  if (process.platform !== "win32" || /\.[A-Za-z0-9_-]+$/.test(executable)) {
    return [executable];
  }

  const pathExt = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"];
  return [executable, ...pathExt.map((ext) => `${executable}${ext.toLowerCase()}`)];
}

export async function commandExistsOnPath(executable: string): Promise<boolean> {
  let candidate: string;
  try {
    candidate = normalizeExecutableValue(executable, {
      label: "Provider launch command",
      allowBareExecutable: true,
    });
  } catch {
    return false;
  }

  const trimmed = candidate.trim();
  if (executableLooksLikePath(trimmed)) {
    return canAccessExecutable(trimmed);
  }

  const pathEntries = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  for (const dir of pathEntries) {
    for (const name of getPathExecutableCandidates(trimmed)) {
      if (canAccessExecutable(join(dir, name))) return true;
    }
  }
  return false;
}

function formatSpawnError(provider: ProviderConfig, executable: string, error: NodeJS.ErrnoException): ProviderLaunchResult {
  if (error.code === "ENOENT") {
    return {
      status: "missing-command",
      message: `${provider.displayName} could not be launched because \`${executable}\` is not installed or not available on PATH.`,
    };
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    return {
      status: "spawn-error",
      errorCode: error.code,
      message: `${provider.displayName} could not be launched because permission was denied for \`${executable}\`.`,
    };
  }

  return {
    status: "spawn-error",
    errorCode: error.code,
    message: `${provider.displayName} could not be launched. ${error.message}`,
  };
}

export async function launchProviderCli(
  provider: ProviderConfig,
  options: LaunchProviderCliOptions,
): Promise<ProviderLaunchResult> {
  const spec = buildProviderLaunchSpec(provider, options.cwd);
  if ("status" in spec) return spec;

  const spawnImpl = options.spawnImpl ?? spawn;
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const available = await commandExists(spec.executable);
  if (!available) {
    return {
      status: "missing-command",
      message: `${provider.displayName} could not be launched because \`${spec.executable}\` is not installed or not available on PATH.`,
    };
  }

  const wasRaw = Boolean(options.stdin?.isRaw);
  options.beforeLaunch?.();
  setRawMode(options.stdin, false);

  try {
    return await new Promise<ProviderLaunchResult>((resolve) => {
      let child: ChildProcess;
      try {
        const spawnSpec = buildSpawnSpec(spec.executable, spec.args);
        if (!spawnSpec.executable) {
          resolve({ status: "spawn-error", message: "Executable path is empty after resolution." });
          return;
        }
        child = spawnImpl(spawnSpec.executable, spawnSpec.args, {
          cwd: spec.cwd,
          shell: false,
          stdio: "inherit",
        });
      } catch (error) {
        resolve(formatSpawnError(provider, spec.executable, error as NodeJS.ErrnoException));
        return;
      }

      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve(formatSpawnError(provider, spec.executable, error));
      });

      child.once("close", (exitCode, signal) => {
        resolve({
          status: "completed",
          exitCode,
          signal,
          message: `${provider.displayName} launch finished${exitCode === null ? "" : ` with exit code ${exitCode}`}.`,
        });
      });
    });
  } finally {
    if (wasRaw) {
      setRawMode(options.stdin, true);
    }
    options.afterLaunch?.();
  }
}

export function describeProviderLaunch(provider: ProviderConfig): string {
  if (!provider.enabled) {
    return `${provider.displayName} is disabled.`;
  }
  return provider.launchCommand
    ? `${provider.displayName}: ${formatCommand(provider.launchCommand)}`
    : `${provider.displayName} has no launch command configured.`;
}
