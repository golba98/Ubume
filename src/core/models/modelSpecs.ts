import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { MODEL_SPECS_FILE, LEGACY_MODEL_SPECS_FILE } from "../../config/settings.js";

export type ModelSpecStatus = "verified" | "loading" | "unknown";

export interface VerifiedModelSpec {
  status: "verified";
  contextWindow: number;
  maxOutputTokens: number;
  sourceUrl: string;
  verifiedAt: number;
  isEstimated?: boolean;
}

export interface PendingModelSpec {
  status: "loading" | "unknown";
  contextWindow: null;
  maxOutputTokens: null;
  sourceUrl: string;
  verifiedAt: null;
  error: string | null;
}

export type ModelSpec = VerifiedModelSpec | PendingModelSpec;

export const MODEL_SPEC_DOC_URLS: Record<string, string> = {
  "gpt-5.4": "https://developers.openai.com/api/docs/models/gpt-5.4",
  "gpt-5.4-mini": "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
  "gpt-5.3-codex": "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  "gpt-5.2": "https://developers.openai.com/api/docs/models/gpt-5.2",
};

// Legacy model spec registry. Context-window display now goes through
// providerRuntime/contextMetadata.ts so values are source-aware and provider
// scoped. Keep this empty to avoid showing broad or guessed model limits.
export interface KnownModelSpec {
  contextWindow: number;
  maxOutputTokens: number;
}

export const KNOWN_MODEL_SPECS: Record<string, KnownModelSpec> = {};

type ModelSpecCache = Partial<Record<string, VerifiedModelSpec>>;

