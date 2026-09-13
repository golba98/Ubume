import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import { normalizeCodexModelListResponses, type CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import { ThemeProvider } from "../theme.js";
import { ModelPickerScreen } from "./ModelPickerScreen.js";
import { ReasoningPicker } from "./ReasoningPicker.js";
import { createLayoutSnapshot } from "../layout.js";
import { CLAUDE_CODE_EFFORT_LEVELS } from "../../core/providerRuntime/reasoning.js";

class TestInput extends PassThrough {
  readonly isTTY = true;

  setRawMode(): this {
    return this;
  }

  override resume(): this {
    return this;
  }

  override pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
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

function getLastModelPickerFrame(output: string): string {
  const lastTitle = output.lastIndexOf("Select model");
  return lastTitle >= 0 ? output.slice(lastTitle) : output;
}

function createInkHarness(node: React.ReactElement, columns = 120, rows = 40) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    getOutput(): string {
      return stripAnsi(output);
    },
    async cleanup() {
      instance.cleanup();
      await sleep(20);
    },
  };
}

function testModels(): readonly CodexModelCapability[] {
  return normalizeCodexModelListResponses([
    {
      data: [
        {
          id: "model-four",
          model: "model-four",
          displayName: "Model Four",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "xhigh", description: "Extra" },
          ],
        },
        {
          id: "model-two",
          model: "model-two",
          displayName: "Model Two",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
        },
      ],
    },
  ]).models;
}

