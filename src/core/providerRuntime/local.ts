import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { LocalBackendId, ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import type {
  ProviderChatRequest,
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRouteValidationResult,
  ProviderRuntime,
  ResolvedLocalAgentConfig,
} from "./types.js";
import { resolveModelCapabilityProfileCached, clearModelCapabilityProfileCache } from "./capabilityProfile.js";
import { clearModelContextMetadataCache, resolveModelContextLengthCached } from "./contextMetadata.js";
import { deriveLmStudioApiRoot, fetchLmStudioModels, type LmStudioModelInfo, type LmStudioModelList } from "./lmstudio.js";
import { parseUnslothModels, resolveUnslothConnection } from "./unsloth.js";
import { runLocalHarness } from "./localHarness/runtime.js";

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

async function resolveLocalAgentConfig(
  request: ProviderChatRequest,
  signal: AbortSignal,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<ResolvedLocalAgentConfig> {
  const localBackend = request.route.localBackend ?? request.localConfig?.localBackend ?? "lm-studio";
  const modelId = request.route.modelId;
  let config = resolveLocalProviderConfig(request.localConfig, process.env, localBackend);
  let rawMetadata: Record<string, unknown> | undefined;

  if (localBackend === "unsloth") {
    const connection = await resolveUnslothConnection({ fetchImpl, signal });
    config = { ...config, baseUrl: connection.baseUrl, apiKey: connection.apiKey };
    const statusResponse = await fetchImpl(`${connection.rootUrl}/api/inference/status`, {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      redirect: "manual",
      signal,
    });
    if (!statusResponse.ok) {
      throw new Error(`Unsloth inference status returned HTTP ${statusResponse.status}.`);
    }
    const status = await statusResponse.json();
    if (isRecord(status)) {
      rawMetadata = {
        ...status,
        supports_streaming: true,
        supports_tool_calls: status.supports_tools,
        supports_system_prompt: true,
        supports_vision: status.is_vision,
      };
      if (typeof status.active_model === "string" && status.active_model !== modelId) {
        throw new Error(`Unsloth has model "${status.active_model}" active, but Codexa selected "${modelId}".`);
      }
    }
  } else {
    const cache = discoveryCaches.get(localBackend);
    const discovered = cache?.result.models.find((model) => model.modelId === modelId)?.raw;
    if (isRecord(discovered)) rawMetadata = discovered;
  }

  const context = resolveModelContextLengthCached({
    providerId: "local",
    modelId,
    providerConfig: request.localConfig,
    rawMetadata,
  });
  const capabilities = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId,
    providerConfig: request.localConfig,
    rawMetadata,
  });
  const configuredModel = request.localConfig?.models?.[modelId];
  return {
    localBackend,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelId,
    contextWindow: context.contextLength ?? configuredModel?.contextLength ?? 32_768,
    maxTokens: capabilities.maxOutputTokens ?? configuredModel?.maxOutputTokens ?? 8_192,
    supportsStreaming: capabilities.supportsStreaming,
    supportsToolCalls: capabilities.supportsToolCalls,
    supportsSystemPrompt: capabilities.supportsSystemPrompt,
    supportsVision: capabilities.supportsVision ?? rawMetadata?.supports_vision === true,
  };
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
  routeStatus: "Uses the DeepSeek Harness agent runtime with the configured Local OpenAI-compatible server.",
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
      text: "Starting Local agent harness",
    });
    resolveLocalAgentConfig(request, controller.signal)
      .then((resolvedLocalAgentConfig) => {
        if (controller.signal.aborted) throw new DOMException("Local request cancelled.", "AbortError");
        return runLocalHarness({ ...request, resolvedLocalAgentConfig }, handlers, controller.signal);
      })
      .then((text) => {
        if (controller.signal.aborted) return;
        handlers.onResponse(text);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : "Local agent harness failed.";
        const message = detail.startsWith("Local agent request failed") || detail.startsWith("Local Harness")
          ? detail
          : [
            `Local agent request failed: ${detail}`,
            `Backend: ${request.route.localBackend ?? request.localConfig?.localBackend ?? "lm-studio"}`,
            `Model: ${request.route.modelId}`,
          ].join("\n");
        handlers.onError(message);
      });
    return () => controller.abort();
  },
};

export const localRuntimeTestUtils = {
  resolveLocalAgentConfig,
};
