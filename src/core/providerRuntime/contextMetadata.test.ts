import assert from "node:assert/strict";
import test from "node:test";
import {
  clearModelContextMetadataCache,
  contextMetadataToModelSpec,
  formatContextCompact,
  formatContextLength,
  formatContextMeter,
  resolveModelContextLength,
  resolveModelContextLengthCached,
} from "./contextMetadata.js";

test("Local /v1/models context_length metadata is used as verified API context", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: {
      id: "google/gemma-4-26b-a4b",
      context_length: 8192,
    },
  });

  assert.equal(metadata.contextLength, 8192);
  assert.equal(metadata.source, "api");
  assert.equal(metadata.confidence, "verified");
  assert.equal(metadata.rawField, "context_length");
});

test("Local /v1/models nested context metadata is detected", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "local-model",
    rawMetadata: {
      id: "local-model",
      model_info: {
        max_context_length: 32768,
      },
    },
  });

  assert.equal(metadata.contextLength, 32768);
  assert.equal(metadata.source, "api");
  assert.equal(metadata.rawField, "model_info.max_context_length");
});

test("Local /v1/models without context metadata returns Unknown", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: {
      id: "google/gemma-4-26b-a4b",
    },
  });

  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
  assert.equal(metadata.confidence, "unknown");
  assert.match(metadata.error ?? "", /did not include context length metadata/);
  assert.equal(formatContextLength(metadata.contextLength), "Unknown");
});

test("config override supplies context length when API metadata is unknown", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: {
      id: "google/gemma-4-26b-a4b",
    },
    providerConfig: {
      models: {
        "google/gemma-4-26b-a4b": {
          contextLength: 8192,
        },
      },
    },
  });

  assert.equal(metadata.contextLength, 8192);
  assert.equal(metadata.source, "config");
  assert.equal(metadata.confidence, "configured");
});

test("invalid config context length is rejected as Unknown", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "bad-model",
    providerConfig: {
      models: {
        "bad-model": {
          contextLength: 0,
        },
      },
    },
  });

  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
  assert.match(metadata.error ?? "", /Invalid configured contextLength/);
});

test("known registry values are exact provider/model matches only", async () => {
  clearModelContextMetadataCache();
  const exact = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-2.5-flash",
  });
  const unknown = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-2.5-flash-custom",
  });
  const gemini3 = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-3-flash-preview",
  });

  assert.equal(exact.contextLength, 1_048_576);
  assert.equal(exact.source, "known-registry");
  assert.equal(exact.confidence, "known");
  assert.equal(unknown.contextLength, null);
  assert.equal(gemini3.contextLength, 1_048_576);
  assert.equal(gemini3.source, "known-registry");
});

test("unknown context converts to model spec without fake percentage inputs", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "unknown-local-model",
  });
  const spec = contextMetadataToModelSpec(metadata);

  assert.equal(spec.status, "unknown");
  assert.equal(spec.contextWindow, null);
  assert.equal(spec.maxOutputTokens, null);
});

test("context metadata cache can be upgraded from Unknown when raw API metadata arrives", async () => {
  clearModelContextMetadataCache();
  const first = resolveModelContextLengthCached({
    providerId: "local",
    modelId: "cached-local-model",
  });
  const second = await resolveModelContextLength({
    providerId: "local",
    modelId: "cached-local-model",
    rawMetadata: {
      id: "cached-local-model",
      n_ctx: 4096,
    },
  });
  const third = resolveModelContextLengthCached({
    providerId: "local",
    modelId: "cached-local-model",
  });

  assert.equal(first.contextLength, null);
  assert.equal(second.contextLength, 4096);
  assert.equal(third.contextLength, 4096);
});

test("loaded_context_length takes priority over max_context_length and uses lmstudio-api source", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: {
      id: "google/gemma-4-26b-a4b",
      loaded_context_length: 64000,
      max_context_length: 262144,
    },
  });

  assert.equal(metadata.contextLength, 64000);
  assert.equal(metadata.source, "lmstudio-api");
  assert.equal(metadata.rawField, "loaded_context_length");
  assert.equal(metadata.confidence, "verified");
});

