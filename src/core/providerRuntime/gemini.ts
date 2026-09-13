import { appendFileSync } from "fs";
import { runCommand, type CommandResult, type CommandStreamHandlers } from "../process/CommandRunner.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { GEMINI_DEFAULT_MODEL_ID, GEMINI_FALLBACK_MODELS, normalizeGeminiModelId } from "./models.js";
import type { ProviderBackendKind, ProviderChatRequest, ProviderRouteValidationResult, ProviderRuntime, ResolvedRuntimeConfig } from "./types.js";
import { formatConversationHistory } from "../../session/conversation.js";
import { resolveGeminiExecutable } from "../executables/geminiExecutable.js";

// ─── Diagnostics ─────────────────────────────────────────────────────────────

const GEMINI_DIAG_LOG = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/ubume-gemini-diag.log`;
function isGeminiDiagEnabled(): boolean {
  return process.env.UBUME_GEMINI_DEBUG === "1";
}

function diagLog(msg: string): void {
  if (!isGeminiDiagEnabled()) return;
  try { appendFileSync(GEMINI_DIAG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = Number(process.env.UBUME_GEMINI_TIMEOUT_MS?.trim()) || 120_000;
const GEMINI_ROUTE_VALIDATION_TIMEOUT_MS = 30_000;
const GEMINI_READY_PROMPT = "Respond with READY only.";
const GEMINI_REASONING_UNSUPPORTED_DIAGNOSTIC = "Gemini reasoning control is not supported by this CLI version.";
export const GEMINI_ROUTE_SETUP_MESSAGE = "Google/Gemini is not configured for in-Ubume routing yet. Sign in with Gemini CLI headless auth or set GEMINI_API_KEY / GOOGLE_API_KEY.";

type CommandRunner = typeof runCommand;
export type GeminiApprovalMode = "default" | "plan" | "auto_edit" | "yolo";
export type GeminiOutputFormat = "text" | "json" | "stream-json";
export type GeminiCommandMode = "readiness" | "prompt";
type GeminiExtractionStatus = "assistant-text" | "completed-empty-assistant" | "not-completed";

export interface GeminiCommandSpec {
  file: string;
  args: string[];
  cwd: string;
  mode: GeminiCommandMode;
  model?: string;
  reasoning?: string;
  approvalMode: GeminiApprovalMode;
  outputFormat: GeminiOutputFormat;
  includesPolicy: boolean;
}

interface GeminiPromptRunDiagnostics {
  command: GeminiCommandSpec;
  redactedArgs: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: CommandResult["status"];
  stdoutSnippet: string;
  stderrSnippet: string;
  extractionStatus: GeminiExtractionStatus;
  parseMode: "plain-text";
  parsedEvents: number;
  parsedMessages: number;
  finalAssistantTextLength: number;
  finalAssistantTextPreview: string;
  stderrWarningTextPresent: boolean;
}

let geminiCliHeadlessValidated = false;
let resolvedGeminiCommand: string | null = null;
let lastPromptDiagnostics: GeminiPromptRunDiagnostics | null = null;

function getGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null;
}

export function hasGeminiApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return getGeminiApiKey(env) !== null;
}

export function isGeminiRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasGeminiApiKey(env) || geminiCliHeadlessValidated;
}

export function resetGeminiRouteValidationCacheForTests(): void {
  geminiCliHeadlessValidated = false;
  resolvedGeminiCommand = null;
  lastPromptDiagnostics = null;
}

function parseGeminiJsonResponse(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && "response" in parsed) {
      const response = (parsed as { response?: unknown }).response;
      return typeof response === "string" ? response : null;
    }
  } catch {
    return null;
  }

  return null;
}

function firstUsefulOutputLine(result: Pick<CommandResult, "stdout" | "stderr" | "userMessage">): string | null {
  return sanitizeTerminalOutput(`${result.stderr}\n${result.stdout}\n${result.userMessage}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function getCombinedOutput(result: Pick<CommandResult, "stdout" | "stderr" | "userMessage">): string {
  return sanitizeTerminalOutput(`${result.stderr}\n${result.stdout}\n${result.userMessage}`);
}

