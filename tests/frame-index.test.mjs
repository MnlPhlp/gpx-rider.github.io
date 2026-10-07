import assert from "node:assert/strict";
import test from "node:test";

import { enrichRoute } from "../app/route/route.mjs";
import {
  addCandidates,
  approachFraction,
  countFramesBy,
  coveragePercent,
  coverageSegments,
  createFrameIndex,
  frameForProgress,
  longestGapMeters,
  nextSwitchMeters,
  panoCenterX,
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

test("panoCenterX turns a route heading into the viewer's basic x coordinate", () => {
  assert.equal(panoCenterX(90, 0), 0.75);
  assert.equal(panoCenterX(0, 0), 0.5);
  assert.ok(Math.abs(panoCenterX(350, 10) - (0.5 - 20 / 360)) < 1e-9);
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

const SELECT_OPTS = {
  nowMs: 10_000,
  minDwellMs: 500,
  switchFraction: 0.5,
  maxBehindMeters: 40,
  maxAheadMeters: 60,
  sameSequenceBonusMeters: 20,
  ownImageryBonusMeters: 30,
  panoBonusMeters: 5,
  preferredCreator: null,
};

function indexWith(frames) {
  const index = createFrameIndex(lRoute, INDEX_OPTS);
  addCandidates(index, frames);
  return index;
}

test("frameForProgress returns null outside the reach window", () => {
  const index = indexWith([at(500, { ref: "f500" })]);
  assert.equal(frameForProgress(index, 100, null, SELECT_OPTS), null);
  assert.equal(frameForProgress(index, 580, null, SELECT_OPTS), null);
  assert.equal(frameForProgress(index, 440, null, SELECT_OPTS)?.ref, "f500");
  assert.equal(frameForProgress(index, 535, null, SELECT_OPTS)?.ref, "f500");
});

test("frameForProgress picks the nearest frame when nothing is shown yet", () => {
  const index = indexWith([at(480, { ref: "a" }), at(500, { ref: "b" }), at(530, { ref: "c" })]);
  assert.equal(frameForProgress(index, 505, null, SELECT_OPTS).ref, "b");
});

test("frameForProgress holds the current frame until the rider passes the midpoint, then switches", () => {
  const index = indexWith([at(500, { ref: "a" }), at(520, { ref: "b" })]);
  const a = index.frames[0];
  const current = { frame: a, sinceMs: 0 };
  assert.equal(frameForProgress(index, 505, current, SELECT_OPTS), a, "before midpoint: same object");
  assert.equal(frameForProgress(index, 509.9, current, SELECT_OPTS), a);
  assert.equal(frameForProgress(index, 510.5, current, SELECT_OPTS).ref, "b", "past midpoint: next frame");
});

test("frameForProgress skips frames closer than the minimum step distance", () => {
  const index = indexWith([at(500, { ref: "a" }), at(502, { ref: "b" }), at(504, { ref: "c" }), at(512, { ref: "d" })]);
  const current = { frame: index.frames[0], sinceMs: 0 };
  const opts = { ...SELECT_OPTS, minAdvanceMeters: 10 };
  // b and c are within 10 m of a: never stepped to; d (12 m ahead) is the
  // candidate, reached past the midpoint at 506 m.
  assert.equal(frameForProgress(index, 503, current, opts), index.frames[0]);
  assert.equal(frameForProgress(index, 505, current, opts), index.frames[0]);
  assert.equal(frameForProgress(index, 506.5, current, opts).ref, "d");
  // Without the minimum step, the very next frame is taken at its midpoint.
  assert.equal(frameForProgress(index, 501.5, current, SELECT_OPTS).ref, "b");
});

test("frameForProgress respects the minimum dwell time", () => {
  const index = indexWith([at(500, { ref: "a" }), at(520, { ref: "b" })]);
  const current = { frame: index.frames[0], sinceMs: 9_800 };
  assert.equal(frameForProgress(index, 515, current, SELECT_OPTS), index.frames[0], "shown 200 ms ago: hold");
  assert.equal(frameForProgress(index, 515, current, { ...SELECT_OPTS, nowMs: 10_400 }).ref, "b");
});

test("frameForProgress prefers the rider's own imagery, then the current sequence", () => {
  const index = indexWith([
    at(400, { ref: "prev", sequenceId: "a", creator: "stranger" }),
    at(500, { ref: "other-seq", sequenceId: "x", creator: "stranger" }),
    at(505, { ref: "same-seq", sequenceId: "a", creator: "stranger" }),
    at(512, { ref: "mine", sequenceId: "y", creator: "me" }),
  ]);
  // With no preference and no current frame: plain nearest.
  assert.equal(frameForProgress(index, 500, null, SELECT_OPTS).ref, "other-seq");
  // Coming from sequence "a" (now out of reach after a jump), staying on it
  // beats a slightly nearer frame from another sequence.
  const prev = index.frames.find((frame) => frame.ref === "prev");
  assert.equal(frameForProgress(index, 500, { frame: prev, sinceMs: 0 }, SELECT_OPTS).ref, "same-seq");
  // Own uploads win outright.
  assert.equal(frameForProgress(index, 500, null, { ...SELECT_OPTS, preferredCreator: "me" }).ref, "mine");
});

test("frameForProgress re-picks after a backward seek leaves the current frame behind", () => {
  const index = indexWith([at(300, { ref: "early" }), at(800, { ref: "late" })]);
  const current = { frame: index.frames[1], sinceMs: 0 };
  assert.equal(frameForProgress(index, 310, current, SELECT_OPTS).ref, "early");
});

test("nextSwitchMeters predicts where the selection will advance", () => {
  const index = indexWith([at(500, { ref: "a" }), at(502, { ref: "b" }), at(512, { ref: "c" })]);
  const [a, , c] = index.frames;
  // With a 10 m minimum step, b is skipped: the switch toward c sits at the midpoint 506 m.
  assert.ok(Math.abs(nextSwitchMeters(index, a, { minAdvanceMeters: 10, switchFraction: 0.5 }) - 506) < 1e-6);
  // Without the minimum step, b is next: midpoint 501 m.
  assert.ok(Math.abs(nextSwitchMeters(index, a, { switchFraction: 0.5 }) - 501) < 1e-6);
  assert.equal(nextSwitchMeters(index, c, { minAdvanceMeters: 10, switchFraction: 0.5 }), null);
});

test("approachFraction measures progress from the shown frame toward the next one", () => {
  const index = indexWith([at(500, { ref: "a" }), at(520, { ref: "b" })]);
  const [a, b] = index.frames;
  assert.equal(approachFraction(index, a, 495), 0, "not past the frame yet");
  assert.ok(Math.abs(approachFraction(index, a, 510) - 0.5) < 1e-6);
  assert.equal(approachFraction(index, a, 530), 1, "clamped past the next frame");
  assert.equal(approachFraction(index, b, 525), 1, "no next frame");
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
