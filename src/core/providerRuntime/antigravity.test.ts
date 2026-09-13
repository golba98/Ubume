import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { runCommand, type CommandResult, type CommandSpec } from "../process/CommandRunner.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  ANTIGRAVITY_DEFAULT_REASONING,
  getAgyModelSelector,
  getAntigravityModelLabel,
  migrateAntigravityLegacyModelId,
  resetAntigravityRouteValidationCacheForTests,
  runAntigravityWithRunner,
  validateAntigravityRoute,
  antigravityRuntime,
  discoverAgyModels,
  parseAgyModelsOutput,
} from "./antigravity.js";
import { resetAgyExecutableCacheForTests } from "../executables/antigravityExecutable.js";
import { saveCachedProviderModels } from "../models/providerModelCache.js";
import type { ProviderChatRequest } from "./types.js";

const AGY_MODELS_OUTPUT = [
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
].join("\n");
const DISCOVERED_AGY_MODELS = parseAgyModelsOutput(AGY_MODELS_OUTPUT);
const CURRENT_AGY_MODELS_OUTPUT = [
  "gemini-3.7-flash-high  Gemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium  Gemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low  Gemini 3.7 Flash (Low)",
  "gemini-3.6-flash-high  Gemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium  Gemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low  Gemini 3.6 Flash (Low)",
  "claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium  GPT-OSS 120B (Medium)",
].join("\n");

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "Hello back!",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function mockRunCommand(
  resultOrFn: CommandResult | ((spec: Parameters<typeof runCommand>[0]) => CommandResult),
  onCall?: (spec: Parameters<typeof runCommand>[0]) => void,
): typeof runCommand {
  return ((spec) => {
    onCall?.(spec);
    const result = typeof resultOrFn === "function" ? resultOrFn(spec) : resultOrFn;
    return {
      child: null as unknown as ChildProcess,
      result: Promise.resolve(result),
      cancel: () => undefined,
    };
  }) as typeof runCommand;
}

function buildRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  const runtime = normalizeRuntimeConfig({});
  return {
    prompt: "say hello back",
    route: {
      providerId: "antigravity",
      modelId: ANTIGRAVITY_DEFAULT_MODEL_ID,
      backendKind: "antigravity-cli-auth",
    },
    runtime: resolveRuntimeConfig(runtime),
    workspaceRoot: "/tmp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

test("Gemini 3.5 Flash appears once, not three times", () => {
  const geminiFlash = DISCOVERED_AGY_MODELS.filter((m) => m.label.includes("Gemini 3.5 Flash"));
  assert.equal(geminiFlash.length, 1, "Gemini 3.5 Flash should appear exactly once");
  assert.equal(geminiFlash[0]!.id, "gemini-3.5-flash");
});

test("Gemini 3.1 Pro appears once, not two times", () => {
  const geminiPro = DISCOVERED_AGY_MODELS.filter((m) => m.label.includes("Gemini 3.1 Pro"));
  assert.equal(geminiPro.length, 1, "Gemini 3.1 Pro should appear exactly once");
  assert.equal(geminiPro[0]!.id, "gemini-3.1-pro");
});

test("parseAgyModelsOutput preserves the full discovered catalog", () => {
  const labels = DISCOVERED_AGY_MODELS.map((m) => m.label);
  assert.ok(labels.includes("Gemini 3.5 Flash"), "missing Gemini 3.5 Flash");
  assert.ok(labels.includes("Gemini 3.1 Pro"), "missing Gemini 3.1 Pro");
  assert.ok(labels.includes("Claude Sonnet 4.6 (Thinking)"), "missing Claude Sonnet 4.6 (Thinking)");
  assert.ok(labels.includes("Claude Opus 4.6 (Thinking)"), "missing Claude Opus 4.6 (Thinking)");
  assert.ok(labels.includes("GPT-OSS 120B (Medium)"), "missing GPT-OSS 120B (Medium)");
});

test("parseAgyModelsOutput groups Gemini rows from the current two-column agy format", () => {
  const models = parseAgyModelsOutput(CURRENT_AGY_MODELS_OUTPUT);
  assert.deepEqual(models.map((model) => model.id), [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ]);
  assert.deepEqual(models[0]?.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high"]);
  assert.equal(getAgyModelSelector("gemini-3.7-flash", "high", models), "gemini-3.7-flash-high");
});

test("current agy format leaves Claude and GPT-OSS as native models without intelligence levels", () => {
  const models = parseAgyModelsOutput(CURRENT_AGY_MODELS_OUTPUT);
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]) {
    const model = models.find((item) => item.id === id);
    assert.ok(model, `${id} not found`);
    assert.equal(model.supportedReasoningLevels, null);
  }
  assert.equal(getAgyModelSelector("claude-sonnet-4-6", null, models), "claude-sonnet-4-6");
  assert.equal(getAgyModelSelector("gpt-oss-120b-medium", null, models), "gpt-oss-120b-medium");
});

