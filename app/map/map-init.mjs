// Map bootstrap: Maps API key resolution (visitor-saved key wins over the
// deploy-time key baked into config.mjs), the Google Maps JS loader, and the
// creation of the 3D map — Google's photorealistic one or the virtual world
// (world/), per the Map rendering setting, swappable mid-session — and the 2D
// minimap.

import { computeFollowCamera } from "../camera/camera.mjs";
import { deployedMapsApiKey } from "../config.mjs";
import { bindManualCameraCapture } from "../camera/follow-camera.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { removeGhostMarker } from "../replay/ghost-ui.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import { clearRouteFromMap, renderRoute } from "./route-render.mjs";
import { openSettings } from "../settings/settings-ui.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { DEFAULT_MAP_FOV_DEGREES } from "../core/tuning.mjs";

// Deliberately localStorage, not storage.mjs: saving the key reloads the page
// immediately, and only a synchronous write is guaranteed to survive that.
const MAPS_API_KEY_STORAGE_KEY = "gpx-rider:maps-api-key";

export function getStoredMapsApiKey() {
  return localStorage.getItem(MAPS_API_KEY_STORAGE_KEY) || "";
}

// A key a visitor pasted into Settings always wins; otherwise fall back to
// whatever this deployment baked in at build time (see config.mjs).
export function resolveMapsApiKey() {
  return getStoredMapsApiKey() || deployedMapsApiKey();
}

export function saveMapsApiKey() {
  const key = els.mapsApiKeyInput.value.trim();
  if (key) {
    localStorage.setItem(MAPS_API_KEY_STORAGE_KEY, key);
  } else {
    localStorage.removeItem(MAPS_API_KEY_STORAGE_KEY);
  }
  location.reload();
}

// The minimap pins to the far end of the right column (align "end"), so it
// sits just above the bottom dock no matter what stacks above it.
export function registerMinimapHud() {
  registerHudComponent({ id: "minimap", region: "right", weight: 30, element: els.minimap, align: "end" });
}

export async function initMap() {
  els.mapRendererSelect.value = state.mapRenderer;
  const apiKey = resolveMapsApiKey();
  if (!apiKey && state.mapRenderer !== "virtual") {
    updateProgressLabel("Add your Google Maps API key in Settings (⚙, top right) to load the map, or switch Map rendering to a virtual world.");
    // First run: the key input lives in the settings dialog's Data &
    // storage panel, so open the dialog on that panel.
    openSettings("data");
    return;
  }

  // The virtual world needs no key, but still gets the Google minimap when
  // one is available.
  if (apiKey) {
    try {
      await loadGoogleMaps(apiKey);
      initMinimap();
    } catch (error) {
      console.error(error);
      if (state.mapRenderer !== "virtual") {
        updateProgressLabel("Photorealistic 3D Maps did not load. Check that the 3D Maps feature is enabled for your Google API key.");
        return;
      }
    }
  }

  // The virtual world without a key has no Google minimap: drop its slot.
  els.minimap.hidden = !state.minimapMap;
  await createMainMap(initialCamera());
}

// The 3D map for the chosen renderer, mounted into #map with `camera`.
async function createMainMap(camera) {
  try {
    if (state.mapRenderer === "virtual") await initVirtualWorldMap(camera);
    else await initGooglePhotorealistic3DMap(camera);
    bindManualCameraCapture();
  } catch (error) {
    console.error(error);
    updateProgressLabel(state.mapRenderer === "virtual"
      ? "The virtual world could not start. This browser may not support WebGL."
      : "Photorealistic 3D Maps did not load. Check that the 3D Maps feature is enabled for your Google API key.");
  }
}

// The side panel's Map rendering select: persist the choice and swap the map.
export function updateMapRendererFromControl() {
  const renderer = els.mapRendererSelect.value === "virtual" ? "virtual" : "google";
  if (renderer === state.mapRenderer) return;
  state.mapRenderer = renderer;
  saveSettings();
  applyMapRenderer();
}

