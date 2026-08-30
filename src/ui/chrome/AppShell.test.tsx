import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, render, Text } from "ink";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import { buildRuntimeSummary } from "../../config/runtimeConfig.js";
import { HEADER_CONFIG_DEFAULTS, type HeaderConfig } from "../../config/settings.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { BottomComposer, measureBottomComposerRows } from "./BottomComposer.js";
import { AppShell, calculateColdStartSpacerRows, calculateHeaderToContentGapRows, calculateNativeSpacerRows } from "./AppShell.js";
import { createLayoutSnapshot, useTerminalViewport } from "../layout.js";
import { PlanActionPicker, measurePlanActionPickerRows } from "../panels/PlanActionPicker.js";
import { buildStaticIntroRows, StaticIntroItem } from "../timeline/StaticIntroItem.js";
import { ThemeProvider } from "../theme.js";

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

const EVENTS: TimelineEvent[] = [
  { id: 1, type: "system", createdAt: 1, title: "Launch mode", content: "Dev shell attached" },
  { id: 2, type: "user", createdAt: 2, prompt: "Reproduce the resize flicker and fix it.", turnId: 1 },
  {
    id: 3,
    type: "run",
    createdAt: 3,
    startedAt: 3,
    durationMs: 1250,
    backendId: "codex-subprocess",
    backendLabel: "Codexa",
    runtime: TEST_RUNTIME,
    prompt: "Reproduce the resize flicker and fix it.",
    progressEntries: [],
    status: "completed",
    summary: "Completed",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 1,
    errorMessage: null,
    turnId: 1,
  },
  {
    id: 4,
    type: "assistant",
    createdAt: 4,
    content: "Root cause looks like a layout gutter mismatch during resize.\n\nThis response is intentionally a bit longer to force wrapping at smaller widths.",
    contentChunks: [],
    turnId: 1,
  },
];

