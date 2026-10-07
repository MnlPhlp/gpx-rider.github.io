// Street imagery coordinator: shows real street-level photos in place of the
// 3D view while the rider is in the first-person camera and imagery exists
// for their position, fading back to the 3D view in gaps. It owns the layer
// element and its fade, the HUD status chip, the per-route lifecycle keyed
// on route identity (so GPX loads, gallery loads and restored rides all
// restart it without a hook in route-load — the scan/plan/cache work itself
// lives in street-view-plan.mjs), the mounted renderer, and a light refresh
// loop. The provider-specific parts are
// behind two contracts — a *source* (mapillary-source.mjs) that fills the
// pure frame index (frame-index.mjs) and a *renderer* (sfm-renderer.mjs)
// that plays a plan — so a future "replay my own ride video" provider plugs
// in here without touching the planning, fallback or coverage logic.
//
// Why its own setTimeout loop instead of riding updateRideUi's slow cadence:
// the layer must also react while the rider is parked — to a camera preset
// change, or a manual map drag (endUserInteraction in follow-camera.mjs,
// which does not run updateRideUi) that takes the camera out of first
// person — the same reason camera-debug.mjs polls on its own. The renderer
// samples the ride position itself every animation frame.

import { isFirstPersonCameraView } from "../camera/camera-ui.mjs";
import { currentRouteHeading } from "../camera/follow-camera.mjs";
import { deployedMapillaryToken } from "../config.mjs";
import { els, state } from "../core/state.mjs";
import { STREET_IMAGERY } from "../core/tuning.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { currentSpeedKph, isMoving } from "../ride/movement.mjs";
import { chainPositionAt } from "./playback-plan.mjs";
import { createSfmRenderer } from "./sfm-renderer.mjs";
import { ensureStore, maybeBuildPlan, resetIndex, startRoute, startScan, updateCoverage } from "./street-view-plan.mjs";
import { renderStreetImageryCoverage } from "./street-view-settings.mjs";

export function resolveMapillaryToken() {
  return state.mapillaryToken.trim() || deployedMapillaryToken();
}

// Boot: register the chip with the screen manager (center column, under the
// climb banner and demo chip), stamp the fade duration, and keep the canvas
// sized to the layer through fullscreen/theater changes.
export function initStreetImagery() {
  els.mapViewport.style.setProperty("--street-imagery-fade-ms", `${STREET_IMAGERY.fade_ms}ms`);
  registerHudComponent({ id: "street-imagery", region: "center", weight: 30, element: els.streetImageryChip });
  els.streetImageryCredit.textContent = STREET_IMAGERY.attribution;
  els.mapillaryTokenHelpLink.href = STREET_IMAGERY.token_help_url;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => state.streetImagery.renderer?.resize()).observe(els.streetImageryLayer);
  }
}

// The one entry point for "the setting or the token changed": enabled → run
// the refresh loop (which starts scans, mounts the renderer and drives the
// layer); disabled → tear everything down and send nothing anywhere.
export function applyStreetImagerySetting() {
  if (state.streetImageryEnabled) {
    ensureStreetImageryLoop();
  } else {
    shutdown("off");
  }
  renderStreetImageryCoverage();
}

// Recompute the coverage summary (e.g. after the preferred username changed).
export function refreshStreetImageryCoverage() {
  updateCoverage();
}

// Coverage for the loaded route, scanning it first if needed — used by the
// contribute dialog's "check coverage" even while the feature is switched
// off (the scan then runs once, without mounting the renderer).
export async function ensureRouteCoverage() {
  const si = state.streetImagery;
  const token = resolveMapillaryToken();
  if (!token) throw new Error("no-token");
  if (state.route.length < 2) throw new Error("no-route");
  if (token !== si.token) resetForToken(token);
  if (si.indexRoute !== state.route) startScan(state.route);
  await si.scanPromise;
  if (si.status === "token-error") throw new Error("token-error");
  return si.coverage;
}

// Size of the local photo/mesh cache, and emptying it (Settings).
export async function imageryCacheStats() {
  return (await ensureStore()).cacheStats();
}

export async function clearImageryCache() {
  const si = state.streetImagery;
  await (await ensureStore()).clearCache();
  si.planFinal = false;
}

function ensureStreetImageryLoop() {
  const si = state.streetImagery;
  if (si.loopTimer) return;
  const step = () => {
    if (!state.streetImageryEnabled) {
      si.loopTimer = null;
      return;
    }
    stepStreetImagery();
    si.loopTimer = setTimeout(step, STREET_IMAGERY.refresh_ms);
  };
  step();
}

function stepStreetImagery() {
  const si = state.streetImagery;
  const route = state.route;
  const token = resolveMapillaryToken();
  if (token !== si.token) resetForToken(token);

  if (route.length < 2) {
    if (si.indexRoute) resetIndex();
    setLayerVisible(false);
    els.streetImageryChip.hidden = true;
    return;
  }
  if (si.token) {
    if (si.indexRoute !== route) startRoute(route);
    ensureRenderer();
    maybeBuildPlan();
  }

  if (!isFirstPersonCameraView()) {
    si.renderer?.setActive(false);
    setLayerVisible(false);
    els.streetImageryChip.hidden = true;
    return;
  }
  si.renderer?.setActive(true);

  const position = si.plan && si.status !== "token-error"
    ? chainPositionAt(si.plan, state.progressMeters, { maxBehindMeters: STREET_IMAGERY.max_behind_meters, maxAheadMeters: STREET_IMAGERY.max_ahead_meters })
    : null;
  const showing = Boolean(position && si.renderer?.isShowing());
  setLayerVisible(showing);
  renderChip(position, showing);
}

