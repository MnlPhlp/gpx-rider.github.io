# Plan: real-world data (OpenStreetMap) in the virtual world's real-terrain styles

Status: **implemented 2026-10-08** (all six milestones; see "Outcome" at the
end). Written 2026-10-08. Read `CLAUDE.md` first —
especially the `app/world/` module table and the "Two map renderers, one map
API" section — then this plan.

## 1. Goal and decisions already made

- The virtual world gets two kinds of styles per look (theme):
  - **Offline** (`terrain: "route"`): everything synthesized from the route's
    own track and elevations. Sends no network requests. Unchanged.
  - **Real world** (`terrain: "real"`): the existing real-terrain styles grow
    into "everything real": the ground shape from the Terrarium DEM (already
    built), **plus OpenStreetMap buildings, land use / land cover (parks,
    forest, farmland, residential, water, rock, glacier…), other roads and
    waterways**. No separate new mode: the OSM data is folded into the
    existing `*-real` styles.
- The route itself stays the generated road (`world-road.mjs`): the road the
  rider rides is still the smoothed GPX centerline with its flat bed. OSM
  roads are *other* roads drawn around it.
- Rename the real styles' labels from "· real terrain" to "· real world" in
  `virtual_world.styles` (`tuning.yaml`). **Keep the ids** (`virtual-real`,
  `neon-real`, `city-real`) — they are persisted in settings.
- In a real-world style, OSM replaces *all* synthetic placement wherever OSM
  data exists: no synthetic town (`world-city.mjs`), no synthetic forest or
  fields. Where an OSM tile failed to load, fall back to the synthetic
  biome for that area (as the DEM path already falls back per sample).
- **Decision to confirm with the user at the start of the session:** with
  real buildings, the "City · real world" style differs from "Natural · real
  world" only in its look (facade/window material, paved ground colors). The
  recommendation is to keep it as a look variant (city facades + windows on
  the real buildings) rather than drop it. If dropped, map a persisted
  `city-real` to `virtual-real` in `restoreSettings`.

## 2. Data source (verified 2026-10-08)

**OpenFreeMap vector tiles** (OpenMapTiles schema, built from OSM):

- TileJSON: `https://tiles.openfreemap.org/planet` → `tiles: ["https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf"]`.
  The tile URL contains a **dated build id that changes**; always read it from
  the TileJSON at world load (cache in memory for the session). Put the
  TileJSON URL in `tuning.yaml`, never the dated template.
- `access-control-allow-origin: *` on both the TileJSON and the tiles; no API
  key. Tiles are served `content-encoding: gzip` (fetch decompresses
  transparently) and `cache-control: public, max-age=315360000` on the
  immutable dated URLs — **the browser HTTP cache is the tile cache**; no
  IndexedDB layer is needed.
- `minzoom 0`, `maxzoom 14`. Use **zoom 14** (a tile is ~2.45 km × cos(lat)
  wide, ~1.57 km in Prague, ~1.68 km at Stelvio).
- Measured sizes at z14: dense Prague center tile **437 KB transferred / 750
  KB decoded**; rural Stelvio tile **19 KB**. Most bytes are `poi` and
  `housenumber`, which we ignore but still download.
- Attribution required (ODbL + OpenMapTiles), from the TileJSON:
  `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` — must be **visible on
  the map** while a real-world style shows OSM data (see §7).
- Layers we use and their fields (from the TileJSON `vector_layers`):

  | layer | zoom | fields we use |
  |---|---|---|
  | `building` | 13–14 | `render_height`, `render_min_height`, `hide_3d`, `colour` |
  | `landcover` | 0–14 | `class`, `subclass` (wood, grass, farmland, rock, ice, sand, wetland…) |
  | `landuse` | 4–14 | `class` (residential, commercial, industrial, retail, cemetery, …) |
  | `park` | 4–14 | `class` |
  | `water` | 0–14 | `class` (lake, river, ocean…), `brunnel`, `intermittent` |
  | `waterway` | 3–14 | `class` (river, stream, canal…), `brunnel`, `intermittent` |
  | `transportation` | 4–14 | `class` (motorway, trunk, primary, secondary, tertiary, minor, service, track, path, rail…), `brunnel` (bridge/tunnel), `ramp`, `layer`, `surface` |

- Observed in the probes: `building` features are **merged multipolygons**
  (205 features cover the whole dense Prague tile, one feature = many
  buildings); every building carried `render_height` (OpenMapTiles fills a
  default when OSM has none). Tile `extent` was 4096.
