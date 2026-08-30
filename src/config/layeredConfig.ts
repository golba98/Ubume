import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { normalizeWorkspaceRoot } from "../core/workspace/workspaceRoot.js";
import {
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPersonalityLabel,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  mergeRuntimeConfig,
  type PartialRuntimeConfig,
  type RuntimeApprovalPolicy,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
  type RuntimePersonality,
  type RuntimeSandboxMode,
  type RuntimeServiceTier,
  DEFAULT_RUNTIME_CONFIG,
} from "./runtimeConfig.js";
import {
  AVAILABLE_BACKENDS,
  AVAILABLE_MODES,
  formatBackendLabel,
  formatModeLabel,
  formatReasoningLabel,
  getCodexConfigFile,
  type AvailableBackend,
  type AvailableMode,
  type AvailableModel,
  type ReasoningLevel,
} from "./settings.js";
import type { LaunchArgs } from "./launchArgs.js";
import { isProjectTrusted } from "./trustStore.js";
import { isRecord, serializeTomlDocument } from "./toml-serialize.js";

export const RUNTIME_FIELD_PATHS = [
  "provider",
  "model",
  "reasoningLevel",
  "mode",
  "planMode",
  "geminiCommandPath",
  "policy.approvalPolicy",
  "policy.sandboxMode",
  "policy.networkAccess",
  "policy.writableRoots",
  "policy.serviceTier",
  "policy.personality",
] as const;

export type RuntimeFieldPath = (typeof RUNTIME_FIELD_PATHS)[number];

export type ConfigLayerStatus = "loaded" | "missing" | "blocked" | "error";

export interface ConfigLayerReport {
  label: string;
  status: ConfigLayerStatus;
  path?: string;
  reason?: string;
}

export interface LayeredConfigDiagnostics {
  projectRoot: string;
  projectTrusted: boolean;
  selectedProfile: string | null;
  selectedProfileSource: string | null;
  cliOverrides: string[];
  layers: ConfigLayerReport[];
  ignoredEntries: string[];
  fieldSources: Record<RuntimeFieldPath, string>;
}

export interface LayeredConfigResult {
  runtime: RuntimeConfig;
  diagnostics: LayeredConfigDiagnostics;
}

export interface ResolveLayeredConfigOptions {
  workspaceRoot: string;
  launchArgs: LaunchArgs;
}

interface RuntimeLayerPatch {
  patch: PartialRuntimeConfig;
  touchedFields: RuntimeFieldPath[];
  ignoredEntries: string[];
}

interface ParsedConfigLayer {
  label: string;
  path: string;
  data: Record<string, unknown>;
  topLevelPatch: RuntimeLayerPatch;
  topLevelProfile: string | null;
}

// ─── Field source tracking ─────────────────────────────────────────────────────

function createFieldSources(label: string): Record<RuntimeFieldPath, string> {
  return Object.fromEntries(
    RUNTIME_FIELD_PATHS.map((field) => [field, label]),
  ) as Record<RuntimeFieldPath, string>;
}

function addTouchedField(target: Set<RuntimeFieldPath>, field: RuntimeFieldPath): void {
  target.add(field);
}

function assignPolicyValue<T extends keyof NonNullable<PartialRuntimeConfig["policy"]>>(
  patch: PartialRuntimeConfig,
  key: T,
  value: NonNullable<PartialRuntimeConfig["policy"]>[T],
): void {
  patch.policy = {
    ...(patch.policy ?? {}),
    [key]: value,
  };
}

// ─── TOML patch extraction ─────────────────────────────────────────────────────

function isAbsolutePath(pathValue: string): boolean {
  // Matches Windows drive-letter paths (C:\ or C:/), UNC paths (\\server), and Unix absolute paths (/).
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(pathValue);
}

function resolveConfigPath(configFilePath: string, rawPath: string): string {
  return normalizeWorkspaceRoot(
    isAbsolutePath(rawPath) ? rawPath : resolve(dirname(configFilePath), rawPath),
  );
}

