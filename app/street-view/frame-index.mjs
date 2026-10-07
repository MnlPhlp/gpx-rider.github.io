// Route-distance index of street-imagery "frames" — the provider-agnostic
// core of the street imagery feature. Candidates (an image or a video
// instant with a position and, usually, a heading) are projected onto the
// route, kept only when they sit on the road and face along it, and stored
// sorted by distance along the route. frameForProgress then picks what to
// show at a given progress with hysteresis so playback doesn't ping-pong
// between neighbors, and the coverage helpers summarize where imagery
// exists. A frame's `ref` is opaque here: a Mapillary image id today, a
// video timestamp for a future "replay my own ride" source. Pure: no DOM,
// no app state; every threshold is passed in (the app reads them from
// tuning.yaml's street_imagery section).
//
// Candidate shape: { lat, lng, headingDeg|null, isPano, sequenceId,
//                    capturedAt, creator, ref }
// Frame shape:     candidate + { distanceMeters, offsetMeters, routeBearingDeg }

import { routeBearingAt, routeTotalDistance } from "../route/route.mjs";

const METERS_PER_DEGREE_LAT = 111320;
const DEFAULT_GRID_CELL_DEGREES = 0.001;

export function wrap180(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// Basic x coordinate ([0, 1] across the image) that points a 360° image
// along the route: the viewer centers x = 0.5 on the image's compass angle.
export function panoCenterX(routeHeadingDeg, compassDeg) {
  return 0.5 + wrap180(routeHeadingDeg - compassDeg) / 360;
}

export function createFrameIndex(route, {
  maxOffsetMeters,
  headingToleranceDegrees,
  bearingSampleMeters = 4,
  gridCellDegrees = DEFAULT_GRID_CELL_DEGREES,
}) {
  return {
    route,
    totalMeters: route?.length ? routeTotalDistance(route) : 0,
    frames: [],
    refs: new Set(),
    frameByRef: new Map(),
    maxOffsetMeters,
    headingToleranceDegrees,
    bearingSampleMeters,
    projection: buildProjection(route, gridCellDegrees),
  };
}

// Equirectangular local frame (meters east/north of the first point) plus a
// grid of segment buckets, so projecting a candidate only inspects the
// handful of segments near it instead of the whole track.
function buildProjection(route, gridCellDegrees) {
  if (!route || route.length < 2) return null;
  const meanLat = route.reduce((sum, point) => sum + point.lat, 0) / route.length;
  const mPerDegLat = METERS_PER_DEGREE_LAT;
  const mPerDegLng = METERS_PER_DEGREE_LAT * Math.cos((meanLat * Math.PI) / 180);
  const lat0 = route[0].lat;
  const lng0 = route[0].lng;
  const cellSizeMeters = gridCellDegrees * mPerDegLat;
  const toXY = (point) => ({ x: (point.lng - lng0) * mPerDegLng, y: (point.lat - lat0) * mPerDegLat });

  const segments = [];
  const grid = new Map();
  for (let i = 0; i + 1 < route.length; i += 1) {
    const a = toXY(route[i]);
    const b = toXY(route[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    segments.push({
      ax: a.x,
      ay: a.y,
      dx,
      dy,
      len2: dx * dx + dy * dy,
      startMeters: route[i].distance,
      lengthMeters: route[i + 1].distance - route[i].distance,
    });
    const cx0 = Math.floor(Math.min(a.x, b.x) / cellSizeMeters);
    const cx1 = Math.floor(Math.max(a.x, b.x) / cellSizeMeters);
    const cy0 = Math.floor(Math.min(a.y, b.y) / cellSizeMeters);
    const cy1 = Math.floor(Math.max(a.y, b.y) / cellSizeMeters);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const key = `${cx}:${cy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  return { toXY, cellSizeMeters, segments, grid };
}

// Nearest point on the route to a position: distance along the route, the
// perpendicular offset from it, and the route's bearing there. Only the
// segments in the surrounding grid cells are considered, so positions more
// than about a cell (~111 m) from the track return null.
export function projectOntoRoute(index, { lat, lng }) {
  const projection = index.projection;
  if (!projection) return null;
  const { toXY, cellSizeMeters, segments, grid } = projection;
  const q = toXY({ lat, lng });
  const cx = Math.floor(q.x / cellSizeMeters);
  const cy = Math.floor(q.y / cellSizeMeters);

  let best = null;
  const seen = new Set();
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
      const bucket = grid.get(`${ix}:${iy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        if (seen.has(i)) continue;
        seen.add(i);
        const segment = segments[i];
        const t = segment.len2 > 0
          ? Math.max(0, Math.min(1, ((q.x - segment.ax) * segment.dx + (q.y - segment.ay) * segment.dy) / segment.len2))
          : 0;
        const px = segment.ax + t * segment.dx;
        const py = segment.ay + t * segment.dy;
        const dist2 = (q.x - px) ** 2 + (q.y - py) ** 2;
        if (!best || dist2 < best.dist2) {
          best = { dist2, distanceMeters: segment.startMeters + t * segment.lengthMeters };
        }
      }
    }
  }
  if (!best) return null;
  return {
    distanceMeters: best.distanceMeters,
    offsetMeters: Math.sqrt(best.dist2),
    bearingDeg: routeBearingAt(index.route, best.distanceMeters, index.bearingSampleMeters),
  };
}

function refKey(ref) {
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}

// Project candidates onto the route and keep the usable ones: close enough
// to the track, and either a 360° image or facing within the heading
// tolerance of the direction of travel (an image shot riding the other way
// shows the wrong road). Returns how many were accepted; duplicates by ref
// are ignored so repeated scans are idempotent.
export function addCandidates(index, candidates) {
  let accepted = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = refKey(candidate.ref);
    if (index.refs.has(key)) continue;
    const hit = projectOntoRoute(index, candidate);
    if (!hit || hit.offsetMeters > index.maxOffsetMeters) continue;
    const facesAlong = Number.isFinite(candidate.headingDeg)
      && Math.abs(wrap180(candidate.headingDeg - hit.bearingDeg)) <= index.headingToleranceDegrees;
    if (!candidate.isPano && !facesAlong) continue;

    const frame = {
      ...candidate,
      distanceMeters: hit.distanceMeters,
      offsetMeters: hit.offsetMeters,
      routeBearingDeg: hit.bearingDeg,
    };
    index.refs.add(key);
    index.frameByRef.set(key, frame);
    index.frames.splice(upperBound(index.frames, frame.distanceMeters), 0, frame);
    accepted += 1;
  }
  return accepted;
}

export function frameByRef(index, ref) {
  return ref == null ? null : index.frameByRef.get(refKey(ref)) ?? null;
}

// Score shared by frameForProgress and nextFrame: along-route distance from
// `originMeters`, minus the bonuses that keep playback coherent — staying in
// the sequence of `referenceFrame` (the viewer can animate between images of
// one capture run; a jump to another is a hard cut), the rider's own uploads,
// and 360° images (which always face the road).
function frameScore(frame, originMeters, referenceFrame, {
  sameSequenceBonusMeters = 0,
  ownImageryBonusMeters = 0,
  panoBonusMeters = 0,
  preferredCreator = null,
}) {
  let value = Math.abs(frame.distanceMeters - originMeters);
  if (referenceFrame && frame.sequenceId && frame.sequenceId === referenceFrame.sequenceId) value -= sameSequenceBonusMeters;
  if (preferredCreator && frame.creator === preferredCreator) value -= ownImageryBonusMeters;
  if (frame.isPano) value -= panoBonusMeters;
  return value;
}

function bestFrame(frames, from, to, originMeters, referenceFrame, options) {
  let winner = null;
  let winnerScore = Infinity;
  for (let i = from; i < to; i += 1) {
    const frame = frames[i];
    const value = frameScore(frame, originMeters, referenceFrame, options);
    if (value < winnerScore || (value === winnerScore && (frame.capturedAt ?? 0) > (winner?.capturedAt ?? 0))) {
      winner = frame;
      winnerScore = value;
    }
  }
  return winner;
}

// The frame playback should continue to after `frame`: the best-scoring one
// between minAdvanceMeters and maxAheadMeters further along the route, or
// null when a gap follows. Lets a renderer queue the next image behind the
// transition it is already running, so motion never stops between photos.
export function nextFrame(index, frame, { minAdvanceMeters = 0, maxAheadMeters, ...options }) {
  const frames = index.frames;
  const from = Math.max(
    upperBound(frames, frame.distanceMeters),
    lowerBound(frames, frame.distanceMeters + minAdvanceMeters),
  );
  const to = upperBound(frames, frame.distanceMeters + maxAheadMeters);
  if (from >= to) return null;
  return bestFrame(frames, from, to, frame.distanceMeters + minAdvanceMeters, frame, options);
}

// First position whose distance is >= meters.
function lowerBound(frames, meters) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].distanceMeters < meters) low = mid + 1;
    else high = mid;
  }
  return low;
}

