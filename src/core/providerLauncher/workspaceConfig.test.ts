import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test, { afterEach, beforeEach } from "node:test";
import { buildProviderRegistry } from "./registry.js";
import { resetGeminiRouteValidationCacheForTests } from "../providerRuntime/gemini.js";
import { checkLocalProvider, resetLocalProviderStateForTests } from "../providerRuntime/local.js";
import {
  getProviderWorkspaceConfigFile,
  getLegacyProviderWorkspaceConfigFile,
  loadProviderWorkspaceConfig,
  parseProviderWorkspaceConfig,
  saveProviderWorkspaceConfig,
  serializeProviderWorkspaceConfig,
  setProviderActiveRoute,
  setProviderDefaultReasoning,
  setProviderDefaultModel,
  setProviderWorkspaceDefault,
} from "./workspaceConfig.js";

let testDataRoot = "";
let originalDataRoot: string | undefined;

beforeEach(() => {
  originalDataRoot = process.env.UBUME_DATA_DIR;
  testDataRoot = mkdtempSync(join(tmpdir(), "ubume-provider-test-data-"));
  process.env.UBUME_DATA_DIR = testDataRoot;
});

afterEach(() => {
  if (originalDataRoot === undefined) delete process.env.UBUME_DATA_DIR;
  else process.env.UBUME_DATA_DIR = originalDataRoot;
  rmSync(testDataRoot, { recursive: true, force: true });
});