export function resolveGeminiApprovalMode(runtime?: ResolvedRuntimeConfig | boolean): GeminiApprovalMode {
  if (typeof runtime === "boolean") {
    return runtime ? "plan" : "default";
  }

  if (!runtime) return "default";
  if (runtime.planMode || runtime.mode === "suggest" || runtime.policy.sandboxMode === "read-only") {
    return "plan";
  }
  if (runtime.mode === "auto-edit") {
    return "auto_edit";
  }
  if (
    runtime.mode === "full-auto"
    || (runtime.policy.approvalPolicy === "never" && runtime.policy.sandboxMode === "danger-full-access")
  ) {
    return "yolo";
  }
  return "default";
}

// ─── Command building ─────────────────────────────────────────────────────────

export function buildGeminiCliValidationArgs(): string[] {
  return ["--model", GEMINI_DEFAULT_MODEL_ID, "-p", GEMINI_READY_PROMPT];
}

export function buildGeminiCliPromptArgs(
  prompt: string,
  modelId?: string | null,
  runtime?: ResolvedRuntimeConfig | boolean,
): string[] {
  void runtime;
  const resolvedModelId = normalizeGeminiModelId(modelId);
  return [
    "--model",
    resolvedModelId,
    "-p",
    prompt,
  ];
}

export async function buildGeminiCommand(options: {
  cwd: string;
  mode: GeminiCommandMode;
  prompt?: string;
  model?: string | null;
  reasoning?: string | null;
  runtime?: ResolvedRuntimeConfig | boolean;
  configuredPath?: string | null;
  runCommandImpl?: CommandRunner;
  outputFormat?: GeminiOutputFormat;
}): Promise<GeminiCommandSpec> {
  const file = await resolveGeminiExecutable({
    runCommandImpl: options.runCommandImpl,
    cwd: options.cwd,
    configuredPath: options.configuredPath,
  });
  resolvedGeminiCommand = file;

  const approvalMode = resolveGeminiApprovalMode(options.runtime);
  const outputFormat = options.outputFormat ?? "text";
  const model = options.mode === "readiness" ? GEMINI_DEFAULT_MODEL_ID : normalizeGeminiModelId(options.model);
  const args = options.mode === "readiness"
    ? ["--model", model, "-p", GEMINI_READY_PROMPT]
    : [
      "--model",
      model,
      "-p",
      options.prompt ?? "",
    ];

  return {
    file,
    args,
    cwd: options.cwd,
    mode: options.mode,
    model,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    approvalMode,
    outputFormat,
    includesPolicy: args.includes("--policy") || args.includes("--admin-policy") || args.some((arg) => /auto-saved\.toml/i.test(arg)),
  };
}

function redactedPromptArgs(command: GeminiCommandSpec): string[] {
  if (command.mode !== "prompt") return [...command.args];
  const args = [...command.args];
  const promptIndex = args.indexOf("-p");
  if (promptIndex >= 0 && promptIndex + 1 < args.length) {
    args[promptIndex + 1] = "<prompt>";
  }
  return args;
}

function diagnosticArgs(command: GeminiCommandSpec): string {
  return JSON.stringify(command.mode === "prompt" ? redactedPromptArgs(command) : command.args);
}

function recordPromptDiagnostics(command: GeminiCommandSpec, result: CommandResult): void {
  lastPromptDiagnostics = {
    command,
    redactedArgs: redactedPromptArgs(command),
    exitCode: result.exitCode,
    signal: result.signal,
    status: result.status,
    stdoutSnippet: sanitizeTerminalOutput(result.stdout).trim().slice(0, 500),
    stderrSnippet: sanitizeTerminalOutput(result.stderr).trim().slice(0, 500),
    extractionStatus: "not-completed",
    parseMode: "plain-text",
    parsedEvents: 0,
    parsedMessages: 0,
    finalAssistantTextLength: 0,
    finalAssistantTextPreview: "",
    stderrWarningTextPresent: /warning|ripgrep is not available|falling back to greptool/i.test(result.stderr),
  };
}

