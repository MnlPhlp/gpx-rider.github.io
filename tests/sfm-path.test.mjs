import assert from "node:assert/strict";
import test from "node:test";

import { bearingDirection, cameraAlongLink } from "../app/street-view/sfm-path.mjs";

function assertClose(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${actual} vs ${expected}`);
}

const a = { position: [0, 0, 0], direction: [0, 1, 0], up: [0, 0, 1], fov: 40 };
const b = { position: [0, 10, 0], direction: [1, 0, 0], up: [0, 0, 1], fov: 50 };

test("bearingDirection points east at 90° and north at 0°", () => {
  assertClose(bearingDirection(90), [1, 0, 0]);
  assertClose(bearingDirection(0), [0, 1, 0]);
  assertClose(bearingDirection(undefined), [0, 1, 0]);
});

test("cameraAlongLink interpolates linearly and hits both ends", () => {
  const start = cameraAlongLink(a, b, 0);
  assertClose(start.eye, a.position);
  assertClose(start.direction, a.direction);
  assert.equal(start.fov, 40);
  const end = cameraAlongLink(a, b, 1);
  assertClose(end.eye, b.position);
  assertClose(end.direction, b.direction);
  assert.equal(end.fov, 50);
  const mid = cameraAlongLink(a, b, 0.5);
  assertClose(mid.eye, [0, 5, 0]);
  assertClose(mid.direction, [Math.SQRT1_2, Math.SQRT1_2, 0]);
  assert.equal(mid.fov, 45);
});

test("cameraAlongLink's Catmull-Rom path still passes through the photos and bends with neighbors", () => {
  const before = { position: [0, -10, 0], direction: [0, 1, 0], up: [0, 0, 1], fov: 40 };
  const after = { position: [10, 10, 0], direction: [1, 0, 0], up: [0, 0, 1], fov: 50 };
  const options = { smoothing: "catmull", before, after };
  assertClose(cameraAlongLink(a, b, 0, options).eye, a.position);
  assertClose(cameraAlongLink(a, b, 1, options).eye, b.position);
  const mid = cameraAlongLink(a, b, 0.5, options);
  assert.ok(mid.eye[0] !== 0 && Math.abs(mid.eye[0]) < 2, "leaves the straight chord to bend with the neighbors");
  assert.ok(Math.abs(mid.eye[1] - 5) < 1, "stays near the midpoint along the link");
  assert.ok(Math.abs(Math.hypot(...mid.direction) - 1) < 1e-9, "direction stays unit length");
  // Without neighbors the spline degenerates to the straight path.
  assertClose(cameraAlongLink(a, b, 0.5, { smoothing: "catmull" }).eye, [0, 5, 0]);
});
