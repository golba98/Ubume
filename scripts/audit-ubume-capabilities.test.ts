import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("capability audit resolves the current source layout without false missing results", () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "audit-ubume-capabilities.mjs")],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Total checks:\s+17/);
  assert.match(result.stdout, /Passed:\s+17 \(100%\)/);
  assert.match(result.stdout, /Missing\/Partial:\s+0 \(0%\)/);
  assert.doesNotMatch(result.stdout, /✗ MISSING/);
});
