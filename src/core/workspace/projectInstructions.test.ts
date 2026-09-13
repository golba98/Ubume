import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectInstructions } from "./projectInstructions.js";

function withTempWorkspace(run: (workspaceRoot: string) => void) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ubume-instructions-"));
  try {
    run(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test("loads AGENTS.md from the workspace root first", () => {
  withTempWorkspace((workspaceRoot) => {
    mkdirSync(join(workspaceRoot, ".codex"), { recursive: true });
    writeFileSync(join(workspaceRoot, "AGENTS.md"), "root instructions\n", "utf8");
    writeFileSync(join(workspaceRoot, ".codex", "AGENTS.md"), "nested instructions\n", "utf8");

    const result = loadProjectInstructions(workspaceRoot);

    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(result.instructions.content, "root instructions");
    assert.match(result.instructions.path, /AGENTS\.md$/);
  });
});

test("falls back to .codex/AGENTS.md", () => {
  withTempWorkspace((workspaceRoot) => {
    mkdirSync(join(workspaceRoot, ".codex"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".codex", "AGENTS.md"), "project instructions\n", "utf8");

    const result = loadProjectInstructions(workspaceRoot);

    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(result.instructions.content, "project instructions");
    assert.match(result.instructions.path, /\.codex[\\/]AGENTS\.md$/);
  });
});

test("treats missing instruction files as non-fatal", () => {
  withTempWorkspace((workspaceRoot) => {
    assert.deepEqual(loadProjectInstructions(workspaceRoot), { status: "missing" });
  });
});
