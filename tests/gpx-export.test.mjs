import assert from "node:assert/strict";
import test from "node:test";

import { serializeGpx } from "../app/route/gpx-export.mjs";

// parseGpx needs the browser's DOMParser, so the round trip is checked with
// a tiny regex reader over the serialized text instead.
function readTrackpoints(xml) {
  return [...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">(?:<ele>([^<]+)<\/ele>)?<\/trkpt>/g)]
    .map((match) => ({ lat: Number(match[1]), lng: Number(match[2]), ele: match[3] === undefined ? null : Number(match[3]) }));
}

test("serializeGpx writes a GPX 1.1 track with the route's points and name", () => {
  const xml = serializeGpx(
    [
      { lat: 50.1234567, lng: 14.7654321, ele: 312.26 },
      { lat: 50.1244567, lng: 14.7664321, ele: 315 },
    ],
    { name: "Ještěd <loop> & back" },
  );
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<gpx version="1.1" creator="[^"]+" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1">/);
  assert.ok(xml.includes("<name>Ještěd &lt;loop&gt; &amp; back</name>"));
  const points = readTrackpoints(xml);
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[0].lat - 50.1234567) < 1e-6);
  assert.ok(Math.abs(points[0].lng - 14.7654321) < 1e-6);
  assert.equal(points[0].ele, 312.3);
  assert.equal(points[1].ele, 315);
  assert.ok(xml.trimEnd().endsWith("</gpx>"));
});

test("serializeGpx omits the name and elevation when they are missing", () => {
  const xml = serializeGpx([{ lat: 1, lng: 2 }]);
  assert.ok(!xml.includes("<name>"));
  assert.deepEqual(readTrackpoints(xml), [{ lat: 1, lng: 2, ele: null }]);
});
