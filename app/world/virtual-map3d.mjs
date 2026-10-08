// The virtual world as a drop-in for Google's `maps3d` library: a
// <gpx-virtual-map-3d> element with Map3DElement's camera properties (center,
// range, tilt, heading, roll, fov, mode), `append` for overlays, `isSteady`,
// and the overlay classes from world-overlays.mjs. The app's camera drivers,
// route rendering and HUD write to it exactly as they write to Google's map;
// only the picture behind them is different — a three.js landscape built from
// the route alone (world-scene.mjs). Loaded on demand (map/map-init.mjs) so the
// Google renderer never downloads three.js.
//
// Rendering is on demand: any camera write, overlay change or arriving
// terrain tile requests one frame; frames keep coming only while tiles load.

import * as THREE from "three";

import { cameraEyePosition } from "../camera/camera.mjs";
import { TERRAIN_TILE_BASE_URL, VIRTUAL_WORLD } from "../core/tuning.mjs";
import { bindCameraGestures } from "./world-gestures.mjs";
import { AltitudeMode, MapMode, Model3DElement, Polygon3DElement, Polyline3DElement } from "./world-overlays.mjs";
import { createWorldScene } from "./world-scene.mjs";

const TAG = "gpx-virtual-map-3d";
const DEG = Math.PI / 180;

class VirtualMap3DElement extends HTMLElement {
  constructor(options = {}) {
    super();
    this._center = { lat: 0, lng: 0, altitude: 0 };
    this._range = 1000;
    this._tilt = 45;
    this._heading = 0;
    this._roll = 0;
    this._fov = 35;
    this.mode = options.mode ?? MapMode.SATELLITE;
    // The virtual_world.styles entry drawn: { id, theme, terrain }.
    this.worldStyle = options.worldStyle ?? VIRTUAL_WORLD.styles[0];
    this.overlays = new Set();
    this.frameRequested = false;
    this.renderer = null;
    for (const key of ["center", "range", "tilt", "heading", "roll", "fov"]) {
      if (options[key] !== undefined) this[key] = options[key];
    }
  }

  connectedCallback() {
    if (!this.renderer) this.setup();
    this.resizeObserver.observe(this);
    this.requestRender();
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
  }

  setup() {
    this.style.display = "block";
    this.style.position = "relative";
    this.style.width = "100%";
    this.style.height = "100%";
    this.style.touchAction = "none";
    this.style.outline = "none";
    this.tabIndex = 0;

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    this.append(canvas);

    // A logarithmic depth buffer: the same frame holds a first-person eye
    // half a meter off the road and mountains 50 km away.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(this._fov, 1, VIRTUAL_WORLD.scene.near_meters, VIRTUAL_WORLD.scene.far_meters);
    this.camera.rotation.order = "YXZ";
    this.world = this.createWorld();
    this.world.setRoute([]);
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    bindCameraGestures(this);
  }

  createWorld() {
    return createWorldScene(VIRTUAL_WORLD, {
      style: this.worldStyle,
      demBaseUrl: TERRAIN_TILE_BASE_URL,
      onTileReady: () => this.requestRender(),
      // Real elevation arrived: everything placed on the ground re-seats.
      onTerrainChanged: () => {
        for (const overlay of this.overlays) overlay.dirty = true;
        this.requestRender();
      },
    });
  }

  // Switch to another virtual_world.styles entry in place: a fresh scene in
  // the new look (and ground source) with the same camera, route and overlays.
  setWorldStyle(style) {
    if (!style || style.id === this.worldStyle?.id) return;
    this.worldStyle = style;
    if (!this.renderer) return;
    const previous = this.world;
    for (const overlay of this.overlays) previous.scene.remove(overlay.object);
    previous.dispose();
    this.world = this.createWorld();
    for (const overlay of this.overlays) {
      this.world.scene.add(overlay.object);
      overlay.dirty = true;
    }
    this.world.setRoute(Array.isArray(this.worldRoute) ? this.worldRoute : []);
    this.requestRender();
  }

  // --- Map3DElement camera properties ---------------------------------------

  get center() {
    return { ...this._center };
  }

  set center(value) {
    this._center = {
      lat: Number(value?.lat) || 0,
      lng: Number(value?.lng) || 0,
      altitude: Number(value?.altitude) || 0,
    };
    this.requestRender();
  }

  get range() { return this._range; }
  set range(value) { this.setNumber("_range", value, 1); }
  get tilt() { return this._tilt; }
  set tilt(value) { this.setNumber("_tilt", Math.min(90, Math.max(0, Number(value))), 0); }
  get heading() { return this._heading; }
  set heading(value) { this.setNumber("_heading", ((Number(value) % 360) + 360) % 360, 0); }
  get roll() { return this._roll; }
  set roll(value) { this.setNumber("_roll", value, -Infinity); }
  get fov() { return this._fov; }
  set fov(value) { this.setNumber("_fov", Math.min(170, Math.max(1, Number(value))), 1); }

