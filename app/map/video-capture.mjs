// Video capture of the map viewport: the moving-picture sibling of
// screenshot.mjs. The 3D map's WebGL canvas lives in a closed shadow root and
// cannot be read directly, so — exactly like the screenshot — the browser's
// own tab capture (getDisplayMedia with preferCurrentTab) streams the rendered
// tab, cropped to the viewport element by Region Capture where the browser
// supports it (else by mapping its rectangle onto the frame). `openTabCapture`
// turns that into a canvas the viewport is drawn onto, whole, at the output
// size, so every export has exact, repeatable pixel dimensions regardless of
// window size or device pixel ratio — the viewport itself (theater mode) sets
// the frame's aspect, nothing is cropped away. `startViewportRecording` records that canvas in real time
// through a MediaRecorder. Chrome keeps rendering a tab it is capturing, so
// the recording keeps going with the tab in the background. Because the frame
// is what the browser composited, Google's logo and legal notices are always
// part of the video — never draw over or crop them out.
//
// Owns only its own capture state; reports upward through the returned
// controller and the `onMessage` callback. Pure helpers (`pickRecorderMimeType`,
// `videoFileExtension`) are exported for tests.

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
// (+ 2D `context`) sized to the output, `drawFrame()` which draws the
// viewport's current frame onto it, and `stop()`. `outputAspect` (width ÷
// height) fixes the output's shape when the viewport is meant to have it
// but rounds to whole pixels (a scaled-down theater viewport); without it
// the captured shape is kept. Rejects if the user dismisses the share
// picker.
export async function openTabCapture(viewport, { outputWidth = null, outputAspect = null, frameRate = 30 } = {}) {
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

  // Region Capture (Chrome 104+): the browser crops the tab capture to the
  // viewport element itself, so the frames *are* the viewport at device
  // pixels — exact whatever the device pixel ratio, zoom or scrollbars, and
  // following the element if it moves or resizes. Without it, the viewport's
  // CSS rectangle is mapped onto the frame below.
  let cropped = false;
  const [track] = stream.getVideoTracks();
  if (typeof CropTarget === "function" && typeof track?.cropTo === "function") {
    try {
      await track.cropTo(await CropTarget.fromElement(viewport));
      await nextVideoFrame(video);
      cropped = true;
    } catch (error) {
      console.warn("Region capture unavailable; mapping the viewport onto the frame instead.", error);
    }
  }

  // Map the viewport's CSS rectangle onto the captured frame. When the user
  // shares the current tab the frame covers exactly the page viewport, so
  // the ratio of frame size to window size is the capture scale (device
  // pixel ratio included).
  const geometry = () => {
    if (cropped) return { sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight };
    const rect = viewport.getBoundingClientRect();
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    return {
      sx: Math.max(0, Math.round(rect.left * scaleX)),
      sy: Math.max(0, Math.round(rect.top * scaleY)),
      sw: Math.min(video.videoWidth, Math.round(rect.width * scaleX)),
      sh: Math.min(video.videoHeight, Math.round(rect.height * scaleY)),
    };
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
  // The output keeps the viewport's aspect at the requested width (or the
  // captured size as is). Even dimensions keep every H.264/VP9 encoder happy.
  const targetWidth = Number(outputWidth) > 0 ? Math.round(outputWidth) : first.sw;
  const evenWidth = targetWidth - (targetWidth % 2);
  const rawHeight = Math.round(evenWidth / (Number(outputAspect) > 0 ? Number(outputAspect) : first.sw / first.sh));
  const evenHeight = rawHeight - (rawHeight % 2);

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
// discards it, `mimeType` says what was encoded, `bytes` how much has been
// encoded so far, and `outputWidth`/`outputHeight` the frame size. Rejects if
// the user dismisses the share picker or nothing can encode.
export async function startViewportRecording(viewport, {
  outputWidth = null,
  outputAspect = null,
  frameRate = 30,
  videoBitsPerSecond = null,
  mimeTypePreferences = [],
  onMessage = null,
  onEnded = null,
} = {}) {
  const mimeType = pickRecorderMimeType(mimeTypePreferences);
  if (!mimeType) throw new Error("This browser cannot encode a video.");

  const capture = await openTabCapture(viewport, { outputWidth, outputAspect, frameRate });
  const { video, canvas } = capture;

  // Redraw on every presented capture frame (not on animation frames, which
  // can outpace the capture and would only redraw the same frame).
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
  // Each timeslice's data is a Blob the browser may page to disk; the file is
  // concatenated from them at the end without copying through the JS heap.
  const chunks = [];
  let bytes = 0;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
      bytes += event.data.size;
    }
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
    get bytes() {
      return bytes;
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
