import assert from "node:assert/strict";
import test from "node:test";
import {
  alignedGhostStart,
  ghostElapsedSeconds,
  ghostRaceStatus,
} from "../app/replay/ghost-race.mjs";
import { buildRideTimeline } from "../app/replay/ride-timeline.mjs";

const OPTIONS = { maxGapSeconds: 10, pauseMinSpeedKph: 3, speedWindowSeconds: 4, grossEfficiency: 0.25 };

// ~10 m north per sample, one sample a second: the recording rides at 10 m/s.
function northSamples(count, { stepSeconds = 1, startT = 1_700_000_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * stepSeconds,
    lat: 50 + i * 0.00009,
    lng: 14,
    ele: 300,
  }));
}

const timeline = buildRideTimeline(northSamples(11), OPTIONS);
const metersPerSecond = timeline.distanceMeters / timeline.durationSeconds;

test("ghost elapsed is the race clock offset by where the race joined the recording", () => {
  assert.equal(ghostElapsedSeconds({ startElapsedSeconds: 12, raceSeconds: 3 }), 15);
});

test("aligning the ghost puts it exactly at the rider for the current race clock", () => {
  const riderMeters = metersPerSecond * 4;
  // A fresh race (clock at 0) joins the recording where the rider stands…
  const freshStart = alignedGhostStart(timeline, riderMeters, 0);
  assert.ok(Math.abs(freshStart - 4) < 1e-6, `expected ≈4 s, got ${freshStart}`);
  // …and a race already 2.5 s old is offset back by that much so the ghost
  // still stands at the rider right now.
  const start = alignedGhostStart(timeline, riderMeters, 2.5);
  const status = ghostRaceStatus(timeline, {
    riderMeters,
    ghostElapsedSeconds: ghostElapsedSeconds({ startElapsedSeconds: start, raceSeconds: 2.5 }),
  });
  assert.ok(Math.abs(status.distanceGapMeters) < 1e-6);
  assert.ok(Math.abs(status.timeGapSeconds) < 1e-6);
});

test("a rider further along than the ghost is ahead in distance and time", () => {
  const status = ghostRaceStatus(timeline, {
    riderMeters: metersPerSecond * 6,
    ghostElapsedSeconds: 4,
  });
  assert.ok(Math.abs(status.ghostMeters - metersPerSecond * 4) < 1e-6);
  assert.ok(Math.abs(status.distanceGapMeters - metersPerSecond * 2) < 1e-6);
  // The recording needed 6 s to reach the rider's spot; the ghost is at 4 s.
  assert.ok(Math.abs(status.timeGapSeconds - 2) < 1e-6);
  assert.equal(status.ghostFinished, false);
});

test("a rider trailing the ghost is behind: both gaps negative", () => {
  const status = ghostRaceStatus(timeline, {
    riderMeters: metersPerSecond * 3,
    ghostElapsedSeconds: 7,
  });
  assert.ok(status.distanceGapMeters < 0);
  assert.ok(status.timeGapSeconds < 0);
  assert.ok(Math.abs(status.timeGapSeconds + 4) < 1e-6);
});

test("a ghost past the end of the recording parks at the finish", () => {
  const status = ghostRaceStatus(timeline, {
    riderMeters: metersPerSecond * 5,
    ghostElapsedSeconds: 99,
  });
  assert.equal(status.ghostMeters, timeline.distanceMeters);
  assert.equal(status.ghostFinished, true);
  assert.ok(status.distanceGapMeters < 0);
});

test("without a timeline there is no race status", () => {
  assert.equal(ghostRaceStatus(null, { riderMeters: 0, ghostElapsedSeconds: 0 }), null);
});
