// GPX Rider's own street imagery renderer: shows Mapillary photos the way
// the official viewer does — each photo projected onto its reconstructed
// proxy mesh, a virtual camera moving from one photo's pose to the next with
// the two photos blended — but driven by the rider's route position instead
// of a clock, so motion is continuous and exactly as fast as the ride. It
// implements the *renderer* half of the street imagery contract:
//
//   createSfmRenderer({ store, config, sampleInputs, onError })
//   renderer: { mount(container) → Promise, setPlan(plan), setActive(bool),
//               setVisible(bool), currentRef(), isShowing(), resize(), unmount() }
//   (active = keep rendering frames; visible = the layer is shown — the
//    coordinator shows it once isShowing() reports a drawn photo)
//   sampleInputs(): { progressMeters, speedMps, routeBearingDeg, debug }  — read every frame
//
// Per frame: playback-plan.mjs maps the progress onto a link (a → b, fraction
// s) of the plan; the two images' GPU nodes (transform, geometry, texture —
// sfm-nodes.mjs loads and evicts them, prefetched ahead) are drawn in the
// viewer's order — b as a backdrop, a over it, b again at opacity s — from a
// camera interpolated between the two poses (position, view direction, up,
// field of view) in a's frame, b offset by its east/north/up displacement.
// A "cut" link (unrelated reconstructions) holds a's pose, then cross-fades
// a snapshot of the last frame over b. A missing image is never shown as
// black: the hop waits on the last ready node. Browser only.
//
// Ported ideas from MapillaryJS 4.1.2 (MIT, © Mapillary): the pass order of
// ImageGLRenderer, the camera lerp of TraversingState. See THIRD_PARTY_NOTICES.md.

import { chainPositionAt, prefetchWindow } from "./playback-plan.mjs";
import { isSpherical, verticalFovDegrees } from "./sfm-camera.mjs";
import { createSfmGl } from "./sfm-gl.mjs";
import { createNodeCache } from "./sfm-nodes.mjs";
import { geodeticToEnu, mat4Identity, mat4LookAtView, mat4Multiply, mat4Perspective, mat4Translation, vec3Add } from "./sfm-math.mjs";
import { bearingDirection, cameraAlongLink } from "./sfm-path.mjs";

const NEAR_METERS = 0.1;
const FAR_METERS = 10000;

