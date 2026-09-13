import { type ChildProcess } from "child_process";
import { APP_NAME, APP_VERSION, DEFAULT_MODEL, LEGACY_FALLBACK_MODELS, formatReasoningLabel } from "../../config/settings.js";
import { resolveCodexExecutable, spawnCodexProcess } from "../executables/codexExecutable.js";
import { loadSeededCodexCapabilities } from "./codexModelsCacheSeed.js";
import { saveCachedProviderModels } from "./providerModelCache.js";
import type { ProviderModel } from "../providerRuntime/types.js";

export type ModelCapabilitySource = "runtime" | "fallback";
export type ModelCapabilityStatus = "ready" | "fallback";

export interface ReasoningEffortCapability {
  id: string;
  label: string;
  description: string | null;
}

export interface CodexModelCapability {
  id: string;
  model: string;
  label: string;
  description: string | null;
  available: boolean;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: readonly ReasoningEffortCapability[] | null;
  reasoningLevelCount: number | null;
  source: ModelCapabilitySource;
  raw: unknown;
}

export interface CodexModelCapabilities {
  status: ModelCapabilityStatus;
  source: ModelCapabilitySource;
  models: readonly CodexModelCapability[];
  discoveredAt: number;
  executable: string | null;
  error: string | null;
}

export interface DiscoverCodexModelCapabilitiesOptions {
  executable?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  now?: () => number;
}

export interface GetCodexModelCapabilitiesOptions extends DiscoverCodexModelCapabilitiesOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
  resolveExecutable?: typeof resolveCodexExecutable;
  discover?: typeof discoverCodexModelCapabilities;
  seed?: typeof loadSeededCodexCapabilities;
  persist?: typeof persistCodexModelCapabilities;
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
}

interface ModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

interface AppServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface CapabilityCacheEntry {
  expiresAt: number;
  promise: Promise<CodexModelCapabilities>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_LIMIT = 100;

const capabilityCache = new Map<string, CapabilityCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown model capability discovery error";
  }
}

function createReasoningEffortCapability(raw: unknown): ReasoningEffortCapability | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, label: formatReasoningLabel(id), description: null } : null;
  }

  if (!isRecord(raw)) {
    return null;
  }

  const id = normalizeString(raw.reasoningEffort ?? raw.reasoning_effort ?? raw.id);
  if (!id) {
    return null;
  }

  return {
    id,
    label: formatReasoningLabel(id),
    description: normalizeString(raw.description),
  };
}

function normalizeRuntimeModel(raw: unknown): CodexModelCapability | null {
  if (!isRecord(raw)) {
    return null;
  }

  // Accept both "model" and "id" fields — Codex runtime has used both across versions.
  const model = normalizeString(raw.model ?? raw.id);
  const id = normalizeString(raw.id ?? raw.model) ?? model;
  if (!model || !id) {
    return null;
  }

  // Accept both camelCase and snake_case reasoning effort fields.
  const rawReasoning = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
    : Array.isArray(raw.supported_reasoning_efforts)
      ? raw.supported_reasoning_efforts
      : null;
  const supportedReasoningLevels = rawReasoning
    ? rawReasoning.map(createReasoningEffortCapability).filter((item): item is ReasoningEffortCapability => Boolean(item))
    : null;
  const defaultReasoningLevel = normalizeString(raw.defaultReasoningEffort ?? raw.default_reasoning_effort);

  return {
    id,
    model,
    label: normalizeString(raw.displayName ?? raw.display_name) ?? model,
    description: normalizeString(raw.description),
    available: true,
    hidden: normalizeBoolean(raw.hidden),
    isDefault: normalizeBoolean(raw.isDefault ?? raw.is_default),
    defaultReasoningLevel,
    supportedReasoningLevels,
    reasoningLevelCount: supportedReasoningLevels ? supportedReasoningLevels.length : null,
    source: "runtime",
    raw,
  };
}

function dedupeModels(models: CodexModelCapability[]): CodexModelCapability[] {
  const seen = new Set<string>();
  const deduped: CodexModelCapability[] = [];

  for (const model of models) {
    const key = model.model.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(model);
  }

  return deduped;
}

export function normalizeCodexModelListResponses(
  responses: readonly ModelListResponse[],
  options: { discoveredAt?: number; executable?: string | null } = {},
): CodexModelCapabilities {
  const models = dedupeModels(
    responses.flatMap((response) => {
      const rawModels = Array.isArray(response.data) ? response.data : [];
      return rawModels
        .map(normalizeRuntimeModel)
        .filter((item): item is CodexModelCapability => Boolean(item));
    }),
  );

  if (models.length === 0) {
    throw new Error("Codex model discovery returned no usable models.");
  }

  return {
    status: "ready",
    source: "runtime",
    models,
    discoveredAt: options.discoveredAt ?? Date.now(),
    executable: options.executable ?? null,
    error: null,
  };
}

