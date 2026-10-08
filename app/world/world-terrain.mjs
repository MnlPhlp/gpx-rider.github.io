// The virtual world's ground: a deterministic height field synthesized from
// nothing but the route's own track and elevations. Pure — no three.js, no
// DOM — so the tile builder, the tree scatterer, the overlay placement and the
// follow camera's terrain avoidance all read the exact same surface.
//
// The surface is built in three layers:
//   1. A road bed. Every route segment within `influence_radius_meters` pulls
//      the ground toward its own elevation with an inverse-distance weight
//      (Shepard interpolation). Inside the road's half width the nearest
//      segment dominates completely, so the road sits exactly at the GPX
//      elevation; between two switchback legs the weights blend into a real
//      hillside instead of a cliff halfway between them.
//   2. A regional trend: a coarse raster of the Gaussian-smoothed route
//      elevation (and its local spread), so the land far from the road still
//      rises toward the mountains the route climbs into and stays low where
//      the route runs flat.
//   3. Relief: fractal noise whose amplitude is zero on the road, grows with
//      distance from it, scales with how hilly the route is locally, and turns
//      from rolling hills into ridged mountains when that amplitude is large.
//      The noise is biased upward, so roads mostly run along valley floors —
//      where real roads tend to be.
//
// Local frame: x = meters east, z = meters south (three.js's -z is north),
// y = elevation in meters, all relative to the route's bounding-box center.

import { createNoise2D, fbm, ridged, seedFromString } from "./world-noise.mjs";
import { roadCenterline, simplifyPolyline } from "./world-road.mjs";

const EARTH_RADIUS_METERS = 6371000;
const DEG = Math.PI / 180;
const DEFAULT_ORIGIN = { lat: 46.8182, lng: 8.2275 };

// Equirectangular projection around `origin`. Accurate to well under 1% over
// the few hundred kilometers a ride spans, and both the camera eye and its
// look-at point go through the same projection, so the view stays consistent.
export function createWorldProjection(origin = DEFAULT_ORIGIN) {
  const lat0 = Number(origin.lat) || 0;
  const lng0 = Number(origin.lng) || 0;
  const metersPerDegLat = EARTH_RADIUS_METERS * DEG;
  const metersPerDegLng = metersPerDegLat * Math.max(1e-6, Math.cos(lat0 * DEG));
  return {
    origin: { lat: lat0, lng: lng0 },
    toLocal(lat, lng) {
      return { x: (lng - lng0) * metersPerDegLng, z: -(lat - lat0) * metersPerDegLat };
    },
    toGeo(x, z) {
      return { lat: lat0 - z / metersPerDegLat, lng: lng0 + x / metersPerDegLng };
    },
  };
}

export function smoothstep(edge0, edge1, value) {
  if (edge1 === edge0) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Route → evenly spaced local samples { x, z, e } (at most `spacing` apart).
export function resampleRouteLocal(route, projection, spacing) {
  const out = [];
  if (!Array.isArray(route)) return out;
  let previous = null;
  for (const point of route) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const local = projection.toLocal(lat, lng);
    const current = { x: local.x, z: local.z, e: Number(point.ele) || 0 };
    if (previous) {
      const length = Math.hypot(current.x - previous.x, current.z - previous.z);
      const steps = Math.max(1, Math.ceil(length / spacing));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({
          x: previous.x + (current.x - previous.x) * t,
          z: previous.z + (current.z - previous.z) * t,
          e: previous.e + (current.e - previous.e) * t,
        });
      }
      if (length < 0.01) continue;
    }
    out.push(current);
    previous = current;
  }
  return out;
}

