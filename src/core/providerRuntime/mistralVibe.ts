import { existsSync, readFileSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { parseTomlDocument } from "../../config/layeredConfig.js";
import { runCommand, runShellCommand, type CommandResult, type CommandStreamHandlers, type CommandSpec } from "../process/CommandRunner.js";
import { normalizeExecutableValue } from "../process/processValidation.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { launchProviderCli, type LaunchProviderCliOptions, type ProviderLaunchResult } from "../providerLauncher/launcher.js";
import type { ProviderConfig } from "../providerLauncher/types.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ProviderChatRequest, ProviderModel, ProviderModelDiscoveryResult, ProviderRouteValidationResult, ProviderRuntime } from "./types.js";
import { formatConversationHistory } from "../../session/conversation.js";

const VIBE_LOOKUP_TIMEOUT_MS = 5_000;
const VIBE_RUN_TIMEOUT_MS = 600_000;
export const VIBE_DEFAULT_MODEL_LABEL = "Vibe default";

export const MISTRAL_VIBE_MISSING_MESSAGE =
  "`vibe` is not available. Install Mistral Vibe CLI and authenticate it with `vibe --setup`, then try again.";

export const MISTRAL_VIBE_AUTH_MESSAGE =
  "Mistral Vibe CLI is not authenticated. Run `vibe` in a terminal and sign in, then retry.";

type CommandResultSubset = Pick<CommandResult, "status" | "exitCode" | "stdout">;
type ShellCommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs?: number },
) => { result: Promise<CommandResultSubset> };
type DirectCommandRunner = (
  spec: { executable: string; args: string[]; cwd: string; timeoutMs?: number },
) => { result: Promise<CommandResultSubset> };

export interface VibeModelDetection {
  modelId: string;
  source: "environment" | "project-config" | "user-config" | "default";
  configPath: string | null;
}

function readActiveModel(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parseTomlDocument(readFileSync(filePath, "utf-8"));
    return typeof parsed.active_model === "string" && parsed.active_model.trim()
      ? parsed.active_model.trim()
      : null;
  } catch {
    return null;
  }
}

