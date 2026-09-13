import assert from "node:assert/strict";
import test from "node:test";
import { performStartupClear } from "./startupClear.js";

function makeCapture(): { written: string[]; write: (chunk: string) => boolean } {
  const written: string[] = [];
  return { written, write: (chunk) => { written.push(chunk); return true; } };
}

const TRANSCRIPT_CLEAR = "\x1b[2J\x1b[3J\x1b[H";

test("emits full transcript clear in normal interactive mode", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: false, env: {} });
  assert.deepEqual(cap.written, [TRANSCRIPT_CLEAR]);
});

test("skips clear when noClear flag is true (--no-clear)", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: true, env: {} });
  assert.equal(cap.written.length, 0);
});

test("skips clear when UBUME_NO_CLEAR=1 env var is set", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: false, env: { UBUME_NO_CLEAR: "1" } });
  assert.equal(cap.written.length, 0);
});

test("noClear flag takes precedence over unset env var", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: true, env: { UBUME_NO_CLEAR: "0" } });
  assert.equal(cap.written.length, 0);
});

test("emits clear when UBUME_NO_CLEAR is not '1'", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: false, env: { UBUME_NO_CLEAR: "0" } });
  assert.deepEqual(cap.written, [TRANSCRIPT_CLEAR]);
});

test("emits clear when UBUME_NO_CLEAR is undefined", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: false, env: { UBUME_NO_CLEAR: undefined } });
  assert.deepEqual(cap.written, [TRANSCRIPT_CLEAR]);
});

test("clear sequence includes viewport clear, scrollback clear, and cursor home", () => {
  const cap = makeCapture();
  performStartupClear({ write: cap.write, noClear: false, env: {} });
  const seq = cap.written[0] ?? "";
  assert.ok(seq.includes("\x1b[2J"), "must include viewport clear");
  assert.ok(seq.includes("\x1b[3J"), "must include scrollback clear");
  assert.ok(seq.includes("\x1b[H"), "must include cursor home");
});
