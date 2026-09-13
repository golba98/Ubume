import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import {
  buildGeminiCommand,
  buildGeminiCliPromptArgs,
  buildGeminiCliValidationArgs,
  classifyGeminiProbeFailure,
  hasGeminiApiKey,
  isGeminiRouteConfigured,
  resetGeminiRouteValidationCacheForTests,
  runGeminiDiagnostics,
  runGeminiCliWithRunner,
  validateGeminiRoute,
} from "./gemini.js";
import { resetGeminiExecutableCacheForTests } from "../executables/geminiExecutable.js";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { ProviderChatRequest } from "./types.js";

// A real temp file used wherever tests need a configured absolute exe path that passes the existence check.
const FAKE_GEMINI_EXE = join(tmpdir(), "ubume-test-gemini.cmd");
writeFileSync(FAKE_GEMINI_EXE, "");

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

async function withGeminiEnv<T>(
  env: Partial<NodeJS.ProcessEnv>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalExe = process.env.GEMINI_EXECUTABLE;
  const originalCliPath = process.env.GEMINI_CLI_PATH;

  try {
    if ("GEMINI_API_KEY" in env) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
    else delete process.env.GEMINI_API_KEY;
    if ("GOOGLE_API_KEY" in env) process.env.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
    else delete process.env.GOOGLE_API_KEY;
    if ("GEMINI_EXECUTABLE" in env) process.env.GEMINI_EXECUTABLE = env.GEMINI_EXECUTABLE;
    else delete process.env.GEMINI_EXECUTABLE;
    if ("GEMINI_CLI_PATH" in env) process.env.GEMINI_CLI_PATH = env.GEMINI_CLI_PATH;
    else delete process.env.GEMINI_CLI_PATH;
    resetGeminiExecutableCacheForTests();
    return await callback();
  } finally {
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalExe === undefined) delete process.env.GEMINI_EXECUTABLE;
    else process.env.GEMINI_EXECUTABLE = originalExe;
    if (originalCliPath === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = originalCliPath;
    resetGeminiRouteValidationCacheForTests();
    resetGeminiExecutableCacheForTests();
  }
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

function buildRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    prompt: "hello",
    route: {
      providerId: "google",
      modelId: "gemini-3-flash-preview",
      backendKind: "gemini-cli-auth",
    },
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
      model: "gemini-3-flash-preview",
      geminiCommandPath: FAKE_GEMINI_EXE,
    })),
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

test("Gemini route validation returns command-not-found diagnostic with PS commands when executable missing", async () => {
  await withGeminiEnv({}, async () => {
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        status: "spawn_error",
        exitCode: null,
        errorCode: "ENOENT",
        userMessage: "`gemini` is not installed or not available on PATH.",
      })),
    });

    assert.equal(validation.status, "not-configured");
    assert.equal(validation.backendKind, "unavailable");
    assert.match(validation.message ?? "", /Gemini CLI was not found|Gemini CLI was not found as a real executable/);
    assert.match(validation.message ?? "", /GEMINI_EXECUTABLE/);
    assert.equal(isGeminiRouteConfigured(), false);
  });
});

test("Gemini readiness uses resolved executable, Gemini 3 Flash Preview, and combined READY output", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    const calls: Array<Parameters<typeof runCommand>[0]> = [];
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        stderr: "READY\n",
      }), (spec) => calls.push(spec)),
    });

    const probe = calls.find((call) => call.args.includes("-p"));
    assert.equal(validation.status, "ready");
    assert.equal(probe?.executable, FAKE_GEMINI_EXE);
    assert.deepEqual(probe?.args, ["--model", "gemini-3-flash-preview", "-p", "Respond with READY only."]);
    assert.equal("shell" in (probe ?? {}), false);
    assert.equal(probe?.args.includes("--reasoning"), false);
    assert.equal(validation.diagnostics?.resolvedCommand, FAKE_GEMINI_EXE);
    assert.equal(validation.diagnostics?.lastProbeCommandArgs, JSON.stringify(["--model", "gemini-3-flash-preview", "-p", "Respond with READY only."]));
    assert.equal(validation.diagnostics?.readyTokenObserved, true);
  });
});

test("Gemini command builders use verified model IDs and no reasoning argv", () => {
  assert.deepEqual(buildGeminiCliValidationArgs(), ["--model", "gemini-3-flash-preview", "-p", "Respond with READY only."]);
  for (const modelId of [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ]) {
    assert.deepEqual(buildGeminiCliPromptArgs("hello", modelId), ["--model", modelId, "-p", "hello"]);
  }
  assert.deepEqual(buildGeminiCliPromptArgs("hello", "gemini-3-flash", true), ["--model", "gemini-3-flash-preview", "-p", "hello"]);

  for (const args of [
    buildGeminiCliValidationArgs(),
    buildGeminiCliPromptArgs("hello", "gemini-3-flash-preview"),
    buildGeminiCliPromptArgs("hello", "gemini-2.5-pro", resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "full-auto" }))),
  ]) {
    assert.equal(args.includes("--reasoning"), false);
    assert.equal(args.includes("--approval-mode"), false);
    assert.equal(args.includes("--output-format"), false);
  }
});

