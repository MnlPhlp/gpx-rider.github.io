// Minimal Garmin FIT activity decoder — the read side of ride/fit.mjs. It
// walks the FIT record stream (definition messages, normal and compressed-
// timestamp data headers, developer fields skipped by size) and pulls out
// what a ride replay needs: the `record` messages' timestamp, position,
// altitude, distance, speed, power, heart rate and cadence, plus the sport
// from the session message. Everything else is skipped by its declared size,
// so files from any head unit decode as long as they are well-formed.
//
// Pure: no DOM, no app state. Returns
//   { records: [{ t (unix seconds), lat, lng, ele, distance, speedKph,
//                 powerWatts, heartRateBpm, cadenceRpm }], sport, name }
// with null for fields a record does not carry. Records without a position
// are kept (a tunnel gap still advances time); callers decide what to drop.

const FIT_EPOCH_OFFSET_SECONDS = 631065600; // 1989-12-31T00:00:00Z
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

const GLOBAL_MSG = { fileId: 0, session: 18, record: 20, sport: 12 };

// Base type number (low 5 bits of the base type byte) → byte size.
const BASE_TYPE_SIZE = {
  0x00: 1, // enum
  0x01: 1, // sint8
  0x02: 1, // uint8
  0x03: 2, // sint16
  0x04: 2, // uint16
  0x05: 4, // sint32
  0x06: 4, // uint32
  0x07: 1, // string
  0x08: 4, // float32
  0x09: 8, // float64
  0x0a: 1, // uint8z
  0x0b: 2, // uint16z
  0x0c: 4, // uint32z
  0x0d: 1, // byte
  0x0e: 8, // sint64
  0x0f: 8, // uint64
  0x10: 8, // uint64z
};

// Record (global 20) fields: number → { key, scale, offset }. Enhanced
// fields (73 speed, 78 altitude) carry the same quantity with more range;
// they win over the plain ones when both are present.
const RECORD_FIELDS = {
  253: { key: "timestamp" },
  0: { key: "lat", semicircles: true },
  1: { key: "lng", semicircles: true },
  2: { key: "ele", scale: 5, offset: 500 },
  78: { key: "ele", scale: 5, offset: 500, enhanced: true },
  5: { key: "distance", scale: 100 },
  6: { key: "speedMps", scale: 1000 },
  73: { key: "speedMps", scale: 1000, enhanced: true },
  7: { key: "powerWatts" },
  3: { key: "heartRateBpm" },
  4: { key: "cadenceRpm" },
};

export function isFitFile(bytes) {
  const view = toUint8(bytes);
  if (view.length < 12) return false;
  const headerSize = view[0];
  return headerSize >= 12 && String.fromCharCode(view[8], view[9], view[10], view[11]) === ".FIT";
}

