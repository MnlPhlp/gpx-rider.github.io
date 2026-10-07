// Deterministic render steps: configure the recording view (hidden overlays,
// speed, camera, viewport size) and advance the app clock (core/clock.mjs) by
// exactly one frame at a time. Because every motion in the app reads
// `nowMs()`, the ride, the camera chase, transition arcs and the finish orbit
// all step deterministically — a video is identical however slowly frames are
// grabbed. Two consumers: the in-browser stepped video export
// (video-export.mjs) and, when app.html is opened with `?render=1`, the
// headless batch renderer scripts/render_replay_video.py, for which this
// module freezes the clock before any loop starts and publishes the same
// steps on `window.gpxRiderRender`.

import { applyCameraViewPreset } from "../camera/camera-ui.mjs";
import { enterOverviewMode } from "../camera/overview-camera.mjs";
import { advanceVirtualClock, enableVirtualClock } from "../core/clock.mjs";
import { enterTheaterMode } from "../hud/theater-mode.mjs";
import { pauseReplay, seekReplayToSeconds, setReplaySpeed, startReplay } from "./replay-mode.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { applyDisplaySettings, syncDisplayControls } from "../settings/settings-ui.mjs";
import { els, state } from "../core/state.mjs";

const HIDE_FLAGS = {
  clock: "theaterHideClock",
  meters: "theaterHideMeters",
  dock: "theaterHideDock",
  "climb-banner": "theaterHideClimbBanner",
  "demo-chip": "theaterHideDemoChip",
  controls: "theaterHideControls",
  minimap: "theaterHideMinimap",
};

export function renderModeRequested() {
  return new URLSearchParams(location.search).get("render") === "1";
}

// Called first thing in startApp when render mode is requested.
export function initRenderHook() {
  if (!renderModeRequested()) return;
  enableVirtualClock();
  document.documentElement.classList.add("render-mode");
  window.gpxRiderRender = {
    // The script polls this until a recorded ride is loaded.
    status: renderStatus,
    configure: configureRecordingView,
    start: () => startReplay(),
    step: stepAppClock,
  };
}

export function renderStatus() {
  const replay = state.replay;
  const duration = replay.timeline?.durationSeconds ?? 0;
  return {
    routeLoaded: state.route.length > 1,
    replayLoaded: Boolean(replay.timeline),
    mapReady: Boolean(state.map),
    playing: replay.playing,
    elapsedSeconds: replay.elapsedSeconds,
    durationSeconds: duration,
    progressMeters: state.progressMeters,
    finished: Boolean(replay.timeline) && !replay.playing && replay.elapsedSeconds >= duration,
    finishOrbit: state.finishOrbitActive,
    cameraMode: state.cameraMode,
  };
}

// hide: overlay keys (see HIDE_FLAGS), or null to keep the current toggles;
// speed: multiplier; camera: "follow" | "first-person" | null to keep;
// width/height: the recording viewport in CSS pixels.
export function configureRecordingView({ hide = null, speed = null, camera = null, width = null, height = null } = {}) {
  if (Array.isArray(hide)) {
    for (const [key, flag] of Object.entries(HIDE_FLAGS)) state[flag] = hide.includes(key);
    syncDisplayControls();
    applyDisplaySettings();
  }
  if (Number(width) > 0 && Number(height) > 0) {
    els.mapViewport.style.setProperty("--recording-viewport-w", `${Math.round(width)}px`);
    els.mapViewport.style.setProperty("--recording-viewport-h", `${Math.round(height)}px`);
  }
  if (speed !== null) setReplaySpeed(Number(speed));
  if (camera !== null) applyCameraViewPreset(camera === "first-person" ? "firstPerson" : "default");
  if (!state.theaterMode) enterTheaterMode();
  // Our own buttons stay out of the frames, like a screenshot.
  els.mapViewport.classList.add("capturing");
  // Park at the start on the whole-route overview; starting the replay then
  // flies the camera down to the rider exactly as in a live ride.
  pauseReplay({ silent: true });
  seekReplayToSeconds(0);
  state.overviewActive = true;
  state.finishOrbitActive = false;
  enterOverviewMode({ instant: true });
  updateRideUi({ force: true });
  return renderStatus();
}

// Advances the app clock by one frame and lets every animation loop process
// it: in the first animation frame the loops observe the new time and set
// the map's camera, by the second the map has rendered it. `onRendered` runs
// inside that second frame's callback — before the browser paints — so
// anything it changes (the stepped export's frame tag) lands in the same
// composited frame as the stepped state. Reports where the ride stands.
export function stepAppClock(deltaMs, onRendered = null) {
  advanceVirtualClock(deltaMs);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      onRendered?.();
      resolve(renderStatus());
    }));
  });
}

// Resolves once the 3D map reports a steady frame (all tiles for the current
// camera loaded) or after `timeoutMs`, whichever is first — a step may move
// the camera into imagery that is still streaming. A timeout of 0 skips the
// wait: a camera that moves every frame is rarely "steady", and tiles stream
// in progressively exactly as during live playback.
export function waitForMapSteady(timeoutMs) {
  const map = state.map;
  if (!(timeoutMs > 0) || !map || map.isSteady !== false) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (steady) => {
      if (done) return;
      done = true;
      map.removeEventListener("gmp-steadychange", onChange);
      window.clearTimeout(timer);
      resolve(steady);
    };
    const onChange = (event) => {
      if (event.isSteady) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    map.addEventListener("gmp-steadychange", onChange);
  });
}
