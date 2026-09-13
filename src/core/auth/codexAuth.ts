import { spawn } from "child_process";
import { formatCodexLaunchError, resolveCodexExecutable, spawnCodexProcess } from "../executables/codexExecutable.js";

export type CodexAuthState = "checking" | "authenticated" | "unauthenticated" | "unknown";

export interface CodexAuthProbeResult {
  state: CodexAuthState;
  checkedAt: number;
  rawSummary: string;
  recommendedAction: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

const JSON_STATUS_FLAGS = ["authenticated", "is_authenticated", "logged_in", "signed_in"] as const;

const UNAUTHENTICATED_PATTERNS = [
  "not logged in",
  "not signed in",
  "no active session",
  "login required",
  "sign in required",
  "unauthenticated",
  "authentication required",
  "run `codex login`",
  "run codex login",
  "please login",
  "please log in",
  "session expired",
  "token expired",
] as const;

const AUTH_FAILURE_PATTERNS = [
  ...UNAUTHENTICATED_PATTERNS,
  "unauthorized",
  "forbidden",
  "invalid token",
  "invalid grant",
  "access denied",
  "401",
  "403",
] as const;

export function getAuthStateLabel(state: CodexAuthState): string {
  switch (state) {
    case "authenticated":
      return "Authenticated";
    case "unauthenticated":
      return "Signed out";
    case "checking":
      return "Checking";
    default:
      return "Unknown";
  }
}

export function getLoginGuidance(): string {
  return [
    "Sign in to the Ubume neural network to continue.",
    "Run this in your terminal:",
    "  codex login",
    "",
    "If you were previously using API-key auth and want ChatGPT subscription auth:",
    "  codex logout",
    "  codex",
  ].join("\n");
}

export function getLogoutGuidance(): string {
  return [
    "You are managing your Ubume sign-out state.",
    "Run this in your terminal:",
    "  codex logout",
    "",
    "After logging out, use /auth status in this UI to refresh state.",
  ].join("\n");
}

export function getAuthStatusMessage(result: CodexAuthProbeResult): string {
  if (result.state === "authenticated") {
    return [
      "Ubume authentication looks healthy.",
      "State: Authenticated",
      `Summary: ${result.rawSummary}`,
    ].join("\n");
  }

  if (result.state === "unauthenticated") {
    return [
      "Ubume is currently signed out.",
      "State: Signed out",
      `Summary: ${result.rawSummary}`,
      "Recovery:",
      "  codex login",
    ].join("\n");
  }

  if (result.state === "checking") {
    return "Authentication check is currently running.";
  }

  return [
    "Ubume auth state is unknown. This can happen on unsupported neural versions.",
    `Summary: ${result.rawSummary}`,
    `Recommended action: ${result.recommendedAction}`,
  ].join("\n");
}

export interface RunGateDecision {
  allowRun: boolean;
  blockMessage?: string;
  warningMessage?: string;
}

export interface RunGateDecisionOptions {
  warnOnUnknown?: boolean;
}

export function getRunGateDecision(
  authState: CodexAuthState,
  options: RunGateDecisionOptions = {},
): RunGateDecision {
  if (authState === "unauthenticated") {
    return {
      allowRun: false,
      blockMessage: [
        "Run blocked: Ubume is signed out.",
        "Sign in first with your ChatGPT subscription:",
        "  codex login",
      ].join("\n"),
    };
  }

  if (authState === "unknown" || authState === "checking") {
    if (options.warnOnUnknown === false) {
      return { allowRun: true };
    }

    return {
      allowRun: true,
      warningMessage:
        "Auth state is unknown. Run is allowed, but if this fails, use `codex login` and try again.",
    };
  }

  return { allowRun: true };
}

export function inferAuthStateFromProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): CodexAuthState {
  if (exitCode === 0) return "authenticated";

  const jsonState = inferAuthStateFromJson(stdout);
  if (jsonState) return jsonState;

  const output = `${stdout}\n${stderr}`.toLowerCase();

  if (UNAUTHENTICATED_PATTERNS.some((pattern) => output.includes(pattern))) {
    return "unauthenticated";
  }

  return "unknown";
}

