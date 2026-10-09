// OpenStreetMap vector tiles (OpenMapTiles schema, decoded by world-mvt.mjs)
// → what the virtual world's real-world styles draw: which z14 tiles cover
// the route's corridor, tile units ↔ world-local meters, the ground class of
// every land use / land cover area (virtual_world.osm.ground), and the
// buildings, roads, waterways and water areas of one tile. Pure — runs in the
// tile worker and in tests.
//
// Everything a tile yields stays in tile units (0..extent, y down) and is
// clipped to the tile's own square, so features in the tiles' overlapping
// buffers are drawn once. Roads and waterways come out resampled every
// roads.resample_meters, and stretches that run along the route's own road
// are cut out (the route is drawn by world-road.mjs).

const EARTH_CIRCUMFERENCE_METERS = 40075016.686;

// Fractional tile coordinates → { lat, lng } (Web Mercator inverse).
export function tileToGeo(zoom, tx, ty) {
  const n = 2 ** zoom;
  const lng = (tx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { lat, lng };
}

// { lat, lng } → fractional tile coordinates at a zoom.
export function geoToTile(zoom, lat, lng) {
  const n = 2 ** zoom;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

export function osmTileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

// A tile's square in world-local meters { minX, maxX, minZ, maxZ }.
export function osmTileRect(tile, projection) {
  const nw = tileToGeo(tile.z, tile.x, tile.y);
  const se = tileToGeo(tile.z, tile.x + 1, tile.y + 1);
  const a = projection.toLocal(nw.lat, nw.lng);
  const b = projection.toLocal(se.lat, se.lng);
  return { minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z };
}

// Ground meters per tile unit, at the tile's center latitude.
export function metersPerTileUnit(tile, extent) {
  const { lat } = tileToGeo(tile.z, tile.x + 0.5, tile.y + 0.5);
  return (EARTH_CIRCUMFERENCE_METERS * Math.cos((lat * Math.PI) / 180)) / 2 ** tile.z / extent;
}

// Tile units → world-local meters: project(px, py) returns { x, z } (a
// shared scratch object — copy what you keep).
export function createTileProjector(tile, extent, projection) {
  const out = { x: 0, z: 0 };
  return function project(px, py) {
    const geo = tileToGeo(tile.z, tile.x + px / extent, tile.y + py / extent);
    const local = projection.toLocal(geo.lat, geo.lng);
    out.x = local.x;
    out.z = local.z;
    return out;
  };
}

function distanceToRect(x, z, rect) {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

// The tiles within `corridorMeters` of a local polyline ({ x, z } points, the
// road centerline), in the order the route reaches them. While more than
// `maxTiles` would be needed the corridor shrinks; if even the tiles the
// route itself crosses exceed the budget, the first `maxTiles` along the
// route are kept.
export function osmTilesForCorridor(points, projection, { zoom, corridorMeters, maxTiles }) {
  if (!points.length || maxTiles <= 0) return [];
  let corridor = Math.max(0, corridorMeters);
  for (;;) {
    const tiles = corridorTiles(points, projection, zoom, corridor);
    if (tiles.length <= maxTiles) return tiles;
    if (corridor < 1) return tiles.slice(0, maxTiles);
    corridor = corridor < 50 ? 0 : corridor * 0.7;
  }
}

function corridorTiles(points, projection, zoom, corridor) {
  const seen = new Set();
  const tiles = [];
  const rects = new Map();
  // Probe along the line at most a quarter tile apart so no tile the
  // corridor touches is stepped over.
  const tileMeters = (EARTH_CIRCUMFERENCE_METERS * Math.cos((projection.origin.lat * Math.PI) / 180)) / 2 ** zoom;
  const step = Math.max(10, Math.min(tileMeters / 4, Math.max(corridor, tileMeters / 8)));
  const visit = (x, z) => {
    const a = projection.toGeo(x - corridor, z - corridor);
    const b = projection.toGeo(x + corridor, z + corridor);
    const t0 = geoToTile(zoom, a.lat, a.lng);
    const t1 = geoToTile(zoom, b.lat, b.lng);
    for (let ty = Math.floor(t0.y); ty <= Math.floor(t1.y); ty++) {
      for (let tx = Math.floor(t0.x); tx <= Math.floor(t1.x); tx++) {
        const key = `${tx}/${ty}`;
        if (seen.has(key)) continue;
        let rect = rects.get(key);
        if (!rect) rects.set(key, (rect = osmTileRect({ z: zoom, x: tx, y: ty }, projection)));
        if (distanceToRect(x, z, rect) > corridor) continue;
        seen.add(key);
        tiles.push({ z: zoom, x: tx, y: ty });
      }
    }
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    visit(p.x, p.z);
    const next = points[i + 1];
    if (!next) break;
    const length = Math.hypot(next.x - p.x, next.z - p.z);
    const steps = Math.floor(length / step);
    for (let s = 1; s <= steps; s++) {
      const t = (s * step) / length;
      if (t < 1) visit(p.x + (next.x - p.x) * t, p.z + (next.z - p.z) * t);
    }
  }
  return tiles;
}

// virtual_world.osm.ground → class lookup. `index(name)` gives a class's
// index (its priority: lower wins), `classify(layer, properties)` the class
// of a landcover/landuse feature (landcover subclass before class), or -1.
export function createGroundClasses(groundConfig) {
  const names = groundConfig.map((entry) => entry.name);
  const byOsm = new Map();
  groundConfig.forEach((entry, index) => {
    for (const osm of entry.match ?? []) if (!byOsm.has(osm)) byOsm.set(osm, index);
  });
  const lookup = (value) => (value === undefined || value === null ? -1 : byOsm.get(String(value)) ?? -1);
  return {
    names,
    count: names.length,
    index(name) {
      return names.indexOf(name);
    },
    classify(layer, properties) {
      if (layer === "landcover") {
        const sub = lookup(properties.subclass);
        return sub >= 0 ? sub : lookup(properties.class);
      }
      if (layer === "landuse") return lookup(properties.class);
      return -1;
    },
  };
}

const ROAD_KINDS = {
  motorway: "major", trunk: "major", primary: "major", secondary: "major", tertiary: "major", raceway: "major",
  minor: "minor", service: "minor", busway: "minor",
  track: "path", path: "path",
};

// One decoded tile → { extent, areas, water, buildings, roads, waterways }:
//   areas:     [{ cls, polygons }]           land use / land cover (raster)
//   water:     [{ still, ocean, polygons }]  water areas, clipped
//   buildings: [{ rings, height, minHeight }]
//   roads:     [{ points, width, kind, bridge }]   kind: major | minor | path
//   waterways: [{ points, width }]
// all in tile units. `terrain` (world-terrain.mjs) tells where the route's
// road is (de-duplication, path and building clearance); `roadHalfWidth` is
// the route road bed's half width.
export function extractOsmTile(layers, tile, { projection, terrain, config, classes, roadHalfWidth }) {
  const extent = firstExtent(layers);
  const unit = metersPerTileUnit(tile, extent);
  const project = createTileProjector(tile, extent, projection);
  const scratch = {};
  const routeDistance = (px, py) => {
    const p = project(px, py);
    return terrain.sample(p.x, p.z, scratch);
  };
  const result = { extent, areas: [], water: [], buildings: [], roads: [], waterways: [] };

  for (const layerName of ["landcover", "landuse"]) {
    for (const feature of layers[layerName]?.features ?? []) {
      if (feature.type !== 3) continue;
      const cls = classes.classify(layerName, feature.properties);
      if (cls >= 0 && feature.geometry.length) result.areas.push({ cls, polygons: feature.geometry });
    }
  }

  const stillClasses = new Set(config.water.still_classes);
  for (const feature of layers.water?.features ?? []) {
    if (feature.type !== 3 || feature.properties.brunnel === "tunnel") continue;
    const polygons = feature.geometry
      .map((polygon) => polygon.map((ring) => clipRing(ring, extent)).filter((ring) => ring.length >= 6))
      .filter((polygon) => polygon.length && ringArea(polygon[0]) > 0);
    if (!polygons.length) continue;
    const cls = String(feature.properties.class ?? "");
    result.water.push({ still: stillClasses.has(cls), ocean: cls === "ocean", polygons });
  }

  const buildingConfig = config.buildings;
  const clearance = roadHalfWidth + buildingConfig.road_clearance_meters;
  for (const feature of layers.building?.features ?? []) {
    if (feature.type !== 3 || feature.properties.hide_3d === true || feature.properties.hide_3d === "true") continue;
    const height = Math.max(buildingConfig.min_height_meters, Number(feature.properties.render_height) || 0);
    const minHeight = Math.max(0, Number(feature.properties.render_min_height) || 0);
    if (minHeight >= height) continue;
    for (const rings of feature.geometry) {
      if (!ownsPolygon(rings[0], extent)) continue;
      if (touchesRoute(rings[0], routeDistance, clearance)) continue;
      result.buildings.push({ rings, height, minHeight });
    }
  }

  const roads = config.roads;
  const step = roads.resample_meters / unit;
  for (const feature of layers.transportation?.features ?? []) {
    if (feature.type !== 2) continue;
    const { brunnel, ramp } = feature.properties;
    if (brunnel === "tunnel") continue;
    const cls = String(feature.properties.class ?? "").replace(/_construction$/, "");
    const width = roads.widths[cls];
    if (!(width > 0)) continue;
    const kind = ROAD_KINDS[cls] ?? "minor";
    for (const line of feature.geometry) {
      for (const piece of clipLine(line, extent)) {
        const points = resampleLine(piece, step);
        const keep = (px, py, dx, dy) => {
          const ground = routeDistance(px, py);
          if (kind === "path" && ground.roadDistance > roads.path_max_route_distance_meters) return false;
          if (ground.roadDistance > roads.route_overlap_meters + width / 2) return true;
          // Along the route's road (in either direction) = the route itself.
          const length = Math.hypot(dx, dy) || 1;
          const along = Math.abs((dx * ground.roadDirX + dy * ground.roadDirZ) / length);
          return along < roads.route_parallel_cos;
        };
        for (const run of filterRuns(points, keep)) {
          result.roads.push({ points: run, width, kind, bridge: brunnel === "bridge" && !ramp });
        }
      }
    }
  }

  for (const feature of layers.waterway?.features ?? []) {
    if (feature.type !== 2 || feature.properties.brunnel === "tunnel") continue;
    const width = config.waterways.widths[String(feature.properties.class ?? "")];
    if (!(width > 0)) continue;
    for (const line of feature.geometry) {
      for (const piece of clipLine(line, extent)) {
        result.waterways.push({ points: resampleLine(piece, step), width });
      }
    }
  }
  return result;
}

function firstExtent(layers) {
  for (const layer of Object.values(layers)) if (layer?.extent) return layer.extent;
  return 4096;
}

// Twice the signed area of a flat ring (positive = exterior, y down).
export function ringArea(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) sum += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return sum;
}

// A polygon belongs to the tile its bounding-box center lies in, so a
// building in two tiles' buffers is drawn once.
function ownsPolygon(ring, extent) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return cx >= 0 && cx < extent && cy >= 0 && cy < extent;
}

function touchesRoute(ring, routeDistance, clearance) {
  let sx = 0; let sy = 0;
  for (let i = 0; i < ring.length; i += 2) {
    if (routeDistance(ring[i], ring[i + 1]).roadDistance < clearance) return true;
    sx += ring[i]; sy += ring[i + 1];
  }
  const n = ring.length / 2;
  return routeDistance(sx / n, sy / n).roadDistance < clearance;
}

// A ring clipped to the square [0, extent]² (Sutherland–Hodgman). Concave
// rings may come back with edges running along the border; triangulation and
// rasterization handle those.
export function clipRing(ring, extent) {
  let points = ring;
  const edges = [
    (x, y) => x >= 0, (x, y) => x <= extent, (x, y) => y >= 0, (x, y) => y <= extent,
  ];
  const cut = [
    (ax, ay, bx, by) => [0, ay + ((by - ay) * (0 - ax)) / (bx - ax)],
    (ax, ay, bx, by) => [extent, ay + ((by - ay) * (extent - ax)) / (bx - ax)],
    (ax, ay, bx, by) => [ax + ((bx - ax) * (0 - ay)) / (by - ay), 0],
    (ax, ay, bx, by) => [ax + ((bx - ax) * (extent - ay)) / (by - ay), extent],
  ];
  for (let e = 0; e < 4 && points.length >= 6; e++) {
    const inside = edges[e];
    const out = [];
    const n = points.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + n - 2) % n;
      const ax = points[j]; const ay = points[j + 1];
      const bx = points[i]; const by = points[i + 1];
      const aIn = inside(ax, ay);
      const bIn = inside(bx, by);
      if (bIn) {
        if (!aIn) out.push(...cut[e](ax, ay, bx, by));
        out.push(bx, by);
      } else if (aIn) out.push(...cut[e](ax, ay, bx, by));
    }
    points = out;
  }
  return points;
}