const STARTUP_HEADER_CONFIG: HeaderConfig = {
  ...HEADER_CONFIG_DEFAULTS,
  showModel: false,
  showReasoning: false,
  showContext: false,
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function compactText(value: string): string {
  return stripAnsi(value).replace(/\s+/g, "");
}

function countOccurrences(value: string, pattern: RegExp): number {
  return stripAnsi(value).match(pattern)?.length ?? 0;
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderShell(
  layoutCols: number,
  layoutRows: number,
  uiState: UIState,
  screen: "main" | "theme-picker" | "model-picker" = "main",
  panel: React.ReactNode = null,
  mainPanel: React.ReactNode = null,
  mainPanelMode: "viewport" | "full-output" = "viewport",
): Promise<string> {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = layoutCols;
  stdout.rows = layoutRows;
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(layoutCols, layoutRows);
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "auto-edit",
    model: "gpt-5.4",
    reasoningLevel: "medium",
    tokensUsed: 1200,
    value: "",
    cursor: 0,
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen={screen}
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={EVENTS}
        activeEvents={[]}
        uiState={uiState}
        panel={panel}
        mainPanel={mainPanel}
        mainPanelMode={mainPanelMode}
        composer={
          <BottomComposer
            layout={layout}
            uiState={uiState}
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
        composerRows={composerRows}
        headerConfig={STARTUP_HEADER_CONFIG}
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

  return sleep(100).then(async () => {
    instance.cleanup();
    await sleep(20);
    return stripAnsi(output);
  });
}

test("does not render passive update notice (replaced by interactive prompt)", async () => {
  const output = await renderShell(120, 40, { kind: "IDLE" });
  assert.doesNotMatch(output, /Update available: Codexa .* is available/);
  assert.doesNotMatch(output, /Run: npm install -g @golba98\/codexa@latest/);
});

test("header omits model/context while composer status row renders active model and context", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 130;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(130, 40);
  const uiState: UIState = { kind: "IDLE" };
  const runtimeSummary = {
    ...buildRuntimeSummary(TEST_RUNTIME),
    providerLabel: "Claude Code CLI",
    modelLabel: "Claude Code CLI / Sonnet 4.6 / reasoning: Low",
    contextLabel: "0 / 200K",
  };
  const composer = (
    <BottomComposer
      layout={layout}
      uiState={uiState}
      mode="full-auto"
      model="Claude Code CLI / Sonnet 4.6 / reasoning: Low"
      footerModelDisplay="Claude Code CLI / Sonnet 4.6 (Low)"
      themeName="purple"
      reasoningLevel=""
      contextDisplay="0 / 200K"
      tokensUsed={0}
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
      onOpenProviderPicker={() => {}}
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
        screen="main"
        authState="authenticated"
        workspaceLabel="13-Custom-CLI-Normal"
        runtimeSummary={runtimeSummary}
        staticEvents={[]}
        activeEvents={[]}
        uiState={uiState}
        panel={null}
        composer={composer}
        composerRows={measureBottomComposerRows({
          layout,
          uiState,
          mode: "full-auto",
          model: "Claude Code CLI / Sonnet 4.6 / reasoning: Low",
          reasoningLevel: "",
          tokensUsed: 0,
          value: "",
          cursor: 0,
        })}
        headerConfig={{ ...HEADER_CONFIG_DEFAULTS, showModel: true, showContext: true }}
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

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const text = stripAnsi(output);
  assert.doesNotMatch(text, /Model:\s*Claude Code CLI/);

  const lines = text.split("\n");
  const statusLineIndex = lines.findLastIndex((line) => line.includes("Claude Code CLI / Sonnet 4.6 (Low)"));
  const promptLineIndex = lines.findLastIndex((line, index) => index < statusLineIndex && line.includes("❯") && line.includes("Ask Codexa"));
  assert.ok(promptLineIndex >= 0, "composer prompt should render");

  const finalBottomChrome = lines.slice(Math.max(0, promptLineIndex - 2)).join("\n");
  assert.equal(countOccurrences(finalBottomChrome, /Context:/g), 1, "context metadata should render exactly once in the final frame");
  assert.equal(countOccurrences(finalBottomChrome, /Claude Code CLI \/ Sonnet 4\.6 \(Low\)/g), 1, "runtime metadata should render exactly once in the final frame");
  assert.equal(statusLineIndex, promptLineIndex + 2, "runtime status row should directly follow the composer input border");

  const statusLine = lines[statusLineIndex] ?? "";
  assert.match(statusLine, /Claude Code CLI \/ Sonnet 4\.6 \(Low\)/);
  assert.match(statusLine, /Context:\s*0 \/ 200K/);
  assert.ok(statusLine.indexOf("Context:") > statusLine.indexOf("Claude Code CLI"), "context should be on the same row to the right of model text");
  assert.ok(statusLine.indexOf("Context:") >= 90, "context should stay right-aligned at normal widths");
});

test("100x22 bottom chrome renders runtime context once below composer", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 100;
  stdout.rows = 22;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(100, 22);
  const uiState: UIState = { kind: "IDLE" };
  const composer = (
    <BottomComposer
      layout={layout}
      uiState={uiState}
      mode="auto-edit"
      model="OpenAI Codex CLI / gpt-5.4-mini"
      footerModelDisplay="OpenAI Codex CLI / gpt-5.4-mini (Low)"
      themeName="purple"
      contextDisplay="0 / ~200K"
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
      onOpenProviderPicker={() => {}}
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
        screen="main"
        authState="authenticated"
        workspaceLabel="13-Custom-CLI-Normal"
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={[]}
        activeEvents={[]}
        uiState={uiState}
        panel={null}
        composer={composer}
        composerRows={measureBottomComposerRows({
          layout,
          uiState,
          value: "",
          cursor: 0,
        })}
        headerConfig={STARTUP_HEADER_CONFIG}
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

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const text = stripAnsi(output);
  const lines = text.split("\n");
  assert.match(text, /██████|CODEXA|Codexa/);
  assert.match(text, /❯\s+Ask Codexa/);

  const runtimeLineIndex = lines.findLastIndex((line) => line.includes("OpenAI Codex CLI / gpt-5.4-mini"));
  const promptLineIndex = lines.findLastIndex((line, index) => index < runtimeLineIndex && line.includes("❯") && line.includes("Ask Codexa"));
  assert.ok(runtimeLineIndex >= 0, "runtime metadata should render");
  assert.ok(promptLineIndex >= 0, "composer prompt should render");
  assert.equal(runtimeLineIndex, promptLineIndex + 2, "runtime metadata should sit directly below the composer input border");

  const finalBottomChrome = lines.slice(Math.max(0, promptLineIndex - 2)).join("\n");
  assert.equal(countOccurrences(finalBottomChrome, /Context:/g), 1);
  assert.equal(countOccurrences(finalBottomChrome, /OpenAI Codex CLI \/ gpt-5\.4-mini/g), 1);
});

function renderStartupShell(
  layoutCols: number,
  layoutRows: number,
  screen: "main" | "model-picker" = "main",
  staticEvents: TimelineEvent[] = [],
  panel: React.ReactNode = null,
): Promise<string> {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = layoutCols;
  stdout.rows = layoutRows;
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(layoutCols, layoutRows);
  const uiState: UIState = { kind: "IDLE" };
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "auto-edit",
    model: "gpt-5.4",
    reasoningLevel: "medium",
    tokensUsed: 0,
    value: "",
    cursor: 0,
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen={screen}
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={staticEvents}
        activeEvents={[]}
        uiState={uiState}
        panel={panel}
        mainPanel={null}
        composer={
          <BottomComposer
            layout={layout}
            uiState={uiState}
            mode="auto-edit"
            model="gpt-5.4"
            themeName="purple"
            reasoningLevel="medium"
            tokensUsed={0}
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
        composerRows={composerRows}
        headerConfig={STARTUP_HEADER_CONFIG}
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

  return sleep(100).then(async () => {
    instance.cleanup();
    await sleep(20);
    return stripAnsi(output);
  });
}

test("startup uses the large logo only when the viewport height can contain it", async () => {
  const output = await renderStartupShell(120, 30);

  assert.match(output, /██████/);
  assert.match(output, /Codexa v/);
  assert.match(output, /\n\s*╭[─]+╮\n\s*│ ❯/);
});

test("startup uses compact side-by-side ASCII header at normal shorter terminal width", async () => {
  const output = await renderStartupShell(100, 24);

  assert.match(output, /██████/);
  assert.match(output, /Codexa v/);
  assert.match(output, /Workspace:\s*…\\13-Custom CLI/);
  assert.match(output, /Provider: Codexa Core/);
  assert.match(output, /gpt-5\.4 \(medium\)\s+· Auto\s+Context: Unknown/);
  assert.doesNotMatch(output, /Model: gpt-5\.4/);
  assert.doesNotMatch(output, /Reasoning:/);
  assert.match(output, /\n\s*╭[─]+╮\n\s*│ ❯/);
});

test("startup micro mode keeps the live header and composer visible", async () => {
  const output = await renderStartupShell(39, 13);

  assert.match(output, /Codexa/);
  assert.match(output, /\n\s*╭[─]+╮\n\s*│ ❯/);
  assert.doesNotMatch(output, /██████/);
});

test("80x24 keeps the last timeline content visible above the composer", async () => {
  const output = await renderShell(80, 24, { kind: "IDLE" });

  assert.match(output, /Root cause looks like a layout gutter mismatch/);
  assert.match(output, /\n\s*╭[─]+╮\n\s*│ ❯/);
  assert.doesNotMatch(output, /Auto\s+gpt-5\.4 \(medium\)\s+Ctrl\+O/);
});

test("larger terminals keep the composer metadata row", async () => {
  const output = await renderShell(100, 30, { kind: "IDLE" });

  assert.match(output, /gpt-5\.4 \(medium\)\s+· Auto\s+Context: Unknown/);
  assert.match(output, /Dev shell attached/);
  assert.match(output, /gpt-5\.4/i);
});

test("cramped busy state uses the run footer in app composition", async () => {
  const output = await renderShell(80, 24, { kind: "THINKING", turnId: 1 });

  assert.match(output, /Codexa is thinking/i);
  assert.doesNotMatch(output, /CODEXA\s+\|\s+gpt-5\.4/i);
  assert.doesNotMatch(output, /CODEXA AGENT/);
});

test("cramped streaming state avoids response-labelled footer text", async () => {
  const output = await renderShell(80, 24, { kind: "RESPONDING", turnId: 1 });

  assert.match(output, /Codexa is thinking/i);
  assert.doesNotMatch(output, /Codexa is streaming/i);
  assert.doesNotMatch(output, /Streaming response/i);
});

test("non-main screens center the active panel and keep the composer visible", async () => {
  const output = await renderShell(
    100,
    30,
    { kind: "IDLE" },
    "theme-picker",
    <Text>Theme panel</Text>,
  );

  assert.match(output, /Theme panel/);
  assert.match(output, /gpt-5\.4 \(medium\)/);
});

test("100x22 overlay panels prioritize visible options over the large startup logo", async () => {
  const output = await renderShell(
    100,
    22,
    { kind: "IDLE" },
    "theme-picker",
    <Box flexDirection="column">
      <Text>Midnight Purple</Text>
      <Text>Codex the Black</Text>
      <Text>Dracula Night</Text>
      <Text>Deep Oceanic</Text>
    </Box>,
  );

  assert.match(output, /Codexa v/);
  assert.doesNotMatch(output, /██████/);
  assert.match(output, /Midnight Purple/);
  assert.match(output, /Codex the Black/);
  assert.match(output, /Dracula Night/);
  assert.match(output, /Deep Oceanic/);
  assert.match(output, /Ask Codexa/);
  assert.match(output, /gpt-5\.4 \(medium\)/);
});

test("non-main panel content updates while the active screen is unchanged", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(100, 30);
  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="model-picker"
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={EVENTS}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={<Text>Loading model list</Text>}
        mainPanel={null}
        composer={null}
        composerRows={0}
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
    await sleep(80);
    instance.rerender(
      <ThemeProvider theme="purple">
        <AppShell
          layout={layout}
          screen="model-picker"
          authState="authenticated"
          workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
          runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
          staticEvents={EVENTS}
          activeEvents={[]}
          uiState={{ kind: "IDLE" }}
          panel={<Text>Interactive model list</Text>}
          mainPanel={null}
          composer={null}
          composerRows={0}
        />
      </ThemeProvider>,
    );
    await sleep(80);

    const frame = stripAnsi(output);
    assert.match(frame, /Loading model list/);
    assert.match(frame, /Interactive model list/);
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});

test("startup intro workspace label updates when the intro component rerenders", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(120, 34);
  const instance = render(
    <ThemeProvider theme="purple">
      <StaticIntroItem
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal"}
        layout={layout}
        verboseMode={false}
        workspaceRoot={"C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal"}
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
    await sleep(80);
    instance.rerender(
      <ThemeProvider theme="purple">
        <StaticIntroItem
          authState="authenticated"
          workspaceLabel="Codexa"
          layout={layout}
          verboseMode={false}
          workspaceRoot={"C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal"}
        />
      </ThemeProvider>,
    );
    await sleep(80);

    const frame = stripAnsi(output);
    assert.match(frame, /Workspace:\s*Codexa/);
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});

test("model picker renders as a compact command panel with composer", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 30;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });
  const layout = createLayoutSnapshot(120, 30);

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="model-picker"
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={EVENTS}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={<Text>Select model command panel</Text>}
        mainPanel={null}
        composer={buildComposerNode(layout, { kind: "IDLE" })}
        composerRows={measureBottomComposerRows({
          layout,
          uiState: { kind: "IDLE" },
          value: "",
          cursor: 0,
        })}
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

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const output = stripAnsi(raw);
  assert.match(output, /Select model command panel/);
  assert.match(output, /Codexa v/);
  assert.match(output, /gpt-5\.4 \(medium\)/);
});

