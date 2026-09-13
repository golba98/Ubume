import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getUpdateCheckCacheFilePath,
  isCacheForRunningVersion,
  isCacheValid,
  loadUpdateCheckCache,
  saveUpdateCheckCache,
  type UpdateCheckCache,
} from "./updateCheckCache.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ubume-update-cache-"));
}

function makeCache(overrides: Partial<UpdateCheckCache> = {}): UpdateCheckCache {
  return {
    lastChecked: Date.now(),
    currentVersion: "1.0.4",
    latestVersion: "1.0.5",
    updateAvailable: true,
    ...overrides,
  };
}

test("save/load round-trips through an explicit file path", () => {
  const dir = makeTempDir();
  try {
    const filePath = join(dir, "update-check.json");
    const cache = makeCache();
    saveUpdateCheckCache(cache, filePath);
    const loaded = loadUpdateCheckCache(filePath);
    assert.deepEqual(loaded, cache);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns null for corrupt JSON", () => {
  const dir = makeTempDir();
  try {
    const filePath = join(dir, "update-check.json");
    writeFileSync(filePath, "{ definitely not json", "utf8");
    assert.equal(loadUpdateCheckCache(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns null for a missing file", () => {
  const dir = makeTempDir();
  try {
    assert.equal(loadUpdateCheckCache(join(dir, "does-not-exist.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns null when required fields have wrong types", () => {
  const dir = makeTempDir();
  try {
    const filePath = join(dir, "update-check.json");
    writeFileSync(filePath, JSON.stringify({ lastChecked: "yesterday", currentVersion: "1.0.4" }), "utf8");
    assert.equal(loadUpdateCheckCache(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache file path is resolved from the environment per call, not at module load", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  try {
    delete process.env.USERPROFILE;
    process.env.HOME = dirA;
    assert.equal(getUpdateCheckCacheFilePath(), join(dirA, ".ubume-update-check.json"));

    process.env.HOME = dirB;
    assert.equal(getUpdateCheckCacheFilePath(), join(dirB, ".ubume-update-check.json"));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("save/load honor a HOME change between calls", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  try {
    delete process.env.USERPROFILE;
    process.env.HOME = dirA;
    saveUpdateCheckCache(makeCache({ latestVersion: "1.0.5" }));
    assert.equal(loadUpdateCheckCache()?.latestVersion, "1.0.5");

    process.env.HOME = dirB;
    assert.equal(loadUpdateCheckCache(), null);
    // The file landed under dirA, not dirB.
    const written = JSON.parse(
      readFileSync(join(dirA, ".ubume-update-check.json"), "utf8"),
    ) as UpdateCheckCache;
    assert.equal(written.latestVersion, "1.0.5");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("isCacheValid: TTL expiry invalidates the cache", () => {
  const cache = makeCache({ lastChecked: Date.now() - 7 * 60 * 60 * 1000 });
  assert.equal(isCacheValid(cache, 6, "1.0.4"), false);
});

test("isCacheValid: version mismatch invalidates (post-upgrade, still-running scenario)", () => {
  // A cache written by 1.0.4 must not be reused once the running app is 1.0.5.
  const cache = makeCache({ currentVersion: "1.0.4", latestVersion: "1.0.4", updateAvailable: false });
  assert.equal(isCacheValid(cache, 6, "1.0.5"), false);
});

test("isCacheValid: fresh cache for the running version is valid", () => {
  const cache = makeCache();
  assert.equal(isCacheValid(cache, 6, "1.0.4"), true);
});

test("isCacheForRunningVersion ignores a leading v but rejects a different install", () => {
  const cache = makeCache({ currentVersion: "v1.0.4" });
  assert.equal(isCacheForRunningVersion(cache, "1.0.4"), true);
  assert.equal(isCacheForRunningVersion(cache, "1.0.5"), false);
});