export function isLikelyAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export async function probeCodexAuthStatus(): Promise<CodexAuthProbeResult> {
  const attempts: string[][] = [
    ["login", "status", "--json"],
    ["login", "status"],
  ];

  const summaries: string[] = [];

  for (let index = 0; index < attempts.length; index += 1) {
    const args = attempts[index]!;
    const result = await runCodexCommand(args);
    const summary = summarizeAttempt(args, result);
    summaries.push(summary);

    if (result.error) {
      if (isCodexUnavailableError(result.error)) {
        return {
          state: "unknown",
          checkedAt: Date.now(),
          rawSummary: summary,
          recommendedAction:
            "Set CODEX_EXECUTABLE to a working Codex command/path, restart Ubume, then run /auth status again.",
        };
      }

      continue;
    }

    const inferred = inferAuthStateFromProbe(result.exitCode, result.stdout, result.stderr);

    if (inferred === "authenticated" || inferred === "unauthenticated") {
      return {
        state: inferred,
        checkedAt: Date.now(),
        rawSummary: summary,
        recommendedAction: inferred === "authenticated" ? "None" : "Run `codex login` and retry.",
      };
    }
  }

  return {
    state: "unknown",
    checkedAt: Date.now(),
    rawSummary: summaries.join(" | "),
    recommendedAction: "If runs fail, sign in with `codex login`, then retry `/auth status`.",
  };
}

function inferAuthStateFromJson(raw: string): CodexAuthState | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;

    for (const key of JSON_STATUS_FLAGS) {
      const value = payload[key];
      if (typeof value === "boolean") {
        return value ? "authenticated" : "unauthenticated";
      }
    }

    const status = payload.status;
    if (typeof status === "string") {
      const lower = status.toLowerCase();
      if (lower.includes("auth")) return "authenticated";
      if (lower.includes("unauth")) return "unauthenticated";
      if (lower.includes("signed_out")) return "unauthenticated";
    }
  } catch {
    return null;
  }

  return null;
}

function runCodexCommand(args: string[], timeoutMs = 6000): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let done = false;
    let proc: ReturnType<typeof spawn> | null = null;

    let stdout = "";
    let stderr = "";

    const finish = (result: CommandResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const startWithExecutable = async () => {
      let executable: string;
      try {
        executable = await resolveCodexExecutable();
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        finish({
          exitCode: null,
          stdout,
          stderr: formatCodexLaunchError(errno),
          timedOut: false,
          error: errno,
        });
        return;
      }

      if (done) return;
      try {
        proc = spawnCodexProcess(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        clearTimeout(timer);
        finish({
          exitCode: null,
          stdout,
          stderr: formatCodexLaunchError(errno),
          timedOut: false,
          error: errno,
        });
        return;
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (error) => {
        clearTimeout(timer);
        const errno = error as NodeJS.ErrnoException;
        finish({
          exitCode: null,
          stdout,
          stderr: formatCodexLaunchError(errno),
          timedOut: false,
          error: errno,
        });
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        finish({
          exitCode,
          stdout,
          stderr,
          timedOut: false,
        });
      });
    };

    const timer = setTimeout(() => {
      proc?.kill();
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
      });
    }, timeoutMs);

    void startWithExecutable();
  });
}

function summarizeAttempt(args: string[], result: CommandResult): string {
  const status =
    result.error?.code ??
    (result.timedOut ? "timeout" : `exit:${result.exitCode ?? "null"}`);

  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(" | ");
  const output = combined.length > 140 ? `${combined.slice(0, 137)}...` : combined || "no output";

  return `[${args.join(" ")}] ${status} - ${output}`;
}

function isCodexUnavailableError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM";
}
