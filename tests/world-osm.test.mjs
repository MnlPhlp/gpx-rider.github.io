import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { VIRTUAL_WORLD } from "../app/core/tuning.mjs";
import { decodeMvt, ringArea2 } from "../app/world/world-mvt.mjs";
import {
  clipLine,
  clipRing,
  createGroundClasses,
  createTileProjector,
  extractOsmTile,
  geoToTile,
  osmTileRect,
  osmTilesForCorridor,
  resampleLine,
  tileToGeo,
} from "../app/world/world-osm.mjs";
import { createOsmGround, fillPolygon, rasterizeOsmTile } from "../app/world/world-osm-raster.mjs";
import { buildOsmMeshes, RIBBON_KINDS } from "../app/world/world-osm-meshes.mjs";
import { createSurface } from "../app/world/world-surface.mjs";
import { createWorldProjection, createWorldTerrain } from "../app/world/world-terrain.mjs";

const OSM = VIRTUAL_WORLD.osm;

// --- A test-only MVT encoder -------------------------------------------------

function varint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}
function key(out, field, wire) {
  varint(out, field * 8 + wire);
}
function bytesField(out, field, bytes) {
  key(out, field, 2);
  varint(out, bytes.length);
  out.push(...bytes);
}
const zz = (n) => (n << 1) ^ (n >> 31);

// runs: [[x, y, x, y, …], …]; polygons close their rings.
function geometryCommands(type, runs) {
  const out = [];
  let cx = 0;
  let cy = 0;
  for (const run of runs) {
    const n = run.length / 2;
    out.push((1 & 7) | (1 << 3), zz(run[0] - cx), zz(run[1] - cy));
    cx = run[0]; cy = run[1];
    if (n > 1) {
      out.push((2 & 7) | ((n - 1) << 3));
      for (let i = 1; i < n; i++) {
        out.push(zz(run[i * 2] - cx), zz(run[i * 2 + 1] - cy));
        cx = run[i * 2]; cy = run[i * 2 + 1];
      }
    }
    if (type === 3) out.push((7 & 7) | (1 << 3));
  }
  return out;
}

function encodeValue(value) {
  const out = [];
  if (typeof value === "string") bytesField(out, 1, [...new TextEncoder().encode(value)]);
  else if (typeof value === "boolean") { key(out, 7, 0); varint(out, value ? 1 : 0); }
  else if (value && value.float !== undefined) {
    key(out, 2, 5);
    const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value.float, true); out.push(...b);
  } else if (value && value.sint !== undefined) { key(out, 6, 0); varint(out, value.sint < 0 ? -2 * value.sint - 1 : 2 * value.sint); }
  else if (value && value.int !== undefined) {
    key(out, 4, 0);
    let v = BigInt.asUintN(64, BigInt(value.int));
    while (v >= 0x80n) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
  } else if (Number.isInteger(value) && value >= 0) { key(out, 5, 0); varint(out, value); }
  else {
    key(out, 3, 1);
    const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); out.push(...b);
  }
  return out;
}

function encodeTile(layers) {
  const tile = [];
  for (const layer of layers) {
    const out = [];
    key(out, 15, 0); varint(out, 2);
    bytesField(out, 1, [...new TextEncoder().encode(layer.name)]);
    const keys = [];
    const values = [];
    for (const feature of layer.features) {
      const f = [];
      const tags = [];
      for (const [k, v] of Object.entries(feature.properties ?? {})) {
        let ki = keys.indexOf(k);
        if (ki < 0) ki = keys.push(k) - 1;
        values.push(v);
        tags.push(ki, values.length - 1);
      }
      const packed = [];
      tags.forEach((t) => varint(packed, t));
      if (tags.length) bytesField(f, 2, packed);
      key(f, 3, 0); varint(f, feature.type);
      const geom = [];
      geometryCommands(feature.type, feature.runs).forEach((c) => varint(geom, c));
      bytesField(f, 4, geom);
      bytesField(out, 2, f);
    }
    for (const k of keys) bytesField(out, 3, [...new TextEncoder().encode(k)]);
    for (const v of values) bytesField(out, 4, encodeValue(v));
    key(out, 5, 0); varint(out, layer.extent ?? 4096);
    bytesField(tile, 3, out);
  }
  return new Uint8Array(tile);
}

