import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type { BackendRunHandlers, ToolApprovalDecision } from "../../providers/types.js";
import type { ProviderChatRequest } from "../types.js";
import type { LocalHarnessSessionMetadata } from "../../workspace/conversationStore.js";
import { resolveCodexaWorkspaceDataDir } from "../../workspace/appData.js";
import { getShellWorkspaceGuardMessage, isPathInsideAllowedRoots } from "../../workspace/workspaceGuard.js";
import { isDangerousShellCommand } from "../../agent/tools.js";
import { traceLocalStream } from "../../debug/localStreamDebug.js";

const HARNESS_VERSION = "0.1.1-rc.2";
const PROFILE_NAME = "codexa-local";
const INTERNAL_PROVIDER = "codexa-local";
const require = createRequire(import.meta.url);
const PROCESS_FINGERPRINT_KEY = randomBytes(32);

interface HarnessNotification {
  sessionId?: string;
  status?: string;
  event?: { seq?: number; type?: string; data?: Record<string, unknown> };
  childSessionId?: string;
  parentSessionId?: string;
}

interface HarnessRunState {
  sessionId: string;
  handlers: BackendRunHandlers;
  request: ProviderChatRequest;
  text: string;
  runningSeen: boolean;
  settled: boolean;
  toolArguments: Map<string, { tool: string; arguments: Record<string, unknown> }>;
  reasoningText: Map<string, string>;
  approvals: Set<string>;
  sessionMetadata: LocalHarnessSessionMetadata;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  abortCleanup: () => void;
  turnFailure?: string;
  lastUsage?: { inputTokens: number; outputTokens: number; contextTokens: number; contextWindow: number | null; exact: boolean };
}

interface HarnessConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
}

type HarnessSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

function resolveHarnessSandboxMode(request: ProviderChatRequest): HarnessSandboxMode {
  if (request.runIntent === "plan" || request.runtime.planMode) return "read-only";
  const mode = String(request.runtime.policy.sandboxMode);
  if (mode === "read-only") return "read-only";
  if (mode === "danger-full-access" || mode === "full-access") return "danger-full-access";
  return "workspace-write";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (Array.isArray(block.content)) return [textFromContent(block.content)];
    return [];
  }).join("");
}

function transcriptHash(request: ProviderChatRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(request.conversationHistory ?? []))
    .digest("hex");
}

function routeFingerprint(config: HarnessConfig, request: ProviderChatRequest): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: config.baseUrl,
    model: config.model,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    supportsVision: config.supportsVision,
    sandbox: resolveHarnessSandboxMode(request),
    writableRoots: request.runtime.policy.writableRoots,
  })).digest("hex");
}

function secretFingerprint(value: string): string {
  // This only detects credential changes during this process. A process-local
  // HMAC key prevents the fingerprint from becoming an offline API-key oracle.
  return createHmac("sha256", PROCESS_FINGERPRINT_KEY).update(value).digest("hex");
}

function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "configured Local endpoint";
  }
}

function resolveDshBin(): string {
  const packagePath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: { dsh?: string } };
  if (!manifest.bin?.dsh) throw new Error("The installed @deepseek-ai/dsh package has no dsh executable.");
  return resolve(dirname(packagePath), manifest.bin.dsh);
}

function bridgePath(): string {
  return fileURLToPath(new URL("../../../../bin/codexa-local-harness-bridge.js", import.meta.url));
}

