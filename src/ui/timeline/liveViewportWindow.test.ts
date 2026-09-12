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

const CARD_WIDTH = 32;

/** A bordered card the same shape buildDashCardRows emits, for slice tests. */
function card(id: string, contentRows: number): TimelineRow[] {
  const fill = (body: string, right: string) =>
    `${body}${"\u2500".repeat(Math.max(0, CARD_WIDTH - body.length - right.length))}${right}`;
  const boxed = (body: string) => `${body.padEnd(CARD_WIDTH - 2, " ")}\u2502`.slice(0, CARD_WIDTH);

  const built: TimelineRow[] = [{
    key: `${id}-top`,
    spans: [{ text: fill(`\u256d\u2500\u2500 ${id} `, "\u256e"), tone: "accent" }],
    frame: { id, role: "top" },
  }];

  for (let index = 0; index < contentRows; index += 1) {
    built.push({
      key: `${id}-content-${index}`,
      spans: [{ text: boxed(`\u2502 body ${index}`), tone: "accent" }],
      frame: { id, role: "content" },
    });
  }

  built.push({
    key: `${id}-bottom`,
    spans: [{ text: fill("\u2570", "\u256f"), tone: "accent" }],
    frame: { id, role: "bottom" },
  });

  return built;
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

test("re-caps a card the window cuts open instead of emitting a headless box", () => {
  const input = [...rows(3), ...card("plan", 20)];
  const limit = 8;
  const windowed = windowLiveRows(input, limit);

  assert.equal(windowed.length, limit);
  assert.equal(windowed[0]!.key, "plan-top");
  assert.equal(windowed[0]!.frame?.role, "top");
  const elisionText = windowed[1]!.spans.map((span) => span.text).join("");
  assert.match(elisionText, /\u22ef \d+ rows hidden/);
  assert.equal(elisionText.length, CARD_WIDTH);
  // Six rows of budget remain after the two re-cap rows, and the tail is intact.
  assert.deepEqual(
    windowed.slice(2).map((row) => row.key),
    ["plan-content-15", "plan-content-16", "plan-content-17", "plan-content-18", "plan-content-19", "plan-bottom"],
  );
});

test("reports the number of card rows dropped by the re-cap", () => {
  const input = card("plan", 20);
  const windowed = windowLiveRows(input, 8);

  // 20 content rows + bottom = 21 rows below the top border; 6 survive.
  assert.match(windowed[1]!.spans.map((span) => span.text).join(""), /\u22ef 15 rows hidden/);
});

test("leaves a clean cut between cards alone", () => {
  const input = [...card("first", 2), ...card("second", 2)];
  const windowed = windowLiveRows(input, 4);

  assert.deepEqual(
    windowed.map((row) => row.key),
    ["second-top", "second-content-0", "second-content-1", "second-bottom"],
  );
});

test("falls back to a plain slice when the budget cannot pay for a re-cap", () => {
  const input = card("plan", 20);

  assert.deepEqual(windowLiveRows(input, 3).map((row) => row.key), [
    "plan-content-18",
    "plan-content-19",
    "plan-bottom",
  ]);
});

test("leaves unframed live rows on the plain slice path", () => {
  const input = rows(10);
  assert.deepEqual(windowLiveRows(input, 4).map((row) => row.key), ["row-6", "row-7", "row-8", "row-9"]);
});

test("aligns the re-cap row with a card that carries outer padding", () => {
  const padded = card("plan", 12).map((row) => ({
    ...row,
    spans: [{ text: " " }, ...row.spans, { text: " " }],
  })) as TimelineRow[];

  const windowed = windowLiveRows(padded, 6);
  const text = (row: TimelineRow) => row.spans.map((span) => span.text).join("");

  assert.equal(text(windowed[1]!).indexOf("\u2502"), text(windowed[0]!).indexOf("\u256d"));
  assert.equal(text(windowed[1]!).length, text(windowed[0]!).length);
});
