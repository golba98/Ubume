import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersistedAssistantMessage,
  formatRunActivitySummary,
  selectPersistedAssistantResponse,
} from "./persistedResponse.js";

test("preserves the complete assistant response when streamed content needs no replacement", () => {
  assert.equal(selectPersistedAssistantResponse(undefined, "streamed answer"), "streamed answer");
});

test("falls back to the rendered response for non-streaming providers", () => {
  assert.equal(selectPersistedAssistantResponse("final answer", undefined), "final answer");
});

test("completed runs keep the reply content unchanged and store the activity summary separately", () => {
  const message = buildPersistedAssistantMessage({
    status: "completed",
    completeResponse: "Built the game.",
    streamedText: "Built the game.",
    toolCommands: ["write_file index.html"],
    fileActivity: [{ path: "index.html", operation: "created" }],
  });
  assert.deepEqual(message, {
    role: "assistant",
    content: "Built the game.",
    activitySummary: "Files changed: index.html (created)\nCommands run: write_file index.html",
  });
});

test("completed runs without activity store no summary field", () => {
  const message = buildPersistedAssistantMessage({
    status: "completed",
    renderedResponse: "Hello!",
    streamedText: "Hello!",
    toolCommands: [],
    fileActivity: [],
  });
  assert.deepEqual(message, { role: "assistant", content: "Hello!" });
});

test("canceled runs keep the streamed partial reply, an interruption note, and the summary", () => {
  const message = buildPersistedAssistantMessage({
    status: "canceled",
    streamedText: "Creating the renderer...\n",
    toolCommands: ["npm test"],
    fileActivity: [{ path: "src/game.js", operation: "modified" }],
  });
  assert.equal(
    message?.content,
    "Creating the renderer...\n\n[Run canceled before finishing]\n\nFiles changed: src/game.js (modified)\nCommands run: npm test",
  );
  assert.equal(message?.activitySummary, undefined);
});

test("failed runs include the first line of the error", () => {
  const message = buildPersistedAssistantMessage({
    status: "failed",
    streamedText: "Partial work",
    errorMessage: "\nLocal agent request failed: continuation stopped.\n\nBackend: local",
    toolCommands: [],
    fileActivity: [],
  });
  assert.equal(message?.content, "Partial work\n\n[Run failed: Local agent request failed: continuation stopped.]");
});

test("interrupted runs with no output and no activity save nothing", () => {
  assert.equal(buildPersistedAssistantMessage({
    status: "canceled",
    streamedText: "   ",
    toolCommands: [],
    fileActivity: [],
  }), undefined);
});

test("activity summary dedupes, caps, and truncates entries", () => {
  const files = Array.from({ length: 22 }, (_, index) => ({ path: `f${index}.js`, operation: "modified" as const }));
  const summary = formatRunActivitySummary(
    ["ls", "ls", `echo ${"x".repeat(100)}`],
    [{ path: "new.js", operation: "created" }, { path: "new.js", operation: "modified" }, ...files],
  );
  const [fileLine, commandLine] = summary.split("\n");
  assert.ok(fileLine?.startsWith("Files changed: new.js (created), f0.js (modified)"));
  assert.ok(fileLine?.endsWith(", +3 more"));
  assert.equal(commandLine?.startsWith("Commands run: ls, echo xxx"), true);
  assert.equal(commandLine?.split(", ").length, 2);
  assert.ok(commandLine?.endsWith("…"));
});