function withGeminiEnv<T>(
  env: Partial<NodeJS.ProcessEnv>,
  callback: () => T,
): T {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGoogle = process.env.GOOGLE_API_KEY;

  try {
    if ("GEMINI_API_KEY" in env) {
      process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if ("GOOGLE_API_KEY" in env) {
      process.env.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    resetGeminiRouteValidationCacheForTests();
    return callback();
  } finally {
    if (originalGemini === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGemini;
    }
    if (originalGoogle === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = originalGoogle;
    }
    resetGeminiRouteValidationCacheForTests();
  }
}

test("parses provider workspace config from Ubume-owned JSON", () => {
  const config = parseProviderWorkspaceConfig({
    default_provider_id: "google",
    activeRoute: {
      providerId: "openai",
      modelId: "gpt-5.5",
      reasoning: "high",
    },
    providers: {
      local: {
        current_model: "llama",
        current_reasoning: "medium",
        type: "openai-compatible",
        base_url: "http://localhost:1234/v1",
        api_key: "lm-studio",
        default_model: "llama",
        command: "ollama",
      },
      unknown: {
        command: "ignored",
      },
    },
  });

  assert.equal(config.workspaceDefaultProviderId, "openai");
  assert.deepEqual(config.activeRoute, {
    providerId: "openai",
    modelId: "gpt-5.5",
    backendKind: "codex-cli-auth",
    reasoning: "high",
  });
  assert.deepEqual(config.providers?.local, {
    currentModel: "llama",
    currentReasoning: "medium",
    type: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    defaultModel: "llama",
    command: "ollama",
  });
  assert.equal("unknown" in (config.providers ?? {}), false);
  assert.equal(config.migrationNotice?.deprecatedProviderId, "google");
});

test("legacy Antigravity active/default config falls back to OpenAI and drops provider override", () => {
  const config = parseProviderWorkspaceConfig({
    workspaceDefaultProviderId: "antigravity",
    activeRoute: {
      providerId: "antigravity",
      modelId: "external-antigravity-default",
      backendKind: "antigravity-cli-auth",
      reasoning: "medium",
    },
    providers: {
      antigravity: {
        current_model: "external-antigravity-default",
        current_reasoning: "medium",
      },
      openai: {
        current_model: "gpt-5.4-mini",
        current_reasoning: "low",
      },
    },
  });

  assert.deepEqual(config.activeRoute, {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth",
    reasoning: "low",
  });
  assert.equal(config.workspaceDefaultProviderId, "openai");
  assert.equal(config.providers?.openai?.currentModel, "gpt-5.4-mini");
  assert.equal((config.providers as Record<string, unknown> | undefined)?.antigravity, undefined);
  assert.deepEqual(config.migrationNotice, {
    deprecatedProviderId: "antigravity",
    revertedProviderId: "openai",
  });
  assert.doesNotMatch(JSON.stringify(serializeProviderWorkspaceConfig(config)), /antigravity/i);
});

test("legacy Antigravity backend aliases are treated as deprecated routes", () => {
  const config = parseProviderWorkspaceConfig({
    active_route: {
      provider_id: "openai",
      model_id: "external-antigravity-default",
      backend_kind: "agy",
    },
  });

  assert.equal(config.activeRoute?.providerId, "openai");
  assert.equal(config.activeRoute?.backendKind, "codex-cli-auth");
  assert.equal(config.migrationNotice?.revertedProviderId, "openai");
});

test("serializes and persists provider workspace defaults", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-provider-config-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "ubume-provider-data-"));
  const previousDataRoot = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = dataRoot;
  try {
    const config = setProviderWorkspaceDefault({}, "anthropic");
    saveProviderWorkspaceConfig(tempRoot, config);

    assert.match(getProviderWorkspaceConfigFile(tempRoot), /ubume-provider-data-/);
    assert.doesNotMatch(getProviderWorkspaceConfigFile(tempRoot), /\.ubume/);
    assert.equal(existsSync(join(tempRoot, ".ubume")), false);
    assert.deepEqual(loadProviderWorkspaceConfig(tempRoot), {
      workspaceDefaultProviderId: "anthropic",
    });
    assert.deepEqual(serializeProviderWorkspaceConfig(config), {
      workspaceDefaultProviderId: "anthropic",
    });
  } finally {
    if (previousDataRoot === undefined) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previousDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("loads legacy provider settings without recreating the workspace directory", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "codexa-provider-legacy-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "ubume-provider-data-"));
  const previousDataRoot = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = dataRoot;
  try {
    const legacyFile = getLegacyProviderWorkspaceConfigFile(tempRoot);
    mkdirSync(join(legacyFile, ".."), { recursive: true });
    writeFileSync(legacyFile, JSON.stringify({ workspaceDefaultProviderId: "anthropic" }), "utf8");

    assert.deepEqual(loadProviderWorkspaceConfig(tempRoot), { workspaceDefaultProviderId: "anthropic" });
    assert.equal(existsSync(getProviderWorkspaceConfigFile(tempRoot)), false);

    saveProviderWorkspaceConfig(tempRoot, { workspaceDefaultProviderId: "openai" });
    assert.deepEqual(loadProviderWorkspaceConfig(tempRoot), { workspaceDefaultProviderId: "openai" });
    assert.equal(existsSync(legacyFile), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previousDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("Mistral Vibe workspace default and active route both round-trip", () => {
  const serialized = serializeProviderWorkspaceConfig({ workspaceDefaultProviderId: "mistral" });
  assert.deepEqual(serialized, { workspaceDefaultProviderId: "mistral" });
  assert.deepEqual(parseProviderWorkspaceConfig(serialized), { workspaceDefaultProviderId: "mistral" });

  const parsed = parseProviderWorkspaceConfig({
    workspaceDefaultProviderId: "mistral",
    activeRoute: {
      providerId: "mistral",
      modelId: "mistral-medium-3.5",
      backendKind: "mistral-vibe-cli-auth",
    },
  });
  assert.equal(parsed.workspaceDefaultProviderId, "mistral");
  assert.equal(parsed.activeRoute?.providerId, "mistral");
  assert.equal(parsed.activeRoute?.modelId, "mistral-medium-3.5");
});

test("saved Google workspace default is migrated to OpenAI before registry construction", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-provider-restart-"));
  try {
    saveProviderWorkspaceConfig(tempRoot, setProviderWorkspaceDefault({}, "google"));

    const loadedConfig = loadProviderWorkspaceConfig(tempRoot);
    const providers = buildProviderRegistry({
      activeModel: "gpt-5.4",
      workspaceConfig: loadedConfig,
    });

    assert.equal(providers.find((provider) => provider.id === "google"), undefined);
    assert.equal(providers.find((provider) => provider.id === "openai")?.isDefault, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace provider config reload preserves default and active route separately", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-provider-route-"));
  try {
    saveProviderWorkspaceConfig(tempRoot, {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-5.5",
        backendKind: "codex-cli-auth",
        reasoning: "high",
      },
    });

    assert.deepEqual(loadProviderWorkspaceConfig(tempRoot), {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-5.5",
        backendKind: "codex-cli-auth",
        reasoning: "high",
      },
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("active Anthropic route persists without secrets", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-provider-anthropic-route-"));
  const original = process.env.ANTHROPIC_API_KEY;

  try {
    process.env.ANTHROPIC_API_KEY = "secret-test-key";
    saveProviderWorkspaceConfig(tempRoot, {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        backendKind: "claude-code-auth",
        reasoning: "high",
      },
    });

    const loaded = loadProviderWorkspaceConfig(tempRoot);
    assert.deepEqual(loaded, {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        backendKind: "claude-code-auth",
        reasoning: "high",
      },
    });
    assert.doesNotMatch(JSON.stringify(serializeProviderWorkspaceConfig(loaded)), /secret-test-key/);
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setProviderActiveRoute rejects unconfigured Gemini routes", () => {
  withGeminiEnv({}, () => {
    const config = setProviderActiveRoute({
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-5.5",
        backendKind: "codex-cli-auth",
        reasoning: "high",
      },
    }, {
      providerId: "google",
      modelId: "gemini-2.5-flash",
      backendKind: "gemini-cli-auth",
      reasoning: "high",
    });

    assert.deepEqual(config.activeRoute, {
      providerId: "openai",
      modelId: "gpt-5.5",
      backendKind: "codex-cli-auth",
      reasoning: "high",
    });
  });
});

test("setProviderActiveRoute does not persist Google routes even when Gemini is configured", () => {
  withGeminiEnv({ GEMINI_API_KEY: "test-gemini-key" }, () => {
    const config = setProviderActiveRoute({}, {
      providerId: "google",
      modelId: "gemini-2.5-flash",
      backendKind: "gemini-api-key",
      reasoning: "high",
    });

    assert.equal(config.activeRoute, undefined);
    assert.doesNotMatch(JSON.stringify(serializeProviderWorkspaceConfig(config)), /test-gemini-key/);
  });
});

// ---------------------------------------------------------------------------
// setProviderDefaultModel
// ---------------------------------------------------------------------------

test("setProviderDefaultModel saves model without overwriting other provider fields", () => {
  const initial = {
    providers: {
      anthropic: { currentModel: "opus", currentReasoning: "high", enabled: true },
      google: { currentModel: "gemini-2.5-pro" },
    },
  };
  const updated = setProviderDefaultModel(initial, "anthropic", "sonnet");
  assert.equal(updated.providers?.["anthropic"]?.currentModel, "sonnet");
  assert.equal(updated.providers?.["anthropic"]?.currentReasoning, "high", "reasoning must be preserved");
  assert.equal(updated.providers?.["anthropic"]?.enabled, true, "enabled flag must be preserved");
  assert.equal(updated.providers?.["google"]?.currentModel, "gemini-2.5-pro", "other provider unchanged");
});

test("setProviderDefaultModel creates providers entry when none exists", () => {
  const config = setProviderDefaultModel({}, "anthropic", "haiku");
  assert.equal(config.providers?.["anthropic"]?.currentModel, "haiku");
});

test("setProviderDefaultModel round-trips through serialize/parse", () => {
  const config = setProviderDefaultModel({}, "anthropic", "sonnet");
  const serialized = serializeProviderWorkspaceConfig(config);
  const reparsed = parseProviderWorkspaceConfig(serialized);
  assert.equal(reparsed.providers?.["anthropic"]?.currentModel, "sonnet");
});

test("setProviderDefaultReasoning saves provider-scoped reasoning without touching other providers", () => {
  const initial = {
    providers: {
      openai: { currentReasoning: "high" },
      anthropic: { currentModel: "sonnet", currentReasoning: "medium" },
    },
  };
  const updated = setProviderDefaultReasoning(initial, "anthropic", "max");
  assert.equal(updated.providers?.anthropic?.currentModel, "sonnet");
  assert.equal(updated.providers?.anthropic?.currentReasoning, "max");
  assert.equal(updated.providers?.openai?.currentReasoning, "high");
});

test("provider default reasoning round-trips through serialize/parse", () => {
  const config = setProviderDefaultReasoning(
    setProviderDefaultModel({}, "anthropic", "sonnet"),
    "anthropic",
    "xhigh",
  );
  const serialized = serializeProviderWorkspaceConfig(config);
  assert.deepEqual(serialized.providers, {
    anthropic: {
      current_model: "sonnet",
      current_reasoning: "xhigh",
    },
  });
  const reparsed = parseProviderWorkspaceConfig(serialized);
  assert.equal(reparsed.providers?.anthropic?.currentModel, "sonnet");
  assert.equal(reparsed.providers?.anthropic?.currentReasoning, "xhigh");
});

test("Anthropic claudeCommandPath round-trips through serialize/parse", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      anthropic: {
        current_model: "sonnet",
        claude_command_path: "C:\\Users\\Example\\.local\\bin\\claude.exe",
      },
    },
  });

  assert.equal(config.providers?.anthropic?.claudeCommandPath, "C:\\Users\\Example\\.local\\bin\\claude.exe");
  const serialized = serializeProviderWorkspaceConfig(config);
  assert.deepEqual(serialized.providers, {
    anthropic: {
      current_model: "sonnet",
      claude_command_path: "C:\\Users\\Example\\.local\\bin\\claude.exe",
    },
  });
});