function profilePatch(supportsVision: boolean): string {
  const input = supportsVision ? "[text, image]" : "[text]";
  return `- id: hmr
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: web
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: tool-web
  disabled: true
- id: agent-default-model
  config:
    provider: ${INTERNAL_PROVIDER}
    model: !!js process.env.CODEXA_DSH_MODEL
- id: llm-pi-ai
  config:
    providers:
      ${INTERNAL_PROVIDER}:
        displayName: Codexa Local
        apiKeyEnv: CODEXA_DSH_API_KEY
        api: openai-completions
        baseURL: !!js process.env.CODEXA_DSH_BASE_URL
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        defaultContextWindow: !!js Number(process.env.CODEXA_DSH_CONTEXT_WINDOW)
        defaultMaxTokens: !!js Number(process.env.CODEXA_DSH_MAX_TOKENS)
        defaultInput: ${input}
        models:
          - id: !!js process.env.CODEXA_DSH_MODEL
            name: !!js process.env.CODEXA_DSH_MODEL
            contextWindow: !!js Number(process.env.CODEXA_DSH_CONTEXT_WINDOW)
            maxTokens: !!js Number(process.env.CODEXA_DSH_MAX_TOKENS)
            input: ${input}
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: !!js process.env.CODEXA_DSH_APPROVAL_POLICY
- id: permission
  config:
    defaultPreset: !!js process.env.CODEXA_DSH_PERMISSION_PRESET
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: Read only
        description: Read-only access controlled by Codexa.
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: Workspace write
        description: Workspace writes controlled by Codexa.
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: Full access
        description: Full filesystem access controlled by Codexa.
- id: tools
  config:
    mode: native
- id: system-prompt
  config:
    persona: >-
      You are a coding agent running inside Codexa. Work only in the active workspace,
      use the provided Harness tools for shell and file operations, and respect every
      Codexa permission decision.
- insert:
    - id: codexa-local-harness-bridge
      name: ${yamlString(bridgePath())}
`;
}

function ensureProfile(workspaceRoot: string, config: HarnessConfig): string {
  const home = join(resolveCodexaWorkspaceDataDir(workspaceRoot), "local-harness", `v-${HARNESS_VERSION}`);
  const profileDir = join(home, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), `${JSON.stringify({
    private: true,
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(profileDir, "cordis.patch.yml"), profilePatch(config.supportsVision), "utf8");
  return home;
}

function resolveHarnessConfig(request: ProviderChatRequest): HarnessConfig {
  const resolved = request.resolvedLocalAgentConfig;
  const selectedBackend = request.route.localBackend ?? request.localConfig?.localBackend;
  if (selectedBackend === "unsloth" && !resolved) {
    throw new Error("Local agent request failed: the selected Unsloth connection was not resolved before Harness startup.");
  }
  const local = request.localConfig;
  const model = resolved?.modelId ?? (request.route.modelId || local?.pinnedModel || local?.currentModel || local?.defaultModel || "");
  if (!model) throw new Error("Local agent request failed: no Local model is selected.");
  const modelConfig = local?.models?.[model];
  if (resolved?.supportsToolCalls === false || modelConfig?.supportsToolCalls === false) {
    throw new Error(`Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without tool/function-calling support required by the Local agent harness.`);
  }
  if (resolved?.supportsStreaming === false || modelConfig?.supportsStreaming === false) {
    throw new Error(`Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without streaming support required by Codexa's Local agent harness.`);
  }
  if (resolved?.supportsSystemPrompt === false || modelConfig?.supportsSystemPrompt === false) {
    throw new Error(`Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without system-prompt support required by the Local agent harness.`);
  }
  return {
    baseUrl: (resolved?.baseUrl ?? local?.baseUrl ?? process.env.CODEXA_LOCAL_BASE_URL ?? "http://localhost:1234/v1").replace(/\/+$/, ""),
    apiKey: resolved?.apiKey ?? local?.apiKey ?? process.env.CODEXA_LOCAL_API_KEY ?? "lm-studio",
    model,
    contextWindow: resolved?.contextWindow ?? modelConfig?.contextLength ?? 32_768,
    maxTokens: resolved?.maxTokens ?? modelConfig?.maxOutputTokens ?? 8_192,
    supportsVision: resolved?.supportsVision ?? modelConfig?.supportsVision === true,
  };
}

function normalizedArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function commandFrom(tool: string, args: Record<string, unknown>): string {
  if ((tool === "bash" || tool === "pwsh") && typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return `${tool} ${args.path}`;
  if (typeof args.file_path === "string") return `${tool} ${args.file_path}`;
  return tool;
}

function pathsFrom(args: Record<string, unknown>): string[] {
  return [args.path, args.file_path, args.old_path, args.new_path]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isMutatingTool(tool: string): boolean {
  return ["bash", "pwsh", "write", "edit", "str_replace_editor"].includes(tool);
}

export interface LocalHarnessRunner {
  run(request: ProviderChatRequest, handlers: BackendRunHandlers, signal: AbortSignal): Promise<string>;
  shutdown(): Promise<void>;
  terminate(): void;
  closeSession?(sessionId: string): Promise<void>;
}

export class LocalHarnessProcess implements LocalHarnessRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: JsonRpcLineTransport | null = null;
  private fingerprint = "";
  private active: HarnessRunState | null = null;
  private stderr = "";
  private redactions: string[] = [];

  async run(request: ProviderChatRequest, handlers: BackendRunHandlers, signal: AbortSignal): Promise<string> {
    const config = resolveHarnessConfig(request);
    const fingerprint = routeFingerprint(config, request);
    const processFingerprint = `${fingerprint}:${secretFingerprint(config.apiKey)}`;
    await this.ensureStarted(request, config, processFingerprint, handlers);
    const metadata = request.localHarnessSession;
    const canResume = metadata?.routeFingerprint === fingerprint
      && metadata.throughMessageCount === (request.conversationHistory?.length ?? 0)
      && metadata.transcriptHash === transcriptHash(request);
    if (metadata && !canResume) {
      await this.transport!.request("session/close", { sessionId: metadata.sessionId }).catch(() => undefined);
    }
    const sessionId = canResume ? metadata.sessionId : randomUUID();
    traceLocalStream("harness.session.open", { sessionId, model: config.model, resumed: canResume, endpoint: sanitizedEndpoint(config.baseUrl) });
    await this.transport!.request("session/open", {
      sessionId,
      resume: canResume,
    }, signal);

    const sessionMetadata: LocalHarnessSessionMetadata = {
      version: 1,
      sessionId,
      harnessVersion: HARNESS_VERSION,
      routeFingerprint: fingerprint,
      throughMessageCount: request.conversationHistory?.length ?? 0,
      transcriptHash: transcriptHash(request),
      updatedAt: new Date().toISOString(),
    };
    handlers.onLocalHarnessSession?.(sessionMetadata);

    return new Promise<string>((resolveRun, rejectRun) => {
      const state: HarnessRunState = {
        sessionId,
        handlers,
        request,
        text: "",
        runningSeen: false,
        settled: false,
        toolArguments: new Map(),
        reasoningText: new Map(),
        approvals: new Set(),
        sessionMetadata,
        resolve: resolveRun,
        reject: rejectRun,
        abortCleanup: () => undefined,
      };
      this.active = state;
      const abort = () => {
        traceLocalStream("harness.request.cancel", { sessionId });
        void this.transport?.request("session/cancel", { sessionId }).catch(() => this.terminate());
      };
      signal.addEventListener("abort", abort, { once: true });
      state.abortCleanup = () => signal.removeEventListener("abort", abort);
      const history = request.conversationHistory ?? [];
      const promptContent = !canResume && history.length > 0
        ? [
          "Codexa restored the following visible conversation into a new Local Harness session.",
          "Treat it as prior dialogue; prior ephemeral tool state is unavailable.",
          "",
          ...history.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
          "",
          `USER: ${request.prompt}`,
        ].join("\n")
        : request.prompt;
      if (!canResume && history.length > 0) {
        handlers.onProgress?.({
          id: "local-harness-session-migration",
          source: "transcript",
          text: "Restored visible Codexa history into a new Local Harness session; prior ephemeral tool state was not available.",
        });
      }
      void this.transport!.request("session/prompt", { sessionId, content: promptContent }, signal)
        .catch((error) => this.failActive(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async ensureStarted(request: ProviderChatRequest, config: HarnessConfig, fingerprint: string, handlers: BackendRunHandlers): Promise<void> {
    if (this.child && this.transport && this.fingerprint === fingerprint) return;
    await this.shutdown();
    handlers.onProcessLifecycle?.("before-spawn");
    const dshHome = ensureProfile(request.workspaceRoot, config);
    const harnessSandboxMode = resolveHarnessSandboxMode(request);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
      DSH_PERMISSION_MODE: harnessSandboxMode,
      CODEXA_DSH_PERMISSION_PRESET: harnessSandboxMode,
      CODEXA_DSH_APPROVAL_POLICY: harnessSandboxMode === "danger-full-access" ? "never" : "ask",
      CODEXA_DSH_BASE_URL: config.baseUrl,
      CODEXA_DSH_API_KEY: config.apiKey,
      CODEXA_DSH_MODEL: config.model,
      CODEXA_DSH_CONTEXT_WINDOW: String(config.contextWindow),
      CODEXA_DSH_MAX_TOKENS: String(config.maxTokens),
      CODEXA_DSH_VISION: config.supportsVision ? "1" : "0",
    };
    const child = spawn(process.env.CODEXA_NODE_PATH?.trim() || "node", [resolveDshBin(), "--profile", PROFILE_NAME], {
      cwd: request.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    traceLocalStream("harness.start", { model: config.model, endpoint: sanitizedEndpoint(config.baseUrl), workspaceRoot: request.workspaceRoot });
    this.stderr = "";
    this.redactions = [config.apiKey].filter((value) => value.length >= 6);
    let startupSettled = false;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    // Every listener below guards on `this.child === child`: shutdown() and
    // terminate() null `this.child` before the outgoing child can emit, so a
    // stale generation must never mutate state owned by its replacement.
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-12_000);
    });
    child.once("spawn", () => handlers.onProcessLifecycle?.("spawned"));
    child.once("error", (error) => {
      if (this.child !== child) return;
      handlers.onProcessLifecycle?.("error");
      if (!startupSettled) rejectStartup(error);
      this.failActive(error);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      handlers.onProcessLifecycle?.("exit");
      this.child = null;
      this.transport?.close();
      this.transport = null;
      if (!startupSettled) rejectStartup(new Error(`Local Harness exited during startup (${code ?? "signal"}).`));
      if (this.active && !this.active.settled) {
        const safeStderr = this.redactions.reduce((text, secret) => text.split(secret).join("[redacted]"), this.stderr).trim();
        this.failActive(new Error(`Local Harness exited unexpectedly (${code ?? "signal"}).${safeStderr ? `\n${safeStderr}` : ""}`));
      }
    });
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    this.transport = transport;
    transport.onNotification((method, params) => this.onNotification(method, params as HarnessNotification));
    transport.onRequest((method, params) => this.onBridgeRequest(method, params));
    transport.start();
    try {
      await Promise.race([
        transport.request("initialize", {
          cwd: request.workspaceRoot,
          provider: INTERNAL_PROVIDER,
          model: config.model,
          maxTokens: config.maxTokens,
        }),
        startupFailure,
      ]);
      startupSettled = true;
      this.fingerprint = fingerprint;
    } catch (error) {
      startupSettled = true;
      this.terminate();
      const message = error instanceof Error ? error.message : String(error);
      const safeStderr = this.redactions.reduce((text, secret) => text.split(secret).join("[redacted]"), this.stderr).trim();
      throw new Error(`Local Harness startup failed.\n\nModel: ${config.model}\nEndpoint: ${sanitizedEndpoint(config.baseUrl)}\n\n${message}${safeStderr ? `\n${safeStderr}` : ""}`);
    }
  }

  private onNotification(method: string, params: HarnessNotification): void {
    const state = this.active;
    const ownsNotification = params.sessionId === state?.sessionId || params.parentSessionId === state?.sessionId;
    if (!state || !ownsNotification || state.settled) return;
    if (method === "subagent.started" || method === "subagent.finished") {
      const childId = params.childSessionId ?? "subagent";
      const finished = method === "subagent.finished";
      state.handlers.onToolActivity?.({
        id: `local-subagent-${childId}`,
        command: `Subagent ${childId}`,
        status: finished ? (params.status === "error" ? "failed" : "completed") : "running",
        startedAt: Date.now(),
        ...(finished ? { completedAt: Date.now() } : {}),
      });
      return;
    }
    if (method === "session.status") {
      if (params.status === "running") state.runningSeen = true;
      if (params.status === "idle" && state.runningSeen) {
        if (state.turnFailure) this.failActive(new Error(state.turnFailure));
        else this.completeActive();
      }
      return;
    }
    if (method !== "session.event" || !params.event) return;
    const event = params.event;
    const data = event.data ?? {};
    if (event.type?.startsWith("compaction/")) {
      state.handlers.onProgress?.({
        id: "local-harness-compaction",
        source: "transcript",
        text: event.type.endsWith("/end") ? "Local Harness compacted the conversation context." : "Local Harness is compacting conversation context.",
      });
      if (event.type.endsWith("/end") && state.lastUsage) {
        state.handlers.onContextUsage?.({ ...state.lastUsage, compacted: true });
      }
      return;
    }
    if (event.type === "turn/end" && isRecord(data.reason)) {
      const reason = data.reason;
      if (reason.kind === "error") {
        const failure = isRecord(reason.error) ? reason.error : {};
        const message = typeof failure.message === "string" ? failure.message : "The Local Harness model request failed.";
        state.turnFailure = [
          `Local agent request failed: ${message}`,
          "",
          `Backend: ${state.request.resolvedLocalAgentConfig?.localBackend ?? state.request.route.localBackend ?? "local"}`,
          `Model: ${state.request.route.modelId}`,
          `Endpoint: ${sanitizedEndpoint(state.request.resolvedLocalAgentConfig?.baseUrl ?? state.request.localConfig?.baseUrl ?? "")}`,
          "",
          "Verify that the server supports OpenAI-compatible streaming and native tool/function calling, and that the model's chat template has tool support enabled.",
        ].join("\n");
      } else if (reason.kind === "blocked") {
        state.turnFailure = "The Local Harness blocked this turn before completion.";
      }
      return;
    }
    if (event.type === "assistant/chunk" && isRecord(data.chunk)) {
      const chunk = data.chunk;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        state.text += chunk.text;
        state.handlers.onAssistantDelta?.(chunk.text);
      } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
        const step = typeof data.step === "number" ? data.step : 0;
        const index = typeof chunk.index === "number" ? chunk.index : 0;
        const reasoningKey = `${step}:${index}`;
        const text = `${state.reasoningText.get(reasoningKey) ?? ""}${chunk.text}`;
        state.reasoningText.set(reasoningKey, text);
        state.handlers.onProgress?.({
          id: `local-reasoning-${state.sessionId}-${step}-${index}`,
          source: "reasoning",
          text,
        });
      } else if (chunk.type === "usage" && isRecord(chunk.usage)) {
        this.emitUsage(state, chunk.usage);
      }
      return;
    }
    if (event.type === "assistant/message") {
      if (isRecord(data.usage)) this.emitUsage(state, data.usage);
      if (!state.text && isRecord(data.message)) {
        const finalText = textFromContent(data.message.content);
        if (finalText) {
          state.text = finalText;
          state.handlers.onAssistantDelta?.(finalText);
        }
      }
      return;
    }
    if (event.type === "tool/call") {
      const callId = String(data.callId ?? event.seq ?? randomUUID());
      const tool = String(data.name ?? "tool");
      let args: Record<string, unknown> = {};
      try { args = normalizedArgs(JSON.parse(String(data.arguments ?? "{}"))); } catch { /* malformed args stay empty */ }
      state.toolArguments.set(callId, { tool, arguments: args });
      traceLocalStream("harness.tool.call", { sessionId: state.sessionId, callId, tool, arguments: args });
      state.handlers.onToolActivity?.({
        id: `local-tool-${callId}`,
        command: commandFrom(tool, args),
        status: "running",
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === "tool/result" && isRecord(data.message)) {
      const source = isRecord(data.message.source) ? data.message.source : {};
      const callId = String(source.callId ?? event.seq ?? "result");
      const known = state.toolArguments.get(callId);
      const failed = isRecord(data.error);
      state.handlers.onToolActivity?.({
        id: `local-tool-${callId}`,
        command: known ? commandFrom(known.tool, known.arguments) : "Harness tool",
        status: failed ? "failed" : "completed",
        startedAt: Date.now(),
        completedAt: Date.now(),
        summary: textFromContent(data.message.content).slice(0, 2_000) || (failed ? "Tool failed" : "Tool completed"),
      });
    }
  }

  private emitUsage(state: HarnessRunState, usage: Record<string, unknown>): void {
    const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    const normalized = {
      inputTokens,
      outputTokens,
      contextTokens: inputTokens + outputTokens,
      contextWindow: state.request.localConfig?.models?.[state.request.route.modelId]?.contextLength ?? null,
      exact: true,
    };
    state.lastUsage = normalized;
    state.handlers.onContextUsage?.(normalized);
  }

  private async onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const state = this.active;
    if (!state || params.sessionId !== state.sessionId) return method === "approval/request" ? { outcome: "rejected" } : { kind: "deny", reason: "No active Codexa Local run owns this tool call." };
    if (method === "tool/policy") {
      const tool = String(params.tool ?? "tool");
      const callId = String(params.callId ?? "");
      const args = normalizedArgs(params.arguments);
      if (callId) state.toolArguments.set(callId, { tool, arguments: args });
      if (!isMutatingTool(tool)) return { kind: "allow" };
      if (state.request.runIntent === "plan" || state.request.runtime.policy.sandboxMode === "read-only") {
        return { kind: "deny", reason: "Codexa's current runtime policy is read-only." };
      }
      const command = typeof args.command === "string" ? args.command : "";
      if (command && isDangerousShellCommand(command)) return { kind: "deny", reason: "Shell command blocked as dangerous." };
      if (command) {
        const guard = getShellWorkspaceGuardMessage(command, state.request.workspaceRoot, state.request.runtime.policy.writableRoots);
        if (guard) return { kind: "deny", reason: guard };
      }
      for (const candidatePath of pathsFrom(args)) {
        if (!isPathInsideAllowedRoots(candidatePath, state.request.workspaceRoot, state.request.runtime.policy.writableRoots)) {
          return { kind: "deny", reason: `Path is outside the active workspace: ${candidatePath}` };
        }
      }
      const signature = `${tool}:${command || pathsFrom(args).join(",")}`;
      if (state.approvals.has(signature)) return { kind: "allow" };
      if (state.request.runtime.policy.approvalPolicy === "on-request") return { kind: "ask", reason: `Allow ${commandFrom(tool, args)}?` };
      return { kind: "allow" };
    }
    if (method === "approval/request") {
      const callId = String(params.callId ?? "");
      const known = state.toolArguments.get(callId);
      const tool = String(params.tool ?? known?.tool ?? "tool");
      const args = known?.arguments ?? {};
      if (!state.handlers.onToolApproval) return { outcome: "rejected" };
      const signature = `${tool}:${commandFrom(tool, args)}`;
      const decision: ToolApprovalDecision = await state.handlers.onToolApproval({
        tool,
        signature,
        command: typeof args.command === "string" ? args.command : undefined,
        paths: pathsFrom(args),
      });
      if (decision === "allow-for-run") state.approvals.add(`${tool}:${typeof args.command === "string" ? args.command : pathsFrom(args).join(",")}`);
      return { outcome: decision === "deny" ? "rejected" : "allowed-once" };
    }
    throw new Error(`Unknown Local Harness bridge request: ${method}`);
  }

  private completeActive(): void {
    const state = this.active;
    if (!state || state.settled) return;
    if (!state.text.trim()) {
      this.failActive(new Error([
        "Local agent request failed: the Harness turn completed without visible assistant output.",
        "",
        `Backend: ${state.request.resolvedLocalAgentConfig?.localBackend ?? state.request.route.localBackend ?? "local"}`,
        `Model: ${state.request.route.modelId}`,
        `Endpoint: ${sanitizedEndpoint(state.request.resolvedLocalAgentConfig?.baseUrl ?? state.request.localConfig?.baseUrl ?? "")}`,
        "Verify the model chat template, streaming response format, and native tool/function-calling support.",
      ].join("\n")));
      return;
    }
    state.settled = true;
    state.abortCleanup();
    this.active = null;
    const completedMessages = [
      ...(state.request.conversationHistory ?? []),
      { role: "user", content: state.request.prompt },
      { role: "assistant", content: state.text },
    ];
    state.handlers.onLocalHarnessSession?.({
      ...state.sessionMetadata,
      throughMessageCount: completedMessages.length,
      transcriptHash: createHash("sha256").update(JSON.stringify(completedMessages)).digest("hex"),
      updatedAt: new Date().toISOString(),
    });
    state.handlers.onFinalAnswerObserved?.(state.text);
    traceLocalStream("harness.request.complete", { sessionId: state.sessionId, responseCharacters: state.text.length });
    state.resolve(state.text);
  }

  private failActive(error: Error): void {
    const state = this.active;
    if (!state || state.settled) return;
    state.settled = true;
    state.abortCleanup();
    this.active = null;
    traceLocalStream("harness.request.error", { sessionId: state.sessionId, error: error.message });
    state.reject(error);
  }

  async shutdown(): Promise<void> {
    const transport = this.transport;
    const child = this.child;
    this.transport = null;
    this.child = null;
    this.fingerprint = "";
    if (!child) return;
    traceLocalStream("harness.shutdown", {});
    try {
      await Promise.race([
        transport?.request("shutdown", {}) ?? Promise.resolve(),
        new Promise((resolveWait) => setTimeout(resolveWait, 1_500)),
      ]);
    } catch { /* terminate below */ }
    transport?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    // Wait for the child to actually exit so the next ensureStarted() never
    // overlaps a dying generation with a freshly spawned one.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise<boolean>((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
      if (!exited) child.kill("SIGKILL");
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.transport || !sessionId) return;
    await this.transport.request("session/close", { sessionId });
  }

  terminate(): void {
    this.transport?.close();
    this.transport = null;
    if (this.child?.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    this.child = null;
    this.fingerprint = "";
  }
}

let sharedProcess: LocalHarnessRunner = new LocalHarnessProcess();

export function resetLocalHarnessProcessForTests(processOverride: LocalHarnessRunner = new LocalHarnessProcess()): void {
  sharedProcess.terminate();
  sharedProcess = processOverride;
}

export function runLocalHarness(request: ProviderChatRequest, handlers: BackendRunHandlers, signal: AbortSignal): Promise<string> {
  return sharedProcess.run(request, handlers, signal);
}

export function shutdownLocalHarness(): Promise<void> {
  return sharedProcess.shutdown();
}

export function closeLocalHarnessSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId || !sharedProcess.closeSession) return Promise.resolve();
  return sharedProcess.closeSession(sessionId);
}

export const localHarnessTestUtils = {
  resolveHarnessConfig,
  resolveHarnessSandboxMode,
  routeFingerprint,
  secretFingerprint,
  profilePatch,
};
