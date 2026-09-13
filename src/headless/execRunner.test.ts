import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADLESS_EXEC_PROVIDER_UNAVAILABLE,
  HEADLESS_EXEC_RUN_FAILED,
  createHeadlessExecTiming,
  runHeadlessExec,
  type HeadlessExecIo,
} from "./execRunner.js";
import { normalizeRuntimeConfig, resolveRuntimeConfig, type ResolvedRuntimeConfig } from "../config/runtimeConfig.js";
import type { LayeredConfigResult } from "../config/layeredConfig.js";
import type { LaunchArgs } from "../config/launchArgs.js";
import type { BackendProvider } from "../core/providers/types.js";

function createLaunchArgs(): LaunchArgs {
  return {
    help: false,
    version: false,
    initialPrompt: "Prompt",
    profile: null,
    configOverrides: [],
    passthroughArgs: [],
    modelOverride: null,
    noClear: false,
  };
}

function createIo(): HeadlessExecIo & { stdoutText: () => string; stderrText: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function createLayeredConfig(): LayeredConfigResult {
  return {
    runtime: normalizeRuntimeConfig({
      provider: "codex-subprocess",
      model: "gpt-5.4-mini",
      reasoningLevel: "medium",
      mode: "full-auto",
      planMode: true,
      policy: {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        writableRoots: ["C:/Repo/extra"],
        serviceTier: "fast",
        personality: "pragmatic",
      },
    }),
    diagnostics: {
      projectRoot: "C:\\Repo",
      projectTrusted: true,
      selectedProfile: null,
      selectedProfileSource: null,
      cliOverrides: [],
      layers: [{ label: "test", status: "loaded" }],
      ignoredEntries: [],
      fieldSources: {
        provider: "test",
        model: "test",
        reasoningLevel: "test",
        mode: "test",
        planMode: "test",
        geminiCommandPath: "test",
        "policy.approvalPolicy": "test",
        "policy.sandboxMode": "test",
        "policy.networkAccess": "test",
        "policy.writableRoots": "test",
        "policy.serviceTier": "test",
        "policy.personality": "test",
      },
    },
  };
}

function createProvider(run: BackendProvider["run"]): BackendProvider {
  return {
    id: "codex-subprocess",
    label: "Mock Codex",
    description: "Mock provider",
    authState: "delegated",
    authLabel: "Mock",
    statusMessage: "Mock",
    supportsModels: () => true,
    run,
  };
}

test("streams assistant deltas to stdout and progress/tool/error diagnostics to stderr", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onProgress?.({ id: "p1", source: "reasoning", text: "thinking" });
    handlers.onToolActivity?.({
      id: "tool-1",
      command: "pwd",
      status: "running",
      startedAt: Date.now(),
    });
    handlers.onAssistantDelta?.("Hello ");
    handlers.onAssistantDelta?.("world");
    handlers.onResponse("Hello world");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Hello world");
  assert.doesNotMatch(`${io.stdoutText()}\n${io.stderrText()}`, /██████|Ubume v|Workspace:|Provider:|Context:/);
  assert.match(io.stderrText(), /startup:/);
  assert.match(io.stderrText(), /reasoning: thinking/);
  assert.match(io.stderrText(), /tool: running: pwd/);
});

test("emits final_answer_observed timing before provider response settles", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onAssistantDelta?.("READY");
    handlers.onFinalAnswerObserved?.("READY");
    handlers.onResponse("READY");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      benchmarkDiagnostics: createHeadlessExecTiming({
        enabled: true,
        stderr: io.stderr,
        startTimeMs: Date.now(),
      }),
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(io.stderrText(), /final_answer_observed/);
  assert.match(io.stderrText(), /\[ubume exec timing\]/);
  assert.match(io.stderrText(), /final_answer_character_count=5/);
});

test("timing is silent when disabled", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(io.stderrText(), /\[ubume exec timing\]/);
});

