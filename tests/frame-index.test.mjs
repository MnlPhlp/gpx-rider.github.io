import assert from "node:assert/strict";
import test from "node:test";

import { enrichRoute } from "../app/route/route.mjs";
import {
  addCandidates,
  countFramesBy,
  coveragePercent,
  coverageSegments,
  createFrameIndex,
  frameByRef,
  longestGapMeters,
  nextFrame,
  projectOntoRoute,
  wrap180,
} from "../app/street-view/frame-index.mjs";

// An L-shaped route: 1 km north, then 1 km east. Points every ~111 m.
const corner = { lat: 50.009, lng: 14.400 };
const lRoute = enrichRoute([
  ...Array.from({ length: 10 }, (_, i) => ({ lat: 50.000 + i * 0.001, lng: 14.400, ele: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ lat: corner.lat, lng: 14.400 + (i + 1) * 0.0014, ele: 0 })),
]);
const northLegMeters = lRoute[9].distance;

const INDEX_OPTS = { maxOffsetMeters: 15, headingToleranceDegrees: 45 };

function candidate(overrides) {
  return {
    lat: 50.0045,
    lng: 14.4,
    headingDeg: 0,
    isPano: false,
    sequenceId: "a",
    capturedAt: 1,
    creator: "someone",
    ref: `ref-${Math.random()}`,
    ...overrides,
  };
}

function at(meters, overrides = {}) {
  // A candidate sitting exactly on the north leg `meters` from the start.
  const lat = 50.000 + (meters / northLegMeters) * 0.009;
  return candidate({ lat, lng: 14.4, ...overrides });
}

test("wrap180 folds any angle into (-180, 180]", () => {
  assert.equal(wrap180(0), 0);
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(-190), 170);
  assert.equal(wrap180(359), -1);
  assert.equal(wrap180(721), 1);
});

test("projectOntoRoute returns along-route distance, offset and local bearing", () => {
  const index = createFrameIndex(lRoute, INDEX_OPTS);
  // 10 m east of the north leg, halfway up.
  const hit = projectOntoRoute(index, { lat: 50.0045, lng: 14.4 + 10 / 71700 });
  assert.ok(hit);
  assert.ok(Math.abs(hit.distanceMeters - northLegMeters / 2) < 5, `distance ${hit.distanceMeters}`);
  assert.ok(Math.abs(hit.offsetMeters - 10) < 1, `offset ${hit.offsetMeters}`);
  assert.ok(Math.abs(wrap180(hit.bearingDeg - 0)) < 2, `bearing ${hit.bearingDeg}`);
  // On the east leg the bearing is 90.
  const east = projectOntoRoute(index, { lat: corner.lat, lng: 14.4 + 3 * 0.0014 });
  assert.ok(Math.abs(wrap180(east.bearingDeg - 90)) < 2, `bearing ${east.bearingDeg}`);
  assert.ok(east.distanceMeters > northLegMeters);
  // Far away from the route: nothing.
  assert.equal(projectOntoRoute(index, { lat: 51, lng: 15 }), null);
});

test("addCandidates keeps only frames near the route that face along it (or are panos)", () => {
  const index = createFrameIndex(lRoute, INDEX_OPTS);
  const accepted = addCandidates(index, [
    at(500, { headingDeg: 10, ref: "forward" }),
    at(520, { headingDeg: 180, ref: "backward" }),
    at(540, { headingDeg: 180, isPano: true, ref: "pano" }),
    at(560, { headingDeg: 359, ref: "wrap-a" }),
    at(580, { headingDeg: 1, ref: "wrap-b" }),
    candidate({ lat: 50.0045, lng: 14.4 + 40 / 71700, ref: "too-far" }),
    at(500, { headingDeg: 10, ref: "forward" }), // duplicate ref
  ]);
  assert.equal(accepted, 4);
  assert.deepEqual(index.frames.map((frame) => frame.ref), ["forward", "pano", "wrap-a", "wrap-b"]);
  assert.ok(index.frames.every((frame, i, all) => i === 0 || all[i - 1].distanceMeters <= frame.distanceMeters));
  assert.ok(index.frames.every((frame) => typeof frame.distanceMeters === "number" && frame.offsetMeters <= 15));
});

function indexWith(frames) {
  const index = createFrameIndex(lRoute, INDEX_OPTS);
  addCandidates(index, frames);
  return index;
}

test("nextFrame queues the best frame beyond the minimum step, or null in a gap", () => {
  const index = indexWith([
    at(500, { ref: "a", sequenceId: "s1" }),
    at(503, { ref: "too-close", sequenceId: "s1" }),
    at(511, { ref: "other", sequenceId: "s2" }),
    at(513, { ref: "same", sequenceId: "s1" }),
    at(900, { ref: "far", sequenceId: "s1" }),
  ]);
  const a = frameByRef(index, "a");
  const opts = { minAdvanceMeters: 10, maxAheadMeters: 60, sameSequenceBonusMeters: 20 };
  assert.equal(nextFrame(index, a, opts).ref, "same", "same sequence beats a slightly nearer other one");
  assert.equal(nextFrame(index, a, { ...opts, sameSequenceBonusMeters: 0 }).ref, "other");
  assert.equal(nextFrame(index, frameByRef(index, "same"), opts), null, "nothing within reach ahead");
  assert.equal(frameByRef(index, "nope"), null);
});

test("coverage helpers merge nearby frames into runs and measure gaps", () => {
  const index = indexWith([at(100, {}), at(150, {}), at(200, {}), at(900, {})]);
  const segments = coverageSegments(index, 100);
  assert.deepEqual(
    segments.map((segment) => [Math.round(segment.startMeters), Math.round(segment.endMeters), segment.count]),
    [[50, 250, 3], [850, 950, 1]],
  );
  const total = 2000;
  assert.ok(Math.abs(coveragePercent(segments, total) - 15) < 0.5);
  assert.ok(Math.abs(longestGapMeters(segments, total) - 1050) < 1);
  assert.equal(coveragePercent([], total), 0);
  assert.equal(longestGapMeters([], total), total);
  assert.equal(countFramesBy(index, "someone"), 4);
  assert.equal(countFramesBy(index, "nobody"), 0);
});
