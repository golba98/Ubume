import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { carrierKeyOf } from "@deepseek-ai/dsh-scope";

export const name = "codexa-local-harness-bridge";
export const inject = ["agents"];
const MAX_PENDING_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
const configuredMaxRssBytes = Number(process.env.CODEXA_DSH_MAX_RSS_BYTES);
const maxRssBytes = Number.isSafeInteger(configuredMaxRssBytes) && configuredMaxRssBytes > 0
  ? configuredMaxRssBytes
  : 1024 * 1024 * 1024;

function contentPreview(blocks, limit = MAX_TOOL_RESULT_CHARS) {
  if (!Array.isArray(blocks)) return "";
  let result = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const part = typeof block.text === "string" ? block.text : contentPreview(block.content, limit - result.length);
    result += part.slice(0, limit - result.length);
    if (result.length >= limit) break;
  }
  return result;
}

function toolDisplayArguments(raw) {
  try {
    if (typeof raw === "string" && raw.length > 1024 * 1024) return "{}";
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!args || typeof args !== "object") return "{}";
    return JSON.stringify(Object.fromEntries(
      ["command", "path", "file_path"].filter((key) => typeof args[key] === "string")
        .map((key) => [key, args[key].slice(0, MAX_TOOL_ARGUMENT_CHARS)]),
    ));
  } catch {
    return "{}";
  }
}

export function policyArguments(args) {
  if (!args || typeof args !== "object") return {};
  return Object.fromEntries(
    ["command", "path", "file_path", "old_path", "new_path"]
      .filter((key) => typeof args[key] === "string")
      .map((key) => [key, args[key]]),
  );
}

function outputContent(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string") return [block];
    return outputContent(block.content);
  });
}

export function projectHarnessEvent(event) {
  const data = event?.data ?? {};
  if (event?.type?.startsWith("compaction/")) return { type: event.type };
  if (event?.type === "turn/end") {
    const reason = data.reason ?? {};
    return { type: event.type, data: { reason: {
      kind: reason.kind,
      ...(reason.error ? { error: { message: String(reason.error.message ?? "").slice(0, 4_000) } } : {}),
    } } };
  }
  if (event?.type === "assistant/chunk") {
    const chunk = data.chunk;
    if (!chunk || !["text-delta", "reasoning-delta", "usage", "finish"].includes(chunk.type)) return null;
    if (chunk.type === "finish") {
      return { type: event.type, data: { chunk: {
        type: "finish",
        reason: chunk.reason,
        replayState: { response: { stopReason: chunk.replayState?.response?.stopReason } },
      } } };
    }
    return { type: event.type, data: { step: data.step, chunk } };
  }
  if (event?.type === "assistant/message") {
    const content = outputContent(data.message?.content);
    return { type: event.type, data: { usage: data.usage, message: { content } } };
  }
  if (event?.type === "tool/call") {
    return { type: event.type, seq: event.seq, data: {
      callId: data.callId,
      name: data.name,
      arguments: toolDisplayArguments(data.arguments),
    } };
  }
  if (event?.type === "tool/result") {
    return { type: event.type, seq: event.seq, data: {
      message: { source: { callId: data.message?.source?.callId }, content: [{ type: "text", text: contentPreview(data.message?.content) }] },
      ...(data.error ? { error: { message: "Tool failed" } } : {}),
    } };
  }
  return null;
}

export function notifyBounded(transport, method, params, output = process.stdout, abort = (code) => {
  process.stderr.write("Codexa Local Harness output safety buffer exceeded.\n");
  process.exit(code);
}) {
  transport.notify(method, params);
  if (output.writableLength > MAX_PENDING_STDOUT_BYTES) abort(86);
}

