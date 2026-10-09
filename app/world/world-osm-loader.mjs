// Fetches OpenStreetMap vector tiles inside the tile worker for the virtual
// world's real-world styles: the TileJSON once per world (its tile URL
// template carries a dated build id that changes), then the corridor's tiles
// through a small pool, always taking the queued tile nearest the current
// focus (the camera) next. Each tile's bytes (or null when it failed) go to
// `onTile`; the world then keeps the synthetic look there. The browser's HTTP
// cache is the tile cache (the dated URLs are immutable).

export function createOsmLoader({ tilejsonUrl, concurrency, onTile, onError }) {
  const controller = new AbortController();
  let queue = [];
  let focus = { x: 0, z: 0 };
  let template = null;
  let running = 0;

  async function start(tiles) {
    queue = tiles.slice();
    try {
      const response = await fetch(tilejsonUrl, { mode: "cors", signal: controller.signal });
      if (!response.ok) throw new Error(`TileJSON HTTP ${response.status}`);
      const tilejson = await response.json();
      template = Array.isArray(tilejson.tiles) ? tilejson.tiles[0] : null;
      if (!template) throw new Error("TileJSON lists no tile URL");
    } catch (error) {
      if (controller.signal.aborted) return;
      onError?.(error);
      for (const tile of queue) onTile(tile, null);
      queue = [];
      return;
    }
    pump();
  }

  // The point (world-local meters) whose nearest queued tile loads next;
  // tiles carry their `center`.
  function setFocus(x, z) {
    focus = { x, z };
  }

  function pump() {
    while (running < concurrency && queue.length && !controller.signal.aborted) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        if (distanceSq(queue[i]) < distanceSq(queue[best])) best = i;
      }
      const [tile] = queue.splice(best, 1);
      running++;
      load(tile).then((bytes) => {
        running--;
        if (controller.signal.aborted) return;
        onTile(tile, bytes);
        pump();
      });
    }
  }

  function distanceSq(tile) {
    const c = tile.center;
    return c ? (c.x - focus.x) ** 2 + (c.z - focus.z) ** 2 : 0;
  }

  async function load(tile) {
    const url = template.replace("{z}", tile.z).replace("{x}", tile.x).replace("{y}", tile.y);
    try {
      const response = await fetch(url, { mode: "cors", signal: controller.signal });
      // 204: an empty tile (open sea, say) — no features, but loaded.
      if (response.status === 204) return new Uint8Array(0);
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[virtual-world] OSM tile failed", tile, error);
      return null;
    }
  }

  return {
    start,
    setFocus,
    abort() {
      controller.abort();
      queue = [];
    },
  };
}
