import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ProviderChatRequest } from "../providerRuntime/types.js";
import { executeAgentTool, type AgentToolResult } from "./tools.js";
import {
  parseAgentToolCall,
  serializeToolResult,
  type MalformedOpenAiToolCall,
  type NormalizedAgentToolCall,
} from "./protocol.js";

export interface AgentChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AgentChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: readonly AgentChatToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface AgentChatResponse {
  text: string;
  reasoning?: string;
  toolCalls?: readonly NormalizedAgentToolCall[];
  malformedToolCalls?: readonly MalformedOpenAiToolCall[];
  finishReason?: string | null;
}

export interface RunAgentLoopOptions {
  request: ProviderChatRequest;
  handlers: BackendRunHandlers;
  sendMessages: (messages: readonly AgentChatMessage[], turnIndex: number) => Promise<AgentChatResponse>;
  includeSystemPrompt: boolean;
  toolProtocol?: "none" | "text" | "openai";
  signal?: AbortSignal;
  maxConsecutiveNoProgressCalls?: number;
}

const DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_CALLS = 3;

function workspaceSummary(workspaceRoot: string): string {
  const lines = [`Workspace root: ${workspaceRoot}`];
  try {
    const entries = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => ![".git", "node_modules", "dist", "build", "coverage"].includes(entry.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .slice(0, 20);
    if (entries.length > 0) lines.push(`Top-level entries: ${entries.join(", ")}`);
  } catch {
    // Tool-based inspection remains available when a shallow summary is unavailable.
  }

  try {
    const packageJsonPath = path.join(workspaceRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      const name = typeof packageJson.name === "string" ? packageJson.name : null;
      const description = typeof packageJson.description === "string" ? packageJson.description : null;
      if (name) lines.push(`Package: ${name}${description ? ` - ${description}` : ""}`);
    }
  } catch {
    // A malformed package.json should not prevent a local chat request.
  }

  return lines.join("\n");
}

function localAgentSystemPrompt(request: ProviderChatRequest, toolProtocol: "none" | "text" | "openai"): string {
  const hasCargoToml = existsSync(path.join(request.workspaceRoot, "Cargo.toml"));
  const planning = request.runIntent === "plan";
  return [
    `You are an autonomous coding assistant running inside this workspace: ${request.workspaceRoot}`,
    "You must inspect files with tools before claiming you cannot see them.",
    "For broad questions about the repository, use the workspace summary below, then inspect with get_workspace_info or list_files before answering when more detail is needed.",
    planning
      ? "PLAN MODE: inspect the repository and return a concrete Markdown implementation plan. Do not write files, apply patches, or run shell commands."
      : "Use tools to create, edit, build, and test when the user asks for workspace changes.",
    planning
      ? null
      : "When the user explicitly asks you to commit, push, or open a pull request, complete those actions with tools when runtime policy permits. Do not replace unfinished authorized work with commands for the user to run.",
    "Keep inspecting and acting until the requested work is complete or a concrete external blocker prevents progress. Never mention internal tool budgets or claim a file, commit, push, or pull request exists unless a tool confirmed it.",
    "Do not ask vague clarification questions when the user's intent has an obvious safe implementation.",
    hasCargoToml
      ? "Rust workspace note: Cargo.toml exists. Prefer src/main.rs for simple binaries, use cargo check for validation, use cargo run for running, and do not use rustc main.rs unless main.rs is truly at the workspace root."
      : null,
    toolProtocol === "text" ? "Use exactly one tool call at a time in this format:" : null,
    toolProtocol === "text" ? '<tool_call>{"name":"read_file","arguments":{"path":"src/index.tsx"}}</tool_call>' : null,
    toolProtocol === "text"
      ? planning
        ? "Available tools: list_files, read_file, get_workspace_info."
        : "Available tools: list_files, read_file, write_file, apply_patch, run_shell, get_workspace_info."
      : toolProtocol === "openai"
        ? "Use the provided API tools when workspace inspection or action is required."
        : "No workspace tools are available for this model.",
    "Summarize changed files and commands run in your final answer.",
    `Workspace summary:\n${workspaceSummary(request.workspaceRoot)}`,
    request.projectInstructions?.content
      ? ["Project instructions:", request.projectInstructions.content].join("\n")
      : null,
  ].filter(Boolean).join("\n\n");
}

function buildInitialMessages(
  request: ProviderChatRequest,
  includeSystemPrompt: boolean,
  toolProtocol: "none" | "text" | "openai",
): AgentChatMessage[] {
  const systemPrompt = localAgentSystemPrompt(request, toolProtocol);
  if (includeSystemPrompt) {
    return [
      { role: "system", content: systemPrompt },
      ...(request.conversationHistory ?? []).map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: request.prompt },
    ];
  }

  return [
    ...(request.conversationHistory ?? []).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: `${systemPrompt}\n\nUser request:\n${request.prompt}` },
  ];
}

