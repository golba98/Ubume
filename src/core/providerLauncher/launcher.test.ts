import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildProviderLaunchSpec, commandExistsOnPath, launchProviderCli } from "./launcher.js";
import type { ProviderConfig } from "./types.js";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "openai",
    displayName: "OpenAI",
    currentModel: "gpt-5.4",
    backendType: "codex-cli-auth",
    routeMode: "in-ubume",
    enabled: true,
    statusLabel: "Enabled",
    launchCommand: { executable: "codex", args: [] },
    isDefault: true,
    isActiveRoute: true,
    routeUnavailableReason: null,
    ...overrides,
  };
}

test("builds launch specs for enabled providers", () => {
  const spec = buildProviderLaunchSpec(makeProvider({
    launchCommand: { executable: "claude", args: ["--resume"] },
  }), "C:\\Workspace");

  assert.equal("status" in spec, false);
  if ("status" in spec) return;
  assert.equal(spec.executable, "claude");
  assert.deepEqual(spec.args, ["--resume"]);
  assert.equal(spec.cwd, "C:\\Workspace");
});

test("disabled providers fail before spawning", () => {
  const result = buildProviderLaunchSpec(makeProvider({
    id: "local",
    displayName: "Local",
    backendType: "local-openai-compatible",
    enabled: false,
    statusLabel: "Disabled",
    launchCommand: null,
    isDefault: false,
  }), "C:\\Workspace");

  assert.equal("status" in result, true);
  assert.equal("status" in result ? result.status : "", "disabled");
  assert.match("status" in result ? result.message : "", /Configure a command/i);
});

test("unsafe configured launch commands fail before spawning", () => {
  const result = buildProviderLaunchSpec(makeProvider({
    launchCommand: { executable: "codex & calc", args: [] },
  }), "C:\\Workspace");

  assert.equal("status" in result, true);
  assert.equal("status" in result ? result.status : "", "spawn-error");
  assert.match("status" in result ? result.message : "", /unsafe launch command/i);
});

test("configured launch commands reject shell injection and extra arguments", () => {
  const unsafeExecutables = [
    "codex; echo hacked",
    "codex && echo hacked",
    "codex | echo hacked",
    "codex $(echo hacked)",
    "codex --dangerous-extra-arg",
    "codex.cmd & echo hacked",
  ];

  for (const executable of unsafeExecutables) {
    const result = buildProviderLaunchSpec(makeProvider({
      launchCommand: { executable, args: [] },
    }), "C:\\Workspace");

    assert.equal("status" in result, true, executable);
    assert.equal("status" in result ? result.status : "", "spawn-error", executable);
  }
});

test("commandExistsOnPath rejects unsafe executable candidates without launching a shell", async () => {
  const unsafeExecutables = [
    "codex; echo hacked",
    "codex && echo hacked",
    "codex | echo hacked",
    "codex $(echo hacked)",
    "codex --dangerous-extra-arg",
    "codex.cmd & echo hacked",
  ];

  for (const executable of unsafeExecutables) {
    assert.equal(await commandExistsOnPath(executable), false, executable);
  }
});

test("commandExistsOnPath accepts a normal executable path", async () => {
  const tempRoot = join(tmpdir(), `ubume-provider-launcher-${Date.now()}`);
  const executablePath = join(tempRoot, "ubume-test-tool");
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);

  try {
    assert.equal(await commandExistsOnPath(executablePath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("missing command spawn errors become friendly launch results", async () => {
  const child = new EventEmitter();
  const spawnImpl = (() => {
    queueMicrotask(() => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace",
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "missing-command");
  assert.match(result.message, /codex.*PATH/i);
});

test("missing command preflight fails before suspending raw mode", async () => {
  const rawModes: boolean[] = [];
  let didSpawn = false;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace",
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        rawModes.push(enabled);
      },
    },
    commandExists: () => false,
    spawnImpl: (() => {
      didSpawn = true;
      return new EventEmitter();
    }) as unknown as typeof import("child_process").spawn,
  });

  assert.equal(result.status, "missing-command");
  assert.equal(didSpawn, false);
  assert.deepEqual(rawModes, []);
});

test("launch restores raw mode after child exits", async () => {
  const child = new EventEmitter();
  const rawModes: boolean[] = [];
  const spawnImpl = (() => {
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace",
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        rawModes.push(enabled);
      },
    },
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(rawModes, [false, true]);
});

test("launch passes the workspace root as the child cwd", async () => {
  const child = new EventEmitter();
  let observedCwd = "";
  let observedShell: boolean | undefined = undefined;
  const spawnImpl = ((_executable: string, _args: string[], options: { cwd?: string; shell?: boolean }) => {
    observedCwd = options.cwd ?? "";
    observedShell = options.shell;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace\\Project",
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.equal(observedCwd, "C:\\Workspace\\Project");
  assert.equal(observedShell, false);
});

test("launch wraps Windows batch commands without enabling shell mode", async () => {
  if (process.platform !== "win32") return;

  const child = new EventEmitter();
  let observedExecutable = "";
  let observedArgs: string[] = [];
  let observedShell: boolean | undefined = undefined;
  const spawnImpl = ((executable: string, args: string[], options: { shell?: boolean }) => {
    observedExecutable = executable;
    observedArgs = args;
    observedShell = options.shell;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider({
    launchCommand: { executable: "codex.cmd", args: ["--resume"] },
  }), {
    cwd: "C:\\Workspace",
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.equal(observedExecutable, "cmd.exe");
  assert.deepEqual(observedArgs, ["/d", "/s", "/c", "call", "codex.cmd", "--resume"]);
  assert.equal(observedShell, false);
});

test("launch runs suspend and resume hooks around raw mode changes", async () => {
  const child = new EventEmitter();
  const events: string[] = [];
  const spawnImpl = (() => {
    events.push("spawn");
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace",
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        events.push(enabled ? "raw-on" : "raw-off");
      },
    },
    beforeLaunch: () => events.push("before"),
    afterLaunch: () => events.push("after"),
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(events, ["before", "raw-off", "spawn", "raw-on", "after"]);
});

test("launch restores terminal state after child spawn error", async () => {
  const child = new EventEmitter();
  const events: string[] = [];
  const spawnImpl = (() => {
    events.push("spawn");
    queueMicrotask(() => {
      const error = new Error("blocked") as NodeJS.ErrnoException;
      error.code = "EPERM";
      child.emit("error", error);
    });
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchProviderCli(makeProvider(), {
    cwd: "C:\\Workspace",
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        events.push(enabled ? "raw-on" : "raw-off");
      },
    },
    beforeLaunch: () => events.push("before"),
    afterLaunch: () => events.push("after"),
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "spawn-error");
  assert.deepEqual(events, ["before", "raw-off", "spawn", "raw-on", "after"]);
});
