import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { SCRATCH_RELATIVE_DIR } from "./scratchDir.js";

export type RunFileOperation = "created" | "modified" | "deleted";
export type RunDiffLineKind = "added" | "removed";

export interface RunDiffLine {
  kind: RunDiffLineKind;
  text: string;
}

export interface RunFileActivity {
  path: string;
  operation: RunFileOperation;
  detectedAt: number;
  addedLines?: number;
  removedLines?: number;
  diffLines?: RunDiffLine[];
}

export interface RunActivitySummary {
  created: number;
  modified: number;
  deleted: number;
  totalActivityCount: number;
  recent: RunFileActivity[];
}

export interface WorkspaceActivityTracker {
  stop: () => void;
}

export interface WorkspaceActivityTrackerOptions {
  rootDir: string;
  onActivity: (activity: RunFileActivity[]) => void;
  pollIntervalMs?: number;
  initialSnapshot?: Map<string, WorkspaceFileSnapshot>;
}

export interface WorkspaceFileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  content?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 400;
const MAX_TRACKED_TEXT_BYTES = 128 * 1024;
const MAX_DIFFABLE_LINE_COUNT = 240;
const MAX_DIFF_PREVIEW_LINES = 6;
const MAX_SUMMARY_ACTIVITY_ITEMS = 6;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".turbo",
  ".vercel",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "temp",
  "tmp",
]);

const BINARY_EXTENSIONS = new Set([
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function shouldTrackTextContent(path: string, size: number): boolean {
  const lower = path.toLowerCase();
  const dotIndex = lower.lastIndexOf(".");
  const ext = dotIndex >= 0 ? lower.slice(dotIndex) : "";
  if (size > MAX_TRACKED_TEXT_BYTES) return false;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return true;
}

function readTrackedFileContent(path: string, size: number): string | undefined {
  if (!shouldTrackTextContent(path, size)) return undefined;

  const buffer = readFileSync(path);
  if (isBinaryBuffer(buffer)) return undefined;
  return buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

interface DiffOperation {
  kind: "equal" | RunDiffLineKind;
  text: string;
}

// LCS diff has O(n*m) complexity. Skip diffing for large files to avoid
// blocking the poll loop — callers treat null as "too large to diff".
function buildLineDiff(before: string[], after: string[]): DiffOperation[] | null {
  if (before.length + after.length > MAX_DIFFABLE_LINE_COUNT) {
    return null;
  }

  const rows = before.length + 1;
  const cols = after.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let col = after.length - 1; col >= 0; col -= 1) {
      if (before[row] === after[col]) {
        matrix[row]![col] = 1 + matrix[row + 1]![col + 1]!;
      } else {
        matrix[row]![col] = Math.max(matrix[row + 1]![col]!, matrix[row]![col + 1]!);
      }
    }
  }

  const operations: DiffOperation[] = [];
  let row = 0;
  let col = 0;
  while (row < before.length && col < after.length) {
    if (before[row] === after[col]) {
      operations.push({ kind: "equal", text: before[row]! });
      row += 1;
      col += 1;
      continue;
    }

    if (matrix[row + 1]![col]! >= matrix[row]![col + 1]!) {
      operations.push({ kind: "removed", text: before[row]! });
      row += 1;
    } else {
      operations.push({ kind: "added", text: after[col]! });
      col += 1;
    }
  }

  while (row < before.length) {
    operations.push({ kind: "removed", text: before[row]! });
    row += 1;
  }

  while (col < after.length) {
    operations.push({ kind: "added", text: after[col]! });
    col += 1;
  }

  return operations;
}

export function createTextDiffExcerpt(
  beforeContent: string,
  afterContent: string,
): Pick<RunFileActivity, "addedLines" | "removedLines" | "diffLines"> | null {
  const operations = buildLineDiff(splitTextLines(beforeContent), splitTextLines(afterContent));
  if (!operations) {
    return {
      addedLines: afterContent ? splitTextLines(afterContent).length : 0,
      removedLines: beforeContent ? splitTextLines(beforeContent).length : 0,
    };
  }

  const diffOperations = operations.filter(
    (operation) => operation.kind === "added" || operation.kind === "removed",
  );

  const diffLines: RunDiffLine[] = diffOperations
    .slice(0, MAX_DIFF_PREVIEW_LINES)
    .map((operation) => ({
      kind: operation.kind as RunDiffLineKind,
      text: operation.text,
    }));

  const addedLines = operations.filter((operation) => operation.kind === "added").length;
  const removedLines = operations.filter((operation) => operation.kind === "removed").length;

  if (addedLines === 0 && removedLines === 0) {
    return null;
  }

  return {
    addedLines,
    removedLines,
    diffLines,
  };
}

export function captureWorkspaceSnapshot(rootDir: string): Map<string, WorkspaceFileSnapshot> {
  const snapshot = new Map<string, WorkspaceFileSnapshot>();

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip directories we can't read (EPERM, locked temp dirs, etc.)
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name)) continue;
        const childDir = join(dir, entry.name);
        if (normalizePath(relative(rootDir, childDir)) === SCRATCH_RELATIVE_DIR) continue;
        walk(childDir);
        continue;
      }

      if (!entry.isFile()) continue;

      const fullPath = join(dir, entry.name);
      try {
        const stats = statSync(fullPath);
        const path = normalizePath(relative(rootDir, fullPath));
        snapshot.set(path, {
          path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          content: readTrackedFileContent(fullPath, stats.size),
        });
      } catch {
        // Skip files we can't stat (deleted between readdir and stat, etc.)
      }
    }
  }

  walk(rootDir);
  return snapshot;
}