// First position whose distance is > meters.
function upperBound(frames, meters) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].distanceMeters <= meters) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Which frame to show at `progressMeters`.
//   current: { frame, sinceMs } for the frame on screen, or null.
//   Returns a frame (the *same object* as current.frame when nothing should
//   change) or null when no frame is within reach — the caller then fades
//   back to the 3D view.
// Selection: within the reach window [p − maxBehind, p + maxAhead] the frame
// with the lowest score wins, score = along-route distance from the rider
// minus bonuses for staying in the current sequence (visual continuity),
// for the rider's own uploads, and for 360° images (always face the road).
// Hysteresis: while the current frame is still in reach, we only advance to
// a frame at least minAdvanceMeters ahead of it (dense areas have a frame
// every meter or two; stepping through all of them is constant churn, and
// ~10 m is where the view actually changes), once the rider has passed
// `switchFraction` of the way to it and the current frame has been up for
// at least minDwellMs — otherwise two neighbors would flicker back and forth
// around their midpoint.
export function frameForProgress(index, progressMeters, current, {
  nowMs,
  minDwellMs,
  switchFraction,
  maxBehindMeters,
  maxAheadMeters,
  minAdvanceMeters = 0,
  sameSequenceBonusMeters = 0,
  ownImageryBonusMeters = 0,
  panoBonusMeters = 0,
  preferredCreator = null,
}) {
  const frames = index.frames;
  const start = lowerBound(frames, progressMeters - maxBehindMeters);
  const end = upperBound(frames, progressMeters + maxAheadMeters);
  if (start >= end) return null;

  const currentFrame = current?.frame ?? null;
  const scoring = { sameSequenceBonusMeters, ownImageryBonusMeters, panoBonusMeters, preferredCreator };
  const best = (from, to) => bestFrame(frames, from, to, progressMeters, currentFrame, scoring);

  const currentInReach = currentFrame
    && currentFrame.distanceMeters >= progressMeters - maxBehindMeters
    && currentFrame.distanceMeters <= progressMeters + maxAheadMeters;
  if (!currentInReach) return best(start, end);

  const aheadStart = Math.max(
    upperBound(frames, currentFrame.distanceMeters),
    lowerBound(frames, currentFrame.distanceMeters + minAdvanceMeters),
  );
  if (aheadStart >= end) return currentFrame;
  const next = best(aheadStart, end);
  if (!next) return currentFrame;
  const switchAt = currentFrame.distanceMeters + switchFraction * (next.distanceMeters - currentFrame.distanceMeters);
  const dwelled = nowMs - (current.sinceMs ?? -Infinity) >= minDwellMs;
  return progressMeters >= switchAt && dwelled ? next : currentFrame;
}

