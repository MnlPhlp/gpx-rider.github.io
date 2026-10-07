// Ride timeline: the pure model of a *recorded* ride — where the rider was at
// every second of it. Built once from the timestamped samples of a GPX or FIT
// file (replay/fit-decode.mjs, route/route.mjs#parseGpx), it answers the
// questions a replay (and, later, a ghost rider) asks every frame: how far
// along the route was the rider `elapsed` seconds in, how fast, at what
// power/heart rate/cadence, and how many calories had been burned.
//
// Time axis: `elapsedSeconds` is ride time with stops squeezed out — a gap
// between two samples longer than `maxGapSeconds` during which the rider
// barely moved (a café stop, a red light, an auto-pause) is shortened to
// `maxGapSeconds`, so a replay never freezes on a stationary rider for
// minutes. Gaps the rider rode through (smart recording on a straight) keep
// their real duration. Distance is the route's own cumulative haversine
// distance over the kept points, so `distanceAt` lines up exactly with the
// enriched route the app renders from the same points.
//
// Pure: no DOM, no app state. Thresholds are explicit parameters; tuning.yaml
// only supplies the app's defaults.

import { haversine, lerp } from "../core/geo.mjs";
import { activeCaloriesFromPower } from "../core/units.mjs";
import {
  CYCLING_GROSS_EFFICIENCY,
  RIDE_REPLAY_MAX_GAP_SECONDS,
  RIDE_REPLAY_PAUSE_MIN_SPEED_KPH,
  RIDE_REPLAY_SPEED_WINDOW_SECONDS,
} from "../core/tuning.mjs";

// samples: [{ t (unix seconds), lat, lng, ele, speedKph?, powerWatts?,
//             heartRateBpm?, cadenceRpm? }] — nullable fields allowed.
// Returns null when fewer than two usable (timestamped, positioned) samples
// remain.
export function buildRideTimeline(samples, {
  maxGapSeconds = RIDE_REPLAY_MAX_GAP_SECONDS,
  pauseMinSpeedKph = RIDE_REPLAY_PAUSE_MIN_SPEED_KPH,
  speedWindowSeconds = RIDE_REPLAY_SPEED_WINDOW_SECONDS,
  grossEfficiency = CYCLING_GROSS_EFFICIENCY,
} = {}) {
  const usable = (samples ?? [])
    .filter((sample) =>
      Number.isFinite(sample?.t) && Number.isFinite(sample.lat) && Number.isFinite(sample.lng))
    .sort((a, b) => a.t - b.t);
  if (usable.length < 2) return null;

  const points = [];
  const out = [];
  let distance = 0;
  let elapsed = 0;
  let calories = 0;
  let pausedSeconds = 0;
  const pauseMinSpeedMps = pauseMinSpeedKph / 3.6;

  for (let i = 0; i < usable.length; i += 1) {
    const sample = usable[i];
    const point = {
      lat: sample.lat,
      lng: sample.lng,
      ele: Number.isFinite(sample.ele) ? sample.ele : (points.at(-1)?.ele ?? 0),
    };
    if (i > 0) {
      const previous = usable[i - 1];
      const step = haversine(points.at(-1), point);
      let dt = Math.max(0, sample.t - previous.t);
      if (dt > maxGapSeconds && step / dt < pauseMinSpeedMps) {
        pausedSeconds += dt - maxGapSeconds;
        dt = maxGapSeconds;
      }
      distance += step;
      elapsed += dt;
      const power = out.at(-1).powerWatts;
      if (Number.isFinite(power) && dt > 0) {
        calories += activeCaloriesFromPower(power, dt, grossEfficiency);
      }
    }
    points.push(point);
    out.push({
      elapsedSeconds: elapsed,
      distanceMeters: distance,
      speedKph: Number.isFinite(sample.speedKph) ? sample.speedKph : null,
      powerWatts: Number.isFinite(sample.powerWatts) ? sample.powerWatts : null,
      heartRateBpm: Number.isFinite(sample.heartRateBpm) ? sample.heartRateBpm : null,
      cadenceRpm: Number.isFinite(sample.cadenceRpm) ? sample.cadenceRpm : null,
      caloriesKcal: calories,
    });
  }

  // Files without a speed channel (most GPX exports) get one derived from the
  // distance covered over a trailing window, which smooths GPS jitter.
  let tail = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].speedKph !== null) continue;
    while (tail < i && out[i].elapsedSeconds - out[tail].elapsedSeconds > speedWindowSeconds) tail += 1;
    const dt = out[i].elapsedSeconds - out[tail].elapsedSeconds;
    out[i].speedKph = dt > 0 ? ((out[i].distanceMeters - out[tail].distanceMeters) / dt) * 3.6 : 0;
  }

  const hasPower = out.some((sample) => sample.powerWatts !== null);
  return {
    points,
    samples: out,
    durationSeconds: elapsed,
    distanceMeters: distance,
    pausedSeconds,
    startTimeMs: usable[0].t * 1000,
    hasPower,
    hasHeartRate: out.some((sample) => sample.heartRateBpm !== null),
    hasCadence: out.some((sample) => sample.cadenceRpm !== null),
    // Calories only mean something when a power channel fed them.
    caloriesKcal: hasPower ? calories : null,
  };
}

