// Video export of a ride replay — the recording view's export tooling. The
// "preview" is theater mode itself: the viewport pinned to the recording
// size, the toolbar's overlay toggles, speed and camera deciding what the
// video shows. "Record video" then renders it right here:
//
// - **Stepped export** (the normal path, needs WebCodecs): the app clock is
//   frozen and advanced one frame at a time (render-hook.mjs); after each
//   step the export waits for the 3D map to report a steady frame, grabs
//   that frame from the tab capture and encodes it with an exact timestamp
//   (map/stepped-video.mjs). The ride, camera and HUD move deterministically
//   and the video renders as fast as frames can be captured — a long ride at
//   a high playback multiplier takes minutes, not hours — with no screen
//   recording running in real time.
// - **Real-time fallback** (no WebCodecs): the viewport is recorded live
//   through a MediaRecorder (map/video-capture.mjs) while the replay plays.
//
// Both open on the route overview for an intro, play the replay from the
// start, keep rolling through the finish-line orbit for an outro, then save.
// The viewport carries the `capturing` class meanwhile so our own buttons
// stay out of the video (Google's attribution always stays in). "Copy render
// command" hands the same choices to the optional headless batch renderer
// (scripts/render_replay_video.py).

import { applyCameraViewPreset } from "../camera/camera-ui.mjs";
import { enterOverviewMode } from "../camera/overview-camera.mjs";
import { advanceVirtualClock, disableVirtualClock, enableVirtualClock } from "../core/clock.mjs";
import { enterTheaterMode } from "../hud/theater-mode.mjs";
import { parseAspectRatio } from "../map/screenshot.mjs";
import { startSteppedRecording, steppedVideoSupported } from "../map/stepped-video.mjs";
import {
  downloadVideoBlob,
  startViewportRecording,
  videoCaptureSupported,
  videoFileExtension,
} from "../map/video-capture.mjs";
import { buildRenderCommand, hiddenOverlayKeys } from "./render-command.mjs";
import { renderStatus } from "./render-hook.mjs";
import { pauseReplay, seekReplayToSeconds, startReplay } from "./replay-mode.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { RIDE_REPLAY_VIDEO } from "../core/tuning.mjs";
import { formatDuration } from "../core/units.mjs";