  // Everything is generated locally — there is never imagery to wait for.
  get isSteady() { return true; }

  setNumber(field, value, min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const next = Math.max(min, number);
    if (next === this[field]) return;
    this[field] = next;
    this.requestRender();
  }

  // --- Overlays ---------------------------------------------------------------

  append(...items) {
    for (const item of items) {
      if (item instanceof Node || typeof item === "string") super.append(item);
      else this.attachOverlay(item);
    }
  }

  attachOverlay(overlay) {
    if (overlay.map === this) return;
    overlay.map?.detachOverlay(overlay);
    overlay.map = this;
    overlay.dirty = true;
    this.overlays.add(overlay);
    this.world?.scene.add(overlay.object);
    this.requestRender();
  }

  detachOverlay(overlay) {
    if (!this.overlays.delete(overlay)) return;
    this.world?.scene.remove(overlay.object);
    overlay.dispose();
    overlay.map = null;
    this.requestRender();
  }

  // --- The world ------------------------------------------------------------------

  // Rebuild the landscape for a route (route-render.mjs calls this on every
  // route load). Overlays re-seat onto the new ground.
  setWorldRoute(route) {
    if (!this.renderer) this.setup();
    if (route === this.worldRoute) return;
    this.worldRoute = route;
    this.world.setRoute(Array.isArray(route) ? route : []);
    for (const overlay of this.overlays) overlay.dirty = true;
    this.requestRender();
  }

  // The rider's pose on the generated road at a ride progress: { lat, lng,
  // ele (the road's top), heading (compass degrees) }, or null without a
  // route. The follow and first-person cameras ride this instead of the raw
  // track, so they stay on the asphalt through the rounded bends.
  roadPoseAt(progressMeters) {
    const pose = this.world?.roadTrack?.poseAt(progressMeters);
    if (!pose) return null;
    const geo = this.world.terrain.projection.toGeo(pose.x, pose.z);
    return { ...geo, ele: pose.e + VIRTUAL_WORLD.scene.road_lift_meters, heading: pose.heading };
  }

  // Hide the route lines (overlays tagged isRouteLine), e.g. in first person.
  set routeLinesHidden(value) {
    const hidden = Boolean(value);
    if (hidden === this._routeLinesHidden) return;
    this._routeLinesHidden = hidden;
    this.requestRender();
  }

  // Ground elevation of the virtual terrain (null before the world exists) —
  // what the follow camera's terrain avoidance and the fly-by planner read.
  groundElevationAt(lat, lng) {
    const terrain = this.world?.terrain;
    return terrain ? terrain.heightAtGeo(lat, lng) : null;
  }

  requestRender() {
    if (this.frameRequested || !this.renderer) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.renderFrame();
    });
  }

  renderFrame() {
    const width = this.clientWidth;
    const height = this.clientHeight;
    const terrain = this.world.terrain;
    if (!width || !height || !terrain) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false);

    const heightAboveGround = this.updateCamera(terrain, width / height);
    const pending = this.world.update(this.camera, heightAboveGround);

    for (const overlay of this.overlays) {
      if (overlay.isRouteLine) overlay.object.visible = !this._routeLinesHidden;
      if (overlay.dirty) {
        overlay.dirty = false;
        overlay.sync(terrain, VIRTUAL_WORLD.scene);
      }
      overlay.setResolution?.(width, height);
    }

    this.renderer.render(this.world.scene, this.camera);
    if (pending) this.requestRender();
  }

  // Map3DElement camera → three.js camera. Returns the eye's height above
  // the ground below it.
  updateCamera(terrain, aspect) {
    const eye = cameraEyePosition({
      center: this._center,
      range: this._range,
      tilt: this._tilt,
      heading: this._heading,
    });
    if (!eye) return 0;
    const local = terrain.projection.toLocal(eye.lat, eye.lng);
    const camera = this.camera;
    camera.position.set(local.x, eye.altitude, local.z);
    // Heading 0 looks north (-z), clockwise positive; tilt 0 looks straight
    // down, 90 at the horizon; a positive roll banks right.
    camera.rotation.set((this._tilt - 90) * DEG, -this._heading * DEG, -this._roll * DEG);
    const heightAboveGround = Math.max(0, eye.altitude - terrain.heightAt(local.x, local.z));
    camera.fov = this._fov;
    camera.aspect = aspect;
    camera.far = Math.max(VIRTUAL_WORLD.scene.far_meters, heightAboveGround * 20);
    camera.updateProjectionMatrix();
    return heightAboveGround;
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, VirtualMap3DElement);

// The `maps3d`-shaped library the app keeps in `state.maps3d`.
export function loadVirtualMaps3d() {
  return {
    Map3DElement: VirtualMap3DElement,
    Polyline3DElement,
    Polygon3DElement,
    Model3DElement,
    AltitudeMode,
    MapMode,
  };
}
