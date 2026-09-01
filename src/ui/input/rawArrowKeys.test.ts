import assert from "node:assert/strict";
import { test } from "node:test";
import { getArrowDirection, getHorizontalArrowDirection } from "./rawArrowKeys.js";

const ESC = String.fromCharCode(27);

test("resolves CSI and application-cursor arrows", () => {
  assert.equal(getArrowDirection(`${ESC}[A`), "up");
  assert.equal(getArrowDirection(`${ESC}[B`), "down");
  assert.equal(getArrowDirection(`${ESC}[C`), "right");
  assert.equal(getArrowDirection(`${ESC}[D`), "left");
  assert.equal(getArrowDirection(`${ESC}OC`), "right");
  assert.equal(getArrowDirection(`${ESC}OD`), "left");
});

test("resolves modified arrows that carry CSI parameters", () => {
  assert.equal(getArrowDirection(`${ESC}[1;5C`), "right");
  assert.equal(getArrowDirection(`${ESC}[1;2D`), "left");
});

test("finds an arrow that completes a buffered escape prefix", () => {
  assert.equal(getArrowDirection(`${ESC}` + "[C"), "right");
});

test("ignores non-arrow input", () => {
  assert.equal(getArrowDirection("[C"), null, "a bare remnant without ESC is not an arrow");
  assert.equal(getArrowDirection(ESC), null);
  assert.equal(getArrowDirection("plain text"), null);
  assert.equal(getArrowDirection(`${ESC}[<0;83;19M`), null, "SGR mouse reports are not arrows");
});

test("horizontal helper drops vertical arrows", () => {
  assert.equal(getHorizontalArrowDirection(`${ESC}[C`), "right");
  assert.equal(getHorizontalArrowDirection(`${ESC}[D`), "left");
  assert.equal(getHorizontalArrowDirection(`${ESC}[A`), null);
  assert.equal(getHorizontalArrowDirection(`${ESC}[B`), null);
});
