import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import {
  AttachmentImportPanel,
  compactHomePath,
  type PendingImportFile,
} from "./AttachmentImportPanel.js";
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

function stripAnsi(value: string): string {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const TEST_FILE: PendingImportFile = {
  srcPath: "C:\\Users\\jorda\\OneDrive\\Screenshots\\Screenshot 2026-05-18.png",
  rawPath: "C:\\Users\\jorda\\OneDrive\\Screenshots\\Screenshot 2026-05-18.png",
  destFilename: "Screenshot 2026-05-18.png",
  isImage: true,
};

const ATTACHMENTS_DIR = "C:\\Users\\jorda\\AppData\\Local\\Ubume\\workspaces\\example1\\attachments";
const WORKSPACE_ROOT = "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal";

test("compactHomePath abbreviates attachment paths below the home directory", () => {
  assert.equal(
    compactHomePath(
      "/home/k9-vortex/.local/share/ubume/workspaces/example/attachments",
      "/home/k9-vortex",
    ),
    "~/.local/share/ubume/workspaces/example/attachments",
  );
});

interface HarnessState {
  confirmed: number;
  cancelled: number;
}

function AttachmentImportPanelHarness({
  files = [TEST_FILE],
  modelSupportsVision = null,
}: {
  files?: PendingImportFile[];
  modelSupportsVision?: boolean | null;
}) {
  const [state, setState] = React.useState<HarnessState>({ confirmed: 0, cancelled: 0 });

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <AttachmentImportPanel
          focusId="import-confirmation"
          files={files}
          attachmentsDir={ATTACHMENTS_DIR}
          workspaceRoot={WORKSPACE_ROOT}
          modelSupportsVision={modelSupportsVision}
          onConfirm={() => setState((s) => ({ ...s, confirmed: s.confirmed + 1 }))}
          onCancel={() => setState((s) => ({ ...s, cancelled: s.cancelled + 1 }))}
        />
        <Text>{`confirmed:${state.confirmed}`}</Text>
        <Text>{`cancelled:${state.cancelled}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

test("AttachmentImportPanel renders filename and destination path", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    const output = harness.getOutput();
    assert.match(output, /Screenshot 2026-05-18\.png/);
    assert.match(output, /AppData.*Ubume.*attachments/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel Enter key calls onConfirm", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    harness.stdin.write("\r");
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /confirmed:1/);
    assert.match(output, /cancelled:0/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel Esc key calls onCancel", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    harness.stdin.write("");
    await sleep(80);
    const output = harness.getOutput();
    assert.match(output, /confirmed:0/);
    assert.match(output, /cancelled:1/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel keeps both import actions on one row", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    assert.match(harness.getOutput(), /› Import once\s+·\s+Cancel/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel navigates horizontally to Cancel", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    harness.stdin.write("\u001b[C");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    assert.match(harness.getOutput(), /cancelled:1/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel ignores vertical navigation", async () => {
  const harness = createInkHarness(<AttachmentImportPanelHarness />);
  try {
    await sleep();
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(80);
    assert.match(harness.getOutput(), /confirmed:1/);
    assert.match(harness.getOutput(), /cancelled:0/);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel shows vision warning when modelSupportsVision is false and file is image", async () => {
  const harness = createInkHarness(
    <AttachmentImportPanelHarness modelSupportsVision={false} />,
  );
  try {
    await sleep();
    const output = harness.getOutput();
    assert.match(output, /active model may not support images/i);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel does NOT show vision warning when modelSupportsVision is null", async () => {
  const harness = createInkHarness(
    <AttachmentImportPanelHarness modelSupportsVision={null} />,
  );
  try {
    await sleep();
    const output = harness.getOutput();
    assert.doesNotMatch(output, /active model may not support images/i);
  } finally {
    await harness.cleanup();
  }
});

test("AttachmentImportPanel does NOT show vision warning for non-image file even when modelSupportsVision is false", async () => {
  const textFile: PendingImportFile = {
    srcPath: "C:\\Users\\jorda\\Documents\\notes.txt",
    rawPath: "C:\\Users\\jorda\\Documents\\notes.txt",
    destFilename: "notes.txt",
    isImage: false,
  };
  const harness = createInkHarness(
    <AttachmentImportPanelHarness files={[textFile]} modelSupportsVision={false} />,
  );
  try {
    await sleep();
    const output = harness.getOutput();
    assert.doesNotMatch(output, /active model may not support images/i);
  } finally {
    await harness.cleanup();
  }
});
