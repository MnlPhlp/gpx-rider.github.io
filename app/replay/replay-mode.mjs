// Ride replay playback: plays the recorded ride behind the loaded route (the
// timeline attached by replay-load.mjs) through the normal follow camera and
// HUD. While playing, the replay is the ride's movement source — the movement
// loop (ride/movement.mjs#tick) calls advanceReplay every frame instead of
// integrating a speed — and the recorded speed / power / heart rate / cadence
// are written to the same state fields a real trainer fills, so every tile,
// meter and the profile history read them unchanged. Nothing is recorded
// into the FIT buffer and no grade is sent to a trainer while a replay plays.
// This module also owns the transport controls (play, scrubber, speed) in
// the Ride replay card and the theater toolbar.

import { returnToRiderCamera } from "../camera/overview-camera.mjs";
import { nowMs } from "../core/clock.mjs";
import { stopDemoMode } from "../demo/demo-mode.mjs";
import { updateFullscreenLocalTime } from "../hud/map-hud.mjs";
import { ensureMovementLoop, updateStartButton } from "../ride/movement.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import {
  timelineDistanceAt,
  timelineElapsedAtDistance,
  timelineIndexAt,
  timelineTelemetryAt,
} from "./ride-timeline.mjs";
import { saveRide } from "../storage/persistence.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { updateTelemetryUi } from "../ride/telemetry-ui.mjs";
import { RIDE_REPLAY_DEFAULT_SPEED, RIDE_REPLAY_SPEED_OPTIONS } from "../core/tuning.mjs";
import { formatDuration } from "../core/units.mjs";

// Fills the speed selects from tuning once at boot.
export function initReplayUi() {
  for (const select of els.replaySpeedSelects) {
    select.replaceChildren(...RIDE_REPLAY_SPEED_OPTIONS.map((multiplier) => {
      const option = document.createElement("option");
      option.value = String(multiplier);
      option.textContent = multiplier === 1 ? "1× real time" : `${multiplier}×`;
      return option;
    }));
  }
  state.replay.speed = RIDE_REPLAY_SPEED_OPTIONS.includes(RIDE_REPLAY_DEFAULT_SPEED)
    ? RIDE_REPLAY_DEFAULT_SPEED
    : RIDE_REPLAY_SPEED_OPTIONS[0];
  syncReplayTransport();
}

export function isReplayPlaying() {
  return state.replay.playing;
}

export function toggleReplayPlayback() {
  if (state.replay.playing) pauseReplay();
  else startReplay();
}

export function startReplay() {
  const replay = state.replay;
  if (!replay.timeline || state.route.length < 2) return false;
  if (state.pedaling) {
    updateProgressLabel("You're pedaling — the ride follows the trainer, not the recording.");
    return false;
  }
  stopDemoMode({ silent: true });
  state.simulating = false;
  updateStartButton();
  if (replay.elapsedSeconds >= replay.timeline.durationSeconds) seekReplayToSeconds(0);
  // A start by any route supersedes a pending wait for the camera.
  replay.cameraWait = null;
  replay.playing = true;
  replay.lastTelemetryIndex = -1;
  applyReplayTelemetry(replay.elapsedSeconds);
  syncReplayTransport();
  ensureMovementLoop();
  return true;
}

