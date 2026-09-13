import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getLegacyCodexaTrustStoreFile, getUbumeTrustStoreFile } from "./settings.js";
import { normalizeWorkspaceRoot } from "../core/workspace/workspaceRoot.js";

interface TrustStoreData {
  trustedProjectRoots: string[];
}

function getDefaultTrustStore(): TrustStoreData {
  return { trustedProjectRoots: [] };
}

function parseTrustStoreData(data: unknown): TrustStoreData {
  if (!data || typeof data !== "object") {
    return getDefaultTrustStore();
  }

  const record = data as Record<string, unknown>;
  const trustedProjectRoots = Array.isArray(record.trustedProjectRoots)
    ? record.trustedProjectRoots
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => normalizeWorkspaceRoot(value))
    : [];

  return {
    trustedProjectRoots: Array.from(new Set(trustedProjectRoots)),
  };
}

function loadTrustStore(): TrustStoreData {
  try {
    const ubumeFile = getUbumeTrustStoreFile();
    const legacyFile = getLegacyCodexaTrustStoreFile();

    let text = "";
    if (existsSync(ubumeFile)) {
      text = readFileSync(ubumeFile, "utf-8");
    } else if (existsSync(legacyFile)) {
      text = readFileSync(legacyFile, "utf-8");
      try {
        const parsed = parseTrustStoreData(JSON.parse(text));
        saveTrustStore(parsed);
      } catch {
        // Non-destructive best-effort migration
      }
    } else {
      return getDefaultTrustStore();
    }

    return parseTrustStoreData(JSON.parse(text));
  } catch {
    // Best-effort persistence; corrupt or missing file silently resets to empty.
    return getDefaultTrustStore();
  }
}

function saveTrustStore(data: TrustStoreData): void {
  try {
    const trustStoreFile = getUbumeTrustStoreFile();
    mkdirSync(dirname(trustStoreFile), { recursive: true });
    const tmpFile = `${trustStoreFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpFile, trustStoreFile);
  } catch {
    // Best-effort persistence only.
  }
}

export function isProjectTrusted(projectRoot: string): boolean {
  const normalizedRoot = normalizeWorkspaceRoot(projectRoot);
  const store = loadTrustStore();
  return store.trustedProjectRoots.includes(normalizedRoot);
}

export function setProjectTrust(projectRoot: string, trusted: boolean): void {
  const normalizedRoot = normalizeWorkspaceRoot(projectRoot);
  const store = loadTrustStore();
  const nextRoots = trusted
    ? Array.from(new Set([...store.trustedProjectRoots, normalizedRoot]))
    : store.trustedProjectRoots.filter((value) => value !== normalizedRoot);

  saveTrustStore({ trustedProjectRoots: nextRoots });
}