// Squares as flat rings: exterior clockwise on screen (positive area, y
// down), holes counter-clockwise.
const square = (x0, y0, size) => [x0, y0, x0 + size, y0, x0 + size, y0 + size, x0, y0 + size];
const hole = (x0, y0, size) => [x0, y0, x0, y0 + size, x0 + size, y0 + size, x0 + size, y0];

// --- Decoder ----------------------------------------------------------------

test("MVT: points, lines, polygons with holes and every value type", () => {
  const bytes = encodeTile([
    {
      name: "things",
      features: [
        { type: 1, properties: { name: "peak", ele: 3905, flag: true }, runs: [[10, 20]] },
        { type: 2, properties: { neg: { int: -5 }, big: { int: 2 ** 40 + 3 }, s: { sint: -3 }, f: { float: 1.5 }, d: 2.25 }, runs: [[0, 0, 100, 0, 100, 50], [5, 5, 6, 6]] },
        { type: 3, properties: { class: "wood" }, runs: [square(0, 0, 100), hole(20, 20, 10), square(200, 200, 50)] },
      ],
    },
    { name: "poi", features: [{ type: 1, properties: { a: "b" }, runs: [[1, 1]] }] },
  ]);
  const all = decodeMvt(bytes);
  assert.deepEqual(Object.keys(all).sort(), ["poi", "things"]);
  const [point, line, polygon] = all.things.features;
  assert.equal(all.things.extent, 4096);
  assert.deepEqual(point.properties, { name: "peak", ele: 3905, flag: true });
  assert.deepEqual(point.geometry, [[10, 20]]);
  assert.equal(line.properties.neg, -5);
  assert.equal(line.properties.big, 2 ** 40 + 3);
  assert.equal(line.properties.s, -3);
  assert.equal(line.properties.f, 1.5);
  assert.equal(line.properties.d, 2.25);
  assert.deepEqual(line.geometry, [[0, 0, 100, 0, 100, 50], [5, 5, 6, 6]]);
  // Multipolygon: the first polygon carries its hole, the second stands alone.
  assert.equal(polygon.geometry.length, 2);
  assert.equal(polygon.geometry[0].length, 2);
  assert.deepEqual(polygon.geometry[0][1], hole(20, 20, 10));
  assert.equal(polygon.geometry[1].length, 1);
  assert.ok(ringArea2(square(0, 0, 10)) > 0 && ringArea2(hole(0, 0, 10)) < 0);

  const filtered = decodeMvt(bytes, { layers: ["poi"] });
  assert.deepEqual(Object.keys(filtered), ["poi"]);
});

test("MVT: a real OpenFreeMap tile (Stelvio, z14) decodes", () => {
  // © OpenStreetMap contributors (ODbL), © OpenMapTiles — see tests/fixtures/README.md.
  const layers = decodeMvt(readFileSync(new URL("./fixtures/osm-stelvio-14-8667-5793.pbf", import.meta.url)));
  for (const name of ["building", "landcover", "transportation", "waterway"]) assert.ok(layers[name], name);
  assert.equal(layers.landcover.extent, 4096);
  const subclasses = new Set(layers.landcover.features.map((f) => f.properties.subclass));
  assert.ok(subclasses.has("bare_rock") && subclasses.has("scree"));
  assert.ok(layers.transportation.features.some((f) => f.properties.class === "secondary" && f.type === 2));
  for (const feature of layers.building.features) {
    assert.equal(feature.type, 3);
    assert.ok(feature.properties.render_height > 0);
  }
});

// --- Tiles, clipping, classes ----------------------------------------------

