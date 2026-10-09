// A minimal Mapbox Vector Tile (MVT 2.1) decoder for the virtual world's
// real-world styles, hand-rolled like ride/fit.mjs and street-view/sfm-mesh.mjs
// (no dependency, no DOM — it runs in the tile worker and in Node tests):
// protobuf varints and length-delimited fields → layers with their keys and
// values, feature tags → properties, and geometry commands (MoveTo / LineTo /
// ClosePath with zigzag deltas) → coordinates in tile units (0..extent, y
// down). Polygon rings are grouped into polygons by signed area, as the spec
// defines: an exterior ring has a positive surveyor's-formula area in tile
// coordinates, a hole a negative one, so one merged multipolygon feature
// becomes many polygons, each with its holes.
//
// Coordinates are flat arrays [x0, y0, x1, y1, …] (what earcut and the
// rasterizer take). A feature is
//   { type: 1 | 2 | 3, properties, geometry }
// where geometry is a list of point runs (type 1), a list of lines (type 2),
// or a list of polygons, each a list of rings with the exterior first (type 3).

export const GEOM_POINT = 1;
export const GEOM_LINE = 2;
export const GEOM_POLYGON = 3;

const textDecoder = new TextDecoder();

// bytes (Uint8Array or ArrayBuffer) → { [layerName]: { name, extent, features } }.
// `layers` (optional): names to decode; the features of any other layer are
// skipped without being parsed.
export function decodeMvt(bytes, { layers = null } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const wanted = layers ? new Set(layers) : null;
  const reader = createReader(data);
  const out = {};
  while (reader.pos < data.length) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === 2) {
      const end = reader.lengthEnd();
      const layer = readLayer(reader, end, wanted);
      if (layer) out[layer.name] = layer;
      reader.pos = end;
    } else reader.skip(wire);
  }
  return out;
}

function readLayer(reader, end, wanted) {
  let name = "";
  let extent = 4096;
  const featureRanges = [];
  const keys = [];
  const values = [];
  // A first pass records where the features are; they are decoded once the
  // name says the layer is wanted (and the keys/values are known).
  while (reader.pos < end) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) name = reader.string();
    else if (field === 2 && wire === 2) {
      const featureEnd = reader.lengthEnd();
      featureRanges.push([reader.pos, featureEnd]);
      reader.pos = featureEnd;
    } else if (field === 3 && wire === 2) keys.push(reader.string());
    else if (field === 4 && wire === 2) {
      const valueEnd = reader.lengthEnd();
      values.push(readValue(reader, valueEnd));
      reader.pos = valueEnd;
    } else if (field === 5 && wire === 0) extent = reader.varint();
    else reader.skip(wire);
  }
  if (wanted && !wanted.has(name)) return null;
  const features = featureRanges.map(([start, featureEnd]) => {
    reader.pos = start;
    return readFeature(reader, featureEnd, keys, values);
  });
  return { name, extent, features };
}

function readValue(reader, end) {
  let value = null;
  while (reader.pos < end) {
    const { field, wire } = reader.tag();
    if (field === 1) value = reader.string();
    else if (field === 2) value = reader.float();
    else if (field === 3) value = reader.double();
    else if (field === 4) value = reader.int64();
    else if (field === 5) value = reader.varint();
    else if (field === 6) value = reader.zigzag(reader.varint());
    else if (field === 7) value = reader.varint() !== 0;
    else reader.skip(wire);
  }
  return value;
}

function readFeature(reader, end, keys, values) {
  let type = 0;
  let tags = null;
  let commands = null;
  while (reader.pos < end) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) tags = reader.packed();
    else if (field === 3 && wire === 0) type = reader.varint();
    else if (field === 4 && wire === 2) commands = reader.packed();
    else reader.skip(wire);
  }
  const properties = {};
  if (tags) {
    for (let i = 0; i + 1 < tags.length; i += 2) {
      const key = keys[tags[i]];
      if (key !== undefined) properties[key] = values[tags[i + 1]] ?? null;
    }
  }
  const runs = commands ? decodeCommands(commands) : [];
  const geometry = type === GEOM_POLYGON ? groupRings(runs) : runs;
  return { type, properties, geometry };
}

