import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import {
  MISTRAL_VIBE_AUTH_MESSAGE,
  MISTRAL_VIBE_MISSING_MESSAGE,
  createVibeStreamParser,
  detectVibeActiveModel,
  discoverMistralVibeModels,
  findLatestVibeSession,
  getMistralVibeSessionId,
  launchMistralVibeCli,
  listVibeConfiguredModels,
  resetMistralVibeSession,
  resolveVibeExecutable,
  runMistralVibe,
  validateMistralVibeRoute,
} from "./mistralVibe.js";
import type { CommandResult, CommandSpec, CommandStreamHandlers } from "../process/CommandRunner.js";
import type { ProviderConfig } from "../providerLauncher/types.js";
import type { ProviderChatRequest } from "./types.js";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function buildRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    prompt: "Reply with hello.",
    route: {
      providerId: "mistral",
      modelId: "mistral-medium-3.5",
      backendKind: "mistral-vibe-cli-auth",
    },
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
    workspaceRoot: "/workspace/project",
    ...overrides,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProvider(): ProviderConfig {
  return {
    id: "mistral",
    displayName: "Mistral Vibe CLI",
    currentModel: "mistral-medium-3.5",
    backendType: "mistral-vibe-cli-auth",
    routeMode: "launch-only",
    enabled: true,
    statusLabel: "Launch only",
    launchCommand: { executable: "vibe", args: [] },
    isDefault: false,
    isActiveRoute: false,
    routeUnavailableReason: "Native interactive session.",
  };
}

test("resolveVibeExecutable uses the exact command -v vibe probe", async () => {
  let observedCommand = "";
  const executable = await resolveVibeExecutable({
    cwd: "/workspace",
    platform: "linux",
    runShellCommandImpl: ((command: string) => {
      observedCommand = command;
      return {
        result: Promise.resolve({
          status: "completed" as const,
          exitCode: 0,
          stdout: "/home/test/.local/bin/vibe\n",
        }),
      };
    }) as any,
  });

  assert.equal(observedCommand, "command -v vibe");
  assert.equal(executable, "/home/test/.local/bin/vibe");
});

test("resolveVibeExecutable returns null when command -v cannot find vibe", async () => {
  const executable = await resolveVibeExecutable({
    platform: "linux",
    runShellCommandImpl: (() => ({
      result: Promise.resolve({ status: "failed" as const, exitCode: 1, stdout: "" }),
    })) as any,
  });

  assert.equal(executable, null);
});