interface ModelSpecServiceOptions {
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function createPendingModelSpec(
  model: string,
  status: PendingModelSpec["status"],
  error: string | null = null,
): PendingModelSpec {
  return {
    status,
    contextWindow: null,
    maxOutputTokens: null,
    sourceUrl: getModelSpecDocUrl(model),
    verifiedAt: null,
    error,
  };
}

function getModelSpecDocUrl(model: string): string {
  return MODEL_SPEC_DOC_URLS[model] ?? `https://developers.openai.com/api/docs/models/${encodeURIComponent(model)}`;
}

export function createLoadingModelSpec(model: string): ModelSpec {
  return createPendingModelSpec(model, "loading");
}

export function createUnknownModelSpec(model: string, error: string | null = null): ModelSpec {
  return createPendingModelSpec(model, "unknown", error);
}

export function parseTokenCount(rawValue: string): number | null {
  const normalized = rawValue.trim().replace(/\s+/g, "").toLowerCase();
  if (!normalized) return null;

  const suffix = normalized.endsWith("m")
    ? 1_000_000
    : normalized.endsWith("k")
      ? 1_000
      : 1;
  const numericText = suffix === 1 ? normalized : normalized.slice(0, -1);
  const numeric = Number.parseFloat(numericText.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;

  return Math.round(numeric * suffix);
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractModelSpecFromDocText(
  model: string,
  text: string,
  verifiedAt = Date.now(),
): VerifiedModelSpec | null {
  const normalized = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const contextMatch = normalized.match(/(\d[\d,.]*(?:\s*[mk])?)\s+context\s+window/i);
  const maxOutputMatch = normalized.match(/(\d[\d,.]*(?:\s*[mk])?)\s+max\s+output\s+tokens/i);

  const contextWindow = contextMatch ? parseTokenCount(contextMatch[1] ?? "") : null;
  const maxOutputTokens = maxOutputMatch ? parseTokenCount(maxOutputMatch[1] ?? "") : null;
  if (!contextWindow || !maxOutputTokens) {
    return null;
  }

  return {
    status: "verified",
    contextWindow,
    maxOutputTokens,
    sourceUrl: getModelSpecDocUrl(model),
    verifiedAt,
  };
}

function isVerifiedModelSpec(value: unknown): value is VerifiedModelSpec {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<VerifiedModelSpec>;
  return candidate.status === "verified"
    && typeof candidate.contextWindow === "number"
    && Number.isFinite(candidate.contextWindow)
    && typeof candidate.maxOutputTokens === "number"
    && Number.isFinite(candidate.maxOutputTokens)
    && typeof candidate.sourceUrl === "string"
    && typeof candidate.verifiedAt === "number"
    && Number.isFinite(candidate.verifiedAt);
}

export function loadModelSpecCache(cacheFile = MODEL_SPECS_FILE): ModelSpecCache {
  if (cacheFile === MODEL_SPECS_FILE && !existsSync(MODEL_SPECS_FILE) && existsSync(LEGACY_MODEL_SPECS_FILE)) {
    cacheFile = LEGACY_MODEL_SPECS_FILE;
  }
  try {
    const raw = JSON.parse(readFileSync(cacheFile, "utf-8")) as Record<string, unknown>;
    const cache: ModelSpecCache = {};

    for (const [model, value] of Object.entries(raw)) {
      if (isVerifiedModelSpec(value)) {
        cache[model] = value;
      }
    }

    return cache;
  } catch {
    return {};
  }
}

export function saveModelSpecCache(cache: ModelSpecCache, cacheFile = MODEL_SPECS_FILE): void {
  try {
    const tmpFile = `${cacheFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tmpFile, cacheFile);
  } catch {
    // Best-effort cache only.
  }
}

export async function fetchModelSpecFromDocs(
  model: string,
  fetchImpl: typeof fetch = fetch,
  verifiedAt = Date.now(),
): Promise<VerifiedModelSpec> {
  const response = await fetchImpl(getModelSpecDocUrl(model), {
    headers: {
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Spec request failed with ${response.status}`);
  }

  const html = await response.text();
  const parsed = extractModelSpecFromDocText(model, stripHtmlToText(html), verifiedAt);
  if (!parsed) {
    throw new Error(`Unable to parse model spec for ${model}`);
  }

  return parsed;
}

export interface ResolveModelSpecOptions {
  // Persisted verified cache (loaded synchronously at startup).
  cache?: Partial<Record<string, VerifiedModelSpec>>;
  // Runtime discovery contextWindow if/when Codex starts providing it.
  runtimeContextWindow?: number | null;
  runtimeMaxOutputTokens?: number | null;
  // Set true when a background refresh is in progress and no other source
  // has produced verified numbers — lets callers render a "loading" state
  // instead of "unknown".
  refreshInFlight?: boolean;
  now?: () => number;
}

// Single authoritative resolver. Precedence:
//   1. Runtime discovery metadata (if contextWindow is provided)
//   2. Persistent spec cache (~/.ubume-model-specs.json)
//   3. Trusted static registry (KNOWN_MODEL_SPECS)
//   4. Loading (if a background refresh is in-flight)
//   5. Unknown
export function resolveModelSpec(model: string, options: ResolveModelSpecOptions = {}): ModelSpec {
  const now = options.now?.() ?? Date.now();

  const runtimeCtx = options.runtimeContextWindow;
  const runtimeMax = options.runtimeMaxOutputTokens;
  if (
    typeof runtimeCtx === "number" && Number.isFinite(runtimeCtx) && runtimeCtx > 0
    && typeof runtimeMax === "number" && Number.isFinite(runtimeMax) && runtimeMax > 0
  ) {
    return {
      status: "verified",
      contextWindow: runtimeCtx,
      maxOutputTokens: runtimeMax,
      sourceUrl: getModelSpecDocUrl(model),
      verifiedAt: now,
    };
  }

  const cached = options.cache?.[model];
  if (cached && cached.status === "verified") {
    return cached;
  }

  const known = KNOWN_MODEL_SPECS[model];
  if (known) {
    return {
      status: "verified",
      contextWindow: known.contextWindow,
      maxOutputTokens: known.maxOutputTokens,
      sourceUrl: getModelSpecDocUrl(model),
      verifiedAt: now,
    };
  }

  if (options.refreshInFlight) {
    return createLoadingModelSpec(model);
  }

  return createUnknownModelSpec(model);
}

export function areModelSpecsEqual(left: ModelSpec | undefined, right: ModelSpec): boolean {
  if (!left) return false;
  if (left.status !== right.status) return false;

  return left.contextWindow === right.contextWindow
    && left.maxOutputTokens === right.maxOutputTokens
    && left.sourceUrl === right.sourceUrl
    && left.verifiedAt === right.verifiedAt
    && ("error" in left ? left.error : null) === ("error" in right ? right.error : null);
}

export function createModelSpecService(options: ModelSpecServiceOptions = {}) {
  const cacheFile = options.cacheFile ?? MODEL_SPECS_FILE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  // Persisted specs are kept for saving, not for live UI trust.
  const cache = loadModelSpecCache(cacheFile);
  const inflight = new Map<string, Promise<ModelSpec>>();

  return {
    async refreshSpec(model: string): Promise<ModelSpec> {
      const current = inflight.get(model);
      if (current) return current;

      const refreshPromise = (async () => {
        try {
          const verified = await fetchModelSpecFromDocs(model, fetchImpl, now());
          cache[model] = verified;
          saveModelSpecCache(cache, cacheFile);
          return verified;
        } catch (error) {
          return createUnknownModelSpec(
            model,
            error instanceof Error ? error.message : "Unknown model spec failure",
          );
        } finally {
          inflight.delete(model);
        }
      })();

      inflight.set(model, refreshPromise);
      return refreshPromise;
    },
  };
}
