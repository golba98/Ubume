import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTerminalTitleSequence,
  computeTerminalTitle,
  deriveTerminalTitle,
  formatTerminalTitleLabel,
  getIntendedTerminalTitle,
  normalizeTerminalTitle,
  reassertTerminalTitle,
  reassertIntendedTerminalTitle,
  sanitizeTerminalTitle,
  setIntendedTerminalTitle,
  setTerminalTitle,
  createTerminalTitleSequenceStripper,
  stripTerminalTitleSequences,
  stripTerminalTitleSequencesFromChunk,
  traceTerminalTitleSequences,
  writeUbumeTerminalTitle,
  writeGuardedTerminalOutput,
  __resetTerminalTitleCache,
} from "./terminalTitle.js";

test("buildTerminalTitleSequence emits OSC 0 and OSC 2 with sanitized title text", () => {
  const sequence = buildTerminalTitleSequence("Ubume\u0007!");
  assert.equal(sequence, "\x1b]0;Ubume !\x07\x1b]2;Ubume !\x07");
  assert.equal(sanitizeTerminalTitle("  Ubume  "), "Ubume");
});

test("title normalization never exposes raw Windows paths", () => {
  assert.equal(normalizeTerminalTitle("C:\\WINDOWS\\system"), "Ubume");
  assert.equal(normalizeTerminalTitle("c:/Users/example"), "Ubume");
  assert.equal(normalizeTerminalTitle("\\\\server\\share"), "Ubume");
  assert.equal(buildTerminalTitleSequence("C:\\WINDOWS\\system"), buildTerminalTitleSequence("Ubume"));
});

test("stripTerminalTitleSequences removes OSC 0 title sequences with BEL terminator", () => {
  assert.equal(
    stripTerminalTitleSequences("hello\x1b]0;C:\\WINDOWS\\system\x07world"),
    "helloworld",
  );
});

test("stripTerminalTitleSequences removes OSC 2 title sequences with BEL terminator", () => {
  assert.equal(
    stripTerminalTitleSequences("hello\x1b]2;Codex\x07world"),
    "helloworld",
  );
});

test("stripTerminalTitleSequences preserves normal ANSI SGR colour sequences", () => {
  const input = "\x1b[31mred\x1b[0m";
  assert.equal(stripTerminalTitleSequences(input), input);
});

test("stripTerminalTitleSequences removes title OSC from mixed output while preserving SGR", () => {
  assert.equal(
    stripTerminalTitleSequences("start\x1b]0;C:\\WINDOWS\\system\x07middle\x1b[32mok\x1b[0mend"),
    "startmiddle\x1b[32mok\x1b[0mend",
  );
});

test("stripTerminalTitleSequences removes OSC title sequences with ST terminator", () => {
  assert.equal(
    stripTerminalTitleSequences("hello\x1b]0;C:\\WINDOWS\\system\x1b\\world"),
    "helloworld",
  );
});

test("stripTerminalTitleSequencesFromChunk handles Buffer input", () => {
  assert.equal(
    stripTerminalTitleSequencesFromChunk(Buffer.from("hello\x1b]0;C:\\WINDOWS\\system\x07world", "utf8")),
    "helloworld",
  );
});

test("createTerminalTitleSequenceStripper removes title sequences split across chunks", () => {
  const stripper = createTerminalTitleSequenceStripper({
    source: "test",
    stream: "stdout",
    origin: "child",
  });

  assert.equal(stripper.process("hello\x1b]0;C:\\WINDOWS"), "hello");
  assert.equal(stripper.process("\\system\x07world"), "world");
  assert.equal(stripper.flush(), "");
});

