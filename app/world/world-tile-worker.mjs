// Module Web Worker that builds terrain tiles for world-tile-manager.mjs off
// the main thread (a tile costs ~5–15 ms, too much to pay mid-frame while
// riding). It rebuilds the same deterministic height field and surface from
// the route it is sent, then answers tile requests with transferable arrays.
// For a real-terrain style it first fetches and decodes the elevation tiles
// covering the world and sends them to the main thread too, so both sides
// shape the ground from the same data. Tile requests wait until that is done.
//
// Messages in:  { type: "world", worldId, route, config, terrain, trees, demBaseUrl }
//               { type: "tile", worldId, key, rect }
// Messages out: { type: "dem", worldId, tiles }   (real terrain only)
//               { type: "tile", worldId, key, tile }

import { createDem, demTilesForBox } from "./world-dem.mjs";
import { loadDemTiles } from "./world-dem-loader.mjs";
import { createSurface } from "./world-surface.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";
import { buildTileArrays } from "./world-tiles.mjs";

let world = null;

self.onmessage = async ({ data }) => {
  if (data.type === "world") {
    const current = { id: data.worldId, config: data.config, trees: data.trees };
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
    self.postMessage(
      { type: "tile", worldId: current.id, key: data.key, tile },
      [tile.positions.buffer, tile.normals.buffer, tile.colors.buffer, tile.indices.buffer, tile.trees.buffer],
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
  current.surface = createSurface(terrain, data.config.surface);
}

// The world's local bounds as a lat/lng box.
function geoBox(terrain) {
  const { bounds, projection } = terrain;
  const nw = projection.toGeo(bounds.minX, bounds.minZ);
  const se = projection.toGeo(bounds.maxX, bounds.maxZ);
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}
