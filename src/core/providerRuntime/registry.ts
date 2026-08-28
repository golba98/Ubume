import { codexSubprocessProvider } from "../providers/codexSubprocess.js";
import { loadSeededOpenAiModels } from "../models/codexModelsCacheSeed.js";
import { loadCachedProviderModels, saveCachedProviderModels } from "../models/providerModelCache.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ProviderId, ProviderActiveRoute, ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import { isLocalDevChannel } from "../version/channel.js";
import { anthropicRuntime } from "./anthropic.js";
import { geminiRuntime } from "./gemini.js";
import { localRuntime } from "./local.js";
import { codexaNativeRuntime, CODEXA_NATIVE_MODEL_ID } from "./codexaNative.js";
import { codexaCupyRuntime } from "./codexaCupy.js";
import { antigravityRuntime, ANTIGRAVITY_DEFAULT_MODEL_ID, migrateAntigravityLegacyModelId } from "./antigravity.js";
import { mistralVibeRuntime } from "./mistralVibe.js";
import {
  ANTHROPIC_FALLBACK_MODELS,
  GEMINI_DEFAULT_MODEL_ID,
  GEMINI_FALLBACK_MODELS,
  normalizeGeminiModelId,
} from "./models.js";
import type {
  ActiveProviderRoute,
  GeminiModelSelection,
  ProviderChatRequest,
  ProviderModelDiscoveryResult,
  ProviderRoute,
  ProviderRouteValidationResult,
  ProviderRuntime,
} from "./types.js";

const openAiRuntime: ProviderRuntime = {
  providerId: "openai",
  label: "OpenAI/Codex",
  backendKind: "codex-cli-auth",
  routeAvailable: true,
  routeStatus: "Uses the configured Codex/OpenAI backend inside Codexa.",
  launchAvailable: true,
  discoverModels: () => ({
    status: "ready",
    providerId: "openai",
    backendKind: "codex-cli-auth",
    models: loadSeededOpenAiModels()?.models ?? [],
  }),
  run: (request: ProviderChatRequest, handlers: BackendRunHandlers) => {
    handlers.onProgress?.({
      id: "openai-route",
      source: "stdout",
      text: "Starting Codex CLI",
    });
    return codexSubprocessProvider.run!(
      request.prompt,
      {
        runtime: request.runtime,
        workspaceRoot: request.workspaceRoot,
        projectInstructions: request.projectInstructions,
        conversationHistory: request.conversationHistory,
      },
      handlers,
    );
  },
};

function unavailableRuntime(providerId: ProviderId, label: string): ProviderRuntime {
  return {
    providerId,
    label,
    backendKind: "unavailable",
    routeAvailable: false,
    routeStatus: `${label} is available as a launcher, but in-Codexa routing is not configured yet.`,
    launchAvailable: providerId !== "local",
    discoverModels: (): ProviderModelDiscoveryResult => ({
      status: "not-configured",
      providerId,
      backendKind: "unavailable",
      models: [],
      message: `${label} is available as a launcher, but in-Codexa routing is not configured yet.`,
    }),
  };
}

const PROVIDER_RUNTIMES: Record<ProviderId, ProviderRuntime> = {
  openai: openAiRuntime,
  anthropic: anthropicRuntime,
  google: geminiRuntime,
  mistral: mistralVibeRuntime,
  local: localRuntime,
  "codexa-native": codexaNativeRuntime,
  "codexa-cupy": codexaCupyRuntime,
  antigravity: antigravityRuntime,
};

export function getProviderRuntime(providerId: ProviderId): ProviderRuntime {
  return PROVIDER_RUNTIMES[providerId];
}

export function isProviderRoutableInCodexa(
  providerId: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((providerId === "codexa-native" || providerId === "codexa-cupy") && !isLocalDevChannel(env)) {
    return false;
  }
  return getProviderRuntime(providerId).routeAvailable;
}

export function isProviderRouteConfigured(
  providerId: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const runtime = getProviderRuntime(providerId);
  return isProviderRoutableInCodexa(providerId, env) && (runtime.isRouteConfigured?.() ?? true);
}

export function getProviderRouteSetupMessage(providerId: ProviderId): string {
  const runtime = getProviderRuntime(providerId);
  return runtime.routeSetupMessage ?? runtime.routeStatus;
}

export function discoverProviderModels(providerId: ProviderId): ProviderModelDiscoveryResult {
  const result = getProviderRuntime(providerId).discoverModels();
  const hasRuntimeModels = result.models.some((model) => model.source && model.source !== "fallback");
  if (result.status === "ready" && !hasRuntimeModels) {
    const cached = loadCachedProviderModels(providerId);
    if (cached) {
      return { ...result, models: cached.models };
    }
  }
  return result;
}

export function persistProviderDiscovery(discovery: ProviderModelDiscoveryResult): void {
  const runtimeModels = discovery.models.filter((model) => model.source && model.source !== "fallback");
  if (discovery.status !== "ready" || runtimeModels.length === 0) {
    return;
  }
  saveCachedProviderModels(discovery.providerId, {
    discoveredAt: Date.now(),
    models: runtimeModels,
  });
}