export function createFallbackModelCapabilities(
  error: unknown = null,
  options: { discoveredAt?: number; executable?: string | null } = {},
): CodexModelCapabilities {
  return {
    status: "fallback",
    source: "fallback",
    models: LEGACY_FALLBACK_MODELS.map((model) => ({
      id: model,
      model,
      label: model,
      description: null,
      available: false,
      hidden: false,
      isDefault: model === DEFAULT_MODEL,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      reasoningLevelCount: null,
      source: "fallback",
      raw: null,
    })),
    discoveredAt: options.discoveredAt ?? Date.now(),
    executable: options.executable ?? null,
    error: error ? getErrorMessage(error) : null,
  };
}

function writeJsonLine(proc: ChildProcess, message: AppServerRequest): void {
  proc.stdin?.write(`${JSON.stringify(message)}\n`);
}

function asModelListResponse(value: unknown): ModelListResponse {
  if (!isRecord(value)) {
    throw new Error("Codex model/list returned a non-object result.");
  }

  return {
    data: value.data,
    nextCursor: value.nextCursor ?? value.next_cursor, // accept both field name styles
  };
}

async function requestModelListFromAppServer(
  executable: string,
  options: Required<Pick<DiscoverCodexModelCapabilitiesOptions, "includeHidden" | "timeoutMs">>,
): Promise<ModelListResponse[]> {
  return new Promise<ModelListResponse[]>((resolve, reject) => {
    let proc: ReturnType<typeof spawnCodexProcess>;
    try {
      proc = spawnCodexProcess(executable, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let nextRequestId = 1;
    let activeModelListRequestId: number | null = null;
    const responses: ModelListResponse[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      if (!proc.killed) {
        try {
          proc.kill();
        } catch {
          // Best-effort shutdown.
        }
      }
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) => {
      finish(() => reject(error));
    };

    const requestModels = (cursor: string | null = null) => {
      const id = ++nextRequestId;
      activeModelListRequestId = id;
      writeJsonLine(proc, {
        id,
        method: "model/list",
        params: {
          includeHidden: options.includeHidden,
          limit: MODEL_LIST_LIMIT,
          cursor,
        },
      });
    };

    const handleResponse = (message: JsonRpcResponse) => {
      if (message.error) {
        fail(new Error(`Codex app-server request failed: ${getErrorMessage(message.error)}`));
        return;
      }

      if (message.id === 1) {
        requestModels();
        return;
      }

      if (message.id === activeModelListRequestId) {
        let response: ModelListResponse;
        try {
          response = asModelListResponse(message.result);
        } catch (error) {
          fail(error);
          return;
        }

        responses.push(response);
        const nextCursor = normalizeString(response.nextCursor);
        if (nextCursor) {
          requestModels(nextCursor);
          return;
        }

        finish(() => resolve(responses));
      }
    };

    const processStdout = (flush = false) => {
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          if (flush && stdoutBuffer.trim()) {
            const line = stdoutBuffer;
            stdoutBuffer = "";
            parseLine(line);
          }
          return;
        }

        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        parseLine(line);
      }
    };

    const parseLine = (line: string) => {
      if (!line.trim()) {
        return;
      }

      try {
        handleResponse(JSON.parse(line) as JsonRpcResponse);
      } catch (error) {
        fail(new Error(`Unable to parse Codex app-server response: ${getErrorMessage(error)}`));
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for Codex model discovery after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      processStdout(false);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (error) => {
      fail(error);
    });

    proc.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      processStdout(true);
      if (settled) {
        return;
      }
      const stderrSummary = stderr.trim() ? ` stderr: ${stderr.trim().slice(0, 300)}` : "";
      fail(new Error(`Codex app-server exited before model discovery completed (code ${exitCode}).${stderrSummary}`));
    });

    writeJsonLine(proc, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: APP_NAME.toLowerCase(),
          title: APP_NAME,
          version: APP_VERSION,
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });
  });
}

export async function discoverCodexModelCapabilities(
  options: DiscoverCodexModelCapabilitiesOptions = {},
): Promise<CodexModelCapabilities> {
  const executable = options.executable ?? await resolveCodexExecutable();
  const includeHidden = options.includeHidden ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const discoveredAt = options.now?.() ?? Date.now();
  const responses = await requestModelListFromAppServer(executable, { includeHidden, timeoutMs });

  return normalizeCodexModelListResponses(responses, {
    discoveredAt,
    executable,
  });
}

// Persist a successful live discovery so the next launch can seed the model
// picker without spawning the codex app-server. Best-effort by design.
export function persistCodexModelCapabilities(capabilities: CodexModelCapabilities): void {
  const models: ProviderModel[] = capabilities.models
    .filter((capability) => !capability.hidden)
    .map((capability) => ({
      id: capability.id,
      modelId: capability.model,
      label: capability.label,
      description: capability.description,
      defaultReasoningLevel: capability.defaultReasoningLevel,
      supportedReasoningLevels: capability.supportedReasoningLevels,
      source: "discovered",
    }));
  saveCachedProviderModels("openai", { discoveredAt: capabilities.discoveredAt, models });
}