// `dem` (optional, world-dem.mjs#createDem): real ground elevation. With it
// the ground is the real terrain plus a little detail noise, the road bed
// still pinned to the GPX and blended into the real ground beside the road
// (config.real), and no relief is invented; wherever the DEM has no data
// the route-only synthesis below takes over.
export function createWorldTerrain(route, config, { dem = null } = {}) {
  const points = Array.isArray(route) ? route.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng))) : [];
  const origin = points.length ? boundsCenter(points) : DEFAULT_ORIGIN;
  const projection = createWorldProjection(origin);
  const seed = points.length
    ? seedFromString(`${points[0].lat.toFixed(5)},${points[0].lng.toFixed(5)},${points.length}`)
    : 1;
  // The road's smooth centerline (world-road.mjs) — the scene draws the
  // asphalt along it and the road bed below follows it.
  const centerline = roadCenterline(resampleRouteLocal(points, projection, Infinity), config);
  // The ground is shaped by the simplified smooth centerline: close enough to
  // the asphalt (centerline_tolerance_meters) that the road bed stays under
  // it, far fewer segments for every height query to visit.
  const samples = simplifyPolyline(centerline, config.centerline_tolerance_meters, config.resample_meters);
  const relief = config.relief;

  // Elevation statistics of the route itself.
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let sumElevation = 0;
  for (const s of samples) {
    minElevation = Math.min(minElevation, s.e);
    maxElevation = Math.max(maxElevation, s.e);
    sumElevation += s.e;
  }
  if (!samples.length) {
    minElevation = config.empty_elevation_meters;
    maxElevation = config.empty_elevation_meters;
    sumElevation = config.empty_elevation_meters;
  }
  const meanElevation = sumElevation / Math.max(1, samples.length);

  // World bounds: the route's footprint plus a generous margin of scenery.
  let minX = 0; let maxX = 0; let minZ = 0; let maxZ = 0;
  for (const s of samples) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
  }
  const extent = Math.max(maxX - minX, maxZ - minZ, 1);
  const margin = Math.max(config.margin_meters, extent * config.margin_fraction);
  const bounds = { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };

  const segments = buildSegmentIndex(samples, config.influence_radius_meters);
  const regional = buildRegionalRaster(samples, bounds, config, meanElevation);
  const noise = createNoise2D(seed);
  const noiseMountains = createNoise2D(seed ^ 0x9e3779b9);

  const radius = config.influence_radius_meters;
  const power = config.weight_power;
  const halfWidth = config.road_half_width_meters;
  const backgroundWeight = config.background_weight / Math.pow(radius, power);
  const feature = relief.feature_meters;
  const bias = relief.valley_bias;
  const real = config.real;
  // With real ground, water is the sea (Terrarium carries bathymetry), kept
  // below the route so a polder road below sea level stays dry.
  const waterLevel = dem
    ? Math.min(real.sea_level_meters, minElevation - real.water_below_route_meters)
    : minElevation - config.water_below_route_meters;

  // Everything about the ground at (x, z), written into `out` (reused by hot
  // loops to avoid allocating): height, distance to the road, and the local
  // relief amplitude and alpine mix the surface colors key off.
  function sample(x, z, out = {}) {
    const near = segments.query(x, z, radius, halfWidth, power);
    const reg = regional.at(x, z);
    if (dem) {
      const geo = projection.toGeo(x, z);
      const ground = dem.elevationAt(geo.lat, geo.lng);
      if (ground !== null && ground !== undefined) return sampleReal(x, z, near, reg, ground, out);
    }
    const blended = (near.sumWeightedElevation + backgroundWeight * reg.mean) / (near.sumWeight + backgroundWeight);
    // Inside the bed the ground is exactly the nearest road point's elevation
    // (the weighted blend averages neighboring segments and would sit a few
    // centimeters off on a climb); it eases into the blend beyond.
    const bed = near.minDistance < radius ? 1 - smoothstep(halfWidth, halfWidth + config.road_bed_blend_meters, near.minDistance) : 0;
    const base = blended + (near.nearestElevation - blended) * bed;
    const distance = near.minDistance < radius ? near.minDistance : Math.max(radius, reg.distance);

    const amplitude = Math.min(relief.max_amplitude_meters, Math.max(relief.min_amplitude_meters, reg.spread * relief.local_relief_factor));
    const nearRamp = smoothstep(relief.road_clearance_meters, relief.ramp_meters, distance);
    const farBoost = 1 + (relief.far_boost - 1) * smoothstep(relief.ramp_meters, relief.far_ramp_meters, distance);
    const scaled = amplitude * farBoost;
    const alpine = smoothstep(relief.alpine_start_meters, relief.alpine_full_meters, scaled);

    let shape = 0;
    if (nearRamp > 0) {
      const hills = (fbm(noise, x / feature, z / feature, relief.octaves) + bias) / (1 + bias);
      shape = hills;
      if (alpine > 0) {
        const peaks = ridged(
          noiseMountains,
          x / relief.mountain_feature_meters,
          z / relief.mountain_feature_meters,
          relief.octaves,
          relief.ridge_gain,
          2,
          relief.ridge_sharpness,
        );
        shape = hills * (1 - alpine) + (peaks * 1.6 - 0.3) * alpine;
      }
    }

    out.height = base + scaled * nearRamp * shape;
    out.roadDistance = distance;
    out.amplitude = scaled * nearRamp;
    out.alpine = alpine;
    return out;
  }

  // Real ground: the DEM plus fine detail noise the ~10–30 m grid lacks, the
  // road bed at the GPX elevation, easing into the real ground over
  // real.road_blend_meters (cuttings and embankments where the two differ).
  function sampleReal(x, z, near, reg, ground, out) {
    const distance = near.minDistance < radius ? near.minDistance : Math.max(radius, reg.distance);
    const detailRamp = smoothstep(relief.road_clearance_meters, real.detail_ramp_meters, distance);
    const detail = fbm(noise, x / real.detail_feature_meters, z / real.detail_feature_meters, 3) * real.detail_meters * detailRamp;
    const natural = ground + detail;
    const bed = near.minDistance < radius
      ? 1 - smoothstep(halfWidth, halfWidth + real.road_blend_meters, near.minDistance)
      : 0;
    out.height = natural + (near.nearestElevation - natural) * bed;
    out.roadDistance = distance;
    out.amplitude = real.detail_meters * detailRamp;
    out.alpine = smoothstep(real.alpine_from_meters, real.alpine_full_meters, out.height);
    return out;
  }

  const scratch = {};
  function heightAt(x, z) {
    return sample(x, z, scratch).height;
  }

  return {
    projection,
    seed,
    realGround: Boolean(dem),
    bounds,
    extent,
    samples,
    centerline,
    minElevation,
    maxElevation,
    meanElevation,
    waterLevel,
    sample,
    heightAt,
    heightAtGeo(lat, lng) {
      const local = projection.toLocal(lat, lng);
      return heightAt(local.x, local.z);
    },
  };
}

