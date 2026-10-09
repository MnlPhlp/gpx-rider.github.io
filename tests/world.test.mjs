import assert from "node:assert/strict";
import test from "node:test";

import { VIRTUAL_WORLD } from "../app/core/tuning.mjs";
import { cellRandom, createNoise2D, fbm, ridged, seedFromString } from "../app/world/world-noise.mjs";
import { createSurface, hexToLinear } from "../app/world/world-surface.mjs";
import {
  buildRoadArrays,
  catmullRomPolyline,
  createRoadTrack,
  crossSectionFrames,
  simplifyPolyline,
  smoothPolyline,
} from "../app/world/world-road.mjs";
import { createWorldProjection, createWorldTerrain, resampleRouteLocal } from "../app/world/world-terrain.mjs";
import { createDem, demTilesForBox, globalPixel } from "../app/world/world-dem.mjs";
import { tileForLngLat } from "../app/map/terrain-tiles-math.mjs";
import { BUILDING_STRIDE, createCity } from "../app/world/world-city.mjs";
import {
  baseNodes,
  buildTileArrays,
  createQuadtree,
  nodeKey,
  protectedAncestors,
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

test("a tile still building is covered by its loaded children, never by a far coarser ancestor", () => {
  const tree = createQuadtree({ minX: -8000, maxX: 8000, minZ: -8000, maxZ: 8000 }, 200);
  // The camera moved away: level-3 tiles are wanted where their level-4
  // children were drawn a moment ago. One level-3 tile isn't built yet.
  const leaves = selectLeaves(tree, { x: 0, z: 0, heightAboveGround: 10 }, { splitFactor: 2 });
  const missing = leaves.find((leaf) => leaf.level === 3);
  assert.ok(missing, "a level-3 leaf");
  const childKeys = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([di, dj]) => nodeKey(4, missing.i * 2 + di, missing.j * 2 + dj));
  const ready = new Set([...leaves.map((leaf) => leaf.key).filter((key) => key !== missing.key), ...childKeys, ...baseNodes(tree, 1).map((n) => n.key)]);
  const display = resolveDisplay(tree, leaves, (key) => ready.has(key));
  const keys = new Set(display.map((node) => node.key));
  for (const key of childKeys) assert.ok(keys.has(key), `child ${key} drawn`);
  // Everything else exactly as wanted, and the root covered once.
  assert.equal(display.length, leaves.length - 1 + 4);
  const area = display.reduce((sum, node) => sum + node.size * node.size, 0);
  assert.ok(Math.abs(area - tree.size * tree.size) < 1e-3);
});

test("protectedAncestors keeps every displayed tile's fallback chain", () => {
  const tree = createQuadtree({ minX: -8000, maxX: 8000, minZ: -8000, maxZ: 8000 }, 200);
  const leaves = selectLeaves(tree, { x: 0, z: 0, heightAboveGround: 10 }, { splitFactor: 2 });
  const keep = protectedAncestors(leaves);
  for (const leaf of leaves) {
    for (let level = leaf.level - 1, i = leaf.i >> 1, j = leaf.j >> 1; level >= 0; level--, i >>= 1, j >>= 1) {
      assert.ok(keep.has(nodeKey(level, i, j)));
    }
  }
});

