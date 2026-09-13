import type {
  ProviderConfig,
  ProviderId,
  ProviderBackendType,
  ProviderLaunchCommand,
  ProviderWorkspaceConfig,
  ProviderWorkspaceOverride,
} from "./types.js";
import { DEFAULT_MODEL } from "../../config/settings.js";
import { isLocalDevChannel } from "../version/channel.js";
import {
  getDefaultRouteModel,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  isProviderRoutableInUbume,
  isProviderRouteConfigured,
} from "../providerRuntime/registry.js";
import { normalizeGeminiModelId } from "../providerRuntime/models.js";
import { ANTIGRAVITY_DEFAULT_MODEL_ID } from "../providerRuntime/antigravity.js";
import { discoverMistralVibeModels } from "../providerRuntime/mistralVibe.js";
import { setLocalProviderConfig } from "../providerRuntime/local.js";
import { CODEXA_NATIVE_MODEL_ID, discoverCodexaNativeModels } from "../providerRuntime/codexaNative.js";
import { CODEXA_CUPY_MODEL_ID, discoverCodexaCupyModels } from "../providerRuntime/codexaCupy.js";
import { formatContextLength, resolveModelContextLengthCached } from "../providerRuntime/contextMetadata.js";
import { resolveModelCapabilityProfileCached } from "../providerRuntime/capabilityProfile.js";

// Google/Gemini remains a recognized legacy config value so existing workspace
// files can be migrated, but it is no longer a selectable Ubume provider.
const ALL_PROVIDER_ORDER: readonly ProviderId[] = ["openai", "anthropic", "mistral", "codexa-native", "codexa-cupy", "local", "antigravity"];
const KNOWN_PROVIDER_IDS: readonly ProviderId[] = ["openai", "anthropic", "google", "mistral", "local", "codexa-native", "codexa-cupy", "antigravity"];

export function getProviderOrder(env: NodeJS.ProcessEnv = process.env): readonly ProviderId[] {
  if (isLocalDevChannel(env)) {
    return ALL_PROVIDER_ORDER;
  }
  return ALL_PROVIDER_ORDER.filter((id) => id !== "codexa-native" && id !== "codexa-cupy");
}

const DEFAULT_PROVIDER_ID: ProviderId = "openai";

type ProviderDefault = Omit<ProviderConfig, "currentModel" | "enabled" | "statusLabel" | "launchCommand" | "isDefault"> & {
  currentModel: (activeModel: string) => string;
  enabled: boolean;
  launchCommand: ProviderLaunchCommand | null;
};

const DEFAULT_PROVIDERS: Record<ProviderId, ProviderDefault> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    currentModel: (activeModel) => activeModel,
    backendType: "codex-cli-auth",
    routeMode: "in-ubume",
    enabled: true,
    launchCommand: { executable: "codex", args: [] },
    isActiveRoute: false,
    routeUnavailableReason: null,
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    currentModel: () => "Claude Code default",
    backendType: "claude-code-auth",
    routeMode: "in-ubume",
    enabled: true,
    launchCommand: { executable: "claude", args: [] },
    isActiveRoute: false,
    routeUnavailableReason: null,
  },
  google: {
    id: "google",
    displayName: "Google",
    currentModel: () => "gemini-3-flash-preview",
    backendType: "gemini-cli-auth",
    routeMode: "in-ubume",
    enabled: true,
    launchCommand: { executable: "gemini", args: [] },
    isActiveRoute: false,
    routeUnavailableReason: null,
  },
  local: {
    id: "local",
    displayName: "Local",
    currentModel: () => "Local default",
    backendType: "local-openai-compatible",
    routeMode: "in-ubume",
    enabled: false,
    launchCommand: null,
    isActiveRoute: false,
    routeUnavailableReason: "Local provider unavailable. Start LM Studio, load a model, and enable the local server.",
  },
  "codexa-native": {
    id: "codexa-native",
    displayName: "ubume-PyTorch",
    currentModel: () => CODEXA_NATIVE_MODEL_ID,
    backendType: "codexa-native-pytorch",
    routeMode: "in-ubume",
    enabled: false,
    launchCommand: null,
    isActiveRoute: false,
    routeUnavailableReason: "Codexa Native is only available on ubume-dev.",
  },
  "codexa-cupy": {
    id: "codexa-cupy",
    displayName: "CuPy",
    currentModel: () => CODEXA_CUPY_MODEL_ID,
    backendType: "codexa-cupy",
    routeMode: "in-ubume",
    enabled: false,
    launchCommand: null,
    isActiveRoute: false,
    routeUnavailableReason: "CuPy is only available on ubume-dev.",
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral Vibe CLI",
    currentModel: () => "Vibe default",
    backendType: "mistral-vibe-cli-auth",
    routeMode: "in-ubume",
    enabled: true,
    launchCommand: { executable: "vibe", args: [] },
    isActiveRoute: false,
    routeUnavailableReason: null,
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    currentModel: () => ANTIGRAVITY_DEFAULT_MODEL_ID,
    backendType: "antigravity-cli-auth",
    routeMode: "in-ubume",
    enabled: true,
    launchCommand: { executable: "agy", args: [] },
    isActiveRoute: false,
    routeUnavailableReason: null,
  },
};

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && KNOWN_PROVIDER_IDS.includes(value as ProviderId);
}

