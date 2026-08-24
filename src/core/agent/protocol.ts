export type AgentToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "run_shell"
  | "get_workspace_info";

export interface ParsedAgentToolCall {
  kind: "tool_call";
  id?: string | null;
  name: AgentToolName;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  raw: string;
}

export interface NormalizedAgentToolCall {
  id?: string | null;
  name: AgentToolName;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface MalformedOpenAiToolCall {
  kind: "malformed";
  id: string | null;
  name: string | null;
  rawArguments: string;
  error: string;
}

export type OpenAiToolCallParseResult =
  | { kind: "valid"; call: NormalizedAgentToolCall }
  | MalformedOpenAiToolCall;

export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface MalformedAgentToolCall {
  kind: "malformed_tool_call";
  raw: string;
  error: string;
}

export type AgentToolParseResult =
  | { kind: "final"; text: string }
  | ParsedAgentToolCall
  | MalformedAgentToolCall;

const TOOL_CALL_PATTERN = /<tool_call>([\s\S]*?)<\/tool_call>/i;
const TOOL_CALL_OPEN_PATTERN = /<tool_call\b[^>]*>/i;

const TOOL_NAMES = new Set<AgentToolName>([
  "list_files",
  "read_file",
  "write_file",
  "apply_patch",
  "run_shell",
  "get_workspace_info",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonMaybeWithExtraBrace(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (firstError) {
    const trimmed = raw.trim();
    if (trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed.slice(0, -1)) as unknown;
      } catch {
        // Return the original parse error below.
      }
    }
    throw firstError;
  }
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function rawArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function normalizeAgentToolCall(value: unknown): NormalizedAgentToolCall | null {
  if (!isRecord(value)) return null;

  const functionCall = isRecord(value.function) ? value.function : null;
  const rawName = functionCall?.name ?? value.name ?? value.tool;
  if (typeof rawName !== "string" || !TOOL_NAMES.has(rawName as AgentToolName)) {
    return null;
  }

  const args = parseArguments(functionCall?.arguments ?? value.arguments ?? value.args);
  if (!args) return null;

  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id : null,
    name: rawName as AgentToolName,
    arguments: args,
    rawArguments: rawArguments(functionCall?.arguments ?? value.arguments ?? value.args),
  };
}

export function parseOpenAiToolCallsDetailed(value: unknown): OpenAiToolCallParseResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const normalized = normalizeAgentToolCall(item);
    if (normalized) return { kind: "valid" as const, call: normalized };
    const record = isRecord(item) ? item : {};
    const functionCall = isRecord(record.function) ? record.function : null;
    const rawName = functionCall?.name ?? record.name ?? record.tool;
    const argsValue = functionCall?.arguments ?? record.arguments ?? record.args;
    const raw = rawArguments(argsValue);
    const parsedArgs = parseArguments(argsValue);
    const name = typeof rawName === "string" && rawName.trim() ? rawName : null;
    return {
      kind: "malformed" as const,
      id: typeof record.id === "string" && record.id.trim() ? record.id : null,
      name,
      rawArguments: raw,
      error: !name
        ? "Tool call did not contain a function name."
        : !TOOL_NAMES.has(name as AgentToolName)
          ? `Unsupported tool: ${name}`
          : parsedArgs === null
            ? "Tool call arguments were not valid JSON."
            : "Tool call could not be normalized.",
    };
  });
}

export function parseOpenAiToolCalls(value: unknown): NormalizedAgentToolCall[] {
  return parseOpenAiToolCallsDetailed(value)
    .filter((item): item is { kind: "valid"; call: NormalizedAgentToolCall } => item.kind === "valid")
    .map((item) => item.call);
}

const AGENT_TOOL_DEFINITIONS: readonly OpenAiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories inside the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write complete UTF-8 content to a file inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a Codex Begin Patch formatted patch inside the workspace.",
      parameters: {
        type: "object",
        properties: { patch: { type: "string" }, path: { type: "string" } },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a safe shell command in the workspace.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workspace_info",
      description: "Return workspace and runtime policy information.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export function agentToolDefinitions(runIntent: "normal" | "plan" | "approved-execution" = "normal"): readonly OpenAiToolDefinition[] {
  if (runIntent !== "plan") return AGENT_TOOL_DEFINITIONS;
  return AGENT_TOOL_DEFINITIONS.filter((definition) =>
    definition.function.name === "list_files"
    || definition.function.name === "read_file"
    || definition.function.name === "get_workspace_info"
  );
}

function extractJsonObjectAfterToolCall(text: string): string | null {
  const open = TOOL_CALL_OPEN_PATTERN.exec(text);
  if (!open) return null;

  const startSearch = open.index + open[0].length;
  const firstBrace = text.indexOf("{", startSearch);
  if (firstBrace < 0) return text.slice(startSearch).trim();

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, index + 1).trim();
      }
    }
  }

  return text.slice(firstBrace).replace(/<\/tool_call>.*/is, "").trim();
}

function parseToolCallPayload(raw: string): AgentToolParseResult {
  try {
    const parsed = parseJsonMaybeWithExtraBrace(raw);
    const fromToolCalls = isRecord(parsed) ? parseOpenAiToolCalls(parsed.tool_calls) : [];
    const normalized = fromToolCalls[0] ?? normalizeAgentToolCall(parsed);
    if (!normalized) {
      return { kind: "malformed_tool_call", raw, error: "Tool call JSON did not contain a supported tool call." };
    }

    return {
      kind: "tool_call",
      ...normalized,
      raw,
    };
  } catch (error) {
    return {
      kind: "malformed_tool_call",
      raw,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseAgentToolCall(text: string): AgentToolParseResult {
  const closedMatch = TOOL_CALL_PATTERN.exec(text);
  const raw = closedMatch?.[1]?.trim() ?? extractJsonObjectAfterToolCall(text);
  if (!raw) {
    return TOOL_CALL_OPEN_PATTERN.test(text)
      ? { kind: "malformed_tool_call", raw: "", error: "Tool call block did not contain JSON." }
      : { kind: "final", text };
  }

  return parseToolCallPayload(raw);
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function blockField(name: string, value: unknown): string[] {
  return [`${name}:`, scalar(value)];
}

export function serializeToolResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const tool = typeof record.tool === "string" ? record.tool : "unknown";
  const lines: string[] = [`<tool_result name="${tool}">`];

  lines.push(`success: ${scalar(record.success)}`);
  if (record.command !== undefined) lines.push(`command: ${scalar(record.command)}`);
  if (record.path !== undefined) lines.push(`path: ${scalar(record.path)}`);
  if (record.paths !== undefined) lines.push(`paths: ${Array.isArray(record.paths) ? record.paths.join(", ") : scalar(record.paths)}`);
  if (record.exitCode !== undefined) lines.push(`exit_code: ${scalar(record.exitCode)}`);
  if (record.durationMs !== undefined) lines.push(`duration_ms: ${scalar(record.durationMs)}`);
  if (record.summary !== undefined) lines.push(...blockField("summary", record.summary));
  if (record.error !== undefined) lines.push(...blockField("error", record.error));

  if (tool === "run_shell") {
    lines.push(...blockField("stdout", record.stdout ?? record.output ?? ""));
    lines.push(...blockField("stderr", record.stderr ?? ""));
  } else if (record.output !== undefined) {
    lines.push(...blockField("output", record.output));
  }

  if (record.raw !== undefined) lines.push(...blockField("raw", record.raw));
  lines.push("</tool_result>");
  return lines.join("\n");
}