// Index of the last sample at or before `elapsedSeconds` (0 before the start).
export function timelineIndexAt(timeline, elapsedSeconds) {
  const samples = timeline.samples;
  if (elapsedSeconds <= samples[0].elapsedSeconds) return 0;
  if (elapsedSeconds >= samples.at(-1).elapsedSeconds) return samples.length - 1;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid].elapsedSeconds <= elapsedSeconds) low = mid;
    else high = mid;
  }
  return low;
}

// Route distance the rider had covered `elapsedSeconds` into the ride,
// interpolated between samples and clamped to the ride. At (or past) the
// ride's end it is the exact total: the serialized samples are rounded to
// 0.1 m, so the last sample alone could leave the rider a few centimeters
// short of the route's finish line forever.
export function timelineDistanceAt(timeline, elapsedSeconds) {
  if (elapsedSeconds >= timeline.durationSeconds) return timeline.distanceMeters;
  const samples = timeline.samples;
  const index = timelineIndexAt(timeline, elapsedSeconds);
  const current = samples[index];
  const next = samples[index + 1];
  if (!next || elapsedSeconds <= current.elapsedSeconds) return current.distanceMeters;
  const span = next.elapsedSeconds - current.elapsedSeconds;
  if (span <= 0) return next.distanceMeters;
  const ratio = Math.min(1, (elapsedSeconds - current.elapsedSeconds) / span);
  return lerp(current.distanceMeters, next.distanceMeters, ratio);
}

// Telemetry at `elapsedSeconds`: speed and calories interpolate (they are
// continuous), the sensor channels hold the last recorded value (a head unit
// reports them once a second, so stepping is what the rider saw).
export function timelineTelemetryAt(timeline, elapsedSeconds) {
  const samples = timeline.samples;
  const index = timelineIndexAt(timeline, elapsedSeconds);
  const current = samples[index];
  const next = samples[index + 1];
  let ratio = 0;
  if (next && elapsedSeconds > current.elapsedSeconds) {
    const span = next.elapsedSeconds - current.elapsedSeconds;
    ratio = span > 0 ? Math.min(1, (elapsedSeconds - current.elapsedSeconds) / span) : 1;
  }
  return {
    speedKph: next ? lerp(current.speedKph, next.speedKph, ratio) : current.speedKph,
    caloriesKcal: next ? lerp(current.caloriesKcal, next.caloriesKcal, ratio) : current.caloriesKcal,
    powerWatts: current.powerWatts,
    heartRateBpm: current.heartRateBpm,
    cadenceRpm: current.cadenceRpm,
  };
}

