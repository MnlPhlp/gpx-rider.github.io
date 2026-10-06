// Mapillary image source for the street imagery feature: scans the grid cells
// along a route through the Graph API and reports candidate frames. This is
// the *source* half of the provider contract the coordinator
// (street-view-ui.mjs) talks to, so another provider — including a future
// "replay my own ride video" source that maps a timestamped track onto the
// route without any network — implements the same shape:
//
//   source: { id, attribution,
//             scanRoute(route, { signal, startMeters, onCandidates(candidates), onProgress({ done, total }) }) → Promise<void> }
//
// IO only: no DOM, no app state — the token and the street_imagery config are
// passed in. Responses are cached per grid cell for the session (cell keys
// are global, see scan-boxes.mjs), so re-enabling the feature or reloading a
// route in the same area is instant. A cell that comes back with the API's
// result cap is treated as truncated and split into quadrants.

import { candidateFromMapillaryImage, routeScanCells, subdivideCell } from "./scan-boxes.mjs";

const cellCache = new Map();

export class StreetImageryTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "StreetImageryTokenError";
    this.code = "token";
  }
}

// For tests and for forgetting results fetched with a different token.
export function clearMapillaryCellCache() {
  cellCache.clear();
}

export function createMapillarySource({ token, config, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  async function fetchCell(cell, signal) {
    const cached = cellCache.get(cell.key);
    if (cached) return cached;

    const url = new URL("/images", config.graph_base_url);
    url.searchParams.set("access_token", token);
    url.searchParams.set("fields", config.image_fields.join(","));
    url.searchParams.set("limit", String(config.request_limit));
    url.searchParams.set("bbox", [cell.minLon, cell.minLat, cell.maxLon, cell.maxLat].map((v) => v.toFixed(6)).join(","));

    const response = await fetchImpl(url.toString(), { signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 401 || response.status === 403 || body?.error?.code === 190) {
      throw new StreetImageryTokenError(body?.error?.message || `Mapillary rejected the token (${response.status})`);
    }
    if (!response.ok) throw new Error(`Mapillary responded ${response.status} for cell ${cell.key}`);

    const data = Array.isArray(body?.data) ? body.data : [];
    const result = {
      candidates: data.map(candidateFromMapillaryImage).filter(Boolean),
      truncated: data.length >= config.request_limit,
    };
    cellCache.set(cell.key, result);
    return result;
  }

  return {
    id: "mapillary",
    attribution: config.attribution,

    async scanRoute(route, { signal, startMeters = 0, onCandidates, onProgress } = {}) {
      const queue = routeScanCells(route, {
        cellSizeDegrees: config.cell_size_degrees,
        marginDegrees: config.cell_margin_degrees,
        startMeters,
      });
      let total = queue.length;
      let done = 0;
      let delivered = 0;
      let warned = false;
      const seen = new Set();
      const report = () => onProgress?.({ done, total });
      report();

      const worker = async () => {
        while (queue.length) {
          if (signal?.aborted) return;
          if (delivered >= config.max_candidates) {
            queue.length = 0;
            return;
          }
          const cell = queue.shift();
          let result;
          try {
            result = await fetchCell(cell, signal);
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return;
            if (error instanceof StreetImageryTokenError) {
              queue.length = 0;
              throw error;
            }
            if (!warned) {
              console.warn("[street-imagery] cell request failed, skipping", cell.key, error);
              warned = true;
            }
            done += 1;
            report();
            continue;
          }
          if (result.truncated && cell.depth < config.subdivide_max_depth) {
            const parts = subdivideCell(cell);
            queue.unshift(...parts);
            total += parts.length;
          }
          const fresh = result.candidates.filter((candidate) => !seen.has(candidate.ref));
          for (const candidate of fresh) seen.add(candidate.ref);
          delivered += fresh.length;
          if (fresh.length) onCandidates?.(fresh);
          done += 1;
          report();
        }
      };

      const workers = Array.from({ length: Math.max(1, config.scan_concurrency | 0) }, worker);
      await Promise.all(workers);
    },
  };
}
