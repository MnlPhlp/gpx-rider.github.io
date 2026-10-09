// The on-map credit of the virtual world's real-world style: OpenStreetMap /
// OpenMapTiles / OpenFreeMap (ODbL requires it to be visible on the map) and
// the Mapzen elevation tiles, shown in the HUD's left column, bottom, while
// such a style is the map. It stays in screenshots and recordings, like
// Google's own attribution.

import { TERRAIN_TILE_ATTRIBUTION, VIRTUAL_WORLD } from "../core/tuning.mjs";
import { els, state } from "../core/state.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { virtualWorldStyle } from "./map-init.mjs";

export function registerWorldAttributionHud() {
  els.worldAttribution.textContent = `${VIRTUAL_WORLD.osm.attribution} · ${TERRAIN_TILE_ATTRIBUTION}`;
  registerHudComponent({ id: "world-attribution", region: "left", weight: 90, element: els.worldAttribution, align: "end" });
  syncWorldAttribution();
}

// Show the credit exactly while the map draws a real-world style.
export function syncWorldAttribution() {
  const style = virtualWorldStyle(state.mapRenderer);
  els.worldAttribution.hidden = !(state.mapProvider === "virtual" && style?.terrain === "real");
}
