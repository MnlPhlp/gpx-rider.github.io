// Recorded-ride intake: turns a FIT file or a timestamped GPX into the
// replay timeline behind the loaded route, keeps that timeline across reloads
// (IndexedDB, next to the saved ride), handles the pasted Strava link (the
// browser cannot fetch an activity's file itself — see strava-link.mjs — so
// it opens Strava's export for the logged-in rider and remembers the
// activity id as the ride's source), and renders the Ride replay card.
// Playback itself lives in replay-mode.mjs, the video export in
// video-export.mjs.

import { decodeFitActivity } from "./fit-decode.mjs";
import { resetGhostRace } from "./ghost-ui.mjs";
import { pauseReplay, syncReplayTransport } from "./replay-mode.mjs";
import {
  buildRideTimeline,
  deserializeTimeline,
  serializeTimeline,
} from "./ride-timeline.mjs";
import { applyRoutePoints, loadRideFile } from "../route/route-load.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { readJson, removeStored, writeJson } from "../storage/storage.mjs";
import { parseStravaActivityId, stravaActivityUrl, stravaExportUrl } from "./strava-link.mjs";
import { syncTheaterToolbar } from "../hud/theater-mode.mjs";
import { updateTelemetryUi } from "../ride/telemetry-ui.mjs";
import { formatDistance, formatDuration, formatSpeed } from "../core/units.mjs";

const REPLAY_STORAGE_KEY = "gpx-rider:replay";

// The Ride replay card's own picker (accepts .gpx and .fit). Unlike the
// top-bar picker it expects a recording, so a plain route gets a hint.
export async function loadRecordedRideFile(event) {
  const [file] = event.target.files;
  if (!file) return;
  event.target.value = "";
  const attached = await loadRideFile(file);
  if (!attached && state.route.length) {
    updateProgressLabel("Loaded as a route — this GPX has no timestamps, so there is nothing to replay. Export the ride from your head unit or Strava instead.");
  }
}

// A GPX is a recorded ride when every point carries a <time>; a planned
// route (or a track with only a few stamped points) replays nothing.
export function replayTimelineFromGpxPoints(points) {
  if (!points?.length || !points.every((point) => Number.isFinite(point.time))) return null;
  return buildRideTimeline(points.map((point) => ({
    t: point.time,
    lat: point.lat,
    lng: point.lng,
    ele: point.ele,
    speedKph: null,
    powerWatts: point.powerWatts ?? null,
    heartRateBpm: point.heartRateBpm ?? null,
    cadenceRpm: point.cadenceRpm ?? null,
  })));
}

// Decodes a FIT activity and applies it as route + replay. Returns whether a
// timeline was attached.
export function applyRecordedFit(bytes, { fallbackName = null } = {}) {
  let decoded;
  try {
    decoded = decodeFitActivity(bytes);
  } catch (error) {
    console.error("Could not decode the FIT file.", error);
    updateProgressLabel("That FIT file could not be read.");
    return false;
  }
  const timeline = buildRideTimeline(decoded.records);
  if (!timeline) {
    updateProgressLabel("That FIT file has no GPS track to replay.");
    return false;
  }
  applyRoutePoints(timeline.points, { routeName: fallbackName });
  attachReplayTimeline(timeline, { sourceName: fallbackName });
  return true;
}

// Makes `timeline` the replay of the current route (null detaches any
// previous replay — a plain route load). Persists it so a reload restores
// the replay with the saved ride.
export function attachReplayTimeline(timeline, { sourceName = null, persist = true } = {}) {
  const replay = state.replay;
  if (replay.playing) pauseReplay({ silent: true });
  // The previous replay owned the trainer/strap fields; a plain route load
  // with no replay before leaves live sensor values alone.
  const hadTimeline = Boolean(replay.timeline);
  replay.timeline = timeline;
  replay.sourceName = timeline ? sourceName : null;
  replay.stravaActivityId = timeline ? replay.pendingStravaActivityId : null;
  replay.pendingStravaActivityId = null;
  replay.elapsedSeconds = 0;
  replay.lastTelemetryIndex = -1;
  if (hadTimeline) clearReplayTelemetry();
  // A new recording (or none) is a new race.
  resetGhostRace();

  if (persist) {
    if (timeline) {
      const saved = writeJson(REPLAY_STORAGE_KEY, {
        ...serializeTimeline(timeline),
        sourceName: replay.sourceName,
        stravaActivityId: replay.stravaActivityId,
      });
      if (!saved) updateProgressLabel("This recording is too large to keep across reloads, but the replay still works.");
    } else {
      removeStored(REPLAY_STORAGE_KEY);
    }
  }

  if (timeline) {
    // The route was applied before the timeline existed; refresh the
    // readouts that read it (ETA, elapsed, calories), then announce.
    updateRideUi({ force: true });
    updateProgressLabel(
      `Recorded ride loaded: ${formatDuration(timeline.durationSeconds, state.durationFormat)} over `
        + `${formatDistance(timeline.distanceMeters, state.distanceUnits, 1)} — press Play to replay it.`,
    );
  }
  syncReplayUi();
}

