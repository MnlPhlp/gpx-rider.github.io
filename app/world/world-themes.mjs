// The virtual world's looks (virtual_world.themes in tuning.yaml): resolves a
// style's theme and builds its materials — the ground ("biome": lit vertex
// colors from world-surface.mjs; "neon": dark relief with glowing grid and
// contour lines, a custom shader), the sky dome, water, horizon ground and
// road. Everything else in the scene is theme-agnostic, so a new look is a
// new `themes` entry plus, at most, a new terrain_style here.

import * as THREE from "three";

export function resolveTheme(config, style) {
  return config.themes[style?.theme] ?? config.themes.nature;
}

// The ground material. For "neon", call `setElevationRange(min, max)` once
// the ground is known so the color gradient spans the world's relief.
export function createTerrainMaterial(theme, sunDirection) {
  if (theme.terrain_style !== "neon") return new THREE.MeshLambertMaterial({ vertexColors: true });
  const neon = theme.neon;
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        groundLow: { value: new THREE.Color(neon.ground_low) },
        groundHigh: { value: new THREE.Color(neon.ground_high) },
        gridColor: { value: new THREE.Color(neon.grid) },
        contourColor: { value: new THREE.Color(neon.contour) },
        gridSpacing: { value: neon.grid_spacing_meters },
        contourSpacing: { value: neon.contour_spacing_meters },
        glow: { value: neon.glow },
        elevationRange: { value: new THREE.Vector2(0, 1000) },
        lightDirection: { value: sunDirection.clone().normalize() },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 groundLow;
      uniform vec3 groundHigh;
      uniform vec3 gridColor;
      uniform vec3 contourColor;
      uniform float gridSpacing;
      uniform float contourSpacing;
      uniform float glow;
      uniform vec2 elevationRange;
      uniform vec3 lightDirection;
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>

      // A line every unit of 'coord': a sharp core about a pixel wide plus a
      // soft glow, fading out where the lines crowd closer than a few pixels.
      float neonLine(float coord) {
        float width = fwidth(coord);
        float d = abs(fract(coord - 0.5) - 0.5) / max(width, 1e-5);
        float core = 1.0 - smoothstep(0.5, 1.5, d);
        float halo = exp(-d / 4.0) * glow;
        float fade = 1.0 - smoothstep(0.06, 0.3, width);
        return (core + halo) * fade;
      }

      void main() {
        #include <logdepthbuf_fragment>
        float t = clamp((vWorld.y - elevationRange.x) / max(1.0, elevationRange.y - elevationRange.x), 0.0, 1.0);
        float shade = 0.45 + 0.55 * max(dot(normalize(vNormalWorld), lightDirection), 0.0);
        vec3 color = mix(groundLow, groundHigh, t) * shade;
        vec2 grid = vWorld.xz / gridSpacing;
        color += gridColor * max(neonLine(grid.x), neonLine(grid.y));
        color += contourColor * neonLine(vWorld.y / contourSpacing) * 0.8;
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
  });
  material.setElevationRange = (min, max) => material.uniforms.elevationRange.value.set(min, max);
  return material;
}

