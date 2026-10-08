// three.js stand-ins for the maps3d overlay elements the app draws with —
// Polyline3DElement (route lines, trail, debug path), Polygon3DElement (rider
// and ghost beacons) and Model3DElement (the rider dot) — implementing the
// slice of Google's API the app uses: the same constructor options, settable
// path/position/scale/orientation, altitude modes, and `remove()`. Appending
// one to the virtual map (`map.append(overlay)`) attaches it; the map calls
// `sync(world)` before rendering whenever an overlay changed or the ground did.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

import { VIRTUAL_WORLD } from "../core/tuning.mjs";
import { applyDepthPull } from "./world-depth-pull.mjs";

const ROAD_DEPTH_PULL = VIRTUAL_WORLD.scene.road_depth_pull;

export const AltitudeMode = Object.freeze({
  ABSOLUTE: "ABSOLUTE",
  CLAMP_TO_GROUND: "CLAMP_TO_GROUND",
  RELATIVE_TO_GROUND: "RELATIVE_TO_GROUND",
  RELATIVE_TO_MESH: "RELATIVE_TO_MESH",
});

// Map labels have no meaning in the virtual world; kept so settings code that
// toggles `map.mode` keeps working.
export const MapMode = Object.freeze({ HYBRID: "HYBRID", SATELLITE: "SATELLITE" });

// "#rrggbb" / "rgb(...)" / "rgba(...)" → { color, opacity }.
export function parseCssColor(value, fallback = "#ffffff") {
  const text = String(value ?? fallback).trim();
  const rgba = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map((part) => Number(part.trim()));
    return { color: new THREE.Color(r / 255, g / 255, b / 255).convertSRGBToLinear(), opacity: a };
  }
  return { color: new THREE.Color(text), opacity: 1 };
}

// World-space position of a {lat, lng, altitude} under an altitude mode.
function localPoint(world, point, altitudeMode, target = new THREE.Vector3()) {
  const { x, z } = world.projection.toLocal(Number(point.lat), Number(point.lng));
  const altitude = Number(point.altitude) || 0;
  let y = altitude;
  if (altitudeMode !== AltitudeMode.ABSOLUTE) {
    const ground = world.heightAt(x, z);
    y = altitudeMode === AltitudeMode.CLAMP_TO_GROUND ? ground + 0.3 : ground + altitude;
  }
  return target.set(x, y, z);
}

class VirtualOverlay {
  constructor() {
    this.map = null;
    this.object = new THREE.Group();
    this.dirty = true;
  }

  changed() {
    this.dirty = true;
    this.map?.requestRender();
  }

  remove() {
    this.map?.detachOverlay(this);
  }

  dispose() {
    this.object.traverse((child) => {
      if (child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
      if (child.material && !child.userData.sharedMaterial) child.material.dispose();
    });
    this.object.clear();
  }
}

// Screen-space-width polyline with an optional casing, like Google's. The
// casing is the full strokeWidth; the colored core is (1 - outerWidth) of it.
// Both pass through a depth pull toward the camera (line_depth_pull) so the
// floating line clears slightly-too-coarse distant ground but not real ridges.
export class Polyline3DElement extends VirtualOverlay {
  constructor(options = {}) {
    super();
    this.altitudeMode = options.altitudeMode ?? AltitudeMode.ABSOLUTE;
    this.strokeColor = options.strokeColor ?? "#0a84ff";
    this.strokeWidth = options.strokeWidth ?? 4;
    this.outerColor = options.outerColor ?? null;
    this.outerWidth = options.outerWidth ?? 0;
    this.drawsOccludedSegments = Boolean(options.drawsOccludedSegments);
    this._path = options.path ?? options.coordinates ?? [];
    this.materials = [];
  }

  get path() {
    return this._path;
  }

  set path(value) {
    this._path = value ?? [];
    this.changed();
  }

  get coordinates() {
    return this._path;
  }

