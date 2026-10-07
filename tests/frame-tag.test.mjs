import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrameTag, encodeFrameTag, FRAME_TAG_COUNT } from "../app/map/frame-tag.mjs";

function channels(rgb) {
  return rgb.match(/\d+/g).map(Number);
}

test("every tag round-trips through its color", () => {
  for (let tag = 0; tag < FRAME_TAG_COUNT; tag += 1) {
    const [r, g, b] = channels(encodeFrameTag(tag));
    assert.equal(decodeFrameTag(r, g, b), tag);
  }
});

test("tags wrap and tolerate color drift from the capture pipeline", () => {
  assert.equal(encodeFrameTag(64), encodeFrameTag(0));
  assert.equal(encodeFrameTag(-1), encodeFrameTag(63));
  const [r, g, b] = channels(encodeFrameTag(37));
  assert.equal(decodeFrameTag(r + 20, g - 20, b + 20), 37);
  assert.equal(decodeFrameTag(r - 30, g + 30, b - 30), 37);
});

test("channel levels are well separated", () => {
  const [r, g, b] = channels(encodeFrameTag(0b11_10_01));
  assert.deepEqual([r, g, b], [255, 170, 85]);
});