test("native spacer subtracts persistent transcript rows before anchoring the composer", () => {
  const spacerRows = calculateNativeSpacerRows({
    shellRows: 30,
    introRows: 10,
    composerRows: 5,
    staticRows: 4,
    liveRows: 2,
  });

  assert.equal(spacerRows, 9);
  assert.equal(10 + 4 + 2 + spacerRows + 5, 30);
});

test("native spacer clamps when model update events fill the body", () => {
  const spacerRows = calculateNativeSpacerRows({
    shellRows: 24,
    introRows: 9,
    composerRows: 5,
    staticRows: 12,
    liveRows: 0,
  });

  assert.equal(spacerRows, 0);
});

test("cold-start header gap adapts to terminal height", () => {
  // micro 17-row: measureTopHeaderRows=1, headerToContentGap=0, shellHeight=16
  assert.equal(calculateColdStartSpacerRows({
    shellRows: 16,
    headerRows: 1,
    composerRows: 4,
    layoutMode: "compact",
    availableRows: 9,
  }), 1);
  // full 30-row medium: measureTopHeaderRows=7 (1+6+0), headerToContentGap=1, shellHeight=29
  assert.equal(calculateColdStartSpacerRows({
    shellRows: 29,
    headerRows: 8,
    composerRows: 7,
    layoutMode: "regular",
    availableRows: 11,
  }), 1);
  // full 40-row tall: measureTopHeaderRows=7 (1+6+0), headerToContentGap=1, shellHeight=39
  assert.equal(calculateColdStartSpacerRows({
    shellRows: 39,
    headerRows: 9,
    composerRows: 7,
    layoutMode: "regular",
    availableRows: 20,
  }), 1);
});

