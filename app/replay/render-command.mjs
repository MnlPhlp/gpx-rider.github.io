// Builds the command line for the headless video renderer
// (scripts/render_replay_video.py) from the preview's choices — the hidden
// overlays, the playback speed, the camera — so the recording view's
// "Copy render command" button hands over exactly what is on screen. Pure
// string building; the file path is a placeholder because the browser never
// learns where the opened file lives.

export const RENDER_SCRIPT = "scripts/render_replay_video.py";
export const RIDE_FILE_PLACEHOLDER = "<your-ride.fit-or-.gpx>";

// hide: array of overlay keys as the script expects them (clock, meters,
// dock, climb-banner, demo-chip, controls, minimap, route-ahead); camera: "follow" |
// "first-person"; speed: playback multiplier.
export function buildRenderCommand({ hide = [], speed = 1, camera = "follow", rideFile = RIDE_FILE_PLACEHOLDER } = {}) {
  const parts = ["python3", RENDER_SCRIPT, shellQuote(rideFile)];
  if (Number.isFinite(speed) && speed !== 1) parts.push("--speed", String(speed));
  if (camera === "first-person") parts.push("--camera", "first-person");
  const hidden = hide.filter(Boolean);
  if (hidden.length) parts.push("--hide", hidden.join(","));
  return parts.join(" ");
}

// Theater "hide" state flags → the script's overlay keys.
export function hiddenOverlayKeys({
  clock = false,
  meters = false,
  dock = false,
  climbBanner = false,
  demoChip = false,
  controls = false,
  minimap = false,
  routeAhead = false,
} = {}) {
  const keys = [];
  if (clock) keys.push("clock");
  if (meters) keys.push("meters");
  if (dock) keys.push("dock");
  if (climbBanner) keys.push("climb-banner");
  if (demoChip) keys.push("demo-chip");
  if (controls) keys.push("controls");
  if (minimap) keys.push("minimap");
  if (routeAhead) keys.push("route-ahead");
  return keys;
}

function shellQuote(text) {
  return /^[A-Za-z0-9_./<>-]+$/.test(text) ? text : `'${String(text).replaceAll("'", "'\\''")}'`;
}
