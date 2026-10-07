import assert from "node:assert/strict";
import test from "node:test";
import { parseStravaActivityId, stravaActivityUrl, stravaExportUrl } from "../app/replay/strava-link.mjs";

test("activity ids parse from the common Strava URL shapes", () => {
  assert.equal(parseStravaActivityId("https://www.strava.com/activities/1234567890"), "1234567890");
  assert.equal(parseStravaActivityId("https://www.strava.com/activities/1234567890/overview"), "1234567890");
  assert.equal(parseStravaActivityId("strava.com/activities/987654321?x=1"), "987654321");
  assert.equal(parseStravaActivityId("  1234567890  "), "1234567890", "bare id");
});

test("anything else is rejected", () => {
  assert.equal(parseStravaActivityId("https://www.strava.com/athletes/42"), null);
  assert.equal(parseStravaActivityId("https://example.com/activities/123456"), null);
  assert.equal(parseStravaActivityId("ride"), null);
  assert.equal(parseStravaActivityId(""), null);
  assert.equal(parseStravaActivityId(null), null);
});

test("export URLs use the template for the original file and the GPX", () => {
  const template = "https://www.strava.com/activities/{id}/{export}";
  assert.equal(stravaExportUrl("55", "original", template), "https://www.strava.com/activities/55/export_original");
  assert.equal(stravaExportUrl("55", "gpx", template), "https://www.strava.com/activities/55/export_gpx");
  assert.equal(stravaActivityUrl("55"), "https://www.strava.com/activities/55");
});
