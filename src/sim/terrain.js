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

// --- Ground surfaces ----------------------------------------------------------
// What the wheels roll on. Rolling resistance is a coefficient of the wheel
// load; `stiction` is how much more it takes to break a parked model away;
// `drag` scales sliding friction (skids, belly slides) in longer grass;
// `bump` is the amplitude (m) of the uneven ground the gear rolls over.
export const RUNWAY = { x: 0, z: -22, length: 180, width: 18 };
export const PILOT_PAD = { x: 0, z: 0.5, length: 6, width: 4 };

export const SURFACES = {
  runway: { name: 'mown runway', roll: 0.06, stiction: 2, drag: 1.0, bump: 0.006 },
  pad: { name: 'gravel pad', roll: 0.08, stiction: 2, drag: 1.0, bump: 0.003 },
  grass: { name: 'field grass', roll: 0.16, stiction: 2, drag: 1.3, bump: 0.02 },
  rough: { name: 'rough grass', roll: 0.22, stiction: 2, drag: 1.5, bump: 0.035 },
};

const inRect = (r, x, z) => Math.abs(x - r.x) <= r.length / 2 && Math.abs(z - r.z) <= r.width / 2;

export function surfaceAt(x, z) {
  if (inRect(RUNWAY, x, z)) return SURFACES.runway;
  if (inRect(PILOT_PAD, x, z)) return SURFACES.pad;
  return Math.hypot(x, z + 40) < FIELD_RADIUS ? SURFACES.grass : SURFACES.rough;
}

// Small bumps (~0.7 m across) on top of the terrain. Too small to see on the
// 25 m render grid, but the wheels feel them.
function bumpNoise(x, z) {
  return smoothNoise(x / 0.7 + 1000, z / 0.7 + 1000) * 0.65 + smoothNoise(x / 0.25 + 500, z / 0.25 + 500) * 0.35 - 0.5;
}

export function bumpyHeightAt(x, z) {
  return heightAt(x, z) + surfaceAt(x, z).bump * 2 * bumpNoise(x, z);
}

/** Terrain as the gear feels it (bumpy), and its surface type. */
export const physicsGround = {
  heightAt: bumpyHeightAt,
  normalAt(x, z, out) {
    const e = 0.05; // small enough to feel individual bumps
    const hx = bumpyHeightAt(x + e, z) - bumpyHeightAt(x - e, z);
    const hz = bumpyHeightAt(x, z + e) - bumpyHeightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  },
  surfaceAt,
};

export const ground = { heightAt, normalAt, surfaceAt };
