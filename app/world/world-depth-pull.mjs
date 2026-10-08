// A distance-scaled depth margin for built-in three.js materials: each vertex
// moves toward the camera along its own view ray by `fraction` of its
// distance. Screen position is unchanged (a perspective projection is
// invariant along the ray), only depth shrinks — so a surface wins depth
// fights against terrain that is slightly too high, by a margin that grows
// with distance exactly as the terrain LOD error does, while real hills
// (much farther in front) still hide it. Used by the road (world-scene.mjs)
// and the rider marker (world-overlays.mjs); route lines patch their own
// shader the same way.

export function applyDepthPull(material, fraction) {
  const keep = (1 - fraction).toFixed(6);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      mvPosition.xyz *= ${keep};
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  // Different pulls must not share a compiled program.
  material.customProgramCacheKey = () => `depth-pull-${keep}`;
  material.needsUpdate = true;
  return material;
}
