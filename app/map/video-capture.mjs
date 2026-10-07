// Video capture of the map viewport: the moving-picture sibling of
// screenshot.mjs. The 3D map's WebGL canvas lives in a closed shadow root and
// cannot be read directly, so — exactly like the screenshot — the browser's
// own tab capture (getDisplayMedia with preferCurrentTab) streams the rendered
// tab. `openTabCapture` turns that into a canvas the viewport's rectangle
// (and the chosen aspect ratio) is drawn onto at the output size, so every
// export has exact, repeatable pixel dimensions regardless of window size or
// device pixel ratio. Two consumers: `startViewportRecording` here records
// the canvas in real time through a MediaRecorder (the fallback path), and
// stepped-video.mjs samples it one frame per app-clock step. Because the
// frame is what the browser composited, Google's logo and legal notices are
// always part of the video — never draw over or crop them out.
//
// Owns only its own capture state; reports upward through the returned
// controller and the `onMessage` callback. Pure helpers (`pickRecorderMimeType`,
// `videoFileExtension`) are exported for tests.

import { centerCropForAspect } from "./screenshot.mjs";

export function videoCaptureSupported() {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function"
    && typeof window.MediaRecorder === "function"
    && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

// First MIME type in `preferences` the recorder can encode, or null.
// `isTypeSupported` is injected so the choice is unit-testable.
export function pickRecorderMimeType(preferences, isTypeSupported = (type) => MediaRecorder.isTypeSupported(type)) {
  for (const type of preferences ?? []) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // An unknown container string throws in some browsers; try the next.
    }
  }
  return null;
}

// "video/mp4;codecs=avc1" → "mp4", "video/webm;codecs=vp9" → "webm".
export function videoFileExtension(mimeType) {
  const container = String(mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (container === "video/mp4") return "mp4";
  if (container === "video/x-matroska") return "mkv";
  return "webm";
}

// Asks the browser to share the current tab and resolves, once frames flow,
// with the capture plumbing: the `<video>` the stream plays in, a `canvas`
// (+ 2D `context`) sized to the output, `drawFrame()` which crops the
// viewport's current frame onto it, and `stop()`. Rejects if the user
// dismisses the share picker.
export async function openTabCapture(viewport, { aspectRatio = null, outputWidth = null, frameRate = 30 } = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { preferCurrentTab: true, frameRate: { ideal: frameRate } },
    audio: false,
    // Chrome-only hints; unknown members are ignored elsewhere.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  });

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await nextVideoFrame(video);

  // Map the viewport's CSS rectangle onto the captured frame. When the user
  // shares the current tab the frame covers exactly the page viewport, so
  // the ratio of frame size to window size is the capture scale (device
  // pixel ratio included).
  const geometry = () => {
    const rect = viewport.getBoundingClientRect();
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const crop = {
      x: Math.max(0, Math.round(rect.left * scaleX)),
      y: Math.max(0, Math.round(rect.top * scaleY)),
      width: Math.min(video.videoWidth, Math.round(rect.width * scaleX)),
      height: Math.min(video.videoHeight, Math.round(rect.height * scaleY)),
    };
    const sub = centerCropForAspect(crop, aspectRatio);
    return { sx: crop.x + sub.x, sy: crop.y + sub.y, sw: sub.width, sh: sub.height };
  };

  const stop = () => {
    video.srcObject = null;
    stream.getTracks().forEach((track) => track.stop());
  };

  const first = geometry();
  if (first.sw < 2 || first.sh < 2) {
    stop();
    throw new Error("Empty capture area.");
  }
  const targetWidth = Number(outputWidth) > 0 ? Math.round(outputWidth) : first.sw;
  // Even dimensions keep every H.264/VP9 encoder happy.
  const evenWidth = targetWidth - (targetWidth % 2);
  const rawHeight = aspectRatio ? evenWidth / aspectRatio : evenWidth * (first.sh / first.sw);
  const evenHeight = Math.round(rawHeight) - (Math.round(rawHeight) % 2);

  const canvas = document.createElement("canvas");
  canvas.width = evenWidth;
  canvas.height = evenHeight;
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingQuality = "high";

  const drawFrame = () => {
    const g = geometry();
    if (g.sw >= 2 && g.sh >= 2) {
      context.drawImage(video, g.sx, g.sy, g.sw, g.sh, 0, 0, canvas.width, canvas.height);
    }
  };

  return { stream, video, canvas, context, drawFrame, stop };
}

// Starts recording `viewport` in real time. Resolves once frames are flowing
// — the caller then starts whatever it wants recorded — with a controller:
// `stop()` ends the recording and resolves to the encoded Blob, `cancel()`
// discards it, `mimeType` says what was encoded, and
// `outputWidth`/`outputHeight` the frame size. Rejects if the user dismisses
// the share picker or nothing can encode.
export async function startViewportRecording(viewport, {
  aspectRatio = null,
  outputWidth = null,
  frameRate = 30,
  videoBitsPerSecond = null,
  mimeTypePreferences = [],
  onMessage = null,
  onEnded = null,
} = {}) {
  const mimeType = pickRecorderMimeType(mimeTypePreferences);
  if (!mimeType) throw new Error("This browser cannot encode a video.");

  const capture = await openTabCapture(viewport, { aspectRatio, outputWidth, frameRate });
  const { video, canvas } = capture;

  let drawing = true;
  const drawLoop = () => {
    if (!drawing) return;
    capture.drawFrame();
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(drawLoop);
    } else {
      requestAnimationFrame(drawLoop);
    }
  };
  drawLoop();

  const canvasStream = canvas.captureStream(frameRate);
  const recorderOptions = { mimeType };
  if (Number(videoBitsPerSecond) > 0) recorderOptions.videoBitsPerSecond = Number(videoBitsPerSecond);
  const recorder = new MediaRecorder(canvasStream, recorderOptions);
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });

  let settle = null;
  const done = new Promise((resolve) => { settle = resolve; });
  recorder.addEventListener("stop", () => settle(new Blob(chunks, { type: mimeType })));
  recorder.addEventListener("error", (event) => {
    console.error("Video recorder error.", event.error ?? event);
    onMessage?.("Video recording failed.");
    settle(null);
  });

  // The user can end the share from the browser's own "Stop sharing" bar;
  // treat that like pressing stop.
  for (const track of capture.stream.getVideoTracks()) {
    track.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop();
      onEnded?.();
    });
  }

  function stopStream() {
    drawing = false;
    capture.stop();
    canvasStream.getTracks().forEach((track) => track.stop());
  }

  // Timeslice keeps memory bounded and makes a crash lose seconds, not all.
  recorder.start(1000);

  return {
    mimeType,
    outputWidth: canvas.width,
    outputHeight: canvas.height,
    get recording() {
      return recorder.state === "recording";
    },
    async stop() {
      if (recorder.state !== "inactive") recorder.stop();
      const blob = await done;
      stopStream();
      return blob;
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      stopStream();
      settle(null);
    },
  };
}

// Wait for a frame rendered after the share picker closed, so the picker is
// not part of the first captured frames.
function nextVideoFrame(video) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => video.requestVideoFrameCallback(() => resolve()));
    } else {
      setTimeout(resolve, 300);
    }
  });
}

export function downloadVideoBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the click has been handed to the download manager.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
