import assert from "node:assert/strict";
import test from "node:test";
import {
  getCommandSuggestionState,
  getComposerToFooterGapRows,
  getComposerPersona,
  getTokenBarDisplay,
  getVisibleComposerStatusLine,
  measureBottomComposerRows,
} from "./BottomComposer.js";
import { createLayoutSnapshot } from "../layout.js";
import { getSlashCommandSuggestions } from "../input/slashCommands.js";
import type { PendingModelSpec, VerifiedModelSpec } from "../../core/models/modelSpecs.js";

test("maps the idle state to the idle composer persona", () => {
  assert.equal(getComposerPersona({ kind: "IDLE" }), "idle");
});

test("maps busy, answer, and error states to the right personas", () => {
  assert.equal(getComposerPersona({ kind: "THINKING", turnId: 1 }), "busy");
  assert.equal(getComposerPersona({ kind: "RESPONDING", turnId: 1 }), "busy");
  assert.equal(getComposerPersona({ kind: "SHELL_RUNNING", shellId: 7 }), "busy");
  assert.equal(getComposerPersona({ kind: "AWAITING_USER_ACTION", turnId: 2, question: "Need Redis?" }), "answer");
  assert.equal(getComposerPersona({ kind: "ERROR", turnId: 3, message: "Boom" }), "error");
});

test("measures compact idle bottom chrome as metadata plus prompt border", () => {
  const rows = measureBottomComposerRows({
    layout: createLayoutSnapshot(100, 30),
    uiState: { kind: "IDLE" },
    mode: "auto-edit",
    model: "gpt-5.4",
    reasoningLevel: "medium",
    tokensUsed: 1200,
    value: "",
    cursor: 0,
  });

  assert.equal(rows, 4);
});

test("keeps runtime footer directly attached to the composer", () => {
  assert.equal(getComposerToFooterGapRows(createLayoutSnapshot(120, 30)), 0);
  assert.equal(getComposerToFooterGapRows(createLayoutSnapshot(100, 24)), 0);
  assert.equal(getComposerToFooterGapRows(createLayoutSnapshot(39, 30)), 0);
});

test("keeps the composer status row visible in normal 24-row terminals", () => {
  const rows = measureBottomComposerRows({
    layout: createLayoutSnapshot(80, 24),
    uiState: { kind: "THINKING", turnId: 1 },
    value: "",
    cursor: 0,
  });

  assert.equal(rows, 5);
});

test("does not render an exact slash command draft as a suggestion row", () => {
  const exact = getCommandSuggestionState({
    value: "/clear",
    allowCommands: true,
    inputLocked: false,
  });

  assert.equal(exact.showSuggestions, true);
  assert.equal(exact.reserveSuggestionRow, true);
  assert.deepEqual(exact.suggestions.map((suggestion) => suggestion.cmd), []);
});

test("keeps partial slash command suggestions visible", () => {
  const partial = getCommandSuggestionState({
    value: "/clea",
    allowCommands: true,
    inputLocked: false,
  });

  assert.equal(partial.showSuggestions, true);
  assert.equal(partial.reserveSuggestionRow, true);
  assert.deepEqual(partial.suggestions.map((suggestion) => suggestion.cmd), ["/clear"]);
});

test("surfaces the provider picker suggestion for root prefixes and alias input", () => {
  const rootSuggestions = getCommandSuggestionState({
    value: "/",
    allowCommands: true,
    inputLocked: false,
  });

  assert.equal(rootSuggestions.showSuggestions, true);
  assert.ok(rootSuggestions.suggestions.map((suggestion) => suggestion.cmd).includes("/providers"));

  const pSuggestions = getCommandSuggestionState({
    value: "/p",
    allowCommands: true,
    inputLocked: false,
  });

  assert.ok(pSuggestions.suggestions.map((suggestion) => suggestion.cmd).includes("/providers"));

  const shortProviderSuggestions = getCommandSuggestionState({
    value: "/pro",
    allowCommands: true,
    inputLocked: false,
  });

  assert.ok(shortProviderSuggestions.suggestions.map((suggestion) => suggestion.cmd).includes("/providers"));

  const prefixProviderSuggestions = getCommandSuggestionState({
    value: "/pr",
    allowCommands: true,
    inputLocked: false,
  });

  assert.ok(prefixProviderSuggestions.suggestions.map((suggestion) => suggestion.cmd).includes("/providers"));

  const providerSuggestions = getCommandSuggestionState({
    value: "/provider",
    allowCommands: true,
    inputLocked: false,
  });

  assert.equal(providerSuggestions.showSuggestions, true);
  assert.deepEqual(providerSuggestions.suggestions.map((suggestion) => suggestion.cmd), ["/providers"]);

  const exactProviderSuggestions = getCommandSuggestionState({
    value: "/providers",
    allowCommands: true,
    inputLocked: false,
  });

  assert.equal(exactProviderSuggestions.showSuggestions, true);
  assert.deepEqual(exactProviderSuggestions.suggestions.map((suggestion) => suggestion.cmd), ["/providers"]);

  const aliasMetadata = getSlashCommandSuggestions("/provider").find((suggestion) => suggestion.cmd === "/providers");
  assert.deepEqual(aliasMetadata?.aliases, ["/provider"]);
});

