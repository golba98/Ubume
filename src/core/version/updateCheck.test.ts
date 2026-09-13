import assert from "node:assert/strict";
import test from "node:test";
import {
  UBUME_NPM_REGISTRY_URL,
  UBUME_UPDATE_COMMAND,
  checkForUpdates,
  compareSemver,
  formatUpdateInstructions,
  formatVersionLabel,
  isNewerVersion,
  isValidSemver,
  normalizeVersion,
  shouldRunStartupUpdateCheck,
  type NpmRegistryMetadata,
} from "./updateCheck.js";
import { isCacheValid, type UpdateCheckCache } from "../../config/updateCheckCache.js";

function metadata(version: string): NpmRegistryMetadata {
  return { "dist-tags": { latest: version } };
}

test("checkForUpdates returns update-available when installed version is lower than npm latest", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.2",
      fetchNpmMetadataFn: async (url) => {
        assert.equal(url, UBUME_NPM_REGISTRY_URL);
        return metadata("1.0.3");
      },
    },
  );

  assert.equal(result.status, "update-available");
  assert.equal(result.currentVersion, "1.0.2");
  assert.equal(result.latestVersion, "1.0.3");
});

test("checkForUpdates flags 1.0.5 as an update over installed 1.0.4", async () => {
  // The exact scenario the stale-cache bug masked: 1.0.4 installed, 1.0.5 published.
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.4",
      fetchNpmMetadataFn: async () => metadata("1.0.5"),
    },
  );

  assert.equal(result.status, "update-available");
  assert.equal(result.latestVersion, "1.0.5");
});

test("checkForUpdates compares versions numerically, not as strings", async () => {
  // As strings "1.0.10" < "1.0.9"; numerically it is newer.
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.9",
      fetchNpmMetadataFn: async () => metadata("1.0.10"),
    },
  );

  assert.equal(result.status, "update-available");

  const downgrade = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.10",
      fetchNpmMetadataFn: async () => metadata("1.0.9"),
    },
  );

  assert.equal(downgrade.status, "up-to-date");
  assert.equal(isNewerVersion("1.0.10", "1.0.9"), true);
});

test("checkForUpdates returns up-to-date when installed version equals npm latest", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.3",
      fetchNpmMetadataFn: async () => metadata("1.0.3"),
    },
  );

  assert.equal(result.status, "up-to-date");
});

test("checkForUpdates returns up-to-date when currentVersion has a v-prefix and equals npm latest", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "v1.0.2",
      fetchNpmMetadataFn: async () => metadata("1.0.2"),
    },
  );

  assert.equal(result.status, "up-to-date");
  assert.equal(result.currentVersion, "1.0.2", "v-prefix should be stripped from currentVersion");
});

test("checkForUpdates returns up-to-date when npm latest has a v-prefix and equals currentVersion", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.2",
      fetchNpmMetadataFn: async () => metadata("v1.0.2"),
    },
  );

  assert.equal(result.status, "up-to-date");
});

test("checkForUpdates does not show update available when installed version is higher than npm latest", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.4",
      fetchNpmMetadataFn: async () => metadata("1.0.3"),
    },
  );

  assert.equal(result.status, "up-to-date");
});

test("checkForUpdates returns error status instead of throwing when npm request fails", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => {
        throw new Error("network unavailable");
      },
    },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /network unavailable/);
});

test("checkForUpdates returns error when npm latest is missing", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => ({ "dist-tags": {} }),
    },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /dist-tags\.latest/);
});

test("checkForUpdates returns error when npm latest has a malformed type", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.2",
      fetchNpmMetadataFn: async () => ({ "dist-tags": { latest: 103 } }),
    },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /dist-tags\.latest/);
});

test("checkForUpdates returns unknown (not update-available) when npm latest is an invalid semver", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => metadata("not-a-version"),
    },
  );

  assert.notEqual(result.status, "update-available", "must not show a false update banner for invalid semver");
  assert.equal(result.status, "unknown");
});

test("checkForUpdates returns unknown when npm latest is an empty string", async () => {
  const result = await checkForUpdates(
    {},
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => metadata(""),
    },
  );

  assert.notEqual(result.status, "update-available");
});

test("checkForUpdates returns unknown immediately when enabled=false", async () => {
  let called = false;
  const result = await checkForUpdates(
    { enabled: false },
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => {
        called = true;
        return metadata("1.0.2");
      },
    },
  );

  assert.equal(result.status, "unknown");
  assert.equal(called, false, "should not call npm when disabled");
});

test("startup update check is disabled for local-dev channel", () => {
  assert.equal(shouldRunStartupUpdateCheck({ UBUME_CHANNEL: "local-dev" }, true), false);
  assert.equal(shouldRunStartupUpdateCheck({ UBUME_CHANNEL: "published" }, true), true);
  assert.equal(shouldRunStartupUpdateCheck({ UBUME_CHANNEL: "local-dev" }, false), false);
});

