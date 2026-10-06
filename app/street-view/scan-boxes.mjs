// Where to look for street imagery along a route: the cells of a fixed global
// lon/lat grid the route passes through (plus a margin, so an image just
// across a cell edge is still found), ordered so the cells ahead of the rider
// are fetched first, and quadrant subdivision for cells a source reports as
// truncated. Pure: no DOM, no app state, no network. Cell keys are stable
// across routes and sessions, so a source can cache responses per cell.
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
