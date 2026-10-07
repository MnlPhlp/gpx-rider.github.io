// GPU-side cache of street photos for the renderer: one node per plan
// entry holding the image's camera transform, its proxy geometry uploaded
// to the GPU and its photo as a texture. Loads photo + mesh bytes through
// the asset store (decoding the photo off the main thread), builds the
// transform against the real bitmap size, dedupes and aborts loads, and
// evicts the least-recently-used nodes past a cap. Nodes are plain objects
// ({ ref, index, meta, status: "loading"|"ready"|"failed", transform,
// direction, geometry, texture, lastUsed, fov }) owned by sfm-renderer.mjs.
// Browser only.

import { createImageTransform, viewDirection } from "./sfm-camera.mjs";
import { countVerticesOutsidePhoto, decodeMeshPbf, geometryForImage } from "./sfm-mesh.mjs";

export function createNodeCache({ store, config, gl, onError, debug = () => false }) {
  const c = config.renderer;
  const nodes = new Map(); // ref → node

  function dispose(node) {
    node.abort?.abort();
    node.disposed = true;
    const context = gl();
    if (context && !context.lost) {
      context.deleteGeometry(node.geometry);
      context.deleteTexture(node.texture);
    }
    nodes.delete(node.ref);
  }

  async function load(plan, index, frameCounter) {
    const planNode = plan?.nodes[index];
    if (!planNode || nodes.has(planNode.ref)) return;
    const abort = new AbortController();
    const node = { ref: planNode.ref, index, meta: planNode.meta, status: "loading", abort, disposed: false, lastUsed: frameCounter, fov: new Map() };
    nodes.set(node.ref, node);
    try {
      const [blob, meshBytes] = await Promise.all([
        store.loadPhoto(node.meta, { signal: abort.signal }),
        planNode.pose === "sfm" ? store.loadMesh(node.meta, { signal: abort.signal }) : null,
      ]);
      if (node.disposed) return;
      if (!blob) throw new Error(`No photo for ${node.ref}`);
      const bitmap = await createImageBitmap(blob);
      const context = gl();
      if (node.disposed || !context || context.lost) {
        bitmap.close();
        return;
      }
      const transform = createImageTransform(node.meta, {
        bitmapWidth: bitmap.width,
        bitmapHeight: bitmap.height,
        lookatDepth: c.lookat_depth_meters,
      });
      const mesh = meshBytes ? decodeMeshPbf(meshBytes) : null;
      const geometry = geometryForImage(mesh, transform, {
        planeDepth: c.plane_depth_meters,
        sphereRadius: c.sphere_radius_meters,
        minDepth: c.min_depth_meters,
        marginFactor: c.undistortion_margin_factor,
      });
      node.transform = transform;
      node.direction = viewDirection(transform);
      node.geometry = context.uploadGeometry(geometry);
      node.texture = context.uploadTexture(bitmap);
      bitmap.close();
      node.status = "ready";
      if (debug() && geometry.kind === "mesh") {
        // A frame, orientation or scale mistake shows up here immediately.
        const outside = countVerticesOutsidePhoto(geometry.positions, transform);
        console.debug(`[street-imagery] ${node.ref}: ${geometry.positions.length / 3} mesh vertices, ${outside} project outside the photo (${transform.cameraType}, o${transform.orientation})`);
      }
    } catch (error) {
      if (node.disposed || error?.name === "AbortError") return;
      node.status = "failed";
      onError(error);
    }
  }

  return {
    get: (ref) => (ref == null ? null : nodes.get(ref) ?? null),
    nodeAt(plan, index) {
      const planNode = plan?.nodes[index];
      return planNode ? nodes.get(planNode.ref) ?? null : null;
    },
    load,
    // Drop the least-recently-used nodes beyond `max`, never the kept indices.
    evict(keepIndices, max) {
      if (nodes.size <= max) return;
      const candidates = [...nodes.values()].filter((node) => !keepIndices.has(node.index)).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const node of candidates) {
        if (nodes.size <= max) break;
        dispose(node);
      }
    },
    // A new plan for the same route keeps nodes by ref; others are dropped.
    reindex(plan) {
      const indexByRef = new Map((plan?.nodes ?? []).map((node, index) => [node.ref, index]));
      for (const node of [...nodes.values()]) {
        const index = indexByRef.get(node.ref);
        if (index == null) dispose(node);
        else node.index = index;
      }
    },
    clear() {
      for (const node of [...nodes.values()]) dispose(node);
    },
  };
}
