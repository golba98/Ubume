import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { runCommand, type CommandResult } from "../process/CommandRunner.js";
import {
  parseClaudeAuthStatus,
  parseClaudeEffortLevelsFromHelp,
  claudeCodeModelsToProviderModels,
  getClaudeModelDefaultEffort,
  modelSupportsClaudeEffort,
  discoverClaudeCodeCapabilities,
  discoverModelsFromClaudePackageMetadata,
} from "./claudeCodeDiscovery.js";
import { ANTHROPIC_FALLBACK_MODELS } from "./models.js";

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function mockRunCommand(
  resultOrMap: CommandResult | ((executable: string, args: string[]) => CommandResult),
): typeof runCommand {
  return ((spec) => {
    const result = typeof resultOrMap === "function"
      ? resultOrMap(spec.executable, spec.args)
      : resultOrMap;
    return {
      child: null as unknown as ChildProcess,
      result: Promise.resolve(result),
      cancel: () => undefined,
    };
  }) as typeof runCommand;
}

// ---------------------------------------------------------------------------
// 1. parseClaudeAuthStatus Unit Tests
// ---------------------------------------------------------------------------
test("parseClaudeAuthStatus: handles valid JSON loggedIn true/false and extra fields", () => {
  const trueRes = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "firstParty",
    apiProvider: "anthropic",
    subscriptionType: "pro",
    extraField: "ignored",
  }));
  assert.deepEqual(trueRes, {
    loggedIn: true,
    authMethod: "firstParty",
    apiProvider: "anthropic",
    subscriptionType: "pro",
  });

  const falseRes = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: false,
    extraField: 123,
  }));
  assert.deepEqual(falseRes, {
    loggedIn: false,
    authMethod: undefined,
    apiProvider: undefined,
    subscriptionType: undefined,
  });
});

test("parseClaudeAuthStatus: returns null for invalid JSON or non-object", () => {
  assert.equal(parseClaudeAuthStatus("{bad json"), null);
  assert.equal(parseClaudeAuthStatus("plain string"), null);
  assert.equal(parseClaudeAuthStatus('"valid json string but not object"'), null);
  assert.equal(parseClaudeAuthStatus("42"), null);
  assert.equal(parseClaudeAuthStatus("[]"), null);
  assert.equal(parseClaudeAuthStatus("null"), null);
});

test("parseClaudeEffortLevelsFromHelp: extracts the CLI valid-values list", () => {
  const helpText = "Usage: claude [options]\n  --effort <level>  Effort level (low, medium, high, xhigh, max)";
  assert.deepEqual(parseClaudeEffortLevelsFromHelp(helpText), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseClaudeEffortLevelsFromHelp("Usage: claude [options]"), null);
});

// ---------------------------------------------------------------------------
// 2. claudeCodeModelsToProviderModels Unit Tests
// ---------------------------------------------------------------------------
test("claudeCodeModelsToProviderModels: empty list", () => {
  assert.deepEqual(claudeCodeModelsToProviderModels([]), []);
});

test("claudeCodeModelsToProviderModels: maps models with effort levels and verified flag", () => {
  const models = [
    {
      label: "Custom Claude Model",
      family: "sonnet",
      value: "claude-custom-sonnet-1",
      canonicalId: "canonical-sonnet",
      source: "claude-code" as const,
      isFallback: false,
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
      effortSource: "claude-code" as const,
      effortVerified: true,
      description: "A very nice custom model",
    },
  ];

  const providerModels = claudeCodeModelsToProviderModels(models);
  assert.equal(providerModels.length, 1);
  assert.equal(providerModels[0].id, "claude-custom-sonnet-1");
  assert.equal(providerModels[0].modelId, "claude-custom-sonnet-1");
  assert.equal(providerModels[0].label, "Custom Claude Model");
  assert.equal(providerModels[0].description, "A very nice custom model");
  assert.equal(providerModels[0].defaultReasoningLevel, "medium");
  assert.deepEqual(providerModels[0].supportedReasoningLevels?.map((l) => l.id), ["low", "medium", "high"]);
  assert.equal(providerModels[0].source, "claude-code");
  assert.equal(providerModels[0].canonicalId, "canonical-sonnet");
  assert.equal(providerModels[0].family, "sonnet");
  assert.equal(providerModels[0].effortSource, "claude-code");
  assert.equal(providerModels[0].effortVerified, true);
});