test("Gemini command builder returns exact readiness and prompt specs", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    const readiness = await buildGeminiCommand({
      cwd: process.cwd(),
      mode: "readiness",
      runCommandImpl: mockRunCommand(commandResult({ stdout: "READY\n" })),
    });
    assert.equal(readiness.file, FAKE_GEMINI_EXE);
    assert.deepEqual(readiness.args, ["--model", "gemini-3-flash-preview", "-p", "Respond with READY only."]);
    assert.equal(readiness.mode, "readiness");
    assert.equal(readiness.model, "gemini-3-flash-preview");
    assert.equal(readiness.includesPolicy, false);

    const prompt = await buildGeminiCommand({
      cwd: process.cwd(),
      mode: "prompt",
      prompt: "hello",
      model: "gemini-3-flash",
      reasoning: "high",
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "full-auto" })),
      runCommandImpl: mockRunCommand(commandResult({ stdout: "READY\n" })),
    });
    assert.equal(prompt.file, FAKE_GEMINI_EXE);
    assert.deepEqual(prompt.args, ["--model", "gemini-3-flash-preview", "-p", "hello"]);
    assert.equal(prompt.mode, "prompt");
    assert.equal(prompt.model, "gemini-3-flash-preview");
    assert.equal(prompt.reasoning, "high");
    assert.equal(prompt.args.includes("--reasoning"), false);
    assert.equal(prompt.args.includes("--approval-mode"), false);
    assert.equal(prompt.args.includes("--output-format"), false);
    assert.equal(prompt.includesPolicy, false);
  });
});

test("Gemini prompt execution appends plain stdout as assistant text", async () => {
  await withGeminiEnv({}, async () => {
    const calls: Array<Parameters<typeof runCommand>[0]> = [];
    const text = await runGeminiCliWithRunner(
      buildRequest({
        runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
          model: "gemini-3-flash-preview",
          mode: "full-auto",
          geminiCommandPath: FAKE_GEMINI_EXE,
        })),
      }),
      mockRunCommand(commandResult({ stdout: "done\n" }), (spec) => {
        if (spec.args.includes("-p")) calls.push(spec);
      }),
    );

    assert.equal(text, "done");
    assert.deepEqual(calls[0]?.args, ["--model", "gemini-3-flash-preview", "-p", "hello"]);
    assert.equal("shell" in (calls[0] ?? {}), false);
  });
});

test("Gemini prompt execution detects policy file error and provides diagnostics", async () => {
  await withGeminiEnv({}, async () => {
    await assert.rejects(
      () => runGeminiCliWithRunner(
        buildRequest(),
        mockRunCommand(commandResult({
          status: "completed",
          exitCode: 1,
          stderr: "[USER] Policy file error in auto-saved.toml: validation failed",
        })),
      ),
      /Policy file error in Gemini CLI[\s\S]*validation failed/,
    );
  });
});

test("Gemini bad PowerShell wrapper -p ambiguity is classified as wrapper conflict", async () => {
  const result = commandResult({
    status: "failed",
    exitCode: 1,
    stderr: "Parameter cannot be processed because the parameter name 'p' is ambiguous. Possible matches include: -ProgressAction -PipelineVariable",
  });
  assert.equal(classifyGeminiProbeFailure(result), "shell wrapper/function conflict");

  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(result),
    });
    assert.equal(validation.status, "not-configured");
    assert.equal(validation.diagnostics?.failureReason, "shell wrapper/function conflict");
    assert.doesNotMatch(validation.message ?? "", /not found/i);
  });
});

test("Gemini route validation returns auth-unknown diagnostic if executable found but probe fails", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: "my-gemini" }, async () => {
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        status: "completed",
        exitCode: 1,
        stderr: "Auth failed",
      })),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message ?? "", /Gemini CLI installed, auth unknown/);
  });
});

test("Gemini route validation returns timeout diagnostic on probe timeout", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: "my-gemini" }, async () => {
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        status: "timeout",
        exitCode: null,
      })),
    });

    assert.equal(validation.status, "not-configured");
    assert.equal(validation.message, "Installed but headless probe timed out.");
  });
});

test("Gemini route validation preferences authenticated CLI over API key", async () => {
  await withGeminiEnv({ GEMINI_API_KEY: "gemini-key" }, async () => {
    let commandCalled = false;
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        stdout: JSON.stringify({ response: "READY" }),
      }), () => {
        commandCalled = true;
      }),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "gemini-cli-auth");
    assert.equal(commandCalled, true);
    assert.equal(isGeminiRouteConfigured(), true);
  });
});

