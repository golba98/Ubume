import type { ReasoningEffortCapability } from "../models/codexModelCapabilities.js";
import type { ProjectInstructions } from "../workspace/projectInstructions.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
export type { ResolvedRuntimeConfig };
import type { LocalBackendId, ProviderId } from "../providerLauncher/types.js";
import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import type { ConversationContextCheckpoint, ConversationMessage, LocalHarnessSessionMetadata } from "../workspace/conversationStore.js";

export type ProviderBackendKind =
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

export interface ProviderModel {
  id: string;
  modelId: string;
  label: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: readonly ReasoningEffortCapability[] | null;
  source?: "discovered" | "claude-code" | "claude-code-command" | "claude-code-package" | "claude-code-cache" | "claude-code-config" | "settings" | "config" | "fallback";
  canonicalId?: string;
  family?: string;
  version?: string;
  isFallback?: boolean;
  discoveryKind?: "models" | "aliases";
  effortSource?: "claude-code" | "claude-code-command" | "claude-code-package" | "claude-code-cache" | "claude-code-config" | "settings" | "config" | "fallback";
  effortVerified?: boolean;
  raw?: unknown;
}

export interface ProviderModelDiscoveryResult {
  status: "ready" | "not-configured";
  providerId: ProviderId;
  backendKind: ProviderBackendKind;
  models: readonly ProviderModel[];
  message?: string;
  diagnostics?: Record<string, string | number | boolean | null>;
  localBackend?: LocalBackendId;
}

export type GeminiModelFamily = "gemini-3" | "gemini-2.5";

export type GeminiModelSelection =
  | { kind: "auto"; family: GeminiModelFamily }
  | { kind: "manual"; modelId: string };

export interface ProviderRoute {
  providerId: ProviderId;
  modelId: string;
  backendKind: ProviderBackendKind;
  reasoning?: string;
  modelSelection?: GeminiModelSelection;
  localBackend?: LocalBackendId;
}

export type ActiveProviderRoute = ProviderRoute;

/** Ephemeral, request-scoped Local connection. Secrets are never persisted. */
export interface ResolvedLocalAgentConfig {
  localBackend: LocalBackendId;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  supportsStreaming: boolean | null;
  supportsToolCalls: boolean | null;
  supportsSystemPrompt: boolean | null;
  supportsVision: boolean;
}

export interface ProviderRouteValidationRequest {
  route: ProviderRoute;
  workspaceRoot: string;
  geminiCommandPath?: string | null;
  claudeCommandPath?: string | null;
  antigravityCommandPath?: string | null;
  localConfig?: ProviderWorkspaceOverride | null;
  localBackend?: LocalBackendId;
}

export interface ProviderRouteValidationResult {
  status: "ready" | "not-configured";
  providerId: ProviderId;
  backendKind: ProviderBackendKind;
  message?: string;
  diagnostics?: Record<string, string | number | boolean | null>;
}

export interface ProviderChatRequest {
  prompt: string;
  imageAttachments?: readonly ProviderImageAttachment[];
  route: ProviderRoute;
  runtime: ResolvedRuntimeConfig;
  workspaceRoot: string;
  projectInstructions?: ProjectInstructions | null;
  localConfig?: ProviderWorkspaceOverride | null;
  resolvedLocalAgentConfig?: ResolvedLocalAgentConfig;
  runIntent?: "normal" | "plan" | "approved-execution";
  conversationHistory?: readonly ConversationMessage[];
  localContextCheckpoint?: ConversationContextCheckpoint;
  localHarnessSession?: LocalHarnessSessionMetadata;
}

export interface ProviderImageAttachment {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string;
  bytes: number;
}

export interface ProviderChatResponse {
  text: string;
  rawOutput?: string;
}

export interface ProviderRuntime {
  providerId: ProviderId;
  label: string;
  modelPickerLabel?: string;
  backendKind: ProviderBackendKind;
  routeAvailable: boolean;
  routeStatus: string;
  routeSetupMessage?: string;
  launchAvailable: boolean;
  isRouteConfigured?: () => boolean;
  validateRoute?: (request: ProviderRouteValidationRequest) => Promise<ProviderRouteValidationResult>;
  discoverModels: () => ProviderModelDiscoveryResult;
  refreshModels?: (options: { cwd: string; localConfig?: ProviderWorkspaceOverride | null; localBackend?: LocalBackendId }) => Promise<ProviderModelDiscoveryResult>;
  run?: (request: ProviderChatRequest, handlers: BackendRunHandlers) => () => void;
}
