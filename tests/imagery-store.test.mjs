import assert from "node:assert/strict";
import test from "node:test";

import { createImageryStore } from "../app/street-view/imagery-store.mjs";
import { StreetImageryTokenError } from "../app/street-view/mapillary-source.mjs";

const config = {
  graph_base_url: "https://graph.example",
  renderer: {
    metadata_fields: ["id", "geometry", "mesh", "thumb_1024_url"],
    metadata_batch_size: 2,
    thumb_size_perspective: 1024,
    thumb_size_spherical: 2048,
    cache_max_bytes: 100,
  },
};

function memoryDb() {
  const stores = new Map([["plans", new Map()], ["assets", new Map()], ["assetIndex", new Map()]]);
  return {
    stores,
    get: async (store, key) => stores.get(store).get(key),
    put: async (store, key, value) => { stores.get(store).set(key, value); },
    delete: async (store, key) => { stores.get(store).delete(key); },
    getAll: async (store) => [...stores.get(store).values()],
    clear: async (store) => { stores.get(store).clear(); },
  };
}

function entity(id, overrides = {}) {
  return {
    id,
    geometry: { coordinates: [14.4, 50.0] },
    computed_rotation: [0, 0, 0],
    computed_altitude: 100,
    merge_cc: 7,
    mesh: { id: `m${id}`, url: `https://cdn/mesh/${id}?sig=1` },
    thumb_1024_url: `https://cdn/thumb/${id}?sig=1`,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function bytesResponse(size, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new ArrayBuffer(size),
    blob: async () => new Blob([new Uint8Array(size)]),
  };
}

test("fetchMetadata batches ids, normalizes entities and remembers them for the session", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const ids = new URL(url).searchParams.get("image_ids").split(",");
    return jsonResponse({ data: ids.map((id) => entity(id)) });
  };
  const store = createImageryStore({ token: "MLY|t", config, fetchImpl, db: null });
  const metas = await store.fetchMetadata(["1", "2", "3"]);
  assert.equal(urls.length, 2, "batches of two");
  assert.ok(urls[0].includes("image_ids=1%2C2") && urls[0].includes("fields=id%2Cgeometry"));
  assert.equal(metas.get("3").thumbUrl, "https://cdn/thumb/3?sig=1");
  assert.equal(metas.get("1").mergeId, "7");
  await store.fetchMetadata(["1", "3"]);
  assert.equal(urls.length, 2, "nothing refetched");
  assert.equal(store.metadata("2").id, "2");
});

test("fetchMetadata surfaces a rejected token", async () => {
  const fetchImpl = async () => jsonResponse({ error: { code: 190, message: "bad" } }, 400);
  const store = createImageryStore({ token: "bad", config, fetchImpl, db: null });
  await assert.rejects(store.fetchMetadata(["1"]), (error) => error instanceof StreetImageryTokenError);
});

test("fetchMetadata bisects a failing batch so one unavailable image is skipped", async () => {
  const batches = [];
  const fetchImpl = async (url) => {
    const ids = new URL(url).searchParams.get("image_ids").split(",");
    batches.push(ids.join(","));
    if (ids.includes("bad")) return jsonResponse({}, 500);
    return jsonResponse({ data: ids.map((id) => entity(id)) });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const store = createImageryStore({ token: "t", config: { ...config, renderer: { ...config.renderer, metadata_batch_size: 4 } }, fetchImpl, db: null });
    const metas = await store.fetchMetadata(["1", "bad", "3", "4", "5"]);
    assert.deepEqual([...metas.keys()].sort(), ["1", "3", "4", "5"]);
    assert.deepEqual(batches, ["1,bad,3,4", "1,bad", "1", "bad", "3,4", "5"]);
    await store.fetchMetadata(["bad", "6"]);
    assert.deepEqual(batches.slice(6), ["6"], "an unavailable id is not asked for again");
  } finally {
    console.warn = warn;
  }
});

