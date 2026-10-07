// GLSL for the street imagery renderer: projective texturing of a photo onto
// its proxy geometry. The vertex shader carries each vertex into the image's
// camera frame (projectorMat = the pose, including the EXIF-orientation
// twist) and the fragment shader applies the camera model — perspective or
// fisheye with radial distortion, or equirectangular for 360° images — to
// look the photo's texel up; anything outside the photo is transparent so
// the image underneath shows through. Shared vertex shader for all three.
//
// Textures are uploaded in natural orientation (row 0 = top of the photo),
// so the v coordinate here is "1 −" the one in the viewer, which uploads
// flipped. GLSL ES 1.00 so the same source runs on WebGL1 and WebGL2.
//
// Ported from MapillaryJS 4.1.2 (MIT, © Mapillary): component/shaders/*.glsl.ts.
// See THIRD_PARTY_NOTICES.md.

export const IMAGE_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;

uniform mat4 projectorMat;
uniform mat4 modelMatrix;
uniform mat4 viewProjection;

varying vec4 vRstq;

void main() {
  vRstq = projectorMat * vec4(position, 1.0);
  gl_Position = viewProjection * modelMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D projectorTex;
uniform float opacity;
uniform float focal;
uniform float k1;
uniform float k2;
uniform float scale_x;
uniform float scale_y;
uniform float radial_peak;

varying vec4 vRstq;
`;

export const PERSPECTIVE_FRAGMENT_SHADER = `${FRAGMENT_HEADER}
void main() {
  float x = vRstq.x / vRstq.z;
  float y = vRstq.y / vRstq.z;
  float r2 = x * x + y * y;

  if (radial_peak > 0. && r2 > radial_peak * sqrt(r2)) {
    r2 = radial_peak * radial_peak;
  }

  float d = 1.0 + k1 * r2 + k2 * r2 * r2;
  float u = scale_x * focal * d * x + 0.5;
  float v = scale_y * focal * d * y + 0.5;

  vec4 baseColor;
  if (vRstq.z > 0. && u >= 0. && u <= 1. && v >= 0. && v <= 1.) {
    baseColor = texture2D(projectorTex, vec2(u, v));
    baseColor.a = opacity;
  } else {
    baseColor = vec4(0.0, 0.0, 0.0, 0.0);
  }

  gl_FragColor = baseColor;
}
`;

export const FISHEYE_FRAGMENT_SHADER = `${FRAGMENT_HEADER}
void main() {
  float x = vRstq.x;
  float y = vRstq.y;
  float z = vRstq.z;

  float r = sqrt(x * x + y * y);
  float theta = atan(r, z);

  if (radial_peak > 0. && theta > radial_peak) {
    theta = radial_peak;
  }

  float theta2 = theta * theta;
  float theta_d = theta * (1.0 + theta2 * (k1 + theta2 * k2));
  float s = focal * theta_d / r;

  float u = scale_x * s * x + 0.5;
  float v = scale_y * s * y + 0.5;

  vec4 baseColor;
  if (u >= 0. && u <= 1. && v >= 0. && v <= 1.) {
    baseColor = texture2D(projectorTex, vec2(u, v));
    baseColor.a = opacity;
  } else {
    baseColor = vec4(0.0, 0.0, 0.0, 0.0);
  }

  gl_FragColor = baseColor;
}
`;

export const SPHERICAL_FRAGMENT_SHADER = `${FRAGMENT_HEADER}
#define tau 6.28318530718

void main() {
  vec3 b = normalize(vRstq.xyz);
  float lat = -asin(b.y);
  float lng = atan(b.x, b.z);
  float x = lng / tau + 0.5;
  float y = 0.5 - lat / tau * 2.0;
  vec4 baseColor = texture2D(projectorTex, vec2(x, y));
  baseColor.a = opacity;
  gl_FragColor = baseColor;
}
`;

// Full-screen quad showing a snapshot of the previous frame, for the
// cross-fade at a cut between unrelated reconstructions.
export const SNAPSHOT_VERTEX_SHADER = `
precision highp float;

attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const SNAPSHOT_FRAGMENT_SHADER = `
precision mediump float;

uniform sampler2D snapshotTex;
uniform float opacity;

varying vec2 vUv;

void main() {
  vec4 color = texture2D(snapshotTex, vUv);
  gl_FragColor = vec4(color.rgb, opacity);
}
`;

export const FRAGMENT_SHADER_BY_CAMERA_TYPE = {
  perspective: PERSPECTIVE_FRAGMENT_SHADER,
  fisheye: FISHEYE_FRAGMENT_SHADER,
  spherical: SPHERICAL_FRAGMENT_SHADER,
};