function DelayedModelPickerHarness() {
  const [models, setModels] = React.useState<readonly CodexModelCapability[]>([]);
  const [closed, setClosed] = React.useState(false);
  const [cancelCount, setCancelCount] = React.useState(0);
  const [selected, setSelected] = React.useState("none");

  React.useEffect(() => {
    const timer = setTimeout(() => setModels(testModels()), 80);
    return () => clearTimeout(timer);
  }, []);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        {closed ? null : (
          <ModelPickerScreen
            layout={createLayoutSnapshot(120, 40)}
            models={models}
            currentModel="model-four"
            currentReasoning="medium"
            isLoading={models.length === 0}
            onSelect={(model, reasoning) => {
              setSelected(`${model}:${reasoning}`);
              setClosed(true);
            }}
            onCancel={() => {
              setCancelCount((count) => count + 1);
              setClosed(true);
            }}
          />
        )}
        <Text>{`closed:${closed ? "yes" : "no"}`}</Text>
        <Text>{`cancel:${cancelCount}`}</Text>
        <Text>{`selected:${selected}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

test("model picker renders a compact command panel", async () => {
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={testModels()}
        currentModel="model-four"
        currentReasoning="medium"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Select model/);
    assert.match(output, /↑↓ model · ←→ reasoning · Enter select · Esc cancel/);
    assert.match(output, /Choose an OpenAI model to use inside Ubume/);
    assert.match(output, /Reasoning: Medium/);
    assert.match(output, /Model Four \(model-four\)/);
    assert.match(output, /Model Two/);
    const frame = getLastModelPickerFrame(output);
    assert.match(frame, />\s+Model Four \(model-four\)/);
    assert.match(frame, /Intelligence\s+Low.*Medium/);
    assert.match(frame, /\s+Model Two/);
    assert.doesNotMatch(frame, /Model Two \(model-two\).*\[/);
    assert.doesNotMatch(frame, /■/);
    assert.match(output, /✓/);
  } finally {
    await harness.cleanup();
  }
});

test("model picker supports model movement and reasoning adjustment", async () => {
  let selected = "";
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={testModels()}
        currentModel="model-four"
        currentReasoning="medium"
        onSelect={(model, reasoning) => {
          selected = `${model}:${reasoning}`;
        }}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    harness.stdin.write("j");
    await sleep(40);
    harness.stdin.write("k");
    await sleep(40);
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("l");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    assert.equal(selected, "model-two:high");
    const frame = getLastModelPickerFrame(harness.getOutput());
    assert.match(frame, /Reasoning: High/);
    assert.match(frame, />\s+Model Two/);
    assert.match(frame, /Intelligence\s+Medium.*High\s+High/);
    assert.doesNotMatch(frame, /Model Four \(model-four\).*\[/);
  } finally {
    await harness.cleanup();
  }
});

test("Antigravity collapses Gemini effort variants into one model with an intelligence slider", async () => {
  const models = normalizeCodexModelListResponses([
    {
      data: [
        { id: "gemini-3.7-flash-high", model: "gemini-3.7-flash-high", displayName: "Gemini 3.7 Flash (High)", hidden: false },
        { id: "gemini-3.7-flash-medium", model: "gemini-3.7-flash-medium", displayName: "Gemini 3.7 Flash (Medium)", hidden: false },
        { id: "gemini-3.7-flash-low", model: "gemini-3.7-flash-low", displayName: "Gemini 3.7 Flash (Low)", hidden: false },
      ],
    },
  ]).models;
  let selected = "";
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 30)}
        models={models}
        currentModel="gemini-3.7-flash-high"
        currentReasoning="high"
        activeProviderLabel="Antigravity"
        onSelect={(model, reasoning) => { selected = `${model}:${reasoning}`; }}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Gemini 3\.7 Flash/);
    assert.match(output, /Intelligence\s+Low.*High/);
    assert.doesNotMatch(output, /Gemini 3\.7 Flash \(Medium\)/);
    assert.doesNotMatch(output, /gemini-3\.7-flash-medium/);
    harness.stdin.write("h");
    await sleep(40);
    harness.stdin.write("h");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    assert.equal(selected, "gemini-3.7-flash-low:low");
  } finally {
    await harness.cleanup();
  }
});

test("Antigravity native Claude and GPT-OSS models do not show an intelligence control", async () => {
  const models = normalizeCodexModelListResponses([{
    data: [
      { id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", hidden: false },
      { id: "claude-opus-4-6-thinking", model: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)", hidden: false },
      { id: "gpt-oss-120b-medium", model: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", hidden: false },
    ],
  }]).models;
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 30)}
        models={models}
        currentModel="claude-sonnet-4-6"
        currentReasoning="medium"
        activeProviderLabel="Antigravity"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const frame = getLastModelPickerFrame(harness.getOutput());
    assert.match(frame, /Claude Sonnet 4\.6/);
    assert.match(frame, /Claude Opus 4\.6/);
    assert.match(frame, /GPT-OSS 120B/);
    assert.doesNotMatch(frame, /Intelligence/);
  } finally {
    await harness.cleanup();
  }
});

test("model picker loading state stays in the command panel and escape cancels", async () => {
  let cancelled = false;
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="model-four"
        currentReasoning="medium"
        isLoading
        onSelect={() => {}}
        onCancel={() => {
          cancelled = true;
        }}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Select model/);
    assert.match(output, /Discovering models from the Codex runtime/);
    harness.stdin.write("\u001b");
    await sleep(80);
    assert.equal(cancelled, true);
  } finally {
    await harness.cleanup();
  }
});

test("model picker keeps escape active after loading swaps to interactive models", async () => {
  const harness = createInkHarness(<DelayedModelPickerHarness />);

  try {
    await sleep(180);
    harness.stdin.write("\u001b");
    await sleep(100);

    const output = harness.getOutput();
    assert.match(output, /Discovering models from the Codex runtime/);
    assert.match(output, /Model Four \(model-four\)/);
    assert.match(output, /closed:yes/);
    assert.match(output, /cancel:1/);
  } finally {
    await harness.cleanup();
  }
});

test("model picker keeps enter selection active after loading swaps to interactive models", async () => {
  const harness = createInkHarness(<DelayedModelPickerHarness />);

  try {
    await sleep(180);
    harness.stdin.write("\r");
    await sleep(100);

    const output = harness.getOutput();
    assert.match(output, /Discovering models from the Codex runtime/);
    assert.match(output, /Model Four \(model-four\)/);
    assert.match(output, /closed:yes/);
    assert.match(output, /selected:model-four:medium/);
  } finally {
    await harness.cleanup();
  }
});

test("model picker truncates long model labels on narrow terminals", async () => {
  const longModel = normalizeCodexModelListResponses([
    {
      data: [
        {
          id: "extremely-long-model-name-with-extra-segments",
          model: "extremely-long-model-name-with-extra-segments",
          displayName: "Extremely Long Display Name That Must Not Merge Into Metadata",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
        },
      ],
    },
  ]).models;
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(44, 18)}
        models={longModel}
        currentModel={longModel[0]!.model}
        currentReasoning="medium"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    44,
    18,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Select model/);
    assert.match(output, /…/);
    assert.match(output, /Reasoning: Medium/);
    assert.doesNotMatch(output, /\[Medium\]/);
    assert.doesNotMatch(output, /Metadata/);
  } finally {
    await harness.cleanup();
  }
});

test("model picker disables reasoning for models without advertised levels", async () => {
  const noReasoningModel = normalizeCodexModelListResponses([
    {
      data: [
        {
          id: "plain-model",
          model: "plain-model",
          displayName: "Plain Model",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
    },
  ]).models;
  let selected = "";
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(80, 24)}
        models={noReasoningModel}
        currentModel="plain-model"
        currentReasoning="medium"
        onSelect={(model, reasoning) => {
          selected = `${model}:${reasoning}`;
        }}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    harness.stdin.write("l");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /Reasoning: unavailable/);
    assert.equal(selected, "plain-model:medium");
  } finally {
    await harness.cleanup();
  }
});

test("reasoning picker renders only detected levels for the selected model", async () => {
  const modelTwo = testModels()[1]!;
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ReasoningPicker
        currentModel={modelTwo.model}
        currentReasoning="medium"
        reasoningLevels={modelTwo.supportedReasoningLevels ?? []}
        defaultReasoning={modelTwo.defaultReasoningLevel}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Medium/);
    assert.match(output, /High/);
    assert.doesNotMatch(output, /Extra high/);
    assert.doesNotMatch(output, /\bLow\b/);
  } finally {
    await harness.cleanup();
  }
});

test("reasoning picker renders Claude effort levels without OpenAI-only levels", async () => {
  const harness = createInkHarness(
    <ThemeProvider theme="purple">
      <ReasoningPicker
        currentModel="sonnet"
        currentReasoning="medium"
        reasoningLevels={CLAUDE_CODE_EFFORT_LEVELS}
        defaultReasoning="medium"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
  );

  try {
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /Low/);
    assert.match(output, /Medium/);
    assert.match(output, /High/);
    assert.match(output, /XHigh/);
    assert.match(output, /Max/);
    assert.doesNotMatch(output, /Minimal/);
    assert.doesNotMatch(output, /\bNone\b/);
    assert.doesNotMatch(output, /Extra high/);
  } finally {
    await harness.cleanup();
  }
});
