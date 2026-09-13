import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatReasoningLabel } from "../../config/settings.js";
import type { ProviderModel } from "../providerRuntime/types.js";
import type {
  CodexModelCapabilities,
  CodexModelCapability,
  ReasoningEffortCapability,
} from "./codexModelCapabilities.js";
import { loadCachedProviderModels, type CachedProviderModels } from "./providerModelCache.js";

// The codex CLI maintains its own model catalog cache with slugs, labels and
// reasoning levels. Reading it seeds Ubume's OpenAI model list instantly —
// no subprocess — and stays current because the codex CLI refreshes the file
// on its own runs.
// Resolved per call from env (matching claudeCodeDiscovery) so HOME
// redirection in tests holds — Bun's homedir() ignores runtime HOME changes.
export function getCodexModelsCacheFile(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".codex", "models_cache.json");
}

interface CodexSeed {
  fetchedAt: number;
  models: readonly ProviderModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseReasoningLevels(raw: unknown): readonly ReasoningEffortCapability[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const levels = raw
    .map((entry): ReasoningEffortCapability | null => {
      if (!isRecord(entry)) {
        return null;
      }
      const id = asString(entry.effort);
      if (!id) {
        return null;
      }
      return { id, label: formatReasoningLabel(id), description: asString(entry.description) };
    })
    .filter((entry): entry is ReasoningEffortCapability => entry !== null);
  return levels.length > 0 ? levels : null;
}

function parseSeedModel(raw: unknown): ProviderModel | null {
  if (!isRecord(raw)) {
    return null;
  }
  // Models with visibility "hide" are internal codex routes (e.g. auto-review).
  if (asString(raw.visibility) === "hide") {
    return null;
  }
  const modelId = asString(raw.slug);
  if (!modelId) {
    return null;
  }
  return {
    id: modelId,
    modelId,
    label: asString(raw.display_name) ?? modelId,
    description: asString(raw.description),
    defaultReasoningLevel: asString(raw.default_reasoning_level),
    supportedReasoningLevels: parseReasoningLevels(raw.supported_reasoning_levels),
    source: "discovered",
  };
}

export function loadCodexSeedModels(cacheFile = getCodexModelsCacheFile()): CodexSeed | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return null;
    }
    const models = parsed.models
      .map(parseSeedModel)
      .filter((model): model is ProviderModel => model !== null);
    if (models.length === 0) {
      return null;
    }
    const fetchedAtRaw = asString(parsed.fetched_at);
    const fetchedAt = fetchedAtRaw ? Date.parse(fetchedAtRaw) : Number.NaN;
    return { fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0, models };
  } catch {
    return null;
  }
}

// Freshest locally known OpenAI models without spawning a subprocess:
// codex's own cache file vs Ubume's persisted last-good discovery.
export function loadSeededOpenAiModels(options: {
  codexCacheFile?: string;
  providerCacheFile?: string;
} = {}): CachedProviderModels | null {
  const seed = loadCodexSeedModels(options.codexCacheFile);
  const persisted = options.providerCacheFile === undefined
    ? loadCachedProviderModels("openai")
    : loadCachedProviderModels("openai", options.providerCacheFile);
  if (seed && (!persisted || seed.fetchedAt >= persisted.discoveredAt)) {
    return { discoveredAt: seed.fetchedAt, models: seed.models };
  }
  return persisted;
}

function toCapability(model: ProviderModel, index: number): CodexModelCapability {
  return {
    id: model.id,
    model: model.modelId,
    label: model.label,
    description: model.description,
    available: true,
    hidden: false,
    isDefault: index === 0,
    defaultReasoningLevel: model.defaultReasoningLevel,
    supportedReasoningLevels: model.supportedReasoningLevels,
    reasoningLevelCount: model.supportedReasoningLevels ? model.supportedReasoningLevels.length : null,
    source: "runtime",
    raw: model,
  };
}

// Capabilities for the OpenAI picker sourced purely from local caches.
// Returns null when nothing is cached yet (first ever launch).
export function loadSeededCodexCapabilities(options: {
  codexCacheFile?: string;
  providerCacheFile?: string;
} = {}): CodexModelCapabilities | null {
  const seeded = loadSeededOpenAiModels(options);
  if (!seeded) {
    return null;
  }
  return {
    status: "ready",
    source: "runtime",
    models: seeded.models.map(toCapability),
    discoveredAt: seeded.discoveredAt,
    executable: null,
    error: null,
  };
}
