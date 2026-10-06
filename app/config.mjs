// Baked in at deploy time by .github/workflows/deploy-pages.yml, which
// replaces the values below with repository secrets before uploading the
// site: MAPS_API_KEY (an HTTP referrer-restricted Google Maps key, scoped to
// the Pages origin) and MAPILLARY_TOKEN (a Mapillary *client* token for the
// opt-in street imagery — public by design, like a browser Maps key). Both
// stay empty in this checked-in source and in any local checkout or fork
// without the secrets configured — the app then falls back to asking the
// visitor for their own key/token, exactly as before. A key or token saved
// by a visitor in Settings always takes precedence over these defaults.
//
// Base64-encoded, not encrypted — this is a public webapp, so the values are
// visible in the network tab regardless of anything done here.
const DEPLOYED_MAPS_API_KEY_B64 = "";
const DEPLOYED_MAPILLARY_TOKEN_B64 = "";

function decode(encoded) {
  if (!encoded) return "";
  try {
    return atob(encoded);
  } catch {
    return "";
  }
}

export function deployedMapsApiKey() {
  return decode(DEPLOYED_MAPS_API_KEY_B64);
}

export function deployedMapillaryToken() {
  return decode(DEPLOYED_MAPILLARY_TOKEN_B64);
}
