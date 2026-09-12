import assert from "node:assert/strict";
import { test } from "node:test";
// The shipped Harness plugin is JavaScript because the child runs it directly with Node.
// @ts-expect-error no declaration file is needed for this private bridge module
import { notifyBounded, policyArguments, projectHarnessEvent } from "../../../../bin/codexa-local-harness-bridge.js";

test("bridge drops unused events and does not copy large tool results", () => {
  assert.equal(projectHarnessEvent({ type: "step/start", data: { large: "x".repeat(100_000) } }), null);
  const projected = projectHarnessEvent({
    type: "tool/result",
    seq: 4,
    data: { message: { source: { callId: "call-1" }, content: [{ type: "text", text: "x".repeat(100_000) }] } },
  });
  assert.equal(projected.data.message.content[0].text.length, 2_000);
  assert.equal(projected.data.message.source.callId, "call-1");
  assert.ok(JSON.stringify(projected).length < 3_000);
});

test("bridge preserves streamed text and final output while omitting final reasoning", () => {
  const delta = { type: "assistant/chunk", data: { step: 2, chunk: { type: "text-delta", text: "answer" } } };
  assert.deepEqual(projectHarnessEvent(delta), delta);
  const projected = projectHarnessEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "reasoning", text: "x".repeat(100_000) }, { type: "output_text", text: "answer" }] } },
  });
  assert.deepEqual(projected.data.message.content, [{ type: "output_text", text: "answer" }]);
});

test("bridge limits tool-call display arguments and excludes tool content from policy requests", () => {
  const projected = projectHarnessEvent({
    type: "tool/call",
    data: { callId: "call-2", name: "bash", arguments: JSON.stringify({ command: "x".repeat(100_000), secret: "hidden" }) },
  });
  const args = JSON.parse(projected.data.arguments);
  assert.equal(args.command.length, 2_000);
  assert.equal(args.secret, undefined);
  assert.deepEqual(policyArguments({ command: "git status", path: "src/app.tsx", content: "x".repeat(100_000) }), {
    command: "git status",
    path: "src/app.tsx",
  });
});

test("bridge stops when pending stdout exceeds its 16 MiB buffer", () => {
  const sent: string[] = [];
  const exits: number[] = [];
  const transport = { notify: (method: string) => sent.push(method) };
  notifyBounded(transport, "session.event", {}, { writableLength: 16 * 1024 * 1024 }, (code: number) => exits.push(code));
  assert.equal(exits.length, 0);
  notifyBounded(transport, "session.event", {}, { writableLength: 16 * 1024 * 1024 + 1 }, (code: number) => exits.push(code));
  assert.deepEqual(sent, ["session.event", "session.event"]);
  assert.deepEqual(exits, [86]);
});