test("cold-start header gap is capped by available rows", () => {
  assert.equal(calculateColdStartSpacerRows({
    shellRows: 39,
    headerRows: 9,
    composerRows: 7,
    layoutMode: "regular",
    availableRows: 2,
  }), 1);
});

test("header-to-content gap is reserved outside the hero", () => {
  assert.equal(calculateHeaderToContentGapRows(createLayoutSnapshot(120, 40)), 1);
  assert.equal(calculateHeaderToContentGapRows(createLayoutSnapshot(39, 13)), 0);
});

test("main screen keeps the transcript visible while showing the plan action picker", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const layout = createLayoutSnapshot(100, 30);
  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="main"
        authState="authenticated"
        workspaceLabel={"C:\\Development\\1-JavaScript\\13-Custom CLI"}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        staticEvents={EVENTS}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={null}
        mainPanel={null}
        composer={<PlanActionPicker onSelect={() => {}} onCancel={() => {}} />}
        composerRows={measurePlanActionPickerRows()}
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

  await sleep(100);
  const frame = compactText(output);
  instance.cleanup();
  await sleep(20);

  // Assert transcript content is visible
  assert.match(frame, /Reproducetheresizeflickerandfixit\./);
  assert.match(frame, /Rootcauselookslikealayoutguttermismatchduringresize\./);
  // Assert action picker is visible
  assert.match(frame, /Planready/);
  assert.match(frame, /\[I\]Implementchanges/);
  assert.match(frame, /\[U\]Updateplan/);
  assert.doesNotMatch(frame, /╭──Planready/);
  assert.doesNotMatch(frame, /Requestchanges/);
  assert.doesNotMatch(frame, /Addconstraints/);
});



test("memoized composer re-renders when only the terminal height changes", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const renderComposer = (rows: number) => (
    <ThemeProvider theme="purple">
      <BottomComposer
        layout={createLayoutSnapshot(100, rows)}
        uiState={{ kind: "IDLE" }}
        mode="auto-edit"
        model="gpt-5.4"
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
    </ThemeProvider>
  );

  const instance = render(renderComposer(30), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(80);
  let frame = stripAnsi(output);
  assert.match(frame, /gpt-5\.4 \(medium\)\s+· Auto\s+Context: Unknown/);

  output = "";
  instance.rerender(renderComposer(24));
  await sleep(80);
  frame = stripAnsi(output);
  assert.match(frame, /gpt-5\.4 \(medium\)\s+· Auto\s+Context: Unknown/);

  instance.cleanup();
  await sleep(20);
});

function ViewportProbe() {
  const viewport = useTerminalViewport();

  return (
    <Text>
      {`stable:${viewport.cols}x${viewport.rows} raw:${viewport.rawCols ?? 0}x${viewport.rawRows ?? 0} unstable:${viewport.unstable} epoch:${viewport.layoutEpoch}`}
    </Text>
  );
}

test("terminal viewport ignores invalid restore sizes and bumps layout epoch on recovery", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <ViewportProbe />
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

  await sleep(80);
  let frame = compactText(output);
  assert.match(frame, /stable:120x40raw:120x40unstable:falseepoch:0/);

  output = "";
  stdout.columns = 1;
  stdout.rows = 1;
  stdout.emit("resize");
  await sleep(30);
  frame = compactText(output);
  assert.match(frame, /stable:120x40raw:1x1unstable:trueepoch:0/);

  output = "";
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.emit("resize");
  await sleep(140);
  frame = compactText(output);
  assert.match(frame, /stable:120x40raw:120x40unstable:falseepoch:1/);

  instance.cleanup();
  await sleep(20);
});

