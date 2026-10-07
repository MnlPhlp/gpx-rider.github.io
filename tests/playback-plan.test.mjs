import assert from "node:assert/strict";
import test from "node:test";

import { enrichRoute } from "../app/route/route.mjs";
import { addCandidates, createFrameIndex } from "../app/street-view/frame-index.mjs";
import {
  annotateLinks,
  buildChain,
  chainPositionAt,
  prefetchWindow,
  routePlanKey,
} from "../app/street-view/playback-plan.mjs";

// The same L-shaped route as frame-index.test.mjs: 1 km north, then 1 km east.
const lRoute = enrichRoute([
  ...Array.from({ length: 10 }, (_, i) => ({ lat: 50.000 + i * 0.001, lng: 14.400, ele: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ lat: 50.009, lng: 14.400 + (i + 1) * 0.0014, ele: 0 })),
]);
const northLegMeters = lRoute[9].distance;

function at(meters, overrides = {}) {
  return {
    lat: 50.000 + (meters / northLegMeters) * 0.009,
    lng: 14.4,
    headingDeg: 0,
    isPano: false,
    sequenceId: "s1",
    capturedAt: 1,
    creator: null,
    ref: `ref-${meters}`,
    ...overrides,
  };
}

function indexWith(frames) {
  const index = createFrameIndex(lRoute, { maxOffsetMeters: 15, headingToleranceDegrees: 45 });
  addCandidates(index, frames);
  return index;
}

const CHAIN_OPTS = { minAdvanceMeters: 10, maxAheadMeters: 60, sameSequenceBonusMeters: 20 };

function metaFor(index, ref, overrides = {}) {
  const frame = index.frames.find((f) => f.ref === ref);
  return {
    id: ref,
    lat: frame.lat,
    lng: frame.lng,
    originalLat: frame.lat,
    originalLng: frame.lng,
    altitude: 100,
    rotation: [0, 0, 0],
    mergeId: "cc",
    thumbUrl: `https://img/${ref}`,
    quality: 0.9,
    compassDeg: 0,
    ...overrides,
  };
}

test("buildChain walks the index at the playback step and restarts after gaps", () => {
  const index = indexWith([
    at(500, { ref: "a" }),
    at(503, { ref: "too-close" }),
    at(511, { ref: "other", sequenceId: "s2" }),
    at(513, { ref: "same" }),
    at(900, { ref: "far" }),
  ]);
  const chain = buildChain(index, CHAIN_OPTS);
  assert.deepEqual(chain.map((node) => node.ref), ["a", "same", "far"]);
  assert.deepEqual(chain.map((node) => node.gapBefore), [false, false, true]);
  assert.deepEqual(buildChain(indexWith([]), CHAIN_OPTS), []);
});

test("annotateLinks classifies parallax, cut and gap links and drops unusable frames", () => {
  const index = indexWith([at(500, { ref: "a" }), at(513, { ref: "b" }), at(526, { ref: "c" }), at(900, { ref: "far" })]);
  const chain = buildChain(index, CHAIN_OPTS);
  const metadata = new Map([
    ["a", metaFor(index, "a")],
    ["b", metaFor(index, "b")],
    ["c", metaFor(index, "c", { mergeId: "other-cc" })],
    ["far", metaFor(index, "far", { rotation: null, altitude: null })],
  ]);
  const plan = annotateLinks(chain, metadata, { parallaxMaxMeters: 25, maxLinkMeters: 60 });
  assert.deepEqual(plan.nodes.map((node) => node.ref), ["a", "b", "c", "far"]);
  assert.deepEqual(plan.links.map((link) => link.kind), ["parallax", "cut", "gap"]);
  assert.equal(plan.nodes[3].pose, "synthesized");
  assert.ok(Array.isArray(plan.nodes[3].meta.rotation), "a level pose is synthesized from the compass");
  assert.equal(plan.nodes[0].pose, "sfm");
  assert.ok(plan.nodes.every((node) => !("gapBefore" in node)));

  // Missing metadata drops a node; the neighbors then sit too far apart for a
  // link and become a gap. A quality floor drops low-quality frames.
  const sparse = annotateLinks(chain, new Map([["a", metaFor(index, "a")], ["far", metaFor(index, "far")]]), { parallaxMaxMeters: 25, maxLinkMeters: 60 });
  assert.deepEqual(sparse.nodes.map((node) => node.ref), ["a", "far"]);
  assert.deepEqual(sparse.links.map((link) => link.kind), ["gap"]);
  const filtered = annotateLinks(chain, new Map([["a", metaFor(index, "a", { quality: 0.1 })], ["b", metaFor(index, "b")]]), { parallaxMaxMeters: 25, minQualityScore: 0.5 });
  assert.deepEqual(filtered.nodes.map((node) => node.ref), ["b"]);
  // A gap before a dropped node carries over to the next kept one.
  const gapCarried = annotateLinks(
    [{ ref: "a", distanceMeters: 500, frame: {}, gapBefore: false }, { ref: "x", distanceMeters: 800, frame: {}, gapBefore: true }, { ref: "b", distanceMeters: 805, frame: {}, gapBefore: false }],
    new Map([["a", metaFor(index, "a")], ["b", metaFor(index, "b")]]),
    { parallaxMaxMeters: 25, maxLinkMeters: 1000 },
  );
  assert.deepEqual(gapCarried.links.map((link) => link.kind), ["gap"]);
});