function parseWritableRoots(
  value: unknown,
  configFilePath: string,
  ignoredEntries: string[],
): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    ignoredEntries.push("sandbox_workspace_write.writable_roots");
    return null;
  }

  return value.map((item) => resolveConfigPath(configFilePath, item));
}

function extractRuntimePatch(
  data: Record<string, unknown>,
  sourceLabel: string,
  configFilePath: string,
): RuntimeLayerPatch {
  const patch: PartialRuntimeConfig = {};
  const touchedFields = new Set<RuntimeFieldPath>();
  const ignoredEntries: string[] = [];

  if ("model" in data) {
    if (typeof data.model === "string" && data.model.trim().length > 0) {
      patch.model = data.model.trim() as AvailableModel;
      addTouchedField(touchedFields, "model");
    } else {
      ignoredEntries.push("model");
    }
  }

  if ("model_reasoning_effort" in data) {
    const value = data.model_reasoning_effort;
    if (typeof value === "string" && value.trim().length > 0) {
      patch.reasoningLevel = value.trim() as ReasoningLevel;
      addTouchedField(touchedFields, "reasoningLevel");
    } else {
      ignoredEntries.push("model_reasoning_effort");
    }
  }

  const geminiCommandPath = data.geminiCommandPath ?? data.gemini_command_path;
  if (geminiCommandPath !== undefined) {
    if (typeof geminiCommandPath === "string" && geminiCommandPath.trim().length > 0) {
      patch.geminiCommandPath = geminiCommandPath.trim();
      addTouchedField(touchedFields, "geminiCommandPath");
    } else {
      ignoredEntries.push("gemini_command_path");
    }
  }

  if ("approval_policy" in data) {
    const value = data.approval_policy;
    const validValues = ["untrusted", "on-request", "never"] as const;
    if (typeof value === "string" && (validValues as readonly string[]).includes(value)) {
      assignPolicyValue(patch, "approvalPolicy", value as RuntimeApprovalPolicy);
      addTouchedField(touchedFields, "policy.approvalPolicy");
    } else {
      ignoredEntries.push("approval_policy");
    }
  }

  if ("sandbox_mode" in data) {
    const value = data.sandbox_mode;
    const validValues = ["read-only", "workspace-write", "danger-full-access"] as const;
    if (typeof value === "string" && (validValues as readonly string[]).includes(value)) {
      assignPolicyValue(patch, "sandboxMode", value as RuntimeSandboxMode);
      addTouchedField(touchedFields, "policy.sandboxMode");
    } else {
      ignoredEntries.push("sandbox_mode");
    }
  }

  if ("service_tier" in data) {
    const value = data.service_tier;
    const validValues = ["flex", "fast"] as const;
    if (typeof value === "string" && validValues.includes(value as RuntimeServiceTier)) {
      assignPolicyValue(patch, "serviceTier", value as RuntimeServiceTier);
      addTouchedField(touchedFields, "policy.serviceTier");
    } else {
      ignoredEntries.push("service_tier");
    }
  }

  if ("personality" in data) {
    const value = data.personality;
    const validValues = ["none", "friendly", "pragmatic"] as const;
    if (typeof value === "string" && validValues.includes(value as RuntimePersonality)) {
      assignPolicyValue(patch, "personality", value as RuntimePersonality);
      addTouchedField(touchedFields, "policy.personality");
    } else {
      ignoredEntries.push("personality");
    }
  }

  const sandboxTable = data.sandbox_workspace_write;
  if ("sandbox_workspace_write" in data) {
    if (!isRecord(sandboxTable)) {
      ignoredEntries.push("sandbox_workspace_write");
    } else {
      if ("network_access" in sandboxTable) {
        if (typeof sandboxTable.network_access === "boolean") {
          const networkAccess: RuntimeNetworkAccess = sandboxTable.network_access ? "enabled" : "disabled";
          assignPolicyValue(patch, "networkAccess", networkAccess);
          addTouchedField(touchedFields, "policy.networkAccess");
        } else {
          ignoredEntries.push("sandbox_workspace_write.network_access");
        }
      }

      if ("writable_roots" in sandboxTable) {
        const writableRoots = parseWritableRoots(
          sandboxTable.writable_roots,
          configFilePath,
          ignoredEntries,
        );
        if (writableRoots) {
          assignPolicyValue(patch, "writableRoots", writableRoots);
          addTouchedField(touchedFields, "policy.writableRoots");
        }
      }
    }
  }

  const codexaTable = data.codexa;
  if ("codexa" in data) {
    if (!isRecord(codexaTable)) {
      ignoredEntries.push("codexa");
    } else {
      if ("backend" in codexaTable) {
        if (
          typeof codexaTable.backend === "string"
          && AVAILABLE_BACKENDS.some((item) => item.id === codexaTable.backend)
        ) {
          patch.provider = codexaTable.backend as AvailableBackend;
          addTouchedField(touchedFields, "provider");
        } else {
          ignoredEntries.push("codexa.backend");
        }
      }

      if ("mode" in codexaTable) {
        if (
          typeof codexaTable.mode === "string"
          && AVAILABLE_MODES.some((item) => item.key === codexaTable.mode)
        ) {
          patch.mode = codexaTable.mode as AvailableMode;
          addTouchedField(touchedFields, "mode");
        } else {
          ignoredEntries.push("codexa.mode");
        }
      }

      if ("plan_mode" in codexaTable) {
        if (typeof codexaTable.plan_mode === "boolean") {
          patch.planMode = codexaTable.plan_mode;
          addTouchedField(touchedFields, "planMode");
        } else {
          ignoredEntries.push("codexa.plan_mode");
        }
      }
    }
  }

  return {
    patch,
    touchedFields: Array.from(touchedFields),
    ignoredEntries: ignoredEntries.map((entry) => `${sourceLabel}: ${entry}`),
  };
}