test("saved Google provider overrides are removed during migration", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      google: {
        current_model: "gemini-2.5-flash",
        gemini_command_path: "C:\\Users\\Example\\AppData\\Roaming\\npm\\gemini.cmd",
      },
    },
  });

  assert.equal(config.providers?.google, undefined);
  assert.equal(config.migrationNotice?.deprecatedProviderId, "google");
  const serialized = serializeProviderWorkspaceConfig(config);
  assert.equal(serialized.providers, undefined);
});

test("Codex codexCommandPath round-trips through serialize/parse", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      openai: {
        current_model: "gpt-5.4",
        codex_command_path: "C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd",
      },
    },
  });

  assert.equal(config.providers?.openai?.codexCommandPath, "C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd");
  const serialized = serializeProviderWorkspaceConfig(config);
  assert.deepEqual(serialized.providers, {
    openai: {
      current_model: "gpt-5.4",
      codex_command_path: "C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd",
    },
  });
});

test("Local OpenAI-compatible config round-trips through serialize/parse", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      local: {
        enabled: true,
        type: "openai-compatible",
        base_url: "http://localhost:1234/v1",
        api_key: "lm-studio",
        pinned_model: "qwen/qwen3.6-27b",
        default_model: "google/gemma-4-26b-a4b",
        models: {
          "google/gemma-4-26b-a4b": {
            contextLength: 8192,
          },
        },
      },
    },
  });

  assert.deepEqual(config.providers?.local, {
    enabled: true,
    type: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    pinnedModel: "qwen/qwen3.6-27b",
    defaultModel: "google/gemma-4-26b-a4b",
    models: {
      "google/gemma-4-26b-a4b": {
        contextLength: 8192,
      },
    },
  });
  assert.deepEqual(serializeProviderWorkspaceConfig(config).providers, {
    local: {
      enabled: true,
      type: "openai-compatible",
      base_url: "http://localhost:1234/v1",
      api_key: "lm-studio",
      pinned_model: "qwen/qwen3.6-27b",
      default_model: "google/gemma-4-26b-a4b",
      models: {
        "google/gemma-4-26b-a4b": {
          contextLength: 8192,
        },
      },
    },
  });
});

