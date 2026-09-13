import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { isLocalDevChannel } from "../version/channel.js";
import type { BackendRunHandlers } from "../providers/types.js";
import type { ProviderChatRequest, ProviderModelDiscoveryResult, ProviderRouteValidationResult, ProviderRuntime } from "./types.js";
import { formatConversationHistory } from "../../session/conversation.js";

export const CODEXA_CUPY_MODEL_ID = "codexa-250m-cupy";

interface Config { modelRoot: string; python: string; bridgeScript: string; checkpoint: string; tokenizer: string; device: string; }
interface Response { type: string; id?: string; text?: string; message?: string; device?: string; context_length?: number; }
interface Bridge { child: ChildProcessWithoutNullStreams; ready: Promise<Response>; pending: Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>; }

let bridge: Bridge | null = null;
let sequence = 0;

export function resolveCodexaCupyConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modelRoot = env.CODEXA_CUPY_MODEL_ROOT?.trim() || join(homedir(), "Development", "2-Python", "32-LLM (NumPy)");
  return {
    modelRoot,
    python: env.CODEXA_CUPY_PYTHON?.trim() || "python3",
    bridgeScript: join(modelRoot, "scripts", "codexa_cupy_bridge.py"),
    checkpoint: env.CODEXA_CUPY_CHECKPOINT?.trim() || join(modelRoot, "runs", "pretraining", "pretrain_250m_fineweb_followup_10m", "target_final.npz"),
    tokenizer: env.CODEXA_CUPY_TOKENIZER?.trim() || join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json"),
    device: env.CODEXA_CUPY_DEVICE?.trim() || "cuda",
  };
}

function missing(config: Config): string[] {
  const executableMissing = config.python.includes("/") && !existsSync(config.python);
  return [config.bridgeScript, config.checkpoint, config.tokenizer]
    .filter((path) => !existsSync(path))
    .concat(executableMissing ? [config.python] : []);
}

export function discoverCodexaCupyModels(config = resolveCodexaCupyConfig(), env: NodeJS.ProcessEnv = process.env): ProviderModelDiscoveryResult {
  if (!isLocalDevChannel(env)) return { status: "not-configured", providerId: "codexa-cupy", backendKind: "unavailable", models: [], message: "CuPy is only available on ubume-dev." };
  const missingPaths = missing(config);
  if (missingPaths.length) return { status: "not-configured", providerId: "codexa-cupy", backendKind: "unavailable", models: [], message: `CuPy is missing required files:\n${missingPaths.join("\n")}`, diagnostics: { modelRoot: config.modelRoot, missingPaths: missingPaths.join(", ") } };
  return {
    status: "ready", providerId: "codexa-cupy", backendKind: "codexa-cupy",
    models: [{ id: CODEXA_CUPY_MODEL_ID, modelId: CODEXA_CUPY_MODEL_ID, label: "CuPy 250M", description: "NumPy model with CuPy/CUDA inference.", defaultReasoningLevel: null, supportedReasoningLevels: null, source: "config", raw: { context_length: 128, supportsStreaming: false, supportsToolCalls: false, supportsSystemPrompt: true, supportsVision: false } }],
    diagnostics: { modelRoot: config.modelRoot, checkpoint: config.checkpoint, tokenizer: config.tokenizer, device: config.device, runtime: bridge ? "loaded" : "not-loaded" },
  };
}

function stopBridge(message = "CuPy process stopped."): void {
  const active = bridge; bridge = null; if (!active) return;
  for (const pending of active.pending.values()) pending.reject(new Error(message));
  active.pending.clear();
  if (!active.child.killed) active.child.kill("SIGTERM");
}

function startBridge(config: Config, handlers: BackendRunHandlers): Bridge {
  if (bridge && !bridge.child.killed && bridge.child.exitCode === null) return bridge;
  const child = spawn(config.python, [config.bridgeScript, "--checkpoint", config.checkpoint, "--tokenizer", config.tokenizer, "--device", config.device], { cwd: config.modelRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  const pending = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  let readyResolve: (response: Response) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<Response>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const active: Bridge = { child, ready, pending }; bridge = active;
  const timeout = setTimeout(() => { readyReject(new Error("CuPy timed out while loading the checkpoint.")); stopBridge(); }, 60_000);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let response: Response; try { response = JSON.parse(line) as Response; } catch { return; }
    if (response.type === "ready") { clearTimeout(timeout); readyResolve(response); return; }
    if (!response.id) return;
    const request = pending.get(response.id); if (!request) return; pending.delete(response.id);
    if (response.type === "response" && typeof response.text === "string") request.resolve(response.text);
    else request.reject(new Error(response.message || "CuPy returned an invalid response."));
  });
  child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8").trim(); if (text) handlers.onProgress?.({ id: "codexa-cupy-load", source: "stderr", text }); });
  child.on("error", (error) => { clearTimeout(timeout); readyReject(error); stopBridge(error.message); });
  child.on("close", (code, signal) => { clearTimeout(timeout); const message = `CuPy process exited (${signal ?? code ?? "unknown"}).`; readyReject(new Error(message)); stopBridge(message); });
  return active;
}

async function sendPrompt(prompt: string, handlers: BackendRunHandlers): Promise<string> {
  const config = resolveCodexaCupyConfig(); const missingPaths = missing(config); if (missingPaths.length) throw new Error(`CuPy is missing required files:\n${missingPaths.join("\n")}`);
  const active = startBridge(config, handlers); const ready = await active.ready;
  handlers.onProgress?.({ id: "codexa-cupy-ready", source: "stdout", text: `CuPy loaded on ${ready.device ?? config.device}` });
  const id = `cupy-${Date.now()}-${++sequence}`;
  const response = new Promise<string>((resolve, reject) => active.pending.set(id, { resolve, reject }));
  active.child.stdin.write(`${JSON.stringify({ type: "chat", id, prompt })}\n`);
  return response;
}

export const codexaCupyRuntime: ProviderRuntime = {
  providerId: "codexa-cupy", label: "CuPy", modelPickerLabel: "CuPy", backendKind: "codexa-cupy", routeAvailable: true, routeStatus: "Runs the NumPy checkpoint through CuPy/CUDA.", routeSetupMessage: "CuPy model files are unavailable.", launchAvailable: false,
  isRouteConfigured: () => isLocalDevChannel() && discoverCodexaCupyModels().status === "ready",
  discoverModels: discoverCodexaCupyModels, refreshModels: async () => discoverCodexaCupyModels(),
  validateRoute: async (): Promise<ProviderRouteValidationResult> => { const discovery = discoverCodexaCupyModels(); return { status: discovery.status, providerId: "codexa-cupy", backendKind: discovery.backendKind, message: discovery.message, diagnostics: discovery.diagnostics }; },
  run: (request, handlers) => { let canceled = false; handlers.onProgress?.({ id: "codexa-cupy-route", source: "stdout", text: bridge ? "Using loaded CuPy model" : "Loading CuPy checkpoint" }); const prompt = request.conversationHistory?.length ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}` : request.prompt; sendPrompt(prompt, handlers).then((text) => { if (canceled) return; handlers.onAssistantDelta?.(text); handlers.onFinalAnswerObserved?.(text); handlers.onResponse(text); }).catch((error) => { if (!canceled) handlers.onError(error instanceof Error ? error.message : "CuPy failed."); }); return () => { canceled = true; stopBridge("CuPy request canceled."); }; },
};
