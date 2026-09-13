import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import { buildClaudeSpawnSpec, resetClaudeExecutableCacheForTests } from "../executables/claudeExecutable.js";
import {
  ANTHROPIC_ROUTE_SETUP_MESSAGE,
  anthropicRuntime,
  buildClaudeCodeArgs,
  buildClaudeCodePlainTextArgs,
  ensureClaudeStreamJsonVerbose,
  mapModelIdToClaudeArg,
  mapReasoningToEffort,
  parseClaudeAuthStatus,
  resetAnthropicRouteValidationCacheForTests,
  runClaudeCodeWithRunner,
  tryParseStreamJsonDelta,
  validateAnthropicRoute,
} from "./anthropic.js";
import { discoverClaudeCodeCapabilities } from "./claudeCodeDiscovery.js";
import type { ProviderChatRequest } from "./types.js";

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

function mockRunCommand(
  resultOrMap: CommandResult | ((executable: string, args: string[]) => CommandResult),
  onCall?: (spec: Parameters<typeof runCommand>[0]) => void,
): typeof runCommand {
  return ((spec) => {
    onCall?.(spec);
    const result = typeof resultOrMap === "function"
      ? resultOrMap(spec.executable, spec.args)
      : resultOrMap;
    return {
      child: null as unknown as ChildProcess,
      result: Promise.resolve(result),
      cancel: () => undefined,
    };
  }) as typeof runCommand;
}

function buildRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    prompt: "Say hi.",
    route: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      backendKind: "anthropic-api-key",
      reasoning: "high",
    },
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
    workspaceRoot: process.cwd(),
    projectInstructions: {
      path: "AGENTS.md",
      content: "Be brief.",
    },
    ...overrides,
  };
}

async function withAnthropicEnv<T>(
  env: Partial<NodeJS.ProcessEnv>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalClaudeExe = process.env.CLAUDE_EXECUTABLE;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const isolatedHome = mkdtempSync(join(tmpdir(), "ubume-anthropic-home-"));
  try {
    process.env.HOME = isolatedHome;
    delete process.env.USERPROFILE;
    if ("ANTHROPIC_API_KEY" in env) {
      process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if ("CLAUDE_EXECUTABLE" in env) {
      process.env.CLAUDE_EXECUTABLE = env.CLAUDE_EXECUTABLE;
    } else {
      delete process.env.CLAUDE_EXECUTABLE;
    }
    resetAnthropicRouteValidationCacheForTests();
    return await callback();
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalClaudeExe === undefined) {
      delete process.env.CLAUDE_EXECUTABLE;
    } else {
      process.env.CLAUDE_EXECUTABLE = originalClaudeExe;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(isolatedHome, { recursive: true, force: true });
    resetAnthropicRouteValidationCacheForTests();
  }
}

// ---------------------------------------------------------------------------
// API key route
// ---------------------------------------------------------------------------

test("Anthropic runtime sends prompts through the Messages API", async () => {
  await withAnthropicEnv({ ANTHROPIC_API_KEY: "test-anthropic-key" }, async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    try {
      globalThis.fetch = (async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({
          content: [{ type: "text", text: "Hi from Claude." }],
        }), { status: 200 });
      }) as typeof fetch;

      const response = await new Promise<string>((resolve, reject) => {
        anthropicRuntime.run?.(buildRequest(), {
          onResponse: resolve,
          onError: reject,
        });
      });

      assert.equal(response, "Hi from Claude.");
      assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
      assert.equal(capturedInit?.method, "POST");
      assert.equal((capturedInit?.headers as Record<string, string>)["x-api-key"], "test-anthropic-key");
      assert.equal((capturedInit?.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Windows executable resolution
// ---------------------------------------------------------------------------

test("resolver: where.exe returns .exe path → validation uses that path", async () => {
  await withAnthropicEnv({}, async () => {
    const resolvedPaths: string[] = [];

    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") {
          return commandResult({ exitCode: 0, stdout: "C:\\Users\\Example\\.local\\bin\\claude.exe\n" });
        }
        // Track which executable is used for auth/version
        resolvedPaths.push(executable);
        if (executable === "C:\\Users\\Example\\.local\\bin\\claude.exe" && args[0] === "auth") {
          return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) });
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "claude-code-auth");
    assert.equal(validation.diagnostics?.["resolvedCommand"], "C:\\Users\\Example\\.local\\bin\\claude.exe");
    // The auth command should have used the resolved path, not bare "claude"
    assert.ok(
      resolvedPaths.some((p) => p === "C:\\Users\\Example\\.local\\bin\\claude.exe"),
      `Expected resolved path to be used for auth; got: ${resolvedPaths.join(", ")}`,
    );
  });
});

test("resolver: where.exe returns .cmd path → auth uses that path", async () => {
  await withAnthropicEnv({}, async () => {
    let authExecutable = "";

    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") {
          return commandResult({ exitCode: 0, stdout: "C:\\npm\\node_modules\\.bin\\claude.cmd\n" });
        }
        if (args.includes("auth")) authExecutable = executable;
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      }),
    });

    // .cmd files get wrapped: cmd.exe /d /s /c <path>
    // The auth runner should use cmd.exe (from buildClaudeSpawnSpec)
    assert.ok(
      authExecutable === "cmd.exe" || authExecutable === "C:\\npm\\node_modules\\.bin\\claude.cmd",
      `Expected cmd.exe or .cmd path for auth; got: ${authExecutable}`,
    );
  });
});

