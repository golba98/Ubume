import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderRegistry, getDefaultProviderId, isKnownProviderId } from "./registry.js";
import { checkLocalProvider, resetLocalProviderStateForTests } from "../providerRuntime/local.js";
import { setProviderActiveRoute, parseProviderWorkspaceConfig } from "./workspaceConfig.js";
import { resolveActiveProviderRoute } from "../providerRuntime/registry.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  discoverAgyModels,
  resetAntigravityRouteValidationCacheForTests,
} from "../providerRuntime/antigravity.js";
import { runCommand } from "../process/CommandRunner.js";

test("provider registry exposes Codexa Native in local-dev channel and excludes it in production", () => {
  const devProviders = buildProviderRegistry({ activeModel: "gpt-5.4", env: { UBUME_CHANNEL: "local-dev" } });
  assert.deepEqual(devProviders.map((provider) => provider.id), ["openai", "anthropic", "mistral", "codexa-native", "codexa-cupy", "local", "antigravity"]);
  assert.equal(devProviders[0]?.displayName, "OpenAI");
  assert.equal(devProviders[0]?.currentModel, "gpt-5.4");
  assert.deepEqual(devProviders[0]?.launchCommand, { executable: "codex", args: [] });
  assert.deepEqual(devProviders[1]?.launchCommand, { executable: "claude", args: [] });
  assert.equal(devProviders[2]?.displayName, "Mistral Vibe CLI");
  assert.equal(devProviders[2]?.backendType, "mistral-vibe-cli-auth");
  assert.equal(devProviders[2]?.routeMode, "in-ubume");
  assert.equal(devProviders[2]?.statusLabel, "Enabled");
  assert.deepEqual(devProviders[2]?.launchCommand, { executable: "vibe", args: [] });
  assert.equal(devProviders[3]?.displayName, "ubume-PyTorch");
  assert.equal(devProviders[3]?.backendType, "codexa-native-pytorch");
  assert.equal(devProviders[4]?.displayName, "CuPy");
  assert.equal(devProviders[4]?.backendType, "codexa-cupy");
  assert.equal(devProviders[3]?.launchCommand, null);
  assert.equal(devProviders[4]?.enabled, true);
  assert.equal(devProviders[4]?.launchCommand, null);
  assert.deepEqual(devProviders[6]?.launchCommand, { executable: "agy", args: [] });

  const prodProviders = buildProviderRegistry({ activeModel: "gpt-5.4", env: { UBUME_CHANNEL: "published" } });
  assert.deepEqual(prodProviders.map((provider) => provider.id), ["openai", "anthropic", "mistral", "local", "antigravity"]);
  assert.equal(prodProviders.find((p) => p.id === "codexa-native"), undefined);
  assert.equal(prodProviders.find((p) => p.id === "codexa-cupy"), undefined);
});

test("Codexa Native remains a known provider ID so workspace config preserves overrides when saved", () => {
  assert.equal(isKnownProviderId("codexa-native"), true);
  const parsed = parseProviderWorkspaceConfig({
    providers: {
      "codexa-native": { current_model: "codexa-1b-sft-v2-native" },
      openai: { current_model: "gpt-5.4" },
    },
  });
  assert.ok(parsed.providers?.["codexa-native"]);
  assert.equal(parsed.providers["codexa-native"].currentModel, "codexa-1b-sft-v2-native");
});

test("Mistral Vibe can be the workspace default without becoming the active chat route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "mistral",
      activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
    },
  });

  const mistral = providers.find((provider) => provider.id === "mistral");
  assert.equal(mistral?.isDefault, true);
  assert.equal(mistral?.isActiveRoute, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, true);
});

test("antigravity appears in the provider registry with correct defaults", async () => {
  resetAntigravityRouteValidationCacheForTests();
  try {
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
          stdout: "Gemini 3.5 Flash\n",
          stderr: "",
          startedAt: 0,
          endedAt: 0,
          durationMs: 0,
          userMessage: "Command completed.",
        }),
        cancel: () => {},
      })) as typeof runCommand,
    });

    const providers = buildProviderRegistry({ activeModel: "gpt-5.4", env: { UBUME_CHANNEL: "local-dev" } });
    const antigravity = providers.find((p) => p.id === "antigravity");

    assert.ok(antigravity, "antigravity provider not found");
    assert.equal(antigravity!.displayName, "Antigravity");
    assert.equal(antigravity!.currentModel, ANTIGRAVITY_DEFAULT_MODEL_ID);
    assert.deepEqual(antigravity!.launchCommand, { executable: "agy", args: [] });
    assert.equal(antigravity!.backendType, "antigravity-cli-auth");
    assert.equal(antigravity!.enabled, true);
  } finally {
    resetAntigravityRouteValidationCacheForTests();
  }
});