test("explicit update checks still work for local-dev callers", async () => {
  let calls = 0;
  const result = await checkForUpdates(
    { enabled: true },
    {
      currentVersion: "1.0.1",
      fetchNpmMetadataFn: async () => {
        calls += 1;
        return metadata("1.0.2");
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, "update-available");
});

test("semver comparison handles numeric and prerelease ordering", () => {
  assert.equal(isNewerVersion("1.0.10", "1.0.2"), true);
  assert.equal(isNewerVersion("1.0.2", "1.0.10"), false);
  assert.equal(compareSemver("1.0.2", "1.0.2"), 0);
  assert.equal(isNewerVersion("1.0.2", "1.0.2-beta.1"), true);
  assert.equal(isNewerVersion("1.0.2-beta.1", "1.0.2"), false);
});

test("normalizeVersion strips leading v", () => {
  assert.equal(normalizeVersion("v1.0.2"), "1.0.2");
  assert.equal(normalizeVersion("1.0.2"), "1.0.2");
  assert.equal(normalizeVersion("v0.0.1-beta.1"), "0.0.1-beta.1");
});

test("formatVersionLabel adds a single v-prefix", () => {
  assert.equal(formatVersionLabel("1.0.3"), "v1.0.3");
  assert.equal(formatVersionLabel("v1.0.3"), "v1.0.3");
});

test("isValidSemver accepts valid semver strings with and without v-prefix", () => {
  assert.equal(isValidSemver("1.0.2"), true);
  assert.equal(isValidSemver("v1.0.2"), true);
  assert.equal(isValidSemver("1.0.2-beta.1"), true);
  assert.equal(isValidSemver("not-a-version"), false);
  assert.equal(isValidSemver(""), false);
  assert.equal(isValidSemver("1.0"), false);
});

test("isCacheValid returns true when cache is within the interval", () => {
  const cache: UpdateCheckCache = {
    lastChecked: Date.now() - 1000 * 60 * 30,
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
    updateAvailable: false,
  };
  assert.equal(isCacheValid(cache, 6), true);
});

test("isCacheValid returns false when cache is older than the interval", () => {
  const cache: UpdateCheckCache = {
    lastChecked: Date.now() - 1000 * 60 * 60 * 7,
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
    updateAvailable: false,
  };
  assert.equal(isCacheValid(cache, 6), false);
});

test("isCacheValid returns false when cached currentVersion differs from running app version", () => {
  const cache: UpdateCheckCache = {
    lastChecked: Date.now() - 1000 * 60 * 5,
    currentVersion: "1.0.1",
    latestVersion: "1.0.2",
    updateAvailable: true,
  };
  // Cache was written when app was 1.0.1 — must not be reused when running 1.0.2
  assert.equal(isCacheValid(cache, 6, "1.0.2"), false);
});

test("isCacheValid returns true when cached currentVersion matches running version (v-prefix insensitive)", () => {
  const cache: UpdateCheckCache = {
    lastChecked: Date.now() - 1000 * 60 * 5,
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
    updateAvailable: false,
  };
  assert.equal(isCacheValid(cache, 6, "v1.0.2"), true);
  assert.equal(isCacheValid(cache, 6, "1.0.2"), true);
});

test("isCacheValid with no runningVersion behaves as before (time-only check)", () => {
  const fresh: UpdateCheckCache = {
    lastChecked: Date.now() - 1000 * 60 * 5,
    currentVersion: "1.0.1",
    latestVersion: "1.0.2",
    updateAvailable: true,
  };
  assert.equal(isCacheValid(fresh, 6), true);
});

test("formatUpdateInstructions formats update-available npm status", () => {
  const result = formatUpdateInstructions({
    status: "update-available",
    currentVersion: "1.0.1",
    latestVersion: "1.0.2",
    checkedAt: Date.now(),
  });

  assert.match(result, /Current installed version: 1\.0\.1/);
  assert.match(result, /npm latest version:\s+1\.0\.2/);
  assert.match(result, /Update available: Ubume v1\.0\.2/);
  assert.match(result, new RegExp(`Run: ${UBUME_UPDATE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("formatUpdateInstructions leads with up-to-date confirmation and both versions", () => {
  const result = formatUpdateInstructions({
    status: "up-to-date",
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
    checkedAt: Date.now(),
  });

  assert.match(result, /^Ubume is up to date\./);
  assert.match(result, /Current installed version: 1\.0\.2/);
  assert.match(result, /npm latest version:\s+1\.0\.2/);
});

test("formatUpdateInstructions shows the caller-provided update command", () => {
  const result = formatUpdateInstructions({
    status: "update-available",
    currentVersion: "1.0.1",
    latestVersion: "1.0.2",
    checkedAt: Date.now(),
  }, "bun add -g ubume@latest");

  assert.match(result, /Run: bun add -g ubume@latest/);
});

test("formatUpdateInstructions formats manual npm errors", () => {
  const result = formatUpdateInstructions({
    status: "error",
    currentVersion: "1.0.1",
    latestVersion: null,
    errorMessage: "Connection timed out",
    checkedAt: Date.now(),
  });

  assert.match(result, /Error checking npm update status: Connection timed out/);
});

test("/update check path bypasses cache by performing a fresh npm check", async () => {
  const validCache: UpdateCheckCache = {
    lastChecked: Date.now(),
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
    updateAvailable: false,
  };
  assert.equal(isCacheValid(validCache, 6), true);

  let calls = 0;
  const result = await checkForUpdates(
    { enabled: true },
    {
      currentVersion: validCache.currentVersion,
      fetchNpmMetadataFn: async () => {
        calls += 1;
        return metadata("1.0.3");
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, "update-available");
  assert.equal(result.latestVersion, "1.0.3");
});

test("shows prompt when update is available and version is not skipped", () => {
  const latest = "1.0.3";
  const skipped: string | null = null;
  // null skipped version never suppresses the prompt
  assert.notEqual(latest, skipped);
});

test("skips prompt when skippedUpdateVersion matches the latest version", () => {
  const latest: string = "1.0.3";
  const skipped: string = "1.0.3";
  assert.equal(latest, skipped);
});

test("shows prompt again when npm latest is newer than skipped version", () => {
  const latest = "1.0.4";
  const skipped = "1.0.3";
  // Different versions means the prompt is shown again
  assert.notEqual(latest, skipped);
  assert.equal(isNewerVersion(latest, skipped), true);
});