test("keeps exact and partial slash command row budgets stable", () => {
  const layout = createLayoutSnapshot(100, 30);
  const base = {
    layout,
    uiState: { kind: "IDLE" } as const,
    value: "",
    cursor: 0,
  };

  const partialRows = measureBottomComposerRows({
    ...base,
    value: "/clea",
    cursor: "/clea".length,
  });
  const exactRows = measureBottomComposerRows({
    ...base,
    value: "/clear",
    cursor: "/clear".length,
  });

  assert.equal(exactRows, partialRows);
});

test("suppresses completed response status while a slash command draft is active", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "ANSWER_VISIBLE", turnId: 1 },
      value: "/clear",
      allowCommands: true,
    }),
    "",
  );

  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "ANSWER_VISIBLE", turnId: 1 },
      value: "next prompt",
      allowCommands: true,
    }),
    "✧ Ubume response complete",
  );
});

test("shows Gemini-specific status when THINKING with google provider at 0 seconds", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 0,
    }),
    "Starting Gemini CLI",
  );
});

test("includes elapsed timer in Gemini status after first second", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 3,
    }),
    "Starting Gemini CLI  00:03",
  );
});

test("shows reassurance message in Gemini status at 5 seconds", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 5,
    }),
    "Gemini CLI is still starting. The upstream CLI can take a moment  00:05",
  );
});

test("shows still waiting message in Gemini status at 15 seconds", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 15,
    }),
    "Still waiting for Gemini CLI  00:15",
  );
});

test("shows generic thinking status for unknown/local provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "local",
      runElapsedSeconds: 10,
    }),
    "✧ Ubume is thinking",
  );
});

test("shows Starting Claude Code at 0 seconds for anthropic provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 0,
    }),
    "Starting Claude Code",
  );
});

test("includes elapsed timer in Claude Code status after first second", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 3,
    }),
    "Starting Claude Code  00:03",
  );
});

test("shows reassurance message at 5 seconds for Claude Code", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 5,
    }),
    "Claude Code is still starting. The upstream CLI can take a moment  00:05",
  );
});

test("shows still waiting message at 15 seconds for Claude Code", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 15,
    }),
    "Still waiting for Claude Code  00:15",
  );
});

test("shows Starting Codex CLI at 0 seconds for openai provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "openai",
      runElapsedSeconds: 0,
    }),
    "Starting Codex CLI",
  );
});

test("includes elapsed timer in Codex CLI status after first second", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "openai",
      runElapsedSeconds: 3,
    }),
    "Starting Codex CLI  00:03",
  );
});

test("shows Gemini ready status when RESPONDING with google provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "RESPONDING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
    }),
    "✧ Gemini ready",
  );
});

test("shows Claude ready status when RESPONDING with anthropic provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "RESPONDING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
    }),
    "✧ Claude ready",
  );
});

test("shows Codex ready status when RESPONDING with openai provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "RESPONDING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "openai",
    }),
    "✧ Codex ready",
  );
});

test("shows generic thinking status when RESPONDING with unknown provider", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "RESPONDING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "local",
    }),
    "✧ Ubume is thinking",
  );
});

test("shows error message in status for google provider in ERROR state regardless of elapsed time", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "ERROR", turnId: 1, message: "Gemini CLI failed to start" },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 30,
    }),
    "Gemini CLI failed to start",
  );
});