function normalizeLaunchCommand(value: ProviderWorkspaceOverride["command"] | undefined): ProviderLaunchCommand | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const executable = value.trim();
    return executable ? { executable, args: [] } : null;
  }
  if (typeof value.executable !== "string") return undefined;
  const executable = value.executable.trim();
  if (!executable) return null;
  return {
    executable,
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [],
  };
}

function applyOverride(
  provider: ProviderConfig,
  override: ProviderWorkspaceOverride | undefined,
): ProviderConfig {
  if (!override) return provider;

  const launchCommand = normalizeLaunchCommand(override.command);
  const hasConfiguredCommand = launchCommand !== undefined;
  const nextCommand = hasConfiguredCommand ? launchCommand : provider.launchCommand;
  const nextEnabled = typeof override.enabled === "boolean"
    ? provider.id === "local" ? provider.enabled && override.enabled : override.enabled
    : provider.enabled;

  const overrideModel = typeof override.currentModel === "string" && override.currentModel.trim()
    ? override.currentModel.trim()
    : null;

  return {
    ...provider,
    currentModel: overrideModel && provider.id !== "local"
      ? provider.id === "google" ? normalizeGeminiModelId(overrideModel) : overrideModel
      : provider.currentModel,
    enabled: nextEnabled,
    launchCommand: nextCommand,
    statusLabel: !nextEnabled
      ? "Disabled"
      : provider.routeMode === "launch-only"
        ? provider.statusLabel
        : (provider.routeUnavailableReason ? "Needs config" : "Enabled"),
  };
}