test("tile math round-trips and tile rects line up with the projection", () => {
  const t = geoToTile(14, 46.53, 10.45);
  const back = tileToGeo(14, t.x, t.y);
  assert.ok(Math.abs(back.lat - 46.53) < 1e-9 && Math.abs(back.lng - 10.45) < 1e-9);
  const projection = createWorldProjection({ lat: 46.53, lng: 10.45 });
  const tile = { z: 14, x: Math.floor(t.x), y: Math.floor(t.y) };
  const rect = osmTileRect(tile, projection);
  // ~2.45 km × cos(46.5°) ≈ 1.68 km square.
  assert.ok(Math.abs(rect.maxX - rect.minX - 1683) < 15, `${rect.maxX - rect.minX}`);
  assert.ok(Math.abs(rect.maxZ - rect.minZ - 1683) < 15);
  const project = createTileProjector(tile, 4096, projection);
  const corner = { ...project(0, 0) };
  assert.ok(Math.abs(corner.x - rect.minX) < 1e-6 && Math.abs(corner.z - rect.minZ) < 1e-6);
  const far = project(4096, 4096);
  assert.ok(Math.abs(far.x - rect.maxX) < 1e-6 && Math.abs(far.z - rect.maxZ) < 1e-6);
});

test("corridor tiles: grow with the corridor, follow the route, respect the budget", () => {
  const projection = createWorldProjection({ lat: 46.5, lng: 8.0 });
  // 12 km due east.
  const line = Array.from({ length: 61 }, (_, i) => ({ x: -6000 + i * 200, z: 0 }));
  const narrow = osmTilesForCorridor(line, projection, { zoom: 14, corridorMeters: 0, maxTiles: 100 });
  const wide = osmTilesForCorridor(line, projection, { zoom: 14, corridorMeters: 1500, maxTiles: 100 });
  // ~12 km / 1.68 km per tile: 8 tiles across, 1–2 rows.
  assert.ok(narrow.length >= 8 && narrow.length <= 16, `${narrow.length}`);
  assert.ok(wide.length > narrow.length);
  // In route order: x never jumps back west by more than a tile.
  for (let i = 1; i < wide.length; i++) assert.ok(wide[i].x >= wide[i - 1].x - 2);
  assert.equal(new Set(wide.map((t) => `${t.x}/${t.y}`)).size, wide.length);
  const capped = osmTilesForCorridor(line, projection, { zoom: 14, corridorMeters: 1500, maxTiles: 12 });
  assert.ok(capped.length <= 12 && capped.length >= 8);
  const tiny = osmTilesForCorridor(line, projection, { zoom: 14, corridorMeters: 1500, maxTiles: 3 });
  assert.equal(tiny.length, 3);
});

test("clipping lines and rings to the tile square, resampling lines", () => {
  const pieces = clipLine([-100, 50, 50, 50, 50, 5000, 60, 5000, 60, 100], 4096);
  assert.deepEqual(pieces[0], [0, 50, 50, 50, 50, 4096]);
  assert.deepEqual(pieces[1], [60, 4096, 60, 100]);
  const clipped = clipRing(square(-50, -50, 100), 4096);
  assert.equal(ringArea2(clipped), 2 * 50 * 50);
  const resampled = resampleLine([0, 0, 10, 0], 3);
  assert.equal(resampled.length / 2, 5);
  assert.deepEqual(resampled.slice(-2), [10, 0]);
});

test("ground classes: landcover subclass wins over its class, priority is list order", () => {
  const classes = createGroundClasses(OSM.ground);
  assert.equal(classes.classify("landcover", { class: "grass", subclass: "park" }), classes.index("park"));
  assert.equal(classes.classify("landcover", { class: "wood", subclass: "unknown_thing" }), classes.index("forest"));
  assert.equal(classes.classify("landuse", { class: "residential" }), classes.index("urban"));
  assert.equal(classes.classify("landuse", { class: "nonsense" }), -1);
  assert.equal(classes.classify("park", { class: "national_park" }), -1);
  assert.ok(classes.index("building") < classes.index("water"));
  assert.ok(classes.index("forest") < classes.index("urban"));
});

// --- A synthetic world around a route ---------------------------------------

