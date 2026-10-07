// Per-route playback plan for the street imagery renderer: which frames of
// the index are played, in which order, and how each hop between two of
// them is shown. Building it is the "pre-processing" step a route goes
// through once (the coordinator caches the result): a greedy walk along the
// route-distance index picks a chain of frames at the playback step
// (nextFrame's scoring keeps a capture sequence together), then — once the
// per-image metadata is known — every link is classified as "parallax" (both
// images sit in the same SfM reconstruction, so the renderer can move a
// virtual camera between them), "cut" (unrelated reconstructions or no
// reconstruction at all: a cross-fade) or "gap" (too far apart: the 3D view
// shows in between). Playback then maps the rider's route position straight
// onto a link and a fraction along it — motion is driven by position, never
// by a clock. Pure, unit-tested; no DOM, no network, no app state.
//
// plan: { nodes: [{ ref, distanceMeters, frame, meta, pose: "sfm"|"synthesized" }],
//         links: [{ kind: "parallax"|"cut"|"gap", startMeters, endMeters }] }   (links[i] joins nodes i and i+1)

import { nextFrame } from "./frame-index.mjs";
import { isParallaxPair, synthesizePose } from "./sfm-camera.mjs";

// First frame index whose distance is > meters.
function firstBeyond(frames, meters) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].distanceMeters <= meters) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Walk the index: from each chosen frame, the next one is nextFrame's pick
// (at least minAdvanceMeters ahead, within maxAheadMeters, same-sequence /
// own-upload / pano bonuses); when nothing is within reach the chain
// restarts at the first frame beyond the step distance with a gap marked.
export function buildChain(index, { minAdvanceMeters = 0, maxAheadMeters, ...scoring }) {
  const frames = index.frames;
  if (!frames.length) return [];
  const chain = [{ frame: frames[0], gapBefore: false }];
  let current = frames[0];
  for (;;) {
    const next = nextFrame(index, current, { minAdvanceMeters, maxAheadMeters, ...scoring });
    if (next) {
      chain.push({ frame: next, gapBefore: false });
      current = next;
      continue;
    }
    const restart = firstBeyond(frames, current.distanceMeters + minAdvanceMeters);
    if (restart >= frames.length) break;
    current = frames[restart];
    chain.push({ frame: current, gapBefore: true });
  }
  return chain.map((entry) => ({ ref: entry.frame.ref, distanceMeters: entry.frame.distanceMeters, frame: entry.frame, gapBefore: entry.gapBefore }));
}

// Attach metadata to the chain and classify the links. Frames without
// metadata (deleted, not fetched) or below the quality floor are dropped;
// frames Mapillary never reconstructed get a level pose synthesized from
// their compass heading and only ever take part in cuts.
export function annotateLinks(chain, metadataById, {
  parallaxMaxMeters,
  minQualityScore = 0,
  maxLinkMeters = Infinity,
}) {
  const nodes = [];
  let pendingGap = false;
  for (const entry of chain) {
    const meta = metadataById.get(entry.ref) ?? null;
    pendingGap = pendingGap || entry.gapBefore;
    if (!meta || !meta.thumbUrl) continue;
    if (meta.quality != null && meta.quality < minQualityScore) continue;
    const reconstructed = Array.isArray(meta.rotation) && meta.altitude != null;
    const effective = reconstructed ? meta : { ...meta, rotation: synthesizePose(meta.compassDeg), altitude: meta.altitude ?? 0, scale: null };
    nodes.push({
      ref: entry.ref,
      distanceMeters: entry.distanceMeters,
      frame: entry.frame,
      meta: effective,
      pose: reconstructed ? "sfm" : "synthesized",
      gapBefore: pendingGap,
    });
    pendingGap = false;
  }

  const links = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const span = b.distanceMeters - a.distanceMeters;
    let kind;
    if (b.gapBefore || span > maxLinkMeters) kind = "gap";
    else if (a.pose === "sfm" && b.pose === "sfm" && isParallaxPair(a.meta, b.meta, parallaxMaxMeters)) kind = "parallax";
    else kind = "cut";
    links.push({ kind, startMeters: a.distanceMeters, endMeters: b.distanceMeters });
  }
  for (const node of nodes) delete node.gapBefore;
  return { nodes, links };
}

// Last node index whose distance is <= meters, or -1.
function lastNodeAtOrBefore(nodes, meters) {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (nodes[mid].distanceMeters <= meters) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

// Where playback is at a route position: { a, b, s, kind } — on a link
// (b = a + 1, s = fraction along it, kind parallax/cut), or holding a single
// node (b = null, kind "hold": before the first node, in a gap, past the
// last node — within the reach window), or null when nothing is in reach.
export function chainPositionAt(plan, progressMeters, { maxBehindMeters, maxAheadMeters }) {
  const nodes = plan?.nodes ?? [];
  if (!nodes.length) return null;
  const i = lastNodeAtOrBefore(nodes, progressMeters);
  if (i < 0) {
    return nodes[0].distanceMeters - progressMeters <= maxAheadMeters ? { a: 0, b: null, s: 0, kind: "hold" } : null;
  }
  const link = plan.links[i];
  if (link && link.kind !== "gap") {
    const span = link.endMeters - link.startMeters;
    const s = span > 0 ? Math.max(0, Math.min(1, (progressMeters - link.startMeters) / span)) : 1;
    return { a: i, b: i + 1, s, kind: link.kind };
  }
  if (progressMeters - nodes[i].distanceMeters <= maxBehindMeters) return { a: i, b: null, s: 1, kind: "hold" };
  if (link && nodes[i + 1].distanceMeters - progressMeters <= maxAheadMeters) return { a: i + 1, b: null, s: 0, kind: "hold" };
  return null;
}

// Node indices worth having loaded now: from the current node to the one
// covering `seconds` of travel at the current speed, and never fewer than
// minLinks ahead.
export function prefetchWindow(plan, position, { progressMeters, speedMps, seconds, minLinks }) {
  const nodes = plan?.nodes ?? [];
  if (!nodes.length || !position) return [];
  const start = position.a;
  const aheadMeters = Math.max(0, speedMps) * seconds;
  let end = lastNodeAtOrBefore(nodes, progressMeters + aheadMeters);
  end = Math.max(end, (position.b ?? start) + minLinks);
  end = Math.min(nodes.length - 1, Math.max(start, end));
  const indices = [];
  for (let i = start; i <= end; i += 1) indices.push(i);
  return indices;
}

// Stable identity of a route for caching its plan: endpoints, length, point
// count and a sampled coordinate checksum, prefixed by a plan version so a
// tuning change can invalidate every cached plan at once.
export function routePlanKey(route, version = 1) {
  if (!route?.length) return null;
  const first = route[0];
  const last = route.at(-1);
  const total = last.distance ?? 0;
  let checksum = 0;
  const step = Math.max(1, Math.floor(route.length / 64));
  for (let i = 0; i < route.length; i += step) {
    checksum = (checksum * 31 + Math.round(route[i].lat * 1e5) + Math.round(route[i].lng * 1e5)) % 2147483647;
  }
  return `v${version}:${route.length}:${total.toFixed(0)}:${first.lat.toFixed(5)},${first.lng.toFixed(5)}:${last.lat.toFixed(5)},${last.lng.toFixed(5)}:${checksum}`;
}
