// Frame tags: a step index encoded as a color and read back from a captured
// frame, so the stepped video export knows exactly which app state a tab-
// capture frame shows (the capture pipeline has a latency of a few display
// frames, and guessing it means duplicated or skipped frames). Each channel
// carries two bits as one of four well-separated levels, so the round trip
// through the compositor and the capture's color conversion (which nudges
// values by a few units) still decodes exactly. 64 tags cycle, which is far
// more than the pipeline's latency in frames. Pure; tested.

const LEVELS = [0, 85, 170, 255];
export const FRAME_TAG_COUNT = 64;

// 0..63 → "rgb(r, g, b)" with each channel on one of four levels.
export function encodeFrameTag(tag) {
  const value = ((Math.round(tag) % FRAME_TAG_COUNT) + FRAME_TAG_COUNT) % FRAME_TAG_COUNT;
  const r = LEVELS[(value >> 4) & 3];
  const g = LEVELS[(value >> 2) & 3];
  const b = LEVELS[value & 3];
  return `rgb(${r}, ${g}, ${b})`;
}

// Sampled pixel → tag (0..63). Each channel snaps to the nearest level, so a
// channel may drift up to ±42 before it is misread.
export function decodeFrameTag(r, g, b) {
  return (nearestLevel(r) << 4) | (nearestLevel(g) << 2) | nearestLevel(b);
}

function nearestLevel(value) {
  const clamped = Math.min(255, Math.max(0, Number(value) || 0));
  return Math.min(3, Math.round(clamped / 85));
}
