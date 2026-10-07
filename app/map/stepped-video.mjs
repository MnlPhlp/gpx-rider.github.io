// Stepped (deterministic) video capture of the map viewport. The sibling of
// video-capture.mjs for exports that do not run in real time: the caller
// freezes the app clock and advances it one frame at a time, and this module
// turns the frames the browser composites for those steps into an MP4 — so a
// long ride renders as fast as the page can draw and the encoder can encode,
// not as long as it took to ride.
//
// Pixels still come from the browser's tab capture (the 3D map's canvas is
// unreadable, see screenshot.mjs), but the stream is only *sampled* here, and
// which captured frame shows which step is never guessed: for every step the
// caller stamps a frame tag (frame-tag.mjs) — a small color swatch fixed in
// the window's top-left corner, outside the recorded viewport — in the
// animation frame that step's render lands in. The consumer loop reads the
// swatch back from each presented capture frame and encodes the frame as the
// step it names. That lets the caller keep several steps in flight
// (`inFlight`), overlapping render, capture and encode instead of waiting out
// the pipeline's latency per frame. A step whose frame the capture dropped is
// filled with the next frame (counted in `tagMisses`), like a dropped frame
// in a live recording. Each accepted frame is cropped to the viewport and the
// chosen aspect onto a canvas at the output size, wrapped in a WebCodecs
// VideoFrame stamped frameIndex / fps, encoded as H.264 and muxed into an MP4
// by the vendored mp4-muxer (app/vendor/mp4-muxer, MIT). Timing in the file
// is exact however long frames took to produce. Google's attribution is part
// of every captured frame and must never be cropped or drawn over.
//
// Owns only its own capture/encode state; reports through the returned
// controller. `steppedVideoSupported()` gates the feature — browsers without
// WebCodecs fall back to the real-time MediaRecorder path.

import { decodeFrameTag, encodeFrameTag, FRAME_TAG_COUNT } from "./frame-tag.mjs";
import { openTabCapture } from "./video-capture.mjs";

// H.264 High profile, level 4.2 (1080p60-class). Hardware encoders are tried
// first by the browser; `prefer-hardware` is a hint, not a requirement.
const AVC_CODEC = "avc1.640028";
// The tag swatch in CSS pixels, and the inset sampled from its middle so
// edge blending never reaches the sample.
const TAG_SIZE_PX = 12;
const TAG_INSET_PX = 4;
// A tag this far ahead of the next expected step (mod FRAME_TAG_COUNT) is a
// stale frame from before it, not a skipped step.
const TAG_STALE_DISTANCE = FRAME_TAG_COUNT / 2;
// Encoder backlog at which the caller should stop producing steps.
const ENCODER_BUSY_QUEUE = 3;

export function steppedVideoSupported() {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function"
    && typeof window.VideoEncoder === "function"
    && typeof window.VideoFrame === "function";
}