test("Gemini 3.5 Flash supports Low/Medium/High reasoning (3 levels)", () => {
  const model = DISCOVERED_AGY_MODELS.find((m) => m.id === "gemini-3.5-flash");
  assert.ok(model, "gemini-3.5-flash not found");
  assert.ok(model!.supportedReasoningLevels !== null, "supportedReasoningLevels should not be null");
  assert.equal(model!.supportedReasoningLevels!.length, 3);
  const ids = model!.supportedReasoningLevels!.map((l) => l.id);
  assert.deepEqual(ids, ["low", "medium", "high"]);
  assert.ok(ids.includes("low"), "missing low");
  assert.ok(ids.includes("medium"), "missing medium");
  assert.ok(ids.includes("high"), "missing high");
});

test("Gemini 3.1 Pro supports Low/High reasoning (2 levels, no Medium)", () => {
  const model = DISCOVERED_AGY_MODELS.find((m) => m.id === "gemini-3.1-pro");
  assert.ok(model, "gemini-3.1-pro not found");
  assert.ok(model!.supportedReasoningLevels !== null, "supportedReasoningLevels should not be null");
  assert.equal(model!.supportedReasoningLevels!.length, 2);
  const ids = model!.supportedReasoningLevels!.map((l) => l.id);
  assert.deepEqual(ids, ["low", "high"]);
  assert.ok(ids.includes("low"), "missing low");
  assert.ok(ids.includes("high"), "missing high");
  assert.ok(!ids.includes("medium"), "Gemini 3.1 Pro should not have medium");
});

test("Claude Sonnet, Claude Opus, and GPT-OSS 120B have no reasoning levels", () => {
  for (const id of ["claude-sonnet-4.6-thinking", "claude-opus-4.6-thinking", "gpt-oss-120b-medium"]) {
    const model = DISCOVERED_AGY_MODELS.find((m) => m.id === id);
    assert.ok(model, `${id} not found`);
    assert.equal(model!.supportedReasoningLevels, null, `${id} should have null supportedReasoningLevels`);
  }
});

test("singleton parenthesized variants remain exact model identities", () => {
  const model = DISCOVERED_AGY_MODELS.find((m) => m.id === "gpt-oss-120b-medium");
  assert.equal(model?.label, "GPT-OSS 120B (Medium)");
  assert.equal(model?.supportedReasoningLevels, null);
});

test("default model is 'gemini-3.5-flash' with defaultReasoningLevel 'high'", () => {
  assert.equal(ANTIGRAVITY_DEFAULT_MODEL_ID, "gemini-3.5-flash");
  assert.equal(ANTIGRAVITY_DEFAULT_REASONING, "high");
  const defaultModel = DISCOVERED_AGY_MODELS.find((m) => m.id === ANTIGRAVITY_DEFAULT_MODEL_ID);
  assert.ok(defaultModel, "default model not found in discovery");
  assert.equal(defaultModel!.label, "Gemini 3.5 Flash");
  assert.equal(defaultModel!.defaultReasoningLevel, "high");
});

// ---------------------------------------------------------------------------
// Exact CLI selector mapping
// ---------------------------------------------------------------------------

test("getAgyModelSelector resolves exact discovered Gemini variants", () => {
  assert.equal(getAgyModelSelector("gemini-3.5-flash", "low", DISCOVERED_AGY_MODELS), "Gemini 3.5 Flash (Low)");
  assert.equal(getAgyModelSelector("gemini-3.1-pro", "high", DISCOVERED_AGY_MODELS), "Gemini 3.1 Pro (High)");
});

