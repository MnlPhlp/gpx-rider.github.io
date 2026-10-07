// Video export of a ride replay — the recording view's export tooling. The
// "preview" is theater mode itself: the viewport pinned to the recording
// size, the toolbar's overlay toggles, speed and camera deciding what the
// video shows. "Record video" then records exactly that viewport in real
// time through the browser's tab capture and a MediaRecorder
// (map/video-capture.mjs) while the replay plays: it opens on the route
// overview for an intro, flies the camera down to the rider and plays the
// replay from the start once the camera has arrived, keeps rolling through
// the finish-line orbit for an outro, then saves the file. Chrome
// keeps rendering a captured tab, so the tab may go to the background
// meanwhile. The viewport carries the `capturing` class while recording so
// our own buttons stay out of the video (Google's attribution always stays
// in); the REC chip shows the progress. "Copy render command" hands the same
// choices to the optional headless batch renderer
// (scripts/render_replay_video.py).
//
// A frame-stepped export (frozen app clock, one step per captured frame,
// WebCodecs) was built first and removed again: a tab capture never delivers
// more frames than the display refreshes and the 3D map draws, so it topped
// out at 1–2× real time for considerably more machinery.

import { applyCameraViewPreset } from "../camera/camera-ui.mjs";
import { enterOverviewMode } from "../camera/overview-camera.mjs";
import { enterTheaterMode, recordingViewportAspect } from "../hud/theater-mode.mjs";
import {
  downloadVideoBlob,
  startViewportRecording,
  videoCaptureSupported,
  videoFileExtension,
} from "../map/video-capture.mjs";
import { buildRenderCommand, hiddenOverlayKeys } from "./render-command.mjs";
import {
  cancelReplayCameraWait,
  pauseReplay,
  replayWatchSecondsLeft,
  seekReplayToSeconds,
  startReplayWhenCameraArrives,
} from "./replay-mode.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { RIDE_REPLAY_VIDEO } from "../core/tuning.mjs";
import { formatDuration } from "../core/units.mjs";

// How often the REC chip's progress readout refreshes.
const RECORD_STATUS_INTERVAL_MS = 1000;

export function videoExportSupported() {
  return videoCaptureSupported();
}

// --- Camera choice & the headless render command --------------------------------

// The toolbar's camera select applies the preset to the live map, so the
// preview shows the camera the video will use. The default is the angled
// follow camera; first person is the explicit alternative.
export function updateReplayCameraFromControl() {
  applyReplayCameraChoice();
  syncRecordButton();
}

// Entering the recording view (and starting a recording) puts the camera on
// the toolbar's choice.
export function applyReplayCameraChoice() {
  applyCameraViewPreset(selectedReplayCamera() === "first-person" ? "firstPerson" : "default");
}

function selectedReplayCamera() {
  return els.replayCameraSelect?.value === "first-person" ? "first-person" : "follow";
}

export async function copyRenderCommand() {
  const command = buildRenderCommand({
    hide: hiddenOverlayKeys({
      clock: state.theaterHideClock,
      meters: state.theaterHideMeters,
      dock: state.theaterHideDock,
      climbBanner: state.theaterHideClimbBanner,
      demoChip: state.theaterHideDemoChip,
      controls: state.theaterHideControls,
      minimap: state.theaterHideMinimap,
      routeAhead: state.theaterHideRouteAhead,
    }),
    speed: state.replay.speed,
    camera: selectedReplayCamera(),
  });
  try {
    await navigator.clipboard.writeText(command);
    updateProgressLabel("Render command copied — run it from the repository root with your ride file.");
  } catch (error) {
    console.warn("Clipboard write failed; showing the command instead.", error);
    window.prompt("Headless render command (copy it):", command);
  }
}

// --- Recording ------------------------------------------------------------------

export function toggleReplayVideoExport() {
  if (state.replay.recording) void stopReplayVideoExport();
  else void startReplayVideoExport();
}

