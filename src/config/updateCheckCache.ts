import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface UpdateCheckCache {
  lastChecked: number;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

// Resolved per call (not at module load) so HOME changes — e.g. test isolation —
// are honored. See the same pattern in src/core/models/providerModelCache.ts.
export function getUpdateCheckCacheFilePath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".ubume-update-check.json");
}

export function getLegacyUpdateCheckCacheFilePath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".ubume-update-check.json");
}

export function loadUpdateCheckCache(filePath = getUpdateCheckCacheFilePath()): UpdateCheckCache | null {
  try {
    let resolvedPath = filePath;
    if (!existsSync(resolvedPath) && filePath === getUpdateCheckCacheFilePath()) {
      const legacyPath = getLegacyUpdateCheckCacheFilePath();
      if (existsSync(legacyPath)) {
        resolvedPath = legacyPath;
      }
    }
    const text = readFileSync(resolvedPath, "utf-8");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.lastChecked !== "number") return null;
    if (typeof data.currentVersion !== "string") return null;
    return {
      lastChecked: data.lastChecked,
      currentVersion: data.currentVersion,
      latestVersion: typeof data.latestVersion === "string" ? data.latestVersion : null,
      updateAvailable: data.updateAvailable === true,
    };
  } catch {
    return null;
  }
}

export function saveUpdateCheckCache(cache: UpdateCheckCache, filePath = getUpdateCheckCacheFilePath()): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
    // Best-effort — never crash on cache write failure.
  }
}

function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/** Returns true when a cache entry was created by the running Ubume version. */
export function isCacheForRunningVersion(cache: UpdateCheckCache, runningVersion: string): boolean {
  return stripV(cache.currentVersion) === stripV(runningVersion);
}

/**
 * Returns true only when the cache is still usable:
 * - `runningVersion` matches the version the cache was written for (version-mismatch = stale)
 * - The cache was written within `intervalHours`
 */
export function isCacheValid(
  cache: UpdateCheckCache,
  intervalHours: number,
  runningVersion?: string,
): boolean {
  if (runningVersion !== undefined) {
    if (!isCacheForRunningVersion(cache, runningVersion)) {
      return false;
    }
  }
  const maxAgeMs = intervalHours * 60 * 60 * 1000;
  return Date.now() - cache.lastChecked < maxAgeMs;
}
