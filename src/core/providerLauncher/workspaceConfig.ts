import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DEFAULT_MODEL } from "../../config/settings.js";
import { resolveUbumeWorkspaceDataDir } from "../workspace/appData.js";
import { normalizeWorkspaceRoot } from "../workspace/workspaceRoot.js";
import { isKnownProviderId } from "./registry.js";
import { getDefaultRouteModel, getProviderRuntime, isProviderRouteConfigured, isProviderRoutableInUbume } from "../providerRuntime/registry.js";
import { normalizeGeminiModelId } from "../providerRuntime/models.js";
import type {
  ProviderActiveRoute,
  ProviderId,
  ProviderLaunchCommand,
  ProviderWorkspaceConfig,
  ProviderWorkspaceOverride,
} from "./types.js";

const DEPRECATED_ANTIGRAVITY_PROVIDER_ID = "antigravity";
const DEPRECATED_ANTIGRAVITY_BACKENDS = new Set(["antigravity-cli-auth", "agy"]);
const DEPRECATED_GOOGLE_PROVIDER_ID = "google";

export function getProviderWorkspaceConfigFile(workspaceRoot: string): string {
  return join(resolveUbumeWorkspaceDataDir(normalizeWorkspaceRoot(workspaceRoot)), "providers.json");
}

export function getLegacyProviderWorkspaceConfigFile(workspaceRoot: string): string {
  return join(normalizeWorkspaceRoot(workspaceRoot), ".codexa", "providers.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeprecatedAntigravityProviderId(value: unknown): boolean {
  return value === DEPRECATED_ANTIGRAVITY_PROVIDER_ID;
}

function isDeprecatedAntigravityRoute(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isDeprecatedAntigravityProviderId(value.providerId ?? value.provider_id)
    || DEPRECATED_ANTIGRAVITY_BACKENDS.has(String(value.backendKind ?? value.backend_kind));
}

function isDeprecatedGoogleRoute(value: unknown): boolean {
  return isRecord(value) && (value.providerId ?? value.provider_id) === DEPRECATED_GOOGLE_PROVIDER_ID;
}

function resolveDeprecatedProviderFallback(
  providers: Partial<Record<ProviderId, ProviderWorkspaceOverride>>,
): ProviderId {
  const candidates: readonly ProviderId[] = ["openai", "anthropic", "local"];
  return candidates.find((providerId) =>
    isProviderRoutableInUbume(providerId)
    && (providerId === "openai" || providers[providerId] !== undefined || isProviderRouteConfigured(providerId))
  ) ?? "openai";
}

function createFallbackActiveRoute(
  providerId: ProviderId,
  providers: Partial<Record<ProviderId, ProviderWorkspaceOverride>>,
): ProviderActiveRoute {
  const override = providers[providerId];
  const modelId = providerId === "openai"
    ? override?.currentModel ?? DEFAULT_MODEL
    : providerId === "google"
      ? normalizeGeminiModelId(override?.currentModel ?? getDefaultRouteModel(providerId, DEFAULT_MODEL))
      : override?.currentModel ?? getDefaultRouteModel(providerId, DEFAULT_MODEL);

  return {
    providerId,
    modelId,
    backendKind: getProviderRuntime(providerId).backendKind,
    ...(override?.currentReasoning ? { reasoning: override.currentReasoning } : {}),
    ...(providerId === "google" ? { modelSelection: { kind: "manual" as const, modelId } } : {}),
    ...(providerId === "local" ? { localBackend: override?.localBackend ?? "lm-studio" } : {}),
  };
}

function parseLaunchCommand(value: unknown): ProviderWorkspaceOverride["command"] | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.executable !== "string") return undefined;
  return {
    executable: value.executable,
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [],
  };
}

