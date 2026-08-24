import assert from "node:assert/strict";
import test from "node:test";
import {
  agentToolDefinitions,
  parseAgentToolCall,
  parseOpenAiToolCalls,
  parseOpenAiToolCallsDetailed,
  serializeToolResult,
} from "./protocol.js";

test("parses a valid single tool call block", () => {
  const result = parseAgentToolCall('<tool_call>{"name":"read_file","arguments":{"path":"src/app.tsx"}}</tool_call>');

  assert.equal(result.kind, "tool_call");
  if (result.kind !== "tool_call") return;
  assert.equal(result.name, "read_file");
  assert.deepEqual(result.arguments, { path: "src/app.tsx" });
});

test("parses tool and args aliases without a closing tag", () => {
  const result = parseAgentToolCall('<tool_call>{"tool":"list_files","args":{"path":"."}}');

  assert.equal(result.kind, "tool_call");
  if (result.kind !== "tool_call") return;
  assert.equal(result.name, "list_files");
  assert.deepEqual(result.arguments, { path: "." });
});

test("parses nested function format", () => {
  const result = parseAgentToolCall('<tool_call>{"function":{"name":"read_file","arguments":{"path":"main.rs"}}}</tool_call>');

  assert.equal(result.kind, "tool_call");
  if (result.kind !== "tool_call") return;
  assert.equal(result.name, "read_file");
  assert.deepEqual(result.arguments, { path: "main.rs" });
});

test("recovers from one extra trailing brace", () => {
  const result = parseAgentToolCall('<tool_call>{"name":"list_files","arguments":{"path":"."}}}');

  assert.equal(result.kind, "tool_call");
  if (result.kind !== "tool_call") return;
  assert.equal(result.name, "list_files");
  assert.deepEqual(result.arguments, { path: "." });
});

test("parses OpenAI-style tool_calls", () => {
  const result = parseOpenAiToolCalls([{
    id: "call_1",
    type: "function",
    function: {
      name: "write_file",
      arguments: "{\"path\":\"main.rs\",\"content\":\"fn main() {}\\n\"}",
    },
  }]);

  assert.deepEqual(result, [{
    id: "call_1",
    name: "write_file",
    arguments: { path: "main.rs", content: "fn main() {}\n" },
    rawArguments: "{\"path\":\"main.rs\",\"content\":\"fn main() {}\\n\"}",
  }]);
});

test("preserves malformed OpenAI tool calls as protocol errors", () => {
  const result = parseOpenAiToolCallsDetailed([{
    id: "call_bad",
    function: { name: "read_file", arguments: "{\"path\":" },
  }]);

  assert.deepEqual(result, [{
    kind: "malformed",
    id: "call_bad",
    name: "read_file",
    rawArguments: "{\"path\":" ,
    error: "Tool call arguments were not valid JSON.",
  }]);
});

test("native tool definitions exclude mutating tools in Plan mode", () => {
  assert.deepEqual(
    agentToolDefinitions("plan").map((definition) => definition.function.name),
    ["list_files", "read_file", "get_workspace_info"],
  );
  assert.ok(agentToolDefinitions("normal").some((definition) => definition.function.name === "write_file"));
});

test("parses tool_calls embedded inside a tool_call block", () => {
  const result = parseAgentToolCall('<tool_call>{"tool_calls":[{"function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]}</tool_call>');

  assert.equal(result.kind, "tool_call");
  if (result.kind !== "tool_call") return;
  assert.equal(result.name, "list_files");
  assert.deepEqual(result.arguments, { path: "." });
});

test("malformed JSON becomes a tool error parse result", () => {
  const result = parseAgentToolCall('<tool_call>{"name":"read_file",</tool_call>');

  assert.equal(result.kind, "malformed_tool_call");
  if (result.kind !== "malformed_tool_call") return;
  assert.match(result.error, /JSON|Expected|position/i);
});

test("unterminated malformed tool call is not final assistant text", () => {
  const result = parseAgentToolCall('<tool_call>{"name":"read_file",');

  assert.equal(result.kind, "malformed_tool_call");
});

test("assistant text without a tool call is final", () => {
  const result = parseAgentToolCall("Done. I changed the file.");

  assert.deepEqual(result, { kind: "final", text: "Done. I changed the file." });
});

test("serializes run_shell result in local-model-friendly XML format", () => {
  const result = serializeToolResult({
    success: true,
    tool: "run_shell",
    command: "cargo run",
    exitCode: 0,
    durationMs: 421,
    stdout: "ok",
    stderr: "",
  });

  assert.match(result, /^<tool_result name="run_shell">/);
  assert.match(result, /command: cargo run/);
  assert.match(result, /exit_code: 0/);
  assert.match(result, /duration_ms: 421/);
  assert.match(result, /stdout:\nok/);
  assert.match(result, /stderr:\n/);
  assert.match(result, /<\/tool_result>$/);
});