test("raw prompt policy sends the exact prompt and skips project instructions", async () => {
  const io = createIo();
  const captured: Array<{ prompt: string; promptPolicy: string | undefined; projectInstructions: unknown }> = [];
  let projectInstructionLoadCount = 0;
  const provider = createProvider((prompt, options, handlers) => {
    captured.push({
      prompt,
      promptPolicy: options.promptPolicy,
      projectInstructions: options.projectInstructions,
    });
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Reply with exactly: UBUME_READY",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => {
        projectInstructionLoadCount += 1;
        return {
          status: "loaded",
          instructions: { path: "C:\\Repo\\AGENTS.md", content: "extra instructions" },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(projectInstructionLoadCount, 0);
  assert.equal(captured[0]?.prompt, "Reply with exactly: UBUME_READY");
  assert.equal(captured[0]?.promptPolicy, "raw");
  assert.equal(captured[0]?.projectInstructions, null);
});

test("wrapped prompt policy loads project instructions for compatibility", async () => {
  const io = createIo();
  let capturedProjectInstructions: unknown = null;
  const provider = createProvider((_prompt, options, handlers) => {
    capturedProjectInstructions = options.projectInstructions;
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      promptPolicy: "wrapped",
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({
        status: "loaded",
        instructions: { path: "C:\\Repo\\AGENTS.md", content: "extra instructions" },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capturedProjectInstructions, {
    path: "C:\\Repo\\AGENTS.md",
    content: "extra instructions",
  });
});

test("does not duplicate equivalent tool activity as progress", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onToolActivity?.({
      id: "tool-1",
      command: "Get-ChildItem",
      status: "running",
      startedAt: Date.now(),
    });
    handlers.onProgress?.({ id: "tool-1", source: "tool", text: "Running Get-ChildItem" });
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(io.stderrText(), /tool: running: Get-ChildItem/);
  assert.doesNotMatch(io.stderrText(), /tool: Running Get-ChildItem/);
});

test("returns exit code 0 on provider success without deltas", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onResponse("Final answer");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Final answer");
});

test("keeps structured fallback events out of stdout", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onAssistantDelta?.("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"raw\"}}\n");
    handlers.onAssistantDelta?.("Actual answer");
    handlers.onResponse("Actual answer");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Actual answer");
});

test("returns non-zero when provider is unavailable", async () => {
  const io = createIo();
  const provider = createProvider(undefined);

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_PROVIDER_UNAVAILABLE);
  assert.match(io.stderrText(), /unavailable/i);
});

test("returns non-zero on provider error", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onError("Provider exploded");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_RUN_FAILED);
  assert.match(io.stderrText(), /Provider exploded/);
});

test("missing-file failure remains non-zero and visible", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onError("Process exited with code 1", "Get-Content: Cannot find path 'missing.txt' because it does not exist.");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Read missing.txt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_RUN_FAILED);
  assert.match(io.stderrText(), /missing\.txt/);
  assert.match(io.stderrText(), /does not exist/);
});

test("forces planMode off while preserving other runtime settings", async () => {
  const io = createIo();
  const capturedRuntimes: ResolvedRuntimeConfig[] = [];
  const provider = createProvider((_prompt, options, handlers) => {
    capturedRuntimes.push(options.runtime);
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      resolveRuntimeConfig,
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  const capturedRuntime = capturedRuntimes[0];
  assert.ok(capturedRuntime);
  assert.equal(capturedRuntime.planMode, false);
  assert.equal(capturedRuntime.model, "gpt-5.4-mini");
  assert.equal(capturedRuntime.reasoningLevel, "medium");
  assert.equal(capturedRuntime.mode, "full-auto");
  assert.equal(capturedRuntime.policy.approvalPolicy, "never");
  assert.equal(capturedRuntime.policy.sandboxMode, "danger-full-access");
  assert.equal(capturedRuntime.policy.networkAccess, true);
  assert.deepEqual(capturedRuntime.policy.writableRoots, ["C:\\Repo\\extra"]);
  assert.equal(capturedRuntime.policy.serviceTier, "fast");
  assert.equal(capturedRuntime.policy.personality, "pragmatic");
});
