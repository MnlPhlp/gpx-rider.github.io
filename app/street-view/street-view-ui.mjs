// Street imagery coordinator: shows real street-level photos in place of the
// 3D view while the rider is in the first-person camera and imagery exists
// for their position, fading back to the 3D view in gaps. It owns the layer
// element and its fade, the HUD status chip, the per-route scan lifecycle
// (keyed on route identity, so GPX loads, gallery loads and restored rides
// all restart it without a hook in route-load), the mounted renderer, and a
// light refresh loop. The provider-specific parts are behind two contracts —
// a *source* (mapillary-source.mjs) that fills the pure frame index
// (frame-index.mjs) and a *renderer* (mapillary-renderer.mjs) that shows a
// frame — so a future "replay my own ride video" provider plugs in here
// without touching the selection, fallback or coverage logic.
//
// Why its own setTimeout loop instead of riding updateRideUi's slow cadence:
// the layer must also react while the rider is parked — to a camera preset
// change, or a manual map drag (endUserInteraction in follow-camera.mjs,
// which does not run updateRideUi) that takes the camera out of first
// person — the same reason camera-debug.mjs polls on its own.

import { isFirstPersonCameraView } from "../camera/camera-ui.mjs";
import { deployedMapillaryToken } from "../config.mjs";
import { els, state } from "../core/state.mjs";
import { STREET_IMAGERY } from "../core/tuning.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { currentSpeedKph, isMoving } from "../ride/movement.mjs";
import { renderProfile } from "../route/profile-ui.mjs";
import {
  addCandidates,
  approachFraction,
  countFramesBy,
  coveragePercent,
  coverageSegments,
  createFrameIndex,
  frameByRef,
  frameForProgress,
  longestGapMeters,
  nextFrame,
} from "./frame-index.mjs";
import { createMapillaryRenderer } from "./mapillary-renderer.mjs";
import { createMapillarySource } from "./mapillary-source.mjs";
import { renderStreetImageryCoverage } from "./street-view-settings.mjs";

export function resolveMapillaryToken() {
  return state.mapillaryToken.trim() || deployedMapillaryToken();
}

// Boot: register the chip with the screen manager (center column, under the
// climb banner and demo chip), stamp the fade duration, and keep the viewer
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
// off (the scan then runs once, without mounting the viewer).
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
    if (si.indexRoute !== route) startScan(route);
    ensureRenderer();
  }

  if (!isFirstPersonCameraView()) {
    setLayerVisible(false);
    els.streetImageryChip.hidden = true;
    return;
  }

  let frame = null;
  if (si.index && si.status !== "token-error") {
    frame = frameForProgress(si.index, state.progressMeters, si.current, selectionOptions());
  }
  if (!frame) {
    si.current = null;
  } else if (si.renderer) {
    frame = driveRenderer(frame);
  }
  if (frame && frame !== si.current?.frame) si.current = { frame, sinceMs: performance.now() };
  setLayerVisible(Boolean(frame && si.renderer));
  renderChip(frame);
}

// Keep the viewer rolling: if the image it is on (or heading to) is still
// within reach of the rider, let it continue and queue the next image behind
// it so the motion never stops; otherwise hard-cut to the frame the selection
// wants (first show, a seek, a gap). Returns the frame actually on screen.
function driveRenderer(wanted) {
  const si = state.streetImagery;
  const c = STREET_IMAGERY;
  const progress = state.progressMeters;
  const onScreen = frameByRef(si.index, si.renderer.currentRef());
  const inReach = onScreen
    && onScreen.distanceMeters >= progress - c.max_behind_meters
    && onScreen.distanceMeters <= progress + c.max_ahead_meters;
  let shown = wanted;
  if (inReach) {
    shown = onScreen;
  } else if (si.renderer.showFrame(wanted) && state.cameraDebugEnabled) {
    console.debug(`[street-imagery] hard cut → ${wanted.ref}`);
  }
  const upcoming = nextFrame(si.index, shown, selectionOptions());
  if (upcoming) si.renderer.queueFrame(upcoming);
  si.renderer.pace({ progressMeters: progress, speedMps: isMoving() ? currentSpeedKph() / 3.6 : 0 });
  si.renderer.setApproach(approachFraction(si.index, shown, progress));
  return shown;
}

function handleViewerMotion(inMotion) {
  const si = state.streetImagery;
  const now = performance.now();
  if (inMotion) {
    si.motionStartedMs = now;
  } else if (state.cameraDebugEnabled && si.motionStartedMs) {
    console.debug(`[street-imagery] transition took ${((now - si.motionStartedMs) / 1000).toFixed(2)} s`);
  }
  si.inMotion = inMotion;
}

function selectionOptions() {
  const c = STREET_IMAGERY;
  return {
    nowMs: performance.now(),
    minDwellMs: c.min_dwell_ms,
    switchFraction: c.switch_hysteresis_fraction,
    maxBehindMeters: c.max_behind_meters,
    maxAheadMeters: c.max_ahead_meters,
    minAdvanceMeters: c.min_advance_meters,
    sameSequenceBonusMeters: c.same_sequence_bonus_meters,
    ownImageryBonusMeters: c.own_imagery_bonus_meters,
    panoBonusMeters: c.pano_bonus_meters,
    preferredCreator: state.mapillaryUsername || null,
  };
}

