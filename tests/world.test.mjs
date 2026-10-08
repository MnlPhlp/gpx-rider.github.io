import assert from "node:assert/strict";
import test from "node:test";

import { VIRTUAL_WORLD } from "../app/core/tuning.mjs";
import { cellRandom, createNoise2D, fbm, ridged, seedFromString } from "../app/world/world-noise.mjs";
import { createSurface, hexToLinear } from "../app/world/world-surface.mjs";
import { createWorldProjection, createWorldTerrain, resampleRouteLocal } from "../app/world/world-terrain.mjs";
import {
  baseNodes,
  buildTileArrays,
  createQuadtree,
  resolveDisplay,
  selectLeaves,
} from "../app/world/world-tiles.mjs";

// A climb heading north-east: 4 km, 0 → 320 m gain.
function climbRoute() {
  const points = [];
  for (let i = 0; i <= 40; i++) {
    points.push({ lat: 46.5 + i * 0.0006, lng: 8.0 + i * 0.0008, ele: 600 + i * 8 });
  }
  return points;
}

// Two parallel legs 60 m apart joined by a hairpin: the lower one at 1000 m,
// the upper one at 1030 m.
function switchbackRoute() {
  const dLat = 60 / 111195;
  const points = [];
  for (let i = 0; i <= 20; i++) points.push({ lat: 46.5, lng: 8.0 + i * 0.0005, ele: 1000 + i * 0.75 });
  for (let i = 20; i >= 0; i--) points.push({ lat: 46.5 + dLat, lng: 8.0 + i * 0.0005, ele: 1030 - i * 0.75 + 15 });
  return points;
}

test("noise is deterministic per seed and stays in range", () => {
  const a = createNoise2D(42);
  const b = createNoise2D(42);
  const c = createNoise2D(43);
  let differs = false;
  for (let i = 0; i < 200; i++) {
    const x = i * 0.37;
    const y = i * -0.61;
    assert.equal(a(x, y), b(x, y));
    if (a(x, y) !== c(x, y)) differs = true;
    const value = fbm(a, x, y, 5);
    assert.ok(value >= -1 && value <= 1, `fbm ${value} in [-1, 1]`);
    const ridge = ridged(a, x, y, 5);
    assert.ok(ridge >= 0 && ridge <= 1, `ridged ${ridge} in [0, 1]`);
  }
  assert.ok(differs, "a different seed gives a different field");
  assert.equal(seedFromString("abc"), seedFromString("abc"));
  const r = cellRandom(7, 3, -4, 1);
  assert.ok(r >= 0 && r < 1);
  assert.equal(r, cellRandom(7, 3, -4, 1));
  assert.notEqual(r, cellRandom(7, 3, -4, 2));
});

test("projection round-trips and puts north at -z and east at +x", () => {
  const projection = createWorldProjection({ lat: 46.5, lng: 8 });
  const north = projection.toLocal(46.51, 8);
  const east = projection.toLocal(46.5, 8.01);
  assert.ok(north.z < -1000 && Math.abs(north.x) < 1e-6);
  assert.ok(east.x > 700 && Math.abs(east.z) < 1e-6);
  const back = projection.toGeo(north.x, north.z);
  assert.ok(Math.abs(back.lat - 46.51) < 1e-9 && Math.abs(back.lng - 8) < 1e-9);
});

test("resampleRouteLocal keeps every sample within the spacing", () => {
  const route = climbRoute();
  const projection = createWorldProjection(route[0]);
  const samples = resampleRouteLocal(route, projection, 20);
  for (let i = 1; i < samples.length; i++) {
    const gap = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    assert.ok(gap <= 20.0001, `gap ${gap}`);
  }
  assert.equal(samples[0].e, 600);
  assert.equal(samples.at(-1).e, 920);
});

test("the road sits exactly at the GPX elevation", () => {
  const route = climbRoute();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  for (const point of route) {
    const height = terrain.heightAtGeo(point.lat, point.lng);
    assert.ok(Math.abs(height - point.ele) < 0.5, `road at ${height}, GPX ${point.ele}`);
  }
  // Midway between two GPX points it follows the interpolated grade.
  const mid = { lat: (route[10].lat + route[11].lat) / 2, lng: (route[10].lng + route[11].lng) / 2 };
  assert.ok(Math.abs(terrain.heightAtGeo(mid.lat, mid.lng) - (route[10].ele + route[11].ele) / 2) < 0.5);
});

test("switchback legs blend into a slope instead of a cliff", () => {
  const route = switchbackRoute();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const { projection } = terrain;
  const lower = projection.toLocal(46.5, 8.005);
  const upper = projection.toLocal(46.5 + 60 / 111195, 8.005);
  let previous = terrain.heightAt(lower.x, lower.z);
  let maxStep = 0;
  for (let k = 1; k <= 60; k++) {
    const z = lower.z + ((upper.z - lower.z) * k) / 60;
    const height = terrain.heightAt(lower.x, z);
    maxStep = Math.max(maxStep, Math.abs(height - previous));
    previous = height;
  }
  const rise = terrain.heightAt(upper.x, upper.z) - terrain.heightAt(lower.x, lower.z);
  assert.ok(rise > 20, `upper leg is higher (${rise})`);
  // 1 m steps across ~30 m of height: no single meter carries the whole rise.
  assert.ok(maxStep < rise * 0.35, `largest 1 m step ${maxStep} of ${rise}`);
});

