import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../providerLauncher/types.js";
import type { ProviderModel } from "../providerRuntime/types.js";

// Persistent last-good model discovery results, one entry per provider.
// Lets pickers open instantly with the previous session's discovered models
// while a background refresh runs. Corrupt or missing cache degrades to null.
// Resolved per call from env (matching claudeCodeDiscovery) so HOME
// redirection in tests holds — Bun's homedir() ignores runtime HOME changes.
export function getProviderModelCacheFile(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  const ubumePath = join(home, ".ubume-model-cache.json");
  if (existsSync(ubumePath)) return ubumePath;
  const legacyPath = join(home, ".codexa-model-cache.json");
  if (existsSync(legacyPath)) return legacyPath;
  return ubumePath;
}

const CACHE_VERSION = 1;

export interface CachedProviderModels {
  discoveredAt: number;
  models: readonly ProviderModel[];
}

interface ProviderModelCacheFile {
  version: number;
  providers: Partial<Record<ProviderId, CachedProviderModels>>;
}

function readCacheFile(cacheFile: string): ProviderModelCacheFile | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || (parsed as ProviderModelCacheFile).version !== CACHE_VERSION
      || typeof (parsed as ProviderModelCacheFile).providers !== "object"
      || (parsed as ProviderModelCacheFile).providers === null
    ) {
      return null;
    }
    return parsed as ProviderModelCacheFile;
  } catch {
    return null;
  }
}

function isValidEntry(entry: unknown): entry is CachedProviderModels {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as CachedProviderModels;
  return typeof candidate.discoveredAt === "number"
    && Array.isArray(candidate.models)
    && candidate.models.every((model) =>
      typeof model === "object" && model !== null
      && typeof model.id === "string"
      && typeof model.modelId === "string"
      && typeof model.label === "string");
}

export function loadCachedProviderModels(
  providerId: ProviderId,
  cacheFile = getProviderModelCacheFile(),
): CachedProviderModels | null {
  const cache = readCacheFile(cacheFile);
  const entry = cache?.providers?.[providerId];
  if (!entry || !isValidEntry(entry) || entry.models.length === 0) {
    return null;
  }
  return entry;
}

export function saveCachedProviderModels(
  providerId: ProviderId,
  entry: CachedProviderModels,
  cacheFile = getProviderModelCacheFile(),
): void {
  if (entry.models.length === 0) {
    return;
  }
  try {
    const cache = readCacheFile(cacheFile) ?? { version: CACHE_VERSION, providers: {} };
    cache.providers[providerId] = entry;
    writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort; discovery still works without it.
  }
}