// ─── Layer loading ─────────────────────────────────────────────────────────────

export function parseTomlDocument(text: string): Record<string, unknown> {
  const parsed = (globalThis as { Bun?: { TOML?: { parse?: (input: string) => unknown } } }).Bun?.TOML?.parse?.(text);
  if (parsed === undefined) {
    throw new Error("Bun TOML parser is unavailable.");
  }
  return isRecord(parsed) ? parsed : {};
}

function tryLoadConfigLayer(label: string, filePath: string): ParsedConfigLayer | ConfigLayerReport {
  if (!existsSync(filePath)) {
    return {
      label,
      status: "missing",
      path: filePath,
    };
  }

  try {
    const data = parseTomlDocument(readFileSync(filePath, "utf-8"));
    return {
      label,
      path: filePath,
      data,
      topLevelPatch: extractRuntimePatch(data, label, filePath),
      topLevelProfile: typeof data.profile === "string" && data.profile.trim().length > 0
        ? data.profile.trim()
        : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown TOML parse failure";
    return {
      label,
      status: "error",
      path: filePath,
      reason: message,
    };
  }
}

function applyRuntimeLayer(
  runtime: RuntimeConfig,
  fieldSources: Record<RuntimeFieldPath, string>,
  layer: RuntimeLayerPatch,
  sourceLabel: string,
): RuntimeConfig {
  const nextRuntime = mergeRuntimeConfig(runtime, layer.patch);
  for (const field of layer.touchedFields) {
    fieldSources[field] = sourceLabel;
  }
  return nextRuntime;
}

function getProfilePatch(
  layer: ParsedConfigLayer,
  profileName: string,
): RuntimeLayerPatch | null {
  const profiles = layer.data.profiles;
  if (!isRecord(profiles)) {
    return null;
  }

  const profileData = profiles[profileName];
  if (!isRecord(profileData)) {
    return null;
  }

  return extractRuntimePatch(profileData, `Profile ${profileName} from ${layer.label}`, layer.path);
}

function parseTomlScalar(rawValue: string): unknown {
  try {
    return parseTomlDocument(`value = ${rawValue}`).value;
  } catch {
    return rawValue;
  }
}

function extractRuntimePatchFromOverride(
  workspaceRoot: string,
  rawOverride: string,
): RuntimeLayerPatch {
  const separatorIndex = rawOverride.indexOf("=");
  const key = separatorIndex === -1 ? rawOverride.trim() : rawOverride.slice(0, separatorIndex).trim();
  const rawValue = separatorIndex === -1 ? "" : rawOverride.slice(separatorIndex + 1).trim();
  const value = parseTomlScalar(rawValue);
  const sourceLabel = `CLI override (${key})`;
  const configPath = join(workspaceRoot, ".codex", "config.toml");

  const overrideData: Record<string, unknown> = {};
  switch (key) {
    case "model":
      overrideData.model = value;
      break;
    case "model_reasoning_effort":
      overrideData.model_reasoning_effort = value;
      break;
    case "approval_policy":
      overrideData.approval_policy = value;
      break;
    case "sandbox_mode":
      overrideData.sandbox_mode = value;
      break;
    case "sandbox_workspace_write.network_access":
      overrideData.sandbox_workspace_write = { network_access: value };
      break;
    case "sandbox_workspace_write.writable_roots":
      overrideData.sandbox_workspace_write = { writable_roots: value };
      break;
    case "service_tier":
      overrideData.service_tier = value;
      break;
    case "personality":
      overrideData.personality = value;
      break;
    case "codexa.backend":
      overrideData.codexa = { backend: value };
      break;
    case "codexa.mode":
      overrideData.codexa = { mode: value };
      break;
    default:
      return {
        patch: {},
        touchedFields: [],
        ignoredEntries: [`${sourceLabel}: unsupported key`],
      };
  }

  return extractRuntimePatch(overrideData, sourceLabel, configPath);
}

// ─── Config resolution ─────────────────────────────────────────────────────────

function findProjectRoot(workspaceRoot: string): string {
  let current = normalizeWorkspaceRoot(workspaceRoot);

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return normalizeWorkspaceRoot(workspaceRoot);
    }
    current = parent;
  }
}