// Geometry commands → runs of coordinates: each MoveTo starts a new run.
// ClosePath adds nothing (rings are implicitly closed).
function decodeCommands(commands) {
  const runs = [];
  let run = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < commands.length) {
    const command = commands[i] & 7;
    const count = commands[i] >>> 3;
    i++;
    if (command === 1 || command === 2) {
      for (let k = 0; k < count && i + 1 < commands.length; k++) {
        x += zigzag32(commands[i]);
        y += zigzag32(commands[i + 1]);
        i += 2;
        if (command === 1) {
          run = [];
          runs.push(run);
        }
        run?.push(x, y);
      }
    } else if (command !== 7) break;
  }
  return runs.filter((r) => r.length >= 2);
}

// Twice the signed area of a flat ring (surveyor's formula). Positive for an
// exterior ring in tile coordinates (y down), negative for a hole.
export function ringArea2(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  }
  return sum;
}

// Rings → polygons: a positive-area ring opens a polygon, the negative ones
// after it are its holes. Degenerate (zero-area) rings are dropped.
function groupRings(rings) {
  const polygons = [];
  let current = null;
  for (const ring of rings) {
    if (ring.length < 6) continue;
    const area = ringArea2(ring);
    if (area > 0) {
      current = [ring];
      polygons.push(current);
    } else if (area < 0 && current) current.push(ring);
  }
  return polygons;
}

function zigzag32(n) {
  return (n >>> 1) ^ -(n & 1);
}

function createReader(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const reader = {
    pos: 0,
    varint() {
      // Up to 64 bits; values past 2^53 lose precision (never the case for
      // the counts, lengths and ids we read).
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = data[reader.pos++];
        result += shift < 28 ? (byte & 0x7f) << shift : (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte >= 0x80 && reader.pos < data.length);
      return result;
    },
    int64() {
      // Two's complement: a negative int64 is a 10-byte varint. Read the low
      // and high 32 bits separately — as one double the low bits are lost.
      let low = 0;
      let high = 0;
      let shift = 0;
      let byte;
      do {
        byte = data[reader.pos++];
        const bits = byte & 0x7f;
        if (shift < 28) low |= bits << shift;
        else if (shift === 28) {
          low |= (bits & 0x0f) << 28;
          high |= bits >>> 4;
        } else high |= bits << (shift - 32);
        shift += 7;
      } while (byte >= 0x80 && reader.pos < data.length);
      low >>>= 0;
      high >>>= 0;
      if (high & 0x80000000) return -((~high >>> 0) * 2 ** 32 + (~low >>> 0) + 1);
      return high * 2 ** 32 + low;
    },
    zigzag(n) {
      return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
    },
    tag() {
      const value = reader.varint();
      return { field: Math.floor(value / 8), wire: value & 7 };
    },
    lengthEnd() {
      const length = reader.varint();
      return reader.pos + length;
    },
    string() {
      const end = reader.lengthEnd();
      const text = textDecoder.decode(data.subarray(reader.pos, end));
      reader.pos = end;
      return text;
    },
    float() {
      const value = view.getFloat32(reader.pos, true);
      reader.pos += 4;
      return value;
    },
    double() {
      const value = view.getFloat64(reader.pos, true);
      reader.pos += 8;
      return value;
    },
    packed() {
      const end = reader.lengthEnd();
      const out = [];
      while (reader.pos < end) out.push(reader.varint());
      return out;
    },
    skip(wire) {
      if (wire === 0) reader.varint();
      else if (wire === 1) reader.pos += 8;
      else if (wire === 2) reader.pos = reader.lengthEnd();
      else if (wire === 5) reader.pos += 4;
      else throw new Error(`MVT: unsupported wire type ${wire}`);
    },
  };
  return reader;
}