// Swap the 3D map to the renderer in state.mapRenderer mid-session, keeping
// the camera where it is: the old map's overlays are taken down, the new map
// takes the same pose, and the route, rider and ghost are drawn onto it.
export async function applyMapRenderer() {
  const wanted = state.mapRenderer === "virtual" ? "virtual" : "google3d";
  if (!state.map) {
    // No map yet (e.g. no API key at boot): the new choice may now work.
    await initMap();
    if (state.map && state.route.length) {
      renderRoute();
      updateRideUi({ force: true });
    }
    return;
  }
  if (state.mapProvider === wanted) return;
  if (wanted === "google3d" && !window.google?.maps) {
    // Google was never loaded (no key, or the virtual world needed none):
    // keep the current map and point at the key setting.
    updateProgressLabel("Add your Google Maps API key in Settings › Data & storage to use the photorealistic map.");
    return;
  }

  const camera = currentCameraSnapshot();
  clearRouteFromMap();
  removeGhostMarker();
  state.map.remove();
  state.map = null;
  state.maps3d = null;
  state.mapProvider = null;
  await createMainMap(camera);
  if (state.map && state.route.length) {
    renderRoute();
    updateRideUi({ force: true });
  }
}

function currentCameraSnapshot() {
  const map = state.map;
  // Read each field: Google's LatLngAltitude keeps them in prototype getters,
  // which a spread would drop.
  const { lat, lng, altitude } = map.center ?? {};
  return {
    center: { lat: Number(lat) || 0, lng: Number(lng) || 0, altitude: Number(altitude) || 0 },
    heading: Number(map.heading) || 0,
    range: Number(map.range) || 1000,
    tilt: Number(map.tilt) || 0,
    roll: Number(map.roll) || 0,
    fov: Number(map.fov) || DEFAULT_MAP_FOV_DEGREES,
  };
}

function initialCamera() {
  const camera = computeFollowCamera({
    riderPosition: { lat: 46.8182, lng: 8.2275 },
    heading: 0,
    cameraZoom: state.cameraZoom,
    cameraBehindMeters: state.cameraBehindMeters,
    cameraAngleDegrees: state.cameraAngleDegrees,
  });
  return { ...camera, center: { ...camera.center, altitude: 0 }, roll: 0, fov: DEFAULT_MAP_FOV_DEGREES };
}

function initMinimap() {
  try {
    state.minimapMap = new google.maps.Map(els.minimap, {
      mapTypeId: google.maps.MapTypeId.HYBRID,
      center: { lat: 46.8182, lng: 8.2275 },
      zoom: 12,
      disableDefaultUI: true,
      gestureHandling: "none",
      clickableIcons: false,
      keyboardShortcuts: false,
      backgroundColor: "#cdd7d1",
    });
  } catch (error) {
    console.error(error);
  }
}

// The synthetic three.js world (world/virtual-map3d.mjs), imported on demand so
// the Google renderer never downloads three.js. Its library mirrors maps3d.
async function initVirtualWorldMap(camera) {
  const { loadVirtualMaps3d } = await import("../world/virtual-map3d.mjs");
  state.maps3d = loadVirtualMaps3d();
  const { Map3DElement, MapMode } = state.maps3d;
  state.mapProvider = "virtual";
  const mapEl = document.querySelector("#map");
  mapEl.replaceChildren();
  state.map = new Map3DElement({
    ...camera,
    mode: state.mapLabelsEnabled ? MapMode.HYBRID : MapMode.SATELLITE,
  });
  mapEl.append(state.map);
}

async function initGooglePhotorealistic3DMap(camera) {
  state.maps3d = await google.maps.importLibrary("maps3d");
  const { Map3DElement, MapMode } = state.maps3d;
  if (!Map3DElement) throw new Error("Map3DElement is not available.");

  state.mapProvider = "google3d";
  const mapEl = document.querySelector("#map");
  mapEl.replaceChildren();
  state.map = new Map3DElement({
    center: camera.center,
    heading: camera.heading,
    roll: camera.roll,
    fov: camera.fov,
    // HYBRID adds place labels (roads, towns) on top of the satellite
    // imagery; toggled in Settings → Display & HUD.
    mode: state.mapLabelsEnabled ? MapMode?.HYBRID : MapMode?.SATELLITE,
    range: camera.range,
    tilt: camera.tilt,
    // Hide the default UI buttons (compass, zoom); gestures still work and
    // the view stays clean for riding and screenshots. Never touch
    // googleLogoDisabled/legalNoticesDisabled — attribution must stay
    // visible under the Google Maps ToS.
    defaultUIDisabled: true,
  });
  mapEl.append(state.map);
}

function loadGoogleMaps(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=beta`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load the Google Maps JavaScript API."));
    document.head.append(script);
  });
}