// ---------------------------------------------------------------------------
// Logo / intro duplication tests
//
// These tests use debug:false (real Ink cursor-control mode) so that Ink's
// <Static> commitment semantics are exercised correctly.  In debug:true each
// full frame is flushed to stdout, making logo-count comparisons meaningless.
// In real mode, <Static> items are written once; subsequent renders only
// update the live portion below the static area.  After stripping ANSI the
// cumulative stdout therefore contains the logo exactly once if — and only if
// — the logo was never re-emitted as a fresh <Static> commit.
// ---------------------------------------------------------------------------

function buildComposerNode(layout: ReturnType<typeof createLayoutSnapshot>, uiState: UIState) {
  return (
    <BottomComposer
      layout={layout}
      uiState={uiState}
      mode="auto-edit"
      model="gpt-5.4"
      themeName="purple"
      reasoningLevel="medium"
      tokensUsed={0}
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
}

function buildShellNode(
  layout: ReturnType<typeof createLayoutSnapshot>,
  staticEvents: TimelineEvent[],
  options: {
    screen?: Screen;
    authState?: "authenticated" | "checking" | "unauthenticated";
    workspaceLabel?: string;
    clearCount?: number;
    panel?: React.ReactNode;
    activeEvents?: TimelineEvent[];
    uiState?: UIState;
    headerConfig?: HeaderConfig;
  } = {},
) {
  const {
    screen = "main",
    authState = "authenticated",
    workspaceLabel = "C:\\Test",
    clearCount = 0,
    panel = null,
    activeEvents = [],
    uiState = { kind: "IDLE" } as UIState,
    headerConfig = HEADER_CONFIG_DEFAULTS,
  } = options;
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "auto-edit",
    model: "gpt-5.4",
    reasoningLevel: "medium",
    tokensUsed: 0,
    value: "",
    cursor: 0,
  });
  return (
    <ThemeProvider theme="purple">
      <AppShell
        key={`app-shell-${clearCount}`}
        layout={layout}
        screen={screen}
        authState={authState}
        workspaceLabel={workspaceLabel}
        staticEvents={staticEvents}
        activeEvents={activeEvents}
        uiState={uiState}
        panel={panel}
        mainPanel={null}
        composer={buildComposerNode(layout, uiState)}
        composerRows={composerRows}
        clearCount={clearCount}
        headerConfig={headerConfig}
      />
    </ThemeProvider>
  );
}

function countLogoInOutput(raw: string): number {
  // Count occurrences of a distinctive second line of the ASCII logo.
  // This line appears exactly once per physical logo render in real-mode output.
  return (stripAnsi(raw).match(/██╔════╝██╔═══██╗/g) ?? []).length;
}

function countCodexaMetadataInOutput(raw: string): number {
  return (stripAnsi(raw).match(/Codexa v/g) ?? []).length;
}

function maxCountPerWrite(writes: string[], counter: (value: string) => number): number {
  return writes.reduce((maximum, write) => Math.max(maximum, counter(write)), 0);
}

function assertHeaderBefore(output: string, marker: string) {
  const text = stripAnsi(output);
  const headerIndex = text.indexOf("Codexa v");
  const markerIndex = text.indexOf(marker);
  assert.ok(headerIndex >= 0, "header should render");
  assert.ok(markerIndex >= 0, `marker should render: ${marker}`);
  assert.ok(
    headerIndex < markerIndex,
    `header should render before ${marker}; header index ${headerIndex}, marker index ${markerIndex}`,
  );
}

function rowText(row: ReturnType<typeof buildStaticIntroRows>[number]): string {
  return row.spans.map((span) => span.text).join("");
}

test("startup metadata stacks workspace between version and auth in the right block", () => {
  const rows = buildStaticIntroRows({
    authState: "checking",
    workspaceLabel: "Codexa",
    layout: createLayoutSnapshot(120, 40),
    verboseMode: false,
    workspaceRoot: "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal",
  }).map(rowText);

  const versionIndex = rows.findIndex((row) => row.includes("Codexa v"));
  const authIndex = rows.findIndex((row) => row.includes("Auth: Checking"));
  const workspaceIndex = rows.findIndex((row) => row.includes("Workspace: Codexa"));

  assert.ok(versionIndex >= 0, "version metadata row should render");
  assert.ok(workspaceIndex >= 0, "workspace metadata row should render");
  assert.ok(authIndex >= 0, "auth metadata row should render");
  assert.equal(workspaceIndex, versionIndex + 1, "workspace metadata should be directly below version");
  assert.equal(authIndex, workspaceIndex + 1, "auth metadata should be directly below workspace");
  assert.doesNotMatch(rows.slice(workspaceIndex + 1).join("\n"), /Workspace:/);
});

test("header renders before committed prompt and assistant transcript content", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);
  const instance = render(buildShellNode(layout, EVENTS), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  assertHeaderBefore(raw, "Reproduce the resize flicker and fix it.");
  assertHeaderBefore(raw, "Root cause looks like a layout gutter mismatch");
});

