import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderModel } from "../providerRuntime/types.js";
import { loadCachedProviderModels, saveCachedProviderModels } from "./providerModelCache.js";

function tempCacheFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ubume-model-cache-"));
  return { file: join(dir, "model-cache.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SAMPLE_MODELS: readonly ProviderModel[] = [
  {
    id: "gpt-5.6-sol",
    modelId: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    source: "discovered",
  },
];

test("round-trips a provider entry", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 123, models: SAMPLE_MODELS }, file);
    const loaded = loadCachedProviderModels("openai", file);
    assert.ok(loaded);
    assert.equal(loaded.discoveredAt, 123);
    assert.equal(loaded.models.length, 1);
    assert.equal(loaded.models[0]!.modelId, "gpt-5.6-sol");
    assert.equal(loaded.models[0]!.supportedReasoningLevels?.length, 2);
  } finally {
    cleanup();
  }
});

test("providers are isolated from each other", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 1, models: SAMPLE_MODELS }, file);
    saveCachedProviderModels("anthropic", {
      discoveredAt: 2,
      models: [{ ...SAMPLE_MODELS[0]!, id: "opus", modelId: "opus", label: "Claude Opus" }],
    }, file);
    assert.equal(loadCachedProviderModels("openai", file)?.models[0]?.modelId, "gpt-5.6-sol");
    assert.equal(loadCachedProviderModels("anthropic", file)?.models[0]?.modelId, "opus");
    assert.equal(loadCachedProviderModels("google", file), null);
  } finally {
    cleanup();
  }
});

test("missing file loads as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("corrupt JSON loads as null and is overwritten by the next save", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(file, "{ not json", "utf8");
    assert.equal(loadCachedProviderModels("openai", file), null);
    saveCachedProviderModels("openai", { discoveredAt: 5, models: SAMPLE_MODELS }, file);
    assert.equal(loadCachedProviderModels("openai", file)?.discoveredAt, 5);
  } finally {
    cleanup();
  }
});

test("unknown cache version loads as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ version: 99, providers: { openai: { discoveredAt: 1, models: SAMPLE_MODELS } } }), "utf8");
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("entries with malformed models load as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, providers: { openai: { discoveredAt: 1, models: [{ bogus: true }] } } }), "utf8");
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("empty model lists are not persisted", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 9, models: SAMPLE_MODELS }, file);
    saveCachedProviderModels("openai", { discoveredAt: 10, models: [] }, file);
    assert.equal(loadCachedProviderModels("openai", file)?.discoveredAt, 9);
  } finally {
    cleanup();
  }
});
