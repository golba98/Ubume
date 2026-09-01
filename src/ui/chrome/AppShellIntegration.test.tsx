import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { AppShell } from "./AppShell.js";
import { ProviderPicker } from "../panels/ProviderPicker.js";
import { createTerminalViewport } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { HEADER_CONFIG_DEFAULTS } from "../../config/settings.js";
import { buildRuntimeSummary } from "../../config/runtimeConfig.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { BottomComposer } from "./BottomComposer.js";
import { UpdatePromptPanel, type RunUpdateFn } from "../panels/UpdatePromptPanel.js";
import type { CommandResult } from "../../core/process/CommandRunner.js";

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
  ref() { return this; }
  unref() { return this; }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 100;
  rows = 21;
}

const mockProviders = [
  { id: "openai", displayName: "OpenAI", routeMode: "provider-direct", backendType: "openai", isActiveRoute: true, enabled: true, currentModel: "gpt-4", statusLabel: "Active" },
  { id: "anthropic", displayName: "Anthropic", routeMode: "provider-direct", backendType: "anthropic", isActiveRoute: false, enabled: true, currentModel: "claude-3", statusLabel: "Ready" },
  { id: "mistral", displayName: "Mistral Vibe CLI", routeMode: "in-codexa", backendType: "mistral-vibe-cli-auth", isActiveRoute: false, enabled: true, currentModel: "mistral-medium-3.5", statusLabel: "Enabled" },
  { id: "local", displayName: "Local", routeMode: "provider-direct", backendType: "local", isActiveRoute: false, enabled: true, currentModel: "llama-3", statusLabel: "Ready" },
  { id: "antigravity", displayName: "Antigravity", routeMode: "provider-direct", backendType: "antigravity", isActiveRoute: false, enabled: true, currentModel: "AG-1", statusLabel: "Ready" }
];

function makePendingUpdateResult(): Promise<CommandResult> {
  return new Promise(() => {});
}

test("AppShell renders ProviderPicker with all 5 providers at normal standard size", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createTerminalViewport(100, 21);
  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="provider-picker"
        authState="authenticated"
        workspaceLabel="test"
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={[]}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={
          <ProviderPicker
            layout={layout}
            providers={mockProviders as any}
            onAction={() => {}}
            onCancel={() => {}}
          />
        }
        composer={
          <BottomComposer
            layout={layout}
            uiState={{ kind: "IDLE" }}
            mode="auto-edit"
            model="gpt-5.4"
            themeName="purple"
            reasoningLevel="medium"
            tokensUsed={1200}
            value=""
            cursor={0}
            onChangeInput={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onChangeValue={() => {}}
            onChangeCursor={() => {}}
            onHistoryUp={() => {}}
            onHistoryDown={() => {}}
            onOpenBackendPicker={() => {}}
            onOpenModelPicker={() => {}}
            onOpenModePicker={() => {}}
            onOpenThemePicker={() => {}}
            onOpenAuthPanel={() => {}}
            onTogglePlanMode={() => {}}
            onClear={() => {}}
            onCycleMode={() => {}}
            onQuit={() => {}}
          />
        }
        composerRows={4}
        headerConfig={HEADER_CONFIG_DEFAULTS}
      />
    </ThemeProvider>,
    {
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: stdout as any,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );

  // Wait a bit
  await new Promise(r => setTimeout(r, 100));
  instance.cleanup();

  const stripped = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");

  // Assert all five providers are visible:
  assert.ok(stripped.includes("OpenAI"), "Missing OpenAI");
  assert.ok(stripped.includes("Anthropic"), "Missing Anthropic");
  assert.ok(stripped.includes("Mistral Vibe"), "Missing Mistral Vibe CLI");
  assert.ok(stripped.includes("Local"), "Missing Local");
  assert.ok(stripped.includes("Antigravity"), "Missing Antigravity");

  // Assert the broken state is impossible:
  const hasOpenAI = stripped.includes("OpenAI");
  const hasAnthropic = stripped.includes("Anthropic");
  const hasAntigravity = stripped.includes("Antigravity");
  const hasMistral = stripped.includes("Mistral Vibe");
  const hasLocal = stripped.includes("Local");
  const finalRuntimeIndex = stripped.lastIndexOf("gpt-5.4 (medium)");
  assert.ok(finalRuntimeIndex >= 0, "ProviderPicker shell should render runtime metadata");
  const finalBottomChrome = stripped.slice(Math.max(0, finalRuntimeIndex - 80));
  assert.equal(finalBottomChrome.match(/Context:/g)?.length ?? 0, 1, "ProviderPicker shell should render one context row");
  assert.equal(finalBottomChrome.match(/gpt-5\.4 \(medium\)/g)?.length ?? 0, 1, "ProviderPicker shell should render one runtime row");

  assert.equal(
    hasOpenAI && hasAnthropic && hasAntigravity && (!hasMistral || !hasLocal),
    false,
    "Broken state (missing Mistral Vibe or Local while rendering others) detected!"
  );
});

test("canceling an install leaves the complete updater shell visible", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let output = "";
  let cancelCalls = 0;
  let skipCalls = 0;
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const layout = createTerminalViewport(120, 40);
  const runUpdate: RunUpdateFn = () => ({
    result: makePendingUpdateResult(),
    cancel: () => { cancelCalls += 1; },
  });
  const composer = (
    <BottomComposer
      layout={layout}
      uiState={{ kind: "IDLE" }}
      mode="auto-edit"
      model="gpt-5.4"
      themeName="purple"
      reasoningLevel="medium"
      tokensUsed={1200}
      value=""
      cursor={0}
      onChangeInput={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      onChangeValue={() => {}}
      onChangeCursor={() => {}}
      onHistoryUp={() => {}}
      onHistoryDown={() => {}}
      onOpenBackendPicker={() => {}}
      onOpenModelPicker={() => {}}
      onOpenModePicker={() => {}}
      onOpenThemePicker={() => {}}
      onOpenAuthPanel={() => {}}
      onTogglePlanMode={() => {}}
      onClear={() => {}}
      onCycleMode={() => {}}
      onQuit={() => {}}
    />
  );

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="update-prompt"
        authState="authenticated"
        workspaceLabel="13-Codexa CLI"
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={[]}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={
          <UpdatePromptPanel
            focusId="update-prompt-integration"
            currentVersion="1.0.19"
            latestVersion="1.0.20"
            packageManager="npm"
            runUpdate={runUpdate}
            onSkip={() => { skipCalls += 1; }}
            onRestart={() => {}}
          />
        }
        composer={composer}
        composerRows={4}
        headerConfig={HEADER_CONFIG_DEFAULTS}
      />
    </ThemeProvider>,
    {
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: stdout as any,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const beforeCancel = output.length;
  stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 180));

  const postCancel = output.slice(beforeCancel).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(cancelCalls, 1);
  assert.equal(skipCalls, 0);
  assert.match(postCancel, /Codexa v/);
  assert.match(postCancel, /13-Codexa CLI/);
  assert.match(postCancel, /Update available: Codexa 1\.0\.20/);
  assert.match(postCancel, /Current version: 1\.0\.19/);
  assert.match(postCancel, /│ ❯/);
  assert.match(postCancel, /gpt-5\.4 \(medium\)/);
  assert.match(postCancel, /Context:/);
  assert.doesNotMatch(postCancel.slice(postCancel.lastIndexOf("Update available")), /Installing Codexa/);

  instance.cleanup();
});
