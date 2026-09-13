import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isNoiseLine } from "../providers/codexTranscript.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { resolveUbumeDataDir } from "./appData.js";

type Platform = "win32" | "darwin" | "linux" | string;

const SECTION_LINE_RE = /^\s*(?:#{1,3}\s+)?(?:\*\*)?([A-Za-z][A-Za-z0-9 /&-]{0,48})(?:\*\*)?:?\s*$/;
const ABSOLUTE_WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s`),;\]]+/g;

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  if (!search) return value;
  return value.split(search).join(replacement);
}

/**
 * Strips absolute filesystem paths from plan text, replacing them with
 * relative paths or truncated versions to protect user privacy.
 */
export function hidePlanReviewFilesystemDetails(planText: string, workspaceRoot?: string | null): string {
  let output = planText;
  const normalizedRoot = workspaceRoot?.trim() ? normalizePathSeparators(workspaceRoot.trim()).replace(/\/+$/, "") : "";

  if (normalizedRoot) {
    output = replaceAllLiteral(output, workspaceRoot!.replace(/\\+$/, ""), "");
    output = replaceAllLiteral(normalizePathSeparators(output), normalizedRoot, "");
    output = output.replace(/(^|[\s(`])\/+([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g, "$1$2");
  }

  return output.replace(ABSOLUTE_WINDOWS_PATH_RE, (match) => {
    const normalized = normalizePathSeparators(match);
    const srcIndex = normalized.search(/(?:^|\/)(src|test|tests|docs|scripts|bin)\//);
    if (srcIndex >= 0) {
      return normalized.slice(normalized[srcIndex] === "/" ? srcIndex + 1 : srcIndex);
    }
    const parts = normalized.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || match;
  });
}

/**
 * Normalizes plan markdown for consistent rendering, converting bold labels
 * into proper headings and hiding filesystem details.
 */
export function normalizePlanReviewMarkdown(planText: string, workspaceRoot?: string | null): string {
  const sanitized = sanitizeTerminalOutput(hidePlanReviewFilesystemDetails(planText, workspaceRoot), {
    preserveTabs: false,
    tabSize: 2,
  })
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .split("\n")
    .filter((line) => !isNoiseLine(line))
    .join("\n");

  return sanitized
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const sectionMatch = SECTION_LINE_RE.exec(trimmed);
      if (sectionMatch && !/^[-*]\s+/.test(trimmed) && !/^\d+\.\s+/.test(trimmed)) {
        return `## ${sectionMatch[1]!.trim()}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Resolve the directory where plan files are stored.
 * Uses platform-appropriate app-data locations instead of the workspace.
 */
export function resolvePlanDir(platformOverride?: Platform): string {
  const envDir = process.env["UBUME_PLAN_DIR"] || process.env["CODEXA_PLAN_DIR"];
  if (envDir) return envDir;

  const platform = platformOverride ?? process.platform;

  if (platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) return join(localAppData, "Ubume", "plans");
    const appData = process.env["APPDATA"];
    if (appData) return join(appData, "Ubume", "plans");
    return join(homedir(), "AppData", "Local", "Ubume", "plans");
  }

  return join(resolveUbumeDataDir(platform), "plans");
}

// SHA-256 of the workspace path ensures filename uniqueness across projects with the same name.
function workspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 8);
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Save plan content to the app-data plan directory.
 * Returns the written file path, or null on failure.
 */
export function savePlan(content: string, workspaceRoot: string): string | null {
  try {
    const dir = resolvePlanDir();
    mkdirSync(dir, { recursive: true });
    const filename = `plan-${safeTimestamp()}-${workspaceHash(workspaceRoot)}.md`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Read plan content from a file path.
 * Returns the content string, or null on failure.
 */
export function readPlan(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
