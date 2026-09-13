import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeSessionScratchDir,
  ensureSessionScratchDir,
  mentionsScratchDir,
  pruneStaleScratchDirs,
  removeUnusedSessionScratchDir,
  resolveScratchRoot,
} from "./scratchDir.js";

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

test("describes a session scratch folder without creating anything", () => {
  const root = createTempWorkspace();
  try {
    const scratch = describeSessionScratchDir(root, "session-1");
    assert.equal(scratch.absolutePath, join(root, ".ubume", "scratch", "session-1"));
    assert.equal(scratch.relativePath, ".ubume/scratch/session-1");
    assert.equal(existsSync(join(root, ".ubume")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects session ids that could escape the scratch root", () => {
  const root = createTempWorkspace();
  try {
    assert.throws(() => ensureSessionScratchDir(root, "../escape"));
    assert.throws(() => describeSessionScratchDir(root, "../escape"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects tool paths and commands that target the scratch folder", () => {
  assert.equal(mentionsScratchDir(".ubume/scratch/session-1/_probe.html"), true);
  assert.equal(mentionsScratchDir("node .ubume/scratch/session-1/_cdp.js"), true);
  assert.equal(mentionsScratchDir(String.raw`node .ubume\scratch\session-1\_cdp.js`), true);
  assert.equal(mentionsScratchDir("index.html"), false);
  assert.equal(mentionsScratchDir("git status"), false);
});

test("removes an unused session folder and the Ubume tree it left behind", () => {
  const root = createTempWorkspace();
  try {
    ensureSessionScratchDir(root, "session-1");
    removeUnusedSessionScratchDir(root, "session-1");
    assert.equal(existsSync(join(root, ".ubume")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a session folder that holds files", () => {
  const root = createTempWorkspace();
  try {
    const scratch = ensureSessionScratchDir(root, "session-1");
    writeFileSync(join(scratch.absolutePath, "_probe.html"), "<html></html>\n", "utf8");
    removeUnusedSessionScratchDir(root, "session-1");
    assert.ok(existsSync(join(scratch.absolutePath, "_probe.html")));
    assert.ok(existsSync(join(resolveScratchRoot(root), ".gitignore")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the scratch root while another session still uses it", () => {
  const root = createTempWorkspace();
  try {
    ensureSessionScratchDir(root, "session-1");
    ensureSessionScratchDir(root, "session-2");
    removeUnusedSessionScratchDir(root, "session-1");
    assert.equal(existsSync(join(resolveScratchRoot(root), "session-1")), false);
    assert.ok(existsSync(join(resolveScratchRoot(root), "session-2")));
    assert.ok(existsSync(join(resolveScratchRoot(root), ".gitignore")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves a .ubume folder that holds other files", () => {
  const root = createTempWorkspace();
  try {
    ensureSessionScratchDir(root, "session-1");
    writeFileSync(join(root, ".ubume", "notes.md"), "keep\n", "utf8");
    removeUnusedSessionScratchDir(root, "session-1");
    assert.equal(existsSync(resolveScratchRoot(root)), false);
    assert.ok(existsSync(join(root, ".ubume", "notes.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing scratch from a workspace that never had one is a no-op", () => {
  const root = createTempWorkspace();
  try {
    removeUnusedSessionScratchDir(root, "session-1");
    assert.equal(existsSync(join(root, ".ubume")), false);
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
