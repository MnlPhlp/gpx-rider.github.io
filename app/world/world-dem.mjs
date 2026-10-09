// Real ground elevation for the virtual world's real-world style: which
// Mapzen Terrarium tiles cover the world (picking the finest zoom that stays
// under a tile budget), and bilinear elevation sampling across decoded tiles,
// seamless over tile borders. Pure — the tile worker fetches and decodes the
// PNGs (world-dem-loader.mjs) and hands the grids to createDem.

// Fractional Web Mercator pixel coordinates of a point at a zoom level
// (the same projection as map/terrain-tiles-math.mjs#tileForLngLat).
export function globalPixel(lat, lng, zoom, tileSize) {
  const scale = 2 ** zoom * tileSize;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clamped * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
  };
}

// The tiles covering a lat/lng box, at the finest zoom ≤ maxZoom whose tile
// count fits within maxTiles.
export function demTilesForBox({ south, west, north, east }, { maxZoom, maxTiles, tileSize }) {
  for (let zoom = maxZoom; zoom >= 0; zoom--) {
    const nw = globalPixel(north, west, zoom, tileSize);
    const se = globalPixel(south, east, zoom, tileSize);
    const x0 = Math.floor(nw.x / tileSize);
    const x1 = Math.floor(se.x / tileSize);
    const y0 = Math.floor(nw.y / tileSize);
    const y1 = Math.floor(se.y / tileSize);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count > maxTiles && zoom > 0) continue;
    const tiles = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) tiles.push({ z: zoom, x, y });
    }
    return tiles;
  }
  return [];
}

// Decoded tiles ({ z, x, y, size, data: Float32Array of size² meters }, all
// at one zoom) → elevationAt(lat, lng): bilinear between pixel centers,
// reading neighbors from the adjacent tile at borders; null where no tile
// was loaded.
export function createDem(tiles) {
  // Only well-formed grids: a size that disagrees with the data would send
  // every lookup to the wrong (or no) tile.
  const loaded = tiles.filter((tile) => tile?.size > 0 && tile.data?.length === tile.size * tile.size);
  if (!loaded.length) return null;
  const zoom = loaded[0].z;
  const size = loaded[0].size;
  const byKey = new Map(loaded.map((tile) => [`${tile.x}/${tile.y}`, tile]));

  function pixel(gx, gy) {
    const tile = byKey.get(`${Math.floor(gx / size)}/${Math.floor(gy / size)}`);
    if (!tile) return null;
    const px = gx - tile.x * size;
    const py = gy - tile.y * size;
    return tile.data[py * size + px];
  }

  return {
    zoom,
    elevationAt(lat, lng) {
      const p = globalPixel(lat, lng, zoom, size);
      // Pixel (i, j) holds the elevation at its center (i + 0.5, j + 0.5).
      const fx = p.x - 0.5;
      const fy = p.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const a = pixel(x0, y0);
      const b = pixel(x0 + 1, y0);
      const c = pixel(x0, y0 + 1);
      const d = pixel(x0 + 1, y0 + 1);
      if (a === null || b === null || c === null || d === null) {
        return a ?? b ?? c ?? d;
      }
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
  };
}
