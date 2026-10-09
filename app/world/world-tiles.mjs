// Level of detail for the virtual world's terrain: a quadtree over the world
// square whose nodes split while the camera is close (chunked LOD), the
// display set that falls back to a loaded ancestor while finer tiles are still
// being built (so the ground never shows holes), and the mesh arrays of one
// tile — grid heights, normals, biome colors, the skirts that hide cracks
// between neighbors of different detail, and the tile's trees. Pure, so it
// runs in the tile worker and in tests.

export function createQuadtree(bounds, minTileMeters) {
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const maxLevel = Math.max(0, Math.floor(Math.log2(size / Math.max(1, minTileMeters))));
  return {
    x0: (bounds.minX + bounds.maxX) / 2 - size / 2,
    z0: (bounds.minZ + bounds.maxZ) / 2 - size / 2,
    size,
    maxLevel,
  };
}

export function nodeKey(level, i, j) {
  return `${level}/${i}/${j}`;
}

export function nodeRect(tree, level, i, j) {
  const size = tree.size / 2 ** level;
  return { x0: tree.x0 + i * size, z0: tree.z0 + j * size, size };
}

function makeNode(tree, level, i, j) {
  return { level, i, j, key: nodeKey(level, i, j), ...nodeRect(tree, level, i, j) };
}

// Horizontal distance from (x, z) to the square, 0 inside it.
function distanceToRect(x, z, rect) {
  const dx = Math.max(rect.x0 - x, 0, x - (rect.x0 + rect.size));
  const dz = Math.max(rect.z0 - z, 0, z - (rect.z0 + rect.size));
  return Math.hypot(dx, dz);
}

// The leaves to draw for a camera at { x, z, heightAboveGround }: a node
// splits while the camera is nearer than splitFactor × its size (times an
// optional per-node detailBoost, which the scene uses to refine tiles the
// route crosses so the floating route line never sinks into coarse ground).
export function selectLeaves(tree, camera, { splitFactor, detailBoost = null }) {
  const leaves = [];
  const height = Math.max(0, Number(camera.heightAboveGround) || 0);
  const visit = (level, i, j) => {
    const node = makeNode(tree, level, i, j);
    node.distance = Math.hypot(distanceToRect(camera.x, camera.z, node), height);
    const boost = detailBoost ? detailBoost(node) : 1;
    if (level < tree.maxLevel && node.distance < node.size * splitFactor * boost) {
      visit(level + 1, i * 2, j * 2);
      visit(level + 1, i * 2 + 1, j * 2);
      visit(level + 1, i * 2, j * 2 + 1);
      visit(level + 1, i * 2 + 1, j * 2 + 1);
      return;
    }
    leaves.push(node);
  };
  visit(0, 0, 0);
  return leaves;
}

// The nodes to actually draw: each wanted leaf that is ready; a leaf that is
// not ready yet but whose loaded descendants cover it (the camera moved away
// and the finer tiles drawn a moment ago are still cached) draws those; else
// the closest ready ancestor covers the whole family instead — never a mix of
// a parent and its children, which would overlap. Returns [] when nothing in
// the tree is ready.
const DESCENDANT_FALLBACK_LEVELS = 2;

export function resolveDisplay(tree, leaves, isReady) {
  const leafKeys = new Set(leaves.map((leaf) => leaf.key));
  // Ready descendants (at most DESCENDANT_FALLBACK_LEVELS down) tiling the
  // node exactly, or null.
  const descendants = (level, i, j, depth) => {
    if (depth >= DESCENDANT_FALLBACK_LEVELS || level >= tree.maxLevel) return null;
    const parts = [];
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const ci = i * 2 + di;
      const cj = j * 2 + dj;
      if (isReady(nodeKey(level + 1, ci, cj))) parts.push(makeNode(tree, level + 1, ci, cj));
      else {
        const deeper = descendants(level + 1, ci, cj, depth + 1);
        if (!deeper) return null;
        parts.push(...deeper);
      }
    }
    return parts;
  };
  const visit = (level, i, j) => {
    const key = nodeKey(level, i, j);
    if (leafKeys.has(key)) return isReady(key) ? [makeNode(tree, level, i, j)] : descendants(level, i, j, 0);
    if (level >= tree.maxLevel) return null;
    const parts = [];
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const part = visit(level + 1, i * 2 + di, j * 2 + dj);
      if (!part) return isReady(key) ? [makeNode(tree, level, i, j)] : null;
      parts.push(...part);
    }
    return parts;
  };
  return visit(0, 0, 0) ?? [];
}

