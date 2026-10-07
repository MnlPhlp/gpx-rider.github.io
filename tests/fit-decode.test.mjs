import assert from "node:assert/strict";
import test from "node:test";
import { encodeFitActivity } from "../app/ride/fit.mjs";
import { decodeFitActivity, isFitFile } from "../app/replay/fit-decode.mjs";

const START_MS = Date.UTC(2026, 6, 4, 10, 0, 0);

function sampleRide() {
  const startSeconds = START_MS / 1000;
  return {
    samples: [
      { t: startSeconds, lat: 50.087, lng: 14.421, ele: 200, distance: 0, speedKph: 0, powerWatts: 0, heartRateBpm: 90, cadenceRpm: 0 },
      { t: startSeconds + 1, lat: 50.0871, lng: 14.4211, ele: 200.4, distance: 12, speedKph: 25.4, powerWatts: 180, heartRateBpm: 120, cadenceRpm: 88 },
      { t: startSeconds + 2, lat: 50.0872, lng: 14.4212, ele: 200.9, distance: 25, speedKph: null, powerWatts: null, heartRateBpm: null, cadenceRpm: null },
    ],
    summary: {
      startTimeMs: START_MS,
      totalElapsedSeconds: 2,
      totalTimerSeconds: 2,
      totalDistanceMeters: 25,
      totalCalories: 42,
    },
  };
}

test("recognizes the .FIT header signature", () => {
  assert.equal(isFitFile(encodeFitActivity(sampleRide())), true);
  assert.equal(isFitFile(new TextEncoder().encode("<?xml version=\"1.0\"?><gpx></gpx>")), false);
  assert.equal(isFitFile(new Uint8Array(4)), false);
});

test("decoding round-trips the app's own encoder output", () => {
  const ride = sampleRide();
  const { records, sport } = decodeFitActivity(encodeFitActivity(ride));

  assert.equal(records.length, 3);
  assert.equal(sport, 2, "session sport = cycling");

  records.forEach((record, index) => {
    const expected = ride.samples[index];
    assert.equal(record.t, Math.round(expected.t));
    assert.ok(Math.abs(record.lat - expected.lat) < 1e-6, "latitude");
    assert.ok(Math.abs(record.lng - expected.lng) < 1e-6, "longitude");
    assert.ok(Math.abs(record.ele - expected.ele) < 0.11, "altitude (scale 5)");
    assert.ok(Math.abs(record.distance - expected.distance) < 0.011, "distance (scale 100)");
    if (expected.speedKph === null) {
      assert.equal(record.speedKph, null);
      assert.equal(record.powerWatts, null);
      assert.equal(record.heartRateBpm, null);
      assert.equal(record.cadenceRpm, null);
    } else {
      assert.ok(Math.abs(record.speedKph - expected.speedKph) < 0.01, "speed (m/s scale 1000)");
      assert.equal(record.powerWatts, expected.powerWatts);
      assert.equal(record.heartRateBpm, expected.heartRateBpm);
      assert.equal(record.cadenceRpm, expected.cadenceRpm);
    }
  });
});

test("the file_id product name is surfaced", () => {
  const { name } = decodeFitActivity(encodeFitActivity(sampleRide()));
  assert.equal(name, "GPX Rider");
});

test("compressed timestamp headers roll the last timestamp forward", () => {
  // Hand-built stream: a record definition (timestamp + heart rate) and one
  // normal record at FIT time 1000; then a second record definition WITHOUT
  // a timestamp field (as the spec requires for compressed headers) and a
  // compressed-header record whose low 5 bits say "+3" → FIT time 1003.
  const body = [
    0x40, 0x00, 0x00, 20, 0x00, 2, // definition: local 0, little-endian, global 20, 2 fields
    253, 4, 0x86, // timestamp uint32
    3, 1, 0x02, // heart_rate uint8
    0x00, 0xe8, 0x03, 0x00, 0x00, 120, // data: t=1000, hr=120
    0x41, 0x00, 0x00, 20, 0x00, 1, // definition: local 1, global 20, heart rate only
    3, 1, 0x02,
    0x80 | (1 << 5) | ((1003) & 0x1f), 130, // compressed header, local 1, hr=130
  ];
  const header = [14, 0x10, 0x54, 0x08, body.length, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const bytes = Uint8Array.from([...header, ...body, 0, 0]);

  const { records } = decodeFitActivity(bytes);
  assert.equal(records.length, 2);
  assert.equal(records[0].t - records[1].t, -3);
  assert.equal(records[1].heartRateBpm, 130);
  assert.equal(records[1].lat, null);
});

test("developer fields and unknown messages are skipped by size", () => {
  const body = [
    // Definition with a developer field: local 1, global 999 (unknown), 1
    // field (uint8) + 1 developer field of 3 bytes.
    0x61, 0x00, 0x00, 0xe7, 0x03, 1,
    0, 1, 0x02,
    1,
    0, 3, 0,
    // Data for it: 1 + 3 bytes.
    0x21, 7, 1, 2, 3,
    // Then a plain record definition + record so decoding visibly continued.
    0x40, 0x00, 0x00, 20, 0x00, 1,
    4, 1, 0x02,
    0x00, 95,
  ];
  const header = [14, 0x10, 0x54, 0x08, body.length, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const { records } = decodeFitActivity(Uint8Array.from([...header, ...body, 0, 0]));
  assert.equal(records.length, 1);
  assert.equal(records[0].cadenceRpm, 95);
});

test("refuses a non-FIT buffer", () => {
  assert.throws(() => decodeFitActivity(new TextEncoder().encode("hello")));
});
