import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render, useFocus, useFocusManager } from "ink";
import { handleCommand } from "../../commands/handler.js";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { getNextRotatingMode, type AvailableMode, type AvailableModel, type ReasoningLevel } from "../../config/settings.js";
import { createFallbackModelCapabilities, getSelectableModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import { buildProviderRegistry } from "../../core/providerLauncher/registry.js";
import { BottomComposer, isBacktabSequence } from "../chrome/BottomComposer.js";
import { getFocusTargetForScreen } from "./focus.js";
import { ModelPickerScreen } from "../panels/ModelPickerScreen.js";
import { PlanActionPicker } from "../panels/PlanActionPicker.js";
import { ProviderPicker } from "../panels/ProviderPicker.js";
import { createLayoutSnapshot } from "../layout.js";
import { TextEntryPanel } from "../panels/TextEntryPanel.js";
import { ThemeProvider } from "../theme.js";
import { shouldBumpComposerInstance } from "../themeFlow.js";

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

test("recognizes legacy, xterm, Kitty CSI-u, and modifyOtherKeys Shift+Tab", () => {
  for (const sequence of ["\u001b[Z", "\u001b[1;2Z", "\u001b[9;2u", "\u001b[27;2;9~"]) {
    assert.equal(isBacktabSequence(sequence), true, JSON.stringify(sequence));
  }
  assert.equal(isBacktabSequence("\t"), false);
});

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

const TEST_LAYOUT = createLayoutSnapshot(120, 40);
const TEST_MODEL_CAPABILITIES = getSelectableModelCapabilities(createFallbackModelCapabilities());
const TEST_COMMAND_CONTEXT = {
  config: {
    runtime: normalizeRuntimeConfig({
      provider: "codex-subprocess",
      model: "gpt-5.4",
      mode: "suggest",
      reasoningLevel: "high",
    }),
    diagnostics: {
      projectRoot: "C:\\Workspace",
      projectTrusted: false,
      selectedProfile: null,
      selectedProfileSource: null,
      cliOverrides: [],
      layers: [
        { label: "Built-in defaults", status: "loaded" as const },
        { label: "User config", status: "missing" as const, path: "C:\\Users\\Test\\.codex\\config.toml" },
      ],
      ignoredEntries: [],
      fieldSources: {
        provider: "Built-in defaults",
        model: "Built-in defaults",
        reasoningLevel: "Built-in defaults",
        mode: "Built-in defaults",
        planMode: "Built-in defaults",
        geminiCommandPath: "Built-in defaults",
        "policy.approvalPolicy": "Built-in defaults",
        "policy.sandboxMode": "Built-in defaults",
        "policy.networkAccess": "Built-in defaults",
        "policy.writableRoots": "Built-in defaults",
        "policy.serviceTier": "Built-in defaults",
        "policy.personality": "Built-in defaults",
      },
    },
  },
  runtime: normalizeRuntimeConfig({
    provider: "codex-subprocess",
    model: "gpt-5.4",
    mode: "suggest",
    reasoningLevel: "high",
  }),
  resolvedRuntime: resolveRuntimeConfig(
    normalizeRuntimeConfig({
      provider: "codex-subprocess",
      model: "gpt-5.4",
      mode: "suggest",
      reasoningLevel: "high",
    }),
  ),
  settings: {
    workspaceDisplayMode: "dir" as const,
    terminalTitleMode: "dir" as const,
    showBusyLoader: true,
  },
  workspace: {
    root: "C:\\Workspace",
    summaryMessage: [
      "Active workspace:",
      "  C:\\Workspace",
      "",
      "Launch mode: installed codexa",
    ].join("\n"),
  },
  tokensUsed: 1200,
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLastComposerValue(output: string): string | null {
  const lines = output.match(/value:[^\n]*/g) ?? [];
  const lastLine = lines[lines.length - 1];
  if (!lastLine) return null;

  try {
    return JSON.parse(lastLine.slice("value:".length)) as string;
  } catch {
    return null;
  }
}

function createInkHarness(node: React.ReactElement) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
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
    stdout,
    instance,
    getOutput(): string {
      return stripAnsi(output);
    },
    async cleanup() {
      instance.cleanup();
      await sleep(20);
    },
  };
}

