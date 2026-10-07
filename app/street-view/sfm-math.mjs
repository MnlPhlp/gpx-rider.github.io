// Small linear algebra + geodesy kit for the street imagery renderer: column-
// major 4×4 matrices (the WebGL / three.js layout, elements[0..3] = first
// column), 3-vectors, Rodrigues angle-axis rotations, a gluLookAt view
// matrix, a perspective projection, Catmull-Rom interpolation, and the
// WGS84 ⇄ ECEF ⇄ local ENU (east/north/up, meters) conversions that Mapillary's
// SfM poses are expressed in. Pure, dependency-free, unit-tested.
//
// Portions ported from MapillaryJS 4.1.2 (MIT, © Mapillary) — GeoCoords.ts
// and the Matrix4 conventions its Transform relies on. See THIRD_PARTY_NOTICES.md.

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const WGS84A = 6378137.0;
const WGS84B = 6356752.31424518;

// --- vectors --------------------------------------------------------------------

export function vec3Add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vec3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vec3Length(a) {
  return Math.sqrt(vec3Dot(a, a));
}

export function vec3Normalize(a) {
  const length = vec3Length(a);
  return length > 0 ? vec3Scale(a, 1 / length) : [0, 0, 0];
}

export function vec3Lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function vec3Distance(a, b) {
  return vec3Length(vec3Sub(a, b));
}

// Centripetal-free uniform Catmull-Rom spline through p1..p2, t ∈ [0, 1].
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    out[i] = 0.5 * (
      2 * p1[i]
      + (-p0[i] + p2[i]) * t
      + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2
      + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
    );
  }
  return out;
}

// --- 4×4 matrices (column-major, Float64Array(16)) ------------------------------

export function mat4Identity() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Row-major arguments (like three.js's Matrix4.set) stored column-major.
export function mat4FromRows(
  n11, n12, n13, n14,
  n21, n22, n23, n24,
  n31, n32, n33, n34,
  n41, n42, n43, n44,
) {
  const m = new Float64Array(16);
  m[0] = n11; m[4] = n12; m[8] = n13; m[12] = n14;
  m[1] = n21; m[5] = n22; m[9] = n23; m[13] = n24;
  m[2] = n31; m[6] = n32; m[10] = n33; m[14] = n34;
  m[3] = n41; m[7] = n42; m[11] = n43; m[15] = n44;
  return m;
}

export function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function mat4Invert(m) {
  const n11 = m[0]; const n21 = m[1]; const n31 = m[2]; const n41 = m[3];
  const n12 = m[4]; const n22 = m[5]; const n32 = m[6]; const n42 = m[7];
  const n13 = m[8]; const n23 = m[9]; const n33 = m[10]; const n43 = m[11];
  const n14 = m[12]; const n24 = m[13]; const n34 = m[14]; const n44 = m[15];

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) return new Float64Array(16);
  const d = 1 / det;
  const out = new Float64Array(16);
  out[0] = t11 * d;
  out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d;
  out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d;
  out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;
  out[4] = t12 * d;
  out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d;
  out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d;
  out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;
  out[8] = t13 * d;
  out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d;
  out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d;
  out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;
  out[12] = t14 * d;
  out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d;
  out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d;
  out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;
  return out;
}

export function mat4Translation([x, y, z]) {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function mat4SetPosition(m, [x, y, z]) {
  const out = new Float64Array(m);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

// Rotation matrix from an angle-axis vector (angle = |v|, axis = v/|v|;
// a zero vector is the identity). Same formula as three.js makeRotationAxis.
export function rodrigues(angleAxis) {
  const angle = Math.hypot(angleAxis[0], angleAxis[1], angleAxis[2]);
  const m = mat4Identity();
  if (!(angle > 0)) return m;
  const x = angleAxis[0] / angle;
  const y = angleAxis[1] / angle;
  const z = angleAxis[2] / angle;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const tx = t * x;
  const ty = t * y;
  const tz = t * z;
  m[0] = tx * x + c; m[4] = tx * y - s * z; m[8] = tx * z + s * y;
  m[1] = tx * y + s * z; m[5] = ty * y + c; m[9] = ty * z - s * x;
  m[2] = tx * z - s * y; m[6] = ty * z + s * x; m[10] = tz * z + c;
  return m;
}

// Angle-axis vector of a rotation matrix (inverse of rodrigues), robust at
// the identity and at 180°.
export function rotationToAngleAxis(m) {
  const r00 = m[0]; const r01 = m[4]; const r02 = m[8];
  const r10 = m[1]; const r11 = m[5]; const r12 = m[9];
  const r20 = m[2]; const r21 = m[6]; const r22 = m[10];
  const trace = r00 + r11 + r22;
  const cosAngle = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const angle = Math.acos(cosAngle);
  if (angle < 1e-9) return [0, 0, 0];
  if (Math.PI - angle > 1e-6) {
    const k = angle / (2 * Math.sin(angle));
    return [(r21 - r12) * k, (r02 - r20) * k, (r10 - r01) * k];
  }
  // Near 180°: the off-diagonal differences vanish; use the largest diagonal.
  let axis;
  if (r00 >= r11 && r00 >= r22) {
    const x = Math.sqrt(Math.max(0, (r00 + 1) / 2));
    axis = [x, r01 / (2 * x), r02 / (2 * x)];
  } else if (r11 >= r22) {
    const y = Math.sqrt(Math.max(0, (r11 + 1) / 2));
    axis = [r01 / (2 * y), y, r12 / (2 * y)];
  } else {
    const z = Math.sqrt(Math.max(0, (r22 + 1) / 2));
    axis = [r02 / (2 * z), r12 / (2 * z), z];
  }
  return vec3Scale(vec3Normalize(axis), angle);
}

// Transform a point (w = 1) and divide by the resulting w.
export function transformPoint(m, [x, y, z]) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const inv = w !== 0 ? 1 / w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * inv,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * inv,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * inv,
  ];
}