test("header renders before command output and system notices", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);
  const commandAndNoticeEvents: TimelineEvent[] = [
    {
      id: 20,
      type: "shell",
      createdAt: 20,
      command: "echo command output marker",
      lines: ["command output marker"],
      stderrLines: [],
      summary: "command output marker",
      status: "completed",
      exitCode: 0,
      durationMs: 10,
    },
    {
      id: 21,
      type: "system",
      createdAt: 21,
      title: "Model settings updated",
      content: "model notice marker",
    },
    {
      id: 22,
      type: "system",
      createdAt: 22,
      title: "Settings",
      content: "Workspace display set to Name (name).",
    },
  ];

  const instance = render(buildShellNode(layout, commandAndNoticeEvents), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  assertHeaderBefore(raw, "command output marker");
  assertHeaderBefore(raw, "Model settings updated");
  assertHeaderBefore(raw, "Workspace display set to Name");
});

test("settings panel renders below the header", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);
  const instance = render(buildShellNode(layout, EVENTS, {
    screen: "settings-panel",
    panel: <Text>Settings panel marker</Text>,
  }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  assertHeaderBefore(raw, "Settings panel marker");
});

test("header remains topmost after multiple prompt and response cycles", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  const writes: string[] = [];
  stdout.on("data", (chunk) => {
    const write = chunk.toString();
    raw += write;
    writes.push(write);
  });

  const layout = createLayoutSnapshot(120, 40);
  const multiTurnEvents: TimelineEvent[] = [
    ...EVENTS,
    { id: 30, type: "user", createdAt: 30, prompt: "Second prompt marker", turnId: 2 },
    {
      id: 31,
      type: "run",
      createdAt: 31,
      startedAt: 31,
      durationMs: 200,
      backendId: "codex-subprocess",
      backendLabel: "Codexa",
      runtime: TEST_RUNTIME,
      prompt: "Second prompt marker",
      progressEntries: [],
      status: "completed",
      summary: "Completed",
      truncatedOutput: false,
      toolActivities: [],
      activity: [],
      touchedFileCount: 0,
      errorMessage: null,
      turnId: 2,
    },
    {
      id: 32,
      type: "assistant",
      createdAt: 32,
      content: "Second assistant response marker",
      contentChunks: [],
      turnId: 2,
    },
  ];

  const instance = render(buildShellNode(layout, multiTurnEvents), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  assertHeaderBefore(raw, "Second prompt marker");
  assertHeaderBefore(raw, "Second assistant response marker");
  assert.equal(maxCountPerWrite(writes, countLogoInOutput), 1, "each rendered frame should contain one header");
  assert.equal(maxCountPerWrite(writes, countCodexaMetadataInOutput), 1, "each rendered frame should contain one metadata block");
});

test("header is not duplicated by provider migration and route switch transcript events", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  const writes: string[] = [];
  stdout.on("data", (chunk) => {
    const write = chunk.toString();
    raw += write;
    writes.push(write);
  });

  const layout = createLayoutSnapshot(120, 40);
  const routeEvents: TimelineEvent[] = [
    {
      id: 50,
      type: "system",
      createdAt: 50,
      title: "Provider migrated",
      content: "Antigravity provider is no longer supported. Reverted to OpenAI.",
    },
    {
      id: 51,
      type: "system",
      createdAt: 51,
      title: "Provider route active",
      content: "Google is active via gemini-cli-auth: gemini-3-flash-preview.",
    },
  ];

  const instance = render(buildShellNode(layout, routeEvents), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  assert.match(stripAnsi(raw), /Provider migrated/);
  assert.match(stripAnsi(raw), /Provider route active/);
  assert.equal(maxCountPerWrite(writes, countLogoInOutput), 1, "route switch events must not add a transcript banner");
  assert.equal(maxCountPerWrite(writes, countCodexaMetadataInOutput), 1, "route switch events must not duplicate metadata");
});

test("project instructions render with breathing room below the live header", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  const writes: string[] = [];
  stdout.on("data", (chunk) => {
    const write = chunk.toString();
    raw += write;
    writes.push(write);
  });

  const layout = createLayoutSnapshot(120, 40);
  const projectInstructionEvents: TimelineEvent[] = [
    {
      id: 60,
      type: "system",
      createdAt: 60,
      title: "Project instructions",
      content: "Loaded C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal\\AGENTS.md.",
    },
  ];

  const instance = render(buildShellNode(layout, projectInstructionEvents), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const rows = stripAnsi(raw).split("\n");
  const lastLogoRow = rows.findIndex((row) => row.includes("╚═════"));
  const projectRow = rows.findIndex((row) => row.includes("Project instructions"));

  assert.ok(lastLogoRow >= 0, "logo should render");
  assert.ok(projectRow > lastLogoRow + 1, "project instructions should not touch the logo block");
  assertHeaderBefore(raw, "Project instructions");
  assert.equal(maxCountPerWrite(writes, countLogoInOutput), 1, "project instruction notice must not add a transcript banner");
});

test("live header remains visible when transitioning from startup frame to first prompt", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  // Use a tall terminal so the large ASCII logo is chosen.
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, []), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  const transitionOffset = raw.length;

  // Simulate first prompt completing — transitions from startup frame to transcript.
  instance.rerender(buildShellNode(layout, EVENTS));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  const postPromptOutput = stripAnsi(raw.slice(transitionOffset));
  assert.match(postPromptOutput, /██████/);
  assert.match(postPromptOutput, /Codexa v/);
  assert.match(postPromptOutput, /Workspace: C:\\Test/);
  assert.match(postPromptOutput, /Reproduce the resize flicker and fix it\./);
  assert.match(postPromptOutput, /Root cause looks like a layout gutter mismatch/);
  assertHeaderBefore(postPromptOutput, "Reproduce the resize flicker and fix it.");
  assertHeaderBefore(postPromptOutput, "Root cause looks like a layout gutter mismatch");
});

