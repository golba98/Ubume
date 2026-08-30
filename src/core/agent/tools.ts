import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import { runShellCommand, summarizeCommandResult } from "../process/CommandRunner.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import {
  getShellWorkspaceGuardMessage,
  isPathInsideAllowedRoots,
  resolveWorkspacePath,
} from "../workspace/workspaceGuard.js";
import type { AgentToolName } from "./protocol.js";

export interface AgentToolContext {
  workspaceRoot: string;
  runtime: ResolvedRuntimeConfig;
  signal?: AbortSignal;
}

export interface AgentToolResult {
  success: boolean;
  tool: AgentToolName;
  path?: string;
  command?: string;
  paths?: string[];
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  summary?: string;
  error?: string;
}

const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_OUTPUT_LINES = 80;
const SHELL_TIMEOUT_MS = 120_000;

const DANGEROUS_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-[^\n;|&]*r[f]?\b/i,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\bdd\s+.*\bof=/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  />\s*\/dev\/(?:sd|hd|nvme|disk)/i,
];

function preview(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  const sanitized = sanitizeTerminalOutput(text);
  return sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...[truncated]` : sanitized;
}

function trimOutputLines(text: string, preferTail: boolean): string {
  const sanitized = sanitizeTerminalOutput(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = sanitized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length <= MAX_OUTPUT_LINES) return sanitized;
  const visible = preferTail ? lines.slice(-MAX_OUTPUT_LINES) : lines.slice(0, MAX_OUTPUT_LINES);
  const hidden = lines.length - visible.length;
  const marker = `[...${hidden} line${hidden === 1 ? "" : "s"} truncated; showing ${preferTail ? "last" : "first"} ${MAX_OUTPUT_LINES} lines...]`;
  return preferTail
    ? [marker, ...visible].join("\n")
    : [...visible, marker].join("\n");
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function isReadOnly(runtime: ResolvedRuntimeConfig): boolean {
  return runtime.policy.sandboxMode === "read-only";
}

function canWrite(runtime: ResolvedRuntimeConfig): boolean {
  return runtime.policy.sandboxMode === "workspace-write"
    || runtime.policy.sandboxMode === "danger-full-access";
}

function relativeDisplay(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  return relative || ".";
}

function hasCargoManifest(workspaceRoot: string): boolean {
  return existsSync(path.join(workspaceRoot, "Cargo.toml"));
}

function rustCommandGuard(command: string, context: AgentToolContext): string | null {
  if (!hasCargoManifest(context.workspaceRoot)) return null;
  const normalized = command.trim().replace(/\s+/g, " ");
  const tokens = normalized.split(" ");
  if (tokens[0] !== "rustc") return null;

  let targetIndex = 1;
  while (tokens[targetIndex]?.startsWith("-")) targetIndex += 1;
  const target = tokens[targetIndex];
  if (!target?.endsWith(".rs")) return null;

  const resolved = path.resolve(context.workspaceRoot, target);
  const rootMain = path.join(context.workspaceRoot, "main.rs");
  if (resolved !== rootMain || !existsSync(rootMain)) {
    return "This workspace has Cargo.toml. Use `cargo check` to validate or `cargo run` to run instead of compiling a Rust source file directly with rustc.";
  }
  return null;
}

function resolveAllowedPath(rawPath: string, context: AgentToolContext): { ok: true; absolutePath: string; relativePath: string } | { ok: false; error: string } {
  if (!isPathInsideAllowedRoots(rawPath, context.workspaceRoot, context.runtime.policy.writableRoots)) {
    return { ok: false, error: `Path is outside the workspace: ${rawPath}` };
  }
  const absolutePath = resolveWorkspacePath(rawPath, context.workspaceRoot);
  return {
    ok: true,
    absolutePath,
    relativePath: relativeDisplay(context.workspaceRoot, absolutePath),
  };
}

async function listFiles(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  const rawPath = stringArg(args, "path") ?? ".";
  const resolved = resolveAllowedPath(rawPath, context);
  if (!resolved.ok) return { success: false, tool: "list_files", path: rawPath, error: resolved.error };

  const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
  const names = entries
    .filter((entry) => ![".git", "node_modules", "dist", "build", "coverage"].includes(entry.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort();
  return {
    success: true,
    tool: "list_files",
    path: resolved.relativePath,
    output: names.slice(0, 200).join("\n"),
    summary: `Listed ${names.length} item${names.length === 1 ? "" : "s"}.`,
  };
}

async function readFileTool(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  const rawPath = stringArg(args, "path");
  if (!rawPath) return { success: false, tool: "read_file", error: "Missing path." };
  const resolved = resolveAllowedPath(rawPath, context);
  if (!resolved.ok) return { success: false, tool: "read_file", path: rawPath, error: resolved.error };

  const fileStat = await stat(resolved.absolutePath);
  if (fileStat.size > MAX_FILE_BYTES) {
    return { success: false, tool: "read_file", path: resolved.relativePath, error: "File is too large to read through the agent tool." };
  }
  const content = await readFile(resolved.absolutePath, "utf8");
  return {
    success: true,
    tool: "read_file",
    path: resolved.relativePath,
    output: content,
    summary: `Read ${resolved.relativePath}.`,
  };
}

async function writeFileTool(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  if (!canWrite(context.runtime)) {
    return { success: false, tool: "write_file", error: "write_file is blocked by read-only runtime policy." };
  }
  const rawPath = stringArg(args, "path");
  const content = stringArg(args, "content");
  if (!rawPath) return { success: false, tool: "write_file", error: "Missing path." };
  if (content === null) return { success: false, tool: "write_file", path: rawPath, error: "Missing content." };
  const resolved = resolveAllowedPath(rawPath, context);
  if (!resolved.ok) return { success: false, tool: "write_file", path: rawPath, error: resolved.error };

  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, content, "utf8");
  return {
    success: true,
    tool: "write_file",
    path: resolved.relativePath,
    paths: [resolved.relativePath],
    summary: `Wrote ${resolved.relativePath}.`,
  };
}

function parseApplyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const marker = /^(?:\*\*\* (?:Add|Update|Delete) File:|--- a\/|\+\+\+ b\/)\s*(.+)$/.exec(line);
    if (marker?.[1] && marker[1] !== "/dev/null") {
      paths.push(marker[1].trim());
    }
  }
  return [...new Set(paths)];
}

function applyPatchFormatToContent(before: string, patchLines: string[]): string {
  let contentLines = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (contentLines.at(-1) === "") contentLines = contentLines.slice(0, -1);
  let cursor = 0;
  let index = 0;

  while (index < patchLines.length) {
    if (!patchLines[index]?.startsWith("@@")) {
      index += 1;
      continue;
    }
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (index < patchLines.length && !patchLines[index]?.startsWith("@@") && !patchLines[index]?.startsWith("*** ")) {
      const line = patchLines[index] ?? "";
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      }
      index += 1;
    }

    let matchAt = -1;
    for (let candidate = cursor; candidate <= contentLines.length - oldLines.length; candidate += 1) {
      const matches = oldLines.every((line, offset) => contentLines[candidate + offset] === line);
      if (matches) {
        matchAt = candidate;
        break;
      }
    }
    if (matchAt < 0) {
      throw new Error("Patch context did not match the target file.");
    }
    contentLines.splice(matchAt, oldLines.length, ...newLines);
    cursor = matchAt + newLines.length;
  }

  return `${contentLines.join("\n")}\n`;
}

async function applyPatchFormat(patch: string, context: AgentToolContext): Promise<AgentToolResult> {
  const lines = patch.split(/\r?\n/);
  const changedPaths: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const add = /^\*\*\* Add File:\s*(.+)$/.exec(lines[index] ?? "");
    const update = /^\*\*\* Update File:\s*(.+)$/.exec(lines[index] ?? "");
    const del = /^\*\*\* Delete File:\s*(.+)$/.exec(lines[index] ?? "");

    if (add) {
      const resolved = resolveAllowedPath(add[1]!, context);
      if (!resolved.ok) return { success: false, tool: "apply_patch", path: add[1], error: resolved.error };
      index += 1;
      const content: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const line = lines[index] ?? "";
        if (line.startsWith("+")) content.push(line.slice(1));
        index += 1;
      }
      await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      await writeFile(resolved.absolutePath, `${content.join("\n")}\n`, "utf8");
      changedPaths.push(resolved.relativePath);
      continue;
    }

    if (update) {
      const resolved = resolveAllowedPath(update[1]!, context);
      if (!resolved.ok) return { success: false, tool: "apply_patch", path: update[1], error: resolved.error };
      index += 1;
      const patchLines: string[] = [];
      while (index < lines.length && !/^\*\*\* (?:Add|Update|Delete|End)/.test(lines[index] ?? "")) {
        patchLines.push(lines[index] ?? "");
        index += 1;
      }
      const before = await readFile(resolved.absolutePath, "utf8");
      await writeFile(resolved.absolutePath, applyPatchFormatToContent(before, patchLines), "utf8");
      changedPaths.push(resolved.relativePath);
      continue;
    }

    if (del) {
      const resolved = resolveAllowedPath(del[1]!, context);
      if (!resolved.ok) return { success: false, tool: "apply_patch", path: del[1], error: resolved.error };
      await rm(resolved.absolutePath, { force: true });
      changedPaths.push(resolved.relativePath);
      index += 1;
      continue;
    }

    index += 1;
  }

  if (changedPaths.length === 0) {
    return { success: false, tool: "apply_patch", error: "No supported patch operations were found." };
  }

  return {
    success: true,
    tool: "apply_patch",
    paths: changedPaths,
    summary: `Patched ${changedPaths.join(", ")}.`,
  };
}

async function applyPatchTool(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  if (!canWrite(context.runtime)) {
    return { success: false, tool: "apply_patch", error: "apply_patch is blocked by read-only runtime policy." };
  }
  const patch = stringArg(args, "patch");
  if (!patch) return { success: false, tool: "apply_patch", error: "Missing patch." };

  const explicitPath = stringArg(args, "path");
  const paths = explicitPath ? [explicitPath] : parseApplyPatchPaths(patch);
  for (const patchPath of paths) {
    const resolved = resolveAllowedPath(patchPath, context);
    if (!resolved.ok) return { success: false, tool: "apply_patch", path: patchPath, error: resolved.error };
  }

  if (!patch.trimStart().startsWith("*** Begin Patch")) {
    return { success: false, tool: "apply_patch", error: "Only *** Begin Patch format is supported by this agent tool." };
  }

  return applyPatchFormat(patch, context);
}

async function runShellTool(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  if (!canWrite(context.runtime) || isReadOnly(context.runtime)) {
    return { success: false, tool: "run_shell", error: "run_shell is blocked by read-only runtime policy." };
  }
  const command = stringArg(args, "command");
  if (!command) return { success: false, tool: "run_shell", error: "Missing command." };

  if (DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(command))) {
    return { success: false, tool: "run_shell", command, error: "Shell command blocked as dangerous." };
  }
  const rustGuard = rustCommandGuard(command, context);
  if (rustGuard) {
    return { success: false, tool: "run_shell", command, exitCode: null, durationMs: 0, stdout: "", stderr: "", error: rustGuard };
  }
  const workspaceGuard = getShellWorkspaceGuardMessage(command, context.workspaceRoot, context.runtime.policy.writableRoots);
  if (workspaceGuard) {
    return { success: false, tool: "run_shell", command, error: workspaceGuard };
  }

  const runner = runShellCommand(command, {
    cwd: context.workspaceRoot,
    timeoutMs: SHELL_TIMEOUT_MS,
  });
  const cancel = () => runner.cancel();
  context.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await runner.result;
    const success = result.status === "completed" && result.exitCode === 0;
    const stdout = trimOutputLines(result.stdout, !success);
    const stderr = trimOutputLines(result.stderr, !success);
    const output = preview([stdout, stderr].filter(Boolean).join("\n"));
    return {
      success,
      tool: "run_shell",
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout,
      stderr,
      output,
      summary: summarizeCommandResult(command, result),
      error: success ? undefined : result.userMessage,
    };
  } finally {
    context.signal?.removeEventListener("abort", cancel);
  }
}

async function getWorkspaceInfo(context: AgentToolContext): Promise<AgentToolResult> {
  return {
    success: true,
    tool: "get_workspace_info",
    path: ".",
    output: JSON.stringify({
      workspaceRoot: context.workspaceRoot,
      sandboxMode: context.runtime.policy.sandboxMode,
      writableRoots: context.runtime.policy.writableRoots,
      packageJson: existsSync(path.join(context.workspaceRoot, "package.json")),
    }),
    summary: "Returned workspace info.",
  };
}

export async function executeAgentTool(
  name: AgentToolName,
  args: Record<string, unknown>,
  context: AgentToolContext,
): Promise<AgentToolResult> {
  try {
    switch (name) {
      case "list_files":
        return await listFiles(args, context);
      case "read_file":
        return await readFileTool(args, context);
      case "write_file":
        return await writeFileTool(args, context);
      case "apply_patch":
        return await applyPatchTool(args, context);
      case "run_shell":
        return await runShellTool(args, context);
      case "get_workspace_info":
        return await getWorkspaceInfo(context);
    }
  } catch (error) {
    return {
      success: false,
      tool: name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