function parseProviderOverride(value: unknown): ProviderWorkspaceOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override: ProviderWorkspaceOverride = {};

  // Accept both camelCase and snake_case field names for compatibility with
  // config files written by different tool versions.
  if (typeof value.currentModel === "string") {
    override.currentModel = value.currentModel;
  } else if (typeof value.current_model === "string") {
    override.currentModel = value.current_model;
  }

  if (typeof value.currentReasoning === "string") {
    override.currentReasoning = value.currentReasoning;
  } else if (typeof value.current_reasoning === "string") {
    override.currentReasoning = value.current_reasoning;
  }

  if (typeof value.enabled === "boolean") {
    override.enabled = value.enabled;
  }

  const providerType = value.type;
  if (providerType === "openai-compatible") {
    override.type = providerType;
  }

  const baseUrl = value.baseUrl ?? value.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    override.baseUrl = baseUrl.trim();
  }

  const apiKey = value.apiKey ?? value.api_key;
  if (typeof apiKey === "string" && apiKey.trim()) {
    override.apiKey = apiKey.trim();
  }

  const pinnedModel = value.pinnedModel ?? value.pinned_model;
  if (typeof pinnedModel === "string" && pinnedModel.trim()) {
    override.pinnedModel = pinnedModel.trim();
  }

  const defaultModel = value.defaultModel ?? value.default_model;
  if (typeof defaultModel === "string" && defaultModel.trim()) {
    override.defaultModel = defaultModel.trim();
  }

  const localBackend = value.localBackend ?? value.local_backend;
  if (localBackend === "lm-studio" || localBackend === "unsloth") {
    override.localBackend = localBackend;
  }

  if (isRecord(value.models)) {
    const models: Record<string, import("./types.js").ProviderModelWorkspaceOverride> = {};
    for (const [modelId, modelValue] of Object.entries(value.models)) {
      if (!modelId.trim() || !isRecord(modelValue)) continue;
      const entry: import("./types.js").ProviderModelWorkspaceOverride = {};

      const rawContextLength = modelValue.contextLength ?? modelValue.context_length;
      if (typeof rawContextLength === "number" && Number.isInteger(rawContextLength) && rawContextLength > 0) {
        entry.contextLength = rawContextLength;
      }

      const rawMaxOutput = modelValue.maxOutputTokens ?? modelValue.max_output_tokens;
      if (typeof rawMaxOutput === "number" && Number.isInteger(rawMaxOutput) && rawMaxOutput > 0) {
        entry.maxOutputTokens = rawMaxOutput;
      }

      for (const [camelKey, snakeKey] of [
        ["supportsReasoningEffort", "supports_reasoning_effort"],
        ["supportsStreaming", "supports_streaming"],
        ["supportsToolCalls", "supports_tool_calls"],
        ["supportsSystemPrompt", "supports_system_prompt"],
        ["supportsVision", "supports_vision"],
      ] as const) {
        const raw = modelValue[camelKey] ?? modelValue[snakeKey];
        if (typeof raw === "boolean") {
          (entry as Record<string, unknown>)[camelKey] = raw;
        }
      }

      if (Object.keys(entry).length > 0) {
        models[modelId] = entry;
      }
    }
    if (Object.keys(models).length > 0) {
      override.models = models;
    }
  }

  const command = parseLaunchCommand(value.command);
  if (command !== undefined) {
    override.command = command;
  }

  const claudeCommandPath = value.claudeCommandPath ?? value.claude_command_path;
  if (typeof claudeCommandPath === "string" && claudeCommandPath.trim()) {
    override.claudeCommandPath = claudeCommandPath.trim();
  }

  const geminiCommandPath = value.geminiCommandPath ?? value.gemini_command_path;
  if (typeof geminiCommandPath === "string" && geminiCommandPath.trim()) {
    override.geminiCommandPath = geminiCommandPath.trim();
  }

  const codexCommandPath = value.codexCommandPath ?? value.codex_command_path;
  if (typeof codexCommandPath === "string" && codexCommandPath.trim()) {
    override.codexCommandPath = codexCommandPath.trim();
  }

  return override;
}

function parseActiveRoute(value: unknown): ProviderActiveRoute | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = value.providerId ?? value.provider_id;
  const modelId = value.modelId ?? value.model_id;
  const backendKind = value.backendKind ?? value.backend_kind;
  const reasoning = value.reasoning;
  const modelSelection = value.modelSelection ?? value.model_selection;
  const localBackend = value.localBackend ?? value.local_backend;

  if (typeof providerId !== "string" || !isKnownProviderId(providerId) || !isProviderRoutableInUbume(providerId)) return undefined;
  if (typeof modelId !== "string" || !modelId.trim()) return undefined;

  const normalizedModelId = providerId === "google" ? normalizeGeminiModelId(modelId.trim()) : modelId.trim();
  const normalizedModelSelection = providerId === "google" && isRecord(modelSelection)
    ? modelSelection.kind === "manual"
      ? { kind: "manual" as const, modelId: normalizeGeminiModelId(typeof modelSelection.modelId === "string" ? modelSelection.modelId : null) }
      : { kind: "auto" as const, family: modelSelection.family === "gemini-2.5" ? "gemini-2.5" as const : "gemini-3" as const }
    : undefined;

  return {
    providerId,
    modelId: normalizedModelId,
    backendKind: getProviderRuntime(providerId).backendKind,
    ...(typeof reasoning === "string" && reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(normalizedModelSelection ? { modelSelection: normalizedModelSelection } : {}),
    ...(providerId === "local"
      ? { localBackend: localBackend === "unsloth" ? "unsloth" as const : "lm-studio" as const }
      : {}),
  };
}

