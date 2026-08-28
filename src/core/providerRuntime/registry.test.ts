import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import {
  discoverProviderModels,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  isProviderRouteConfigured,
  resolveActiveProviderRoute,
  getDefaultRouteModel,
} from "./registry.js";

test("every supported external provider exposes the shared planning run path", () => {
  for (const providerId of ["openai", "anthropic", "mistral", "antigravity", "local"] as const) {
    const runtime = getProviderRuntime(providerId);
    assert.equal(runtime.routeAvailable, true, `${providerId} must remain routable for plan mode`);
    assert.equal(typeof runtime.run, "function", `${providerId} must accept shared plan requests`);
  }
});
import { resetGeminiRouteValidationCacheForTests } from "./gemini.js";
import { resetAnthropicRouteValidationCacheForTests, validateAnthropicRoute } from "./anthropic.js";
import { checkLocalProvider, resetLocalProviderStateForTests } from "./local.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  discoverAgyModels,
  resetAntigravityRouteValidationCacheForTests,
} from "./antigravity.js";

test("google runtime exposes configured Gemini models for in-Codexa routing", () => {
  const runtime = getProviderRuntime("google");
  const discovery = discoverProviderModels("google");

  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.backendKind, "gemini-cli-auth");
  assert.equal(discovery.status, "ready");
  assert.ok(discovery.models.length > 0);
});

test("anthropic runtime exposes configured Claude models for in-Codexa routing", () => {
  const runtime = getProviderRuntime("anthropic");
  const discovery = discoverProviderModels("anthropic");

  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.backendKind, "claude-code-auth");
  assert.equal(discovery.status, "ready");
  assert.ok(discovery.models.length > 0);
});

test("active route resolution falls back from legacy google routes", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-2.5-pro",
      backendKind: "gemini-cli-auth",
      reasoning: "medium",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.deepEqual(route, {
    providerId: "openai",
    modelId: "gpt-5.4",
    backendKind: "codex-cli-auth",
    reasoning: "high",
  });
});

test("active route resolution falls back from legacy Gemini 3 Flash routes", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-3-flash",
      backendKind: "gemini-cli-auth",
      reasoning: "high",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });

  assert.deepEqual(route, {
    providerId: "openai",
    modelId: "gpt-5.4",
    backendKind: "codex-cli-auth",
    reasoning: "medium",
  });
});

test("active route resolution preserves routable anthropic routes", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      backendKind: "anthropic-api-key",
      reasoning: "high",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });

  assert.deepEqual(route, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    backendKind: "anthropic-api-key",
    reasoning: "high",
  });
});

test("active route resolution preserves routable local routes", async () => {
  resetLocalProviderStateForTests();
  await checkLocalProvider({
    fetchImpl: (async () => new Response(JSON.stringify({
      data: [{ id: "llama-local" }],
    }), { status: 200 })) as typeof fetch,
  });
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "local",
      modelId: "llama-local",
      backendKind: "local-openai-compatible",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.deepEqual(route, {
    providerId: "local",
    modelId: "llama-local",
    backendKind: "local-openai-compatible",
    localBackend: "lm-studio",
  });
  resetLocalProviderStateForTests();
});

test("active route resolution preserves an explicit Unsloth backend", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "local",
      modelId: "Qwen3.8-27B-UD-Q3_K_XL",
      backendKind: "local-openai-compatible",
      localBackend: "unsloth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "low",
  });

  assert.deepEqual(route, {
    providerId: "local",
    modelId: "Qwen3.8-27B-UD-Q3_K_XL",
    backendKind: "local-openai-compatible",
    localBackend: "unsloth",
  });
});

// ─── CLI --model override precedence ─────────────────────────────────────────
// These tests mirror the app-level logic: when --model is given on the CLI,
// the caller constructs effectiveRoute = { ...savedRoute, modelId: cliModel }
// before passing it to resolveActiveProviderRoute. The tests verify the resolver
// honours that override correctly.

test("CLI model override wins over persisted OpenAI activeRoute model", () => {
  // Simulate: providers.json has gpt-5.4-mini, but user ran --model gpt-5.5
  const cliModel = "gpt-5.5";
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };
  const effectiveRoute = { ...savedRoute, modelId: cliModel };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: effectiveRoute,
    currentModel: "gpt-5.5",
    currentReasoning: "low",
  });

  assert.equal(route.modelId, "gpt-5.5", "CLI model must be used for the run, not providers.json model");
  assert.equal(route.providerId, "openai");
});

test("without CLI model override the persisted providers.json activeRoute model is used", () => {
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: savedRoute,
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.equal(route.modelId, "gpt-5.4-mini", "Without CLI override, persisted model must win over layered-config default");
});