function toolActivityCommand(result: Pick<AgentToolResult, "tool" | "path" | "paths" | "command">): string {
  if (result.command) return `${result.tool}: ${result.command}`;
  if (result.path) return `${result.tool}: ${result.path}`;
  if (result.paths && result.paths.length > 0) return `${result.tool}: ${result.paths.join(", ")}`;
  return result.tool;
}

interface ExecutedCommand {
  command: string;
  success: boolean;
  exitCode?: number | null;
  durationMs?: number;
}

interface AgentLoopSummary {
  changedFiles: Set<string>;
  commands: ExecutedCommand[];
  toolResults: AgentToolResult[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(call: Pick<NormalizedAgentToolCall, "name" | "arguments">): string {
  return `${call.name}:${stableJson(call.arguments)}`;
}

function toolResultFingerprint(result: AgentToolResult): string {
  const { durationMs: _durationMs, ...stableResult } = result;
  return stableJson(stableResult);
}

function recordToolResult(summary: AgentLoopSummary, result: AgentToolResult): void {
  for (const file of result.paths ?? []) {
    if (file) summary.changedFiles.add(file);
  }
  if (result.path && (result.tool === "write_file" || result.tool === "apply_patch")) {
    summary.changedFiles.add(result.path);
  }
  if (result.command) {
    summary.commands.push({
      command: result.command,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  }
  summary.toolResults.push(result);
}

function commandStatus(command: ExecutedCommand): string {
  const status = command.success ? "succeeded" : "failed";
  const exitCode = command.exitCode === undefined ? "" : `, exit ${command.exitCode ?? "n/a"}`;
  return `- ${command.command}: ${status}${exitCode}`;
}

function synthesizeFinalMessage(_request: ProviderChatRequest, summary: AgentLoopSummary, reason: string): string {
  const files = [...summary.changedFiles].sort();
  const commandLines = summary.commands.map(commandStatus);
  return [
    reason,
    "",
    "Files changed:",
    files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- None detected",
    "",
    "Commands run:",
    commandLines.length > 0 ? commandLines.join("\n") : "- None",
  ].join("\n").trim();
}

async function requestFinalAnswer(options: RunAgentLoopOptions, messages: AgentChatMessage[], toolCallCount: number, reason: string): Promise<string | null> {
  messages.push({
    role: "user",
    content: [
      reason,
      "Repeated tool calls are no longer changing the result. Stop calling tools and report the exact blocker using only confirmed tool results.",
      "Include files changed and commands run with their outcomes. Do not expose internal loop controls, claim unfinished work is complete, or delegate runnable actions to the user unless the required capability is genuinely unavailable.",
    ].join("\n"),
  });
  const response = await options.sendMessages(messages, toolCallCount);
  if ((response.toolCalls?.length ?? 0) > 0 || (response.malformedToolCalls?.length ?? 0) > 0) return null;
  const parsed = parseAgentToolCall(response.text);
  return parsed.kind === "final" && parsed.text.trim() ? parsed.text.trim() : null;
}

function wireToolCall(call: NormalizedAgentToolCall, id: string): AgentChatToolCall {
  return {
    id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.rawArguments || JSON.stringify(call.arguments),
    },
  };
}

function malformedWireToolCall(call: MalformedOpenAiToolCall, id: string): AgentChatToolCall {
  return {
    id,
    type: "function",
    function: {
      name: call.name ?? "unknown",
      arguments: call.rawArguments || "{}",
    },
  };
}

function appendToolResultMessage(
  messages: AgentChatMessage[],
  native: boolean,
  toolCallId: string,
  result: unknown,
): void {
  const content = serializeToolResult(result);
  messages.push(native
    ? { role: "tool", tool_call_id: toolCallId, content }
    : { role: "user", content });
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<string> {
  const maxConsecutiveNoProgressCalls = Math.max(
    1,
    Math.floor(options.maxConsecutiveNoProgressCalls ?? DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_CALLS),
  );
  const toolProtocol = options.toolProtocol ?? "text";
  const messages = buildInitialMessages(options.request, options.includeSystemPrompt, toolProtocol);
  let toolCallCount = 0;
  const completedToolCallIds = new Set<string>();
  const previousToolResults = new Map<string, string>();
  let consecutiveNoProgressCalls = 0;
  const approvedForRun = new Set<string>();
  const summary: AgentLoopSummary = {
    changedFiles: new Set(),
    commands: [],
    toolResults: [],
  };

  while (true) {
    if (options.signal?.aborted) {
      throw new Error("Local agent run was canceled.");
    }

    const response = await options.sendMessages(messages, toolCallCount);
    const structuredCalls = [...(response.toolCalls ?? [])];
    const malformedCalls = [...(response.malformedToolCalls ?? [])];
    const native = structuredCalls.length > 0 || malformedCalls.length > 0;
    let calls = structuredCalls;
    let textMalformed: { error: string; raw: string } | null = null;

    if (!native) {
      const parsed = parseAgentToolCall(response.text);
      if (parsed.kind === "final") {
        if (response.finishReason === "tool_calls") {
          textMalformed = { error: "Completion ended with finish_reason=tool_calls but contained no tool calls.", raw: response.text };
        } else {
          return parsed.text.trim();
        }
      } else if (parsed.kind === "malformed_tool_call") {
        textMalformed = { error: parsed.error, raw: parsed.raw };
      } else {
        calls = [{
          id: parsed.id,
          name: parsed.name,
          arguments: parsed.arguments,
          rawArguments: parsed.rawArguments,
        }];
      }
    }

    if (toolProtocol === "none" && calls.length > 0) {
      textMalformed = { error: "Tool calls are disabled by the selected model capability profile.", raw: response.text };
      calls = [];
    }

    const callIds = calls.map((call, index) => call.id ?? `local-call-${toolCallCount + index + 1}`);
    const malformedIds = malformedCalls.map((call, index) => call.id ?? `local-malformed-${toolCallCount + index + 1}`);
    if (native) {
      messages.push({
        role: "assistant",
        content: response.text || null,
        ...(response.reasoning?.trim() ? { reasoning_content: response.reasoning } : {}),
        tool_calls: [
          ...calls.map((call, index) => wireToolCall(call, callIds[index]!)),
          ...malformedCalls.map((call, index) => malformedWireToolCall(call, malformedIds[index]!)),
        ],
      });
    } else {
      messages.push({ role: "assistant", content: response.text });
    }

    if (textMalformed) {
      toolCallCount += 1;
      appendToolResultMessage(messages, false, "", {
        success: false,
        error: `Malformed tool call: ${textMalformed.error}`,
        raw: textMalformed.raw,
      });
      consecutiveNoProgressCalls += 1;
      if (consecutiveNoProgressCalls >= maxConsecutiveNoProgressCalls) {
        const reason = "The Local agent repeated malformed tool calls without making progress.";
        const final = await requestFinalAnswer(options, messages, toolCallCount, reason);
        return final ?? synthesizeFinalMessage(options.request, summary, reason);
      }
      continue;
    }

    for (let index = 0; index < malformedCalls.length; index += 1) {
      const malformed = malformedCalls[index]!;
      toolCallCount += 1;
      appendToolResultMessage(messages, true, malformedIds[index]!, {
        success: false,
        tool: malformed.name ?? "unknown",
        error: `Malformed tool call: ${malformed.error}`,
        raw: malformed.rawArguments,
      });
      consecutiveNoProgressCalls += 1;
    }
    if (consecutiveNoProgressCalls >= maxConsecutiveNoProgressCalls) {
      const reason = "The Local agent repeated malformed tool calls without making progress.";
      const final = await requestFinalAnswer(options, messages, toolCallCount, reason);
      return final ?? synthesizeFinalMessage(options.request, summary, reason);
    }

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const callId = callIds[index]!;
      const signature = toolCallSignature(call);
      if (completedToolCallIds.has(callId)) {
        const reason = `Local agent replayed completed tool call ID ${callId}.`;
        appendToolResultMessage(messages, native, callId, {
          success: false,
          tool: call.name,
          error: reason,
        });
        consecutiveNoProgressCalls += 1;
        if (consecutiveNoProgressCalls >= maxConsecutiveNoProgressCalls) {
          const finalReason = "The Local agent replayed completed tool calls without making progress.";
          const final = await requestFinalAnswer(options, messages, toolCallCount, finalReason);
          return final ?? synthesizeFinalMessage(options.request, summary, finalReason);
        }
        continue;
      }

      completedToolCallIds.add(callId);
      toolCallCount += 1;
      const activityId = `local-agent-${toolCallCount}-${call.name}`;
      const startedAt = Date.now();
      const runningCommand = toolActivityCommand({
        tool: call.name,
        path: typeof call.arguments.path === "string" ? call.arguments.path : undefined,
        command: typeof call.arguments.command === "string" ? call.arguments.command : undefined,
      });
      const mutating = call.name === "write_file" || call.name === "apply_patch" || call.name === "run_shell";
      let deniedReason: string | null = null;
      if (mutating && options.request.runIntent === "plan") {
        deniedReason = "This tool is unavailable in Plan mode. Continue with read-only inspection and return a plan.";
      } else if (
        mutating
        && options.request.runtime.policy.approvalPolicy !== "never"
        && !approvedForRun.has(signature)
      ) {
        const rawPath = typeof call.arguments.path === "string" ? call.arguments.path : null;
        const patchPaths = call.name === "apply_patch" && typeof call.arguments.patch === "string"
          ? [...call.arguments.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1]!.trim())
          : [];
        const decision = await options.handlers.onToolApproval?.({
          tool: call.name,
          signature,
          command: typeof call.arguments.command === "string" ? call.arguments.command : undefined,
          paths: rawPath ? [rawPath] : patchPaths,
        }) ?? "deny";
        if (decision === "deny") deniedReason = "User denied this local-model action.";
        if (decision === "allow-for-run") approvedForRun.add(signature);
      }

      if (deniedReason) {
        const denied: AgentToolResult = { success: false, tool: call.name, error: deniedReason };
        options.handlers.onToolActivity?.({
          id: activityId,
          command: runningCommand,
          status: "failed",
          startedAt,
          completedAt: Date.now(),
          summary: deniedReason,
        });
        recordToolResult(summary, denied);
        appendToolResultMessage(messages, native, callId, denied);
        const deniedFingerprint = toolResultFingerprint(denied);
        const previousDenied = previousToolResults.get(signature);
        previousToolResults.set(signature, deniedFingerprint);
        consecutiveNoProgressCalls = previousDenied === deniedFingerprint
          ? consecutiveNoProgressCalls + 1
          : 0;
        if (consecutiveNoProgressCalls >= maxConsecutiveNoProgressCalls) {
          const reason = "The Local agent repeated denied tool calls without making progress.";
          const final = await requestFinalAnswer(options, messages, toolCallCount, reason);
          return final ?? synthesizeFinalMessage(options.request, summary, reason);
        }
        continue;
      }

      options.handlers.onToolActivity?.({ id: activityId, command: runningCommand, status: "running", startedAt });
      const result = await executeAgentTool(call.name, call.arguments, {
        workspaceRoot: options.request.workspaceRoot,
        runtime: options.request.runtime,
        signal: options.signal,
      });
      const completedCommand = toolActivityCommand(result);
      options.handlers.onToolActivity?.({
        id: activityId,
        command: completedCommand,
        status: result.success ? "completed" : "failed",
        startedAt,
        completedAt: Date.now(),
        summary: result.summary ?? result.error ?? null,
      });
      recordToolResult(summary, result);
      appendToolResultMessage(messages, native, callId, result);
      const resultFingerprint = toolResultFingerprint(result);
      const previousResult = previousToolResults.get(signature);
      previousToolResults.set(signature, resultFingerprint);
      consecutiveNoProgressCalls = previousResult === resultFingerprint
        ? consecutiveNoProgressCalls + 1
        : 0;
      if (consecutiveNoProgressCalls >= maxConsecutiveNoProgressCalls) {
        const reason = "The Local agent repeated tool calls with unchanged results and could not make further progress.";
        const final = await requestFinalAnswer(options, messages, toolCallCount, reason);
        return final ?? synthesizeFinalMessage(options.request, summary, reason);
      }
    }
  }
}