test("formatTerminalTitleLabel follows the workspace leaf and app-name rules", () => {
  assert.equal(
    formatTerminalTitleLabel("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "dir"),
    "13-Custom-CLI-Normal",
  );
  assert.equal(
    formatTerminalTitleLabel("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "name"),
    "Ubume",
  );
  assert.equal(
    formatTerminalTitleLabel("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "simple"),
    "Ubume",
  );
});

test("deriveTerminalTitle follows terminal title mode on startup", () => {
  const workspaceRoot = "C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal";

  assert.equal(deriveTerminalTitle(workspaceRoot, "dir"), "13-Custom-CLI-Normal");
  assert.equal(deriveTerminalTitle(workspaceRoot, "name"), "Ubume");
  assert.equal(deriveTerminalTitle(workspaceRoot, "simple"), "Ubume");
});

test("computeTerminalTitle follows the requested mapping", () => {
  const workspaceName = "13-Custom-CLI-Normal";
  assert.equal(computeTerminalTitle({ terminalTitleMode: "dir", workspaceName }), "13-Custom-CLI-Normal");
  assert.equal(computeTerminalTitle({ terminalTitleMode: "name" }), "Ubume");
  assert.equal(computeTerminalTitle({ terminalTitleMode: "simple" }), "Ubume");
  assert.equal(computeTerminalTitle({ terminalTitleMode: "dir", appName: "Other" }), "Other");
});

test("reassertTerminalTitle writes both title sequences without mutating process title", () => {
  const writes: string[] = [];
  const originalTitle = process.title;

  try {
    reassertTerminalTitle("Ubume", (chunk) => {
      writes.push(chunk);
    });

    assert.equal(process.title, originalTitle);
    assert.deepEqual(writes, [buildTerminalTitleSequence("Ubume")]);
  } finally {
    process.title = originalTitle;
  }
});

test("setTerminalTitle deduplicates identical title writes", () => {
  const writes: string[] = [];
  __resetTerminalTitleCache();

  setTerminalTitle("Ubume", { write: (chunk) => writes.push(chunk) });
  setTerminalTitle("Ubume", { write: (chunk) => writes.push(chunk) });
  setTerminalTitle("Other", { write: (chunk) => writes.push(chunk) });

  assert.equal(writes.length, 2);
  assert.equal(writes[0], buildTerminalTitleSequence("Ubume"));
  assert.equal(writes[1], buildTerminalTitleSequence("Other"));
});

test("writeUbumeTerminalTitle delegates to central title writer with force support", () => {
  const writes: string[] = [];
  __resetTerminalTitleCache();

  writeUbumeTerminalTitle("Ubume", { force: true, reason: "test", write: (chunk) => writes.push(chunk) });

  assert.deepEqual(writes, [buildTerminalTitleSequence("Ubume")]);
});

test("intended terminal title fallback is safe and later replaced by workspace title", () => {
  const writes: string[] = [];
  __resetTerminalTitleCache();

  setIntendedTerminalTitle("C:\\WINDOWS\\system", {
    force: true,
    reason: "test-fallback",
    write: (chunk) => writes.push(chunk),
  });
  assert.equal(getIntendedTerminalTitle(), "Ubume");
  assert.equal(writes.at(-1), buildTerminalTitleSequence("Ubume"));

  setIntendedTerminalTitle("13-Custom-CLI-Normal", {
    force: true,
    reason: "test-workspace",
    write: (chunk) => writes.push(chunk),
  });
  assert.equal(getIntendedTerminalTitle(), "13-Custom-CLI-Normal");
  assert.equal(writes.at(-1), buildTerminalTitleSequence("13-Custom-CLI-Normal"));
});

test("busy idle reassertion keeps the same intended title", () => {
  const writes: string[] = [];
  __resetTerminalTitleCache();

  setIntendedTerminalTitle("13-Custom-CLI-Normal", {
    force: true,
    write: (chunk) => writes.push(chunk),
  });
  reassertIntendedTerminalTitle({ reason: "busy-start", write: (chunk) => writes.push(chunk) });
  reassertIntendedTerminalTitle({ reason: "busy-end", write: (chunk) => writes.push(chunk) });

  assert.equal(getIntendedTerminalTitle(), "13-Custom-CLI-Normal");
  assert.deepEqual(writes, [
    buildTerminalTitleSequence("13-Custom-CLI-Normal"),
    buildTerminalTitleSequence("13-Custom-CLI-Normal"),
    buildTerminalTitleSequence("13-Custom-CLI-Normal"),
  ]);
});

test("writeGuardedTerminalOutput strips external title OSC and preserves SGR", () => {
  const writes: string[] = [];
  const result = writeGuardedTerminalOutput(
    (chunk) => {
      writes.push(chunk);
      return true;
    },
    "start\x1b]0;C:\\WINDOWS\\system\x07middle\x1b[32mok\x1b[0mend",
    { source: "test", stream: "stdout", origin: "child" },
  );

  assert.equal(result, true);
  assert.deepEqual(writes, ["startmiddle\x1b[32mok\x1b[0mend"]);
});

test("setTerminalTitle force option bypasses dedup", () => {
  const writes: string[] = [];
  __resetTerminalTitleCache();

  setTerminalTitle("Ubume", { write: (chunk) => writes.push(chunk) });
  setTerminalTitle("Ubume", { force: true, write: (chunk) => writes.push(chunk) });
  setTerminalTitle("Ubume", { force: true, write: (chunk) => writes.push(chunk) });

  assert.equal(writes.length, 3);
  writes.forEach((w) => assert.equal(w, buildTerminalTitleSequence("Ubume")));
});

test("stripTerminalTitleSequences handles very long unterminated OSC without hanging", () => {
  const long = "\x1b]0;" + "A".repeat(100_000);
  const start = Date.now();
  const result = stripTerminalTitleSequences(long);
  assert.ok(Date.now() - start < 100, "must complete in under 100 ms");
  assert.ok(result.includes("\x1b]0;"), "unterminated sequence passes through unchanged");
});

test("stripTerminalTitleSequences strips OSC sequence with empty title", () => {
  assert.equal(stripTerminalTitleSequences("pre\x1b]0;\x07post"), "prepost");
  assert.equal(stripTerminalTitleSequences("pre\x1b]2;\x1b\\post"), "prepost");
});

test("createTerminalTitleSequenceStripper handles OSC split across chunks with ST terminator", () => {
  const stripper = createTerminalTitleSequenceStripper({ source: "test", stream: "stdout", origin: "child" });
  assert.equal(stripper.process("hello\x1b]2;MyTitle"), "hello");
  assert.equal(stripper.process("\x1b\\world"), "world");
  assert.equal(stripper.flush(), "");
});

test("traceTerminalTitleSequences does not hang on crafted adversarial input", () => {
  const crafted = "\x1b]0;" + "X".repeat(10_000) + "\x1b]2;" + "Y".repeat(10_000);
  const start = Date.now();
  const found = traceTerminalTitleSequences(crafted, { source: "test", stream: "stdout", origin: "child" });
  assert.ok(Date.now() - start < 100, "must complete in under 100 ms");
  assert.equal(found, false, "no complete sequences in adversarial input");
});
