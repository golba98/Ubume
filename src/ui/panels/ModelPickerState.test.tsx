import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { useEffect, useState } from "react";
import { render } from "ink";
import { ThemeProvider } from "../theme.js";
import { ModelPickerScreen } from "./ModelPickerScreen.js";
import { createLayoutSnapshot } from "../layout.js";
import { normalizeCodexModelListResponses, type CodexModelCapability } from "../../core/models/codexModelCapabilities.js";

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
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function UncachedProviderPickerFlow(): React.ReactElement {
  const [pickerOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<readonly CodexModelCapability[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setModels(normalizeCodexModelListResponses([{
        data: [{
          id: "mistral-large-latest",
          model: "mistral-large-latest",
          displayName: "Mistral Large Latest",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
        }],
      }]).models);
      setLoading(false);
    }, 30);
    return () => clearTimeout(timer);
  }, []);

  if (!pickerOpen) return <></>;

  return (
    <ModelPickerScreen
      layout={createLayoutSnapshot(120, 40)}
      models={models}
      currentModel="mistral-large-latest"
      currentReasoning="medium"
      activeProviderLabel="Mistral"
      isLoading={loading}
      onSelect={() => {}}
      onCancel={() => {}}
    />
  );
}

test("model picker displays grammar-correct selection message for OpenAI", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const { cleanup } = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-4o"
        currentReasoning="medium"
        activeProviderLabel="OpenAI"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true }
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Choose an OpenAI model to use inside Ubume/);
  } finally {
    cleanup();
  }
});

test("model picker displays grammar-correct selection message for Google", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const { cleanup } = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-4o"
        currentReasoning="medium"
        activeProviderLabel="Google"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true }
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Choose a Google model to use inside Ubume/);
  } finally {
    cleanup();
  }
});

test("model picker displays reasoning: current/default when models are empty", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const { cleanup } = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-4o"
        currentReasoning="medium"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true }
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Reasoning: current\/default/);
    assert.match(stripped, /No models available/);
  } finally {
    cleanup();
  }
});

test("model picker displays emptyMessage when provided", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const { cleanup } = render(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-4o"
        currentReasoning="medium"
        emptyMessage="Custom empty message"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true }
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Custom empty message/);
  } finally {
    cleanup();
  }
});

test("uncached provider discovery populates the open picker in place", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const { cleanup } = render(
    <ThemeProvider theme="purple">
      <UncachedProviderPickerFlow />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Mistral Large Latest/);
    assert.doesNotMatch(stripped, /No models available/);
  } finally {
    cleanup();
  }
});
