import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderBackendKind } from "../providerRuntime/types.js";
import type { ProviderId } from "../providerLauncher/types.js";
import type { LocalBackendId } from "../providerLauncher/types.js";
import { resolveCodexaConversationDir } from "./appData.js";

export type ConversationMessageRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationMessageRole;
  content: string;
}

export interface ConversationMetadata {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: ProviderId | string | null;
  modelId: string;
  backendKind: ProviderBackendKind | string | null;
  reasoning?: string;
  localBackend?: LocalBackendId;
  messageCount: number;
}

export interface ConversationRecord {
  metadata: ConversationMetadata;
  messages: ConversationMessage[];
}

export interface ConversationListEntry extends ConversationMetadata {}

interface ConversationStoreOptions {
  rootDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  onDiagnostic?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseMessages(value: unknown): ConversationMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ConversationMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const role = item.role;
    const content = item.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    messages.push({ role, content });
  }
  return messages;
}

function parseMetadata(value: unknown, fallbackId: string): ConversationMetadata | null {
  if (!isRecord(value)) return null;
  const id = safeString(value.id) ?? fallbackId;
  const title = safeString(value.title) ?? "Untitled conversation";
  const createdAt = safeString(value.createdAt) ?? new Date(0).toISOString();
  const updatedAt = safeString(value.updatedAt) ?? createdAt;
  const modelId = safeString(value.modelId) ?? "unknown";
  const messageCount = typeof value.messageCount === "number" && Number.isInteger(value.messageCount)
    ? Math.max(0, value.messageCount)
    : 0;
  return {
    version: 1,
    id,
    title,
    createdAt,
    updatedAt,
    providerId: typeof value.providerId === "string" ? value.providerId : null,
    modelId,
    backendKind: typeof value.backendKind === "string" ? value.backendKind : null,
    ...(typeof value.reasoning === "string" && value.reasoning.trim() ? { reasoning: value.reasoning } : {}),
    ...(value.localBackend === "lm-studio" || value.localBackend === "unsloth" ? { localBackend: value.localBackend } : {}),
    messageCount,
  };
}

function titleFromMessages(messages: ConversationMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  if (!firstUser) return "Untitled conversation";
  const title = firstUser.content.replace(/\s+/g, " ").trim();
  return title.length > 72 ? `${title.slice(0, 69).trimEnd()}...` : title;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function isSafeConversationId(id: string): boolean {
  return /^chat_[A-Za-z0-9-]+$/.test(id);
}

export class ConversationStore {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onDiagnostic: (message: string) => void;

  constructor(workspaceRoot: string, options: ConversationStoreOptions = {}) {
    this.rootDir = options.rootDir ?? resolveCodexaConversationDir(workspaceRoot);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  private conversationDir(id: string): string {
    if (!isSafeConversationId(id)) throw new Error("Invalid conversation id.");
    return join(this.rootDir, id);
  }

  private ensureRoot(): void {
    mkdirSync(this.rootDir, { recursive: true });
  }

  createConversation(route: {
    providerId: ProviderId | string | null;
    modelId: string;
    backendKind: ProviderBackendKind | string | null;
    reasoning?: string;
    localBackend?: LocalBackendId;
  }): ConversationRecord {
    this.ensureRoot();
    const id = `chat_${this.idFactory()}`;
    const timestamp = this.now().toISOString();
    const metadata: ConversationMetadata = {
      version: 1,
      id,
      title: "Untitled conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerId: route.providerId,
      modelId: route.modelId,
      backendKind: route.backendKind,
      ...(route.reasoning ? { reasoning: route.reasoning } : {}),
      ...(route.localBackend ? { localBackend: route.localBackend } : {}),
      messageCount: 0,
    };
    return { metadata, messages: [] };
  }

  save(record: ConversationRecord): void {
    const dir = this.conversationDir(record.metadata.id);
    mkdirSync(dir, { recursive: true });
    const messages = record.messages.map((message) => ({ role: message.role, content: message.content }));
    const metadata: ConversationMetadata = {
      ...record.metadata,
      title: record.metadata.title === "Untitled conversation" ? titleFromMessages(record.messages) : record.metadata.title,
      updatedAt: this.now().toISOString(),
      messageCount: messages.length,
    };
    atomicWriteJson(join(dir, "messages.json"), messages);
    atomicWriteJson(join(dir, "metadata.json"), metadata);
  }

  load(id: string): ConversationRecord | null {
    try {
      const dir = this.conversationDir(id);
      const messages = parseMessages(JSON.parse(readFileSync(join(dir, "messages.json"), "utf8")));
      if (!messages) throw new Error("messages.json is not a valid conversation message array");
      let metadata: ConversationMetadata | null = null;
      const metadataPath = join(dir, "metadata.json");
      if (existsSync(metadataPath)) {
        metadata = parseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")), id);
      }
      const timestamp = this.now().toISOString();
      metadata ??= {
        version: 1,
        id,
        title: titleFromMessages(messages),
        createdAt: timestamp,
        updatedAt: timestamp,
        providerId: null,
        modelId: "unknown",
        backendKind: null,
        messageCount: messages.length,
      };
      metadata = { ...metadata, messageCount: messages.length };
      return { metadata, messages };
    } catch (error) {
      this.onDiagnostic(`Skipped conversation ${id}: ${error instanceof Error ? error.message : "invalid data"}`);
      return null;
    }
  }

  list(): ConversationListEntry[] {
    if (!existsSync(this.rootDir)) return [];
    const entries: ConversationListEntry[] = [];
    let directoryEntries;
    try {
      directoryEntries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch (error) {
      this.onDiagnostic(`Unable to list conversations: ${error instanceof Error ? error.message : "filesystem error"}`);
      return [];
    }
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || !isSafeConversationId(entry.name)) continue;
      const dir = join(this.rootDir, entry.name);
      try {
        const metadataPath = join(dir, "metadata.json");
        if (existsSync(metadataPath)) {
          const metadata = parseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")), entry.name);
          if (metadata) {
            entries.push(metadata);
            continue;
          }
        }
        const record = this.load(entry.name);
        if (record) entries.push(record.metadata);
      } catch (error) {
        this.onDiagnostic(`Skipped conversation ${entry.name}: ${error instanceof Error ? error.message : "invalid metadata"}`);
      }
    }
    return entries.sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    });
  }
}