test("resolver: CLAUDE_EXECUTABLE env var is used without calling where.exe", async () => {
  // Use a bare (non-absolute) name so the resolver returns it without an existsSync check.
  await withAnthropicEnv({ CLAUDE_EXECUTABLE: "my-claude" }, async () => {
    let whereExeCalled = false;

    // We pass a custom runCommandImpl, so the resolver won't cache.
    // But CLAUDE_EXECUTABLE is checked BEFORE where.exe, so where.exe shouldn't be called.
    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe") whereExeCalled = true;
      if (args[0] === "auth") {
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      }
      return commandResult({ exitCode: 0 });
    });

    // Manually test the resolver (bypass the cache since we're injecting mockImpl)
    const { resolveClaudeExecutable } = await import("../executables/claudeExecutable.js");
    const resolved = await resolveClaudeExecutable({ runCommandImpl: mockImpl, cwd: process.cwd() });

    assert.equal(resolved, "my-claude", "Should use CLAUDE_EXECUTABLE directly");
    assert.equal(whereExeCalled, false, "Should not call where.exe when CLAUDE_EXECUTABLE is set");
  });
});

test("resolver: CLAUDE_EXECUTABLE set to nonexistent absolute path → validation returns not-configured", async () => {
  await withAnthropicEnv({ CLAUDE_EXECUTABLE: "C:\\nonexistent\\claude.exe" }, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand(commandResult({ exitCode: 0 })),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /CLAUDE_EXECUTABLE/);
    assert.match(validation.message!, /does not exist/);
  });
});

test("resolver: where.exe fails → uses known path or bare 'claude' fallback", async () => {
  await withAnthropicEnv({}, async () => {
    let usedExecutable = "";

    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") {
          return commandResult({ status: "failed", exitCode: 1, stdout: "" });
        }
        if (args[0] === "auth") usedExecutable = executable;
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      }),
    });

    // After where.exe fails, the resolver checks known Windows paths (e.g. %USERPROFILE%\bin\claude.exe).
    // On machines where a known path exists it is returned; otherwise bare "claude" is the final fallback.
    assert.ok(
      usedExecutable === "claude" ||
        usedExecutable.toLowerCase().endsWith("claude.exe") ||
        usedExecutable.toLowerCase().endsWith("claude.cmd") ||
        usedExecutable.toLowerCase().endsWith("claude.bat"),
      `Expected resolved executable to be 'claude' or a known path, got: "${usedExecutable}"`,
    );
  });
});

test("buildClaudeSpawnSpec wraps .bat files in cmd.exe on Windows", () => {
  if (process.platform !== "win32") return;
  const spec = buildClaudeSpawnSpec("C:\\some\\path\\claude.bat", ["-p", "hello"]);
  assert.equal(spec.executable, "cmd.exe");
  assert.ok(spec.args.includes("C:\\some\\path\\claude.bat"), "bat path should appear in args");
  assert.ok(spec.args.includes("call"), "cmd.exe should use call for batch files");
  assert.ok(spec.args.includes("/c"), "cmd.exe /c flag should be present");
});

test("buildClaudeSpawnSpec does not wrap .exe on Windows", () => {
  if (process.platform !== "win32") return;
  const spec = buildClaudeSpawnSpec("C:\\some\\claude.exe", ["-p", "hello"]);
  assert.equal(spec.executable, "C:\\some\\claude.exe");
  assert.deepEqual(spec.args, ["-p", "hello"]);
});

// ---------------------------------------------------------------------------
// Auth JSON parsing
// ---------------------------------------------------------------------------

