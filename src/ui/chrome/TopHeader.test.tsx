import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { CodexAuthState } from "../../core/auth/codexAuth.js";
import { buildRuntimeSummary } from "../../config/runtimeConfig.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { createLayoutSnapshot } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import {
  getHeaderHeroLayout,
  HEADER_WORDMARK_LINES,
  measureTopHeaderRows,
  selectHeaderLogo,
  shortenHeaderWorkspaceLabel,
  TopHeader,
  type UpdateAvailableInfo,
} from "./TopHeader.js";
import { LOGO_LARGE, LOGO_MEDIUM, LOGO_MEDIUM_MIN_COLS, LOGO_LARGE_MIN_COLS } from "../render/logoVariants.js";
import { APP_VERSION, formatWorkspaceDisplayPath, HEADER_CONFIG_DEFAULTS } from "../../config/settings.js";
import type { HeaderConfig } from "../../config/settings.js";

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

const HEADER_CONFIG_WITH_AUTH: HeaderConfig = {
  ...HEADER_CONFIG_DEFAULTS,
  showAuthStatus: true,
  showContext: true,
};

const MOCK_UPDATE: UpdateAvailableInfo = {
  latestVersion: "1.0.3",
  currentVersion: "1.0.2",
};

async function renderHeader(cols: number, authState: CodexAuthState, headerConfig?: HeaderConfig): Promise<string> {
  return renderHeaderWithWorkspace(cols, authState, "C:\\Development\\1-JavaScript\\13-Custom CLI", headerConfig);
}

