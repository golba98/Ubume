import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { ANTHROPIC_FALLBACK_MODELS } from "./models.js";
import type { ProviderBackendKind, ProviderChatRequest, ProviderModel, ProviderModelDiscoveryResult, ProviderRouteValidationResult, ProviderRuntime } from "./types.js";
import { formatConversationHistory } from "../../session/conversation.js";
import { buildClaudeSpawnSpec, resetClaudeExecutableCacheForTests } from "../executables/claudeExecutable.js";
import {
  claudeCodeModelsToProviderModels,
  discoverClaudeCodeCapabilities,
  getClaudeModelDefaultEffort,
  modelSupportsClaudeEffort,
  type ClaudeCodeCapabilityDiscovery,
} from "./claudeCodeDiscovery.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 1024;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const ANTHROPIC_AUTH_CHECK_TIMEOUT_MS = 10_000;
const ANTHROPIC_ROUTE_VALIDATION_TIMEOUT_MS = 15_000;
const DISCOVERY_FAILURE_MESSAGE = "Claude Code model version discovery failed; using fallback aliases with unknown versions.";
export const ANTHROPIC_ROUTE_SETUP_MESSAGE = "Anthropic/Claude is not configured for in-Ubume routing.\nSign in with Claude Code or set ANTHROPIC_API_KEY.";
export { parseClaudeAuthStatus } from "./claudeCodeDiscovery.js";

type CommandRunner = typeof runCommand;

let claudeCodeValidated = false;
let resolvedClaudeExecutable: string = "claude";
let discoveredAnthropicModels: readonly ProviderModel[] | null = null;
let claudeCapabilityDiscovery: ClaudeCodeCapabilityDiscovery | null = null;

function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function isAnthropicRouteConfigured(): boolean {
  return getAnthropicApiKey() !== null || claudeCodeValidated;
}

export function resetAnthropicRouteValidationCacheForTests(): void {
  claudeCodeValidated = false;
  resolvedClaudeExecutable = "claude";
  discoveredAnthropicModels = null;
  claudeCapabilityDiscovery = null;
  resetClaudeExecutableCacheForTests();
}

// ---------------------------------------------------------------------------
// Model / reasoning / permission-mode mapping
// ---------------------------------------------------------------------------

// Claude Code CLI accepts both short aliases ("sonnet", "opus", "haiku") and
// full versioned IDs ("claude-sonnet-4-20250514"). Pass through unchanged.
export function mapModelIdToClaudeArg(modelId: string): string {
  return modelId;
}

export function mapReasoningToEffort(reasoning: string | null | undefined): string | null {
  return reasoning?.trim() || null;
}

function buildClaudeCodeBaseArgs(request: ProviderChatRequest): string[] {
  const effort = mapReasoningToEffort(request.route.reasoning ?? null);
  const models = getActiveAnthropicModels();
  const supportedEffort = effort && modelSupportsClaudeEffort(request.route.modelId, effort, models) ? effort : null;
  return [
    ...(request.route.modelId ? ["--model", mapModelIdToClaudeArg(request.route.modelId)] : []),
    ...(supportedEffort ? ["--effort", supportedEffort] : []),
    "--permission-mode", "default",
    request.conversationHistory?.length
      ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
      : request.prompt,
  ];
}

export function ensureClaudeStreamJsonVerbose(args: string[]): string[] {
  const outputFormatIndex = args.indexOf("--output-format");
  const usesStreamJson = outputFormatIndex >= 0 && args[outputFormatIndex + 1] === "stream-json";
  const usesPrint = args.includes("-p") || args.includes("--print");
  if (!usesStreamJson || !usesPrint || args.includes("--verbose")) return args;

  const printIndex = args.findIndex((arg) => arg === "-p" || arg === "--print");
  const next = [...args];
  next.splice(printIndex + 1, 0, "--verbose");
  return next;
}

export function buildClaudeCodeArgs(request: ProviderChatRequest): string[] {
  return ensureClaudeStreamJsonVerbose([
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    ...buildClaudeCodeBaseArgs(request),
  ]);
}

