import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureSessionScratchDir, pruneStaleScratchDirs, resolveScratchRoot } from "./scratchDir.js";

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ubume-scratch-"));
}

test("creates a self-gitignored session scratch folder inside the workspace", () => {
  const root = createTempWorkspace();
  try {
    const scratch = ensureSessionScratchDir(root, "session-1");
    assert.equal(scratch.absolutePath, join(root, ".ubume", "scratch", "session-1"));
    assert.equal(scratch.relativePath, ".ubume/scratch/session-1");
    assert.ok(existsSync(scratch.absolutePath));
    assert.equal(readFileSync(join(resolveScratchRoot(root), ".gitignore"), "utf8"), "*\n");
    assert.deepEqual(ensureSessionScratchDir(root, "session-1"), scratch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects session ids that could escape the scratch root", () => {
  const root = createTempWorkspace();
  try {
    assert.throws(() => ensureSessionScratchDir(root, "../escape"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prunes stale session folders but keeps the active and fresh ones", () => {
  const root = createTempWorkspace();
  try {
    const scratchRoot = resolveScratchRoot(root);
    ensureSessionScratchDir(root, "active");
    for (const name of ["active", "stale", "fresh"]) mkdirSync(join(scratchRoot, name), { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(scratchRoot, "stale"), old, old);
    utimesSync(join(scratchRoot, "active"), old, old);

    pruneStaleScratchDirs(root, { keep: "active" });

    assert.equal(existsSync(join(scratchRoot, "stale")), false);
    assert.ok(existsSync(join(scratchRoot, "active")));
    assert.ok(existsSync(join(scratchRoot, "fresh")));
    assert.ok(existsSync(join(scratchRoot, ".gitignore")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruning a workspace without a scratch folder is a no-op", () => {
  const root = createTempWorkspace();
  try {
    pruneStaleScratchDirs(root);
    assert.equal(existsSync(resolveScratchRoot(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
