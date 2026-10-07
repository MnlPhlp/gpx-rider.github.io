// Strava activity links: recognizes a pasted Strava activity URL (or bare
// activity id) and builds the export URLs Strava serves to the logged-in
// owner of the activity. Pure string handling — the browser cannot fetch an
// activity's file itself (Strava's export endpoints need the rider's own
// login session and send no CORS headers, and the API needs OAuth), so the
// app opens the export URL in a new tab and the rider drops the downloaded
// file back in; the activity id stays attached to the replay as its source.

import { STRAVA_ACTIVITY_EXPORT_URL } from "../core/tuning.mjs";

const ACTIVITY_URL_PATTERN = /strava\.com\/activities\/(\d{3,})/i;
const BARE_ID_PATTERN = /^\s*(\d{6,})\s*$/;

// "https://www.strava.com/activities/1234567890/overview" → "1234567890";
// a bare numeric id is accepted too. Null for anything else.
export function parseStravaActivityId(text) {
  if (typeof text !== "string") return null;
  const urlMatch = ACTIVITY_URL_PATTERN.exec(text);
  if (urlMatch) return urlMatch[1];
  const idMatch = BARE_ID_PATTERN.exec(text);
  return idMatch ? idMatch[1] : null;
}

export function stravaActivityUrl(activityId) {
  return `https://www.strava.com/activities/${activityId}`;
}

// `kind` is "original" (the FIT/TCX file the activity was uploaded as, when
// Strava still has it) or "gpx" (Strava's own GPX export, always available
// for GPS activities). The template lives in tuning.yaml.
export function stravaExportUrl(activityId, kind = "original", template = STRAVA_ACTIVITY_EXPORT_URL) {
  const suffix = kind === "gpx" ? "export_gpx" : "export_original";
  return template.replace("{id}", String(activityId)).replace("{export}", suffix);
}
