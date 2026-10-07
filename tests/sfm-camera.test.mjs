import assert from "node:assert/strict";
import test from "node:test";

import {
  bearingToSfm,
  cameraTypeFrom,
  createImageTransform,
  isParallaxPair,
  projectBasic,
  radialPeakFor,
  sfmToBearing,
  synthesizePose,
  unprojectBasic,
  unprojectSfM,
  verticalFovDegrees,
  viewDirection,
} from "../app/street-view/sfm-camera.mjs";
import { transformDirection } from "../app/street-view/sfm-math.mjs";

function assertClose(actual, expected, tolerance = 1e-6, message = "") {
  if (Array.isArray(expected) || ArrayBuffer.isView(expected)) {
    assert.equal(actual.length, expected.length, `${message} length`);
    for (let i = 0; i < expected.length; i += 1) {
      assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${message} [${i}]: ${actual[i]} vs ${expected[i]}`);
    }
    return;
  }
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

// A 4:3 landscape perspective image with unit focal and no distortion.
function meta(overrides = {}) {
  return {
    orientation: 1,
    width: 4,
    height: 3,
    scale: 1,
    rotation: [0, 0, 0],
    cameraParameters: [1, 0, 0],
    cameraType: "perspective",
    ...overrides,
  };
}

test("cameraTypeFrom normalizes the Graph API camera types", () => {
  assert.equal(cameraTypeFrom("equirectangular"), "spherical");
  assert.equal(cameraTypeFrom("spherical"), "spherical");
  assert.equal(cameraTypeFrom("fisheye"), "fisheye");
  assert.equal(cameraTypeFrom("brown"), "perspective");
  assert.equal(cameraTypeFrom(undefined), "perspective");
});

test("rt is the identity for a zero pose, rotates with the angle-axis and carries the translation", () => {
  const unit = createImageTransform(meta());
  assertClose(unit.rt, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  const aboutZ = createImageTransform(meta({ rotation: [0, 0, Math.PI] }));
  assertClose([aboutZ.rt[0], aboutZ.rt[5], aboutZ.rt[10]], [-1, -1, 1], 1e-9);
  const moved = createImageTransform(meta(), { translation: [10, 20, 30] });
  assertClose([moved.rt[12], moved.rt[13], moved.rt[14]], [10, 20, 30], 0);
});

test("srt scales the rotation block and the translation by the reconstruction scale", () => {
  const t = createImageTransform(meta({ scale: 2 }), { translation: [1, 2, 3] });
  assertClose([t.srt[0], t.srt[5], t.srt[10]], [2, 2, 2], 0);
  assertClose([t.srt[12], t.srt[13], t.srt[14]], [2, 4, 6], 0);
  assertClose([t.srtInverse[12], t.srtInverse[13], t.srtInverse[14]], [-1, -2, -3], 1e-12);
  assert.equal(createImageTransform(meta({ scale: 0 })).hasValidScale, false, "no scale → flat fallback");
  assert.equal(createImageTransform(meta({ scale: 100 })).hasValidScale, false);
  assert.equal(t.hasValidScale, true);
});

test("basic dimensions follow the EXIF orientation; missing API sizes fall back to the bitmap", () => {
  const landscape = createImageTransform(meta({ width: 1920, height: 1080 }));
  assert.equal(landscape.basicWidth, 1920);
  assert.equal(landscape.basicHeight, 1080);
  assertClose(landscape.scaleX, 1, 0);
  assertClose(landscape.scaleY, 1920 / 1080, 1e-12);
  const portrait = createImageTransform(meta({ width: 1920, height: 1080, orientation: 6 }));
  assert.equal(portrait.basicWidth, 1080);
  assert.equal(portrait.basicHeight, 1920);
  const fallback = createImageTransform(meta({ width: null, height: null }), { bitmapWidth: 640, bitmapHeight: 480 });
  assert.equal(fallback.width, 640);
  assert.equal(fallback.height, 480);
  const rotatedFallback = createImageTransform(meta({ width: null, height: null, orientation: 6 }), { bitmapWidth: 640, bitmapHeight: 480 });
  assert.equal(rotatedFallback.width, 480, "the API width is the unrotated one");
  assert.equal(createImageTransform(meta({ cameraParameters: [] })).focal, 1, "focal fallback");
  assert.equal(createImageTransform(meta({ cameraParameters: [0.85] })).k1, 0, "parameters are zero-padded");
});

test("unprojectSfM returns the optical center at distance 0 and points along the axis", () => {
  const unit = createImageTransform(meta());
  assertClose(unprojectSfM(unit, [0, 0], 0), [0, 0, 0], 1e-12);
  assertClose(unprojectSfM(unit, [0, 0], 10), [0, 0, 10], 1e-12);
  const moved = createImageTransform(meta(), { translation: [10, 20, 30] });
  assertClose(unprojectSfM(moved, [0, 0], 0), [-10, -20, -30], 1e-9, "C = −Rᵀt");
  assertClose(moved.position, [-10, -20, -30], 1e-9);
  // depth = true treats the distance as depth: with unit focal the sfm
  // coordinate is the tangent of the ray.
  assertClose(unprojectSfM(unit, [0.5, -0.25], 10, true), [5, -2.5, 10], 1e-9);
});

test("projectBasic maps the axis to the image center and offsets to the expected quadrant", () => {
  const t = createImageTransform(meta());
  assertClose(projectBasic(t, [0, 0, 10]), [0.5, 0.5], 1e-12);
  // sfm = (0.1, 0.1): basic x = (0.1 + 0.5) = 0.6, basic y = (0.1 + 0.375) · 4/3.
  assertClose(projectBasic(t, [1, 1, 10]), [0.6, (0.1 + 0.375) * (4 / 3)], 1e-9);
  const behind = bearingToSfm(t, [0.1, 0.1, -1]);
  assert.equal(behind[0], Infinity, "points behind the camera project to infinity");
});

test("basic → world → basic round-trips for every camera model and orientation", () => {
  const cases = [
    meta({ cameraParameters: [0.9, -0.1, 0.01] }),
    meta({ cameraParameters: [0.9, -0.1, 0.01], orientation: 6 }),
    meta({ cameraParameters: [0.9, -0.1, 0.01], orientation: 3 }),
    meta({ cameraParameters: [0.9, -0.1, 0.01], orientation: 8, rotation: [0.2, -0.4, 1.1] }),
    meta({ cameraType: "fisheye", cameraParameters: [0.6, 0.05, -0.01], rotation: [0.3, 0.2, 0.1] }),
    meta({ cameraType: "spherical", cameraParameters: [], width: 8, height: 4, rotation: [1, 0, 0.5] }),
  ];
  for (const m of cases) {
    const t = createImageTransform(m, { translation: [3, -2, 1] });
    for (const x of [0.1, 0.35, 0.5, 0.8, 0.95]) {
      for (const y of [0.15, 0.5, 0.9]) {
        const basic = [x, y];
        const world = unprojectBasic(t, basic, 10);
        assertClose(projectBasic(t, world), basic, 1e-6, `${m.cameraType} o${m.orientation} ${basic}`);
      }
    }
  }
});

test("sfmToBearing undistorts: a distorted perspective ray lands back on the undistorted tangent", () => {
  const t = createImageTransform(meta({ cameraParameters: [1, -0.2, 0.05] }));
  const bearing = sfmToBearing(t, [0.3, -0.2]);
  assertClose(bearingToSfm(t, bearing), [0.3, -0.2], 1e-6);
  assertClose(sfmToBearing(t, [0, 0]), [0, 0, 1], 1e-12);
});

test("radialPeakFor finds the monotonic limit and reports none when k2 is zero", () => {
  assert.equal(radialPeakFor(0, 0), null);
  assert.equal(radialPeakFor(-0.1, 0), null, "upstream: k2 = 0 degenerates to NaN roots → no peak");
  assert.equal(radialPeakFor(-0.3, 0.1), null, "negative discriminant");
  const peak = radialPeakFor(-0.5, 0.05);
  assertClose(peak, Math.sqrt((1.5 - Math.sqrt(1.25)) / 0.5), 1e-9);
  const t = createImageTransform(meta({ cameraParameters: [1, -0.5, 0.05] }));
  // Beyond the peak the projection is clamped: the sfm coordinate keeps
  // growing linearly with the tangent instead of folding back.
  const atPeak = bearingToSfm(t, [peak, 0, 1])[0];
  const beyond = bearingToSfm(t, [2 * peak, 0, 1])[0];
  assertClose(beyond, 2 * atPeak, 1e-9);
});

test("verticalFovDegrees fits the image for fill and letterbox modes", () => {
  const square = createImageTransform(meta({ width: 1000, height: 1000 }));
  const corner = 2 * Math.atan(0.5) * (180 / Math.PI);
  assertClose(verticalFovDegrees(square, 1, { mode: "letterbox" }), corner, 1e-6);
  assertClose(verticalFovDegrees(square, 1, { mode: "fill" }), corner * 0.995, 1e-6);
  // A wide viewport needs less vertical fov to be filled by the image's width.
  assertClose(verticalFovDegrees(square, 2, { mode: "fill" }), 2 * Math.atan(0.25) * (180 / Math.PI) * 0.995, 1e-6);
  assertClose(verticalFovDegrees(square, 2, { mode: "letterbox" }), corner, 1e-6);
  const pano = createImageTransform(meta({ cameraType: "spherical", cameraParameters: [] }));
  assertClose(verticalFovDegrees(pano, 1.5), 90, 1e-9);
  assertClose(verticalFovDegrees(pano, 1.5, { zoom: 1 }), 2 * Math.atan(0.5) * (180 / Math.PI), 1e-9);
});

test("synthesizePose makes a level camera facing the compass bearing", () => {
  const east = createImageTransform(meta({ rotation: synthesizePose(90) }));
  assertClose(viewDirection(east), [1, 0, 0], 1e-9);
  assertClose(east.up, [0, 0, 1], 1e-9);
  const north = createImageTransform(meta({ rotation: synthesizePose(0) }));
  assertClose(viewDirection(north), [0, 1, 0], 1e-9);
  // World up maps to the camera's −y (camera y points down).
  assertClose(transformDirection(north.rt, [0, 0, 1]), [0, -1, 0], 1e-9);
});

test("isParallaxPair needs the same merged component and nearby original positions", () => {
  const a = { mergeId: "7", originalLat: 50.0, originalLng: 14.4, lat: 50.0, lng: 14.4 };
  const near = { mergeId: "7", originalLat: 50.0001, originalLng: 14.4, lat: 50.0001, lng: 14.4 };
  assert.equal(isParallaxPair(a, near, 25), true);
  assert.equal(isParallaxPair(a, { ...near, mergeId: "8" }, 25), false);
  assert.equal(isParallaxPair(a, { ...near, mergeId: null }, 25), false);
  assert.equal(isParallaxPair(a, { ...near, originalLat: 50.001 }, 25), false, "111 m apart");
  assert.equal(isParallaxPair(a, null, 25), false);
});