  set coordinates(value) {
    this.path = value;
  }

  sync(world, look) {
    this.dispose();
    this.materials = [];
    const points = (this._path ?? []).map((point) => localPoint(world, point, this.altitudeMode));
    if (points.length < 2) return;
    const origin = points[0].clone();
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => flat.set([p.x - origin.x, p.y - origin.y, p.z - origin.z], i * 3));
    this.object.position.copy(origin);

    const hasCasing = this.outerColor && this.outerWidth > 0;
    const layers = hasCasing
      ? [
        { css: this.outerColor, width: this.strokeWidth, order: 10 },
        { css: this.strokeColor, width: this.strokeWidth * (1 - this.outerWidth), order: 11 },
      ]
      : [{ css: this.strokeColor, width: this.strokeWidth, order: 11 }];
    for (const layer of layers) {
      const { color, opacity } = parseCssColor(layer.css);
      const geometry = new LineGeometry();
      geometry.setPositions(flat);
      const material = new LineMaterial({
        color,
        linewidth: Math.max(1, layer.width),
        // Transparent and not writing depth: three.js draws opaque materials
        // before transparent ones whatever their renderOrder, so this is what
        // lets renderOrder put the core over the casing and the rider marker
        // (renderOrder 15) over both. Terrain and trees still hide the line.
        transparent: true,
        opacity,
        depthTest: !this.drawsOccludedSegments,
        depthWrite: false,
      });
      patchLineShader(material, look);
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      line.renderOrder = layer.order;
      line.frustumCulled = false;
      this.object.add(line);
      this.materials.push(material);
    }
  }

  setResolution(width, height) {
    for (const material of this.materials) material.resolution.set(width, height);
  }
}