// The keys of every ancestor of the given nodes: the fallback chain the
// display needs while a tile rebuilds, so the cache must not evict them.
export function protectedAncestors(nodes) {
  const keys = new Set();
  for (const node of nodes) {
    for (let level = node.level - 1, i = node.i >> 1, j = node.j >> 1; level >= 0; level--, i >>= 1, j >>= 1) {
      const key = nodeKey(level, i, j);
      if (keys.has(key)) break;
      keys.add(key);
    }
  }
  return keys;
}

// Every node down to `level` — the always-loaded coarse base the display
// falls back to before anything finer has been built.
export function baseNodes(tree, level) {
  const nodes = [];
  for (let l = 0; l <= Math.min(level, tree.maxLevel); l++) {
    const count = 2 ** l;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) nodes.push(makeNode(tree, l, i, j));
    }
  }
  return nodes;
}

// Mesh arrays for one tile. Positions are relative to the tile center
// (cx, cz) so float32 keeps centimeter precision anywhere in the world;
// heights stay absolute. Normals come from central differences over a
// one-vertex border ring, so neighboring tiles of the same detail shade
// seamlessly.
//
// The road bed is narrower than a coarse tile's grid step, so a triangle
// spanning the road would interpolate the hillside beside it over the
// asphalt. Every vertex within `roadClearSteps` grid steps (plus the road
// bed's half width) of the road is therefore capped at the road's elevation
// — ground is only ever lowered there, never raised — and skirts reach as
// deep as a tile two levels coarser could cut, so seams stay closed. Trees
// stand on the mesh as drawn, not on the finer height field.
export function buildTileArrays(terrain, surface, rect, { segments, skirtFactor, treeMaxTileMeters, roadClearSteps = 0 }) {
  const n = segments;
  const step = rect.size / n;
  const cx = rect.x0 + rect.size / 2;
  const cz = rect.z0 + rect.size / 2;
  const ring = n + 3;
  const heights = new Float64Array(ring * ring);
  const vertexCount = (n + 1) * (n + 1);
  const grounds = new Array(vertexCount);
  const halfWidth = terrain.roadHalfWidth ?? 0;
  const clearReach = roadClearSteps > 0 ? roadClearSteps * step + halfWidth : -1;
  const coarseReach = roadClearSteps > 0 ? roadClearSteps * step * 4 + halfWidth : -1;
  // Per edge vertex: how far a tile two levels coarser could lower it.
  const coarseDrop = new Float64Array(vertexCount);
  const scratch = {};

  for (let r = 0; r < ring; r++) {
    for (let c = 0; c < ring; c++) {
      const x = rect.x0 + (c - 1) * step;
      const z = rect.z0 + (r - 1) * step;
      const interior = r >= 1 && r <= n + 1 && c >= 1 && c <= n + 1;
      const ground = terrain.sample(x, z, interior ? {} : scratch);
      let h = ground.height;
      if (ground.roadDistance < coarseReach && h > ground.roadElevation) {
        if (interior) coarseDrop[(r - 1) * (n + 1) + (c - 1)] = h - ground.roadElevation;
        if (ground.roadDistance < clearReach) h = ground.roadElevation;
      }
      if (interior) grounds[(r - 1) * (n + 1) + (c - 1)] = ground;
      heights[r * ring + c] = h;
    }
  }

  const skirtVertices = 4 * (n + 1);
  const total = vertexCount + skirtVertices;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const color = [0, 0, 0];
  let minY = Infinity;
  let maxY = -Infinity;

  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const v = r * (n + 1) + c;
      const h = heights[(r + 1) * ring + (c + 1)];
      const dx = (heights[(r + 1) * ring + (c + 2)] - heights[(r + 1) * ring + c]) / (2 * step);
      const dz = (heights[(r + 2) * ring + (c + 1)] - heights[r * ring + (c + 1)]) / (2 * step);
      const length = Math.hypot(dx, 1, dz);
      const nx = -dx / length;
      const ny = 1 / length;
      const nz = -dz / length;
      const x = rect.x0 + c * step;
      const z = rect.z0 + r * step;
      positions[v * 3] = x - cx;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = z - cz;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      surface.colorAt(x, z, grounds[v], 1 - ny, color);
      colors[v * 3] = color[0];
      colors[v * 3 + 1] = color[1];
      colors[v * 3 + 2] = color[2];
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }

  // Skirts: each border vertex repeated straight below, deep enough to cover
  // the largest gap a coarser neighbor can leave. Each skirt quad is emitted
  // in both windings: the terrain renders front faces only, and a crack can
  // show a skirt from either side (a double-sided material would flip its
  // normal on the back and light it as if facing down — dark seams).
  const skirtDepth = Math.max(4, step * skirtFactor);
  const edges = [
    (k) => k, // north edge (r = 0)
    (k) => n * (n + 1) + k, // south edge (r = n)
    (k) => k * (n + 1), // west edge (c = 0)
    (k) => k * (n + 1) + n, // east edge (c = n)
  ];
  const triangles = 2 * n * n + 4 * 4 * n;
  const indices = total > 65535 ? new Uint32Array(triangles * 3) : new Uint16Array(triangles * 3);
  let t = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * (n + 1) + c;
      const b = a + 1;
      const cc = a + (n + 1);
      const d = cc + 1;
      indices[t++] = a; indices[t++] = cc; indices[t++] = b;
      indices[t++] = b; indices[t++] = cc; indices[t++] = d;
    }
  }
  edges.forEach((edgeVertex, e) => {
    const base = vertexCount + e * (n + 1);
    for (let k = 0; k <= n; k++) {
      const source = edgeVertex(k);
      const target = base + k;
      positions[target * 3] = positions[source * 3];
      positions[target * 3 + 1] = positions[source * 3 + 1] - skirtDepth - coarseDrop[source];
      positions[target * 3 + 2] = positions[source * 3 + 2];
      for (let q = 0; q < 3; q++) {
        normals[target * 3 + q] = normals[source * 3 + q];
        colors[target * 3 + q] = colors[source * 3 + q];
      }
      if (k < n) {
        const next = edgeVertex(k + 1);
        indices[t++] = source; indices[t++] = target; indices[t++] = next;
        indices[t++] = next; indices[t++] = target; indices[t++] = target + 1;
        indices[t++] = source; indices[t++] = next; indices[t++] = target;
        indices[t++] = next; indices[t++] = target + 1; indices[t++] = target;
      }
    }
  });

  let trees = new Float32Array(0);
  if (rect.size <= treeMaxTileMeters) {
    const placed = surface.placeTrees(rect.x0, rect.z0, rect.size);
    trees = new Float32Array(placed.data);
    for (let k = 0; k < placed.count; k++) {
      trees[k * 6 + 1] = meshHeight(placed.data[k * 6], placed.data[k * 6 + 2]);
      trees[k * 6] -= cx;
      trees[k * 6 + 2] -= cz;
    }
  }

  return { cx, cz, minY, maxY: Math.max(maxY, minY), positions, normals, colors, indices, trees };

  // The drawn surface at (x, z): the grid's triangles (diagonal from each
  // quad's top-right to its bottom-left corner, as indexed above).
  function meshHeight(x, z) {
    const fx = Math.min(n, Math.max(0, (x - rect.x0) / step));
    const fz = Math.min(n, Math.max(0, (z - rect.z0) / step));
    const c = Math.min(n - 1, Math.floor(fx));
    const r = Math.min(n - 1, Math.floor(fz));
    const u = fx - c;
    const v = fz - r;
    const h = (cc, rr) => heights[(rr + 1) * ring + (cc + 1)];
    if (u + v <= 1) return h(c, r) + (h(c + 1, r) - h(c, r)) * u + (h(c, r + 1) - h(c, r)) * v;
    return h(c + 1, r + 1) + (h(c, r + 1) - h(c + 1, r + 1)) * (1 - u) + (h(c + 1, r) - h(c + 1, r + 1)) * (1 - v);
  }
}