// A road heading due east through the middle of a z14 tile at 46.5° N.
function tileWorld() {
  const t = geoToTile(14, 46.5, 8.0);
  const tile = { z: 14, x: Math.floor(t.x), y: Math.floor(t.y) };
  const midLat = tileToGeo(14, tile.x + 0.5, tile.y + 0.5).lat;
  const west = tileToGeo(14, tile.x - 0.3, tile.y).lng;
  const east = tileToGeo(14, tile.x + 1.3, tile.y).lng;
  const route = Array.from({ length: 41 }, (_, i) => ({ lat: midLat, lng: west + ((east - west) * i) / 40, ele: 500 }));
  return { tile, route };
}


test("extract: route stretches, tunnels, far paths and buildings on the road are left out", () => {
  const { tile, route } = tileWorld();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const classes = createGroundClasses(OSM.ground);
  const mid = 2048;
  const layers = decodeMvt(encodeTile([
    {
      name: "transportation",
      features: [
        // Along the route (the route itself), then turning north away from it.
        { type: 2, properties: { class: "secondary" }, runs: [[200, mid, 1500, mid, 1500, 500]] },
        // Crossing the route at right angles: kept.
        { type: 2, properties: { class: "minor" }, runs: [[3000, mid - 800, 3000, mid + 800]] },
        { type: 2, properties: { class: "primary", brunnel: "tunnel" }, runs: [[100, 100, 900, 100]] },
        // A path ~1.2 km north of the route (> path_max_route_distance).
        { type: 2, properties: { class: "path" }, runs: [[100, 10, 900, 10]] },
        { type: 2, properties: { class: "rail" }, runs: [[100, 3000, 900, 3000]] },
      ],
    },
    {
      name: "building",
      features: [
        { type: 3, properties: { render_height: 12 }, runs: [square(2500, mid - 8, 16)] }, // on the road
        { type: 3, properties: { render_height: 12 }, runs: [square(2500, mid - 300, 30)] },
        { type: 3, properties: { render_height: 30, hide_3d: true }, runs: [square(3500, mid - 300, 30)] },
        { type: 3, properties: { render_height: 9 }, runs: [square(4090, 600, 30)] }, // centered in the next tile
      ],
    },
    { name: "waterway", features: [{ type: 2, properties: { class: "stream" }, runs: [[100, 3500, 2000, 3500]] }] },
    { name: "landcover", features: [{ type: 3, properties: { class: "wood", subclass: "forest" }, runs: [square(0, 0, 1000)] }] },
  ]));
  const out = extractOsmTile(layers, tile, {
    projection: terrain.projection, terrain, config: OSM, classes, roadHalfWidth: VIRTUAL_WORLD.terrain.road_half_width_meters,
  });
  assert.equal(out.buildings.length, 1);
  assert.equal(out.buildings[0].height, 12);
  const kinds = out.roads.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["major", "minor"]);
  // The secondary road survives only on its northbound leg: near the route
  // nothing is left but the junction.
  const secondary = out.roads.find((r) => r.kind === "major");
  for (let i = 0; i < secondary.points.length; i += 2) {
    if (Math.abs(secondary.points[i + 1] - mid) < 30) assert.ok(Math.abs(secondary.points[i] - 1500) < 15);
  }
  assert.equal(out.waterways.length, 1);
  assert.equal(out.areas[0].cls, classes.index("forest"));
});