test("hexToLinear converts sRGB to linear", () => {
  assert.deepEqual(hexToLinear("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToLinear("#ffffff"), [1, 1, 1]);
  const [r] = hexToLinear("#808080");
  assert.ok(Math.abs(r - 0.2159) < 1e-3);
});

// A right-angle corner: 200 m east, then 200 m north, flat at 500 m.
function cornerRoute() {
  const dLat = 1 / 111195;
  const dLng = 1 / (111195 * Math.cos(46.5 * Math.PI / 180));
  return [
    { lat: 46.5, lng: 8, ele: 500 },
    { lat: 46.5, lng: 8 + 200 * dLng, ele: 500 },
    { lat: 46.5 + 200 * dLat, lng: 8 + 200 * dLng, ele: 500 },
  ];
}

function maxTurnPerMeter(line) {
  let worst = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const a = Math.atan2(line[i].z - line[i - 1].z, line[i].x - line[i - 1].x);
    const b = Math.atan2(line[i + 1].z - line[i].z, line[i + 1].x - line[i].x);
    let turn = Math.abs(b - a);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    worst = Math.max(worst, turn / Math.hypot(line[i + 1].x - line[i].x, line[i + 1].z - line[i].z));
  }
  return worst;
}

test("smoothPolyline rounds a corner, keeps the ends and leaves straights alone", () => {
  const projection = createWorldProjection({ lat: 46.5, lng: 8 });
  const dense = resampleRouteLocal(cornerRoute(), projection, 3);
  const smooth = smoothPolyline(dense, 2);
  assert.equal(smooth.length, dense.length);
  for (const [a, b] of [[smooth[0], dense[0]], [smooth.at(-1), dense.at(-1)]]) {
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z, a.e - b.e) < 1e-9, "endpoints stay put");
  }
  // A sharp 90° corner turns all at once; the smoothed one spreads it out.
  // A sharp 90° corner turns all at once (~0.5 rad/m at 3 m spacing); the
  // smoothed one spreads it over the bend.
  assert.ok(maxTurnPerMeter(dense) > 0.5);
  assert.ok(maxTurnPerMeter(smooth) < 0.2, "bend is rounded");
  // Far from the corner the line is untouched.
  const middle = Math.floor(dense.length / 4);
  assert.ok(Math.hypot(smooth[middle].x - dense[middle].x, smooth[middle].z - dense[middle].z) < 1e-6);
});