function findProjectVibeConfig(cwd: string, vibeHome: string): string | null {
  let current = resolve(cwd);
  const stopDirectory = dirname(resolve(vibeHome));

  while (current !== stopDirectory) {
    const candidate = join(current, ".vibe", "config.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function detectVibeActiveModel(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): VibeModelDetection {
  const env = options.env ?? process.env;
  const environmentModel = env.VIBE_ACTIVE_MODEL?.trim();
  if (environmentModel) {
    return { modelId: environmentModel, source: "environment", configPath: null };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const vibeHome = env.VIBE_HOME?.trim() || join(homeDirectory, ".vibe");
  const projectConfig = findProjectVibeConfig(options.cwd ?? process.cwd(), vibeHome);
  if (projectConfig) {
    const projectModel = readActiveModel(projectConfig);
    if (projectModel) {
      return { modelId: projectModel, source: "project-config", configPath: projectConfig };
    }
  }

  const userConfig = join(vibeHome, "config.toml");
  const userModel = readActiveModel(userConfig);
  if (userModel) {
    return { modelId: userModel, source: "user-config", configPath: userConfig };
  }

  return { modelId: VIBE_DEFAULT_MODEL_LABEL, source: "default", configPath: null };
}

interface VibeConfigModelEntry {
  name: string;
  alias: string;
  provider: string | null;
}

// Vibe resolves `active_model` (and the VIBE_ACTIVE_MODEL override) against the
// model *alias*, which defaults to the model name when omitted — so the alias is
// the id Ubume must select and pass back.
function readVibeModelEntries(filePath: string): VibeConfigModelEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = parseTomlDocument(readFileSync(filePath, "utf-8"));
    const rawModels = (parsed as Record<string, unknown>).models;
    if (!Array.isArray(rawModels)) return [];
    const entries: VibeConfigModelEntry[] = [];
    for (const raw of rawModels) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) continue;
      const alias = typeof record.alias === "string" && record.alias.trim() ? record.alias.trim() : name;
      entries.push({
        name,
        alias,
        provider: typeof record.provider === "string" && record.provider.trim() ? record.provider.trim() : null,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function vibeEntryToProviderModel(entry: VibeConfigModelEntry): ProviderModel {
  return {
    id: entry.alias,
    modelId: entry.alias,
    label: entry.alias,
    description: entry.provider ? `${entry.name} via ${entry.provider}` : entry.name,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    source: "config",
    raw: entry,
  };
}

export function listVibeConfiguredModels(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): { models: ProviderModel[]; configPath: string | null } {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const vibeHome = env.VIBE_HOME?.trim() || join(homeDirectory, ".vibe");
  const projectConfig = findProjectVibeConfig(options.cwd ?? process.cwd(), vibeHome);
  const userConfig = join(vibeHome, "config.toml");

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  let configPath: string | null = null;
  for (const candidate of [projectConfig, userConfig]) {
    if (!candidate) continue;
    const entries = readVibeModelEntries(candidate);
    if (entries.length > 0 && !configPath) configPath = candidate;
    for (const entry of entries) {
      if (seen.has(entry.alias)) continue;
      seen.add(entry.alias);
      models.push(vibeEntryToProviderModel(entry));
    }
  }
  return { models, configPath };
}

export function discoverMistralVibeModels(cwd = process.cwd()): ProviderModelDiscoveryResult {
  const detected = detectVibeActiveModel({ cwd });
  const listed = listVibeConfiguredModels({ cwd });

  // The active model must be first: registry consumers read models[0] as the default route model.
  const models: ProviderModel[] = [];
  const activeFromList = listed.models.find((model) => model.modelId === detected.modelId);
  if (activeFromList) {
    models.push(activeFromList, ...listed.models.filter((model) => model !== activeFromList));
  } else {
    models.push({
      id: detected.modelId,
      modelId: detected.modelId,
      label: detected.modelId,
      description: "Active model reported by Mistral Vibe configuration.",
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      source: detected.source === "default" ? "fallback" : "config",
      raw: {
        source: detected.source,
        configPath: detected.configPath,
      },
    }, ...listed.models);
  }

  return {
    status: "ready",
    providerId: "mistral",
    backendKind: "mistral-vibe-cli-auth",
    models,
    diagnostics: {
      selectedModel: detected.modelId,
      modelSource: detected.source,
      configPath: detected.configPath ?? listed.configPath,
      modelCount: models.length,
    },
  };
}

function firstOutputLine(result: CommandResultSubset): string | null {
  if (result.status !== "completed" || result.exitCode !== 0) return null;
  return result.stdout.split(/[\r\n]+/).map((line) => line.trim()).find(Boolean) ?? null;
}

export async function resolveVibeExecutable(options: {
  cwd?: string;
  platform?: NodeJS.Platform;
  runShellCommandImpl?: ShellCommandRunner;
  runCommandImpl?: DirectCommandRunner;
} = {}): Promise<string | null> {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  let candidate: string | null;

  if (platform === "win32") {
    const runner = (options.runCommandImpl ?? runCommand as DirectCommandRunner)({
      executable: "where.exe",
      args: ["vibe"],
      cwd,
      timeoutMs: VIBE_LOOKUP_TIMEOUT_MS,
    });
    candidate = firstOutputLine(await runner.result);
  } else {
    const runner = (options.runShellCommandImpl ?? runShellCommand as ShellCommandRunner)(
      "command -v vibe",
      { cwd, timeoutMs: VIBE_LOOKUP_TIMEOUT_MS },
    );
    candidate = firstOutputLine(await runner.result);
  }

  if (!candidate) return null;
  try {
    return normalizeExecutableValue(candidate, {
      label: "Mistral Vibe executable",
      cwd,
      allowBareExecutable: true,
    });
  } catch {
    return null;
  }
}

export async function launchMistralVibeCli(
  provider: ProviderConfig,
  options: LaunchProviderCliOptions & {
    resolveExecutable?: (cwd: string) => Promise<string | null>;
  },
): Promise<ProviderLaunchResult> {
  const resolveExecutable = options.resolveExecutable
    ?? ((cwd: string) => resolveVibeExecutable({ cwd }));
  const executable = await resolveExecutable(options.cwd);
  if (!executable) {
    return { status: "missing-command", message: MISTRAL_VIBE_MISSING_MESSAGE };
  }

  return launchProviderCli({
    ...provider,
    launchCommand: { executable, args: [] },
  }, options);
}

// ─── Session continuation ────────────────────────────────────────────────────
// Vibe persists every programmatic run as a session directory; passing the last
// session id back via --resume keeps conversation context across Ubume turns.

const activeVibeSessions = new Map<string, string>();

export function getMistralVibeSessionId(workspaceRoot: string): string | null {
  return activeVibeSessions.get(resolve(workspaceRoot)) ?? null;
}

export function resetMistralVibeSession(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    activeVibeSessions.clear();
    return;
  }
  activeVibeSessions.delete(resolve(workspaceRoot));
}

export async function findLatestVibeSession(options: {
  workspaceRoot: string;
  sinceMs: number;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): Promise<string | null> {
  try {
    const env = options.env ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const vibeHome = env.VIBE_HOME?.trim() || join(homeDirectory, ".vibe");
    const sessionRoot = join(vibeHome, "logs", "session");
    const workspaceRoot = resolve(options.workspaceRoot);
    const entries = await readdir(sessionRoot);

    let latestStart = -Infinity;
    let latestSessionId: string | null = null;
    for (const entry of entries) {
      if (!entry.startsWith("session_")) continue;
      try {
        const meta = JSON.parse(await readFile(join(sessionRoot, entry, "meta.json"), "utf-8")) as {
          session_id?: unknown;
          start_time?: unknown;
          environment?: { working_directory?: unknown };
        };
        if (typeof meta.session_id !== "string" || typeof meta.start_time !== "string") continue;
        if (meta.environment?.working_directory !== workspaceRoot) continue;
        const startMs = Date.parse(meta.start_time);
        // 5s slack absorbs clock skew between Ubume's spawn timestamp and vibe's own start_time.
        if (!Number.isFinite(startMs) || startMs < options.sinceMs - 5_000) continue;
        if (startMs > latestStart) {
          latestStart = startMs;
          latestSessionId = meta.session_id;
        }
      } catch {
        continue;
      }
    }
    return latestSessionId;
  } catch {
    return null;
  }
}

// ─── Streaming output parsing ────────────────────────────────────────────────

function extractVibeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncateForActivity(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export interface VibeStreamParser {
  push: (chunk: string) => void;
  flush: () => void;
  finalText: () => string;
  assistantText: () => string;
}

// Parses `vibe -p --output streaming` stdout: one JSON LLMMessage per line, followed
// by the final assistant text repeated as plain text (which must not be emitted twice).
export function createVibeStreamParser(
  handlers: BackendRunHandlers,
  options: { startAfterUserPrompt?: string } = {},
): VibeStreamParser {
  let lineBuf = "";
  let accumulated = "";
  const plainLines: string[] = [];
  let sequence = 0;
  const runningTools = new Map<string, { command: string; startedAt: number }>();
  const resumePrompt = options.startAfterUserPrompt?.trim() || null;
  let acceptingCurrentTurn = resumePrompt === null;

  const handleMessage = (message: Record<string, unknown>) => {
    const role = message.role;
    if (!acceptingCurrentTurn) {
      if (role === "user" && extractVibeText(message.content).trim() === resumePrompt) {
        acceptingCurrentTurn = true;
      }
      return;
    }
    if (role !== "assistant" && role !== "tool") return;

    if (role === "tool") {
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : null;
      const running = toolCallId ? runningTools.get(toolCallId) : undefined;
      if (toolCallId && running) {
        runningTools.delete(toolCallId);
        handlers.onToolActivity?.({
          id: toolCallId,
          command: running.command,
          status: "completed",
          startedAt: running.startedAt,
          completedAt: Date.now(),
          summary: truncateForActivity(extractVibeText(message.content)) || null,
        });
      }
      return;
    }

    const reasoning = extractVibeText(message.reasoning_content);
    if (reasoning.trim()) {
      handlers.onProgress?.({
        id: `vibe-reasoning-${++sequence}`,
        source: "reasoning",
        text: reasoning,
      });
    }

    const content = extractVibeText(message.content);
    if (content.trim()) {
      const chunk = accumulated ? `\n\n${content}` : content;
      accumulated += chunk;
      handlers.onAssistantDelta?.(chunk);
    }

    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const record = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const name = typeof record.function?.name === "string" ? record.function.name : "tool";
        const args = typeof record.function?.arguments === "string" ? record.function.arguments : "";
        const id = typeof record.id === "string" ? record.id : `vibe-tool-${++sequence}`;
        const activity = {
          id,
          command: truncateForActivity(args ? `${name}(${args})` : name),
          startedAt: Date.now(),
        };
        runningTools.set(id, activity);
        handlers.onToolActivity?.({ ...activity, status: "running" });
      }
    }
  };

  const handleLine = (rawLine: string) => {
    const line = sanitizeTerminalOutput(rawLine).trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { role?: unknown }).role === "string") {
        handleMessage(parsed as Record<string, unknown>);
        return;
      }
    } catch {
      // Not a JSON message: either a pre-stream notice or the trailing plain-text
      // duplicate of the final answer. Collected as fallback, never streamed.
    }
    plainLines.push(line);
  };

  return {
    push: (chunk) => {
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    flush: () => {
      if (!lineBuf) return;
      const rest = lineBuf;
      lineBuf = "";
      handleLine(rest);
    },
    finalText: () => accumulated || plainLines.join("\n").trim(),
    assistantText: () => accumulated,
  };
}

// ─── In-Ubume run adapter ───────────────────────────────────────────────────

type VibeCommandRunner = (
  spec: CommandSpec,
  handlers: CommandStreamHandlers,
) => { result: Promise<CommandResult>; cancel: () => void };

export interface RunMistralVibeDeps {
  runCommandImpl?: VibeCommandRunner;
  resolveExecutable?: (cwd: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  findSessionImpl?: typeof findLatestVibeSession;
  now?: () => number;
}

function isVibeAuthFailure(stderr: string): boolean {
  return /api key|401|unauthorized|authentication/i.test(stderr);
}

export function runMistralVibe(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  deps: RunMistralVibeDeps = {},
): () => void {
  let cancelled = false;
  let currentCancel: (() => void) | null = null;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const runImpl = deps.runCommandImpl ?? (runCommand as VibeCommandRunner);
  const resolveExecutable = deps.resolveExecutable ?? ((cwd: string) => resolveVibeExecutable({ cwd }));
  const findSessionImpl = deps.findSessionImpl ?? findLatestVibeSession;
  const workspaceRoot = request.workspaceRoot;

  handlers.onProgress?.({
    id: "mistral-route",
    source: "stdout",
    text: "Starting Mistral Vibe CLI",
  });

  const runAttempt = (executable: string, resumeSessionId: string | null) => {
    const args = ["-p", "--output", "streaming", "--trust", "--auto-approve", "--workdir", workspaceRoot];
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const modelId = request.route.modelId?.trim();
    const spawnEnv: NodeJS.ProcessEnv = { ...env };
    if (modelId && modelId !== VIBE_DEFAULT_MODEL_LABEL) {
      spawnEnv.VIBE_ACTIVE_MODEL = modelId;
    }

    const prompt = !resumeSessionId && request.conversationHistory?.length
      ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
      : request.prompt;
    const parser = createVibeStreamParser(
      handlers,
      resumeSessionId ? { startAfterUserPrompt: request.prompt } : undefined,
    );
    const spawnedAt = now();
    const runner = runImpl(
      {
        executable,
        args,
        cwd: workspaceRoot,
        env: spawnEnv,
        timeoutMs: VIBE_RUN_TIMEOUT_MS,
        stdinData: prompt,
      },
      {
        onStdout: (chunk) => {
          if (!cancelled) parser.push(chunk);
        },
        onProcessLifecycle: (event) => {
          handlers.onProcessLifecycle?.(event === "cancel" ? "cleanup" : event);
        },
      },
    );
    currentCancel = runner.cancel;

    runner.result.then((result) => {
      if (cancelled || result.status === "canceled") return;
      parser.flush();

      if (result.status !== "completed" || result.exitCode !== 0) {
        if (isVibeAuthFailure(result.stderr)) {
          handlers.onError(MISTRAL_VIBE_AUTH_MESSAGE, result.stderr);
          return;
        }
        if (result.status === "spawn_error" && result.errorCode === "ENOENT") {
          handlers.onError(MISTRAL_VIBE_MISSING_MESSAGE);
          return;
        }
        if (resumeSessionId && /session|not found|resume/i.test(result.stderr)) {
          resetMistralVibeSession(workspaceRoot);
          handlers.onProgress?.({
            id: "vibe-resume-retry",
            source: "stderr",
            text: "Saved Vibe session could not be resumed; retrying with a fresh session.",
          });
          runAttempt(executable, null);
          return;
        }
        handlers.onError(
          result.userMessage || "Mistral Vibe execution failed.",
          result.stderr.trim() || undefined,
        );
        return;
      }

      const finalText = parser.finalText() || sanitizeTerminalOutput(result.stdout).trim();
      if (!parser.assistantText() && finalText) {
        handlers.onAssistantDelta?.(finalText);
      }
      handlers.onFinalAnswerObserved?.(finalText);
      handlers.onResponse(finalText);

      void findSessionImpl({ workspaceRoot, sinceMs: spawnedAt, env })
        .then((sessionId) => {
          if (sessionId) activeVibeSessions.set(resolve(workspaceRoot), sessionId);
        })
        .catch(() => undefined);
    }).catch((error) => {
      if (cancelled) return;
      handlers.onError(error instanceof Error ? error.message : "Mistral Vibe execution failed.");
    });
  };

  void (async () => {
    const executable = await resolveExecutable(workspaceRoot);
    if (cancelled) return;
    if (!executable) {
      handlers.onError(MISTRAL_VIBE_MISSING_MESSAGE);
      return;
    }
    runAttempt(executable, getMistralVibeSessionId(workspaceRoot));
  })();

  return () => {
    cancelled = true;
    currentCancel?.();
  };
}

export async function validateMistralVibeRoute(options: {
  cwd: string;
  resolveExecutable?: (cwd: string) => Promise<string | null>;
} = { cwd: process.cwd() }): Promise<ProviderRouteValidationResult> {
  const resolveExecutable = options.resolveExecutable ?? ((cwd: string) => resolveVibeExecutable({ cwd }));
  const executable = await resolveExecutable(options.cwd);
  if (!executable) {
    return {
      status: "not-configured",
      providerId: "mistral",
      backendKind: "unavailable",
      message: MISTRAL_VIBE_MISSING_MESSAGE,
      diagnostics: { resolvedCommand: null },
    };
  }
  const detected = detectVibeActiveModel({ cwd: options.cwd });
  return {
    status: "ready",
    providerId: "mistral",
    backendKind: "mistral-vibe-cli-auth",
    message: "Mistral Vibe CLI is available.",
    diagnostics: {
      resolvedCommand: executable,
      selectedModel: detected.modelId,
      modelSource: detected.source,
    },
  };
}

export const mistralVibeRuntime: ProviderRuntime = {
  providerId: "mistral",
  label: "Mistral Vibe CLI",
  modelPickerLabel: "Mistral Vibe",
  backendKind: "mistral-vibe-cli-auth",
  routeAvailable: true,
  routeStatus: "Uses the Mistral Vibe CLI (vibe -p) with your existing vibe authentication.",
  routeSetupMessage: MISTRAL_VIBE_MISSING_MESSAGE,
  launchAvailable: true,
  validateRoute: async ({ workspaceRoot }) => validateMistralVibeRoute({ cwd: workspaceRoot }),
  discoverModels: () => discoverMistralVibeModels(),
  refreshModels: async ({ cwd }) => {
    const executable = await resolveVibeExecutable({ cwd });
    if (!executable) {
      return {
        status: "not-configured",
        providerId: "mistral",
        backendKind: "unavailable",
        models: [],
        message: MISTRAL_VIBE_MISSING_MESSAGE,
      };
    }
    return discoverMistralVibeModels(cwd);
  },
  run: (request, handlers) => runMistralVibe(request, handlers),
};
