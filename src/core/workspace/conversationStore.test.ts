import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

test("ConversationStore persists the opaque Local Harness session used by /resume", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "local-harness");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
  });
  created.metadata.localHarnessSession = {
    version: 1,
    sessionId: "session-123",
    harnessVersion: "0.1.1-rc.2",
    routeFingerprint: "route-hash",
    throughMessageCount: 2,
    transcriptHash: "transcript-hash",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  conversations.save(created);

  assert.deepEqual(
    conversations.load(created.metadata.id)?.metadata.localHarnessSession,
    created.metadata.localHarnessSession,
  );
});

test("ConversationStore persists invisible Local context checkpoints", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "local-checkpoint");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "ornith",
    backendKind: "local-openai-compatible",
  });
  created.messages.push({ role: "user", content: "Continue this task." });
  created.metadata.localContextCheckpoint = {
    version: 1,
    modelId: "ornith",
    contextLength: 2_024,
    throughMessageCount: 1,
    transcriptHash: "abc123",
    summary: "Objective: continue the task.",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  conversations.save(created);

  assert.deepEqual(
    conversations.load(created.metadata.id)?.metadata.localContextCheckpoint,
    created.metadata.localContextCheckpoint,
  );
});

test("ConversationStore ignores malformed Local context checkpoints", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "invalid-checkpoint");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "ornith",
    backendKind: "local-openai-compatible",
  });
  conversations.save(created);

  const rootDir = (conversations as unknown as { rootDir: string }).rootDir;
  const metadataPath = join(rootDir, created.metadata.id, "metadata.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.localContextCheckpoint = {
    version: 1,
    modelId: "ornith",
    contextLength: -1,
    throughMessageCount: -1,
    transcriptHash: "abc123",
    summary: "Invalid checkpoint",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  assert.equal(conversations.load(created.metadata.id)?.metadata.localContextCheckpoint, undefined);
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

test("ConversationStore round-trips assistant activity summaries and loads messages saved without them", () => {
  const conversations = store("2026-09-12T10:00:00.000Z", "activity-summary");
  const created = conversations.createConversation({ providerId: "local", modelId: "qwen", backendKind: "local-openai-compatible" });
  created.messages.push(
    { role: "user", content: "Build it" },
    { role: "assistant", content: "Done.", activitySummary: "Files changed: index.html (created)" },
    { role: "user", content: "Thanks" },
  );
  conversations.save(created);

  const loaded = conversations.load(created.metadata.id);
  assert.deepEqual(loaded?.messages, [
    { role: "user", content: "Build it" },
    { role: "assistant", content: "Done.", activitySummary: "Files changed: index.html (created)" },
    { role: "user", content: "Thanks" },
  ]);
  assert.equal("activitySummary" in (loaded?.messages[0] ?? {}), false);
});
