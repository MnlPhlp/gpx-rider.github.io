// Ghost rider: races the loaded recording while the rider moves under their
// own power (pedaling, the simulation, demo mode). Owns the race clock on
// `state.ghost` (advanced by the movement loop, aligned on seeks, reset with
// the ride), the ghost's 3D beacon and minimap marker, the HUD chip with the
// time and distance gaps, and the switch in the Ride replay card. The
// arithmetic is ghost-race.mjs; the recording itself is the replay timeline
// attached by replay-load.mjs. A playing replay *is* the recording, so the
// ghost steps aside until the rider takes over again.

import { haversine } from "../core/geo.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { riderCircleCoordinates } from "../map/route-render.mjs";
import { interpolateRoutePoint } from "../route/route.mjs";
import { els, state } from "../core/state.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import { alignedGhostStart, ghostElapsedSeconds, ghostRaceStatus } from "./ghost-race.mjs";
import { GHOST_BEACON, GHOST_MARKER_UPDATE_METERS } from "../core/tuning.mjs";
import { formatGapDistance, formatSignedDuration } from "../core/units.mjs";

export function registerGhostHud() {
  // Under the clock chip (10) and above the training meters (20).
  registerHudComponent({ id: "ghost-chip", region: "left", weight: 15, element: els.ghostChip });
  // The chip's accent is the beacon's color, so the two read as one thing.
  els.ghostChip.style.setProperty("--ghost-color", GHOST_BEACON.color);
}

// The ghost is on the course whenever a recording is loaded, the switch is
// on, and the recording isn't driving the rider itself. The recording view
// is for replay videos, so it stays clean.
export function ghostVisible() {
  return Boolean(state.replay.timeline)
    && state.ghostRiderEnabled
    && !state.replay.playing
    && !state.theaterMode
    && state.route.length >= 2;
}

// --- The race clock ----------------------------------------------------------

// One own-power movement tick: the first one starts the race where the
// rider stands, every one advances the ghost by the same moving time.
export function advanceGhostRace(elapsedSeconds) {
  const timeline = state.replay.timeline;
  if (!timeline || !state.ghostRiderEnabled) return;
  const ghost = state.ghost;
  if (!ghost.active) {
    ghost.active = true;
    ghost.raceSeconds = 0;
    ghost.startElapsedSeconds = alignedGhostStart(timeline, state.progressMeters, 0);
  }
  ghost.raceSeconds += elapsedSeconds;
}

// A reset ride, a new recording, or the replay taking over: no race.
export function resetGhostRace() {
  const ghost = state.ghost;
  ghost.active = false;
  ghost.raceSeconds = 0;
  ghost.startElapsedSeconds = 0;
  refreshGhostRider();
}

// The rider was moved by route distance (profile/climb click): the ghost
// comes along, so the race continues from there with the gap at zero.
export function alignGhostToRider() {
  const ghost = state.ghost;
  const timeline = state.replay.timeline;
  if (!ghost.active || !timeline) return;
  ghost.startElapsedSeconds = alignedGhostStart(timeline, state.progressMeters, ghost.raceSeconds);
}

// The race's moving time, for the HUD's elapsed readout while racing.
export function ghostRaceSeconds() {
  return state.ghost.active ? state.ghost.raceSeconds : null;
}

// Where the ghost is right now (before the race starts: at the rider).
function currentGhostStatus() {
  const timeline = state.replay.timeline;
  if (!timeline) return null;
  const ghost = state.ghost;
  const elapsed = ghost.active
    ? ghostElapsedSeconds(ghost)
    : alignedGhostStart(timeline, state.progressMeters, 0);
  return ghostRaceStatus(timeline, { riderMeters: state.progressMeters, ghostElapsedSeconds: elapsed });
}

// --- Persistence (with the saved ride) -------------------------------------------

export function ghostRaceForSave() {
  const ghost = state.ghost;
  if (!ghost.active) return null;
  return {
    startElapsedSeconds: Math.round(ghost.startElapsedSeconds * 10) / 10,
    raceSeconds: Math.round(ghost.raceSeconds * 10) / 10,
  };
}

export function restoreGhostRace(saved) {
  const ghost = state.ghost;
  const start = Number(saved?.startElapsedSeconds);
  const race = Number(saved?.raceSeconds);
  ghost.active = Boolean(state.replay.timeline) && Number.isFinite(start) && Number.isFinite(race) && race > 0;
  ghost.startElapsedSeconds = ghost.active ? start : 0;
  ghost.raceSeconds = ghost.active ? race : 0;
}