test("detectVibeActiveModel follows environment, project, and user config precedence", () => {
  const root = join(tmpdir(), `ubume-vibe-model-${Date.now()}`);
  const workspace = join(root, "workspace", "nested");
  const home = join(root, "home");
  mkdirSync(join(root, "workspace", ".vibe"), { recursive: true });
  mkdirSync(join(home, ".vibe"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".vibe", "config.toml"), 'active_model = "user-model"\n');
  writeFileSync(join(root, "workspace", ".vibe", "config.toml"), 'active_model = "project-model"\n');

  try {
    assert.deepEqual(
      detectVibeActiveModel({ cwd: workspace, homeDirectory: home, env: {} }),
      {
        modelId: "project-model",
        source: "project-config",
        configPath: join(root, "workspace", ".vibe", "config.toml"),
      },
    );
    assert.equal(
      detectVibeActiveModel({ cwd: workspace, homeDirectory: home, env: { VIBE_ACTIVE_MODEL: "env-model" } }).modelId,
      "env-model",
    );
    rmSync(join(root, "workspace", ".vibe"), { recursive: true, force: true });
    assert.equal(
      detectVibeActiveModel({ cwd: workspace, homeDirectory: home, env: {} }).modelId,
      "user-model",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectVibeActiveModel falls back safely when configuration is malformed", () => {
  const root = join(tmpdir(), `ubume-vibe-invalid-${Date.now()}`);
  const home = join(root, "home");
  mkdirSync(join(home, ".vibe"), { recursive: true });
  writeFileSync(join(home, ".vibe", "config.toml"), "active_model = [\n");

  try {
    assert.deepEqual(
      detectVibeActiveModel({ cwd: root, homeDirectory: home, env: {} }),
      { modelId: "Vibe default", source: "default", configPath: null },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured Vibe models prefer the project config, deduplicate aliases, and keep the active model first", () => {
  const root = join(tmpdir(), `ubume-vibe-models-${Date.now()}`);
  const workspace = join(root, "workspace", "nested");
  const home = join(root, "home");
  mkdirSync(join(root, "workspace", ".vibe"), { recursive: true });
  mkdirSync(join(home, ".vibe"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, "workspace", ".vibe", "config.toml"), [
    'active_model = "project-model"',
    "[[models]]",
    'name = "project/model"',
    'alias = "project-model"',
    'provider = "mistral"',
    "[[models]]",
    'name = "shared/project"',
    'alias = "shared"',
  ].join("\n"));
  writeFileSync(join(home, ".vibe", "config.toml"), [
    "[[models]]",
    'name = "shared/user"',
    'alias = "shared"',
    "[[models]]",
    'name = "user/model"',
    'alias = "user-model"',
  ].join("\n"));

  try {
    const listed = listVibeConfiguredModels({ cwd: workspace, homeDirectory: home, env: {} });
    assert.deepEqual(listed.models.map((model) => model.modelId), ["project-model", "shared", "user-model"]);
    assert.equal(listed.models[0]?.description, "project/model via mistral");

    const previousHome = process.env.HOME;
    const previousVibeHome = process.env.VIBE_HOME;
    try {
      process.env.HOME = home;
      process.env.VIBE_HOME = join(home, ".vibe");
      const discovery = discoverMistralVibeModels(workspace);
      assert.deepEqual(discovery.models.map((model) => model.modelId), ["project-model", "shared", "user-model"]);
      assert.equal(discovery.diagnostics?.selectedModel, "project-model");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousVibeHome === undefined) delete process.env.VIBE_HOME;
      else process.env.VIBE_HOME = previousVibeHome;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream parser emits reasoning, assistant text, and tool lifecycle without duplicating trailing text", () => {
  const deltas: string[] = [];
  const progress: string[] = [];
  const tools: Array<{ id: string; status: string; summary?: string | null }> = [];
  const parser = createVibeStreamParser({
    onResponse: () => undefined,
    onError: () => undefined,
    onAssistantDelta: (chunk) => deltas.push(chunk),
    onProgress: (update) => progress.push(update.text),
    onToolActivity: (activity) => tools.push({ id: activity.id, status: activity.status, summary: activity.summary }),
  });

  const assistant = JSON.stringify({
    role: "assistant",
    reasoning_content: "Check the workspace",
    content: [{ text: "First answer" }],
    tool_calls: [{ id: "tool-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
  });
  const tool = JSON.stringify({ role: "tool", tool_call_id: "tool-1", content: "Read complete" });
  parser.push(`${assistant.slice(0, 20)}`);
  parser.push(`${assistant.slice(20)}\n${tool}\nFirst answer`);
  parser.flush();

  assert.deepEqual(deltas, ["First answer"]);
  assert.deepEqual(progress, ["Check the workspace"]);
  assert.deepEqual(tools.map(({ id, status }) => ({ id, status })), [
    { id: "tool-1", status: "running" },
    { id: "tool-1", status: "completed" },
  ]);
  assert.equal(tools[1]?.summary, "Read complete");
  assert.equal(parser.finalText(), "First answer");
});

test("stream parser falls back to plain text when no assistant JSON is present", () => {
  const parser = createVibeStreamParser({ onResponse: () => undefined, onError: () => undefined });
  parser.push("plain response without newline");
  parser.flush();
  assert.equal(parser.assistantText(), "");
  assert.equal(parser.finalText(), "plain response without newline");
});

test("stream parser suppresses replayed history until the resumed turn's user prompt", () => {
  const deltas: string[] = [];
  const progress: string[] = [];
  const parser = createVibeStreamParser({
    onResponse: () => undefined,
    onError: () => undefined,
    onAssistantDelta: (chunk) => deltas.push(chunk),
    onProgress: (update) => progress.push(update.text),
  }, { startAfterUserPrompt: "current prompt" });

  for (const message of [
    { role: "user", content: "prior prompt" },
    { role: "assistant", reasoning_content: "prior reasoning", content: "prior answer" },
    { role: "user", content: "current prompt" },
    { role: "assistant", reasoning_content: "current reasoning", content: "current answer" },
  ]) {
    parser.push(`${JSON.stringify(message)}\n`);
  }
  parser.push("current answer\n");

  assert.deepEqual(deltas, ["current answer"]);
  assert.deepEqual(progress, ["current reasoning"]);
  assert.equal(parser.finalText(), "current answer");
});

test("launchMistralVibeCli launches the resolved executable with no arguments", async () => {
  const child = new EventEmitter();
  let observedExecutable = "";
  let observedArgs: string[] = [];
  let observedCwd = "";
  let observedStdio: unknown;
  const spawnImpl = ((executable: string, args: string[], options: { cwd?: string; stdio?: unknown }) => {
    observedExecutable = executable;
    observedArgs = args;
    observedCwd = options.cwd ?? "";
    observedStdio = options.stdio;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace/project",
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.equal(observedExecutable, "/home/test/.local/bin/vibe");
  assert.deepEqual(observedArgs, []);
  assert.equal(observedCwd, "/workspace/project");
  assert.equal(observedStdio, "inherit");
});

test("launchMistralVibeCli reports the install and authentication requirement", async () => {
  let didSpawn = false;
  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace",
    resolveExecutable: async () => null,
    spawnImpl: (() => {
      didSpawn = true;
      return new EventEmitter();
    }) as unknown as typeof import("child_process").spawn,
  });

  assert.equal(result.status, "missing-command");
  assert.equal(result.message, MISTRAL_VIBE_MISSING_MESSAGE);
  assert.equal(didSpawn, false);
});

test("launchMistralVibeCli restores terminal state after SIGINT termination", async () => {
  const child = new EventEmitter();
  const events: string[] = [];
  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace",
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
    commandExists: () => true,
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        events.push(enabled ? "raw-on" : "raw-off");
      },
    },
    beforeLaunch: () => events.push("before"),
    afterLaunch: () => events.push("after"),
    spawnImpl: (() => {
      events.push("spawn");
      queueMicrotask(() => child.emit("close", null, "SIGINT"));
      return child;
    }) as unknown as typeof import("child_process").spawn,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.signal, "SIGINT");
  assert.deepEqual(events, ["before", "raw-off", "spawn", "raw-on", "after"]);
});

test("findLatestVibeSession selects the newest matching workspace session after the run started", async () => {
  const root = join(tmpdir(), `ubume-vibe-sessions-${Date.now()}`);
  const sessionRoot = join(root, ".vibe", "logs", "session");
  const workspaceRoot = join(root, "workspace");
  const startedAt = Date.now();
  const writeSession = (directory: string, sessionId: string, startTime: number, cwd: string) => {
    mkdirSync(join(sessionRoot, directory), { recursive: true });
    writeFileSync(join(sessionRoot, directory, "meta.json"), JSON.stringify({
      session_id: sessionId,
      start_time: new Date(startTime).toISOString(),
      environment: { working_directory: cwd },
    }));
  };
  writeSession("session_old", "old", startedAt - 20_000, workspaceRoot);
  writeSession("session_other", "other", startedAt + 1_000, join(root, "other"));
  writeSession("session_first", "first", startedAt + 1_000, workspaceRoot);
  writeSession("session_latest", "latest", startedAt + 2_000, workspaceRoot);

  try {
    assert.equal(await findLatestVibeSession({
      workspaceRoot,
      sinceMs: startedAt,
      homeDirectory: root,
      env: {},
    }), "latest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMistralVibe sends the prompt on stdin, streams once, and resumes the saved workspace session", async () => {
  resetMistralVibeSession();
  const specs: CommandSpec[] = [];
  const runImpl = (spec: CommandSpec, streamHandlers: CommandStreamHandlers) => {
    specs.push(spec);
    const text = specs.length === 1 ? "first response" : "second response";
    streamHandlers.onStdout?.(`${JSON.stringify({ role: "assistant", content: text })}\n${text}\n`);
    return { result: Promise.resolve(commandResult({ stdout: `${text}\n` })), cancel: () => undefined };
  };

  const runOnce = (prompt: string, findSessionImpl: typeof findLatestVibeSession) => new Promise<string>((resolve, reject) => {
    runMistralVibe(buildRequest({ prompt }), {
      onResponse: resolve,
      onError: (message) => reject(new Error(message)),
    }, {
      resolveExecutable: async () => "/home/test/.local/bin/vibe",
      runCommandImpl: runImpl,
      findSessionImpl,
      env: { PATH: "/test/bin" },
      now: () => 10_000,
    });
  });

  try {
    assert.equal(await runOnce("first prompt", async () => "session-123"), "first response");
    await tick();
    assert.equal(getMistralVibeSessionId("/workspace/project"), "session-123");
    assert.equal(await runOnce("second prompt", async () => null), "second response");

    assert.deepEqual(specs[0]?.args, [
      "-p", "--output", "streaming", "--trust", "--auto-approve", "--workdir", "/workspace/project",
    ]);
    assert.deepEqual(specs[1]?.args, [
      "-p", "--output", "streaming", "--trust", "--auto-approve", "--workdir", "/workspace/project",
      "--resume", "session-123",
    ]);
    assert.equal(specs[0]?.stdinData, "first prompt");
    assert.equal(specs[1]?.stdinData, "second prompt");
    assert.equal(specs[0]?.env?.VIBE_ACTIVE_MODEL, "mistral-medium-3.5");
  } finally {
    resetMistralVibeSession();
  }
});

test("runMistralVibe retries once without resume when the saved session is stale", async () => {
  resetMistralVibeSession();
  let calls = 0;
  const seedResponse = new Promise<string>((resolve, reject) => {
    runMistralVibe(buildRequest(), { onResponse: resolve, onError: (message) => reject(new Error(message)) }, {
      resolveExecutable: async () => "vibe",
      runCommandImpl: (_spec, streamHandlers) => {
        streamHandlers.onStdout?.(`${JSON.stringify({ role: "assistant", content: "seed" })}\n`);
        return { result: Promise.resolve(commandResult({ stdout: "seed" })), cancel: () => undefined };
      },
      findSessionImpl: async () => "stale-session",
    });
  });
  await seedResponse;
  await tick();

  const response = new Promise<string>((resolve, reject) => {
    runMistralVibe(buildRequest({ prompt: "retry" }), { onResponse: resolve, onError: (message) => reject(new Error(message)) }, {
      resolveExecutable: async () => "vibe",
      runCommandImpl: (spec, streamHandlers) => {
        calls += 1;
        if (calls === 1) {
          assert.ok(spec.args.includes("stale-session"));
          return {
            result: Promise.resolve(commandResult({ status: "failed", exitCode: 1, stderr: "session not found", userMessage: "failed" })),
            cancel: () => undefined,
          };
        }
        assert.equal(spec.args.includes("--resume"), false);
        streamHandlers.onStdout?.(`${JSON.stringify({ role: "assistant", content: "fresh" })}\n`);
        return { result: Promise.resolve(commandResult({ stdout: "fresh" })), cancel: () => undefined };
      },
      findSessionImpl: async () => null,
    });
  });

  try {
    assert.equal(await response, "fresh");
    assert.equal(calls, 2);
    assert.equal(getMistralVibeSessionId("/workspace/project"), null);
  } finally {
    resetMistralVibeSession();
  }
});

test("runMistralVibe maps missing executable and authentication failures to setup guidance", async () => {
  const missing = await new Promise<string>((resolve) => {
    runMistralVibe(buildRequest(), { onResponse: () => undefined, onError: resolve }, {
      resolveExecutable: async () => null,
    });
  });
  assert.equal(missing, MISTRAL_VIBE_MISSING_MESSAGE);

  const auth = await new Promise<string>((resolve) => {
    runMistralVibe(buildRequest(), { onResponse: () => undefined, onError: resolve }, {
      resolveExecutable: async () => "vibe",
      runCommandImpl: () => ({
        result: Promise.resolve(commandResult({ status: "failed", exitCode: 1, stderr: "401 unauthorized" })),
        cancel: () => undefined,
      }),
    });
  });
  assert.equal(auth, MISTRAL_VIBE_AUTH_MESSAGE);
});

test("runMistralVibe cancellation before executable resolution prevents process launch", async () => {
  let resolveExecutable!: (value: string | null) => void;
  let didRun = false;
  const cancel = runMistralVibe(buildRequest(), { onResponse: () => undefined, onError: () => undefined }, {
    resolveExecutable: () => new Promise((resolve) => { resolveExecutable = resolve; }),
    runCommandImpl: () => {
      didRun = true;
      return { result: Promise.resolve(commandResult()), cancel: () => undefined };
    },
  });
  cancel();
  resolveExecutable("vibe");
  await tick();
  assert.equal(didRun, false);
});

test("validateMistralVibeRoute reports missing and ready executable states", async () => {
  const missing = await validateMistralVibeRoute({ cwd: "/workspace", resolveExecutable: async () => null });
  assert.equal(missing.status, "not-configured");
  assert.equal(missing.backendKind, "unavailable");
  assert.equal(missing.message, MISTRAL_VIBE_MISSING_MESSAGE);

  const ready = await validateMistralVibeRoute({
    cwd: process.cwd(),
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.backendKind, "mistral-vibe-cli-auth");
  assert.equal(ready.diagnostics?.resolvedCommand, "/home/test/.local/bin/vibe");
});
