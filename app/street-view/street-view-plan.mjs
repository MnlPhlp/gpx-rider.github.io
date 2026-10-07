// Street imagery route lifecycle: everything that turns the loaded route
// into a playback plan for the renderer, keyed on route identity by the
// coordinator (street-view-ui.mjs). A route ridden before has its plan
// cached in the asset store and skips the network; otherwise the coverage
// scan (mapillary-source.mjs) fills the pure frame index, an interim plan is
// built every interim_plan_ms while the scan runs (so playback starts on
// the road ahead early), and the final plan — chain of frames + per-image
// metadata + link kinds (playback-plan.mjs) — is cached. Also the coverage
// summary (profile strip, settings readout) and the asset store itself.
// All state lives on state.streetImagery.

import { state } from "../core/state.mjs";
import { STREET_IMAGERY } from "../core/tuning.mjs";
import { renderProfile } from "../route/profile-ui.mjs";
import { addCandidates, countFramesBy, coveragePercent, coverageSegments, createFrameIndex, longestGapMeters } from "./frame-index.mjs";
import { createImageryStore, openImageryDatabase } from "./imagery-store.mjs";
import { createMapillarySource } from "./mapillary-source.mjs";
import { annotateLinks, buildChain, routePlanKey } from "./playback-plan.mjs";
import { renderStreetImageryCoverage } from "./street-view-settings.mjs";

function chainOptions() {
  const c = STREET_IMAGERY;
  return {
    minAdvanceMeters: c.min_advance_meters,
    maxAheadMeters: c.max_ahead_meters,
    sameSequenceBonusMeters: c.same_sequence_bonus_meters,
    ownImageryBonusMeters: c.own_imagery_bonus_meters,
    panoBonusMeters: c.pano_bonus_meters,
    preferredCreator: state.mapillaryUsername || null,
  };
}

function planKeyFor(route) {
  return `${routePlanKey(route, STREET_IMAGERY.renderer.plan_version)}:${state.mapillaryUsername || ""}`;
}

// A route ridden before has its plan cached: play it straight away and skip
// the scan (coverage then comes from the plan). Otherwise scan.
export async function startRoute(route) {
  const si = state.streetImagery;
  resetIndex();
  si.indexRoute = route;
  si.status = "scanning";
  si.planKey = planKeyFor(route);
  const key = si.planKey;
  const store = await ensureStore();
  if (si.indexRoute !== route || si.planKey !== key) return;
  const cached = await store.loadPlan(key);
  if (si.indexRoute !== route || si.planKey !== key) return;
  if (cached?.nodes?.length) {
    store.adoptMetadata(cached.nodes.map((node) => node.meta));
    si.plan = cached;
    si.planFinal = true;
    si.scanDone = true;
    si.scanPromise = Promise.resolve();
    si.status = "ready";
    si.renderer?.setPlan(cached);
    updateCoverage();
    return;
  }
  startScan(route);
}

export function startScan(route) {
  const si = state.streetImagery;
  if (si.indexRoute !== route) resetIndex();
  const c = STREET_IMAGERY;
  const index = createFrameIndex(route, {
    maxOffsetMeters: c.max_offset_meters,
    headingToleranceDegrees: c.heading_tolerance_degrees,
    bearingSampleMeters: c.heading_sample_meters,
  });
  si.index = index;
  si.indexRoute = route;
  si.planKey = si.planKey ?? planKeyFor(route);
  si.status = "scanning";
  if (!si.source) si.source = createMapillarySource({ token: si.token, config: c });

  const controller = new AbortController();
  si.scanController = controller;
  let batchesSinceCoverage = 0;
  si.scanPromise = si.source.scanRoute(route, {
    signal: controller.signal,
    startMeters: state.progressMeters,
    onCandidates: (candidates) => {
      if (si.index !== index) return;
      addCandidates(index, candidates);
      batchesSinceCoverage += 1;
      if (batchesSinceCoverage >= 10) {
        batchesSinceCoverage = 0;
        updateCoverage();
      }
    },
    onProgress: (progress) => {
      if (si.index !== index) return;
      si.scan = progress;
      renderStreetImageryCoverage();
    },
  }).then(() => {
    if (si.index !== index) return;
    si.scanDone = true;
    si.status = "ready";
    updateCoverage();
  }).catch((error) => {
    if (si.index !== index || controller.signal.aborted) return;
    si.scanDone = true;
    if (error?.code === "token") {
      si.status = "token-error";
    } else {
      si.status = "ready";
      console.warn("[street-imagery] route scan failed", error);
    }
    updateCoverage();
  });
}

