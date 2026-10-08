// Seeded 2D noise for the virtual world: simplex noise (Gustavson's
// formulation), fractal sums of it (fBm and ridged multifractal), and a small
// integer hash for deterministic per-cell randomness (tree placement). Pure:
// the same seed always builds the same landscape, so a route looks identical
// every time it is opened.

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRADIENTS = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

// A 32-bit integer mix (lowbias32) — good avalanche, cheap.
export function hashInt(value) {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// A uniform [0, 1) value for an integer cell (i, j) and a channel, so several
// independent random numbers can be drawn for the same cell.
export function cellRandom(seed, i, j, channel = 0) {
  return hashInt(seed ^ hashInt(i * 374761393 + hashInt(j * 668265263 + channel * 2246822519))) / 4294967296;
}

// Stable 32-bit seed from any string (e.g. a route's first coordinates).
export function seedFromString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createNoise2D(seed = 1) {
  const perm = new Uint8Array(512);
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;
  let state = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    state = hashInt(state + i);
    const j = state % (i + 1);
    const swap = source[i];
    source[i] = source[j];
    source[j] = swap;
  }
  for (let i = 0; i < 512; i++) perm[i] = source[i & 255];

  // Simplex noise in roughly [-1, 1].
  return function noise2D(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = GRADIENTS[perm[ii + perm[jj]] & 7];
      t0 *= t0;
      n += t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = GRADIENTS[perm[ii + i1 + perm[jj + j1]] & 7];
      t1 *= t1;
      n += t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = GRADIENTS[perm[ii + 1 + perm[jj + 1]] & 7];
      t2 *= t2;
      n += t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * n;
  };
}

// Fractal Brownian motion: octaves of noise, each at double the frequency and
// `gain` the amplitude, normalized back to roughly [-1, 1].
export function fbm(noise, x, y, octaves = 5, gain = 0.5, lacunarity = 2) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * noise(x * frequency + o * 17.13, y * frequency - o * 9.71);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

// Ridged multifractal in [0, 1]: sharp crests where the noise crosses zero,
// each octave weighted by the one before so ridges carry the fine detail and
// valleys stay smooth — the classic look of eroded mountains.
// `sharpness` shapes the crest profile: 2 is the classic knife edge, lower
// values give rounder, more weathered ridges.
export function ridged(noise, x, y, octaves = 5, gain = 0.5, lacunarity = 2, sharpness = 2) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = 1;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * frequency - o * 13.37, y * frequency + o * 7.77));
    n = Math.pow(n, sharpness) * weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amplitude * n;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}
