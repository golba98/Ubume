import { createHash } from "node:crypto";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { runAgentLoop, type AgentChatMessage, type AgentChatResponse } from "../agent/loop.js";
import { agentToolDefinitions, parseOpenAiToolCallsDetailed } from "../agent/protocol.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { LocalBackendId, ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import type {
  ProviderChatRequest,
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRouteValidationResult,
  ProviderRuntime,
} from "./types.js";
import { resolveModelCapabilityProfileCached, clearModelCapabilityProfileCache } from "./capabilityProfile.js";
import { clearModelContextMetadataCache, resolveModelContextLengthCached } from "./contextMetadata.js";
import { deriveLmStudioApiRoot, fetchLmStudioModels, type LmStudioModelInfo, type LmStudioModelList } from "./lmstudio.js";
import { parseUnslothModels, resolveUnslothConnection } from "./unsloth.js";
import { traceLocalStream } from "../debug/localStreamDebug.js";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_LOCAL_API_KEY = "lm-studio";
const LOCAL_TIMEOUT_MS = Number(process.env.CODEXA_LOCAL_TIMEOUT_MS?.trim()) || 15_000;
const LOCAL_ROUTE_SETUP_MESSAGE = [
  "Local provider unavailable",
  `Could not reach ${DEFAULT_LOCAL_BASE_URL}`,
  "Start LM Studio, load a model, and enable the local server.",
].join("\n");

type FetchImpl = typeof fetch;

interface LocalProviderConfig {
  localBackend: LocalBackendId;
  enabled: boolean;
  type: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  pinnedModel: string | null;
  currentModel: string | null;
  defaultModel: string | null;
}

interface LocalDiscoveryCache {
  configKey: string;
  result: ProviderModelDiscoveryResult;
  selectedModel: string | null;
  checkedAt: number;
  resolvedConfig: LocalProviderConfig;
}

let configuredOverride: ProviderWorkspaceOverride | null = null;
const discoveryCaches = new Map<LocalBackendId, LocalDiscoveryCache>();

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setLocalProviderConfig(override: ProviderWorkspaceOverride | null | undefined): void {
  configuredOverride = override ?? null;
}

export function resetLocalProviderStateForTests(): void {
  configuredOverride = null;
  discoveryCaches.clear();
  clearModelCapabilityProfileCache();
  clearModelContextMetadataCache();
}

export function resolveLocalProviderConfig(
  override: ProviderWorkspaceOverride | null | undefined = configuredOverride,
  env: NodeJS.ProcessEnv = process.env,
  localBackend: LocalBackendId = override?.localBackend ?? "lm-studio",
): LocalProviderConfig {
  const baseUrl = nonEmpty(override?.baseUrl)
    ?? nonEmpty(env.CODEXA_LOCAL_BASE_URL)
    ?? nonEmpty(env.OPENAI_BASE_URL)
    ?? nonEmpty(env.OPENAI_API_BASE)
    ?? DEFAULT_LOCAL_BASE_URL;
  const apiKey = nonEmpty(override?.apiKey)
    ?? nonEmpty(env.CODEXA_LOCAL_API_KEY)
    ?? nonEmpty(env.OPENAI_API_KEY)
    ?? DEFAULT_LOCAL_API_KEY;
  const currentModel = nonEmpty(override?.currentModel);
  const defaultModel = nonEmpty(override?.defaultModel)
    ?? nonEmpty(env.CODEXA_LOCAL_MODEL);
  const pinnedModel = nonEmpty(override?.pinnedModel);

  return {
    localBackend,
    enabled: override?.enabled !== false,
    type: override?.type ?? "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    pinnedModel,
    currentModel,
    defaultModel,
  };
}

function localConfigKey(config: LocalProviderConfig): string {
  return JSON.stringify({
    localBackend: config.localBackend,
    enabled: config.enabled,
    type: config.type,
    baseUrl: config.baseUrl,
    pinnedModel: config.pinnedModel,
    currentModel: config.currentModel,
    defaultModel: config.defaultModel,
  });
}

function modelFromId(id: string, source: ProviderModel["source"] = "discovered", raw: unknown = null): ProviderModel {
  return {
    id,
    modelId: id,
    label: id,
    description: "Discovered from local OpenAI-compatible /v1/models endpoint.",
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    source,
    raw,
  };
}