// Build (or rebuild) the playback plan from the index: an interim plan every
// interim_plan_ms while the scan is still filling the index, the final one
// once it is done — that one is cached for the route.
export function maybeBuildPlan() {
  const si = state.streetImagery;
  const index = si.index;
  if (!index || !si.store || si.planPromise || si.status === "token-error") return;
  const final = si.scanDone;
  if (final ? si.planFinal : !(performance.now() - si.planBuiltAt >= STREET_IMAGERY.renderer.interim_plan_ms)) return;
  if (!index.frames.length || (!final && index.frames.length === si.planIndexSize)) return;
  const c = STREET_IMAGERY;
  const chain = buildChain(index, chainOptions());
  const controller = new AbortController();
  si.planController = controller;
  const key = si.planKey;
  si.planPromise = (async () => {
    const metadata = await si.store.fetchMetadata(chain.map((node) => node.ref), { signal: controller.signal });
    if (si.index !== index || controller.signal.aborted) return;
    const plan = annotateLinks(chain, metadata, {
      parallaxMaxMeters: c.renderer.parallax_max_meters,
      minQualityScore: c.renderer.min_quality_score,
      maxLinkMeters: c.max_ahead_meters,
    });
    si.plan = plan;
    si.planFinal = final;
    si.planBuiltAt = performance.now();
    si.planIndexSize = index.frames.length;
    si.renderer?.setPlan(plan);
    if (final) si.store.savePlan(key, { nodes: plan.nodes, links: plan.links });
  })().catch((error) => {
    if (controller.signal.aborted || error?.name === "AbortError") return;
    if (error?.code === "token") si.status = "token-error";
    else console.warn("[street-imagery] plan failed", error);
    si.planBuiltAt = performance.now();
  }).finally(() => {
    if (si.planController === controller) {
      si.planController = null;
      si.planPromise = null;
    }
  });
}

export function resetIndex() {
  const si = state.streetImagery;
  si.scanController?.abort();
  si.scanController = null;
  si.planController?.abort();
  si.planController = null;
  si.planPromise = null;
  si.index = null;
  si.indexRoute = null;
  si.scanPromise = null;
  si.scanDone = false;
  si.scan = { done: 0, total: 0 };
  si.coverage = null;
  si.plan = null;
  si.planKey = null;
  si.planFinal = false;
  si.planBuiltAt = -Infinity;
  si.planIndexSize = 0;
  si.renderer?.setPlan(null);
  renderProfile();
  renderStreetImageryCoverage();
}

export function updateCoverage() {
  const si = state.streetImagery;
  const index = si.index ?? (si.plan && si.indexRoute
    ? { frames: si.plan.nodes.map((node) => node.frame), totalMeters: si.indexRoute.at(-1).distance ?? 0 }
    : null);
  if (!index) return;
  const segments = coverageSegments(index, STREET_IMAGERY.coverage_gap_meters);
  si.coverage = {
    segments,
    percent: coveragePercent(segments, index.totalMeters),
    frames: index.frames.length,
    own: countFramesBy(index, state.mapillaryUsername || null),
    longestGapMeters: longestGapMeters(segments, index.totalMeters),
  };
  renderProfile();
  renderStreetImageryCoverage();
}

// The asset store (metadata + bytes + plans, IndexedDB-backed) for the
// current token; a token-less store still serves the cache statistics.
export function ensureStore() {
  const si = state.streetImagery;
  if (si.store) return Promise.resolve(si.store);
  if (!si.storePromise) {
    if (!si.dbPromise) {
      si.dbPromise = openImageryDatabase().catch((error) => {
        console.warn("[street-imagery] cache database unavailable", error);
        return null;
      });
    }
    const token = si.token;
    const promise = si.dbPromise.then((db) => {
      const store = createImageryStore({ token: token ?? "", config: STREET_IMAGERY, db });
      if (si.storePromise === promise && si.token === token) si.store = store;
      return store;
    });
    si.storePromise = promise;
  }
  return si.storePromise;
}

