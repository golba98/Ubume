export type ProviderId = "openai" | "anthropic" | "google" | "mistral" | "local" | "codexa-native" | "codexa-cupy" | "antigravity";

export type LocalBackendId = "lm-studio" | "unsloth";

export type ProviderBackendType =
  | "codex-cli-auth"
  | "gemini-cli-auth"
  | "claude-code-auth"
  | "mistral-vibe-cli-auth"
  | "antigravity-cli-auth"
  | "openai-api-key"
  | "gemini-api-key"
  | "anthropic-api-key"
  | "local-openai-compatible"
  | "codexa-native-pytorch"
  | "codexa-cupy"
  | "unavailable";

export type ProviderLaunchAction = "launch" | "set-default" | "cancel";
export type ProviderRouteAction = "use-in-codexa" | "select-model" | "refresh-models" | "run-diagnostics";
export type ProviderPickerAction = ProviderLaunchAction | ProviderRouteAction;
export type ProviderRouteMode = "in-codexa" | "launch-only";

export interface ProviderLaunchCommand {
  executable: string;
  args: string[];
}

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  currentModel: string;
  contextLengthLabel?: string;
  contextLengthSource?: string;
  capabilityProfile?: import("../providerRuntime/capabilityProfile.js").ModelCapabilityProfile;
  backendType: ProviderBackendType;
  routeMode: ProviderRouteMode;
  enabled: boolean;
  statusLabel: string;
  launchCommand: ProviderLaunchCommand | null;
  isDefault: boolean;
  isActiveRoute: boolean;
  routeUnavailableReason: string | null;
  routeDiagnostics?: Record<string, string | number | boolean | null>;
}

export interface ProviderWorkspaceConfig {
  workspaceDefaultProviderId?: ProviderId;
  activeRoute?: ProviderActiveRoute;
  providers?: Partial<Record<ProviderId, ProviderWorkspaceOverride>>;
  migrationNotice?: ProviderWorkspaceMigrationNotice;
}

export interface ProviderWorkspaceMigrationNotice {
  deprecatedProviderId: string;
  revertedProviderId: ProviderId;
}

export interface ProviderActiveRoute {
  providerId: ProviderId;
  modelId: string;
  backendKind?: import("../providerRuntime/types.js").ProviderBackendKind;
  reasoning?: string;
  modelSelection?: import("../providerRuntime/types.js").GeminiModelSelection;
  localBackend?: LocalBackendId;
}

export interface ProviderWorkspaceOverride {
  currentModel?: string;
  currentReasoning?: string;
  enabled?: boolean;
  type?: "openai-compatible";
  baseUrl?: string;
  apiKey?: string;
  pinnedModel?: string;
  defaultModel?: string;
  localBackend?: LocalBackendId;
  models?: Record<string, ProviderModelWorkspaceOverride>;
  command?: string | ProviderLaunchCommand | null;
  claudeCommandPath?: string;
  geminiCommandPath?: string;
  codexCommandPath?: string;
  antigravityCommandPath?: string;
}

export interface ProviderModelWorkspaceOverride {
  contextLength?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  supportsSystemPrompt?: boolean;
  supportsVision?: boolean;
}
