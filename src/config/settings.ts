import { homedir } from "os";
import { basename, join, parse, win32 } from "path";

function isWindowsStylePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function smartJoin(base: string, ...parts: string[]): string {
  return isWindowsStylePath(base) ? win32.join(base, ...parts) : join(base, ...parts);
}

import { getAppVersion } from "./appVersion.js";

// Authoritative runtime version: resolved from the installed package.json at
// startup (buildInfo.ts is only the committed fallback and can drift).
export const APP_VERSION: string = getAppVersion();
export const APP_NAME = "Ubume";
export const DEFAULT_BACKEND = "codex-subprocess";
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_MODE = "full-auto";
export const DEFAULT_REASONING_LEVEL = "high";
export const DEFAULT_LAYOUT_STYLE = "gemini-shell";
export const DEFAULT_THEME = "dark";
export const DEFAULT_WORKSPACE_DISPLAY_MODE = "dir";
export const DEFAULT_TERMINAL_TITLE_MODE = "dir";
export const DEFAULT_SHOW_BUSY_LOADER = true;
export const DEFAULT_AUTH_PREFERENCE = "chatgpt-login-goal";
export const CODEX_EXECUTABLE = process.env.CODEX_EXECUTABLE || "codex";
export const CLAUDE_EXECUTABLE = process.env.CLAUDE_EXECUTABLE || null;
export const MAX_CHAT_LINES = 2000;
export const MAX_VISIBLE_EVENTS = 8;

export function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function getCodexConfigFile(): string {
  return smartJoin(getCodexHome(), "config.toml");
}

export function getUbumeTrustStoreFile(): string {
  return smartJoin(getCodexHome(), "ubume-trust.json");
}

export function getLegacyCodexaTrustStoreFile(): string {
  return smartJoin(getCodexHome(), "codexa-trust.json");
}

export const getCodexaTrustStoreFile = getUbumeTrustStoreFile;

export const CODEX_HOME = getCodexHome();
export const CODEX_CONFIG_FILE = getCodexConfigFile();
export const UBUME_TRUST_STORE_FILE = getUbumeTrustStoreFile();
export const CODEXA_TRUST_STORE_FILE = getLegacyCodexaTrustStoreFile();
export const SETTINGS_FILE = join(homedir(), ".ubume-settings.json");
export const LEGACY_SETTINGS_FILE = join(homedir(), ".codexa-settings.json");
export const MODEL_SPECS_FILE = join(homedir(), ".ubume-model-specs.json");
export const LEGACY_MODEL_SPECS_FILE = join(homedir(), ".codexa-model-specs.json");

export const AVAILABLE_BACKENDS = [
  {
    id: "codex-subprocess",
    label: "Ubume Core",
    description: "Direct connection to the Ubume neural network.",
  },
  {
    id: "openai-native",
    label: "OpenAI Native",
    description: "Future native provider. ChatGPT subscriptions do not automatically grant API access.",
  },
] as const;

export type AvailableBackend = (typeof AVAILABLE_BACKENDS)[number]["id"];

// Static model list used when runtime model discovery is unavailable.
// Named "legacy fallback" because dynamic discovery is the preferred source of truth,
// but this list is the live exported AVAILABLE_MODELS for now.
export const LEGACY_FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
] as const;

export const AVAILABLE_MODELS = LEGACY_FALLBACK_MODELS;

export type AvailableModel = string;

export const AVAILABLE_REASONING_LEVELS = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
] as const;

export type ReasoningLevel = string;

export const WORKSPACE_DISPLAY_MODES = ["dir", "name", "simple"] as const;
export const LEGACY_DIRECTORY_DISPLAY_MODES = ["normal", "simple"] as const;

export type WorkspaceDisplayMode = (typeof WORKSPACE_DISPLAY_MODES)[number];
export type LegacyDirectoryDisplayMode = (typeof LEGACY_DIRECTORY_DISPLAY_MODES)[number];
export type TerminalTitleMode = WorkspaceDisplayMode;

export const BUSY_LOADER_SETTING_VALUES = ["true", "false"] as const;

export type BusyLoaderSettingValue = (typeof BUSY_LOADER_SETTING_VALUES)[number];

export interface SettingOption<TValue extends string> {
  value: TValue;
  label: string;
}