test("CLI model override preserves provider from providers.json activeRoute", () => {
  // --model on the CLI should not change the provider, only the modelId
  const cliModel = "gpt-5.5";
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };
  const effectiveRoute = { ...savedRoute, modelId: cliModel };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: effectiveRoute,
    currentModel: cliModel,
    currentReasoning: "low",
  });

  assert.equal(route.providerId, "openai", "Provider from providers.json must be preserved");
  assert.equal(route.modelId, cliModel);
  assert.equal(route.reasoning, "low", "Reasoning from providers.json must be preserved");
});

test("antigravity runtime has routeAvailable and correct backendKind", async () => {
  resetAntigravityRouteValidationCacheForTests();
  await discoverAgyModels({
    executable: "agy",
    cwd: process.cwd(),
    platform: process.platform,
    runCommandImpl: (() => ({
      child: null as never,
      result: Promise.resolve({
        status: "completed" as const,
        exitCode: 0,
        signal: null,
        stdout: "Gemini 3.5 Flash\nGemini 3.1 Pro\nClaude 3.7 Sonnet\nClaude 3.5 Sonnet\nGPT-OSS 120B\n",
        stderr: "",
        startedAt: 0,
        endedAt: 0,
        durationMs: 0,
        userMessage: "Command completed.",
      }),
      cancel: () => {},
    })) as typeof runCommand,
  });
  const runtime = getProviderRuntime("antigravity");
  const discovery = discoverProviderModels("antigravity");

  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.backendKind, "antigravity-cli-auth");
  assert.equal(discovery.status, "ready");
  assert.equal(discovery.models.length, 5);
  assert.equal(discovery.providerId, "antigravity");
  resetAntigravityRouteValidationCacheForTests();
});

test("Mistral Vibe runtime is routable in Codexa and exposes the configured model", () => {
  const runtime = getProviderRuntime("mistral");
  const discovery = discoverProviderModels("mistral");

  assert.equal(runtime.label, "Mistral Vibe CLI");
  assert.equal(runtime.backendKind, "mistral-vibe-cli-auth");
  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.launchAvailable, true);
  assert.equal(typeof runtime.run, "function");
  assert.equal(typeof runtime.refreshModels, "function");
  assert.equal(typeof runtime.validateRoute, "function");
  assert.equal(discovery.providerId, "mistral");
  assert.equal(discovery.backendKind, "mistral-vibe-cli-auth");
  assert.ok(discovery.models[0]?.modelId);
});

test("getDefaultRouteModel prefers discovered Antigravity models and otherwise uses the default", () => {
  const model = getDefaultRouteModel("antigravity", "gpt-5.4");
  const discovered = discoverProviderModels("antigravity").models[0]?.modelId;

  assert.equal(model, discovered ?? ANTIGRAVITY_DEFAULT_MODEL_ID);
});

test("active route resolution preserves routable antigravity routes with reasoning", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "antigravity",
      modelId: "gemini-3.5-flash",
      backendKind: "antigravity-cli-auth",
      reasoning: "medium",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.deepEqual(route, {
    providerId: "antigravity",
    modelId: "gemini-3.5-flash",
    backendKind: "antigravity-cli-auth",
    reasoning: "medium",
  });
});

test("active route resolution migrates legacy compound antigravity model IDs", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "antigravity",
      modelId: "gemini-3.5-flash-high",
      backendKind: "antigravity-cli-auth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.equal(route.modelId, "gemini-3.5-flash");
  assert.equal(route.reasoning, "high");
});

test("active route resolution migrates legacy gemini-3.1-pro-low to family and reasoning", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "antigravity",
      modelId: "gemini-3.1-pro-low",
      backendKind: "antigravity-cli-auth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.equal(route.modelId, "gemini-3.1-pro");
  assert.equal(route.reasoning, "low");
});

// ─── Authentication and setup gates ──────────────────────────────────────────