test("Gemini route validation falls back to GEMINI_API_KEY if CLI fails", async () => {
  await withGeminiEnv({ GEMINI_API_KEY: "gemini-key" }, async () => {
    const validation = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        status: "spawn_error",
        errorCode: "ENOENT",
      })),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "gemini-api-key");
  });
});

test("Gemini non-zero model errors surface without silent retry", async () => {
  await withGeminiEnv({}, async () => {
    const calls: Array<Parameters<typeof runCommand>[0]> = [];
    await assert.rejects(
      () => runGeminiCliWithRunner(
        buildRequest(),
        mockRunCommand(commandResult({
          status: "failed",
          exitCode: 1,
          stderr: "ModelNotFoundError: Requested entity was not found.",
        }), (spec) => calls.push(spec)),
      ),
      /ModelNotFoundError: Requested entity was not found/,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["--model", "gemini-3-flash-preview", "-p", "hello"]);
  });
});

test("Gemini diagnostics include command details without prompt text", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    await runGeminiCliWithRunner(
      buildRequest({ prompt: "secret prompt text" }),
      mockRunCommand(commandResult({ stdout: "done" })),
    );

    const diagnostics = await runGeminiDiagnostics({
      cwd: process.cwd(),
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
        mode: "full-auto",
        geminiCommandPath: FAKE_GEMINI_EXE,
      })),
      selectedModel: "gemini-3-flash",
      selectedReasoning: "high",
      runCommandImpl: mockRunCommand(commandResult({ stdout: "READY\n" })),
    });

    assert.ok(diagnostics.includes(`Resolved executable path: ${FAKE_GEMINI_EXE}`), `Expected diagnostics to include resolved path`);
    assert.match(diagnostics, /Readiness command args: \["--model","gemini-3-flash-preview","-p","Respond with READY only\."\]/);
    assert.match(diagnostics, /Selected model: gemini-3-flash-preview/);
    assert.match(diagnostics, /Policy args included: false/);
    assert.match(diagnostics, /Gemini reasoning control is not supported by this CLI version/);
    assert.match(diagnostics, /Last prompt command args: \["--model","gemini-3-flash-preview","-p","<prompt>"/);
    assert.doesNotMatch(diagnostics, /secret prompt text/);
  });
});

test("Gemini API key detection remains provider-specific", () => {
  assert.equal(hasGeminiApiKey({ GEMINI_API_KEY: "key" } as NodeJS.ProcessEnv), true);
  assert.equal(hasGeminiApiKey({ GOOGLE_API_KEY: "key" } as NodeJS.ProcessEnv), true);
  assert.equal(hasGeminiApiKey({} as NodeJS.ProcessEnv), false);
});

// ─── Provider selection / runtime sync tests ─────────────────────────────────

test("isGeminiRouteConfigured is false with no API key and no cached CLI validation", async () => {
  await withGeminiEnv({}, () => {
    assert.equal(isGeminiRouteConfigured(), false);
  });
});

test("isGeminiRouteConfigured is true with GEMINI_API_KEY set", async () => {
  await withGeminiEnv({ GEMINI_API_KEY: "test-key" }, () => {
    assert.equal(isGeminiRouteConfigured(), true);
  });
});

test("isGeminiRouteConfigured is true with GOOGLE_API_KEY set", async () => {
  await withGeminiEnv({ GOOGLE_API_KEY: "test-key" }, () => {
    assert.equal(isGeminiRouteConfigured(), true);
  });
});

test("isGeminiRouteConfigured is true after successful CLI validation", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    assert.equal(isGeminiRouteConfigured(), false);
    await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({ stderr: "READY\n" })),
    });
    assert.equal(isGeminiRouteConfigured(), true);
  });
});

test("validateGeminiRoute not-configured message names missing credentials when CLI not found", async () => {
  await withGeminiEnv({ GEMINI_EXECUTABLE: FAKE_GEMINI_EXE }, async () => {
    const result = await validateGeminiRoute({
      cwd: process.cwd(),
      modelId: "gemini-3-flash-preview",
      runCommandImpl: mockRunCommand(commandResult({
        status: "spawn_error",
        exitCode: null,
        errorCode: "ENOENT",
        userMessage: "`gemini` is not installed or not available on PATH.",
      })),
    });
    assert.equal(result.status, "not-configured");
    assert.match(result.message ?? "", /GEMINI_API_KEY|GOOGLE_API_KEY|GEMINI_EXECUTABLE|Gemini CLI/);
    assert.equal(isGeminiRouteConfigured(), false);
  });
});