test("claudeCodeModelsToProviderModels: correct source propagation and description fallback", () => {
  const m1 = {
    label: "Sonnet Fallback",
    family: "sonnet",
    value: "claude-3-5-sonnet-fallback",
    canonicalId: "claude-3-5-sonnet",
    source: "fallback" as const,
    isFallback: true,
    effortLevels: ["medium"],
    defaultEffort: "medium",
    effortSource: "fallback" as const,
    effortVerified: false,
  };
  const m2 = {
    label: "Sonnet Settings",
    family: "sonnet",
    value: "claude-3-5-sonnet-settings",
    canonicalId: "claude-3-5-sonnet",
    source: "settings" as const,
    isFallback: false,
    effortLevels: ["medium"],
    defaultEffort: "medium",
    effortSource: "settings" as const,
    effortVerified: false,
  };

  const results = claudeCodeModelsToProviderModels([m1, m2]);
  assert.match(results[0].description ?? "", /Fallback defaults; effort metadata unverified/);
  assert.match(results[1].description ?? "", /From Claude settings/);
});

// ---------------------------------------------------------------------------
// 3. getClaudeModelDefaultEffort Unit Tests
// ---------------------------------------------------------------------------
test("getClaudeModelDefaultEffort: matches by modelId, family, canonicalId, and falls back to medium", () => {
  const mockProviderModels = [
    {
      id: "claude-opus-model",
      modelId: "claude-opus-model",
      label: "Opus Model",
      defaultReasoningLevel: "high",
      supportedReasoningLevels: [],
      canonicalId: "canonical-opus",
      family: "opus",
    },
  ] as any;

  assert.equal(getClaudeModelDefaultEffort("claude-opus-model", mockProviderModels), "high");
  assert.equal(getClaudeModelDefaultEffort("opus", mockProviderModels), "high");
  assert.equal(getClaudeModelDefaultEffort("canonical-opus", mockProviderModels), "high");
  assert.equal(getClaudeModelDefaultEffort("nonexistent", mockProviderModels), "medium");
});

// ---------------------------------------------------------------------------
// 4. modelSupportsClaudeEffort Unit Tests
// ---------------------------------------------------------------------------
test("modelSupportsClaudeEffort: checks supported, unsupported, and invalid efforts", () => {
  const mockProviderModels = [
    {
      id: "sonnet-model",
      modelId: "sonnet-model",
      label: "Sonnet Model",
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ id: "low" }, { id: "medium" }],
      canonicalId: "canonical-sonnet",
      family: "sonnet",
    },
  ] as any;

  assert.equal(modelSupportsClaudeEffort("sonnet-model", "low", mockProviderModels), true);
  assert.equal(modelSupportsClaudeEffort("sonnet-model", "medium", mockProviderModels), true);
  assert.equal(modelSupportsClaudeEffort("sonnet-model", "high", mockProviderModels), false);
  assert.equal(modelSupportsClaudeEffort("sonnet-model", null, mockProviderModels), false);
  assert.equal(modelSupportsClaudeEffort("sonnet-model", undefined, mockProviderModels), false);
  assert.equal(modelSupportsClaudeEffort("nonexistent-model", "low", mockProviderModels), false);
});

// ---------------------------------------------------------------------------
// 5. discoverClaudeCodeCapabilities Unit Tests
// ---------------------------------------------------------------------------
test("discoverClaudeCodeCapabilities: auth info parsed from claude auth status output", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    metadataPaths: [],
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (executable === "where.exe") return commandResult({ exitCode: 0, stdout: "claude\n" });
      if (args[0] === "auth") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "firstParty",
            apiProvider: "anthropic",
            subscriptionType: "pro",
          }),
        });
      }
      return commandResult({ exitCode: 0 });
    }),
  });

  assert.equal(discovery.auth.loggedIn, true);
  assert.equal(discovery.auth.authMethod, "firstParty");
  assert.equal(discovery.auth.apiProvider, "anthropic");
  assert.equal(discovery.auth.subscriptionType, "pro");
});

