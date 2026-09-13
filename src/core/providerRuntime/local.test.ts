import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import {
  checkLocalProvider,
  discoverLocalModels,
  localRuntime,
  localRuntimeTestUtils,
  resetLocalProviderStateForTests,
  resolveLocalProviderConfig,
  runLocalDiagnostics,
} from "./local.js";
import type { ProviderChatRequest } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withLocalEnv<T>(env: Partial<NodeJS.ProcessEnv>, callback: () => T | Promise<T>): Promise<T> {
  const keys = ["UBUME_LOCAL_BASE_URL", "UBUME_LOCAL_API_KEY", "UBUME_LOCAL_MODEL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_KEY"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLocalProviderStateForTests();
    return await callback();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLocalProviderStateForTests();
  }
}

test("Local discovery remains OpenAI-compatible and model-family agnostic", async () => {
  await withLocalEnv({}, async () => {
    const result = await checkLocalProvider({
      override: { baseUrl: "http://local.test/v1" },
      fetchImpl: (async (input) => String(input).includes("/api/v0/")
        ? new Response(null, { status: 404 })
        : jsonResponse({ data: [{ id: "Qwen/Qwen3" }, { id: "google/gemma-3" }] })) as typeof fetch,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.backendKind, "local-openai-compatible");
    assert.equal(result.diagnostics?.baseUrl, "http://local.test/v1");
    assert.deepEqual(discoverLocalModels({ baseUrl: "http://local.test/v1" }).models.map((model) => model.modelId), ["Qwen/Qwen3", "google/gemma-3"]);
  });
});

test("Local discovery reports an unreachable endpoint", async () => {
  await withLocalEnv({}, async () => {
    const result = await checkLocalProvider({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    assert.equal(result.status, "not-configured");
    assert.equal(result.backendKind, "unavailable");
    assert.match(result.message ?? "", /Could not reach/);
  });
});

test("Local configuration normalizes endpoint and preserves credentials and model", async () => {
  await withLocalEnv({ UBUME_LOCAL_BASE_URL: "http://127.0.0.1:8080/v1/", UBUME_LOCAL_API_KEY: "local-secret", UBUME_LOCAL_MODEL: "meta-llama/Llama-4" }, () => {
    const config = resolveLocalProviderConfig(null);
    assert.equal(config.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(config.apiKey, "local-secret");
    assert.equal(config.defaultModel, "meta-llama/Llama-4");
  });
});

test("Local runtime delegates chat to the isolated Harness adapter", async () => {
  const source = await readFile(new URL("./local.ts", import.meta.url), "utf8");
  assert.equal(typeof localRuntime.run, "function");
  assert.match(source, /runLocalHarness/);
  assert.doesNotMatch(source, /runLocalOpenAiCompatible|parseXmlToolCalls|runAgentLoop/);
});

test("Local diagnostics retains configured endpoint and selected model", async () => {
  await withLocalEnv({}, async () => {
    const diagnostics = await runLocalDiagnostics({
      localConfig: { baseUrl: "http://localhost:11434/v1", defaultModel: "ornith-local" },
      fetchImpl: (async (input) => String(input).includes("/api/v0/")
        ? new Response(null, { status: 404 })
        : jsonResponse({ data: [{ id: "ornith-local" }] })) as typeof fetch,
    });
    assert.match(diagnostics, /http:\/\/localhost:11434\/v1/);
    assert.match(diagnostics, /ornith-local/);
  });
});

test("Unsloth execution resolves its authenticated endpoint instead of falling back to LM Studio", async () => {
  const previousKey = process.env.UNSLOTH_API_KEY;
  const previousUrl = process.env.UNSLOTH_STUDIO_URL;
  process.env.UNSLOTH_API_KEY = "sk-unsloth-test-key";
  process.env.UNSLOTH_STUDIO_URL = "http://127.0.0.1:8888";
  const req: ProviderChatRequest = {
    prompt: "hello",
    route: {
      providerId: "local",
      modelId: "Ornith-1.5-35B-A3B-Q4_K_M",
      backendKind: "local-openai-compatible",
      localBackend: "unsloth",
    },
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
    workspaceRoot: process.cwd(),
    localConfig: {
      currentModel: "Ornith-1.5-35B-A3B-Q4_K_M",
      localBackend: "unsloth",
    },
  };
  const fetchImpl = (async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return jsonResponse({ data: [{ id: req.route.modelId, loaded: true }] });
    }
    if (url.endsWith("/api/inference/status")) {
      return jsonResponse({
        active_model: req.route.modelId,
        context_length: 128_000,
        supports_tools: true,
        is_vision: false,
      });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  }) as typeof fetch;
  try {
    const resolved = await localRuntimeTestUtils.resolveLocalAgentConfig(req, new AbortController().signal, fetchImpl);
    assert.equal(resolved.localBackend, "unsloth");
    assert.equal(resolved.baseUrl, "http://127.0.0.1:8888/v1");
    assert.equal(resolved.apiKey, "sk-unsloth-test-key");
    assert.equal(resolved.contextWindow, 128_000);
    assert.equal(resolved.supportsToolCalls, true);
    assert.notEqual(resolved.baseUrl, "http://localhost:1234/v1");
  } finally {
    if (previousKey === undefined) delete process.env.UNSLOTH_API_KEY;
    else process.env.UNSLOTH_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.UNSLOTH_STUDIO_URL;
    else process.env.UNSLOTH_STUDIO_URL = previousUrl;
  }
});
