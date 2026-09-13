import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import { resolveExecutable, buildSpawnSpec } from "./executableResolver.js";

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

function mockRunCommand(result: CommandResult, onCall?: (spec: Parameters<typeof runCommand>[0]) => void): typeof runCommand {
  return ((spec) => {
    onCall?.(spec);
    return {
      child: null as unknown as ChildProcess,
      result: Promise.resolve(result),
      cancel: () => undefined,
    };
  }) as typeof runCommand;
}

async function withEnv<T>(env: Partial<NodeJS.ProcessEnv>, callback: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolver: uses configuredPath", async () => {
  const resolved = await resolveExecutable({
    commandNames: ["test"],
    label: "test",
    configuredPath: process.execPath,
  });
  assert.equal(resolved, process.execPath);
});

test("resolver: uses environment override", async () => {
  const original = process.env.TEST_EXECUTABLE;
  process.env.TEST_EXECUTABLE = "custom-test";
  try {
    const resolved = await resolveExecutable({
      commandNames: ["test"],
      label: "test",
      envOverrides: ["TEST_EXECUTABLE"],
    });
    assert.equal(resolved, "custom-test");
  } finally {
    if (original === undefined) delete process.env.TEST_EXECUTABLE;
    else process.env.TEST_EXECUTABLE = original;
  }
});

test("resolver: rejects environment override with shell metacharacters", async () => {
  const original = process.env.TEST_EXECUTABLE;
  process.env.TEST_EXECUTABLE = "custom-test & calc";
  try {
    await assert.rejects(
      () => resolveExecutable({
        commandNames: ["test"],
        label: "test",
        envOverrides: ["TEST_EXECUTABLE"],
      }),
      /shell metacharacters|single executable name/i,
    );
  } finally {
    if (original === undefined) delete process.env.TEST_EXECUTABLE;
    else process.env.TEST_EXECUTABLE = original;
  }
});

test("resolver: rejects malicious environment executable candidates", async () => {
  const unsafeExecutables = [
    "codex; echo hacked",
    "codex && echo hacked",
    "codex | echo hacked",
    "codex $(echo hacked)",
    "codex --dangerous-extra-arg",
    "codex.cmd & echo hacked",
  ];

  for (const executable of unsafeExecutables) {
    await withEnv({ TEST_EXECUTABLE: executable }, async () => {
      await assert.rejects(
        () => resolveExecutable({
          commandNames: ["test"],
          label: "test",
          envOverrides: ["TEST_EXECUTABLE"],
        }),
        /shell metacharacters|single executable name/i,
        executable,
      );
    });
  }
});

test("resolver: rejects configured executable values that include arguments", async () => {
  await assert.rejects(
    () => resolveExecutable({
      commandNames: ["test"],
      label: "test",
      configuredPath: "test --version",
    }),
    /single executable name/i,
  );
});

test("resolver: accepts quoted executable paths with spaces", async () => {
  const tempRoot = join(tmpdir(), `ubume resolver ${Date.now()}`);
  const executablePath = join(tempRoot, "tool with spaces.exe");
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(executablePath, "");
  try {
    const resolved = await resolveExecutable({
      commandNames: ["test"],
      label: "test",
      configuredPath: `"${executablePath}"`,
    });
    assert.equal(resolved, executablePath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolver: falls back to bare name if not found", async () => {
  const mockImpl = mockRunCommand(commandResult({ status: "failed", exitCode: 1 }));
  const resolved = await resolveExecutable({
    runCommandImpl: mockImpl,
    commandNames: ["mytest"],
    label: "test",
  });
  assert.equal(resolved, "mytest");
});

test("resolver: ignores unsafe where.exe output", async () => {
  const resolved = await resolveExecutable({
    runCommandImpl: mockRunCommand(commandResult({ stdout: "codex.cmd & echo hacked\n" })),
    commandNames: ["test"],
    label: "test",
  });

  assert.equal(resolved, "test");
});

test("buildSpawnSpec rejects unsafe executable candidates", () => {
  const unsafeExecutables = [
    "codex; echo hacked",
    "codex && echo hacked",
    "codex | echo hacked",
    "codex $(echo hacked)",
    "codex --dangerous-extra-arg",
    "codex.cmd & echo hacked",
  ];

  for (const executable of unsafeExecutables) {
    assert.throws(
      () => buildSpawnSpec(executable, []),
      /shell metacharacters|single executable name/i,
      executable,
    );
  }
});

// The Windows wrapping branch is driven by an injected platform so it runs on any OS.
test("buildSpawnSpec: wraps .cmd files in cmd.exe on Windows", () => {
  const spec = buildSpawnSpec("test.cmd", ["arg1"], "win32");
  assert.equal(spec.executable, "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "call", "test.cmd", "arg1"]);
});

test("buildSpawnSpec: wraps .bat files in cmd.exe on Windows", () => {
  const spec = buildSpawnSpec("test.bat", ["arg1"], "win32");
  assert.equal(spec.executable, "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "call", "test.bat", "arg1"]);
});

test("buildSpawnSpec: does not wrap .exe files on Windows", () => {
  const spec = buildSpawnSpec("test.exe", ["arg1"], "win32");
  assert.equal(spec.executable, "test.exe");
  assert.deepEqual(spec.args, ["arg1"]);
});

test("buildSpawnSpec: passes .cmd through unwrapped on non-Windows", () => {
  const spec = buildSpawnSpec("test.cmd", ["arg1"], "linux");
  assert.equal(spec.executable, "test.cmd");
  assert.deepEqual(spec.args, ["arg1"]);
});

test("buildSpawnSpec: rejects a .cmd path containing a batch metacharacter on Windows", () => {
  // Path form bypasses the bare-name check, reaching validateWindowsBatchExecutableForCmd.
  assert.throws(
    () => buildSpawnSpec("./bad%name.cmd", ["arg1"], "win32"),
    /unsafe for cmd\.exe batch launch/i,
  );
});

test("buildSpawnSpec rejects batch arguments containing cmd metacharacters", () => {
  assert.throws(
    () => buildSpawnSpec("test.cmd", ["safe", "& whoami"], "win32"),
    /unsafe for cmd\.exe batch launch/i,
  );
});
