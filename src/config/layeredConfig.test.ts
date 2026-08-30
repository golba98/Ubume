import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";

function writeText(filePath: string, contents: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, contents, "utf-8");
}

test("resolves user config, trusted project config, profiles, and CLI overrides deterministically", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "codexa-layered-config-"));
  const tempHome = join(tempRoot, "home");
  const workspaceRoot = join(tempRoot, "repo", "packages", "app");
  const projectRoot = join(tempRoot, "repo");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".codex"), { recursive: true });
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    mkdirSync(tempHome, { recursive: true });

    writeFileSync(join(tempHome, "config.toml"), [
      "model = \"gpt-5.2\"",
      "[codexa]",
      "backend = \"openai-native\"",
      "",
      "[profiles.review]",
      "service_tier = \"fast\"",
    ].join("\n"), "utf-8");

    writeFileSync(join(projectRoot, ".codex", "config.toml"), [
      "model = \"gpt-5.4\"",
      "profile = \"review\"",
      "[codexa]",
      "mode = \"suggest\"",
      "plan_mode = true",
      "",
      "[profiles.review]",
      "approval_policy = \"never\"",
      "",
      "[profiles.review.sandbox_workspace_write]",
      "network_access = true",
      "writable_roots = [\"./roots/project\"]",
    ].join("\n"), "utf-8");

    writeFileSync(join(workspaceRoot, ".codex", "config.toml"), [
      "personality = \"pragmatic\"",
      "",
      "[profiles.review]",
      "model_reasoning_effort = \"high\"",
    ].join("\n"), "utf-8");

    const trustStore = await import(`./trustStore.js?layered-trust=${Date.now()}`);
    trustStore.setProjectTrust(projectRoot, true);

    const layeredConfig = await import(`./layeredConfig.js?layered=${Date.now()}`);
    const result = layeredConfig.resolveLayeredConfig({
      workspaceRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: [
          "model=\"gpt-5.4-mini\"",
          "codexa.mode=\"full-auto\"",
          "mcp.enabled=true",
        ],
        passthroughArgs: [],
        modelOverride: "gpt-5.4-mini",
      },
    });

    assert.equal(result.runtime.provider, "openai-native");
    assert.equal(result.runtime.model, "gpt-5.4-mini");
    assert.equal(result.runtime.reasoningLevel, "high");
    assert.equal(result.runtime.mode, "full-auto");
    assert.equal(result.runtime.planMode, true);
    assert.equal(result.runtime.policy.approvalPolicy, "never");
    assert.equal(result.runtime.policy.networkAccess, "enabled");
    assert.equal(result.runtime.policy.serviceTier, "fast");
    assert.equal(result.runtime.policy.personality, "pragmatic");
    assert.equal(result.diagnostics.selectedProfile, "review");
    assert.equal(result.diagnostics.selectedProfileSource, "Project config");
    assert.equal(result.diagnostics.projectTrusted, true);
    assert.match(result.runtime.policy.writableRoots[0] ?? "", /roots[\\/]project/i);
    assert.match(result.diagnostics.fieldSources.model, /CLI override/i);
    assert.match(result.diagnostics.fieldSources["policy.approvalPolicy"], /Profile review from Project config/i);
    assert.ok(result.diagnostics.ignoredEntries.some((entry: string) => /mcp\.enabled/i.test(entry)));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("blocks project config when the detected project root is untrusted", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "codexa-layered-untrusted-"));
  const tempHome = join(tempRoot, "home");
  const workspaceRoot = join(tempRoot, "repo", "app");
  const projectRoot = join(tempRoot, "repo");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    mkdirSync(tempHome, { recursive: true });

    writeFileSync(join(tempHome, "config.toml"), "model = \"gpt-5.2\"\n", "utf-8");
    writeFileSync(join(projectRoot, ".codex", "config.toml"), "model = \"gpt-5.4-mini\"\n", "utf-8");

    const layeredConfig = await import(`./layeredConfig.js?untrusted=${Date.now()}`);
    const result = layeredConfig.resolveLayeredConfig({
      workspaceRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: [],
        passthroughArgs: [],
        modelOverride: null,
      },
    });

    assert.equal(result.runtime.model, "gpt-5.2");
    assert.equal(result.diagnostics.projectTrusted, false);
    assert.ok(result.diagnostics.layers.some((layer: { status: string }) => layer.status === "blocked"));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
