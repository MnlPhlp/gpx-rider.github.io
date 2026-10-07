import assert from "node:assert/strict";
import test from "node:test";

import {
  catmullRom,
  enuToGeodetic,
  geodeticToEcef,
  geodeticToEnu,
  mat4FromRows,
  mat4Identity,
  mat4Invert,
  mat4LookAtView,
  mat4Multiply,
  mat4Perspective,
  mat4Translation,
  rodrigues,
  rotationToAngleAxis,
  transformDirection,
  transformPoint,
  vec3Normalize,
} from "../app/street-view/sfm-math.mjs";

const WGS84A = 6378137;
const WGS84B = 6356752.31424518;

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

test("geodeticToEcef maps the equator/Greenwich point to the X axis and the pole to the Z axis", () => {
  assertClose(geodeticToEcef(0, 0, 0), [WGS84A, 0, 0], 1e-6);
  assertClose(geodeticToEcef(90, 0, 0), [0, WGS84A, 0], 1e-6);
  assertClose(geodeticToEcef(0, 90, 0), [0, 0, WGS84B], 1e-6);
});

test("geodeticToEnu is zero at the reference, up for altitude, and round-trips", () => {
  const ref = { lng: 133.34589734, lat: 12.9450823, alt: 12.52389239 };
  assertClose(geodeticToEnu(ref.lng, ref.lat, ref.alt, ref.lng, ref.lat, ref.alt), [0, 0, 0], 1e-8);
  assertClose(geodeticToEnu(ref.lng, ref.lat, ref.alt + 7.5, ref.lng, ref.lat, ref.alt), [0, 0, 7.5], 1e-6);
  // 0.001° north at 50° latitude ≈ 111.2 m north, nothing east.
  const north = geodeticToEnu(14.4, 50.001, 300, 14.4, 50.0, 300);
  assertClose(north[0], 0, 1e-6);
  assertClose(north[1], 111.2, 0.2);
  assert.ok(Math.abs(north[2]) < 0.01, "curvature drop over 111 m is negligible");
  const back = enuToGeodetic(north[0], north[1], north[2], 14.4, 50.0, 300);
  assertClose(back, [14.4, 50.001, 300], 1e-7);
});

test("rodrigues matches the viewer's rotation matrices (column-major)", () => {
  assertClose(rodrigues([0, 0, 0]), mat4Identity(), 0);
  const aboutZ = rodrigues([0, 0, Math.PI]);
  assertClose([aboutZ[0], aboutZ[5], aboutZ[10]], [-1, -1, 1], 1e-9);
  assert.ok(Math.abs(aboutZ[1]) < 1e-9 && Math.abs(aboutZ[4]) < 1e-9);
  const aboutX = rodrigues([Math.PI / 2, 0, 0]);
  assertClose([aboutX[0], aboutX[5], aboutX[6], aboutX[9], aboutX[10]], [1, 0, 1, -1, 0], 1e-9);
});

test("rotationToAngleAxis inverts rodrigues, including near 180°", () => {
  for (const v of [[0.3, -0.2, 0.9], [0, 0, 1.2], [Math.PI, 0, 0], [0, Math.PI, 0], [0.5, 0.5, 0.5], [0, 0, 0]]) {
    const back = rotationToAngleAxis(rodrigues(v));
    // An angle-axis and its 2π-complement describe the same rotation; compare matrices.
    assertClose(rodrigues(back), rodrigues(v), 1e-9, `rotation ${v}`);
  }
});

test("mat4 helpers: multiply, invert, translation, transformPoint/Direction", () => {
  const t = mat4Translation([1, 2, 3]);
  const r = rodrigues([0, 0, Math.PI / 2]);
  const m = mat4Multiply(t, r);
  // Rotate (1,0,0) about z by 90° → (0,1,0), then translate.
  assertClose(transformPoint(m, [1, 0, 0]), [1, 3, 3], 1e-9);
  assertClose(transformDirection(m, [1, 0, 0]), [0, 1, 0], 1e-9, "directions ignore translation");
  assertClose(mat4Multiply(mat4Invert(m), m), mat4Identity(), 1e-9);
  const rowMajor = mat4FromRows(
    1, 2, 3, 4,
    5, 6, 7, 8,
    9, 10, 11, 12,
    0, 0, 0, 1,
  );
  assert.equal(rowMajor[4], 2, "second column, first row");
  assert.equal(rowMajor[12], 4, "translation x");
});

test("mat4LookAtView builds an OpenGL view matrix (camera looks down −z)", () => {
  const identityView = mat4LookAtView([0, 0, 0], [0, 0, -10], [0, 1, 0]);
  assertClose(identityView, mat4Identity(), 1e-9);
  // Camera at (1, 2, 3) looking east (+x) with z up: a point 5 m east of it
  // ends up 5 m in front (−z), and a point above it ends up at +y.
  const view = mat4LookAtView([1, 2, 3], [11, 2, 3], [0, 0, 1]);
  assertClose(transformPoint(view, [6, 2, 3]), [0, 0, -5], 1e-9);
  assertClose(transformPoint(view, [1, 2, 4]), [0, 1, 0], 1e-9);
});

test("mat4Perspective maps the near plane to −1 and the far plane to +1", () => {
  const p = mat4Perspective(60, 2, 0.1, 100);
  assertClose(transformPoint(p, [0, 0, -0.1])[2], -1, 1e-9);
  assertClose(transformPoint(p, [0, 0, -100])[2], 1, 1e-6);
  // A point on the top edge of the frustum at depth 1 projects to y = 1.
  const halfHeight = Math.tan((60 / 2) * (Math.PI / 180));
  assertClose(transformPoint(p, [0, halfHeight, -1])[1], 1, 1e-9);
  assertClose(transformPoint(p, [2 * halfHeight, 0, -1])[0], 1, 1e-9, "aspect widens x");
});

test("catmullRom passes through its inner control points", () => {
  const p0 = [0, 0, 0];
  const p1 = [1, 1, 0];
  const p2 = [2, 0, 0];
  const p3 = [3, 1, 0];
  assertClose(catmullRom(p0, p1, p2, p3, 0), p1, 1e-12);
  assertClose(catmullRom(p0, p1, p2, p3, 1), p2, 1e-12);
  const mid = catmullRom(p0, p1, p2, p3, 0.5);
  assert.ok(mid[0] > 1 && mid[0] < 2);
  assertClose(vec3Normalize([3, 0, 4]), [0.6, 0, 0.8], 1e-12);
});