function recordExtractionDiagnostics(result: CommandResult, text: string): GeminiExtractionStatus {
  const extractionStatus: GeminiExtractionStatus = result.status === "completed" && result.exitCode === 0
    ? text.trim()
      ? "assistant-text"
      : "completed-empty-assistant"
    : "not-completed";

  if (lastPromptDiagnostics) {
    lastPromptDiagnostics = {
      ...lastPromptDiagnostics,
      extractionStatus,
      finalAssistantTextLength: text.length,
      finalAssistantTextPreview: "",
    };
  }

  diagLog([
    "PARSED:",
    `parseMode=plain-text`,
    `parsedEvents=0`,
    `parsedMessages=0`,
    `extractionStatus=${extractionStatus}`,
    `finalExtractedAssistantText.length=${text.length}`,
    `stderrWarningTextPresent=${/warning|ripgrep is not available|falling back to greptool/i.test(result.stderr)}`,
  ].join(" "));

  return extractionStatus;
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function executeGeminiCommand(
  command: GeminiCommandSpec,
  runCommandImpl: CommandRunner,
  timeoutMs: number,
  handlers?: CommandStreamHandlers,
): Promise<CommandResult> {
  let stdoutChunkCount = 0;
  let stderrChunkCount = 0;
  const lifecycleEvents: string[] = [];
  const streamHandlers: CommandStreamHandlers = {
    onProcessLifecycle: (event) => {
      lifecycleEvents.push(event);
      diagLog(`PROCESS_LIFECYCLE: event=${event}`);
      handlers?.onProcessLifecycle?.(event);
    },
    onStdout: (text) => {
      stdoutChunkCount += 1;
      diagLog(`STDOUT_RAW_CHUNK: index=${stdoutChunkCount} length=${text.length}`);
      handlers?.onStdout?.(text);
    },
    onStderr: (text) => {
      stderrChunkCount += 1;
      diagLog(`STDERR_RAW_CHUNK: index=${stderrChunkCount} length=${text.length}`);
      handlers?.onStderr?.(text);
    },
  };

  diagLog([
    "EXECUTE_COMMAND:",
    `resolvedCommand=${command.file}`,
    `argv=${diagnosticArgs(command)}`,
    `cwd=${command.cwd}`,
    `shell=false`,
  ].join(" "));

  const runner = runCommandImpl({
    executable: command.file,
    args: command.args,
    cwd: command.cwd,
    timeoutMs,
  }, streamHandlers);
  diagLog(`SPAWNED: pid=${runner.child?.pid ?? "unknown"} executable=${command.file} timeoutMs=${timeoutMs}`);
  const result = await runner.result;
  diagLog(`PROCESS_CLOSE_EVENT: closeObserved=true status=${result.status} exitCode=${result.exitCode} signal=${result.signal}`);
  diagLog(`CLOSED: status=${result.status} exitCode=${result.exitCode} signal=${result.signal} durationMs=${result.durationMs} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length} stdoutChunks=${stdoutChunkCount} stderrChunks=${stderrChunkCount} lifecycle=${JSON.stringify(lifecycleEvents)}`);
  return result;
}

async function runGeminiApi(request: ProviderChatRequest): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(GEMINI_ROUTE_SETUP_MESSAGE);
  }

  const modelId = normalizeGeminiModelId(request.route.modelId);
  const response = await fetch(`${GEMINI_API_BASE_URL}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: request.conversationHistory?.length
            ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
            : request.prompt }],
        },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini API request failed (${response.status}): ${sanitizeTerminalOutput(body).slice(0, 500)}`);
  }

  const parsed = JSON.parse(body) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = parsed.candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini API returned no assistant text.");
  }

  return text;
}

function isPolicyFileError(result: CommandResult): boolean {
  return /policy file error|auto-saved\.toml/i.test(getCombinedOutput(result));
}

function isInvalidModelError(result: CommandResult): boolean {
  const combined = getCombinedOutput(result);
  return /\b(model)\b[\s\S]{0,80}\b(not found|invalid|unknown|unsupported|does not exist|not supported)\b/i.test(combined)
    || /\b(not found|invalid|unknown|unsupported)\b[\s\S]{0,80}\b(model)\b/i.test(combined);
}

