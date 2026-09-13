import assert from "node:assert/strict";
import test from "node:test";
import { isUnifiedDiff, maybeRenderDiff, renderUnifiedDiff } from "./diffRenderer.js";

const GIT_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " const name = \"Ubume\";",
  "-console.log(\"old\");",
  "+console.log(\"new\");",
  "+console.log(\"added\");",
  " export default name;",
].join("\n");

test("detects a git unified diff", () => {
  assert.equal(isUnifiedDiff(GIT_DIFF), true);
});

test("detects a simple file-header and hunk diff", () => {
  const diff = [
    "--- old.txt",
    "+++ new.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  assert.equal(isUnifiedDiff(diff), true);
});

test("classifies file, hunk, added, removed, context, and meta lines", () => {
  const rendered = renderUnifiedDiff(GIT_DIFF);
  assert.deepEqual(rendered.map((line) => line.type), [
    "file",
    "meta",
    "file",
    "file",
    "hunk",
    "context",
    "remove",
    "add",
    "add",
    "context",
  ]);
});

test("handles malformed diff-like text without throwing", () => {
  assert.doesNotThrow(() => renderUnifiedDiff("diff --git a/a b/a\nnot enough here"));
  assert.equal(maybeRenderDiff("diff --git a/a b/a\nnot enough here"), null);
});

test("does not classify normal text as a diff", () => {
  const text = [
    "Here are options:",
    "- use --help",
    "+ consider reading docs",
  ].join("\n");

  assert.equal(isUnifiedDiff(text), false);
  assert.equal(maybeRenderDiff(text), null);
});

test("keeps Windows paths readable in file headers", () => {
  const diff = [
    "--- a\\src\\example.ts",
    "+++ b\\src\\example.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  const rendered = renderUnifiedDiff(diff);
  assert.equal(rendered[0]?.text, "--- a\\src\\example.ts");
  assert.equal(rendered[1]?.text, "+++ b\\src\\example.ts");
});

test("strips ANSI and unsafe controls before classification", () => {
  const diff = [
    "\u001b[31m--- a/file.ts\u001b[0m",
    "\u001b[32m+++ b/file.ts\u001b[0m",
    "@@ -1 +1 @@",
    "\u001b[31m-old\u001b[0m",
    "\u001b[32m+new\u001b[0m\u0007",
  ].join("\n");

  const rendered = renderUnifiedDiff(diff);
  assert.deepEqual(rendered.map((line) => line.text), [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ]);
});

test("forced rendering accepts explicit diff fences with change lines", () => {
  assert.equal(isUnifiedDiff("-old\n+new", { force: true }), true);
  assert.equal(isUnifiedDiff("-old\n+new"), false);
});
