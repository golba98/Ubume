import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCodexSeedModels,
  loadSeededCodexCapabilities,
  loadSeededOpenAiModels,
} from "./codexModelsCacheSeed.js";
import { saveCachedProviderModels } from "./providerModelCache.js";

// Mirrors the real ~/.codex/models_cache.json shape written by codex-cli.
const SEED_FIXTURE = {
  fetched_at: "2026-07-12T03:23:48.012262527Z",
  client_version: "0.144.1",
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      visibility: "list",
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: null,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      visibility: "list",
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }],
      visibility: "hide",
    },
  ],
};

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ubume-seed-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parses codex cache into provider models with reasoning levels", () => {
  withTempDir((dir) => {
    const file = join(dir, "models_cache.json");
    writeFileSync(file, JSON.stringify(SEED_FIXTURE), "utf8");
    const seed = loadCodexSeedModels(file);
    assert.ok(seed);
    assert.equal(seed.models.length, 2, "hidden models are filtered out");
    const sol = seed.models[0]!;
    assert.equal(sol.modelId, "gpt-5.6-sol");
    assert.equal(sol.label, "GPT-5.6-Sol");
    assert.equal(sol.defaultReasoningLevel, "medium");
    assert.deepEqual(sol.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "ultra"]);
    assert.equal(sol.supportedReasoningLevels?.[2]?.description, "Maximum reasoning with automatic task delegation");
    assert.equal(seed.fetchedAt, Date.parse("2026-07-12T03:23:48.012262527Z"));
  });
});

test("missing or malformed cache file yields null", () => {
  withTempDir((dir) => {
    assert.equal(loadCodexSeedModels(join(dir, "missing.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json", "utf8");
    assert.equal(loadCodexSeedModels(bad), null);
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ fetched_at: "2026-01-01T00:00:00Z", models: [] }), "utf8");
    assert.equal(loadCodexSeedModels(empty), null);
  });
});

test("prefers the fresher of codex seed and persisted discovery", () => {
  withTempDir((dir) => {
    const codexFile = join(dir, "models_cache.json");
    const providerFile = join(dir, "provider-cache.json");
    writeFileSync(codexFile, JSON.stringify(SEED_FIXTURE), "utf8");

    const newerThanSeed = Date.parse(SEED_FIXTURE.fetched_at) + 60_000;
    saveCachedProviderModels("openai", {
      discoveredAt: newerThanSeed,
      models: [{
        id: "gpt-6",
        modelId: "gpt-6",
        label: "GPT-6",
        description: null,
        defaultReasoningLevel: "high",
        supportedReasoningLevels: null,
        source: "discovered",
      }],
    }, providerFile);

    const fresher = loadSeededOpenAiModels({ codexCacheFile: codexFile, providerCacheFile: providerFile });
    assert.equal(fresher?.models[0]?.modelId, "gpt-6", "newer persisted discovery wins");

    saveCachedProviderModels("openai", {
      discoveredAt: Date.parse(SEED_FIXTURE.fetched_at) - 60_000,
      models: [{
        id: "gpt-old",
        modelId: "gpt-old",
        label: "GPT Old",
        description: null,
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
        source: "discovered",
      }],
    }, providerFile);
    const seedWins = loadSeededOpenAiModels({ codexCacheFile: codexFile, providerCacheFile: providerFile });
    assert.equal(seedWins?.models[0]?.modelId, "gpt-5.6-sol", "newer codex seed wins");
  });
});

test("builds ready runtime capabilities from local caches only", () => {
  withTempDir((dir) => {
    const codexFile = join(dir, "models_cache.json");
    writeFileSync(codexFile, JSON.stringify(SEED_FIXTURE), "utf8");
    const capabilities = loadSeededCodexCapabilities({
      codexCacheFile: codexFile,
      providerCacheFile: join(dir, "provider-cache.json"),
    });
    assert.ok(capabilities);
    assert.equal(capabilities.status, "ready");
    assert.equal(capabilities.source, "runtime");
    assert.equal(capabilities.models.length, 2);
    assert.equal(capabilities.models[0]!.isDefault, true);
    assert.equal(capabilities.models[0]!.reasoningLevelCount, 3);
  });
});

test("returns null capabilities when no cache exists anywhere", () => {
  withTempDir((dir) => {
    assert.equal(
      loadSeededCodexCapabilities({
        codexCacheFile: join(dir, "missing.json"),
        providerCacheFile: join(dir, "also-missing.json"),
      }),
      null,
    );
  });
});