function planFixture() {
  const index = indexWith([at(500, { ref: "a" }), at(513, { ref: "b" }), at(900, { ref: "far" })]);
  const chain = buildChain(index, CHAIN_OPTS);
  const metadata = new Map(["a", "b", "far"].map((ref) => [ref, metaFor(index, ref)]));
  return annotateLinks(chain, metadata, { parallaxMaxMeters: 25, maxLinkMeters: 60 });
}

const REACH = { maxBehindMeters: 40, maxAheadMeters: 60 };

test("chainPositionAt maps a route position onto a link fraction or a held node", () => {
  const plan = planFixture();
  assert.equal(chainPositionAt(plan, 400, REACH), null, "far before the first node");
  assert.deepEqual(chainPositionAt(plan, 490, REACH), { a: 0, b: null, s: 0, kind: "hold" }, "approaching the first node");
  const mid = chainPositionAt(plan, 506.5, REACH);
  assert.equal(mid.a, 0);
  assert.equal(mid.b, 1);
  assert.equal(mid.kind, "parallax");
  assert.ok(Math.abs(mid.s - 0.5) < 1e-6);
  assert.deepEqual(chainPositionAt(plan, 520, REACH), { a: 1, b: null, s: 1, kind: "hold" }, "in the gap, still near b");
  assert.equal(chainPositionAt(plan, 600, REACH), null, "deep in the gap");
  assert.deepEqual(chainPositionAt(plan, 850, REACH), { a: 2, b: null, s: 0, kind: "hold" }, "approaching the node after the gap");
  assert.deepEqual(chainPositionAt(plan, 905, REACH), { a: 2, b: null, s: 1, kind: "hold" }, "past the last node");
  assert.equal(chainPositionAt(plan, 950, REACH), null);
  assert.equal(chainPositionAt({ nodes: [], links: [] }, 0, REACH), null);
});

test("prefetchWindow covers the travel ahead at the current speed, at least a few links", () => {
  const plan = planFixture();
  const position = chainPositionAt(plan, 502, REACH);
  assert.deepEqual(prefetchWindow(plan, position, { progressMeters: 502, speedMps: 0, seconds: 20, minLinks: 0 }), [0, 1], "the current link only");
  assert.deepEqual(prefetchWindow(plan, position, { progressMeters: 502, speedMps: 0, seconds: 20, minLinks: 1 }), [0, 1, 2], "one link beyond the current one");
  assert.deepEqual(prefetchWindow(plan, position, { progressMeters: 502, speedMps: 0, seconds: 20, minLinks: 5 }), [0, 1, 2], "clamped to the chain");
  assert.deepEqual(prefetchWindow(plan, position, { progressMeters: 502, speedMps: 25, seconds: 20, minLinks: 1 }), [0, 1, 2], "500 m ahead reaches the far node");
  assert.deepEqual(prefetchWindow(plan, null, { progressMeters: 0, speedMps: 1, seconds: 1, minLinks: 1 }), []);
});

test("routePlanKey is stable for a route and changes with its shape or the plan version", () => {
  const key = routePlanKey(lRoute, 1);
  assert.equal(routePlanKey(lRoute, 1), key);
  assert.notEqual(routePlanKey(lRoute, 2), key);
  const other = enrichRoute(lRoute.map((p, i) => (i === 5 ? { ...p, lng: p.lng + 0.001 } : { ...p })));
  assert.notEqual(routePlanKey(other, 1), key);
  assert.equal(routePlanKey([], 1), null);
});