class CodexaHarnessServer {
  constructor(ctx, transport) {
    this.ctx = ctx;
    this.transport = transport;
    this.cwd = process.cwd();
    this.provider = "codexa-local";
    this.model = "";
    this.maxTokens = undefined;
    this.sessions = new Map();
    this.creations = new Map();
    this.disposers = [];
    this.shuttingDown = false;

    this.disposers.push(ctx.on("session/event", (session, event) => {
      if (!this.sessions.has(String(session.id))) return;
      const projected = projectHarnessEvent(event);
      if (projected) notifyBounded(this.transport, "session.event", { sessionId: String(session.id), event: projected });
    }));
    this.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
      notifyBounded(this.transport, "session.status", { sessionId: String(agent.id), status });
    }));
    this.disposers.push(ctx.on("session/created", (session) => {
      if (session.header.parentSession === undefined) return;
      notifyBounded(this.transport, "subagent.started", {
        parentSessionId: String(session.header.parentSession),
        childSessionId: String(session.id),
      });
    }));
    const notificationTransport = this.transport;
    this.disposers.push(ctx.on("subagent/end", function(info) {
      if (!info.local) return;
      const parent = carrierKeyOf(this);
      notifyBounded(notificationTransport, "subagent.finished", {
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: info.stopReason === "completed" ? "ok" : "error",
        stopReason: info.stopReason,
      });
    }));
    this.disposers.push(ctx.on("tools/pre-execute", async (execution, next) => {
      const agent = execution.agent;
      if (!agent || !this.sessions.has(String(agent.id))) return next();
      const result = await this.transport.request("tool/policy", {
        sessionId: String(agent.id),
        callId: execution.callId === undefined ? undefined : String(execution.callId),
        tool: execution.name,
        arguments: policyArguments(execution.arguments),
      });
      if (!result || typeof result !== "object") {
        return { kind: "deny", reason: "Codexa returned an invalid tool-policy decision." };
      }
      if (result.kind === "allow") return { kind: "allow" };
      if (result.kind === "ask") {
        return { kind: "ask", ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
      }
      return {
        kind: "deny",
        reason: typeof result.reason === "string" ? result.reason : "Codexa denied this tool call.",
      };
    }));
    this.disposers.push(ctx.on("approval/request", async (request, next) => {
      if (!this.sessions.has(String(request.agent.id))) return next();
      const result = await this.transport.request("approval/request", {
        sessionId: String(request.agent.id),
        tool: request.toolName,
        callId: request.callId === undefined ? undefined : String(request.callId),
        reason: request.reason,
      });
      if (!result || typeof result !== "object") return "unavailable";
      if (result.outcome === "allowed-once") return "allowed-once";
      if (result.outcome === "cancelled") return "cancelled";
      return "rejected";
    }));
  }

  async initialize(params) {
    this.cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    this.provider = typeof params.provider === "string" ? params.provider : "codexa-local";
    this.model = typeof params.model === "string" ? params.model : "";
    this.maxTokens = Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0
      ? params.maxTokens
      : undefined;
    return { serverInfo: { name: "codexa-local-harness-runtime", version: "1" } };
  }

  async open(params) {
    const sessionId = String(params.sessionId ?? "");
    if (!sessionId) throw new Error("session/open requires a sessionId");
    const record = await this.getOrCreate(sessionId, params.resume === true, Array.isArray(params.seed) ? params.seed : undefined);
    return { sessionId: String(record.handle.agent.id), resumed: record.resumed };
  }

  async prompt(params) {
    const record = await this.getOrCreate(String(params.sessionId ?? ""), params.resume === true);
    const content = Array.isArray(params.contentBlocks)
      ? params.contentBlocks
      : [{ type: "text", text: String(params.content ?? "") }];
    const message = createUserMessage({ content, source: { kind: "user" } });
    record.handle.agent.followup(message);
    return { messageId: String(message.id) };
  }

  async cancel(params) {
    const record = this.sessions.get(String(params.sessionId ?? ""));
    if (!record) return { cancelled: false };
    record.handle.agent.cancel({ kind: "user" });
    await record.handle.agent.whenIdle();
    return { cancelled: true };
  }

  async close(params) {
    const sessionId = String(params.sessionId ?? "");
    const record = this.sessions.get(sessionId);
    if (!record) return {};
    this.sessions.delete(sessionId);
    await record.handle.dispose();
    return {};
  }

  async getOrCreate(sessionId, resume = false, seed) {
    if (!sessionId) throw new Error("A non-empty Harness session id is required.");
    if (this.shuttingDown) throw new Error("Local Harness is shutting down.");
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.creations.get(sessionId);
    if (pending) return pending;
    const creation = this.create(sessionId, resume, seed);
    this.creations.set(sessionId, creation);
    creation.finally(() => this.creations.delete(sessionId));
    return creation;
  }

  async create(sessionId, resume, seed) {
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
    let handle;
    let resumed = false;
    if (resume) {
      try {
        handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions });
        resumed = true;
      } catch (error) {
        if (!seed) throw error;
      }
    }
    handle ??= await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd, ...(seed ? { seedLength: seed.length } : {}) },
      ...(seed ? { seed } : {}),
      agentOptions,
    });
    const record = { handle, resumed };
    this.sessions.set(sessionId, record);
    return record;
  }

  async shutdown() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.creations.values()]);
    this.creations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    while (this.disposers.length > 0) this.disposers.pop()?.();
    await Promise.allSettled(records.map((record) => record.handle.dispose()));
    return {};
  }

  handle(method, params) {
    if (method === "initialize") return this.initialize(params);
    if (method === "session/open") return this.open(params);
    if (method === "session/prompt") return this.prompt(params);
    if (method === "session/cancel") return this.cancel(params);
    if (method === "session/close") return this.close(params);
    if (method === "shutdown") return this.shutdown();
    throw new Error(`Unknown Codexa Local Harness method: ${method}`);
  }
}

export function apply(ctx) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new CodexaHarnessServer(ctx, transport);
  const rootFiber = ctx.root.fiber;
  transport.onRequest(async (method, params) => {
    if (method === "initialize") await ctx.get("loader")?.await();
    const result = await server.handle(method, params);
    if (method === "shutdown") {
      setImmediate(async () => {
        await Promise.allSettled([transport.flush(), rootFiber.dispose()]);
        process.exit(0);
      });
    }
    return result;
  });
  ctx.effect(() => {
    transport.start();
    const memoryTimer = setInterval(() => {
      const rssBytes = process.memoryUsage().rss;
      if (rssBytes >= maxRssBytes) {
        process.stderr.write("Codexa Local Harness RAM safety limit reached.\n");
        process.exit(85);
      }
      notifyBounded(transport, "harness.memory", { rssBytes });
    }, 500);
    memoryTimer.unref();
    return async () => {
      clearInterval(memoryTimer);
      await server.shutdown();
      transport.close();
    };
  }, "codexa-local-harness.serve");
}
