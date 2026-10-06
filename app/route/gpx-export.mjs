// GPX serialization: turns route points back into a GPX 1.1 track — the
// pure counterpart of parseGpx in route.mjs. Used to hand the loaded route
// back to the user (e.g. to geotag a ride video with mapillary_tools), since
// the original GPX text is not kept after a load.

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function serializeGpx(points, { name = null, creator = "GPX Rider" } = {}) {
  const nameTag = name ? `<name>${escapeXml(name)}</name>` : "";
  const trackpoints = points.map((point) => {
    const ele = Number.isFinite(point.ele) ? `<ele>${Number(point.ele.toFixed(1))}</ele>` : "";
    return `<trkpt lat="${Number(point.lat.toFixed(7))}" lon="${Number(point.lng.toFixed(7))}">${ele}</trkpt>`;
  });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
  ];
  if (nameTag) lines.push(`<metadata>${nameTag}</metadata>`);
  lines.push(`<trk>${nameTag}<trkseg>`, ...trackpoints, "</trkseg></trk>", "</gpx>", "");
  return lines.join("\n");
}
