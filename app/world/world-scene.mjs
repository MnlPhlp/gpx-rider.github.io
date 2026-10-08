// The virtual world's three.js scene: sky dome, sun and ambient light, haze
// that thins with altitude, lakes, the far horizon ground, the asphalt road
// along the track, and the streamed terrain tiles (world-tile-manager.mjs).
// Owns the main-thread copy of the height field the overlays and the camera
// read; the tile worker builds its own identical one.

import * as THREE from "three";

import { applyDepthPull } from "./world-depth-pull.mjs";
import { buildRoadArrays } from "./world-road.mjs";
import { createTileManager } from "./world-tile-manager.mjs";
import { createWorldTerrain } from "./world-terrain.mjs";

export function createWorldScene(config, { onTileReady }) {
  const look = config.scene;
  const scene = new THREE.Scene();
  const haze = new THREE.Color(look.ground_haze);
  scene.background = new THREE.Color(look.sky_horizon);
  scene.fog = new THREE.FogExp2(haze, look.fog_density_per_km / 1000);

  const sunDirection = new THREE.Vector3();
  const azimuth = THREE.MathUtils.degToRad(look.sun_azimuth_degrees);
  const elevation = THREE.MathUtils.degToRad(look.sun_elevation_degrees);
  // Compass bearing → x east, z south.
  sunDirection.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));

  const sun = new THREE.DirectionalLight(0xfff4e0, look.sun_intensity);
  sun.position.copy(sunDirection);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(new THREE.Color(look.sky_horizon), new THREE.Color("#4d5a3c"), look.ambient_intensity));

  const sky = createSky(look, sunDirection);
  scene.add(sky);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshPhongMaterial({ color: new THREE.Color(look.water), shininess: 90, specular: 0x8899aa, transparent: true, opacity: 0.93 }),
  );
  water.renderOrder = 1;
  scene.add(water);

  // A huge flat ground under everything, so the edge of the world reads as a
  // hazy plain instead of sky below the horizon.
  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: new THREE.Color("#55703f") }),
  );
  scene.add(horizon);

  let road = null;
  let terrain = null;
  const tiles = createTileManager({ scene, config, onTileReady });

  function setRoute(route) {
    terrain = createWorldTerrain(route, config.terrain);
    const { bounds } = terrain;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    water.position.set(cx, terrain.waterLevel, cz);
    water.scale.set(size, 1, size);
    horizon.position.set(cx, Math.min(terrain.waterLevel, terrain.minElevation - 60), cz);
    horizon.scale.set(size * 40, 1, size * 40);

    if (road) {
      scene.remove(road);
      road.geometry.dispose();
    }
    road = createRoad(terrain.centerline, look);
    if (road) scene.add(road);
    tiles.setWorld(terrain, route);
    return terrain;
  }

  // Per frame: keep the sky around the camera, thin the haze with altitude,
  // stream terrain tiles. Returns true while tiles are still loading.
  function update(camera, heightAboveGround) {
    sky.position.copy(camera.position);
    sky.scale.setScalar(camera.far * 0.9);
    scene.fog.density = look.fog_density_per_km / 1000 / (1 + Math.max(0, heightAboveGround) / 1500);
    return tiles.update(camera.position, heightAboveGround);
  }

  function dispose() {
    tiles.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
  }

  return {
    scene,
    setRoute,
    update,
    dispose,
    get terrain() {
      return terrain;
    },
  };
}

// A gradient sky dome with a soft sun glow; unit sphere scaled to the far
// plane each frame and always centered on the camera.
function createSky(look, sunDirection) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(look.sky_top) },
      horizonColor: { value: new THREE.Color(look.sky_horizon) },
      hazeColor: { value: new THREE.Color(look.ground_haze) },
      sunDirection: { value: sunDirection.clone().normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 hazeColor;
      uniform vec3 sunDirection;
      varying vec3 vDirection;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float up = vDirection.y;
        vec3 color = mix(horizonColor, topColor, pow(clamp(up, 0.0, 1.0), 0.55));
        color = mix(color, hazeColor, smoothstep(0.02, -0.12, up));
        float sun = max(dot(normalize(vDirection), sunDirection), 0.0);
        color += vec3(1.0, 0.92, 0.75) * (pow(sun, 900.0) * 1.6 + pow(sun, 12.0) * 0.18);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

// The road along the smooth centerline as a solid strip (world-road.mjs): an
// asphalt top lifted a little above the flat road bed, and on each side an
// embankment sloping down and out into the ground, so wherever the terrain
// mesh dips below the road there is a bank, never a gap. Columns left to
// right: bank foot, bank top, asphalt edge, asphalt edge, bank top, bank foot
// (edges doubled so asphalt and banks get their own colors and normals).
function createRoad(centerline, look) {
  const half = look.road_width_meters / 2;
  const foot = half + look.road_embankment_spread_meters;
  const depth = look.road_embankment_depth_meters;
  const BANK = 0;
  const ASPHALT = 1;
  const arrays = buildRoadArrays(centerline, {
    lift: look.road_lift_meters,
    columns: [
      [foot, -depth, BANK], [half, 0, BANK], [half, 0, ASPHALT],
      [-half, 0, ASPHALT], [-half, 0, BANK], [-foot, -depth, BANK],
    ],
  });
  if (!arrays) return null;
  const palette = [new THREE.Color(look.road_embankment), new THREE.Color(look.road)];
  const colors = new Float32Array(arrays.colorIndex.length * 3);
  arrays.colorIndex.forEach((index, v) => palette[index].toArray(colors, v * 3));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  applyDepthPull(material, look.road_depth_pull);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(arrays.origin.x, 0, arrays.origin.z);
  return mesh;
}
