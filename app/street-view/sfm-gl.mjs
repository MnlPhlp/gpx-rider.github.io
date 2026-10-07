// Thin WebGL layer for the street imagery renderer: owns the canvas context,
// the three projective-texturing programs (one per camera model) plus the
// snapshot cross-fade program, geometry and texture uploads, and the draw
// calls. No knowledge of images, links or the ride — sfm-renderer.mjs tells
// it what to draw with which matrices and opacity. Blending follows the
// viewer: alpha blending, no depth writes or tests, both faces drawn, so the
// pass order decides what is seen. Browser only (not unit-tested); every
// GL object it hands out is a plain handle the renderer gives back.

import {
  FRAGMENT_SHADER_BY_CAMERA_TYPE,
  IMAGE_VERTEX_SHADER,
  SNAPSHOT_FRAGMENT_SHADER,
  SNAPSHOT_VERTEX_SHADER,
} from "./sfm-shaders.mjs";

const IMAGE_UNIFORMS = ["projectorMat", "modelMatrix", "viewProjection", "projectorTex", "opacity", "focal", "k1", "k2", "scale_x", "scale_y", "radial_peak"];

function parseColor(hex) {
  const value = hex.replace("#", "");
  const n = parseInt(value.length === 3 ? value.replace(/(.)/g, "$1$1") : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compileProgram(gl, vertexSource, fragmentSource, uniformNames) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  const uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

export function createSfmGl(canvas, { maxPixelRatio = 1.5, clearColor = "#0f0f0f", onContextLost = () => {} } = {}) {
  const attributes = { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" };
  const gl = canvas.getContext("webgl2", attributes) || canvas.getContext("webgl", attributes);
  if (!gl) throw new Error("WebGL is not available");
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const clear = parseColor(clearColor);
  const programs = new Map();
  let snapshotProgram = null;
  let snapshotTexture = null;
  let snapshotWidth = 0;
  let snapshotHeight = 0;
  let quadBuffer = null;
  let lost = false;
  const matrixScratch = new Float32Array(16);

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    onContextLost();
  });

  function programFor(cameraType) {
    let entry = programs.get(cameraType);
    if (!entry) {
      entry = compileProgram(gl, IMAGE_VERTEX_SHADER, FRAGMENT_SHADER_BY_CAMERA_TYPE[cameraType] ?? FRAGMENT_SHADER_BY_CAMERA_TYPE.perspective, IMAGE_UNIFORMS);
      programs.set(cameraType, entry);
    }
    return entry;
  }

  function setMatrix(location, matrix) {
    for (let i = 0; i < 16; i += 1) matrixScratch[i] = matrix[i];
    gl.uniformMatrix4fv(location, false, matrixScratch);
  }

  return {
    gl,
    get lost() {
      return lost;
    },

    // Size the drawing buffer to the canvas's CSS size (capped pixel ratio).
    resize(cssWidth, cssHeight) {
      const ratio = Math.min(maxPixelRatio, globalThis.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(cssWidth * ratio));
      const height = Math.max(1, Math.round(cssHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      return { width, height, aspect: width / height };
    },

    uploadGeometry({ positions, indices }) {
      const vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      const wide = indices instanceof Uint32Array;
      if (wide && !isWebGL2 && !gl.getExtension("OES_element_index_uint")) {
        throw new Error("32-bit mesh indices need WebGL2");
      }
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return { vertexBuffer, indexBuffer, count: indices.length, indexType: wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
    },

    deleteGeometry(geometry) {
      if (!geometry) return;
      gl.deleteBuffer(geometry.vertexBuffer);
      gl.deleteBuffer(geometry.indexBuffer);
    },

    // Natural orientation (row 0 = top), linear filtering, no mipmaps.
    uploadTexture(bitmap) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    },

    deleteTexture(texture) {
      if (texture) gl.deleteTexture(texture);
    },

    beginFrame() {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    // One projective-texturing pass of an image's geometry.
    drawImage({ geometry, texture, cameraType, projectorMat, modelMatrix, viewProjection, opacity, focal, k1, k2, scaleX, scaleY, radialPeak }) {
      if (!geometry || !texture || opacity <= 0) return;
      const { program, uniforms } = programFor(cameraType);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.vertexBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geometry.indexBuffer);
      setMatrix(uniforms.projectorMat, projectorMat);
      setMatrix(uniforms.modelMatrix, modelMatrix);
      setMatrix(uniforms.viewProjection, viewProjection);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms.projectorTex, 0);
      gl.uniform1f(uniforms.opacity, opacity);
      gl.uniform1f(uniforms.focal, focal);
      gl.uniform1f(uniforms.k1, k1);
      gl.uniform1f(uniforms.k2, k2);
      gl.uniform1f(uniforms.scale_x, scaleX);
      gl.uniform1f(uniforms.scale_y, scaleY);
      gl.uniform1f(uniforms.radial_peak, radialPeak ?? 0);
      gl.drawElements(gl.TRIANGLES, geometry.count, geometry.indexType, 0);
    },

    // Copy what has been drawn this frame into the snapshot texture.
    snapshot() {
      if (!snapshotTexture) snapshotTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, snapshotTexture);
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, canvas.width, canvas.height, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      snapshotWidth = canvas.width;
      snapshotHeight = canvas.height;
    },

    get hasSnapshot() {
      return Boolean(snapshotTexture) && snapshotWidth > 0 && snapshotHeight > 0;
    },

    // Blend the snapshot over the frame at the given opacity.
    drawSnapshot(opacity) {
      if (!snapshotTexture || opacity <= 0) return;
      if (!snapshotProgram) {
        snapshotProgram = compileProgram(gl, SNAPSHOT_VERTEX_SHADER, SNAPSHOT_FRAGMENT_SHADER, ["snapshotTex", "opacity"]);
        quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      }
      gl.useProgram(snapshotProgram.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, snapshotTexture);
      gl.uniform1i(snapshotProgram.uniforms.snapshotTex, 0);
      gl.uniform1f(snapshotProgram.uniforms.opacity, opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    dropSnapshot() {
      snapshotWidth = 0;
      snapshotHeight = 0;
    },

    dispose() {
      for (const { program } of programs.values()) gl.deleteProgram(program);
      programs.clear();
      if (snapshotProgram) gl.deleteProgram(snapshotProgram.program);
      if (snapshotTexture) gl.deleteTexture(snapshotTexture);
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      snapshotProgram = null;
      snapshotTexture = null;
      quadBuffer = null;
      const extension = gl.getExtension("WEBGL_lose_context");
      if (extension && !lost) extension.loseContext();
    },
  };
}