test("simplifyPolyline stays within tolerance and caps segment length", () => {
  const projection = createWorldProjection({ lat: 46.5, lng: 8 });
  const smooth = smoothPolyline(resampleRouteLocal(cornerRoute(), projection, 3), 2);
  const simple = simplifyPolyline(smooth, 0.15, 20);
  assert.ok(simple.length < smooth.length / 2, `${simple.length} of ${smooth.length} kept`);
  for (let i = 1; i < simple.length; i++) {
    assert.ok(Math.hypot(simple[i].x - simple[i - 1].x, simple[i].z - simple[i - 1].z) <= 20.0001);
  }
  for (const p of smooth) {
    let nearest = Infinity;
    for (let i = 1; i < simple.length; i++) {
      const a = simple[i - 1];
      const b = simple[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      nearest = Math.min(nearest, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
    }
    assert.ok(nearest <= 0.15 + 1e-6, `centerline point ${nearest} m off`);
  }
});

test("the flat road bed lies under the whole smoothed road", () => {
  const terrain = createWorldTerrain(climbRoute(), VIRTUAL_WORLD.terrain);
  const half = VIRTUAL_WORLD.scene.road_width_meters / 2;
  const line = terrain.centerline;
  for (let i = 1; i < line.length - 1; i += 7) {
    const tx = line[i + 1].x - line[i - 1].x;
    const tz = line[i + 1].z - line[i - 1].z;
    const length = Math.hypot(tx, tz);
    for (const side of [-half, 0, half]) {
      const x = line[i].x - (tz / length) * side;
      const z = line[i].z + (tx / length) * side;
      const ground = terrain.heightAt(x, z);
      assert.ok(Math.abs(ground - line[i].e) < 0.1, `ground ${ground} vs road ${line[i].e} at offset ${side}`);
    }
  }
});

// A 180° hairpin with a 6 m apex radius: up a leg, round the bend, back down
// a parallel leg 12 m away.
function hairpinLocal() {
  const points = [];
  for (let i = 0; i <= 10; i++) points.push({ x: 0, z: -i * 10, e: 1000 + i });
  for (let k = 1; k < 8; k++) {
    const a = Math.PI - (k / 8) * Math.PI;
    points.push({ x: 6 + 6 * Math.cos(a), z: -100 - 6 * Math.sin(a), e: 1010 + k * 0.5 });
  }
  for (let i = 10; i >= 0; i--) points.push({ x: 12, z: -i * 10, e: 1014 + (10 - i) });
  return points;
}

test("catmullRomPolyline passes through every input point and rounds the corners", () => {
  const projection = createWorldProjection({ lat: 46.5, lng: 8 });
  const corner = resampleRouteLocal(cornerRoute(), projection, Infinity);
  const curve = catmullRomPolyline(corner, 2);
  for (const p of corner) {
    assert.ok(curve.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1e-6), "input point kept");
  }
  for (let i = 1; i < curve.length; i++) {
    // Even in the spline parameter, so allow a little slack in arc length.
    assert.ok(Math.hypot(curve[i].x - curve[i - 1].x, curve[i].z - curve[i - 1].z) <= 2.5);
  }
  // A spline through a hairpin keeps its apex (no inward pull).
  const hairpin = hairpinLocal();
  const smooth = catmullRomPolyline(hairpin, 2);
  const apex = hairpin[14];
  assert.ok(smooth.some((q) => Math.hypot(q.x - apex.x, q.z - apex.z) < 1e-6));
});

test("road cross-sections never fold on a tight hairpin", () => {
  const centerline = catmullRomPolyline(hairpinLocal(), 2);
  const arrays = buildRoadArrays(centerline, {
    lift: 0.25,
    columns: [[4.5, -2.5, 0], [2.5, 0, 0], [2.5, 0, 1], [-2.5, 0, 1], [-2.5, 0, 0], [-4.5, -2.5, 0]],
  });
  const width = 6;
  const frames = crossSectionFrames(centerline);
  // Each column's edge must keep moving forward along the road (a fold runs
  // an edge backward).
  for (let c = 0; c < width; c++) {
    for (let i = 1; i < centerline.length - 1; i++) {
      const v0 = ((i - 1) * width + c) * 3;
      const v1 = (i * width + c) * 3;
      const dx = arrays.positions[v1] - arrays.positions[v0];
      const dz = arrays.positions[v1 + 2] - arrays.positions[v0 + 2];
      const tx = centerline[i + 1].x - centerline[i - 1].x;
      const tz = centerline[i + 1].z - centerline[i - 1].z;
      assert.ok(dx * tx + dz * tz >= -1e-6, `column ${c} folds at ${i}`);
    }
  }
  assert.ok(frames.some((f) => Number.isFinite(f.maxLeft) || Number.isFinite(f.maxRight)), "the bend is clamped");
});

// Fake Terrarium tiles whose elevation is a plane in global pixel space:
// elevation = 0.5·gx + 0.25·gy (meters), so bilinear sampling is exact.
function planeTiles(box, zoom) {
  return demTilesForBox(box, { maxZoom: zoom, maxTiles: 64, tileSize: 16 }).map((tile) => {
    const data = new Float32Array(16 * 16);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        data[py * 16 + px] = 0.5 * (tile.x * 16 + px + 0.5) + 0.25 * (tile.y * 16 + py + 0.5);
      }
    }
    return { ...tile, size: 16, data };
  });
}

test("globalPixel agrees with the online-terrain tile math", () => {
  const p = globalPixel(50.7333, 15.0075, 12, 256);
  const tile = tileForLngLat(50.7333, 15.0075, 12, 256);
  assert.equal(Math.floor(p.x / 256), tile.x);
  assert.equal(Math.floor(p.y / 256), tile.y);
  assert.equal(Math.floor(p.x) - tile.x * 256, tile.px);
});

test("demTilesForBox picks the finest zoom within the tile budget", () => {
  const box = { south: 46.4, west: 10.3, north: 46.6, east: 10.6 };
  const tiles = demTilesForBox(box, { maxZoom: 14, maxTiles: 20, tileSize: 256 });
  assert.ok(tiles.length <= 20 && tiles.length > 0);
  const zoom = tiles[0].z;
  assert.ok(tiles.every((tile) => tile.z === zoom));
  const finer = demTilesForBox(box, { maxZoom: zoom + 1, maxTiles: 1e6, tileSize: 256 });
  assert.ok(finer.length > 20, "one zoom finer would exceed the budget");
});

