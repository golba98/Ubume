import assert from "node:assert/strict";
import test from "node:test";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import type { ActiveProviderRoute } from "../../core/providerRuntime/types.js";
import { buildActiveRuntimeDisplay } from "./runtimeDisplay.js";

function capability(model: string, label = model): CodexModelCapability {
  return {
    id: model,
    model,
    label,
    description: null,
    available: true,
    hidden: false,
    isDefault: true,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "runtime",
    raw: null,
  };
}

function context(route: ActiveProviderRoute, contextLength: number | null, confidence: ModelContextMetadata["confidence"] = "known"): ModelContextMetadata {
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    contextLength,
    source: contextLength === null ? "unknown" : "known-registry",
    confidence: contextLength === null ? "unknown" : confidence,
  };
}

test("Claude route display uses Claude model and context, not stale Gemini", () => {
  const route: ActiveProviderRoute = {
    providerId: "anthropic",
    modelId: "sonnet",
    backendKind: "claude-code-auth",
    reasoning: "low",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    modelCapability: capability("sonnet", "Sonnet 4.6"),
    contextMetadata: context(route, 200_000),
  });

  assert.equal(display.providerLabel, "Claude Code CLI");
  assert.equal(display.modelDisplay, "Claude Code CLI / Sonnet 4.6 / reasoning: Low");
  assert.equal(display.footerModelDisplay, "Claude Code CLI / Sonnet 4.6 (Low)");
  assert.equal(display.contextDisplay, "0 / 200K");
  assert.doesNotMatch(display.modelDisplay, /Gemini|OpenAI/i);
});

test("Gemini route display uses Gemini model and estimated context", () => {
  const route: ActiveProviderRoute = {
    providerId: "google",
    modelId: "gemini-3-flash-preview",
    backendKind: "gemini-cli-auth",
    reasoning: "medium",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 12_400,
    contextMetadata: context(route, 1_048_576, "estimated"),
  });

  assert.equal(display.modelDisplay, "Gemini CLI / gemini-3-flash-preview / reasoning: Medium");
  assert.equal(display.footerModelDisplay, "Gemini CLI / gemini-3-flash-preview (Medium)");
  assert.equal(display.contextDisplay, "12.4K / ~1M");
  assert.doesNotMatch(display.modelDisplay, /Claude|OpenAI/i);
});

test("OpenAI route display uses OpenAI model and unknown context without stale Claude", () => {
  const route: ActiveProviderRoute = {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth",
    reasoning: "medium",
  };
  const staleClaude = context({
    providerId: "anthropic",
    modelId: "sonnet",
    backendKind: "claude-code-auth",
  }, 200_000);
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: staleClaude,
  });

  assert.equal(display.modelDisplay, "OpenAI Codex CLI / gpt-5.4-mini / reasoning: Medium");
  assert.equal(display.footerModelDisplay, "OpenAI Codex CLI / gpt-5.4-mini (Medium)");
  assert.equal(display.contextDisplay, "Unknown");
  assert.equal(display.modelSpec.status, "unknown");
  assert.doesNotMatch(display.modelDisplay, /Claude|Gemini/i);
});

test("Header and footer display values share the same context string", () => {
  const route: ActiveProviderRoute = {
    providerId: "google",
    modelId: "gemini-2.5-flash",
    backendKind: "gemini-cli-auth",
    reasoning: "medium",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, 1_048_576, "known"),
  });

  assert.equal(display.contextDisplay, "0 / 1M");
  assert.ok(display.modelDisplay.includes("Gemini CLI / gemini-2.5-flash"));
  assert.ok(display.footerModelDisplay.includes("Gemini CLI / gemini-2.5-flash"));
});

test("Antigravity route display uses Antigravity CLI label and human-readable model label", () => {
  const route: ActiveProviderRoute = {
    providerId: "antigravity",
    modelId: "gemini-3.5-flash",
    backendKind: "antigravity-cli-auth",
    reasoning: "high",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.providerLabel, "Antigravity CLI");
  assert.equal(display.modelDisplay, "Antigravity CLI / Gemini 3.5 Flash / reasoning: High");
  assert.equal(display.footerModelDisplay, "Antigravity CLI / Gemini 3.5 Flash (High)");
});

test("provider label system recognizes Mistral Vibe CLI", () => {
  const route: ActiveProviderRoute = {
    providerId: "mistral",
    modelId: "mistral-medium-3.5",
    backendKind: "mistral-vibe-cli-auth",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.providerLabel, "Mistral Vibe CLI");
  assert.equal(display.footerModelDisplay, "Mistral Vibe CLI / mistral-medium-3.5");
});

test("Local route omits the non-adjustable reasoning suffix", () => {
  const route: ActiveProviderRoute = {
    providerId: "local",
    modelId: "qwen/qwen3.8-27b",
    backendKind: "local-openai-compatible",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.modelDisplay, "Local / qwen/qwen3.8-27b");
  assert.equal(display.footerModelDisplay, "Local / qwen/qwen3.8-27b");
  assert.doesNotMatch(display.footerModelDisplay, /\(Low\)/);
});

test("Antigravity route footer reflects reasoning separately from model label", () => {
  const route: ActiveProviderRoute = {
    providerId: "antigravity",
    modelId: "gemini-3.1-pro",
    backendKind: "antigravity-cli-auth",
    reasoning: "low",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.modelDisplay, "Antigravity CLI / Gemini 3.1 Pro / reasoning: Low");
  assert.equal(display.footerModelDisplay, "Antigravity CLI / Gemini 3.1 Pro (Low)");
});

test("Antigravity route displays correct label for Thinking profiles", () => {
  const route: ActiveProviderRoute = {
    providerId: "antigravity",
    modelId: "claude-sonnet-4-6-think",
    backendKind: "antigravity-cli-auth",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "high",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.modelDisplay, "Antigravity CLI / Claude Sonnet 4.6 (Thinking)");
  assert.equal(display.footerModelDisplay, "Antigravity CLI / Claude Sonnet 4.6 (Thinking)");
});

test("Antigravity GPT-OSS 120B displays label without effort suffix", () => {
  const route: ActiveProviderRoute = {
    providerId: "antigravity",
    modelId: "gpt-oss-120b",
    backendKind: "antigravity-cli-auth",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.modelDisplay, "Antigravity CLI / GPT-OSS 120B");
  assert.equal(display.footerModelDisplay, "Antigravity CLI / GPT-OSS 120B");
});

test("Codexa Native displays the canonical 1B model name for legacy 900M routes", () => {
  const route: ActiveProviderRoute = {
    providerId: "codexa-native",
    modelId: "codexa-900m-sft-v2-native",
    backendKind: "codexa-native-pytorch",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.footerModelDisplay, "Codexa Native / codexa-1b-sft-v2-native (Low)");
});

test("Codexa CuPy is presented as a Codexa Native model route", () => {
  const route: ActiveProviderRoute = {
    providerId: "codexa-cupy",
    modelId: "codexa-250m-cupy",
    backendKind: "codexa-cupy",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.providerLabel, "Codexa Native");
  assert.equal(display.footerModelDisplay, "Codexa Native / codexa-250m-cupy (Low)");
});