function boundsCenter(points) {
  let minLat = Infinity; let maxLat = -Infinity; let minLng = Infinity; let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

// Route segments bucketed into a uniform grid so a height query only visits
// the segments within the influence radius.
function buildSegmentIndex(samples, cellSize) {
  const count = Math.max(0, samples.length - 1);
  const ax = new Float64Array(count); const az = new Float64Array(count);
  const bx = new Float64Array(count); const bz = new Float64Array(count);
  const ea = new Float64Array(count); const eb = new Float64Array(count);
  const cells = new Map();
  for (let i = 0; i < count; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    ax[i] = a.x; az[i] = a.z; bx[i] = b.x; bz[i] = b.z; ea[i] = a.e; eb[i] = b.e;
    const ci = Math.floor((a.x + b.x) / 2 / cellSize);
    const cj = Math.floor((a.z + b.z) / 2 / cellSize);
    const key = cellKey(ci, cj);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }
  const result = { minDistance: Infinity, nearestElevation: 0, sumWeight: 0, sumWeightedElevation: 0 };

  return {
    query(x, z, radius, halfWidth, power) {
      result.minDistance = Infinity;
      result.sumWeight = 0;
      result.sumWeightedElevation = 0;
      if (!count) return result;
      const ci = Math.floor(x / cellSize);
      const cj = Math.floor(z / cellSize);
      // Segments are bucketed by midpoint; a segment is far shorter than a
      // cell, so the 3×3 neighborhood covers everything within `radius`.
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const list = cells.get(cellKey(ci + di, cj + dj));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k];
            const sx = bx[i] - ax[i];
            const sz = bz[i] - az[i];
            const lengthSq = sx * sx + sz * sz;
            let t = lengthSq > 0 ? ((x - ax[i]) * sx + (z - az[i]) * sz) / lengthSq : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = x - (ax[i] + sx * t);
            const dz = z - (az[i] + sz * t);
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d >= radius) continue;
            const elevation = ea[i] + (eb[i] - ea[i]) * t;
            if (d < result.minDistance) {
              result.minDistance = d;
              result.nearestElevation = elevation;
            }
            const taper = (1 - d / radius) * (1 - d / radius);
            const w = taper / Math.pow(Math.max(0, d - halfWidth) + 1, power);
            result.sumWeight += w;
            result.sumWeightedElevation += w * elevation;
          }
        }
      }
      return result;
    },
  };
}

