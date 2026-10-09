// OSM ground classes as rasters, for O(1) lookups from the hot loops that
// color terrain vertices, place trees and carve water: per OSM tile, the
// extracted areas (world-osm.mjs) are scanline-filled onto a cells² grid in
// priority order (the class list's first entry wins), roads stamped at their
// width, buildings filled and their outlines traced (so even a footprint
// smaller than a cell marks the cells it touches — no tree grows inside a
// house), plus a separate water mask. createOsmGround stitches the tiles into
// one sampler over world-local meters. Pure — the tile worker and tests.

import { globalPixel } from "./world-dem.mjs";
import { metersPerTileUnit } from "./world-osm.mjs";

// Extracted tile → { cells, classes: Uint8Array (class index + 1, 0 = no
// area), water: Uint8Array (1 = water) }.
export function rasterizeOsmTile(extracted, tile, { cells, groundClasses }) {
  const extent = extracted.extent;
  const scale = cells / extent;
  const unitMeters = metersPerTileUnit(tile, extent);
  const classes = new Uint8Array(cells * cells);
  const water = new Uint8Array(cells * cells);
  const ops = [];
  for (const area of extracted.areas) {
    for (const polygon of area.polygons) ops.push({ cls: area.cls, fill: polygon });
  }
  const waterClass = groundClasses.index("water");
  const roadClass = groundClasses.index("road");
  const buildingClass = groundClasses.index("building");
  for (const area of extracted.water) {
    for (const polygon of area.polygons) {
      ops.push({ cls: waterClass, fill: polygon });
      fillPolygon(water, cells, polygon, scale, 1);
    }
  }
  for (const road of extracted.roads) {
    ops.push({ cls: roadClass, line: road.points, halfWidth: road.width / 2 / unitMeters });
  }
  for (const building of extracted.buildings) {
    ops.push({ cls: buildingClass, fill: building.rings });
    for (const ring of building.rings) ops.push({ cls: buildingClass, line: closeRing(ring), halfWidth: extent / cells / 2 });
  }
  // Lowest priority first, so higher ones paint over it (stable for ties).
  ops.forEach((op, i) => { op.order = i; });
  ops.sort((a, b) => (b.cls - a.cls) || (a.order - b.order));
  for (const op of ops) {
    if (op.cls < 0) continue;
    if (op.fill) fillPolygon(classes, cells, op.fill, scale, op.cls + 1);
    else stampLine(classes, cells, op.line, scale, op.halfWidth * scale, op.cls + 1);
  }
  return { cells, classes, water };
}

function closeRing(ring) {
  return ring.length >= 2 ? [...ring, ring[0], ring[1]] : ring;
}

// Even-odd scanline fill of a polygon (exterior + holes, tile units) into a
// grid: a cell is filled when its center is inside.
export function fillPolygon(grid, cells, rings, scale, value) {
  let minY = Infinity; let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i += 2) {
      minY = Math.min(minY, ring[i] * scale);
      maxY = Math.max(maxY, ring[i] * scale);
    }
  }
  const row0 = Math.max(0, Math.ceil(minY - 0.5));
  const row1 = Math.min(cells - 1, Math.floor(maxY - 0.5));
  const crossings = [];
  for (let row = row0; row <= row1; row++) {
    const y = row + 0.5;
    crossings.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const ay = ring[j + 1] * scale; const by = ring[i + 1] * scale;
        if ((ay <= y) === (by <= y)) continue;
        const ax = ring[j] * scale; const bx = ring[i] * scale;
        crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const c1 = Math.min(cells - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) grid[row * cells + c] = value;
    }
  }
}

// Every cell whose center lies within `halfWidth` (cells) of the line.
export function stampLine(grid, cells, line, scale, halfWidth, value) {
  const reach = Math.max(halfWidth, 0.5);
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i] * scale; const ay = line[i + 1] * scale;
    const bx = line[i + 2] * scale; const by = line[i + 3] * scale;
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const c1 = Math.min(cells - 1, Math.ceil(Math.max(ax, bx) + reach));
    const r0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const r1 = Math.min(cells - 1, Math.ceil(Math.max(ay, by) + reach));
    const dx = bx - ax; const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = c + 0.5; const py = r + 0.5;
        let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) <= reach) grid[r * cells + c] = value;
      }
    }
  }
}

// The stitched sampler over world-local meters. classAt(x, z) is the ground
// class index there, `unclassified` for land no area covers, and -1 where no
// OSM tile is loaded (the caller falls back to the synthetic surface);
// waterAt(x, z) is the water mask, bilinear (0..1), 0 outside loaded tiles.
// `version` counts the tiles added.
export function createOsmGround(projection, { zoom, cells, unclassified }) {
  const tiles = new Map();
  const ground = {
    version: 0,
    addTile(tile, raster) {
      tiles.set(`${tile.x}/${tile.y}`, raster);
      ground.version++;
    },
    hasTiles() {
      return tiles.size > 0;
    },
    classAt(x, z) {
      if (!tiles.size) return -1;
      const geo = projection.toGeo(x, z);
      const p = globalPixel(geo.lat, geo.lng, zoom, cells);
      const tx = Math.floor(p.x / cells);
      const ty = Math.floor(p.y / cells);
      const raster = tiles.get(`${tx}/${ty}`);
      if (!raster) return -1;
      const c = Math.min(cells - 1, Math.floor(p.x - tx * cells));
      const r = Math.min(cells - 1, Math.floor(p.y - ty * cells));
      const value = raster.classes[r * cells + c];
      return value ? value - 1 : unclassified;
    },
    waterAt(x, z) {
      if (!tiles.size) return 0;
      const geo = projection.toGeo(x, z);
      const p = globalPixel(geo.lat, geo.lng, zoom, cells);
      const fx = p.x - 0.5;
      const fy = p.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const at = (gx, gy) => {
        const raster = tiles.get(`${Math.floor(gx / cells)}/${Math.floor(gy / cells)}`);
        if (!raster) return 0;
        return raster.water[(gy - Math.floor(gy / cells) * cells) * cells + (gx - Math.floor(gx / cells) * cells)];
      };
      const a = at(x0, y0); const b = at(x0 + 1, y0); const c = at(x0, y0 + 1); const d = at(x0 + 1, y0 + 1);
      if (!(a | b | c | d)) return 0;
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
  };
  return ground;
}
