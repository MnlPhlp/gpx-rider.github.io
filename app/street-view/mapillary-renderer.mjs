// MapillaryJS renderer for the street imagery layer: loads the pinned viewer
// script and stylesheet on demand (only once the feature is enabled), owns
// the single Viewer instance, and implements the *renderer* half of the
// provider contract the coordinator (street-view-ui.mjs) talks to:
//
//   renderer: { mount(container) → Promise,
//               showFrame(frame)        — hard cut: start a fresh trajectory at this image
//               queueFrame(frame)       — follow-on image appended behind the running transition
//               pace({ progressMeters, speedMps }) — tracking controller (see below)
//               currentRef()            — ref of the image on screen / being transitioned to
//               setApproach(fraction), setVisible(bool), resize(), unmount() }
//   callbacks: onError(error), onMotion(inMotion)
//
// Continuous, linear motion. The viewer animates image-to-image with an
// ease-in/ease-out curve whenever its trajectory holds fewer than three
// images — which is every plain moveTo. Fed a trajectory one image *ahead*
// instead (queueFrame → the state service's append, the path the viewer's
// own sequence playback uses), the alpha stays linear and the next hop starts
// the instant the previous one ends. pace() then scales the viewer's
// transition speed (its 0–10 coefficient) every tick so each hop finishes
// exactly when the rider reaches that image's position: a tracking
// controller on an estimated alpha, reset on every 'image' event. All of
// that reaches MapillaryJS internals (navigator → stateService/graphService;
// no public API). The version is pinned in tuning.yaml and every call is
// guarded, so a future bundle without them degrades to hard cuts at the
// viewer's native pace instead of breaking. A <video>-based renderer for a
// future "replay my own ride" source would implement the same contract.

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
  // Frames fed to the viewer, by ref, plus the trajectory order from the
  // image currently on screen onward ([current, queued]).
  const nodes = new Map();
  let trajectory = [];
  let current = null;
  let pendingCut = null;
  // Tracking controller state for the hop in progress.
  let motionSpeed = 1;
  let alphaEstimate = 1;
  let lastPaceMs = 0;

  const internals = () => {
    const navigator = viewer?._navigator;
    return {
      stateService: navigator?.stateService,
      graphService: navigator?.graphService,
    };
  };

  function applySpeed(coefficient) {
    const { stateService } = internals();
    if (!stateService || typeof stateService.setSpeed !== "function") return;
    const next = Math.max(0.01, Math.min(10, coefficient));
    if (next === motionSpeed) return;
    motionSpeed = next;
    try {
      stateService.setSpeed(next);
    } catch (error) {
      onError(error);
    }
  }

  // The viewer moved on to the next image of its trajectory (or landed after
  // a hard cut): it is now transitioning toward `ref`.
  function handleImage(ref) {
    current = ref;
    const at = trajectory.indexOf(ref);
    trajectory = at >= 0 ? trajectory.slice(at) : [ref];
    alphaEstimate = 0;
    const node = nodes.get(ref);
    if (node?.isPano && Number.isFinite(node.routeBearingDeg) && Number.isFinite(node.headingDeg)) {
      viewer.setCenter([panoCenterX(node.routeBearingDeg, node.headingDeg), 0.5]);
      viewer.setFieldOfView(config.pano_fov_degrees);
    }
    // Passed images are no longer needed; the viewer's own playback prunes
    // the same way.
    internals().stateService?.clearPriorImages?.();
  }

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
      viewer.on("image", (event) => handleImage(event.image.id));
      viewer.on("movestart", () => onMotion(true));
      viewer.on("moveend", () => onMotion(false));
    },

    currentRef() {
      return current;
    },

    // Hard cut: a fresh trajectory starting at this image (resync after a
    // seek, a gap, or on first show). Superseded moves reject with
    // CancelMapillaryError, which is expected and ignored. Returns true when
    // a move was actually started (false if already there or pending).
    showFrame(frame) {
      if (!viewer || !frame) return false;
      if (frame.ref === current || frame.ref === pendingCut) return false;
      nodes.set(frame.ref, frame);
      pendingCut = frame.ref;
      trajectory = [];
      viewer.moveTo(frame.ref)
        .then(() => {
          if (pendingCut === frame.ref) pendingCut = null;
          if (!trajectory.length) trajectory = [frame.ref];
        })
        .catch((error) => {
          if (pendingCut === frame.ref) pendingCut = null;
          if (error?.name === "CancelMapillaryError") return;
          onError(error);
        });
      return true;
    },

    // Append the image to play after the current one, so the viewer rolls
    // straight into the next hop with no pause and no easing. One image is
    // kept queued beyond the current one; anything else is ignored.
    queueFrame(frame) {
      if (!viewer || !frame || pendingCut || !current) return;
      if (trajectory.length >= 2 || trajectory.includes(frame.ref)) return;
      const { stateService, graphService } = internals();
      if (typeof graphService?.cacheImage$ !== "function" || typeof stateService?.appendImagess !== "function") return;
      nodes.set(frame.ref, frame);
      trajectory.push(frame.ref);
      const expectedCurrent = current;
      try {
        graphService.cacheImage$(frame.ref).subscribe({
          next: (image) => {
            // Still wanted? A hard cut or a different pick may have come in
            // while the image was loading.
            if (pendingCut || current !== expectedCurrent || !trajectory.includes(frame.ref)) return;
            stateService.appendImagess([image]);
          },
          error: (error) => {
            trajectory = trajectory.filter((ref) => ref !== frame.ref);
            onError(error);
          },
        });
      } catch (error) {
        trajectory = trajectory.filter((ref) => ref !== frame.ref);
        onError(error);
      }
    },

    // Tracking controller: scale the viewer's transition speed so the hop in
    // progress (toward `current`) completes exactly when the rider reaches
    // that image's route position. alphaEstimate integrates our own speed
    // setting against the viewer's native hop duration; it is reset at every
    // image event so errors never accumulate across hops.
    pace({ progressMeters, speedMps }) {
      if (!viewer) return;
      const now = performance.now();
      const dt = lastPaceMs ? Math.min(1, (now - lastPaceMs) / 1000) : 0;
      lastPaceMs = now;
      alphaEstimate = Math.min(1, alphaEstimate + (motionSpeed * dt) / config.transition_base_seconds);
      const node = nodes.get(current);
      let coefficient = 1;
      if (node && speedMps >= config.motion_min_speed_mps) {
        const remainingMeters = node.distanceMeters - progressMeters;
        if (remainingMeters <= 0) {
          // The rider is already past this image: catch up as fast as allowed.
          coefficient = config.motion_coefficient_max;
        } else {
          const remainingSeconds = remainingMeters / speedMps;
          coefficient = (config.transition_base_seconds * (1 - alphaEstimate)) / remainingSeconds;
        }
        coefficient = Math.max(config.motion_coefficient_min, Math.min(config.motion_coefficient_max, coefficient));
      }
      applySpeed(coefficient);
    },

    // Experimental approach zoom (off unless approach_zoom_max > 0): zoom
    // into the current photo as the rider closes in on the next one.
    setApproach(fraction) {
      if (!viewer || !current || pendingCut || !(config.approach_zoom_max > 0)) return;
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
      nodes.clear();
      trajectory = [];
      current = null;
      pendingCut = null;
      motionSpeed = 1;
      alphaEstimate = 1;
      lastPaceMs = 0;
    },
  };
}