test("discoverClaudeCodeCapabilities: full success with model list --json as array of model objects", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    metadataPaths: [],
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              value: "claude-3-5-sonnet-custom",
              label: "Discovered Sonnet",
              family: "sonnet",
              canonicalId: "canonical-custom-sonnet",
              effortLevels: ["low", "medium"],
              defaultEffort: "low",
            },
          ]),
        });
      }
      return commandResult({ exitCode: 0 });
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command");
  assert.equal(discovery.models.length, 1);
  assert.equal(discovery.models[0].value, "claude-3-5-sonnet-custom");
  assert.equal(discovery.models[0].label, "Discovered Sonnet");
  assert.equal(discovery.models[0].source, "claude-code-command");
  assert.equal(discovery.models[0].effortVerified, true);
});

test("discoverClaudeCodeCapabilities: full success with model list --json returning JSON object with .models key", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify({
            models: [
              {
                value: "claude-3-5-sonnet-custom-2",
                label: "Discovered Sonnet 2",
                family: "sonnet",
                canonicalId: "canonical-custom-sonnet-2",
                effortLevels: ["low", "medium"],
                defaultEffort: "medium",
              },
            ],
          }),
        });
      }
      return commandResult({ exitCode: 0 });
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command");
  assert.equal(discovery.models.length, 1);
  assert.equal(discovery.models[0].value, "claude-3-5-sonnet-custom-2");
  assert.equal(discovery.models[0].label, "Discovered Sonnet 2");
});

test("discoverClaudeCodeCapabilities: full success with model list --json returning plain string model IDs", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify(["claude-3-5-sonnet-custom-3"]),
        });
      }
      return commandResult({ exitCode: 0 });
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command");
  assert.equal(discovery.models.length, 1);
  assert.equal(discovery.models[0].value, "claude-3-5-sonnet-custom-3");
  assert.equal(discovery.models[0].label, "Claude Sonnet (version unknown)");
});

test("discoverClaudeCodeCapabilities: applies CLI effort truth and settings default without overriding per-model metadata", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-discovery-effort-test-"));
  const settingsPath = join(tempRoot, "settings.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({ effortLevel: "xhigh" }), "utf-8");
    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(), settingsPath, metadataPaths: [],
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ stdout: JSON.stringify({ loggedIn: true }) });
        if (args[0] === "--help") return commandResult({ stdout: "  --effort <level>  Set effort (low, medium, high, xhigh, max)" });
        if (args[0] === "model" && args[1] === "list") return commandResult({ stdout: JSON.stringify([
          { value: "sonnet", family: "sonnet" },
          { value: "haiku", family: "haiku", effortLevels: ["low", "ultra"], defaultEffort: "ultra" },
        ]) });
        return commandResult({ exitCode: 1 });
      }),
    });
    const sonnet = discovery.models.find((model) => model.value === "sonnet");
    assert.deepEqual(sonnet?.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(sonnet?.defaultEffort, "xhigh");
    assert.equal(sonnet?.effortSource, "claude-code-command");
    assert.equal(sonnet?.effortVerified, true);
    const haiku = discovery.models.find((model) => model.value === "haiku");
    assert.deepEqual(haiku?.effortLevels, ["low", "ultra"]);
    assert.equal(haiku?.defaultEffort, "ultra");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverClaudeCodeCapabilities: normalizes versioned Claude Code IDs into clear labels", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify([
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
          ]),
        });
      }
      return commandResult({ exitCode: 1 });
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command");
  assert.deepEqual(
    discovery.models.map((model) => [model.value, model.label]),
    [
      ["claude-opus-4-8", "Claude Opus 4.8"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
      ["claude-haiku-4-5", "Claude Haiku 4.5"],
    ],
  );
});