export function parseProviderWorkspaceConfig(data: unknown): ProviderWorkspaceConfig {
  if (!isRecord(data)) return {};

  const config: ProviderWorkspaceConfig = {};
  const providers: Partial<Record<ProviderId, ProviderWorkspaceOverride>> = {};
  let foundDeprecatedAntigravity = false;
  let foundDeprecatedGoogle = false;

  if (isRecord(data.providers)) {
    for (const [id, value] of Object.entries(data.providers)) {
      if (isDeprecatedAntigravityProviderId(id)) {
        foundDeprecatedAntigravity = true;
        continue;
      }
      if (id === DEPRECATED_GOOGLE_PROVIDER_ID) {
        foundDeprecatedGoogle = true;
        continue;
      }
      if (!isKnownProviderId(id)) continue;
      const override = parseProviderOverride(value);
      if (override) providers[id] = override;
    }
    config.providers = providers;
  }

  const defaultProvider = data.workspaceDefaultProviderId
    ?? data.workspace_default_provider_id
    ?? data.defaultProviderId
    ?? data.default_provider_id;
  if (defaultProvider === DEPRECATED_GOOGLE_PROVIDER_ID) {
    foundDeprecatedGoogle = true;
    config.workspaceDefaultProviderId = resolveDeprecatedProviderFallback(providers);
  } else if (isDeprecatedAntigravityProviderId(defaultProvider)) {
    foundDeprecatedAntigravity = true;
    config.workspaceDefaultProviderId = resolveDeprecatedProviderFallback(providers);
  } else if (typeof defaultProvider === "string" && isKnownProviderId(defaultProvider)) {
    config.workspaceDefaultProviderId = defaultProvider;
  }

  const rawActiveRoute = data.activeRoute ?? data.active_route;
  if (isDeprecatedGoogleRoute(rawActiveRoute)) {
    foundDeprecatedGoogle = true;
    const fallbackProviderId = resolveDeprecatedProviderFallback(providers);
    config.activeRoute = createFallbackActiveRoute(fallbackProviderId, providers);
    config.workspaceDefaultProviderId ??= fallbackProviderId;
  } else if (isDeprecatedAntigravityRoute(rawActiveRoute)) {
    foundDeprecatedAntigravity = true;
    const fallbackProviderId = resolveDeprecatedProviderFallback(providers);
    config.activeRoute = createFallbackActiveRoute(fallbackProviderId, providers);
    config.workspaceDefaultProviderId ??= fallbackProviderId;
  } else {
    const activeRoute = parseActiveRoute(rawActiveRoute);
    if (activeRoute) {
      config.activeRoute = activeRoute;
      if (activeRoute.providerId === "local") {
        providers.local = {
          ...providers.local,
          localBackend: activeRoute.localBackend ?? "lm-studio",
        };
        config.providers = providers;
      }
    }
  }

  if (foundDeprecatedGoogle || foundDeprecatedAntigravity) {
    const revertedProviderId = config.activeRoute?.providerId
      ?? config.workspaceDefaultProviderId
      ?? resolveDeprecatedProviderFallback(providers);
    config.migrationNotice = {
      deprecatedProviderId: foundDeprecatedGoogle ? DEPRECATED_GOOGLE_PROVIDER_ID : DEPRECATED_ANTIGRAVITY_PROVIDER_ID,
      revertedProviderId,
    };
  }

  return config;
}

function serializeLaunchCommand(command: string | ProviderLaunchCommand | null | undefined): unknown {
  if (command === undefined || command === null || typeof command === "string") {
    return command;
  }
  return {
    executable: command.executable,
    args: command.args,
  };
}

