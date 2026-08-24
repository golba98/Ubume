import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { runAgentLoop, type AgentChatMessage, type AgentChatResponse } from "../agent/loop.js";
import { agentToolDefinitions, parseOpenAiToolCallsDetailed } from "../agent/protocol.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
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
}

let configuredOverride: ProviderWorkspaceOverride | null = null;
let discoveryCache: LocalDiscoveryCache | null = null;

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
  discoveryCache = null;
  clearModelCapabilityProfileCache();
  clearModelContextMetadataCache();
}

export function resolveLocalProviderConfig(
  override: ProviderWorkspaceOverride | null | undefined = configuredOverride,
  env: NodeJS.ProcessEnv = process.env,
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
  loadedModels?: readonly LmStudioModelInfo[];
  selectedModelPrevious?: string | null;
  selectionReason?: string | null;
  contextField?: string | null;
  error?: string | null;
}): Record<string, string | number | boolean | null> {
  return {
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
    contextSource: options.contextField ? "lmstudio-api" : null,
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
    backendKind: "unavailable",
    models: [],
    message,
    diagnostics: diagnosticsFor({ config, status, models: [], selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, error }),
  };
}

export function discoverLocalModels(
  override: ProviderWorkspaceOverride | null | undefined = configuredOverride,
): ProviderModelDiscoveryResult {
  const config = resolveLocalProviderConfig(override);
  const key = localConfigKey(config);
  if (discoveryCache?.configKey === key) {
    return discoveryCache.result;
  }
  return notConfiguredResult(config, LOCAL_ROUTE_SETUP_MESSAGE);
}

export async function checkLocalProvider(options: {
  override?: ProviderWorkspaceOverride | null;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
} = {}): Promise<ProviderRouteValidationResult> {
  const config = resolveLocalProviderConfig(options.override ?? configuredOverride);
  const key = localConfigKey(config);
  const previousSelectedModel = discoveryCache?.configKey === key ? discoveryCache.selectedModel : null;
  clearModelCapabilityProfileCache();
  clearModelContextMetadataCache();

  if (!config.enabled) {
    const result = notConfiguredResult(config, "Local provider is disabled in provider config.");
    discoveryCache = { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now() };
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
    discoveryCache = { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now() };
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
      discoveryCache = { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now() };
      return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
    }

    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      const message = "Local provider unavailable\n/v1/models returned invalid JSON.";
      const result = notConfiguredResult(config, message, "unavailable", "invalid JSON");
      discoveryCache = { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now() };
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
        discoveryCache = { configKey: key, result, selectedModel: null, checkedAt: Date.now() };
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
      discoveryCache = { configKey: key, result, selectedModel, checkedAt: Date.now() };
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
    discoveryCache = { configKey: key, result, selectedModel, checkedAt: Date.now() };
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
    discoveryCache = { configKey: key, result, selectedModel: config.pinnedModel ?? config.defaultModel ?? config.currentModel, checkedAt: Date.now() };
    return { status: "not-configured", providerId: "local", backendKind: "unavailable", message, diagnostics: result.diagnostics };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function getCachedSelectedModel(config: LocalProviderConfig, routeModel: string): string {
  const cache = discoveryCache?.configKey === localConfigKey(config) ? discoveryCache : null;
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

function applyStreamDelta(line: string, accumulator: StreamingCompletionAccumulator): void {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return;
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") return;
  try {
    const parsed = JSON.parse(data) as { choices?: unknown[] };
    for (const rawChoice of parsed.choices ?? []) {
      if (!isRecord(rawChoice)) continue;
      if (typeof rawChoice.finish_reason === "string") accumulator.finishReasons.push(rawChoice.finish_reason);
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : rawChoice;
      accumulator.content += textFromContent(delta.content) || textFromContent(rawChoice.text);
      accumulator.reasoningContent += textFromContent(delta.reasoning_content);
      accumulator.reasoning += textFromContent(delta.reasoning);
      accumulator.analysis += textFromContent(delta.analysis);
      if (!Array.isArray(delta.tool_calls)) continue;
      for (let position = 0; position < delta.tool_calls.length; position += 1) {
        const rawCall = delta.tool_calls[position];
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
        if (typeof rawCall.id === "string") current.id = appendStreamFragment(current.id ?? "", rawCall.id);
        if (fn && typeof fn.name === "string") current.name = appendStreamFragment(current.name, fn.name);
        if (fn && typeof fn.arguments === "string") current.arguments = appendStreamFragment(current.arguments, fn.arguments);
        accumulator.toolCalls.set(index, current);
      }
    }
  } catch {
    accumulator.malformedEventCount += 1;
  }
}

async function readStreamingResponse(response: Response): Promise<AgentChatResponse> {
  if (!response.body) return { text: "" };
  const reader = response.body.getReader();
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
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      applyStreamDelta(line, accumulated);
    }
  }
  applyStreamDelta(buffer, accumulated);
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
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(malformedToolCalls.length > 0 ? { malformedToolCalls } : {}),
    finishReason: accumulated.finishReasons[0] ?? null,
  };
}

