// The virtual world's road geometry. Pure — the terrain module shapes its
// flat road bed along the same centerline the scene draws the asphalt on.
//
//   - Centerline: the track de-jittered (Douglas-Peucker), then a centripetal
//     Catmull-Rom spline through the remaining points. The spline passes
//     exactly through every kept GPX vertex — bends are rounded without
//     pulling hairpins inward the way averaging would — and the centripetal
//     parameterization never overshoots or loops. Elevation is interpolated
//     linearly and then Gaussian-smoothed along the road, so grade changes
//     are gentle too.
//   - Cross-sections: a solid strip (asphalt top + embankments sloping into
//     the ground), with every column's offset on the inside of a bend clamped
//     to the bend's radius so a tight hairpin never folds the strip over
//     itself.

// Gaussian smoothing of an evenly spaced polyline along its length, of the
// given fields. The window shrinks symmetrically toward the ends, so both
// endpoints stay put and nothing drifts. `sigmaSamples` is the kernel width
// in samples.
export function smoothPolyline(points, sigmaSamples, fields = ["x", "z", "e"]) {
  if (!(sigmaSamples > 0) || points.length < 3) return points.map((p) => ({ ...p }));
  const reach = Math.ceil(sigmaSamples * 3);
  const weights = Array.from({ length: reach + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const last = points.length - 1;
  return points.map((point, i) => {
    const r = Math.min(reach, i, last - i);
    const out = { ...point };
    for (const field of fields) {
      let sw = 0;
      let sv = 0;
      for (let k = -r; k <= r; k++) {
        const w = weights[Math.abs(k)];
        sw += w;
        sv += w * points[i + k][field];
      }
      out[field] = sv / sw;
    }
    return out;
  });
}

// Douglas-Peucker in x/z/elevation: drops points the line between their
// neighbors already passes within `tolerance` meters of, then re-splits any
// segment longer than `maxLength`. Straights collapse to a few long segments
// while bends keep their detail.
export function simplifyPolyline(points, tolerance, maxLength = Infinity) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = points.length > 2 ? [[0, points.length - 1]] : [];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment3(points[i], points[a], points[b]);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  let previous = null;
  points.forEach((p, i) => {
    if (!keep[i]) return;
    if (previous && Number.isFinite(maxLength)) {
      const length = Math.hypot(p.x - previous.x, p.z - previous.z);
      const steps = Math.ceil(length / maxLength);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({ x: previous.x + (p.x - previous.x) * t, z: previous.z + (p.z - previous.z) * t, e: previous.e + (p.e - previous.e) * t });
      }
    }
    out.push({ ...p });
    previous = p;
  });
  return out;
}

function distanceToSegment3(p, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z; const de = b.e - a.e;
  const lengthSq = dx * dx + dz * dz + de * de;
  let t = lengthSq > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz + (p.e - a.e) * de) / lengthSq : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t), p.e - (a.e + de * t));
}

// Centripetal Catmull-Rom (alpha 0.5) through `points` in x/z, sampled at most
// `spacing` meters apart; elevation runs linearly between the input points.
// Passes exactly through every input point.
export function catmullRomPolyline(points, spacing) {
  // Two points are a straight line: just resample it.
  if (points.length < 3) return simplifyPolyline(points, Infinity, spacing);
  const n = points.length;
  const at = (i) => {
    if (i < 0) return { x: 2 * points[0].x - points[1].x, z: 2 * points[0].z - points[1].z };
    if (i >= n) return { x: 2 * points[n - 1].x - points[n - 2].x, z: 2 * points[n - 1].z - points[n - 2].z };
    return points[i];
  };
  const knot = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
  const out = [{ ...points[0] }];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1); const p1 = points[i]; const p2 = points[i + 1]; const p3 = at(i + 2);
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    // Steps are even in the spline parameter, not in arc length; oversample a
    // little so the curved stretches stay near the requested spacing too.
    const steps = Math.max(1, Math.ceil((1.25 * Math.hypot(p2.x - p1.x, p2.z - p1.z)) / spacing));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      if (s === steps) {
        out.push({ ...p2 });
        break;
      }
      const t = t1 + (t2 - t1) * f;
      const lerp = (a, b, ta, tb) => ({
        x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta),
        z: ((tb - t) * a.z + (t - ta) * b.z) / (tb - ta),
      });
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      const c = lerp(b1, b2, t1, t2);
      out.push({ x: c.x, z: c.z, e: p1.e + (p2.e - p1.e) * f });
    }
  }
  return out;
}

