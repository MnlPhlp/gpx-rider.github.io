import assert from "node:assert/strict";
import test from "node:test";

import { enrichRoute } from "../app/route/route.mjs";
import {
  candidateFromMapillaryImage,
  routeScanCells,
  subdivideCell,
} from "../app/street-view/scan-boxes.mjs";

// A straight 2 km route heading north at ~111 m spacing.
const northRoute = enrichRoute(
  // Latitudes deliberately avoid exact grid-cell boundaries (multiples of 0.005).
  Array.from({ length: 19 }, (_, i) => ({ lat: 50.0003 + i * 0.001, lng: 14.4013, ele: 300 })),
);

const CELL = 0.005;

function cellContains(cell, point) {
  return point.lng >= cell.minLon && point.lng < cell.maxLon && point.lat >= cell.minLat && point.lat < cell.maxLat;
}

test("routeScanCells covers every route point with small grid cells", () => {
  const cells = routeScanCells(northRoute, { cellSizeDegrees: CELL });
  assert.ok(cells.length >= 3, `expected several cells along 2 km, got ${cells.length}`);
  for (const point of northRoute) {
    assert.ok(cells.some((cell) => cellContains(cell, point)), `point at ${point.lat} not covered`);
  }
  for (const cell of cells) {
    const area = (cell.maxLon - cell.minLon) * (cell.maxLat - cell.minLat);
    assert.ok(area < 0.01, "Mapillary bbox area limit is 0.01 deg²");
    assert.equal(cell.depth, 0);
    assert.equal(typeof cell.key, "string");
  }
  const keys = new Set(cells.map((cell) => cell.key));
  assert.equal(keys.size, cells.length, "cells are unique");
});

test("routeScanCells orders cells lookahead-first from the rider's position", () => {
  const cells = routeScanCells(northRoute, { cellSizeDegrees: CELL, startMeters: 1000 });
  const rider = northRoute.find((point) => point.distance >= 1000);
  assert.ok(cellContains(cells[0], rider), "the cell under the rider comes first");
  // Everything ahead of the rider precedes everything behind.
  const ahead = cells.filter((cell) => cell.exitMeters >= 1000);
  const behind = cells.filter((cell) => cell.exitMeters < 1000);
  assert.ok(behind.length >= 1 && ahead.length >= 1);
  assert.deepEqual(cells.slice(0, ahead.length).map((cell) => cell.key), ahead.map((cell) => cell.key));
});

test("routeScanCells pulls in the neighbor cell when a point sits near a cell edge", () => {
  const nearEdge = enrichRoute([
    { lat: 50.0049, lng: 14.4013, ele: 0 },
    { lat: 50.0048, lng: 14.4013, ele: 0 },
  ]);
  const without = routeScanCells(nearEdge, { cellSizeDegrees: CELL });
  const withMargin = routeScanCells(nearEdge, { cellSizeDegrees: CELL, marginDegrees: 0.0003 });
  assert.equal(without.length, 1);
  assert.equal(withMargin.length, 2);
});

test("subdivideCell splits a cell into four quadrants covering the parent", () => {
  const [cell] = routeScanCells(northRoute, { cellSizeDegrees: CELL });
  const quadrants = subdivideCell(cell);
  assert.equal(quadrants.length, 4);
  const area = quadrants.reduce((sum, q) => sum + (q.maxLon - q.minLon) * (q.maxLat - q.minLat), 0);
  assert.ok(Math.abs(area - (cell.maxLon - cell.minLon) * (cell.maxLat - cell.minLat)) < 1e-12);
  for (const q of quadrants) {
    assert.equal(q.depth, cell.depth + 1);
    assert.ok(q.key.startsWith(cell.key));
    assert.ok(q.minLon >= cell.minLon && q.maxLon <= cell.maxLon);
    assert.ok(q.minLat >= cell.minLat && q.maxLat <= cell.maxLat);
  }
  const corners = [
    [cell.minLon, cell.minLat], [cell.maxLon - 1e-9, cell.minLat],
    [cell.minLon, cell.maxLat - 1e-9], [cell.maxLon - 1e-9, cell.maxLat - 1e-9],
  ];
  for (const [lon, lat] of corners) {
    assert.ok(quadrants.some((q) => lon >= q.minLon && lon < q.maxLon && lat >= q.minLat && lat < q.maxLat));
  }
});

test("candidateFromMapillaryImage maps the Graph API shape and prefers the computed heading", () => {
  const candidate = candidateFromMapillaryImage({
    id: "123",
    geometry: { type: "Point", coordinates: [14.4, 50.0] },
    compass_angle: 10,
    computed_compass_angle: 12.5,
    is_pano: false,
    sequence: "seq-1",
    captured_at: 1700000000000,
    creator: { id: "9", username: "rider" },
  });
  assert.deepEqual(candidate, {
    lat: 50.0,
    lng: 14.4,
    headingDeg: 12.5,
    isPano: false,
    sequenceId: "seq-1",
    capturedAt: 1700000000000,
    creator: "rider",
    ref: "123",
  });
  const bare = candidateFromMapillaryImage({ id: "5", geometry: { coordinates: [1, 2] }, compass_angle: 90 });
  assert.equal(bare.headingDeg, 90);
  assert.equal(bare.isPano, false);
  assert.equal(bare.sequenceId, null);
  assert.equal(bare.creator, null);
  assert.equal(candidateFromMapillaryImage({ id: "x" }), null);
});