test("getAgyModelSelector uses the discovered default and singleton selector", () => {
  assert.equal(getAgyModelSelector("gemini-3.5-flash", undefined, DISCOVERED_AGY_MODELS), "Gemini 3.5 Flash (High)");
  assert.equal(getAgyModelSelector("claude-sonnet-4.6-thinking", undefined, DISCOVERED_AGY_MODELS), "Claude Sonnet 4.6 (Thinking)");
});

test("getAgyModelSelector does not guess unknown models or efforts", () => {
  assert.equal(getAgyModelSelector("gemini-3.5-flash", "ultra", DISCOVERED_AGY_MODELS), null);
  assert.equal(getAgyModelSelector("missing", "high", DISCOVERED_AGY_MODELS), null);
});

test("parseAgyModelsOutput preserves unknown repeated variants without a hardcoded level list", () => {
  const models = parseAgyModelsOutput("Gemini Future (Ultra)\nGemini Future (Nano)");
  assert.deepEqual(models[0]?.supportedReasoningLevels, [
    { id: "ultra", label: "Ultra", description: null },
    { id: "nano", label: "Nano", description: null },
  ]);
  assert.equal(getAgyModelSelector("gemini-future", "ultra", models), "Gemini Future (Ultra)");
  assert.deepEqual(parseAgyModelsOutput("\n"), []);
});

test("discoverAgyModels uses the last-good cache when live discovery fails", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-agy-cache-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = tempHome;
    delete process.env.USERPROFILE;
    saveCachedProviderModels("antigravity", { discoveredAt: Date.now(), models: DISCOVERED_AGY_MODELS });
    const discovery = await discoverAgyModels({
      executable: "agy",
      cwd: "/tmp",
      platform: "linux",
      runCommandImpl: mockRunCommand(commandResult({ status: "failed", exitCode: 1, stdout: "" })),
    });
    assert.equal(discovery.status, "ready");
    assert.equal(discovery.models.length, 5);
    assert.equal(discovery.diagnostics?.modelSource, "cache");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Legacy model ID migration
// ---------------------------------------------------------------------------

test("migrateAntigravityLegacyModelId: maps old compound IDs to family + reasoning", () => {
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.5-flash-high"),   { modelId: "gemini-3.5-flash", reasoning: "high" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.5-flash-medium"), { modelId: "gemini-3.5-flash", reasoning: "medium" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.5-flash-low"),    { modelId: "gemini-3.5-flash", reasoning: "low" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.1-pro-high"),     { modelId: "gemini-3.1-pro",   reasoning: "high" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.1-pro-low"),      { modelId: "gemini-3.1-pro",   reasoning: "low" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gpt-oss-120b"),            { modelId: "gpt-oss-120b-medium" });
});

test("migrateAntigravityLegacyModelId: passes through current model IDs unchanged", () => {
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.5-flash"),      { modelId: "gemini-3.5-flash" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gemini-3.1-pro"),        { modelId: "gemini-3.1-pro" });
  assert.deepEqual(migrateAntigravityLegacyModelId("claude-sonnet-4.6-thinking"), { modelId: "claude-sonnet-4.6-thinking" });
  assert.deepEqual(migrateAntigravityLegacyModelId("gpt-oss-120b-medium"),      { modelId: "gpt-oss-120b-medium" });
});

// ---------------------------------------------------------------------------
// Model label display
// ---------------------------------------------------------------------------

test("getAntigravityModelLabel: falls back to raw modelId for unknown id", () => {
  assert.equal(getAntigravityModelLabel("unknown-model"), "unknown-model");
});

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

test("runAntigravityWithRunner: passes the exact discovered selector with --model", async () => {
  let capturedSpec: CommandSpec | null = null;
  const runner = mockRunCommand(commandResult({}), (spec) => { capturedSpec = spec; });

  await new Promise<void>((resolve) => {
    const cancel = runAntigravityWithRunner(
      buildRequest({ prompt: "say hello back" }),
      {
        onResponse: () => resolve(),
        onError: (msg) => { throw new Error(msg); },
      },
      runner,
      "agy",
      "linux",
      DISCOVERED_AGY_MODELS,
    );
    void cancel;
  });

  assert.ok(capturedSpec !== null, "runCommand was not called");
  assert.equal((capturedSpec as CommandSpec).executable, "agy");
  assert.deepEqual((capturedSpec as CommandSpec).args, ["--model", "Gemini 3.5 Flash (High)", "-p", "say hello back"]);
});

