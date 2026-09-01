import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTerminalViewport,
  clampVisualText,
  createTerminalViewport,
  computeAppLayoutBudget,
  createLayoutSnapshot,
  getShellHeight,
  getShellWidth,
  getUsableShellWidth,
  getVisualWidth,
  resolveStartupHeaderMode,
  getContentWidth,
} from "./layout.js";
import { getHeaderHeroLayout, measureTopHeaderRows } from "./chrome/TopHeader.js";

test("leaves a one-column gutter to avoid edge-triggered scrollbars", () => {
  assert.equal(getShellWidth(120), 119);
  assert.equal(getShellWidth(80), 79);
});

test("keeps a sensible minimum shell width on tiny terminals", () => {
  assert.equal(getShellWidth(20), 20);
  assert.equal(getShellWidth(10), 20);
  assert.equal(getShellWidth(undefined), 119);
});

test("derives usable shell width from the guttered viewport width", () => {
  assert.equal(getUsableShellWidth(120, 6), 113);
  assert.equal(getUsableShellWidth(20, 30), 1);
});

test("leaves a one-row gutter to avoid edge-triggered bottom scrolling", () => {
  assert.equal(getShellHeight(40), 39);
  assert.equal(getShellHeight(24), 23);
});

test("keeps a sensible minimum shell height on tiny terminals", () => {
  assert.equal(getShellHeight(10), 10);
  assert.equal(getShellHeight(5), 10);
  assert.equal(getShellHeight(undefined), 23);
});

test("keeps breakpoint modes stable at the edges", () => {
  assert.equal(createLayoutSnapshot(59, 30).mode, "compact");
  assert.equal(createLayoutSnapshot(60, 19).mode, "compact");
  assert.equal(createLayoutSnapshot(89, 30).mode, "compact");
  assert.equal(createLayoutSnapshot(90, 20).mode, "compact");
  assert.equal(createLayoutSnapshot(100, 21).mode, "compact");
  assert.equal(createLayoutSnapshot(140, 30).mode, "expanded");
  assert.equal(createLayoutSnapshot(180, 40).mode, "expanded");
});

test("responsive layout breakpoints and budgeting spec assertions", () => {
  // 100x22 spec assertions
  const layout100x22 = createLayoutSnapshot(100, 22);
  assert.equal(layout100x22.mode, "compact");

  const budget100x22 = computeAppLayoutBudget({
    cols: 100,
    rows: 22,
  });

  assert.equal(budget100x22.mode, "compact");
  assert.equal(budget100x22.showNormalLogo, true);
  assert.equal(budget100x22.placeMetadataBesideLogo, true);
  assert.equal(budget100x22.headerRows, 6);
  assert.equal(budget100x22.headerGapRows, 0);
  assert.equal(budget100x22.panelStagePaddingY, 0);
  assert.equal(budget100x22.composerRows, 3);
  assert.equal(budget100x22.bottomChromeBudget.runtimeMetadataRows, 1);
  assert.equal(budget100x22.bottomChromeBudget.composerRows, 3);
  assert.equal(budget100x22.bottomChromeBudget.transientStatusRows, 0);
  assert.equal(budget100x22.bottomChromeBudget.totalRows, 4);
  assert.ok(budget100x22.activePanelRows >= 6, `expected activePanelRows >= 6, got ${budget100x22.activePanelRows}`);

  // 80x24 spec assertions
  const layout80x24 = createLayoutSnapshot(80, 24);
  assert.equal(layout80x24.mode, "compact");
  const budget80x24 = computeAppLayoutBudget({ cols: 80, rows: 24 });
  assert.equal(budget80x24.showNormalLogo, true); // logo visible since cols 80 >= 72

  // <72w compact header only assertion
  const layout70x24 = createLayoutSnapshot(70, 24);
  assert.equal(layout70x24.mode, "compact");
  const budget70x24 = computeAppLayoutBudget({ cols: 70, rows: 24 });
  assert.equal(budget70x24.showNormalLogo, false);
  assert.equal(budget70x24.showCompactHeader, true);

  // 120x32 regular spec assertions
  const layout120x32 = createLayoutSnapshot(120, 32);
  assert.equal(layout120x32.mode, "regular");

  // 140x30 expanded spec assertions
  const layout140x30 = createLayoutSnapshot(140, 30);
  assert.equal(layout140x30.mode, "expanded");
});

test("compact size does not show logo tiers if too narrow", () => {
  const budget = computeAppLayoutBudget({
    cols: 70,
    rows: 14,
    composerRows: 4,
  });

  assert.equal(budget.mode, "compact");
  assert.equal(budget.showNormalLogo, false);
  assert.equal(budget.showLargeLogo, false);
  assert.equal(budget.showCompactHeader, true);
});