// Inverse lookup for seeking by route position (clicking the elevation
// profile): the first ride time at which the rider reached `distanceMeters`.
export function timelineElapsedAtDistance(timeline, distanceMeters) {
  const samples = timeline.samples;
  if (distanceMeters <= samples[0].distanceMeters) return samples[0].elapsedSeconds;
  if (distanceMeters >= samples.at(-1).distanceMeters) return samples.at(-1).elapsedSeconds;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid].distanceMeters < distanceMeters) low = mid;
    else high = mid;
  }
  const previous = samples[low];
  const next = samples[high];
  const span = next.distanceMeters - previous.distanceMeters;
  if (span <= 0) return next.elapsedSeconds;
  return lerp(previous.elapsedSeconds, next.elapsedSeconds, (distanceMeters - previous.distanceMeters) / span);
}

// The ride so far in the shape the elevation profile's history series draw
// (see route/profile.mjs#drawHistorySeries): one entry per sample up to
// `elapsedSeconds`, keyed by route progress.
export function timelineHistoryUpTo(timeline, elapsedSeconds, { limit = Infinity } = {}) {
  const index = timelineIndexAt(timeline, elapsedSeconds);
  const start = Math.max(0, index + 1 - limit);
  return timeline.samples.slice(start, index + 1).map((sample) => ({
    routeProgressMeters: sample.distanceMeters,
    distance: sample.distanceMeters,
    speedKph: sample.speedKph,
    powerWatts: sample.powerWatts,
    heartRateBpm: sample.heartRateBpm,
  }));
}

// Compact array form for persistence (mirrors recorder.mjs' approach):
// [elapsedSeconds, distanceMeters, speedKph, powerWatts, heartRateBpm, cadenceRpm, caloriesKcal]
export function serializeTimeline(timeline) {
  return {
    durationSeconds: timeline.durationSeconds,
    distanceMeters: timeline.distanceMeters,
    pausedSeconds: timeline.pausedSeconds,
    startTimeMs: timeline.startTimeMs,
    points: timeline.points.map(({ lat, lng, ele }) => [lat, lng, ele]),
    samples: timeline.samples.map((sample) => [
      Math.round(sample.elapsedSeconds * 10) / 10,
      Math.round(sample.distanceMeters * 10) / 10,
      sample.speedKph === null ? null : Math.round(sample.speedKph * 10) / 10,
      sample.powerWatts === null ? null : Math.round(sample.powerWatts),
      sample.heartRateBpm === null ? null : Math.round(sample.heartRateBpm),
      sample.cadenceRpm === null ? null : Math.round(sample.cadenceRpm),
      Math.round(sample.caloriesKcal * 10) / 10,
    ]),
  };
}

export function deserializeTimeline(saved) {
  if (!Array.isArray(saved?.samples) || saved.samples.length < 2 || !Array.isArray(saved.points)) return null;
  const samples = saved.samples.map(([elapsedSeconds, distanceMeters, speedKph, powerWatts, heartRateBpm, cadenceRpm, caloriesKcal]) => ({
    elapsedSeconds: Number(elapsedSeconds) || 0,
    distanceMeters: Number(distanceMeters) || 0,
    speedKph: Number.isFinite(speedKph) ? speedKph : 0,
    powerWatts: Number.isFinite(powerWatts) ? powerWatts : null,
    heartRateBpm: Number.isFinite(heartRateBpm) ? heartRateBpm : null,
    cadenceRpm: Number.isFinite(cadenceRpm) ? cadenceRpm : null,
    caloriesKcal: Number(caloriesKcal) || 0,
  }));
  const points = saved.points
    .map(([lat, lng, ele]) => ({ lat: Number(lat), lng: Number(lng), ele: Number(ele) || 0 }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (points.length !== samples.length) return null;
  const hasPower = samples.some((sample) => sample.powerWatts !== null);
  return {
    points,
    samples,
    durationSeconds: Number(saved.durationSeconds) || samples.at(-1).elapsedSeconds,
    distanceMeters: Number(saved.distanceMeters) || samples.at(-1).distanceMeters,
    pausedSeconds: Number(saved.pausedSeconds) || 0,
    startTimeMs: Number(saved.startTimeMs) || 0,
    hasPower,
    hasHeartRate: samples.some((sample) => sample.heartRateBpm !== null),
    hasCadence: samples.some((sample) => sample.cadenceRpm !== null),
    caloriesKcal: hasPower ? samples.at(-1).caloriesKcal : null,
  };
}
