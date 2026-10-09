// Module Web Worker that builds terrain tiles for world-tile-manager.mjs off
// the main thread (a tile costs ~5–15 ms, too much to pay mid-frame while
// riding). It rebuilds the same deterministic height field and surface from
// the route it is sent, then answers tile requests with transferable arrays.
// For a real-world style it first fetches and decodes the elevation tiles
// covering the world and sends them to the main thread too, so both sides
// shape the ground from the same data. Tile requests wait until that is done.
// Then it streams the OpenStreetMap tiles of the route's corridor (nearest to
// the camera first) without blocking tile requests: each one that arrives is
// rasterized into the ground classes (colors, trees, water carve) and
// announced, and the main thread rebuilds the terrain tiles it covers and
// asks for its building/road/water meshes when the camera comes near.
// For a city theme (ground: "city", offline) each tile also carries its
// buildings (world-city.mjs): all of them on near tiles, the skyline on
// farther ones.
//
// Only relative imports here (and in everything imported): module workers
// don't see the page's import map.
//
// Messages in:  { type: "world", worldId, route, config, terrain, trees, ground, demBaseUrl }
//               { type: "tile", worldId, key, rect }
//               { type: "focus", worldId, x, z }        (camera, for the OSM queue)
//               { type: "osm-mesh", worldId, key }
// Messages out: { type: "dem", worldId, tiles }   (real-world styles only)
//               { type: "tile", worldId, key, tile }  (tile.osmVersion = OSM tiles applied)
//               { type: "osm-tile", worldId, key, rect, version }
//               { type: "osm-mesh", worldId, key, meshes }

import { BUILDING_STRIDE, createCity } from "./world-city.mjs";
import { createDem, demTilesForBox } from "./world-dem.mjs";
import { loadDemTiles } from "./world-dem-loader.mjs";
import { decodeMvt } from "./world-mvt.mjs";
import { createGroundClasses, extractOsmTile, osmTileKey, osmTileRect, osmTilesForCorridor } from "./world-osm.mjs";
import { createOsmLoader } from "./world-osm-loader.mjs";
import { buildOsmMeshes } from "./world-osm-meshes.mjs";
import { createOsmGround, rasterizeOsmTile } from "./world-osm-raster.mjs";
import { createSurface } from "./world-surface.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";
import { buildTileArrays } from "./world-tiles.mjs";

const OSM_LAYERS = ["landcover", "landuse", "water", "waterway", "building", "transportation"];

let world = null;

self.onmessage = async ({ data }) => {
  if (data.type === "world") {
    world?.osmLoader?.abort();
    const current = { id: data.worldId, config: data.config, trees: data.trees, ground: data.ground, focus: { x: 0, z: 0 } };
    world = current;
    current.ready = prepareWorld(current, data);
    return;
  }
  if (!world || data.worldId !== world.id) return;
  const current = world;
  if (data.type === "focus") {
    current.focus = { x: data.x, z: data.z };
    current.osmLoader?.setFocus(data.x, data.z);
    return;
  }
  await current.ready;
  if (world !== current) return;
  if (data.type === "tile") postTile(current, data);
  else if (data.type === "osm-mesh") postOsmMesh(current, data.key);
};

function postTile(current, data) {
  const tiles = current.config.tiles;
  const tile = buildTileArrays(current.terrain, current.surface, data.rect, {
    segments: tiles.segments,
    skirtFactor: tiles.skirt_factor,
    treeMaxTileMeters: current.trees ? tiles.tree_max_tile_meters : 0,
    roadClearSteps: tiles.road_clear_steps,
  });
  tile.buildings = current.city ? tileBuildings(current, data.rect, tile) : new Float32Array(0);
  tile.osmVersion = current.osmGround?.version ?? 0;
  self.postMessage(
    { type: "tile", worldId: current.id, key: data.key, tile },
    [tile.positions.buffer, tile.normals.buffer, tile.colors.buffer, tile.indices.buffer, tile.trees.buffer, tile.buildings.buffer],
  );
}