test("runAntigravityWithRunner: wraps a .cmd executable in cmd.exe on Windows, keeping the prompt as one arg", async () => {
  let capturedSpec: CommandSpec | null = null;
  const runner = mockRunCommand(commandResult({}), (spec) => { capturedSpec = spec; });

  await new Promise<void>((resolve) => {
    runAntigravityWithRunner(
      buildRequest({ prompt: "say hello back" }),
      { onResponse: () => resolve(), onError: (msg) => { throw new Error(msg); } },
      runner,
      "agy.cmd",
      "win32",
      DISCOVERED_AGY_MODELS,
    );
  });

  assert.ok(capturedSpec !== null, "runCommand was not called");
  assert.equal((capturedSpec as CommandSpec).executable, "cmd.exe");
  assert.deepEqual((capturedSpec as CommandSpec).args, ["/d", "/s", "/c", "call", "agy.cmd", "--model", "Gemini 3.5 Flash (High)", "-p", "say hello back"]);
});

test("runAntigravityWithRunner: passes a .cmd executable through unchanged on non-Windows", async () => {
  let capturedSpec: CommandSpec | null = null;
  const runner = mockRunCommand(commandResult({}), (spec) => { capturedSpec = spec; });

  await new Promise<void>((resolve) => {
    runAntigravityWithRunner(
      buildRequest({ prompt: "say hello back" }),
      { onResponse: () => resolve(), onError: (msg) => { throw new Error(msg); } },
      runner,
      "agy.cmd",
      "linux",
      DISCOVERED_AGY_MODELS,
    );
  });

  assert.ok(capturedSpec !== null, "runCommand was not called");
  assert.equal((capturedSpec as CommandSpec).executable, "agy.cmd");
  assert.deepEqual((capturedSpec as CommandSpec).args, ["--model", "Gemini 3.5 Flash (High)", "-p", "say hello back"]);
});

test("runAntigravityWithRunner: does not synthesize AGY_MODEL", async () => {
  let capturedEnv: NodeJS.ProcessEnv | null | undefined;
  const runner = mockRunCommand(commandResult({}), (spec) => { capturedEnv = spec.env; });

  await new Promise<void>((resolve) => {
    runAntigravityWithRunner(
      buildRequest({ route: { providerId: "antigravity", modelId: "gemini-3.5-flash", backendKind: "antigravity-cli-auth", reasoning: "high" } }),
      { onResponse: () => resolve(), onError: (msg) => { throw new Error(msg); } },
      runner,
      "agy",
      "linux",
      DISCOVERED_AGY_MODELS,
    );
  });

  assert.equal(capturedEnv?.AGY_MODEL, process.env.AGY_MODEL);
});

test("runAntigravityWithRunner: selects singleton Claude models exactly", async () => {
  let capturedEnv: NodeJS.ProcessEnv | null | undefined;
  const runner = mockRunCommand(commandResult({}), (spec) => { capturedEnv = spec.env; });

  const prevAgyModel = process.env.AGY_MODEL;
  delete process.env.AGY_MODEL;

  try {
    await new Promise<void>((resolve) => {
      runAntigravityWithRunner(
        buildRequest({ route: { providerId: "antigravity", modelId: "claude-sonnet-4.6-thinking", backendKind: "antigravity-cli-auth" } }),
        { onResponse: () => resolve(), onError: (msg) => { throw new Error(msg); } },
        runner,
        "agy",
        "linux",
        DISCOVERED_AGY_MODELS,
      );
    });
    assert.equal(capturedEnv?.AGY_MODEL, undefined);
  } finally {
    if (prevAgyModel !== undefined) process.env.AGY_MODEL = prevAgyModel;
  }
});

test("runAntigravityWithRunner: calls onError when agy exits non-zero", async () => {
  const runner = mockRunCommand(commandResult({ status: "failed", exitCode: 1, stdout: "", stderr: "auth error" }));

  const errorMsg = await new Promise<string>((resolve) => {
    runAntigravityWithRunner(
      buildRequest(),
      { onResponse: () => { throw new Error("unexpected success"); }, onError: resolve },
      runner,
      "agy",
      "linux",
      DISCOVERED_AGY_MODELS,
    );
  });

  assert.ok(errorMsg.length > 0, "expected a non-empty error message");
});

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

