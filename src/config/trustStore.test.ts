import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";

test("persists trusted project roots", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-store-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const module = await import(`./trustStore.js?trust=${Date.now()}`);
    const projectRoot = "C:/Workspace/Repo";

    assert.equal(module.isProjectTrusted(projectRoot), false);
    module.setProjectTrust(projectRoot, true);
    assert.equal(module.isProjectTrusted(projectRoot), true);
    module.setProjectTrust(projectRoot, false);
    assert.equal(module.isProjectTrusted(projectRoot), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("migrates legacy codexa-trust.json to ubume-trust.json non-destructively", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-migration-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const legacyTrustFile = join(tempHome, "codexa-trust.json");
    writeFileSync(legacyTrustFile, JSON.stringify({ trustedProjectRoots: ["/migrated/project"] }), "utf-8");

    const module = await import(`./trustStore.js?trustMigrate=${Date.now()}`);
    assert.equal(module.isProjectTrusted("/migrated/project"), true);

    const ubumeTrustFile = join(tempHome, "ubume-trust.json");
    assert.ok(existsSync(ubumeTrustFile), "ubume-trust.json should be created");
    assert.ok(existsSync(legacyTrustFile), "codexa-trust.json should remain intact");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});
