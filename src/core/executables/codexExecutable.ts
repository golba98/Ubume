import { spawn } from "child_process";
import { join } from "path";
import { runCommand } from "../process/CommandRunner.js";
import { buildSpawnSpec, resolveExecutable } from "./executableResolver.js";

type CommandRunner = typeof runCommand;

let cachedExecutable: string | null = null;
let resolveInFlight: Promise<string> | null = null;

interface SpawnOptions {
  stdio: ["ignore" | "pipe", "pipe", "pipe"];
}

export interface CapturedProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function resetCodexExecutableCacheForTests(): void {
  cachedExecutable = null;
}

export async function resolveCodexExecutable(options?: {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
}): Promise<string> {
  if (!options?.configuredPath && !options?.runCommandImpl && cachedExecutable !== null) {
    return cachedExecutable;
  }

  if (!options?.configuredPath && !options?.runCommandImpl) {
    if (resolveInFlight) return resolveInFlight;

    resolveInFlight = (async () => {
      const result = await doResolveCodexExecutable(options);
      cachedExecutable = result;
      return result;
    })();

    try {
      return await resolveInFlight;
    } finally {
      resolveInFlight = null;
    }
  }

  return doResolveCodexExecutable(options);
}

async function doResolveCodexExecutable(options?: {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
}): Promise<string> {
  const knownFilePaths: string[] = [];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    knownFilePaths.push(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "codex.exe"));
  }

  return resolveExecutable({
    runCommandImpl: options?.runCommandImpl,
    cwd: options?.cwd,
    configuredPath: options?.configuredPath,
    envOverrides: ["CODEX_EXECUTABLE"],
    commandNames: process.platform === "win32"
      ? ["codex.cmd", "codex.exe", "codex"]
      : ["codex"],
    knownFilePaths,
    label: "codex",
  });
}

export function formatCodexLaunchError(err: NodeJS.ErrnoException): string {
  const detail = err.message ? `\n\nDetails: ${err.message}` : "";

  if (err.code === "ENOENT") {
    return [
      "Codex executable was not found in PATH.",
      "Set CODEX_EXECUTABLE to your working command/path, then restart Ubume.",
      "Alternative: install CLI with `npm install -g @openai/codex`.",
    ].join("\n") + detail;
  }

  if (err.code === "EACCES" || err.code === "EPERM") {
    return [
      "Codex appears installed but this process cannot launch it (permission blocked).",
      "Set CODEX_EXECUTABLE to a working CLI command/path and restart Ubume.",
      "Windows note: Codex docs recommend WSL for the best CLI experience.",
    ].join("\n") + detail;
  }

  return err.message;
}

export function spawnCodexProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const spec = buildSpawnSpec(executable, args);
  if (!spec.executable) throw new Error("Codex executable path is empty.");
  return spawn(spec.executable, spec.args, { ...options, shell: false });
}

export function captureCodexProcessOutput(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<CapturedProcessOutput> {
  return new Promise<CapturedProcessOutput>((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnCodexProcess(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      proc.kill();
      const error = new Error(`Timed out waiting for Codex command: ${args.join(" ")}`) as NodeJS.ErrnoException;
      error.code = "ETIME";
      finish(() => reject(error));
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      finish(() => reject(error));
    });

    proc.on("close", (exitCode) => {
      finish(() => resolve({
        exitCode,
        stdout,
        stderr,
      }));
    });
  });
}