function parseModels(body: unknown): ProviderModel[] {
  const rawModels = typeof body === "object" && body !== null
    ? Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : []
    : [];

  const models = rawModels
    .map((item) => {
      if (typeof item === "string") return modelFromId(item, "discovered", item);
      if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
        return modelFromId((item as { id: string }).id, "discovered", item);
      }
      return null;
    })
    .filter((model): model is ProviderModel => Boolean(model?.modelId.trim()));

  const seen = new Set<string>();
  return models.filter((model) => {
    const key = model.modelId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeModelIds(...groups: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const id of group) {
      const trimmed = id.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function mergeProviderModels(v1Models: readonly ProviderModel[], lmStudioModels: LmStudioModelList): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const model of v1Models) {
    byId.set(model.modelId.toLowerCase(), model);
  }
  for (const lmModel of lmStudioModels.data) {
    const key = lmModel.id.toLowerCase();
    const existing = byId.get(key);
    byId.set(key, existing
      ? { ...existing, raw: { ...(isRecord(existing.raw) ? existing.raw : {}), ...lmModel } }
      : modelFromId(lmModel.id, "discovered", lmModel));
  }
  return Array.from(byId.values());
}

function selectFallbackLocalModel(config: LocalProviderConfig, modelIds: readonly string[]): string | null {
  for (const candidate of [config.pinnedModel, config.defaultModel, config.currentModel]) {
    if (candidate && modelIds.includes(candidate)) return candidate;
  }
  return config.pinnedModel ?? config.defaultModel ?? config.currentModel ?? modelIds[0] ?? null;
}

function selectLoadedLmStudioModel(options: {
  config: LocalProviderConfig;
  loadedModels: readonly LmStudioModelInfo[];
  previousModel: string | null;
}): { modelId: string | null; selectionReason: string } {
  const loadedIds = options.loadedModels.map((model) => model.id);
  if (options.config.pinnedModel && loadedIds.includes(options.config.pinnedModel)) {
    return { modelId: options.config.pinnedModel, selectionReason: "pinned-loaded" };
  }
  if (loadedIds.length === 1) {
    return { modelId: loadedIds[0] ?? null, selectionReason: "single-loaded" };
  }
  if (options.previousModel && loadedIds.includes(options.previousModel)) {
    return { modelId: options.previousModel, selectionReason: "previous-loaded" };
  }
  return { modelId: loadedIds[0] ?? null, selectionReason: loadedIds.length > 1 ? "first-loaded" : "none-loaded" };
}

function diagnosticsFor(options: {
  config: LocalProviderConfig;
  status: "available" | "unavailable" | "no-models";
  models: readonly string[];
  selectedModel: string | null;
  lmStudioEndpoint?: string | null;
  loadedModels?: readonly { id: string }[];
  selectedModelPrevious?: string | null;
  selectionReason?: string | null;
  contextField?: string | null;
  error?: string | null;
}): Record<string, string | number | boolean | null> {
  return {
    localBackend: options.config.localBackend,
    enabled: options.config.enabled,
    type: options.config.type,
    baseUrl: options.config.baseUrl,
    lmStudioModelsEndpoint: options.lmStudioEndpoint ?? null,
    pinnedModel: options.config.pinnedModel,
    previousModel: options.selectedModelPrevious ?? null,
    selectedModel: options.selectedModel,
    discoveredModels: options.models.join(", "),
    loadedModels: options.loadedModels?.map((model) => model.id).join(", ") ?? null,
    modelCount: options.models.length,
    endpointCheckResult: options.status,
    selectionReason: options.selectionReason ?? null,
    contextSource: options.contextField
      ? options.config.localBackend === "unsloth" ? "unsloth-api" : "lmstudio-api"
      : null,
    contextRawField: options.contextField ?? null,
    errorMessage: options.error ?? null,
  };
}

function notConfiguredResult(
  config: LocalProviderConfig,
  message: string,
  status: "unavailable" | "no-models" = "unavailable",
  error?: string | null,
): ProviderModelDiscoveryResult {
  return {
    status: "not-configured",
    providerId: "local",
    localBackend: config.localBackend,
    backendKind: "unavailable",
    models: [],
    message,
    diagnostics: diagnosticsFor({ config, status, models: [], selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, error }),
  };
}

export function discoverLocalModels(
  override: ProviderWorkspaceOverride | null | undefined = configuredOverride,
  localBackend: LocalBackendId = override?.localBackend ?? "lm-studio",
): ProviderModelDiscoveryResult {
  const config = resolveLocalProviderConfig(override, process.env, localBackend);
  const key = localConfigKey(config);
  const cache = discoveryCaches.get(localBackend);
  if (cache && (localBackend === "unsloth" || cache.configKey === key)) {
    return cache.result;
  }
  return notConfiguredResult(config, LOCAL_ROUTE_SETUP_MESSAGE);
}

export async function checkLocalProvider(options: {
  override?: ProviderWorkspaceOverride | null;
  localBackend?: LocalBackendId;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
} = {}): Promise<ProviderRouteValidationResult> {
  const localBackend = options.localBackend ?? options.override?.localBackend ?? configuredOverride?.localBackend ?? "lm-studio";
  if (localBackend === "unsloth") return checkUnslothProvider({ ...options, localBackend });
  const config = resolveLocalProviderConfig(options.override ?? configuredOverride, process.env, localBackend);
  const key = localConfigKey(config);
  const previousCache = discoveryCaches.get(localBackend);
  const previousSelectedModel = previousCache?.configKey === key ? previousCache.selectedModel : null;
  clearModelCapabilityProfileCache();
  clearModelContextMetadataCache();

  if (!config.enabled) {
    const result = notConfiguredResult(config, "Local provider is disabled in provider config.");
    discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now(), resolvedConfig: config });
    return {
      status: "not-configured",
      providerId: "local",
      backendKind: "unavailable",
      message: result.message,
      diagnostics: result.diagnostics,
    };
  }

  if (config.type !== "openai-compatible") {
    const message = `Local provider type "${config.type}" is not supported. Use openai-compatible.`;
    const result = notConfiguredResult(config, message);
    discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now(), resolvedConfig: config });
    return {
      status: "not-configured",
      providerId: "local",
      backendKind: "unavailable",
      message,
      diagnostics: result.diagnostics,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(`${config.baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const message = [
        "Local provider unavailable",
        `Could not reach ${config.baseUrl}`,
        sanitizeTerminalOutput(text).slice(0, 300) || `HTTP ${response.status}`,
      ].join("\n");
      const result = notConfiguredResult(config, message, "unavailable", `HTTP ${response.status}`);
      discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now(), resolvedConfig: config });
      return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
    }

    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      const message = "Local provider unavailable\n/v1/models returned invalid JSON.";
      const result = notConfiguredResult(config, message, "unavailable", "invalid JSON");
      discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now(), resolvedConfig: config });
      return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
    }

    const rawModels = parseModels(parsed);
    const v1ModelIds = rawModels.map((model) => model.modelId);
    const apiRoot = deriveLmStudioApiRoot(config.baseUrl);
    const lmStudioEndpoint = apiRoot ? `${apiRoot}/models` : null;
    const lmStudioModels = apiRoot
      ? await fetchLmStudioModels({
        apiRoot,
        fetchImpl,
        signal: controller.signal,
      })
      : null;
    const loadedModels = lmStudioModels?.data.filter((model) => model.state === "loaded") ?? [];
    const loadedModelIds = loadedModels.map((model) => model.id);
    const discoveredIds = mergeModelIds(loadedModelIds, v1ModelIds);

    let selectedModel: string | null = null;
    let selectionReason = "fallback";

    if (lmStudioModels) {
      if (loadedModels.length === 0) {
        const message = "LM Studio is running, but no model is loaded.";
        const models = mergeProviderModels(rawModels, lmStudioModels);
        const result: ProviderModelDiscoveryResult = {
          status: "not-configured",
          providerId: "local",
          localBackend,
          backendKind: "unavailable",
          models,
          message,
          diagnostics: diagnosticsFor({
            config,
            status: "no-models",
            models: discoveredIds,
            selectedModel: null,
            lmStudioEndpoint,
            loadedModels,
            selectedModelPrevious: previousSelectedModel,
            selectionReason: "none-loaded",
            error: message,
          }),
        };
        discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: null, checkedAt: Date.now(), resolvedConfig: config });
        return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
      }

      const loadedSelection = selectLoadedLmStudioModel({
        config,
        loadedModels,
        previousModel: previousSelectedModel,
      });
      selectedModel = loadedSelection.modelId;
      selectionReason = loadedSelection.selectionReason;
    } else {
      selectedModel = selectFallbackLocalModel(config, v1ModelIds);
      selectionReason = selectedModel === config.pinnedModel ? "pinned-available" : "fallback";
    }

    if (discoveredIds.length === 0) {
      const message = "Local endpoint is reachable, but no models were returned. Load a model in LM Studio.";
      const result = notConfiguredResult(config, message, "no-models");
      discoveryCaches.set(localBackend, { configKey: key, result, selectedModel, checkedAt: Date.now(), resolvedConfig: config });
      return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
    }

    const models = lmStudioModels
      ? mergeProviderModels(rawModels, lmStudioModels)
      : rawModels;
    const selectedRaw = models.find((model) => model.modelId === selectedModel)?.raw;
    const contextField = isRecord(selectedRaw) && typeof selectedRaw.loaded_context_length === "number"
      ? "loaded_context_length"
      : null;
    const result: ProviderModelDiscoveryResult = {
      status: "ready",
      providerId: "local",
      localBackend,
      backendKind: "local-openai-compatible",
      models,
      message: [
        "Local provider found",
        "LM Studio endpoint reachable",
        `Model: ${selectedModel}`,
      ].join("\n"),
      diagnostics: diagnosticsFor({
        config,
        status: "available",
        models: discoveredIds,
        selectedModel,
        lmStudioEndpoint,
        loadedModels,
        selectedModelPrevious: previousSelectedModel,
        selectionReason,
        contextField,
      }),
    };
    discoveryCaches.set(localBackend, { configKey: key, result, selectedModel, checkedAt: Date.now(), resolvedConfig: config });
    return {
      status: "ready",
      providerId: "local",
      backendKind: "local-openai-compatible",
      message: result.message,
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = [
      "Local provider unavailable",
      `Could not reach ${config.baseUrl}`,
      "Start LM Studio, load a model, and enable the local server.",
    ].join("\n");
    const result = notConfiguredResult(config, message, "unavailable", errorMessage);
    discoveryCaches.set(localBackend, { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now(), resolvedConfig: config });
    return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function checkUnslothProvider(options: {
  override?: ProviderWorkspaceOverride | null;
  localBackend: "unsloth";
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}): Promise<ProviderRouteValidationResult> {
  const initialConfig = resolveLocalProviderConfig(options.override ?? configuredOverride, process.env, "unsloth");
  clearModelCapabilityProfileCache();
  clearModelContextMetadataCache();
  if (!initialConfig.enabled) {
    const result = notConfiguredResult(initialConfig, "Unsloth is disabled in provider config.");
    discoveryCaches.set("unsloth", { configKey: localConfigKey(initialConfig), result, selectedModel: null, checkedAt: Date.now(), resolvedConfig: initialConfig });
    return { status: "not-configured", providerId: "local", backendKind: "unavailable", message: result.message, diagnostics: result.diagnostics };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const connection = await resolveUnslothConnection({ fetchImpl, signal: controller.signal });
    const config: LocalProviderConfig = { ...initialConfig, baseUrl: connection.baseUrl, apiKey: connection.apiKey };
    const key = localConfigKey(config);
    const previous = discoveryCaches.get("unsloth");
    const response = await fetchImpl(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: "manual", signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(sanitizeTerminalOutput(text).slice(0, 300) || `HTTP ${response.status}`);
    const unslothModels = parseUnslothModels(text.trim() ? JSON.parse(text) as unknown : {});
    const loadedModels = unslothModels.filter((model) => model.loaded === true);
    let status: Record<string, unknown> = {};
    try {
      const statusResponse = await fetchImpl(`${connection.rootUrl}/api/inference/status`, { headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: "manual", signal: controller.signal });
      if (statusResponse.ok) status = await statusResponse.json() as Record<string, unknown>;
    } catch {}
    const activeModel = typeof status.active_model === "string" ? status.active_model : null;
    const loadedIds = loadedModels.map((model) => model.id);
    // A pin is an explicit user override. Otherwise Unsloth's active model is
    // authoritative: persisted defaults describe the previous session and must
    // not pull the route back after the user loads a different model in Studio.
    const selectedModel = [config.pinnedModel, activeModel, config.currentModel, config.defaultModel, previous?.selectedModel, loadedIds[0]]
      .find((candidate): candidate is string => Boolean(candidate && loadedIds.includes(candidate))) ?? null;
    const models = loadedModels.map((model) => modelFromId(model.id, "discovered", {
      ...(isRecord(model.raw) ? model.raw : {}),
      ...(model.id === selectedModel ? status : {}),
      state: "loaded",
      supports_tool_calls: model.id === selectedModel ? status.supports_tools : undefined,
      supports_streaming: true,
      context_length: model.id === selectedModel ? status.context_length : undefined,
      max_context_length: model.id === selectedModel ? status.max_context_length : undefined,
    }));
    if (!selectedModel) {
      const message = "Unsloth Studio is running, but no model is loaded.";
      const result: ProviderModelDiscoveryResult = {
        status: "not-configured", providerId: "local", localBackend: "unsloth", backendKind: "unavailable", models, message,
        diagnostics: diagnosticsFor({ config, status: "no-models", models: unslothModels.map((model) => model.id), selectedModel: null, loadedModels, error: message }),
      };
      discoveryCaches.set("unsloth", { configKey: key, result, selectedModel: null, checkedAt: Date.now(), resolvedConfig: config });
      return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
    }
    const result: ProviderModelDiscoveryResult = {
      status: "ready", providerId: "local", localBackend: "unsloth", backendKind: "local-openai-compatible", models,
      message: ["Local provider found", "Unsloth Studio endpoint reachable", `Model: ${selectedModel}`].join("\n"),
      diagnostics: diagnosticsFor({ config, status: "available", models: loadedIds, selectedModel, loadedModels, selectedModelPrevious: previous?.selectedModel ?? null, selectionReason: selectedModel === activeModel ? "active-loaded" : loadedIds.length === 1 ? "single-loaded" : "preferred-loaded", contextField: typeof status.context_length === "number" ? "context_length" : null }),
    };
    discoveryCaches.set("unsloth", { configKey: key, result, selectedModel, checkedAt: Date.now(), resolvedConfig: config });
    return { status: "ready", providerId: "local", backendKind: "local-openai-compatible", message: result.message, diagnostics: result.diagnostics };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = ["Unsloth provider unavailable", "Start Unsloth Studio and load a model.", errorMessage].join("\n");
    const result = notConfiguredResult(initialConfig, message, "unavailable", errorMessage);
    discoveryCaches.set("unsloth", { configKey: localConfigKey(initialConfig), result, selectedModel: null, checkedAt: Date.now(), resolvedConfig: initialConfig });
    return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function getCachedSelectedModel(config: LocalProviderConfig, routeModel: string): string {
  const candidate = discoveryCaches.get(config.localBackend);
  const cache = candidate?.configKey === localConfigKey(config) ? candidate : null;
  const discoveredIds = cache?.result.models.map((model) => model.modelId) ?? [];
  if (cache?.selectedModel && discoveredIds.includes(cache.selectedModel)) return cache.selectedModel;
  if (config.pinnedModel && discoveredIds.includes(config.pinnedModel)) return config.pinnedModel;
  if (routeModel && discoveredIds.includes(routeModel)) return routeModel;
  return selectFallbackLocalModel(config, discoveredIds) ?? routeModel;
}

interface LocalResponseDiagnostics {
  choiceCount: number;
  finishReasons: string[];
  recognizedFields: string[];
  topLevelKeys: string[];
}

interface ExtractedLocalResponse extends AgentChatResponse {
  diagnostics: LocalResponseDiagnostics;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).join("");
  if (!isRecord(value)) return "";

  // OpenAI-compatible servers commonly emit content as typed parts, such as
  // { type: "text", text: "..." } or { type: "output_text", text: "..." }.
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return textFromContent(value.content);
  }
  if ((value.type === "text" || value.type === "output_text") && typeof value.value === "string") {
    return value.value;
  }
  return "";
}

function messageFieldText(message: Record<string, unknown>, fields: readonly string[], recognizedFields: Set<string>): string {
  for (const field of fields) {
    const text = textFromContent(message[field]);
    if (text.trim()) {
      recognizedFields.add(`message.${field}`);
      return text;
    }
  }
  return "";
}

function extractNonStreamingResponse(body: unknown): ExtractedLocalResponse {
  const topLevelKeys = isRecord(body) ? Object.keys(body).sort() : [];
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
  const recognizedFields = new Set<string>();
  const finishReasons: string[] = [];
  const parsedToolCalls = choices.flatMap((choice) => {
    if (!isRecord(choice)) return [];
    if (typeof choice.finish_reason === "string") finishReasons.push(choice.finish_reason);
    const message = isRecord(choice.message) ? choice.message : null;
    return message ? parseOpenAiToolCallsDetailed(message.tool_calls) : [];
  });
  const toolCalls = parsedToolCalls
    .filter((item) => item.kind === "valid")
    .map((item) => item.call);
  const malformedToolCalls = parsedToolCalls.filter((item) => item.kind === "malformed");

  const content: string[] = [];
  const reasoning: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : null;
    const messageContent = message
      ? messageFieldText(message, ["content"], recognizedFields)
      : "";
    const legacyText = textFromContent(choice.text);
    if (legacyText.trim()) recognizedFields.add("choice.text");
    const answer = messageContent || legacyText;
    if (answer.trim()) {
      content.push(answer);
    }

    const reasoningText = message
      ? messageFieldText(message, ["reasoning_content", "reasoning", "analysis"], recognizedFields)
      : "";
    const choiceReasoning = !reasoningText
      ? messageFieldText(choice, ["reasoning_content", "reasoning", "analysis"], recognizedFields)
      : "";
    if ((reasoningText || choiceReasoning).trim()) {
      reasoning.push(reasoningText || choiceReasoning);
    }
  }

  return {
    text: content.join("").trim(),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join("").trim() } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(malformedToolCalls.length > 0 ? { malformedToolCalls } : {}),
    finishReason: finishReasons[0] ?? null,
    diagnostics: {
      choiceCount: choices.length,
      finishReasons: [...new Set(finishReasons)],
      recognizedFields: [...recognizedFields].sort(),
      topLevelKeys,
    },
  };
}

function emptyResponseError(config: LocalProviderConfig, model: string, diagnostics: LocalResponseDiagnostics): Error {
  const finishReasons = diagnostics.finishReasons.length > 0 ? diagnostics.finishReasons.join(", ") : "none";
  const fields = diagnostics.recognizedFields.length > 0 ? diagnostics.recognizedFields.join(", ") : "none";
  const keys = diagnostics.topLevelKeys.length > 0 ? diagnostics.topLevelKeys.join(", ") : "none";
  return new Error([
    "Local OpenAI-compatible API returned no assistant text.",
    `Endpoint: ${config.baseUrl}/chat/completions`,
    `Model: ${model}`,
    `Response details: choices=${diagnostics.choiceCount}; finish_reason=${finishReasons}; recognized_fields=${fields}; top_level_keys=${keys}.`,
    "Check the local server response format or retry the prompt.",
  ].join("\n"));
}

interface StreamingToolCallAccumulator {
  id?: string;
  name: string;
  arguments: string;
}

interface StreamingCompletionAccumulator {
  content: string;
  reasoningContent: string;
  reasoning: string;
  analysis: string;
  toolCalls: Map<number, StreamingToolCallAccumulator>;
  finishReasons: string[];
  malformedEventCount: number;
  eventCount: number;
  byteChunkCount: number;
  receivedDone: boolean;
  streamClosedNormally: boolean;
  usage: unknown;
  recognizedFields: Set<string>;
}

function appendStreamFragment(current: string, fragment: string): string {
  if (!fragment) return current;
  if (!current) return fragment;
  if (fragment === current || current.endsWith(fragment)) return current;
  if (fragment.startsWith(current)) return fragment;
  return `${current}${fragment}`;
}

function streamFragmentsCompatible(current: string | undefined, fragment: string | undefined): boolean {
  if (!current || !fragment) return true;
  if (current === fragment || current.endsWith(fragment) || fragment.startsWith(current)) return true;
  if (current.length === fragment.length) return false;
  if (current.startsWith("call_") && fragment.startsWith("call_")) return false;
  return true;
}

function mergeStreamSnapshot(current: string, snapshot: string): string {
  if (!snapshot || snapshot === current) return current;
  if (!current || snapshot.startsWith(current)) return snapshot;
  return `${current}${snapshot}`;
}

function applyToolCallFragments(
  value: unknown,
  accumulator: StreamingCompletionAccumulator,
  mode: "delta" | "message",
): void {
  if (!Array.isArray(value)) return;
  accumulator.recognizedFields.add(`${mode}.tool_calls`);
  for (let position = 0; position < value.length; position += 1) {
    const rawCall = value[position];
    if (!isRecord(rawCall)) continue;
    const explicitIndex = typeof rawCall.index === "number" ? rawCall.index : null;
    const index = explicitIndex ?? position;
    if (explicitIndex !== null && explicitIndex !== position && !accumulator.toolCalls.has(explicitIndex)) {
      const provisional = accumulator.toolCalls.get(position);
      if (provisional && streamFragmentsCompatible(provisional.id, typeof rawCall.id === "string" ? rawCall.id : undefined)) {
        accumulator.toolCalls.delete(position);
        accumulator.toolCalls.set(explicitIndex, provisional);
      }
    }
    const current = accumulator.toolCalls.get(index) ?? { name: "", arguments: "" };
    const fn = isRecord(rawCall.function) ? rawCall.function : null;
    const merge = mode === "message" ? mergeStreamSnapshot : appendStreamFragment;
    if (typeof rawCall.id === "string") current.id = merge(current.id ?? "", rawCall.id);
    if (fn && typeof fn.name === "string") current.name = merge(current.name, fn.name);
    if (fn && typeof fn.arguments === "string") current.arguments = merge(current.arguments, fn.arguments);
    accumulator.toolCalls.set(index, current);
  }
}

function applyStreamPayload(data: string, accumulator: StreamingCompletionAccumulator): void {
  if (!data) return;
  if (data === "[DONE]") {
    accumulator.receivedDone = true;
    traceLocalStream("raw-local-stream-chunk", { raw: data });
    return;
  }
  accumulator.eventCount += 1;
  traceLocalStream("raw-local-stream-chunk", { raw: data });
  try {
    const parsed = JSON.parse(data) as { choices?: unknown[]; usage?: unknown };
    if (parsed.usage !== undefined) accumulator.usage = parsed.usage;
    const parsedSummary: Record<string, unknown>[] = [];
    for (const rawChoice of parsed.choices ?? []) {
      if (!isRecord(rawChoice)) continue;
      if (typeof rawChoice.finish_reason === "string") accumulator.finishReasons.push(rawChoice.finish_reason);
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : null;
      const message = isRecord(rawChoice.message) ? rawChoice.message : null;
      const contentSource = delta && delta.content !== undefined
        ? { field: "delta.content", value: delta.content, mode: "delta" as const }
        : message && message.content !== undefined
          ? { field: "message.content", value: message.content, mode: "message" as const }
          : { field: "choice.text", value: rawChoice.text, mode: "delta" as const };
      const content = textFromContent(contentSource.value);
      if (contentSource.value !== undefined) accumulator.recognizedFields.add(contentSource.field);
      accumulator.content = contentSource.mode === "message"
        ? mergeStreamSnapshot(accumulator.content, content)
        : `${accumulator.content}${content}`;

      const reasoningSource = [
        ["delta.reasoning_content", delta?.reasoning_content],
        ["delta.reasoning", delta?.reasoning],
        ["delta.analysis", delta?.analysis],
        ["message.reasoning_content", message?.reasoning_content],
        ["message.reasoning", message?.reasoning],
        ["message.analysis", message?.analysis],
      ].find(([, value]) => value !== undefined);
      if (reasoningSource) {
        const [field, value] = reasoningSource;
        accumulator.recognizedFields.add(String(field));
        const text = textFromContent(value);
        if (String(field).endsWith("reasoning_content")) accumulator.reasoningContent += text;
        else if (String(field).endsWith("reasoning")) accumulator.reasoning += text;
        else accumulator.analysis += text;
      }
      applyToolCallFragments(delta?.tool_calls, accumulator, "delta");
      if (!Array.isArray(delta?.tool_calls)) applyToolCallFragments(message?.tool_calls, accumulator, "message");
      parsedSummary.push({
        content,
        reasoning_content: textFromContent(delta?.reasoning_content ?? message?.reasoning_content),
        reasoning: textFromContent(delta?.reasoning ?? message?.reasoning),
        tool_calls: delta?.tool_calls ?? message?.tool_calls ?? null,
        finish_reason: rawChoice.finish_reason ?? null,
      });
    }
    traceLocalStream("parsed-local-stream-chunk", { choices: parsedSummary, usage: parsed.usage ?? null });
  } catch {
    accumulator.malformedEventCount += 1;
    traceLocalStream("malformed-local-stream-chunk", { raw: data });
  }
}

function applySseEvent(event: string, accumulator: StreamingCompletionAccumulator): void {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""))
    .join("\n")
    .trim();
  applyStreamPayload(data, accumulator);
}

interface StreamingLocalResponse extends AgentChatResponse {
  diagnostics: StreamingCompletionAccumulator;
  rawText: string;
}

async function readStreamingResponse(response: Response): Promise<StreamingLocalResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  const accumulated: StreamingCompletionAccumulator = {
    content: "",
    reasoningContent: "",
    reasoning: "",
    analysis: "",
    toolCalls: new Map(),
    finishReasons: [],
    malformedEventCount: 0,
    eventCount: 0,
    byteChunkCount: 0,
    receivedDone: false,
    streamClosedNormally: false,
    usage: null,
    recognizedFields: new Set(),
  };
  if (!response.body) return { text: "", rawText: "", diagnostics: accumulated };
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        accumulated.streamClosedNormally = true;
        break;
      }
      accumulated.byteChunkCount += 1;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) applySseEvent(event, accumulated);
    }
    buffer += decoder.decode();
    if (buffer.trim()) applySseEvent(buffer, accumulated);
  } catch (error) {
    traceLocalStream("local-stream-read-error", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const parsedToolCalls = [...accumulated.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]) => parseOpenAiToolCallsDetailed([{ id: call.id, type: "function", function: {
      name: call.name,
      arguments: call.arguments,
    } }]));
  const toolCalls = parsedToolCalls
    .filter((item) => item.kind === "valid")
    .map((item) => item.call);
  const malformedToolCalls = parsedToolCalls.filter((item) => item.kind === "malformed");
  const reasoning = accumulated.reasoningContent || accumulated.reasoning || accumulated.analysis;
  return {
    text: accumulated.content.trim(),
    rawText: accumulated.content,
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(malformedToolCalls.length > 0 ? { malformedToolCalls } : {}),
    finishReason: accumulated.finishReasons[0] ?? null,
    diagnostics: accumulated,
  };
}

function validateStreamingResponse(config: LocalProviderConfig, model: string, response: StreamingLocalResponse): void {
  const { diagnostics } = response;
  const visibleChars = response.text.length;
  const reasoningChars = response.reasoning?.length ?? 0;
  const toolCallCount = response.toolCalls?.length ?? 0;
  const malformedToolCallCount = response.malformedToolCalls?.length ?? 0;
  const finishReason = response.finishReason;
  const context = `\nEndpoint: ${config.baseUrl}/chat/completions\nModel: ${model}`;
  traceLocalStream("local-stream-complete", {
    visible_content_chars: visibleChars,
    reasoning_chars: reasoningChars,
    tool_call_count: toolCallCount,
    malformed_tool_call_count: malformedToolCallCount,
    finish_reason: finishReason,
    chunk_count: diagnostics.eventCount,
    byte_chunk_count: diagnostics.byteChunkCount,
    received_done: diagnostics.receivedDone,
    stream_closed_normally: diagnostics.streamClosedNormally,
    malformed_event_count: diagnostics.malformedEventCount,
    usage: diagnostics.usage,
  });
  // length is a valid partial completion. The Local continuation layer carries
  // it into a fresh request window instead of exposing a failed turn.
  if (finishReason === "length") return;
  if (visibleChars > 0 || toolCallCount > 0 || malformedToolCallCount > 0) return;
  if (finishReason === "tool_calls") {
    throw new Error(`Local OpenAI-compatible API finished with finish_reason=tool_calls, but no tool call was present in the stream.${context}`);
  }
  if (reasoningChars > 0) {
    throw new Error(`Local OpenAI-compatible API returned ${reasoningChars} reasoning characters but no visible assistant text or tool call after streaming completion (finish_reason=${finishReason ?? "none"}).${context}`);
  }
  if (!diagnostics.streamClosedNormally || (!diagnostics.receivedDone && !finishReason)) {
    throw new Error(`Local OpenAI-compatible API stream closed without a finish_reason or [DONE] marker and produced no assistant text or tool call.${context}`);
  }
  throw new Error(`Local OpenAI-compatible API returned no visible assistant text or tool call after streaming completion.${context}`);
}

interface PostLocalChatCompletionOptions {
  request: ProviderChatRequest;
  config: LocalProviderConfig;
  stream: boolean;
  messages?: readonly AgentChatMessage[];
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  handlers: BackendRunHandlers;
  capProfile: import("./capabilityProfile.js").ModelCapabilityProfile;
  toolProtocol: "none" | "text" | "openai";
  turnIndex: number;
  contextLength: number | null;
}

async function postLocalChatCompletionOnce(options: PostLocalChatCompletionOptions): Promise<AgentChatResponse> {
  const model = getCachedSelectedModel(options.config, options.request.route.modelId);
  const includeSystemPrompt = options.capProfile.supportsSystemPrompt !== false;
  const messages: readonly AgentChatMessage[] = options.messages ?? [
    ...(includeSystemPrompt && options.request.projectInstructions?.content
      ? [{ role: "system" as const, content: options.request.projectInstructions.content }]
      : []),
    { role: "user" as const, content: options.request.prompt },
  ];
  const tools = options.toolProtocol === "openai"
    ? agentToolDefinitions(options.request.runIntent ?? "normal")
    : [];
  const requestBody = {
    model,
    messages,
    stream: options.stream,
    ...(options.stream ? { stream_options: { include_usage: true } } : {}),
    ...(options.capProfile.maxOutputTokens !== null ? { max_tokens: options.capProfile.maxOutputTokens } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };
  traceLocalStream("local-stream-request", {
    model,
    stream: options.stream,
    max_tokens: "max_tokens" in requestBody ? requestBody.max_tokens : null,
    max_completion_tokens: null,
    stop: null,
    temperature: null,
    top_p: null,
    tools: tools.length,
    tool_choice: tools.length > 0 ? "auto" : null,
  });
  const sendRequest = (body: Record<string, unknown>) => options.fetchImpl(`${options.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  let response = await sendRequest(requestBody);
  let rejectedBody: string | null = null;
  if (!response.ok && options.stream && (response.status === 400 || response.status === 422)) {
    rejectedBody = await response.text();
    if (/stream[_ -]?options|include[_ -]?usage|unknown.+(?:field|parameter)/i.test(rejectedBody)) {
      const { stream_options: _streamOptions, ...compatibleBody } = requestBody;
      traceLocalStream("local-stream-usage-option-rejected", { status: response.status });
      response = await sendRequest(compatibleBody);
      rejectedBody = null;
    }
  }

  if (!response.ok) {
    const body = rejectedBody ?? await response.text();
    const sanitized = sanitizeTerminalOutput(body).slice(0, 500);
    if (isModelNotLoadedError(response.status, sanitized)) {
      discoveryCaches.delete(options.config.localBackend);
      clearModelCapabilityProfileCache();
      clearModelContextMetadataCache();
    }
    throw new Error(`Local OpenAI-compatible request failed (${response.status}): ${sanitized}`);
  }

  if (options.stream && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const streamed = await readStreamingResponse(response);
    if (streamed.reasoning?.trim()) {
      options.handlers.onProgress?.({
        id: `local-reasoning-${options.turnIndex}`,
        source: "reasoning",
        text: streamed.reasoning,
      });
    }
    validateStreamingResponse(options.config, model, streamed);
    return streamed;
  }

  const parsed = JSON.parse(await response.text()) as unknown;
  const extracted = extractNonStreamingResponse(parsed);
  if (extracted.reasoning?.trim()) {
    options.handlers.onProgress?.({
      id: `local-reasoning-${options.turnIndex}`,
      source: "reasoning",
      text: extracted.reasoning,
    });
  }
  if (
    !extracted.text.trim()
    && (extracted.toolCalls?.length ?? 0) === 0
    && (extracted.malformedToolCalls?.length ?? 0) === 0
  ) {
    throw emptyResponseError(options.config, model, extracted.diagnostics);
  }
  return extracted;
}

function estimateLocalTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function checkpointTranscriptHash(messages: readonly { role: string; content: string }[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function persistLocalCheckpoint(options: PostLocalChatCompletionOptions, summary: string, responseCharsCovered = 0): void {
  const coveredMessages = [
    ...(options.request.conversationHistory ?? []),
    { role: "user" as const, content: options.request.prompt },
  ];
  options.handlers.onLocalContextCheckpoint?.({
    version: 1,
    modelId: options.request.route.modelId,
    contextLength: options.contextLength,
    throughMessageCount: coveredMessages.length,
    transcriptHash: checkpointTranscriptHash(coveredMessages),
    summary,
    activeWindowChars: summary.length + Math.min(1_200, responseCharsCovered),
    responseCharsCovered,
    updatedAt: new Date().toISOString(),
  });
}

function appendContinuationSegment(current: string, next: string): { text: string; overlap: number } {
  if (!next) return { text: current, overlap: 0 };
  if (!current) return { text: next, overlap: 0 };
  const limit = Math.min(current.length, next.length, 2_000);
  // Tiny one-character matches are common at natural sentence boundaries and
  // are not reliable evidence that the model replayed the supplied tail.
  for (let size = limit; size >= 4; size -= 1) {
    if (current.slice(-size) === next.slice(0, size)) {
      return { text: `${current}${next.slice(size)}`, overlap: size };
    }
  }
  return { text: `${current}${next}`, overlap: 0 };
}

function renderCheckpointSource(messages: readonly AgentChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === "tool") return `TOOL RESULT (${message.tool_call_id}):\n${message.content}`;
    if (message.role === "assistant" && message.tool_calls?.length) {
      return `ASSISTANT TOOL CALLS:\n${JSON.stringify(message.tool_calls)}`;
    }
    return `${message.role.toUpperCase()}:\n${message.content ?? ""}`;
  }).join("\n\n");
}

function boundedCheckpointSource(source: string, maxCharacters: number): string {
  if (source.length <= maxCharacters) return source;
  const headSize = Math.floor(maxCharacters * 0.3);
  const tailSize = maxCharacters - headSize;
  return `${source.slice(0, headSize)}\n\n[older verbatim material omitted]\n\n${source.slice(-tailSize)}`;
}

function fallbackCheckpoint(source: string, maxCharacters: number): string {
  const compact = source.replace(/\s+/g, " ").trim();
  if (compact.length <= maxCharacters) return compact;
  const half = Math.floor((maxCharacters - 32) / 2);
  return `${compact.slice(0, half)} … ${compact.slice(-half)}`;
}

async function createLocalCheckpoint(options: PostLocalChatCompletionOptions & {
  messages: readonly AgentChatMessage[];
  accumulatedText: string;
  accumulatedReasoning: string;
  interruptedToolState: string;
  previousCheckpoint?: string;
}): Promise<string> {
  const contextLength = options.contextLength ?? 8_192;
  const checkpointTokens = Math.max(128, Math.min(1_024, Math.floor(contextLength * 0.12)));
  const checkpointCharacters = checkpointTokens * 4;
  const sourceLimit = Math.max(1_024, Math.floor(contextLength * 4 * 0.55));
  const exactTail = options.accumulatedText.slice(-1_200);
  const source = boundedCheckpointSource([
    options.previousCheckpoint ? `PREVIOUS ROLLING CHECKPOINT:\n${options.previousCheckpoint}` : "",
    renderCheckpointSource(options.messages),
    options.accumulatedText ? `VISIBLE RESPONSE WRITTEN SO FAR:\n${options.accumulatedText}` : "",
    options.accumulatedReasoning ? `PRIVATE REASONING TAIL:\n${options.accumulatedReasoning.slice(-800)}` : "",
    options.interruptedToolState ? `INTERRUPTED TOOL STATE:\n${options.interruptedToolState}` : "",
  ].filter(Boolean).join("\n\n"), sourceLimit);
  const summaryMessages: AgentChatMessage[] = [{
    role: "user",
    content: [
      "Create a compact continuation checkpoint for another instance of the same coding model.",
      "Return only the checkpoint, with these headings: Objective, Constraints, Established facts, Completed work, Unresolved work, Next response position.",
      "Preserve concrete paths, commands, errors, decisions, and tool outcomes. Do not invent facts.",
      `The next response must continue after this exact visible tail without repeating it: ${JSON.stringify(exactTail)}`,
      "SOURCE:",
      source,
    ].join("\n\n"),
  }];
  try {
    const response = await postLocalChatCompletionOnce({
      ...options,
      stream: false,
      messages: summaryMessages,
      handlers: { onResponse: () => undefined, onError: () => undefined },
      toolProtocol: "none",
      capProfile: { ...options.capProfile, maxOutputTokens: checkpointTokens },
    });
    const checkpoint = response.text.trim();
    if (checkpoint) return checkpoint.slice(0, checkpointCharacters);
  } catch (error) {
    traceLocalStream("local-context-checkpoint-fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return fallbackCheckpoint(source, checkpointCharacters);
}

function systemMessages(messages: readonly AgentChatMessage[]): AgentChatMessage[] {
  return messages.filter((message): message is Extract<AgentChatMessage, { role: "system" }> => message.role === "system");
}

function buildContinuationMessages(
  originalMessages: readonly AgentChatMessage[],
  checkpoint: string,
  accumulatedText: string,
  contextLength: number | null,
): AgentChatMessage[] {
  const contextCharacters = (contextLength ?? 8_192) * 4;
  const systems = systemMessages(originalMessages);
  const systemCost = JSON.stringify(systems).length;
  const available = Math.max(384, Math.floor(contextCharacters * 0.55) - systemCost - checkpoint.length);
  const exactTail = accumulatedText.slice(-Math.min(1_200, available));
  return [
    ...systems,
    {
      role: "user",
      content: [
        "Internal continuation checkpoint for the same user turn:",
        checkpoint,
        "Continue the response directly. Do not mention context windows, checkpoints, summaries, or continuation.",
        "Do not repeat completed material. If an interrupted tool call is described, emit one complete replacement tool call from scratch.",
      ].join("\n\n"),
    },
    ...(exactTail ? [{ role: "assistant" as const, content: exactTail }] : []),
    { role: "user", content: "Continue exactly where the assistant text ends." },
  ];
}

async function fitInitialLocalWindow(options: PostLocalChatCompletionOptions): Promise<readonly AgentChatMessage[] | undefined> {
  if (!options.messages || !options.contextLength) return options.messages;
  const tools = options.toolProtocol === "openai" ? agentToolDefinitions(options.request.runIntent ?? "normal") : [];
  const promptBudget = Math.max(256, Math.floor(options.contextLength * 0.72));
  let candidateMessages = options.messages;
  const saved = options.request.localContextCheckpoint;
  const history = options.request.conversationHistory ?? [];
  if (
    saved
    && saved.modelId === options.request.route.modelId
    && saved.throughMessageCount <= history.length
    && checkpointTranscriptHash(history.slice(0, saved.throughMessageCount)) === saved.transcriptHash
  ) {
    const systems = systemMessages(options.messages);
    const baseMessageCount = systems.length + history.length + 1;
    const ephemeralMessages = options.messages.slice(baseMessageCount);
    candidateMessages = [
      ...systems,
      { role: "user", content: `Earlier conversation checkpoint:\n${saved.summary}` },
      ...history.slice(saved.throughMessageCount).map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: options.request.prompt },
      ...ephemeralMessages,
    ];
  }
  const estimated = estimateLocalTokens({ messages: candidateMessages, tools });
  if (estimated <= promptBudget) return candidateMessages;
  const checkpoint = await createLocalCheckpoint({
    ...options,
    messages: candidateMessages,
    accumulatedText: "",
    accumulatedReasoning: "",
    interruptedToolState: "",
  });
  persistLocalCheckpoint(options, checkpoint);
  const latestUser = [...options.messages].reverse().find((message) => message.role === "user");
  return [
    ...systemMessages(options.messages),
    { role: "user", content: `Earlier conversation checkpoint:\n${checkpoint}` },
    ...(latestUser ? [latestUser] : []),
  ];
}

async function postLocalChatCompletion(options: PostLocalChatCompletionOptions): Promise<AgentChatResponse> {
  const originalMessages = options.messages ?? [];
  let requestMessages = await fitInitialLocalWindow(options) ?? originalMessages;
  let accumulatedText = "";
  let accumulatedReasoning = "";
  let interruptedToolState = "";
  let rollingCheckpoint = "";
  let windowIndex = 0;
  let consecutiveNoProgress = 0;

  while (true) {
    windowIndex += 1;
    const response = await postLocalChatCompletionOnce({ ...options, messages: requestMessages });
    const responseSegment = "rawText" in response && typeof response.rawText === "string"
      ? response.rawText
      : response.text;
    const stitched = appendContinuationSegment(accumulatedText, responseSegment);
    const reasoningStitched = appendContinuationSegment(accumulatedReasoning, response.reasoning ?? "");
    const toolState = JSON.stringify({
      toolCalls: response.toolCalls ?? [],
      malformedToolCalls: response.malformedToolCalls ?? [],
    });
    const madeProgress = stitched.text.length > accumulatedText.length
      || reasoningStitched.text.length > accumulatedReasoning.length
      || toolState !== interruptedToolState;
    accumulatedText = stitched.text;
    accumulatedReasoning = reasoningStitched.text;

    traceLocalStream("local-context-window-complete", {
      window: windowIndex,
      finish_reason: response.finishReason ?? null,
      accumulated_visible_chars: accumulatedText.length,
      accumulated_reasoning_chars: accumulatedReasoning.length,
      overlap_removed: stitched.overlap,
      made_progress: madeProgress,
    });

    if (response.finishReason !== "length") {
      return {
        ...response,
        text: accumulatedText.trim(),
        ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
      };
    }

    consecutiveNoProgress = madeProgress ? 0 : consecutiveNoProgress + 1;
    if (consecutiveNoProgress >= 2) {
      return {
        text: accumulatedText || "The local model could not advance the response after refreshing its context.",
        ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
        finishReason: "stop",
      };
    }

    interruptedToolState = toolState;
    rollingCheckpoint = await createLocalCheckpoint({
      ...options,
      messages: originalMessages,
      accumulatedText,
      accumulatedReasoning,
      interruptedToolState,
      previousCheckpoint: rollingCheckpoint,
    });
    persistLocalCheckpoint(options, rollingCheckpoint, accumulatedText.length);
    requestMessages = buildContinuationMessages(
      originalMessages,
      rollingCheckpoint,
      accumulatedText,
      options.contextLength,
    );
  }
}

function isModelNotLoadedError(status: number, body: string): boolean {
  return status === 404 || /model.+not.+loaded|not.+loaded.+model|load a model|no model is loaded/i.test(body);
}

export async function runLocalOpenAiCompatible(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  options: { fetchImpl?: FetchImpl; signal?: AbortSignal } = {},
): Promise<string> {
  const localBackend = request.route.localBackend ?? request.localConfig?.localBackend ?? configuredOverride?.localBackend ?? "lm-studio";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (localBackend === "unsloth") {
    const validation = await checkLocalProvider({ override: request.localConfig ?? configuredOverride, localBackend, fetchImpl, signal: options.signal });
    if (validation.status !== "ready") throw new Error(validation.message);
  }
  const config = discoveryCaches.get(localBackend)?.resolvedConfig
    ?? resolveLocalProviderConfig(request.localConfig ?? configuredOverride, process.env, localBackend);

  const resolvedModel = getCachedSelectedModel(config, request.route.modelId);
  const cache = discoveryCaches.get(localBackend);
  const rawMeta = cache?.configKey === localConfigKey(config)
    ? cache.result.models.find((m) => m.modelId === resolvedModel)?.raw
    : undefined;
  const capProfile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: resolvedModel,
    providerConfig: request.localConfig ?? configuredOverride,
    rawMetadata: rawMeta,
  });
  const contextMetadata = resolveModelContextLengthCached({
    providerId: "local",
    modelId: resolvedModel,
    providerConfig: request.localConfig ?? configuredOverride,
    rawMetadata: rawMeta,
  });
  const toolProtocol = capProfile.supportsToolCalls === true
    ? "openai"
    : capProfile.supportsToolCalls === false
      ? "none"
      : "text";
  const text = await runAgentLoop({
    request,
    handlers,
    includeSystemPrompt: capProfile.supportsSystemPrompt !== false,
    toolProtocol,
    signal: options.signal,
    sendMessages: async (messages, turnIndex) =>
      postLocalChatCompletion({
        request,
        config,
        messages,
        // Streaming makes the server commit response headers immediately. A
        // long local generation can otherwise exceed the HTTP client's header
        // timeout even while the model is actively producing tokens.
        stream: capProfile.supportsStreaming !== false,
        fetchImpl,
        signal: options.signal,
        handlers,
        capProfile,
        toolProtocol,
        turnIndex,
        contextLength: contextMetadata.contextLength,
      }),
  });
  if (!text) throw new Error("Local OpenAI-compatible API returned no assistant text after tool execution.");
  handlers.onAssistantDelta?.(text);
  return text;
}