test("discoverClaudeCodeCapabilities: aliases are marked version unknown when Claude Code exposes no version", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    metadataPaths: [],
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({ exitCode: 0, stdout: JSON.stringify(["opus", "sonnet", "haiku"]) });
      }
      return commandResult({ exitCode: 1 });
    }),
  });

  assert.deepEqual(
    discovery.models.map((model) => [model.value, model.label]),
    [
      ["opus", "Claude Opus (version unknown)"],
      ["sonnet", "Claude Sonnet (version unknown)"],
      ["haiku", "Claude Haiku (version unknown)"],
    ],
  );
});

test("discoverClaudeCodeCapabilities: resolves alias-only command output using installed package metadata", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-package-metadata-test-"));
  const metadataPath = join(tempRoot, "claude-binary-strings.txt");
  try {
    writeFileSync(
      metadataPath,
      [
        "claude-opus-4-6",
        "claude-opus-4-8",
        "claude-sonnet-4-5",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
      ].join("\n"),
      "utf-8",
    );

    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      metadataPaths: [metadataPath],
      settingsPath: null,
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
          return commandResult({ exitCode: 0, stdout: JSON.stringify(["opus", "sonnet", "haiku"]) });
        }
        return commandResult({ exitCode: 1 });
      }),
    });

    assert.equal(discovery.modelSource, "claude-code-package");
    assert.deepEqual(
      discovery.models.map((model) => ({
        value: model.value,
        canonicalId: model.canonicalId,
        label: model.label,
        version: model.version,
        source: model.source,
        isFallback: model.isFallback,
        discoveryKind: model.discoveryKind,
      })),
      [
        { value: "opus", canonicalId: "claude-opus-4-8", label: "Claude Opus 4.8", version: "4.8", source: "claude-code-package", isFallback: false, discoveryKind: "aliases" },
        { value: "sonnet", canonicalId: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", version: "4.6", source: "claude-code-package", isFallback: false, discoveryKind: "aliases" },
        { value: "haiku", canonicalId: "claude-haiku-4-5", label: "Claude Haiku 4.5", version: "4.5", source: "claude-code-package", isFallback: false, discoveryKind: "aliases" },
      ],
    );
    assert.ok(!discovery.models.some((model) => /version unknown/i.test(model.label)));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverModelsFromClaudePackageMetadata: major-only ids like claude-sonnet-5 win over older versioned ids", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-package-metadata-test-"));
  const metadataPath = join(tempRoot, "claude-binary-strings.txt");
  try {
    writeFileSync(
      metadataPath,
      [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
      ].join("\n"),
      "utf-8",
    );

    const discovery = discoverModelsFromClaudePackageMetadata("claude", [metadataPath]);
    assert.ok(discovery, "expected package metadata discovery to succeed");
    const byFamily = new Map(discovery.models.map((model) => [model.family, model]));
    assert.deepEqual(
      { canonicalId: byFamily.get("sonnet")?.canonicalId, version: byFamily.get("sonnet")?.version, label: byFamily.get("sonnet")?.label },
      { canonicalId: "claude-sonnet-5", version: "5", label: "Claude Sonnet 5" },
    );
    assert.equal(byFamily.get("opus")?.canonicalId, "claude-opus-4-8");
    // Date-suffixed ids keep extracting the family-version prefix only.
    assert.equal(byFamily.get("haiku")?.canonicalId, "claude-haiku-4-5");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverModelsFromClaudePackageMetadata: resolves a family from a major-only id alone", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-package-metadata-test-"));
  const metadataPath = join(tempRoot, "claude-binary-strings.txt");
  try {
    writeFileSync(metadataPath, "claude-sonnet-5\n", "utf-8");

    const discovery = discoverModelsFromClaudePackageMetadata("claude", [metadataPath]);
    assert.ok(discovery, "expected package metadata discovery to succeed");
    assert.deepEqual(
      discovery.models.map((model) => [model.value, model.canonicalId, model.label]),
      [["sonnet", "claude-sonnet-5", "Claude Sonnet 5"]],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverClaudeCodeCapabilities: uses package metadata before fallback when command discovery is unavailable", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-package-metadata-test-"));
  const metadataPath = join(tempRoot, "claude-binary-strings.txt");
  try {
    writeFileSync(
      metadataPath,
      "claude-opus-4-8\nclaude-sonnet-4-6\nclaude-haiku-4-5\n",
      "utf-8",
    );

    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      metadataPaths: [metadataPath],
      settingsPath: null,
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        return commandResult({ exitCode: 1 });
      }),
    });

    assert.equal(discovery.modelSource, "claude-code-package");
    assert.deepEqual(discovery.models.map((model) => model.label), [
      "Claude Opus 4.8",
      "Claude Sonnet 4.6",
      "Claude Haiku 4.5",
    ]);
    assert.equal(discovery.diagnostics?.packageMetadataPath, metadataPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverClaudeCodeCapabilities: settings fallback when CLI has no model json, and modelOverrides are parsed", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-discovery-test-"));
  const settingsPath = join(tempRoot, "settings.json");
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        modelOverrides: {
          "custom-override-model": {
            label: "Overridden Label",
            family: "opus",
            effortLevels: ["low", "high"],
            defaultEffort: "high",
          },
        },
      }),
      "utf-8"
    );

    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      settingsPath,
      metadataPaths: [],
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "no model json command here" });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(discovery.modelSource, "settings");
    const overrideModel = discovery.models.find((m) => m.value === "custom-override-model");
    assert.ok(overrideModel);
    assert.equal(overrideModel?.label, "Overridden Label");
    assert.equal(overrideModel?.family, "opus");
    assert.deepEqual(overrideModel?.effortLevels, ["low", "high"]);
    assert.equal(overrideModel?.defaultEffort, "high");
    assert.equal(overrideModel?.source, "settings");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverClaudeCodeCapabilities: settings fallback with availableModels, allowlist filtering, prepending model, and deduplication", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-discovery-test-"));
  const settingsPath = join(tempRoot, "settings.json");
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "claude-3-opus-custom",
        availableModels: ["opus", "sonnet"],
      }),
      "utf-8"
    );

    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      settingsPath,
      metadataPaths: [],
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
        if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "no model json command here" });
        return commandResult({ exitCode: 0 });
      }),
    });

    assert.equal(discovery.modelSource, "settings");

    // "claude-3-opus-custom" should be prepended without replacing it with a generic alias.
    assert.equal(discovery.models[0]?.value, "claude-3-opus-custom");
    assert.equal(discovery.models[0]?.source, "settings");
    assert.equal(discovery.models[1]?.value, "opus");
    assert.equal(discovery.models[2]?.value, "sonnet");

    // The availableModels allowlist filters out others (like fallback haiku), keeping the prepended one plus allowed aliases.
    assert.equal(discovery.models.length, 3);

    // Verify raw model IDs are preserved instead of collapsed into family aliases.
    const values = discovery.models.map((m) => m.value);
    assert.deepEqual(values, ["claude-3-opus-custom", "opus", "sonnet"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverClaudeCodeCapabilities: complete fallback when CLI fails and no settings", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-discovery-test-"));
  const settingsPath = join(tempRoot, "settings.json"); // Non-existent settings.json since we don't write it.

  try {
    const discovery = await discoverClaudeCodeCapabilities({
      cwd: process.cwd(),
      settingsPath,
      metadataPaths: [],
      runCommandImpl: mockRunCommand((executable, args) => {
        if (args[0] === "auth") return commandResult({ exitCode: 1, stdout: "" });
        if (args[0] === "--help") return commandResult({ exitCode: 1, stdout: "" });
        return commandResult({ exitCode: 1 });
      }),
    });

    assert.equal(discovery.modelSource, "fallback");
    assert.equal(discovery.models.length, ANTHROPIC_FALLBACK_MODELS.length);
    assert.equal(discovery.models[0].value, ANTHROPIC_FALLBACK_MODELS[0].modelId);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: direct-probe discovery — the root cause of ubume-dev showing
// hardcoded fallback models. The Claude Code CLI (v2.x) does not mention
// "model list --json" in its help text, so the old help-text-gated approach
// never generated any probe candidates and always fell through to fallback.
// The fix probes model-list commands directly before checking help text.
// ---------------------------------------------------------------------------

test("direct-probe regression: discovery succeeds when help text has NO matching pattern", async () => {
  // Simulate Claude Code CLI that supports 'model list --json' but whose help text
  // does NOT contain "model list" + "--json" together (the old regex would produce 0 candidates).
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      // Help text deliberately contains NO matching "model list --json" substring.
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "Usage: claude [options]\n  --model <m>  Set model\n" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "Usage: claude model\n  list  List models\n" });
      // But the direct probe for 'model list --json' succeeds.
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({ exitCode: 0, stdout: JSON.stringify({
          models: [
            { value: "claude-opus-4-8", label: "Claude Opus 4.8", family: "opus", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "xhigh" },
            { value: "claude-sonnet-4-7", label: "Claude Sonnet 4.7", family: "sonnet", effortLevels: ["low", "medium", "high", "max"], defaultEffort: "high" },
          ],
        }) });
      }
      return commandResult({ exitCode: 1 }); // everything else fails
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command", "Must discover via direct probe, not fall back");
  assert.equal(discovery.models.length, 2);
  assert.equal(discovery.models[0]?.source, "claude-code-command");
  // Must NOT contain any fallback model aliases
  assert.ok(!discovery.models.some((m) => m.value === "opus" || m.value === "sonnet" || m.value === "haiku"),
    "Direct-probe results must not be replaced by static fallback aliases");
});