- Why not alternatives: the Overpass API is rate-limited/fair-use with heavy
  per-request cost and returns raw OSM needing much more processing;
  Protomaps' hosted API needs a key. OpenFreeMap is open source and
  self-hostable, so keep the TileJSON URL configurable.

Probe script used for the numbers above (Python, no deps) is easy to recreate:
a varint/length-delimited walk over `Tile.layers (3) → Layer.name (1),
features (2), keys (3), values (4), extent (5)`.

## 3. Current architecture this builds on

- `app/world/world-tile-worker.mjs` — module Web Worker. `prepareWorld`
  builds the route-only terrain, then for `terrain: "real"` loads Terrarium
  tiles (`world-dem-loader.mjs`), builds `createWorldTerrain(route, config,
  { dem })`, posts `{ type: "dem" }` to the main thread, and only then answers
  `tile` requests (they `await current.ready`).
- `app/world/world-terrain.mjs` — the height field; `sampleReal` is the DEM
  path (road bed pinned to GPX, blended into real ground). `sample()` also
  returns `roadDistance` and the nearest road heading (`roadDirX/Z`).
- `app/world/world-surface.mjs` — `createSurface(terrain, config, { city })`:
  per-vertex ground colors (`colorAt`) and tree placement (`placeTrees`,
  global jittered lattice, `forestDensity`).
- `app/world/world-tiles.mjs` — quadtree LOD + `buildTileArrays` (heights,
  normals, colors, skirts, trees). Tiles are keyed `level/i/j`.
- `app/world/world-tile-manager.mjs` — requests tiles from the worker, builds
  meshes, instanced trees, instanced city buildings (`addBuildings`), LRU.
- `app/world/world-scene.mjs` — scene per style; owns the main-thread terrain;
  `onDem` swaps in the DEM terrain and calls `onTerrainChanged`.
- `app/world/world-themes.mjs` — per-theme materials incl.
  `createBuildingMaterial` (instanced unit boxes, windows in the shader from
  instance scale).
- `app/world/world-road.mjs` — the route's road strip (`buildRoadArrays`,
  columns with bend-radius clamping) and `createRoadTrack`.
- Important constraint: **module workers do not see the page's import map**,
  so worker-side code must import only relative paths (no bare `three`).

## 4. New modules

All pure modules get unit tests in `tests/` (they run in the worker *and* in
Node). Keep each under ~400 lines.

1. **`app/world/world-mvt.mjs`** (pure) — minimal Mapbox Vector Tile decoder,
   hand-rolled like `ride/fit.mjs` and `street-view/sfm-mesh.mjs` (no
   dependency, worker-safe): protobuf varints / length-delimited fields,
   layers, keys/values (string, float, double, int, uint, sint, bool),
   feature tags, geometry commands (MoveTo/LineTo/ClosePath, zigzag deltas)
   → `{ name, extent, features: [{ type: 1|2|3, properties, geometry:
   [[{x,y}…]…] }] }`. Polygon rings: split into polygons by **signed area**
   (MVT spec: exterior rings are positive area in tile coordinates with y
   down; holes negative), so a merged multipolygon becomes many polygons with
   their holes. Option to decode only listed layers (skip `poi`,
   `housenumber`, `*_name` without parsing their features).
   Tests: an encoder helper in the test file builds synthetic tiles (point,
   line, polygon with hole, multipolygon, all value types); optionally a
   small real fixture (`tests/fixtures/osm-stelvio-14-8667-5793.pbf`, 19 KB,
   with an ODbL attribution note).
2. **`app/world/world-osm.mjs`** (pure) — OSM features → world-local
   geometry and classes:
   - Tile pixel → lat/lng (Web Mercator inverse, reuse the math style of
     `world-dem.mjs#globalPixel`) → local x/z via `terrain.projection`.
   - Classification tables (from `tuning.yaml`, §6): landcover/landuse/park
     classes → surface classes `forest | grass | park | farmland | urban |
     industrial | water | sand | rock | ice | wetland`, each with a priority.
   - Buildings: polygons (+holes) with `height = render_height`,
     `minHeight = render_min_height`, skip `hide_3d`.
   - Roads: `transportation` lines → `{ points, width, kind, bridge, tunnel,
     layer }` with width per class (§6); drop tunnels; drop `rail` unless
     configured; drop paths/tracks beyond a distance from the route.
   - Waterways → lines with width per class; water polygons.
   - **Route de-duplication:** cut out OSM road stretches that coincide with
     the route (within `route_overlap_meters` of the road centerline and
     roughly parallel, via `terrain.sample(...).roadDistance/roadDir`), so
     the route's own road isn't drawn twice.
