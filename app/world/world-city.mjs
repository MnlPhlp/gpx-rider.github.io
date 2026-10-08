// The city look's layout (virtual_world.city in tuning.yaml): where the town
// is (an urban band along the route that fades into countryside), its parks,
// and its buildings. Pure — the tile worker places buildings per terrain tile
// and world-surface.mjs paints the ground from urbanAt/parkAt.
//
// Buildings sit on a global square lattice (so a tile split never moves one)
// with at most one per cell; a footprint's diagonal never exceeds the cell
// minus the street gap, so neighbors can't overlap at any rotation. Near the
// road they turn to face it; farther out they follow a slowly varying
// district angle. A low-frequency "downtown" field sets their heights —
// houses on the outskirts, towers in the center — and cells on steep ground,
// in parks or on the road stay empty.

import { cellRandom, createNoise2D, fbm } from "./world-noise.mjs";
import { smoothstep } from "./world-terrain.mjs";

// Floats per placed building: x, y (base), z, width, depth, height,
// rotation (radians about the vertical), facade color index.
export const BUILDING_STRIDE = 8;

export function createCity(terrain, config) {
  const seed = terrain.seed ^ 0x3c6ef372;
  const districtNoise = createNoise2D(seed);
  const parkNoise = createNoise2D(seed ^ 0x1b873593);
  const angleNoise = createNoise2D(seed ^ 0x85ebca6b);
  const ground = {};
  const corner = {};

  // 0..1: how built-up the land at (x, z) is — full within urban_radius of
  // the road, fading out over urban_fade, with ragged district edges.
  function urbanAt(x, z, roadDistance) {
    const edge = fbm(districtNoise, x / config.district_meters, z / config.district_meters, 3) * config.urban_fade_meters;
    return 1 - smoothstep(config.urban_radius_meters, config.urban_radius_meters + config.urban_fade_meters, roadDistance + edge);
  }

  // 0..1 park cover (green, wooded, no buildings).
  function parkAt(x, z) {
    const n = fbm(parkNoise, x / config.park_patch_meters, z / config.park_patch_meters, 3);
    return smoothstep(config.park_threshold - 0.08, config.park_threshold + 0.08, n);
  }

  // 0..1 downtown-ness: the tallest buildings where this peaks.
  function downtownAt(x, z) {
    const n = fbm(districtNoise, x / config.downtown_meters + 31.7, z / config.downtown_meters - 12.9, 2);
    return Math.min(1, Math.max(0, n * 0.5 + 0.5));
  }

  // The buildings whose lattice cell centers fall inside the square tile.
  // `minHeight` > 0 keeps only those at least that tall (the skyline coarse,
  // distant tiles show).
  function placeBuildings(x0, z0, size, { minHeight = 0 } = {}) {
    const spacing = config.block_meters;
    const maxDiagonal = spacing - config.street_gap_meters;
    const i0 = Math.ceil(x0 / spacing - 0.5);
    const j0 = Math.ceil(z0 / spacing - 0.5);
    const i1 = Math.floor((x0 + size) / spacing - 0.5 - 1e-9);
    const j1 = Math.floor((z0 + size) / spacing - 0.5 - 1e-9);
    const data = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * spacing;
        const z = (j + 0.5) * spacing;
        // Cheap checks first: the height and the occupancy roll need only noise.
        // Low-rise everywhere; only where the downtown field peaks does it
        // climb (squared, so towers stay a small center).
        const tall = smoothstep(config.downtown_from, 1, downtownAt(x, z)) ** 2;
        const height = (config.min_height_meters + (config.max_height_meters - config.min_height_meters) * tall)
          * (0.7 + 0.6 * cellRandom(seed, i, j, 0));
        if (height < minHeight) continue;
        if (cellRandom(seed, i, j, 1) > config.occupancy) continue;
        if (parkAt(x, z) > 0.5) continue;

        terrain.sample(x, z, ground);
        const urban = urbanAt(x, z, ground.roadDistance);
        if (cellRandom(seed, i, j, 2) >= urban) continue;

        // Footprint: wide houses and blocks, always within the cell's diagonal.
        const grow = 0.8 + 0.2 * tall;
        let width = (config.min_footprint_meters + (config.max_footprint_meters - config.min_footprint_meters) * cellRandom(seed, i, j, 3)) * grow;
        let depth = (config.min_footprint_meters + (config.max_footprint_meters - config.min_footprint_meters) * cellRandom(seed, i, j, 4)) * grow;
        const diagonal = Math.hypot(width, depth);
        if (diagonal > maxDiagonal) {
          width *= maxDiagonal / diagonal;
          depth *= maxDiagonal / diagonal;
        }
        if (ground.roadDistance < config.road_setback_meters + Math.hypot(width, depth) / 2) continue;

        // Face the road nearby, else the district's grid angle.
        let rotation = angleNoise(x / config.district_meters, z / config.district_meters) * Math.PI;
        if (ground.roadDistance < config.align_to_road_meters && (ground.roadDirX || ground.roadDirZ)) {
          rotation = Math.atan2(ground.roadDirX, ground.roadDirZ);
        }

        // Sit on the lowest corner (sunk a little) and skip steep ground, so a
        // building never floats or hangs over a slope.
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        let low = ground.height;
        let high = ground.height;
        for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
          const cx = x + u * width * cos + v * depth * sin;
          const cz = z - u * width * sin + v * depth * cos;
          const h = terrain.sample(cx, cz, corner).height;
          low = Math.min(low, h);
          high = Math.max(high, h);
        }
        if (high - low > config.max_ground_step_meters) continue;

        const palette = tall > config.tower_from ? 1 : 0;
        const colorIndex = palette * 16 + Math.floor(cellRandom(seed, i, j, 5) * 16);
        data.push(x, low - config.foundation_meters, z, width, depth, height + (high - low) + config.foundation_meters, rotation, colorIndex);
      }
    }
    return { count: data.length / BUILDING_STRIDE, data };
  }

  return { urbanAt, parkAt, downtownAt, placeBuildings, parkTreeDensity: config.park_tree_density };
}
