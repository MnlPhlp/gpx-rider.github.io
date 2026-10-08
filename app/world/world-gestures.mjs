// Mouse/touch camera control on the virtual map, mirroring Google's 3D map
// gestures closely enough that the app's manual-camera capture
// (follow-camera.mjs) works unchanged: drag pans (the look-at point slides
// over the ground and re-settles on the terrain), right-drag / Ctrl- or
// Shift-drag orbits (heading + tilt), the wheel and a two-finger pinch zoom,
// a two-finger twist rotates. The app listens for the same pointer/wheel
// events on the element to know the user is steering.

import { clamp, destinationPoint } from "../core/geo.mjs";

const ORBIT_DEGREES_PER_PIXEL = 0.25;
const WHEEL_ZOOM_RATE = 0.0015;
const MIN_RANGE_METERS = 3;
const MAX_RANGE_METERS = 2_000_000;
const MAX_TILT_DEGREES = 88;

export function bindCameraGestures(map) {
  const pointers = new Map();
  let mode = null;

  map.addEventListener("contextmenu", (event) => event.preventDefault());

  map.addEventListener("pointerdown", (event) => {
    map.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) mode = "pinch";
    else mode = event.button === 1 || event.button === 2 || event.ctrlKey || event.shiftKey ? "orbit" : "pan";
  });

  map.addEventListener("pointermove", (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const now = { x: event.clientX, y: event.clientY };

    if (mode === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const before = { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
      pointers.set(event.pointerId, now);
      const [a2, b2] = [...pointers.values()];
      const after = { dist: Math.hypot(b2.x - a2.x, b2.y - a2.y), angle: Math.atan2(b2.y - a2.y, b2.x - a2.x) };
      if (before.dist > 0 && after.dist > 0) zoomBy(map, before.dist / after.dist);
      map.heading = map.heading - ((after.angle - before.angle) * 180) / Math.PI;
      return;
    }

    pointers.set(event.pointerId, now);
    const dx = now.x - last.x;
    const dy = now.y - last.y;
    if (mode === "orbit") {
      map.heading = map.heading + dx * ORBIT_DEGREES_PER_PIXEL;
      map.tilt = clamp(map.tilt - dy * ORBIT_DEGREES_PER_PIXEL, 0, MAX_TILT_DEGREES);
    } else if (mode === "pan") {
      pan(map, dx, dy);
    }
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (!pointers.size) mode = null;
    else if (mode === "pinch") mode = "pan";
  };
  map.addEventListener("pointerup", release);
  map.addEventListener("pointercancel", release);

  map.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomBy(map, Math.exp(event.deltaY * WHEEL_ZOOM_RATE));
  }, { passive: false });
}

function zoomBy(map, factor) {
  map.range = clamp(map.range * factor, MIN_RANGE_METERS, MAX_RANGE_METERS);
}

// Slide the look-at point so the ground follows the cursor (approximately:
// meters per pixel at the look-at distance, stretched along the view's
// forward direction by the tilt), then re-seat it on the terrain.
function pan(map, dx, dy) {
  const height = Math.max(1, map.clientHeight);
  const metersPerPixel = (2 * map.range * Math.tan(((map.fov || 35) * Math.PI) / 360)) / height;
  const stretch = Math.min(4, 1 / Math.max(0.25, Math.cos((map.tilt * Math.PI) / 180)));
  const right = -dx * metersPerPixel;
  const forward = dy * metersPerPixel * stretch;
  const distance = Math.hypot(right, forward);
  if (distance < 1e-6) return;
  const bearing = map.heading + (Math.atan2(right, forward) * 180) / Math.PI;
  const center = map.center;
  const moved = destinationPoint(center, bearing, distance);
  const ground = map.groundElevationAt(moved.lat, moved.lng);
  map.center = { ...moved, altitude: ground ?? center.altitude };
}