function formatGeminiFailure(command: GeminiCommandSpec, result: CommandResult): string {
  const combinedOutput = getCombinedOutput(result).trim();
  if (isPolicyFileError(result)) {
    return [
      "Policy file error in Gemini CLI.",
      `Command file: ${command.file}`,
      `Command args: ${JSON.stringify(redactedPromptArgs(command))}`,
      `Included --policy: ${command.args.includes("--policy")}`,
      `Included --admin-policy: ${command.args.includes("--admin-policy")}`,
      `Included policy file: ${command.includesPolicy}`,
      `First useful output: ${firstUsefulOutputLine(result) ?? "Unknown error"}`,
    ].join("\n");
  }
  if (result.status === "timeout") {
    return [
      `Gemini CLI prompt timed out after ${GEMINI_TIMEOUT_MS}ms.`,
      `Command file: ${command.file}`,
      `Command args: ${JSON.stringify(redactedPromptArgs(command))}`,
      result.stderr.trim() ? `Stderr: ${result.stderr.trim().slice(0, 500)}` : null,
      result.stdout.trim() ? `Stdout: ${result.stdout.trim().slice(0, 500)}` : null,
    ].filter(Boolean).join("\n");
  }
  return combinedOutput || result.userMessage || "Gemini CLI headless route failed.";
}

async function runGeminiCliAttempt(
  request: ProviderChatRequest,
  runCommandImpl: CommandRunner,
  modelId: string | null,
  handlers?: CommandStreamHandlers,
): Promise<{ command: GeminiCommandSpec; result: CommandResult }> {
  const command = await buildGeminiCommand({
    cwd: request.workspaceRoot,
    mode: "prompt",
    prompt: request.conversationHistory?.length
      ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
      : request.prompt,
    model: modelId,
    reasoning: request.route.reasoning,
    runtime: request.runtime,
    configuredPath: request.runtime.geminiCommandPath,
    runCommandImpl,
    outputFormat: "text",
  });
  const result = await executeGeminiCommand(command, runCommandImpl, GEMINI_TIMEOUT_MS, handlers);
  recordPromptDiagnostics(command, result);
  return { command, result };
}

export async function runGeminiCliWithRunner(
  request: ProviderChatRequest,
  runCommandImpl: CommandRunner = runCommand,
  handlers?: CommandStreamHandlers,
): Promise<string> {
  const first = await runGeminiCliAttempt(request, runCommandImpl, request.route.modelId, handlers);
  diagLog(`ATTEMPT1: status=${first.result.status} exitCode=${first.result.exitCode} stdout.len=${first.result.stdout.length} stderr.len=${first.result.stderr.length}`);
  if (first.result.status === "completed" && first.result.exitCode === 0) {
    const text = sanitizeTerminalOutput(first.result.stdout).trim();
    const extractionStatus = recordExtractionDiagnostics(first.result, text);
    if (!text) {
      diagLog(`EMPTY_STDOUT: stdout is empty after sanitize+trim.`);
      diagLog(`EMPTY_STDOUT: stderr.len=${first.result.stderr.length} stdout.len=${first.result.stdout.length}`);
      diagLog(`EMPTY_STDOUT: extractionStatus=${extractionStatus}. Gemini likely wrote response to stderr or emitted no assistant text. Run will complete with no rendered assistant content unless app boundary treats this as an error.`);
    }
    diagLog(`SUCCESS: returning text.length=${text.length}`);
    return text;
  }

  recordExtractionDiagnostics(first.result, "");
  diagLog(`FAILURE: isInvalidModel=${request.route.modelId ? isInvalidModelError(first.result) : false} status=${first.result.status} exitCode=${first.result.exitCode}`);

  throw new Error(formatGeminiFailure(first.command, first.result));
}

async function runGeminiCli(request: ProviderChatRequest, handlers?: CommandStreamHandlers): Promise<string> {
  return runGeminiCliWithRunner(request, runCommand, handlers);
}