export function serializeProviderWorkspaceConfig(config: ProviderWorkspaceConfig): Record<string, unknown> {
  const providers = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([id, override]) => [
      id,
      {
        ...(override.currentModel !== undefined ? { current_model: override.currentModel } : {}),
        ...(override.currentReasoning !== undefined ? { current_reasoning: override.currentReasoning } : {}),
        ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
        ...(override.type !== undefined ? { type: override.type } : {}),
        ...(override.baseUrl !== undefined ? { base_url: override.baseUrl } : {}),
        ...(override.apiKey !== undefined ? { api_key: override.apiKey } : {}),
        ...(override.pinnedModel !== undefined ? { pinned_model: override.pinnedModel } : {}),
        ...(override.defaultModel !== undefined ? { default_model: override.defaultModel } : {}),
        ...(override.localBackend !== undefined ? { local_backend: override.localBackend } : {}),
        ...(override.models !== undefined ? { models: Object.fromEntries(
          Object.entries(override.models).map(([modelId, model]) => [
            modelId,
            {
              ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
              ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
              ...(model.supportsStreaming !== undefined ? { supportsStreaming: model.supportsStreaming } : {}),
              ...(model.supportsToolCalls !== undefined ? { supportsToolCalls: model.supportsToolCalls } : {}),
              ...(model.supportsSystemPrompt !== undefined ? { supportsSystemPrompt: model.supportsSystemPrompt } : {}),
              ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
              ...(model.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: model.supportsReasoningEffort } : {}),
            },
          ]),
        ) } : {}),
        ...(override.command !== undefined ? { command: serializeLaunchCommand(override.command) } : {}),
        ...(override.claudeCommandPath !== undefined ? { claude_command_path: override.claudeCommandPath } : {}),
        ...(override.geminiCommandPath !== undefined ? { gemini_command_path: override.geminiCommandPath } : {}),
        ...(override.codexCommandPath !== undefined ? { codex_command_path: override.codexCommandPath } : {}),
      },
    ]),
  );

  return {
    ...(config.workspaceDefaultProviderId ? { workspaceDefaultProviderId: config.workspaceDefaultProviderId } : {}),
    ...(config.activeRoute ? {
      activeRoute: {
        providerId: config.activeRoute.providerId,
        modelId: config.activeRoute.modelId,
        backendKind: config.activeRoute.backendKind ?? getProviderRuntime(config.activeRoute.providerId).backendKind,
        ...(config.activeRoute.reasoning ? { reasoning: config.activeRoute.reasoning } : {}),
        ...(config.activeRoute.modelSelection ? { modelSelection: config.activeRoute.modelSelection } : {}),
        ...(config.activeRoute.providerId === "local"
          ? { localBackend: config.activeRoute.localBackend ?? config.providers?.local?.localBackend ?? "lm-studio" }
          : {}),
      },
    } : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
}

export function loadProviderWorkspaceConfig(workspaceRoot: string): ProviderWorkspaceConfig {
  const filePath = getProviderWorkspaceConfigFile(workspaceRoot);
  if (existsSync(filePath)) {
    try {
      return parseProviderWorkspaceConfig(JSON.parse(readFileSync(filePath, "utf-8")));
    } catch {
      return {};
    }
  }

  const legacyFilePath = getLegacyProviderWorkspaceConfigFile(workspaceRoot);
  if (!existsSync(legacyFilePath)) return {};
  try {
    return parseProviderWorkspaceConfig(JSON.parse(readFileSync(legacyFilePath, "utf-8")));
  } catch {
    return {};
  }
}

export function saveProviderWorkspaceConfig(workspaceRoot: string, config: ProviderWorkspaceConfig): void {
  const filePath = getProviderWorkspaceConfigFile(workspaceRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(serializeProviderWorkspaceConfig(config), null, 2), "utf-8");
  renameSync(tmpFile, filePath);
}

export function setProviderWorkspaceDefault(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
): ProviderWorkspaceConfig {
  return {
    ...config,
    workspaceDefaultProviderId: providerId === DEPRECATED_GOOGLE_PROVIDER_ID ? "openai" : providerId,
  };
}

export function setProviderDefaultModel(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
  modelId: string,
): ProviderWorkspaceConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        ...config.providers?.[providerId],
        currentModel: modelId,
      },
    },
  };
}

export function setProviderDefaultReasoning(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
  reasoning: string,
): ProviderWorkspaceConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        ...config.providers?.[providerId],
        currentReasoning: reasoning,
      },
    },
  };
}

export function setProviderActiveRoute(
  config: ProviderWorkspaceConfig,
  activeRoute: ProviderActiveRoute,
): ProviderWorkspaceConfig {
  if (activeRoute.providerId === DEPRECATED_GOOGLE_PROVIDER_ID || !isProviderRoutableInUbume(activeRoute.providerId) || !isProviderRouteConfigured(activeRoute.providerId)) {
    return config;
  }

  if (activeRoute.providerId !== "local") {
    return { ...config, activeRoute };
  }

  const localBackend = activeRoute.localBackend ?? config.providers?.local?.localBackend ?? "lm-studio";
  return {
    ...config,
    activeRoute: { ...activeRoute, localBackend },
    providers: {
      ...config.providers,
      local: {
        ...config.providers?.local,
        localBackend,
      },
    },
  };
}

export function setLocalBackendPreference(
  config: ProviderWorkspaceConfig,
  localBackend: import("./types.js").LocalBackendId,
): ProviderWorkspaceConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      local: {
        ...config.providers?.local,
        localBackend,
      },
    },
  };
}