3. **`app/world/world-osm-raster.mjs`** (pure) — per OSM tile, scanline-fill
   the surface-class polygons into a `Uint8Array` class grid (e.g. 256×256 →
   ~6 m cells at z14) in priority order, plus a water mask. Gives O(1)
   `surfaceClassAt(x, z)` for the per-vertex ground colors, tree placement
   and the height-field water carve. Tests: fill/priority/holes.
4. **`app/world/world-osm-loader.mjs`** (worker IO) — fetch the TileJSON
   once, fetch z14 tiles with a small concurrency pool (like
   `world-dem-loader.mjs`), decode with `world-mvt.mjs`, extract with
   `world-osm.mjs`, rasterize. Failed tiles resolve to null (→ synthetic
   fallback for that area).
5. **`app/world/world-osm-meshes.mjs`** (pure geometry arrays, worker side) —
   per OSM tile:
   - **Buildings:** extruded footprints. Walls per ring edge; flat roof
     triangulated with **earcut** (vendor `earcut` v3, ISC, ESM, single file,
     under `app/vendor/earcut/`, imported by *relative path* from the worker;
     note it in `THIRD_PARTY_NOTICES.md`). Base = lowest ground under the
     footprint vertices minus `foundation_meters` (the same rule as
     `world-city.mjs`); top = base-ground + height. Per-vertex attributes for
     the window shader: `facade` (u = running meters along the ring, v =
     meters above the base) and `roof` flag; facade color per building.
   - **Roads:** draped ribbons — resample each line to ~4 m, each cross-
     section's two edge points get their *own* ground height + `road_lift`
     (follows the cross slope; no embankments), reuse `world-road.mjs`'s
     `crossSectionFrames` for fold-free bends. Bridges: v1 keeps them
     draped (document); later they could use `layer`.
   - **Waterways:** same ribbon builder, water color, slightly sunk.
   - **Water polygons:** flat surfaces at the polygon's minimum ground
     height (earcut), rendered with the theme's water material.

## 5. Changes to existing modules

- **`world-tile-worker.mjs`**: for `terrain: "real"`, after the DEM, start
  the OSM corridor load (§5.1). Keep answering terrain-tile requests
  immediately (do not block on OSM — too slow in cities); a terrain tile
  built before the OSM tiles covering it arrived is marked `provisional`.
  New outgoing messages: `{ type: "osm-tile", worldId, key, meshes }` (the
  building/road/water arrays of one OSM tile, transferable) and
  `{ type: "invalidate", worldId, rects }` (terrain-tile areas to rebuild
  because their OSM data arrived — ground colors/trees change).
- **`world-terrain.mjs`**: accept an optional `osm` sampler; in `sampleReal`,
  inside OSM water polygons carve the ground just below the water surface
  (so lakes/rivers in the DEM don't poke through the flat water), using the
  raster's water mask. Keep the route's road bed priority over everything.
- **`world-surface.mjs`**: `createSurface(terrain, config, { city, osm })`.
  With `osm`, `colorAt` takes the class at the vertex from the raster
  (`surfaceClassAt`) and maps it to the palette (new colors: farmland,
  industrial, wetland, ice already = snow, …); `forestDensity` = 1 in
  forest/wood, a park density in parks, 0 in urban/industrial/water/farmland,
  and the synthetic noise only where no OSM tile is loaded. Trees must never
  stand inside a building footprint: check the raster's building mask (add a
  `building` class to the raster at low priority… or rather the highest).
- **`world-tile-manager.mjs`**: handle `osm-tile` (build meshes: one merged
  building mesh per OSM tile with the theme's building material, one road
  mesh, one water mesh; add to a separate `osm` group; distance-based
  visibility so far OSM tiles hide) and `invalidate` (drop cached terrain
  tiles intersecting the rects so they are re-requested). Keep the LRU for
  OSM meshes too.
- **`world-themes.mjs`**: `createBuildingMaterial` gets a non-instanced
  variant reading the `facade`/`roof` attributes (a `#define` switch in the
  same shader) for OSM buildings; neon: dark buildings with glowing edges
  (shader: bright where `facade.u` is near a ring corner or `v` near the
  roof) and OSM roads as dim glowing lines; nature: plain lit facades with
  the window pattern toned down; city: the existing facades + windows.
- **`world-scene.mjs`**: wire the new tile-manager callbacks; apply the
  `invalidate` flow; `onTerrainChanged` already re-seats overlays.
