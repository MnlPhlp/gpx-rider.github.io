// "Theater mode": rather than resizing the actual browser window (most
// browsers block scripted resizing of a window/tab they didn't open via
// window.open()), pin the map viewport itself to an exact recording size in
// CSS pixels via the .theater-mode class (styles.css), centered over a dimmed
// backdrop, so a screen recording always captures a consistent size. A
// toolbar under the viewport (#theaterToolbar) holds the "hide in recording
// view" overlay toggles — what you see is what a recording or a replay video
// export shows — and, when a recorded ride is loaded, the replay transport
// and the Record button (replay/replay-mode.mjs, replay/video-export.mjs).
// Dismissed by Escape, the toolbar's Exit, or a click outside the map and
// toolbar (see the shared document keydown/click handlers in app.js), same
// convention as the camera menus.

import { renderProfile } from "../route/profile-ui.mjs";
import { applyReplayCameraChoice, syncRecordButton, stopReplayVideoExport } from "../replay/video-export.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import {
  RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS,
  RECORDING_MAP_VIEWPORT_TOLERANCE_PIXELS,
  RECORDING_MAP_VIEWPORT_WIDTH_PIXELS,
} from "../core/tuning.mjs";

// The one human-readable name of the configured recording size — every
// label, title and message naming the size derives from this, so retuning
// RECORDING_MAP_VIEWPORT_* in tuning.yaml changes the whole feature at once.
const RECORDING_SIZE_LABEL =
  `${RECORDING_MAP_VIEWPORT_WIDTH_PIXELS}x${RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS}`;

const ENTER_TITLE = `Frame the map at exactly ${RECORDING_SIZE_LABEL} px for recording`;
const EXIT_TITLE = `Exit the ${RECORDING_SIZE_LABEL} map view`;

// Gap kept between the pinned viewport and the toolbar, and the toolbar's
// distance from the window's bottom edge (also the CSS default).
const TOOLBAR_GAP_PX = 14;
const TOOLBAR_BOTTOM_PX = 14;

// Stamp the configured size into everything static: the CSS variables the
// .theater-mode rule sizes the viewport with, the toolbar's toggle label, and
// the toggle button's text/title. Called once at boot.
export function initTheaterModeUi() {
  els.mapViewport.style.setProperty("--recording-viewport-w", `${RECORDING_MAP_VIEWPORT_WIDTH_PIXELS}px`);
  els.mapViewport.style.setProperty("--recording-viewport-h", `${RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS}px`);
  els.resizeRecordingWindowBtn.textContent = `${RECORDING_SIZE_LABEL} map`;
  els.resizeRecordingWindowBtn.title = ENTER_TITLE;
  if (els.theaterHudTogglesLabel) {
    els.theaterHudTogglesLabel.textContent = `Hide in ${RECORDING_SIZE_LABEL} view`;
  }
  // The toolbar wraps with the window width; whatever height it ends up
  // with is reserved under the viewport so it can never overlap the
  // captured area (a toolbar inside the capture ends up in the video).
  if (els.theaterToolbar && typeof ResizeObserver === "function") {
    new ResizeObserver(reserveToolbarSpace).observe(els.theaterToolbar);
  }
  syncTheaterToolbar();
}

function reserveToolbarSpace() {
  if (!els.theaterToolbar || els.theaterToolbar.hidden) return;
  const height = els.theaterToolbar.offsetHeight;
  els.theaterToolbar.style.setProperty("--theater-toolbar-bottom", `${TOOLBAR_BOTTOM_PX}px`);
  els.mapViewport.style.setProperty("--theater-toolbar-reserve", `${height + TOOLBAR_BOTTOM_PX + TOOLBAR_GAP_PX}px`);
}

export function toggleTheaterMode(event) {
  event?.stopPropagation();
  if (state.theaterMode) exitTheaterMode();
  else enterTheaterMode();
}

export function enterTheaterMode() {
  if (document.fullscreenElement) {
    updateProgressLabel(`Exit fullscreen before opening the ${RECORDING_SIZE_LABEL} map view.`);
    return;
  }

  state.theaterMode = true;
  els.mapViewport.classList.add("theater-mode");
  els.resizeRecordingWindowBtn.setAttribute("aria-pressed", "true");
  els.resizeRecordingWindowBtn.title = EXIT_TITLE;
  // The recording view previews a video: it opens on the toolbar's camera
  // choice (the angled follow camera by default) when a recording is loaded.
  if (state.replay.timeline) applyReplayCameraChoice();
  syncTheaterToolbar();
  reportTheaterModeSize();
}

export function exitTheaterMode() {
  // Leaving the recording view mid-export ends the export and saves what
  // was recorded — the viewport is about to change size.
  if (state.replay.recording) void stopReplayVideoExport();
  state.theaterMode = false;
  els.mapViewport.classList.remove("theater-mode");
  els.resizeRecordingWindowBtn.setAttribute("aria-pressed", "false");
  els.resizeRecordingWindowBtn.title = ENTER_TITLE;
  syncTheaterToolbar();
  if (state.route.length) renderProfile();
}

export function closeTheaterModeOnOutsideClick(event) {
  if (!state.theaterMode) return;
  // Only a real pointer click dismisses: the screenshot/video download
  // helpers click a detached <a> programmatically, which bubbles here too.
  if (!event.isTrusted) return;
  if (els.mapViewport.contains(event.target) || els.theaterToolbar?.contains(event.target)) return;
  exitTheaterMode();
}

// The toolbar shows with theater mode; its replay section only when a
// recorded ride is loaded.
export function syncTheaterToolbar() {
  if (!els.theaterToolbar) return;
  els.theaterToolbar.hidden = !state.theaterMode;
  if (els.theaterToolbarReplay) els.theaterToolbarReplay.hidden = !state.replay.timeline;
  syncRecordButton();
  reserveToolbarSpace();
}

function currentMapViewportPixelSize() {
  const rect = els.mapViewport.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function recordingMapViewportIsSized(size) {
  return Math.abs(size.width - RECORDING_MAP_VIEWPORT_WIDTH_PIXELS) <= RECORDING_MAP_VIEWPORT_TOLERANCE_PIXELS
    && Math.abs(size.height - RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS) <= RECORDING_MAP_VIEWPORT_TOLERANCE_PIXELS;
}

function reportTheaterModeSize() {
  if (state.route.length) renderProfile();

  const size = currentMapViewportPixelSize();
  if (recordingMapViewportIsSized(size)) {
    updateProgressLabel(
      `Map view set to ${RECORDING_MAP_VIEWPORT_WIDTH_PIXELS}x${RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS} px.`,
    );
    return;
  }

  updateProgressLabel(
    `Map view is ${size.width}x${size.height} px — enlarge the browser window to fit the full `
      + `${RECORDING_MAP_VIEWPORT_WIDTH_PIXELS}x${RECORDING_MAP_VIEWPORT_HEIGHT_PIXELS} view.`,
  );
}
