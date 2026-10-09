// Mesh arrays for one OSM tile's buildings and roads/waterways
// (extracted by world-osm.mjs), built in the tile worker and handed to the
// main thread as transferable typed arrays. Pure apart from earcut (vendored,
// imported by relative path: module workers don't see the page's import map).
//
//   - Buildings: every footprint extruded — a wall quad per ring edge, holes
//     (courtyards) included, and a flat roof triangulated with earcut. The
//     base is the lowest ground under the footprint minus foundation_meters,
//     the roof the building's height above that lowest point plus the
//     ground's rise across the footprint, so nothing floats or drowns on a
//     slope. Per vertex: `facade` (meters along the ring, meters above the
//     lowest ground — the window shader's coordinates) and `kind`/`tone`
//     (0 house wall, 1 tower wall, 2 roof; a per-building 0..1 tone that
//     picks its facade color).
//   - Roads and waterways: draped ribbons. Each resampled point's two edge
//     points get their own ground height, so the ribbon follows the cross
//     slope; bends use world-road.mjs's fold-free cross-sections. A bridge
//     runs straight from its first to its last point's height instead.
//     Per vertex a kind index: 0 major, 1 minor, 2 path, 3 water.
// Positions are relative to the tile's center (cx, cz), so float32 keeps
// centimeter precision anywhere in the world.

import earcut from "../vendor/earcut/earcut.js";
import { crossSectionFrames } from "./world-road.mjs";
import { cellRandom } from "./world-noise.mjs";
import { createTileProjector, osmTileRect, ringArea } from "./world-osm.mjs";

export const RIBBON_KINDS = { major: 0, minor: 1, path: 2, water: 3 };

export function buildOsmMeshes(extracted, tile, { projection, terrain, config, seed = 1 }) {
  const project = createTileProjector(tile, extracted.extent, projection);
  const rect = osmTileRect(tile, projection);
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const toLocal = (ring) => {
    const out = new Float64Array(ring.length);
    for (let i = 0; i < ring.length; i += 2) {
      const p = project(ring[i], ring[i + 1]);
      out[i] = p.x;
      out[i + 1] = p.z;
    }
    return out;
  };
  return {
    cx,
    cz,
    buildings: buildBuildings(extracted.buildings, { toLocal, terrain, config, cx, cz, seed, tile }),
    ribbons: buildRibbons(extracted, { toLocal, terrain, config, cx, cz }),
  };
}

function buildBuildings(buildings, { toLocal, terrain, config, cx, cz, seed, tile }) {
  const look = config.buildings;
  const positions = [];
  const normals = [];
  const facade = [];
  const style = [];
  const indices = [];
  let vertex = 0;
  buildings.forEach((building, b) => {
    // Exterior rings clockwise on the map, holes counter-clockwise, whatever
    // the source's winding.
    const rings = building.rings.map((ring, r) => orient(toLocal(ring), r === 0));
    let low = Infinity;
    let high = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const h = terrain.heightAt(ring[i], ring[i + 1]);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    if (!Number.isFinite(low)) return;
    const base = building.minHeight > 0 ? low + building.minHeight : low - look.foundation_meters;
    const top = low + building.height + (high - low);
    const kind = building.height >= look.tower_from_meters ? 1 : 0;
    const tone = cellRandom(seed, tile.x * 4096 + b, tile.y, 7);
    const v0 = base - low;
    const v1 = top - low;

    for (const ring of rings) {
      let along = 0;
      const n = ring.length;
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % n;
        const ax = ring[i]; const az = ring[i + 1]; const bx = ring[j]; const bz = ring[j + 1];
        const dx = bx - ax; const dz = bz - az;
        const length = Math.hypot(dx, dz);
        if (length < 0.05) continue;
        // Outward normal: exterior rings run clockwise on the map, holes the
        // other way, so (dz, -dx) points out of the solid.
        const nx = dz / length; const nz = -dx / length;
        positions.push(ax - cx, base, az - cz, bx - cx, base, bz - cz, bx - cx, top, bz - cz, ax - cx, top, az - cz);
        for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
        facade.push(along, v0, along + length, v0, along + length, v1, along, v1);
        for (let k = 0; k < 4; k++) style.push(kind, tone);
        // A0 A1 B0, B0 A1 B1 — counter-clockwise seen from outside.
        indices.push(vertex, vertex + 3, vertex + 1, vertex + 1, vertex + 3, vertex + 2);
        vertex += 4;
        along += length;
      }
    }

    const flat = [];
    const holes = [];
    rings.forEach((ring, r) => {
      if (r > 0) holes.push(flat.length / 2);
      for (let i = 0; i < ring.length; i++) flat.push(ring[i]);
    });
    const triangles = earcut(flat, holes);
    const first = vertex;
    for (let i = 0; i < flat.length; i += 2) {
      positions.push(flat[i] - cx, top, flat[i + 1] - cz);
      normals.push(0, 1, 0);
      facade.push(flat[i], flat[i + 1]);
      style.push(2, tone);
      vertex++;
    }
    for (let t = 0; t < triangles.length; t += 3) {
      pushUpward(indices, flat, first, triangles[t], triangles[t + 1], triangles[t + 2]);
    }
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    facade: new Float32Array(facade),
    style: new Float32Array(style),
    indices: new Uint32Array(indices),
  };
}

