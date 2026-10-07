// The app's monotonic clock. Every time-based motion — the movement loop,
// the camera chase, animated overviews, transition arcs, the slow-UI cadence —
// reads `nowMs()` instead of `performance.now()` directly, so the headless
// video renderer (scripts/render_replay_video.py through
// replay/render-hook.mjs) can freeze time and advance it by exactly one
// frame per captured image: the ride, the camera and the HUD then move
// deterministically, independent of how fast frames are actually captured.
// Pure, no imports; in normal use it is a one-line pass-through.

let virtual = null;

export function nowMs() {
  return virtual === null ? performance.now() : virtual;
}

// Switches to a frozen clock starting at the current real time.
export function enableVirtualClock() {
  if (virtual === null) virtual = performance.now();
}

export function isVirtualClock() {
  return virtual !== null;
}

// Moves the frozen clock forward. Returns the new time.
export function advanceVirtualClock(deltaMs) {
  if (virtual === null) enableVirtualClock();
  virtual += Math.max(0, Number(deltaMs) || 0);
  return virtual;
}

// Back to real time. Every loop clamps its next delta, so the jump is safe.
export function disableVirtualClock() {
  virtual = null;
}