test("loadMesh/loadPhoto fetch bytes once, serve repeats from the cache and skip unmerged images", async () => {
  const db = memoryDb();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/images?")) return jsonResponse({ data: [entity("1"), entity("2", { merge_cc: null })] });
    return bytesResponse(10);
  };
  const store = createImageryStore({ token: "t", config, fetchImpl, db });
  const metas = await store.fetchMetadata(["1", "2"]);
  const mesh = await store.loadMesh(metas.get("1"));
  assert.equal(mesh.byteLength, 10);
  const photo = await store.loadPhoto(metas.get("1"));
  assert.equal(photo.size, 10);
  assert.equal(calls.length, 3);

  // A second store instance (new session) finds both in the database.
  const again = createImageryStore({ token: "t", config, fetchImpl, db });
  assert.equal((await again.loadMesh(metas.get("1"))).byteLength, 10);
  assert.equal((await again.loadPhoto(metas.get("1"))).size, 10);
  assert.equal(calls.length, 3, "served from the cache");
  assert.deepEqual(await again.cacheStats(), { bytes: 20, count: 2 });

  assert.equal(await store.loadMesh(metas.get("2")), null, "not merged: no mesh request");
  assert.equal(calls.length, 3);
});

test("an expired signed URL refreshes the metadata once and retries", async () => {
  const calls = [];
  let thumbVersion = 1;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/images?")) return jsonResponse({ data: [entity("1", { thumb_1024_url: `https://cdn/thumb/1?sig=${thumbVersion}` })] });
    if (url.endsWith("sig=1")) return bytesResponse(0, 403);
    return bytesResponse(5);
  };
  const store = createImageryStore({ token: "t", config, fetchImpl, db: null });
  const metas = await store.fetchMetadata(["1"]);
  thumbVersion = 2;
  const photo = await store.loadPhoto(metas.get("1"));
  assert.equal(photo.size, 5);
  assert.deepEqual(calls.map((url) => url.split("?")[0]), [
    "https://graph.example/images",
    "https://cdn/thumb/1",
    "https://graph.example/images",
    "https://cdn/thumb/1",
  ]);
  assert.equal(store.metadata("1").thumbUrl, "https://cdn/thumb/1?sig=2");
});

test("the cache evicts least-recently-used assets over the byte limit", async () => {
  const db = memoryDb();
  let clock = 1000;
  const fetchImpl = async (url) => (url.includes("/images?")
    ? jsonResponse({ data: ["1", "2", "3"].map((id) => entity(id)) })
    : bytesResponse(40));
  const store = createImageryStore({ token: "t", config, fetchImpl, db, now: () => (clock += 1) });
  const metas = await store.fetchMetadata(["1", "2", "3"]);
  await store.loadPhoto(metas.get("1"));
  await store.loadPhoto(metas.get("2"));
  await store.loadPhoto(metas.get("1"), {}); // touch 1 so 2 is the oldest
  await store.loadPhoto(metas.get("3"));
  assert.deepEqual([...db.stores.get("assets").keys()].sort(), ["photo:1", "photo:3"], "120 bytes > 100: the oldest (2) goes");
  assert.deepEqual(await store.cacheStats(), { bytes: 80, count: 2 });
  await store.clearCache();
  assert.deepEqual(await store.cacheStats(), { bytes: 0, count: 0 });
  assert.equal(db.stores.get("assets").size, 0);
});

test("plans round-trip through the database by key", async () => {
  const db = memoryDb();
  const store = createImageryStore({ token: "t", config, fetchImpl: async () => jsonResponse({ data: [] }), db });
  assert.equal(await store.loadPlan("k"), null);
  await store.savePlan("k", { nodes: [{ ref: "1" }], links: [] });
  assert.deepEqual(await store.loadPlan("k"), { nodes: [{ ref: "1" }], links: [] });
  store.adoptMetadata([{ id: "9", thumbUrl: "u" }]);
  assert.equal(store.metadata("9").thumbUrl, "u");
});

test("aborting stops metadata batches", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    controller.abort();
    return jsonResponse({ data: [entity("1"), entity("2")] });
  };
  const store = createImageryStore({ token: "t", config, fetchImpl, db: null });
  await assert.rejects(store.fetchMetadata(["1", "2", "3", "4"], { signal: controller.signal }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});