// A flat local ring with the wanted winding (positive area = clockwise on the
// map in the x-east/z-south frame, like an MVT exterior ring).
function orient(ring, exterior) {
  if ((ringArea(ring) > 0) === exterior) return ring;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < ring.length; i += 2) {
    out[i] = ring[ring.length - 2 - i];
    out[i + 1] = ring[ring.length - 1 - i];
  }
  return out;
}

// A roof/water triangle wound to face up (+y): in the x-east/z-south frame
// that is clockwise on the map.
function pushUpward(indices, flat, first, a, b, c) {
  const abx = flat[b * 2] - flat[a * 2]; const abz = flat[b * 2 + 1] - flat[a * 2 + 1];
  const acx = flat[c * 2] - flat[a * 2]; const acz = flat[c * 2 + 1] - flat[a * 2 + 1];
  // y of (ab × ac) = ab.z·ac.x − ab.x·ac.z; positive faces up.
  if (abz * acx - abx * acz >= 0) indices.push(first + a, first + b, first + c);
  else indices.push(first + a, first + c, first + b);
}

function buildRibbons(extracted, { toLocal, terrain, config, cx, cz }) {
  const lift = config.roads.lift_meters;
  const positions = [];
  const kinds = [];
  const indices = [];
  let vertex = 0;
  // Bigger roads a few centimeters above smaller ones where they overlap.
  const kindLift = [0.06, 0.03, 0, 0.01];
  const add = (line, width, kind, bridge) => {
    const local = toLocal(line);
    const n = local.length / 2;
    if (n < 2) return;
    const points = [];
    for (let i = 0; i < n; i++) points.push({ x: local[i * 2], z: local[i * 2 + 1] });
    const frames = crossSectionFrames(points);
    const half = width / 2;
    const startHeight = bridge ? terrain.heightAt(points[0].x, points[0].z) : 0;
    const endHeight = bridge ? terrain.heightAt(points[n - 1].x, points[n - 1].z) : 0;
    let total = 0;
    const along = [0];
    for (let i = 1; i < n; i++) along.push((total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)));
    const up = lift + kindLift[kind];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const { side, maxLeft, maxRight } = frames[i];
      const left = Math.min(half, maxLeft);
      const right = Math.min(half, maxRight);
      const lx = p.x + side.x * left; const lz = p.z + side.z * left;
      const rx = p.x - side.x * right; const rz = p.z - side.z * right;
      let lh;
      let rh;
      if (bridge) {
        lh = rh = startHeight + (endHeight - startHeight) * (total > 0 ? along[i] / total : 0);
      } else {
        lh = terrain.heightAt(lx, lz);
        rh = terrain.heightAt(rx, rz);
      }
      positions.push(lx - cx, lh + up, lz - cz, rx - cx, rh + up, rz - cz);
      kinds.push(kind, kind);
      if (i > 0) {
        const a = vertex - 2; const b = vertex - 1; const c = vertex; const d = vertex + 1;
        // `side` is left of travel: (left, right, next left) faces up.
        indices.push(a, b, c, b, d, c);
      }
      vertex += 2;
    }
  };
  for (const road of extracted.roads) add(road.points, road.width, RIBBON_KINDS[road.kind] ?? 1, road.bridge);
  for (const waterway of extracted.waterways) add(waterway.points, waterway.width, RIBBON_KINDS.water, false);
  return {
    positions: new Float32Array(positions),
    kinds: new Float32Array(kinds),
    indices: new Uint32Array(indices),
  };
}
