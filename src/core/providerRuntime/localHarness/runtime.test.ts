import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { getProviderRuntime } from "../registry.js";
import { localRuntime } from "../local.js";
import {
  LocalHarnessProcess,
  localHarnessTestUtils,
  resetLocalHarnessProcessForTests,
  type LocalHarnessRunner,
} from "./runtime.js";
import type { ProviderChatRequest } from "../types.js";
import type { BackendRunHandlers } from "../../providers/types.js";

function request(modelId: string): ProviderChatRequest {
  return {
    prompt: "inspect the workspace",
    route: { providerId: "local", modelId, backendKind: "local-openai-compatible" },
    workspaceRoot: process.cwd(),
    runtime: ({
      policy: {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        writableRoots: [],
      },
    } as unknown) as ProviderChatRequest["runtime"],
    localConfig: {
      enabled: true,
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "test-key",
      models: {
        [modelId]: {
          contextLength: 32_768,
          maxOutputTokens: 4_096,
          supportsStreaming: true,
          supportsToolCalls: true,
        },
      },
    },
  };
}

function runRuntime(req: ProviderChatRequest, handlers: Partial<BackendRunHandlers> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    localRuntime.run!(req, {
      onResponse: resolve,
      onError: (message) => reject(new Error(message)),
      ...handlers,
    });
  });
}

afterEach(() => resetLocalHarnessProcessForTests());

