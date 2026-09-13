import {
  resolveLayeredConfig,
  type LayeredConfigResult,
} from "../config/layeredConfig.js";
import type { LaunchArgs } from "../config/launchArgs.js";
import {
  mergeRuntimeConfig,
  resolveRuntimeConfig,
  type ResolvedRuntimeConfig,
} from "../config/runtimeConfig.js";
import { loadProjectInstructions, type ProjectInstructionsLoadResult } from "../core/workspace/projectInstructions.js";
import { getBackendProvider } from "../core/providers/registry.js";
import type { BackendProvider } from "../core/providers/types.js";
import { isNoiseLine } from "../core/providers/codexTranscript.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import { resolveWorkspaceRoot } from "../core/workspace/workspaceRoot.js";
import type { RunToolActivity } from "../session/types.js";

// ─── Types & constants ────────────────────────────────────────────────────────

export const HEADLESS_EXEC_PARSE_ERROR = 2;
export const HEADLESS_EXEC_PROVIDER_UNAVAILABLE = 3;
export const HEADLESS_EXEC_RUN_FAILED = 1;

export interface HeadlessExecIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface HeadlessExecOptions {
  prompt: string;
  launchArgs: LaunchArgs;
  workspaceRoot?: string;
  benchmarkDiagnostics?: HeadlessExecTiming;
  promptPolicy?: "raw" | "wrapped";
}

export interface HeadlessExecResult {
  exitCode: number;
}

export interface HeadlessExecDependencies {
  resolveWorkspaceRoot: () => string;
  resolveLayeredConfig: (options: { workspaceRoot: string; launchArgs: LaunchArgs }) => LayeredConfigResult;
  resolveRuntimeConfig: typeof resolveRuntimeConfig;
  getBackendProvider: (id: string) => BackendProvider;
  loadProjectInstructions: (workspaceRoot: string) => ProjectInstructionsLoadResult;
}

export type HeadlessExecTimingValue = string | number | boolean | null | readonly string[];

export interface HeadlessExecTiming {
  enabled: boolean;
  mark: (phase: string, fields?: Record<string, HeadlessExecTimingValue>) => void;
}

export function createHeadlessExecTiming(options: {
  enabled: boolean;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  startTimeMs?: number;
}): HeadlessExecTiming {
  const startTimeMs = options.startTimeMs ?? Date.now();
  const stderr = options.stderr ?? process.stderr;
  let previousElapsedMs = 0;

  return {
    enabled: options.enabled,
    mark: (phase, fields = {}) => {
      if (!options.enabled) return;
      const elapsedMs = Date.now() - startTimeMs;
      const deltaMs = elapsedMs - previousElapsedMs;
      previousElapsedMs = elapsedMs;
      const formattedFields = Object.entries(fields)
        .map(([key, value]) => {
          const serialized = Array.isArray(value) || typeof value === "string"
            ? JSON.stringify(value)
            : String(value);
          return `${key}=${serialized}`;
        })
        .join(" ");
      writeLine(stderr, `[ubume exec timing] phase=${phase} elapsed_ms=${elapsedMs} delta_ms=${deltaMs}${formattedFields ? ` ${formattedFields}` : ""}`);
    },
  };
}

export const createHeadlessBenchmarkDiagnostics = createHeadlessExecTiming;

const DEFAULT_DEPENDENCIES: HeadlessExecDependencies = {
  resolveWorkspaceRoot,
  resolveLayeredConfig,
  resolveRuntimeConfig,
  getBackendProvider,
  loadProjectInstructions,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, line: string): void {
  stream.write(`${line}\n`);
}

