import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { ConversationStore } from "./conversationStore.js";

const temporaryRoots: string[] = [];

function store(now: string, id = "abc") {
  const root = mkdtempSync(join(tmpdir(), "codexa-conversations-"));
  temporaryRoots.push(root);
  return new ConversationStore("/workspace", {
    rootDir: root,
    now: () => new Date(now),
    idFactory: () => id,
  });
}

afterEach(() => {
  // Tests use unique OS temporary directories; leaving them avoids destructive
  // cleanup and keeps interrupted test runs recoverable.
  temporaryRoots.length = 0;
});

test("ConversationStore creates and reloads a stable conversation", () => {
    const conversations = store("2026-08-16T10:00:00.000Z");
    const created = conversations.createConversation({ providerId: "local", modelId: "qwen", backendKind: "local-openai-compatible" });
    created.messages.push({ role: "user", content: "Help me debug this." });
    conversations.save(created);

    const loaded = conversations.load(created.metadata.id);
    assert.equal(loaded?.metadata.id, created.metadata.id);
    assert.equal(loaded?.metadata.messageCount, 1);
    assert.equal(loaded?.metadata.title, "Help me debug this.");
    assert.equal(loaded?.messages[0]?.content, "Help me debug this.");
});

test("ConversationStore preserves the selected Local backend", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "unsloth-route");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
    localBackend: "unsloth",
  });
  conversations.save(created);
  assert.equal(conversations.load(created.metadata.id)?.metadata.localBackend, "unsloth");
});

test("ConversationStore lists newest activity first and ignores malformed conversations", () => {
    const conversations = store("2026-08-16T12:00:00.000Z", "first");
    const first = conversations.createConversation({ providerId: "local", modelId: "one", backendKind: "local-openai-compatible" });
    first.messages.push({ role: "user", content: "Older" });
    conversations.save(first);

    const newer = new ConversationStore("/workspace", {
      rootDir: (conversations as unknown as { rootDir: string }).rootDir,
      now: () => new Date("2026-08-16T13:00:00.000Z"),
      idFactory: () => "second",
    });
    const second = newer.createConversation({ providerId: "anthropic", modelId: "sonnet", backendKind: "anthropic-api-key" });
    second.messages.push({ role: "user", content: "Newer" });
    newer.save(second);
    mkdirSync(join((conversations as unknown as { rootDir: string }).rootDir, "chat_bad"));
    writeFileSync(join((conversations as unknown as { rootDir: string }).rootDir, "chat_bad", "messages.json"), "invalid");

    const listed = newer.list();
    assert.deepEqual(listed.map((entry) => entry.id), [second.metadata.id, first.metadata.id]);
});

test("ConversationStore does not leave temporary files after a successful atomic save", () => {
    const conversations = store("2026-08-16T10:00:00.000Z");
    const created = conversations.createConversation({ providerId: "openai", modelId: "gpt", backendKind: "codex-cli-auth" });
    created.messages.push({ role: "user", content: "Atomic" });
    conversations.save(created);
    const rootDir = (conversations as unknown as { rootDir: string }).rootDir;
    assert.equal(existsSync(join(rootDir, created.metadata.id, "messages.json.tmp")), false);
    assert.equal(existsSync(join(rootDir, created.metadata.id, "metadata.json.tmp")), false);
});
