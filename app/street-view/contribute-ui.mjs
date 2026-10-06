// "Contribute your own imagery" guide: the step-by-step dialog that walks a
// rider from capturing a real ride (phone app or action cam + GPX) through
// uploading to Mapillary to riding it back in GPX Rider. The step copy lives
// in app.html; this module wires the dialog's actions — download the loaded
// route as GPX, check the route's coverage, and enable street imagery in
// first person.

import { applyFirstPersonCameraView } from "../camera/camera-ui.mjs";
import { els, state } from "../core/state.mjs";
import { serializeGpx } from "../route/gpx-export.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import {
  formatCoverageSummary,
  renderStreetImageryCoverage,
  syncStreetImageryControls,
} from "./street-view-settings.mjs";
import { applyStreetImagerySetting, ensureRouteCoverage } from "./street-view-ui.mjs";

export function openContributeDialog() {
  const hasRoute = state.route.length >= 2;
  els.contributeDownloadGpxBtn.disabled = !hasRoute;
  els.contributeCheckCoverageBtn.disabled = !hasRoute;
  els.contributeCoverage.textContent = hasRoute ? "—" : "Load a route first.";
  renderStreetImageryCoverage();
  if (!els.contributeDialog.open) els.contributeDialog.showModal();
}

export function closeContributeDialog() {
  if (els.contributeDialog.open) els.contributeDialog.close();
}

export function closeContributeDialogOnBackdrop(event) {
  // A click on the dialog element itself (not its content) is the backdrop.
  if (event.target === els.contributeDialog) closeContributeDialog();
}

export function downloadRouteGpx() {
  if (state.route.length < 2) return;
  const name = state.routeName || "route";
  const xml = serializeGpx(state.route, { name });
  const blob = new Blob([xml], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "route"}.gpx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function checkRouteCoverage() {
  els.contributeCheckCoverageBtn.disabled = true;
  els.contributeCoverage.textContent = "Scanning the route for imagery…";
  try {
    const coverage = await ensureRouteCoverage();
    els.contributeCoverage.textContent = formatCoverageSummary(coverage, state.distanceUnits)
      || "No imagery found along this route yet.";
  } catch (error) {
    const reasons = {
      "no-token": "Save a Mapillary client token in Settings first.",
      "no-route": "Load a route first.",
      "token-error": "Mapillary rejected the token — check it in Settings.",
    };
    els.contributeCoverage.textContent = reasons[error?.message] || "The coverage check failed — try again later.";
  } finally {
    els.contributeCheckCoverageBtn.disabled = state.route.length < 2;
  }
}

export function enableStreetImageryAndRide() {
  state.streetImageryEnabled = true;
  saveSettings();
  syncStreetImageryControls();
  applyStreetImagerySetting();
  closeContributeDialog();
  if (els.settingsDialog.open) els.settingsDialog.close();
  if (state.route.length >= 2) applyFirstPersonCameraView();
}
