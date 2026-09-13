import assert from "node:assert/strict";
import test from "node:test";
import { formatUbumeBrandLabel, formatUbumeVersionLabel, formatCodexaBrandLabel, isLocalDevChannel } from "./channel.js";
import { APP_VERSION } from "../../config/settings.js";

test("local-dev channel formats an obvious dev version label", () => {
  for (const env of [{ UBUME_CHANNEL: "local-dev" }, { CODEXA_CHANNEL: "local-dev" }]) {
    assert.equal(isLocalDevChannel(env), true);
    assert.equal(formatUbumeVersionLabel(APP_VERSION, env), `${APP_VERSION}-dev local`);
    assert.equal(formatUbumeBrandLabel(env), `Ubume v${APP_VERSION}-dev local`);
    assert.equal(formatCodexaBrandLabel(env), `Ubume v${APP_VERSION}-dev local`);
  }
});

test("published channel keeps normal version label", () => {
  const env = {};

  assert.equal(isLocalDevChannel(env), false);
  assert.equal(formatUbumeVersionLabel("0.1.0", env), "0.1.0");
});