- **`world-city.mjs`**: not used in real-world styles (OSM replaces it).
- **`virtual-map3d.mjs` / HUD**: the attribution chip (§7).
- **`tuning.yaml` + `tuning.mjs`**: new `virtual_world.osm` section (§6);
  relabel the real styles.

### 5.1 Which OSM tiles, in what order

- Corridor: all z14 tiles intersecting the route's road centerline buffered
  by `osm.corridor_meters` (start ~1500 m); cap at `osm.max_tiles` (e.g. 80;
  if exceeded, shrink the buffer). Pure helper in `world-osm.mjs`, tested
  (count for a straight route, a loop, a long route).
- Order: by distance to the rider's current position, then along the route
  ahead of the rider. The worker needs the rider position: the tile manager
  already sends camera-driven tile requests; add a lightweight
  `{ type: "focus", worldId, x, z }` message (throttled, e.g. every 2 s or
  200 m) so the worker re-prioritizes its OSM queue.
- Budget awareness: a city route of 30 km can mean ~40 dense tiles ≈ 15 MB.
  Keep the pool at ~4 concurrent requests; never fetch beyond the corridor.

## 6. `tuning.yaml` additions (sketch)

```yaml
virtual_world:
  osm:
    # TileJSON of an OpenMapTiles-schema vector tile source (read at world
    # load: the tile URLs carry a dated build id). Self-hostable.
    tilejson_url: "https://tiles.openfreemap.org/planet"
    zoom: 14
    corridor_meters: 1500
    max_tiles: 80
    concurrency: 4
    attribution: "© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap"
    raster_cells: 256
    route_overlap_meters: 8
    road_lift_meters: 0.12
    roads:            # width in meters per transportation class (0 = skip)
      motorway: 12
      trunk: 10
      primary: 8
      secondary: 7
      tertiary: 6
      minor: 5
      service: 3.5
      track: 2.5
      path: 1.5
      rail: 0
    waterways: { river: 14, canal: 10, stream: 2.5, ditch: 0, drain: 0 }
    surface_classes:  # OSM class → ground class (priority = list order)
      water: [water, ocean, lake, river, reservoir, basin]
      ice: [ice, glacier]
      rock: [rock, bare_rock, scree]
      sand: [sand, beach]
      forest: [wood, forest]
      park: [park, garden, cemetery, golf_course, pitch, playground]
      wetland: [wetland, marsh, swamp, bog]
      farmland: [farmland, farm, orchard, vineyard, allotments]
      grass: [grass, meadow, grassland, heath, scrub]
      industrial: [industrial, commercial, retail, railway, quarry]
      urban: [residential, suburb, neighbourhood, school, university, hospital]
    buildings:
      foundation_meters: 1.5
      default_height_meters: 8
      max_distance_meters: 4000   # hide farther building meshes
```

Verify the exact `class` values against the OpenMapTiles schema docs
(openmaptiles.org/schema) at implementation time; the TileJSON lists fields
but not their values.

## 7. Attribution, privacy, docs

- **Attribution on the map** whenever a real-world style is active: a small
  chip registered with the screen manager (`hud/screen-manager.mjs`, bottom
  of the left or right column, low weight) — "© OpenStreetMap contributors ·
  OpenMapTiles · OpenFreeMap · Elevation: Mapzen / AWS Open Data". This also
  fixes an existing gap: the real-terrain styles currently fetch Terrarium
  tiles without showing their attribution on the map (the
  `#terrainAttribution` line only follows the online-terrain camera setting).
  Keep it visible in theater mode/recordings (`capturing` class) like
  Google's attribution.
- Privacy (README "Data and privacy", `CLAUDE.md` Persistence paragraph):
  real-world styles request z14 vector tiles for the route's corridor from
  OpenFreeMap (anonymous, no keys, tile coordinates only); offline styles
  send nothing.
- README: Highlights bullet (virtual world) and an "Under the hood" paragraph
  (vector tiles → classes → raster → ground/trees; extruded buildings with
  earcut; draped road ribbons; corridor streaming with invalidation).
  `CLAUDE.md`/`AGENTS.md`: module table rows for the new modules, the worker
  protocol additions, the "no import map in workers" rule; keep the two files
  in sync. `THIRD_PARTY_NOTICES.md`: earcut (ISC) and the OSM/OpenMapTiles
  data attribution.

## 8. Milestones (each ends green: `make test`, browser check, docs)

1. **Decode & select** — `world-mvt.mjs`, corridor tile selection,
   `world-osm.mjs` extraction + classification, tests (synthetic tiles +
   the Stelvio fixture). No rendering yet.
