import type { ProviderId } from "../core/providerLauncher/types.js";
import type { ProviderBackendKind, ProviderRoute } from "../core/providerRuntime/types.js";
import type { ConversationMessage, ConversationMetadata } from "../core/workspace/conversationStore.js";
import type { AssistantEvent, TimelineEvent, UserPromptEvent } from "./types.js";

/**
 * Route restored by /resume. Local conversations must keep their saved backend:
 * without it the route falls back to LM Studio's default endpoint, so an
 * Unsloth-served model fails with a connection error.
 */
export function buildResumedProviderRoute(
  metadata: Pick<ConversationMetadata, "modelId" | "backendKind" | "reasoning" | "localBackend">,
  providerId: ProviderId,
  fallbackBackendKind: ProviderBackendKind,
): ProviderRoute {
  return {
    providerId,
    modelId: metadata.modelId,
    backendKind: metadata.backendKind && metadata.backendKind !== "unavailable"
      ? metadata.backendKind as ProviderBackendKind
      : fallbackBackendKind,
    ...(metadata.reasoning ? { reasoning: metadata.reasoning } : {}),
    ...(providerId === "local" && metadata.localBackend ? { localBackend: metadata.localBackend } : {}),
  };
}

export function conversationMessagesToTimeline(
  messages: readonly ConversationMessage[],
  createEventId: () => number,
  createTurnId?: () => number,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  // Restored turns must draw from the app's turn counter: the timeline groups
  // events by turnId, so restored ids that collide with the next live turn
  // would fold the new prompt and run into an old turn.
  let localTurnId = 0;
  const nextTurnId = createTurnId ?? (() => ++localTurnId);
  let turnId = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turnId = nextTurnId();
      const user: UserPromptEvent = {
        id: createEventId(),
        type: "user",
        createdAt: Date.now(),
        prompt: message.content,
        turnId,
      };
      events.push(user);
      continue;
    }
    const assistant: AssistantEvent = {
      id: createEventId(),
      type: "assistant",
      createdAt: Date.now(),
      content: message.activitySummary
        ? `${message.content}\n\n---\n${message.activitySummary}`
        : message.content,
      contentChunks: [],
      turnId,
    };
    events.push(assistant);
  }
  return events;
}

/**
 * Plain role/content history for a provider request. Local Harness session
 * reuse hashes this array, so activity summaries are only folded into content
 * when requested (providers that restart from visible history).
 */
export function toProviderConversationHistory(
  messages: readonly ConversationMessage[],
  options: { includeActivitySummaries: boolean },
): ConversationMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: options.includeActivitySummaries && message.activitySummary
      ? `${message.content}\n\n${message.activitySummary}`
      : message.content,
  }));
}

export function formatConversationHistory(messages: readonly ConversationMessage[]): string {
  return messages.map((message) => {
    const label = message.role === "user" ? "User" : "Assistant";
    return `${label}:\n${message.content}`;
  }).join("\n\n");
}

export function selectConversationContext(
  messages: readonly ConversationMessage[],
  maxCharacters?: number,
): ConversationMessage[] {
  if (!maxCharacters || maxCharacters <= 0) return [...messages];
  const selected: ConversationMessage[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const cost = message.content.length;
    if (selected.length > 0 && total + cost > maxCharacters) break;
    selected.unshift(message);
    total += cost;
  }
  return selected;
}
