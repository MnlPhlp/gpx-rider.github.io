// Elevation profile canvas wiring: rendering the shared #profile canvas
// (profile.mjs owns the drawing math) and its pointer interactions — hover
// readout, click-to-seek, and drag-to-select a custom route segment.

import {
  buildProfileSegment,
  clearSelectedProfileSegment,
  focusedRouteRange,
  focusProfileSegment,
} from "./climbs-ui.mjs";
import { seekToMeters } from "../ride/movement.mjs";
import { distanceAtProfileX, drawEmptyProfile, drawProfile } from "./profile.mjs";
import { rideLogSamples } from "../ride/recorder.mjs";
import { timelineHistoryUpTo } from "../replay/ride-timeline.mjs";
import { routeTotalDistance } from "./route.mjs";
import { els, state } from "../core/state.mjs";
import {
  PROFILE_HISTORY_SAMPLE_LIMIT,
  PROFILE_SEGMENT_SELECTION_DRAG_PIXELS,
  STREET_IMAGERY,
} from "../core/tuning.mjs";

export function renderProfile(progress = currentRideProgress()) {
  if (!state.route.length) {
    drawEmptyProfile(els.profile, { dark: true });
    return;
  }
  const focusedRange = focusedRouteRange();
  drawProfile(els.profile, {
    route: state.route,
    progress,
    hoverMeters: state.selectedProfileSegment ? null : state.profileHoverMeters,
    focusRange: focusedRange
      ? {
        startMeters: focusedRange.startDistanceMeters,
        endMeters: focusedRange.endDistanceMeters,
      }
      : null,
    selectionStats: state.selectedProfileSegment,
    dark: true,
    distanceUnits: state.distanceUnits,
    historySamples: currentProfileHistorySamples(),
    visibleSeries: state.profileSeries,
    coverage: streetImageryCoverageStrip(),
  });
}

// Covered runs for the loaded route only (the index is keyed on route
// identity, so a stale summary from a previous route is never drawn).
function streetImageryCoverageStrip() {
  const si = state.streetImagery;
  if (!si.coverage || si.indexRoute !== state.route) return null;
  return {
    segments: si.coverage.segments,
    heightPx: STREET_IMAGERY.profile_strip_px,
    color: STREET_IMAGERY.profile_strip_color,
  };
}

function currentProfileHistorySamples() {
  if (state.demoModeActive && state.demoModel) {
    return state.demoModel.historySamples;
  }
  if (state.demoHistorySamples.length) {
    return state.demoHistorySamples;
  }
  // A loaded recording draws its own speed/power/HR up to the playhead.
  if (state.replay.timeline) {
    return timelineHistoryUpTo(state.replay.timeline, state.replay.elapsedSeconds, {
      limit: PROFILE_HISTORY_SAMPLE_LIMIT,
    });
  }
  return rideLogSamples().slice(-PROFILE_HISTORY_SAMPLE_LIMIT);
}

export function handleProfileHover(event) {
  if (state.selectedProfileSegment) return;
  const distance = distanceAtProfileX(els.profile, event.clientX, state.route);
  if (distance === null) return;
  state.profileHoverMeters = distance;
  renderProfile();
}

export function handleProfileLeave() {
  if (state.profileSelectPointerId !== null) return;
  if (state.profileHoverMeters === null) return;
  state.profileHoverMeters = null;
  renderProfile();
}

export function handleProfileClick(event) {
  if (state.profileSelectionSuppressClick) {
    state.profileSelectionSuppressClick = false;
    return;
  }
  const distance = distanceAtProfileX(els.profile, event.clientX, state.route);
  if (distance === null) return;
  clearSelectedProfileSegment();
  seekToMeters(distance);
}

export function handleProfilePointerDown(event) {
  if (event.button !== 0 || !state.route.length) return;
  const distance = distanceAtProfileX(els.profile, event.clientX, state.route);
  if (distance === null) return;
  state.profileSelectStartMeters = distance;
  state.profileSelectStartX = event.clientX;
  state.profileSelectPointerId = event.pointerId;
  state.profileSelecting = false;
  els.profile.setPointerCapture?.(event.pointerId);
}

export function handleProfilePointerMove(event) {
  if (state.profileSelectPointerId !== event.pointerId) return;
  const distance = distanceAtProfileX(els.profile, event.clientX, state.route);
  if (distance === null) return;
  if (
    !state.profileSelecting &&
    Math.abs(event.clientX - state.profileSelectStartX) >= PROFILE_SEGMENT_SELECTION_DRAG_PIXELS
  ) {
    state.profileSelecting = true;
  }
  if (!state.profileSelecting) return;
  state.profileHoverMeters = distance;
  const preview = buildProfileSegment(state.profileSelectStartMeters, distance);
  state.selectedProfileSegment = preview;
  renderProfile();
}

export function handleProfilePointerUp(event) {
  if (state.profileSelectPointerId !== event.pointerId) return;
  const selecting = state.profileSelecting;
  const start = state.profileSelectStartMeters;
  const distance = distanceAtProfileX(els.profile, event.clientX, state.route);
  cancelProfileSelection(event);
  if (!selecting || distance === null) return;
  state.profileSelectionSuppressClick = true;
  focusProfileSegment(start, distance);
}

export function cancelProfileSelection(event) {
  if (event?.pointerId != null) els.profile.releasePointerCapture?.(event.pointerId);
  state.profileSelectStartMeters = null;
  state.profileSelectStartX = null;
  state.profileSelectPointerId = null;
  state.profileSelecting = false;
}

function currentRideProgress() {
  if (!state.route.length) return 0;
  const totalDistance = routeTotalDistance(state.route) || 1;
  return state.progressMeters / totalDistance;
}