test("parseClaudeAuthStatus: loggedIn true with all fields", () => {
  const result = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  }));

  assert.ok(result !== null);
  assert.equal(result?.loggedIn, true);
  assert.equal(result?.authMethod, "claude.ai");
  assert.equal(result?.apiProvider, "firstParty");
  assert.equal(result?.subscriptionType, "pro");
});

test("parseClaudeAuthStatus: loggedIn false", () => {
  const result = parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }));
  assert.ok(result !== null);
  assert.equal(result?.loggedIn, false);
});

test("parseClaudeAuthStatus: malformed JSON returns null", () => {
  assert.equal(parseClaudeAuthStatus("{bad json}"), null);
  assert.equal(parseClaudeAuthStatus("plain text"), null);
  assert.equal(parseClaudeAuthStatus(""), null);
});

test("parseClaudeAuthStatus: valid JSON but not an object returns null", () => {
  assert.equal(parseClaudeAuthStatus('"string"'), null);
  assert.equal(parseClaudeAuthStatus("42"), null);
  assert.equal(parseClaudeAuthStatus("null"), null);
});

// ---------------------------------------------------------------------------
// Route validation with auth JSON
// ---------------------------------------------------------------------------

test("validateAnthropicRoute: exit 0 + loggedIn true → ready with auth diagnostics", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") {
          return commandResult({
            exitCode: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }),
          });
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "claude-code-auth");
    assert.match(validation.message!, /claude\.ai/);
    assert.equal(validation.diagnostics?.["loggedIn"], true);
    assert.equal(validation.diagnostics?.["authMethod"], "claude.ai");
    assert.equal(validation.diagnostics?.["subscriptionType"], "pro");
  });
});

test("validateAnthropicRoute: exit 0 + loggedIn false → not-configured with login hint", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") {
          return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) });
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /not signed in/i);
    assert.match(validation.message!, /auth login/);
    assert.equal(validation.diagnostics?.["loggedIn"], false);
  });
});

test("validateAnthropicRoute: exit 0 + malformed JSON → not configured", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") {
          return commandResult({ exitCode: 0, stdout: "authenticated\n" }); // non-JSON output
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /valid JSON/i);
    assert.equal(validation.diagnostics?.["authJsonParsed"], false);
  });
});

test("validateAnthropicRoute: exit 0 prefers claude-code-auth over API key", async () => {
  await withAnthropicEnv({ ANTHROPIC_API_KEY: "anthropic-key" }, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "claude\n" });
        if (args[0] === "auth") {
          return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "claude-code-auth");
  });
});

test("validateAnthropicRoute: exit 1 falls back to ANTHROPIC_API_KEY", async () => {
  await withAnthropicEnv({ ANTHROPIC_API_KEY: "anthropic-key" }, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "claude\n" });
        if (args[0] === "auth") return commandResult({ status: "failed", exitCode: 1 });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "ready");
    assert.equal(validation.backendKind, "anthropic-api-key");
  });
});

test("validateAnthropicRoute: exit 1 + no API key → not signed in message", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "claude\n" });
        if (args[0] === "auth") return commandResult({ status: "failed", exitCode: 1 });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /not signed in/i);
    assert.match(validation.message!, /auth login/);
  });
});

test("validateAnthropicRoute: ENOENT + no API key → command not found message", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ status: "spawn_error", exitCode: null, errorCode: "ENOENT" });
        return commandResult({ status: "spawn_error", exitCode: null, errorCode: "ENOENT" });
      }),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /not found|Install Claude Code/i);
  });
});

test("validateAnthropicRoute: timeout → timeout message", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "claude\n" });
        if (args[0] === "auth") return commandResult({ status: "timeout", exitCode: null });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.status, "not-configured");
    assert.match(validation.message!, /timed out/i);
    assert.match(validation.message!, /auth status/);
  });
});