async function renderHeaderWithWorkspace(
  cols: number,
  authState: CodexAuthState,
  workspaceLabel: string,
  headerConfig: HeaderConfig = HEADER_CONFIG_DEFAULTS,
  updateAvailable?: UpdateAvailableInfo | null,
): Promise<string> {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = cols;
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(
    <ThemeProvider theme="purple">
      <TopHeader
        authState={authState}
        workspaceLabel={workspaceLabel}
        layout={createLayoutSnapshot(cols, 40)}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        headerConfig={headerConfig}
        updateAvailable={updateAvailable}
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

async function renderHeaderWithUpdate(cols: number, updateAvailable: UpdateAvailableInfo | null): Promise<string> {
  return renderHeaderWithWorkspace(cols, "authenticated", "C:\\Development\\1-JavaScript\\13-Custom CLI", HEADER_CONFIG_WITH_AUTH, updateAvailable);
}

test("full mode renders wordmark at wide terminal", async () => {
  const output = await renderHeader(140, "authenticated", HEADER_CONFIG_WITH_AUTH);

  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(140, 40)).mode, "wide");
  assert.match(output, /[█╔╗╚╝═║]/);
  assert.match(output, new RegExp(`Ubume v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /Authenticated/);
  assert.match(output, /Workspace:\s*C:\\Development\\1-JavaScript\\13-Custom CLI/);
  assert.match(output, /Provider:\s*Ubume Core/);
  assert.doesNotMatch(output, /Model:/);
  assert.doesNotMatch(output, /Context:/);
  assert.doesNotMatch(output, /Reasoning:/);
  assert.doesNotMatch(output, /Runtime:/);
  assert.doesNotMatch(output, /Net:\s*off/i);
  assert.doesNotMatch(output, /Roots:\s*0/i);
  assert.doesNotMatch(output, /FULL AUTO/i);
  assert.doesNotMatch(output, /Workspace write/i);
  assert.doesNotMatch(output, /On request/i);
});

test("local-dev channel makes header version obvious", async () => {
  const previous = process.env.UBUME_CHANNEL;
  process.env.UBUME_CHANNEL = "local-dev";
  try {
    const output = await renderHeader(130, "authenticated", HEADER_CONFIG_WITH_AUTH);
    assert.match(output, new RegExp(`Ubume v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-dev local`));
  } finally {
    if (previous === undefined) {
      delete process.env.UBUME_CHANNEL;
    } else {
      process.env.UBUME_CHANNEL = previous;
    }
  }
});

test("wide header centers metadata beside the logo with a clear column gap", async () => {
  const output = await renderHeader(140, "authenticated", HEADER_CONFIG_WITH_AUTH);
  const rows = output.split("\n");
  const firstLogoRow = rows.findIndex((row) => row.includes("██╗"));
  const brandRow = rows.findIndex((row) => row.includes(`Ubume v${APP_VERSION}`));
  const workspaceRow = rows.findIndex((row) => row.includes("Workspace:"));

  assert.ok(firstLogoRow >= 0, "logo should render");
  assert.ok(brandRow >= firstLogoRow && brandRow <= firstLogoRow + 2, "metadata should be vertically centered within the logo block");
  assert.equal(workspaceRow, brandRow + 2, "workspace should sit below auth in the metadata block");
  assert.ok((rows[brandRow]?.indexOf(`Ubume v${APP_VERSION}`) ?? -1) >= 49, "metadata should have a visible left gap from the logo");
});

test("version and workspace metadata rows have a visible gap between them", async () => {
  const output = await renderHeader(140, "authenticated", {
    ...HEADER_CONFIG_DEFAULTS,
    showProvider: false,
    showModel: false,
  });
  const rows = output.split("\n");
  const brandRow = rows.findIndex((row) => row.includes(`Ubume v${APP_VERSION}`));
  const workspaceRow = rows.findIndex((row) => row.includes("Workspace:"));

  assert.ok(brandRow >= 0, "brand line should render");
  assert.ok(workspaceRow > brandRow + 1, "workspace should not be immediately adjacent to version");
  assert.equal(workspaceRow, brandRow + 2, "workspace is exactly 2 rows below brand — 1 blank gap row separates them");
});

test("normal header keeps metadata beside the canonical logo with compact truncation", async () => {
  const output = await renderHeaderWithWorkspace(
    100,
    "authenticated",
    "C:\\Development\\1-JavaScript\\13-Custom CLI\\packages\\really-long-subfolder\\nested\\workspace",
    HEADER_CONFIG_WITH_AUTH,
  );
  const rows = output.split("\n");
  const brandRow = rows.findIndex((row) => row.includes(`Ubume v${APP_VERSION}`));
  const firstLogoRow = rows.findIndex((row) => row.includes("██╗"));
  const workspaceRow = rows.find((row) => row.includes("Workspace:")) ?? "";

  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(100, 40)).mode, "medium");
  assert.ok(firstLogoRow >= 0, "logo should render");
  assert.ok(brandRow >= firstLogoRow && brandRow <= firstLogoRow + 2, "metadata should stay beside the logo");
  assert.match(workspaceRow, /Workspace:\s*…\\workspace/);
  assert.doesNotMatch(output, /____|\/ ___\||\|_\|/, "thin ASCII logo must not render in the header");
  assert.ok((rows[brandRow]?.indexOf(`Ubume v${APP_VERSION}`) ?? -1) >= 47, "normal metadata should retain a compact gap from the canonical logo");
});

test("compact header uses text-only identity instead of logo art", async () => {
  const output = await renderHeader(65, "authenticated", HEADER_CONFIG_WITH_AUTH);

  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(65, 40)).mode, "compact");
  assert.match(output, /Ubume/);
  assert.match(output, new RegExp(`v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(output, /[█╔╗╚╝═║]/);
  assert.doesNotMatch(output, /____/);
});

test("header wordmark lines never contain metadata text", () => {
  const wordmarkText = HEADER_WORDMARK_LINES.join("\n");

  assert.doesNotMatch(wordmarkText, /Ubume v/);
  assert.doesNotMatch(wordmarkText, /Workspace:/);
  assert.doesNotMatch(wordmarkText, /Auth:/);
});

test("normal mode renders canonical logo, version, and auth", async () => {
  const output = await renderHeader(105, "authenticated", HEADER_CONFIG_WITH_AUTH);

  assert.match(output, /██╗/);
  assert.doesNotMatch(output, /____|\/ ___\||\|_\|/);
  assert.match(output, new RegExp(`v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /Authenticated/);
  assert.match(output, /Workspace:\s*(?:.*\\)?13-Custom CLI/);
  assert.match(output, /Provider:\s*Ubume Core/);
  assert.doesNotMatch(output, /Model:/);
  assert.doesNotMatch(output, /Context:/);
  assert.doesNotMatch(output, /Reasoning:/);
  assert.doesNotMatch(output, /Runtime:/);
  assert.doesNotMatch(output, /Net:\s*off/i);
  assert.doesNotMatch(output, /Roots:\s*0/i);
  assert.doesNotMatch(output, /FULL AUTO/i);
});

test("micro mode renders version and auth", async () => {
  const output = await renderHeader(50, "authenticated", HEADER_CONFIG_WITH_AUTH);

  assert.match(output, /Ubume/);
  assert.match(output, new RegExp(`v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(output, /[█╔╗╚╝═║]/);
  assert.match(output, /Provider/);
  assert.doesNotMatch(output, /Model:/);
  assert.doesNotMatch(output, /Context:/);
});

test("full mode always shows wordmark regardless of activity", async () => {
  const output = await renderHeader(180, "authenticated", HEADER_CONFIG_WITH_AUTH);

  assert.match(output, /[█╔╗╚╝═║]/);
  assert.match(output, new RegExp(`Ubume v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /Authenticated/);
  assert.match(output, /Workspace:\s*C:\\Development\\1-JavaScript\\13-Custom CLI/);
  assert.doesNotMatch(output, /Runtime:/);
});

test("full mode renders Checking for checking auth state", async () => {
  const output = await renderHeader(130, "checking", HEADER_CONFIG_WITH_AUTH);
  assert.match(output, /Checking/);
  assert.doesNotMatch(output, /Auth:\s*Unknown/);
});

test("compact mode preserves workspace truncation with runtime text", async () => {
  const output = await renderHeaderWithWorkspace(
    80,
    "authenticated",
    "C:\\Development\\1-JavaScript\\13-Custom CLI\\packages\\really-long-subfolder\\nested\\workspace",
  );

  assert.match(output, /Workspace:/);
  assert.doesNotMatch(output, /packages\\really-long-subfolder/);
  assert.match(output, /Provider:\s*Ubume Core/);
  assert.doesNotMatch(output, /Model:/);
});

test("shortens long workspace paths to the leaf segment", () => {
  assert.equal(
    shortenHeaderWorkspaceLabel("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", 24),
    "…\\13-Custom-CLI-Normal",
  );
});

test("header layout changes when width changes without duplicating the component", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 130;
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const buildHeader = (cols: number) => (
    <ThemeProvider theme="purple">
      <TopHeader
        authState="authenticated"
        workspaceLabel="C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal"
        layout={createLayoutSnapshot(cols, 40)}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        headerConfig={HEADER_CONFIG_WITH_AUTH}
      />
    </ThemeProvider>
  );

  const instance = render(buildHeader(130), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await sleep(60);
  output = "";
  stdout.columns = 100;
  instance.rerender(buildHeader(100));
  await sleep(60);

  instance.cleanup();
  await sleep(20);

  const rows = stripAnsi(output).split("\n");
  const brandRows = rows.filter((row) => row.includes(`Ubume v${APP_VERSION}`));
  const firstLogoRow = rows.findIndex((row) => row.includes("██╗"));
  const firstBrandRow = rows.findIndex((row) => row.includes(`Ubume v${APP_VERSION}`));

  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(100, 40), HEADER_CONFIG_WITH_AUTH).mode, "medium");
  assert.ok(firstBrandRow >= firstLogoRow, "rerendered medium header should show metadata beside or aligned with logo");
  assert.ok(brandRows.length <= 2, "rerender should not duplicate unbounded header instances");
});

test("renders configured workspace display labels", async () => {
  const workspaceRoot = "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal";

  const dirOutput = await renderHeaderWithWorkspace(
    130,
    "authenticated",
    formatWorkspaceDisplayPath(workspaceRoot, "dir"),
  );
  assert.match(dirOutput, /Workspace:\s*(?:.*\\)?13-Custom-CLI-Normal/);

  const nameOutput = await renderHeaderWithWorkspace(
    130,
    "authenticated",
    formatWorkspaceDisplayPath(workspaceRoot, "name"),
  );
  assert.match(nameOutput, /Workspace:\s*Ubume/);

  const simpleOutput = await renderHeaderWithWorkspace(
    130,
    "authenticated",
    formatWorkspaceDisplayPath(workspaceRoot, "simple"),
  );
  assert.match(simpleOutput, /Workspace:\s*(?:.*\\)?13-Custom-CLI-Normal/);
});

// ─── Layout threshold tests ───────────────────────────────────────────────────

test("71 cols selects compact text-only mode", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(71, 40)).mode, "compact");
});

test("60 cols selects compact text-only mode", () => {
  const layout60 = getHeaderHeroLayout(createLayoutSnapshot(60, 40));
  assert.equal(layout60.mode, "compact");
});

test("100 cols selects medium mode (at MEDIUM_HEADER_MIN_COLUMNS threshold)", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(100, 40)).mode, "medium");
});

test("140 cols selects wide mode", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(140, 40)).mode, "wide");
});

test("LOGO_LARGE rows never exceed the minimum columns needed to render them", () => {
  for (const row of LOGO_LARGE) {
    assert.ok(row.length <= LOGO_LARGE_MIN_COLS + 4, `LOGO_LARGE row is unexpectedly wide: "${row}"`);
  }
});

// ─── Rows-aware header degradation tests ──────────────────────────────────────

test("100x21 keeps a normal logo header instead of collapsing to compact", () => {
  const layout = getHeaderHeroLayout(createLayoutSnapshot(100, 21));
  assert.equal(layout.mode, "medium");
  assert.equal(layout.logoRows, LOGO_LARGE.length, "normal terminals should keep the canonical block wordmark");
});

test("normal, wide, and max header modes select the same canonical logo", () => {
  assert.equal(selectHeaderLogo(createLayoutSnapshot(100, 21)), LOGO_LARGE);
  assert.equal(selectHeaderLogo(createLayoutSnapshot(140, 30)), LOGO_LARGE);
  assert.equal(selectHeaderLogo(createLayoutSnapshot(180, 45)), LOGO_LARGE);
  assert.deepEqual(selectHeaderLogo(createLayoutSnapshot(80, 24)), LOGO_LARGE);
  assert.deepEqual(selectHeaderLogo(createLayoutSnapshot(71, 24)), []);
  assert.deepEqual(selectHeaderLogo(createLayoutSnapshot(39, 13)), []);
  assert.notEqual(selectHeaderLogo(createLayoutSnapshot(100, 21)), LOGO_MEDIUM);
});

test("full header is selected when both columns and rows are sufficient", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(140, 40)).mode, "wide");
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(120, 30)).mode, "medium");
});

test("compact mode only fires when the terminal is genuinely too small for any logo", () => {
  const layout = getHeaderHeroLayout(createLayoutSnapshot(40, 40));
  assert.equal(layout.mode, "compact");
});

test("compact mode is one identity row and measurement matches", () => {
  const layout = createLayoutSnapshot(40, 40);
  const hero = getHeaderHeroLayout(layout);
  assert.equal(hero.mode, "compact");
  assert.equal(hero.compactHintRows, 0, "compact mode should not reserve a hint row");
  assert.equal(measureTopHeaderRows(layout), hero.totalRows);
});

test("compact mode renders a deliberate one-line header with accent", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 40;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });

  const instance = render(
    <ThemeProvider theme="purple">
      <TopHeader
        authState="authenticated"
        workspaceLabel="C:\\Development\\1-JavaScript\\13-Custom CLI"
        layout={createLayoutSnapshot(40, 40)}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        headerConfig={HEADER_CONFIG_DEFAULTS}
        updateAvailable={null}
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

  const text = stripAnsi(output);
  assert.match(text, /✦/, "compact header should show the ✦ accent");
  assert.doesNotMatch(text, /Resize to ≥72×24/, "compact header should not show a recommended-size hint");
});

test("UBUME_NO_ASCII_LOGO compact header omits the resize hint row", () => {
  process.env["UBUME_NO_ASCII_LOGO"] = "1";
  try {
    // With ASCII art disabled, compact is intentional at any size — no nag hint.
    const hero = getHeaderHeroLayout(createLayoutSnapshot(120, 40));
    assert.equal(hero.mode, "compact");
    assert.equal(hero.compactHintRows, 0);
  } finally {
    delete process.env["UBUME_NO_ASCII_LOGO"];
  }
});

// ─── Update card tests ────────────────────────────────────────────────────────

test("wide mode with update available renders update card in right column", async () => {
  const output = await renderHeaderWithUpdate(140, MOCK_UPDATE);

  // Round-border box uses ╭ and ╰
  assert.match(output, /[╭╰]/, "update card border should appear");
  assert.match(output, /Update available/, "card title should appear");
  assert.match(output, /Ubume v1\.0\.3/, "latest version should appear");
  assert.match(output, /Using v1\.0\.2/, "current version should appear");
});

test("medium mode with update available renders update card in right column", async () => {
  const output = await renderHeaderWithUpdate(100, MOCK_UPDATE);

  assert.match(output, /[╭╰]/, "update card border should appear at 100 cols");
  assert.match(output, /Update available/);
  assert.match(output, /Ubume v1\.0\.3/);
});

test("compact mode with update available omits the update card", async () => {
  const output = await renderHeaderWithUpdate(65, MOCK_UPDATE);

  assert.doesNotMatch(output, /[╭╰]/, "no card border in narrow mode");
  assert.doesNotMatch(output, /Ubume v1\.0\.3/, "compact header should not spend rows on update notice");
});

test("wide mode without update shows no update notice", async () => {
  const output = await renderHeaderWithUpdate(140, null);

  assert.doesNotMatch(output, /Update available/);
  assert.doesNotMatch(output, /[╭╰]/);
});

test("measureTopHeaderRows increases when hasUpdate is true in side-by-side mode", () => {
  const layout = createLayoutSnapshot(140, 40);
  const withoutUpdate = measureTopHeaderRows(layout, HEADER_CONFIG_DEFAULTS, false);
  const withUpdate = measureTopHeaderRows(layout, HEADER_CONFIG_DEFAULTS, true);

  assert.ok(withUpdate > withoutUpdate, `totalRows with update (${withUpdate}) should exceed without (${withoutUpdate})`);
});

test("measureTopHeaderRows increases when hasUpdate is true in medium mode", () => {
  const layout = createLayoutSnapshot(100, 40);
  const withoutUpdate = measureTopHeaderRows(layout, HEADER_CONFIG_DEFAULTS, false);
  const withUpdate = measureTopHeaderRows(layout, HEADER_CONFIG_DEFAULTS, true);

  assert.ok(withUpdate > withoutUpdate, `totalRows with update (${withUpdate}) should exceed without (${withoutUpdate}) in medium mode`);
});

// ─── Responsive threshold parity tests ──────────────────────────────────────

test("80 cols selects narrow mode and renders logo art with metadata below", async () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(80, 40)).mode, "narrow");

  const output = await renderHeader(80, "authenticated", HEADER_CONFIG_WITH_AUTH);
  assert.match(output, /[█╔╗╚╝═║]/);
  assert.doesNotMatch(output, /____/);
  assert.match(output, /Ubume/);
});

test("70 cols selects compact mode and renders no logo art", async () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(70, 40)).mode, "compact");

  const output = await renderHeader(70, "authenticated", HEADER_CONFIG_WITH_AUTH);
  assert.doesNotMatch(output, /[█╔╗╚╝═║]/);
  assert.doesNotMatch(output, /____/);
  assert.match(output, /Ubume/);
});

test("95 cols is the minimum for placing metadata beside logo", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(95, 40)).mode, "medium", "95 → medium layout with canonical logo beside metadata");
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(94, 40)).mode, "narrow", "94 → narrow layout with logo and metadata below");
});

test("71 cols selects compact mode", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(71, 40)).mode, "compact");
});

// ─── Canonical wordmark regression tests ─────────────────────────────────────

test("normal canonical wordmark renders at 100 cols without thin ASCII fallback", async () => {
  const output = await renderHeader(100, "authenticated", HEADER_CONFIG_DEFAULTS);
  assert.match(output, /██╗/, "canonical block wordmark must appear at 100 cols");
  assert.doesNotMatch(output, /____|\/ ___\||\|_\|/, "thin ASCII wordmark must not appear at 100 cols");
});

test("LOGO_LARGE block wordmark renders at 140 cols", async () => {
  const output = await renderHeader(140, "authenticated", HEADER_CONFIG_DEFAULTS);
  assert.match(output, /[█╔╗╚╝═║]/, "block wordmark must appear at wide terminal");
});

test("compact layout at 48 cols shows accent line — not thin ASCII art", async () => {
  const output = await renderHeader(48, "authenticated", HEADER_CONFIG_DEFAULTS);
  assert.doesNotMatch(output, /____/, "thin ASCII art must never appear in any header path");
});

test("model line does not render in the header even when showModel is true", async () => {
  const runtimeWithModel = {
    ...buildRuntimeSummary(TEST_RUNTIME),
    modelLabel: "qwen3-27b",
  };
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 130;
  let output = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const instance = render(
    <ThemeProvider theme="purple">
      <TopHeader
        authState="authenticated"
        workspaceLabel="test-workspace"
        layout={createLayoutSnapshot(130, 40)}
        runtimeSummary={runtimeWithModel}
        headerConfig={{ ...HEADER_CONFIG_DEFAULTS, showModel: true }}
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  instance.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stripped = stripAnsi(output);
  assert.match(stripped, /Provider:\s*Ubume Core/);
  assert.doesNotMatch(stripped, /Model:/, "Model belongs below the composer, not in the header");
});

test("context line does not render in the header even when contextLabel is provided", async () => {
  const runtimeWithContext = {
    ...buildRuntimeSummary(TEST_RUNTIME),
    contextLabel: "0 / 128k",
  };
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 130;
  let output = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const instance = render(
    <ThemeProvider theme="purple">
      <TopHeader
        authState="authenticated"
        workspaceLabel="test-workspace"
        layout={createLayoutSnapshot(130, 40)}
        runtimeSummary={runtimeWithContext}
        headerConfig={{ ...HEADER_CONFIG_DEFAULTS, showContext: true }}
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  instance.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stripped = stripAnsi(output);
  assert.match(stripped, /Provider:\s*Ubume Core/);
  assert.doesNotMatch(stripped, /Context:/, "Context belongs below the composer, not in the header");
});

test("header does not render fallback unknown context", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = 130;
  let output = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const instance = render(
    <ThemeProvider theme="purple">
      <TopHeader
        authState="authenticated"
        workspaceLabel="test-workspace"
        layout={createLayoutSnapshot(130, 40)}
        runtimeSummary={buildRuntimeSummary(TEST_RUNTIME)}
        headerConfig={{ ...HEADER_CONFIG_DEFAULTS, showContext: true }}
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  instance.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stripped = stripAnsi(output);
  assert.doesNotMatch(stripped, /Context:\s*Unknown/, "Header should not render context fallback");
  assert.doesNotMatch(stripped, /Context:\s*0%/, "Context must not show fake 0% percentage");
});

test("update notice at 100 cols (medium mode) renders card in right column", async () => {
  const output = await renderHeaderWithUpdate(100, MOCK_UPDATE);

  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(100, 40)).mode, "medium");
  assert.match(output, /[╭╰]/, "update card border should appear in medium mode at 100 cols");
  assert.match(output, /1\.0\.3/, "latest version should appear in card");
});