// Opens the tab capture, the encoder and the consumer loop. Resolves to a
// controller:
//   onPresented     → set by the caller; called after every presented capture
//                     frame — the producer's pacing signal
//   tagStep(step)   → stamps the swatch for `step` (0-based); call it in the
//                     animation frame the step has rendered in
//   inFlight        → steps tagged but not yet encoded
//   busy            → the encoder is backlogged; hold off producing
//   frames, tagMisses, outputWidth, outputHeight
//   finish()        → drains the in-flight steps, flushes and muxes; resolves
//                     to the MP4 Blob
//   cancel()        → discards everything
export async function startSteppedRecording(viewport, {
  aspectRatio = null,
  outputWidth = null,
  frameRate = 30,
  captureFrameRate = 120,
  videoBitsPerSecond = null,
  onEnded = null,
} = {}) {
  if (!steppedVideoSupported()) throw new Error("This browser cannot encode video frames (WebCodecs).");

  // Ask for the fastest capture the display allows: the consumer can only
  // see steps the capture presents, so the capture rate — at most the
  // display's refresh rate — is the export's ceiling in steps per second.
  const capture = await openTabCapture(viewport, { aspectRatio, outputWidth, frameRate: captureFrameRate });
  const { canvas, video } = capture;

  const encoderConfig = {
    codec: AVC_CODEC,
    width: canvas.width,
    height: canvas.height,
    framerate: frameRate,
    bitrate: Number(videoBitsPerSecond) > 0 ? Number(videoBitsPerSecond) : undefined,
    latencyMode: "quality",
    avc: { format: "avc" },
  };
  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    capture.stop();
    throw new Error(`H.264 encoding at ${canvas.width}×${canvas.height} is not supported here.`);
  }

  const { ArrayBufferTarget, Muxer } = await import("../vendor/mp4-muxer/mp4-muxer.mjs");
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: canvas.width, height: canvas.height, frameRate },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      console.error("Video encoder error.", error);
      encodeError = error;
    },
  });
  encoder.configure(encoderConfig);

  // The tag swatch, and the 1×1 canvas it is read back through. It starts
  // on the last tag so frames from before the first step read as stale.
  const swatch = document.createElement("div");
  swatch.className = "frame-tag";
  swatch.setAttribute("aria-hidden", "true");
  swatch.style.backgroundColor = encodeFrameTag(FRAME_TAG_COUNT - 1);
  document.body.append(swatch);
  const tagCanvas = document.createElement("canvas");
  tagCanvas.width = 1;
  tagCanvas.height = 1;
  const tagContext = tagCanvas.getContext("2d", { willReadFrequently: true });

  const readTag = () => {
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const sx = TAG_INSET_PX * scaleX;
    const sy = TAG_INSET_PX * scaleY;
    const sw = Math.max(1, (TAG_SIZE_PX - 2 * TAG_INSET_PX) * scaleX);
    const sh = Math.max(1, (TAG_SIZE_PX - 2 * TAG_INSET_PX) * scaleY);
    tagContext.drawImage(video, sx, sy, sw, sh, 0, 0, 1, 1);
    const [r, g, b] = tagContext.getImageData(0, 0, 1, 1).data;
    return decodeFrameTag(r, g, b);
  };

  const nextPresentedFrame = () => new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => resolve());
    } else {
      requestAnimationFrame(resolve);
    }
  });

  const frameDurationUs = Math.round(1_000_000 / frameRate);
  let produced = 0; // steps tagged so far (next step index)
  let frames = 0; // frames encoded (= steps consumed)
  let tagMisses = 0;
  let finished = false;

  const encodeCanvasAs = (step) => {
    const frame = new VideoFrame(canvas, {
      timestamp: step * frameDurationUs,
      duration: frameDurationUs,
    });
    // A keyframe every two seconds keeps seeking snappy in players.
    encoder.encode(frame, { keyFrame: step % (frameRate * 2) === 0 });
    frame.close();
  };

  // Consumer: every presented capture frame is attributed to the step its
  // tag names. Frames behind the next expected step are stale and skipped;
  // a tag ahead of it means the capture dropped the steps in between, which
  // are filled with this frame.
  // After each presented frame the controller's `onPresented` fires: the
  // producer paces its steps on it, so steps are never produced faster than
  // the capture can show them (which would drop every surplus step).
  // (Getters must be defined on the object itself — Object.assign would copy
  // their values once and freeze them.)
  const controller = {
    onPresented: null,
    outputWidth: canvas.width,
    outputHeight: canvas.height,
    get frames() {
      return frames;
    },
    get tagMisses() {
      return tagMisses;
    },
    get inFlight() {
      return produced - frames;
    },
    get busy() {
      return encoder.encodeQueueSize > ENCODER_BUSY_QUEUE;
    },
    get error() {
      return encodeError;
    },
    tagStep(step) {
      if (finished) return;
      produced = Math.max(produced, step + 1);
      swatch.style.backgroundColor = encodeFrameTag(step);
    },
    async finish() {
      if (finished) return null;
      // Give the in-flight steps a moment to come through the capture.
      const deadline = performance.now() + 1500;
      while (frames < produced && performance.now() < deadline) await nextPresentedFrame();
      if (frames < produced) tagMisses += produced - frames;
      release();
      try {
        if (encoder.state === "configured") await encoder.flush();
        encoder.close();
        if (frames === 0) return null;
        muxer.finalize();
        return new Blob([muxer.target.buffer], { type: "video/mp4" });
      } catch (error) {
        console.error("Could not finish the video.", error);
        return null;
      }
    },
    cancel() {
      release();
      try {
        if (encoder.state !== "closed") encoder.close();
      } catch {
        // Closing an errored encoder throws; nothing left to release.
      }
    },
  };
  const consume = async () => {
    while (!finished) {
      await nextPresentedFrame();
      if (finished) return;
      if (frames < produced) {
        const tag = readTag();
        const ahead = (tag - (frames % FRAME_TAG_COUNT) + FRAME_TAG_COUNT) % FRAME_TAG_COUNT;
        if (ahead < TAG_STALE_DISTANCE && frames + ahead < produced) {
          capture.drawFrame();
          for (let step = frames; step <= frames + ahead; step += 1) encodeCanvasAs(step);
          tagMisses += ahead;
          frames += ahead + 1;
        }
      }
      controller.onPresented?.();
    }
  };
  void consume();

  for (const track of capture.stream.getVideoTracks()) {
    track.addEventListener("ended", () => onEnded?.());
  }

  const release = () => {
    finished = true;
    swatch.remove();
    capture.stop();
  };

  return controller;
}
