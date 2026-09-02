import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineRow } from "./timelineMeasure.js";
import { LIVE_WINDOW_SAFETY_ROWS, windowLiveRows } from "./liveViewportWindow.js";

function rows(count: number): TimelineRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row-${index}`,
    spans: [{ text: `line ${index}` }],
  })) as TimelineRow[];
}

test("returns the same array reference when the live rows fit the window", () => {
  const input = rows(5);
  assert.equal(windowLiveRows(input, 5), input);
  assert.equal(windowLiveRows(input, 8), input);
});

test("keeps only the last maxRows rows when the live turn is taller than the window", () => {
  const input = rows(10);
  const windowed = windowLiveRows(input, 4);
  assert.deepEqual(windowed.map((row) => row.key), ["row-6", "row-7", "row-8", "row-9"]);
});

test("treats a non-positive or fractional window as a floored non-negative row budget", () => {
  const input = rows(3);
  assert.deepEqual(windowLiveRows(input, 0), []);
  assert.deepEqual(windowLiveRows(input, -2), []);
  assert.deepEqual(windowLiveRows(input, 2.9).map((row) => row.key), ["row-1", "row-2"]);
});

test("exposes a one-row safety margin for composer measurement drift", () => {
  assert.equal(LIVE_WINDOW_SAFETY_ROWS, 1);
});
