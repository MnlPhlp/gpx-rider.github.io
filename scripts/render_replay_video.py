#!/usr/bin/env python3
"""Render a recorded ride (FIT, or GPX with timestamps) into a video — headless.

The optional batch alternative to the app's own "Record video" (which renders
frame by frame inside the browser and needs no setup). Use this when you want
no browser window at all — overnight batches, a server with a GPU. It drives
a headless Chromium through Playwright: the app is opened with `?render=1`,
which freezes its clock (app/core/clock.mjs) and exposes
`window.gpxRiderRender` (app/replay/render-hook.mjs). The script configures
the recording view (hidden overlays, playback speed, camera, viewport size),
starts the replay and then, for every output frame, advances the app clock by
exactly one frame, waits for the map's tile requests to settle, screenshots
the viewport and pipes the image into ffmpeg. The ride, camera and HUD
therefore move deterministically — the video is identical however fast or
slow frames are captured. Speed is bounded by screenshot capture plus tile
loading (several frames per second), so a high `--speed` multiplier is what
makes a long ride render quickly.

Requirements (not needed by the app itself):
  pip install playwright      # the Python package; the browser can be
  playwright install chromium #   Playwright's own build, or --chrome PATH
  ffmpeg on PATH
  A GPU reachable through Vulkan: Chrome 154 dropped software WebGL, so a
  headless Chromium without GPU access shows a blank map (use --headed on a
  machine with a display as a fallback).

Settings shared with the app come from app/core/tuning.yaml (ride_replay.render
and ride_replay.video); every CLI flag below overrides its tuning default. The
Maps API key is served the same way `make run` does — via scripts/dev_server.py
with `.maps-api-key` or MAPS_API_KEY.

Example (as copied from the recording view's "Copy render command" button):
  python3 scripts/render_replay_video.py ride.fit --speed 8 --hide clock,minimap
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tuning_config import load_tuning  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
# Same port as `make run`: a Maps key restricted to http://127.0.0.1:5173/*
# would reject any other origin with RefererNotAllowedMapError.
DEFAULT_PORT = 5173
HIDE_KEYS = ("clock", "meters", "dock", "climb-banner", "demo-chip", "controls", "minimap")
CHROME_CANDIDATES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")


def parse_args():
    tuning = load_tuning()
    render = tuning["ride_replay"]["render"]
    video = tuning["ride_replay"]["video"]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ride", help="recorded ride: a .fit file or a .gpx with timestamps")
    parser.add_argument("-o", "--output", help="output video path (default: <ride>.mp4 next to the ride)")
    parser.add_argument("--speed", type=float, default=tuning["ride_replay"]["default_speed"],
                        help="playback multiplier (default %(default)s)")
    parser.add_argument("--camera", choices=("follow", "first-person"), default="follow",
                        help="rider camera (default: the angled follow camera)")
    parser.add_argument("--hide", default="", help="comma-separated overlays to hide: " + ",".join(HIDE_KEYS))
    parser.add_argument("--fps", type=int, default=render["fps"], help="video frame rate (default %(default)s)")
    parser.add_argument("--size", default=f"{render['output_width']}x{render['output_height']}",
                        help="output size WxH (default %(default)s)")
    parser.add_argument("--scale", type=float, default=render["css_scale"],
                        help="device pixels per CSS pixel; the page is laid out at size/scale (default %(default)s)")
    parser.add_argument("--intro", type=float, default=video["intro_seconds"],
                        help="seconds of route overview before the ride starts (default %(default)s)")
    parser.add_argument("--outro", type=float, default=video["outro_seconds"],
                        help="seconds of finish-line orbit after the ride ends (default %(default)s)")
    parser.add_argument("--settle-ms", type=int, default=render["settle_timeout_ms"],
                        help="max wait per frame for map tiles to finish loading (default %(default)s)")
    parser.add_argument("--quality", type=int, default=render["jpeg_quality"], help="frame capture JPEG quality")
    parser.add_argument("--crf", type=int, default=render["crf"], help="x264 CRF (default %(default)s)")
    parser.add_argument("--max-ride-seconds", type=float, default=None,
                        help="stop after this much ride time (for quick tests)")
    parser.add_argument("--chrome", help="path to a Chrome/Chromium executable (default: Playwright's chromium, else a system Chrome)")
    parser.add_argument("--headed", action="store_true", help="show the browser window (needs a display; works without Vulkan)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="dev server port; a server already running there (e.g. `make run`) is reused "
                             "(default %(default)s — the origin a referrer-restricted Maps key is usually allowed for)")
    args = parser.parse_args()
    args.chrome_args = list(render.get("chrome_args", []))
    return args


def main():
    args = parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright for Python is not installed. Run: pip install playwright && playwright install chromium")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg was not found on PATH.")

    ride = Path(args.ride).expanduser().resolve()
    if not ride.is_file():
        sys.exit(f"Ride file not found: {ride}")
    output = Path(args.output).expanduser() if args.output else ride.with_suffix(".mp4")
    hide = [key for key in args.hide.split(",") if key]
    for key in hide:
        if key not in HIDE_KEYS:
            sys.exit(f"Unknown overlay '{key}'. Choose from: {', '.join(HIDE_KEYS)}")
    out_w, out_h = (int(value) for value in args.size.lower().split("x"))
    css_w, css_h = round(out_w / args.scale), round(out_h / args.scale)
    frame_ms = 1000.0 / args.fps

    port = args.port
    server = start_dev_server(port)
    ffmpeg = None
    try:
        with sync_playwright() as playwright:
            browser = launch_browser(playwright, args)
            # The window is exactly the recording viewport (render mode pins
            # the map to it edge to edge), so the element screenshot is the frame.
            context = browser.new_context(viewport={"width": css_w, "height": css_h}, device_scale_factor=args.scale)
            page = context.new_page()
            in_flight = InFlightRequests(page)
            page.on("console", lambda message: print(f"  [browser] {message.text}", file=sys.stderr) if message.type == "error" else None)

            page.goto(f"http://127.0.0.1:{port}/app/app.html?render=1")
            page.wait_for_function("() => window.gpxRiderRender && window.gpxRiderRender.status().mapReady", timeout=60_000)
            # The theater viewport is centered in the window; make the window
            # exactly the viewport so nothing else is captured.
            page.set_input_files("#replayFile", str(ride))
            page.wait_for_function("() => window.gpxRiderRender.status().replayLoaded", timeout=60_000)
            status = page.evaluate(
                "(options) => window.gpxRiderRender.configure(options)",
                {"hide": hide, "speed": args.speed, "camera": args.camera, "width": css_w, "height": css_h},
            )
            duration = status["durationSeconds"]
            print(f"Ride: {ride.name} — {fmt_seconds(duration)} of ride time, {args.speed:g}× → "
                  f"~{fmt_seconds(duration / args.speed + args.intro + args.outro)} of video at {out_w}×{out_h} {args.fps} fps")
            # Let the overview's tiles stream in before the first frame.
            in_flight.wait_idle(page, timeout_ms=15_000, quiet_ms=800)

            viewport = page.locator("#mapViewport")
            ffmpeg = start_ffmpeg(output, args.fps, args.crf)
            started = time.time()
            frames = 0

            def capture():
                nonlocal frames
                frame = viewport.screenshot(type="jpeg", quality=args.quality)
                try:
                    ffmpeg.stdin.write(frame)
                except BrokenPipeError:
                    sys.exit(f"ffmpeg stopped accepting frames: {ffmpeg_error(ffmpeg) or 'no error output'}")
                frames += 1

            def step():
                result = page.evaluate("(ms) => window.gpxRiderRender.step(ms)", frame_ms)
                in_flight.wait_idle(page, timeout_ms=args.settle_ms, quiet_ms=0)
                return result

            for _ in range(round(args.intro * args.fps)):
                step()
                capture()

            page.evaluate("() => window.gpxRiderRender.start()")
            last_report = time.time()
            while True:
                result = step()
                capture()
                if result["finished"]:
                    break
                if args.max_ride_seconds is not None and result["elapsedSeconds"] >= args.max_ride_seconds:
                    break
                if time.time() - last_report > 5:
                    last_report = time.time()
                    done = result["elapsedSeconds"] / duration if duration else 1
                    rate = frames / max(1e-6, time.time() - started)
                    remaining_frames = (duration - result["elapsedSeconds"]) / args.speed * args.fps + args.outro * args.fps
                    print(f"  {fmt_seconds(result['elapsedSeconds'])} / {fmt_seconds(duration)} ride time "
                          f"({done:4.0%}) · {frames} frames · {rate:.1f} fps · ~{fmt_seconds(remaining_frames / max(rate, 1e-6))} left")

            for _ in range(round(args.outro * args.fps)):
                step()
                capture()

            ffmpeg.stdin.close()
            if ffmpeg.wait() != 0:
                sys.exit(f"ffmpeg failed: {ffmpeg_error(ffmpeg)}")
            ffmpeg = None
            wall = time.time() - started
            print(f"Wrote {output} — {frames} frames ({fmt_seconds(frames / args.fps)} of video) in {fmt_seconds(wall)}, {frames / wall:.1f} fps")
            browser.close()
    except KeyboardInterrupt:
        print("\nInterrupted — finishing the video with the frames so far.")
    finally:
        if ffmpeg is not None:
            try:
                ffmpeg.stdin.close()
                ffmpeg.wait(timeout=30)
            except Exception:
                ffmpeg.kill()
        server.terminate()


class InFlightRequests:
    """Counts the page's outstanding network requests so a frame is captured
    once the map has finished loading what the new camera pose asked for."""

    def __init__(self, page):
        self.count = 0
        self.last_change = time.time()
        page.on("request", self._started)
        page.on("requestfinished", self._ended)
        page.on("requestfailed", self._ended)

    def _started(self, _request):
        self.count += 1
        self.last_change = time.time()

    def _ended(self, _request):
        self.count = max(0, self.count - 1)
        self.last_change = time.time()

    def wait_idle(self, page, timeout_ms, quiet_ms):
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            quiet = (time.time() - self.last_change) * 1000 >= quiet_ms
            if self.count == 0 and quiet:
                return True
            page.wait_for_timeout(15)
        return False


def launch_browser(playwright, args):
    launch = {"headless": not args.headed, "args": args.chrome_args}
    if args.chrome:
        launch["executable_path"] = args.chrome
        return playwright.chromium.launch(**launch)
    try:
        return playwright.chromium.launch(**launch)
    except Exception as error:
        for candidate in CHROME_CANDIDATES:
            path = shutil.which(candidate)
            if path:
                print(f"Playwright's chromium is not installed ({str(error).splitlines()[0][:80]}); using {path}")
                launch["executable_path"] = path
                return playwright.chromium.launch(**launch)
        raise


class ExternalServer:
    """Stand-in for a dev server that was already running (e.g. `make run`)."""

    def terminate(self):
        pass


def serving(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status == 200
    except Exception:
        return False


def start_dev_server(port):
    url = f"http://127.0.0.1:{port}/app/app.html"
    if serving(url):
        print(f"Using the server already running on port {port}.")
        return ExternalServer()
    server = subprocess.Popen(
        [sys.executable, str(REPO_ROOT / "scripts" / "dev_server.py"), str(port), "127.0.0.1"],
        cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        if serving(url):
            return server
        time.sleep(0.1)
    server.terminate()
    sys.exit(f"The dev server did not start on port {port}.")


def start_ffmpeg(output, fps, crf):
    output.parent.mkdir(parents=True, exist_ok=True)
    # JPEG frames on stdin (declared as mjpeg so image2pipe need not probe),
    # dimensions forced even for H.264, faststart for web playback.
    return subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(fps), "-i", "-",
         "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf), "-preset", "medium",
         "-movflags", "+faststart", str(output)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def ffmpeg_error(ffmpeg):
    try:
        return ffmpeg.stderr.read().decode(errors="replace").strip()
    except Exception:
        return ""


def fmt_seconds(seconds):
    seconds = max(0, int(round(seconds)))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


if __name__ == "__main__":
    main()
