# GPX Rider

**A free, open-source virtual cycling trainer that runs in your browser.** Load any GPX route, ride it over photorealistic 3D terrain, and let the real road gradient control your Bluetooth smart trainer.

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)

**[Launch GPX Rider →](https://gpx-rider.github.io/app.html)**  
[About GPX Rider](https://gpx-rider.github.io/)

**Zero friction:** The live app requires **zero accounts, zero installations, and zero API keys**. Open it and ride. The hosted version uses a domain-restricted Google Maps key.

The landing page uses the Ještěd climb as an animated 3D backdrop and gives a quick overview of GPX Rider’s features and riding workflow.

## Screenshots

![Ride HUD](screenshots/ride.jpg)
![Setup screen](screenshots/setup.jpg)
![Route gallery](screenshots/gallery.jpg)

## Why GPX Rider?

Most indoor cycling platforms give you fixed virtual worlds, subscriptions, and routes chosen for you. GPX Rider takes a different approach: bring any GPX track and ride the actual terrain, with trainer resistance following its grade in real time.

It is built for people who want to:

- ride their own routes indoors over real-world 3D scenery;
- preview climbs before riding them outside;
- control an FTMS-compatible or Tacx FE-C smart trainer directly from the browser;
- export virtual rides as FIT files for services such as Strava and Garmin Connect;
- self-host, modify, or contribute without a backend or build system.

## Highlights

- **Bring any GPX track** — open a local file or choose a ready-to-ride route from the built-in gallery.
- **Photorealistic 3D terrain** — follow elevated, grade-colored route lines through Google Photorealistic 3D Maps with a real 3D rider marker, beacon, minimap, and terrain-aware camera lift.
- **Virtual world renderer** — prefer a stylized world, or have no Maps key? Switch **Map rendering** at the top of the side panel to a *Virtual world* style: a landscape generated in the browser around the route — the road at its exact GPX height, forests, fields, lakes, rock and snow — with the same route line, rider marker, cameras, and HUD. Three offline looks are synthesized from the route alone and send no network requests: the *natural* landscape, a *neon grid* (Tron-style glowing grid and contour lines) and a *city* (a town of low-rise blocks, parks and a tower downtown along the route). The **Real world** style builds the place itself: the ground shape from free public elevation data (real mountains and coastlines; sea from bathymetry) plus **OpenStreetMap** buildings (with facades and windows), forests, parks, fields, rock and glaciers, the other roads, rivers and lakes around the route.
- **Bluetooth trainer control** — connect an FTMS-compatible smart trainer, or a Tacx FE-C trainer (the wheel-on Flow/Vortex/Bushido/Genius, which predate FTMS), through Web Bluetooth. Trainer-reported speed advances the rider while route grade drives simulated resistance.
- **Heart-rate support** — connect a standard Bluetooth heart-rate strap or use heart-rate data reported by the trainer.
- **Route intelligence** — calculate distance, noise-filtered ascent and descent, grade, difficulty, terrain classification, sustained climbs, and smart ETA directly from the GPX data.
- **Climb and segment focus** — inspect detected climbs or drag across the elevation profile to select any custom route segment.
- **Adaptive ride HUD** — use the same standard ride screen in windowed and fullscreen views, with sensor meters appearing only when their data is available.
- **Cinematic camera system** — switch among follow, first-person, static, orbit, fly-by, fly-over, and satellite views with physically flown transitions between the route overview and rider.
- **Street imagery in first person (opt-in)** — ride through real street-level photos from [Mapillary](https://www.mapillary.com/) wherever the route has coverage, rendered by the app's own 3D projection of Mapillary's reconstructions so the view moves continuously with you, with the 3D view filling the gaps, a coverage strip under the elevation profile, a local cache so a route you rode before plays offline, and a guided way to capture and publish your own ride so you can ride it back.
- **FIT export** — record rides locally and download standards-compliant `.fit` files classified as virtual cycling activities.
- **Simulation and demo modes** — preview a route at a chosen speed, or drive the complete UI with synthetic trainer and heart-rate data.
- **Ride replay and video export** — open a ride you really rode (a FIT file, or a GPX with timestamps, straight from your head unit or Strava) and watch it replayed over the 3D terrain at its recorded speed, with your real power, heart rate and cadence on the HUD — then render it to a 1080p MP4 of exactly the overlays you choose, frame by frame in the browser, as fast as the map can draw.
- **Ghost rider** — race a recorded ride: while you pedal (or simulate), the recording rides along as a tall blue beacon on the route, and a HUD chip shows how far ahead or behind you are in time and distance.
- **Recording view** — frame the map at an exact recording size and choose which HUD components appear in the recording.
- **Local-first persistence** — routes, progress, recordings, settings, camera preferences, and remembered sensors survive reloads without an account.
- **Zero build step** — vanilla HTML, CSS, and JavaScript ES modules. No framework, bundler, or `node_modules`; the one or two libraries used are vendored as static files.

## How to ride

[Mapy.com](https://mapy.com/) is a convenient way to create routes: it supports bicycle routing, displays an elevation profile, and exports GPX files ready for GPX Rider.

1. Open GPX Rider in Chrome or Edge.
2. Choose **Open GPX file…** or select a route from **Browse gallery**. If there is no saved ride or route deep-link, the app automatically opens the first gallery route.
3. Select **Connect** beside the smart trainer and choose an FTMS-compatible or Tacx FE-C device.
4. Optionally connect a Bluetooth heart-rate strap the same way.
5. Start pedaling. Trainer speed moves the rider along the route, while the current GPX grade is sent back to the trainer.
6. Use **Download .FIT** whenever you want to export the recorded ride.

Not on the bike? Use the Simulation card's **Start** button to preview the route at a fixed speed. Real pedaling automatically stops a running simulation and takes priority.

### Replay a recorded ride and export a video

The **Ride replay** card turns a ride you actually did into a cinematic replay: no trainer, no simulation — the rider moves exactly as fast as you did, and the HUD shows the power, heart rate and cadence you recorded.

1. Open the ride with **Open recorded ride…** (or the top bar's **Open GPX or FIT…**). A `.fit` file from a Garmin, Wahoo or similar head unit works directly; so does a GPX export as long as its points carry timestamps (Strava's and most head units' GPX exports do).
2. For a Strava activity, paste its link into the card. GPX Rider cannot download the file for you — Strava's exports need your own login session — but **Get FIT** / **Get GPX** opens the export in a new tab where you are logged in; save the file and open it here. The activity id stays attached to the replay as its source.
3. Press **Play** to watch the replay in the normal ride view. Stops longer than a few seconds are skipped, the speed selector (1× to 32×) turns a long ride into a time-lapse (the readout shows the ride time and how long the rest takes to watch at that speed: two hours at 4× is 30 minutes), and the scrubber or a click on the elevation profile jumps anywhere in the ride.
4. **Preview & record** opens the recording view: the map pinned to the video's size, with a toolbar to hide the clock, meters, bottom dock, climb banner, controls or minimap, pick the playback speed, and choose the camera (the angled follow camera by default, or first person). By default the recording view also hides the **route ahead**: the route line only trails the rider, so the rider's position is easy to follow, while the opening overview shot still shows the whole route; untick **Route ahead** to draw the full route throughout. What you see is what the video shows.
5. **Record video** asks the browser to share **This Tab** once, then records the recording view in real time, exactly as you see it. The ride opens on a short overview shot, flies the camera down to the rider at the start, begins moving once the camera has arrived, plays to the finish-line orbit (or **Stop & save**), and downloads as a 1920×1080 video (MP4/H.264 in current Chrome and Edge, WebM in older ones). The REC chip shows the progress, the time left at the chosen speed and the file size; expect roughly 2 MB per second of video. The recording takes as long as the video is, so the playback speed is what shortens a long ride: a two-hour ride at 16× is about eight minutes of video and recording. The browser keeps rendering a tab it is capturing, so you can switch to another tab or window meanwhile — just don't minimize or close the browser. If your window is too small for the full 1280×720 view, the view is scaled down (the aspect, and so the video's frame, stays the same); a larger window means sharper footage.

The replay never writes to the FIT buffer and never sends grade to a connected trainer; pedaling, the simulation button or demo mode pause it and take over. The loaded recording survives reloads together with the route.

### Race a ghost rider

With a recorded ride loaded, leave the replay paused and just ride — on the trainer, with the simulation, or in demo mode. The recording rides along as a **ghost**: a tall translucent blue beacon on the route (drawn through trees and buildings, so you can spot it when the camera is not on it) and a matching dot on the minimap. The **Ghost** chip under the clock shows your gap in ride time and route distance, green while you are ahead, red while you are behind, with the elapsed readout switching to your own moving time since the race began.

- The race starts the moment you first move and runs in moving time on both sides: the ghost advances only while you do, so stopping pauses it too (the recording's own stops were squeezed out when it was loaded). A reset puts both of you back at the start.
- A click on the elevation profile or a climb moves the ghost along with you, so the gap starts at zero from there; the clock keeps running.
- The **Ghost rider** switch in the Ride replay card turns it off; pressing **Play** on the replay (which makes the recording drive the rider itself) and the recording view also take the ghost off the map.
- The race survives reloads together with the recording. Colors, beacon size and the ghost's update step live under `ride_replay.ghost` in `tuning.yaml`.

For batch rendering without a browser window, **Copy render command** in the toolbar produces a command for the optional headless renderer, `scripts/render_replay_video.py`, with the same overlay, speed and camera choices. It needs Playwright for Python (`pip install playwright`), ffmpeg, and a GPU reachable through Vulkan (recent Chrome has no software WebGL), and reuses a running `make run` server on port 5173.

### Street imagery

Settings › **Street imagery** turns on real street-level photos in the first-person camera. GPX Rider looks up Mapillary images along the loaded route, keeps the ones that sit on the road and face the way you ride, and shows them as you move; where there are none, the 3D view takes over again. The settings panel and the elevation profile show how much of the route is covered.

- The hosted demo ships with a Mapillary client token; self-hosters paste a free one from the [Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers) (or bake it in, see below). A token saved in Settings always wins.
- Coverage is crowd-sourced and uneven: popular passes and cities are well covered, remote roads often are not, and photo age and season vary. Images are a few to tens of meters apart, so it is a fast slideshow with animated transitions, not video.
- **How it plays.** The first time a route is loaded, GPX Rider scans it for imagery and prepares a *playback plan* — the chain of photos to play, each with its 3D pose from Mapillary's reconstruction. Riding then projects each photo onto its reconstructed proxy mesh and moves a virtual camera from one photo's position to the next exactly as fast as you ride, blending the two; where two photos come from different reconstructions it cross-fades instead. The plan and every photo and mesh you pass are kept in a local cache (Settings shows its size and a Clear button), so the next ride of that route starts instantly and needs no network for the parts you have seen.
- **Ride it yourself, then ride it back.** The **Contribute your own imagery…** guide walks through capturing a real ride (the Mapillary phone app on a bar mount, or an action camera plus a timestamped GPX), uploading it, checking the route's coverage once Mapillary has processed it, and enabling street imagery. Enter your Mapillary username so your own sequences are preferred where several riders photographed the same road.

## Route intelligence

When a route loads, GPX Rider shows its name, distance, ascent, descent, terrain class, and difficulty. The classification uses distance and elevation gain only; it does not depend on power, speed, or weather.

The climb detector tolerates short flats, small descents, and noisy elevation samples, so a sustained climb is not incorrectly split into several pieces. Detected climbs include:

- start and summit positions;
- length, elevation gain, average grade, and maximum grade;
- approach distance and climb order;
- live distance, ascent, and average grade remaining;
- distance and climbing progress to the summit.

Drag across any part of the elevation profile to select a custom segment. The app reports its start, end, length, ascent, and descent. While stationary, the camera can focus on the selection; while riding, the rider camera remains active and the segment statistics move into the map HUD.

### Smart ETA

During a trainer ride, ETA measures the rider's pace through *flat-equivalent distance*: climbing is charged, descending is credited, and the result is projected across the terrain still ahead. It learns only from real pedaling, so artificial simulation speed never contaminates the estimate.

Simulation ETA remains a straightforward remaining-distance calculation at the selected speed.

## Camera and HUD

### Rider camera

- The default follow camera flies behind the rider using the GPX route bearing.
- A first-person preset places the camera at rider height.
- Camera distance, angle, position, heading, and centering can be adjusted.
- Terrain avoidance lifts the camera when the ground between it and the rider would otherwise block the view. It uses the route's own elevation as a free offline floor, and — when **online terrain** is enabled (Settings › Rendering, on by default) — augments it with real ground elevation streamed from free public Mapzen/AWS terrain tiles, so the camera also clears hills the GPX track never climbs.
- When a hill sits squarely between the camera and the rider even with the camera above ground, the follow camera swings the shortest way around the rider — left or right — until the rider is visible again, instead of only lifting overhead. The rider stays centered; only the viewing side changes.
- Manual dragging gives the user direct control; reset restores the selected camera surface.

### Route overview

A newly loaded route opens in a whole-route overview. The same overview control remains available during a ride, so the camera is never locked to the rider.

Five overview styles are available:

- **Static** — a tightly framed still view of the complete route.
- **Orbit** — a continuous turntable rotation around the route.
- **Fly-by** — a camera flies a PCA-aligned ellipse around the route and looks into its direction of travel.
- **Fly-over** — a banking figure-eight that crosses the route's center and reverses its turn direction between lobes.
- **Satellite** — a near-vertical, north-up view fitted to the route.

Before a fly-by or fly-over starts, GPX Rider profiles the elevation of the entire flight path (from online terrain when enabled) and raises the fly height so the camera clears the highest ground along it — including hills the route itself detours around. The sampled data is visible on the camera debug overlay.

Selecting a detected climb or custom segment opens a dedicated static, orbit, or satellite focus camera. Reaching the end of a ride can trigger a finish-line orbit around the rider.

### Cinematic handoffs

- Overview-to-rider, rider-to-overview, and movement-start handoffs are flown rather than cut.
- The camera intercepts a moving rider where it will be when the flight finishes, rather than chasing its old position.
- Entering Fly-by or Fly-over joins the pattern at the point needing the least turn of the current view — ahead along the line of sight at a natural climb angle, never where the pattern flies back at the camera; the pattern then continues from that exact point.
- Position, view direction, roll, field of view, and velocity continue through the dock without a separate alignment phase.
- Geometry that cannot satisfy the configured physical limits falls back to the classic chase flight.

The underlying kinematics are described in [Under the hood](#under-the-hood).

### Map HUD

The HUD belongs to the map viewport and remains a standard ride screen in both windowed and fullscreen layouts. Fullscreen expands the same surface instead of switching to a separate UI.

- The bottom dock presents the core ride metrics, road-ahead elevation profile, and distance and climbing progress.
- Power, heart-rate, and cadence meters appear only when those sensor values are available; grade appears when a route is loaded.
- Available power, heart-rate, and grade meters show live training zones; the cadence meter shows a fixed green (90-110 rpm) / yellow / red band.
- The clock chip combines local time, elapsed time, ridden distance, and ascent.
- The climb banner shows approaching-climb, active-climb, or custom-segment statistics.
- The minimap and map controls remain available on the ride surface.
- The data dock can collapse to a compact strip when more map is wanted.

The separate **Recording view** fixes the map to a consistent output size; its toolbar lets you hide selected components—clock, meters, bottom dock, climb banner, demo chip, controls, or minimap—without changing the normal ride screen, and hosts the replay transport and video **Record** button when a recorded ride is loaded.

### Camera diagnostics

The Debug settings category provides a collapsible overlay with the camera values the 3D map actually applies: look-at center, eye altitude, heading, tilt, range, roll, field of view, and ride progress. For Orbit, Fly-by, and Fly-over, it can also draw the camera travel path as a red 3D line.

## Under the hood

GPX Rider is deliberately engineered as a small, inspectable static application rather than a packaged web platform.

### Broadcast-quality camera kinematics

The camera system uses purpose-built geometry rather than canned animations:

- **Time-scaled cubic Hermite splines** fly the camera onto a continuously-moving target in a local east/north/up frame, executed as cubic Béziers whose control offsets encode the endpoint velocities. The arc is used only where docking with matching velocity reads as one motion — flying back to the rider (leaving an overview, starting to move, teleporting via the elevation profile) and flying onto the Fly-by / Fly-over pattern. Artificial framings (static, orbit, satellite) snap or ease through their own driver, and a camera reset eases the plain chase home. Which targets get the arc is a single tunable list.
- **Exact position-and-velocity docking** makes both ends of a flight continuous: the chase camera inherits the arc's terminal velocity so follow tracking picks up without a restart, and an arc onto a Fly-by/Fly-over pattern docks at the direction-aligned pattern point needing the least view turn — ahead along the line of sight at a natural climb angle — handing off at that exact arc-length.
- **Dual-arc, tangent POV** flies the camera eye on the Hermite path while looking strictly along its flight tangent mid-arc. Near each dock, Rodrigues rotation turns the view direction at a constant rate into the real endpoint view—never through independent heading and tilt interpolation.
- **Moving-target interception** solves the rider's future follow-camera pose for each candidate flight duration instead of aiming where the rider was when the transition began.
- **Centripetal banking** derives roll from the path's lateral acceleration, producing aircraft-like banking into turns.
- **Physical constraints** bound turn radius, climb and dive angle, and velocity-control offsets. A duration solver chooses the shortest valid arc and rejects geometry that would loop or break exact docking.
- **Principal Component Analysis (PCA)** finds the route footprint's true axis of greatest spread, giving stable framing to diagonal routes, loops, lollipops, and out-and-backs.
- **Frustum projection and binary search** calculate the tightest camera range that keeps the complete route inside the real viewport.
- **Arc-length parameterization** keeps Fly-by and Fly-over ground speed consistent around their curves.

The pure transition solver is isolated in [`app/camera/transition-arc.mjs`](app/camera/transition-arc.mjs) and exercised by tests for endpoint docking, velocity continuity, physical limits, orientation smoothness, moving-target interception, and impossible-flight rejection. The browser-facing driver lives in [`app/camera/transition-camera.mjs`](app/camera/transition-camera.mjs). Every behavior knob is documented under `camera_transition` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### Human-perceived climb detection

Climb detection reads like a rider's own sense of effort rather than raw point-to-point geometry:

- **Resample and dual-filter elevation** to a fixed distance step, then a median filter followed by a moving average, so detection depends only on the terrain's real shape — not the source GPX's point density or GPS jitter.
- **Short- and long-window rolling grade** are read at every point; whichever reads more "climb-like" wins, so the same detector catches punchy ramps and long sustained drags alike.
- **A nonlinear pressure curve** converts grade into "fatigue" pressure, modeling how perceived effort ramps up faster than grade does — a jump from 2% to 4% barely registers, but 8%+ hurts far more than twice as much.
- **A fatigue integrator** (a leaky bucket) accumulates that pressure and drains it on flats and descents; a climb becomes officially active once the bucket crosses a start threshold.
- **Elevation-based exit conditions** — a large enough drop past the peak, or a long enough flat/downhill spell with no climb pressure at all — can close a climb even before its fatigue has fully drained, so a long descent is never mistaken for part of the climb.
- **Small-gap merging** stitches climbs separated only by a brief, shallow dip into one human-perceived climb.

The pure signal-processing helpers (resample, smoothing, rolling grade) live in [`app/route/climb-signal.mjs`](app/route/climb-signal.mjs); the fatigue state machine sits in [`app/route/climbs.mjs`](app/route/climbs.mjs). Both are covered by unit tests. Every behavior knob is documented under `climb_detection` in [`app/core/tuning.yaml`](app/core/tuning.yaml); [`scripts/climb_tester.py`](scripts/climb_tester.py) is a standalone CLI that reads the exact same tunables for verbose, step-by-step diagnostics against any GPX file.

### Free client-side terrain elevation

Keeping the camera above the ground needs to know where the ground actually is — but a commercial elevation API, queried at follow-camera rates, would cost real money on every ride. GPX Rider gets the same data for free, entirely in the browser:

- **Public open-data terrain tiles.** It streams Mapzen Terrarium terrain-RGB tiles from the [AWS Open Data](https://registry.opendata.aws/terrain-tiles/) bucket — no API key, no quota, no cost, requested anonymously.
- **Pixel-decoded elevation.** Each tile is an ordinary PNG that packs elevation into its color channels (`elevation = R·256 + G + B/256 − 32768`). The tile is drawn to an offscreen canvas and its pixels are read back into an elevation grid — decoding real ground height with zero server round-trips per query.
- **Synchronous lookups over an async cache.** Decoded tiles are held in an LRU cache, so `terrainElevationAt(lat, lng)` is a cheap per-frame lookup; a cache miss kicks off the tile fetch and returns nothing, and the camera falls back to the route's own elevation until the tile arrives. One tile spans several kilometers, so a whole ride usually stays inside one or two cached tiles — the network is touched only when the rider crosses into a new tile.
- **Safe blending.** The camera lift takes the higher of the route-based estimate and the real terrain, so enabling online terrain can only ever raise the camera clear of a hill, never drop it into one — and turning it off degrades gracefully to the offline estimate.

The pure tile math (Web Mercator coordinates, Terrarium decode) lives in [`app/map/terrain-tiles-math.mjs`](app/map/terrain-tiles-math.mjs) and is unit-tested; the fetch/decode/cache machinery is in [`app/map/terrain-tiles.mjs`](app/map/terrain-tiles.mjs). Every knob — the tile source, zoom, cache size, and attribution — is documented under `terrain_tiles` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### A virtual world from the route alone

The optional virtual world renderer replaces Google's photorealistic map with a landscape synthesized from the GPX itself — no imagery, no elevation service, no key. It is a drop-in for Google's `maps3d` library rather than a second rendering path: a `<gpx-virtual-map-3d>` element with `Map3DElement`'s camera properties, plus three.js stand-ins for `Polyline3DElement`, `Polygon3DElement` and `Model3DElement`. Every camera driver, route line, marker, beacon and HUD overlay writes to it exactly as it writes to Google's map, so the two renderers can be swapped mid-ride.

- **A height field pinned to the road.** Route segments near a point pull the ground toward their own elevation with inverse-distance (Shepard) weights; inside the road's half width the nearest segment dominates completely, so the road sits exactly at the GPX elevation, while two switchback legs blend into one hillside instead of a cliff between them.
- **Relief that grows away from the road.** A Gaussian-smoothed raster of the route elevation sets the regional trend; seeded simplex fBm adds hills whose amplitude is zero on the road, ramps up with distance, and scales with how hilly the route is locally — turning into ridged mountains where the route climbs high. The noise is biased upward, so roads run along valley floors as real roads tend to. The seed comes from the route, so a route always gets the same world.
- **Chunked LOD streamed off the main thread.** The terrain is a quadtree of tiles that split near the camera (and more eagerly where the route crosses, so the floating route line never sinks into coarse ground), built in a module Web Worker. While a tile builds, the display keeps what already covers it — the finer tiles drawn a moment ago when the camera moves away, else the closest loaded ancestor — and the ancestors of everything on screen are never evicted from the cache, so the ground never collapses to a coarse level for a frame. Skirts hide cracks between tiles of different detail.
- **A road that is smooth and solid.** The asphalt follows a centripetal Catmull-Rom spline through the de-jittered track, so every bend is rounded while the curve still passes exactly through the GPX points (averaging would pull hairpins inward). The flat road bed is shaped along that same curve, and the road is a solid strip: a slightly lifted top plus embankments sloping into the ground, with each cross-section clamped to the local bend radius so tight hairpins never fold. A coarse tile's grid is wider than the road bed, so a triangle spanning the road would draw the hillside beside it over the asphalt: grid vertices within 1.5 grid steps of the road are capped at the road's elevation (ground is only ever lowered there), with skirts deep enough to keep seams to coarser neighbors closed and trees placed on the mesh as drawn. What's left — switchback stacks a distant grid can't separate — is covered by a small depth margin that grows with view distance.
- **Real terrain as an option.** The real-world style fetches the free Mapzen Terrarium elevation tiles covering the world (the finest zoom that fits a tile budget) in the tile worker, decode them off the main thread and hand the grids to the main thread too, so both shape the ground from the same data. The road bed still sits on the GPX elevation, flat across a shoulder, and eases into the real ground beside it, a little detail noise fills in below the data's ~13–26 m resolution, and the sea comes from the data's bathymetry.
- **OpenStreetMap on top.** The real-world style adds the place's own buildings, land cover, roads and water — see the next section.
- **Themes, not forks.** A style is a theme (look) × ground source listed in `tuning.yaml`; a theme swaps only materials — lit biome colors, or a dark neon ground shader with a world-aligned glowing grid and elevation contours that fade out where they would shimmer — plus sky, water and road colors. A new look is a new entry.
- **A town without data.** The city look grows a town along the route: an urban band with ragged edges, parks from a noise mask, and buildings on a global block lattice (one per cell, footprints that can't overlap at any angle) facing the road nearby, sitting on their lowest corner and skipping steep ground. A low-frequency "downtown" field keeps most of it low-rise with a tower core. Buildings are instanced boxes whose windows and floors are drawn in the shader, and distant tiles keep only the skyline.
- **The camera rides the road you see.** In the virtual world the follow and first-person cameras take their position, height and heading from the generated road (ride progress mapped monotonically onto the road's centerline), so they stay on the asphalt through every rounded bend; in first person the floating route line is hidden.
- **Ground cover from the same field.** Per-vertex biome colors (meadow, fields, forest floor, alpine pasture, rock on steep slopes, snow above the snowline, lake shores, gravel road shoulders) and instanced low-poly trees on a global jittered lattice, so a tile split never moves a tree.
- **One depth range from the handlebars to the horizon.** A logarithmic depth buffer covers a first-person eye half a meter off the road and mountains 50 km away; route lines get a small view-space pull toward the camera, which leaves their screen position and width unchanged but keeps them clear of slightly-too-coarse distant ground.

The pure modules — [`world-noise.mjs`](app/world/world-noise.mjs), [`world-terrain.mjs`](app/world/world-terrain.mjs), [`world-road.mjs`](app/world/world-road.mjs), [`world-dem.mjs`](app/world/world-dem.mjs), [`world-city.mjs`](app/world/world-city.mjs), [`world-surface.mjs`](app/world/world-surface.mjs), [`world-tiles.mjs`](app/world/world-tiles.mjs) — are unit-tested in [`tests/world.test.mjs`](tests/world.test.mjs); the three.js side is [`virtual-map3d.mjs`](app/world/virtual-map3d.mjs), [`world-themes.mjs`](app/world/world-themes.mjs), [`world-scene.mjs`](app/world/world-scene.mjs), [`world-tile-manager.mjs`](app/world/world-tile-manager.mjs) and [`world-overlays.mjs`](app/world/world-overlays.mjs). Every knob is documented under `virtual_world` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### The real world from OpenStreetMap vector tiles

The *Real world* style draws the actual place around the route: OpenStreetMap buildings, land use and land cover, other roads, rivers and lakes, from free vector tiles in the OpenMapTiles schema served by [OpenFreeMap](https://openfreemap.org) (no key, CORS-enabled, immutable dated URLs, so the browser's HTTP cache is the tile cache). Everything runs in the same tile worker as the terrain and never blocks it: the terrain streams immediately, and each OSM tile that arrives upgrades the ground under it.

- **A hand-rolled vector tile decoder.** Protobuf varints and length-delimited fields → layers, keys/values and the MVT geometry commands (zigzag deltas), with polygon rings grouped by signed area so a merged multipolygon becomes many polygons with their courtyards. Unused layers (points of interest, house numbers — most of a city tile's bytes) are skipped without being parsed.
- **Corridor streaming, nearest first.** Only the zoom-14 tiles within a corridor of the route are loaded (the corridor shrinks until a tile budget fits), through a small pool that always takes the queued tile nearest the camera; the main thread sends its position as the focus.
- **Classes → raster → ground.** Land cover and land use classes map to ground classes in priority order (`tuning.yaml`); each tile's areas are scanline-filled onto a 256² class grid (~6 m cells) with roads stamped at their width and building outlines traced, so even a tiny shed claims its cells. Terrain vertices read their color, forest density and lone-tree chance from it in O(1) — trees grow in mapped woods and parks, never in a house or on a road — and where no tile loaded the synthetic look fills in. Terrain tiles built before the data arrived are marked stale (versioned, so a fresh tile is never rebuilt) and the displayed ones are rebuilt in the background.
- **Water as ground color.** Lakes and rivers are simply the "water" ground class: the terrain is tinted blue there (no trees), and streams and rivers mapped as lines are blue draped ribbons. A separate water surface was tried and dropped — OpenStreetMap's outlines and the ~13–26 m elevation data rarely agree, so a surface either floated above its shore or, lowered to fit, sank into a pit; the color reads well without either. The open sea is the scene's own water plane at sea level.
- **Extruded buildings with earcut.** Each footprint becomes walls per ring edge (oriented by signed area, whatever the source winding) and a roof triangulated with [earcut](https://github.com/mapbox/earcut), sitting on the lowest ground under it and sunk a little, so nothing floats or drowns on a slope. The walls carry their own meters along the ring and above the ground, which the city look's window shader uses for real facades: glass insets per window cell, a darker ground floor, fading to an average tone where the cells shrink below a few pixels.
- **Draped road ribbons.** Other roads and waterways are resampled ribbons whose two edges each take their own ground height (so they follow the cross slope), with fold-free bends from the route road's cross-section code; bridges run straight from end to end. Stretches running along the route's own road are cut out so it isn't drawn twice, and buildings touching it are left out.
- **Meshes on demand.** Building and road meshes exist only for OSM tiles near the camera, requested from the worker nearest first, shown within a distance and evicted least-recently-used — a dense city center still holds 60 fps.

The pure modules — [`world-mvt.mjs`](app/world/world-mvt.mjs), [`world-osm.mjs`](app/world/world-osm.mjs), [`world-osm-raster.mjs`](app/world/world-osm-raster.mjs), [`world-osm-meshes.mjs`](app/world/world-osm-meshes.mjs) — are unit-tested in [`tests/world-osm.test.mjs`](tests/world-osm.test.mjs) (with a test-only tile encoder and one real tile as a fixture); the IO and three.js side is [`world-osm-loader.mjs`](app/world/world-osm-loader.mjs) and [`world-osm-layer.mjs`](app/world/world-osm-layer.mjs). The knobs live under `virtual_world.osm` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### Street imagery frame matching

Showing the right street photo for a moving rider is a matching problem, not a lookup — Mapillary knows where its images are, not where they sit along *your* route or which way you are riding. GPX Rider solves it client-side and provider-agnostically:

- **Grid-cell scan with subdivision.** The route's bounding boxes are searched on a fixed global grid of cells (so responses cache across routes), cells ahead of the rider first; a cell that comes back at the API's result cap is split into quadrants until it fits.
- **Route-distance frame index.** Every image is projected onto the route through a spatial grid of track segments (O(images), not O(images × points)), kept only if it sits on the road and either is a 360° image or faces within a tolerance of the direction of travel, and stored by its distance along the route — the one coordinate the rest of the app already thinks in.
- **Playback plan.** A greedy walk through the index picks the chain of photos to play — at least a minimum step apart (about 10 m, Mapillary's own in-sequence spacing; dense areas carry a frame every meter or two), preferring the same capture sequence, the rider's own uploads and panoramas — then each hop between two photos is classified from their metadata: *parallax* when both sit in the same SfM reconstruction and close together, *cut* otherwise, *gap* when they are too far apart. The plan is cached per route.
- **Opaque frame references.** The index never interprets what a frame *is* — today a Mapillary image id, later a timestamp into the rider's own ride video — and a source/renderer contract keeps the provider swappable without touching planning or fallback.

The pure index lives in [`app/street-view/frame-index.mjs`](app/street-view/frame-index.mjs), the plan in [`app/street-view/playback-plan.mjs`](app/street-view/playback-plan.mjs), the cell geometry in [`app/street-view/scan-boxes.mjs`](app/street-view/scan-boxes.mjs); all are unit-tested, as are the Graph API source ([`app/street-view/mapillary-source.mjs`](app/street-view/mapillary-source.mjs)) and the asset store ([`app/street-view/imagery-store.mjs`](app/street-view/imagery-store.mjs)) against a fake fetch. Every knob is documented under `street_imagery` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### Street imagery rendering

The official MapillaryJS viewer animates between photos on its own clock with an ease-in/ease-out, so a rider's motion could only be approximated by nudging its transition speed. GPX Rider instead renders the photos itself, from the same data the viewer uses, and lets the rider's route position drive every frame:

- **Ported projection, not reinvented.** Each image's SfM pose (an angle-axis rotation plus an east/north/up position), camera model (perspective or fisheye with radial distortion, or equirectangular for 360° images) and per-image proxy mesh are handled exactly as the viewer does — the geodesy, camera math, mesh decoding and clamping rules, and the projective-texturing shaders are ported from MapillaryJS (MIT, see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)) into small pure modules with unit tests, including a self-check that every mesh vertex projects back inside its own photo.
- **Position-driven blending.** A hop between two photos is a fraction along its link: the virtual camera is interpolated between the two poses (position, view direction, up and field of view) in the first photo's frame, the second photo offset by its east/north/up displacement, and the two are blended with the viewer's three-pass order — the new photo as a backdrop, the old one over it, the new one on top at the hop's fraction — so holes in one mesh are filled by the other. Motion is therefore continuous and exactly as fast as the ride; a stopped rider sees a still frame. An optional Catmull-Rom path through the neighboring photos bends the camera smoothly through each one.
- **Cuts and gaps.** Photos from different reconstructions cannot share a camera, so such a hop holds the first photo and cross-fades a snapshot of the last frame over the second; stretches without imagery fade the 3D view back in.
- **Raw WebGL, no dependencies.** Three fragment shaders, a few indexed meshes (a Mapillary proxy mesh is roughly 300 vertices) and a handful of textures — the per-frame cost is a couple of draw calls; thumbnails are decoded off the main thread and prefetched for the next seconds of travel.
- **Local cache.** Plans, photos and meshes are stored in IndexedDB (signed URLs expire, so bytes are cached, never URLs) and evicted least-recently-used past a size cap.

Pure modules: [`sfm-math.mjs`](app/street-view/sfm-math.mjs), [`sfm-camera.mjs`](app/street-view/sfm-camera.mjs), [`sfm-mesh.mjs`](app/street-view/sfm-mesh.mjs), [`sfm-path.mjs`](app/street-view/sfm-path.mjs) (all tested); the WebGL layer in [`sfm-gl.mjs`](app/street-view/sfm-gl.mjs), the shaders in [`sfm-shaders.mjs`](app/street-view/sfm-shaders.mjs), the GPU node cache in [`sfm-nodes.mjs`](app/street-view/sfm-nodes.mjs), the renderer in [`sfm-renderer.mjs`](app/street-view/sfm-renderer.mjs). Knobs live under `street_imagery.renderer` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### Ride replay and in-browser video export

A recorded ride is replayed through the very same movement loop, follow camera and HUD the live ride uses — the replay is simply a third movement source next to pedaling and the simulation — and the video is produced by the browser itself, with no server and no upload.

- **A ride timeline instead of a speed.** [`ride-timeline.mjs`](app/replay/ride-timeline.mjs) turns the file's timestamped samples into ride time with stops squeezed out (a gap longer than the configured maximum during which the rider barely moved is shortened; one the rider rode through keeps its real length), cumulative route distance computed with the same haversine sum as the rendered route so the two can never drift apart, a speed channel derived over a trailing window when the file has none, held sensor channels, and calories integrated from power. Playback asks it where the rider was `elapsed` seconds in; a profile click asks the inverse question.
- **A minimal FIT reader.** [`fit-decode.mjs`](app/replay/fit-decode.mjs) walks the FIT record stream — definition messages, normal and compressed-timestamp headers, developer fields skipped by size — and extracts just the record fields a replay needs. It is tested round-trip against the app's own FIT encoder, so the two halves of the format stay in agreement.
- **An app that owns its clock.** Every time-based motion — the movement loop, the camera chase, transition arcs, the orbits, the HUD cadence — reads one clock ([`clock.mjs`](app/core/clock.mjs)) instead of `performance.now()`. In normal use it is the wall clock; the headless renderer freezes it and advances it by exactly one frame per captured image ([`render-hook.mjs`](app/replay/render-hook.mjs)), so the ride, camera and HUD step deterministically and the video is identical however fast or slow frames are produced. (Chrome's own virtual-time emulation was tried first and does not reliably freeze a page's timers; owning the clock does.)
- **Tab capture as the camera.** The 3D map's WebGL canvas lives in a closed shadow root and cannot be read, so the pixels come from the browser's own tab capture, as for screenshots. The recording view's viewport is drawn whole onto a canvas at the output size and recorded in real time by a `MediaRecorder` ([`video-capture.mjs`](app/map/video-capture.mjs)); the viewport sets the frame's aspect, so nothing at its edges is cropped away, and the browser keeps rendering a captured tab even in the background. Because the frame is what the browser composited, Google's attribution is always in the video. A frame-stepped export — frozen clock, one step per captured frame identified by a color tag, WebCodecs encoding — was built and removed again: a tab capture never delivers more frames than the display refreshes and the map draws, so it topped out at one to two times real time for considerably more machinery.
- **The preview is the recording view.** Rather than a separate preview renderer, the export records theater mode itself, so the overlay toggles, speed and camera you see are exactly what the video contains; the viewport hides the app's own buttons while capturing.
- **The same steps drive a headless renderer.** Opened with `?render=1`, the app publishes the configure/step functions on `window`, and [`render_replay_video.py`](scripts/render_replay_video.py) drives a headless Chromium through them, screenshotting the viewport per step into ffmpeg — for batch renders with no window at all.
- **The ghost rider is two numbers.** [`ghost-race.mjs`](app/replay/ghost-race.mjs) races the same timeline: the moment in the recording where the race joined it and the rider's moving time since, so the ghost's position is the recording's distance at their sum and both gaps come from the timeline's two lookups (distance at a time, time at a distance) — positive when the rider is ahead, and always sharing a sign because the timeline is monotonic in both. A seek keeps the clock and re-aligns the join, so the gap collapses to zero instead of the clock restarting.

Tests: [`ride-timeline.test.mjs`](tests/ride-timeline.test.mjs), [`fit-decode.test.mjs`](tests/fit-decode.test.mjs), [`video-capture.test.mjs`](tests/video-capture.test.mjs), [`strava-link.test.mjs`](tests/strava-link.test.mjs), [`render-command.test.mjs`](tests/render-command.test.mjs), [`ghost-race.test.mjs`](tests/ghost-race.test.mjs). Tuning: the `ride_replay` section of [`tuning.yaml`](app/core/tuning.yaml).

### Two trainer protocols behind one interface

Most modern smart trainers speak the standard Fitness Machine Service (FTMS) over Bluetooth, but the wheel-on Tacx trainers (Flow, Vortex, Bushido, Genius) predate it and expose no FTMS service at all — they tunnel ANT+ FE-C over a vendor Bluetooth service instead. GPX Rider supports both from a single pairing flow:

- **Protocol detection at connect time.** The pairing dialog advertises both services; once a device is chosen, the app inspects which control service it actually exposes and routes to the matching backend — FTMS for KICKR-class trainers, FE-C for Tacx. The rest of the app (movement, grade updates, telemetry, status) talks to one unchanged interface and never learns which protocol is underneath.
- **A hand-rolled ANT+ FE-C codec.** Rather than pull in a dependency, the FE-C wire format is encoded and decoded by hand — the same approach the FIT exporter takes. It builds ANT serial frames (sync byte, length, XOR checksum), encodes the grade as a *Track Resistance* page (page 51, with its −200 %-offset fixed-point grade field), and decodes the trainer's *General FE Data* (speed) and *Specific Trainer Data* (power, cadence) telemetry pages.
- **Framing that adapts to the device.** Some FE-C peripherals wrap their pages in ANT framing and some send them bare; the backend learns which from the first parseable notification and mirrors it — including the ANT channel — on every control write.

The pure framing and page codec is isolated in [`app/trainer/fec.mjs`](app/trainer/fec.mjs) and covered by unit tests for checksums, frame round-tripping, grade encoding across the clamped range, and telemetry decoding. The Bluetooth backend that composes it lives in [`app/trainer/trainer-fec.mjs`](app/trainer/trainer-fec.mjs); protocol detection and routing stay in [`app/trainer/trainer.mjs`](app/trainer/trainer.mjs). The rolling-resistance coefficient sent with each grade command is tunable under `trainer` in [`app/core/tuning.yaml`](app/core/tuning.yaml).

### Architecture

- **Zero build step, vanilla ES modules.** The deployed `app/` directory is static HTML, CSS, JavaScript, and assets; the few third-party libraries are vendored as ES module builds under `app/vendor/` (see `THIRD_PARTY_NOTICES.md`).
- Code is organized by feature: camera, route processing, ride execution, trainer hardware, map rendering, HUD, persistence, gallery, demo mode, and ride replay.
- Pure geometry, routing, climb, ETA, units, FIT encoding and decoding, ride-timeline, and simulation logic is separated from browser and DOM coordination and tested with Node's built-in test runner.
- A deliberately thin `app.js` performs startup and event wiring; it does not contain feature logic.
- Shared mutable application state lives in one documented foundation module.
- Adjustable physics, thresholds, defaults, colors, timings, and paths live in `app/core/tuning.yaml`.
- A central screen manager lays out dynamic HUD components without feature-specific positioning hacks.
- IndexedDB stores routes and long recordings, with `localStorage` as a compatibility fallback.
- The app has no account system, application server, or database backend.

For the complete module map, import boundaries, contributor rules, and browser-verification checklist, see [`AGENTS.md`](AGENTS.md).

## Run locally

```sh
git clone git@github.com:gpx-rider/gpx-rider.github.io.git
cd gpx-rider
make run
```

`make run` starts a no-cache development server and prints two URLs:

- the landing page at `http://127.0.0.1:5173/app/`;
- the application at `http://127.0.0.1:5173/app/app.html`.

Local development of the photorealistic map needs a Google Maps API key with the **Maps JavaScript API** and **Photorealistic 3D Maps** enabled (the virtual world renderer runs without one, minus the minimap). Save the key as a single line in the gitignored `.maps-api-key` file at the repository root, then run `make run`. The development server injects it into the served `app/config.mjs` response without modifying the file on disk. The `MAPS_API_KEY` environment variable is also supported and takes precedence. A Mapillary client token for the street imagery feature works the same way: `.mapillary-token` at the repository root, or the `MAPILLARY_TOKEN` environment variable.

Run the tests with:

```sh
make test
```

Or run the default project check:

```sh
make
```

The default target regenerates derived gallery data and runs the tests. The GitHub Pages deployment performs the same generation before publishing.

## Hosting your own copy

The `app/` directory is a complete static site and can be served from GitHub Pages, Netlify, Vercel, S3, or a machine on your local network. Its entry points are:

- `app/index.html` — public landing page;
- `app/app.html` — GPX Rider application.

The included [GitHub Pages workflow](.github/workflows/deploy-pages.yml) publishes `app/` after regenerating gallery data. To use it in a fork, select **GitHub Actions** as the Pages source in the repository settings.

Self-hosted deployments can request a visitor-supplied Maps key. It is stored in that browser and sent only to Google Maps.

The workflow also bakes in two optional repository secrets: `MAPS_API_KEY` (a referrer-restricted Maps key) and `MAPILLARY_TOKEN` (a Mapillary client token so visitors get street imagery without pasting their own). Without them, visitors supply their own in Settings.

## Data and privacy

GPX Rider has no user accounts and no application backend. Routes, settings, ride progress, sensor preferences, recorded samples, and loaded ride recordings remain in browser storage. A pasted Strava link is only parsed locally; the app never talks to Strava — the export opens in a new tab under your own Strava session. Trainer and heart-rate communication happens directly between the browser and the selected Bluetooth devices.

The hosted application's Maps key is restricted to the GPX Rider domain. Self-hosted installations use their own key.

When **online terrain** is enabled (on by default), the app anonymously fetches free public elevation tiles from the Mapzen/AWS Open Data bucket to sharpen the terrain-aware camera. The requests carry no keys, accounts, or ride data — only the map tile coordinates for the area you are riding, which Google's own 3D imagery already streams for the same area. It can be turned off in Settings › Rendering, in which case the camera falls back to route-only elevation and no tiles are ever requested.

The **virtual world** renderer generates its landscape in the browser from the loaded route and requests no map imagery. Its *Real world* style additionally fetches, while it is shown, the same anonymous public elevation tiles as online terrain for the area around the route, and the OpenStreetMap vector tiles of a corridor around the route from OpenFreeMap (anonymous, no keys — only tile coordinates). The offline styles send nothing at all. Map data © OpenStreetMap contributors (ODbL), © OpenMapTiles, served by OpenFreeMap; the credit is shown on the map while the style is active.

When **street imagery** is enabled (off by default), the app asks Mapillary (owned by Meta) for images in the map grid cells the loaded route passes through, then for the pose and mesh data of the photos it plays and the photos themselves — using the site's or your own client token. No ride data, settings, or account information is sent, and nothing is requested at all while the switch is off. Photos, meshes and route plans are cached in your browser's IndexedDB (Settings shows the size and clears it). Imagery is © its Mapillary contributors under CC BY-SA 4.0; the app credits each image on screen.

## Browser, hardware, and limitations

- The complete visual app and Simulation mode work without cycling hardware.
- Trainer and heart-rate connections require a secure context and a browser with [Web Bluetooth support](https://developer.chrome.com/docs/capabilities/bluetooth). Chrome and Edge are the intended browsers.
- Bluetooth device selection, permissions, and remembered-device access are controlled by the browser. If a saved device is unavailable, select **Connect** again.
- FTMS-compatible trainers are the primary hardware target; wheel-on Tacx trainers are supported through their ANT+ FE-C over Bluetooth protocol. Other proprietary control protocols may still require trainer-specific work.
- Total ascent and descent are calculated from noise-filtered GPX elevation and may differ from another planner or head unit.
- Smart ETA needs about a minute of real pedaling before it trusts the measured pace; until then it projects from current speed.
- Calories are derived from power, or taken from FTMS Expended Energy when an FTMS trainer reports it (FE-C trainers report no energy field, so calories come from power).
- Heart rate comes from a paired strap or, as a fallback, the trainer's own heart-rate field.
- Terrain avoidance uses the route's own elevation as a free offline floor and, when online terrain is enabled, augments it with free public Mapzen/AWS terrain tiles. With online terrain off (or before tiles load), it works best where the route itself follows the hillside.
- Ride replay needs a file with timestamps: a FIT activity or a GPX whose points carry `<time>`. A planned GPX (no timestamps) loads as a normal route with nothing to replay. Video export needs Chrome or Edge (tab capture) and records in real time: the video's length, not the ride's, decides how long it takes, so pick a playback speed accordingly. The tab may be in the background meanwhile, but the browser window must stay open and not minimized. Strava activities cannot be fetched directly (their exports require your Strava login and the API requires server-side OAuth); the card opens Strava's export for you to save and open.
- The offline virtual world styles are invented scenery: only the road follows the GPX (its track and elevation); the hills, forests, lakes, and mountains around it are synthesized to look plausible, not to match the real place. The *Real world* style shows the real ground shape and OpenStreetMap's buildings, land cover, roads and water, with limits: elevation data is ~13–26 m coarse, lakes and rivers are blue ground rather than a water surface, the route's own bridges become embankments (other roads' bridges run straight but have no deck or pillars), tunnels are left out, building heights are OpenStreetMap's (often estimated), OSM data loads only within ~1.5 km of the route (the synthetic look fills in beyond and while tiles load), and in a dense city the buildings around you take a few seconds to appear. Without a Maps key it has no minimap, and switching a route rebuilds its landscape (a fraction of a second; terrain tiles then stream in around the camera).
- Street imagery depends on what Mapillary's contributors have uploaded: coverage is partial (often excellent on famous climbs and in cities, sparse on remote roads), photos vary in age, season, and camera, and gaps show the 3D view. Photos are shown at Mapillary's 1024 px (2048 px for 360°) thumbnail size, the smooth moving-camera transition only works between photos of the same reconstruction (others cross-fade), and the first ride of a route scans and prepares it before playback starts on the road ahead.

## Tested hardware

The primary development and real-ride setup is:

- **Wahoo KICKR v4** — smart trainer (FTMS)
- **Wahoo KICKR v6** - smart trainer
- **Wahoo TICKR** — Bluetooth heart-rate monitor
- **Polar H10** - Bluetooth heart-rate monitor
- **Tacx Flow (smart)** — smart trainer (ANT+ FE-C); verified: pairing, grade/resistance control, and speed and power telemetry.

Other FTMS-compatible trainers and standard Bluetooth heart-rate sensors are expected to work, but this is the reference hardware tested against the app.

Successfully tested another trainer or heart-rate sensor? Please open a pull request to add it to this list, including the exact model, firmware version when available, and the features you verified.

## Routes and gallery

The built-in gallery contains ready-to-ride GPX routes. Each source route lives under `gallery/<route-id>/` with an `export.gpx` and `metadata.json`. Running:

```sh
make gallery-data
```

generates `app/gallery.json`, including descriptions, preview cameras, route statistics, difficulty, and miniature elevation profiles.

To add or refresh a route, open its GPX in the app, position the 3D camera for the preview, complete the **Export to gallery** card, and select **Copy JSON** to produce a `metadata.json` draft. Descriptions support simple Markdown, and gallery previews use live interactive 3D maps.

## Map imagery, routes, and trademarks

GPX Rider uses Google Maps Platform and Google Photorealistic 3D Maps. Google Maps, Google Earth, and related imagery are owned by Google and/or its data providers. Keep all required attribution visible in the app.

The GPX files in this repository are independently created demonstration routes for personal training and testing. They are unofficial and are not affiliated with, endorsed by, or sponsored by any race organizer, venue, mapping provider, equipment manufacturer, or other third party.

Route and place names identify real-world locations only. Third-party trademarks belong to their respective owners.

## Contributing

Issues and pull requests are welcome. Please open an issue before beginning a large architectural or product change so the intended behavior can be discussed first.

GPX Rider is developed through human-directed AI collaboration. Architecture, module ownership, test expectations, and browser-verification procedures are documented in [`AGENTS.md`](AGENTS.md), so changes remain reviewable and reproducible regardless of who—or what—implements them.

Useful contribution areas include additional trainer protocols, real-hardware ride reports, broader browser and device testing, route libraries, import integrations, accessibility, mobile improvements, alternative map-rendering experiments, and more automated tests.

## License

[MIT](LICENSE)