export async function validateProviderRouteActivation(options: {
  route: ProviderRoute;
  workspaceRoot: string;
  geminiCommandPath?: string | null;
  claudeCommandPath?: string | null;
  antigravityCommandPath?: string | null;
  localConfig?: ProviderWorkspaceOverride | null;
}): Promise<ProviderRouteValidationResult> {
  const runtime = getProviderRuntime(options.route.providerId);
  if (!runtime.routeAvailable) {
    return {
      status: "not-configured",
      providerId: options.route.providerId,
      backendKind: "unavailable",
      message: getProviderRouteSetupMessage(options.route.providerId),
    };
  }

  if (runtime.validateRoute) {
    return runtime.validateRoute(options);
  }

  if (!isProviderRouteConfigured(options.route.providerId)) {
    return {
      status: "not-configured",
      providerId: options.route.providerId,
      backendKind: "unavailable",
      message: getProviderRouteSetupMessage(options.route.providerId),
    };
  }

  return {
    status: "ready",
    providerId: options.route.providerId,
    backendKind: runtime.backendKind,
  };
}

export function resolveGeminiModelId(selection: GeminiModelSelection): string {
  if (selection.kind === "manual") {
    return normalizeGeminiModelId(selection.modelId);
  }
  if (selection.family === "gemini-3") {
    return "gemini-3-flash-preview";
  }
  if (selection.family === "gemini-2.5") {
    return "gemini-2.5-pro";
  }
  return GEMINI_DEFAULT_MODEL_ID;
}

export function resolveActiveProviderRoute(options: {
  workspaceConfigActiveRoute?: ProviderActiveRoute;
  currentModel: string;
  currentReasoning: string;
}): ActiveProviderRoute {
  const configuredRoute = options.workspaceConfigActiveRoute;
  if (configuredRoute && configuredRoute.providerId !== "google" && isProviderRoutableInCodexa(configuredRoute.providerId)) {
    const route: ActiveProviderRoute = {
      providerId: configuredRoute.providerId,
      modelId: configuredRoute.modelId,
      backendKind: configuredRoute.backendKind ?? getProviderRuntime(configuredRoute.providerId).backendKind,
      ...(configuredRoute.reasoning ? { reasoning: configuredRoute.reasoning } : {}),
      ...(configuredRoute.modelSelection ? { modelSelection: configuredRoute.modelSelection } : {}),
      ...(configuredRoute.providerId === "local"
        ? { localBackend: configuredRoute.localBackend ?? "lm-studio" }
        : {}),
    };

    if (route.providerId === "google" && route.modelSelection) {
      route.modelId = resolveGeminiModelId(route.modelSelection);
    } else if (route.providerId === "google") {
      route.modelId = normalizeGeminiModelId(route.modelId);
    } else if (route.providerId === "anthropic") {
      const discovery = discoverProviderModels("anthropic");
      const stillAvailable = discovery.models.some((model) =>
        model.modelId === route.modelId ||
        model.id === route.modelId ||
        model.canonicalId === route.modelId
      );
      const hasNonFallbackModels = discovery.models.some((model) => model.source !== "fallback");
      const isKnownShortAlias = ANTHROPIC_FALLBACK_MODELS.some((model) => model.modelId === route.modelId);
      if (discovery.status === "ready" && hasNonFallbackModels && discovery.models.length > 0 && !stillAvailable && isKnownShortAlias) {
        route.modelId = discovery.models[0]!.modelId;
      }
    } else if (route.providerId === "antigravity") {
      const migrated = migrateAntigravityLegacyModelId(route.modelId);
      route.modelId = migrated.modelId;
      if (!route.reasoning && migrated.reasoning) {
        route.reasoning = migrated.reasoning;
      }
      const discovery = discoverProviderModels("antigravity");
      if (discovery.status === "ready" && discovery.models.length > 0) {
        let model = discovery.models.find((item) => item.modelId === route.modelId || item.id === route.modelId);
        if (!model) {
          model = discovery.models[0];
          route.modelId = model.modelId;
        }
        const levels = model.supportedReasoningLevels;
        if (levels?.length && (!route.reasoning || !levels.some((level) => level.id === route.reasoning))) {
          route.reasoning = model.defaultReasoningLevel ?? levels[0]?.id;
        }
      }
    }

    return route;
  }

  return {
    providerId: "openai",
    modelId: options.currentModel,
    backendKind: "codex-cli-auth",
    reasoning: options.currentReasoning,
  };
}

export function getDefaultRouteModel(providerId: ProviderId, currentOpenAiModel: string): string {
  if (providerId === "anthropic") {
    const discovered = discoverProviderModels("anthropic");
    if (discovered.status === "ready" && discovered.models.length > 0) {
      return discovered.models[0].modelId;
    }
    return ANTHROPIC_FALLBACK_MODELS[0]?.modelId ?? "sonnet";
  }
  if (providerId === "google") {
    return GEMINI_FALLBACK_MODELS[0]?.modelId ?? GEMINI_DEFAULT_MODEL_ID;
  }
  if (providerId === "local") {
    const discovery = discoverProviderModels("local");
    return discovery.models[0]?.modelId ?? "Local default";
  }
  if (providerId === "codexa-native") {
    return CODEXA_NATIVE_MODEL_ID;
  }
  if (providerId === "mistral") {
    const discovery = discoverProviderModels("mistral");
    return discovery.models[0]?.modelId ?? "Vibe default";
  }
  if (providerId === "antigravity") {
    return discoverProviderModels("antigravity").models[0]?.modelId ?? ANTIGRAVITY_DEFAULT_MODEL_ID;
  }
  return currentOpenAiModel;
}
