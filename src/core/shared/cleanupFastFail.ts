import type { RunToolActivity } from "../../session/types.js";

const DELETE_COMMAND_PATTERN =
  /(?:^|[\s;&|])(?:remove-item|rm|rmdir|del|erase|unlink)\b/i;

const BLOCKED_DELETE_CAUSE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:^|[\\/])\.git[\\/][^\s"'`]*\.lock\b|(?:^|[\\/])?config\.lock\b|\.lock\b/i, label: "lock artifact" },
  { pattern: /\bEACCES\b/i, label: "access denied" },
  { pattern: /\bEPERM\b/i, label: "permission denied" },
  { pattern: /\bEBUSY\b/i, label: "file is busy or locked" },
  { pattern: /access(?:\s+to\s+the\s+path)?\s+.*?\s+denied|access is denied/i, label: "access denied" },
  { pattern: /permission denied|operation not permitted/i, label: "permission denied" },
  { pattern: /being used by another process|file is in use|resource busy|text file busy|device or resource busy/i, label: "file is locked or in use" },
];

const PATH_PATTERNS = [
  /Access to the path ['"]([^'"]+)['"] is denied/i,
  /(?:EPERM|EACCES|EBUSY)[^,\n\r]*,\s*(?:unlink|rmdir|rm|open|scandir)\s+['"]?([^'"\n\r]+)['"]?/i,
  /(?:cannot|can't|failed to|unable to)\s+(?:remove|delete|unlink|rmdir)[^'"\n\r]*['"]([^'"]+)['"]/i,
  /(?:being used by another process|file is in use|permission denied|access is denied)[^'"\n\r]*['"]([^'"]+)['"]/i,
  /((?:\.git[\\/])?[^\s"'`]+\.lock)\b/i,
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isDeleteCommand(command: string): boolean {
  return DELETE_COMMAND_PATTERN.test(command);
}

function findCause(text: string): string | null {
  for (const { pattern, label } of BLOCKED_DELETE_CAUSE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function findBlockedPath(text: string): string | null {
  for (const pattern of PATH_PATTERNS) {
    const match = pattern.exec(text);
    const path = match?.[1]?.trim();
    if (path) return path.replace(/[.,;:]+$/g, "");
  }
  return null;
}

export function getBlockedCleanupFailure(activity: RunToolActivity): string | null {
  if (activity.status !== "failed") return null;

  const command = normalizeText(activity.command);
  const summary = normalizeText(activity.summary);
  const combined = [command, summary].filter(Boolean).join("\n");
  if (!command || !isDeleteCommand(command)) return null;

  const cause = findCause(combined);
  if (!cause) return null;

  const blockedPath = findBlockedPath(combined);
  const target = blockedPath ? `\nBlocked item: ${blockedPath}` : "";
  return [
    "Cleanup stopped because a safe generated artifact could not be deleted.",
    `Cause: ${cause}.`,
    target,
    "Ubume stopped after the first clear blocked-delete signal to avoid retrying a doomed cleanup.",
  ].filter(Boolean).join("\n");
}
