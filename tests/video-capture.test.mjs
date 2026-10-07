import assert from "node:assert/strict";
import test from "node:test";
import { pickRecorderMimeType, videoFileExtension } from "../app/map/video-capture.mjs";

test("the first supported MIME type in preference order wins", () => {
  const preferences = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"];
  assert.equal(pickRecorderMimeType(preferences, (type) => type.startsWith("video/webm")), "video/webm;codecs=vp9");
  assert.equal(pickRecorderMimeType(preferences, () => true), "video/mp4;codecs=avc1");
  assert.equal(pickRecorderMimeType(preferences, () => false), null);
  assert.equal(pickRecorderMimeType([], () => true), null);
});

test("a type-support probe that throws is skipped", () => {
  const picked = pickRecorderMimeType(["video/mp4", "video/webm"], (type) => {
    if (type === "video/mp4") throw new TypeError("unknown container");
    return true;
  });
  assert.equal(picked, "video/webm");
});

test("file extensions follow the container", () => {
  assert.equal(videoFileExtension("video/mp4;codecs=avc1.42E01E"), "mp4");
  assert.equal(videoFileExtension("video/webm;codecs=vp9"), "webm");
  assert.equal(videoFileExtension("video/x-matroska"), "mkv");
  assert.equal(videoFileExtension(null), "webm");
});