async function postLocalChatCompletion(options: {
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
}): Promise<AgentChatResponse> {
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
  const response = await options.fetchImpl(`${options.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: options.stream,
      ...(options.capProfile.maxOutputTokens !== null ? { max_tokens: options.capProfile.maxOutputTokens } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    const sanitized = sanitizeTerminalOutput(body).slice(0, 500);
    if (isModelNotLoadedError(response.status, sanitized)) {
      discoveryCache = null;
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
    if (
      !streamed.text.trim()
      && (streamed.toolCalls?.length ?? 0) === 0
      && (streamed.malformedToolCalls?.length ?? 0) === 0
    ) {
      throw new Error("Local OpenAI-compatible API returned no visible assistant text or tool call after streaming completed.");
    }
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

function isModelNotLoadedError(status: number, body: string): boolean {
  return status === 404 || /model.+not.+loaded|not.+loaded.+model|load a model|no model is loaded/i.test(body);
}

export async function runLocalOpenAiCompatible(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  options: { fetchImpl?: FetchImpl; signal?: AbortSignal } = {},
): Promise<string> {
  const config = resolveLocalProviderConfig(request.localConfig ?? configuredOverride);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const resolvedModel = getCachedSelectedModel(config, request.route.modelId);
  const rawMeta = discoveryCache?.configKey === localConfigKey(config)
    ? discoveryCache.result.models.find((m) => m.modelId === resolvedModel)?.raw
    : undefined;
  const capProfile = resolveModelCapabilityProfileCached({
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
      }),
  });
  if (!text) throw new Error("Local OpenAI-compatible API returned no assistant text after tool execution.");
  handlers.onAssistantDelta?.(text);
  return text;
}

export async function runLocalDiagnostics(options: {
  localConfig?: ProviderWorkspaceOverride | null;
  fetchImpl?: FetchImpl;
} = {}): Promise<string> {
  const validation = await checkLocalProvider({
    override: options.localConfig ?? configuredOverride,
    fetchImpl: options.fetchImpl,
  });
  const diagnostics = validation.diagnostics ?? {};
  const models = String(diagnostics.discoveredModels ?? "").trim() || "none";
  const selectedModelId = String(diagnostics.selectedModel ?? "");
  const previousModelId = typeof diagnostics.previousModel === "string" ? diagnostics.previousModel : "";
  const lmStudioEndpoint = String(diagnostics.lmStudioModelsEndpoint ?? "");
  const modelRaw = discoveryCache?.result.models.find((m) => m.modelId === selectedModelId)?.raw;
  const lmLines: (string | null)[] = [];
  const loadedModels = discoveryCache?.result.models.filter((model) => {
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
      rawMetadata: discoveryCache?.result.models.find((m) => m.modelId === selectedModelId)?.raw,
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
  validateRoute: async ({ localConfig }) => checkLocalProvider({ override: localConfig ?? configuredOverride }),
  discoverModels: discoverLocalModels,
  refreshModels: async ({ localConfig }) => {
    const validation = await checkLocalProvider({ override: localConfig ?? configuredOverride });
    return {
      status: validation.status,
      providerId: "local",
      backendKind: validation.backendKind,
      models: validation.status === "ready" ? discoverLocalModels(localConfig).models : [],
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