// A line clipped to the square [0, extent]² → the pieces inside
// (Liang–Barsky per segment).
export function clipLine(line, extent) {
  const pieces = [];
  let current = null;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]; const ay = line[i + 1]; const bx = line[i + 2]; const by = line[i + 3];
    const dx = bx - ax; const dy = by - ay;
    let t0 = 0; let t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [ax, extent - ax, ay, extent - ay];
    let visible = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) { visible = false; break; }
      } else {
        const r = q[k] / p[k];
        if (p[k] < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!visible || t0 > t1) {
      current = null;
      continue;
    }
    const sx = ax + dx * t0; const sy = ay + dy * t0;
    const ex = ax + dx * t1; const ey = ay + dy * t1;
    if (!current || t0 > 0) {
      current = [sx, sy];
      pieces.push(current);
    }
    current.push(ex, ey);
    if (t1 < 1) current = null;
  }
  return pieces.filter((piece) => piece.length >= 4);
}

// A flat line resampled so no two points are more than `step` apart (the
// original vertices are kept).
export function resampleLine(line, step) {
  const out = [line[0], line[1]];
  for (let i = 2; i < line.length; i += 2) {
    const ax = line[i - 2]; const ay = line[i - 1]; const bx = line[i]; const by = line[i + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let s = 1; s < steps; s++) out.push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
    out.push(bx, by);
  }
  return out;
}

// The runs of consecutive points `keep(x, y, dx, dy)` accepts (dx/dy = the
// local direction there), each at least two points long.
function filterRuns(points, keep) {
  const runs = [];
  let run = null;
  const n = points.length / 2;
  for (let k = 0; k < n; k++) {
    const x = points[k * 2]; const y = points[k * 2 + 1];
    const a = Math.max(0, k - 1); const b = Math.min(n - 1, k + 1);
    const ok = keep(x, y, points[b * 2] - points[a * 2], points[b * 2 + 1] - points[a * 2 + 1]);
    if (ok) {
      if (!run) runs.push((run = []));
      run.push(x, y);
    } else run = null;
  }
  return runs.filter((r) => r.length >= 4);
}
