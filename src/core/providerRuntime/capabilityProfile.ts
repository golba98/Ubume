import type { ProviderId, ProviderWorkspaceOverride } from "../providerLauncher/types.js";

export type CapabilitySource = "api" | "cli" | "config" | "detected-family" | "known-registry" | "unknown";
export type CapabilityConfidence = "verified" | "configured" | "detected" | "known" | "unknown";
export type LocalModelFamily = "deepseek";

export interface ModelCapabilityProfile {
  providerId: ProviderId;
  modelId: string;
  family: LocalModelFamily | null;
  maxOutputTokens: number | null;
  supportsStreaming: boolean | null;
  supportsToolCalls: boolean | null;
  supportsSystemPrompt: boolean | null;
  supportsVision: boolean | null;
  source: CapabilitySource;
  confidence: CapabilityConfidence;
  raw?: unknown;
  error?: string;
}

export interface ResolveModelCapabilityProfileOptions {
  providerId: ProviderId;
  modelId: string;
  providerConfig?: ProviderWorkspaceOverride | null;
  rawMetadata?: unknown;
}

interface KnownCapabilityRegistryEntry {
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  supportsSystemPrompt?: boolean;
  supportsVision?: boolean;
}

// Empty by default — only exact "providerId:modelId" matches are allowed.
// Do NOT add wildcard or family-based entries.
const KNOWN_CAPABILITY_REGISTRY: Record<string, KnownCapabilityRegistryEntry> = {};

const SYSTEM_PROMPT_CANDIDATES = [
  "supports_system_prompt",
  "supportsSystemPrompt",
  "system_prompt",
  "has_system_prompt",
] as const;

const STREAMING_CANDIDATES = [
  "supports_streaming",
  "supportsStreaming",
  "streaming",
  "stream_supported",
] as const;

const TOOL_CALLS_CANDIDATES = [
  "supports_tool_calls",
  "supportsToolCalls",
  "tool_calls",
  "supports_tools",
  "function_calling",
  "has_tools",
] as const;

const MAX_OUTPUT_TOKENS_CANDIDATES = [
  "max_output_tokens",
  "maxOutputTokens",
  "max_new_tokens",
  "max_tokens_output",
] as const;

const NESTED_METADATA_KEYS = [
  "model_info",
  "modelInfo",
  "metadata",
  "details",
  "config",
] as const;

const MODEL_IDENTITY_FIELDS = [
  "id",
  "name",
  "model",
  "model_id",
  "modelId",
  "display_name",
  "displayName",
  "repository",
  "repo",
  "path",
  "publisher",
] as const;

const capabilityCache = new Map<string, ModelCapabilityProfile>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function validPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function cacheKey(options: ResolveModelCapabilityProfileOptions): string {
  return JSON.stringify({
    providerId: options.providerId,
    modelId: options.modelId,
    models: options.providerConfig?.models ?? null,
  });
}

function deepSeekIdentity(value: string): boolean {
  return /(^|[^a-z0-9])deep[\s_\-./:]*seek(?=$|[^a-z0-9])/i.test(value);
}

function metadataIdentityValues(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const values: string[] = [];
  for (const field of MODEL_IDENTITY_FIELDS) {
    if (typeof raw[field] === "string") values.push(raw[field]);
  }
  for (const nestedKey of NESTED_METADATA_KEYS) {
    const nested = raw[nestedKey];
    if (!isRecord(nested)) continue;
    for (const field of MODEL_IDENTITY_FIELDS) {
      if (typeof nested[field] === "string") values.push(nested[field]);
    }
  }
  return values;
}

export function detectLocalModelFamily(modelId: string, rawMetadata?: unknown): LocalModelFamily | null {
  return [modelId, ...metadataIdentityValues(rawMetadata)].some(deepSeekIdentity)
    ? "deepseek"
    : null;
}

export function clearModelCapabilityProfileCache(): void {
  capabilityCache.clear();
}

function unknownProfile(
  providerId: ProviderId,
  modelId: string,
  error?: string,
): ModelCapabilityProfile {
  return {
    providerId,
    modelId,
    family: null,
    maxOutputTokens: null,
    supportsStreaming: null,
    supportsToolCalls: null,
    supportsSystemPrompt: null,
    supportsVision: null,
    source: "unknown",
    confidence: "unknown",
    ...(error ? { error } : {}),
  };
}

function findBooleanField(
  raw: Record<string, unknown>,
  candidates: readonly string[],
): boolean | null {
  for (const field of candidates) {
    const value = validBoolean(raw[field]);
    if (value !== null) return value;
  }
  for (const nestedKey of NESTED_METADATA_KEYS) {
    const nested = raw[nestedKey];
    if (!isRecord(nested)) continue;
    for (const field of candidates) {
      const value = validBoolean(nested[field]);
      if (value !== null) return value;
    }
  }
  return null;
}

function findIntegerField(
  raw: Record<string, unknown>,
  candidates: readonly string[],
): number | null {
  for (const field of candidates) {
    const value = validPositiveInteger(raw[field]);
    if (value !== null) return value;
  }
  for (const nestedKey of NESTED_METADATA_KEYS) {
    const nested = raw[nestedKey];
    if (!isRecord(nested)) continue;
    for (const field of candidates) {
      const value = validPositiveInteger(nested[field]);
      if (value !== null) return value;
    }
  }
  return null;
}

