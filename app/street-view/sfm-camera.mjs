// Camera model of one street image, as Mapillary's SfM pipeline (OpenSfM)
// describes it: the world→camera pose from an angle-axis rotation and the
// optical center, the perspective / fisheye / spherical projection with
// radial distortion, EXIF orientation handling, and the "basic" ([0,1]²
// across the displayed image) ⇄ "SfM" (normalized by max(width, height),
// origin at the center) ⇄ bearing (unit vector in the camera frame, x right,
// y down, z forward) coordinate conversions. Also the derived render-camera
// data (position, look-at, up, vertical field of view) and the pair test
// that decides whether two images can be blended with parallax. Pure and
// unit-tested; the renderer only ever calls into this.
//
// A transform is built in the image's *own* frame (ENU axes, origin at its
// optical center) unless a translation is passed; the renderer offsets other
// images by their ENU displacement instead of sharing one world origin.
//
// Portions ported from MapillaryJS 4.1.2 (MIT, © Mapillary): geo/Transform.ts,
// geo/Camera.ts, geo/Geo.ts, render/RenderCamera.ts. See THIRD_PARTY_NOTICES.md.

import { haversine } from "../core/geo.mjs";
import {
  mat4FromRows,
  mat4Invert,
  mat4LookAtView,
  mat4Multiply,
  mat4SetPosition,
  rodrigues,
  rotationToAngleAxis,
  transformPoint,
  vec3Normalize,
} from "./sfm-math.mjs";

const EPSILON = 1e-8;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function cameraTypeFrom(graphCameraType) {
  switch (graphCameraType) {
    case "equirectangular":
    case "spherical":
      return "spherical";
    case "fisheye":
      return "fisheye";
    default:
      return "perspective";
  }
}

export function isSpherical(cameraType) {
  return cameraType === "spherical";
}

export function isFisheye(cameraType) {
  return cameraType === "fisheye";
}

function positive(value, fallback) {
  return value != null && value > 0 ? value : fallback;
}

// Radius at which the radial distortion polynomial d(r) = 1 + k1 r² + k2 r⁴
// stops growing monotonically (where r·d(r) peaks); beyond it the model is
// clamped so a pixel never maps twice. null = no peak. With k2 = 0 the
// quadratic degenerates — upstream's roots turn NaN — so there is no peak
// either, which is reproduced here explicitly.
export function radialPeakFor(k1, k2) {
  const a = 5 * k2;
  const b = 3 * k1;
  const c = 1;
  if (a === 0) return null;
  const d = b * b - 4 * a * c;
  if (d < 0) return null;
  const root1 = (-b - Math.sqrt(d)) / 2 / a;
  const root2 = (-b + Math.sqrt(d)) / 2 / a;
  const minRoot = Math.min(root1, root2);
  const maxRoot = Math.max(root1, root2);
  if (minRoot > 0) return Math.sqrt(minRoot);
  if (maxRoot > 0) return Math.sqrt(maxRoot);
  return null;
}

function cameraParametersFor(value, cameraType) {
  if (isSpherical(cameraType)) return [];
  if (!value || value.length === 0) return [1, 0, 0];
  const padding = 3 - value.length;
  return padding <= 0 ? value.slice(0, 3) : value.concat(new Array(padding).fill(0));
}

