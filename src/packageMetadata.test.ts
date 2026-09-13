import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

test("published package binary provides ubume and backwards-compatible codexa alias", () => {
  assert.deepEqual(packageJson.bin, {
    ubume: "bin/ubume.js",
    codexa: "bin/codexa.js",
  });
  assert.equal(Object.hasOwn(packageJson.bin ?? {}, "ubume-dev"), false);
  assert.equal(Object.hasOwn(packageJson.bin ?? {}, "ubume-dev"), false);
});

test("local dev scripts install and run dev bin separately", () => {
  assert.equal(packageJson.scripts?.["install:dev-bin"], "node scripts/install-local-dev-bin.mjs");
  assert.equal(packageJson.scripts?.["dev:run"], "node scripts/run-local-dev.mjs");
});
