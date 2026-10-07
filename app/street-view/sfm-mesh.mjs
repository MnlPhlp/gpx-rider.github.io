// Proxy geometry of one street image: decodes Mapillary's per-image mesh
// (a coarse triangulated depth surface in the camera frame, SfM units) and
// turns it into world-space positions the renderer can texture the photo
// onto, with the viewer's exact clamping rules — everything at least a few
// meters in front of the camera, nothing beyond the far plane, the four
// image-plane corner vertices widened so undistortion never shows an edge.
// Images without a usable mesh (not merged into an SfM component, invalid
// reconstruction scale) get a flat plane (perspective/fisheye) or a sphere
// (360°) at the far distance instead. Pure, unit-tested.
//
// Portions ported from MapillaryJS 4.1.2 (MIT, © Mapillary): api/Common.ts
// (readMeshPbf) and component/util/MeshFactory.ts. See THIRD_PARTY_NOTICES.md.

import { isSpherical, projectBasic, unprojectSfM } from "./sfm-camera.mjs";
import { transformPoint } from "./sfm-math.mjs";

// Protobuf: field 1 = vertex coordinates (float32, x y z interleaved), field
// 2 = face vertex indices (varint, triangles). Each coordinate/index is its
// own tagged record upstream; packed (length-delimited) runs of either field
// are accepted too.
export function decodeMeshPbf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertices = [];
  const faces = [];
  let pos = 0;

  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= bytes.length) throw new Error("Truncated mesh protobuf");
      const byte = bytes[pos];
      pos += 1;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) return result;
    }
  };
  const readFloat = () => {
    if (pos + 4 > bytes.length) throw new Error("Truncated mesh protobuf");
    const value = view.getFloat32(pos, true);
    pos += 4;
    return value;
  };

  while (pos < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 5) {
      const value = readFloat();
      if (field === 1) vertices.push(value);
    } else if (wire === 0) {
      const value = readVarint();
      if (field === 2) faces.push(value);
    } else if (wire === 2) {
      const length = readVarint();
      const end = pos + length;
      if (field === 1) while (pos < end) vertices.push(readFloat());
      else if (field === 2) while (pos < end) faces.push(readVarint());
      pos = end;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`Unsupported mesh protobuf wire type ${wire}`);
    }
  }

  const maxIndex = faces.reduce((max, index) => (index > max ? index : max), 0);
  return {
    vertices: Float32Array.from(vertices),
    faces: maxIndex < 65536 ? Uint16Array.from(faces) : Uint32Array.from(faces),
  };
}

export function usesMesh(mesh, transform) {
  return Boolean(mesh?.vertices?.length) && transform.hasValidScale;
}

// Mesh vertices (camera frame, SfM units) → world positions in the
// transform's frame. Perspective meshes are clamped in depth (z), fisheye
// and spherical ones radially; the first four vertices of a perspective
// mesh are the image-plane corners and get widened by marginFactor.
export function meshWorldPositions(mesh, transform, {
  planeDepth = 200,
  sphereRadius = 200,
  minDepth = 5,
  marginFactor = 3,
} = {}) {
  const vertices = mesh.vertices;
  const count = vertices.length / 3;
  const positions = new Float32Array(vertices.length);
  const scale = transform.scale;
  const minZ = minDepth * scale;
  const perspective = transform.cameraType === "perspective";
  const maxZ = (isSpherical(transform.cameraType) ? sphereRadius : planeDepth) * scale;

  for (let i = 0; i < count; i += 1) {
    const index = 3 * i;
    let x = vertices[index];
    let y = vertices[index + 1];
    let z = vertices[index + 2];
    let point;
    if (perspective) {
      if (i < 4) {
        x *= marginFactor;
        y *= marginFactor;
      }
      const boundedZ = Math.max(minZ, Math.min(z, maxZ));
      const factor = z > 0 ? boundedZ / z : 1;
      point = [x * factor, y * factor, boundedZ];
    } else {
      const length = Math.sqrt(x * x + y * y + z * z);
      const boundedLength = Math.max(minZ, Math.min(length, maxZ));
      const factor = length > 0 ? boundedLength / length : 1;
      point = [x * factor, y * factor, z * factor];
    }
    const world = transformPoint(transform.srtInverse, point);
    positions[index] = world[0];
    positions[index + 1] = world[1];
    positions[index + 2] = world[2];
  }
  return positions;
}

// A quad covering the whole image at `depth` meters along each corner ray.
export function flatPlaneGeometry(transform, depth = 200) {
  const size = Math.max(transform.width, transform.height);
  const dx = transform.width / 2 / size;
  const dy = transform.height / 2 / size;
  const corners = [
    unprojectSfM(transform, [-dx, -dy], depth),
    unprojectSfM(transform, [dx, -dy], depth),
    unprojectSfM(transform, [dx, dy], depth),
    unprojectSfM(transform, [-dx, dy], depth),
  ];
  const positions = new Float32Array(12);
  corners.forEach((corner, i) => {
    positions[3 * i] = corner[0];
    positions[3 * i + 1] = corner[1];
    positions[3 * i + 2] = corner[2];
  });
  return { positions, indices: Uint16Array.from([0, 1, 3, 1, 2, 3]) };
}

// A UV sphere of `radius` around the camera center (the viewer's
// SphereGeometry(radius, 20, 40) transformed by the inverse pose).
export function flatSphereGeometry(transform, radius = 200, widthSegments = 20, heightSegments = 40) {
  const positions = [];
  const grid = [];
  for (let iy = 0; iy <= heightSegments; iy += 1) {
    const row = [];
    const v = iy / heightSegments;
    for (let ix = 0; ix <= widthSegments; ix += 1) {
      const u = ix / widthSegments;
      const local = [
        -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI),
        radius * Math.cos(v * Math.PI),
        radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI),
      ];
      const world = transformPoint(transform.rtInverse, local);
      row.push(positions.length / 3);
      positions.push(world[0], world[1], world[2]);
    }
    grid.push(row);
  }
  const indices = [];
  for (let iy = 0; iy < heightSegments; iy += 1) {
    for (let ix = 0; ix < widthSegments; ix += 1) {
      const a = grid[iy][ix + 1];
      const b = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== heightSegments - 1) indices.push(b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint16Array.from(indices) };
}

// What to draw for an image: its mesh when usable, else the flat fallback.
export function geometryForImage(mesh, transform, options = {}) {
  if (usesMesh(mesh, transform)) {
    return { kind: "mesh", positions: meshWorldPositions(mesh, transform, options), indices: mesh.faces };
  }
  if (isSpherical(transform.cameraType)) {
    return { kind: "flat", ...flatSphereGeometry(transform, options.sphereRadius ?? 200) };
  }
  return { kind: "flat", ...flatPlaneGeometry(transform, options.planeDepth ?? 200) };
}

// Sanity check for a mesh placed in the world: every vertex of an image's
// own proxy mesh must project back inside that image (the four widened
// corner vertices are skipped). A frame, orientation or scale mistake shows
// up here as a large count.
export function countVerticesOutsidePhoto(positions, transform, { skip = 4, tolerance = 0.01 } = {}) {
  let outside = 0;
  for (let i = skip; i < positions.length / 3; i += 1) {
    const basic = projectBasic(transform, [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
    if (!(basic[0] >= -tolerance && basic[0] <= 1 + tolerance && basic[1] >= -tolerance && basic[1] <= 1 + tolerance)) outside += 1;
  }
  return outside;
}
