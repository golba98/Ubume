import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeRuntimeIntoTomlConfig } from "./layeredConfig.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtimeConfig.js";
import {
  extractLegacyRuntime,
  getDefaultSettings,
  parseSettingsData,
  serializeSettings,
  saveRuntimeModePreference,
} from "./persistence.js";
import { parseTomlDocument } from "./layeredConfig.js";

test("extracts legacy flat runtime settings for migration", () => {
  const runtime = extractLegacyRuntime({
    backend: "codex-subprocess",
    model: "gpt-5.4-mini",
    mode: "suggest",
    reasoning_level: "medium",
  });

  assert.equal(runtime?.model, "gpt-5.4-mini");
  assert.equal(runtime?.mode, "suggest");
  assert.equal(runtime?.reasoningLevel, "medium");
});

test("keeps UI and auth settings separate from runtime persistence", () => {
  const initial = {
    ui: {
      layoutStyle: "gemini-shell",
      theme: "purple",
      workspaceDisplayMode: "simple" as const,
      terminalTitleMode: "name" as const,
      showBusyLoader: false,
      customTheme: { text: "#fff" },
    },
    auth: {
      preference: "runner-managed" as const,
    },
    header: {
      showBrand: true,
      showWorkspace: true,
      showProvider: true,
      showModel: true,
      showReasoning: false,
      showContext: false,
      showAuthStatus: false,
    },
    updateCheck: {
      enabled: true,
      intervalHours: 6,
    },
  };

  const serialized = serializeSettings(initial);
  const parsed = parseSettingsData(serialized);

  assert.equal("runtime" in serialized, false);
  assert.equal(parsed.ui.theme, "purple");
  assert.equal(parsed.ui.workspaceDisplayMode, "simple");
  assert.equal(parsed.ui.terminalTitleMode, "name");
  assert.equal(parsed.ui.showBusyLoader, false);
  assert.equal(parsed.auth.preference, "runner-managed");
});

test("falls back to defaults for missing UI or auth preferences", () => {
  const parsed = parseSettingsData({});
  const defaults = getDefaultSettings();

  assert.equal(parsed.ui.layoutStyle, defaults.ui.layoutStyle);
  assert.equal(parsed.ui.theme, defaults.ui.theme);
  assert.equal(parsed.ui.workspaceDisplayMode, defaults.ui.workspaceDisplayMode);
  assert.equal(parsed.ui.terminalTitleMode, defaults.ui.terminalTitleMode);
  assert.equal(parsed.ui.showBusyLoader, defaults.ui.showBusyLoader);
  assert.equal(parsed.auth.preference, defaults.auth.preference);
});

test("maps legacy directory display settings into workspace display mode", () => {
  assert.equal(parseSettingsData({ directory_display_mode: "normal" }).ui.workspaceDisplayMode, "dir");
  assert.equal(parseSettingsData({ directoryDisplayMode: "simple" }).ui.workspaceDisplayMode, "simple");
});

test("parses workspace display and busy loader from camel and snake case", () => {
  assert.equal(parseSettingsData({ workspace_display_mode: "name", terminal_title_mode: "simple", show_busy_loader: false }).ui.workspaceDisplayMode, "name");
  assert.equal(parseSettingsData({ workspaceDisplayMode: "dir", terminalTitleMode: "name", showBusyLoader: true }).ui.showBusyLoader, true);
  assert.equal(parseSettingsData({ terminalTitleMode: "name" }).ui.terminalTitleMode, "name");
});

test("merges legacy runtime fields into TOML without overwriting existing values", () => {
  const merged = mergeRuntimeIntoTomlConfig({
    model: "gpt-5.4",
    codexa: {
      mode: "suggest",
    },
  }, {
    ...DEFAULT_RUNTIME_CONFIG,
    model: "gpt-5.4-mini",
    mode: "full-auto",
    policy: {
      ...DEFAULT_RUNTIME_CONFIG.policy,
      networkAccess: "enabled",
      writableRoots: ["C:\\safe"],
      personality: "pragmatic",
    },
  });

  assert.equal(merged.model, "gpt-5.4");
  assert.deepEqual(merged.codexa, { mode: "suggest" });
  assert.deepEqual(merged.sandbox_workspace_write, {
    network_access: true,
    writable_roots: ["C:\\safe"],
  });
  assert.equal(merged.personality, "pragmatic");
});

test("persists Auto and Plan choices while preserving unrelated Codex config", () => {
  const root = mkdtempSync(join(tmpdir(), "codexa-mode-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    writeFileSync(join(root, "config.toml"), "model = \"kept-model\"\n[codexa]\nbackend = \"openai-native\"\n", "utf-8");
    saveRuntimeModePreference("auto-edit", false);
    let parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.equal(parsed.model, "kept-model");
    assert.deepEqual(parsed.codexa, { backend: "openai-native", mode: "auto-edit", plan_mode: false });

    saveRuntimeModePreference("auto-edit", true);
    parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.equal((parsed.codexa as Record<string, unknown>).plan_mode, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime mode persistence failures do not escape into the TUI", () => {
  const root = mkdtempSync(join(tmpdir(), "codexa-mode-failure-"));
  const previous = process.env.CODEX_HOME;
  const blockedHome = join(root, "not-a-directory");
  writeFileSync(blockedHome, "blocked", "utf-8");
  process.env.CODEX_HOME = blockedHome;
  try {
    assert.doesNotThrow(() => saveRuntimeModePreference("full-auto", false));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
