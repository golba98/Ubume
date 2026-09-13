import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

type DebugDetails = Record<string, unknown>;

let sequence = 0;

export function isInputDebugEnabled(): boolean {
  return process.env.UBUME_DEBUG_INPUT === "1";
}

export function getInputDebugLogPath(): string {
  return process.env.UBUME_DEBUG_INPUT_LOG || join(homedir(), ".ubume-input-debug.log");
}

export function getStdinDebugState(stdin: unknown): DebugDetails {
  const input = stdin as {
    isTTY?: boolean;
    isRaw?: boolean;
    readable?: boolean;
    destroyed?: boolean;
    isPaused?: () => boolean;
  } | null | undefined;

  return {
    isTTY: input?.isTTY ?? null,
    isRaw: input?.isRaw ?? null,
    readable: input?.readable ?? null,
    destroyed: input?.destroyed ?? null,
    paused: typeof input?.isPaused === "function" ? input.isPaused() : null,
  };
}

export function traceInputDebug(event: string, details: DebugDetails = {}): void {
  if (!isInputDebugEnabled()) {
    return;
  }

  try {
    const entry = {
      ts: new Date().toISOString(),
      seq: ++sequence,
      event,
      ...details,
    };
    appendFileSync(getInputDebugLogPath(), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Debug tracing must never affect interactive input.
  }
}
