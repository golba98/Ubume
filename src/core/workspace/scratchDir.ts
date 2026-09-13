import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Workspace-relative home for agent throwaway files (test harnesses, probe scripts, logs). */
export const SCRATCH_RELATIVE_DIR = ".ubume/scratch";
export const LEGACY_SCRATCH_RELATIVE_DIR = ".codexa/scratch";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

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

/**
 * Create `.ubume/scratch/<sessionId>` inside the workspace. The scratch root
 * carries its own `*` .gitignore so git ignores it without touching the
 * project's ignore rules. It lives in the workspace (not the OS temp dir)
 * because sandboxed shells only get a persistent writable workspace.
 */
export function ensureSessionScratchDir(workspaceRoot: string, sessionId: string): SessionScratchDir {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`Unsafe scratch session id: ${sessionId}`);
  const root = resolveScratchRoot(workspaceRoot);
  mkdirSync(root, { recursive: true });
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");
  const absolutePath = join(root, sessionId);
  mkdirSync(absolutePath, { recursive: true });
  return { absolutePath, relativePath: `${SCRATCH_RELATIVE_DIR}/${sessionId}` };
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