function sampleRendererInputs() {
  return {
    progressMeters: state.progressMeters,
    speedMps: isMoving() ? currentSpeedKph() / 3.6 : 0,
    routeBearingDeg: currentRouteHeading(),
    debug: state.cameraDebugEnabled,
  };
}

// A different token means a different source, store and renderer session.
function resetForToken(token) {
  const si = state.streetImagery;
  resetIndex();
  unmountRenderer();
  si.source = null;
  si.store = null;
  si.storePromise = null;
  si.token = token;
  si.status = token ? "scanning" : "no-token";
}

// --- renderer + layer ------------------------------------------------------------------

function ensureRenderer() {
  const si = state.streetImagery;
  if (si.renderer || si.rendererPromise || si.status === "load-error") return;
  if (performance.now() < si.rendererRetryAt) return;
  const promise = ensureStore().then(async (store) => {
    if (si.rendererPromise !== promise) return;
    const renderer = createSfmRenderer({
      store,
      config: STREET_IMAGERY,
      sampleInputs: sampleRendererInputs,
      onError: (error) => {
        if (error?.code === "context-lost") {
          console.warn("[street-imagery] WebGL context lost; restarting the renderer");
          unmountRenderer();
          si.rendererRetryAt = performance.now() + 1000;
          return;
        }
        console.warn("[street-imagery] renderer", error);
      },
    });
    await renderer.mount(els.streetImageryLayer);
    if (si.rendererPromise !== promise) {
      renderer.unmount();
      return;
    }
    si.rendererPromise = null;
    si.renderer = renderer;
    if (si.plan) renderer.setPlan(si.plan);
  }).catch((error) => {
    console.warn("[street-imagery] renderer failed to start", error);
    if (si.rendererPromise === promise) {
      si.rendererPromise = null;
      si.status = "load-error";
    }
  });
  si.rendererPromise = promise;
}

function unmountRenderer() {
  const si = state.streetImagery;
  setLayerVisible(false);
  si.rendererPromise = null;
  const renderer = si.renderer;
  si.renderer = null;
  if (!renderer) return;
  // Let the fade-out finish before the canvas disappears.
  setTimeout(() => renderer.unmount(), STREET_IMAGERY.fade_ms);
}

// Show/hide the photo layer. While it is fully opaque the 3D map underneath
// is taken out of layout (pause_map_when_covered) so it stops rendering and
// streaming tiles for a view nobody sees; it comes back before the fade-out
// starts so the reveal has a painted map under it.
function setLayerVisible(visible) {
  const si = state.streetImagery;
  if (si.visible === visible) return;
  si.visible = visible;
  clearTimeout(si.coverTimer);
  si.coverTimer = null;
  if (visible) {
    si.renderer?.setVisible(true);
    if (STREET_IMAGERY.pause_map_when_covered) {
      si.coverTimer = setTimeout(() => {
        si.coverTimer = null;
        if (si.visible) els.mapViewport.classList.add("street-imagery-covering");
      }, STREET_IMAGERY.fade_ms);
    }
  } else {
    els.mapViewport.classList.remove("street-imagery-covering");
    si.renderer?.setVisible(false);
  }
}

function shutdown(status) {
  const si = state.streetImagery;
  if (si.loopTimer) {
    clearTimeout(si.loopTimer);
    si.loopTimer = null;
  }
  resetIndex();
  unmountRenderer();
  si.source = null;
  si.store = null;
  si.storePromise = null;
  si.token = null;
  si.status = status;
  els.streetImageryChip.hidden = true;
}

// --- HUD chip ------------------------------------------------------------------

function renderChip(position, showing) {
  const si = state.streetImagery;
  const c = STREET_IMAGERY;
  let text;
  let offerContribute = false;
  // "live" = a photo is on screen right now; "gap" = riding the 3D view
  // because nothing covers this spot; "status" = scanning / token trouble.
  let chipState = "status";
  const node = showing ? si.plan.nodes.find((entry) => entry.ref === si.renderer.currentRef()) : null;
  if (!si.token) {
    text = c.chip_no_token;
  } else if (si.status === "token-error") {
    text = c.chip_token_rejected;
  } else if (si.status === "load-error") {
    text = c.chip_load_error;
  } else if (node) {
    const year = node.meta.capturedAt ? ` · ${new Date(node.meta.capturedAt).getFullYear()}` : "";
    const creator = node.meta.creator ? ` · @${node.meta.creator}` : "";
    text = `${c.chip_prefix} · © Mapillary${creator}${year}`;
    chipState = "live";
  } else if (!si.scanDone) {
    const percent = si.scan.total ? Math.round((si.scan.done / si.scan.total) * 100) : 0;
    text = `${c.chip_scanning} ${percent}%`;
  } else if (!si.plan || (position && !showing)) {
    text = c.chip_planning;
  } else {
    text = c.chip_no_imagery;
    offerContribute = true;
    chipState = "gap";
  }
  els.streetImageryChipText.textContent = text;
  els.streetImageryChipContributeBtn.hidden = !offerContribute;
  els.streetImageryChip.dataset.state = chipState;
  els.streetImageryChip.hidden = false;
}
