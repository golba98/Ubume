import { createHash } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

type Platform = "win32" | "darwin" | "linux" | string;
type Environment = Record<string, string | undefined>;

export function resolveLegacyCodexaDataDir(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = homedir(),
): string {
  const configuredDir = env["CODEXA_DATA_DIR"]?.trim();
  if (configuredDir) return configuredDir;

  const platform = platformOverride ?? process.platform;
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"]?.trim() || env["APPDATA"]?.trim() || join(home, "AppData", "Local"), "Codexa");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Codexa");
  }

  return join(env["XDG_DATA_HOME"]?.trim() || join(home, ".local", "share"), "codexa");
}

export function resolveUbumeDataDir(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = homedir(),
): string {
  const configuredDir = env["UBUME_DATA_DIR"]?.trim() || env["CODEXA_DATA_DIR"]?.trim();
  if (configuredDir) return configuredDir;

  const platform = platformOverride ?? process.platform;
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"]?.trim() || env["APPDATA"]?.trim() || join(home, "AppData", "Local"), "Ubume");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Ubume");
  }

  return join(env["XDG_DATA_HOME"]?.trim() || join(home, ".local", "share"), "ubume");
}

let dataMigrated = false;

export function maybeMigrateLegacyData(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = homedir(),
): void {
  if (dataMigrated) return;
  dataMigrated = true;

  try {
    const ubumeDir = resolveUbumeDataDir(platformOverride, env, home);
    const legacyDir = resolveLegacyCodexaDataDir(platformOverride, env, home);

    if (ubumeDir !== legacyDir && !existsSync(ubumeDir) && existsSync(legacyDir)) {
      // Safe non-destructive one-time copy
      cpSync(legacyDir, ubumeDir, { recursive: true });
    }
  } catch {
    // Non-destructive best-effort migration
  }
}

export function resetDataMigrationForTests(): void {
  dataMigrated = false;
}

export function workspaceStorageKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

export function resolveUbumeWorkspaceDataDir(workspaceRoot: string): string {
  maybeMigrateLegacyData();
  return join(resolveUbumeDataDir(), "workspaces", workspaceStorageKey(workspaceRoot));
}

export function resolveUbumeConversationDir(workspaceRoot: string): string {
  return join(resolveUbumeWorkspaceDataDir(workspaceRoot), "conversations");
}

export function resolveUbumeAttachmentDir(workspaceRoot: string, configuredDir: string): string {
  if (isAbsolute(configuredDir)) return configuredDir;

  const normalized = configuredDir
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.(?:ubume|codexa)\/?/, "") || "attachments";
  const safeRelativeDir = normalize(normalized).replace(/^(\.\.([/\\]|$))+/, "") || "attachments";
  return join(resolveUbumeWorkspaceDataDir(workspaceRoot), safeRelativeDir);
}

export function resolveUbumeDebugLogPath(env: Environment = process.env): string {
  return join(resolveUbumeDataDir(undefined, env), "debug", "render-status.log");
}

// Backwards-compatible aliases
export const resolveCodexaDataDir = resolveUbumeDataDir;
export const resolveCodexaWorkspaceDataDir = resolveUbumeWorkspaceDataDir;
export const resolveCodexaConversationDir = resolveUbumeConversationDir;
export const resolveCodexaAttachmentDir = resolveUbumeAttachmentDir;
export const resolveCodexaDebugLogPath = resolveUbumeDebugLogPath;
