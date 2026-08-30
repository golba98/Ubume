import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { ProviderChatRequest } from "../providerRuntime/types.js";
import { runAgentLoop, type AgentChatMessage } from "./loop.js";

function request(workspaceRoot: string, prompt: string): ProviderChatRequest {
  return {
    prompt,
    workspaceRoot,
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
      policy: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
    })),
    route: {
      providerId: "local",
      modelId: "test-model",
      backendKind: "local-openai-compatible",
    },
  };
}

async function withTempWorkspace<T>(callback: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-loop-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function handlers() {
  const tools: string[] = [];
  return {
    tools,
    handlers: {
      onResponse: () => undefined,
      onError: assert.fail,
      onToolActivity: (activity: { status: string; command: string }) => {
        if (activity.status !== "running") tools.push(activity.command);
      },
    },
  };
}

test("create a rust hello world project leads to write_file and final summary", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const observed = handlers();
    const replies = [
      '<tool_call>{"name":"write_file","arguments":{"path":"Cargo.toml","content":"[package]\\nname = \\"hello\\"\\nversion = \\"0.1.0\\"\\nedition = \\"2021\\"\\n"}}</tool_call>',
      "Created Cargo.toml.",
    ];

    const text = await runAgentLoop({
      request: request(workspaceRoot, "create a rust hello world project here"),
      handlers: observed.handlers,
      includeSystemPrompt: true,
      sendMessages: async () => ({ text: replies.shift() ?? "done" }),
    });

    assert.equal(text, "Created Cargo.toml.");
    assert.match(await readFile(path.join(workspaceRoot, "Cargo.toml"), "utf8"), /name = "hello"/);
    assert.deepEqual(observed.tools, ["write_file: Cargo.toml"]);
  });
});

test("on-request local mutations wait for approval and denial prevents writes", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const pending = request(workspaceRoot, "write a file");
    pending.runtime = resolveRuntimeConfig(normalizeRuntimeConfig({
      policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
    }));
    const decisions: string[] = [];
    const replies = [
      '<tool_call>{"name":"write_file","arguments":{"path":"blocked.txt","content":"nope"}}</tool_call>',
      "The write was denied.",
    ];
    const text = await runAgentLoop({
      request: pending,
      handlers: {
        ...handlers().handlers,
        onToolApproval: async (approval) => {
          decisions.push(`${approval.tool}:${approval.paths.join(",")}`);
          return "deny";
        },
      },
      includeSystemPrompt: true,
      sendMessages: async () => ({ text: replies.shift() ?? "done" }),
    });
    assert.equal(text, "The write was denied.");
    assert.deepEqual(decisions, ["write_file:blocked.txt"]);
    await assert.rejects(readFile(path.join(workspaceRoot, "blocked.txt"), "utf8"));
  });
});

test("plan intent advertises only inspection tools and blocks model mutations", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const planning = request(workspaceRoot, "plan a change");
    planning.runIntent = "plan";
    let systemPrompt = "";
    const replies = [
      '<tool_call>{"name":"write_file","arguments":{"path":"blocked.txt","content":"nope"}}</tool_call>',
      "# Plan\n\n1. Inspect and update the target.",
    ];
    const text = await runAgentLoop({
      request: planning,
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      sendMessages: async (messages) => {
        systemPrompt ||= messages[0]?.content ?? "";
        return { text: replies.shift() ?? "done" };
      },
    });
    assert.match(systemPrompt, /PLAN MODE/);
    assert.match(systemPrompt, /Available tools: list_files, read_file, get_workspace_info/);
    assert.equal(text, "# Plan\n\n1. Inspect and update the target.");
    await assert.rejects(readFile(path.join(workspaceRoot, "blocked.txt"), "utf8"));
  });
});

test("allow-for-run remembers an exact local action signature", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const pending = request(workspaceRoot, "write, inspect, then repeat");
    pending.runtime = resolveRuntimeConfig(normalizeRuntimeConfig({
      policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
    }));
    let approvals = 0;
    const replies = [
      '<tool_call>{"name":"write_file","arguments":{"path":"same.txt","content":"ok"}}</tool_call>',
      '<tool_call>{"name":"list_files","arguments":{"path":"."}}</tool_call>',
      '<tool_call>{"name":"write_file","arguments":{"path":"same.txt","content":"ok"}}</tool_call>',
      "Done.",
    ];
    await runAgentLoop({
      request: pending,
      handlers: {
        ...handlers().handlers,
        onToolApproval: async () => {
          approvals += 1;
          return "allow-for-run";
        },
      },
      includeSystemPrompt: true,
      sendMessages: async () => ({ text: replies.shift() ?? "Done." }),
    });
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(workspaceRoot, "same.txt"), "utf8"), "ok");
  });
});

test("open the main file and fix the bug performs read then write", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "main.ts"), "const value = false;\n", "utf8");
    const replies = [
      '<tool_call>{"name":"read_file","arguments":{"path":"main.ts"}}</tool_call>',
      '<tool_call>{"name":"write_file","arguments":{"path":"main.ts","content":"const value = true;\\n"}}</tool_call>',
      "Fixed main.ts.",
    ];

    const text = await runAgentLoop({
      request: request(workspaceRoot, "open the main file and fix the bug"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      sendMessages: async () => ({ text: replies.shift() ?? "done" }),
    });

    assert.equal(text, "Fixed main.ts.");
    assert.equal(await readFile(path.join(workspaceRoot, "main.ts"), "utf8"), "const value = true;\n");
  });
});

