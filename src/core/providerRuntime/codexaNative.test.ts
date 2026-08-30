import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexaNativePrompt,
  CODEXA_NATIVE_MODEL_ID,
  codexaNativeRuntime,
  DEFAULT_CODEXA_NATIVE_MODEL_ROOT,
  discoverCodexaNativeModels,
  resolveCodexaNativeConfig,
  runCodexaNativeRollover,
  stitchNativeContinuation,
} from "./codexaNative.js";

test("Codexa Native prompt establishes Codexa identity", () => {
  const prompt = buildCodexaNativePrompt("Who are you?");
  assert.match(prompt, /You are Codexa/);
  assert.match(prompt, /never as Open Assistant/);
  assert.match(prompt, /User request:\nWho are you\?/);
});

test("Codexa Native resolves explicit model paths", () => {
  const config = resolveCodexaNativeConfig({
    CODEXA_NATIVE_MODEL_ROOT: "/models/codexa",
    CODEXA_NATIVE_PYTHON: "/python",
    CODEXA_NATIVE_CHECKPOINT: "/checkpoint.pt",
    CODEXA_NATIVE_TOKENIZER: "/tokenizer.json",
    CODEXA_NATIVE_DEVICE: "cpu",
  });

  assert.equal(config.bridgeScript, "/models/codexa/scripts/native_chat_bridge.py");
  assert.equal(config.python, "/python");
  assert.equal(config.checkpoint, "/checkpoint.pt");
  assert.equal(config.tokenizer, "/tokenizer.json");
  assert.equal(config.device, "cpu");
});

test("Codexa Native defaults to the canonical PyTorch checkout", () => {
  const config = resolveCodexaNativeConfig({});
  assert.equal(config.modelRoot, DEFAULT_CODEXA_NATIVE_MODEL_ROOT);
  assert.equal(config.bridgeScript, join(DEFAULT_CODEXA_NATIVE_MODEL_ROOT, "scripts", "native_chat_bridge.py"));
  assert.equal(config.checkpoint, join(DEFAULT_CODEXA_NATIVE_MODEL_ROOT, "checkpoints", "codexa-900m-sft-v2", "latest.pt"));
  assert.equal(config.tokenizer, join(DEFAULT_CODEXA_NATIVE_MODEL_ROOT, "checkpoints", "tokenizer-base-v1", "tokenizer.json"));
});

test("Codexa Native discovery returns not-configured in production channel", () => {
  const result = discoverCodexaNativeModels(undefined, { CODEXA_CHANNEL: "published" });
  assert.equal(result.status, "not-configured");
  assert.match(result.message ?? "", /only available on codexa-dev/);
});

test("Codexa Native discovery exposes the direct PyTorch model in local-dev channel when files exist", () => {
  const root = mkdtempSync(join(tmpdir(), "codexa-native-"));
  try {
    const scripts = join(root, "scripts");
    const checkpoint = join(root, "latest.pt");
    const tokenizer = join(root, "tokenizer.json");
    const python = join(root, "python");
    mkdirSync(scripts);
    for (const path of [join(scripts, "native_chat_bridge.py"), checkpoint, tokenizer, python]) {
      writeFileSync(path, "fixture");
    }

    const result = discoverCodexaNativeModels(
      {
        modelRoot: root,
        python,
        bridgeScript: join(scripts, "native_chat_bridge.py"),
        checkpoint,
        tokenizer,
        device: "cpu",
      },
      { CODEXA_CHANNEL: "local-dev" },
    );

    assert.equal(result.status, "ready");
    assert.equal(result.backendKind, "codexa-native-pytorch");
    assert.equal(result.models[0]?.modelId, CODEXA_NATIVE_MODEL_ID);
    assert.equal(codexaNativeRuntime.providerId, "codexa-native");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codexa Native stitches overlapping context-window continuations", () => {
  assert.equal(stitchNativeContinuation("The answer is partly", "partly complete."), "The answer is partly complete.");
});

test("Codexa Native silently rolls over finish_reason=length", async () => {
  const sent: boolean[] = [];
  const checkpoints: string[] = [];
  const responses = [
    { type: "response", text: "The answer is partly", finish_reason: "length" },
    { type: "response", text: "goal and unfinished answer", finish_reason: "stop" },
    { type: "response", text: "partly complete.", finish_reason: "stop" },
  ];
  const result = await runCodexaNativeRollover({
    request: { prompt: "Explain it" } as never,
    handlers: {
      onResponse: () => {},
      onError: () => {},
      onLocalContextCheckpoint: (checkpoint) => { checkpoints.push(checkpoint.summary); },
    },
    send: async (_prompt, announceReady) => {
      sent.push(announceReady);
      return responses.shift()!;
    },
  });
  assert.equal(result, "The answer is partly complete.");
  assert.deepEqual(sent, [true, false, false]);
  assert.deepEqual(checkpoints, ["goal and unfinished answer"]);
});

test("Codexa Native crosses 20 length windows without a fixed rollover cap", async () => {
  let answerCalls = 0;
  const result = await runCodexaNativeRollover({
    request: { prompt: "Long answer" } as never,
    handlers: { onResponse: () => {}, onError: () => {} },
    send: async (prompt) => {
      if (prompt.includes("compact continuation checkpoint")) {
        return { type: "response", text: `checkpoint ${answerCalls}`, finish_reason: "stop" };
      }
      answerCalls += 1;
      return { type: "response", text: `window-${answerCalls} `, finish_reason: answerCalls <= 22 ? "length" : "stop" };
    },
  });
  assert.equal(answerCalls, 23);
  assert.match(result, /window-1/);
  assert.match(result, /window-23/);
});
