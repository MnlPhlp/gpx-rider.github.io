// Street imagery settings panel: reads the switch, token and username inputs
// into state, persists and applies them, writes state back into the inputs,
// and renders the coverage/token readouts (shared with the contribute
// dialog's coverage line). The behavior itself lives in street-view-ui.mjs.

import { els, state } from "../core/state.mjs";
import { STREET_IMAGERY } from "../core/tuning.mjs";
import { formatDistance } from "../core/units.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import {
  applyStreetImagerySetting,
  refreshStreetImageryCoverage,
  resolveMapillaryToken,
} from "./street-view-ui.mjs";

export function updateStreetImagerySettingsFromControls() {
  const usernameChanged = state.mapillaryUsername !== els.mapillaryUsernameInput.value.trim();
  state.streetImageryEnabled = els.streetImageryInput.checked;
  state.mapillaryUsername = els.mapillaryUsernameInput.value.trim().slice(0, 128);
  saveSettings();
  applyStreetImagerySetting();
  if (usernameChanged) refreshStreetImageryCoverage();
}

export function saveMapillaryToken() {
  state.mapillaryToken = els.mapillaryTokenInput.value.trim().slice(0, 256);
  els.mapillaryTokenInput.value = state.mapillaryToken;
  saveSettings();
  applyStreetImagerySetting();
}

export function syncStreetImageryControls() {
  els.streetImageryInput.checked = state.streetImageryEnabled;
  els.mapillaryTokenInput.value = state.mapillaryToken;
  els.mapillaryUsernameInput.value = state.mapillaryUsername;
  renderStreetImageryCoverage();
}

// "94% of this route · 1,208 images · 12 yours · longest gap 0.3 km"
export function formatCoverageSummary(coverage, distanceUnits) {
  if (!coverage) return "";
  const parts = [
    `${Math.round(coverage.percent)}% of this route`,
    `${coverage.frames.toLocaleString()} image${coverage.frames === 1 ? "" : "s"}`,
  ];
  if (state.mapillaryUsername) parts.push(`${coverage.own.toLocaleString()} yours`);
  if (coverage.frames) parts.push(`longest gap ${formatDistance(coverage.longestGapMeters, distanceUnits)}`);
  return parts.join(" · ");
}

// The settings panel's two readouts: where the token comes from, and how much
// of the loaded route has usable imagery (also mirrored into the contribute
// dialog while it is open).
export function renderStreetImageryCoverage() {
  const si = state.streetImagery;
  const token = resolveMapillaryToken();

  let tokenNote;
  if (si.status === "token-error") tokenNote = "Mapillary rejected this token — check it in your developer dashboard.";
  else if (state.mapillaryToken) tokenNote = "Using your token (stored only in this browser).";
  else if (token) tokenNote = "Using this site's built-in token; paste your own to override it.";
  else tokenNote = "No token yet — street imagery stays off until one is saved.";
  els.mapillaryTokenNote.textContent = tokenNote;

  let coverageText;
  if (!state.streetImageryEnabled && !si.coverage) {
    coverageText = "Turn it on (or run the coverage check in the contribute guide) to see how much of the loaded route has imagery.";
  } else if (!token) {
    coverageText = STREET_IMAGERY.chip_no_token;
  } else if (state.route.length < 2) {
    coverageText = "Load a route to check its coverage.";
  } else if (si.status === "token-error") {
    coverageText = STREET_IMAGERY.chip_token_rejected;
  } else if (!si.scanDone) {
    const percent = si.scan.total ? Math.round((si.scan.done / si.scan.total) * 100) : 0;
    coverageText = `Scanning the route for imagery… ${percent}%`;
  } else {
    coverageText = formatCoverageSummary(si.coverage, state.distanceUnits) || "No imagery found along this route.";
  }
  els.streetImageryCoverage.textContent = coverageText;
  if (els.contributeDialog.open) els.contributeCoverage.textContent = coverageText;
}
