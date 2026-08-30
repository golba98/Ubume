import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Theme } from "../ui/theme.js";
import {
  AUTH_PREFERENCES,
  DEFAULT_AUTH_PREFERENCE,
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_SHOW_BUSY_LOADER,
  DEFAULT_TERMINAL_TITLE_MODE,
  DEFAULT_THEME,
  DEFAULT_WORKSPACE_DISPLAY_MODE,
  HEADER_CONFIG_DEFAULTS,
  LEGACY_DIRECTORY_DISPLAY_MODES,
  WORKSPACE_DISPLAY_MODES,
  getCodexConfigFile,
  normalizeLegacyDirectoryDisplayMode,
  SETTINGS_FILE,
  type AuthPreference,
  type HeaderConfig,
  type TerminalTitleMode,
  type WorkspaceDisplayMode,
} from "./settings.js";
import {
  mergeRuntimeIntoTomlConfig,
  parseTomlDocument,
} from "./layeredConfig.js";
import { serializeTomlDocument } from "./toml-serialize.js";
import {
  normalizeRuntimeConfig,
  type RuntimeConfig,
} from "./runtimeConfig.js";
import type { AvailableMode } from "./settings.js";

export interface UiSettings {
  layoutStyle: string;
  theme: string;
  workspaceDisplayMode: WorkspaceDisplayMode;
  terminalTitleMode: TerminalTitleMode;
  showBusyLoader: boolean;
  customTheme?: Partial<Theme>;
}

export interface AuthSettings {
  preference: AuthPreference;
}

export interface UpdateCheckSettings {
  enabled: boolean;
  intervalHours: number;
  skippedUpdateVersion?: string | null;
}

export const DEFAULT_UPDATE_CHECK_SETTINGS: UpdateCheckSettings = {
  enabled: true,
  intervalHours: 6,
};

export interface AppSettings {
  ui: UiSettings;
  auth: AuthSettings;
  header: HeaderConfig;
  updateCheck: UpdateCheckSettings;
}

// Pick the first string value found under the camelCase or snake_case key.
// Falls through to the snake_case key only when the camelCase value is absent or not a string.
function pickStr(src: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const camelVal = src[camel];
  if (typeof camelVal === "string") return camelVal;
  const snakeVal = src[snake];
  if (typeof snakeVal === "string") return snakeVal;
  return undefined;
}

// Same as pickStr but for boolean values.
function pickBool(src: Record<string, unknown>, camel: string, snake: string): boolean | undefined {
  const camelVal = src[camel];
  if (typeof camelVal === "boolean") return camelVal;
  const snakeVal = src[snake];
  if (typeof snakeVal === "boolean") return snakeVal;
  return undefined;
}

function normalizeAuthPreference(value: unknown): AuthPreference {
  return typeof value === "string" && AUTH_PREFERENCES.some((item) => item.id === value)
    ? (value as AuthPreference)
    : DEFAULT_AUTH_PREFERENCE;
}

function normalizeUiSettings(input: Partial<UiSettings> | null | undefined): UiSettings {
  return {
    layoutStyle: input?.layoutStyle ?? DEFAULT_LAYOUT_STYLE,
    theme: input?.theme ?? DEFAULT_THEME,
    workspaceDisplayMode: input?.workspaceDisplayMode ?? DEFAULT_WORKSPACE_DISPLAY_MODE,
    terminalTitleMode: input?.terminalTitleMode ?? DEFAULT_TERMINAL_TITLE_MODE,
    showBusyLoader: typeof input?.showBusyLoader === "boolean"
      ? input.showBusyLoader
      : DEFAULT_SHOW_BUSY_LOADER,
    customTheme: input?.customTheme,
  };
}

function normalizeHeaderConfig(input: Partial<HeaderConfig> | null | undefined): HeaderConfig {
  return {
    showBrand: typeof input?.showBrand === "boolean" ? input.showBrand : HEADER_CONFIG_DEFAULTS.showBrand,
    showWorkspace: typeof input?.showWorkspace === "boolean" ? input.showWorkspace : HEADER_CONFIG_DEFAULTS.showWorkspace,
    showProvider: typeof input?.showProvider === "boolean" ? input.showProvider : HEADER_CONFIG_DEFAULTS.showProvider,
    showModel: typeof input?.showModel === "boolean" ? input.showModel : HEADER_CONFIG_DEFAULTS.showModel,
    showReasoning: typeof input?.showReasoning === "boolean" ? input.showReasoning : HEADER_CONFIG_DEFAULTS.showReasoning,
    showContext: typeof input?.showContext === "boolean" ? input.showContext : HEADER_CONFIG_DEFAULTS.showContext,
    showAuthStatus: typeof input?.showAuthStatus === "boolean" ? input.showAuthStatus : HEADER_CONFIG_DEFAULTS.showAuthStatus,
  };
}