export function getDefaultProviderId(
  config: ProviderWorkspaceConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId {
  const providerId = config?.workspaceDefaultProviderId;
  const isAvailable = isProviderId(providerId)
    && providerId !== "google"
    && (providerId !== "codexa-native" || isLocalDevChannel(env));
  return isAvailable ? providerId : DEFAULT_PROVIDER_ID;
}

export function getActiveRouteProviderId(
  config: ProviderWorkspaceConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId {
  const providerId = config?.activeRoute?.providerId;
  return isProviderId(providerId) && providerId !== "google" && isProviderRoutableInUbume(providerId, env)
    ? providerId
    : DEFAULT_PROVIDER_ID;
}

export function buildProviderRegistry(options: {
  activeModel: string;
  workspaceRoot?: string;
  workspaceConfig?: ProviderWorkspaceConfig | null;
  diagnostics?: Record<string, Record<string, string | number | boolean | null>>;
  routeErrors?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): ProviderConfig[] {
  const env = options.env ?? process.env;
  const defaultProviderId = getDefaultProviderId(options.workspaceConfig, env);
  const activeRouteProviderId = getActiveRouteProviderId(options.workspaceConfig, env);
  const providerOrder = getProviderOrder(env);

  return providerOrder.map((id) => {
    if (id === "local") {
      setLocalProviderConfig(options.workspaceConfig?.providers?.local);
    }
    const defaults = DEFAULT_PROVIDERS[id];
    const runtime = getProviderRuntime(id);
    const discovery = id === "mistral"
      ? discoverMistralVibeModels(options.workspaceRoot ?? process.cwd())
      : id === "codexa-native"
      ? discoverCodexaNativeModels(undefined, env)
      : id === "codexa-cupy"
      ? discoverCodexaCupyModels(undefined, env)
      : runtime.discoverModels();

    const activeRoute = options.workspaceConfig?.activeRoute;
    const isThisActive = activeRoute?.providerId === id;

    let currentModelLabel = isThisActive && activeRoute
      ? activeRoute.modelId
      : getDefaultRouteModel(id, id === "openai" ? DEFAULT_MODEL : defaults.currentModel(options.activeModel));

    if (id === "google") {
      const hasGoogleOverride = options.workspaceConfig?.providers?.google?.currentModel !== undefined;
      const geminiRoute = isThisActive || !hasGoogleOverride ? activeRoute : null;
      const selection = geminiRoute?.modelSelection;
      if (selection) {
        if (selection.kind === "auto") {
          currentModelLabel = `Auto (${selection.family === "gemini-3" ? "Gemini 3" : "Gemini 2.5"})`;
        } else {
          currentModelLabel = normalizeGeminiModelId(selection.modelId);
        }
      } else {
        currentModelLabel = normalizeGeminiModelId(currentModelLabel);
      }
    }

    if (id === "local") {
      const selectedModel = typeof discovery.diagnostics?.selectedModel === "string" && discovery.diagnostics.selectedModel.trim()
        ? discovery.diagnostics.selectedModel.trim()
        : discovery.models[0]?.modelId;
      if (selectedModel) {
        currentModelLabel = selectedModel;
      }
    }

    if (id === "mistral") {
      currentModelLabel = discovery.models[0]?.modelId ?? "Vibe default";
    }

    const rawMetadataForModel = discovery.models.find((model) => model.modelId === currentModelLabel)?.raw;
    const contextMetadata = resolveModelContextLengthCached({
      providerId: id,
      modelId: currentModelLabel,
      providerConfig: options.workspaceConfig?.providers?.[id],
      rawMetadata: rawMetadataForModel,
    });
    const contextSource = contextMetadata.source === "known-registry" ? "registry" : contextMetadata.source;
    const capabilityProfile = resolveModelCapabilityProfileCached({
      providerId: id,
      modelId: currentModelLabel,
      providerConfig: options.workspaceConfig?.providers?.[id],
      rawMetadata: rawMetadataForModel,
    });

    const routeUnavailableReason: string | null = runtime.routeAvailable
      ? (isProviderRouteConfigured(id, env)
          ? null
          : (options.routeErrors?.[id]
            ?? discovery.message
            ?? getProviderRouteSetupMessage(id)))
      : runtime.routeStatus;

    const enabled = id === "codexa-native" || id === "codexa-cupy"
      ? isLocalDevChannel(env)
      : id === "local"
      ? discovery.status === "ready"
      : defaults.enabled;

    const availabilityStatus = options.diagnostics?.[id]?.availabilityStatus;
    const statusLabel = id === "mistral"
      ? availabilityStatus === "checking"
        ? "Checking"
        : availabilityStatus === "unavailable"
          ? "Missing"
          : routeUnavailableReason
            ? "Needs config"
            : "Enabled"
      : id === "local"
      ? (discovery.status === "ready" ? "Enabled" : "Disabled")
      : !enabled
        ? "Disabled"
        : routeUnavailableReason
          ? "Needs config"
          : "Enabled";

    const provider: ProviderConfig = {
      id,
      displayName: defaults.displayName,
      currentModel: currentModelLabel,
      contextLengthLabel: formatContextLength(contextMetadata.contextLength),
      contextLengthSource: contextSource,
      capabilityProfile,
      // Keep the provider's stable backend identity even when discovery reports
      // missing local model files. Availability is represented separately by
      // statusLabel and routeUnavailableReason.
      backendType: id === "codexa-native" || id === "codexa-cupy"
        ? defaults.backendType
        : discovery.backendKind as ProviderBackendType,
      routeMode: runtime.routeAvailable ? "in-ubume" : "launch-only",
      enabled,
      statusLabel,
      launchCommand: defaults.launchCommand ? { ...defaults.launchCommand, args: [...defaults.launchCommand.args] } : null,
      isDefault: id === defaultProviderId,
      isActiveRoute: id === activeRouteProviderId,
      routeUnavailableReason,
      routeDiagnostics: options.diagnostics?.[id],
    };

    return applyOverride(provider, options.workspaceConfig?.providers?.[id]);
  });
}

export function findProvider(providers: readonly ProviderConfig[], providerId: ProviderId): ProviderConfig | null {
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export function isKnownProviderId(value: string): value is ProviderId {
  return isProviderId(value);
}
