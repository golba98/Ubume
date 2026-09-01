import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesceConsecutiveThinking } from "./streamCoalesce.js";
import type { RunProgressBlock } from "../../session/types.js";

function block(id: string, text: string, updatedAt: number, status: RunProgressBlock["status"] = "completed"): RunProgressBlock {
  return { id, text, sequence: 1, createdAt: 1, updatedAt, status };
}

type TestEvent =
  | { kind: "thinking"; streamSeq: number; block: RunProgressBlock }
  | { kind: "action"; streamSeq: number; tool: { id: string } };

test("merges a run of consecutive thinking events into the first one", () => {
  const events: TestEvent[] = [
    { kind: "thinking", streamSeq: 1, block: block("a", "first thought", 10) },
    { kind: "thinking", streamSeq: 2, block: block("b", "second thought", 20) },
    { kind: "thinking", streamSeq: 3, block: block("c", "third thought", 15) },
  ];
  const result = coalesceConsecutiveThinking(events);
  assert.equal(result.length, 1);
  const merged = result[0] as Extract<TestEvent, { kind: "thinking" }>;
  assert.equal(merged.streamSeq, 1);
  assert.equal(merged.block.id, "a");
  assert.equal(merged.block.text, "first thought\n\nsecond thought\n\nthird thought");
  assert.equal(merged.block.updatedAt, 20);
  assert.equal(merged.block.status, "completed");
});

test("thoughts separated by an action stay separate blocks", () => {
  const events: TestEvent[] = [
    { kind: "thinking", streamSeq: 1, block: block("a", "before tool", 1) },
    { kind: "thinking", streamSeq: 2, block: block("b", "still before", 2) },
    { kind: "action", streamSeq: 3, tool: { id: "t1" } },
    { kind: "thinking", streamSeq: 4, block: block("c", "after tool", 3) },
  ];
  const result = coalesceConsecutiveThinking(events);
  assert.deepEqual(result.map((event) => event.kind), ["thinking", "action", "thinking"]);
  assert.equal((result[0] as Extract<TestEvent, { kind: "thinking" }>).block.text, "before tool\n\nstill before");
  assert.equal((result[2] as Extract<TestEvent, { kind: "thinking" }>).block.text, "after tool");
});

test("takes the last member's status so a live tail keeps streaming affordances", () => {
  const events: TestEvent[] = [
    { kind: "thinking", streamSeq: 1, block: block("a", "done part", 1) },
    { kind: "thinking", streamSeq: 2, block: block("b", "live part", 2, "active") },
  ];
  const result = coalesceConsecutiveThinking(events);
  assert.equal((result[0] as Extract<TestEvent, { kind: "thinking" }>).block.status, "active");
});

test("passes through single thinking events and non-thinking lists untouched", () => {
  const single: TestEvent[] = [{ kind: "thinking", streamSeq: 1, block: block("a", "only", 1) }];
  assert.equal(coalesceConsecutiveThinking(single)[0], single[0]);

  const actions: TestEvent[] = [
    { kind: "action", streamSeq: 1, tool: { id: "t1" } },
    { kind: "action", streamSeq: 2, tool: { id: "t2" } },
  ];
  assert.deepEqual(coalesceConsecutiveThinking(actions), actions);
  assert.deepEqual(coalesceConsecutiveThinking([]), []);
});

test("drops blank member texts from the joined body", () => {
  const events: TestEvent[] = [
    { kind: "thinking", streamSeq: 1, block: block("a", "real thought", 1) },
    { kind: "thinking", streamSeq: 2, block: block("b", "   ", 2) },
    { kind: "thinking", streamSeq: 3, block: block("c", "another", 3) },
  ];
  const result = coalesceConsecutiveThinking(events);
  assert.equal((result[0] as Extract<TestEvent, { kind: "thinking" }>).block.text, "real thought\n\nanother");
});