// --- scan lifecycle --------------------------------------------------------

function startScan(route) {
  const si = state.streetImagery;
  resetIndex();
  const c = STREET_IMAGERY;
  const index = createFrameIndex(route, {
    maxOffsetMeters: c.max_offset_meters,
    headingToleranceDegrees: c.heading_tolerance_degrees,
    bearingSampleMeters: c.heading_sample_meters,
  });
  si.index = index;
  si.indexRoute = route;
  si.status = "scanning";
  if (!si.source) si.source = createMapillarySource({ token: si.token, config: c });

  const controller = new AbortController();
  si.scanController = controller;
  let batchesSinceCoverage = 0;
  si.scanPromise = si.source.scanRoute(route, {
    signal: controller.signal,
    startMeters: state.progressMeters,
    onCandidates: (candidates) => {
      if (si.index !== index) return;
      addCandidates(index, candidates);
      batchesSinceCoverage += 1;
      if (batchesSinceCoverage >= 10) {
        batchesSinceCoverage = 0;
        updateCoverage();
      }
    },
    onProgress: (progress) => {
      if (si.index !== index) return;
      si.scan = progress;
      renderStreetImageryCoverage();
    },
  }).then(() => {
    if (si.index !== index) return;
    si.scanDone = true;
    si.status = "ready";
    updateCoverage();
  }).catch((error) => {
    if (si.index !== index || controller.signal.aborted) return;
    si.scanDone = true;
    if (error?.code === "token") {
      si.status = "token-error";
    } else {
      si.status = "ready";
      console.warn("[street-imagery] route scan failed", error);
    }
    updateCoverage();
  });
}

function abortScan() {
  const si = state.streetImagery;
  si.scanController?.abort();
  si.scanController = null;
}

function resetIndex() {
  const si = state.streetImagery;
  abortScan();
  si.index = null;
  si.indexRoute = null;
  si.scanPromise = null;
  si.scanDone = false;
  si.scan = { done: 0, total: 0 };
  si.coverage = null;
  si.current = null;
  renderProfile();
  renderStreetImageryCoverage();
}

// A different token means a different source and viewer session: start over.
function resetForToken(token) {
  const si = state.streetImagery;
  resetIndex();
  unmountRenderer();
  si.source = null;
  si.token = token;
  si.status = token ? "scanning" : "no-token";
}

function updateCoverage() {
  const si = state.streetImagery;
  if (!si.index) return;
  const segments = coverageSegments(si.index, STREET_IMAGERY.coverage_gap_meters);
  si.coverage = {
    segments,
    percent: coveragePercent(segments, si.index.totalMeters),
    frames: si.index.frames.length,
    own: countFramesBy(si.index, state.mapillaryUsername || null),
    longestGapMeters: longestGapMeters(segments, si.index.totalMeters),
  };
  renderProfile();
  renderStreetImageryCoverage();
}

// --- renderer + layer --------------------------------------------------------

function ensureRenderer() {
  const si = state.streetImagery;
  if (si.renderer || si.rendererPromise || si.status === "load-error") return;
  const renderer = createMapillaryRenderer({
    token: si.token,
    config: STREET_IMAGERY,
    onError: (error) => console.warn("[street-imagery] viewer", error),
    onMotion: handleViewerMotion,
  });
  const promise = renderer.mount(els.streetImageryLayer).then(() => {
    if (si.rendererPromise !== promise) {
      // Torn down (disabled / token changed) while the library was loading.
      renderer.unmount();
      return;
    }
    si.rendererPromise = null;
    si.renderer = renderer;
  }).catch((error) => {
    console.warn("[street-imagery] viewer failed to load", error);
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
  // Let the fade-out finish before the viewer's canvas disappears.
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
  si.token = null;
  si.status = status;
  els.streetImageryChip.hidden = true;
}

// --- HUD chip ------------------------------------------------------------------

function renderChip(frame) {
  const si = state.streetImagery;
  const c = STREET_IMAGERY;
  let text;
  let offerContribute = false;
  // "live" = a photo is on screen right now; "gap" = riding the 3D view
  // because nothing covers this spot; "status" = scanning / token trouble.
  let chipState = "status";
  if (!si.token) {
    text = c.chip_no_token;
  } else if (si.status === "token-error") {
    text = c.chip_token_rejected;
  } else if (si.status === "load-error") {
    text = c.chip_load_error;
  } else if (frame) {
    const year = frame.capturedAt ? ` · ${new Date(frame.capturedAt).getFullYear()}` : "";
    const creator = frame.creator ? ` · @${frame.creator}` : "";
    text = `${c.chip_prefix} · © Mapillary${creator}${year}`;
    chipState = "live";
  } else if (!si.scanDone) {
    const percent = si.scan.total ? Math.round((si.scan.done / si.scan.total) * 100) : 0;
    text = `${c.chip_scanning} ${percent}%`;
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
