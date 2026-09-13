import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGeminiSpawnSpec, resetGeminiExecutableCacheForTests, resolveGeminiExecutable } from "./geminiExecutable.js";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function mockRunCommand(onCall: (spec: Parameters<typeof runCommand>[0]) => CommandResult): typeof runCommand {
  return ((spec) => ({
    child: null as unknown as ChildProcess,
    result: Promise.resolve(onCall(spec)),
    cancel: () => undefined,
  })) as typeof runCommand;
}

async function withEnv<T>(env: Partial<NodeJS.ProcessEnv>, callback: () => Promise<T>): Promise<T> {
  const originalExecutable = process.env.GEMINI_EXECUTABLE;
  const originalCliPath = process.env.GEMINI_CLI_PATH;
  const originalAppData = process.env.APPDATA;
  try {
    if ("GEMINI_EXECUTABLE" in env) process.env.GEMINI_EXECUTABLE = env.GEMINI_EXECUTABLE;
    else delete process.env.GEMINI_EXECUTABLE;
    if ("GEMINI_CLI_PATH" in env) process.env.GEMINI_CLI_PATH = env.GEMINI_CLI_PATH;
    else delete process.env.GEMINI_CLI_PATH;
    if ("APPDATA" in env) process.env.APPDATA = env.APPDATA;
    resetGeminiExecutableCacheForTests();
    return await callback();
  } finally {
    if (originalExecutable === undefined) delete process.env.GEMINI_EXECUTABLE;
    else process.env.GEMINI_EXECUTABLE = originalExecutable;
    if (originalCliPath === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = originalCliPath;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    resetGeminiExecutableCacheForTests();
  }
}

test("Gemini resolver: env GEMINI_EXECUTABLE wins over PATH", async () => {
  await withEnv({ GEMINI_EXECUTABLE: "env-gemini.cmd" }, async () => {
    let whereCalled = false;
    const resolved = await resolveGeminiExecutable({
      runCommandImpl: mockRunCommand((spec) => {
        if (spec.executable === "where.exe") whereCalled = true;
        return commandResult({ stdout: "C:\\Tools\\gemini.cmd\n" });
      }),
    });

    assert.equal(resolved, "env-gemini.cmd");
    assert.equal(whereCalled, false);
  });
});

test("Gemini resolver: APPDATA npm shim fallback works", async () => {
  if (process.platform !== "win32") return;
  const tempRoot = join(tmpdir(), `ubume-gemini-${Date.now()}`);
  const npmDir = join(tempRoot, "npm");
  const shim = join(npmDir, "gemini.cmd");
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(shim, "@echo off\r\n", "utf-8");

  try {
    await withEnv({ APPDATA: tempRoot }, async () => {
      const resolved = await resolveGeminiExecutable({
        runCommandImpl: mockRunCommand(() => commandResult({ status: "failed", exitCode: 1 })),
      });
      assert.equal(resolved, shim);
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Gemini resolver: PowerShell function text is not accepted as executable path", async () => {
  if (process.platform !== "win32") return;
  await withEnv({}, async () => {
    const tempRoot = join(tmpdir(), `ubume-gemini-real-${Date.now()}`);
    const npmDir = join(tempRoot, "npm");
    const shim = join(npmDir, "gemini.cmd");
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(shim, "@echo off\r\n", "utf-8");
    process.env.APPDATA = tempRoot;
    try {
      const resolved = await resolveGeminiExecutable({
        runCommandImpl: mockRunCommand(() => commandResult({ stdout: "function gemini { param($p) }\n" })),
      });
      assert.equal(resolved, shim);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("Gemini spawn spec bypasses PowerShell and targets the resolved executable", () => {
  const spec = buildGeminiSpawnSpec("C:\\Users\\Example\\AppData\\Roaming\\npm\\gemini.cmd", ["-p", "Respond with READY only."]);
  assert.equal(spec.executable, "C:\\Users\\Example\\AppData\\Roaming\\npm\\gemini.cmd");
  assert.deepEqual(spec.args, ["-p", "Respond with READY only."]);
  assert.equal(spec.shell, undefined);
});
