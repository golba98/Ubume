import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error JavaScript utility script exports are exercised directly.
import { createUbumeDevShim, resolveInstallBinDir } from "./install-local-dev-bin.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("resolveInstallBinDir honors explicit ubume dev bin override", () => {
  assert.equal(resolveInstallBinDir({ UBUME_DEV_BIN_DIR: "/tmp/ubume-dev-bin" }), "/tmp/ubume-dev-bin");
});

test("install-local-dev-bin preserves published ubume while creating local dev shims", () => {
  const binDir = mkdtempSync(join(tmpdir(), "ubume-dev-bin-"));
  const publishedBin = join(binDir, "ubume");
  writeFileSync(publishedBin, "published", "utf8");

  try {
    const result = createUbumeDevShim({ binDir });
    const shim = readFileSync(result.shimPath, "utf8");

    assert.equal(readFileSync(publishedBin, "utf8"), "published");
    assert.equal(existsSync(join(binDir, "ubume-dev")), process.platform !== "win32");
    assert.equal(existsSync(join(binDir, "ubume-dev")), process.platform !== "win32");
    assert.match(shim, /run-local-dev\.mjs/);
    assert.match(shim, /node/);
    assert.doesNotMatch(shim, /bin\/ubume\.js/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("run-local-dev handles version without requiring an interactive terminal", () => {
  const output = execFileSync(process.execPath, [join(repoRoot, "scripts", "run-local-dev.mjs"), "--version"], {
    encoding: "utf8",
  }).trim();

  assert.match(output, /^\d+\.\d+\.\d+-dev local$/);
});
