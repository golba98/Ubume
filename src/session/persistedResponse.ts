import type { ConversationMessage } from "../core/workspace/conversationStore.js";
import type { RunFileOperation } from "../core/workspace/workspaceActivity.js";

export type PersistedRunStatus = "completed" | "canceled" | "failed";

export interface PersistedFileActivity {
  path: string;
  operation: RunFileOperation;
}

const MAX_SUMMARY_FILES = 20;
const MAX_SUMMARY_COMMANDS = 10;
const MAX_COMMAND_CHARS = 80;
const MAX_ERROR_CHARS = 200;

export function selectPersistedAssistantResponse(
  renderedResponse: string | undefined,
  completeResponse: string | undefined,
): string | undefined {
  return completeResponse ?? renderedResponse;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

function joinCapped(items: readonly string[], cap: number): string {
  const shown = items.slice(0, cap).join(", ");
  return items.length > cap ? `${shown}, +${items.length - cap} more` : shown;
}

/** Compact, deterministic record of what a run did, stored with its reply for /resume. */
export function formatRunActivitySummary(
  toolCommands: readonly string[],
  fileActivity: readonly PersistedFileActivity[],
): string {
  const files = new Map<string, RunFileOperation>();
  for (const entry of fileActivity) {
    const path = entry.path.trim();
    if (!path) continue;
    // A file created during the run stays "created" even if edited again.
    if (files.get(path) === "created" && entry.operation === "modified") continue;
    files.set(path, entry.operation);
  }
  const commands = [...new Set(
    toolCommands
      .map((command) => command.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((command) => truncate(command, MAX_COMMAND_CHARS)),
  )];

  const lines: string[] = [];
  if (files.size > 0) {
    lines.push(`Files changed: ${joinCapped([...files].map(([path, operation]) => `${path} (${operation})`), MAX_SUMMARY_FILES)}`);
  }
  if (commands.length > 0) {
    lines.push(`Commands run: ${joinCapped(commands, MAX_SUMMARY_COMMANDS)}`);
  }
  return lines.join("\n");
}

/**
 * Builds the assistant message saved for a finished run. Completed replies keep
 * their content byte-for-byte (Local Harness session reuse hashes it) and carry
 * the activity summary separately; interrupted replies keep whatever streamed.
 */
export function buildPersistedAssistantMessage(input: {
  status: PersistedRunStatus;
  renderedResponse?: string;
  completeResponse?: string;
  streamedText: string;
  errorMessage?: string;
  toolCommands: readonly string[];
  fileActivity: readonly PersistedFileActivity[];
}): ConversationMessage | undefined {
  const summary = formatRunActivitySummary(input.toolCommands, input.fileActivity);

  if (input.status === "completed") {
    const content = selectPersistedAssistantResponse(input.renderedResponse, input.completeResponse);
    if (content?.trim()) {
      return { role: "assistant", content, ...(summary ? { activitySummary: summary } : {}) };
    }
    return summary ? { role: "assistant", content: summary } : undefined;
  }

  const partial = input.streamedText.trim();
  if (!partial && !summary) return undefined;
  const firstErrorLine = input.errorMessage?.split("\n").find((line) => line.trim())?.trim();
  const note = input.status === "canceled"
    ? "[Run canceled before finishing]"
    : `[Run failed${firstErrorLine ? `: ${truncate(firstErrorLine, MAX_ERROR_CHARS)}` : ""}]`;
  return { role: "assistant", content: [partial, note, summary].filter(Boolean).join("\n\n") };
}
