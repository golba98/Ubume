import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { carrierKeyOf } from "@deepseek-ai/dsh-scope";

export const name = "codexa-local-harness-bridge";
export const inject = ["agents"];

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
      this.transport.notify("session.event", { sessionId: String(session.id), event });
    }));
    this.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
      this.transport.notify("session.status", { sessionId: String(agent.id), status });
    }));
    this.disposers.push(ctx.on("session/created", (session) => {
      if (session.header.parentSession === undefined) return;
      this.transport.notify("subagent.started", {
        parentSessionId: String(session.header.parentSession),
        childSessionId: String(session.id),
      });
    }));
    const notificationTransport = this.transport;
    this.disposers.push(ctx.on("subagent/end", function(info) {
      if (!info.local) return;
      const parent = carrierKeyOf(this);
      notificationTransport.notify("subagent.finished", {
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
        arguments: execution.arguments,
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
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "codexa-local-harness.serve");
}
