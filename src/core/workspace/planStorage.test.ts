import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolvePlanDir, savePlan, readPlan } from "./planStorage.js";

describe("resolvePlanDir", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["UBUME_PLAN_DIR", "CODEXA_PLAN_DIR", "LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME"];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("UBUME_PLAN_DIR override takes priority", () => {
    process.env["UBUME_PLAN_DIR"] = "/custom/plan/dir";
    assert.equal(resolvePlanDir(), "/custom/plan/dir");
  });

  test("CODEXA_PLAN_DIR fallback override works", () => {
    delete process.env["UBUME_PLAN_DIR"];
    process.env["CODEXA_PLAN_DIR"] = "/custom/codexa/dir";
    assert.equal(resolvePlanDir(), "/custom/codexa/dir");
  });

  test("Windows LOCALAPPDATA path resolution", () => {
    delete process.env["UBUME_PLAN_DIR"];
    delete process.env["CODEXA_PLAN_DIR"];
    process.env["LOCALAPPDATA"] = "C:\\Users\\test\\AppData\\Local";
    const result = resolvePlanDir("win32");
    assert.ok(result.includes("Ubume"));
    assert.ok(result.includes("plans"));
    assert.ok(result.includes("AppData"));
  });

  test("Windows APPDATA fallback", () => {
    delete process.env["UBUME_PLAN_DIR"];
    delete process.env["CODEXA_PLAN_DIR"];
    delete process.env["LOCALAPPDATA"];
    process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
    const result = resolvePlanDir("win32");
    assert.ok(result.includes("Ubume"));
    assert.ok(result.includes("plans"));
    assert.ok(result.includes("Roaming"));
  });

  test("macOS path", () => {
    delete process.env["UBUME_PLAN_DIR"];
    delete process.env["CODEXA_PLAN_DIR"];
    const result = resolvePlanDir("darwin");
    assert.ok(result.includes("Library"));
    assert.ok(result.includes("Ubume"));
    assert.ok(result.includes("plans"));
  });

  test("Linux default path", () => {
    delete process.env["UBUME_PLAN_DIR"];
    delete process.env["CODEXA_PLAN_DIR"];
    delete process.env["XDG_DATA_HOME"];
    const result = resolvePlanDir("linux");
    assert.ok(result.includes(".local"));
    assert.ok(result.includes("share"));
    assert.ok(result.includes("ubume"));
    assert.ok(result.includes("plans"));
  });

  test("Linux XDG_DATA_HOME override", () => {
    delete process.env["UBUME_PLAN_DIR"];
    delete process.env["CODEXA_PLAN_DIR"];
    process.env["XDG_DATA_HOME"] = "/custom/xdg/data";
    const result = resolvePlanDir("linux");
    assert.ok(result.includes("custom"));
    assert.ok(result.includes("xdg"));
    assert.ok(result.includes("ubume"));
    assert.ok(result.includes("plans"));
  });
});

describe("savePlan", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `planStorage-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    process.env["UBUME_PLAN_DIR"] = tempDir;
  });

  afterEach(() => {
    delete process.env["UBUME_PLAN_DIR"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("safe filename format with timestamp and 8-hex-char hash", () => {
    const result = savePlan("# My Plan", "/some/workspace");
    assert.notEqual(result, null);
    const filename = result!.split(/[/\\]/).pop()!;
    assert.match(filename, /^plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*-[0-9a-f]{8}\.md$/);
  });

  test("written content can be read back", () => {
    const content = "# Test Plan\n\n- Step 1\n- Step 2\n";
    const result = savePlan(content, "/workspace");
    assert.notEqual(result, null);
    assert.ok(existsSync(result!));
    assert.equal(readPlan(result!), content);
  });

  test("write failure returns null", () => {
    process.env["UBUME_PLAN_DIR"] = "/nonexistent\x00/bad/path";
    const result = savePlan("content", "/workspace");
    assert.equal(result, null);
  });

  test("does not write to process.cwd()", () => {
    const cwdPlanDir = join(process.cwd(), ".ubume");
    const beforeMarkdown = existsSync(cwdPlanDir)
      ? readdirSync(cwdPlanDir).filter((name) => name.endsWith(".md")).sort()
      : [];
    savePlan("# Plan", process.cwd());
    const afterMarkdown = existsSync(cwdPlanDir)
      ? readdirSync(cwdPlanDir).filter((name) => name.endsWith(".md")).sort()
      : [];
    assert.deepEqual(afterMarkdown, beforeMarkdown);
  });
});

describe("readPlan", () => {
  test("returns null for missing file", () => {
    assert.equal(readPlan("/nonexistent/file.md"), null);
  });

  test("reads existing file content", () => {
    const tempFile = join(tmpdir(), `plan-read-test-${Date.now()}.md`);
    writeFileSync(tempFile, "hello plan", "utf-8");
    try {
      assert.equal(readPlan(tempFile), "hello plan");
    } finally {
      rmSync(tempFile, { force: true });
    }
  });
});