test("shows error message in status for anthropic provider in ERROR state regardless of elapsed time", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "ERROR", turnId: 1, message: "Claude Code failed to start" },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 30,
    }),
    "Claude Code failed to start",
  );
});

test("getTokenBarDisplay returns null percentage (not 0) for an unknown spec", () => {
  const spec: PendingModelSpec = {
    status: "unknown",
    contextWindow: null,
    maxOutputTokens: null,
    sourceUrl: "",
    verifiedAt: null,
    error: null,
  };
  const display = getTokenBarDisplay(5_000, spec);
  assert.equal(display.percentage, null, "percentage must be null, not 0, for unknown specs");
  assert.equal(display.usedText, "Context");
  assert.equal(display.limitText, "Unknown");
  assert.equal(display.isEstimatedLimit, false);
  assert.equal(display.hasKnownLimit, false);
});

test("getTokenBarDisplay returns correct non-null percentage for a verified spec", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    sourceUrl: "",
    verifiedAt: 0,
  };
  const display = getTokenBarDisplay(10_000, spec);
  assert.equal(display.percentage, 5);
  assert.notEqual(display.percentage, null);
  assert.equal(display.isEstimatedLimit, false);
  assert.equal(display.hasKnownLimit, true);
  assert.equal(display.usedText, "10,000", "usedText should be exact number with thousands separator");
});

test("getTokenBarDisplay formats refreshed LM Studio context meter", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 32_000,
    maxOutputTokens: 32_000,
    sourceUrl: "lmstudio-api",
    verifiedAt: 0,
  };
  const display = getTokenBarDisplay(0, spec);
  assert.equal(display.usedText, "0");
  assert.equal(display.limitText, "32,000");
  assert.equal(display.percentage, 0);
  assert.equal(display.hasKnownLimit, true);
});

test("getTokenBarDisplay does not add ~ prefix for a documented verified context window", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    sourceUrl: "",
    verifiedAt: 0,
  };
  const display = getTokenBarDisplay(10_000, spec);
  assert.equal(display.isEstimatedLimit, false);
  assert.ok(!display.limitText.startsWith("~"), "verified limitText must not start with ~");
});

// ─── externalCliStatus: provider readiness gate ───────────────────────────────

test("shows 'Ubume is thinking' (not startup message) when provider is ready and THINKING — google", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 2 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 0,
      externalCliStatus: "ready",
    }),
    "✧ Ubume is thinking",
  );
});

test("shows 'Ubume is thinking' even at 20 seconds elapsed when provider is ready — google", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 2 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 20,
      externalCliStatus: "ready",
    }),
    "✧ Ubume is thinking",
  );
});

test("shows 'Ubume is thinking' (not startup message) when provider is ready and THINKING — anthropic", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 2 },
      value: "",
      allowCommands: true,
      activeProviderId: "anthropic",
      runElapsedSeconds: 0,
      externalCliStatus: "ready",
    }),
    "✧ Ubume is thinking",
  );
});

test("shows 'Ubume is thinking' (not startup message) when provider is ready and THINKING — openai", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 2 },
      value: "",
      allowCommands: true,
      activeProviderId: "openai",
      runElapsedSeconds: 0,
      externalCliStatus: "ready",
    }),
    "✧ Ubume is thinking",
  );
});

test("still shows startup messages when externalCliStatus is 'starting' — google at 0 seconds", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 0,
      externalCliStatus: "starting",
    }),
    "Starting Gemini CLI",
  );
});

test("still shows 'Still waiting' when externalCliStatus is 'starting' at 15 seconds — google", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 15,
      externalCliStatus: "starting",
    }),
    "Still waiting for Gemini CLI  00:15",
  );
});

test("still shows startup messages when externalCliStatus is 'idle' (first prompt, not yet starting)", () => {
  assert.equal(
    getVisibleComposerStatusLine({
      uiState: { kind: "THINKING", turnId: 1 },
      value: "",
      allowCommands: true,
      activeProviderId: "google",
      runElapsedSeconds: 0,
      externalCliStatus: "idle",
    }),
    "Starting Gemini CLI",
  );
});