export function buildClaudeCodePlainTextArgs(request: ProviderChatRequest): string[] {
  return [
    "-p",
    ...buildClaudeCodeBaseArgs(request),
  ];
}

// ---------------------------------------------------------------------------
// Stream-JSON parsing
// ---------------------------------------------------------------------------

interface StreamJsonAssistantEvent {
  type: "assistant";
  message: {
    content?: Array<{ type?: string; text?: string; partial?: boolean }>;
  };
}

/**
 * Parses one stdout line from `claude -p --output-format stream-json`.
 * Returns:
 *   string  — extracted assistant text delta
 *   null    — valid JSON but no text to emit (tool event, system event, etc.)
 *   false   — parse error; caller should fall back to plain-text mode
 */
export function tryParseStreamJsonDelta(line: string): string | null | false {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  if (event["type"] !== "assistant") return null;
  const msg = event["message"];
  if (typeof msg !== "object" || msg === null) return null;
  const content = (msg as StreamJsonAssistantEvent["message"]).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
  return text || null;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

async function runAnthropicApi(request: ProviderChatRequest): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error(ANTHROPIC_ROUTE_SETUP_MESSAGE);
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: request.route.modelId,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(request.projectInstructions?.content ? { system: request.projectInstructions.content } : {}),
      messages: request.conversationHistory?.length
        ? [...request.conversationHistory.map((message) => ({ role: message.role, content: message.content })), { role: "user", content: request.prompt }]
        : [{ role: "user", content: request.prompt }],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic API request failed (${response.status}): ${sanitizeTerminalOutput(body).slice(0, 500)}`);
  }

  const parsed = JSON.parse(body) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = parsed.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Anthropic API returned no assistant text.");
  }

  return text;
}

// ---------------------------------------------------------------------------
// Claude Code CLI execution (streaming)
// ---------------------------------------------------------------------------

function isClaudeStreamJsonRequiresVerboseError(result: CommandResult): boolean {
  const combined = `${result.userMessage}\n${result.stderr}\n${result.stdout}`;
  return /stream-json requires --verbose/i.test(combined);
}

function isClaudeInvalidEffortError(result: CommandResult): boolean {
  const combined = `${result.userMessage}\n${result.stderr}\n${result.stdout}`;
  return /\beffort\b/i.test(combined)
    && /\b(invalid|unsupported|not supported|unknown|expected|allowed|valid)\b/i.test(combined);
}

function withClaudeEffort(request: ProviderChatRequest, effort: string): ProviderChatRequest {
  return {
    ...request,
    route: {
      ...request.route,
      reasoning: effort,
    },
  };
}

function disableClaudeEffortForSession(modelId: string, effort: string): void {
  const models = getActiveAnthropicModels();
  discoveredAnthropicModels = models.map((model) => {
    const isTarget = model.modelId === modelId || model.id === modelId || model.family === modelId || model.canonicalId === modelId;
    if (!isTarget || !model.supportedReasoningLevels) return model;
    return {
      ...model,
      supportedReasoningLevels: model.supportedReasoningLevels.filter((level) => level.id !== effort),
      description: `${model.description ?? model.label} - ${effort} disabled after Claude Code rejection this session`,
    };
  });
}

function formatClaudeCommandDiagnostic(
  executable: string,
  args: string[],
  prompt: string,
): string {
  const safeArgs = args.map((arg) => arg === prompt ? `<prompt redacted: ${prompt.length} chars>` : arg);
  return `Claude Code command args: ${JSON.stringify([executable, ...safeArgs])}`;
}

export function runClaudeCodeWithRunner(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  runCommandImpl: CommandRunner = runCommand,
  executable: string = resolvedClaudeExecutable,
): () => void {
  let currentCancel: (() => void) | null = null;
  let canceled = false;

  const runAttempt = (
    mode: "stream-json" | "plain-text",
    attemptRequest: ProviderChatRequest = request,
    effortFallbackUsed = false,
  ) => {
    const args = mode === "stream-json"
      ? buildClaudeCodeArgs(attemptRequest)
      : buildClaudeCodePlainTextArgs(attemptRequest);
    const spawnSpec = buildClaudeSpawnSpec(executable, args);

    let accumulatedText = "";
    let streamingFailed = false;
    let lineBuf = "";

    const runner = runCommandImpl(
      {
        executable: spawnSpec.executable,
        args: spawnSpec.args,
        cwd: request.workspaceRoot,
        timeoutMs: ANTHROPIC_TIMEOUT_MS,
      },
      {
        onStdout: (chunk) => {
          if (mode !== "stream-json" || streamingFailed) return;
          lineBuf += chunk;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() ?? "";
          for (const line of lines) {
            const delta = tryParseStreamJsonDelta(line);
            if (delta === false) {
              streamingFailed = true;
              return;
            }
            if (delta) {
              accumulatedText += delta;
              handlers.onAssistantDelta?.(delta);
            }
          }
        },
      },
    );

    currentCancel = runner.cancel;
    runner.result.then((result) => {
      if (canceled || result.status === "canceled") return;
      if (result.status !== "completed" || result.exitCode !== 0) {
        const diagnostic = formatClaudeCommandDiagnostic(spawnSpec.executable, spawnSpec.args, request.prompt);
        if (mode === "stream-json" && isClaudeStreamJsonRequiresVerboseError(result)) {
          handlers.onProgress?.({
            id: "anthropic-claude-command-retry",
            source: "stderr",
            text: `${diagnostic}\nClaude Code rejected stream-json args; retrying once with plain text output.`,
          });
          runAttempt("plain-text");
          return;
        }

        const requestedEffort = mapReasoningToEffort(attemptRequest.route.reasoning ?? null);
        const fallbackEffort = getClaudeModelDefaultEffort(attemptRequest.route.modelId, getActiveAnthropicModels());
        if (requestedEffort && isClaudeInvalidEffortError(result)) {
          disableClaudeEffortForSession(attemptRequest.route.modelId, requestedEffort);
        }
        if (!effortFallbackUsed && requestedEffort && requestedEffort !== fallbackEffort && isClaudeInvalidEffortError(result)) {
          const fallbackRequest = withClaudeEffort(attemptRequest, fallbackEffort);
          const fallbackArgs = mode === "stream-json"
            ? buildClaudeCodeArgs(fallbackRequest)
            : buildClaudeCodePlainTextArgs(fallbackRequest);
          const fallbackSpawnSpec = buildClaudeSpawnSpec(executable, fallbackArgs);
          handlers.onProgress?.({
            id: "anthropic-claude-effort-fallback",
            source: "stderr",
            text: [
              `${diagnostic}`,
              `Claude Code rejected effort "${requestedEffort}" for ${request.route.modelId}; retrying once with --effort ${fallbackEffort}.`,
              formatClaudeCommandDiagnostic(fallbackSpawnSpec.executable, fallbackSpawnSpec.args, request.prompt),
            ].join("\n"),
          });
          runAttempt(mode, fallbackRequest, true);
          return;
        }

        const message = result.userMessage || result.stderr || "Claude Code execution failed.";
        handlers.onError(message, diagnostic);
        return;
      }
      let finalText: string;
      if (mode === "stream-json" && !streamingFailed && accumulatedText !== "") {
        finalText = accumulatedText;
      } else {
        finalText = sanitizeTerminalOutput(result.stdout).trim();
        if (finalText && (mode !== "stream-json" || accumulatedText === "")) {
          handlers.onAssistantDelta?.(finalText);
        }
      }
      handlers.onFinalAnswerObserved?.(finalText);
      handlers.onResponse(finalText);
    }).catch((error) => {
      if (canceled) return;
      const message = error instanceof Error ? error.message : "Claude Code execution failed.";
      handlers.onError(message);
    });
  };

  runAttempt("stream-json");

  return () => {
    canceled = true;
    currentCancel?.();
  };
}

function runClaudeCode(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
): () => void {
  return runClaudeCodeWithRunner(request, handlers);
}

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

export async function validateAnthropicRoute(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runCommandImpl?: CommandRunner;
  timeoutMs?: number;
  configuredPath?: string | null;
}): Promise<ProviderRouteValidationResult> {
  let discovery: ClaudeCodeCapabilityDiscovery;
  try {
    discovery = await discoverClaudeCodeCapabilities({
      cwd: options.cwd,
      runCommandImpl: options.runCommandImpl,
      configuredPath: options.configuredPath,
      timeoutMs: options.timeoutMs ?? ANTHROPIC_ROUTE_VALIDATION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve Claude executable.";
    return {
      status: "not-configured",
      providerId: "anthropic",
      backendKind: "unavailable",
      message,
      diagnostics: { resolvedCommand: null },
    };
  }

  resolvedClaudeExecutable = discovery.resolvedCommand;
  claudeCapabilityDiscovery = discovery;
  discoveredAnthropicModels = claudeCodeModelsToProviderModels(discovery.models);

  const diagnostics: Record<string, string | number | boolean | null> = {
    resolvedCommand: discovery.resolvedCommand,
    executablePath: discovery.resolvedCommand,
    authCommand: `${discovery.resolvedCommand} auth status`,
    modelSource: discovery.modelSource,
    discoveredAt: discovery.discoveredAt,
    loggedIn: discovery.auth.loggedIn,
    authMethod: discovery.auth.authMethod ?? null,
    apiProvider: discovery.auth.apiProvider ?? null,
    subscriptionType: discovery.auth.subscriptionType ?? null,
    settingsPath: discovery.settings?.path ?? null,
    settingsModel: discovery.settings?.model ?? null,
    settingsEffortLevel: discovery.settings?.effortLevel ?? null,
    ...(discovery.diagnostics ?? {}),
  };

  if (discovery.auth.loggedIn === true) {
    claudeCodeValidated = true;
    const authMethodLabel = discovery.auth.authMethod ?? null;
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: "claude-code-auth",
      message: authMethodLabel
        ? `Claude Code authenticated (${authMethodLabel}).`
        : "Claude Code auth is configured.",
      diagnostics,
    };
  }

  claudeCodeValidated = false;

  if (getAnthropicApiKey() !== null) {
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: "anthropic-api-key",
      message: "Anthropic API key is configured.",
      diagnostics,
    };
  }

  const authStatus = String(diagnostics["authStatus"] ?? "");
  const authExitCode = diagnostics["authExitCode"];
  const authJsonParsed = diagnostics["authJsonParsed"] === true;
  let message: string;
  if (authStatus === "spawn_error") {
    message = `\`${discovery.resolvedCommand}\` command not found. Install Claude Code from https://claude.ai/code or set CLAUDE_EXECUTABLE to the full path.`;
  } else if (authStatus === "timeout") {
    message = `Claude Code auth check timed out. Run: ${discovery.resolvedCommand} auth status`;
  } else if (authExitCode === 1) {
    message = `Claude Code is installed but not signed in. Run: ${discovery.resolvedCommand} auth login`;
  } else if (!authJsonParsed) {
    message = `Claude Code auth status did not return valid JSON. Run: ${discovery.resolvedCommand} auth status`;
  } else {
    message = `Claude Code is not signed in. Run: ${discovery.resolvedCommand} auth login`;
  }

  return {
    status: "not-configured",
    providerId: "anthropic",
    backendKind: "unavailable",
    message,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function getAnthropicRuntimeBackendKind(): ProviderBackendKind {
  return claudeCodeValidated ? "claude-code-auth" : getAnthropicApiKey() ? "anthropic-api-key" : "claude-code-auth";
}

function getActiveAnthropicModels(): readonly ProviderModel[] {
  return discoveredAnthropicModels ?? ANTHROPIC_FALLBACK_MODELS;
}

export const anthropicRuntime: ProviderRuntime = {
  providerId: "anthropic",
  label: "Anthropic/Claude",
  modelPickerLabel: "Claude",
  backendKind: "claude-code-auth",
  routeAvailable: true,
  routeStatus: "Routes through Claude Code CLI when authenticated (`claude auth status` exit 0), or via ANTHROPIC_API_KEY.",
  routeSetupMessage: ANTHROPIC_ROUTE_SETUP_MESSAGE,
  launchAvailable: true,
  isRouteConfigured: isAnthropicRouteConfigured,
  validateRoute: async ({ workspaceRoot, claudeCommandPath }) => validateAnthropicRoute({
    cwd: workspaceRoot,
    configuredPath: claudeCommandPath,
  }),
  discoverModels: (): ProviderModelDiscoveryResult => ({
    status: "ready",
    providerId: "anthropic",
    backendKind: getAnthropicRuntimeBackendKind(),
    models: getActiveAnthropicModels(),
    message: (claudeCapabilityDiscovery?.modelSource ?? "fallback") === "fallback"
      ? DISCOVERY_FAILURE_MESSAGE
      : undefined,
    diagnostics: claudeCapabilityDiscovery ? {
      resolvedCommand: claudeCapabilityDiscovery.resolvedCommand,
      modelSource: claudeCapabilityDiscovery.modelSource,
      discoveredAt: claudeCapabilityDiscovery.discoveredAt,
      loggedIn: claudeCapabilityDiscovery.auth.loggedIn,
      settingsPath: claudeCapabilityDiscovery.settings?.path ?? null,
    } : { modelSource: "fallback" },
  }),
  refreshModels: async ({ cwd }): Promise<ProviderModelDiscoveryResult> => {
    let discovery: ClaudeCodeCapabilityDiscovery;
    try {
      discovery = await discoverClaudeCodeCapabilities({ cwd, runCommandImpl: runCommand });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claude capability refresh failed.";
      return {
        status: "ready",
        providerId: "anthropic",
        backendKind: getAnthropicRuntimeBackendKind(),
        models: getActiveAnthropicModels(),
        message: `Refresh Claude capabilities failed; keeping previous Claude capability data. ${message}`,
        diagnostics: {
          resolvedCommand: resolvedClaudeExecutable,
          modelSource: claudeCapabilityDiscovery?.modelSource ?? "fallback",
          refreshFailed: true,
        },
      };
    }
    resolvedClaudeExecutable = discovery.resolvedCommand;
    claudeCapabilityDiscovery = discovery;
    claudeCodeValidated = discovery.auth.loggedIn;
    discoveredAnthropicModels = claudeCodeModelsToProviderModels(discovery.models);
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: getAnthropicRuntimeBackendKind(),
      models: discoveredAnthropicModels,
      message: discovery.modelSource === "fallback"
        ? DISCOVERY_FAILURE_MESSAGE
        : `Refreshed Claude capabilities (${discovery.modelSource}).`,
      diagnostics: {
        resolvedCommand: discovery.resolvedCommand,
        modelSource: discovery.modelSource,
        discoveredAt: discovery.discoveredAt,
        loggedIn: discovery.auth.loggedIn,
      },
    };
  },
  run: (request, handlers: BackendRunHandlers) => {
    handlers.onProgress?.({
      id: "anthropic-route",
      source: "stdout",
      text: "Starting Claude Code",
    });

    if (claudeCodeValidated) {
      return runClaudeCode(request, handlers);
    }

    if (getAnthropicApiKey()) {
      let cancelled = false;
      runAnthropicApi(request)
        .then((text) => {
          if (cancelled) return;
          handlers.onAssistantDelta?.(text);
          handlers.onFinalAnswerObserved?.(text);
          handlers.onResponse(text);
        })
        .catch((error) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : "Anthropic/Claude in-Ubume routing failed.";
          handlers.onError(message);
        });
      return () => { cancelled = true; };
    }

    return runClaudeCode(request, handlers);
  },
};