test("workspace config can set the default provider", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: { workspaceDefaultProviderId: "anthropic" },
  });

  assert.equal(getDefaultProviderId({ workspaceDefaultProviderId: "anthropic" }), "anthropic");
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isDefault, false);
});

test("provider registry keeps workspace default separate from active route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-5.4",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isActiveRoute, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isDefault, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, true);
});

test("unvalidated local provider remains disabled until endpoint discovery succeeds", () => {
  resetLocalProviderStateForTests();
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "local",
        modelId: "llama-local",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "local")?.isActiveRoute, true);
  assert.equal(providers.find((provider) => provider.id === "local")?.routeMode, "in-ubume");
  assert.equal(providers.find((provider) => provider.id === "local")?.enabled, false);
});

test("registry hides direct Google routes and falls back to OpenAI", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "google",
        modelId: "gemini-3-flash-preview",
        backendKind: "gemini-cli-auth",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "google"), undefined);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, true);
});

test("anthropic can be selected as an active in-Ubume route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        backendKind: "anthropic-api-key",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isActiveRoute, true);
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.routeMode, "in-ubume");
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.currentModel, "claude-sonnet-4-20250514");
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, false);
});

test("discovered local models enable local provider and display selected model", async () => {
  resetLocalProviderStateForTests();
  const localOverride = {
    currentModel: "google/gemma-4-26b-a4b",
  };
  await checkLocalProvider({
    override: localOverride,
    fetchImpl: (async (input) => {
      if (String(input).includes("/api/v0/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({
        data: [{ id: "google/gemma-4-26b-a4b" }],
      }), { status: 200 });
    }) as typeof fetch,
  });

  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "local",
        modelId: "google/gemma-4-26b-a4b",
        backendKind: "local-openai-compatible",
      },
      providers: {
        local: localOverride,
      },
    },
  });

  const local = providers.find((provider) => provider.id === "local");
  assert.equal(local?.enabled, true);
  assert.equal(local?.currentModel, "google/gemma-4-26b-a4b");
  assert.equal(local?.backendType, "local-openai-compatible");
  assert.equal(local?.statusLabel, "Enabled");
  assert.deepEqual(local?.launchCommand, null);
  resetLocalProviderStateForTests();
});

test("LM Studio loaded Local model replaces stale active route in provider registry", async () => {
  resetLocalProviderStateForTests();
  try {
    await checkLocalProvider({
      override: {
        currentModel: "google/gemma-4-26b-a4b",
        defaultModel: "google/gemma-4-26b-a4b",
        baseUrl: "http://localhost:1234/v1",
      },
      fetchImpl: (async (input) => {
        if (String(input).includes("/api/v0/")) {
          return new Response(JSON.stringify({
            data: [{
              id: "qwen/qwen3.6-27b",
              state: "loaded",
              loaded_context_length: 32000,
              max_context_length: 262144,
              capabilities: ["tool_use"],
            }],
            object: "list",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [{ id: "google/gemma-4-26b-a4b" }, { id: "qwen/qwen3.6-27b" }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    const providers = buildProviderRegistry({
      activeModel: "gpt-5.4",
      workspaceConfig: {
        activeRoute: {
          providerId: "local",
          modelId: "google/gemma-4-26b-a4b",
          backendKind: "local-openai-compatible",
        },
        providers: {
          local: {
            currentModel: "google/gemma-4-26b-a4b",
            defaultModel: "google/gemma-4-26b-a4b",
            baseUrl: "http://localhost:1234/v1",
          },
        },
      },
    });

    const local = providers.find((provider) => provider.id === "local");
    assert.equal(local?.currentModel, "qwen/qwen3.6-27b");
    assert.equal(local?.contextLengthLabel, "32,000");
    assert.equal(local?.contextLengthSource, "lmstudio-api");
    assert.equal(local?.capabilityProfile?.supportsToolCalls, true);
    assert.equal(local?.capabilityProfile?.supportsVision, null);
  } finally {
    resetLocalProviderStateForTests();
  }
});

test("Google cannot become the active route through the registry or runtime resolver", () => {
  const original: import("./types.js").ProviderWorkspaceConfig = {
    activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
  };
  const result = setProviderActiveRoute(original, {
    providerId: "google",
    modelId: "gemini-3-flash-preview",
    backendKind: "gemini-cli-auth",
  });
  assert.equal(result.activeRoute?.providerId, "openai");

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-3-flash-preview",
      backendKind: "gemini-cli-auth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });
  assert.equal(route.providerId, "openai");
  assert.equal(route.modelId, "gpt-5.4");
});