function cellKey(i, j) {
  return i * 73856093 ^ j * 19349663;
}

// Coarse raster of the Gaussian-smoothed route elevation (`mean`), its local
// spread (`spread` — how hilly the route is around there) and the distance to
// the nearest route sample (`distance`), bilinearly sampled.
function buildRegionalRaster(samples, bounds, config, meanElevation) {
  const n = config.regional_cells;
  const sigma = config.regional_sigma_meters;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const mean = new Float32Array(n * n);
  const spread = new Float32Array(n * n);
  const distance = new Float32Array(n * n);

  // Thin the samples to ~sigma/4 spacing; the raster is smooth anyway.
  const step = Math.max(1, Math.round(sigma / 4 / Math.max(1, config.resample_meters)));
  const thin = samples.filter((_, i) => i % step === 0);
  let globalSq = 0;
  for (const s of thin) globalSq += (s.e - meanElevation) ** 2;
  const globalSpread = thin.length ? Math.sqrt(globalSq / thin.length) : config.relief.min_amplitude_meters;
  const fallbackWeight = 1e-3;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = bounds.minX + (i / (n - 1)) * width;
      const z = bounds.minZ + (j / (n - 1)) * depth;
      let sw = fallbackWeight;
      let swe = fallbackWeight * meanElevation;
      let swe2 = fallbackWeight * (meanElevation * meanElevation + globalSpread * globalSpread);
      let nearest = Infinity;
      for (const s of thin) {
        const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d2 < nearest) nearest = d2;
        const w = Math.exp(-d2 / (2 * sigma * sigma));
        sw += w;
        swe += w * s.e;
        swe2 += w * s.e * s.e;
      }
      const m = swe / sw;
      mean[j * n + i] = m;
      spread[j * n + i] = Math.sqrt(Math.max(0, swe2 / sw - m * m));
      distance[j * n + i] = thin.length ? Math.sqrt(nearest) : 1e9;
    }
  }

  const out = { mean: meanElevation, spread: globalSpread, distance: 1e9 };
  return {
    at(x, z) {
      const fx = Math.min(n - 1, Math.max(0, ((x - bounds.minX) / width) * (n - 1)));
      const fz = Math.min(n - 1, Math.max(0, ((z - bounds.minZ) / depth) * (n - 1)));
      const i0 = Math.min(n - 2, Math.floor(fx));
      const j0 = Math.min(n - 2, Math.floor(fz));
      const tx = fx - i0;
      const tz = fz - j0;
      const bilinear = (grid) => {
        const a = grid[j0 * n + i0];
        const b = grid[j0 * n + i0 + 1];
        const c = grid[(j0 + 1) * n + i0];
        const d = grid[(j0 + 1) * n + i0 + 1];
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
      };
      out.mean = bilinear(mean);
      out.spread = bilinear(spread);
      // Outside the raster the nearest-sample distance keeps growing.
      const outside = Math.hypot(
        Math.max(0, bounds.minX - x, x - bounds.maxX),
        Math.max(0, bounds.minZ - z, z - bounds.maxZ),
      );
      out.distance = bilinear(distance) + outside;
      return out;
    },
  };
}
