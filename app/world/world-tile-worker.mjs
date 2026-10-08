// Module Web Worker that builds terrain tiles for world-tile-manager.mjs off
// the main thread (a tile costs ~5–15 ms, too much to pay mid-frame while
// riding). It rebuilds the same deterministic height field and surface from
// the route it is sent, then answers tile requests with transferable arrays.
//
// Messages in:  { type: "world", worldId, route, config }
//               { type: "tile", worldId, key, rect }
// Messages out: { type: "tile", worldId, key, tile }

import { createSurface } from "./world-surface.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";
import { buildTileArrays } from "./world-tiles.mjs";

let world = null;

self.onmessage = ({ data }) => {
  if (data.type === "world") {
    const terrain = createWorldTerrain(data.route, data.config.terrain);
    world = {
      id: data.worldId,
      config: data.config,
      terrain,
      surface: createSurface(terrain, data.config.surface),
    };
    return;
  }
  if (data.type === "tile" && world && data.worldId === world.id) {
    const tiles = world.config.tiles;
    const tile = buildTileArrays(world.terrain, world.surface, data.rect, {
      segments: tiles.segments,
      skirtFactor: tiles.skirt_factor,
      treeMaxTileMeters: tiles.tree_max_tile_meters,
    });
    self.postMessage(
      { type: "tile", worldId: world.id, key: data.key, tile },
      [tile.positions.buffer, tile.normals.buffer, tile.colors.buffer, tile.indices.buffer, tile.trees.buffer],
    );
  }
};
