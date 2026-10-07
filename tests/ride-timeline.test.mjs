import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRideTimeline,
  deserializeTimeline,
  serializeTimeline,
  timelineDistanceAt,
  timelineElapsedAtDistance,
  timelineHistoryUpTo,
  timelineIndexAt,
  timelineTelemetryAt,
} from "../app/replay/ride-timeline.mjs";

const OPTIONS = { maxGapSeconds: 10, pauseMinSpeedKph: 3, speedWindowSeconds: 4, grossEfficiency: 0.25 };

// ~1 m of latitude per 9e-6 degrees; each step below is ~10 m north.
function northSamples(count, { stepSeconds = 1, startT = 1_700_000_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * stepSeconds,
    lat: 50 + i * 0.00009,
    lng: 14,
    ele: 300 + i,
    speedKph: null,
    powerWatts: 200,
    heartRateBpm: 140 + i,
    cadenceRpm: 90,
  }));
}

test("builds a monotonic time/distance timeline from timestamped samples", () => {
  const timeline = buildRideTimeline(northSamples(5), OPTIONS);
  assert.equal(timeline.samples.length, 5);
  assert.equal(timeline.points.length, 5);
  assert.equal(timeline.durationSeconds, 4);
  assert.ok(timeline.distanceMeters > 38 && timeline.distanceMeters < 42, `≈40 m, got ${timeline.distanceMeters}`);
  for (let i = 1; i < timeline.samples.length; i += 1) {
    assert.ok(timeline.samples[i].elapsedSeconds > timeline.samples[i - 1].elapsedSeconds);
    assert.ok(timeline.samples[i].distanceMeters >= timeline.samples[i - 1].distanceMeters);
  }
});

test("samples without a timestamp or position are dropped, and order is restored", () => {
  const samples = northSamples(4);
  samples.push({ t: null, lat: 50.1, lng: 14, ele: 0 });
  samples.push({ t: samples[0].t + 2.5, lat: null, lng: 14, ele: 0 });
  const reversed = [...samples].reverse();
  const timeline = buildRideTimeline(reversed, OPTIONS);
  assert.equal(timeline.samples.length, 4);
  assert.equal(timeline.samples[0].elapsedSeconds, 0);
});

test("needs at least two usable samples", () => {
  assert.equal(buildRideTimeline([], OPTIONS), null);
  assert.equal(buildRideTimeline(northSamples(1), OPTIONS), null);
  assert.equal(buildRideTimeline(null, OPTIONS), null);
});

test("a long stationary gap is squeezed to the maximum gap", () => {
  const samples = northSamples(3);
  // Café stop: 600 s with no movement, then the ride resumes.
  samples[2].t = samples[1].t + 600;
  samples[2].lat = samples[1].lat + 0.000001;
  const timeline = buildRideTimeline(samples, OPTIONS);
  assert.equal(timeline.samples[2].elapsedSeconds - timeline.samples[1].elapsedSeconds, OPTIONS.maxGapSeconds);
  assert.equal(timeline.pausedSeconds, 600 - OPTIONS.maxGapSeconds);
});

test("a long gap the rider rode through keeps its real duration", () => {
  const samples = northSamples(3);
  // Smart recording: 60 s between samples, but ~500 m covered (30 km/h).
  samples[2].t = samples[1].t + 60;
  samples[2].lat = samples[1].lat + 0.0045;
  const timeline = buildRideTimeline(samples, OPTIONS);
  assert.equal(timeline.samples[2].elapsedSeconds - timeline.samples[1].elapsedSeconds, 60);
  assert.equal(timeline.pausedSeconds, 0);
});

test("speed is derived from distance over the trailing window when the file has none", () => {
  const timeline = buildRideTimeline(northSamples(8), OPTIONS);
  // 10 m per second ≈ 36 km/h, after the window has filled.
  const speed = timeline.samples.at(-1).speedKph;
  assert.ok(speed > 34 && speed < 38, `≈36 km/h, got ${speed}`);
  assert.equal(timeline.samples[0].speedKph, 0);
});

test("a recorded speed channel is kept as-is", () => {
  const samples = northSamples(3).map((sample) => ({ ...sample, speedKph: 12.5 }));
  const timeline = buildRideTimeline(samples, OPTIONS);
  assert.ok(timeline.samples.every((sample) => sample.speedKph === 12.5));
});

