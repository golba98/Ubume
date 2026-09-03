import assert from "node:assert/strict";
import test from "node:test";
import { readClipboardImage } from "./clipboardImage.js";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("test")]);

test("reads PNG clipboard bytes through Wayland", async () => {
  const calls: string[] = [];
  const result = await readClipboardImage({
    platform: "linux",
    env: {},
    run: async (file) => { calls.push(file); return PNG; },
  });
  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(result.data, PNG);
  assert.deepEqual(calls, ["wl-paste"]);
});

test("falls back from Wayland to X11 and rejects non-images", async () => {
  const calls: string[] = [];
  await assert.rejects(() => readClipboardImage({
    platform: "linux",
    env: {},
    run: async (file) => {
      calls.push(file);
      if (file === "wl-paste") throw new Error("missing");
      return Buffer.from("plain text");
    },
  }), /supported PNG image/);
  assert.deepEqual(calls, ["wl-paste", "xclip"]);
});