test("createDem interpolates bilinearly across tile borders", () => {
  const box = { south: 46.45, west: 10.40, north: 46.55, east: 10.50 };
  const dem = createDem(planeTiles(box, 10));
  for (const [lat, lng] of [[46.5, 10.45], [46.47, 10.41], [46.53, 10.49]]) {
    const p = globalPixel(lat, lng, 10, 16);
    const expected = 0.5 * p.x + 0.25 * p.y;
    assert.ok(Math.abs(dem.elevationAt(lat, lng) - expected) < 1e-3);
  }
  assert.equal(dem.elevationAt(10, 10), null, "no data outside the loaded tiles");
  assert.equal(createDem([null]), null);
  // A tile whose size disagrees with its data is rejected, not misread.
  assert.equal(createDem([{ z: 10, x: 0, y: 0, size: 0, data: new Float32Array(256) }]), null);
});

test("real terrain: road bed at the GPX elevation, real ground away from it", () => {
  const route = climbRoute();
  const box = { south: 46.3, west: 7.8, north: 46.7, east: 8.25 };
  // A DEM 40 m off from the GPX everywhere near the route.
  const tiles = planeTiles(box, 9).map((tile) => ({ ...tile, data: tile.data.map(() => 700) }));
  const dem = createDem(tiles);
  const config = VIRTUAL_WORLD.terrain;
  const terrain = createWorldTerrain(route, config, { dem });
  assert.ok(terrain.realGround);
  for (const point of route.slice(1, -1)) {
    assert.ok(Math.abs(terrain.heightAtGeo(point.lat, point.lng) - point.ele) < 0.5, "road on the GPX");
  }
  const far = terrain.sample(4000, 4000, {});
  assert.ok(far.roadDistance > config.real.road_blend_meters * 4);
  assert.ok(Math.abs(far.height - 700) <= config.real.detail_meters + 1e-6, `far ground ${far.height} follows the DEM`);
  assert.ok(terrain.waterLevel <= config.real.sea_level_meters);
});

function buildingsOf(placed) {
  const list = [];
  for (let k = 0; k < placed.count; k++) {
    const b = placed.data.slice(k * BUILDING_STRIDE, (k + 1) * BUILDING_STRIDE);
    list.push({ x: b[0], y: b[1], z: b[2], width: b[3], depth: b[4], height: b[5], rotation: b[6], color: b[7] });
  }
  return list;
}

test("city buildings: clear of the road, never overlapping, on the ground", () => {
  const terrain = createWorldTerrain(climbRoute(), VIRTUAL_WORLD.terrain);
  const config = VIRTUAL_WORLD.city;
  const city = createCity(terrain, config);
  const buildings = buildingsOf(city.placeBuildings(-800, -800, 1600));
  assert.ok(buildings.length > 20, `a town was built (${buildings.length})`);
  for (const b of buildings) {
    const ground = terrain.sample(b.x, b.z, {});
    assert.ok(ground.roadDistance >= config.road_setback_meters + Math.hypot(b.width, b.depth) / 2 - 1e-6, "clear of the road");
    assert.ok(Math.hypot(b.width, b.depth) <= config.block_meters - config.street_gap_meters + 1e-6, "fits its cell");
    assert.ok(b.y <= ground.height - config.foundation_meters + 1e-6, "base sunk into the ground");
    assert.ok(b.height > 0);
  }
  // One per lattice cell, so centers are at least a block apart.
  for (let a = 0; a < buildings.length; a++) {
    for (let c = a + 1; c < buildings.length; c++) {
      const gap = Math.hypot(buildings[a].x - buildings[c].x, buildings[a].z - buildings[c].z);
      assert.ok(gap >= config.block_meters - 1e-6);
    }
  }
});