function formatDiagnosticText(value: string): string {
  return sanitizeTerminalOutput(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function writeDiagnostic(stderr: Pick<NodeJS.WriteStream, "write">, kind: string, message: string): void {
  const safeMessage = formatDiagnosticText(message);
  if (!safeMessage) return;
  writeLine(stderr, `[ubume exec] ${kind}: ${safeMessage.replace(/\n/g, "\n  ")}`);
}

function formatToolActivity(activity: RunToolActivity): string {
  const summary = activity.summary?.trim();
  const safeSummary = summary && isProcessTerminationNoise(summary) ? "" : summary;
  return summary
    ? `${activity.status}: ${activity.command}${safeSummary ? `\n${safeSummary}` : ""}`
    : `${activity.status}: ${activity.command}`;
}

function isStructuredCodexEventLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed.type === "string"
      && /^(?:thread|turn|item)\./.test(parsed.type);
  } catch {
    return false;
  }
}

function isProcessTerminationNoise(line: string): boolean {
  return /^SUCCESS: The process with PID \d+ .* has been terminated\.$/.test(line.trim());
}

function shouldSuppressAssistantChunk(chunk: string): boolean {
  const lines = chunk
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0
    && lines.every((line) => isStructuredCodexEventLine(line) || isProcessTerminationNoise(line));
}