export function classifyGeminiProbeFailure(result: CommandResult): "auth required" | "quota/rate limit" | "bad flag" | "shell wrapper/function conflict" | "unknown" {
  const combined = getCombinedOutput(result);
  if (/parameter name 'p' is ambiguous|Possible matches include:[\s\S]*ProgressAction|PipelineVariable/i.test(combined)) {
    return "shell wrapper/function conflict";
  }
  if (/\b(auth|authentication|login|sign in|signin|unauthorized|not authenticated)\b/i.test(combined)) {
    return "auth required";
  }
  if (/\b(quota|rate limit|rate-limit|too many requests|resource exhausted|429)\b/i.test(combined)) {
    return "quota/rate limit";
  }
  if (/\b(unknown|invalid|unrecognized|unexpected)\b/i.test(combined) && /\b(flag|option|argument|parameter)\b/i.test(combined)) {
    return "bad flag";
  }
  return "unknown";
}

async function captureGeminiEnvironment(
  cwd: string,
  runCommandImpl: CommandRunner,
  configuredPath?: string | null,
): Promise<{ path: string | null; version: string | null; commandCheckOk: boolean; commandCheckOutput: string | null }> {
  try {
    const resolved = await resolveGeminiExecutable({ runCommandImpl, cwd, configuredPath });
    const versionRunner = runCommandImpl({
      executable: resolved,
      args: ["--version"],
      cwd,
      timeoutMs: 5000,
    });
    const versionResult = await versionRunner.result;
    if (versionResult.status === "completed" && versionResult.exitCode === 0) {
      return {
        path: resolved,
        version: versionResult.stdout.trim() || versionResult.stderr.trim() || null,
        commandCheckOk: true,
        commandCheckOutput: versionResult.stdout.trim() || versionResult.stderr.trim() || null,
      };
    }

    const helpRunner = runCommandImpl({
      executable: resolved,
      args: ["--help"],
      cwd,
      timeoutMs: 5000,
    });
    const helpResult = await helpRunner.result;
    return {
      path: resolved,
      version: null,
      commandCheckOk: helpResult.status === "completed" && helpResult.exitCode === 0,
      commandCheckOutput: firstUsefulOutputLine(helpResult),
    };
  } catch {
    return { path: null, version: null, commandCheckOk: false, commandCheckOutput: null };
  }
}

// ─── Route validation ─────────────────────────────────────────────────────────