test("raster: priority, holes, building outlines; the sampler stitches tiles", () => {
  const classes = createGroundClasses(OSM.ground);
  const { tile, route } = tileWorld();
  const extracted = {
    extent: 4096,
    areas: [
      { cls: classes.index("urban"), polygons: [[square(0, 0, 4096)]] },
      { cls: classes.index("park"), polygons: [[square(1024, 1024, 2048), hole(1536, 1536, 1024)]] },
    ],
    water: [],
    roads: [],
    waterways: [],
    // Smaller than a cell (16 units): still marks the cells it touches.
    buildings: [{ rings: [square(100, 100, 6)], height: 8, minHeight: 0 }],
  };
  const raster = rasterizeOsmTile(extracted, tile, { cells: 256, groundClasses: classes });
  const at = (c, r) => raster.classes[r * 256 + c] - 1;
  assert.equal(at(70, 70), classes.index("park"));
  assert.equal(at(128, 128), classes.index("urban")); // the hole
  assert.equal(at(10, 200), classes.index("urban"));
  assert.equal(at(6, 6), classes.index("building"));

  const projection = createWorldTerrain(route, VIRTUAL_WORLD.terrain).projection;
  const ground = createOsmGround(projection, { zoom: 14, cells: 256, unclassified: classes.index("unclassified") });
  const rect = osmTileRect(tile, projection);
  assert.equal(ground.classAt(rect.minX + 10, rect.minZ + 1600), -1);
  ground.addTile(tile, raster);
  assert.equal(ground.classAt(rect.minX + 10, rect.minZ + 1600), classes.index("urban"));
  assert.equal(ground.classAt(rect.minX - 10, rect.minZ + 10), -1);
  assert.equal(ground.version, 1);
});

test("water: lake and river areas are a blue ground class without trees", () => {
  const { tile, route } = tileWorld();
  const classes = createGroundClasses(OSM.ground);
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const extracted = {
    extent: 4096, areas: [{ cls: classes.index("forest"), polygons: [[square(0, 0, 4096)]] }], buildings: [], roads: [], waterways: [],
    water: [{ polygons: [[square(300, 300, 1200)]] }],
  };
  const raster = rasterizeOsmTile(extracted, tile, { cells: 256, groundClasses: classes });
  const ground = createOsmGround(terrain.projection, { zoom: 14, cells: 256, unclassified: classes.index("unclassified") });
  ground.addTile(tile, raster);
  const project = createTileProjector(tile, 4096, terrain.projection);
  const lake = { ...project(900, 900) };
  assert.equal(ground.classAt(lake.x, lake.z), classes.index("water"));
  const surface = createSurface(terrain, VIRTUAL_WORLD.surface, { osm: { ground, classes: OSM.ground } });
  const inLake = { ...project(500, 500) };
  assert.equal(surface.placeTrees(inLake.x, inLake.z, 300).count, 0);
  const color = [0, 0, 0];
  surface.colorAt(lake.x, lake.z, terrain.sample(lake.x, lake.z, {}), 0, color);
  assert.ok(color[2] > color[0] && color[2] > color[1], `blue ground ${color}`);
  // The meshes carry no separate water surface.
  const meshes = buildOsmMeshes(extracted, tile, { projection: terrain.projection, terrain, config: OSM });
  assert.deepEqual(Object.keys(meshes).sort(), ["buildings", "cx", "cz", "ribbons"]);
});