test("anthropic route configuration is gated by ANTHROPIC_API_KEY or Claude Code", () => {
  const original = process.env.ANTHROPIC_API_KEY;

  try {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicRouteValidationCacheForTests();
    assert.equal(isProviderRouteConfigured("anthropic"), false);
    assert.match(getProviderRouteSetupMessage("anthropic"), /set ANTHROPIC_API_KEY/);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("google route configuration is gated by Gemini API key or validated headless CLI", () => {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGoogle = process.env.GOOGLE_API_KEY;

  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    resetGeminiRouteValidationCacheForTests();
    assert.equal(isProviderRouteConfigured("google"), false);
    assert.match(getProviderRouteSetupMessage("google"), /GEMINI_API_KEY \/ GOOGLE_API_KEY/);
  } finally {
    if (originalGemini) process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoogle) process.env.GOOGLE_API_KEY = originalGoogle;
  }
});

test("local route configuration is gated by endpoint model discovery", async () => {
  resetLocalProviderStateForTests();
  assert.equal(isProviderRouteConfigured("local"), false);

  await checkLocalProvider({
    fetchImpl: (async (input) => {
      if (String(input).includes("/api/v0/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({
        data: [{ id: "google/gemma-4-26b-a4b" }],
      }), { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(isProviderRouteConfigured("local"), true);
  resetLocalProviderStateForTests();
});

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
): typeof runCommand {
  return ((spec) => {
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

async function withEmptyClaudeSettingsHome(run: () => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = mkdtempSync(join(tmpdir(), "codexa-claude-empty-"));

  try {
    process.env.HOME = tempHome;
    delete process.env.USERPROFILE;
    await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    rmSync(tempHome, { recursive: true, force: true });
  }
}

test("Provider isolation: discoverProviderModels('openai') returns empty models array regardless of anthropic discovery state", async () => {
  await withEmptyClaudeSettingsHome(async () => {
  resetAnthropicRouteValidationCacheForTests();

  // Initially openai is empty
  const initialOpenai = discoverProviderModels("openai");
  assert.deepEqual(initialOpenai.models, []);

  // Mock-validate anthropic to populate cache
  const mockImpl = mockRunCommand((executable, args) => {
    if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
    if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
    if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json\n" });
    if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json\n" });
    if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
      return commandResult({ exitCode: 0, stdout: JSON.stringify({
        models: [
          { value: "claude-sonnet-4-98", label: "Claude Sonnet 4.98", family: "sonnet", canonicalId: "claude-sonnet-4-98", effortLevels: ["low"], defaultEffort: "low" },
        ],
      }) });
    }
    return commandResult({ exitCode: 0 });
  });

  await validateAnthropicRoute({
    cwd: process.cwd(),
    runCommandImpl: mockImpl,
  });

  // Verify anthropic has discovered model
  const anthropicDiscovery = discoverProviderModels("anthropic");
  assert.equal(anthropicDiscovery.status, "ready");
  assert.ok(anthropicDiscovery.models.length > 0);
  assert.equal(anthropicDiscovery.models[0].modelId, "claude-sonnet-4-98");

  // Verify openai is still empty (isolated!)
  const postOpenai = discoverProviderModels("openai");
  assert.deepEqual(postOpenai.models, []);

  resetAnthropicRouteValidationCacheForTests();
  });
});

test("getDefaultRouteModel with discovered models: prefers discovered anthropic models when cache is populated", async () => {
  await withEmptyClaudeSettingsHome(async () => {
  resetAnthropicRouteValidationCacheForTests();

  // Cold cache: should return hardcoded default
  const coldDefault = getDefaultRouteModel("anthropic", "gpt-5.4");
  assert.equal(coldDefault, "fable"); // ANTHROPIC_FALLBACK_MODELS[0]?.modelId is "fable"

  // Mock-validate anthropic to populate cache
  const mockImpl = mockRunCommand((executable, args) => {
    if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
    if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
    if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json\n" });
    if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json\n" });
    if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
      return commandResult({ exitCode: 0, stdout: JSON.stringify({
        models: [
          { value: "claude-sonnet-4-99", label: "Claude Sonnet 4.99", family: "sonnet", canonicalId: "claude-sonnet-4-99", effortLevels: ["low"], defaultEffort: "low" },
        ],
      }) });
    }
    return commandResult({ exitCode: 0 });
  });

  await validateAnthropicRoute({
    cwd: process.cwd(),
    runCommandImpl: mockImpl,
  });

  // Warm cache: should return the first discovered model
  const warmDefault = getDefaultRouteModel("anthropic", "gpt-5.4");
  assert.equal(warmDefault, "claude-sonnet-4-99");

  resetAnthropicRouteValidationCacheForTests();
  });
});

test("resolveActiveProviderRoute selects first discovered Anthropic model when saved alias is stale", async () => {
  await withEmptyClaudeSettingsHome(async () => {
  resetAnthropicRouteValidationCacheForTests();

  const mockImpl = mockRunCommand((executable, args) => {
    if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
    if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
    if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
      return commandResult({ exitCode: 0, stdout: JSON.stringify([
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", family: "opus", effortLevels: ["low"], defaultEffort: "low" },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", family: "sonnet", effortLevels: ["low"], defaultEffort: "low" },
      ]) });
    }
    return commandResult({ exitCode: 1 });
  });

  await validateAnthropicRoute({
    cwd: process.cwd(),
    runCommandImpl: mockImpl,
  });

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "anthropic",
      modelId: "opus",
      backendKind: "claude-code-auth",
      reasoning: "high",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });

  assert.equal(route.modelId, "claude-opus-4-8");

  resetAnthropicRouteValidationCacheForTests();
  });
});