export async function runLocalDiagnostics(options: {
  localConfig?: ProviderWorkspaceOverride | null;
  localBackend?: LocalBackendId;
  fetchImpl?: FetchImpl;
} = {}): Promise<string> {
  const localBackend = options.localBackend ?? options.localConfig?.localBackend ?? configuredOverride?.localBackend ?? "lm-studio";
  const validation = await checkLocalProvider({
    override: options.localConfig ?? configuredOverride,
    localBackend,
    fetchImpl: options.fetchImpl,
  });
  const diagnostics = validation.diagnostics ?? {};
  const models = String(diagnostics.discoveredModels ?? "").trim() || "none";
  const selectedModelId = String(diagnostics.selectedModel ?? "");
  const previousModelId = typeof diagnostics.previousModel === "string" ? diagnostics.previousModel : "";
  const lmStudioEndpoint = String(diagnostics.lmStudioModelsEndpoint ?? "");
  const cache = discoveryCaches.get(localBackend);
  const modelRaw = cache?.result.models.find((m) => m.modelId === selectedModelId)?.raw;
  const lmLines: (string | null)[] = [];
  const loadedModels = cache?.result.models.filter((model) => {
    const raw = model.raw;
    return isRecord(raw) && raw.state === "loaded";
  }) ?? [];
  if (loadedModels.length > 0) {
    lmLines.push("Loaded models:");
    for (const model of loadedModels) {
      const raw = isRecord(model.raw) ? model.raw : {};
      lmLines.push(`- ${model.modelId}`);
      if (typeof raw.state === "string") lmLines.push(`  state: ${raw.state}`);
      if (typeof raw.loaded_context_length === "number") lmLines.push(`  loaded context: ${raw.loaded_context_length.toLocaleString()}`);
      if (typeof raw.max_context_length === "number") lmLines.push(`  max context: ${raw.max_context_length.toLocaleString()}`);
      if (Array.isArray(raw.capabilities) && raw.capabilities.length > 0) {
        lmLines.push(`  capabilities: ${(raw.capabilities as unknown[]).join(", ")}`);
      }
    }
  }
  if (isRecord(modelRaw)) {
    if (typeof modelRaw.state === "string") lmLines.push(`State: ${modelRaw.state}`);
    if (typeof modelRaw.type === "string") lmLines.push(`Type: ${modelRaw.type}`);
    if (typeof modelRaw.arch === "string") lmLines.push(`Architecture: ${modelRaw.arch}`);
    if (typeof modelRaw.quantization === "string") lmLines.push(`Quantization: ${modelRaw.quantization}`);
    if (typeof modelRaw.loaded_context_length === "number") {
      lmLines.push(`Loaded context: ${modelRaw.loaded_context_length.toLocaleString()}`);
    }
    if (typeof modelRaw.max_context_length === "number") {
      lmLines.push(`Max context: ${modelRaw.max_context_length.toLocaleString()}`);
    }
    if (Array.isArray(modelRaw.capabilities) && modelRaw.capabilities.length > 0) {
      lmLines.push(`Capabilities: ${(modelRaw.capabilities as unknown[]).join(", ")}`);
    }
  }
  if (selectedModelId) {
    const contextMeta = resolveModelContextLengthCached({
      providerId: "local",
      modelId: selectedModelId,
      rawMetadata: cache?.result.models.find((m) => m.modelId === selectedModelId)?.raw,
    });
    if (contextMeta.contextLength !== null) {
      lmLines.push(`Active context: ${contextMeta.contextLength.toLocaleString()}`);
      lmLines.push(`Active context limit: ${contextMeta.contextLength.toLocaleString()}`);
      lmLines.push(`Source: ${contextMeta.source}`);
      if (contextMeta.rawField) {
        lmLines.push(`Field: ${contextMeta.rawField.replace(/^raw\./, "")}`);
      }
    }
  }
  if (previousModelId && selectedModelId && previousModelId !== selectedModelId) {
    lmLines.push(`Previous/stale model cleared: ${previousModelId}`);
  }
  return [
    "Local provider",
    `Local: ${validation.status === "ready" ? "available" : "unavailable"}`,
    `Base URL: ${diagnostics.baseUrl ?? resolveLocalProviderConfig(options.localConfig ?? configuredOverride).baseUrl}`,
    lmStudioEndpoint ? `LM Studio models endpoint: ${lmStudioEndpoint}` : null,
    `Models: ${models}`,
    `Active model: ${diagnostics.selectedModel ?? "none"}`,
    `Selected: ${diagnostics.selectedModel ?? "none"}`,
    `Endpoint check: ${diagnostics.endpointCheckResult ?? "unknown"}`,
    diagnostics.errorMessage ? `Error: ${diagnostics.errorMessage}` : null,
    ...lmLines,
  ].filter(Boolean).join("\n");
}