test("validateAnthropicRoute: diagnostics include resolvedCommand", async () => {
  await withAnthropicEnv({}, async () => {
    const validation = await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\Users\\Example\\.local\\bin\\claude.exe\n" });
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(validation.diagnostics?.["resolvedCommand"], "C:\\Users\\Example\\.local\\bin\\claude.exe");
    assert.equal(validation.diagnostics?.["authCommand"], "C:\\Users\\Example\\.local\\bin\\claude.exe auth status");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeSpawnSpec
// ---------------------------------------------------------------------------

test("buildClaudeSpawnSpec: .exe path returns as-is", () => {
  const spec = buildClaudeSpawnSpec("C:\\bin\\claude.exe", ["auth", "status"]);
  assert.equal(spec.executable, "C:\\bin\\claude.exe");
  assert.deepEqual(spec.args, ["auth", "status"]);
});

test("buildClaudeSpawnSpec: bare name returns as-is", () => {
  const spec = buildClaudeSpawnSpec("claude", ["-p", "hello"]);
  assert.equal(spec.executable, "claude");
  assert.deepEqual(spec.args, ["-p", "hello"]);
});

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

test("mapModelIdToClaudeArg: all model IDs pass through unchanged (short aliases and versioned)", () => {
  // Short aliases — Claude Code CLI accepts these directly
  assert.equal(mapModelIdToClaudeArg("sonnet"), "sonnet");
  assert.equal(mapModelIdToClaudeArg("opus"), "opus");
  assert.equal(mapModelIdToClaudeArg("haiku"), "haiku");
  // Full versioned IDs also pass through unchanged
  assert.equal(mapModelIdToClaudeArg("claude-sonnet-4-20250514"), "claude-sonnet-4-20250514");
  assert.equal(mapModelIdToClaudeArg("claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(mapModelIdToClaudeArg("claude-haiku-4-5"), "claude-haiku-4-5");
  // Unknown IDs pass through too
  assert.equal(mapModelIdToClaudeArg("my-custom-model"), "my-custom-model");
});

test("mapReasoningToEffort: maps low/medium/high correctly", () => {
  assert.equal(mapReasoningToEffort("low"), "low");
  assert.equal(mapReasoningToEffort("medium"), "medium");
  assert.equal(mapReasoningToEffort("high"), "high");
  assert.equal(mapReasoningToEffort("xhigh"), "xhigh");
  assert.equal(mapReasoningToEffort("max"), "max");
});

test("mapReasoningToEffort: passes through discovered levels and rejects missing values", () => {
  assert.equal(mapReasoningToEffort(null), null);
  assert.equal(mapReasoningToEffort(undefined), null);
  assert.equal(mapReasoningToEffort("ultra"), "ultra");
});

test("buildClaudeCodeArgs: includes -p, model, effort, permission-mode, and prompt", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      backendKind: "claude-code-auth",
      reasoning: "high",
    },
    prompt: "Hello world",
  });

  const args = buildClaudeCodeArgs(request);

  assert.ok(args.includes("-p"), "must include -p");
  assert.ok(args.includes("--verbose"), "stream-json mode must include --verbose");
  assert.ok(args.includes("--output-format"), "must include --output-format");
  assert.ok(args.includes("stream-json"), "must include stream-json value");
  assert.ok(args.includes("--include-partial-messages"), "must include --include-partial-messages");
  assert.ok(args.includes("--model"), "must include --model flag");
  assert.ok(args.includes("claude-sonnet-4-20250514"), "must pass versioned model ID through unchanged");
  assert.ok(args.includes("--effort"), "must include --effort");
  assert.ok(args.includes("high"), "must include high effort");
  assert.ok(args.includes("--permission-mode"), "must include --permission-mode");
  assert.ok(args.includes("default"), "must default to safe permission mode");
  assert.ok(args.includes("Hello world"), "must include the prompt");
});

for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
  test(`buildClaudeCodeArgs: includes --effort ${effort}`, () => {
    const request = buildRequest({
      route: {
        providerId: "anthropic",
        modelId: effort === "xhigh" ? "opus" : "sonnet",
        backendKind: "claude-code-auth",
        reasoning: effort,
      },
      prompt: `Hello ${effort}`,
    });

    const args = buildClaudeCodeArgs(request);
    const effortIndex = args.indexOf("--effort");
    assert.notEqual(effortIndex, -1, `missing --effort for ${effort}`);
    assert.equal(args[effortIndex + 1], effort);
  });
}

test("buildClaudeCodeArgs: stream-json command includes both --verbose and --effort", () => {
  const args = buildClaudeCodeArgs(buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "opus",
      backendKind: "claude-code-auth",
      reasoning: "xhigh",
    },
  }));

  assert.ok(args.includes("-p"), "must use print mode");
  assert.ok(args.includes("--output-format"), "must include output format");
  assert.ok(args.includes("stream-json"), "must use stream-json");
  assert.ok(args.includes("--verbose"), "stream-json print mode must include --verbose");
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
});

test("buildClaudeCodeArgs: omits --effort when reasoning is null", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      backendKind: "claude-code-auth",
      reasoning: undefined,
    },
  });

  const args = buildClaudeCodeArgs(request);
  assert.ok(!args.includes("--effort"), "--effort must not appear when reasoning is undefined");
});