// The recording's handoff from the overview: fly the camera down to the
// rider parked at the start (the same overview-off arc as the toolbar's
// toggle, or the chase flight when no arc fits) and begin the replay only
// once it has arrived — so the ride does not already move while the camera
// is still flying in. Capped by `maxWaitSeconds` in case the camera never
// settles. Read through the app clock, so the headless renderer's stepped
// clock drives the wait too. A manual start (or `cancelReplayCameraWait`)
// drops a pending wait.
export function startReplayWhenCameraArrives({ maxWaitSeconds = 15 } = {}) {
  const replay = state.replay;
  if (!replay.timeline || state.route.length < 2) return;
  const wait = { deadlineMs: nowMs() + maxWaitSeconds * 1000 };
  replay.cameraWait = wait;
  returnToRiderCamera();
  const check = () => {
    if (replay.cameraWait !== wait) return;
    if (cameraArrivedAtRider() || nowMs() >= wait.deadlineMs) {
      replay.cameraWait = null;
      startReplay();
      return;
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

export function cancelReplayCameraWait() {
  state.replay.cameraWait = null;
}

// The rider camera is in place: no transition arc in flight and the chase
// flight (which the arc hands over to, or which flies alone when no arc fits)
// has settled.
function cameraArrivedAtRider() {
  return state.cameraMode === "follow" && !state.cameraTransition && !state.cameraFlightLoopActive;
}

export function pauseReplay({ silent = false } = {}) {
  const replay = state.replay;
  if (!replay.playing) return;
  replay.playing = false;
  syncReplayTransport();
  saveRide();
  if (!silent) updateProgressLabel("Replay paused.");
}

// Advances the playhead by `elapsedSeconds` of wall time (already clamped by
// the movement loop) at the chosen multiplier and moves the rider to where
// the recording had them. Called by tick while playing.
export function advanceReplay(elapsedSeconds) {
  const replay = state.replay;
  if (!replay.playing || !replay.timeline) return;
  const duration = replay.timeline.durationSeconds;
  replay.elapsedSeconds = Math.min(duration, replay.elapsedSeconds + elapsedSeconds * replay.speed);
  state.progressMeters = timelineDistanceAt(replay.timeline, replay.elapsedSeconds);
  applyReplayTelemetry(replay.elapsedSeconds);
  syncReplayScrubbers();
}

// The movement loop reached the end of the route while replaying: the
// replay is over (the finish orbit is the loop's own business).
export function finishReplay() {
  const replay = state.replay;
  if (!replay.timeline) return;
  replay.playing = false;
  replay.elapsedSeconds = replay.timeline.durationSeconds;
  syncReplayTransport();
}

// Speed the recording had the rider at right now (km/h), for the movement
// loop's speed readouts and the transition arc's velocity capture.
export function replaySpeedKph() {
  const replay = state.replay;
  if (!replay.timeline) return 0;
  return timelineTelemetryAt(replay.timeline, replay.elapsedSeconds).speedKph ?? 0;
}

// Ride-time remaining in the recording (the replay's exact "ETA").
export function replayRemainingSeconds() {
  const replay = state.replay;
  if (!replay.timeline) return null;
  return Math.max(0, replay.timeline.durationSeconds - replay.elapsedSeconds);
}

// Wall-clock seconds left to watch at the chosen speed: a two-hour ride at
// 4× is 30 minutes of playback (or recording).
export function replayWatchSecondsLeft() {
  const remaining = replayRemainingSeconds();
  if (remaining === null) return null;
  return remaining / Math.max(1e-6, state.replay.speed);
}

export function replayCaloriesKcal() {
  const replay = state.replay;
  if (!replay.timeline?.hasPower) return null;
  return timelineTelemetryAt(replay.timeline, replay.elapsedSeconds).caloriesKcal;
}

// Moves the playhead (and the rider) to a ride time; used by the scrubber,
// reset, and the video export's restart.
export function seekReplayToSeconds(seconds) {
  const replay = state.replay;
  if (!replay.timeline) return;
  replay.elapsedSeconds = Math.min(replay.timeline.durationSeconds, Math.max(0, seconds));
  state.progressMeters = timelineDistanceAt(replay.timeline, replay.elapsedSeconds);
  replay.lastTelemetryIndex = -1;
  applyReplayTelemetry(replay.elapsedSeconds);
  syncReplayTransport();
}

// The rider was moved by route distance (profile click, climb click): put
// the playhead at the moment the recording reached that distance.
export function syncReplayToProgress() {
  const replay = state.replay;
  if (!replay.timeline) return;
  replay.elapsedSeconds = timelineElapsedAtDistance(replay.timeline, state.progressMeters);
  replay.lastTelemetryIndex = -1;
  applyReplayTelemetry(replay.elapsedSeconds);
  syncReplayTransport();
}

export function handleReplayScrub(event) {
  const seconds = Number(event.currentTarget.value);
  if (!Number.isFinite(seconds)) return;
  seekReplayToSeconds(seconds);
  updateRideUi({ force: true });
  saveRide();
}

export function updateReplaySpeedFromControl(event) {
  setReplaySpeed(Number(event.currentTarget.value));
}

export function setReplaySpeed(multiplier) {
  if (RIDE_REPLAY_SPEED_OPTIONS.includes(multiplier)) state.replay.speed = multiplier;
  syncReplayTransport();
}

// Writes the recording's sensor values into the trainer/strap state fields.
// The DOM readout only refreshes when the playhead crosses into a new
// sample (once a recorded second), not every animation frame.
function applyReplayTelemetry(elapsedSeconds) {
  const replay = state.replay;
  const index = timelineIndexAt(replay.timeline, elapsedSeconds);
  const telemetry = timelineTelemetryAt(replay.timeline, elapsedSeconds);
  state.trainerSpeedKph = telemetry.speedKph;
  state.trainerPowerWatts = telemetry.powerWatts;
  state.trainerCadenceRpm = telemetry.cadenceRpm;
  state.trainerHeartRateBpm = telemetry.heartRateBpm;
  state.strapHeartRateBpm = telemetry.heartRateBpm;
  if (index !== replay.lastTelemetryIndex) {
    replay.lastTelemetryIndex = index;
    updateTelemetryUi();
  }
}

// --- Transport controls (card + theater toolbar) -------------------------------

export function syncReplayTransport() {
  const replay = state.replay;
  const hasTimeline = Boolean(replay.timeline);
  const duration = hasTimeline ? replay.timeline.durationSeconds : 0;
  for (const button of els.replayPlayButtons) {
    button.disabled = !hasTimeline;
    button.classList.toggle("replay-playing", replay.playing);
    button.setAttribute("aria-pressed", String(replay.playing));
    button.title = replay.playing ? "Pause replay" : "Play the recorded ride";
  }
  for (const scrubber of els.replayScrubbers) {
    scrubber.disabled = !hasTimeline;
    scrubber.max = String(Math.max(1, Math.ceil(duration)));
    scrubber.step = "1";
  }
  for (const select of els.replaySpeedSelects) {
    select.disabled = !hasTimeline;
    select.value = String(replay.speed);
  }
  syncReplayScrubbers();
}

function syncReplayScrubbers() {
  const replay = state.replay;
  const duration = replay.timeline?.durationSeconds ?? 0;
  const elapsedText = formatDuration(replay.elapsedSeconds, "clock");
  const durationText = formatDuration(duration, "clock");
  for (const scrubber of els.replayScrubbers) {
    // Don't fight the user's drag.
    if (document.activeElement !== scrubber) scrubber.value = String(Math.round(replay.elapsedSeconds));
  }
  // Ride time, then how long the rest takes to watch at the chosen speed.
  const leftText = formatDuration(replayWatchSecondsLeft() ?? 0, "clock");
  for (const output of els.replayTimeOutputs) {
    output.textContent = replay.timeline ? `${elapsedText} / ${durationText} · ${leftText} left` : "--";
    output.title = replay.timeline ? `Ride time elapsed / total · time left to watch at ${replay.speed}×` : "";
  }
  // The clock chip follows the playhead (ride time of day), see map-hud.
  if (replay.timeline) updateFullscreenLocalTime();
}