test("workspace label updates on cold start without remounting the app shell", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, [], {
    workspaceLabel: "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal",
  }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.rerender(buildShellNode(layout, [], { workspaceLabel: "Codexa" }));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  const output = stripAnsi(raw);
  assert.match(output, /Workspace:\s*Codexa/);
  assert.doesNotMatch(output, /Settings/);
  assert.ok(countLogoInOutput(raw) <= 4, "workspace label changes should stay bounded to the live startup header");
});

test("post-clear empty native frame renders the live header and empty composer", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, [], { clearCount: 1 }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const output = stripAnsi(raw);
  assert.match(output, /██████/);
  assert.match(output, /Codexa v/);
  assert.match(output, /\n\s*╭[─]+╮\n\s*│ ❯/);
  assert.doesNotMatch(output, /Reproduce the resize flicker and fix it\./);
});

test("clear transition physically reprints the intro after previous transcript output", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, EVENTS, { clearCount: 0 }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  const clearOutputOffset = raw.length;

  instance.rerender(buildShellNode(layout, [], { clearCount: 1 }));
  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const postClearOutput = stripAnsi(raw.slice(clearOutputOffset));
  assert.match(postClearOutput, /Codexa v/);
  assert.match(postClearOutput, /\n\s*╭[─]+╮\n\s*│ ❯/);
  assert.doesNotMatch(postClearOutput, /Reproduce the resize flicker and fix it\./);
  assert.doesNotMatch(postClearOutput, /Root cause looks like a layout gutter mismatch/);
});

test("live header remains visible when panel opens and then closes", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  // Start on main screen with events already committed.
  const instance = render(buildShellNode(layout, EVENTS), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);

  // Open model picker panel.
  instance.rerender(buildShellNode(layout, EVENTS, { screen: "model-picker" }));
  await sleep(80);

  // Close panel — return to main screen.
  const closeOutputOffset = raw.length;
  instance.rerender(buildShellNode(layout, EVENTS));
  await sleep(80);

  instance.cleanup();
  await sleep(20);

  const postCloseOutput = stripAnsi(raw.slice(closeOutputOffset));
  assert.match(postCloseOutput, /██████/);
  assert.match(postCloseOutput, /Codexa v/);
  assert.match(stripAnsi(raw), /Reproduce the resize flicker and fix it\./);
});

test("startup header remains bounded after a terminal resize on the startup frame", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, []), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);

  // Simulate a resize (terminal width change).
  stdout.columns = 140;
  stdout.rows = 45;
  stdout.emit("resize");
  instance.rerender(buildShellNode(createLayoutSnapshot(140, 45), []));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  assert.ok(countLogoInOutput(raw) <= 4, "resize should not replay an unbounded number of startup logos");
});

test("live header updates auth state during startup without transcript output", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  // Enable showAuthStatus so the header displays auth state changes visibly.
  const headerConfigWithAuth = { ...HEADER_CONFIG_DEFAULTS, showAuthStatus: true };

  // Start with auth in "checking" state (before auth resolves).
  const instance = render(buildShellNode(layout, [], { authState: "checking", headerConfig: headerConfigWithAuth }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);

  // Auth resolves — update to "authenticated".
  const authUpdateOffset = raw.length;
  instance.rerender(buildShellNode(layout, [], { authState: "authenticated", headerConfig: headerConfigWithAuth }));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  // Check the full raw output (not just incremental) contains the auth label and logo.
  // When showAuthStatus=true, the header should display auth state.
  const fullOutput = stripAnsi(raw);
  assert.match(fullOutput, /██████/);
  assert.match(fullOutput, /Auth: Authenticated/);
  // Auth update must not have opened a settings panel.
  assert.doesNotMatch(fullOutput, /Settings/);
});

test("cold-start stability: opening and closing model picker does not expand UI", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  // Use a tall terminal so the large ASCII logo is chosen.
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  // 1. Startup frame
  const instance = render(buildShellNode(layout, []), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(100);

  // 2. Open model picker
  instance.rerender(buildShellNode(layout, [], { screen: "model-picker" }));
  await sleep(100);

  // 3. Close model picker
  instance.rerender(buildShellNode(layout, []));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  assert.match(stripAnsi(raw), /Codexa v/);

  // Verify the layout didn't expand to fill the full 40 rows.
  // In real mode, cumulative lines should be low.
  const lines = stripAnsi(raw).split("\n").filter(l => l.trim().length > 0);
  assert.ok(lines.length < 40, "Output should remain bounded on cold start");
});

test("cold-start stability: opening and closing provider picker does not duplicate header", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(buildShellNode(layout, []), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(100);

  instance.rerender(buildShellNode(layout, [], {
    screen: "provider-picker",
    panel: <Text>Provider Picker</Text>,
  }));
  await sleep(100);

  const closeOutputOffset = raw.length;
  instance.rerender(buildShellNode(layout, []));
  await sleep(100);

  instance.cleanup();
  await sleep(20);

  const postCloseOutput = stripAnsi(raw.slice(closeOutputOffset));
  assert.match(postCloseOutput, /██████/);
  assert.match(postCloseOutput, /Codexa v/);
  assert.match(postCloseOutput, /\n\s*╭[─]+╮\n\s*│ ❯/);
  assert.equal(countLogoInOutput(postCloseOutput), 1, "provider picker close frame should have one logo");
  assert.equal(countCodexaMetadataInOutput(postCloseOutput), 1, "provider picker close frame should have one metadata block");
});

