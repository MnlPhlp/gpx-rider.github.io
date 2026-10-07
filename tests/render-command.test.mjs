import assert from "node:assert/strict";
import test from "node:test";
import { buildRenderCommand, hiddenOverlayKeys, RIDE_FILE_PLACEHOLDER } from "../app/replay/render-command.mjs";

test("the default command is just the script and the file placeholder", () => {
  assert.equal(buildRenderCommand(), `python3 scripts/render_replay_video.py ${RIDE_FILE_PLACEHOLDER}`);
});

test("speed, camera and hidden overlays become flags", () => {
  assert.equal(
    buildRenderCommand({ speed: 8, camera: "first-person", hide: ["clock", "minimap"], rideFile: "ride.fit" }),
    "python3 scripts/render_replay_video.py ride.fit --speed 8 --camera first-person --hide clock,minimap",
  );
  // Real time and the follow camera are the script's defaults — no flags.
  assert.equal(buildRenderCommand({ speed: 1, camera: "follow", rideFile: "a.gpx" }), "python3 scripts/render_replay_video.py a.gpx");
});

test("file names with spaces are quoted for the shell", () => {
  assert.equal(
    buildRenderCommand({ rideFile: "Morning ride.fit" }),
    "python3 scripts/render_replay_video.py 'Morning ride.fit'",
  );
});

test("theater hide flags map to the script's overlay keys in a fixed order", () => {
  assert.deepEqual(hiddenOverlayKeys({ minimap: true, clock: true, climbBanner: true }), ["clock", "climb-banner", "minimap"]);
  assert.deepEqual(hiddenOverlayKeys({ routeAhead: true, minimap: true }), ["minimap", "route-ahead"]);
  assert.deepEqual(hiddenOverlayKeys(), []);
});