test("meshes: walls face out, roofs face up, buildings never float; ribbons face up and drape", () => {
  const { tile, route } = tileWorld();
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const extracted = {
    extent: 4096,
    areas: [],
    water: [],
    waterways: [],
    buildings: [{ rings: [square(1000, 1000, 40), hole(1015, 1015, 10)], height: 15, minHeight: 0 }],
    roads: [{ points: resampleLine([500, 3000, 1500, 3000], 5), width: 6, kind: "minor", bridge: false }],
  };
  const meshes = buildOsmMeshes(extracted, tile, { projection: terrain.projection, terrain, config: OSM });
  const { positions, normals, indices, style } = meshes.buildings;
  const vertex = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let walls = 0;
  let roofs = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const face = cross(sub(vertex(b), vertex(a)), sub(vertex(c), vertex(a)));
    const n = [normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2]];
    assert.ok(face[0] * n[0] + face[1] * n[1] + face[2] * n[2] > 0, "winding agrees with the normal");
    if (style[a * 2] === 2) roofs++;
    else walls++;
  }
  // 4 outer + 4 courtyard walls, 2 triangles each; the roof keeps the hole.
  assert.equal(walls, 16);
  assert.equal(roofs, 8);
  // Outer walls point away from the footprint center, courtyard walls into
  // the courtyard (also away from the solid).
  const project = createTileProjector(tile, 4096, terrain.projection);
  const center = { ...project(1020, 1020) };
  const cx = meshes.cx;
  const cz = meshes.cz;
  for (let v = 0; v < positions.length / 3; v++) {
    if (style[v * 2] === 2) continue;
    const dx = positions[v * 3] + cx - center.x;
    const dz = positions[v * 3 + 2] + cz - center.z;
    const outward = normals[v * 3] * dx + normals[v * 3 + 2] * dz;
    // The courtyard's walls are ~2 m from the center, the outer ones ~8 m.
    const inner = Math.max(Math.abs(dx), Math.abs(dz)) < 5;
    assert.ok(inner ? outward < 0 : outward > 0);
  }
  const ground = terrain.heightAt(center.x, center.z);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < positions.length / 3; v++) {
    minY = Math.min(minY, positions[v * 3 + 1]);
    maxY = Math.max(maxY, positions[v * 3 + 1]);
  }
  assert.ok(minY < ground - 1);
  assert.ok(maxY >= ground + 14);

  const ribbons = meshes.ribbons;
  assert.ok(ribbons.kinds.every((k) => k === RIBBON_KINDS.minor));
  for (let t = 0; t < ribbons.indices.length; t += 3) {
    const p = (i) => [ribbons.positions[i * 3], ribbons.positions[i * 3 + 1], ribbons.positions[i * 3 + 2]];
    const [a, b, c] = [p(ribbons.indices[t]), p(ribbons.indices[t + 1]), p(ribbons.indices[t + 2])];
    assert.ok(cross(sub(b, a), sub(c, a))[1] > 0, "ribbon faces up");
  }
  for (let v = 0; v < ribbons.positions.length / 3; v++) {
    const x = ribbons.positions[v * 3] + cx;
    const z = ribbons.positions[v * 3 + 2] + cz;
    const lift = ribbons.positions[v * 3 + 1] - terrain.heightAt(x, z);
    assert.ok(lift > 0.05 && lift < 0.3, `${lift}`);
  }
});

test("surface: OSM classes set colors and trees; unloaded areas stay synthetic", () => {
  const { tile, route } = tileWorld();
  const classes = createGroundClasses(OSM.ground);
  const terrain = createWorldTerrain(route, VIRTUAL_WORLD.terrain);
  const ground = createOsmGround(terrain.projection, { zoom: 14, cells: 256, unclassified: classes.index("unclassified") });
  const raster = { cells: 256, classes: new Uint8Array(256 * 256) };
  // West half forest, east half a solid block of buildings.
  fillPolygon(raster.classes, 256, [[0, 0, 2048, 0, 2048, 4096, 0, 4096]], 1 / 16, classes.index("forest") + 1);
  fillPolygon(raster.classes, 256, [[2048, 0, 4096, 0, 4096, 4096, 2048, 4096]], 1 / 16, classes.index("building") + 1);
  ground.addTile(tile, raster);
  const surface = createSurface(terrain, VIRTUAL_WORLD.surface, { osm: { ground, classes: OSM.ground } });
  const rect = osmTileRect(tile, terrain.projection);
  const third = (rect.maxZ - rect.minZ) / 3;
  // (Kept 20 m inside the tile: lattice jitter moves a tree a few meters.)
  const west = surface.placeTrees(rect.minX + 20, rect.minZ + 20, third);
  const east = surface.placeTrees(rect.maxX - third - 20, rect.minZ + 20, third);
  assert.ok(west.count > 1000, `${west.count}`);
  assert.equal(east.count, 0);
  const color = [0, 0, 0];
  const sample = terrain.sample(rect.maxX - 50, rect.minZ + 50, {});
  surface.colorAt(rect.maxX - 50, rect.minZ + 50, sample, 0, color);
  const building = OSM.ground[classes.index("building")].color;
  assert.ok(color.every((c) => c > 0), building);
  // Outside the loaded tile the synthetic surface still grows trees.
  const synthetic = createSurface(terrain, VIRTUAL_WORLD.surface);
  const outside = { x: rect.minX - 3000, z: rect.minZ };
  assert.deepEqual(
    surface.placeTrees(outside.x, outside.z, 400),
    synthetic.placeTrees(outside.x, outside.z, 400),
  );
});