export interface SettingDefinition<TKey extends string, TValue extends string> {
  key: TKey;
  label: string;
  description?: string;
  options: readonly SettingOption<TValue>[];
}

export interface UserSettingValues {
  workspaceDisplayMode: WorkspaceDisplayMode;
  terminalTitleMode: TerminalTitleMode;
  showBusyLoader: BusyLoaderSettingValue;
}

export type UserSettingKey = keyof UserSettingValues;

export type UserSettingDefinition = {
  [K in UserSettingKey]: SettingDefinition<K, UserSettingValues[K]>;
}[UserSettingKey];

export const USER_SETTING_DEFINITIONS: readonly UserSettingDefinition[] = [
  {
    key: "workspaceDisplayMode",
    label: "Workspace display",
    description: "Controls how the workspace label is displayed in the Ubume header.",
    options: [
      { value: "dir", label: "Dir" },
      { value: "name", label: "Name" },
      { value: "simple", label: "Simple" },
    ],
  },
  {
    key: "terminalTitleMode",
    label: "Terminal title",
    description: "Controls how the terminal tab/window title is displayed.",
    options: [
      { value: "dir", label: "Dir" },
      { value: "name", label: "Name" },
      { value: "simple", label: "Simple" },
    ],
  },
  {
    key: "showBusyLoader",
    label: "Busy loader",
    description: "Controls whether the footer shows a subtle loading animation while Ubume is busy.",
    options: [
      { value: "true", label: "True" },
      { value: "false", label: "False" },
    ],
  },
] as const;

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export const AVAILABLE_MODES = [
  { key: "suggest", label: "Read-only" },
  { key: "auto-edit", label: "Auto" },
  { key: "full-auto", label: "Full Access" },
] as const;

export type AvailableMode = (typeof AVAILABLE_MODES)[number]["key"];

export const MODE_COMMAND_ALIASES = {
  default: DEFAULT_MODE,
  ask: "suggest",
  add: "auto-edit",
  auto: "auto-edit",
} as const;

export type ModeCommandAlias = keyof typeof MODE_COMMAND_ALIASES;

export const AUTH_PREFERENCES = [
  {
    id: "chatgpt-login-goal",
    label: "ChatGPT login goal",
    description: "Design toward account-style sign-in without claiming it works as a backend today.",
  },
  {
    id: "api-key-first",
    label: "API key first",
    description: "Prefer official API credentials when native OpenAI support is added.",
  },
  {
    id: "runner-managed",
    label: "Ubume managed",
    description: "Rely on the core neural bridge to manage authentication.",
  },
] as const;

export type AuthPreference = (typeof AUTH_PREFERENCES)[number]["id"];

export function formatModeLabel(mode: string): string {
  const found = AVAILABLE_MODES.find((m) => m.key === mode);
  return found?.label ?? mode.toUpperCase();
}

export function resolveModeCommand(mode: string): AvailableMode | null {
  const normalized = mode.toLowerCase();
  const canonical = AVAILABLE_MODES.find((item) => item.key === normalized);
  if (canonical) {
    return canonical.key;
  }

  return MODE_COMMAND_ALIASES[normalized as ModeCommandAlias] ?? null;
}

export function formatModeCommandHelp(): string {
  return "plan, suggest, auto-edit, full-auto; aliases: default, ask, add, auto";
}

export function getNextMode(mode: AvailableMode): AvailableMode {
  const currentIndex = AVAILABLE_MODES.findIndex((item) => item.key === mode);
  if (currentIndex < 0) {
    return AVAILABLE_MODES[0].key;
  }

  return AVAILABLE_MODES[(currentIndex + 1) % AVAILABLE_MODES.length].key;
}

export interface RotatingModeState {
  mode: AvailableMode;
  planMode: boolean;
}

/**
 * Shift+Tab uses one predictable loop for planning and execution safety.
 * Plan is deliberately separate from `mode`: it forces a read-only planning
 * turn, while the selected execution mode is persisted for later runs.
 */
export function getNextRotatingMode(mode: AvailableMode, planMode: boolean): RotatingModeState {
  if (planMode) {
    return { mode: "suggest", planMode: false };
  }
  if (mode === "full-auto") {
    return { mode, planMode: true };
  }
  return { mode: getNextMode(mode), planMode: false };
}

export function formatBackendLabel(backend: string): string {
  const found = AVAILABLE_BACKENDS.find((item) => item.id === backend);
  return found?.label ?? backend;
}