test("direct-probe regression: normalises model objects using 'name' field when 'value'/'id' absent", async () => {
  const discovery = await discoverClaudeCodeCapabilities({
    cwd: process.cwd(),
    settingsPath: null,
    runCommandImpl: mockRunCommand((executable, args) => {
      if (args[0] === "auth") return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) });
      if (args[0] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
      if (args[0] === "model" && args[1] === "--help") return commandResult({ exitCode: 0, stdout: "model list --json" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        // CLI returns objects using 'name' rather than 'value'/'id'
        return commandResult({ exitCode: 0, stdout: JSON.stringify([
          { name: "claude-sonnet-4-7", label: "Claude Sonnet 4.7", family: "sonnet" },
        ]) });
      }
      return commandResult({ exitCode: 1 });
    }),
  });

  assert.equal(discovery.modelSource, "claude-code-command");
  assert.equal(discovery.models.length, 1);
  // 'name' field should be used as the model value
  assert.equal(discovery.models[0]?.value, "claude-sonnet-4-7");
  assert.equal(discovery.models[0]?.label, "Claude Sonnet 4.7");
});

test("ANTHROPIC_FALLBACK_MODELS labels contain no version-specific numbers", () => {
  for (const model of ANTHROPIC_FALLBACK_MODELS) {
    assert.ok(
      !/\d+\.\d+/.test(model.label),
      `Fallback label "${model.label}" must not contain a version number — use generic names so the label stays accurate as Claude Code updates`,
    );
  }
});