export function decodeFitActivity(bytes) {
  const data = toUint8(bytes);
  if (!isFitFile(data)) throw new Error("Not a FIT file.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const headerSize = data[0];
  const dataSize = view.getUint32(4, true);
  const end = Math.min(data.length, headerSize + dataSize);

  const definitions = new Map();
  const records = [];
  let sport = null;
  let name = null;
  let lastTimestamp = null;
  let offset = headerSize;

  while (offset < end) {
    const header = data[offset];
    offset += 1;

    const compressed = (header & 0x80) !== 0;
    const isDefinition = !compressed && (header & 0x40) !== 0;
    const hasDeveloperData = !compressed && (header & 0x20) !== 0;
    const localType = compressed ? (header >> 5) & 0x03 : header & 0x0f;

    if (isDefinition) {
      const definition = readDefinition(data, view, offset, hasDeveloperData);
      definitions.set(localType, definition);
      offset = definition.nextOffset;
      continue;
    }

    const definition = definitions.get(localType);
    if (!definition) throw new Error(`FIT data message uses undefined local type ${localType}.`);

    const values = readValues(view, offset, definition);
    offset += definition.size;

    let timestamp = values.get(253) ?? null;
    if (compressed && lastTimestamp !== null) {
      // Compressed headers carry the low 5 bits of the timestamp; roll the
      // last full timestamp forward to the matching value.
      const low = header & 0x1f;
      timestamp = lastTimestamp - (lastTimestamp & 0x1f) + low;
      if (timestamp < lastTimestamp) timestamp += 0x20;
    }
    if (timestamp !== null) lastTimestamp = timestamp;

    if (definition.globalMsg === GLOBAL_MSG.record) {
      records.push(recordFromValues(values, timestamp));
    } else if (definition.globalMsg === GLOBAL_MSG.session) {
      if (values.has(5)) sport = values.get(5);
    } else if (definition.globalMsg === GLOBAL_MSG.fileId) {
      const productName = values.get(8);
      if (typeof productName === "string" && productName) name = productName;
    }
  }

  return { records, sport, name };
}

function readDefinition(data, view, offset, hasDeveloperData) {
  const littleEndian = data[offset + 1] === 0;
  const globalMsg = littleEndian ? view.getUint16(offset + 2, true) : view.getUint16(offset + 2, false);
  const fieldCount = data[offset + 4];
  let cursor = offset + 5;
  const fields = [];
  let size = 0;
  for (let i = 0; i < fieldCount; i += 1) {
    const number = data[cursor];
    const fieldSize = data[cursor + 1];
    const baseType = data[cursor + 2] & 0x1f;
    fields.push({ number, size: fieldSize, baseType });
    size += fieldSize;
    cursor += 3;
  }
  if (hasDeveloperData) {
    const developerFieldCount = data[cursor];
    cursor += 1;
    for (let i = 0; i < developerFieldCount; i += 1) {
      // Developer fields are opaque here: only their size matters so the data
      // message can be stepped over.
      size += data[cursor + 1];
      cursor += 3;
    }
  }
  return { globalMsg, littleEndian, fields, size, nextOffset: cursor };
}

function readValues(view, offset, definition) {
  const values = new Map();
  let cursor = offset;
  for (const field of definition.fields) {
    const value = readField(view, cursor, field, definition.littleEndian);
    if (value !== null) values.set(field.number, value);
    cursor += field.size;
  }
  return values;
}

// Reads one field, returning null for the base type's "invalid" sentinel,
// an array for multi-element fields, and a string for strings.
function readField(view, offset, field, littleEndian) {
  const elementSize = BASE_TYPE_SIZE[field.baseType] ?? 1;
  if (field.baseType === 0x07) {
    let text = "";
    for (let i = 0; i < field.size; i += 1) {
      const byte = view.getUint8(offset + i);
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text || null;
  }
  const count = Math.max(1, Math.floor(field.size / elementSize));
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    const value = readScalar(view, offset + i * elementSize, field.baseType, littleEndian);
    if (value !== null) elements.push(value);
  }
  if (!elements.length) return null;
  return count === 1 ? elements[0] : elements;
}

function readScalar(view, offset, baseType, littleEndian) {
  switch (baseType) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0d: { // byte
      const value = view.getUint8(offset);
      return value === 0xff ? null : value;
    }
    case 0x0a: { // uint8z
      const value = view.getUint8(offset);
      return value === 0 ? null : value;
    }
    case 0x01: { // sint8
      const value = view.getInt8(offset);
      return value === 0x7f ? null : value;
    }
    case 0x03: { // sint16
      const value = view.getInt16(offset, littleEndian);
      return value === 0x7fff ? null : value;
    }
    case 0x04: { // uint16
      const value = view.getUint16(offset, littleEndian);
      return value === 0xffff ? null : value;
    }
    case 0x0b: { // uint16z
      const value = view.getUint16(offset, littleEndian);
      return value === 0 ? null : value;
    }
    case 0x05: { // sint32
      const value = view.getInt32(offset, littleEndian);
      return value === 0x7fffffff ? null : value;
    }
    case 0x06: { // uint32
      const value = view.getUint32(offset, littleEndian);
      return value === 0xffffffff ? null : value;
    }
    case 0x0c: { // uint32z
      const value = view.getUint32(offset, littleEndian);
      return value === 0 ? null : value;
    }
    case 0x08: { // float32
      const value = view.getFloat32(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    }
    case 0x09: { // float64
      const value = view.getFloat64(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    }
    case 0x0e: // sint64
    case 0x0f: // uint64
    case 0x10: { // uint64z
      const value = Number(baseType === 0x0e
        ? view.getBigInt64(offset, littleEndian)
        : view.getBigUint64(offset, littleEndian));
      return Number.isFinite(value) ? value : null;
    }
    default:
      return null;
  }
}

function recordFromValues(values, timestamp) {
  const record = {
    t: timestamp === null ? null : timestamp + FIT_EPOCH_OFFSET_SECONDS,
    lat: null,
    lng: null,
    ele: null,
    distance: null,
    speedKph: null,
    powerWatts: null,
    heartRateBpm: null,
    cadenceRpm: null,
  };
  const enhancedSeen = new Set();
  for (const [number, spec] of Object.entries(RECORD_FIELDS)) {
    const raw = values.get(Number(number));
    if (raw === undefined || Array.isArray(raw)) continue;
    if (spec.key === "timestamp") continue;
    if (enhancedSeen.has(spec.key) && !spec.enhanced) continue;
    let value = raw;
    if (spec.semicircles) value = raw * SEMICIRCLES_TO_DEGREES;
    if (spec.scale) value = raw / spec.scale;
    if (spec.offset) value -= spec.offset;
    if (spec.key === "speedMps") {
      record.speedKph = value * 3.6;
    } else {
      record[spec.key] = value;
    }
    if (spec.enhanced) enhancedSeen.add(spec.key);
  }
  return record;
}

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint8Array.from(bytes);
}