test("expanded size shows the large logo tier", () => {
  const budget = computeAppLayoutBudget({
    cols: 180,
    rows: 45,
    composerRows: 4,
  });

  assert.equal(budget.mode, "expanded");
  assert.equal(budget.showLargeLogo, true);
  assert.equal(budget.showNormalLogo, true);
  assert.equal(budget.showCompactHeader, false);
});

test("chooses startup header mode from measured row budget", () => {
  assert.equal(resolveStartupHeaderMode({
    cols: 120,
    rows: 30,
    introRows: 7,
    composerRows: 6,
  }), "large");

  assert.equal(resolveStartupHeaderMode({
    cols: 120,
    rows: 16,
    introRows: 7,
    composerRows: 6,
  }), "compact");

  assert.equal(resolveStartupHeaderMode({
    cols: 100,
    rows: 24,
    introRows: 7,
    composerRows: 5,
  }), "large"); // STARTUP_FULL_MIN_COLS lowered to 100 to match LOGO_LARGE_MIN_COLS

  assert.equal(resolveStartupHeaderMode({
    cols: 39,
    rows: 24,
    introRows: 7,
    composerRows: 5,
  }), "tiny");

  assert.equal(resolveStartupHeaderMode({
    cols: 100,
    rows: 13,
    introRows: 7,
    composerRows: 5,
  }), "tiny");
});

test("measures the header rows for full and compact layouts", () => {
  assert.equal(measureTopHeaderRows(createLayoutSnapshot(100, 21)), 6);
  assert.equal(measureTopHeaderRows(createLayoutSnapshot(120, 30)), 6);
  assert.equal(measureTopHeaderRows(createLayoutSnapshot(80, 24)), 10);
  assert.equal(measureTopHeaderRows(createLayoutSnapshot(70, 24)), 1);
  assert.ok(measureTopHeaderRows(createLayoutSnapshot(180, 45)) >= 6);
});

test("header hero switches across narrow, medium, and wide breakpoints", () => {
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(70, 30)).mode, "compact");
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(100, 30)).mode, "medium");
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(140, 35)).mode, "wide");
  assert.equal(getHeaderHeroLayout(createLayoutSnapshot(180, 45)).mode, "wide");
});

test("preserves the previous layout when resize values are invalid", () => {
  const previous = createLayoutSnapshot(80, 30);
  const next = createLayoutSnapshot(0, -1, previous);

  assert.deepEqual(next, previous);
});

test("marks undersized restore samples as unstable without discarding the last stable layout", () => {
  const stable = createTerminalViewport(120, 40);
  const invalidSamples = [
    advanceTerminalViewport(stable, 1, 1),
    advanceTerminalViewport(stable, 2, 1),
    advanceTerminalViewport(stable, 1, 24),
    advanceTerminalViewport(stable, 24, 1),
    // Medium-invalid: pass old <=1 check but fail MIN_VIEWPORT thresholds
    advanceTerminalViewport(stable, 15, 8),
    advanceTerminalViewport(stable, 19, 24),
    advanceTerminalViewport(stable, 120, 9),
  ];

  for (const sample of invalidSamples) {
    assert.equal(sample.unstable, true);
    assert.equal(sample.cols, stable.cols);
    assert.equal(sample.rows, stable.rows);
    assert.equal(sample.layoutEpoch, stable.layoutEpoch);
  }
});

test("bumps the layout epoch when the terminal recovers from an unstable restore", () => {
  const stable = createTerminalViewport(120, 40);
  const unstable = advanceTerminalViewport(stable, 1, 1);
  const recovered = advanceTerminalViewport(unstable, 100, 30);

  assert.equal(unstable.unstable, true);
  assert.equal(recovered.unstable, false);
  assert.equal(recovered.cols, 100);
  assert.equal(recovered.rows, 30);
  assert.equal(recovered.layoutEpoch, stable.layoutEpoch + 1);
});

test("measures visual width instead of raw string length", () => {
  assert.equal("⚡".length, 1);
  assert.equal(getVisualWidth("⚡"), 2);
});

test("clamps text to a visual width budget", () => {
  assert.equal(clampVisualText("ACTION REQUIRED", 8), "ACTION …");
  assert.equal(clampVisualText("⚡⚡", 3), "⚡…");
});

test("getContentWidth returns responsive content widths", () => {
  assert.equal(getContentWidth(120), 115);
  assert.equal(getContentWidth(150), 145);
  assert.equal(getContentWidth(180), 171);
  assert.equal(getContentWidth(220), 207);
  assert.equal(getContentWidth(300), 287);
});
