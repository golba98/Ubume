import assert from "node:assert/strict";
import test from "node:test";
import {
  createPastedContentLabel,
  createPastedContentToken,
  deleteAdjacentPastedContent,
  expandPastedContent,
  isLargePaste,
  moveAcrossPastedContent,
} from "./pastedContent.js";

test("large paste labels use Unicode character counts and the 1000 character threshold", () => {
  assert.equal(isLargePaste("x".repeat(999)), false);
  assert.equal(isLargePaste("😀".repeat(1_000)), true);
  assert.equal(createPastedContentLabel("😀".repeat(1_000)), "[Pasted Content 1,000 chars]");
});

test("pasted labels expand to raw provider content in occurrence order", () => {
  const first = createPastedContentToken("x".repeat(1_000));
  const second = createPastedContentToken("y".repeat(1_000));
  const registry = new Map([[first, ["first raw paste"]], [second, ["second raw paste"]]]);
  assert.notEqual(first, second);
  assert.equal(expandPastedContent(`before ${first} between ${second} after`, registry), "before first raw paste between second raw paste after");
});

test("cursor movement and deletion treat a pasted label as an atomic span", () => {
  const label = "[Pasted Content 1,000 chars]";
  const value = `a${label}b`;
  assert.equal(moveAcrossPastedContent(value, 5, "right"), 1 + label.length);
  assert.equal(moveAcrossPastedContent(value, 5, "left"), 1);
  assert.deepEqual(deleteAdjacentPastedContent(value, 1 + label.length, "backward"), { value: "ab", cursorOffset: 1 });
  assert.deepEqual(deleteAdjacentPastedContent(value, 1, "forward"), { value: "ab", cursorOffset: 1 });
});

test("cursor movement and deletion treat image attachment chips atomically", () => {
  const token = `[Image: clipboard-image.png]\u2063\uFE01\u2063`;
  const value = `before ${token} after`;
  const tokenStart = value.indexOf("[Image:");
  const tokenEnd = tokenStart + token.length;

  assert.equal(moveAcrossPastedContent(value, tokenStart + 3, "left"), tokenStart);
  assert.equal(moveAcrossPastedContent(value, tokenStart + 3, "right"), tokenEnd);
  assert.deepEqual(deleteAdjacentPastedContent(value, tokenEnd, "backward"), {
    value: "before  after",
    cursorOffset: tokenStart,
  });
});
