import assert from "node:assert/strict";
import test from "node:test";
import { formatTomlKey, formatTomlPath, serializeTomlDocument } from "./toml-serialize.js";
import { parseTomlDocument } from "./layeredConfig.js";

test("formatTomlKey quotes keys only when necessary", () => {
  assert.equal(formatTomlKey("model"), "model");
  assert.equal(formatTomlKey("plan_mode"), "plan_mode");
  assert.equal(formatTomlKey("danger-full-access"), "danger-full-access");
  assert.equal(formatTomlKey("/home/user/path"), '"/home/user/path"');
  assert.equal(
    formatTomlKey("/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"),
    '"/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"',
  );
  assert.equal(formatTomlKey("key with space"), '"key with space"');
  assert.equal(formatTomlKey("key.with.dots"), '"key.with.dots"');
});

test("formatTomlPath formats dotted section paths with quotes where needed", () => {
  assert.equal(formatTomlPath(["projects"]), "projects");
  assert.equal(
    formatTomlPath(["projects", "/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"]),
    'projects."/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"',
  );
  assert.equal(
    formatTomlPath(["apps", "github", "tools.create_pull_request"]),
    'apps.github."tools.create_pull_request"',
  );
});

test("serializeTomlDocument produces valid parseable TOML for paths with spaces and special chars", () => {
  const input = {
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    projects: {
      "/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI": {
        trust_level: "trusted",
      },
      "/simple/path": {
        trust_level: "trusted",
      },
    },
    ubume: {
      mode: "full-auto",
      plan_mode: false,
    },
  };

  const serialized = serializeTomlDocument(input);
  assert.ok(
    serialized.includes('[projects."/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"]'),
    `Expected quoted table header in:\n${serialized}`,
  );

  const parsed = parseTomlDocument(serialized);
  assert.equal(parsed.sandbox_mode, "danger-full-access");
  assert.equal(parsed.approval_policy, "never");
  assert.deepEqual(
    (parsed.projects as Record<string, unknown>)["/home/k9-vortex/Development/1-JavaScript(Type)/13-Ubume CLI"],
    { trust_level: "trusted" },
  );
  assert.deepEqual(
    (parsed.ubume as Record<string, unknown>),
    { mode: "full-auto", plan_mode: false },
  );
});
