import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { traceLocalStream } from "./localStreamDebug.js";

test("Local stream diagnostics redact response content by default", () => {
  const root = mkdtempSync(join(tmpdir(), "codexa-local-stream-debug-"));
  const logPath = join(root, "stream.jsonl");
  traceLocalStream("chunk", {
    raw: "private response",
    choices: [{ content: "secret text", finish_reason: "stop" }],
  }, {
    CODEXA_DEBUG_LOCAL_STREAM: "1",
    CODEXA_DEBUG_LOCAL_STREAM_FILE: logPath,
  });

  const line = readFileSync(logPath, "utf8");
  assert.doesNotMatch(line, /private response|secret text/);
  assert.match(line, /redacted:16 chars/);
  assert.match(line, /finish_reason/);
});

test("Local stream diagnostics include content only with explicit consent", () => {
  const root = mkdtempSync(join(tmpdir(), "codexa-local-stream-debug-content-"));
  const logPath = join(root, "stream.jsonl");
  traceLocalStream("chunk", { raw: "diagnostic response" }, {
    CODEXA_DEBUG_LOCAL_STREAM: "1",
    CODEXA_DEBUG_LOCAL_STREAM_CONTENT: "1",
    CODEXA_DEBUG_LOCAL_STREAM_FILE: logPath,
  });

  assert.match(readFileSync(logPath, "utf8"), /diagnostic response/);
});