test("buildClaudeCodePlainTextArgs: plain text command omits --verbose and stream-json flags", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "sonnet",
      backendKind: "claude-code-auth",
      reasoning: "low",
    },
    prompt: "Hello plain text",
  });

  const args = buildClaudeCodePlainTextArgs(request);
  assert.ok(args.includes("-p"), "plain text mode must still print");
  assert.ok(!args.includes("--verbose"), "plain text mode should not require --verbose");
  assert.ok(!args.includes("--output-format"), "plain text mode should not request stream-json");
  assert.ok(!args.includes("stream-json"), "plain text mode should not include stream-json value");
  assert.ok(!args.includes("--include-partial-messages"), "plain text mode should not request partial stream messages");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
});

test("ensureClaudeStreamJsonVerbose: inserts --verbose whenever print mode uses stream-json", () => {
  assert.deepEqual(
    ensureClaudeStreamJsonVerbose(["-p", "--output-format", "stream-json", "--model", "haiku", "Hi"]),
    ["-p", "--verbose", "--output-format", "stream-json", "--model", "haiku", "Hi"],
  );
  assert.deepEqual(
    ensureClaudeStreamJsonVerbose(["--print", "--output-format", "stream-json", "--model", "opus", "Hi"]),
    ["--print", "--verbose", "--output-format", "stream-json", "--model", "opus", "Hi"],
  );
  assert.deepEqual(
    ensureClaudeStreamJsonVerbose(["-p", "--verbose", "--output-format", "stream-json", "Hi"]),
    ["-p", "--verbose", "--output-format", "stream-json", "Hi"],
  );
  assert.deepEqual(
    ensureClaudeStreamJsonVerbose(["-p", "--model", "sonnet", "Hi"]),
    ["-p", "--model", "sonnet", "Hi"],
  );
});

test("Claude arg builders keep --model selectedModel", () => {
  for (const modelId of ["sonnet", "opus", "haiku", "claude-sonnet-4-20250514"]) {
    const request = buildRequest({
      route: {
        providerId: "anthropic",
        modelId,
        backendKind: "claude-code-auth",
      },
      prompt: "Hi",
    });
    for (const args of [buildClaudeCodeArgs(request), buildClaudeCodePlainTextArgs(request)]) {
      const modelIndex = args.indexOf("--model");
      assert.notEqual(modelIndex, -1, `missing --model for ${modelId}`);
      assert.equal(args[modelIndex + 1], modelId);
    }
  }
});

test("runClaudeCodeWithRunner: known stream-json verbose error falls back once to plain text", async () => {
  const calls: string[][] = [];
  const progress: string[] = [];
  const response = await new Promise<string>((resolve, reject) => {
    runClaudeCodeWithRunner(
      buildRequest({
        route: {
          providerId: "anthropic",
          modelId: "haiku",
          backendKind: "claude-code-auth",
        },
        prompt: "Hi",
      }),
      {
        onResponse: resolve,
        onError: reject,
        onProgress: (update) => progress.push(update.text),
      },
      mockRunCommand((executable, args) => {
        calls.push(args);
        if (args.includes("stream-json")) {
          return commandResult({
            status: "failed",
            exitCode: 1,
            stderr: "Error: When using --print, --output-format=stream-json requires --verbose",
            userMessage: "Error: When using --print, --output-format=stream-json requires --verbose",
          });
        }
        return commandResult({ stdout: "Hi from Claude.\n" });
      }),
      "claude",
    );
  });

  assert.equal(response, "Hi from Claude.");
  assert.equal(calls.length, 2, "must not retry forever");
  assert.ok(calls[0]?.includes("--verbose"), "first stream-json attempt should include --verbose");
  assert.ok(calls[0]?.includes("stream-json"), "first attempt should use stream-json");
  assert.ok(!calls[1]?.includes("stream-json"), "fallback attempt should use plain text");
  assert.ok(!calls[1]?.includes("--verbose"), "plain text fallback should not require --verbose");
  assert.ok(progress.some((line) => line.includes("--verbose")), "diagnostic should show whether --verbose was included");
});

