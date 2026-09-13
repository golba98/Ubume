import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import { createLayoutSnapshot } from "../layout.js";
import { ModelPickerScreen } from "./ModelPickerScreen.js";
import { ThemeProvider } from "../theme.js";

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this { return this; }
  override resume(): this { return this; }
  override pause(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureConsoleMessages() {
  const messages: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = ((...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  }) as typeof console.error;
  console.warn = ((...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  }) as typeof console.warn;

  return {
    messages,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

function assertNoAvailableRowsFragmentWarning(messages: readonly string[]) {
  assert.equal(
    messages.some((message) => message.includes("Invalid prop `availableRows` supplied to `React.Fragment`")),
    false,
  );
}

async function renderModelPicker(props: Partial<Parameters<typeof ModelPickerScreen>[0]> = {}): Promise<string> {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const instance = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-5.4"
        currentReasoning="medium"
        activeProviderLabel="OpenAI"
        onSelect={() => {}}
        onCancel={() => {}}
        {...props}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await sleep(60);
  instance.cleanup();
  await sleep(20);
  return stripAnsi(output);
}

test("model picker loading state names the active provider", async () => {
  const output = await renderModelPicker({ activeProviderLabel: "Antigravity", isLoading: true });
  assert.match(output, /Discovering models from Antigravity\.\.\./);
});

test("model picker loading state keeps Codex runtime copy for OpenAI", async () => {
  const output = await renderModelPicker({ isLoading: true });
  assert.match(output, /Discovering models from the Codex runtime\.\.\./);
});

test("model picker shows emptyMessage when not loading", async () => {
  const output = await renderModelPicker({ emptyMessage: "No Antigravity models available." });
  assert.match(output, /No Antigravity models available\./);
  assert.doesNotMatch(output, /Discovering models/);
});

test("model picker shows default routeText when no override provided", async () => {
  const output = await renderModelPicker({ activeProviderLabel: "Google" });
  assert.match(output, /Choose a Google model to use inside Ubume\./);
});

test("model picker shows routeTextOverride when provided", async () => {
  const override = "Model selection is managed by the active provider route.";
  const output = await renderModelPicker({
    activeProviderLabel: "Google",
    routeTextOverride: override,
  });
  assert.match(output, /Model selection is managed by the active provider route\./);
});

test("routeTextOverride suppresses the default Choose copy", async () => {
  const override = "Model selection is managed by the active provider route.";
  const output = await renderModelPicker({
    activeProviderLabel: "Google",
    routeTextOverride: override,
  });
  assert.doesNotMatch(output, /Choose a Google model/);
});

test("default routeText uses 'a' for non-vowel provider labels", async () => {
  const output = await renderModelPicker({ activeProviderLabel: "Google" });
  assert.match(output, /Choose a Google model to use inside Ubume\./);
});

test("default routeText uses 'an' for vowel-starting provider labels", async () => {
  const output = await renderModelPicker({ activeProviderLabel: "OpenAI" });
  assert.match(output, /Choose an OpenAI/);
});

test("ModelPickerScreen width follows layout.contentWidth", async () => {
  const layout = createLayoutSnapshot(180, 40);
  const output = await renderModelPicker({
    layout,
    models: [{ id: "m1", model: "model-1", label: "Model 1", available: true, hidden: false, isDefault: false, defaultReasoningLevel: "", supportedReasoningLevels: null, reasoningLevelCount: null, source: "fallback" }] as any,
  });
  const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const borderLine = cleanOutput.split("\n").find(line => line.includes("╭"));
  assert(borderLine, "Should find top border line");
  assert.equal(borderLine.trim().length, 171);
});

test("small ModelPickerScreen renders without availableRows fragment warnings", async () => {
  const consoleCapture = captureConsoleMessages();
  const models = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  try {
    const output = await renderModelPicker({
      layout: createLayoutSnapshot(80, 15),
      models,
      currentModel: "model-0",
    });
    assert.match(output, /Models · 1\/5/);
    assert.match(output, /Model 0/);
    assertNoAvailableRowsFragmentWarning(consoleCapture.messages);
  } finally {
    consoleCapture.restore();
  }
});

test("ModelPickerScreen does not exceed available vertical rows", async () => {
  const models = Array.from({ length: 15 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  const layout = createLayoutSnapshot(120, 22);
  const output = await renderModelPicker({
    layout,
    models,
    currentModel: "model-0",
  });

  const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const renderedModelsCount = Array.from({ length: 15 }, (_, i) => `Model ${i}`)
    .filter(label => cleanOutput.includes(label))
    .length;

  assert.equal(renderedModelsCount, 7, "Should use every calculated model row at this terminal size");
});

test("ModelPickerScreen at 100x21 shows all small model lists before windowing", async () => {
  const models = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  const output = await renderModelPicker({
    layout: createLayoutSnapshot(100, 21),
    models,
    currentModel: "model-0",
  });

  const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  for (let i = 0; i < 5; i += 1) {
    assert.match(cleanOutput, new RegExp(`Model ${i}`));
  }
  assert.doesNotMatch(cleanOutput, /Models · \d+\/5|Showing|more/);
});

test("ModelPickerScreen with many models keeps selected model visible", async () => {
  const models = Array.from({ length: 15 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  const layout = createLayoutSnapshot(120, 22);
  const output = await renderModelPicker({
    layout,
    models,
    currentModel: "model-10",
  });

  const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(cleanOutput, />\s*Model 10/);
});

test("tiny ModelPickerScreen shows continuous selection position without page copy", async () => {
  const models = Array.from({ length: 15 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  // R = 11 - 7 = 4. bodyBudget = 4 - 3 = 1.
  const layout = createLayoutSnapshot(120, 11);
  const output = await renderModelPicker({
    layout,
    models,
    currentModel: "model-0",
  });

  const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(cleanOutput, /Models · 1\/15/);
  assert.doesNotMatch(cleanOutput, /Showing|↓ .*more/);
});

test("active model is shown in a Current line when outside the visible slice", async () => {
  const models = Array.from({ length: 15 }, (_, i) => ({
    id: `m${i}`,
    model: `model-${i}`,
    label: `Model ${i}`,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: "",
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
  })) as any;

  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 13);
  const instance = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={layout}
        models={models}
        currentModel="model-10"
        currentReasoning="medium"
        activeProviderLabel="OpenAI"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  try {
    await sleep(50);
    // Move up 10 times to go from model-10 to model-0
    for (let i = 0; i < 10; i++) {
      stdin.write("k");
      await sleep(15);
    }

    const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
    assert.match(cleanOutput, /Current: Model 10 \(model-10\)/);
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});