// Cache chain: TTL-based in-memory cache → live discovery → seeded local caches
// (codex's own models_cache.json / Ubume's last-good discovery) → static
// fallback model list. Failed discoveries are evicted from the in-memory cache
// so retries are possible even when a seed satisfied the request.
export async function getCodexModelCapabilities(
  options: GetCodexModelCapabilitiesOptions = {},
): Promise<CodexModelCapabilities> {
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const seed = options.seed ?? loadSeededCodexCapabilities;
  const persist = options.persist ?? persistCodexModelCapabilities;
  let executable: string | null = null;
  let liveDiscoverySucceeded = false;

  try {
    executable = options.executable ?? await (options.resolveExecutable ?? resolveCodexExecutable)();
    const cacheKey = `${executable}|hidden:${options.includeHidden ?? false}`;
    const cached = capabilityCache.get(cacheKey);
    if (!options.forceRefresh && cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const discover = options.discover ?? discoverCodexModelCapabilities;
    const promise = discover({
      executable,
      includeHidden: options.includeHidden,
      timeoutMs: options.timeoutMs,
      now: () => now,
    }).then((discovered) => {
      liveDiscoverySucceeded = true;
      try {
        persist(discovered);
      } catch {
        // Persistence must never fail a successful discovery.
      }
      return discovered;
    }).catch((error) => {
      try {
        const seeded = seed();
        if (seeded) {
          return seeded;
        }
      } catch {
        // Seed read failures fall through to the static list.
      }
      return createFallbackModelCapabilities(error, { discoveredAt: now, executable });
    });

    capabilityCache.set(cacheKey, {
      expiresAt: now + ttlMs,
      promise,
    });

    const result = await promise;
    if (!liveDiscoverySucceeded) {
      capabilityCache.delete(cacheKey);
    }

    return result;
  } catch (error) {
    try {
      const seeded = seed();
      if (seeded) {
        return seeded;
      }
    } catch {
      // Seed read failures fall through to the static list.
    }
    return createFallbackModelCapabilities(error, { discoveredAt: now, executable });
  }
}

export function clearCodexModelCapabilityCache(): void {
  capabilityCache.clear();
}

export function getSelectableModelCapabilities(
  capabilities: CodexModelCapabilities,
): readonly CodexModelCapability[] {
  return capabilities.models.filter((model) => !model.hidden);
}

export function findModelCapability(
  capabilities: CodexModelCapabilities | null | undefined,
  model: string,
): CodexModelCapability | null {
  if (!capabilities) {
    return null;
  }

  const normalized = model.toLowerCase();
  return capabilities.models.find((candidate) =>
    candidate.model.toLowerCase() === normalized || candidate.id.toLowerCase() === normalized
  ) ?? null;
}

export function isModelSelectable(
  capabilities: CodexModelCapabilities | null | undefined,
  model: string,
): boolean {
  const found = findModelCapability(capabilities, model);
  return Boolean(found && !found.hidden);
}

export function getPreferredModelFromCapabilities(
  capabilities: CodexModelCapabilities,
  currentModel: string,
): string {
  if (isModelSelectable(capabilities, currentModel)) {
    return currentModel;
  }

  const selectable = getSelectableModelCapabilities(capabilities);
  return selectable.find((model) => model.isDefault)?.model
    ?? selectable[0]?.model
    ?? currentModel
    ?? DEFAULT_MODEL;
}

export function normalizeReasoningForModelCapabilities(
  model: string,
  currentReasoning: string,
  capabilities: CodexModelCapabilities | null | undefined,
): string {
  const capability = findModelCapability(capabilities, model);
  const supported = capability?.supportedReasoningLevels;
  if (!supported || supported.length === 0) {
    return currentReasoning;
  }

  if (supported.some((item) => item.id === currentReasoning)) {
    return currentReasoning;
  }

  if (capability.defaultReasoningLevel && supported.some((item) => item.id === capability.defaultReasoningLevel)) {
    return capability.defaultReasoningLevel;
  }

  return supported[0]!.id;
}

export function formatModelCapabilitiesList(
  capabilities: CodexModelCapabilities,
  currentModel: string,
): string {
  const list = getSelectableModelCapabilities(capabilities)
    .map((model, index) => {
      const active = model.model === currentModel || model.id === currentModel ? "  *" : "";
      const reasoning = model.reasoningLevelCount === null
        ? "reasoning metadata unknown"
        : `${model.reasoningLevelCount} reasoning ${model.reasoningLevelCount === 1 ? "level" : "levels"}`;
      return `  ${index + 1}. ${model.label} (${model.model}) - ${reasoning}${active}`;
    })
    .join("\n");

  const source = capabilities.status === "ready"
    ? "Detected from Codex runtime."
    : `Fallback list; runtime discovery failed${capabilities.error ? `: ${capabilities.error}` : "."}`;

  return `${source}\n${list || "  - none"}`;
}