test("relief grows away from the road and the terrain is deterministic", () => {
  const route = climbRoute();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const again = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const near = terrain.sample(0, 5, {});
  const far = terrain.sample(5000, -5000, {});
  assert.ok(far.roadDistance > near.roadDistance);
  assert.ok(far.amplitude > near.amplitude);
  assert.equal(terrain.heightAt(1234, -987), again.heightAt(1234, -987));
  assert.ok(Number.isFinite(terrain.heightAt(1e6, 1e6)), "finite far outside the world");
  assert.ok(terrain.waterLevel < terrain.minElevation);
});

test("an empty route still builds a world", () => {
  const terrain = createWorldTerrain([], VIRTUAL_WORLD.terrain);
  assert.ok(Number.isFinite(terrain.heightAt(0, 0)));
  assert.ok(terrain.bounds.maxX > terrain.bounds.minX);
});

test("quadtree refines near the camera and resolves fallbacks without overlap", () => {
  const tree = createQuadtree({ minX: -8000, maxX: 8000, minZ: -8000, maxZ: 8000 }, 200);
  const leaves = selectLeaves(tree, { x: 0, z: 0, heightAboveGround: 10 }, { splitFactor: 2 });
  const finest = Math.max(...leaves.map((leaf) => leaf.level));
  assert.equal(finest, tree.maxLevel);
  const nearest = leaves.reduce((a, b) => (a.distance < b.distance ? a : b));
  const farthest = leaves.reduce((a, b) => (a.distance > b.distance ? a : b));
  assert.ok(nearest.size < farthest.size, "smaller tiles near the camera");
  // Leaves tile the root exactly.
  const area = leaves.reduce((sum, leaf) => sum + leaf.size * leaf.size, 0);
  assert.ok(Math.abs(area - tree.size * tree.size) < 1e-3);

  // Nothing ready: nothing drawn. Only the base ready: the base level drawn.
  assert.deepEqual(resolveDisplay(tree, leaves, () => false), []);
  const base = new Set(baseNodes(tree, 1).map((node) => node.key));
  const fallback = resolveDisplay(tree, leaves, (key) => base.has(key));
  const fallbackArea = fallback.reduce((sum, node) => sum + node.size * node.size, 0);
  assert.ok(Math.abs(fallbackArea - tree.size * tree.size) < 1e-3, "fallback covers the root once");
  // Everything ready: exactly the leaves.
  assert.equal(resolveDisplay(tree, leaves, () => true).length, leaves.length);
});

test("tile arrays line up with the height field and carry skirts and trees", () => {
  const route = climbRoute();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const surface = createSurface(terrain, VIRTUAL_WORLD.surface);
  const rect = { x0: -200, z0: -200, size: 400 };
  const segments = 16;
  const tile = buildTileArrays(terrain, surface, rect, { segments, skirtFactor: 3, treeMaxTileMeters: 400 });
  const vertices = (segments + 1) ** 2 + 4 * (segments + 1);
  assert.equal(tile.positions.length, vertices * 3);
  assert.equal(tile.indices.length, (2 * segments * segments + 16 * segments) * 3);
  assert.ok(tile.indices.every((index) => index < vertices));
  // Vertex (r=3, c=5) sits on the field.
  const v = 3 * (segments + 1) + 5;
  const x = tile.positions[v * 3] + tile.cx;
  const z = tile.positions[v * 3 + 2] + tile.cz;
  assert.ok(Math.abs(tile.positions[v * 3 + 1] - terrain.heightAt(x, z)) < 1e-3);
  // Normals are unit length and point up.
  for (let k = 0; k < (segments + 1) ** 2; k++) {
    const [nx, ny, nz] = [tile.normals[k * 3], tile.normals[k * 3 + 1], tile.normals[k * 3 + 2]];
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5 && ny > 0);
  }
  // Trees keep clear of the road.
  for (let k = 0; k < tile.trees.length / 6; k++) {
    const sample = terrain.sample(tile.trees[k * 6] + tile.cx, tile.trees[k * 6 + 2] + tile.cz, {});
    assert.ok(sample.roadDistance >= VIRTUAL_WORLD.surface.trees.road_clearance_meters);
  }
});

test("hexToLinear converts sRGB to linear", () => {
  assert.deepEqual(hexToLinear("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToLinear("#ffffff"), [1, 1, 1]);
  const [r] = hexToLinear("#808080");
  assert.ok(Math.abs(r - 0.2159) < 1e-3);
});