// Called after restoreSavedRide rebuilt the route: re-attach the persisted
// replay only if it is the recording of exactly that route.
export function restoreReplay() {
  const saved = readJson(REPLAY_STORAGE_KEY);
  const timeline = deserializeTimeline(saved);
  if (!timeline || !timelineMatchesRoute(timeline, state.route)) {
    if (saved) removeStored(REPLAY_STORAGE_KEY);
    syncReplayUi();
    return;
  }
  state.replay.pendingStravaActivityId = typeof saved.stravaActivityId === "string" ? saved.stravaActivityId : null;
  attachReplayTimeline(timeline, {
    sourceName: typeof saved.sourceName === "string" ? saved.sourceName : state.routeName,
    persist: false,
  });
  if (state.replay.stravaActivityId) {
    els.replayStravaInput.value = stravaActivityUrl(state.replay.stravaActivityId);
    updateStravaLinkFromControl();
  }
}

function timelineMatchesRoute(timeline, route) {
  if (!route?.length || route.length !== timeline.points.length) return false;
  const close = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
  return close(route[0], timeline.points[0]) && close(route.at(-1), timeline.points.at(-1));
}

function clearReplayTelemetry() {
  state.trainerSpeedKph = null;
  state.trainerPowerWatts = null;
  state.trainerCadenceRpm = null;
  state.trainerHeartRateBpm = null;
  state.strapHeartRateBpm = null;
  updateTelemetryUi();
}

// --- Strava link -------------------------------------------------------------

export function updateStravaLinkFromControl() {
  const activityId = parseStravaActivityId(els.replayStravaInput.value);
  state.replay.pendingStravaActivityId = activityId;
  const hasId = Boolean(activityId);
  els.replayStravaFitBtn.disabled = !hasId;
  els.replayStravaGpxBtn.disabled = !hasId;
  if (!els.replayStravaInput.value.trim()) {
    els.replayStravaHint.textContent = "Paste a Strava activity link to fetch its file from your Strava account.";
  } else if (hasId) {
    els.replayStravaHint.textContent = `Activity ${activityId} — download the original FIT (or Strava's GPX) in a new tab, then open the file here.`;
  } else {
    els.replayStravaHint.textContent = "That does not look like a Strava activity link (strava.com/activities/…).";
  }
}

// Opens Strava's export for the pasted activity in a new tab. It works
// because the rider is logged into Strava there; the app itself never
// receives Strava credentials or data.
export function openStravaExport(event) {
  const kind = event.currentTarget.dataset.stravaExport === "gpx" ? "gpx" : "original";
  const activityId = state.replay.pendingStravaActivityId;
  if (!activityId) return;
  window.open(stravaExportUrl(activityId, kind), "_blank", "noopener");
  updateProgressLabel("Strava opened in a new tab — save the file, then open it here with “Open recorded ride…”.");
}

// --- Card -------------------------------------------------------------------

export function syncReplayUi() {
  const { timeline } = state.replay;
  els.replayEmpty.hidden = Boolean(timeline);
  els.replayLoaded.hidden = !timeline;
  els.replayPreviewBtn.disabled = !timeline;
  if (timeline) {
    els.replaySourceName.textContent = state.replay.sourceName || state.routeName || "Recorded ride";
    els.replayDurationStat.textContent = formatDuration(timeline.durationSeconds, state.durationFormat);
    els.replayDistanceStat.textContent = formatDistance(timeline.distanceMeters, state.distanceUnits, 1);
    const averageKph = timeline.durationSeconds > 0
      ? (timeline.distanceMeters / timeline.durationSeconds) * 3.6
      : 0;
    els.replayAvgSpeedStat.textContent = formatSpeed(averageKph, state.distanceUnits);
    const channels = ["speed"];
    if (timeline.hasPower) channels.push("power");
    if (timeline.hasHeartRate) channels.push("heart rate");
    if (timeline.hasCadence) channels.push("cadence");
    els.replayChannelsStat.textContent = channels.join(" · ");
  }
  syncReplayTransport();
  syncTheaterToolbar();
}
