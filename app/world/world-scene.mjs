// The virtual world's three.js scene: sky dome, sun and ambient light, haze
// that thins with altitude, water, the far horizon ground, the road along the
// track, and the streamed terrain tiles (world-tile-manager.mjs) — with the
// OpenStreetMap buildings, roads and water of a real-world style — all in the
// look of the style's theme (world-themes.mjs). Owns the main-thread copy of
// the height field the overlays and the camera read; the tile worker builds
// its own identical one (the main thread's skips the OSM water carve, which
// only the drawn ground needs). For a real-world style the ground starts out
// route-only and is rebuilt once the worker has loaded the elevation tiles
// (`onTerrainChanged`).

import * as THREE from "three";

import { createDem } from "./world-dem.mjs";
import { applyDepthPull } from "./world-depth-pull.mjs";
import { buildRoadArrays, createRoadTrack } from "./world-road.mjs";
import {
  buildingPalette,
  createBuildingMaterial,
  createHorizonMaterial,
  createRoadMaterial,
  createSky,
  createTerrainMaterial,
  createWaterMaterial,
  resolveTheme,
} from "./world-themes.mjs";
import { createTileManager } from "./world-tile-manager.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";

export function createWorldScene(config, { style, demBaseUrl, onTileReady, onTerrainChanged }) {
  const look = config.scene;
  const theme = resolveTheme(config, style);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.sky_horizon);
  scene.fog = new THREE.FogExp2(new THREE.Color(theme.ground_haze), look.fog_density_per_km / 1000);

  const sunDirection = new THREE.Vector3();
  const azimuth = THREE.MathUtils.degToRad(look.sun_azimuth_degrees);
  const elevation = THREE.MathUtils.degToRad(look.sun_elevation_degrees);
  // Compass bearing → x east, z south.
  sunDirection.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));

  const sun = new THREE.DirectionalLight(0xfff4e0, look.sun_intensity);
  sun.position.copy(sunDirection);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(new THREE.Color(theme.sky_horizon), new THREE.Color("#4d5a3c"), look.ambient_intensity));

  const sky = createSky(theme, sunDirection);
  scene.add(sky);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createWaterMaterial(theme));
  water.renderOrder = 1;
  scene.add(water);

  // A huge flat ground under everything, so the edge of the world reads as a
  // hazy plain instead of sky below the horizon.
  const horizon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createHorizonMaterial(theme));
  scene.add(horizon);

  const terrainMaterial = createTerrainMaterial(theme, sunDirection);
  let road = null;
  let roadTrack = null;
  let terrain = null;
  let route = [];
  const tiles = createTileManager({
    scene,
    config,
    style,
    theme,
    terrainMaterial,
    // The offline city look's instanced buildings (real-world styles draw
    // OSM buildings instead, world-osm-layer.mjs).
    buildingMaterial: theme.ground === "city" ? createBuildingMaterial(theme) : null,
    buildingColor: theme.ground === "city" ? buildingPalette(theme) : null,
    demBaseUrl,
    onTileReady,
    onDem: (demTiles) => {
      const dem = createDem(demTiles);
      if (!dem) return;
      setTerrain(createWorldTerrain(route, config.terrain, { dem }));
      tiles.setTerrain(terrain);
      onTerrainChanged();
    },
  });

  function setRoute(nextRoute) {
    route = nextRoute;
    setTerrain(createWorldTerrain(route, config.terrain));
    if (road) {
      scene.remove(road);
      road.geometry.dispose();
      road.material.dispose();
    }
    road = createRoad(terrain.centerline, look, theme);
    if (road) scene.add(road);
    // Ride progress → the generated road (route points need their distance).
    const routeLocal = route
      .filter((p) => Number.isFinite(Number(p?.distance)))
      .map((p) => ({ ...terrain.projection.toLocal(p.lat, p.lng), distance: Number(p.distance) }));
    roadTrack = createRoadTrack(routeLocal, terrain.centerline);
    tiles.setWorld(terrain, route);
    return terrain;
  }

  function setTerrain(next) {
    terrain = next;
    const { bounds } = terrain;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    water.position.set(cx, terrain.waterLevel, cz);
    water.scale.set(size, 1, size);
    horizon.position.set(cx, Math.min(terrain.waterLevel, terrain.minElevation - 60), cz);
    horizon.scale.set(size * 40, 1, size * 40);
    // The neon ground gradient spans the route's relief plus the hills above it.
    const relief = Math.max(300, terrain.maxElevation - terrain.minElevation);
    terrainMaterial.setElevationRange?.(terrain.minElevation - 100, terrain.maxElevation + relief);
  }

  // Per frame: keep the sky around the camera, thin the haze with altitude,
  // stream terrain tiles. Returns true while tiles are still loading.
  function update(camera, heightAboveGround) {
    sky.position.copy(camera.position);
    sky.scale.setScalar(camera.far * 0.9);
    scene.fog.density = (theme.fog_scale * look.fog_density_per_km) / 1000 / (1 + Math.max(0, heightAboveGround) / 1500);
    return tiles.update(camera.position, heightAboveGround);
  }

  function dispose() {
    tiles.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
    terrainMaterial.dispose();
  }

  return {
    scene,
    setRoute,
    update,
    dispose,
    get terrain() {
      return terrain;
    },
    get roadTrack() {
      return roadTrack;
    },
  };
}

// The road along the smooth centerline as a solid strip (world-road.mjs): an
// asphalt top lifted a little above the flat road bed with painted edge lines,
// and on each side an embankment sloping down and out into the ground, so
// wherever the terrain mesh dips below the road there is a bank, never a gap.
// Columns left to right: bank foot, bank top | edge line | asphalt | edge line
// | bank top, bank foot (edges doubled so every band gets its own color and
// normals).
function createRoad(centerline, look, theme) {
  const half = look.road_width_meters / 2;
  const line = half - look.road_edge_width_meters;
  const foot = half + look.road_embankment_spread_meters;
  const depth = look.road_embankment_depth_meters;
  const BANK = 0;
  const ASPHALT = 1;
  const EDGE = 2;
  const arrays = buildRoadArrays(centerline, {
    lift: look.road_lift_meters,
    columns: [
      [foot, -depth, BANK], [half, 0, BANK],
      [half, 0, EDGE], [line, 0, EDGE],
      [line, 0, ASPHALT], [-line, 0, ASPHALT],
      [-line, 0, EDGE], [-half, 0, EDGE],
      [-half, 0, BANK], [-foot, -depth, BANK],
    ],
  });
  if (!arrays) return null;
  const palette = [theme.road_embankment, theme.road, theme.road_edge].map((hex) => new THREE.Color(hex));
  const colors = new Float32Array(arrays.colorIndex.length * 3);
  arrays.colorIndex.forEach((index, v) => palette[index].toArray(colors, v * 3));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geometry.computeVertexNormals();
  const material = applyDepthPull(createRoadMaterial(theme), look.road_depth_pull);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(arrays.origin.x, 0, arrays.origin.z);
  return mesh;
}