test("runClaudeCodeWithRunner: invalid Claude effort falls back to model default once", async () => {
  const calls: string[][] = [];
  const progress: string[] = [];
  const response = await new Promise<string>((resolve, reject) => {
    runClaudeCodeWithRunner(
      buildRequest({
        route: {
          providerId: "anthropic",
          modelId: "opus",
          backendKind: "claude-code-auth",
          reasoning: "max",
        },
        prompt: "Hi",
      }),
      {
        onResponse: resolve,
        onError: reject,
        onProgress: (update) => progress.push(update.text),
      },
      mockRunCommand((executable, args) => {
        calls.push(args);
        if (args.includes("--effort") && args[args.indexOf("--effort") + 1] === "max") {
          return commandResult({
            status: "failed",
            exitCode: 2,
            stderr: "Invalid effort max for selected model. Valid efforts: low, medium, high, xhigh.",
            userMessage: "Invalid effort max for selected model.",
          });
        }
        return commandResult({ stdout: "Hi from xhigh.\n" });
      }),
      "claude",
    );
  });

  assert.equal(response, "Hi from xhigh.");
  assert.equal(calls.length, 2, "must retry only once");
  assert.deepEqual(calls[0]?.slice(calls[0].indexOf("--effort"), calls[0].indexOf("--effort") + 2), ["--effort", "max"]);
  assert.deepEqual(calls[1]?.slice(calls[1].indexOf("--effort"), calls[1].indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.ok(progress.some((line) => /retrying once with --effort xhigh/i.test(line)));
});

test("runClaudeCodeWithRunner: invalid medium effort reports error without looping", async () => {
  const calls: string[][] = [];
  const error = await new Promise<{ message: string; rawOutput?: string }>((resolve) => {
    runClaudeCodeWithRunner(
      buildRequest({
        route: {
          providerId: "anthropic",
          modelId: "haiku",
          backendKind: "claude-code-auth",
          reasoning: "medium",
        },
      }),
      {
        onResponse: () => assert.fail("unexpected response"),
        onError: (message, rawOutput) => resolve({ message, rawOutput }),
      },
      mockRunCommand((executable, args) => {
        calls.push(args);
        return commandResult({
          status: "failed",
          exitCode: 2,
          stderr: "Invalid effort medium for selected model.",
          userMessage: "Invalid effort medium for selected model.",
        });
      }),
      "claude",
    );
  });

  assert.equal(calls.length, 1);
  assert.match(error.message, /Invalid effort medium/);
  assert.match(error.rawOutput ?? "", /Claude Code command args/);
});

test("runClaudeCodeWithRunner: non-retryable CLI argument error reports safe command args once", async () => {
  const calls: string[][] = [];
  const error = await new Promise<{ message: string; rawOutput?: string }>((resolve) => {
    runClaudeCodeWithRunner(
      buildRequest({ prompt: "Sensitive prompt body" }),
      {
        onResponse: () => assert.fail("unexpected response"),
        onError: (message, rawOutput) => resolve({ message, rawOutput }),
      },
      mockRunCommand((executable, args) => {
        calls.push(args);
        return commandResult({
          status: "failed",
          exitCode: 2,
          stderr: "unknown option: --bad",
          userMessage: "unknown option: --bad",
        });
      }),
      "claude",
    );
  });

  assert.equal(calls.length, 1);
  assert.match(error.message, /unknown option/);
  assert.match(error.rawOutput ?? "", /Claude Code command args/);
  assert.match(error.rawOutput ?? "", /--verbose/);
  assert.match(error.rawOutput ?? "", /<prompt redacted: 21 chars>/);
  assert.doesNotMatch(error.rawOutput ?? "", /Sensitive prompt body/);
});

// ---------------------------------------------------------------------------
// Stream-JSON parsing
// ---------------------------------------------------------------------------

test("tryParseStreamJsonDelta: extracts text from valid assistant event", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hello there" }],
    },
  });

  assert.equal(tryParseStreamJsonDelta(line), "Hello there");
});

test("tryParseStreamJsonDelta: returns null for non-assistant event types", () => {
  const line = JSON.stringify({ type: "system", data: {} });
  assert.equal(tryParseStreamJsonDelta(line), null);
});

test("tryParseStreamJsonDelta: returns null for assistant event with no text content", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tool1" }],
    },
  });
  assert.equal(tryParseStreamJsonDelta(line), null);
});

test("tryParseStreamJsonDelta: returns false for malformed JSON — does not throw", () => {
  assert.equal(tryParseStreamJsonDelta("{not valid json}"), false);
  assert.equal(tryParseStreamJsonDelta("plain text line"), false);
  assert.equal(tryParseStreamJsonDelta(""), null);
});

test("tryParseStreamJsonDelta: returns false for partial/truncated JSON", () => {
  assert.equal(tryParseStreamJsonDelta('{"type":"assistant"'), false);
});

test("tryParseStreamJsonDelta: concatenates multiple text parts", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    },
  });
  assert.equal(tryParseStreamJsonDelta(line), "Hello world");
});

// ---------------------------------------------------------------------------
// Integration: arg building with resolved exe
// ---------------------------------------------------------------------------