function normalizeUpdateCheckSettings(
  input: Partial<UpdateCheckSettings> | null | undefined,
): UpdateCheckSettings {
  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : DEFAULT_UPDATE_CHECK_SETTINGS.enabled,
    intervalHours: typeof input?.intervalHours === "number" && input.intervalHours > 0
      ? input.intervalHours
      : DEFAULT_UPDATE_CHECK_SETTINGS.intervalHours,
    skippedUpdateVersion: input?.skippedUpdateVersion ?? null,
  };
}

export function getDefaultSettings(): AppSettings {
  return {
    ui: normalizeUiSettings(null),
    auth: {
      preference: DEFAULT_AUTH_PREFERENCE,
    },
    header: normalizeHeaderConfig(null),
    updateCheck: normalizeUpdateCheckSettings(null),
  };
}

function parseLegacyRuntime(data: Record<string, unknown>): RuntimeConfig {
  return normalizeRuntimeConfig({
    provider: typeof data.backend === "string" ? data.backend as RuntimeConfig["provider"] : undefined,
    model: typeof data.model === "string" ? data.model as RuntimeConfig["model"] : undefined,
    mode: typeof data.mode === "string" ? data.mode as RuntimeConfig["mode"] : undefined,
    reasoningLevel: typeof data.reasoning_level === "string" ? data.reasoning_level as RuntimeConfig["reasoningLevel"] : undefined,
  });
}

export function extractLegacyRuntime(data: unknown): RuntimeConfig | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.runtime === "object" && record.runtime !== null) {
    return normalizeRuntimeConfig(record.runtime as Partial<RuntimeConfig>);
  }

  const hasFlatRuntimeKeys = ["backend", "model", "mode", "reasoning_level"].some((key) => key in record);
  return hasFlatRuntimeKeys ? parseLegacyRuntime(record) : null;
}

function stripLegacyRuntime(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const record = { ...(data as Record<string, unknown>) };
  delete record.runtime;
  delete record.backend;
  delete record.model;
  delete record.mode;
  delete record.reasoning_level;
  return record;
}

function parseTerminalTitleMode(uiSource: Record<string, unknown>, fallback: TerminalTitleMode): TerminalTitleMode {
  const direct = uiSource.terminalTitleMode ?? uiSource.terminal_title_mode;
  if (typeof direct === "string" && WORKSPACE_DISPLAY_MODES.includes(direct as WorkspaceDisplayMode)) {
    return direct as TerminalTitleMode;
  }

  return fallback;
}

function parseWorkspaceDisplayMode(uiSource: Record<string, unknown>, fallback: WorkspaceDisplayMode): WorkspaceDisplayMode {
  const direct = uiSource.workspaceDisplayMode ?? uiSource.workspace_display_mode;
  if (typeof direct === "string" && WORKSPACE_DISPLAY_MODES.includes(direct as WorkspaceDisplayMode)) {
    return direct as WorkspaceDisplayMode;
  }

  const legacy = uiSource.directoryDisplayMode ?? uiSource.directory_display_mode;
  if (typeof legacy === "string") {
    if (WORKSPACE_DISPLAY_MODES.includes(legacy as WorkspaceDisplayMode)) {
      return legacy as WorkspaceDisplayMode;
    }
    if (LEGACY_DIRECTORY_DISPLAY_MODES.includes(legacy as typeof LEGACY_DIRECTORY_DISPLAY_MODES[number])) {
      return normalizeLegacyDirectoryDisplayMode(legacy as typeof LEGACY_DIRECTORY_DISPLAY_MODES[number]);
    }
  }

  return fallback;
}

export function parseSettingsData(data: unknown): AppSettings {
  const defaults = getDefaultSettings();
  if (!data || typeof data !== "object") {
    return defaults;
  }

  const record = data as Record<string, unknown>;
  const uiSource = typeof record.ui === "object" && record.ui !== null
    ? record.ui as Record<string, unknown>
    : record;
  const authSource = typeof record.auth === "object" && record.auth !== null
    ? record.auth as Record<string, unknown>
    : record;

  const headerSource = typeof record.header === "object" && record.header !== null
    ? record.header as Record<string, unknown>
    : {};

  const updateCheckSource = typeof record.updateCheck === "object" && record.updateCheck !== null
    ? record.updateCheck as Record<string, unknown>
    : typeof record.update_check === "object" && record.update_check !== null
      ? record.update_check as Record<string, unknown>
      : {};

  return {
    ui: normalizeUiSettings({
      layoutStyle: pickStr(uiSource, "layoutStyle", "layout_style") ?? defaults.ui.layoutStyle,
      theme: pickStr(uiSource, "theme", "theme") ?? defaults.ui.theme,
      workspaceDisplayMode: parseWorkspaceDisplayMode(uiSource, defaults.ui.workspaceDisplayMode),
      terminalTitleMode: parseTerminalTitleMode(uiSource, defaults.ui.terminalTitleMode),
      showBusyLoader: pickBool(uiSource, "showBusyLoader", "show_busy_loader") ?? defaults.ui.showBusyLoader,
      customTheme: (uiSource.customTheme ?? uiSource.custom_theme) as Partial<Theme> | undefined,
    }),
    auth: {
      preference: normalizeAuthPreference(authSource.preference ?? authSource.auth_preference),
    },
    header: normalizeHeaderConfig({
      showBrand: pickBool(headerSource, "showBrand", "show_brand"),
      showWorkspace: pickBool(headerSource, "showWorkspace", "show_workspace"),
      showProvider: pickBool(headerSource, "showProvider", "show_provider"),
      showModel: pickBool(headerSource, "showModel", "show_model"),
      showReasoning: pickBool(headerSource, "showReasoning", "show_reasoning"),
      showContext: pickBool(headerSource, "showContext", "show_context"),
      showAuthStatus: pickBool(headerSource, "showAuthStatus", "show_auth_status"),
    }),
    updateCheck: normalizeUpdateCheckSettings({
      enabled: pickBool(updateCheckSource, "enabled", "enabled"),
      intervalHours: typeof updateCheckSource.intervalHours === "number"
        ? updateCheckSource.intervalHours
        : typeof updateCheckSource.interval_hours === "number"
          ? updateCheckSource.interval_hours
          : undefined,
      skippedUpdateVersion: typeof updateCheckSource.skippedUpdateVersion === "string"
        ? updateCheckSource.skippedUpdateVersion
        : typeof updateCheckSource.skipped_update_version === "string"
          ? updateCheckSource.skipped_update_version
          : null,
    }),
  };
}