export function videoExportSupported() {
  return steppedVideoSupported() || videoCaptureSupported();
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

  const stepped = steppedVideoSupported();
  replay.exportStarting = true;
  syncRecordButton();
  updateProgressLabel("Choose “This Tab” in the share dialog to start the export…");
  const options = {
    aspectRatio: parseAspectRatio(RIDE_REPLAY_VIDEO.aspect),
    outputWidth: RIDE_REPLAY_VIDEO.output_width,
    frameRate: RIDE_REPLAY_VIDEO.frame_rate,
    captureFrameRate: RIDE_REPLAY_VIDEO.capture_frame_rate,
    videoBitsPerSecond: RIDE_REPLAY_VIDEO.bits_per_second,
    mimeTypePreferences: RIDE_REPLAY_VIDEO.mime_preferences,
    onMessage: updateProgressLabel,
    // The browser's own "Stop sharing" bar ends the export too.
    onEnded: () => { void stopReplayVideoExport(); },
  };
  try {
    replay.recorder = stepped
      ? await startSteppedRecording(els.mapViewport, options)
      : await startViewportRecording(els.mapViewport, options);
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
  replay.stepped = stepped;
  els.mapViewport.classList.add("capturing");
  syncRecordButton();

  if (stepped) {
    updateProgressLabel("Rendering the video frame by frame — keep this tab visible; press Stop & save to end early.");
    runSteppedExport(replay.recorder);
    return;
  }
  const { outputWidth, outputHeight } = replay.recorder;
  updateProgressLabel(`Recording ${outputWidth}×${outputHeight} in real time — press Stop & save any time.`);
  // A short still of the overview before the ride begins.
  window.setTimeout(() => {
    if (state.replay.recording) startReplay();
  }, RIDE_REPLAY_VIDEO.intro_seconds * 1000);
}

// The producer of the stepped export. It is paced by the tab capture itself:
// every presented capture frame (`recorder.onPresented`) may advance the app
// clock by one video frame — intro still, the ride, the outro — and the
// step's tag is stamped in the next animation frame, where its render lands.
// Steps are therefore never produced faster than the capture can show them
// (a surplus step would simply never be captured), while up to
// `pipeline_depth` steps stay in flight so render, capture latency and
// encoding overlap instead of being waited out one after another. The
// ceiling is the display's refresh rate: a 60 Hz capture yields a 30 fps
// video at about twice real time. Keep the tab visible meanwhile — a hidden
// tab stops both animation frames and capture frames.
function runSteppedExport(recorder) {
  const replay = state.replay;
  const fps = RIDE_REPLAY_VIDEO.frame_rate;
  const frameMs = 1000 / fps;
  const depth = Math.max(1, RIDE_REPLAY_VIDEO.pipeline_depth);
  const introSteps = Math.round(RIDE_REPLAY_VIDEO.intro_seconds * fps);
  const outroSteps = Math.round(RIDE_REPLAY_VIDEO.outro_seconds * fps);
  const active = () => replay.recording && replay.recorder === recorder;
  const startedAt = performance.now();
  let lastReportAt = 0;
  let step = 0;
  let rideStarted = false;
  let outroLeft = null;
  let doneProducing = false;

  const produceStep = () => {
    advanceVirtualClock(frameMs);
    const produced = step;
    step += 1;
    if (outroLeft !== null) outroLeft -= 1;
    // The app's loops (registered before this callback) process the new time
    // in the next animation frame; stamping the tag there, before paint, puts
    // it in the same composited frame as that render.
    requestAnimationFrame(() => recorder.tagStep(produced));
  };

  enableVirtualClock();
  recorder.onPresented = () => {
    if (!active()) {
      recorder.onPresented = null;
      disableVirtualClock();
      return;
    }
    if (recorder.error) {
      console.error("Stepped video export failed.", recorder.error);
      updateProgressLabel(`Video export failed — ${recorder.error.message ?? recorder.error}`);
      recorder.onPresented = null;
      disableVirtualClock();
      void stopReplayVideoExport();
      return;
    }

    const status = renderStatus();
    if (!doneProducing) {
      if (!rideStarted && step >= introSteps) {
        startReplay();
        rideStarted = true;
      }
      if (rideStarted && outroLeft === null && status.finished) outroLeft = outroSteps;
      if (outroLeft === 0) {
        doneProducing = true;
      } else if (recorder.inFlight < depth && !recorder.busy) {
        produceStep();
      }
    }

    const now = performance.now();
    if (now - lastReportAt > 1000) {
      lastReportAt = now;
      const captureFps = recorder.frames / Math.max(0.001, (now - startedAt) / 1000);
      const done = status.durationSeconds ? status.elapsedSeconds / status.durationSeconds : 0;
      // The REC chip carries the render progress; the status line under the
      // progress bar keeps showing the ride readout.
      setRecordStatus(
        `REC ${Math.round(done * 100)}% · ${formatDuration(status.elapsedSeconds, "clock")} of `
          + `${formatDuration(status.durationSeconds, "clock")} · ${captureFps.toFixed(0)} fps`,
      );
    }

    if (doneProducing && recorder.inFlight === 0) {
      recorder.onPresented = null;
      disableVirtualClock();
      void stopReplayVideoExport();
    }
  };
}

// The replay reached the finish while recording in real time: let the
// finish-line orbit play for the outro, then save. (The stepped export runs
// its own outro frames.)
export function handleReplayFinishedWhileRecording() {
  const replay = state.replay;
  if (!replay.recording || replay.stepped || replay.outroTimer) return;
  replay.outroTimer = window.setTimeout(() => {
    replay.outroTimer = null;
    void stopReplayVideoExport();
  }, RIDE_REPLAY_VIDEO.outro_seconds * 1000);
}

export async function stopReplayVideoExport() {
  const replay = state.replay;
  if (!replay.recording || !replay.recorder) return;
  const recorder = replay.recorder;
  const stepped = replay.stepped;
  replay.recording = false;
  replay.recorder = null;
  replay.stepped = false;
  window.clearTimeout(replay.outroTimer);
  replay.outroTimer = null;
  els.mapViewport.classList.remove("capturing");
  disableVirtualClock();
  pauseReplay({ silent: true });
  syncRecordButton();
  updateProgressLabel("Finishing the video…");

  const blob = stepped ? await recorder.finish() : await recorder.stop();
  if (!blob || blob.size === 0) {
    updateProgressLabel("The recording came out empty — nothing was saved.");
    return;
  }
  if (stepped && recorder.tagMisses > 0) {
    console.warn(`Stepped export: ${recorder.tagMisses} of ${recorder.frames} frames were taken without seeing their frame tag.`);
  }
  downloadVideoBlob(blob, videoFileName(stepped ? "video/mp4" : recorder.mimeType));
  const seconds = stepped ? recorder.frames / RIDE_REPLAY_VIDEO.frame_rate : null;
  updateProgressLabel(
    `Video saved (${(blob.size / 1_048_576).toFixed(1)} MB${seconds ? `, ${formatDuration(seconds, "clock")}` : ""}).`,
  );
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
  button.title = steppedVideoSupported()
    ? "Render the replay to an MP4 right here: frame by frame, as fast as the map can draw"
    : "Record the replay here in real time (this browser lacks WebCodecs for the fast export)";
  if (els.replayRecordStatus) {
    els.replayRecordStatus.hidden = !replay.recording;
  }
  if (els.replayCopyCommandBtn) els.replayCopyCommandBtn.disabled = !replay.timeline || replay.recording;
  if (els.replayCameraSelect) {
    els.replayCameraSelect.disabled = replay.recording;
    els.replayCameraSelect.value = state.cameraViewPreset === "firstPerson" ? "first-person" : "follow";
  }
}