test("regression: second prompt with ready provider never shows 'Still waiting for Gemini CLI'", () => {
  const statusLine = getVisibleComposerStatusLine({
    uiState: { kind: "THINKING", turnId: 2 },
    value: "",
    allowCommands: true,
    activeProviderId: "google",
    runElapsedSeconds: 20,
    externalCliStatus: "ready",
  });
  assert.ok(
    !/Still waiting for Gemini CLI|Starting Gemini CLI|Checking Gemini/i.test(statusLine),
    `Expected no startup text but got: "${statusLine}"`,
  );
});

// ─── getTokenBarDisplay — new format ─────────────────────────────────────────

test("getTokenBarDisplay(0, 64k spec) shows '0' usedText and '64,000' limitText, not Unknown", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 64_000,
    maxOutputTokens: 64_000,
    sourceUrl: "",
    verifiedAt: 0,
  };
  const display = getTokenBarDisplay(0, spec);
  assert.equal(display.hasKnownLimit, true, "64k verified spec must have known limit");
  assert.equal(display.usedText, "0", "0 tokens used renders as '0'");
  assert.equal(display.limitText, "64,000");
  assert.equal(display.percentage, 0);
});

test("getTokenBarDisplay uses Math.floor — 1999/200000 rounds down to 0%", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 200_000,
    maxOutputTokens: 200_000,
    sourceUrl: "",
    verifiedAt: 0,
  };
  const display = getTokenBarDisplay(1_999, spec);
  // floor(1999/200000*100) = floor(0.9995) = 0; Math.round would give 1
  assert.equal(display.percentage, 0, "percentage must use Math.floor, not Math.round");
});

test("getTokenBarDisplay unknown spec regression — hasKnownLimit is false", () => {
  const spec: PendingModelSpec = {
    status: "unknown",
    contextWindow: null,
    maxOutputTokens: null,
    sourceUrl: "",
    verifiedAt: null,
    error: null,
  };
  assert.equal(getTokenBarDisplay(99_999, spec).hasKnownLimit, false);
});

// ─── getTokenBarDisplay — estimated specs ─────────────────────────────────────

test("getTokenBarDisplay with isEstimated spec returns limitText with ~ prefix and compact format", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 400_000,
    maxOutputTokens: 400_000,
    sourceUrl: "known-registry",
    verifiedAt: 0,
    isEstimated: true,
  };
  const display = getTokenBarDisplay(0, spec);
  assert.equal(display.limitText, "~400K");
  assert.equal(display.isEstimatedLimit, true);
  assert.equal(display.hasKnownLimit, true);
});

test("getTokenBarDisplay with isEstimated spec still has correct percentage", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 400_000,
    maxOutputTokens: 400_000,
    sourceUrl: "known-registry",
    verifiedAt: 0,
    isEstimated: true,
  };
  const display = getTokenBarDisplay(40_000, spec);
  assert.equal(display.percentage, 10);
  assert.equal(display.hasKnownLimit, true);
});

test("getTokenBarDisplay with isEstimated uses compact M suffix for 1M context", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 1_048_576,
    maxOutputTokens: 1_048_576,
    sourceUrl: "known-registry",
    verifiedAt: 0,
    isEstimated: true,
  };
  const display = getTokenBarDisplay(0, spec);
  assert.equal(display.limitText, "~1.0M");
  assert.equal(display.isEstimatedLimit, true);
});

test("getTokenBarDisplay with isEstimated: false uses comma format (regression guard)", () => {
  const spec: VerifiedModelSpec = {
    status: "verified",
    contextWindow: 400_000,
    maxOutputTokens: 400_000,
    sourceUrl: "",
    verifiedAt: 0,
    isEstimated: false,
  };
  const display = getTokenBarDisplay(0, spec);
  assert.equal(display.limitText, "400,000");
  assert.equal(display.isEstimatedLimit, false);
});

test("measures the transient status row while input is locked even for a slash-command draft", () => {
  const layout = createLayoutSnapshot(100, 30);
  const busy = { kind: "THINKING", turnId: 1 } as const;
  const plainDraft = measureBottomComposerRows({ layout, uiState: busy, value: "hello", cursor: 5 });
  const commandDraft = measureBottomComposerRows({ layout, uiState: busy, value: "/model", cursor: 6 });

  assert.equal(getVisibleComposerStatusLine({ uiState: busy, value: "/model", allowCommands: true }), "");
  assert.equal(commandDraft, plainDraft);
});
