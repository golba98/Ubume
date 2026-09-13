import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Workspace-relative home for agent throwaway files (test harnesses, probe scripts, logs). */
export const SCRATCH_RELATIVE_DIR = ".ubume/scratch";
export const LEGACY_SCRATCH_RELATIVE_DIR = ".codexa/scratch";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SCRATCH_GITIGNORE = ".gitignore";

export interface SessionScratchDir {
  absolutePath: string;
  relativePath: string;
}

export function resolveScratchRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".ubume", "scratch");
}

export function resolveLegacyScratchRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".codexa", "scratch");
}

/** Name the session scratch folder without touching the filesystem. */
export function describeSessionScratchDir(workspaceRoot: string, sessionId: string): SessionScratchDir {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`Unsafe scratch session id: ${sessionId}`);
  return {
    absolutePath: join(resolveScratchRoot(workspaceRoot), sessionId),
    relativePath: `${SCRATCH_RELATIVE_DIR}/${sessionId}`,
  };
}

/** True when a tool path or shell command targets the workspace scratch folder. */
export function mentionsScratchDir(value: string): boolean {
  return value.replace(/\\/g, "/").includes(SCRATCH_RELATIVE_DIR);
}

/**
 * Create `.ubume/scratch/<sessionId>` inside the workspace. The scratch root
 * carries its own `*` .gitignore so git ignores it without touching the
 * project's ignore rules. It lives in the workspace (not the OS temp dir)
 * because sandboxed shells only get a persistent writable workspace. Call it
 * only once a tool actually targets the folder, so unused sessions leave no
 * trace in the project.
 */
export function ensureSessionScratchDir(workspaceRoot: string, sessionId: string): SessionScratchDir {
  const scratch = describeSessionScratchDir(workspaceRoot, sessionId);
  const root = resolveScratchRoot(workspaceRoot);
  mkdirSync(root, { recursive: true });
  const gitignore = join(root, SCRATCH_GITIGNORE);
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");
  mkdirSync(scratch.absolutePath, { recursive: true });
  return scratch;
}

function removeDirIfEmpty(dir: string, ignoredEntries: readonly string[] = []): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.some((entry) => !ignoredEntries.includes(entry))) return false;
  for (const entry of entries) rmSync(join(dir, entry), { force: true });
  rmdirSync(dir);
  return true;
}

/**
 * Best-effort removal of an empty session scratch folder, then of the
 * `.ubume/scratch` root (when only its .gitignore remains) and `.ubume`
 * (when nothing else lives there), so a session that never used scratch
 * leaves the project untouched.
 */
export function removeUnusedSessionScratchDir(workspaceRoot: string, sessionId: string): void {
  try {
    const scratch = describeSessionScratchDir(workspaceRoot, sessionId);
    if (existsSync(scratch.absolutePath) && !removeDirIfEmpty(scratch.absolutePath)) return;
    const root = resolveScratchRoot(workspaceRoot);
    if (!removeDirIfEmpty(root, [SCRATCH_GITIGNORE])) return;
    removeDirIfEmpty(join(workspaceRoot, ".ubume"));
  } catch {
    // A locked or vanished folder must not break the run that triggered cleanup.
  }
}

/** Best-effort removal of session scratch folders older than `maxAgeMs`. */
export function pruneStaleScratchDirs(
  workspaceRoot: string,
  options: { keep?: string; maxAgeMs?: number; now?: number } = {},
): void {
  for (const root of [resolveScratchRoot(workspaceRoot), resolveLegacyScratchRoot(workspaceRoot)]) {
    const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === options.keep) continue;
      const dir = join(root, entry.name);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {
        // A locked or vanished folder must not break the run that triggered pruning.
      }
    }
  }
}