test("validateAntigravityRoute: returns not-configured when agy binary is missing (spawn_error)", async () => {
  resetAntigravityRouteValidationCacheForTests();
  const result = await validateAntigravityRoute({
    cwd: "/tmp",
    configuredPath: null,
    runCommandImpl: mockRunCommand(commandResult({ status: "spawn_error", exitCode: null, userMessage: "`agy` is not installed." })),
  });

  assert.equal(result.status, "not-configured");
  assert.ok(result.message?.includes("agy"), "message should mention agy");
});

test("validateAntigravityRoute: returns ready when agy --help succeeds", async () => {
  resetAntigravityRouteValidationCacheForTests();
  const result = await validateAntigravityRoute({
    cwd: "/tmp",
    runCommandImpl: mockRunCommand((spec) => {
      if (spec.args[0] === "--help") {
        return commandResult({ status: "completed", exitCode: 0, stdout: "Usage of agy..." });
      }
      if (spec.args[0] === "models") return commandResult({ stdout: AGY_MODELS_OUTPUT });
      return commandResult({ status: "failed", exitCode: 1 });
    }),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.backendKind, "antigravity-cli-auth");
});

test("validateAntigravityRoute: second validation in a session short-circuits without re-spawning", async () => {
  resetAntigravityRouteValidationCacheForTests();
  let spawnCount = 0;
  const runCommandImpl = mockRunCommand((spec) => {
    if (spec.args[0] === "--help") return commandResult({ status: "completed", exitCode: 0, stdout: "Usage of agy..." });
    if (spec.args[0] === "models") return commandResult({ stdout: AGY_MODELS_OUTPUT });
    return commandResult({ status: "failed", exitCode: 1 });
  }, () => { spawnCount += 1; });

  const first = await validateAntigravityRoute({ cwd: "/tmp", runCommandImpl });
  assert.equal(first.status, "ready");
  const spawnsAfterFirst = spawnCount;
  assert.ok(spawnsAfterFirst > 0, "first validation should probe the executable");

  const second = await validateAntigravityRoute({ cwd: "/tmp", runCommandImpl });
  assert.equal(second.status, "ready");
  assert.equal(second.backendKind, "antigravity-cli-auth");
  assert.equal(second.diagnostics?.modelSource, "session-cache");
  assert.equal(spawnCount, spawnsAfterFirst, "second validation must not spawn subprocesses");
});

test("validateAntigravityRoute: wraps a .cmd executable probe in cmd.exe on Windows", async () => {
  resetAntigravityRouteValidationCacheForTests();
  const capturedSpecs: CommandSpec[] = [];
  const result = await validateAntigravityRoute({
    cwd: "/tmp",
    configuredPath: "agy.cmd",
    platform: "win32",
    runCommandImpl: mockRunCommand((spec) => spec.args.includes("models")
      ? commandResult({ stdout: AGY_MODELS_OUTPUT })
      : commandResult({ status: "completed", exitCode: 0, stdout: "Usage of agy..." }),
    (spec) => { capturedSpecs.push(spec); }),
  });

  assert.equal(result.status, "ready");
  assert.equal(capturedSpecs[0]?.executable, "cmd.exe");
  assert.deepEqual(capturedSpecs[0]?.args, ["/d", "/s", "/c", "call", "agy.cmd", "--help"]);
  assert.deepEqual(capturedSpecs[1]?.args, ["/d", "/s", "/c", "call", "agy.cmd", "models"]);
});

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

test("antigravityRuntime exposes routeAvailable: true and correct backendKind", () => {
  assert.equal(antigravityRuntime.routeAvailable, true);
  assert.equal(antigravityRuntime.backendKind, "antigravity-cli-auth");
  assert.equal(antigravityRuntime.providerId, "antigravity");
});

test("antigravityRuntime.discoverModels returns the live discovered catalog", () => {
  const result = antigravityRuntime.discoverModels();
  assert.equal(result.status, "ready");
  assert.equal(result.models.length, 5);
  assert.equal(result.providerId, "antigravity");
});