test("ANTHROPIC_FALLBACK_MODELS offers the Fable flagship first with the full effort range", () => {
  const fable = ANTHROPIC_FALLBACK_MODELS[0];
  assert.equal(fable?.modelId, "fable");
  assert.equal(fable?.family, "fable");
  assert.equal(fable?.defaultReasoningLevel, "xhigh");
  assert.deepEqual(fable?.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);
});

test("ANTHROPIC_FALLBACK_MODELS uses short aliases as modelId, not versioned canonical IDs", () => {
  const validAliases = new Set(["fable", "opus", "sonnet", "haiku"]);
  for (const model of ANTHROPIC_FALLBACK_MODELS) {
    assert.ok(
      validAliases.has(model.modelId),
      `Fallback modelId "${model.modelId}" should be a short alias accepted by Claude Code CLI`,
    );
    assert.ok(
      model.canonicalId === undefined || validAliases.has(model.canonicalId),
      `Fallback canonicalId "${model.canonicalId}" must not pin a stale Claude version`,
    );
  }
});

test("ANTHROPIC_FALLBACK_MODELS uses the full last-known Claude CLI effort ladder", () => {
  for (const model of ANTHROPIC_FALLBACK_MODELS) {
    assert.deepEqual(model.supportedReasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(model.effortVerified, false);
  }
});