test("max_context_length alone uses api source (not lmstudio-api)", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "test-model",
    rawMetadata: {
      id: "test-model",
      max_context_length: 262144,
    },
  });

  assert.equal(metadata.contextLength, 262144);
  assert.equal(metadata.source, "api");
  assert.equal(metadata.rawField, "max_context_length");
});

test("full LM Studio fixture uses loaded_context_length with lmstudio-api source", async () => {
  clearModelContextMetadataCache();
  const fixture = {
    id: "google/gemma-4-26b-a4b",
    object: "model",
    type: "vlm",
    publisher: "google",
    arch: "gemma4",
    compatibility_type: "gguf",
    quantization: "Q4_K_M",
    state: "loaded",
    max_context_length: 262144,
    loaded_context_length: 64000,
    capabilities: ["tool_use"],
  };
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: fixture,
  });

  assert.equal(metadata.contextLength, 64000);
  assert.equal(metadata.source, "lmstudio-api");
  assert.equal(metadata.rawField, "loaded_context_length");
});

// ─── formatContextMeter ───────────────────────────────────────────────────────

test("formatContextMeter(0, 64000) returns '0 / 64,000 · 0%'", () => {
  assert.equal(formatContextMeter(0, 64000), "0 / 64,000 · 0%");
});

test("formatContextMeter(640, 64000) returns '640 / 64,000 · 1%'", () => {
  assert.equal(formatContextMeter(640, 64000), "640 / 64,000 · 1%");
});

test("formatContextMeter(32000, 64000) returns '32,000 / 64,000 · 50%'", () => {
  assert.equal(formatContextMeter(32000, 64000), "32,000 / 64,000 · 50%");
});

test("formatContextMeter(null, 64000) treats null as 0 and returns '0 / 64,000 · 0%'", () => {
  assert.equal(formatContextMeter(null, 64000), "0 / 64,000 · 0%");
});

test("formatContextMeter(undefined, 64000) treats undefined as 0 and returns '0 / 64,000 · 0%'", () => {
  assert.equal(formatContextMeter(undefined, 64000), "0 / 64,000 · 0%");
});

test("formatContextMeter(0, null) returns 'Unknown'", () => {
  assert.equal(formatContextMeter(0, null), "Unknown");
});

test("formatContextMeter(32000, null) returns 'Unknown'", () => {
  assert.equal(formatContextMeter(32000, null), "Unknown");
});

// ─── Gemini 3 registry entries ────────────────────────────────────────────────

test("gemini-3.1-pro-preview resolves 1,048,576 from known registry", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-3.1-pro-preview",
  });
  assert.equal(metadata.contextLength, 1_048_576);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "known");
});

test("gemini-3.1-flash-lite-preview resolves 1,048,576 from known registry", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-3.1-flash-lite-preview",
  });
  assert.equal(metadata.contextLength, 1_048_576);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "known");
});

// ─── Anthropic alias normalization ────────────────────────────────────────────

test("anthropic alias 'sonnet' remains unknown without discovered version metadata", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "anthropic",
    modelId: "sonnet",
  });
  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
  assert.equal(metadata.confidence, "unknown");
  assert.equal(metadata.modelId, "sonnet");
});

test("DeepSeek family detection does not replace authoritative context metadata", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-GGUF",
    rawMetadata: { loaded_context_length: 32768 },
    providerConfig: {
      models: {
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-GGUF": { contextLength: 16384 },
      },
    },
  });

  assert.equal(metadata.contextLength, 32768);
  assert.equal(metadata.source, "lmstudio-api");
});

test("anthropic alias 'opus' remains unknown without discovered version metadata", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "anthropic",
    modelId: "opus",
  });
  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
  assert.equal(metadata.confidence, "unknown");
  assert.equal(metadata.modelId, "opus");
});

test("anthropic alias 'haiku' remains unknown without discovered version metadata", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "anthropic",
    modelId: "haiku",
  });
  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
  assert.equal(metadata.confidence, "unknown");
  assert.equal(metadata.modelId, "haiku");
});

test("anthropic full canonical ID 'claude-sonnet-4-6' still resolves correctly", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  assert.equal(metadata.contextLength, 200_000);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.modelId, "claude-sonnet-4-6");
});