test("city buildings are stable across tile splits and the skyline keeps only tall ones", () => {
  const terrain = createWorldTerrain(climbRoute(), VIRTUAL_WORLD.terrain);
  const city = createCity(terrain, VIRTUAL_WORLD.city);
  const whole = buildingsOf(city.placeBuildings(-600, -600, 1200));
  const quarters = [[-600, -600], [0, -600], [-600, 0], [0, 0]]
    .flatMap(([x0, z0]) => buildingsOf(city.placeBuildings(x0, z0, 600)));
  const key = (b) => `${b.x.toFixed(3)},${b.z.toFixed(3)},${b.height.toFixed(3)}`;
  assert.deepEqual(new Set(quarters.map(key)), new Set(whole.map(key)));
  const minHeight = 12;
  const skyline = buildingsOf(city.placeBuildings(-600, -600, 1200, { minHeight }));
  assert.ok(skyline.length > 0 && skyline.length < whole.length, "a skyline, not the whole town");
  const all = new Set(whole.map(key));
  assert.ok(skyline.every((b) => all.has(key(b))), "skyline buildings are the same buildings");
  assert.ok(skyline.every((b) => b.height >= minHeight), "only tall ones");
});

test("road track: the camera pose rides the generated road, not the raw track", () => {
  // The raw hairpin with route distances, and the smooth road through it.
  const raw = hairpinLocal();
  let distance = 0;
  const routeLocal = raw.map((p, i) => {
    if (i) distance += Math.hypot(p.x - raw[i - 1].x, p.z - raw[i - 1].z);
    return { ...p, distance };
  });
  const centerline = catmullRomPolyline(raw, 2);
  const track = createRoadTrack(routeLocal, centerline);
  let previousArc = -1;
  for (let progress = 0; progress <= distance; progress += 5) {
    const pose = track.poseAt(progress);
    // Always on the centerline (within its 2 m sampling).
    const nearest = Math.min(...centerline.map((c) => Math.hypot(c.x - pose.x, c.z - pose.z)));
    assert.ok(nearest < 1.01, `pose ${nearest} m off the road`);
    // Monotonic along the road, even where the two legs run side by side.
    const arc = centerline.reduce((best, c, i) => (Math.hypot(c.x - pose.x, c.z - pose.z) < best.d ? { d: Math.hypot(c.x - pose.x, c.z - pose.z), i } : best), { d: Infinity, i: 0 }).i;
    assert.ok(arc >= previousArc - 1, "never jumps back to the other leg");
    previousArc = arc;
  }
  // Up the first leg (toward -z) the heading is north; down the second, south.
  assert.ok(Math.abs(track.poseAt(30).heading - 0) < 2 || Math.abs(track.poseAt(30).heading - 360) < 2);
  assert.ok(Math.abs(track.poseAt(distance - 30).heading - 180) < 2);
});

// A road traversing a steep hillside: flat at 500 m heading east along
// 46.5° N, the real ground rising 0.8 m per meter to the north — a cut into
// the slope on the uphill side, an embankment on the downhill one.
function hillsideWorld() {
  const lat0 = 46.5;
  const route = Array.from({ length: 41 }, (_, i) => ({ lat: lat0, lng: 8.0 + i * 0.0013, ele: 500 }));
  const box = { south: 46.4, west: 7.9, north: 46.6, east: 8.15 };
  const size = 16;
  const tiles = demTilesForBox(box, { maxZoom: 12, maxTiles: 64, tileSize: size }).map((tile) => {
    const data = new Float32Array(size * size);
    for (let py = 0; py < size; py++) {
      const gy = tile.y * size + py + 0.5;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / (2 ** tile.z * size)))) * 180) / Math.PI;
      data.fill(500 + 0.8 * (lat - lat0) * 111195, py * size, (py + 1) * size);
    }
    return { ...tile, size, data };
  });
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain, { dem: createDem(tiles) });
  return { terrain, surface: createSurface(terrain, VIRTUAL_WORLD.surface) };
}

