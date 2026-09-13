import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import {
  captureWorkspaceSnapshot,
  createWorkspaceActivityTracker,
  createTextDiffExcerpt,
  diffWorkspaceSnapshots,
} from "./workspaceActivity.js";

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "codex-workspace-activity-"));
}

test("detects created files in the workspace snapshot diff", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    writeFileSync(join(root, "new-file.ts"), "const value = 1;\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 123);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "created");
    assert.equal(activity[0]?.path, "new-file.ts");
    assert.equal(activity[0]?.addedLines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects modified files with diff preview", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "edited.py");
    writeFileSync(file, "print('before')\nvalue = 1\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(file, "print('after')\nvalue = 2\nextra = True\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 456);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "modified");
    assert.equal(activity[0]?.path, "edited.py");
    assert.equal(activity[0]?.addedLines, 3);
    assert.equal(activity[0]?.removedLines, 2);
    assert.equal(activity[0]?.diffLines?.[0]?.kind, "removed");
    assert.equal(activity[0]?.diffLines?.at(-1)?.kind, "added");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects deleted files", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "gone.txt");
    writeFileSync(file, "goodbye\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    unlinkSync(file);
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 789);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "deleted");
    assert.equal(activity[0]?.path, "gone.txt");
    assert.equal(activity[0]?.removedLines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores excluded directories like node_modules and .git", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ignored.js"), "console.log('x')", "utf8");
    writeFileSync(join(root, ".git", "ignored.txt"), "internal", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 111);

    assert.equal(activity.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace activity tracker can reuse a provided initial snapshot", async () => {
  const root = createTempWorkspace();
  try {
    writeFileSync(join(root, "edited.txt"), "before\n", "utf8");
    writeFileSync(join(root, "gone.txt"), "delete me\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(join(root, "new-file.ts"), "const value = 1;\n", "utf8");
    writeFileSync(join(root, "edited.txt"), "after\n", "utf8");
    unlinkSync(join(root, "gone.txt"));

    const activity = await new Promise<ReturnType<typeof diffWorkspaceSnapshots>>((resolve, reject) => {
      let tracker: ReturnType<typeof createWorkspaceActivityTracker> | null = null;
      const timeout = setTimeout(() => {
        tracker?.stop();
        reject(new Error("Timed out waiting for workspace activity."));
      }, 500);
      tracker = createWorkspaceActivityTracker({
        rootDir: root,
        initialSnapshot: before,
        pollIntervalMs: 10,
        onActivity: (items) => {
          clearTimeout(timeout);
          tracker?.stop();
          resolve(items);
        },
      });
    });

    const operationsByPath = new Map(activity.map((item) => [item.path, item.operation]));
    assert.equal(operationsByPath.get("new-file.ts"), "created");
    assert.equal(operationsByPath.get("edited.txt"), "modified");
    assert.equal(operationsByPath.get("gone.txt"), "deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips inline diff previews for oversized files", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "large.txt");
    const largeContent = `${"a".repeat(129 * 1024)}\n`;
    writeFileSync(file, largeContent, "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(file, `${largeContent}tail\n`, "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 222);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "modified");
    assert.equal(activity[0]?.diffLines, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates green/red diff excerpts for mixed edits", () => {
  const diff = createTextDiffExcerpt(
    ["alpha", "beta", "gamma"].join("\n"),
    ["alpha", "beta-2", "gamma", "delta"].join("\n"),
  );

  assert(diff);
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 1);
  assert.equal(diff.diffLines?.some((line) => line.kind === "added"), true);
  assert.equal(diff.diffLines?.some((line) => line.kind === "removed"), true);
});

test("ignores agent scratch files under .ubume/scratch", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    mkdirSync(join(root, ".ubume", "scratch", "session-1"), { recursive: true });
    writeFileSync(join(root, ".ubume", "scratch", "session-1", "_test_harness.html"), "<html></html>\n", "utf8");
    writeFileSync(join(root, "index.html"), "<html></html>\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 789);

    assert.deepEqual(activity.map((item) => item.path), ["index.html"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