function resolveFromRawMetadata(
  providerId: ProviderId,
  modelId: string,
  raw: unknown,
): ModelCapabilityProfile | null {
  if (providerId !== "local") return null;
  if (!isRecord(raw)) return null;

  const supportsSystemPrompt = findBooleanField(raw, SYSTEM_PROMPT_CANDIDATES);
  const supportsStreaming = findBooleanField(raw, STREAMING_CANDIDATES);
  let supportsToolCalls = findBooleanField(raw, TOOL_CALLS_CANDIDATES);
  const maxOutputTokens = findIntegerField(raw, MAX_OUTPUT_TOKENS_CANDIDATES);

  if (supportsToolCalls === null && Array.isArray(raw.capabilities)) {
    if ((raw.capabilities as unknown[]).includes("tool_use")) {
      supportsToolCalls = true;
    }
    // absence of "tool_use" in capabilities ≠ not supported — leave null
  }

  if (
    supportsSystemPrompt === null
    && supportsStreaming === null
    && supportsToolCalls === null
    && maxOutputTokens === null
  ) {
    return null;
  }

  return {
    providerId,
    modelId,
    family: null,
    maxOutputTokens,
    supportsStreaming,
    supportsToolCalls,
    supportsSystemPrompt,
    supportsVision: null,
    source: "api",
    confidence: "verified",
    raw,
  };
}

function resolveFromConfig(
  providerId: ProviderId,
  modelId: string,
  providerConfig?: ProviderWorkspaceOverride | null,
): ModelCapabilityProfile | null {
  const modelOverride = providerConfig?.models?.[modelId];
  if (!modelOverride) return null;

  const supportsStreaming = validBoolean(modelOverride.supportsStreaming);
  const supportsToolCalls = validBoolean(modelOverride.supportsToolCalls);
  const supportsSystemPrompt = validBoolean(modelOverride.supportsSystemPrompt);
  const maxOutputTokens = validPositiveInteger(modelOverride.maxOutputTokens);

  const hasAny =
    supportsSystemPrompt !== null
    || supportsStreaming !== null
    || supportsToolCalls !== null
    || maxOutputTokens !== null;

  if (!hasAny) return null;

  return {
    providerId,
    modelId,
    family: null,
    maxOutputTokens,
    supportsStreaming,
    supportsToolCalls,
    supportsSystemPrompt,
    supportsVision: validBoolean(modelOverride.supportsVision),
    source: "config",
    confidence: "configured",
  };
}

function resolveFromKnownRegistry(
  providerId: ProviderId,
  modelId: string,
): ModelCapabilityProfile | null {
  const entry = KNOWN_CAPABILITY_REGISTRY[`${providerId}:${modelId}`];
  if (!entry) return null;
  return {
    providerId,
    modelId,
    family: null,
    maxOutputTokens: entry.maxOutputTokens ?? null,
    supportsStreaming: entry.supportsStreaming ?? null,
    supportsToolCalls: entry.supportsToolCalls ?? null,
    supportsSystemPrompt: entry.supportsSystemPrompt ?? null,
    supportsVision: entry.supportsVision ?? null,
    source: "known-registry",
    confidence: "known",
  };
}

function resolveFromDetectedFamily(
  providerId: ProviderId,
  modelId: string,
  rawMetadata?: unknown,
): ModelCapabilityProfile | null {
  if (providerId !== "local") return null;
  const family = detectLocalModelFamily(modelId, rawMetadata);
  if (family !== "deepseek") return null;
  return {
    providerId,
    modelId,
    family,
    maxOutputTokens: null,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsSystemPrompt: null,
    supportsVision: null,
    source: "detected-family",
    confidence: "detected",
  };
}

function mergeProfiles(options: {
  providerId: ProviderId;
  modelId: string;
  rawMetadata?: unknown;
  profiles: readonly (ModelCapabilityProfile | null)[];
}): ModelCapabilityProfile {
  const profiles = options.profiles.filter((profile): profile is ModelCapabilityProfile => profile !== null);
  const first = profiles[0];
  const family = detectLocalModelFamily(options.modelId, options.rawMetadata)
    ?? profiles.find((profile) => profile.family)?.family
    ?? null;
  const value = <K extends keyof Pick<ModelCapabilityProfile,
    "maxOutputTokens" | "supportsStreaming" | "supportsToolCalls" | "supportsSystemPrompt" | "supportsVision"
  >>(field: K): ModelCapabilityProfile[K] => {
    for (const profile of profiles) {
      if (profile[field] !== null) return profile[field];
    }
    return null as ModelCapabilityProfile[K];
  };

  if (!first && !family) return unknownProfile(options.providerId, options.modelId);
  return {
    providerId: options.providerId,
    modelId: options.modelId,
    family,
    maxOutputTokens: value("maxOutputTokens"),
    supportsStreaming: value("supportsStreaming"),
    supportsToolCalls: value("supportsToolCalls"),
    supportsSystemPrompt: value("supportsSystemPrompt"),
    supportsVision: value("supportsVision"),
    source: first?.source ?? "unknown",
    confidence: first?.confidence ?? "unknown",
    ...(options.rawMetadata !== undefined ? { raw: options.rawMetadata } : {}),
  };
}

export function resolveModelCapabilityProfileCached(
  options: ResolveModelCapabilityProfileOptions,
): ModelCapabilityProfile {
  const key = cacheKey(options);
  const cached = capabilityCache.get(key);
  if (cached && options.rawMetadata === undefined) {
    return cached;
  }

  const raw = resolveFromRawMetadata(options.providerId, options.modelId, options.rawMetadata);
  const config = resolveFromConfig(options.providerId, options.modelId, options.providerConfig);
  const detected = resolveFromDetectedFamily(options.providerId, options.modelId, options.rawMetadata);
  const registry = resolveFromKnownRegistry(options.providerId, options.modelId);
  const result = mergeProfiles({
    providerId: options.providerId,
    modelId: options.modelId,
    rawMetadata: options.rawMetadata,
    profiles: [raw, config, detected, registry],
  });
  capabilityCache.set(key, result);
  return result;
}