export async function startReplayVideoExport() {
  const replay = state.replay;
  if (!replay.timeline || replay.recording || replay.exportStarting) return;
  if (!videoExportSupported()) {
    updateProgressLabel("Video export needs a browser with tab capture (Chrome or Edge).");
    return;
  }
  if (!state.theaterMode) enterTheaterMode();
  applyReplayCameraChoice();

  // Park the rider at the start in the route overview so the video opens on
  // the whole route and flies down to the rider as the replay starts.
  pauseReplay({ silent: true });
  seekReplayToSeconds(0);
  state.overviewActive = true;
  state.finishOrbitActive = false;
  enterOverviewMode({ instant: true });
  updateRideUi({ force: true });

  replay.exportStarting = true;
  syncRecordButton();
  updateProgressLabel("Choose “This Tab” in the share dialog to start recording…");
  try {
    replay.recorder = await startViewportRecording(els.mapViewport, {
      outputWidth: RIDE_REPLAY_VIDEO.output_width,
      outputAspect: recordingViewportAspect(),
      frameRate: RIDE_REPLAY_VIDEO.frame_rate,
      videoBitsPerSecond: RIDE_REPLAY_VIDEO.bits_per_second,
      mimeTypePreferences: RIDE_REPLAY_VIDEO.mime_preferences,
      onMessage: updateProgressLabel,
      // The browser's own "Stop sharing" bar ends the export too.
      onEnded: () => { void stopReplayVideoExport(); },
    });
  } catch (error) {
    replay.exportStarting = false;
    syncRecordButton();
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      updateProgressLabel("Video export cancelled.");
    } else {
      console.error("Video export could not start.", error);
      updateProgressLabel(`Video export could not start — ${error?.message ?? "choose “This Tab” in the share dialog."}`);
    }
    return;
  }

  replay.exportStarting = false;
  replay.recording = true;
  els.mapViewport.classList.add("capturing");
  syncRecordButton();

  const { outputWidth, outputHeight } = replay.recorder;
  updateProgressLabel(
    `Recording ${outputWidth}×${outputHeight} in real time — the tab may go to the background; press Stop & save any time.`,
  );
  replay.statusTimer = window.setInterval(updateRecordStatus, RECORD_STATUS_INTERVAL_MS);
  updateRecordStatus();
  // A short still of the overview, then the camera flies down to the rider
  // at the start; the ride begins once it has arrived.
  window.setTimeout(() => {
    if (state.replay.recording) {
      startReplayWhenCameraArrives({ maxWaitSeconds: RIDE_REPLAY_VIDEO.start_wait_max_seconds });
    }
  }, RIDE_REPLAY_VIDEO.intro_seconds * 1000);
}

// The REC chip carries the recording's progress: how far the ride is, how
// long the rest takes at the playback speed, and the file size so far. The status line under the progress bar keeps showing
// the ride readout.
function updateRecordStatus() {
  const replay = state.replay;
  if (!replay.recording || !replay.recorder) return;
  const duration = replay.timeline?.durationSeconds ?? 0;
  const done = duration > 0 ? Math.min(1, replay.elapsedSeconds / duration) : 0;
  setRecordStatus(
    `REC ${Math.round(done * 100)}% · ${formatDuration(replay.elapsedSeconds, "clock")} of `
      + `${formatDuration(duration, "clock")} · ${formatDuration(replayWatchSecondsLeft() ?? 0, "clock")} left · `
      + `${(replay.recorder.bytes / 1_048_576).toFixed(0)} MB`,
  );
}

// The replay reached the finish while recording: let the finish-line orbit
// play for the outro, then save.
export function handleReplayFinishedWhileRecording() {
  const replay = state.replay;
  if (!replay.recording || replay.outroTimer) return;
  replay.outroTimer = window.setTimeout(() => {
    replay.outroTimer = null;
    void stopReplayVideoExport();
  }, RIDE_REPLAY_VIDEO.outro_seconds * 1000);
}

export async function stopReplayVideoExport() {
  const replay = state.replay;
  if (!replay.recording || !replay.recorder) return;
  const recorder = replay.recorder;
  replay.recording = false;
  replay.recorder = null;
  window.clearTimeout(replay.outroTimer);
  replay.outroTimer = null;
  window.clearInterval(replay.statusTimer);
  replay.statusTimer = null;
  cancelReplayCameraWait();
  els.mapViewport.classList.remove("capturing");
  pauseReplay({ silent: true });
  syncRecordButton();
  updateProgressLabel("Finishing the video…");

  const blob = await recorder.stop();
  if (!blob || blob.size === 0) {
    updateProgressLabel("The recording came out empty — nothing was saved.");
    return;
  }
  downloadVideoBlob(blob, videoFileName(recorder.mimeType));
  updateProgressLabel(`Video saved (${(blob.size / 1_048_576).toFixed(1)} MB).`);
}

function videoFileName(mimeType) {
  // "Ještěd" → "jested": strip diacritics before dropping non-ASCII.
  const base = (state.replay.sourceName || state.routeName || "ride")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "ride";
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("") + "-" + [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `gpx-rider-${base}-${stamp}.${videoFileExtension(mimeType)}`;
}

// The REC chip's text (its pulse dot is kept).
function setRecordStatus(text) {
  const chip = els.replayRecordStatus;
  if (!chip) return;
  const pulse = chip.querySelector(".recording-pulse");
  chip.replaceChildren(...(pulse ? [pulse] : []), document.createTextNode(text));
}

export function syncRecordButton() {
  const replay = state.replay;
  const button = els.replayRecordBtn;
  if (!button) return;
  if (replay.recording && els.replayRecordStatus?.hidden) setRecordStatus("REC");
  button.disabled = !replay.timeline || replay.exportStarting || !videoExportSupported();
  button.classList.toggle("recording", replay.recording);
  button.setAttribute("aria-pressed", String(replay.recording));
  button.textContent = replay.recording ? "Stop & save" : replay.exportStarting ? "Starting…" : "Record video";
  button.title = "Record the replay as a video right here, in real time (share “This Tab” when asked)";
  if (els.replayRecordStatus) {
    els.replayRecordStatus.hidden = !replay.recording;
  }
  if (els.replayCopyCommandBtn) els.replayCopyCommandBtn.disabled = !replay.timeline || replay.recording;
  if (els.replayCameraSelect) {
    els.replayCameraSelect.disabled = replay.recording;
    els.replayCameraSelect.value = state.cameraViewPreset === "firstPerson" ? "first-person" : "follow";
  }
}