// The height of a tile's drawn mesh at (x, z): the grid's own triangulation
// (buildTileArrays: diagonal from the top-right to the bottom-left corner).
function meshHeightAt(tile, rect, segments, x, z) {
  const step = rect.size / segments;
  // (Clamped to the tile: lattice jitter can put a tree just past its edge.)
  const fx = Math.min(segments, Math.max(0, (x - rect.x0) / step));
  const fz = Math.min(segments, Math.max(0, (z - rect.z0) / step));
  const c = Math.min(segments - 1, Math.max(0, Math.floor(fx)));
  const r = Math.min(segments - 1, Math.max(0, Math.floor(fz)));
  const u = fx - c;
  const v = fz - r;
  const h = (cc, rr) => tile.positions[(rr * (segments + 1) + cc) * 3 + 1];
  if (u + v <= 1) return h(c, r) + (h(c + 1, r) - h(c, r)) * u + (h(c, r + 1) - h(c, r)) * v;
  return h(c + 1, r + 1) + (h(c, r + 1) - h(c + 1, r + 1)) * (1 - u) + (h(c + 1, r) - h(c + 1, r + 1)) * (1 - v);
}

test("real terrain: no detail level draws the ground over the road, trees sit on the mesh", () => {
  const { terrain, surface } = hillsideWorld();
  const segments = VIRTUAL_WORLD.tiles.segments;
  const roadTop = 500 + VIRTUAL_WORLD.scene.road_lift_meters;
  const halfRoad = VIRTUAL_WORLD.scene.road_width_meters / 2;
  for (const size of [200, 400, 800, 1600, 3200]) {
    // The road crosses the tile off its grid lines.
    const rect = { x0: -size * 0.43, z0: -size * 0.37, size };
    const tile = buildTileArrays(terrain, surface, rect, {
      segments,
      skirtFactor: VIRTUAL_WORLD.tiles.skirt_factor,
      treeMaxTileMeters: VIRTUAL_WORLD.tiles.tree_max_tile_meters,
      roadClearSteps: VIRTUAL_WORLD.tiles.road_clear_steps,
    });
    let worst = -Infinity;
    for (let x = rect.x0 + 1; x < rect.x0 + size - 1; x += size / 97) {
      for (const offset of [-halfRoad, 0, halfRoad]) {
        const z = terrain.projection.toLocal(46.5, 8.0).z + offset;
        worst = Math.max(worst, meshHeightAt(tile, rect, segments, x, z) - roadTop);
      }
    }
    assert.ok(worst <= 0, `${size} m tile: ground ${worst.toFixed(2)} m over the road`);
    for (let k = 0; k < tile.trees.length / 6; k++) {
      const x = tile.trees[k * 6] + tile.cx;
      const z = tile.trees[k * 6 + 2] + tile.cz;
      const ground = meshHeightAt(tile, rect, segments, x, z);
      assert.ok(Math.abs(tile.trees[k * 6 + 1] - ground) < 0.01, `tree on the mesh (${tile.trees[k * 6 + 1]} vs ${ground})`);
    }
  }
});

test("real terrain: a flat shoulder beside the road, then a gentle cut into the slope", () => {
  const { terrain } = hillsideWorld();
  const config = VIRTUAL_WORLD.terrain;
  const z0 = terrain.projection.toLocal(46.5, 8.0).z;
  const shoulder = config.road_half_width_meters + config.real.road_shoulder_meters;
  // Uphill is north (-z).
  for (let d = 0; d <= shoulder; d += 0.5) {
    assert.ok(Math.abs(terrain.heightAt(500, z0 - d) - 500) < 0.01, `flat at ${d} m`);
  }
  const rise = (d) => terrain.heightAt(500, z0 - d) - 500;
  assert.ok(rise(shoulder + 5) < 2, `${rise(shoulder + 5)}`);
  assert.ok(rise(shoulder + 10) < 5, `${rise(shoulder + 10)}`);
  // Well away from the road the real hillside is back.
  assert.ok(Math.abs(rise(200) - 0.8 * 200) < 6, `${rise(200)}`);
});
