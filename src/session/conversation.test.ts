import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResumedProviderRoute,
  conversationMessagesToTimeline,
  formatConversationHistory,
  selectConversationContext,
  toProviderConversationHistory,
} from "./conversation.js";

test("conversation context restores dialogue as normal user and assistant timeline events", () => {
    let nextId = 0;
    const events = conversationMessagesToTimeline([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ], () => ++nextId);
    assert.deepEqual(events.map((event) => event.type), ["user", "assistant"]);
    assert.equal(events[0]?.type === "user" ? events[0].turnId : null, 1);
    assert.equal(events[1]?.type === "assistant" ? events[1].turnId : null, 1);
});

test("resumed assistant replies show their saved activity summary", () => {
    let nextId = 0;
    const events = conversationMessagesToTimeline([
      { role: "user", content: "Build it" },
      { role: "assistant", content: "Done.", activitySummary: "Files changed: index.html (created)" },
    ], () => ++nextId);
    assert.equal(
      events[1]?.type === "assistant" ? events[1].content : null,
      "Done.\n\n---\nFiles changed: index.html (created)",
    );
});

test("provider history strips extra fields and folds summaries only when requested", () => {
    const messages = [
      { role: "user" as const, content: "Build it" },
      { role: "assistant" as const, content: "Done.", activitySummary: "Commands run: npm test" },
    ];
    assert.deepEqual(toProviderConversationHistory(messages, { includeActivitySummaries: false }), [
      { role: "user", content: "Build it" },
      { role: "assistant", content: "Done." },
    ]);
    assert.equal(
      toProviderConversationHistory(messages, { includeActivitySummaries: true })[1]?.content,
      "Done.\n\nCommands run: npm test",
    );
});

test("conversation context keeps complete history while selecting only a request tail", () => {
    const messages = [
      { role: "user" as const, content: "old" },
      { role: "assistant" as const, content: "old answer" },
      { role: "user" as const, content: "new" },
      { role: "assistant" as const, content: "new answer" },
    ];
    assert.deepEqual(selectConversationContext(messages, 13).map((message) => message.content), ["new", "new answer"]);
    assert.equal(messages.length, 4);
});

test("conversation context serializes prior turns without credentials or provider state", () => {
    assert.equal(formatConversationHistory([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]), "User:\nQuestion\n\nAssistant:\nAnswer");
});

test("resumed Local route keeps the saved backend instead of defaulting to LM Studio", () => {
    assert.deepEqual(buildResumedProviderRoute({
      modelId: "Ornith-1.5-35B-A3B-Q4_K_M",
      backendKind: "local-openai-compatible",
      reasoning: "medium",
      localBackend: "unsloth",
    }, "local", "local-openai-compatible"), {
      providerId: "local",
      modelId: "Ornith-1.5-35B-A3B-Q4_K_M",
      backendKind: "local-openai-compatible",
      reasoning: "medium",
      localBackend: "unsloth",
    });
});

test("resumed routes omit a missing backend and never give non-Local providers one", () => {
    const legacyLocal = buildResumedProviderRoute({ modelId: "qwen", backendKind: null }, "local", "local-openai-compatible");
    assert.equal("localBackend" in legacyLocal, false);
    assert.equal(legacyLocal.backendKind, "local-openai-compatible");
    const openai = buildResumedProviderRoute({ modelId: "gpt", backendKind: "unavailable", localBackend: "unsloth" }, "openai", "codex-cli-auth");
    assert.equal("localBackend" in openai, false);
    assert.equal(openai.backendKind, "codex-cli-auth");
});

test("restored turns take ids from the provided turn counter so they cannot collide with live turns", () => {
    let nextEventId = 0;
    let nextTurnId = 100;
    const events = conversationMessagesToTimeline([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Build it" },
    ], () => ++nextEventId, () => nextTurnId++);
    assert.deepEqual(events.map((event) => ("turnId" in event ? event.turnId : null)), [100, 100, 101]);
    assert.equal(nextTurnId, 102, "the next live turn starts after the restored ones");
});