// Buildings with windows drawn in the shader — a glass inset in every
// window_width × floor_height cell of each wall, measured in meters on that
// wall, a darker ground floor, fading to an average tone where the cells get
// smaller than a few pixels. Two geometries share it:
//   - city buildings (default): instanced unit boxes (base at y = 0, see
//     world-city.mjs) scaled per building, facade color per instance, the
//     wall meters derived from the instance scale; roofs get the roof color.
//   - OSM buildings (`osm: true`, world-osm-layer.mjs): extruded footprints
//     carrying their own wall meters (`facade` attribute: along the ring,
//     above the ground) and a `buildingStyle` attribute (x = 2 on roofs),
//     colored per vertex.
export function createBuildingMaterial(theme, { osm = false } = {}) {
  const look = theme.buildings;
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: osm });
  const glass = new THREE.Color(look.glass);
  const roof = new THREE.Color(look.roof);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glassColor = { value: glass };
    shader.uniforms.roofColor = { value: roof };
    shader.uniforms.windowCell = { value: new THREE.Vector2(look.window_width_meters, look.floor_height_meters) };
    const header = osm ? "attribute vec2 facade;\nattribute vec2 buildingStyle;\n" : "";
    shader.vertexShader = `${header}varying vec2 vFacade;\nvarying float vRoof;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      osm
        ? `#include <begin_vertex>
      vRoof = step(1.5, buildingStyle.x);
      vFacade = facade;`
        : `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 buildingScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      #else
        vec3 buildingScale = vec3(1.0);
      #endif
      vec3 wallMeters = position * buildingScale;
      vRoof = step(0.5, abs(objectNormal.y));
      vFacade = abs(objectNormal.x) > 0.5 ? vec2(wallMeters.z, wallMeters.y) : vec2(wallMeters.x, wallMeters.y);`,
    );
    shader.fragmentShader = `uniform vec3 glassColor;\nuniform vec3 roofColor;\nuniform vec2 windowCell;\nvarying vec2 vFacade;\nvarying float vRoof;\n${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      if (vRoof > 0.5) {
        ${osm ? "" : "diffuseColor.rgb = roofColor * (0.8 + 0.2 * diffuseColor.rgb);"}
      } else {
        vec2 cell = vFacade / windowCell;
        vec2 f = fract(cell);
        vec2 aa = fwidth(cell);
        float inset = smoothstep(0.18, 0.18 + aa.x, f.x) * (1.0 - smoothstep(0.82 - aa.x, 0.82, f.x))
          * smoothstep(0.28, 0.28 + aa.y, f.y) * (1.0 - smoothstep(0.86 - aa.y, 0.86, f.y));
        // The ground floor is a darker band; tiny cells fade to the average.
        inset *= step(1.0, cell.y);
        float detail = 1.0 - smoothstep(0.25, 0.6, max(aa.x, aa.y));
        vec3 windowed = mix(diffuseColor.rgb, glassColor, inset);
        vec3 average = mix(diffuseColor.rgb, glassColor, 0.3);
        diffuseColor.rgb = mix(average, windowed, detail);
        diffuseColor.rgb *= mix(0.72, 1.0, step(1.0, cell.y));
      }`,
    );
  };
  material.customProgramCacheKey = () => (osm ? "osm-buildings" : "city-buildings");
  return material;
}

// The facade palette as colors, indexed like world-city.mjs's color index
// (16 slots per group: 0 = houses, 1 = towers).
export function buildingPalette(theme) {
  const groups = [theme.buildings.facades, theme.buildings.towers].map((list) => list.map((hex) => new THREE.Color(hex)));
  return (index) => {
    const group = groups[Math.floor(index / 16)] ?? groups[0];
    return group[(index % 16) % group.length];
  };
}

export function createWaterMaterial(theme) {
  const color = new THREE.Color(theme.water);
  const options = { color, transparent: true, opacity: theme.water_opacity };
  return theme.unlit
    ? new THREE.MeshBasicMaterial(options)
    : new THREE.MeshPhongMaterial({ ...options, shininess: 90, specular: 0x8899aa });
}

export function createHorizonMaterial(theme) {
  const color = new THREE.Color(theme.horizon_ground);
  return theme.unlit ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
}

// Vertex-colored road; unlit themes draw it at full brightness so the edge
// lines glow.
export function createRoadMaterial(theme) {
  const options = { vertexColors: true, side: THREE.DoubleSide };
  return theme.unlit ? new THREE.MeshBasicMaterial(options) : new THREE.MeshLambertMaterial(options);
}

// A gradient sky dome with an optional soft sun glow; unit sphere scaled to
// the far plane each frame and always centered on the camera.
export function createSky(theme, sunDirection) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(theme.sky_top) },
      horizonColor: { value: new THREE.Color(theme.sky_horizon) },
      hazeColor: { value: new THREE.Color(theme.ground_haze) },
      sunDirection: { value: sunDirection.clone().normalize() },
      sunGlow: { value: theme.sun_glow },
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
      uniform float sunGlow;
      varying vec3 vDirection;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float up = vDirection.y;
        vec3 color = mix(horizonColor, topColor, pow(clamp(up, 0.0, 1.0), 0.55));
        color = mix(color, hazeColor, smoothstep(0.02, -0.12, up));
        float sun = max(dot(normalize(vDirection), sunDirection), 0.0);
        color += sunGlow * vec3(1.0, 0.92, 0.75) * (pow(sun, 900.0) * 1.6 + pow(sun, 12.0) * 0.18);
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
