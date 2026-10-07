import assert from "node:assert/strict";
import test from "node:test";

import { createImageTransform, unprojectSfM } from "../app/street-view/sfm-camera.mjs";
import {
  countVerticesOutsidePhoto,
  decodeMeshPbf,
  flatPlaneGeometry,
  flatSphereGeometry,
  geometryForImage,
  meshWorldPositions,
} from "../app/street-view/sfm-mesh.mjs";

function assertClose(actual, expected, tolerance = 1e-5, message = "") {
  assert.equal(actual.length, expected.length, `${message} length`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${message} [${i}]: ${actual[i]} vs ${expected[i]}`);
  }
}

// --- protobuf encoding helpers (the inverse of what the decoder reads) ----

function varint(value) {
  const out = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function float32(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...new Uint8Array(buffer)];
}

const VERTICES = [-0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, 0.5, 1, 1, 0, 300, 0.2, 0.1, 0.001];
const FACES = [0, 1, 2, 0, 2, 3, 1, 4, 5];

function encodeUnpacked() {
  const bytes = [];
  for (const v of VERTICES) bytes.push(...varint((1 << 3) | 5), ...float32(v));
  for (const f of FACES) bytes.push(...varint((2 << 3) | 0), ...varint(f));
  return Uint8Array.from(bytes).buffer;
}

function encodePacked() {
  const vertexBytes = VERTICES.flatMap(float32);
  const faceBytes = FACES.flatMap(varint);
  return Uint8Array.from([
    ...varint((1 << 3) | 2), ...varint(vertexBytes.length), ...vertexBytes,
    ...varint((2 << 3) | 2), ...varint(faceBytes.length), ...faceBytes,
    // An unknown 64-bit field and an unknown varint field are skipped.
    ...varint((9 << 3) | 1), 0, 0, 0, 0, 0, 0, 0, 0,
    ...varint((10 << 3) | 0), ...varint(300),
  ]).buffer;
}

test("decodeMeshPbf reads tagged vertex floats and face varints, packed or not", () => {
  for (const buffer of [encodeUnpacked(), encodePacked()]) {
    const mesh = decodeMeshPbf(buffer);
    assert.ok(mesh.vertices instanceof Float32Array);
    assert.ok(mesh.faces instanceof Uint16Array);
    assertClose(mesh.vertices, VERTICES, 1e-7);
    assert.deepEqual([...mesh.faces], FACES);
  }
  assert.throws(() => decodeMeshPbf(Uint8Array.from([(1 << 3) | 5, 0, 0]).buffer), /Truncated/);
});

const mesh = { vertices: Float32Array.from(VERTICES), faces: Uint16Array.from(FACES) };

function meta(overrides = {}) {
  return { orientation: 1, width: 4, height: 3, scale: 1, rotation: [0, 0, 0], cameraParameters: [1, 0, 0], cameraType: "perspective", ...overrides };
}

test("meshWorldPositions clamps perspective meshes in depth and widens the four corner vertices", () => {
  const t = createImageTransform(meta());
  const positions = meshWorldPositions(mesh, t, { planeDepth: 200, minDepth: 5, marginFactor: 3 });
  // Corners: x,y ×3 then z pushed from 1 m out to the 5 m minimum (factor 5).
  assertClose(positions.subarray(0, 3), [-7.5, -7.5, 5]);
  assertClose(positions.subarray(6, 9), [7.5, 7.5, 5]);
  // Far vertex at 300 m pulled in to the 200 m plane, keeping its ray.
  assertClose(positions.subarray(12, 15), [200 / 300, 0, 200], 1e-4);
  // Nearly-at-camera vertex pushed out to 5 m along its ray.
  assertClose(positions.subarray(15, 18), [0.2 * 5000, 0.1 * 5000, 5], 1e-3);
});

test("meshWorldPositions undoes the reconstruction scale and the pose", () => {
  // Scale 2: the same mesh units mean half the meters, so everything lands
  // at the same clamped world positions as scale 1 once mapped back.
  const scaled = createImageTransform(meta({ scale: 2 }));
  const positions = meshWorldPositions(mesh, scaled);
  assertClose(positions.subarray(0, 3), [-7.5, -7.5, 5]);
  // A camera turned to face +x (rotation −90° about y, world→camera): the
  // forward axis lands on world +x.
  const turned = createImageTransform(meta({ rotation: [0, -Math.PI / 2, 0] }));
  const far = meshWorldPositions(mesh, turned).subarray(12, 15);
  assert.ok(Math.abs(far[0] - 200) < 1e-3, `forward maps to +x, got ${[...far]}`);
});

test("meshWorldPositions clamps spherical and fisheye meshes radially", () => {
  const pano = createImageTransform(meta({ cameraType: "spherical", cameraParameters: [] }));
  const positions = meshWorldPositions(mesh, pano, { sphereRadius: 100, minDepth: 5 });
  const radius = (i) => Math.hypot(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  assert.ok(Math.abs(radius(0) - 5) < 1e-4, "near vertex pushed out to 5 m");
  assert.ok(Math.abs(radius(4) - 100) < 1e-3, "far vertex pulled in to the sphere radius");
  // Corners are not widened for non-perspective meshes.
  assert.ok(Math.abs(positions[0] / positions[2] - (-0.5)) < 1e-6);
});

test("flatPlaneGeometry puts the image corners at the far distance along their rays", () => {
  const t = createImageTransform(meta(), { translation: [0, 0, -10] });
  const plane = flatPlaneGeometry(t, 200);
  assert.deepEqual([...plane.indices], [0, 1, 3, 1, 2, 3]);
  for (let i = 0; i < 4; i += 1) {
    const p = [plane.positions[3 * i], plane.positions[3 * i + 1], plane.positions[3 * i + 2]];
    const fromCamera = [p[0] - t.position[0], p[1] - t.position[1], p[2] - t.position[2]];
    assert.ok(Math.abs(Math.hypot(...fromCamera) - 200) < 1e-3, `corner ${i} at 200 m`);
    assert.ok(fromCamera[2] > 0, "in front of the camera");
  }
  const sphere = flatSphereGeometry(t, 50, 4, 3);
  assert.equal(sphere.positions.length / 3, (4 + 1) * (3 + 1));
  for (let i = 0; i < sphere.positions.length; i += 3) {
    const r = Math.hypot(sphere.positions[i] - t.position[0], sphere.positions[i + 1] - t.position[1], sphere.positions[i + 2] - t.position[2]);
    assert.ok(Math.abs(r - 50) < 1e-3);
  }
  assert.equal(sphere.indices.length, (4 * 3 * 2 - 4 * 2) * 3, "poles have one triangle per segment");
});

test("geometryForImage uses the mesh when it exists and the scale is valid, else the flat fallback", () => {
  const valid = createImageTransform(meta());
  assert.equal(geometryForImage(mesh, valid).kind, "mesh");
  assert.equal(geometryForImage({ vertices: new Float32Array(0), faces: new Uint16Array(0) }, valid).kind, "flat");
  assert.equal(geometryForImage(mesh, createImageTransform(meta({ scale: null }))).kind, "flat");
  assert.equal(geometryForImage(null, valid).positions.length, 12, "plane for perspective");
  const pano = createImageTransform(meta({ cameraType: "spherical", cameraParameters: [] }));
  assert.equal(geometryForImage(null, pano).positions.length / 3, 21 * 41, "sphere for 360°");
});

test("countVerticesOutsidePhoto is zero for an image's own mesh and counts strays", () => {
  const t = createImageTransform(meta({ rotation: [0.2, -0.3, 0.1], cameraParameters: [0.9, -0.05, 0.01] }), { translation: [1, 2, 3] });
  const inside = { vertices: Float32Array.from([-0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, 0.5, 1, 0.1, 0.1, 2, -0.2, 0.15, 30, 0.3, -0.2, 8]), faces: Uint16Array.from([0, 1, 2]) };
  const positions = meshWorldPositions(inside, t);
  assert.equal(countVerticesOutsidePhoto(positions, t), 0);
  // A vertex behind the camera projects to infinity.
  const behind = Float32Array.from([...positions, ...unprojectSfM(t, [0, 0], -5)]);
  assert.equal(countVerticesOutsidePhoto(behind, t), 1);
});