export function diffWorkspaceSnapshots(
  previous: Map<string, WorkspaceFileSnapshot>,
  next: Map<string, WorkspaceFileSnapshot>,
  detectedAt = Date.now(),
): RunFileActivity[] {
  const activity: RunFileActivity[] = [];
  const allPaths = new Set([...previous.keys(), ...next.keys()]);

  for (const path of [...allPaths].sort()) {
    const before = previous.get(path);
    const after = next.get(path);

    if (!before && after) {
      const diff = createTextDiffExcerpt("", after.content ?? "");
      activity.push({
        path,
        operation: "created",
        detectedAt,
        addedLines: diff?.addedLines,
        removedLines: diff?.removedLines,
        diffLines: diff?.diffLines,
      });
      continue;
    }

    if (before && !after) {
      const diff = createTextDiffExcerpt(before.content ?? "", "");
      activity.push({
        path,
        operation: "deleted",
        detectedAt,
        addedLines: diff?.addedLines,
        removedLines: diff?.removedLines,
        diffLines: diff?.diffLines,
      });
      continue;
    }

    if (!before || !after) continue;

    const metadataChanged = before.mtimeMs !== after.mtimeMs || before.size !== after.size;
    const contentChanged = before.content !== after.content;
    if (!metadataChanged && !contentChanged) continue;

    const diff = before.content !== undefined && after.content !== undefined
      ? createTextDiffExcerpt(before.content, after.content)
      : undefined;

    activity.push({
      path,
      operation: "modified",
      detectedAt,
      addedLines: diff?.addedLines,
      removedLines: diff?.removedLines,
      diffLines: diff?.diffLines,
    });
  }

  return activity;
}

export function summarizeRunActivity(activity: RunFileActivity[]): RunActivitySummary | undefined {
  if (activity.length === 0) return undefined;

  let created = 0;
  let modified = 0;
  let deleted = 0;
  for (const item of activity) {
    if (item.operation === "created") created += 1;
    if (item.operation === "modified") modified += 1;
    if (item.operation === "deleted") deleted += 1;
  }

  return {
    created,
    modified,
    deleted,
    totalActivityCount: activity.length,
    recent: activity.slice(-MAX_SUMMARY_ACTIVITY_ITEMS),
  };
}

export function createWorkspaceActivityTracker(
  options: WorkspaceActivityTrackerOptions,
): WorkspaceActivityTracker {
  let stopped = false;
  let previous = options.initialSnapshot ?? captureWorkspaceSnapshot(options.rootDir);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const poll = () => {
    if (stopped) return;
    const next = captureWorkspaceSnapshot(options.rootDir);
    const activity = diffWorkspaceSnapshots(previous, next);
    previous = next;
    if (activity.length > 0) {
      options.onActivity(activity);
    }
  };

  const timer = setInterval(poll, pollIntervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