test("provider model context length config rejects invalid values", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      local: {
        models: {
          zero: { contextLength: 0 },
          negative: { contextLength: -1 },
          decimal: { contextLength: 8192.5 },
          text: { contextLength: "8192" },
          valid: { context_length: 32768 },
        },
      },
    },
  });

  assert.deepEqual(config.providers?.local?.models, {
    valid: {
      contextLength: 32768,
    },
  });
});

test("setProviderActiveRoute persists Local routes after endpoint discovery", async () => {
  resetLocalProviderStateForTests();
  try {
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
    const config = setProviderActiveRoute({}, {
      providerId: "local",
      modelId: "google/gemma-4-26b-a4b",
      backendKind: "local-openai-compatible",
      localBackend: "lm-studio",
    });

    assert.deepEqual(config.activeRoute, {
      providerId: "local",
      modelId: "google/gemma-4-26b-a4b",
      backendKind: "local-openai-compatible",
      localBackend: "lm-studio",
    });
  } finally {
    resetLocalProviderStateForTests();
  }
});

test("Local active route backend overrides and repairs a stale provider preference", () => {
  const parsed = parseProviderWorkspaceConfig({
    activeRoute: {
      providerId: "local",
      modelId: "Qwen3.8-27B-UD-Q3_K_XL",
      backendKind: "local-openai-compatible",
      localBackend: "unsloth",
    },
    providers: {
      local: { local_backend: "lm-studio" },
    },
  });

  assert.equal(parsed.activeRoute?.localBackend, "unsloth");
  assert.equal(parsed.providers?.local?.localBackend, "unsloth");
});

