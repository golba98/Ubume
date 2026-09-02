import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultMaxOutputTokens } from "./localOutputBudget.js";

test("default output budget scales with the context window inside fixed bounds", () => {
  assert.equal(resolveDefaultMaxOutputTokens(32_768), 8_192);
  assert.equal(resolveDefaultMaxOutputTokens(131_072), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens(1_000_000), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens(4_096), 8_192);
  assert.equal(resolveDefaultMaxOutputTokens(65_536), 16_384);
  assert.equal(resolveDefaultMaxOutputTokens(undefined), 8_192);
});