export const localRuntime: ProviderRuntime = {
  providerId: "local",
  label: "Local",
  modelPickerLabel: "Local",
  backendKind: "local-openai-compatible",
  routeAvailable: true,
  routeStatus: "Routes through a local OpenAI-compatible server such as LM Studio.",
  routeSetupMessage: LOCAL_ROUTE_SETUP_MESSAGE,
  launchAvailable: false,
  isRouteConfigured: () => discoverLocalModels().status === "ready",
  validateRoute: async ({ route, localConfig, localBackend }) => checkLocalProvider({ override: localConfig ?? configuredOverride, localBackend: localBackend ?? route.localBackend }),
  discoverModels: discoverLocalModels,
  refreshModels: async ({ localConfig, localBackend }) => {
    const backend = localBackend ?? localConfig?.localBackend ?? configuredOverride?.localBackend ?? "lm-studio";
    const validation = await checkLocalProvider({ override: localConfig ?? configuredOverride, localBackend: backend });
    return {
      status: validation.status,
      providerId: "local",
      localBackend: backend,
      backendKind: validation.backendKind,
      models: validation.status === "ready" ? discoverLocalModels(localConfig, backend).models : [],
      message: validation.message,
      diagnostics: validation.diagnostics,
    };
  },
  run: (request, handlers) => {
    const controller = new AbortController();
    handlers.onProgress?.({
      id: "local-route",
      source: "stdout",
      text: "Starting Local OpenAI-compatible provider",
    });
    runLocalOpenAiCompatible(request, handlers, { signal: controller.signal })
      .then((text) => {
        if (controller.signal.aborted) return;
        handlers.onFinalAnswerObserved?.(text);
        handlers.onResponse(text);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Local OpenAI-compatible provider failed.";
        handlers.onError(message);
      });
    return () => controller.abort();
  },
};