test("setProviderActiveRoute synchronizes the Local provider preference", async () => {
  resetLocalProviderStateForTests();
  try {
    await checkLocalProvider({
      fetchImpl: (async (input) => String(input).includes("/api/v0/")
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify({ data: [{ id: "Qwen3.8-27B-UD-Q3_K_XL" }] }), { status: 200 })) as typeof fetch,
    });
    const config = setProviderActiveRoute({
      providers: { local: { localBackend: "lm-studio" } },
    }, {
      providerId: "local",
      modelId: "Qwen3.8-27B-UD-Q3_K_XL",
      backendKind: "local-openai-compatible",
      localBackend: "unsloth",
    });

    assert.equal(config.activeRoute?.localBackend, "unsloth");
    assert.equal(config.providers?.local?.localBackend, "unsloth");
  } finally {
    resetLocalProviderStateForTests();
  }
});

test("Google workspace routes migrate to OpenAI and drop Google model overrides", () => {
  const config = parseProviderWorkspaceConfig({
    activeRoute: {
      providerId: "google",
      modelId: "gemini-3-flash",
      backendKind: "gemini-cli-auth",
      modelSelection: {
        kind: "manual",
        modelId: "gemini-3-flash",
      },
    },
    providers: {
      google: {
        current_model: "gemini-3-flash",
      },
    },
  });

  assert.equal(config.activeRoute?.providerId, "openai");
  assert.equal(config.providers?.google, undefined);
  assert.equal(config.migrationNotice?.deprecatedProviderId, "google");
});

test("Local model capability fields round-trip through serialize/parse", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      local: {
        enabled: true,
        type: "openai-compatible",
        base_url: "http://localhost:1234/v1",
        api_key: "lm-studio",
        default_model: "test-model",
        models: {
          "test-model": {
            contextLength: 8192,
            supportsToolCalls: false,
            supportsStreaming: true,
            supportsSystemPrompt: true,
            maxOutputTokens: 4096,
          },
        },
      },
    },
  });

  assert.deepEqual(config.providers?.local?.models?.["test-model"], {
    contextLength: 8192,
    supportsToolCalls: false,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    maxOutputTokens: 4096,
  });

  const serialized = serializeProviderWorkspaceConfig(config);
  const reparsed = parseProviderWorkspaceConfig(serialized);
  assert.deepEqual(reparsed.providers?.local?.models?.["test-model"], {
    contextLength: 8192,
    supportsToolCalls: false,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    maxOutputTokens: 4096,
  });
});

test("Local model capability boolean string values are rejected", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      local: {
        models: {
          "bad-model": {
            supportsStreaming: "true",
            supportsToolCalls: 1,
            supportsSystemPrompt: null,
          },
        },
      },
    },
  });

  // None of the invalid values should create a model entry
  assert.equal(config.providers?.local?.models?.["bad-model"], undefined);
});

test("Local model maxOutputTokens: 4096 round-trips; invalid values are rejected", () => {
  const config = parseProviderWorkspaceConfig({
    providers: {
      local: {
        models: {
          valid: { max_output_tokens: 4096 },
          zero: { maxOutputTokens: 0 },
          negative: { max_output_tokens: -512 },
          decimal: { maxOutputTokens: 1024.5 },
        },
      },
    },
  });

  assert.deepEqual(config.providers?.local?.models?.valid, { maxOutputTokens: 4096 });
  assert.equal(config.providers?.local?.models?.zero, undefined);
  assert.equal(config.providers?.local?.models?.negative, undefined);
  assert.equal(config.providers?.local?.models?.decimal, undefined);
});

test("setProviderActiveRoute ignores Google routes when GOOGLE_API_KEY is configured", () => {
  withGeminiEnv({ GOOGLE_API_KEY: "test-google-key" }, () => {
    const config = setProviderActiveRoute({}, {
      providerId: "google",
      modelId: "gemini-2.5-flash",
      backendKind: "gemini-api-key",
      reasoning: "high",
    });

    assert.equal(config.activeRoute, undefined);
    assert.doesNotMatch(JSON.stringify(serializeProviderWorkspaceConfig(config)), /test-google-key/);
  });
});