function basicRotationFor(rt, orientation) {
  let angle = 0;
  if (orientation === 3) angle = Math.PI;
  else if (orientation === 6) angle = Math.PI / 2;
  else if (orientation === 8) angle = (3 * Math.PI) / 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rz = mat4FromRows(
    c, -s, 0, 0,
    s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
  return mat4Multiply(rz, rt);
}

function upVectorFor(rt, orientation) {
  const e = rt;
  switch (orientation) {
    case 3:
      return [e[1], e[5], e[9]];
    case 6:
      return [-e[0], -e[4], -e[8]];
    case 8:
      return [e[0], e[4], e[8]];
    default:
      return [-e[1], -e[5], -e[9]];
  }
}

// meta: { orientation, width, height, scale, rotation, cameraParameters, cameraType }
// (the normalized metadata shape from scan-boxes.mjs). The bitmap size is
// the fallback when the API lacks dimensions, exactly as the viewer falls
// back to the loaded <img>.
export function createImageTransform(meta, {
  translation = [0, 0, 0],
  bitmapWidth = null,
  bitmapHeight = null,
  lookatDepth = 10,
} = {}) {
  const orientation = positive(meta.orientation, 1);
  const keepOrientation = orientation < 5;
  const imageWidth = positive(bitmapWidth, 4);
  const imageHeight = positive(bitmapHeight, 3);
  const width = positive(meta.width, keepOrientation ? imageWidth : imageHeight);
  const height = positive(meta.height, keepOrientation ? imageHeight : imageWidth);
  const basicWidth = keepOrientation ? width : height;
  const basicHeight = keepOrientation ? height : width;

  const cameraType = cameraTypeFrom(meta.cameraType);
  const parameters = cameraParametersFor(meta.cameraParameters, cameraType);
  const focal = positive(parameters[0], 1);
  const k1 = parameters[1] || 0;
  const k2 = parameters[2] || 0;
  const scale = positive(meta.scale, 0);

  const rt = mat4SetPosition(rodrigues(meta.rotation ?? [0, 0, 0]), translation);
  const rtInverse = mat4Invert(rt);
  const scaling = mat4FromRows(
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    0, 0, 0, 1,
  );
  const srt = mat4Multiply(scaling, rt);
  const srtInverse = mat4Invert(srt);

  const transform = {
    cameraType,
    orientation,
    width,
    height,
    basicWidth,
    basicHeight,
    basicAspect: keepOrientation ? width / height : height / width,
    focal,
    k1,
    k2,
    radialPeak: radialPeakFor(k1, k2),
    scale,
    hasValidScale: scale > 1e-2 && scale < 50,
    rt,
    rtInverse,
    srt,
    srtInverse,
    basicRt: basicRotationFor(rt, orientation),
    scaleX: Math.max(basicHeight, basicWidth) / basicWidth,
    scaleY: Math.max(basicWidth, basicHeight) / basicHeight,
    up: upVectorFor(rt, orientation),
    position: null,
    lookat: null,
  };
  transform.position = unprojectSfM(transform, [0, 0], 0);
  transform.lookat = unprojectSfM(transform, [0, 0], lookatDepth);
  return transform;
}

// --- projection ---------------------------------------------------------------

// Solves d in y = d(x) · x for the distorted radius y (10 fixed-point steps).
function distortionFromDistortedRadius(distortedRadius, k1, k2, radialPeak) {
  let d = 1.0;
  for (let i = 0; i < 10; i += 1) {
    let radius = distortedRadius / d;
    if (radialPeak != null && radius > radialPeak) radius = radialPeak;
    d = 1 + k1 * radius ** 2 + k2 * radius ** 4;
  }
  return d;
}

export function sfmToBearing(transform, sfm) {
  if (isSpherical(transform.cameraType)) {
    const lng = sfm[0] * 2 * Math.PI;
    const lat = -sfm[1] * 2 * Math.PI;
    return [Math.cos(lat) * Math.sin(lng), -Math.sin(lat), Math.cos(lat) * Math.cos(lng)];
  }
  const dxn = sfm[0] / transform.focal;
  const dyn = sfm[1] / transform.focal;
  if (isFisheye(transform.cameraType)) {
    const dTheta = Math.sqrt(dxn * dxn + dyn * dyn);
    const d = distortionFromDistortedRadius(dTheta, transform.k1, transform.k2, transform.radialPeak);
    const theta = dTheta / d;
    const r = Math.sin(theta);
    const denomTheta = dTheta > EPSILON ? 1 / dTheta : 1;
    return [r * dxn * denomTheta, r * dyn * denomTheta, Math.cos(theta)];
  }
  const dr = Math.sqrt(dxn * dxn + dyn * dyn);
  const d = distortionFromDistortedRadius(dr, transform.k1, transform.k2, transform.radialPeak);
  return vec3Normalize([dxn / d, dyn / d, 1]);
}

export function bearingToSfm(transform, bearing) {
  const [x, y, z] = bearing;
  if (isSpherical(transform.cameraType)) {
    const lng = Math.atan2(x, z);
    const lat = Math.atan2(-y, Math.sqrt(x * x + z * z));
    return [lng / (2 * Math.PI), -lat / (2 * Math.PI)];
  }
  if (!(z > 0)) {
    return [
      x < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      y < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    ];
  }
  if (isFisheye(transform.cameraType)) {
    const r = Math.sqrt(x * x + y * y);
    let theta = Math.atan2(r, z);
    if (transform.radialPeak != null && theta > transform.radialPeak) theta = transform.radialPeak;
    const distortion = 1.0 + theta ** 2 * (transform.k1 + theta ** 2 * transform.k2);
    const s = r > 0 ? (transform.focal * distortion * theta) / r : 0;
    return [s * x, s * y];
  }
  const xn = x / z;
  const yn = y / z;
  let r2 = xn * xn + yn * yn;
  if (transform.radialPeak != null) {
    const rp2 = transform.radialPeak ** 2;
    if (r2 > rp2) r2 = rp2;
  }
  const d = 1 + transform.k1 * r2 + transform.k2 * r2 ** 2;
  return [transform.focal * d * xn, transform.focal * d * yn];
}

export function basicToSfm(transform, basic) {
  let rotatedX;
  let rotatedY;
  switch (transform.orientation) {
    case 3:
      rotatedX = 1 - basic[0];
      rotatedY = 1 - basic[1];
      break;
    case 6:
      rotatedX = basic[1];
      rotatedY = 1 - basic[0];
      break;
    case 8:
      rotatedX = 1 - basic[1];
      rotatedY = basic[0];
      break;
    default:
      rotatedX = basic[0];
      rotatedY = basic[1];
      break;
  }
  const w = transform.width;
  const h = transform.height;
  const s = Math.max(w, h);
  return [(rotatedX * w) / s - w / s / 2, (rotatedY * h) / s - h / s / 2];
}

export function sfmToBasic(transform, sfm) {
  const w = transform.width;
  const h = transform.height;
  const s = Math.max(w, h);
  const rotatedX = ((sfm[0] + w / s / 2) / w) * s;
  const rotatedY = ((sfm[1] + h / s / 2) / h) * s;
  switch (transform.orientation) {
    case 3:
      return [1 - rotatedX, 1 - rotatedY];
    case 6:
      return [1 - rotatedY, rotatedX];
    case 8:
      return [rotatedY, 1 - rotatedX];
    default:
      return [rotatedX, rotatedY];
  }
}

export function projectSfM(transform, point3d) {
  return bearingToSfm(transform, transformPoint(transform.rt, point3d));
}

export function projectBasic(transform, point3d) {
  return sfmToBasic(transform, projectSfM(transform, point3d));
}

// `distance` along the bearing, or — with depth=true, perspective/fisheye
// only — the depth in front of the camera.
export function unprojectSfM(transform, sfm, distance, depth = false) {
  const bearing = sfmToBearing(transform, sfm);
  const camera = depth && !isSpherical(transform.cameraType)
    ? [(distance * bearing[0]) / bearing[2], (distance * bearing[1]) / bearing[2], distance]
    : [distance * bearing[0], distance * bearing[1], distance * bearing[2]];
  return transformPoint(transform.rtInverse, camera);
}

export function unprojectBasic(transform, basic, distance, depth = false) {
  return unprojectSfM(transform, basicToSfm(transform, basic), distance, depth);
}

// Direction the camera looks along (unit, in the transform's frame).
export function viewDirection(transform) {
  return vec3Normalize([
    transform.lookat[0] - transform.position[0],
    transform.lookat[1] - transform.position[1],
    transform.lookat[2] - transform.position[2],
  ]);
}

// --- render camera field of view --------------------------------------------------

// Vertical field of view (degrees) that fits the image into a viewport of
// the given aspect: "fill" crops the photo to fill the viewport (the viewer's
// default), "letterbox" shows all of it. Spherical images use a fixed 90°
// (at zoom 0) like the viewer; the caller may override that.
export function verticalFovDegrees(transform, aspect, {
  mode = "fill",
  fillFactor = 0.995,
  zoom = 0,
  pointsPerLine = 100,
} = {}) {
  const zoomScale = 2 ** zoom;
  if (isSpherical(transform.cameraType)) return 2 * Math.atan(1 / zoomScale) * RAD2DEG;
  if (!(aspect > 0)) return 0;
  const view = mat4LookAtView(transform.position, transform.lookat, transform.up);
  // Half the top edge (center → corner) and half the right edge (corner →
  // middle): with symmetric projection that covers every extreme.
  const lines = [
    { v: [0.5, 0], d: [0.5, 0] },
    { v: [1, 0], d: [0, 0.5] },
  ];
  let fov = mode === "fill" ? Infinity : 0;
  for (const line of lines) {
    for (let i = 0; i <= pointsPerLine; i += 1) {
      const basic = [line.v[0] + (line.d[0] * i) / pointsPerLine, line.v[1] + (line.d[1] * i) / pointsPerLine];
      const world = unprojectBasic(transform, basic, 10000);
      const eye = transformPoint(view, world);
      const px = Math.abs(eye[0] / eye[2]);
      const py = Math.abs(eye[1] / eye[2]);
      const required = 2 * Math.atan(Math.max(px / aspect, py) / zoomScale) * RAD2DEG;
      fov = mode === "fill" ? Math.min(fov, required) : Math.max(fov, required);
    }
  }
  return mode === "fill" ? fov * fillFactor : fov;
}

// --- poses without SfM --------------------------------------------------------------

// Angle-axis world→camera rotation of a level camera facing a compass
// bearing (degrees clockwise from north), for images Mapillary never
// reconstructed: ENU forward = (sin β, cos β, 0), right = (cos β, −sin β, 0),
// down = (0, 0, −1); the rotation's rows are [right; down; forward].
export function synthesizePose(compassDegrees) {
  const beta = (compassDegrees ?? 0) * DEG2RAD;
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  const rotation = mat4FromRows(
    c, -s, 0, 0,
    0, 0, -1, 0,
    s, c, 0, 0,
    0, 0, 0, 1,
  );
  return rotationToAngleAxis(rotation);
}

// Two images can be blended with parallax (the viewer's "not motionless"
// test) when both were merged into the same SfM connected component and
// their original GPS positions are close.
export function isParallaxPair(a, b, maxMeters) {
  if (!a || !b) return false;
  if (a.mergeId == null || b.mergeId == null || a.mergeId !== b.mergeId) return false;
  const distance = haversine(
    { lat: a.originalLat ?? a.lat, lng: a.originalLng ?? a.lng },
    { lat: b.originalLat ?? b.lat, lng: b.originalLng ?? b.lng },
  );
  return distance < maxMeters;
}
