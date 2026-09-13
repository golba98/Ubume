import assert from "node:assert/strict";
import test from "node:test";
import { afterEach } from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import {
  resolveCodexExecutable,
  resetCodexExecutableCacheForTests,
  spawnCodexProcess,
} from "./codexExecutable.js";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
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
  const originalCodexExe = process.env.CODEX_EXECUTABLE;
  try {
    if ("CODEX_EXECUTABLE" in env) process.env.CODEX_EXECUTABLE = env.CODEX_EXECUTABLE;
    else delete process.env.CODEX_EXECUTABLE;
    resetCodexExecutableCacheForTests();
    return await callback();
  } finally {
    if (originalCodexExe === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = originalCodexExe;
    resetCodexExecutableCacheForTests();
  }
}

afterEach(() => {
  resetCodexExecutableCacheForTests();
});

test("Codex resolver: configuredPath wins and bypasses env and PATH", async () => {
  await withEnv({ CODEX_EXECUTABLE: "env-codex.cmd" }, async () => {
    let whereCalled = false;
    const resolved = await resolveCodexExecutable({
      configuredPath: process.execPath,
      runCommandImpl: mockRunCommand(commandResult(), () => { whereCalled = true; }),
    });

    assert.equal(resolved, process.execPath);
    assert.equal(whereCalled, false, "where.exe should not be called when configuredPath is set");
  });
});

test("Codex resolver: CODEX_EXECUTABLE env var used when no configuredPath", async () => {
  await withEnv({ CODEX_EXECUTABLE: "env-codex.cmd" }, async () => {
    let whereCalled = false;
    const resolved = await resolveCodexExecutable({
      runCommandImpl: mockRunCommand(commandResult(), () => { whereCalled = true; }),
    });

    assert.equal(resolved, "env-codex.cmd");
    assert.equal(whereCalled, false, "where.exe should not be called when CODEX_EXECUTABLE is set");
  });
});

test("Codex resolver: rejects unsafe CODEX_EXECUTABLE values", async () => {
  await withEnv({ CODEX_EXECUTABLE: "codex.cmd & calc" }, async () => {
    await assert.rejects(
      () => resolveCodexExecutable({
        runCommandImpl: mockRunCommand(commandResult()),
      }),
      /shell metacharacters|single executable name/i,
    );
  });
});

test("Codex resolver: rejects malicious CODEX_EXECUTABLE candidates", async () => {
  const unsafeExecutables = [
    "codex; echo hacked",
    "codex && echo hacked",
    "codex | echo hacked",
    "codex $(echo hacked)",
    "codex --dangerous-extra-arg",
    "codex.cmd & echo hacked",
  ];

  for (const executable of unsafeExecutables) {
    await withEnv({ CODEX_EXECUTABLE: executable }, async () => {
      await assert.rejects(
        () => resolveCodexExecutable({
          runCommandImpl: mockRunCommand(commandResult()),
        }),
        /shell metacharacters|single executable name/i,
        executable,
      );
    });
  }
});

test("Codex resolver: accepts environment executable paths with spaces", async () => {
  const tempRoot = join(tmpdir(), `ubume codex resolver ${Date.now()}`);
  const codexPath = join(tempRoot, "codex cli.exe");
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(codexPath, "");
  try {
    await withEnv({ CODEX_EXECUTABLE: `"${codexPath}"` }, async () => {
      const resolved = await resolveCodexExecutable({
        runCommandImpl: mockRunCommand(commandResult()),
      });
      assert.equal(resolved, codexPath);
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex resolver: Windows where.exe PATH lookup used when no env or config", async () => {
  if (process.platform !== "win32") return;

  const resolvedPath = join(tmpdir(), "codex.cmd");
  writeFileSync(resolvedPath, "");
  await withEnv({}, async () => {
    const calls: Array<Parameters<typeof runCommand>[0]> = [];
    const resolved = await resolveCodexExecutable({
      runCommandImpl: mockRunCommand(
        commandResult({ stdout: `${resolvedPath}\n` }),
        (spec) => calls.push(spec),
      ),
    });

    assert.equal(resolved, resolvedPath);
    const whereCall = calls.find((c) => c.executable === "where.exe");
    assert.ok(whereCall, "where.exe should have been called");
  });
});

test("Codex resolver: bare fallback returned when nothing found (non-Windows)", async () => {
  if (process.platform === "win32") return;

  await withEnv({}, async () => {
    const resolved = await resolveCodexExecutable({
      runCommandImpl: mockRunCommand(commandResult({ exitCode: 1, status: "failed" })),
    });

    assert.equal(resolved, "codex", "Should fall back to bare codex name");
  });
});

test("Codex resolver: Windows bare fallback when where.exe fails", async () => {
  if (process.platform !== "win32") return;

  await withEnv({}, async () => {
    const resolved = await resolveCodexExecutable({
      runCommandImpl: mockRunCommand(commandResult({ exitCode: 1, status: "failed" })),
    });

    assert.ok(["codex.cmd", "codex.exe", "codex"].includes(resolved), `Unexpected fallback: ${resolved}`);
  });
});

test("Codex resolver: cache is populated after first resolution", async () => {
  await withEnv({ CODEX_EXECUTABLE: "env-codex.cmd" }, async () => {
    const first = await resolveCodexExecutable();
    const second = await resolveCodexExecutable();

    assert.equal(first, second);
    assert.equal(first, "env-codex.cmd");
  });
});

test("Codex resolver: configuredPath bypasses cache", async () => {
  await withEnv({ CODEX_EXECUTABLE: "env-codex.cmd" }, async () => {
    const cached = await resolveCodexExecutable();
    assert.equal(cached, "env-codex.cmd");

    const withOverride = await resolveCodexExecutable({
      configuredPath: process.execPath,
    });
    assert.equal(withOverride, process.execPath);

    const afterOverride = await resolveCodexExecutable();
    assert.equal(afterOverride, "env-codex.cmd", "Cache should not be polluted by configuredPath call");
  });
});

test("Codex resolver: resetCodexExecutableCacheForTests clears state", async () => {
  await withEnv({ CODEX_EXECUTABLE: "first.cmd" }, async () => {
    const first = await resolveCodexExecutable();
    assert.equal(first, "first.cmd");
  });

  resetCodexExecutableCacheForTests();

  await withEnv({ CODEX_EXECUTABLE: "second.cmd" }, async () => {
    const second = await resolveCodexExecutable();
    assert.equal(second, "second.cmd");
  });
});

test("spawnCodexProcess wraps .cmd in cmd.exe on Windows", () => {
  if (process.platform !== "win32") return;

  const codexPath = "C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd";
  const proc = spawnCodexProcess(codexPath, ["exec", "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  proc.kill();

  assert.ok(proc, "Process should have been spawned");
});

test("spawnCodexProcess uses executable directly on non-Windows", () => {
  if (process.platform === "win32") return;

  const proc = spawnCodexProcess("echo", ["hello"], { stdio: ["ignore", "pipe", "pipe"] });
  proc.kill();

  assert.ok(proc, "Process should have been spawned");
});

test("spawnCodexProcess rejects executable candidates with injected commands or args", () => {
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
      () => spawnCodexProcess(executable, ["exec"], { stdio: ["ignore", "pipe", "pipe"] }),
      /shell metacharacters|single executable name/i,
      executable,
    );
  }
});