// Local route samples ({ x, z, e }, see world-terrain.mjs) → the road's
// smooth centerline.
export function roadCenterline(localPoints, config) {
  const spacing = config.centerline_spacing_meters;
  const key = simplifyPolyline(localPoints, config.road_simplify_meters);
  const curve = catmullRomPolyline(key, spacing);
  return smoothPolyline(curve, config.road_elevation_smoothing_meters / spacing, ["e"]);
}

// Per centerline point: the unit sideways vector (to the left of travel in
// the x-east/z-south frame) and how far each side may extend before the
// strip folds — the local bend radius on the inside, unlimited outside.
export function crossSectionFrames(centerline, { neighborhood = 2, insideFactor = 0.85 } = {}) {
  const n = centerline.length;
  const frames = centerline.map((_, i) => {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    return { side: { x: tz, z: -tx }, maxLeft: Infinity, maxRight: Infinity };
  });
  for (let i = 1; i < n - 1; i++) {
    const a = centerline[i - 1]; const b = centerline[i]; const c = centerline[i + 1];
    const ux = b.x - a.x; const uz = b.z - a.z; const vx = c.x - b.x; const vz = c.z - b.z;
    const lu = Math.hypot(ux, uz); const lv = Math.hypot(vx, vz);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cross = ux * vz - uz * vx;
    const turn = Math.atan2(Math.abs(cross), ux * vx + uz * vz);
    if (turn < 1e-6) continue;
    const radius = insideFactor * ((lu + lv) / 2) / turn;
    // Spread the limit over the neighbors: the fold involves several
    // consecutive cross-sections, not just the one at the apex.
    for (let k = Math.max(0, i - neighborhood); k <= Math.min(n - 1, i + neighborhood); k++) {
      // cross < 0: the path turns toward `side` (left); cross > 0: right.
      if (cross < 0) frames[k].maxLeft = Math.min(frames[k].maxLeft, radius);
      else frames[k].maxRight = Math.min(frames[k].maxRight, radius);
    }
  }
  return frames;
}

// The road strip's mesh arrays, relative to centerline[0]. `columns` are
// [sideways offset (+ = left), height relative to the top, color index]
// left to right; positions are clamped per side by crossSectionFrames.
export function buildRoadArrays(centerline, { columns, lift }) {
  const count = centerline.length;
  const width = columns.length;
  if (count < 2) return null;
  const frames = crossSectionFrames(centerline);
  const origin = centerline[0];
  const positions = new Float32Array(count * width * 3);
  const colorIndex = new Uint8Array(count * width);
  for (let i = 0; i < count; i++) {
    const s = centerline[i];
    const { side, maxLeft, maxRight } = frames[i];
    columns.forEach(([offset, drop, color], c) => {
      const clamped = offset > 0 ? Math.min(offset, maxLeft) : -Math.min(-offset, maxRight);
      const v = (i * width + c) * 3;
      positions[v] = s.x - origin.x + side.x * clamped;
      positions[v + 1] = s.e + lift + drop;
      positions[v + 2] = s.z - origin.z + side.z * clamped;
      colorIndex[i * width + c] = color;
    });
  }
  // Quads between consecutive cross-sections for each band (column pairs
  // whose edge is not doubled, i.e. pairs given in `bands`).
  const bands = [];
  for (let c = 0; c < width - 1; c += 2) bands.push(c);
  const indices = new Uint32Array((count - 1) * bands.length * 6);
  let k = 0;
  for (let i = 0; i < count - 1; i++) {
    for (const c of bands) {
      const a = i * width + c;
      const b = a + 1;
      indices.set([a, b, a + width, b, b + width, a + width], k);
      k += 6;
    }
  }
  return { origin, positions, colorIndex, indices };
}