export function createSfmRenderer({ store, config, sampleInputs, onError = () => {} }) {
  const c = config.renderer;
  const reach = { maxBehindMeters: config.max_behind_meters, maxAheadMeters: config.max_ahead_meters };
  let container = null;
  let canvas = null;
  let attribution = null;
  let gl = null;
  let plan = null;
  let frameId = 0;
  let active = false;
  let viewport = { width: 1, height: 1, aspect: 1 };
  // Playback state.
  let shown = null; // { current, old } refs drawn last frame
  let alphaOld = 0;
  let cutFading = false;
  let currentRef = null;
  let showing = false;
  let frameCounter = 0;

  const cache = createNodeCache({ store, config, gl: () => gl, onError, debug: () => sampleInputs()?.debug });
  const nodeFor = (index) => cache.nodeAt(plan, index);
  const isReady = (node) => Boolean(node && node.status === "ready");

  function prefetch(position, inputs) {
    const wanted = prefetchWindow(plan, position, {
      progressMeters: inputs.progressMeters,
      speedMps: inputs.speedMps,
      seconds: c.prefetch_seconds,
      minLinks: c.prefetch_min_links,
    });
    for (const index of wanted) cache.load(plan, index, frameCounter);
    const keep = new Set(wanted);
    if (position.a > 0) keep.add(position.a - 1);
    cache.evict(keep, c.max_gpu_nodes);
  }

  function fovFor(node, aspect) {
    const key = aspect.toFixed(4);
    let fov = node.fov.get(key);
    if (fov == null) {
      fov = isSpherical(node.transform.cameraType)
        ? config.pano_fov_degrees
        : verticalFovDegrees(node.transform, aspect, { mode: c.fov_mode, fillFactor: c.fov_fill_factor });
      node.fov.set(key, fov);
    }
    return fov;
  }

  // East/north/up displacement of node b from node a (both at their own
  // optical centers).
  function offsetBetween(a, b) {
    return geodeticToEnu(b.meta.lng, b.meta.lat, b.meta.altitude ?? 0, a.meta.lng, a.meta.lat, a.meta.altitude ?? 0);
  }

  function directionOf(node, inputs) {
    return isSpherical(node.transform.cameraType) ? bearingDirection(inputs.routeBearingDeg) : node.direction;
  }

  function drawNode(node, modelMatrix, viewProjection, opacity) {
    const t = node.transform;
    gl.drawImage({
      geometry: node.geometry,
      texture: node.texture,
      cameraType: t.cameraType,
      projectorMat: isSpherical(t.cameraType) ? t.rt : t.basicRt,
      modelMatrix,
      viewProjection,
      opacity,
      focal: t.focal,
      k1: t.k1,
      k2: t.k2,
      scaleX: t.scaleX,
      scaleY: t.scaleY,
      radialPeak: t.radialPeak,
    });
  }

  // Pose of a node in the frame of `origin` (its own frame when origin is itself).
  function poseOf(node, origin, inputs) {
    return {
      position: node === origin ? [0, 0, 0] : offsetBetween(origin, node),
      direction: directionOf(node, inputs),
      up: node.transform.up,
      fov: fovFor(node, viewport.aspect),
    };
  }

  // Camera between a and b at fraction s (sfm-path.mjs), with the
  // parallax-linked neighbors as spline supports when smoothing is on.
  function cameraBetween(a, b, s, position, inputs) {
    const supports = {};
    if (c.path_smoothing === "catmull") {
      const before = plan.links[position.a - 1]?.kind === "parallax" ? nodeFor(position.a - 1) : null;
      const after = plan.links[position.b]?.kind === "parallax" ? nodeFor(position.b + 1) : null;
      if (isReady(before)) supports.before = poseOf(before, a, inputs);
      if (isReady(after)) supports.after = poseOf(after, a, inputs);
    }
    return cameraAlongLink(poseOf(a, a, inputs), poseOf(b, a, inputs), s, { smoothing: c.path_smoothing, ...supports });
  }

  function staticCamera(node, inputs) {
    const pose = poseOf(node, node, inputs);
    return { eye: pose.position, direction: pose.direction, up: pose.up, fov: pose.fov };
  }

  function viewProjectionFor({ eye, direction, up, fov }) {
    const view = mat4LookAtView(eye, vec3Add(eye, direction), up);
    return mat4Multiply(mat4Perspective(fov, viewport.aspect, NEAR_METERS, FAR_METERS), view);
  }

  // The viewer's pass order: current as backdrop, old over it, current on top
  // at its opacity — the backdrop fills the holes of the fading old image.
  function drawPair(current, old, currentModel, oldModel, viewProjection, opacity) {
    drawNode(current, currentModel, viewProjection, old && alphaOld > 0 ? 1 : opacity);
    if (old && alphaOld > 0) drawNode(old, oldModel, viewProjection, alphaOld);
    drawNode(current, currentModel, viewProjection, opacity);
  }

  function noteShown(current, old) {
    const changed = current !== shown?.current;
    if (changed) alphaOld = old ? 1 : 0;
    shown = { current, old };
    currentRef = current;
  }

  // --- frame ------------------------------------------------------------------------

  function render() {
    frameId = 0;
    if (!active || !gl || gl.lost || !plan) return;
    frameId = requestAnimationFrame(render);
    frameCounter += 1;
    const inputs = sampleInputs();
    const position = chainPositionAt(plan, inputs.progressMeters, reach);
    if (!position) {
      showing = false;
      currentRef = null;
      return;
    }
    prefetch(position, inputs);

    let a = nodeFor(position.a);
    let b = position.b != null ? nodeFor(position.b) : null;
    let s = position.s;
    let kind = position.kind;
    // Readiness: never show a missing image. Hold on the last ready node
    // (looking back a little) or, failing that, wait on the target.
    if (!isReady(a)) {
      let fallback = null;
      for (let i = position.a - 1; i >= 0 && position.a - i <= 2; i -= 1) {
        const candidate = nodeFor(i);
        if (isReady(candidate) && inputs.progressMeters - plan.nodes[i].distanceMeters <= reach.maxBehindMeters) {
          fallback = candidate;
          break;
        }
      }
      if (fallback) {
        a = fallback;
        b = null;
        s = 1;
        kind = "hold";
      } else if (isReady(b)) {
        a = b;
        b = null;
        s = 0;
        kind = "hold";
      } else {
        showing = false;
        return;
      }
    } else if (b && !isReady(b)) {
      b = null;
      s = 0;
      kind = "hold";
    }
    a.lastUsed = frameCounter;
    if (b) b.lastUsed = frameCounter;

    gl.beginFrame();
    const identity = mat4Identity();
    if (!b) {
      // Holding one image (gap, chain end, or waiting for the next load).
      const old = shown?.old && shown.current === a.ref ? cache.get(shown.old) : (shown?.current && shown.current !== a.ref ? cache.get(shown.current) : null);
      noteShown(a.ref, isReady(old) ? old.ref : null);
      const camera = staticCamera(a, inputs);
      const oldModel = isReady(old) ? mat4Translation(offsetBetween(a, old)) : identity;
      drawPair(a, isReady(old) ? old : null, identity, oldModel, viewProjectionFor(camera), 1);
      if (alphaOld > 0) alphaOld = Math.max(0, alphaOld - c.old_fade_per_frame);
      cutFading = false;
      gl.dropSnapshot();
    } else if (kind === "cut") {
      const fadeStart = 1 - c.cut_fade_fraction;
      if (s < fadeStart) {
        // Hold a's pose and keep a snapshot ready for the cross-fade.
        noteShown(a.ref, null);
        drawPair(a, null, identity, identity, viewProjectionFor(staticCamera(a, inputs)), 1);
        gl.snapshot();
        cutFading = false;
      } else {
        const fade = c.cut_fade_fraction > 0 ? (s - fadeStart) / c.cut_fade_fraction : 1;
        if (!cutFading) {
          cutFading = true;
          noteShown(b.ref, null);
          alphaOld = 0;
        }
        drawPair(b, null, identity, identity, viewProjectionFor(staticCamera(b, inputs)), 1);
        if (gl.hasSnapshot) gl.drawSnapshot(1 - Math.min(1, fade));
      }
    } else {
      // Parallax hop: camera between the two poses, in a's frame.
      noteShown(b.ref, a.ref);
      const camera = cameraBetween(a, b, s, position, inputs);
      drawPair(b, a, mat4Translation(offsetBetween(a, b)), identity, viewProjectionFor(camera), s);
      if (s >= 1 && alphaOld > 0) alphaOld = Math.max(0, alphaOld - c.old_fade_per_frame);
      cutFading = false;
      gl.dropSnapshot();
    }
    showing = true;
    updateAttribution(cache.get(currentRef));
  }

  function updateAttribution(node) {
    if (!attribution || !node || attribution.dataset.ref === node.ref) return;
    attribution.dataset.ref = node.ref;
    const year = node.meta.capturedAt ? ` · ${new Date(node.meta.capturedAt).getFullYear()}` : "";
    const creator = node.meta.creator ? ` · @${node.meta.creator}` : "";
    attribution.textContent = `© Mapillary${creator}${year}`;
    attribution.href = `${config.mapillary_image_url}${node.ref}`;
  }

  function start() {
    if (!frameId && active && gl && plan) frameId = requestAnimationFrame(render);
  }

  return {
    id: "sfm",

    async mount(target) {
      if (gl) return;
      container = target;
      canvas = document.createElement("canvas");
      canvas.className = "street-imagery-canvas";
      attribution = document.createElement("a");
      attribution.className = "street-imagery-attribution";
      attribution.target = "_blank";
      attribution.rel = "noopener";
      target.append(canvas, attribution);
      gl = createSfmGl(canvas, {
        maxPixelRatio: c.max_pixel_ratio,
        clearColor: c.clear_color,
        onContextLost: () => {
          const error = new Error("WebGL context lost");
          error.code = "context-lost";
          onError(error);
        },
      });
      this.resize();
    },

    setPlan(nextPlan) {
      plan = nextPlan;
      cache.reindex(plan);
      start();
    },

    currentRef() {
      return currentRef;
    },

    isShowing() {
      return showing;
    },

    setActive(flag) {
      const next = Boolean(flag);
      if (next === active) return;
      active = next;
      if (active) {
        this.resize();
        start();
      } else {
        showing = false;
      }
    },

    setVisible(flag) {
      container?.classList.toggle("visible", Boolean(flag));
      if (flag) this.resize();
    },

    resize() {
      if (!container || !gl || gl.lost) return;
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      viewport = gl.resize(width, height);
    },

    unmount() {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      active = false;
      container?.classList.remove("visible");
      cache.clear();
      try {
        gl?.dispose();
      } catch (error) {
        onError(error);
      }
      canvas?.remove();
      attribution?.remove();
      gl = null;
      canvas = null;
      attribution = null;
      container = null;
      plan = null;
      shown = null;
      currentRef = null;
      showing = false;
      alphaOld = 0;
      cutFading = false;
    },
  };
}
