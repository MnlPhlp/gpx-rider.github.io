// MapillaryJS renderer for the street imagery layer: loads the pinned viewer
// script and stylesheet on demand (only once the feature is enabled), owns
// the single Viewer instance, and implements the *renderer* half of the
// provider contract the coordinator (street-view-ui.mjs) talks to:
//
//   renderer: { mount(container) → Promise, showFrame(frame, { headingDeg, speedMps }),
//               setMotionSpeed(coefficient), setApproach(fraction), setVisible(bool),
//               resize(), unmount() }
//   plus an `onMotion(inMotion)` callback so the coordinator knows when a
//   transition is running.
//
// setMotionSpeed reaches into MapillaryJS internals (the navigator's state
// service `setSpeed`, a 0–10 coefficient on the traversing animation; the
// viewer has no public API for it). The version is pinned in tuning.yaml and
// the call is guarded, so a future bundle without it degrades to the
// viewer's fixed-pace transitions instead of breaking.
//
// A <video>-based renderer for a future "replay my own ride" source would
// implement the same shape (using speedMps to pace playback; ignored here).
// IO only: no app state — the token and the street_imagery config are passed
// in. Frames are shown by Mapillary image id (frame.ref); for 360° images the
// view is turned to look along the route.

import { panoCenterX } from "./frame-index.mjs";

let viewerLibraryPromise = null;

function loadExternalStylesheet(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    document.head.appendChild(link);
  });
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

// Resolves to the MapillaryJS namespace. A failed load is forgotten so the
// next enable retries instead of staying broken for the session.
export function loadMapillaryViewer(config) {
  if (!viewerLibraryPromise) {
    viewerLibraryPromise = Promise.all([
      loadExternalStylesheet(config.viewer_style_url),
      loadExternalScript(config.viewer_script_url),
    ])
      .then(() => {
        const library = globalThis.mapillary;
        if (!library?.Viewer) throw new Error("MapillaryJS did not initialize.");
        return library;
      })
      .catch((error) => {
        viewerLibraryPromise = null;
        throw error;
      });
  }
  return viewerLibraryPromise;
}

export function createMapillaryRenderer({ token, config, onError = () => {}, onMotion = () => {} }) {
  let viewer = null;
  let container = null;
  let host = null;
  let shownRef = null;
  let pendingRef = null;
  let motionSpeed = 1;

  return {
    id: "mapillary",

    async mount(target) {
      const library = await loadMapillaryViewer(config);
      if (viewer) return;
      container = target;
      // The viewer gets a child of its own: MapillaryJS stamps its
      // `mapillary-viewer` class (position: relative, from its stylesheet)
      // onto whatever container it is given, which would collapse the
      // absolutely positioned layer itself to zero height.
      host = document.createElement("div");
      host.className = "street-imagery-viewer";
      target.appendChild(host);
      viewer = new library.Viewer({
        container: host,
        accessToken: token,
        // The layer is a passive window onto the road: no cover screen, no
        // navigation arrows/sequence strip/zoom/bearing widgets, no input —
        // the ride drives it. Attribution stays on (CC BY-SA credit).
        component: {
          cover: false,
          direction: false,
          sequence: false,
          bearing: false,
          zoom: false,
          keyboard: false,
          pointer: false,
          attribution: true,
        },
      });
      viewer.on("movestart", () => onMotion(true));
      viewer.on("moveend", () => onMotion(false));
    },

    // Scale the viewer's transition animation: 1 is MapillaryJS's own pace,
    // 0.5 takes twice as long, 2 half as long. Re-applied every tick by the
    // coordinator because the viewer resets it on some state changes.
    setMotionSpeed(coefficient) {
      const stateService = viewer?._navigator?.stateService;
      if (!stateService || typeof stateService.setSpeed !== "function") return;
      const next = Math.max(0.01, Math.min(10, coefficient));
      if (next === motionSpeed) return;
      motionSpeed = next;
      try {
        stateService.setSpeed(next);
      } catch (error) {
        onError(error);
      }
    },

    showFrame(frame, { headingDeg = null } = {}) {
      if (!viewer || !frame) return;
      if (frame.ref === shownRef || frame.ref === pendingRef) return;
      pendingRef = frame.ref;
      viewer.moveTo(frame.ref)
        .then(() => {
          if (pendingRef !== frame.ref) return;
          pendingRef = null;
          shownRef = frame.ref;
          if (frame.isPano && Number.isFinite(headingDeg) && Number.isFinite(frame.headingDeg)) {
            viewer.setCenter([panoCenterX(headingDeg, frame.headingDeg), 0.5]);
            viewer.setFieldOfView(config.pano_fov_degrees);
          }
        })
        .catch((error) => {
          if (pendingRef === frame.ref) pendingRef = null;
          // A newer frame superseded this move before it finished — expected
          // whenever the rider outruns the viewer; nothing to report.
          if (error?.name === "CancelMapillaryError") return;
          onError(error);
        });
    },

    // Approach zoom: ease into the current photo as the rider closes in on the
    // next frame's position (fraction 0..1), so the cut to the next image
    // continues the motion instead of jumping. Skipped mid-transition so it
    // never fights the viewer's own navigation animation.
    setApproach(fraction) {
      if (!viewer || !shownRef || pendingRef || !(config.approach_zoom_max > 0)) return;
      viewer.setZoom(Math.max(0, Math.min(1, fraction)) * config.approach_zoom_max);
    },

    setVisible(visible) {
      if (!container) return;
      const show = Boolean(visible);
      if (show && !container.classList.contains("visible")) viewer?.resize();
      container.classList.toggle("visible", show);
    },

    resize() {
      viewer?.resize();
    },

    unmount() {
      container?.classList.remove("visible");
      try {
        viewer?.remove();
      } catch (error) {
        onError(error);
      }
      host?.remove();
      viewer = null;
      container = null;
      host = null;
      shownRef = null;
      pendingRef = null;
      motionSpeed = 1;
    },
  };
}