// Rotate a direction (w = 0).
export function transformDirection(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

// View matrix (world → eye) of a camera at `eye` looking at `target` with
// `up`, the OpenGL convention: the camera looks down its −z axis.
export function mat4LookAtView(eye, target, up) {
  let z = vec3Normalize(vec3Sub(eye, target));
  if (vec3Length(z) === 0) z = [0, 0, 1];
  let x = vec3Cross(up, z);
  if (vec3Length(x) < 1e-12) {
    // up is parallel to the view direction: nudge like three.js does.
    const nudged = Math.abs(up[2]) === 1 ? [up[0] + 1e-4, up[1], up[2]] : [up[0], up[1], up[2] + 1e-4];
    x = vec3Cross(nudged, z);
  }
  x = vec3Normalize(x);
  const y = vec3Cross(z, x);
  return mat4FromRows(
    x[0], x[1], x[2], -vec3Dot(x, eye),
    y[0], y[1], y[2], -vec3Dot(y, eye),
    z[0], z[1], z[2], -vec3Dot(z, eye),
    0, 0, 0, 1,
  );
}

export function mat4Perspective(fovYDegrees, aspect, near, far) {
  const f = 1 / Math.tan((fovYDegrees * DEG2RAD) / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

// --- geodesy (WGS84 ⇄ ECEF ⇄ ENU) -------------------------------------------------

export function geodeticToEcef(lng, lat, alt) {
  const lngRad = lng * DEG2RAD;
  const latRad = lat * DEG2RAD;
  const cosLng = Math.cos(lngRad);
  const sinLng = Math.sin(lngRad);
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const a2 = WGS84A * WGS84A;
  const b2 = WGS84B * WGS84B;
  const L = 1.0 / Math.sqrt(a2 * cosLat * cosLat + b2 * sinLat * sinLat);
  const nhcl = (a2 * L + alt) * cosLat;
  return [nhcl * cosLng, nhcl * sinLng, (b2 * L + alt) * sinLat];
}

export function ecefToGeodetic(X, Y, Z) {
  const a = WGS84A;
  const b = WGS84B;
  const a2 = a * a;
  const b2 = b * b;
  const a2mb2 = a2 - b2;
  const ea = Math.sqrt(a2mb2 / a2);
  const eb = Math.sqrt(a2mb2 / b2);
  const p = Math.sqrt(X * X + Y * Y);
  const theta = Math.atan2(Z * a, p * b);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const lng = Math.atan2(Y, X);
  const lat = Math.atan2(
    Z + eb * eb * b * sinTheta * sinTheta * sinTheta,
    p - ea * ea * a * cosTheta * cosTheta * cosTheta,
  );
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - ea * ea * sinLat * sinLat);
  const alt = p / cosLat - N;
  return [lng * RAD2DEG, lat * RAD2DEG, alt];
}

export function ecefToEnu(X, Y, Z, refLng, refLat, refAlt) {
  const ref = geodeticToEcef(refLng, refLat, refAlt);
  const V = [X - ref[0], Y - ref[1], Z - ref[2]];
  const lngRad = refLng * DEG2RAD;
  const latRad = refLat * DEG2RAD;
  const cosLng = Math.cos(lngRad);
  const sinLng = Math.sin(lngRad);
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  return [
    -sinLng * V[0] + cosLng * V[1],
    -sinLat * cosLng * V[0] - sinLat * sinLng * V[1] + cosLat * V[2],
    cosLat * cosLng * V[0] + cosLat * sinLng * V[1] + sinLat * V[2],
  ];
}

export function enuToEcef(x, y, z, refLng, refLat, refAlt) {
  const ref = geodeticToEcef(refLng, refLat, refAlt);
  const lngRad = refLng * DEG2RAD;
  const latRad = refLat * DEG2RAD;
  const cosLng = Math.cos(lngRad);
  const sinLng = Math.sin(lngRad);
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  return [
    -sinLng * x - sinLat * cosLng * y + cosLat * cosLng * z + ref[0],
    cosLng * x - sinLat * sinLng * y + cosLat * sinLng * z + ref[1],
    cosLat * y + sinLat * z + ref[2],
  ];
}

// Local topocentric east/north/up coordinates (meters) of a position
// relative to a reference position.
export function geodeticToEnu(lng, lat, alt, refLng, refLat, refAlt) {
  const ecef = geodeticToEcef(lng, lat, alt);
  return ecefToEnu(ecef[0], ecef[1], ecef[2], refLng, refLat, refAlt);
}

export function enuToGeodetic(x, y, z, refLng, refLat, refAlt) {
  const ecef = enuToEcef(x, y, z, refLng, refLat, refAlt);
  return ecefToGeodetic(ecef[0], ecef[1], ecef[2]);
}