// How far the rider has progressed from `frame` toward the next frame along
// the route, 0..1 (1 when there is no next frame or the rider is past it).
// Drives the "approach zoom": the renderer zooms into the current photo as
// the rider closes in on where the next one was taken, so the cut lands at
// the point the zoomed view was already converging on.
export function approachFraction(index, frame, progressMeters) {
  const nextIndex = upperBound(index.frames, frame.distanceMeters);
  const next = index.frames[nextIndex];
  if (!next) return 1;
  const span = next.distanceMeters - frame.distanceMeters;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (progressMeters - frame.distanceMeters) / span));
}

// Covered runs of the route: each frame covers ±gapMeters/2 around itself and
// overlapping runs merge. Used for the elevation-profile strip and the
// coverage percentage.
export function coverageSegments(index, gapMeters) {
  const half = gapMeters / 2;
  const total = index.totalMeters;
  const segments = [];
  for (const frame of index.frames) {
    const startMeters = Math.max(0, frame.distanceMeters - half);
    const endMeters = Math.min(total, frame.distanceMeters + half);
    const last = segments.at(-1);
    if (last && startMeters <= last.endMeters) {
      last.endMeters = Math.max(last.endMeters, endMeters);
      last.count += 1;
    } else {
      segments.push({ startMeters, endMeters, count: 1 });
    }
  }
  return segments;
}

export function coveragePercent(segments, totalMeters) {
  if (!(totalMeters > 0)) return 0;
  const covered = segments.reduce((sum, segment) => sum + (segment.endMeters - segment.startMeters), 0);
  return Math.max(0, Math.min(100, (covered / totalMeters) * 100));
}

export function longestGapMeters(segments, totalMeters) {
  if (!segments.length) return totalMeters;
  let longest = segments[0].startMeters;
  for (let i = 1; i < segments.length; i += 1) {
    longest = Math.max(longest, segments[i].startMeters - segments[i - 1].endMeters);
  }
  return Math.max(longest, totalMeters - segments.at(-1).endMeters);
}

export function countFramesBy(index, creator) {
  if (!creator) return 0;
  return index.frames.reduce((count, frame) => count + (frame.creator === creator ? 1 : 0), 0);
}