2. **Ground from OSM** — loader in the worker, `world-osm-raster.mjs`,
   surface colors + trees from the raster, synthetic fallback per area,
   `invalidate` flow for terrain tiles, water carve + water polygons. Verify
   on Golden Gate (bay, parks), Prague (river, parks), Stelvio (rock, ice).
3. **Buildings** — earcut vendored, `world-osm-meshes.mjs` buildings, the
   non-instanced building material, per-OSM-tile meshes with distance
   visibility. Verify Prague: frame rate in chase view (target ≥ 50 fps on
   the dev machine, report draw calls/triangles from `renderer.info`), no
   floating/sunken buildings on slopes, no trees inside buildings.
4. **Roads & waterways** — draped ribbons, route de-dup, theme colors.
   Verify the route's own road isn't doubled and side roads follow cross
   slopes without clipping (use the same close-up camera probes as the road
   work: grab the map, set `center/range/tilt/heading` on the element).
5. **Looks** — neon (glowing outlines, dim road lines), city (facades +
   windows on real buildings), nature (plain facades). Relabel styles;
   decide `city-real` (§1).
6. **Attribution, privacy, docs** (§7); confirm offline styles make zero
   requests (Playwright network log) and real-world styles only hit
   `tiles.openfreemap.org` + the Terrarium bucket.

## 9. Testing notes

- Pure modules: Node tests as usual (`make test`). The MVT test encoder
  should live in the test file (it is test-only code).
- Browser: `make run`, the Playwright MCP browser (see the
  `browser-verify-playwright-mcp` memory): switch styles from the
  `#mapRendererSelect` dropdown; hide HUD for clean screenshots with
  `#mapViewport > :not(#map) { visibility: hidden !important; }`; inspect
  `document.querySelector("gpx-virtual-map-3d")` (`.world.terrain`,
  `.world.scene`, `.renderer.info.render`). **Reset the test browser
  afterwards** (renderer back to Google, `#resetCameraViewBtn`), and don't
  grab-and-move the camera on a route you'll screenshot later — the manual
  capture persists camera offsets (it once left the look-at 2.8 km up).
- Performance: measure fps with a 3 s `requestAnimationFrame` count while the
  simulation runs; compare offline vs real-world styles on Prague.

## 10. Risks and open questions

- **Data volume in cities** (~0.4 MB per dense tile): corridor limits, focus
  ordering, and the HTTP cache keep it bounded; show nothing worse than the
  synthetic fallback while tiles load.
- **OpenFreeMap has no SLA** (donation-funded, fair use): keep the URL
  configurable, fail soft (synthetic fallback), don't prefetch beyond the
  corridor.
- **Bridges/tunnels on the route:** the route's road is still pinned to the
  GPX elevation with embankments (a bridge reads as a causeway). OSM
  `brunnel=bridge` on the route's own road could later switch the road strip
  to a deck without embankments — out of scope for v1, note it.
- **Merged building multipolygons** — handled by ring splitting; check that
  holes (courtyards) survive earcut.
- **`render_height` defaults** (OpenMapTiles fills one): fine visually; no
  per-building levels needed.
- **Terrain-tile rebuild churn** when many OSM tiles arrive: coalesce
  `invalidate` messages per frame; only rebuild tiles currently displayed or
  cached.
- **Worker import map limitation** — relative imports only in worker code
  (earcut included).

## Outcome (2026-10-08)

- Decision on §1: the owner dropped `city-real` *and* `neon-real`. The styles
  are now the three offline looks (`virtual`, `neon`, `city`) plus one
  real-world style `virtual-real` ("Real world", nature theme, which gained a
  `buildings` block for the OSM facades + windows and `osm_roads` colors).
  Old ids map to `virtual-real` via `virtual_world.retired_styles`.
- Deviations from the plan: OSM meshes are built on request (worker keeps the
  extracted features per tile; the main thread asks for tiles within
  `mesh_distance_meters`, LRU `max_mesh_tiles`) instead of being pushed for
  every tile — bounds GPU memory in cities. Terrain-tile invalidation is
  per-tile version numbers instead of coalesced rect messages. Bridges of
  *other* roads run straight between their end heights (not draped). Ocean
  polygons only feed the raster/carve; the scene's sea plane draws the sea.
  The `park` layer is ignored (it holds national parks, far too coarse).
  Neon OSM looks were dropped with `neon-real`.
- Measured: Prague center tile ~300 ms worker time (decode 12, extract 80,
  raster 36, meshes 160), 152k building vertices; the Prague gallery route in
  chase view held 60 fps (581 draw calls, ~830k triangles).
