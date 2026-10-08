// What covers the virtual world's ground: per-vertex biome colors (meadow,
// fields, forest floor, rock on steep slopes, snow above the snowline, sand at
// lake shores, gravel along the road) and the deterministic scatter of trees.
// Pure — reads the height field from world-terrain.mjs and returns plain
// numbers, so it runs in the tile worker as well as in tests.

import { cellRandom, createNoise2D, fbm } from "./world-noise.mjs";
import { smoothstep } from "./world-terrain.mjs";

// sRGB hex → linear RGB triple (three.js vertex colors are linear).
export function hexToLinear(hex) {
  const value = parseInt(String(hex).replace("#", ""), 16);
  return [16, 8, 0].map((shift) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

function mix(out, color, amount) {
  if (amount <= 0) return;
  const t = Math.min(1, amount);
  out[0] += (color[0] - out[0]) * t;
  out[1] += (color[1] - out[1]) * t;
  out[2] += (color[2] - out[2]) * t;
}

// Mix toward a blend of two colors (t = 0 → a, 1 → b).
function mixPair(out, a, b, t, amount) {
  mix(out, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], amount);
}

export function createSurface(terrain, config) {
  const palette = Object.fromEntries(Object.entries(config.colors).map(([name, hex]) => [name, hexToLinear(hex)]));
  const forestNoise = createNoise2D(terrain.seed ^ 0x51ed270b);
  const fieldNoise = createNoise2D(terrain.seed ^ 0x2545f491);
  const detailNoise = createNoise2D(terrain.seed ^ 0x6c8e9cf5);
  const trees = config.trees;
  const scratch = {};

  // 0..1 forest cover at (x, z): broad patches of woodland with clearings,
  // none above the treeline, under water, on cliffs or on the road.
  function forestDensity(x, z, height, slope, roadDistance) {
    const patches = fbm(forestNoise, x / config.forest_patch_meters, z / config.forest_patch_meters, 4);
    let density = smoothstep(config.forest_threshold - 0.15, config.forest_threshold + 0.15, patches);
    const treeline = config.treeline_meters + 120 * detailNoise(x / 700, z / 700);
    density *= 1 - smoothstep(treeline - 150, treeline, height);
    density *= 1 - smoothstep(0.45, 0.6, slope);
    density *= smoothstep(terrain.waterLevel + 1, terrain.waterLevel + 4, height);
    density *= smoothstep(trees.road_clearance_meters, trees.road_clearance_meters * 2.5, roadDistance);
    return density;
  }

  // The ground color at a vertex. `slope` is 1 - normal.y (0 flat, ~1 cliff).
  function colorAt(x, z, ground, slope, out) {
    const { height, roadDistance, alpine } = ground;
    const variation = detailNoise(x / 90, z / 90) * 0.5 + 0.5;
    const meadowBlend = 0.35 + 0.65 * variation;
    out[0] = palette.meadow_dark[0] + (palette.meadow_light[0] - palette.meadow_dark[0]) * meadowBlend;
    out[1] = palette.meadow_dark[1] + (palette.meadow_light[1] - palette.meadow_dark[1]) * meadowBlend;
    out[2] = palette.meadow_dark[2] + (palette.meadow_light[2] - palette.meadow_dark[2]) * meadowBlend;

    // Farm fields: patchy, only on gentle low ground.
    const field = fbm(fieldNoise, x / config.field_patch_meters, z / config.field_patch_meters, 2);
    const fieldAmount = smoothstep(0.25, 0.35, field) * (1 - smoothstep(0.05, 0.12, slope)) * (1 - alpine);
    // Blend the paired colors by the variation noise rather than switching per
    // vertex: a hard switch draws jagged hatching on coarse tiles.
    mixPair(out, palette.field_a, palette.field_b, variation, fieldAmount * 0.85);

    mix(out, palette.forest, forestDensity(x, z, height, slope, roadDistance) * 0.9);

    // Alpine pasture fades toward bare rock high up, rock on steep slopes.
    mix(out, palette.alpine, alpine * smoothstep(config.treeline_meters - 200, config.treeline_meters + 300, height) * 0.7);
    const rockSlope = smoothstep(config.rock_slope - 0.12, config.rock_slope + 0.08, slope + alpine * 0.08);
    mixPair(out, palette.rock, palette.rock_dark, variation, rockSlope);

    const snowline = config.snowline_meters + 150 * detailNoise(x / 400, z / 400);
    mix(out, palette.snow, smoothstep(snowline - 60, snowline + 60, height) * (1 - smoothstep(0.55, 0.75, slope)));

    mix(out, palette.sand, 1 - smoothstep(terrain.waterLevel + 0.5, terrain.waterLevel + 3, height));
    mix(out, palette.shoulder, 1 - smoothstep(config.shoulder_meters * 0.5, config.shoulder_meters, roadDistance));
    return out;
  }

  // Trees for one square tile [x0, x0 + size] × [z0, z0 + size]: a jittered
  // grid on the world's global lattice (so a tile split never moves a tree),
  // kept by the local forest density plus a few lone meadow trees.
  // Returns { count, data } with 6 floats per tree: x, y, z, scale,
  // rotation (rad), kind (0 conifer, 1 broadleaf).
  function placeTrees(x0, z0, size) {
    const spacing = trees.spacing_meters;
    const i0 = Math.ceil(x0 / spacing);
    const j0 = Math.ceil(z0 / spacing);
    const i1 = Math.floor((x0 + size) / spacing - 1e-9);
    const j1 = Math.floor((z0 + size) / spacing - 1e-9);
    const data = [];
    const seed = terrain.seed;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const keep = cellRandom(seed, i, j, 0);
        // Neither a full forest nor a lone tree could keep this cell: skip it
        // before paying for a height sample.
        if (keep >= Math.max(trees.forest_fill, trees.lone_tree_chance)) continue;
        const x = (i + (cellRandom(seed, i, j, 1) - 0.5) * 0.9) * spacing;
        const z = (j + (cellRandom(seed, i, j, 2) - 0.5) * 0.9) * spacing;
        const ground = terrain.sample(x, z, scratch);
        if (ground.roadDistance < trees.road_clearance_meters) continue;
        const slope = slopeAt(x, z, ground.height);
        const density = forestDensity(x, z, ground.height, slope, ground.roadDistance);
        const lone = trees.lone_tree_chance * smoothstep(terrain.waterLevel + 2, terrain.waterLevel + 4, ground.height)
          * (1 - smoothstep(0.3, 0.45, slope))
          * (1 - smoothstep(config.treeline_meters - 100, config.treeline_meters, ground.height));
        if (keep >= Math.max(density * trees.forest_fill, lone)) continue;
        const high = smoothstep(config.treeline_meters - 900, config.treeline_meters - 300, ground.height);
        const conifer = cellRandom(seed, i, j, 3) < trees.conifer_share + (1 - trees.conifer_share) * high;
        const scale = trees.min_scale + (trees.max_scale - trees.min_scale) * cellRandom(seed, i, j, 4);
        data.push(x, ground.height, z, scale, cellRandom(seed, i, j, 5) * Math.PI * 2, conifer ? 0 : 1);
      }
    }
    return { count: data.length / 6, data };
  }

  function slopeAt(x, z, height) {
    const step = 4;
    const hx = terrain.heightAt(x + step, z) - height;
    const hz = terrain.heightAt(x, z + step) - height;
    const ny = step / Math.sqrt(hx * hx + hz * hz + step * step);
    return 1 - ny;
  }

  return { colorAt, forestDensity, placeTrees };
}
