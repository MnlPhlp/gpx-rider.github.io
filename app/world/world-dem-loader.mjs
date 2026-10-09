// Fetches and decodes Mapzen Terrarium elevation tiles inside the tile worker
// (fetch → createImageBitmap → OffscreenCanvas pixels → meters), for the
// virtual world's real-world style. The same public, keyless AWS Open Data
// tiles the online-terrain camera feature uses (map/terrain-tiles.mjs). A
// tile that fails to load resolves to null; the height field then falls back
// to the route-only synthesis there.

import { decodeTerrarium } from "../map/terrain-tiles-math.mjs";

export async function loadDemTiles(tiles, { baseUrl, concurrency = 8 }) {
  const results = new Array(tiles.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < tiles.length) {
      const index = next++;
      results[index] = await loadTile(tiles[index], baseUrl);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  return results;
}

async function loadTile(tile, baseUrl) {
  try {
    const response = await fetch(`${baseUrl}${tile.z}/${tile.x}/${tile.y}.png`, { mode: "cors" });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    // Read the size before close(): a closed bitmap reports 0 × 0.
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = context.getImageData(0, 0, width, height);
    const elevations = new Float32Array(width * height);
    for (let i = 0; i < elevations.length; i++) {
      elevations[i] = decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    return { ...tile, size: width, data: elevations };
  } catch (error) {
    console.warn("[virtual-world] elevation tile failed", tile, error);
    return null;
  }
}