function listProjectLayerPaths(projectRoot: string, workspaceRoot: string): string[] {
  const normalizedProjectRoot = normalizeWorkspaceRoot(projectRoot);
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const paths: string[] = [];
  let current = normalizedWorkspaceRoot;

  while (true) {
    paths.unshift(join(current, ".codex", "config.toml"));
    if (current === normalizedProjectRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return paths;
}

export function resolveLayeredConfig(options: ResolveLayeredConfigOptions): LayeredConfigResult {
  // Config resolution order (each layer wins over the previous):
  //   1. Built-in defaults (DEFAULT_RUNTIME_CONFIG)
  //   2. User config  (~/.codex/config.toml)
  //   3. Project config  (.codex/config.toml, only when project is trusted)
  //   4. Profile patch  ([profiles.<name>] from any loaded layer)
  //   5. CLI overrides  (--config key=value flags)
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
  const projectRoot = findProjectRoot(workspaceRoot);
  const projectTrusted = isProjectTrusted(projectRoot);
  const diagnostics: LayeredConfigDiagnostics = {
    projectRoot,
    projectTrusted,
    selectedProfile: null,
    selectedProfileSource: null,
    cliOverrides: [...options.launchArgs.configOverrides],
    layers: [{ label: "Built-in defaults", status: "loaded" }],
    ignoredEntries: [],
    fieldSources: createFieldSources("Built-in defaults"),
  };

  let runtime = DEFAULT_RUNTIME_CONFIG;
  const loadedLayers: ParsedConfigLayer[] = [];
  // The last profile name found in any config file. CLI --profile takes priority over this.
  let configFileProfile: { name: string; source: string } | null = null;

  const userConfigFile = getCodexConfigFile();
  const userLayer = tryLoadConfigLayer("User config", userConfigFile);
  if ("data" in userLayer) {
    runtime = applyRuntimeLayer(runtime, diagnostics.fieldSources, userLayer.topLevelPatch, "User config");
    diagnostics.layers.push({ label: "User config", status: "loaded", path: userLayer.path });
    diagnostics.ignoredEntries.push(...userLayer.topLevelPatch.ignoredEntries);
    loadedLayers.push(userLayer);
    if (userLayer.topLevelProfile) {
      configFileProfile = { name: userLayer.topLevelProfile, source: "User config" };
    }
  } else {
    diagnostics.layers.push(userLayer);
  }

  const projectLayerPaths = listProjectLayerPaths(projectRoot, workspaceRoot)
    .filter((filePath) => existsSync(filePath));

  if (projectLayerPaths.length === 0) {
    diagnostics.layers.push({
      label: "Project config",
      status: "missing",
      path: join(projectRoot, ".codex", "config.toml"),
    });
  } else if (!projectTrusted) {
    for (const filePath of projectLayerPaths) {
      diagnostics.layers.push({
        label: "Project config",
        status: "blocked",
        path: filePath,
        reason: "project is untrusted",
      });
    }
  } else {
    for (const filePath of projectLayerPaths) {
      const relativeLabel = filePath === join(projectRoot, ".codex", "config.toml")
        ? "Project config"
        : `Project config (${dirname(dirname(filePath)).slice(projectRoot.length + 1) || "."})`;
      const layer = tryLoadConfigLayer(relativeLabel, filePath);
      if ("data" in layer) {
        runtime = applyRuntimeLayer(runtime, diagnostics.fieldSources, layer.topLevelPatch, layer.label);
        diagnostics.layers.push({ label: layer.label, status: "loaded", path: layer.path });
        diagnostics.ignoredEntries.push(...layer.topLevelPatch.ignoredEntries);
        loadedLayers.push(layer);
        if (layer.topLevelProfile) {
          configFileProfile = { name: layer.topLevelProfile, source: layer.label };
        }
      } else {
        diagnostics.layers.push(layer);
      }
    }
  }

  if (options.launchArgs.profile) {
    diagnostics.selectedProfile = options.launchArgs.profile;
    diagnostics.selectedProfileSource = "CLI --profile";
  } else if (configFileProfile) {
    diagnostics.selectedProfile = configFileProfile.name;
    diagnostics.selectedProfileSource = configFileProfile.source;
  }

  if (diagnostics.selectedProfile) {
    let matchedProfile = false;
    for (const layer of loadedLayers) {
      const profilePatch = getProfilePatch(layer, diagnostics.selectedProfile);
      if (!profilePatch) {
        continue;
      }

      matchedProfile = true;
      const label = `Profile ${diagnostics.selectedProfile} from ${layer.label}`;
      runtime = applyRuntimeLayer(runtime, diagnostics.fieldSources, profilePatch, label);
      diagnostics.layers.push({
        label,
        status: "loaded",
        path: layer.path,
      });
      diagnostics.ignoredEntries.push(...profilePatch.ignoredEntries);
    }

    if (!matchedProfile) {
      diagnostics.ignoredEntries.push(`Selected profile not found: ${diagnostics.selectedProfile}`);
    }
  }

  for (const rawOverride of options.launchArgs.configOverrides) {
    const overridePatch = extractRuntimePatchFromOverride(workspaceRoot, rawOverride);
    diagnostics.ignoredEntries.push(...overridePatch.ignoredEntries);
    if (overridePatch.touchedFields.length === 0) {
      continue;
    }

    runtime = applyRuntimeLayer(runtime, diagnostics.fieldSources, overridePatch, `CLI override (${rawOverride})`);
    diagnostics.layers.push({
      label: `CLI override`,
      status: "loaded",
      reason: rawOverride,
    });
  }

  return {
    runtime,
    diagnostics,
  };
}

// ─── Runtime override helpers ──────────────────────────────────────────────────

function getTouchedFieldsFromPatch(patch: PartialRuntimeConfig): RuntimeFieldPath[] {
  const touched = new Set<RuntimeFieldPath>();

  if (patch.provider !== undefined) touched.add("provider");
  if (patch.model !== undefined) touched.add("model");
  if (patch.reasoningLevel !== undefined) touched.add("reasoningLevel");
  if (patch.mode !== undefined) touched.add("mode");
  if (patch.planMode !== undefined) touched.add("planMode");
  if (patch.geminiCommandPath !== undefined) touched.add("geminiCommandPath");
  if (patch.policy?.approvalPolicy !== undefined) touched.add("policy.approvalPolicy");
  if (patch.policy?.sandboxMode !== undefined) touched.add("policy.sandboxMode");
  if (patch.policy?.networkAccess !== undefined) touched.add("policy.networkAccess");
  if (patch.policy?.writableRoots !== undefined) touched.add("policy.writableRoots");
  if (patch.policy?.serviceTier !== undefined) touched.add("policy.serviceTier");
  if (patch.policy?.personality !== undefined) touched.add("policy.personality");

  return Array.from(touched);
}

export function applyLayeredRuntimeOverride(
  base: LayeredConfigResult,
  override: PartialRuntimeConfig,
  sourceLabel: string,
): LayeredConfigResult {
  const touchedFields = getTouchedFieldsFromPatch(override);
  if (touchedFields.length === 0) {
    return base;
  }

  const runtime = mergeRuntimeConfig(base.runtime, override);
  const fieldSources = { ...base.diagnostics.fieldSources };
  for (const field of touchedFields) {
    fieldSources[field] = sourceLabel;
  }

  return {
    runtime,
    diagnostics: {
      ...base.diagnostics,
      fieldSources,
      layers: [
        ...base.diagnostics.layers,
        {
          label: sourceLabel,
          status: "loaded",
        },
      ],
    },
  };
}

// ─── Diagnostics formatting ────────────────────────────────────────────────────

function formatRuntimeFieldValue(runtime: RuntimeConfig, field: RuntimeFieldPath): string {
  switch (field) {
    case "provider":
      return formatBackendLabel(runtime.provider);
    case "model":
      return runtime.model;
    case "reasoningLevel":
      return formatReasoningLabel(runtime.reasoningLevel);
    case "mode":
      return formatModeLabel(runtime.mode);
    case "planMode":
      return runtime.planMode ? "Enabled" : "Disabled";
    case "geminiCommandPath":
      return runtime.geminiCommandPath ?? "none";
    case "policy.approvalPolicy":
      return formatApprovalPolicyLabel(runtime.policy.approvalPolicy);
    case "policy.sandboxMode":
      return formatSandboxModeLabel(runtime.policy.sandboxMode);
    case "policy.networkAccess":
      return formatNetworkAccessLabel(runtime.policy.networkAccess);
    case "policy.writableRoots":
      return runtime.policy.writableRoots.length > 0
        ? runtime.policy.writableRoots.join(", ")
        : "none";
    case "policy.serviceTier":
      return formatServiceTierLabel(runtime.policy.serviceTier);
    case "policy.personality":
      return formatPersonalityLabel(runtime.policy.personality);
    default:
      return "";
  }
}

export function formatLayeredConfigStatus(result: LayeredConfigResult): string {
  const { diagnostics, runtime } = result;
  const lines = [
    "Config status:",
    `  Project root: ${diagnostics.projectRoot}`,
    `  Project trust: ${diagnostics.projectTrusted ? "Trusted" : "Untrusted"}`,
    `  Selected profile: ${diagnostics.selectedProfile ? `${diagnostics.selectedProfile} (${diagnostics.selectedProfileSource ?? "unknown"})` : "none"}`,
    `  CLI overrides: ${diagnostics.cliOverrides.length > 0 ? diagnostics.cliOverrides.join(", ") : "none"}`,
    "  Layers:",
  ];

  for (const layer of diagnostics.layers) {
    const detail = [
      layer.path ? `path ${layer.path}` : null,
      layer.reason ?? null,
    ].filter(Boolean).join("; ");
    lines.push(
      `    - ${layer.label}: ${layer.status}${detail ? ` (${detail})` : ""}`,
    );
  }

  lines.push("  Winning sources:");
  for (const field of RUNTIME_FIELD_PATHS) {
    lines.push(
      `    - ${field}: ${formatRuntimeFieldValue(runtime, field)} <- ${diagnostics.fieldSources[field]}`,
    );
  }

  if (diagnostics.ignoredEntries.length > 0) {
    lines.push("  Ignored entries:");
    for (const entry of diagnostics.ignoredEntries) {
      lines.push(`    - ${entry}`);
    }
  }

  return lines.join("\n");
}

// ─── TOML merge helpers ────────────────────────────────────────────────────────

function cloneTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneTomlValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneTomlValue(item)]),
    );
  }

  return value;
}