test("integration: validation stores resolved exe used by subsequent execution", async () => {
  await withAnthropicEnv({}, async () => {
    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        return commandResult({ exitCode: 0 });
      }),
    });

    // buildClaudeCodeArgs does not depend on the resolved exe — just verifies args shape
    const request = buildRequest({
      route: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        backendKind: "claude-code-auth",
        reasoning: "medium",
      },
      prompt: "Hello",
    });
    const args = buildClaudeCodeArgs(request);
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("claude-sonnet-4-20250514"));
    assert.ok(args.includes("medium"));
  });
});

// ---------------------------------------------------------------------------
// Claude Code model discovery
// ---------------------------------------------------------------------------

test("discoverModels returns ANTHROPIC_FALLBACK_MODELS before any validation", () => {
  resetAnthropicRouteValidationCacheForTests();
  const { discoverModels } = anthropicRuntime;
  const result = discoverModels();
  assert.equal(result.status, "ready");
  assert.ok(result.models.length > 0, "Should have models");
  const ids = result.models.map((m) => m.modelId);
  assert.ok(ids.includes("sonnet"), "Should include sonnet alias");
  assert.ok(ids.includes("opus"), "Should include opus alias");
  assert.ok(ids.includes("haiku"), "Should include haiku alias");
  assert.ok(ids.includes("fable"), "Should include fable alias");
  for (const m of result.models) {
    assert.ok(!m.modelId.startsWith("gpt-"), "Must not include OpenAI models");
  }
  assert.deepEqual(result.models.find((m) => m.modelId === "opus")?.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(result.models.find((m) => m.modelId === "sonnet")?.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(result.models.find((m) => m.modelId === "haiku")?.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);
});

test("discoverModels uses Claude Code model-list result when available", async () => {
  await withAnthropicEnv({}, async () => {
    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json\n" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json\n" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({ exitCode: 0, stdout: JSON.stringify({
          models: [
            { value: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "sonnet", canonicalId: "claude-sonnet-4-6", effortLevels: ["low", "medium", "high", "max"], defaultEffort: "high" },
            { value: "claude-opus-4-8", label: "Opus 4.8", family: "opus", canonicalId: "claude-opus-4-8", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "xhigh" },
            { value: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku", canonicalId: "claude-haiku-4-5", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
          ],
        }) });
      }
      return commandResult({ exitCode: 0 });
    });
    await validateAnthropicRoute({ cwd: process.cwd(), runCommandImpl: mockImpl });

    const result = anthropicRuntime.discoverModels();
    assert.equal(result.status, "ready");
    assert.ok(result.models.length === 3, "Should have 3 discovered models");

    const sonnet = result.models.find((m) => m.modelId === "claude-sonnet-4-6");
    const opus = result.models.find((m) => m.modelId === "claude-opus-4-8");
    const haiku = result.models.find((m) => m.modelId === "claude-haiku-4-5");
    assert.ok(sonnet, "Should include sonnet");
    assert.ok(opus, "Should include opus");
    assert.ok(haiku, "Should include haiku");

    assert.equal(sonnet?.source, "claude-code-command", "Sonnet should be marked as Claude Code command discovered");
    assert.equal(opus?.source, "claude-code-command", "Opus should be marked as Claude Code command discovered");
    assert.equal(haiku?.source, "claude-code-command", "Haiku should be marked as Claude Code command discovered");

    assert.equal(sonnet?.label, "Claude Sonnet 4.6");
    assert.equal(opus?.label, "Claude Opus 4.8");
    assert.equal(haiku?.label, "Claude Haiku 4.5");
    assert.ok(!result.models.some((model) => /Claude\s+Opus\s+4\.7|Opus\s+4\.7/.test(model.label)));
  });
});

test("Claude capability discovery uses settings availableModels when CLI model list is unavailable", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-claude-settings-"));
  try {
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ["sonnet"],
      effortLevel: "max",
    }), "utf-8");

    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      settingsPath,
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        if (args.includes("--help")) return commandResult({ exitCode: 0, stdout: "no model json command here" });
        return commandResult({ exitCode: 0, stdout: "" });
      }),
    });

    assert.equal(discovery.modelSource, "settings");
    assert.equal(discovery.models.length, 1);
    assert.equal(discovery.models[0]?.value, "sonnet");
    assert.equal(discovery.models[0]?.source, "settings");
    assert.equal(discovery.settings?.effortLevel, "max");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverModels returns fallback-source models when version check fails", async () => {
  await withAnthropicEnv({}, async () => {
    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
      if (args[0] === "--version") return commandResult({ exitCode: 1, stdout: "" });
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      return commandResult({ exitCode: 0 });
    });
    await validateAnthropicRoute({ cwd: process.cwd(), runCommandImpl: mockImpl });

    const result = anthropicRuntime.discoverModels();
    assert.ok(result.models.length > 0);
    for (const m of result.models) {
      assert.equal(m.source, "fallback", `Model ${m.modelId} should be fallback when version fails`);
    }
  });
});