test("calories accumulate from the power channel", () => {
  const timeline = buildRideTimeline(northSamples(5), OPTIONS);
  // 200 W for 4 s at 25 % efficiency = 800 J / 0.25 = 3200 J ≈ 0.765 kcal.
  assert.ok(Math.abs(timeline.caloriesKcal - 3200 / 4184) < 1e-3, `got ${timeline.caloriesKcal}`);
  assert.equal(timeline.hasPower, true);

  const noPower = buildRideTimeline(northSamples(3).map((s) => ({ ...s, powerWatts: null })), OPTIONS);
  assert.equal(noPower.caloriesKcal, null);
  assert.equal(noPower.hasPower, false);
});

test("distance and telemetry interpolate between samples and clamp at the ends", () => {
  const timeline = buildRideTimeline(northSamples(3), OPTIONS);
  const d0 = timeline.samples[0].distanceMeters;
  const d1 = timeline.samples[1].distanceMeters;
  assert.equal(timelineDistanceAt(timeline, -5), d0);
  assert.ok(Math.abs(timelineDistanceAt(timeline, 0.5) - (d0 + d1) / 2) < 1e-9);
  assert.equal(timelineDistanceAt(timeline, 99), timeline.distanceMeters);

  assert.equal(timelineIndexAt(timeline, 1.2), 1);
  const telemetry = timelineTelemetryAt(timeline, 1.2);
  assert.equal(telemetry.heartRateBpm, 141, "sensor channels hold the last sample");
  assert.equal(telemetry.powerWatts, 200);
  assert.equal(telemetry.cadenceRpm, 90);
  assert.ok(Number.isFinite(telemetry.speedKph));
  assert.ok(Number.isFinite(telemetry.caloriesKcal));
});

test("elapsed-at-distance inverts distance-at-elapsed", () => {
  const timeline = buildRideTimeline(northSamples(6), OPTIONS);
  for (const elapsed of [0, 0.3, 2, 3.75, 5]) {
    const distance = timelineDistanceAt(timeline, elapsed);
    assert.ok(Math.abs(timelineElapsedAtDistance(timeline, distance) - elapsed) < 1e-6, `elapsed ${elapsed}`);
  }
  assert.equal(timelineElapsedAtDistance(timeline, -1), 0);
  assert.equal(timelineElapsedAtDistance(timeline, 1e9), timeline.durationSeconds);
});

test("history up to a time is keyed by route progress and honors the limit", () => {
  const timeline = buildRideTimeline(northSamples(6), OPTIONS);
  const history = timelineHistoryUpTo(timeline, 3.5);
  assert.equal(history.length, 4);
  assert.equal(history.at(-1).routeProgressMeters, timeline.samples[3].distanceMeters);
  assert.equal(history.at(-1).heartRateBpm, 143);
  assert.equal(timelineHistoryUpTo(timeline, 3.5, { limit: 2 }).length, 2);
});

test("serialization round-trips the timeline", () => {
  const timeline = buildRideTimeline(northSamples(4), OPTIONS);
  const restored = deserializeTimeline(JSON.parse(JSON.stringify(serializeTimeline(timeline))));
  assert.equal(restored.samples.length, 4);
  assert.equal(restored.points.length, 4);
  assert.equal(restored.durationSeconds, timeline.durationSeconds);
  assert.ok(Math.abs(restored.distanceMeters - timeline.distanceMeters) < 1e-6);
  assert.equal(restored.hasPower, true);
  assert.equal(restored.samples[2].heartRateBpm, 142);
  assert.equal(deserializeTimeline(null), null);
  assert.equal(deserializeTimeline({ samples: [[0, 0]], points: [] }), null);
});

test("the playhead at the ride's end reports the exact total distance, even after a round-trip", () => {
  // Samples at odd positions so the cumulative distance is not a multiple of
  // the 0.1 m serialization rounding — the ride must still end at the route's
  // exact total, or the movement loop's finish check never fires.
  const samples = northSamples(5).map((sample, i) => ({ ...sample, lat: 50 + i * 0.000091234 }));
  const timeline = buildRideTimeline(samples, OPTIONS);
  assert.equal(timelineDistanceAt(timeline, timeline.durationSeconds), timeline.distanceMeters);
  const restored = deserializeTimeline(JSON.parse(JSON.stringify(serializeTimeline(timeline))));
  assert.equal(timelineDistanceAt(restored, restored.durationSeconds), restored.distanceMeters);
  assert.equal(timelineDistanceAt(restored, restored.durationSeconds + 5), restored.distanceMeters);
});