describe("Local Harness provider routing", () => {
  test("uses a stable salted fingerprint for credential change detection", () => {
    const first = localHarnessTestUtils.secretFingerprint("test-api-key");
    const repeated = localHarnessTestUtils.secretFingerprint("test-api-key");
    const changed = localHarnessTestUtils.secretFingerprint("different-api-key");

    assert.equal(first, repeated);
    assert.notEqual(first, changed);
    assert.equal(first.includes("test-api-key"), false);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  for (const model of ["Qwen3-Coder", "Ornith-32B", "Llama-4", "Gemma-3", "DeepSeek-R1", "GLM-5", "arbitrary-compatible-model"]) {
    test(`${model} uses the generic Local Harness path`, async () => {
      const observed: ProviderChatRequest[] = [];
      const fake: LocalHarnessRunner = {
        run: async (req) => { observed.push(req); return "done"; },
        shutdown: async () => undefined,
        terminate: () => undefined,
      };
      resetLocalHarnessProcessForTests(fake);
      assert.equal(await runRuntime(request(model)), "done");
      assert.deepEqual(observed.map((item) => item.route.providerId), ["local"]);
      assert.equal(observed[0]?.route.modelId, model);
    });
  }

  test("model name is not the routing decision", () => {
    assert.equal(getProviderRuntime("local"), localRuntime);
    assert.notEqual(getProviderRuntime("openai"), localRuntime);
    assert.notEqual(getProviderRuntime("anthropic"), localRuntime);
    assert.notEqual(getProviderRuntime("google"), localRuntime);
    assert.notEqual(getProviderRuntime("mistral"), localRuntime);
    assert.notEqual(getProviderRuntime("codexa-native"), localRuntime);
  });

  test("Local endpoint, model, and generation limits feed the generic Harness profile", () => {
    const resolved = localHarnessTestUtils.resolveHarnessConfig(request("Ornith-32B"));
    assert.deepEqual(resolved, {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "test-key",
      model: "Ornith-32B",
      contextWindow: 32_768,
      maxTokens: 4_096,
      supportsVision: false,
      reasoningEffort: null,
    });
    const patch = localHarnessTestUtils.profilePatch(false);
    assert.match(patch, /codexa-local:/);
    assert.match(patch, /api: openai-completions/);
    assert.match(patch, /model: !!js process\.env\.CODEXA_DSH_MODEL/);
    assert.match(patch, /id: llm-deepseek\n  disabled: true/);
    assert.match(patch, /defaultPreset: !!js process\.env\.CODEXA_DSH_PERMISSION_PRESET/);
    assert.match(patch, /danger-full-access:\n        sandbox: danger-full-access\n        approval: never/);
  });

  test("Codexa permission modes map to the official Harness sandbox schema", () => {
    const req = request("Ornith-32B");
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "workspace-write");
    req.runtime.policy.sandboxMode = "read-only";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "read-only");
    req.runtime.policy.sandboxMode = "danger-full-access";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "danger-full-access");
    (req.runtime.policy as { sandboxMode: string }).sandboxMode = "full-access";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "danger-full-access");
    req.runIntent = "plan";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "read-only");
  });

  test("approved plan execution runs with a writable sandbox once plan mode is off", () => {
    const req = request("Ornith-32B");
    req.runIntent = "approved-execution";
    req.runtime.planMode = false;
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "workspace-write");
  });

  test("an explicitly tool-incompatible Local model fails before Harness startup", async () => {
    const req = request("plain-chat-model");
    req.localConfig!.models!["plain-chat-model"]!.supportsToolCalls = false;
    await assert.rejects(
      new LocalHarnessProcess().run(req, { onResponse: () => undefined, onError: () => undefined }, new AbortController().signal),
      /without tool\/function-calling support/,
    );
  });

  test("Unsloth cannot silently fall back to the LM Studio default endpoint", async () => {
    const req = request("Ornith-32B");
    req.route.localBackend = "unsloth";
    req.localConfig = { currentModel: "Ornith-32B", localBackend: "unsloth" };
    await assert.rejects(
      new LocalHarnessProcess().run(req, { onResponse: () => undefined, onError: () => undefined }, new AbortController().signal),
      /selected Unsloth connection was not resolved/,
    );
  });

  test("Harness consumes the ephemeral resolved Local connection", () => {
    const req = request("Ornith-32B");
    req.route.localBackend = "unsloth";
    req.resolvedLocalAgentConfig = {
      localBackend: "unsloth",
      baseUrl: "http://127.0.0.1:8888/v1",
      apiKey: "ephemeral-key",
      modelId: "Ornith-32B",
      contextWindow: 128_000,
      maxTokens: 8_192,
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsVision: false,
    };
    assert.deepEqual(localHarnessTestUtils.resolveHarnessConfig(req), {
      baseUrl: "http://127.0.0.1:8888/v1",
      apiKey: "ephemeral-key",
      model: "Ornith-32B",
      contextWindow: 128_000,
      maxTokens: 8_192,
      supportsVision: false,
      reasoningEffort: null,
    });
  });

  test("Harness startup failure is isolated and actionable", async () => {
    const previous = process.env.CODEXA_NODE_PATH;
    process.env.CODEXA_NODE_PATH = "/definitely/missing/codexa-node";
    const runner = new LocalHarnessProcess();
    try {
      await assert.rejects(
        runner.run(request("Qwen"), { onResponse: () => undefined, onError: () => undefined }, new AbortController().signal),
        /Local Harness startup failed[\s\S]*Qwen[\s\S]*127\.0\.0\.1:8080/,
      );
    } finally {
      runner.terminate();
      if (previous === undefined) delete process.env.CODEXA_NODE_PATH;
      else process.env.CODEXA_NODE_PATH = previous;
    }
  });

  test("a fingerprint change restarts the Harness without the old child clobbering the new one", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "codexa-harness-stub-"));
    const stubPath = join(stubDir, "stub-bridge.js");
    // Stands in for the spawned dsh process: replies to `initialize` late enough
    // that the previous generation's exit always lands inside the new
    // generation's startup window, like the real bridge's post-`shutdown` exit.
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        "let buffer = \"\";",
        "process.stdin.on(\"data\", (chunk) => {",
        "  buffer += String(chunk);",
        "  let index;",
        "  while ((index = buffer.indexOf(\"\\n\")) !== -1) {",
        "    const line = buffer.slice(0, index).trim();",
        "    buffer = buffer.slice(index + 1);",
        "    if (!line) continue;",
        "    let message;",
        "    try { message = JSON.parse(line); } catch { continue; }",
        "    if (message.id === undefined || message.method === undefined) continue;",
        "    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result })}\\n`);",
        "    if (message.method === \"initialize\") setTimeout(() => reply({ ok: true }), 500);",
        "    else if (message.method === \"shutdown\") { reply({ ok: true }); setTimeout(() => process.exit(0), 300); }",
        "    else reply({});",
        "  }",
        "});",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
    const previous = process.env.CODEXA_NODE_PATH;
    process.env.CODEXA_NODE_PATH = stubPath;
    const runner = new LocalHarnessProcess();
    const internals = runner as unknown as {
      ensureStarted(req: ProviderChatRequest, config: unknown, fingerprint: string, handlers: BackendRunHandlers): Promise<void>;
    };
    const handlers: BackendRunHandlers = { onResponse: () => undefined, onError: () => undefined };
    const req = request("Qwen");
    const config = localHarnessTestUtils.resolveHarnessConfig(req);
    try {
      await internals.ensureStarted(req, config, "fp-a", handlers);
      await internals.ensureStarted(req, config, "fp-b", handlers);
    } finally {
      await runner.shutdown();
      if (previous === undefined) delete process.env.CODEXA_NODE_PATH;
      else process.env.CODEXA_NODE_PATH = previous;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test("forced lifecycle cleanup terminates an owned Harness child", () => {
    const runner = new LocalHarnessProcess();
    let killedWith: string | null = null;
    (runner as unknown as { child: unknown }).child = {
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => { killedWith = signal; },
    };
    runner.terminate();
    assert.equal(killedWith, "SIGTERM");
  });

  test("cancellation aborts the active Harness request", async () => {
    const observed: { signal?: AbortSignal } = {};
    const fake: LocalHarnessRunner = {
      run: (_req, _handlers, signal) => {
        observed.signal = signal;
        return new Promise(() => undefined);
      },
      shutdown: async () => undefined,
      terminate: () => undefined,
    };
    resetLocalHarnessProcessForTests(fake);
    const stop = localRuntime.run!(request("Qwen"), { onResponse: () => undefined, onError: () => undefined });
    await Promise.resolve();
    stop();
    assert.equal(observed.signal?.aborted, true);
  });
});