test("refreshModels returns correct structure with Claude model labels", async () => {
  // refreshModels uses the real claude executable; just verify structural correctness.
  if (!anthropicRuntime.refreshModels) {
    assert.fail("anthropicRuntime.refreshModels should be defined");
  }
  const result = await anthropicRuntime.refreshModels({ cwd: process.cwd() });
  assert.equal(result.status, "ready");
  assert.equal(result.providerId, "anthropic");
  assert.ok(result.models.length > 0, "Should return Claude models");

  const ids = result.models.map((m) => m.modelId);
  assert.ok(ids.every((id) => !id.startsWith("gpt-")), "Must not include OpenAI models");

  // Source must be explicit and provider-owned.
  for (const m of result.models) {
    assert.ok(
      [
        "claude-code-command",
        "claude-code-package",
        "claude-code-cache",
        "claude-code-config",
        "settings",
        "config",
        "fallback",
      ].includes(m.source ?? ""),
      `Unexpected source: ${m.source}`,
    );
    assert.match(m.label, /^Claude /);
    assert.match(m.label, /version unknown|\d+(?:\.\d+)?/i);
  }
});

test("refreshModels keeps previous good capability data on failure", async () => {
  await withAnthropicEnv({}, async () => {
    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockRunCommand((executable, args) => {
        if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
        if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
        if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
          return commandResult({ exitCode: 0, stdout: JSON.stringify({
            models: [{ value: "sonnet", label: "Sonnet 4.6", family: "sonnet", effortLevels: ["low", "medium", "high", "max"], defaultEffort: "high" }],
          }) });
        }
        return commandResult({ exitCode: 0 });
      }),
    });

    const before = anthropicRuntime.discoverModels();
    assert.ok(before.models.some((model) => model.source === "claude-code-command"));
    process.env.CLAUDE_EXECUTABLE = "C:\\definitely-missing\\claude.exe";

    const refreshed = await anthropicRuntime.refreshModels?.({ cwd: process.cwd() });
    assert.equal(refreshed?.status, "ready");
    assert.match(refreshed?.message ?? "", /keeping previous Claude capability data/i);
    assert.ok(refreshed?.models.some((model) => model.source === "claude-code-command"));
    assert.equal(refreshed?.diagnostics?.["refreshFailed"], true);
  });
});

test("buildClaudeCodeArgs uses short alias 'sonnet' directly as --model arg", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "sonnet",
      backendKind: "claude-code-auth",
      reasoning: "high",
    },
    prompt: "Hello",
  });
  const args = buildClaudeCodeArgs(request);
  assert.ok(args.includes("sonnet"), "Short alias 'sonnet' must be passed through to --model");
  assert.ok(!args.some((a) => a.startsWith("claude-sonnet")), "Must not remap to a versioned ID");
});

test("buildClaudeCodeArgs uses short alias 'opus' directly as --model arg", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "opus",
      backendKind: "claude-code-auth",
    },
    prompt: "Hello",
  });
  const args = buildClaudeCodeArgs(request);
  assert.ok(args.includes("opus"), "Short alias 'opus' must be passed through to --model");
  assert.ok(!args.some((a) => a.startsWith("claude-opus")), "Must not remap to a versioned ID");
});

test("buildClaudeCodeArgs uses short alias 'haiku' directly as --model arg", () => {
  const request = buildRequest({
    route: {
      providerId: "anthropic",
      modelId: "haiku",
      backendKind: "claude-code-auth",
    },
    prompt: "Hello",
  });
  const args = buildClaudeCodeArgs(request);
  assert.ok(args.includes("haiku"), "Short alias 'haiku' must be passed through to --model");
  assert.ok(!args.some((a) => a.startsWith("claude-haiku")), "Must not remap to a versioned ID");
});

test("malformed stream-json lines do not crash (no throw)", () => {
  const malformedLines = ["{bad json}", "some plain text", '{"type":"assistant"'];
  for (const line of malformedLines) {
    const result = tryParseStreamJsonDelta(line);
    assert.equal(result, false, `Line "${line}" should return false`);
  }

  assert.equal(tryParseStreamJsonDelta("   "), null);
  assert.equal(tryParseStreamJsonDelta("\n"), null);
});
