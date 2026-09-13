import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maybeMigrateLegacyData,
  resetDataMigrationForTests,
  resolveLegacyCodexaDataDir,
  resolveUbumeDataDir,
  resolveUbumeAttachmentDir,
  resolveUbumeWorkspaceDataDir,
  workspaceStorageKey,
} from "./appData.js";

test("resolves Ubume data directories for supported platforms", () => {
  assert.equal(resolveUbumeDataDir("linux", {}, "/home/test"), join("/home/test", ".local", "share", "ubume"));
  assert.equal(resolveUbumeDataDir("linux", { XDG_DATA_HOME: "/xdg/data" }, "/home/test"), join("/xdg/data", "ubume"));
  assert.equal(resolveUbumeDataDir("darwin", {}, "/Users/test"), join("/Users/test", "Library", "Application Support", "Ubume"));
  assert.equal(resolveUbumeDataDir("win32", { LOCALAPPDATA: "C:/Users/test/AppData/Local" }, "C:/Users/test"), join("C:/Users/test/AppData/Local", "Ubume"));
});

test("UBUME_DATA_DIR overrides the platform default", () => {
  assert.equal(resolveUbumeDataDir("linux", { UBUME_DATA_DIR: "/custom/ubume" }, "/home/test"), "/custom/ubume");
  assert.equal(resolveUbumeDataDir("linux", { CODEXA_DATA_DIR: "/custom/codexa" }, "/home/test"), "/custom/codexa");
});

test("workspace data uses deterministic, isolated storage keys", () => {
  const first = workspaceStorageKey("/work/one");
  const second = workspaceStorageKey("/work/two");
  assert.equal(first, workspaceStorageKey("/work/one"));
  assert.notEqual(first, second);

  const previous = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = "/custom/ubume";
  try {
    assert.equal(resolveUbumeWorkspaceDataDir("/work/one"), join("/custom/ubume", "workspaces", first));
  } finally {
    if (previous === undefined) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previous;
  }
});

test("relative and legacy attachment directories resolve outside the workspace", () => {
  const previous = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = "/custom/ubume";
  try {
    assert.equal(resolveUbumeAttachmentDir("/work/one", "attachments"), join("/custom/ubume", "workspaces", workspaceStorageKey("/work/one"), "attachments"));
    assert.equal(resolveUbumeAttachmentDir("/work/one", ".ubume/attachments"), join("/custom/ubume", "workspaces", workspaceStorageKey("/work/one"), "attachments"));
    assert.equal(resolveUbumeAttachmentDir("/work/one", ".codexa/attachments"), join("/custom/ubume", "workspaces", workspaceStorageKey("/work/one"), "attachments"));
    assert.equal(resolveUbumeAttachmentDir("/work/one", "/tmp/attachments"), "/tmp/attachments");
  } finally {
    if (previous === undefined) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previous;
  }
});

test("safe non-destructive migration copies legacy Codexa data to Ubume without deleting old files", () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-migration-test-"));
  try {
    resetDataMigrationForTests();
    const legacyDir = resolveLegacyCodexaDataDir("linux", {}, tempHome);
    mkdirSync(join(legacyDir, "workspaces", "test-session"), { recursive: true });
    writeFileSync(join(legacyDir, "workspaces", "test-session", "chat.json"), JSON.stringify({ migrated: true }), "utf8");

    maybeMigrateLegacyData("linux", {}, tempHome);

    const ubumeDir = resolveUbumeDataDir("linux", {}, tempHome);
    assert.ok(existsSync(ubumeDir), "Ubume directory should be created");
    const migratedFile = join(ubumeDir, "workspaces", "test-session", "chat.json");
    assert.ok(existsSync(migratedFile), "Migrated file should exist in Ubume dir");
    assert.equal(JSON.parse(readFileSync(migratedFile, "utf8")).migrated, true);

    // Old data must NOT be deleted
    assert.ok(existsSync(join(legacyDir, "workspaces", "test-session", "chat.json")), "Legacy Codexa data should remain intact");
  } finally {
    resetDataMigrationForTests();
    rmSync(tempHome, { recursive: true, force: true });
  }
});