export function serializeSettings(settings: AppSettings): Record<string, unknown> {
  return {
    ui: {
      layout_style: settings.ui.layoutStyle,
      theme: settings.ui.theme,
      workspace_display_mode: settings.ui.workspaceDisplayMode,
      terminal_title_mode: settings.ui.terminalTitleMode,
      show_busy_loader: settings.ui.showBusyLoader,
      custom_theme: settings.ui.customTheme,
    },
    auth: {
      preference: settings.auth.preference,
    },
    header: {
      show_brand: settings.header.showBrand,
      show_workspace: settings.header.showWorkspace,
      show_provider: settings.header.showProvider,
      show_model: settings.header.showModel,
      show_reasoning: settings.header.showReasoning,
      show_context: settings.header.showContext,
      show_auth_status: settings.header.showAuthStatus,
    },
    update_check: {
      enabled: settings.updateCheck.enabled,
      interval_hours: settings.updateCheck.intervalHours,
      ...(settings.updateCheck.skippedUpdateVersion != null
        ? { skipped_update_version: settings.updateCheck.skippedUpdateVersion }
        : {}),
    },
  };
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpFile, filePath);
}

function maybeMigrateLegacyRuntime(rawData: unknown): void {
  const legacyRuntime = extractLegacyRuntime(rawData);
  if (!legacyRuntime) {
    return;
  }

  try {
    const codexConfigFile = getCodexConfigFile();
    const existingConfig = existsSync(codexConfigFile)
      ? parseTomlDocument(readFileSync(codexConfigFile, "utf-8"))
      : {};
    const mergedConfig = mergeRuntimeIntoTomlConfig(existingConfig, legacyRuntime);
    mkdirSync(dirname(codexConfigFile), { recursive: true });
    const tmpTomlFile = `${codexConfigFile}.tmp`;
    writeFileSync(tmpTomlFile, serializeTomlDocument(mergedConfig), "utf-8");
    renameSync(tmpTomlFile, codexConfigFile);
    writeJsonFile(SETTINGS_FILE, stripLegacyRuntime(rawData));
  } catch {
    // Best-effort migration only; keep legacy JSON intact if anything fails.
  }
}

export function loadSettings(): AppSettings {
  try {
    const text = readFileSync(SETTINGS_FILE, "utf-8");
    const rawData = JSON.parse(text);
    maybeMigrateLegacyRuntime(rawData);
    return parseSettingsData(rawData);
  } catch {
    return getDefaultSettings();
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    writeJsonFile(SETTINGS_FILE, serializeSettings(settings));
  } catch {
    // Silently ignore — settings are best-effort
  }
}

/** Persist the interactive execution choice without replacing unrelated Codex config. */
export function saveRuntimeModePreference(mode: AvailableMode, planMode: boolean): void {
  try {
    const codexConfigFile = getCodexConfigFile();
    const current = existsSync(codexConfigFile)
      ? parseTomlDocument(readFileSync(codexConfigFile, "utf-8"))
      : {};
    const codexa = current.codexa && typeof current.codexa === "object" && !Array.isArray(current.codexa)
      ? { ...(current.codexa as Record<string, unknown>) }
      : {};
    current.codexa = { ...codexa, mode, plan_mode: planMode };
    mkdirSync(dirname(codexConfigFile), { recursive: true });
    const tmpFile = `${codexConfigFile}.tmp`;
    writeFileSync(tmpFile, serializeTomlDocument(current), "utf-8");
    renameSync(tmpFile, codexConfigFile);
  } catch {
    // Runtime preference persistence is best-effort and must not crash the TUI.
  }
}
