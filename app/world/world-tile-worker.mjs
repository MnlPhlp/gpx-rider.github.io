// Module Web Worker that builds terrain tiles for world-tile-manager.mjs off
// the main thread (a tile costs ~5–15 ms, too much to pay mid-frame while
// riding). It rebuilds the same deterministic height field and surface from
// the route it is sent, then answers tile requests with transferable arrays.
// For a real-terrain style it first fetches and decodes the elevation tiles
// covering the world and sends them to the main thread too, so both sides
// shape the ground from the same data. Tile requests wait until that is done.
// For a city theme (ground: "city") each tile also carries its buildings
// (world-city.mjs): all of them on near tiles, the skyline on farther ones.
//
// Messages in:  { type: "world", worldId, route, config, terrain, trees, ground, demBaseUrl }
//               { type: "tile", worldId, key, rect }
// Messages out: { type: "dem", worldId, tiles }   (real terrain only)
//               { type: "tile", worldId, key, tile }

import { BUILDING_STRIDE, createCity } from "./world-city.mjs";
import { createDem, demTilesForBox } from "./world-dem.mjs";
import { loadDemTiles } from "./world-dem-loader.mjs";
import { createSurface } from "./world-surface.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";
import { buildTileArrays } from "./world-tiles.mjs";

let world = null;

self.onmessage = async ({ data }) => {
  if (data.type === "world") {
    const current = { id: data.worldId, config: data.config, trees: data.trees, ground: data.ground };
    world = current;
    current.ready = prepareWorld(current, data);
    return;
  }
  if (data.type === "tile" && world && data.worldId === world.id) {
    const current = world;
    await current.ready;
    if (world !== current) return;
    const tiles = current.config.tiles;
    const tile = buildTileArrays(current.terrain, current.surface, data.rect, {
      segments: tiles.segments,
      skirtFactor: tiles.skirt_factor,
      treeMaxTileMeters: current.trees ? tiles.tree_max_tile_meters : 0,
    });
    tile.buildings = current.city ? tileBuildings(current, data.rect, tile) : new Float32Array(0);
    self.postMessage(
      { type: "tile", worldId: current.id, key: data.key, tile },
      [tile.positions.buffer, tile.normals.buffer, tile.colors.buffer, tile.indices.buffer, tile.trees.buffer, tile.buildings.buffer],
    );
  }
};

async function prepareWorld(current, data) {
  const terrainConfig = data.config.terrain;
  let terrain = createWorldTerrain(data.route, terrainConfig);
  if (data.terrain === "real" && data.route.length) {
    const tiles = demTilesForBox(geoBox(terrain), {
      maxZoom: terrainConfig.real.max_zoom,
      maxTiles: terrainConfig.real.max_tiles,
      tileSize: 256,
    });
    const loaded = (await loadDemTiles(tiles, { baseUrl: data.demBaseUrl })).filter(Boolean);
    if (world !== current) return;
    const dem = createDem(loaded);
    if (dem) {
      terrain = createWorldTerrain(data.route, terrainConfig, { dem });
      self.postMessage({ type: "dem", worldId: current.id, tiles: loaded });
    }
  }
  current.terrain = terrain;
  current.city = data.ground === "city" ? createCity(terrain, data.config.city) : null;
  current.surface = createSurface(terrain, data.config.surface, { city: current.city });
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