function formatRuntimeStartup(runtime: ResolvedRuntimeConfig, workspaceRoot: string, provider: BackendProvider): string {
  return [
    `workspace ${workspaceRoot}`,
    `provider ${provider.label} (${provider.id})`,
    `model ${runtime.model}`,
    `mode ${runtime.mode}`,
    `planMode ${runtime.planMode ? "enabled" : "disabled"}`,
    `sandbox ${runtime.policy.sandboxMode}`,
    `approval ${runtime.policy.approvalPolicy}`,
    `network ${runtime.policy.networkAccess ? "enabled" : "disabled"}`,
  ].join("; ");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runHeadlessExec(
  options: HeadlessExecOptions,
  io: HeadlessExecIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: Partial<HeadlessExecDependencies> = {},
): Promise<HeadlessExecResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const diagnostics = options.benchmarkDiagnostics;
  const promptPolicy = options.promptPolicy ?? "raw";
  diagnostics?.mark("run_headless_start");
  const workspaceRoot = options.workspaceRoot ?? deps.resolveWorkspaceRoot();
  diagnostics?.mark("workspace_resolved", { workspace_root: workspaceRoot });
  const layeredConfig = deps.resolveLayeredConfig({
    workspaceRoot,
    launchArgs: options.launchArgs,
  });
  diagnostics?.mark("layered_config_loaded");
  const runtimeConfig = mergeRuntimeConfig(layeredConfig.runtime, { planMode: false });
  const runtime = deps.resolveRuntimeConfig(runtimeConfig);
  diagnostics?.mark("runtime_config_resolved", {
    effective_model: runtime.model,
    effective_reasoning_effort: runtime.reasoningLevel,
    prompt_policy: promptPolicy,
  });

  const projectInstructionsLoad = promptPolicy === "wrapped"
    ? deps.loadProjectInstructions(workspaceRoot)
    : ({ status: "missing" } as ProjectInstructionsLoadResult);
  const projectInstructions = projectInstructionsLoad.status === "loaded"
    ? projectInstructionsLoad.instructions
    : null;
  diagnostics?.mark("project_instructions_resolved", {
    whether_project_instructions_loaded: projectInstructionsLoad.status === "loaded",
    project_instructions_path: projectInstructions?.path ?? ("path" in projectInstructionsLoad ? projectInstructionsLoad.path : null),
    project_instructions_character_count: projectInstructions?.content.length ?? 0,
  });

  const provider = deps.getBackendProvider(runtime.provider);
  diagnostics?.mark("provider_created", {
    provider_id: provider.id,
    provider_label: provider.label,
  });

  writeDiagnostic(io.stderr, "startup", formatRuntimeStartup(runtime, workspaceRoot, provider));

  if (layeredConfig.diagnostics.ignoredEntries.length > 0) {
    writeDiagnostic(io.stderr, "config", `ignored ${layeredConfig.diagnostics.ignoredEntries.join("; ")}`);
  }

  if (projectInstructionsLoad.status === "error") {
    writeDiagnostic(io.stderr, "config", `could not load project instructions at ${projectInstructionsLoad.path}: ${projectInstructionsLoad.message}`);
  }

  if (!provider.run) {
    writeDiagnostic(io.stderr, "error", `${provider.label} is unavailable for headless execution.`);
    return { exitCode: HEADLESS_EXEC_PROVIDER_UNAVAILABLE };
  }

  return await new Promise<HeadlessExecResult>((resolve) => {
    let settled = false;
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode });
    };

    try {
      let streamedAssistantChars = 0;
      const toolActivityIds = new Set<string>();

      provider.run!(
        options.prompt,
        { runtime, workspaceRoot, projectInstructions, promptPolicy },
        {
          onAssistantDelta: (chunk) => {
            const safeChunk = sanitizeTerminalOutput(chunk, { preserveTabs: false, tabSize: 2 });
            if (shouldSuppressAssistantChunk(safeChunk)) return;
            if (!safeChunk) return;
            streamedAssistantChars += safeChunk.length;
            io.stdout.write(safeChunk);
          },
          onProgress: (update) => {
            const safeText = formatDiagnosticText(update.text);
            if (!safeText || isNoiseLine(safeText) || isProcessTerminationNoise(safeText)) return;
            if (update.source === "tool" && toolActivityIds.has(update.id)) return;
            writeDiagnostic(io.stderr, update.source, safeText);
          },
          onToolActivity: (activity) => {
            toolActivityIds.add(activity.id);
            writeDiagnostic(io.stderr, "tool", formatToolActivity(activity));
          },
          onFinalAnswerObserved: (response) => {
            diagnostics?.mark("final_answer_observed", {
              final_answer_character_count: response.length,
            });
          },
          onResponse: (response) => {
            const safeResponse = sanitizeTerminalOutput(response, { preserveTabs: false, tabSize: 2 });
            if (streamedAssistantChars === 0 && safeResponse) {
              io.stdout.write(safeResponse);
            }
            settle(0);
          },
          onError: (message, rawOutput) => {
            const details = [message, rawOutput].filter((value) => value?.trim()).join("\n");
            writeDiagnostic(io.stderr, "error", details || "Provider run failed.");
            settle(HEADLESS_EXEC_RUN_FAILED);
          },
          benchmarkHooks: diagnostics?.enabled
            ? {
                onProviderPrepStart: () => diagnostics.mark("provider_prep_start"),
                onProviderPrepComplete: () => diagnostics.mark("provider_prep_complete"),
                onProviderPromptPrepared: ({ policy, characterCount }) => diagnostics.mark("provider_prompt_prepared", {
                  prompt_policy: policy,
                  prompt_character_count_before_wrapping: options.prompt.length,
                  prompt_character_count_after_wrapping: characterCount,
                }),
                onCodexProcessSpawned: ({ executable, argv }) => diagnostics.mark("codex_process_spawned", {
                  codex_argv_preview: [executable, ...argv].join(" "),
                }),
                onFirstStdout: (observed = true) => diagnostics.mark("first_stdout", { observed }),
                onFirstStderr: (observed = true) => diagnostics.mark("first_stderr", { observed }),
                onCodexProcessExit: (exitCode) => diagnostics.mark("codex_process_exit", {
                  exit_code: exitCode,
                }),
                onCleanupStart: () => diagnostics.mark("cleanup_start"),
                onCleanupComplete: ({ skipped }) => diagnostics.mark("cleanup_complete", { skipped }),
              }
            : undefined,
        },
      );
    } catch (error) {
      writeDiagnostic(io.stderr, "error", error instanceof Error ? error.message : String(error));
      settle(HEADLESS_EXEC_RUN_FAILED);
    }
  });
}