describe("Harness event projection and policy", () => {
  function activeProcess(overrides: Partial<BackendRunHandlers> = {}) {
    const process = new LocalHarnessProcess();
    const deltas: string[] = [];
    const progress: string[] = [];
    const progressIds: string[] = [];
    const tools: Array<{ id: string; status: string; command: string }> = [];
    const usage: number[] = [];
    const handlers: BackendRunHandlers = {
      onResponse: () => undefined,
      onError: () => undefined,
      onAssistantDelta: (chunk) => deltas.push(chunk),
      onProgress: (event) => {
        progress.push(event.text);
        progressIds.push(event.id);
      },
      onToolActivity: (event) => tools.push({ id: event.id, status: event.status, command: event.command }),
      onContextUsage: (event) => usage.push(event.contextTokens),
      ...overrides,
    };
    (process as unknown as { active: unknown }).active = {
      sessionId: "session-1",
      handlers,
      request: request("Qwen"),
      text: "",
      runningSeen: true,
      settled: false,
      toolArguments: new Map(),
      reasoningText: new Map(),
      approvals: new Set(),
      continuationCount: 0,
      windowStartTextLength: 0,
      windowStartToolEventCount: 0,
      toolEventCount: 0,
      reasoningEventCount: 0,
      windowStartReasoningEventCount: 0,
      consecutiveNoProgressWindows: 0,
      cancelled: false,
      resolve: () => undefined,
      reject: () => undefined,
      abortCleanup: () => undefined,
    };
    return { process, deltas, progress, progressIds, tools, usage };
  }

  function notifier(fixture: ReturnType<typeof activeProcess>) {
    return (fixture.process as unknown as { onNotification(method: string, params: unknown): void }).onNotification.bind(fixture.process);
  }

  function attachTransport(fixture: ReturnType<typeof activeProcess>) {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    (fixture.process as unknown as { transport: unknown }).transport = {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return {};
      },
      close: () => undefined,
    };
    return requests;
  }

  function reasoningOnlyTurn(notify: ReturnType<typeof notifier>, outputTokens: number) {
    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: 0, text: "We have a massive request…" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "assistant/chunk", data: { chunk: { type: "usage", usage: { inputTokens: 8_570, outputTokens } } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 3, type: "assistant/chunk", data: { chunk: { type: "finish", reason: { kind: "max-tokens" }, replayState: { response: { stopReason: "length" } } } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 4, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "reasoning", text: "We have a massive request…" }] } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 5, type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } } });
  }

  test("reasoning-only output exhaustion is continued and stops after two no-progress windows", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (error) => errors.push(error);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    reasoningOnlyTurn(notify, 4_096);
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 0, "the first exhaustion must not fail the run");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "session/prompt");
    assert.match(String(requests[0]?.params.content), /ran out of output budget/i);
    assert.ok(fixture.progress.some((text) => /continuing automatically/i.test(text)));

    // The retry exhausts the budget again: fail with a self-diagnosing message.
    notify("session.status", { sessionId: "session-1", status: "running" });
    reasoningOnlyTurn(notify, 4_096);
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 1, "the stalled second window must not enqueue another prompt");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /two output windows made no visible progress/i);
    assert.match(errors[0]!.message, /max_output_tokens/);
  });

  test("a turn that produces reasoning but no answer without hitting the cap reports that distinctly", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (error) => errors.push(error);
    attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", index: 0, text: "hmm" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "assistant/chunk", data: { chunk: { type: "finish", reason: { kind: "stop" } } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /reasoning .* no answer|produced reasoning only/i);
    assert.doesNotMatch(errors[0]!.message, /output budget/);
  });

  test("assistant/message output_text parts populate the final text", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "output_text", text: "the answer" }] } } } });
    assert.deepEqual(fixture.deltas, ["the answer"]);
  });

  test("turn/end records non-error stop reasons", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } } });
    assert.equal((fixture.process as unknown as { active: { stopReason?: string } }).active.stopReason, "aborted");
  });

  test("a truncated non-empty answer continues without completing the logical run", () => {
    const resolved: string[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { resolve: (text: string) => void } }).active.resolve = (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);
    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "partial answer" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "assistant/chunk", data: { chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4_096 } } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } } });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.deepEqual(resolved, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "session/prompt");
    assert.match(String(requests[0]?.params.content), /exactly where the previous response stopped/i);
    assert.ok(fixture.progressIds.includes("local-harness-output-recovery"));
    assert.ok(fixture.progress.some((text) => /window 2/i.test(text)));
    assert.ok(fixture.progress.every((text) => !/response truncated/i.test(text)));
  });

  test("tool activity is productive rollover progress and stays in the same run", () => {
    const fixture = activeProcess();
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "tool/call", data: { callId: "call-1", name: "bash", arguments: "{\"command\":\"git status\"}" } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "tool/result", data: { message: { source: { callId: "call-1" }, content: [{ type: "text", text: "clean" }] } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 3, type: "turn/end", data: { reason: { kind: "max-tokens" } } } });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.params.sessionId, "session-1");
    assert.deepEqual(fixture.tools.map((event) => event.status), ["running", "completed"]);
    assert.equal((fixture.process as unknown as { active: { consecutiveNoProgressWindows: number } }).active.consecutiveNoProgressWindows, 0);
  });

  test("a cancelled rollover cannot enqueue another prompt or finalize", () => {
    const resolved: string[] = [];
    const observedFinalAnswers: string[] = [];
    const fixture = activeProcess({ onFinalAnswerObserved: (text) => observedFinalAnswers.push(text) });
    const active = (fixture.process as unknown as { active: { cancelled: boolean; resolve: (text: string) => void } }).active;
    active.cancelled = true;
    active.resolve = (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "partial" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "turn/end", data: { reason: { kind: "max-tokens" } } } });
    (fixture.process as unknown as { failActive(error: Error): void }).failActive(new DOMException("Local request cancelled.", "AbortError"));
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 0);
    assert.deepEqual(resolved, []);
    assert.deepEqual(observedFinalAnswers, []);
  });

  test("multiple productive output windows accumulate into one final response", () => {
    const resolved: string[] = [];
    const observedFinalAnswers: string[] = [];
    const finalMetadata: Array<{ throughMessageCount: number; transcriptHash: string }> = [];
    const fixture = activeProcess({
      onFinalAnswerObserved: (text) => observedFinalAnswers.push(text),
      onLocalHarnessSession: (metadata) => finalMetadata.push(metadata),
    });
    const active = (fixture.process as unknown as { active: { resolve: (text: string) => void } }).active;
    active.resolve = (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    for (const [index, text] of ["part one ", "part two "].entries()) {
      notify("session.status", { sessionId: "session-1", status: "running" });
      notify("session.event", { sessionId: "session-1", event: { seq: index * 3 + 1, type: "assistant/chunk", data: { chunk: { type: "text-delta", text } } } });
      notify("session.event", { sessionId: "session-1", event: { seq: index * 3 + 2, type: "assistant/chunk", data: { chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4_096 } } } } });
      notify("session.event", { sessionId: "session-1", event: { seq: index * 3 + 3, type: "turn/end", data: { reason: { kind: "max-tokens" } } } });
      notify("session.status", { sessionId: "session-1", status: "idle" });
    }

    notify("session.status", { sessionId: "session-1", status: "running" });
    notify("session.event", { sessionId: "session-1", event: { seq: 7, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "output_text", text: "done" }] } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 8, type: "turn/end", data: { reason: { kind: "completed" } } } });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 2);
    assert.deepEqual(fixture.deltas, ["part one ", "part two ", "done"]);
    assert.deepEqual(resolved, ["part one part two done"]);
    assert.deepEqual(observedFinalAnswers, ["part one part two done"]);
    assert.equal(finalMetadata.length, 1);
    assert.equal(finalMetadata[0]?.throughMessageCount, 2);
    assert.match(finalMetadata[0]?.transcriptHash ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(fixture.progress.filter((text) => /continuing automatically/i.test(text)), [
      "Output window reached; continuing automatically (window 2).",
      "Output window reached; continuing automatically (window 3).",
    ]);
  });

  test("reasoning effort reaches the Harness profile only when the model opts in", () => {
    const plain = localHarnessTestUtils.profilePatch(false, false);
    assert.doesNotMatch(plain, /reasoningEfforts/);
    assert.doesNotMatch(plain, /thinkingFormat/);

    const effort = localHarnessTestUtils.profilePatch(false, true);
    assert.match(effort, /reasoningEfforts:\n\s+low: low\n\s+medium: medium\n\s+high: high/);
    assert.match(effort, /thinkingFormat: openai/);
    assert.match(effort, /reasoning: !!js process\.env\.CODEXA_DSH_REASONING_EFFORT/);

    const req = request("gpt-oss-20b");
    req.localConfig!.models!["gpt-oss-20b"]!.supportsReasoningEffort = true;
    (req.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "low";
    const low = localHarnessTestUtils.resolveHarnessConfig(req);
    assert.equal(low.reasoningEffort, "low");
    (req.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "high";
    const high = localHarnessTestUtils.resolveHarnessConfig(req);
    assert.equal(high.reasoningEffort, "high");
    assert.notEqual(localHarnessTestUtils.routeFingerprint(low, req), localHarnessTestUtils.routeFingerprint(high, req));

    const optedOut = request("qwen");
    (optedOut.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "high";
    assert.equal(localHarnessTestUtils.resolveHarnessConfig(optedOut).reasoningEffort, null);
  });

  test("the default output budget follows the context window when no cap is configured", () => {
    const req = request("big-context");
    delete req.localConfig!.models!["big-context"]!.maxOutputTokens;
    req.localConfig!.models!["big-context"]!.contextLength = 131_072;
    assert.equal(localHarnessTestUtils.resolveHarnessConfig(req).maxTokens, 32_768);
  });

  test("streams assistant, reasoning, usage, and tool events without replaying final text", () => {
    const fixture = activeProcess();
    const notify = (fixture.process as unknown as { onNotification(method: string, params: unknown): void }).onNotification.bind(fixture.process);
    notify("session.event", { sessionId: "session-1", event: { seq: 1, type: "assistant/chunk", data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "think" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "assistant/chunk", data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "ing" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 3, type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "hello" } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 4, type: "assistant/chunk", data: { chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 5, type: "assistant/message", data: { message: { content: [{ type: "text", text: "hello" }] } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 5, type: "tool/call", data: { callId: "call-1", name: "bash", arguments: "{\"command\":\"git status\"}" } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 6, type: "tool/result", data: { message: { source: { callId: "call-1" }, content: [{ type: "text", text: "clean" }] } } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 7, type: "tool/call", data: { callId: "call-2", name: "edit", arguments: "{\"path\":\"src/app.tsx\"}" } } });
    notify("session.event", { sessionId: "session-1", event: { seq: 8, type: "tool/result", data: { message: { source: { callId: "call-2" }, content: [{ type: "text", text: "edited" }] } } } });
    assert.deepEqual(fixture.deltas, ["hello"]);
    assert.deepEqual(fixture.progress, ["think", "thinking"]);
    assert.deepEqual(fixture.progressIds, [
      "local-reasoning-session-1-1-0",
      "local-reasoning-session-1-1-0",
    ]);
    assert.deepEqual(fixture.usage, [12]);
    assert.deepEqual(fixture.tools.map((item) => item.status), ["running", "completed", "running", "completed"]);
    assert.equal(fixture.tools[0]?.command, "git status");
  });

  test("approved plan execution asks for mutating tools instead of denying them", async () => {
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { request: { runIntent: string } } }).active.request.runIntent = "approved-execution";
    const bridge = (fixture.process as unknown as { onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown> }).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(await bridge("tool/policy", { sessionId: "session-1", callId: "1", tool: "edit", arguments: { path: "src/app.tsx" } }), { kind: "ask", reason: "Allow edit src/app.tsx?" });
  });

  test("mutating tools use Codexa approval and dangerous commands fail closed", async () => {
    const fixture = activeProcess({ onToolApproval: async () => "allow-once" });
    const bridge = (fixture.process as unknown as { onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown> }).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(await bridge("tool/policy", { sessionId: "session-1", callId: "1", tool: "bash", arguments: { command: "git status" } }), { kind: "ask", reason: "Allow git status?" });
    assert.deepEqual(await bridge("approval/request", { sessionId: "session-1", callId: "1", tool: "bash" }), { outcome: "allowed-once" });
    assert.deepEqual(await bridge("tool/policy", { sessionId: "session-1", callId: "2", tool: "bash", arguments: { command: "rm -rf ." } }), { kind: "deny", reason: "Shell command blocked as dangerous." });
    assert.deepEqual(await bridge("tool/policy", { sessionId: "session-1", callId: "3", tool: "bash", arguments: { command: "gh pr create --fill" } }), { kind: "ask", reason: "Allow gh pr create --fill?" });
  });
});
