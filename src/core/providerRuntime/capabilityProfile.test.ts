import assert from "node:assert/strict";
import test from "node:test";
import {
  clearModelCapabilityProfileCache,
  detectLocalModelFamily,
  resolveModelCapabilityProfileCached,
} from "./capabilityProfile.js";

test("detects DeepSeek family across local model naming variants", () => {
  const variants = [
    "deepseek-r1",
    "DeepSeek-R1-Distill-Qwen-32B",
    "deepseek-r1-distill-llama-70b",
    "deepseek-v3",
    "deepseek-v3.1",
    "deepseek-v3.2",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B-GGUF",
    "bartowski/deepseek-v3-q4_k_m:latest",
  ];
  for (const modelId of variants) {
    assert.equal(detectLocalModelFamily(modelId), "deepseek", modelId);
  }
  assert.equal(detectLocalModelFamily("qwen/qwen3.6-27b"), null);
  assert.equal(detectLocalModelFamily("vendor/notdeepseekish-model"), null);
});

test("detects DeepSeek family from server metadata names", () => {
  assert.equal(detectLocalModelFamily("opaque-local-id", {
    model_info: { display_name: "DeepSeek_R1 Distill Qwen" },
  }), "deepseek");
});

test("DeepSeek family defaults fill only missing capability fields", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "deepseek-r1-distill-qwen-32b",
    rawMetadata: { supports_streaming: false },
    providerConfig: {
      models: {
        "deepseek-r1-distill-qwen-32b": {
          supportsToolCalls: false,
          supportsSystemPrompt: false,
          maxOutputTokens: 4096,
        },
      },
    },
  });

  assert.equal(profile.family, "deepseek");
  assert.equal(profile.supportsStreaming, false, "authoritative API metadata wins");
  assert.equal(profile.supportsToolCalls, false, "config fills a missing API field before family defaults");
  assert.equal(profile.supportsSystemPrompt, false);
  assert.equal(profile.maxOutputTokens, 4096);
  assert.equal(profile.source, "api");
});

test("DeepSeek family supplies streaming and native tool defaults without token guesses", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "vendor/deepseek-v3.2-q4_k_m:latest",
  });

  assert.equal(profile.family, "deepseek");
  assert.equal(profile.supportsStreaming, true);
  assert.equal(profile.supportsToolCalls, true);
  assert.equal(profile.supportsSystemPrompt, null);
  assert.equal(profile.maxOutputTokens, null);
  assert.equal(profile.source, "detected-family");
});

test("raw API supports_system_prompt: false sets supportsSystemPrompt false with api/verified", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "test-model",
    rawMetadata: {
      id: "test-model",
      supports_system_prompt: false,
    },
  });

  assert.equal(profile.supportsSystemPrompt, false);
  assert.equal(profile.source, "api");
  assert.equal(profile.confidence, "verified");
});

test("raw API supportsStreaming: true (camelCase) is detected", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "test-model",
    rawMetadata: {
      id: "test-model",
      supportsStreaming: true,
    },
  });

  assert.equal(profile.supportsStreaming, true);
  assert.equal(profile.source, "api");
});

test("nested model_info.supports_tool_calls is detected", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "test-model",
    rawMetadata: {
      id: "test-model",
      model_info: {
        supports_tool_calls: true,
        max_output_tokens: 2048,
      },
    },
  });

  assert.equal(profile.supportsToolCalls, true);
  assert.equal(profile.maxOutputTokens, 2048);
  assert.equal(profile.source, "api");
});

test("raw API with no capability fields returns all-null profile with unknown source", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "no-caps-model",
    rawMetadata: {
      id: "no-caps-model",
      object: "model",
    },
  });

  assert.equal(profile.supportsSystemPrompt, null);
  assert.equal(profile.supportsStreaming, null);
  assert.equal(profile.supportsToolCalls, null);
  assert.equal(profile.maxOutputTokens, null);
  assert.equal(profile.source, "unknown");
  assert.equal(profile.confidence, "unknown");
});

test("config override supportsSystemPrompt: false applies when no raw metadata", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "config-model",
    providerConfig: {
      models: {
        "config-model": {
          supportsSystemPrompt: false,
          supportsStreaming: true,
        },
      },
    },
  });

  assert.equal(profile.supportsSystemPrompt, false);
  assert.equal(profile.supportsStreaming, true);
  assert.equal(profile.source, "config");
  assert.equal(profile.confidence, "configured");
});

