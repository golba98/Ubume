import assert from "node:assert/strict";
import test from "node:test";
import { selectPersistedAssistantResponse } from "./persistedResponse.js";

test("preserves the complete assistant response when streamed content needs no replacement", () => {
  assert.equal(selectPersistedAssistantResponse(undefined, "streamed answer"), "streamed answer");
});

test("falls back to the rendered response for non-streaming providers", () => {
  assert.equal(selectPersistedAssistantResponse("final answer", undefined), "final answer");
});