// Two tweaks to LineMaterial's shaders:
//   - Each vertex moves toward the camera along its own view ray by a fraction
//     of its distance: screen position and pixel width are unchanged (a
//     perspective projection is invariant along the ray), only depth shrinks.
//   - The line fades out within `nearHide` meters of the camera. The route
//     floats above the first-person eye, and the stretch passing overhead
//     would otherwise smear into a stripe up the screen.
function patchLineShader(material, look) {
  const keep = (1 - look.line_depth_pull).toFixed(6);
  const nearHide = Math.max(0.01, look.line_near_hide_meters).toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying float vLineViewDepth;\n${shader.vertexShader}`
      .replace(
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
        `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
        start.xyz *= ${keep};
        end.xyz *= ${keep};`,
      )
      .replace(
        "vec4 mvPosition = ( position.y < 0.5 ) ? start : end;",
        "vec4 mvPosition = ( position.y < 0.5 ) ? start : end;\n\t\t\tvLineViewDepth = - mvPosition.z;",
      );
    shader.fragmentShader = `varying float vLineViewDepth;\n${shader.fragmentShader}`.replace(
      "float alpha = opacity;",
      `float alpha = opacity * smoothstep( ${nearHide} * 0.5, ${nearHide}, vLineViewDepth );
      if ( alpha <= 0.0 ) discard;`,
    );
  };
}

// Flat or extruded polygon (the beacons are extruded rings: a translucent
// column from the ground up to the ring's altitude).
export class Polygon3DElement extends VirtualOverlay {
  constructor(options = {}) {
    super();
    this.altitudeMode = options.altitudeMode ?? AltitudeMode.ABSOLUTE;
    this.extruded = Boolean(options.extruded);
    this.drawsOccludedSegments = Boolean(options.drawsOccludedSegments);
    this.fillColor = options.fillColor ?? "rgba(255, 255, 255, 0.5)";
    this._path = options.path ?? options.outerCoordinates ?? [];
  }

  get path() {
    return this._path;
  }

  set path(value) {
    this._path = value ?? [];
    this.changed();
  }

  get outerCoordinates() {
    return this._path;
  }

  set outerCoordinates(value) {
    this.path = value;
  }

  sync(world) {
    this.dispose();
    const ring = this._path ?? [];
    if (ring.length < 3) return;
    const tops = ring.map((point) => localPoint(world, point, this.altitudeMode));
    const origin = tops[0].clone();
    this.object.position.copy(origin);
    const center = tops.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(tops.length);

    const positions = [];
    const push = (p) => positions.push(p.x - origin.x, p.y - origin.y, p.z - origin.z);
    for (let i = 0; i < tops.length; i++) {
      const a = tops[i];
      const b = tops[(i + 1) % tops.length];
      push(center); push(a); push(b);
      if (this.extruded) {
        const ga = a.clone().setY(world.heightAt(a.x, a.z));
        const gb = b.clone().setY(world.heightAt(b.x, b.z));
        push(ga); push(gb); push(a);
        push(a); push(gb); push(b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const { color, opacity } = parseCssColor(this.fillColor);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color,
      opacity,
      transparent: opacity < 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: !this.drawsOccludedSegments,
    }));
    mesh.renderOrder = 20;
    this.object.add(mesh);
  }
}

const gltfLoader = new GLTFLoader();
const modelCache = new Map();

function loadModel(src) {
  const url = String(src);
  if (!modelCache.has(url)) {
    modelCache.set(url, gltfLoader.loadAsync(url).then((gltf) => gltf.scene).catch((error) => {
      console.error("[virtual-world] model failed to load", url, error);
      return null;
    }));
  }
  return modelCache.get(url);
}

// glTF mesh at a geo position. Google's orientation (heading/tilt/roll) works
// in an east/north/up frame where a glTF model's +Y needs tilt 90 to point up
// (see rider_dot.orientation in tuning.yaml); the same rotation is composed
// here and converted into three.js's y-up frame, so tuned values carry over.
export class Model3DElement extends VirtualOverlay {
  constructor(options = {}) {
    super();
    this.altitudeMode = options.altitudeMode ?? AltitudeMode.ABSOLUTE;
    this._position = options.position ?? null;
    this._orientation = options.orientation ?? { heading: 0, tilt: 0, roll: 0 };
    this._scale = options.scale ?? 1;
    this.model = null;
    loadModel(options.src).then((scene) => {
      if (!scene) return;
      this.model = scene.clone(true);
      this.model.traverse((child) => {
        child.userData.sharedGeometry = true;
        child.userData.sharedMaterial = true;
        // Drawn after the route line (see Polyline3DElement), which floats
        // above the marker and would otherwise cover it.
        if (child.isMesh) {
          child.renderOrder = 15;
          child.material.transparent = true;
          // The same depth margin as the road, so the road never covers it.
          applyDepthPull(child.material, ROAD_DEPTH_PULL);
        }
      });
      this.object.add(this.model);
      this.changed();
    });
  }

  get position() {
    return this._position;
  }

  set position(value) {
    this._position = value;
    this.changed();
  }

  get orientation() {
    return this._orientation;
  }

  set orientation(value) {
    this._orientation = value;
    this.changed();
  }

  get scale() {
    return this._scale;
  }

  set scale(value) {
    if (value === this._scale) return;
    this._scale = value;
    this.changed();
  }

  sync(world) {
    if (!this._position) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    localPoint(world, this._position, this.altitudeMode, this.object.position);
    const { heading = 0, tilt = 0, roll = 0 } = this._orientation ?? {};
    const enu = new THREE.Matrix4()
      .makeRotationZ(THREE.MathUtils.degToRad(-heading))
      .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(tilt)))
      .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(roll)));
    const toThree = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    this.object.quaternion.setFromRotationMatrix(toThree.multiply(enu));
    const s = this._scale;
    if (typeof s === "number") this.object.scale.setScalar(s);
    else this.object.scale.set(s?.x ?? 1, s?.z ?? s?.y ?? 1, s?.y ?? 1);
  }

  dispose() {
    // The loaded model is shared; nothing of its own to free.
  }
}
