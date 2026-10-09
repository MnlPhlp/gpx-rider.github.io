// The OpenStreetMap layer of a real-world style on screen: which OSM tiles
// the worker has loaded (world-tile-worker.mjs announces them), asking it
// for the building / road / water meshes of those near the camera (nearest
// first, a few at a time), turning the arrays it returns
// (world-osm-meshes.mjs) into three.js meshes in the theme's look, showing
// only those within osm.mesh_distance_meters, and evicting the least recently
// shown past osm.max_mesh_tiles.

import * as THREE from "three";

import { applyDepthPull } from "./world-depth-pull.mjs";
import { createBuildingMaterial, createWaterMaterial } from "./world-themes.mjs";

export function createOsmLayer({ scene, config, theme, requestMesh }) {
  const root = new THREE.Group();
  root.name = "virtual-world-osm";
  scene.add(root);

  const buildingMaterial = theme.buildings ? createBuildingMaterial(theme, { osm: true }) : null;
  const buildingColor = buildingColors(theme);
  const ribbonMaterial = applyDepthPull(new THREE.MeshLambertMaterial({ vertexColors: true }), config.depth_pull);
  const roads = theme.osm_roads ?? {};
  const ribbonPalette = [roads.major, roads.minor, roads.path, theme.water].map((hex) => new THREE.Color(hex ?? theme.road));
  const waterMaterial = applyDepthPull(createWaterMaterial(theme), config.depth_pull);

  const available = new Map(); // key → { rect }
  const built = new Map(); // key → { group, lastUsed }
  const inflight = new Set();
  let frame = 0;

  function addTile(key, rect) {
    available.set(key, { rect });
  }

  function receiveMesh(key, meshes) {
    inflight.delete(key);
    if (!available.has(key) || built.has(key)) return;
    const group = new THREE.Group();
    group.position.set(meshes.cx, 0, meshes.cz);
    group.visible = false;
    if (buildingMaterial && meshes.buildings.indices.length) group.add(buildingMesh(meshes.buildings));
    if (meshes.ribbons.indices.length) group.add(ribbonMesh(meshes.ribbons));
    if (meshes.water.indices.length) group.add(waterMesh(meshes.water));
    root.add(group);
    built.set(key, { group, lastUsed: frame });
  }

  function buildingMesh({ positions, normals, facade, style, indices }) {
    const count = positions.length / 3;
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    for (let v = 0; v < count; v++) buildingColor(style[v * 2], style[v * 2 + 1], color).toArray(colors, v * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("facade", new THREE.BufferAttribute(facade, 2));
    geometry.setAttribute("buildingStyle", new THREE.BufferAttribute(style, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, buildingMaterial);
  }

  function ribbonMesh({ positions, kinds, indices }) {
    const colors = new Float32Array(kinds.length * 3);
    kinds.forEach((kind, v) => ribbonPalette[kind].toArray(colors, v * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, ribbonMaterial);
  }

  function waterMesh({ positions, indices }) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, waterMaterial);
    mesh.renderOrder = 1;
    return mesh;
  }

  // Per frame: show the built tiles in range, request the nearest missing
  // ones. Returns true while meshes are pending.
  function update(camera, heightAboveGround) {
    frame++;
    const maxDistance = config.mesh_distance_meters;
    const wanted = [];
    for (const [key, { rect }] of available) {
      const distance = Math.hypot(distanceToRect(camera.x, camera.z, rect), Math.max(0, heightAboveGround));
      const near = distance <= maxDistance;
      const entry = built.get(key);
      if (entry) {
        entry.group.visible = near;
        if (near) entry.lastUsed = frame;
      } else if (near && !inflight.has(key)) wanted.push({ key, distance });
    }
    wanted.sort((a, b) => a.distance - b.distance);
    for (const { key } of wanted) {
      if (inflight.size >= config.mesh_inflight) break;
      inflight.add(key);
      requestMesh(key);
    }
    evict();
    return inflight.size > 0 || wanted.length > 0;
  }

  function evict() {
    if (built.size <= config.max_mesh_tiles) return;
    const candidates = [...built.entries()].filter(([, entry]) => !entry.group.visible).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of candidates.slice(0, built.size - config.max_mesh_tiles)) {
      disposeGroup(entry.group);
      built.delete(key);
    }
  }

  function disposeGroup(group) {
    root.remove(group);
    group.traverse((object) => {
      if (object.isMesh) object.geometry.dispose();
    });
  }

  // A new world: everything announced or built so far belongs to the old one.
  function clear() {
    for (const entry of built.values()) disposeGroup(entry.group);
    built.clear();
    available.clear();
    inflight.clear();
  }

  function dispose() {
    clear();
    scene.remove(root);
    buildingMaterial?.dispose();
    ribbonMaterial.dispose();
    waterMaterial.dispose();
  }

  return { addTile, receiveMesh, update, clear, dispose };
}

function distanceToRect(x, z, rect) {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

// (kind, tone) of world-osm-meshes.mjs → a vertex color: the house or tower
// facade picked by the building's tone, roofs the roof color varied by it.
function buildingColors(theme) {
  const look = theme.buildings;
  if (!look) return (kind, tone, out) => out.set(theme.road);
  const facades = look.facades.map((hex) => new THREE.Color(hex));
  const towers = (look.towers ?? look.facades).map((hex) => new THREE.Color(hex));
  const roof = new THREE.Color(look.roof);
  return (kind, tone, out) => {
    if (kind >= 2) return out.copy(roof).multiplyScalar(0.85 + 0.3 * tone);
    const list = kind >= 1 ? towers : facades;
    return out.copy(list[Math.min(list.length - 1, Math.floor(tone * list.length))]);
  };
}
