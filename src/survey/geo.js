// Survey maths: GPS (WGS84 latitude/longitude) to the British National Grid
// and to a site's world frame, and averaging a run of GPS fixes into one point.
//
// The grid conversion is the Ordnance Survey's 7-parameter Helmert shift
// (WGS84 -> OSGB36) followed by the Transverse Mercator projection. It is good
// to about 2 m, and it is the same conversion tools/bake_location.py used to
// place the OpenStreetMap layer, so surveyed points line up with the baked map.
// Survey exports keep the raw latitude/longitude too, for a finer conversion
// (OSTN15) later.

const DEG = Math.PI / 180;
const SEC = DEG / 3600;

// WGS84 and Airy 1830 ellipsoids.
const WGS84 = { a: 6378137.0, b: 6356752.314245 };
const AIRY = { a: 6377563.396, b: 6356256.909 };

// WGS84 -> OSGB36 Helmert parameters (metres, ppm, arc seconds).
const H = { tx: -446.448, ty: 125.157, tz: -542.060, s: 20.4894, rx: -0.1502, ry: -0.2470, rz: -0.8421 };

// National Grid projection.
const TM = { F0: 0.9996012717, lat0: 49 * DEG, lon0: -2 * DEG, E0: 400000, N0: -100000 };

function toCartesian(lat, lon, h, { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const sl = Math.sin(lat);
  const nu = a / Math.sqrt(1 - e2 * sl * sl);
  return [(nu + h) * Math.cos(lat) * Math.cos(lon), (nu + h) * Math.cos(lat) * Math.sin(lon), (nu * (1 - e2) + h) * sl];
}

function toGeodetic([x, y, z], { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const sl = Math.sin(lat);
    const nu = a / Math.sqrt(1 - e2 * sl * sl);
    lat = Math.atan2(z + e2 * nu * sl, p);
  }
  return [lat, Math.atan2(y, x)];
}

function helmert([x, y, z]) {
  const s = 1 + H.s * 1e-6;
  const rx = H.rx * SEC, ry = H.ry * SEC, rz = H.rz * SEC;
  return [
    H.tx + s * x - rz * y + ry * z,
    H.ty + rz * x + s * y - rx * z,
    H.tz - ry * x + rx * y + s * z,
  ];
}

/** OSGB36 latitude/longitude (radians) to National Grid easting/northing (metres). */
export function projectOsgb(lat, lon) {
  const { a, b } = AIRY;
  const { F0, lat0, lon0, E0, N0 } = TM;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n, n3 = n2 * n;
  const sl = Math.sin(lat), cl = Math.cos(lat), tl = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sl * sl);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sl * sl, 1.5);
  const eta2 = nu / rho - 1;
  const dl = lat - lat0, sl2 = lat + lat0;
  const M = b * F0 * (
    (1 + n + 1.25 * n2 + 1.25 * n3) * dl
    - (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dl) * Math.cos(sl2)
    + (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dl) * Math.cos(2 * sl2)
    - (35 / 24) * n3 * Math.sin(3 * dl) * Math.cos(3 * sl2));
  const I = M + N0;
  const II = (nu / 2) * sl * cl;
  const III = (nu / 24) * sl * cl ** 3 * (5 - tl ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sl * cl ** 5 * (61 - 58 * tl ** 2 + tl ** 4);
  const IV = nu * cl;
  const V = (nu / 6) * cl ** 3 * (nu / rho - tl ** 2);
  const VI = (nu / 120) * cl ** 5 * (5 - 18 * tl ** 2 + tl ** 4 + 14 * eta2 - 58 * tl ** 2 * eta2);
  const d = lon - lon0;
  return {
    easting: E0 + IV * d + V * d ** 3 + VI * d ** 5,
    northing: I + II * d ** 2 + III * d ** 4 + IIIA * d ** 6,
  };
}

/** GPS latitude/longitude (degrees, WGS84) to National Grid {easting, northing}. */
export function wgs84ToOsgb(latDeg, lonDeg) {
  const [lat, lon] = toGeodetic(helmert(toCartesian(latDeg * DEG, lonDeg * DEG, 0, WGS84)), AIRY);
  return projectOsgb(lat, lon);
}

/** Grid position to a site's world frame: x east, z south (-z north), metres from the pilot. */
export function osgbToLocal({ easting, northing }, origin) {
  return { x: easting - origin.easting, z: -(northing - origin.northing) };
}

/** Ground distance in metres between two latitude/longitude points (small distances). */
export function distance(a, b) {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  return R * Math.hypot(dLat, dLon);
}

function median(v) {
  const s = [...v].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Average GPS fixes taken standing still into one position.
 * fixes: [{ lat, lon, acc }] (acc: the reported 68% accuracy radius, metres).
 * Fixes much worse than the typical one are dropped; the rest are weighted by
 * 1/acc². Returns { lat, lon, acc, spread, n, dropped } or null with no fixes:
 * acc is the median reported accuracy of the fixes kept, spread their RMS
 * distance from the average (how much the position wandered).
 */
export function averageFixes(fixes, { maxAcc = 50 } = {}) {
  const usable = fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && f.acc > 0 && f.acc <= maxAcc);
  if (!usable.length) return null;
  const cut = Math.max(2 * median(usable.map((f) => f.acc)), 5);
  const kept = usable.filter((f) => f.acc <= cut);
  let sw = 0, slat = 0, slon = 0;
  for (const f of kept) {
    const w = 1 / (f.acc * f.acc);
    sw += w; slat += w * f.lat; slon += w * f.lon;
  }
  const mean = { lat: slat / sw, lon: slon / sw };
  const spread = Math.sqrt(kept.reduce((s, f) => s + distance(mean, f) ** 2, 0) / kept.length);
  return { ...mean, acc: median(kept.map((f) => f.acc)), spread, n: kept.length, dropped: fixes.length - kept.length };
}
