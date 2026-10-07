// The route trail: in the recording view (theater mode) with the toolbar's
// "Route ahead" hidden, the 3D route line shows only the part the rider has
// already covered, growing behind the rider — the road ahead stays unmarked,
// which makes the rider's position much easier to follow in a video than a
// whole route drawn from the start. The whole-route overview (the intro and
// a manual overview) still shows the full route: there the line *is* the
// information, and the dot alone would frame an empty landscape.
//
// Works on the styled segments route-render.mjs computes for the normal line
// (grade colors and the focused-climb highlight apply to the ridden part as
// usual): segments entirely behind the rider are shown whole, the one the
// rider is on is cut at the rider's interpolated point, the rest are not on
// the map at all. Only that one cut polyline is rebuilt as the rider moves,
// and only every ROUTE_TRAIL_UPDATE_METERS, since re-tessellating a
// Polyline3DElement is not free; a seek backward or a camera-mode switch
// re-evaluates every segment. Owns `state.routeTrail`.

import { interpolateRoutePoint } from "../route/route.mjs";
import { createRouteLine, routeLinePath } from "./route-render.mjs";
import { state } from "../core/state.mjs";
import { ROUTE_TRAIL_UPDATE_METERS } from "../core/tuning.mjs";

// The recording view wants the route cut at the rider.
export function routeTrailEnabled() {
  return state.theaterMode && state.theaterHideRouteAhead;
}

// …except while the whole-route overview frames the route.
function trailCutsRoute() {
  return routeTrailEnabled() && !state.overviewActive && state.cameraMode !== "overview";
}

// Takes over the styled segments of the current route line (from
// renderRouteLines) and shows the part up to the rider.
export function setRouteTrailSegments(segments) {
  clearRouteTrail();
  state.routeTrail = {
    entries: segments
      .filter((segment) => segment.path.length >= 2)
      .map((segment) => ({
        segment,
        startMeters: segment.path[0].distance,
        endMeters: segment.path.at(-1).distance,
        line: null,
        shown: "none", // "none" | "partial" | "full"
      })),
    progressMeters: null,
    cut: null,
  };
  updateRouteTrail({ force: true });
}

export function clearRouteTrail() {
  state.routeTrail?.entries.forEach((entry) => entry.line?.remove());
  state.routeTrail = null;
}

// Per tick (and on camera-mode changes): extends the trail to the rider.
export function updateRouteTrail({ force = false } = {}) {
  const trail = state.routeTrail;
  if (!trail) return;
  const cut = trailCutsRoute();
  const progress = cut ? state.progressMeters : Infinity;
  if (!force && cut === trail.cut
    && (!cut || Math.abs(progress - trail.progressMeters) < ROUTE_TRAIL_UPDATE_METERS)) return;
  trail.cut = cut;
  trail.progressMeters = progress;

  const head = cut ? interpolateRoutePoint(state.route, progress) : null;
  for (const entry of trail.entries) {
    if (entry.endMeters <= progress) {
      showEntry(entry, "full", entry.segment.path);
    } else if (entry.startMeters >= progress) {
      hideEntry(entry);
    } else {
      showEntry(entry, "partial", [...entry.segment.path.filter((point) => point.distance < progress), head]);
    }
  }
}

function showEntry(entry, shown, path) {
  if (entry.shown === "full" && shown === "full") return;
  if (entry.line) {
    entry.line.path = routeLinePath(path);
  } else {
    entry.line = createRouteLine({ ...entry.segment, path });
  }
  entry.shown = shown;
}

function hideEntry(entry) {
  if (entry.shown === "none") return;
  entry.line?.remove();
  entry.line = null;
  entry.shown = "none";
}
