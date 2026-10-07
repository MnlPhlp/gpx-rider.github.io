// Camera path between two street photos: given both poses (position, view
// direction, up, field of view, all in the first photo's frame) and the
// fraction s the rider has covered between them, the virtual camera to
// render from — a straight interpolation like the official viewer, or a
// Catmull-Rom spline through the neighboring photos of the same
// reconstruction so position and direction bend smoothly through each
// photo instead of kinking at it. Pure, unit-tested.

import { catmullRom, vec3Lerp, vec3Normalize } from "./sfm-math.mjs";

// Unit east/north/up vector of a compass bearing (degrees clockwise from north).
export function bearingDirection(degrees) {
  const radians = ((degrees ?? 0) * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians), 0];
}

// a/b: { position, direction, up, fov }; before/after: the same shape for
// the previous and next photo when they are parallax-linked, else null.
export function cameraAlongLink(a, b, s, { smoothing = "linear", before = null, after = null } = {}) {
  let eye = vec3Lerp(a.position, b.position, s);
  let direction = vec3Normalize(vec3Lerp(a.direction, b.direction, s));
  if (smoothing === "catmull") {
    const p0 = before ? before.position : a.position;
    const p3 = after ? after.position : b.position;
    eye = catmullRom(p0, a.position, b.position, p3, s);
    const d0 = before ? before.direction : a.direction;
    const d3 = after ? after.direction : b.direction;
    direction = vec3Normalize(catmullRom(d0, a.direction, b.direction, d3, s));
  }
  return {
    eye,
    direction,
    up: vec3Normalize(vec3Lerp(a.up, b.up, s)),
    fov: (1 - s) * a.fov + s * b.fov,
  };
}