test("run it performs run_shell", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const text = await runAgentLoop({
      request: request(workspaceRoot, "run it"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      sendMessages: async (_messages: readonly AgentChatMessage[], index) => ({
        text: index === 0
          ? '<tool_call>{"name":"run_shell","arguments":{"command":"printf ok"}}</tool_call>'
          : "It prints ok.",
      }),
    });

    assert.equal(text, "It prints ok.");
  });
});

test("broad workspace prompts receive a bounded automatic project summary", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      name: "sample-workspace",
      description: "A focused local agent fixture",
    }), "utf8");
    await writeFile(path.join(workspaceRoot, "README.md"), "# Sample\n", "utf8");
    let initialMessages: readonly AgentChatMessage[] = [];

    const text = await runAgentLoop({
      request: request(workspaceRoot, "what is the purpose of this repo?"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      sendMessages: async (messages) => {
        initialMessages = messages;
        return { text: "It is a focused local agent fixture." };
      },
    });

    assert.equal(text, "It is a focused local agent fixture.");
    const system = initialMessages[0]?.content ?? "";
    assert.match(system, /Workspace summary:/);
    assert.match(system, /Top-level entries: .*README\.md.*package\.json/);
    assert.match(system, /Package: sample-workspace - A focused local agent fixture/);
    assert.match(system, /get_workspace_info or list_files/);
    assert.match(system, /commit, push, or open a pull request/);
    assert.match(system, /Do not replace unfinished authorized work with commands for the user/);
  });
});

test("structured provider tool calls are executed before final text", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const text = await runAgentLoop({
      request: request(workspaceRoot, "write a rust file"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      toolProtocol: "openai",
      sendMessages: async (_messages: readonly AgentChatMessage[], index) => ({
        text: index === 0 ? "" : "Created main.rs.",
        toolCalls: index === 0
          ? [{
            id: "call_write",
            name: "write_file",
            arguments: { path: "main.rs", content: "fn main() { println!(\"hi\"); }\n" },
            rawArguments: "{\"path\":\"main.rs\",\"content\":\"fn main() { println!(\\\"hi\\\"); }\\n\"}",
          }]
          : undefined,
      }),
    });

    assert.equal(text, "Created main.rs.");
    assert.equal(await readFile(path.join(workspaceRoot, "main.rs"), "utf8"), "fn main() { println!(\"hi\"); }\n");
  });
});

test("native tool-call IDs are preserved and replayed IDs are not executed twice", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    let chatCalls = 0;
    const histories: AgentChatMessage[][] = [];
    const text = await runAgentLoop({
      request: request(workspaceRoot, "write once"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      toolProtocol: "openai",
      sendMessages: async (messages) => {
        histories.push([...messages]);
        chatCalls += 1;
        if (chatCalls <= 2) {
          return {
            text: "",
            reasoning: chatCalls === 1 ? "Write the file." : "Retry the same call.",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "stable_call_id",
              name: "write_file",
              arguments: { path: "once.txt", content: "once" },
              rawArguments: "{\"path\":\"once.txt\",\"content\":\"once\"}",
            }],
          };
        }
        return { text: "Finished after one write.", finishReason: "stop" };
      },
    });

    assert.equal(text, "Finished after one write.");
    assert.equal(await readFile(path.join(workspaceRoot, "once.txt"), "utf8"), "once");
    const secondRequest = histories[1] ?? [];
    const assistant = secondRequest.find((message) => message.role === "assistant");
    const tool = secondRequest.find((message) => message.role === "tool");
    assert.equal(assistant?.role === "assistant" ? assistant.reasoning_content : null, "Write the file.");
    assert.equal(tool?.role === "tool" ? tool.tool_call_id : null, "stable_call_id");
  });
});

test("Local agent completes more than ten tool calls without an artificial cutoff", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const toolCount = 12;
    const text = await runAgentLoop({
      request: request(workspaceRoot, "create every requested file"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      sendMessages: async (_messages: readonly AgentChatMessage[], index) => ({
        text: index < toolCount
          ? `<tool_call>{"name":"write_file","arguments":{"path":"file-${index}.txt","content":"${index}"}}</tool_call>`
          : "Created all requested files.",
      }),
    });

    assert.equal(text, "Created all requested files.");
    assert.equal(await readFile(path.join(workspaceRoot, "file-11.txt"), "utf8"), "11");
    assert.doesNotMatch(text, /tool limit|tool calls without a final answer/i);
  });
});

test("unchanged repeated tool results trigger a bounded blocker response", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const text = await runAgentLoop({
      request: request(workspaceRoot, "keep listing forever"),
      handlers: handlers().handlers,
      includeSystemPrompt: true,
      maxConsecutiveNoProgressCalls: 1,
      sendMessages: async (messages: readonly AgentChatMessage[], index) => {
        const lastContent = messages.at(-1)?.content;
        const recoveryRequested = typeof lastContent === "string"
          && lastContent.includes("Repeated tool calls are no longer changing");
        if (recoveryRequested) return { text: "I could not make further progress because the workspace listing stayed unchanged." };
        return {
          text: `<tool_call>{"name":"list_files","arguments":{"path":"."}}</tool_call>`,
          finishReason: index < 2 ? "tool_calls" : "stop",
        };
      },
    });

    assert.match(text, /workspace listing stayed unchanged/);
    assert.doesNotMatch(text, /\b10[- ]tool|tool limit|Next command:/i);
  });
});