// --- 3D beacon + minimap marker ----------------------------------------------------

// Per-frame: move the ghost's markers (cheap when it hasn't moved far).
export function updateGhostMarker() {
  const status = ghostVisible() ? currentGhostStatus() : null;
  if (!status) {
    removeGhostMarker();
    return;
  }
  const point = interpolateRoutePoint(state.route, status.ghostMeters);
  updateGhostBeacon(point);
  updateGhostMinimapMarker(point);
}

function updateGhostBeacon(point) {
  const { AltitudeMode, Polygon3DElement } = state.maps3d ?? {};
  if (!Polygon3DElement || !state.map) return;
  const ghost = state.ghost;
  if (!ghost.beacon) {
    // The same kind of geometry as the rider beacon (route-render.mjs): an
    // extruded cylinder from the ground up, drawn through occluders so the
    // ghost is never lost behind trees.
    ghost.beacon = new Polygon3DElement({
      altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND,
      extruded: true,
      drawsOccludedSegments: true,
      fillColor: beaconFillColor(),
      strokeWidth: 0,
    });
    state.map.append(ghost.beacon);
    ghost.lastBeaconPoint = null;
  }
  const last = ghost.lastBeaconPoint;
  if (last && haversine(last, point) < GHOST_MARKER_UPDATE_METERS) return;
  ghost.lastBeaconPoint = { lat: point.lat, lng: point.lng };
  ghost.beacon.path = riderCircleCoordinates(point, GHOST_BEACON.diameter_meters / 2, GHOST_BEACON.height_meters, 15);
}

function beaconFillColor() {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(GHOST_BEACON.color.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${GHOST_BEACON.opacity})`;
}

function updateGhostMinimapMarker(point) {
  if (!state.minimapMap) return;
  const ghost = state.ghost;
  if (!ghost.minimapMarker) {
    ghost.minimapMarker = new google.maps.Marker({
      map: state.minimapMap,
      clickable: false,
      zIndex: 9,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 4,
        fillColor: GHOST_BEACON.color,
        fillOpacity: 1,
        strokeColor: GHOST_BEACON.color,
        strokeOpacity: 0.35,
        strokeWeight: 5,
      },
    });
  }
  ghost.minimapMarker.setPosition({ lat: point.lat, lng: point.lng });
}

export function removeGhostMarker() {
  const ghost = state.ghost;
  if (ghost.beacon) ghost.beacon.remove();
  if (ghost.minimapMarker) ghost.minimapMarker.setMap(null);
  ghost.beacon = null;
  ghost.minimapMarker = null;
  ghost.lastBeaconPoint = null;
}

// --- HUD chip ------------------------------------------------------------------

// Slow-UI cadence: the gaps, signed "rider ahead = positive", colored by
// which side of the ghost the rider is on.
export function updateGhostChip() {
  const status = ghostVisible() ? currentGhostStatus() : null;
  els.ghostChip.hidden = !status;
  if (!status) return;
  const timeGap = Math.round(status.timeGapSeconds);
  els.ghostChipTime.textContent = formatSignedDuration(status.timeGapSeconds, "clock");
  els.ghostChipDistance.textContent = formatGapDistance(status.distanceGapMeters, state.distanceUnits);
  els.ghostChipWord.textContent = timeGap > 0 ? "ahead" : timeGap < 0 ? "behind" : "level";
  els.ghostChip.classList.toggle("ahead", timeGap > 0);
  els.ghostChip.classList.toggle("behind", timeGap < 0);
  els.ghostChip.classList.toggle("finished", status.ghostFinished);
  els.ghostChip.title = status.ghostFinished
    ? "The recording has finished the route"
    : "Your gap to the recorded ride, in ride time and route distance";
}

// --- Switch in the Ride replay card ----------------------------------------------------

export function updateGhostRiderFromControl() {
  state.ghostRiderEnabled = els.ghostRiderInput.checked;
  applyGhostRiderSetting();
  saveSettings();
}

export function syncGhostRiderControls() {
  els.ghostRiderInput.checked = state.ghostRiderEnabled;
}

export function applyGhostRiderSetting() {
  refreshGhostRider();
}

// Re-evaluates whether the ghost shows and where, outside the movement
// loop's cadence — after the replay pauses, a reset, or the switch flips.
export function refreshGhostRider() {
  updateGhostMarker();
  updateGhostChip();
}
