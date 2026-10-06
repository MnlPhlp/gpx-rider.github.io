import assert from "node:assert/strict";
import test from "node:test";

import { enrichRoute } from "../app/route/route.mjs";
import {
  StreetImageryTokenError,
  clearMapillaryCellCache,
  createMapillarySource,
} from "../app/street-view/mapillary-source.mjs";

const config = {
  graph_base_url: "https://graph.example",
  image_fields: ["id", "geometry"],
  request_limit: 3,
  subdivide_max_depth: 1,
  cell_size_degrees: 0.005,
  cell_margin_degrees: 0,
  scan_concurrency: 2,
  max_candidates: 1000,
  attribution: "test",
};

// Two cells' worth of route.
const route = enrichRoute([
  { lat: 50.0013, lng: 14.4013, ele: 0 },
  { lat: 50.0063, lng: 14.4013, ele: 0 },
]);

function image(id, lng = 14.4013, lat = 50.0013) {
  return { id, geometry: { coordinates: [lng, lat] }, compass_angle: 0 };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("scanRoute fetches each cell once, reports progress and delivers deduplicated candidates", async () => {
  clearMapillaryCellCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse({ data: [image("a"), image("b")] });
  };
  const source = createMapillarySource({ token: "MLY|x", config, fetchImpl });
  const delivered = [];
  const progress = [];
  await source.scanRoute(route, {
    onCandidates: (candidates) => delivered.push(...candidates),
    onProgress: (p) => progress.push({ ...p }),
  });
  assert.equal(urls.length, 2, "one request per cell");
  assert.ok(urls[0].includes("access_token=MLY%7Cx") && urls[0].includes("bbox="));
  assert.deepEqual(delivered.map((c) => c.ref), ["a", "b"], "the same ids in the second cell are not delivered twice");
  assert.deepEqual(progress.at(-1), { done: 2, total: 2 });
});

test("scanRoute subdivides a cell that hits the result cap", async () => {
  clearMapillaryCellCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const bbox = new URL(url).searchParams.get("bbox").split(",").map(Number);
    const width = bbox[2] - bbox[0];
    // Full-size cells come back capped; quadrants return one image each.
    if (width > 0.004) return jsonResponse({ data: [image("x1"), image("x2"), image("x3")] });
    return jsonResponse({ data: [image(`q-${bbox[0].toFixed(4)}-${bbox[1].toFixed(4)}`)] });
  };
  const source = createMapillarySource({ token: "t", config, fetchImpl });
  const delivered = [];
  await source.scanRoute(route, { onCandidates: (c) => delivered.push(...c) });
  // 2 cells + 4 quadrants each = 10 requests; depth limit 1 stops further splitting.
  assert.equal(calls, 10);
  assert.equal(delivered.filter((c) => c.ref.startsWith("q-")).length, 8);
});

test("scanRoute stops when aborted", async () => {
  clearMapillaryCellCache();
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const source = createMapillarySource({ token: "t", config: { ...config, scan_concurrency: 1 }, fetchImpl });
  await source.scanRoute(route, { signal: controller.signal });
  assert.equal(calls, 1);
});

test("scanRoute surfaces a rejected token as a typed error", async () => {
  clearMapillaryCellCache();
  const fetchImpl = async () => jsonResponse({ error: { message: "Invalid OAuth 2.0 Access Token", code: 190 } }, 400);
  const source = createMapillarySource({ token: "bad", config, fetchImpl });
  await assert.rejects(source.scanRoute(route, {}), (error) => {
    assert.ok(error instanceof StreetImageryTokenError);
    assert.equal(error.code, "token");
    return true;
  });
});

test("scanRoute skips a failing cell and keeps going", async () => {
  clearMapillaryCellCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, 500);
    return jsonResponse({ data: [image("ok")] });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const source = createMapillarySource({ token: "t", config: { ...config, scan_concurrency: 1 }, fetchImpl });
    const delivered = [];
    await source.scanRoute(route, { onCandidates: (c) => delivered.push(...c) });
    assert.deepEqual(delivered.map((c) => c.ref), ["ok"]);
  } finally {
    console.warn = warn;
  }
});
