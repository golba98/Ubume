import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCodexaDataDir } from "../workspace/appData.js";

export function isLocalStreamDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEXA_DEBUG_LOCAL_STREAM === "1";
}

export function getLocalStreamDebugLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEXA_DEBUG_LOCAL_STREAM_FILE?.trim()
    || join(resolveCodexaDataDir(undefined, env), "debug", "local-stream.jsonl");
}

const SENSITIVE_DETAIL_KEY = /(?:raw|content|reasoning|analysis|arguments|prompt)/i;

function redactStreamDetails(value: unknown, key = ""): unknown {
  if (typeof value === "string" && SENSITIVE_DETAIL_KEY.test(key)) {
    return `[redacted:${value.length} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => redactStreamDetails(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, redactStreamDetails(childValue, childKey)]),
    );
  }
  return value;
}

export function traceLocalStream(
  event: string,
  details: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isLocalStreamDebugEnabled(env)) return;
  try {
    const logPath = getLocalStreamDebugLogPath(env);
    mkdirSync(dirname(logPath), { recursive: true });
    const safeDetails = env.CODEXA_DEBUG_LOCAL_STREAM_CONTENT === "1"
      ? details
      : redactStreamDetails(details);
    appendFileSync(logPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...safeDetails as Record<string, unknown>,
    })}\n`, "utf8");
  } catch {
    // Diagnostics must never interfere with a Local request or the TUI.
  }
}