test("config override rejects non-boolean string values", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "bad-model",
    providerConfig: {
      models: {
        "bad-model": {
          // TypeScript would reject these, but test that runtime parsing rejects them too
          supportsStreaming: "true" as unknown as boolean,
        },
      },
    },
  });

  // A string "true" is not a boolean — should fall through to unknown
  assert.equal(profile.supportsStreaming, null);
  assert.equal(profile.source, "unknown");
});

test("config override maxOutputTokens: 4096 applies; negative is rejected", () => {
  clearModelCapabilityProfileCache();
  const validProfile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "model-a",
    providerConfig: {
      models: {
        "model-a": { maxOutputTokens: 4096 },
      },
    },
  });

  assert.equal(validProfile.maxOutputTokens, 4096);
  assert.equal(validProfile.source, "config");

  clearModelCapabilityProfileCache();
  const invalidProfile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "model-b",
    providerConfig: {
      models: {
        "model-b": { maxOutputTokens: -1 },
      },
    },
  });

  assert.equal(invalidProfile.maxOutputTokens, null);
  assert.equal(invalidProfile.source, "unknown");
});

test("known registry is initially empty — all models return unknown without raw/config", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "google",
    modelId: "gemini-2.5-pro",
  });

  assert.equal(profile.source, "unknown");
  assert.equal(profile.supportsStreaming, null);
  assert.equal(profile.supportsToolCalls, null);
});

test("raw API for non-local providers returns unknown (only local queries /v1/models)", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    rawMetadata: {
      id: "claude-sonnet-4-6",
      supports_streaming: true,
    },
  });

  // Non-local providers don't scan raw metadata
  assert.equal(profile.source, "unknown");
  assert.equal(profile.supportsStreaming, null);
});

test("capability cache is upgraded from unknown when raw API metadata arrives", () => {
  clearModelCapabilityProfileCache();

  const first = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "upgrade-model",
  });

  const second = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "upgrade-model",
    rawMetadata: {
      id: "upgrade-model",
      supports_tool_calls: false,
    },
  });

  const third = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "upgrade-model",
  });

  assert.equal(first.source, "unknown");
  assert.equal(first.supportsToolCalls, null);
  assert.equal(second.source, "api");
  assert.equal(second.supportsToolCalls, false);
  // Third call hits the upgraded cache
  assert.equal(third.source, "api");
  assert.equal(third.supportsToolCalls, false);
});

test("clearModelCapabilityProfileCache resets all cached profiles", () => {
  const profile1 = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "clear-test-model",
    rawMetadata: { id: "clear-test-model", supports_streaming: true },
  });
  assert.equal(profile1.supportsStreaming, true);

  clearModelCapabilityProfileCache();

  const profile2 = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "clear-test-model",
  });
  assert.equal(profile2.supportsStreaming, null);
  assert.equal(profile2.source, "unknown");
});

test("capabilities: ['tool_use'] sets supportsToolCalls true with api source", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "gemma-tools",
    rawMetadata: {
      id: "gemma-tools",
      capabilities: ["tool_use"],
    },
  });

  assert.equal(profile.supportsToolCalls, true);
  assert.equal(profile.source, "api");
  assert.equal(profile.confidence, "verified");
});

test("capabilities: ['vision'] without tool_use leaves supportsToolCalls null (absence != false)", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "vision-only",
    rawMetadata: {
      id: "vision-only",
      capabilities: ["vision"],
    },
  });

  assert.equal(profile.supportsToolCalls, null);
  assert.equal(profile.source, "unknown");
});

test("capabilities: [] (empty array) leaves all capabilities null", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "no-caps",
    rawMetadata: {
      id: "no-caps",
      capabilities: [],
    },
  });

  assert.equal(profile.supportsToolCalls, null);
  assert.equal(profile.source, "unknown");
});

test("type: 'vlm' alone does not set supportsVision (no automatic mapping)", () => {
  clearModelCapabilityProfileCache();
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "vlm-model",
    rawMetadata: {
      id: "vlm-model",
      type: "vlm",
      capabilities: ["tool_use"],
    },
  });

  assert.equal(profile.supportsVision, null);
  assert.equal(profile.supportsToolCalls, true);
});

test("full LM Studio fixture: supportsToolCalls true, supportsVision null", () => {
  clearModelCapabilityProfileCache();
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
  const profile = resolveModelCapabilityProfileCached({
    providerId: "local",
    modelId: "google/gemma-4-26b-a4b",
    rawMetadata: fixture,
  });

  assert.equal(profile.supportsToolCalls, true);
  assert.equal(profile.supportsVision, null);
  assert.equal(profile.source, "api");
});