function ensureTable(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let current = root;
  for (const segment of path) {
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

function getNestedValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const table = ensureTable(root, path.slice(0, -1));
  table[path[path.length - 1]!] = cloneTomlValue(value);
}

export function mergeRuntimeIntoTomlConfig(
  currentData: Record<string, unknown>,
  runtime: RuntimeConfig,
): Record<string, unknown> {
  const nextData = cloneTomlValue(currentData) as Record<string, unknown>;
  const defaultRuntime = DEFAULT_RUNTIME_CONFIG;
  const entries: Array<{ path: string[]; value: unknown; shouldWrite: boolean }> = [
    { path: ["model"], value: runtime.model, shouldWrite: runtime.model !== defaultRuntime.model },
    {
      path: ["model_reasoning_effort"],
      value: runtime.reasoningLevel,
      shouldWrite: runtime.reasoningLevel !== defaultRuntime.reasoningLevel,
    },
    {
      path: ["approval_policy"],
      value: runtime.policy.approvalPolicy,
      shouldWrite: runtime.policy.approvalPolicy !== defaultRuntime.policy.approvalPolicy,
    },
    {
      path: ["sandbox_mode"],
      value: runtime.policy.sandboxMode,
      shouldWrite: runtime.policy.sandboxMode !== defaultRuntime.policy.sandboxMode,
    },
    {
      path: ["sandbox_workspace_write", "network_access"],
      value: runtime.policy.networkAccess === "enabled",
      shouldWrite: runtime.policy.networkAccess !== defaultRuntime.policy.networkAccess,
    },
    {
      path: ["sandbox_workspace_write", "writable_roots"],
      value: runtime.policy.writableRoots,
      shouldWrite: runtime.policy.writableRoots.length > 0,
    },
    {
      path: ["service_tier"],
      value: runtime.policy.serviceTier,
      shouldWrite: runtime.policy.serviceTier !== defaultRuntime.policy.serviceTier,
    },
    {
      path: ["personality"],
      value: runtime.policy.personality,
      shouldWrite: runtime.policy.personality !== defaultRuntime.policy.personality,
    },
    {
      path: ["codexa", "backend"],
      value: runtime.provider,
      shouldWrite: runtime.provider !== defaultRuntime.provider,
    },
    {
      path: ["codexa", "mode"],
      value: runtime.mode,
      shouldWrite: runtime.mode !== defaultRuntime.mode,
    },
    {
      path: ["codexa", "plan_mode"],
      value: runtime.planMode,
      shouldWrite: runtime.planMode !== defaultRuntime.planMode,
    },
  ];

  for (const entry of entries) {
    if (!entry.shouldWrite) {
      continue;
    }

    if (getNestedValue(nextData, entry.path) !== undefined) {
      continue;
    }

    setNestedValue(nextData, entry.path, entry.value);
  }

  return nextData;
}
