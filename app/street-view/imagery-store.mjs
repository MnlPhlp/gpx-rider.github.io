// Data access for the street imagery renderer: per-image metadata (SfM pose,
// camera model, mesh and thumbnail URLs) from the Mapillary Graph API in
// batches, the mesh and photo bytes behind those URLs, and a bounded
// IndexedDB cache of all of it — plans by route key, bytes by image — so a
// route ridden before loads without touching the network again. Thumbnail
// and mesh URLs are signed and expire, so bytes are cached, never URLs; a
// rejected URL refetches that image's metadata once and retries. Eviction is
// least-recently-used over `cache_max_bytes`. IO only: no DOM, no app state;
// the token, config, fetch and database adapter are injected (tests pass an
// in-memory adapter and a fake fetch).
//
// Database adapter contract (openImageryDatabase() provides the IndexedDB
// one): { get(store, key), put(store, key, value), delete(store, key),
//         getAll(store), clear(store) } — all returning promises.

import { StreetImageryTokenError } from "./mapillary-source.mjs";
import { imageMetadataFromMapillaryImage } from "./scan-boxes.mjs";

const DB_NAME = "gpx-rider-imagery";
const DB_VERSION = 1;
const STORES = ["plans", "assets", "assetIndex"];

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openImageryDatabase() {
  if (typeof indexedDB === "undefined") return null;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab."));
  });
  const run = (store, mode, operation) => new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
  return {
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
    delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
    getAll: (store) => run(store, "readonly", (s) => s.getAll()),
    clear: (store) => run(store, "readwrite", (s) => s.clear()),
  };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function createImageryStore({ token, config, fetchImpl = globalThis.fetch?.bind(globalThis), db = null, now = Date.now }) {
  const rendererConfig = config.renderer;
  const metaById = new Map();
  // Ids the API refused this session (deleted, private, broken): skipped
  // instead of being re-requested by every plan rebuild.
  const unavailableIds = new Set();
  const pendingAssets = new Map();
  // key → { key, size, lastUsed }; loaded from the database once.
  const assetIndex = new Map();
  let indexLoaded = null;

  async function ensureIndex() {
    if (!db) return;
    if (!indexLoaded) {
      indexLoaded = db.getAll("assetIndex").then((entries) => {
        for (const entry of entries ?? []) if (entry?.key) assetIndex.set(entry.key, entry);
      }).catch((error) => {
        console.warn("[street-imagery] cache index unreadable", error);
      });
    }
    await indexLoaded;
  }

  async function fetchBatch(ids, signal) {
    const url = new URL("/images", config.graph_base_url);
    url.searchParams.set("access_token", token);
    url.searchParams.set("image_ids", ids.join(","));
    url.searchParams.set("fields", rendererConfig.metadata_fields.join(","));
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
    if (!response.ok) throw new Error(`Mapillary responded ${response.status} for image metadata`);
    const result = new Map();
    for (const item of Array.isArray(body?.data) ? body.data : []) {
      const meta = imageMetadataFromMapillaryImage(item, {
        thumbSizePerspective: rendererConfig.thumb_size_perspective,
        thumbSizeSpherical: rendererConfig.thumb_size_spherical,
      });
      if (!meta) continue;
      meta.fetchedAt = now();
      result.set(meta.id, meta);
      metaById.set(meta.id, meta);
    }
    return result;
  }

  // The Graph API answers a whole batch with an error when one id in it is
  // unavailable (deleted, private, broken): bisect so one bad image costs
  // a few extra requests instead of the whole plan. Token errors propagate.
  async function fetchBatchResilient(ids, signal) {
    try {
      return await fetchBatch(ids, signal);
    } catch (error) {
      if (error instanceof StreetImageryTokenError || error?.name === "AbortError" || signal?.aborted) throw error;
      if (ids.length === 1) {
        console.warn("[street-imagery] image metadata unavailable, skipping", ids[0], error);
        unavailableIds.add(ids[0]);
        return new Map();
      }
      const half = Math.ceil(ids.length / 2);
      const left = await fetchBatchResilient(ids.slice(0, half), signal);
      const right = await fetchBatchResilient(ids.slice(half), signal);
      return new Map([...left, ...right]);
    }
  }

  async function fetchBytes(url, kind, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      const error = new Error(`Asset request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return kind === "mesh" ? response.arrayBuffer() : response.blob();
  }

  async function remember(key, bytes) {
    if (!db) return;
    const size = bytes.byteLength ?? bytes.size ?? 0;
    const entry = { key, size, lastUsed: now() };
    try {
      await db.put("assets", key, bytes);
      await db.put("assetIndex", key, entry);
      assetIndex.set(key, entry);
      await enforceLimit();
    } catch (error) {
      console.warn("[street-imagery] could not cache asset", key, error);
    }
  }

  async function recall(key) {
    if (!db) return null;
    await ensureIndex();
    const entry = assetIndex.get(key);
    if (!entry) return null;
    try {
      const bytes = await db.get("assets", key);
      if (bytes == null) {
        assetIndex.delete(key);
        return null;
      }
      entry.lastUsed = now();
      db.put("assetIndex", key, entry).catch(() => {});
      return bytes;
    } catch {
      return null;
    }
  }

  async function enforceLimit() {
    const limit = rendererConfig.cache_max_bytes;
    let total = 0;
    for (const entry of assetIndex.values()) total += entry.size;
    if (total <= limit) return;
    const oldestFirst = [...assetIndex.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of oldestFirst) {
      if (total <= limit) break;
      assetIndex.delete(entry.key);
      total -= entry.size;
      await db.delete("assets", entry.key);
      await db.delete("assetIndex", entry.key);
    }
  }

  // Load an asset: cache → network (with one metadata refresh when the
  // signed URL has expired).
  async function loadAsset(meta, kind, signal) {
    const key = `${kind}:${meta.id}`;
    if (pendingAssets.has(key)) return pendingAssets.get(key);
    const work = (async () => {
      const cached = await recall(key);
      if (cached) return cached;
      if (signal?.aborted) throw abortError();
      let current = metaById.get(meta.id) ?? meta;
      let url = kind === "mesh" ? current.meshUrl : current.thumbUrl;
      if (!url) return null;
      let bytes;
      try {
        bytes = await fetchBytes(url, kind, signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        if (error?.status !== 403 && error?.status !== 400) throw error;
        // Expired signed URL: refresh the metadata once and retry.
        const refreshed = await fetchBatch([meta.id], signal);
        current = refreshed.get(meta.id);
        url = kind === "mesh" ? current?.meshUrl : current?.thumbUrl;
        if (!url) return null;
        bytes = await fetchBytes(url, kind, signal);
      }
      await remember(key, bytes);
      return bytes;
    })().finally(() => pendingAssets.delete(key));
    pendingAssets.set(key, work);
    return work;
  }

  return {
    // Metadata for the given image ids (Map id → normalized meta), fetching
    // what the session has not seen yet in batches.
    async fetchMetadata(ids, { signal } = {}) {
      const result = new Map();
      const missing = [];
      for (const id of ids) {
        const cached = metaById.get(id);
        if (cached) result.set(id, cached);
        else if (!unavailableIds.has(id)) missing.push(id);
      }
      const batchSize = Math.max(1, rendererConfig.metadata_batch_size | 0);
      for (let i = 0; i < missing.length; i += batchSize) {
        if (signal?.aborted) throw abortError();
        const batch = await fetchBatchResilient(missing.slice(i, i + batchSize), signal);
        for (const [id, meta] of batch) result.set(id, meta);
      }
      return result;
    },

    // Metadata the renderer may already hold for an id.
    metadata(id) {
      return metaById.get(id) ?? null;
    },

    // Adopt metadata restored from a cached plan (no network).
    adoptMetadata(metas) {
      for (const meta of metas) if (meta?.id && !metaById.has(meta.id)) metaById.set(meta.id, meta);
    },

    // Mesh bytes (ArrayBuffer) or null when the image has no mesh / is not
    // merged into a reconstruction / the mesh cannot be fetched.
    async loadMesh(meta, { signal } = {}) {
      if (meta.mergeId == null || !meta.meshUrl) return null;
      try {
        return await loadAsset(meta, "mesh", signal);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn("[street-imagery] mesh unavailable", meta.id, error);
        return null;
      }
    },

    // Photo bytes (Blob).
    loadPhoto(meta, { signal } = {}) {
      return loadAsset(meta, "photo", signal);
    },

    async loadPlan(key) {
      if (!db || !key) return null;
      try {
        return (await db.get("plans", key)) ?? null;
      } catch {
        return null;
      }
    },

    async savePlan(key, plan) {
      if (!db || !key) return;
      try {
        await db.put("plans", key, plan);
      } catch (error) {
        console.warn("[street-imagery] could not cache plan", error);
      }
    },

    async cacheStats() {
      await ensureIndex();
      let bytes = 0;
      for (const entry of assetIndex.values()) bytes += entry.size;
      return { bytes, count: assetIndex.size };
    },

    async clearCache() {
      metaById.clear();
      assetIndex.clear();
      if (!db) return;
      for (const store of STORES) await db.clear(store);
    },
  };
}