export function formatReasoningLabel(reasoning: string): string {
  const found = AVAILABLE_REASONING_LEVELS.find((item) => item.id === reasoning);
  if (found) {
    return found.label;
  }

  return reasoning
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || reasoning;
}

export const AVAILABLE_THEMES = [
  { id: "dark", label: "Ubume Dark" },
  { id: "purple", label: "Midnight Purple" },
  { id: "mono", label: "Black & White" },
  { id: "black", label: "Codex the Black" },
  { id: "nordic", label: "Nordic Frost" },
  { id: "dracula", label: "Dracula Night" },
  { id: "gruvbox", label: "Gruvbox Hard" },
  { id: "ocean", label: "Deep Oceanic" },
  { id: "custom", label: "Customize..." },
] as const;

export type AvailableTheme = (typeof AVAILABLE_THEMES)[number]["id"];

export function formatThemeLabel(themeId: string): string {
  const found = AVAILABLE_THEMES.find((item) => item.id === themeId);
  return found?.label ?? themeId;
}

export function formatWorkspaceDisplayModeLabel(mode: WorkspaceDisplayMode): string {
  if (mode === "name") return "Name";
  if (mode === "simple") return "Simple";
  return "Dir";
}

export function formatTerminalTitleModeLabel(mode: TerminalTitleMode): string {
  return formatWorkspaceDisplayModeLabel(mode);
}

// Maps the old "normal" value (pre-rename) to the current "dir" equivalent.
export function normalizeLegacyDirectoryDisplayMode(mode: LegacyDirectoryDisplayMode): WorkspaceDisplayMode {
  return mode === "simple" ? "simple" : "dir";
}

export function formatDirectoryDisplayModeLabel(mode: WorkspaceDisplayMode | LegacyDirectoryDisplayMode): string {
  if (mode === "normal") return "Dir";
  return formatWorkspaceDisplayModeLabel(mode);
}

export function formatBusyLoaderSettingValue(enabled: boolean): BusyLoaderSettingValue {
  return enabled ? "true" : "false";
}

export function parseBusyLoaderSettingValue(value: string): boolean {
  return value === "true";
}

function formatWorkspaceLeaf(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    return trimmed;
  }

  const api = isWindowsStylePath(trimmed) ? win32 : { parse, basename };
  const { root } = api.parse(trimmed);
  let normalized = trimmed;
  // Stop at filesystem root — root.length > 0 prevents stripping the root itself
  while (normalized.length > root.length && /[\\/]+$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    return trimmed;
  }

  if (normalized === root) {
    return root || trimmed;
  }

  return api.basename(normalized) || normalized;
}

export function formatWorkspaceDisplayPath(
  workspaceRoot: string,
  workspaceDisplayMode: WorkspaceDisplayMode,
): string {
  if (workspaceDisplayMode === "name") {
    return APP_NAME;
  }

  return formatWorkspaceLeaf(workspaceRoot);
}

export function formatTerminalTitlePath(
  workspaceRoot: string,
  terminalTitleMode: TerminalTitleMode,
): string {
  if (terminalTitleMode === "name" || terminalTitleMode === "simple") {
    return APP_NAME;
  }

  return formatWorkspaceLeaf(workspaceRoot);
}

export interface HeaderConfig {
  showBrand: boolean;
  showWorkspace: boolean;
  showProvider: boolean;
  showModel: boolean;
  showReasoning: boolean;
  showContext: boolean;
  showAuthStatus: boolean;
}

export const HEADER_CONFIG_DEFAULTS: HeaderConfig = {
  showBrand: true,
  showWorkspace: true,
  showProvider: true,
  showModel: true,
  showReasoning: false,
  showContext: false,
  showAuthStatus: false,
};

export function getRecommendedReasoningForModel(model: AvailableModel): ReasoningLevel {
  return DEFAULT_REASONING_LEVEL;
}

export function normalizeReasoningForModel(
  model: AvailableModel,
  reasoningLevel: ReasoningLevel,
): ReasoningLevel {
  return reasoningLevel || getRecommendedReasoningForModel(model);
}

export function formatAuthPreferenceLabel(preference: string): string {
  const found = AUTH_PREFERENCES.find((item) => item.id === preference);
  return found?.label ?? preference;
}
