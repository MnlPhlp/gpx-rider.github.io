// Ghost race: the pure arithmetic of racing the loaded recording. The ghost
// rides the ride-timeline.mjs model of the recording in *ride time* (stops
// squeezed out, exactly as the replay plays it) while the rider moves under
// their own power. The race keeps two numbers — `startElapsedSeconds`, the
// moment in the recording where the race joined it, and `raceSeconds`, how
// long the rider has been moving since — and the ghost's position is simply
// the recording's distance at their sum. Both gaps follow the convention
// "positive = the rider is ahead": distance by comparing positions, time by
// asking when the recording reached the rider's current spot and comparing
// that with the ghost's own clock. Because the timeline is monotonic in both
// axes, the two gaps always share a sign.
//
// Pure: no DOM, no app state.

import { timelineDistanceAt, timelineElapsedAtDistance } from "./ride-timeline.mjs";

// The ghost's playhead into the recording for a race state.
export function ghostElapsedSeconds({ startElapsedSeconds, raceSeconds }) {
  return startElapsedSeconds + raceSeconds;
}

// The `startElapsedSeconds` that puts the ghost exactly at `riderMeters` for
// a race clock already at `raceSeconds` — a fresh race (clock 0) joins the
// recording at the moment it reached the rider's position; a seek mid-race
// keeps the clock running and offsets the join so the gap collapses to zero.
export function alignedGhostStart(timeline, riderMeters, raceSeconds = 0) {
  return timelineElapsedAtDistance(timeline, riderMeters) - raceSeconds;
}

// Where the ghost is and how the rider compares, or null without a recording.
export function ghostRaceStatus(timeline, { riderMeters, ghostElapsedSeconds: ghostElapsed }) {
  if (!timeline) return null;
  const ghostMeters = timelineDistanceAt(timeline, ghostElapsed);
  const recordingElapsedAtRider = timelineElapsedAtDistance(timeline, riderMeters);
  return {
    ghostMeters,
    distanceGapMeters: riderMeters - ghostMeters,
    timeGapSeconds: recordingElapsedAtRider - ghostElapsed,
    ghostFinished: ghostElapsed >= timeline.durationSeconds,
  };
}