function FocusProbe({ id, label }: { id: string; label: string }) {
  const { isFocused } = useFocus({ id, autoFocus: true });
  return <Text>{label}:{isFocused ? "focused" : "blurred"}</Text>;
}

function FocusRoutingHarness({ screen }: { screen: "main" | "model-picker" | "permissions-panel" | "settings-panel" }) {
  const focusManager = useFocusManager();

  React.useEffect(() => {
    focusManager.focus(getFocusTargetForScreen(screen));
  }, [focusManager, screen]);

  return (
    <Box flexDirection="column">
      {screen === "main" && <FocusProbe id="composer" label="composer" />}
      {screen === "model-picker" && <FocusProbe id="model-picker" label="model" />}
      {screen === "permissions-panel" && <FocusProbe id="permissions-panel" label="permissions" />}
      {screen === "settings-panel" && <FocusProbe id="settings-panel" label="settings" />}
    </Box>
  );
}

function ModelPickerComposerHarness() {
  const focusManager = useFocusManager();
  const [screen, setScreen] = React.useState<"main" | "model-picker">("model-picker");
  const [model, setModel] = React.useState<AvailableModel>("gpt-5.4");
  const [reasoningLevel, setReasoningLevel] = React.useState<ReasoningLevel>("high");
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [composerInstanceKey, setComposerInstanceKey] = React.useState(0);
  const previousScreenRef = React.useRef<"main" | "model-picker">("model-picker");

  React.useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  React.useEffect(() => {
    focusManager.focus(getFocusTargetForScreen(screen));
  }, [composerInstanceKey, focusManager, screen]);

  return (
    <ThemeProvider theme="purple">
      {screen === "model-picker" ? (
        <ModelPickerScreen
          layout={TEST_LAYOUT}
          models={TEST_MODEL_CAPABILITIES}
          currentModel={model}
          currentReasoning={reasoningLevel}
          onSelect={(nextModel, nextReasoning) => {
            const resolvedModel = nextModel as AvailableModel;
            setModel(resolvedModel);
            setReasoningLevel(nextReasoning as ReasoningLevel);
            setScreen("main");
          }}
          onCancel={() => setScreen("main")}
        />
      ) : (
        <BottomComposer
          key={composerInstanceKey}
          layout={TEST_LAYOUT}
          uiState={{ kind: "IDLE" }}
          value={value}
          cursor={cursor}
          onChangeInput={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onSubmit={() => {}}
          onCancel={() => {}}
          onChangeValue={setValue}
          onChangeCursor={setCursor}
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
      )}
    </ThemeProvider>
  );
}

function PasteComposerHarness() {
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [submitCount, setSubmitCount] = React.useState(0);
  const [registeredChars, setRegisteredChars] = React.useState(0);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <BottomComposer
          layout={TEST_LAYOUT}
          uiState={{ kind: "IDLE" }}
          value={value}
          cursor={cursor}
          onChangeInput={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onRegisterPaste={(_label, content) => setRegisteredChars(Array.from(content).length)}
          onSubmit={() => {
            setSubmitCount((count) => count + 1);
          }}
          onCancel={() => {}}
          onChangeValue={setValue}
          onChangeCursor={setCursor}
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
        <Text>{`submit:${submitCount}`}</Text>
        <Text>{`value:${JSON.stringify(value)}`}</Text>
        <Text>{`registered:${registeredChars}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

function PlanToggleComposerHarness() {
  const [planMode, setPlanMode] = React.useState(false);
  const [mode, setMode] = React.useState<AvailableMode>("full-auto");
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [submitCount, setSubmitCount] = React.useState(0);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <BottomComposer
          layout={TEST_LAYOUT}
          uiState={{ kind: "IDLE" }}
          mode={mode}
          value={value}
          cursor={cursor}
          planMode={planMode}
          onChangeInput={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onSubmit={() => {
            setSubmitCount((count) => count + 1);
          }}
          onCancel={() => {}}
          onChangeValue={setValue}
          onChangeCursor={setCursor}
          onHistoryUp={() => {}}
          onHistoryDown={() => {}}
          onOpenBackendPicker={() => {}}
          onOpenModelPicker={() => {}}
          onOpenModePicker={() => {}}
          onOpenThemePicker={() => {}}
          onOpenAuthPanel={() => {}}
          onTogglePlanMode={() => setPlanMode((current) => !current)}
          onClear={() => {}}
          onCycleMode={() => {
            const next = getNextRotatingMode(mode, planMode);
            setMode(next.mode);
            setPlanMode(next.planMode);
          }}
          onQuit={() => {}}
        />
        <Text>{`plan:${planMode ? "on" : "off"}`}</Text>
        <Text>{`mode:${mode}`}</Text>
        <Text>{`submit:${submitCount}`}</Text>
        <Text>{`value:${JSON.stringify(value)}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

function ShortcutModelPickerHarness() {
  const focusManager = useFocusManager();
  const [screen, setScreen] = React.useState<"main" | "model-picker">("main");
  const [model, setModel] = React.useState<AvailableModel>("gpt-5.4");
  const [reasoningLevel, setReasoningLevel] = React.useState<ReasoningLevel>("high");
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [submitCount, setSubmitCount] = React.useState(0);
  const [composerInstanceKey, setComposerInstanceKey] = React.useState(0);
  const previousScreenRef = React.useRef<"main" | "model-picker">("main");

  React.useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  React.useEffect(() => {
    focusManager.focus(getFocusTargetForScreen(screen));
  }, [composerInstanceKey, focusManager, screen]);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <Text>{`screen:${screen}`}</Text>
        <Text>{`model:${model}`}</Text>
        <Text>{`submit:${submitCount}`}</Text>
        <Text>{`value:${JSON.stringify(value)}`}</Text>
        {screen === "model-picker" ? (
          <ModelPickerScreen
            layout={TEST_LAYOUT}
            models={TEST_MODEL_CAPABILITIES}
            currentModel={model}
            currentReasoning={reasoningLevel}
            onSelect={(nextModel, nextReasoning) => {
              const resolvedModel = nextModel as AvailableModel;
              setModel(resolvedModel);
              setReasoningLevel(nextReasoning as ReasoningLevel);
              setScreen("main");
            }}
            onCancel={() => setScreen("main")}
          />
        ) : (
          <BottomComposer
            key={composerInstanceKey}
            layout={TEST_LAYOUT}
            uiState={{ kind: "IDLE" }}
            value={value}
            cursor={cursor}
            onChangeInput={(nextValue, nextCursor) => {
              setValue(nextValue);
              setCursor(nextCursor);
            }}
            onSubmit={() => {
              setSubmitCount((count) => count + 1);
            }}
            onCancel={() => {}}
            onChangeValue={setValue}
            onChangeCursor={setCursor}
            onHistoryUp={() => {}}
            onHistoryDown={() => {}}
            onOpenBackendPicker={() => {}}
            onOpenModelPicker={() => setScreen("model-picker")}
            onOpenModePicker={() => {}}
            onOpenThemePicker={() => {}}
            onOpenAuthPanel={() => {}}
            onTogglePlanMode={() => {}}
            onClear={() => {}}
            onCycleMode={() => {}}
            onQuit={() => {}}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

function ShortcutProviderPickerHarness() {
  const focusManager = useFocusManager();
  const [screen, setScreen] = React.useState<"main" | "provider-picker">("main");
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [submitCount, setSubmitCount] = React.useState(0);
  const [composerInstanceKey, setComposerInstanceKey] = React.useState(0);
  const previousScreenRef = React.useRef<"main" | "provider-picker">("main");
  const providers = React.useMemo(() => buildProviderRegistry({ activeModel: "gpt-5.4" }), []);

  React.useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  React.useEffect(() => {
    focusManager.focus(getFocusTargetForScreen(screen));
  }, [composerInstanceKey, focusManager, screen]);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <Text>{`screen:${screen}`}</Text>
        <Text>{`submit:${submitCount}`}</Text>
        <Text>{`value:${JSON.stringify(value)}`}</Text>
        {screen === "provider-picker" ? (
          <ProviderPicker
            layout={TEST_LAYOUT}
            providers={providers}
            onAction={() => setScreen("main")}
            onCancel={() => setScreen("main")}
          />
        ) : (
          <BottomComposer
            key={composerInstanceKey}
            layout={TEST_LAYOUT}
            uiState={{ kind: "IDLE" }}
            value={value}
            cursor={cursor}
            onChangeInput={(nextValue, nextCursor) => {
              setValue(nextValue);
              setCursor(nextCursor);
            }}
            onSubmit={() => {
              setSubmitCount((count) => count + 1);
              const result = handleCommand(value, TEST_COMMAND_CONTEXT);
              if (result?.action === "open_provider_picker") {
                setScreen("provider-picker");
              }
              setValue("");
              setCursor(0);
            }}
            onCancel={() => {}}
            onChangeValue={setValue}
            onChangeCursor={setCursor}
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
        )}
      </Box>
    </ThemeProvider>
  );
}

function ShortcutModelReasoningPickerHarness({ delayedModels = false }: { delayedModels?: boolean } = {}) {
  const focusManager = useFocusManager();
  const [screen, setScreen] = React.useState<"main" | "model-picker">("main");
  const [model, setModel] = React.useState<AvailableModel>("gpt-5.4");
  const [reasoningLevel, setReasoningLevel] = React.useState<ReasoningLevel>("high");
  const [models, setModels] = React.useState(() => delayedModels ? [] : TEST_MODEL_CAPABILITIES);
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [submitCount, setSubmitCount] = React.useState(0);
  const [composerInstanceKey, setComposerInstanceKey] = React.useState(0);
  const previousScreenRef = React.useRef<"main" | "model-picker">("main");

  React.useEffect(() => {
    if (!delayedModels) return;

    const timer = setTimeout(() => setModels(TEST_MODEL_CAPABILITIES), 90);
    return () => clearTimeout(timer);
  }, [delayedModels]);

  const returnToChatMode = React.useCallback(() => {
    setScreen("main");
    focusManager.focus("composer");
  }, [focusManager]);

  React.useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  React.useEffect(() => {
    focusManager.focus(getFocusTargetForScreen(screen));
  }, [composerInstanceKey, focusManager, screen]);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <Text>{`screen:${screen}`}</Text>
        <Text>{`model:${model}`}</Text>
        <Text>{`reasoning:${reasoningLevel}`}</Text>
        <Text>{`submit:${submitCount}`}</Text>
        <Text>{`value:${JSON.stringify(value)}`}</Text>
        {screen === "model-picker" ? (
          <ModelPickerScreen
            layout={TEST_LAYOUT}
            models={models}
            currentModel={model}
            currentReasoning={reasoningLevel}
            isLoading={models.length === 0}
            onSelect={(nextModel, nextReasoning) => {
              setModel(nextModel as AvailableModel);
              setReasoningLevel(nextReasoning as ReasoningLevel);
              returnToChatMode();
            }}
            onCancel={returnToChatMode}
          />
        ) : (
          <BottomComposer
            key={composerInstanceKey}
            layout={TEST_LAYOUT}
            uiState={{ kind: "IDLE" }}
            value={value}
            cursor={cursor}
            onChangeInput={(nextValue, nextCursor) => {
              setValue(nextValue);
              setCursor(nextCursor);
            }}
            onSubmit={() => {
              setSubmitCount((count) => count + 1);
              setValue("");
              setCursor(0);
            }}
            onCancel={() => {}}
            onChangeValue={setValue}
            onChangeCursor={setCursor}
            onHistoryUp={() => {}}
            onHistoryDown={() => {}}
            onOpenBackendPicker={() => {}}
            onOpenModelPicker={() => setScreen((currentScreen) => currentScreen === "model-picker" ? currentScreen : "model-picker")}
            onOpenModePicker={() => {}}
            onOpenThemePicker={() => {}}
            onOpenAuthPanel={() => {}}
            onTogglePlanMode={() => {}}
            onClear={() => {}}
            onCycleMode={() => {}}
            onQuit={() => {}}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

function PlanActionPickerHarness() {
  const [selection, setSelection] = React.useState<string>("none");
  const [cancelCount, setCancelCount] = React.useState(0);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <PlanActionPicker
          onSelect={(value) => setSelection(value)}
          onCancel={() => setCancelCount((count) => count + 1)}
        />
        <Text>{`selection:${selection}`}</Text>
        <Text>{`cancel:${cancelCount}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

function PlanFeedbackHarness() {
  const [screen, setScreen] = React.useState<"picker" | "feedback">("picker");
  const [submitted, setSubmitted] = React.useState("");

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        {screen === "picker" ? (
          <PlanActionPicker
            onSelect={(value) => {
              if (value === "revise") {
                setScreen("feedback");
              }
            }}
            onCancel={() => {}}
          />
        ) : (
          <TextEntryPanel
            focusId="composer"
            title="Revise plan"
            subtitle="Describe the revision."
            inputLabel="Revision"
            footerHint="Enter regenerate  Esc back  Backspace delete"
            onSubmit={(value) => {
              setSubmitted(value);
              setScreen("picker");
            }}
            onCancel={() => setScreen("picker")}
          />
        )}
        <Text>{`screen:${screen}`}</Text>
        <Text>{`submitted:${JSON.stringify(submitted)}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

test("focus manager targets the active panel and returns to the composer", async () => {
  const harness = createInkHarness(<FocusRoutingHarness screen="model-picker" />);

  try {
    await sleep();
    harness.instance.rerender(<FocusRoutingHarness screen="main" />);
    await sleep();

    const output = harness.getOutput();
    assert.match(output, /model:focused/);
    assert.ok(output.trim().endsWith("composer:focused"));
  } finally {
    await harness.cleanup();
  }
});

test("focus manager routes through the permissions panel and back to the composer", async () => {
  const harness = createInkHarness(<FocusRoutingHarness screen="permissions-panel" />);

  try {
    await sleep();
    harness.instance.rerender(<FocusRoutingHarness screen="main" />);
    await sleep();

    const output = harness.getOutput();
    assert.match(output, /permissions:focused/);
    assert.ok(output.trim().endsWith("composer:focused"));
  } finally {
    await harness.cleanup();
  }
});

test("model picker hands focus back to the composer so typing works immediately", async () => {
  const harness = createInkHarness(<ModelPickerComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("\u001b[B");
    await sleep();
    harness.stdin.write("\r");
    await sleep(80);
    harness.stdin.write("x");
    await sleep(20);
    harness.stdin.write("y");
    await sleep(20);
    harness.stdin.write("z");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /gpt-5\.4-mini/);
    assert.match(output, /❯\s+xyz/);
  } finally {
    await harness.cleanup();
  }
});

test("bracketed multi-line paste stays in the composer and preserves layout", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("\u001b[200~alpha\nbeta\u001b[201~");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /submit:0/);
    assert.match(output, /value:"alpha\\nbeta"/);
    assert.match(output, /alpha/);
    assert.match(output, /beta/);
  } finally {
    await harness.cleanup();
  }
});

test("large bracketed paste renders as a compact content marker", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);
  try {
    await sleep();
    harness.stdin.write(`\u001b[200~${"x".repeat(1_000)}\u001b[201~`);
    await sleep(100);
    const output = harness.getOutput();
    assert.match(output, /\[Pasted Content 1,000 chars\]/);
    assert.match(output, /registered:1000/);
    assert.doesNotMatch(output, /x{100}/);
  } finally {
    await harness.cleanup();
  }
});

test("multi-chunk 8264-character paste is coalesced into one compact marker", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);
  try {
    await sleep();
    harness.stdin.write("\u001b[200~");
    const chunks = [
      "x".repeat(2_048),
      "x".repeat(2_048),
      "x".repeat(2_048),
      "x".repeat(2_120),
    ];
    for (const chunk of chunks) harness.stdin.write(chunk);
    harness.stdin.write("\u001b[201~");
    await sleep(120);

    const output = harness.getOutput();
    assert.match(output, /\[Pasted Content 8,264 chars\]/);
    assert.match(output, /registered:8264/);
    assert.doesNotMatch(output, /x{100}/);
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+j inserts a newline without submitting the composer", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\n");
    await sleep(20);
    harness.stdin.write("b");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /submit:0/);
    assert.match(output, /value:"a\\nb"/);
    assert.match(output, /a/);
    assert.match(output, /b/);
  } finally {
    await harness.cleanup();
  }
});

test("shift+tab rotates plan and safety modes without submitting or mutating the input", async () => {
  const harness = createInkHarness(<PlanToggleComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\u001b[Z");
    await sleep(80);
    harness.stdin.write("\u001b[Z");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /plan:on/);
    assert.match(output, /plan:off/);
    assert.match(output, /mode:suggest/);
    assert.match(output, /submit:0/);
    assert.equal(getLastComposerValue(output), "a");
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+o opens the existing model picker path without submitting", async () => {
  const harness = createInkHarness(<ShortcutModelPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\x0F"); // Ctrl+O
    await sleep(120);
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    harness.stdin.write("z");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /screen:model-picker/);
    assert.match(output, /Select model/);
    assert.match(output, /screen:main/);
    assert.match(output, /model:gpt-5\.4-mini/);
    assert.match(output, /submit:0/);
    assert.equal(getLastComposerValue(output), "az");
  } finally {
    await harness.cleanup();
  }
});

test("accepting the provider suggestion opens the provider picker and manual alias entry does too", async () => {
  const harness = createInkHarness(<ShortcutProviderPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("/pro");
    await sleep(40);
    harness.stdin.write("\t");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(120);
    harness.stdin.write("\u001b");
    await sleep(80);
    harness.stdin.write("/provider");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(120);

    const output = harness.getOutput();
    assert.match(output, /screen:provider-picker/);
    assert.match(output, /Providers/);
    assert.match(output, /screen:main/);
    assert.match(output, /submit:2/);
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+o model reasoning picker returns to chat after escape and selection", async () => {
  const harness = createInkHarness(<ShortcutModelReasoningPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("\x0F"); // Ctrl+O immediately after startup
    await sleep(120);
    harness.stdin.write("\u001b");
    await sleep(120);
    harness.stdin.write("a");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(120);
    harness.stdin.write("\x0F");
    await sleep(120);
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(120);
    harness.stdin.write("b");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(120);

    const output = harness.getOutput();
    assert.match(output, /screen:model-picker/);
    assert.match(output, /screen:main/);
    assert.match(output, /model:gpt-5\.4-mini/);
    assert.match(output, /submit:2/);
    assert.equal(getLastComposerValue(output), "");
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+o remains usable when startup model loading resolves while picker is open", async () => {
  const harness = createInkHarness(<ShortcutModelReasoningPickerHarness delayedModels />);

  try {
    await sleep();
    harness.stdin.write("\x0F"); // Ctrl+O immediately after startup
    await sleep(180);
    harness.stdin.write("\u001b");
    await sleep(100);
    harness.stdin.write("/");
    await sleep(20);
    harness.stdin.write("h");
    await sleep(20);
    harness.stdin.write("e");
    await sleep(20);
    harness.stdin.write("l");
    await sleep(20);
    harness.stdin.write("p");
    await sleep(20);
    harness.stdin.write("\r");
    await sleep(120);

    const output = harness.getOutput();
    assert.match(output, /Discovering models from the Codex runtime/);
    assert.match(output, /screen:model-picker/);
    assert.match(output, /screen:main/);
    assert.match(output, /submit:1/);
    assert.equal(getLastComposerValue(output), "");
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+m opens the existing model picker path without submitting", async () => {
  const harness = createInkHarness(<ShortcutModelPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\u001b[109;5u");
    await sleep(120);
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    harness.stdin.write("z");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /screen:model-picker/);
    assert.match(output, /Select model/);
    assert.match(output, /screen:main/);
    assert.match(output, /model:gpt-5\.4-mini/);
    assert.match(output, /submit:0/);
    assert.equal(getLastComposerValue(output), "az");
  } finally {
    await harness.cleanup();
  }
});

test("ctrl+m also opens the model picker when the terminal reports ctrl+enter as CSI-u", async () => {
  const harness = createInkHarness(<ShortcutModelPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\u001b[13;5u");
    await sleep(120);
    harness.stdin.write("\u001b");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /screen:model-picker/);
    assert.match(output, /Select model/);
    assert.match(output, /screen:main/);
    assert.match(output, /submit:0/);
    assert.equal(getLastComposerValue(output), "a");
  } finally {
    await harness.cleanup();
  }
});

test("plain enter still submits without opening the model picker", async () => {
  const harness = createInkHarness(<ShortcutModelPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("\r");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /screen:main/);
    assert.match(output, /submit:1/);
    assert.equal(getLastComposerValue(output), "a");
    assert.doesNotMatch(output, /Select model/);
  } finally {
    await harness.cleanup();
  }
});

test("focus manager routes through the settings panel and back to the composer", async () => {
  const harness = createInkHarness(<FocusRoutingHarness screen="settings-panel" />);

  try {
    await sleep();
    harness.instance.rerender(<FocusRoutingHarness screen="main" />);
    await sleep();

    const output = harness.getOutput();
    assert.match(output, /settings:focused/);
    assert.ok(output.trim().endsWith("composer:focused"));
  } finally {
    await harness.cleanup();
  }
});

test("plan action picker supports focused hotkeys and esc cancel", async () => {
  const harness = createInkHarness(<PlanActionPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("u");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /selection:\s*revise/);

    harness.stdin.write("\u001b");
    // A lone escape is held briefly to see whether it is the prefix of an arrow
    // sequence, so allow for Ink's flush plus the picker's settle window.
    await sleep(200);

    const finalOutput = harness.getOutput();
    assert.match(finalOutput, /cancel:\s*1/);
  } finally {
    await harness.cleanup();
  }
});

test("plan action picker ignores SGR mouse escape sequences", async () => {
  const harness = createInkHarness(<PlanActionPickerHarness />);

  try {
    await sleep();

    // Simulate terminal mouse event (button press + scroll) sent to raw stdin
    harness.stdin.write("\x1b[<0;83;19M");
    harness.stdin.write("\x1b[<64;83;19M");
    await sleep(80);

    const output = harness.getOutput();
    // Neither mouse sequence should appear as selection or visible text
    assert.ok(!output.includes("[<0;83;19M"), "mouse sequence must not appear in output");
    assert.ok(!output.includes("[<64;83;19M"), "scroll sequence must not appear in output");
    // selection should still be "none" — no accidental trigger
    assert.match(output, /selection:\s*none/);
  } finally {
    await harness.cleanup();
  }
});

test("plan action picker moves the selection on a whole arrow sequence", async () => {
  const harness = createInkHarness(<PlanActionPickerHarness />);

  try {
    await sleep();
    harness.stdin.write("[C");
    await sleep(120);

    const output = harness.getOutput();
    assert.match(output, /›\s*\[U\] Update plan/);
    assert.match(output, /selection:\s*none/);
    assert.match(output, /cancel:\s*0/);
  } finally {
    await harness.cleanup();
  }
});

test("plan action picker does not cancel when an arrow arrives split across reads", async () => {
  const harness = createInkHarness(<PlanActionPickerHarness />);

  try {
    await sleep();
    // Ink flushes a lone ESC as a bare escape after ~20ms, so a right arrow
    // split across two stdin reads must not be mistaken for "cancel review".
    harness.stdin.write("");
    await sleep(40);
    harness.stdin.write("[C");
    await sleep(150);

    const output = harness.getOutput();
    assert.match(output, /cancel:\s*0/);
    assert.match(output, /selection:\s*none/);
    assert.match(output, /›\s*\[U\] Update plan/);
  } finally {
    await harness.cleanup();
  }
});

test("plan feedback entry returns to the picker on esc and submits on enter", async () => {
  const harness = createInkHarness(<PlanFeedbackHarness />);

  try {
    await sleep();
    harness.stdin.write("u");
    await sleep(80);
    harness.stdin.write("\u001b");
    await sleep(80);
    harness.stdin.write("u");
    await sleep(80);
    harness.stdin.write("s");
    await sleep(20);
    harness.stdin.write("c");
    await sleep(20);
    harness.stdin.write("o");
    await sleep(20);
    harness.stdin.write("p");
    await sleep(20);
    harness.stdin.write("e");
    await sleep(20);
    harness.stdin.write("\r");
    await sleep(80);

    const output = harness.getOutput();
    assert.match(output, /screen:feedback/);
    assert.match(output, /screen:picker/);
    assert.match(output, /submitted:"scope"/);
  } finally {
    await harness.cleanup();
  }
});

test("treats raw DEL (\\u007f) as backspace in the composer", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("H");
    await sleep(20);
    harness.stdin.write("=");
    await sleep(20);
    harness.stdin.write("\u007f");
    await sleep(80);

    const output = harness.getOutput();
    assert.equal(getLastComposerValue(output), "H");
  } finally {
    await harness.cleanup();
  }
});

test("keeps ANSI delete (ESC[3~) as forward delete behavior", async () => {
  const harness = createInkHarness(<PasteComposerHarness />);

  try {
    await sleep();
    harness.stdin.write("a");
    await sleep(20);
    harness.stdin.write("b");
    await sleep(20);
    harness.stdin.write("\u001b[D");
    await sleep(20);
    harness.stdin.write("\u001b[3~");
    await sleep(80);

    const output = harness.getOutput();
    assert.equal(getLastComposerValue(output), "a");
  } finally {
    await harness.cleanup();
  }
});