async function prepareWorld(current, data) {
  const config = data.config;
  const terrainConfig = config.terrain;
  const real = data.terrain === "real" && data.route.length > 0;
  let terrain = createWorldTerrain(data.route, terrainConfig);
  let dem = null;
  if (real) {
    const tiles = demTilesForBox(geoBox(terrain), {
      maxZoom: terrainConfig.real.max_zoom,
      maxTiles: terrainConfig.real.max_tiles,
      tileSize: 256,
    });
    const loaded = (await loadDemTiles(tiles, { baseUrl: data.demBaseUrl })).filter(Boolean);
    if (world !== current) return;
    dem = createDem(loaded);
    if (dem) self.postMessage({ type: "dem", worldId: current.id, tiles: loaded });
  }
  let osm = null;
  if (real && config.osm) {
    current.osmClasses = createGroundClasses(config.osm.ground);
    current.osmGround = createOsmGround(terrain.projection, {
      zoom: config.osm.zoom,
      cells: config.osm.raster_cells,
      unclassified: current.osmClasses.index("unclassified"),
    });
    current.osmTiles = new Map();
    osm = { ground: current.osmGround, classes: config.osm.ground };
  }
  if (dem || osm) {
    terrain = createWorldTerrain(data.route, terrainConfig, {
      dem,
      osm: current.osmGround,
      waterCarveMeters: config.osm?.water.carve_meters ?? 0,
    });
  }
  current.terrain = terrain;
  // The synthetic town is the offline city look; real-world styles have OSM.
  current.city = data.ground === "city" && !real ? createCity(terrain, config.city) : null;
  current.surface = createSurface(terrain, config.surface, { city: current.city, osm });
  if (osm) startOsm(current);
}

// Stream the corridor's OSM tiles; each arrival updates the ground sampler
// in place (terrain + surface read it live) and is announced.
function startOsm(current) {
  const config = current.config.osm;
  const { terrain } = current;
  const tiles = osmTilesForCorridor(terrain.samples, terrain.projection, {
    zoom: config.zoom,
    corridorMeters: config.corridor_meters,
    maxTiles: config.max_tiles,
  }).map((tile) => {
    const rect = osmTileRect(tile, terrain.projection);
    return { ...tile, rect, center: { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 } };
  });
  current.osmLoader = createOsmLoader({
    tilejsonUrl: config.tilejson_url,
    concurrency: config.concurrency,
    onError: (error) => console.warn("[virtual-world] OSM source unavailable", error),
    onTile: (tile, bytes) => {
      if (world !== current || !bytes) return;
      try {
        applyOsmTile(current, tile, bytes);
      } catch (error) {
        console.warn("[virtual-world] OSM tile could not be used", tile, error);
      }
    },
  });
  current.osmLoader.setFocus(current.focus.x, current.focus.z);
  current.osmLoader.start(tiles);
}

function applyOsmTile(current, tile, bytes) {
  const config = current.config.osm;
  const { terrain } = current;
  const layers = decodeMvt(bytes, { layers: OSM_LAYERS });
  const extracted = extractOsmTile(layers, tile, {
    projection: terrain.projection,
    terrain,
    config,
    classes: current.osmClasses,
    roadHalfWidth: current.config.terrain.road_half_width_meters,
  });
  const raster = rasterizeOsmTile(extracted, tile, { cells: config.raster_cells, groundClasses: current.osmClasses });
  current.osmGround.addTile(tile, raster);
  const key = osmTileKey(tile);
  current.osmTiles.set(key, { tile, extracted });
  self.postMessage({ type: "osm-tile", worldId: current.id, key, rect: tile.rect, version: current.osmGround.version });
}

function postOsmMesh(current, key) {
  const entry = current.osmTiles?.get(key);
  if (!entry) return;
  const meshes = buildOsmMeshes(entry.extracted, entry.tile, {
    projection: current.terrain.projection,
    terrain: current.terrain,
    config: current.config.osm,
    seed: current.terrain.seed,
  });
  const transfer = [];
  for (const group of [meshes.buildings, meshes.ribbons, meshes.water]) {
    for (const array of Object.values(group)) transfer.push(array.buffer);
  }
  self.postMessage({ type: "osm-mesh", worldId: current.id, key, meshes }, transfer);
}

// A tile's buildings relative to its center (see BUILDING_STRIDE).
function tileBuildings(current, rect, tile) {
  const city = current.config.city;
  if (rect.size > city.skyline_max_tile_meters) return new Float32Array(0);
  const minHeight = rect.size > city.full_max_tile_meters ? city.skyline_min_height_meters : 0;
  const placed = current.city.placeBuildings(rect.x0, rect.z0, rect.size, { minHeight });
  const data = new Float32Array(placed.data);
  for (let k = 0; k < placed.count; k++) {
    data[k * BUILDING_STRIDE] -= tile.cx;
    data[k * BUILDING_STRIDE + 2] -= tile.cz;
  }
  return data;
}

// The world's local bounds as a lat/lng box.
function geoBox(terrain) {
  const { bounds, projection } = terrain;
  const nw = projection.toGeo(bounds.minX, bounds.minZ);
  const se = projection.toGeo(bounds.maxX, bounds.maxZ);
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}