export async function validateGeminiRoute(options: {
  cwd: string;
  modelId: string;
  env?: NodeJS.ProcessEnv;
  runCommandImpl?: CommandRunner;
  timeoutMs?: number;
  configuredPath?: string | null;
}): Promise<ProviderRouteValidationResult> {
  const runImpl = options.runCommandImpl ?? runCommand;
  const envInfoPromise = captureGeminiEnvironment(options.cwd, runImpl, options.configuredPath);

  let command: GeminiCommandSpec;
  try {
    command = await buildGeminiCommand({
      cwd: options.cwd,
      mode: "readiness",
      model: options.modelId,
      configuredPath: options.configuredPath,
      runCommandImpl: runImpl,
      outputFormat: "text",
    });
  } catch (error) {
    geminiCliHeadlessValidated = false;
    const message = error instanceof Error ? error.message : "Gemini CLI executable was not found.";
    return {
      status: hasGeminiApiKey(options.env) ? "ready" : "not-configured",
      providerId: "google",
      backendKind: hasGeminiApiKey(options.env) ? "gemini-api-key" : "unavailable",
      message: hasGeminiApiKey(options.env) ? "Google/Gemini API key is configured." : `${message} Set GEMINI_EXECUTABLE to a known working Gemini CLI command/path.`,
      diagnostics: {
        resolvedCommand: null,
        executablePath: null,
        commandFile: null,
        headlessPromptMode: "-p",
        lastProbeCommandArgs: JSON.stringify(buildGeminiCliValidationArgs()),
        outputFormat: "text",
        includesPolicy: false,
        failureReason: "unknown",
      },
    };
  }

  const result = await executeGeminiCommand(command, runImpl, options.timeoutMs ?? GEMINI_ROUTE_VALIDATION_TIMEOUT_MS);
  const envInfo = await envInfoPromise;
  const parsed = parseGeminiJsonResponse(result.stdout);
  const probeText = sanitizeTerminalOutput(`${result.stdout}\n${result.stderr}\n${parsed ?? ""}`).trim();
  const probeMatch = /\bREADY\b/.test(probeText);
  const successfulGeminiResponse = result.status === "completed" && result.exitCode === 0 && probeMatch;
  const failureReason = classifyGeminiProbeFailure(result);

  const diagnostics: Record<string, string | number | boolean | null> = {
    resolvedCommand: command.file,
    executablePath: command.file,
    commandFile: command.file,
    version: envInfo.version,
    commandCheckOk: envInfo.commandCheckOk,
    commandCheckOutput: envInfo.commandCheckOutput,
    headlessPromptMode: "-p",
    probeStatus: successfulGeminiResponse ? "Ready" : result.status,
    command: `${command.file} ${command.args.join(" ")}`,
    lastProbeCommandFile: command.file,
    lastProbeCommandArgs: JSON.stringify(command.args),
    approvalMode: command.approvalMode,
    outputFormat: command.outputFormat,
    includesPolicy: command.includesPolicy,
    reasoningDiagnostic: GEMINI_REASONING_UNSUPPORTED_DIAGNOSTIC,
    status: result.status,
    exitCode: result.exitCode,
    timeout: result.status === "timeout",
    stdoutSummary: result.stdout.trim().slice(0, 200),
    stderrSummary: result.stderr.trim().slice(0, 200),
    firstUsefulOutputLine: firstUsefulOutputLine(result),
    failureReason,
    probeMatch,
    readyTokenObserved: probeMatch,
  };

  const looksFound = envInfo.path && (envInfo.commandCheckOk || (result.status !== "spawn_error" && result.errorCode !== "ENOENT"));
  if (successfulGeminiResponse) {
    geminiCliHeadlessValidated = true;
    return {
      status: "ready",
      providerId: "google",
      backendKind: "gemini-cli-auth",
      message: "Gemini CLI auth is configured.",
      diagnostics,
    };
  }

  geminiCliHeadlessValidated = false;
  if (hasGeminiApiKey(options.env)) {
    return {
      status: "ready",
      providerId: "google",
      backendKind: "gemini-api-key",
      message: "Google/Gemini API key is configured.",
      diagnostics,
    };
  }

  let errorMessage = GEMINI_ROUTE_SETUP_MESSAGE;
  if (failureReason === "shell wrapper/function conflict") {
    errorMessage = `PowerShell wrapper detected. Ubume is bypassing it and using:\n${command.file}`;
  } else if (result.status === "completed" && result.exitCode === 0) {
    errorMessage = "Gemini CLI responded, but Ubume could not validate the headless route. The probe returned unexpected output.";
  } else if (!looksFound) {
    errorMessage = "Gemini CLI was not found as a real executable file. Install Gemini CLI or set GEMINI_EXECUTABLE to a known working command/path.";
  } else if (result.status === "timeout") {
    errorMessage = "Installed but headless probe timed out.";
  } else if (result.status === "completed" && result.exitCode !== 0) {
    errorMessage = `Gemini CLI installed, auth unknown or headless mode failed. Run: ${command.file} --model ${command.model ?? GEMINI_DEFAULT_MODEL_ID} -p "Respond with READY only."`;
  } else if (result.status === "failed") {
    errorMessage = `Gemini CLI installed, auth unknown or headless mode failed. Run: ${command.file} --model ${command.model ?? GEMINI_DEFAULT_MODEL_ID} -p "Respond with READY only."`;
  }

  return {
    status: "not-configured",
    providerId: "google",
    backendKind: "unavailable",
    message: errorMessage,
    diagnostics,
  };
}

function getGeminiRuntimeBackendKind(): ProviderBackendKind {
  return geminiCliHeadlessValidated ? "gemini-cli-auth" : hasGeminiApiKey() ? "gemini-api-key" : "gemini-cli-auth";
}

function formatDiagnosticSnippet(label: string, value: string | null | undefined): string | null {
  return value?.trim() ? `${label}: ${value.trim().slice(0, 500)}` : null;
}

