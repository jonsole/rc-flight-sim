// Terrain height field shared by physics and rendering.
//
// The flying field (a ~400 m circle around the pilot) is flat at y = 0;
// beyond it, gentle rolling hills rise towards the horizon.

const FIELD_RADIUS = 260;
const BLEND = 200;

function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * smoothNoise(x * freq, z * freq);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 1.875;
}

/** The analytic terrain shape, before it is sampled onto the grid. */
function shapeHeight(x, z) {
  const r = Math.hypot(x, z + 40);
  if (r < FIELD_RADIUS) return 0;
  const t = Math.min(1, (r - FIELD_RADIUS) / BLEND);
  const blend = t * t * (3 - 2 * t);
  const hills = fbm(x / 220, z / 220) * 55 + fbm(x / 60, z / 60) * 6;
  const far = Math.max(0, (r - 900) / 1200) * 120 * fbm(x / 600 + 7, z / 600 + 3);
  return blend * (hills - 8) + far;
}

// --- Triangulated terrain -------------------------------------------------
// The rendered terrain is a grid of triangles, so between grid points it is
// flat-faceted. Physics must use exactly the same surface, or wheels and trees
// float above or sink into the drawn hills. Heights are sampled once onto the
// grid and interpolated over the same triangles three.js's PlaneGeometry uses:
// in each cell the diagonal runs from (ix, iz+1) to (ix+1, iz).
export const TERRAIN_SIZE = 7000;
export const TERRAIN_SEGMENTS = 280;
const CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;
const HALF = TERRAIN_SIZE / 2;
const N = TERRAIN_SEGMENTS + 1;
const grid = new Float32Array(N * N);
for (let iz = 0; iz < N; iz++) {
  for (let ix = 0; ix < N; ix++) grid[iz * N + ix] = shapeHeight(-HALF + ix * CELL, -HALF + iz * CELL);
}

/** Height of grid vertex (ix, iz); world x = -HALF + ix*CELL, z = -HALF + iz*CELL. */
export function gridHeight(ix, iz) {
  return grid[iz * N + ix];
}

export function heightAt(x, z) {
  const fx = (x + HALF) / CELL;
  const fz = (z + HALF) / CELL;
  if (fx < 0 || fz < 0 || fx >= TERRAIN_SEGMENTS || fz >= TERRAIN_SEGMENTS) return shapeHeight(x, z);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const ha = grid[iz * N + ix]; // (0,0)
  const hb = grid[(iz + 1) * N + ix]; // (0,1)
  const hc = grid[(iz + 1) * N + ix + 1]; // (1,1)
  const hd = grid[iz * N + ix + 1]; // (1,0)
  if (u + v <= 1) return ha + (hd - ha) * u + (hb - ha) * v; // triangle a-b-d
  return hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v); // triangle b-c-d
}

export function normalAt(x, z, out) {
  const e = 0.5;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  out.set(-hx, 2 * e, -hz).normalize();
  return out;
}

export const ground = { heightAt, normalAt };