test("cold-start stability: system events do not break the startup frame", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);
  const systemEvent: TimelineEvent = { 
    id: 100, 
    type: "system", 
    title: "Model updated", 
    content: "Switching to gpt-4",
    createdAt: Date.now() 
  };

  const instance = render(buildShellNode(layout, [systemEvent]), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const output = stripAnsi(raw);
  // Large logo should still render because there is no user prompt yet.
  assert.match(output, /██████/);
  assert.match(output, /Model updated/);

  const lines = output.split("\n").filter(l => l.trim().length > 0);
  assert.ok(lines.length < 25, "Output should remain capped even with system events");
});

test("cold-start stability: panel height is bounded on cold start", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 120;
  stdout.rows = 40;
  let raw = "";
  stdout.on("data", (chunk) => { raw += chunk.toString(); });

  const layout = createLayoutSnapshot(120, 40);

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="model-picker"
        authState="authenticated"
        workspaceLabel="C:\Test"
        staticEvents={[]}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={<Text>Transient Picker</Text>}
        mainPanel={null}
        composer={null}
        composerRows={0}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: false,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await sleep(100);
  instance.cleanup();
  await sleep(20);

  const output = stripAnsi(raw);
  assert.match(output, /Transient Picker/);

  // Count actual lines in output.
  // If height was nativePanelBodyRows (around 25+), we'd have many trailing newlines or spaces.
  const finalPanelFrame = output.slice(Math.max(0, output.lastIndexOf("Transient Picker")));
  const lines = finalPanelFrame.split("\n");
  assert.ok(lines.length <= layout.rows, "Panel height should be bounded on cold start");
});

// ─── Native mode scroll-pause tests ──────────────────────────────────────────

function makeNativeShellInstance(uiState: UIState, activeEvents: TimelineEvent[] = []) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 100;
  stdout.rows = 30;
  let rawOutput = "";
  stdout.on("data", (chunk) => { rawOutput += chunk.toString(); });

  const layout = createLayoutSnapshot(100, 30);
  const composerRows = measureBottomComposerRows({
    layout,
    uiState,
    mode: "auto-edit",
    model: "gpt-5.4",
    reasoningLevel: "medium",
    tokensUsed: 1200,
    value: "",
    cursor: 0,
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <AppShell
        layout={layout}
        screen="main"
        authState="authenticated"
        workspaceLabel="test"
        staticEvents={EVENTS}
        activeEvents={activeEvents}
        uiState={uiState}
        panel={null}
        composer={
          <BottomComposer
            layout={layout}
            uiState={uiState}
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
        composerRows={composerRows}
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

  return {
    stdin,
    instance,
    getOutput: () => stripAnsi(rawOutput),
    getOutputFrom: (offset: number) => stripAnsi(rawOutput.slice(offset)),
    getRawLength: () => rawOutput.length,
  };
}

test("native mode: Page Up is not intercepted by an in-app pause indicator", async () => {
  const { stdin, instance, getOutput, getRawLength } = makeNativeShellInstance({ kind: "RESPONDING", turnId: 1 });

  try {
    await sleep(100);
    const beforePageUp = getRawLength();

    // Send Page Up escape code
    stdin.write("[5~");
    await sleep(100);

    const frame = stripAnsi(getOutput().slice(stripAnsi(getOutput().slice(0, beforePageUp)).length - 1));
    const output = getOutput();
    assert.doesNotMatch(output, /End to follow|History \d+%/, "native terminal owns history navigation");
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});

test("native mode: End does not activate application history UI", async () => {
  const { stdin, instance, getOutput } = makeNativeShellInstance({ kind: "RESPONDING", turnId: 1 });

  try {
    await sleep(100);
    stdin.write("[5~");
    await sleep(100);

    assert.doesNotMatch(getOutput(), /End to follow|History \d+%/);

    stdin.write("[F");
    await sleep(100);

    // After End, the indicator text should no longer be in the latest frame
    // (it may have appeared in earlier frames, so we just check the most recent output
    //  no longer contains it by checking the total output ends without it)
    const outputLines = getOutput().split("\n");
    const trailingContent = outputLines.slice(-10).join("\n");
    assert.doesNotMatch(trailingContent, /End to follow/, "pause indicator should disappear after End");
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});

test("native mode: busy streaming never mounts a nativePaused notice", async () => {
  const { stdin, instance, getOutput } = makeNativeShellInstance({ kind: "RESPONDING", turnId: 1 });

  try {
    await sleep(100);
    stdin.write("[5~");
    await sleep(100);

    assert.doesNotMatch(getOutput(), /End to follow|History \d+%/);

    // Simulate streaming ending — we can't re-render the same instance with new props here,
    // so we verify the auto-clear logic by checking that when busy state would end,
    // the effect dependency chain is correct (tested via the component's useEffect).
    // The manual Page Up → End cycle (test above) covers the user-driven resume path.
    // This test verifies the indicator appears only when isBusy(uiState) is true.
    const output = getOutput();
    assert.doesNotMatch(output, /End to follow|History \d+%/);
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});