export async function runGeminiDiagnostics(options: {
  cwd: string;
  selectedModel?: string | null;
  selectedReasoning?: string | null;
  runtime: ResolvedRuntimeConfig;
  configuredPath?: string | null;
  runCommandImpl?: CommandRunner;
}): Promise<string> {
  const runImpl = options.runCommandImpl ?? runCommand;
  const selectedModel = normalizeGeminiModelId(options.selectedModel);
  const envInfo = await captureGeminiEnvironment(options.cwd, runImpl, options.configuredPath ?? options.runtime.geminiCommandPath);
  const readiness = await validateGeminiRoute({
    cwd: options.cwd,
    modelId: selectedModel,
    configuredPath: options.configuredPath ?? options.runtime.geminiCommandPath,
    runCommandImpl: runImpl,
  });
  const readinessCommand = await buildGeminiCommand({
    cwd: options.cwd,
    mode: "readiness",
    model: selectedModel,
    runtime: options.runtime,
    configuredPath: options.configuredPath ?? options.runtime.geminiCommandPath,
    runCommandImpl: runImpl,
  });
  const promptPreview = await buildGeminiCommand({
    cwd: options.cwd,
    mode: "prompt",
    prompt: "<prompt>",
    model: selectedModel,
    reasoning: options.selectedReasoning,
    runtime: options.runtime,
    configuredPath: options.configuredPath ?? options.runtime.geminiCommandPath,
    runCommandImpl: runImpl,
  });

  return [
    "Gemini diagnostics:",
    `  Resolved executable path: ${envInfo.path ?? "Not found"}`,
    `  Version output: ${envInfo.version ?? "Unknown"}`,
    `  Readiness command file: ${readinessCommand.file}`,
    `  Readiness command args: ${JSON.stringify(readinessCommand.args)}`,
    `  Readiness result: ${readiness.status}${readiness.message ? ` - ${readiness.message}` : ""}`,
    `  Selected model: ${selectedModel}`,
    `  Selected approval mode: ${promptPreview.approvalMode}`,
    `  Selected output format: ${promptPreview.outputFormat}`,
    `  Policy args included: ${promptPreview.includesPolicy}`,
    `  Reasoning: ${options.selectedReasoning ?? "none"} (${GEMINI_REASONING_UNSUPPORTED_DIAGNOSTIC})`,
    `  Last prompt command file: ${lastPromptDiagnostics?.command.file ?? "none"}`,
    `  Last prompt command args: ${lastPromptDiagnostics ? JSON.stringify(lastPromptDiagnostics.redactedArgs) : "none"}`,
    `  Last exit code: ${lastPromptDiagnostics?.exitCode ?? "none"}`,
    `  Last signal: ${lastPromptDiagnostics?.signal ?? "none"}`,
    `  Last parse mode: ${lastPromptDiagnostics?.parseMode ?? "none"}`,
    `  Last parsed events/messages: ${lastPromptDiagnostics ? `${lastPromptDiagnostics.parsedEvents}/${lastPromptDiagnostics.parsedMessages}` : "none"}`,
    `  Last extraction status: ${lastPromptDiagnostics?.extractionStatus ?? "none"}`,
    `  Last final assistant text length: ${lastPromptDiagnostics?.finalAssistantTextLength ?? "none"}`,
    `  Last stderr warning text present: ${lastPromptDiagnostics?.stderrWarningTextPresent ?? "none"}`,
    formatDiagnosticSnippet("  Last stdout", lastPromptDiagnostics?.stdoutSnippet),
    formatDiagnosticSnippet("  Last stderr", lastPromptDiagnostics?.stderrSnippet),
    formatDiagnosticSnippet("  Last final assistant text", lastPromptDiagnostics?.finalAssistantTextPreview),
    `  Prompt preview command file: ${promptPreview.file}`,
    `  Prompt preview command args: ${JSON.stringify(redactedPromptArgs(promptPreview))}`,
  ].filter(Boolean).join("\n");
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export const geminiRuntime: ProviderRuntime = {
  providerId: "google",
  label: "Google/Gemini",
  modelPickerLabel: "Gemini",
  backendKind: "gemini-cli-auth",
  routeAvailable: true,
  routeStatus: "Uses Gemini CLI subscription-backed route when available, otherwise GEMINI_API_KEY or GOOGLE_API_KEY.",
  routeSetupMessage: GEMINI_ROUTE_SETUP_MESSAGE,
  launchAvailable: true,
  isRouteConfigured: isGeminiRouteConfigured,
  validateRoute: async ({ route, workspaceRoot, geminiCommandPath }) => validateGeminiRoute({
    cwd: workspaceRoot,
    modelId: route.modelId,
    configuredPath: geminiCommandPath,
  }),
  discoverModels: () => ({
    status: "ready",
    providerId: "google",
    backendKind: getGeminiRuntimeBackendKind(),
    models: GEMINI_FALLBACK_MODELS,
  }),
  run: (request, handlers: BackendRunHandlers) => {
    let cancelled = false;

    diagLog(`=== RUN START: route=${JSON.stringify(request.route)} cwd=${request.workspaceRoot} geminiCommandPath=${request.runtime.geminiCommandPath ?? "unset"} geminiCliHeadlessValidated=${geminiCliHeadlessValidated} hasApiKey=${hasGeminiApiKey()}`);

    handlers.onProgress?.({
      id: "gemini-route",
      source: "stdout",
      text: "Starting Gemini CLI",
    });
    if (isGeminiDiagEnabled()) {
      handlers.onProgress?.({
        id: "gemini-diag",
        source: "stdout",
        text: `[DEBUG] Gemini diag log: ${GEMINI_DIAG_LOG}`,
      });
    }

    if (request.route.reasoning) {
      handlers.onProgress?.({
        id: "gemini-reasoning",
        source: "stdout",
        text: GEMINI_REASONING_UNSUPPORTED_DIAGNOSTIC,
      });
    }

    const childHandlers: CommandStreamHandlers = {
      onProcessLifecycle: (event) => {
        diagLog(`LIFECYCLE: ${event}`);
        handlers.onProcessLifecycle?.(event === "cancel" ? "cleanup" : event);
      },
      onStdout: (text) => { diagLog(`STDOUT chunk length=${text.length}`); },
      onStderr: (text) => { diagLog(`STDERR chunk length=${text.length}`); },
    };

    const execPath = geminiCliHeadlessValidated ? "runGeminiCli" : hasGeminiApiKey() ? "runGeminiApi" : "runGeminiCli (fallback-no-key)";
    diagLog(`EXEC PATH: geminiCliHeadlessValidated=${geminiCliHeadlessValidated} → ${execPath}`);

    const runGemini = geminiCliHeadlessValidated
      ? runGeminiCli(request, childHandlers)
      : hasGeminiApiKey()
        ? runGeminiApi(request)
        : runGeminiCli(request, childHandlers);

    runGemini
      .then((text) => {
        diagLog(`RESOLVED: text.length=${text.length} cancelled=${cancelled}`);
        if (!text) {
          diagLog(`EMPTY_RESPONSE: text is empty → onAssistantDelta !chunk guard will block it → run will finalize silently with no rendered assistant content`);
          diagLog(`NO_ERROR_CARD: runGeminiCliWithRunner returned "" (success path, not throw). .catch is NOT reached. handlers.onError is NOT called. finalizePromptRun will receive status="completed". RUN_FAILED is never dispatched. No error card appears.`);
        }
        if (cancelled) return;
        diagLog(`CALLING: onAssistantDelta onFinalAnswerObserved onResponse`);
        handlers.onAssistantDelta?.(text);
        handlers.onFinalAnswerObserved?.(text);
        handlers.onResponse(text);
        diagLog(`HANDLERS CALLED OK`);
      })
      .catch((error) => {
        diagLog(`REJECTED: cancelled=${cancelled} errorType=${error instanceof Error ? error.name : typeof error}`);
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Google/Gemini in-Ubume routing failed.";
        diagLog(`CALLING: onError`);
        handlers.onError(message);
      });

    return () => {
      diagLog(`CANCEL CALLED`);
      cancelled = true;
    };
  },
};
