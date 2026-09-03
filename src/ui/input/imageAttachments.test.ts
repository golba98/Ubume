import assert from "node:assert/strict";
import test from "node:test";
import { createImageAttachmentToken, selectImageAttachments } from "./imageAttachments.js";

test("selects multiple image attachments in composer order", () => {
  const first = { path: "/tmp/one.png", mediaType: "image/png" as const, name: "one.png", bytes: 10 };
  const second = { path: "/tmp/two.png", mediaType: "image/png" as const, name: "two.png", bytes: 20 };
  const firstToken = createImageAttachmentToken(first);
  const secondToken = createImageAttachmentToken(second);
  const registry = new Map([[firstToken, first], [secondToken, second]]);

  assert.deepEqual(selectImageAttachments(`${secondToken} compare ${firstToken}`, registry), [second, first]);
});
