import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { ThemeProvider } from "../theme.js";
import { UpdateAvailableCard, UPDATE_CARD_ROWS, UPDATE_CARD_CONTENT_ROWS } from "./UpdateAvailableCard.js";
import { getTextWidth } from "../render/textLayout.js";

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
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderCard(
  latestVersion: string,
  currentVersion: string,
  width?: number,
  updateCommand?: string,
): Promise<string> {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <UpdateAvailableCard
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        width={width}
        updateCommand={updateCommand}
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

test("UPDATE_CARD_ROWS equals UPDATE_CARD_CONTENT_ROWS + 2 border rows", () => {
  assert.equal(UPDATE_CARD_ROWS, UPDATE_CARD_CONTENT_ROWS + 2);
  assert.equal(UPDATE_CARD_CONTENT_ROWS, 4);
  assert.equal(UPDATE_CARD_ROWS, 6);
});

test("card renders all four content lines", async () => {
  const output = await renderCard("1.0.3", "1.0.2");

  assert.match(output, /Update available/);
  assert.match(output, /Ubume v1\.0\.3/);
  assert.match(output, /Using v1\.0\.2/);
  assert.match(output, /npm install -g/);
});

test("card renders the supplied package-manager command", async () => {
  const output = await renderCard("1.0.3", "1.0.2", undefined, "bun add -g @golba98/ubume@latest");

  assert.match(output, /bun add -g @golba98\/ubume@latest/);
  assert.doesNotMatch(output, /npm install -g/);
});

test("card renders round border glyphs", async () => {
  const output = await renderCard("1.0.3", "1.0.2");

  assert.match(output, /[╭╰]/, "round border top-left and bottom-left corners should appear");
});

test("card with width clamps long lines to fit inside the box", async () => {
  const cardWidth = 40;
  const output = await renderCard("1.0.3", "1.0.2", cardWidth);

  // The install command is long; with width=40 the inner content width is 38.
  // clampVisualText should truncate it — the full command should not appear.
  const fullCommand = "npm install -g @golba98/ubume@latest";
  assert.doesNotMatch(output, new RegExp(escapeRegExp(fullCommand)), "long command should be clamped to fit card width");
  // But the card content should still be present (just truncated)
  assert.match(output, /npm install/, "truncated command prefix should still appear");
});

test("regex escaping handles every special character occurrence", () => {
  const dangerous = "ubume.+*?^${}()|[]\\ ubume.+*?^${}()|[]\\";
  const escaped = escapeRegExp(dangerous);
  const matcher = new RegExp(escaped);

  assert.match(dangerous, matcher);
  assert.equal((escaped.match(/\\\./g) ?? []).length, 2);
  assert.equal((escaped.match(/\\\$/g) ?? []).length, 2);
  assert.equal((escaped.match(/\\\\/g) ?? []).length >= 2, true);
});

test("card without width renders without truncation", async () => {
  const output = await renderCard("2.0.0", "1.9.9");

  // Full command should be present when no width constraint
  assert.match(output, /@latest/);
  assert.match(output, /2\.0\.0/);
  assert.match(output, /1\.9\.9/);
});

test("card handles unusual version strings gracefully", async () => {
  const output = await renderCard("10.20.300", "9.99.999");

  assert.match(output, /10\.20\.300/);
  assert.match(output, /9\.99\.999/);
});