test("unknown anthropic model ID does not resolve from registry", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "anthropic",
    modelId: "claude-unknown-model",
  });
  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
});

// ─── Nested raw.loaded_context_length lookup ─────────────────────────────────

test("context is resolved from nested raw.loaded_context_length when ProviderModel is passed as rawMetadata", async () => {
  clearModelContextMetadataCache();
  // app.tsx passes the whole ProviderModel as rawMetadata (via currentModelCapability.raw).
  // providerModelsToCodexCapabilities sets raw: model (the ProviderModel), not model.raw.
  // The nested "raw" key scan must reach loaded_context_length inside ProviderModel.raw.
  const providerModelShaped = {
    id: "google/gemma-4-26b-a4b",
    modelId: "google/gemma-4-26b-a4b",
    label: "google/gemma-4-26b-a4b",
    source: "discovered",
    raw: {
      id: "google/gemma-4-26b-a4b",
      loaded_context_length: 64000,
      max_context_length: 262144,
      capabilities: ["tool_use"],
    },
  };
  const metadata = await resolveModelContextLength({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: providerModelShaped,
  });

  assert.equal(metadata.contextLength, 64000, "should resolve loaded_context_length from nested raw field");
  assert.equal(metadata.source, "lmstudio-api", "nested loaded_context_length should use lmstudio-api source");
});

// ─── OpenAI/Codex model ID normalisation ─────────────────────────────────────

test("openai 'GPT-5.5' uppercase normalises and resolves 1,048,576 from registry", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "GPT-5.5",
  });
  assert.equal(metadata.contextLength, 1_048_576);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "estimated");
  assert.equal(metadata.modelId, "GPT-5.5");
});

test("openai 'GPT-5 Codex' spaced label normalises to 'gpt-5-codex' and resolves 400,000", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "GPT-5 Codex",
  });
  assert.equal(metadata.contextLength, 400_000);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "estimated");
  assert.equal(metadata.modelId, "GPT-5 Codex");
});

test("openai 'gpt-5.4' resolves 400,000 with confidence 'estimated'", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "gpt-5.4",
  });
  assert.equal(metadata.contextLength, 400_000);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "estimated");
});

test("openai 'gpt-5.4-mini' resolves 200,000 with confidence 'estimated'", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "gpt-5.4-mini",
  });
  assert.equal(metadata.contextLength, 200_000);
  assert.equal(metadata.source, "known-registry");
  assert.equal(metadata.confidence, "estimated");
});

test("openai unknown model 'gpt-5-unknown' returns null contextLength", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "gpt-5-unknown",
  });
  assert.equal(metadata.contextLength, null);
  assert.equal(metadata.source, "unknown");
});

test("contextMetadataToModelSpec with confidence 'estimated' sets isEstimated: true", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "openai",
    modelId: "gpt-5.4",
  });
  const spec = contextMetadataToModelSpec(metadata);
  assert.equal(spec.status, "verified");
  assert.equal((spec as { isEstimated?: boolean }).isEstimated, true);
});

test("contextMetadataToModelSpec with confidence 'known' leaves isEstimated falsy", async () => {
  clearModelContextMetadataCache();
  const metadata = await resolveModelContextLength({
    providerId: "google",
    modelId: "gemini-2.5-flash",
  });
  const spec = contextMetadataToModelSpec(metadata);
  assert.equal(spec.status, "verified");
  assert.ok(!(spec as { isEstimated?: boolean }).isEstimated, "known confidence must not set isEstimated");
});

// ─── formatContextCompact ─────────────────────────────────────────────────────

test("formatContextCompact formats 1,048,576 as '1.0M'", () => {
  assert.equal(formatContextCompact(1_048_576), "1.0M");
});

test("formatContextCompact formats 400,000 as '400K'", () => {
  assert.equal(formatContextCompact(400_000), "400K");
});

test("formatContextCompact formats 200,000 as '200K'", () => {
  assert.equal(formatContextCompact(200_000), "200K");
});

test("formatContextCompact formats 128,000 as '128K'", () => {
  assert.equal(formatContextCompact(128_000), "128K");
});

test("formatContextCompact formats small values as plain number", () => {
  assert.equal(formatContextCompact(512), "512");
});
