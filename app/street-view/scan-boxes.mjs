// Where to look for street imagery along a route: the cells of a fixed global
// lon/lat grid the route passes through (plus a margin, so an image just
// across a cell edge is still found), ordered so the cells ahead of the rider
// are fetched first, and quadrant subdivision for cells a source reports as
// truncated. Pure: no DOM, no app state, no network. Cell keys are stable
// across routes and sessions, so a source can cache responses per cell.
// Also the two Graph API entity → app shape mappings (search candidate, and
// the per-image metadata the renderer needs).
//
// Expects an enriched route (points carry `distance`, see route.mjs).

export function routeScanCells(route, { cellSizeDegrees, marginDegrees = 0, startMeters = 0 }) {
  if (!route?.length || !(cellSizeDegrees > 0)) return [];
  const size = cellSizeDegrees;
  const total = route.at(-1).distance ?? 0;
  const cells = new Map();

  for (const point of route) {
    const x0 = Math.floor((point.lng - marginDegrees) / size);
    const x1 = Math.floor((point.lng + marginDegrees) / size);
    const y0 = Math.floor((point.lat - marginDegrees) / size);
    const y1 = Math.floor((point.lat + marginDegrees) / size);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        const cell = cells.get(key);
        if (cell) {
          cell.entryMeters = Math.min(cell.entryMeters, point.distance);
          cell.exitMeters = Math.max(cell.exitMeters, point.distance);
        } else {
          cells.set(key, {
            key,
            minLon: x * size,
            minLat: y * size,
            maxLon: (x + 1) * size,
            maxLat: (y + 1) * size,
            entryMeters: point.distance,
            exitMeters: point.distance,
            depth: 0,
          });
        }
      }
    }
  }

  // Lookahead-first: the cell under the rider, then the cells ahead in route
  // order, then the cells behind (so a mid-route start still gets imagery
  // for the road ahead before the rest of the route fills in).
  const order = (cell) => {
    if (cell.entryMeters <= startMeters && startMeters <= cell.exitMeters) return 0;
    if (cell.entryMeters > startMeters) return cell.entryMeters - startMeters;
    return total - startMeters + cell.entryMeters;
  };
  return [...cells.values()].sort((a, b) => order(a) - order(b));
}

// Four equal quadrants of a cell, one level deeper. Used when a source hits
// its result cap for a cell (dense cities) and needs a finer search.
export function subdivideCell(cell) {
  const midLon = (cell.minLon + cell.maxLon) / 2;
  const midLat = (cell.minLat + cell.maxLat) / 2;
  const quadrant = (index, minLon, minLat, maxLon, maxLat) => ({
    ...cell,
    key: `${cell.key}/${index}`,
    minLon,
    minLat,
    maxLon,
    maxLat,
    depth: cell.depth + 1,
  });
  return [
    quadrant(0, cell.minLon, cell.minLat, midLon, midLat),
    quadrant(1, midLon, cell.minLat, cell.maxLon, midLat),
    quadrant(2, cell.minLon, midLat, midLon, cell.maxLat),
    quadrant(3, midLon, midLat, cell.maxLon, cell.maxLat),
  ];
}

// One Mapillary Graph API image entity → the provider-agnostic candidate
// shape frame-index.mjs consumes. Returns null for entities without a usable
// id or position. The SfM-refined heading is preferred over the raw compass.
export function candidateFromMapillaryImage(image) {
  const coordinates = image?.geometry?.coordinates;
  const lng = Number(coordinates?.[0]);
  const lat = Number(coordinates?.[1]);
  if (image?.id == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const heading = Number(image.computed_compass_angle ?? image.compass_angle);
  const capturedAt = Number(image.captured_at);
  return {
    lat,
    lng,
    headingDeg: Number.isFinite(heading) ? heading : null,
    isPano: Boolean(image.is_pano),
    sequenceId: image.sequence ?? null,
    capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : null,
    creator: image.creator?.username ?? null,
    ref: String(image.id),
  };
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// One Graph API image entity (fetched with the renderer's metadata fields) →
// the normalized per-image metadata the playback plan and renderer consume
// (sfm-camera.mjs builds the camera transform from it). Positions prefer
// the SfM-computed ones; the originals are kept for the parallax pair test.
// The thumbnail URL is picked by camera type (2048 px for 360° images, which
// are spread over a full sphere; 1024 px otherwise). Returns null without an
// id or position.
export function imageMetadataFromMapillaryImage(image, { thumbSizePerspective = 1024, thumbSizeSpherical = 2048 } = {}) {
  if (image?.id == null) return null;
  const original = image.geometry?.coordinates;
  const computed = image.computed_geometry?.coordinates;
  const lat = finiteOrNull(computed?.[1]) ?? finiteOrNull(original?.[1]);
  const lng = finiteOrNull(computed?.[0]) ?? finiteOrNull(original?.[0]);
  if (lat == null || lng == null) return null;
  const rawType = image.camera_type;
  const cameraType = rawType === "spherical" || rawType === "equirectangular"
    ? "spherical"
    : rawType === "fisheye" ? "fisheye" : "perspective";
  const size = cameraType === "spherical" ? thumbSizeSpherical : thumbSizePerspective;
  const rotation = Array.isArray(image.computed_rotation) && image.computed_rotation.length === 3
    ? image.computed_rotation.map(Number)
    : null;
  const capturedAt = finiteOrNull(image.captured_at);
  return {
    id: String(image.id),
    lat,
    lng,
    originalLat: finiteOrNull(original?.[1]),
    originalLng: finiteOrNull(original?.[0]),
    altitude: finiteOrNull(image.computed_altitude),
    rotation: rotation && rotation.every(Number.isFinite) ? rotation : null,
    cameraParameters: Array.isArray(image.camera_parameters) ? image.camera_parameters.map(Number) : null,
    cameraType,
    scale: finiteOrNull(image.atomic_scale),
    mergeId: image.merge_cc != null ? String(image.merge_cc) : null,
    meshUrl: image.mesh?.url ?? null,
    thumbUrl: image[`thumb_${size}_url`] ?? image.thumb_1024_url ?? image.thumb_2048_url ?? null,
    width: finiteOrNull(image.width),
    height: finiteOrNull(image.height),
    orientation: finiteOrNull(image.exif_orientation) ?? 1,
    quality: finiteOrNull(image.quality_score),
    sequenceId: image.sequence ?? null,
    capturedAt: capturedAt != null && capturedAt > 0 ? capturedAt : null,
    creator: image.creator?.username ?? null,
    compassDeg: finiteOrNull(image.computed_compass_angle) ?? finiteOrNull(image.compass_angle),
  };
}
