// The virtual world's terrain on screen: asks the tile worker for the quadtree
// tiles the camera needs (closest first, a few in flight at once), turns the
// arrays it returns into three.js meshes with instanced trees, shows the LOD
// display set (falling back to a coarser loaded ancestor while finer tiles
// build), and evicts least-recently-used tiles past the cache cap.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { baseNodes, createQuadtree, resolveDisplay, selectLeaves } from "./world-tiles.mjs";

export function createTileManager({ scene, config, onTileReady }) {
  const tilesConfig = config.tiles;
  const root = new THREE.Group();
  root.name = "virtual-world-terrain";
  scene.add(root);

  const terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const treeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const treeGeometries = [coniferGeometry(), broadleafGeometry()];

  const worker = new Worker(new URL("./world-tile-worker.mjs", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => receiveTile(data);
  worker.onerror = (event) => console.error("[virtual-world] tile worker failed", event.message ?? event);

  let world = null;
  let worldId = 0;
  const cache = new Map(); // key → { group, lastUsed }
  const inflight = new Set();
  const boostCache = new Map();
  let displayed = new Set();
  let frame = 0;

  function setWorld(terrain, route) {
    worldId++;
    for (const entry of cache.values()) disposeTile(entry);
    cache.clear();
    inflight.clear();
    boostCache.clear();
    displayed = new Set();
    world = {
      terrain,
      tree: createQuadtree(terrain.bounds, tilesConfig.min_tile_meters),
    };
    world.base = baseNodes(world.tree, tilesConfig.base_level);
    worker.postMessage({
      type: "world",
      worldId,
      route: route.map((p) => ({ lat: p.lat, lng: p.lng, ele: p.ele })),
      config,
    });
  }

  // Tiles the route crosses refine more eagerly (see route_detail_boost).
  function detailBoost(node) {
    let boost = boostCache.get(node.key);
    if (boost === undefined) {
      const center = world.terrain.sample(node.x0 + node.size / 2, node.z0 + node.size / 2, {});
      boost = center.roadDistance < node.size * 0.75 ? tilesConfig.route_detail_boost : 1;
      boostCache.set(node.key, boost);
    }
    return boost;
  }

  // Per rendered frame: pick the tiles for this camera, request missing ones
  // and show the best available set. Returns true while tiles are pending.
  function update(cameraLocal, heightAboveGround) {
    if (!world) return false;
    frame++;
    const leaves = selectLeaves(world.tree, { x: cameraLocal.x, z: cameraLocal.z, heightAboveGround }, {
      splitFactor: tilesConfig.split_factor,
      detailBoost,
    });

    const wanted = [...world.base.map((node) => ({ ...node, distance: -1 })), ...leaves];
    const missing = wanted.filter((node) => !cache.has(node.key) && !inflight.has(node.key));
    missing.sort((a, b) => a.distance - b.distance);
    for (const node of missing) {
      if (inflight.size >= tilesConfig.max_inflight) break;
      inflight.add(node.key);
      worker.postMessage({
        type: "tile",
        worldId,
        key: node.key,
        rect: { x0: node.x0, z0: node.z0, size: node.size },
      });
    }

    const display = resolveDisplay(world.tree, leaves, (key) => cache.has(key));
    const next = new Set(display.map((node) => node.key));
    for (const key of displayed) {
      if (!next.has(key)) {
        const entry = cache.get(key);
        if (entry) entry.group.visible = false;
      }
    }
    for (const key of next) {
      const entry = cache.get(key);
      entry.group.visible = true;
      entry.lastUsed = frame;
    }
    for (const node of world.base) {
      const entry = cache.get(node.key);
      if (entry) entry.lastUsed = frame;
    }
    displayed = next;
    evict();
    return inflight.size > 0 || missing.length > 0;
  }

  function receiveTile({ worldId: id, key, tile }) {
    if (id !== worldId) return;
    inflight.delete(key);
    const group = new THREE.Group();
    group.position.set(tile.cx, 0, tile.cz);
    group.visible = false;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(tile.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(tile.normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(tile.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(tile.indices, 1));
    geometry.computeBoundingSphere();
    group.add(new THREE.Mesh(geometry, terrainMaterial));
    addTrees(group, tile.trees);

    root.add(group);
    cache.set(key, { group, lastUsed: frame });
    onTileReady();
  }

  function addTrees(group, data) {
    const count = data.length / 6;
    if (!count) return;
    const perKind = [0, 0];
    for (let k = 0; k < count; k++) perKind[data[k * 6 + 5]]++;
    const meshes = treeGeometries.map((geometry, kind) => {
      if (!perKind[kind]) return null;
      const mesh = new THREE.InstancedMesh(geometry, treeMaterial, perKind[kind]);
      mesh.count = 0;
      return mesh;
    });
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const mesh = meshes[data[k * 6 + 5]];
      const s = data[k * 6 + 3];
      rotation.setFromAxisAngle(up, data[k * 6 + 4]);
      position.set(data[k * 6], data[k * 6 + 1] - 0.3, data[k * 6 + 2]);
      scale.set(s, s * (0.85 + (s % 0.3)), s);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(mesh.count, matrix);
      const shade = 0.82 + ((k * 0.618034) % 1) * 0.3;
      mesh.setColorAt(mesh.count, tint.setRGB(shade, shade, shade));
      mesh.count++;
    }
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  function evict() {
    if (cache.size <= tilesConfig.max_cached_tiles) return;
    const baseKeys = new Set(world.base.map((node) => node.key));
    const candidates = [...cache.entries()]
      .filter(([key]) => !displayed.has(key) && !baseKeys.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const excess = cache.size - tilesConfig.max_cached_tiles;
    for (const [key, entry] of candidates.slice(0, excess)) {
      disposeTile(entry);
      cache.delete(key);
    }
  }

  function disposeTile(entry) {
    root.remove(entry.group);
    entry.group.traverse((object) => {
      // Tree geometries are shared across tiles; only the terrain geometry
      // and the instance buffers belong to this tile.
      if (object.isInstancedMesh) object.dispose();
      else if (object.isMesh) object.geometry.dispose();
    });
  }

  function dispose() {
    worker.terminate();
    for (const entry of cache.values()) disposeTile(entry);
    cache.clear();
    scene.remove(root);
    terrainMaterial.dispose();
    treeMaterial.dispose();
    treeGeometries.forEach((geometry) => geometry.dispose());
  }

  return { setWorld, update, dispose };
}

// Low-poly tree meshes with baked vertex colors (crown + trunk), ~1 m base
// scale × the instance scale.
function coloredGeometry(geometry, hex) {
  const color = new THREE.Color(hex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

function coniferGeometry() {
  const trunk = coloredGeometry(new THREE.CylinderGeometry(0.22, 0.32, 2.2, 5).translate(0, 1.1, 0), "#5a4030");
  const lower = coloredGeometry(new THREE.ConeGeometry(2.4, 5.5, 7).translate(0, 4.2, 0), "#2f5a2e");
  const upper = coloredGeometry(new THREE.ConeGeometry(1.7, 4.4, 7).translate(0, 7.3, 0), "#386a34");
  return mergeGeometries([trunk, lower, upper]);
}

function broadleafGeometry() {
  const trunk = coloredGeometry(new THREE.CylinderGeometry(0.25, 0.38, 3, 5).translate(0, 1.5, 0), "#5f4632");
  const crown = coloredGeometry(new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.85, 1).translate(0, 5.2, 0), "#4f7f36");
  const side = coloredGeometry(new THREE.IcosahedronGeometry(1.9, 0).translate(1.3, 4.2, 0.6), "#5b8b3c");
  return mergeGeometries([trunk, crown, side]);
}
