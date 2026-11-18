// Terrain height field shared by physics and rendering.
//
// Made-up club field: the flying field (a ~400 m circle around the pilot) is
// flat at y = 0; beyond it, gentle rolling hills rise towards the horizon.
// Real sites (src/sim/location.js): the LIDAR ground, levelled on the mown
// field, fading into gentle made-up country beyond the baked area, or, where
// the site has them baked (`far`: mountains), into the real country round
// about, on a bigger terrain grid.
import { LOCATION, inMown, clubAngle } from './location.js';

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

/** The made-up field's terrain shape, before it is sampled onto the grid. */
function homeHeight(x, z) {
  const r = Math.hypot(x, z + 40);
  if (r < FIELD_RADIUS) return 0;
  const t = Math.min(1, (r - FIELD_RADIUS) / BLEND);
  const blend = t * t * (3 - 2 * t);
  const hills = fbm(x / 220, z / 220) * 55 + fbm(x / 60, z / 60) * 6;
  const far = Math.max(0, (r - 900) / 1200) * 120 * fbm(x / 600 + 7, z / 600 + 3);
  return blend * (hills - 8) + far;
}

// --- Real sites ------------------------------------------------------------------
// The baked ground: heights in centimetres on a square grid of `cell` m.
let real = null;
function realTerrain() {
  const t = LOCATION.data.terrain;
  const bytes = Uint8Array.from(atob(t.cm), (c) => c.charCodeAt(0));
  const cm = new Int16Array(bytes.buffer);
  // The baked area's edge height, which the country beyond carries on at.
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < t.n; i++) {
    for (const k of [i, (t.n - 1) * t.n + i, i * t.n, i * t.n + t.n - 1]) {
      sum += cm[k];
      cnt++;
    }
  }
  return { ...t, cm, edge: sum / cnt / 100, half: ((t.n - 1) * t.cell) / 2 };
}

function sampleReal(x, z) {
  const t = real;
  const fx = Math.min(t.n - 1.001, Math.max(0, (x - t.x0) / t.cell));
  const fz = Math.min(t.n - 1.001, Math.max(0, (z - t.z0) / t.cell));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const k = iz * t.n + ix;
  const a = t.cm[k] + (t.cm[k + 1] - t.cm[k]) * u;
  const b = t.cm[k + t.n] + (t.cm[k + t.n + 1] - t.cm[k + t.n]) * u;
  return (a + (b - a) * v) / 100;
}

// The country round about (real sites with `far`): heights in decimetres
// on a coarse square grid.
let farGrid = null;
function farTerrain() {
  const t = LOCATION.data.far;
  const bytes = Uint8Array.from(atob(t.dm), (c) => c.charCodeAt(0));
  return { ...t, dm: new Int16Array(bytes.buffer) };
}

function sampleFar(x, z) {
  const t = farGrid;
  const fx = Math.min(t.n - 1.001, Math.max(0, (x - t.x0) / t.cell));
  const fz = Math.min(t.n - 1.001, Math.max(0, (z - t.z0) / t.cell));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const k = iz * t.n + ix;
  const a = t.dm[k] + (t.dm[k + 1] - t.dm[k]) * u;
  const b = t.dm[k + t.n] + (t.dm[k + t.n + 1] - t.dm[k + t.n]) * u;
  return (a + (b - a) * v) / 10;
}

function realHeight(x, z) {
  real ??= realTerrain();
  const t = real;
  // Beyond the baked area: the real country round about where it is baked,
  // else flat country at the edge height with a little gentle relief;
  // blended in over the last 150 m.
  const cx = t.x0 + t.half;
  const cz = t.z0 + t.half;
  const out = Math.max(Math.abs(x - cx), Math.abs(z - cz)) - t.half;
  let beyond;
  if (LOCATION.data.far) {
    farGrid ??= farTerrain();
    beyond = sampleFar(x, z);
  } else {
    beyond = t.edge + (fbm(x / 400, z / 400) - 0.5) * 6 + Math.max(0, out) / 200;
  }
  const w = Math.min(1, Math.max(0, (out + 150) / 150));
  let h = w >= 1 ? beyond : sampleReal(x, z) * (1 - w * w * (3 - 2 * w)) + beyond * (w * w * (3 - 2 * w));
  // The club's field is levelled (it is within a few cm anyway).
  const f = LOCATION.layout.flat;
  if (f) {
    const dx = Math.max(f.x0 - x, 0, x - f.x1);
    const dz = Math.max(f.z0 - z, 0, z - f.z1);
    const s = Math.min(1, Math.hypot(dx, dz) / f.fade);
    h *= s * s * (3 - 2 * s);
  }
  return h;
}

/** The terrain shape, before it is sampled onto the grid. */
function shapeHeight(x, z) {
  return LOCATION.data ? realHeight(x, z) : homeHeight(x, z);
}

// --- Triangulated terrain -------------------------------------------------
// The rendered terrain is a grid of triangles, so between grid points it is
// flat-faceted. Physics must use exactly the same surface, or wheels and trees
// float above or sink into the drawn hills. Heights are sampled once onto the
// grid and interpolated over the same triangles three.js's PlaneGeometry uses:
// in each cell the diagonal runs from (ix, iz+1) to (ix+1, iz).
// 7 km in 25 m cells; a site with mountains baked round it covers them, in
// cells the size of their grid's.
const FAR = LOCATION.data?.far;
export const TERRAIN_SIZE = FAR ? (FAR.n - 1) * FAR.cell : 7000;
export const TERRAIN_SEGMENTS = FAR ? FAR.n - 1 : 280;
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
export const RUNWAY = LOCATION.layout.runway;
export const PILOT_PAD = LOCATION.layout.pilotPad;

export const SURFACES = {
  runway: { name: 'mown runway', roll: 0.06, stiction: 2, drag: 1.0, bump: 0.006 },
  pitch: { name: 'cricket pitch', roll: 0.04, stiction: 2, drag: 0.9, bump: 0.002 },
  pad: { name: 'gravel pad', roll: 0.08, stiction: 2, drag: 1.0, bump: 0.003 },
  grass: { name: 'field grass', roll: 0.16, stiction: 2, drag: 1.3, bump: 0.02 },
  rough: { name: 'rough grass', roll: 0.22, stiction: 2, drag: 1.5, bump: 0.035 },
};

const inRect = (r, x, z) => Math.abs(x - r.x) <= r.length / 2 && Math.abs(z - r.z) <= r.width / 2;

// The runway and pad are laid out in the club frame (src/sim/location.js).
const CLUB_COS = Math.cos(clubAngle());
const CLUB_SIN = Math.sin(clubAngle());

function bareSurfaceAt(x, z) {
  const cx = x * CLUB_COS + z * CLUB_SIN;
  const cz = -x * CLUB_SIN + z * CLUB_COS;
  if (RUNWAY.style !== 'none' && inRect(RUNWAY, cx, cz)) return RUNWAY.style === 'cricket' ? SURFACES.pitch : SURFACES.runway;
  if (PILOT_PAD && inRect(PILOT_PAD, cx, cz)) return SURFACES.pad;
  return inMown(x, z) ? SURFACES.grass : SURFACES.rough;
}

// Snow lying (0-1, src/world/snow.js): wheels plough through it (much more
// rolling resistance), a belly or skid slides further on it, and it
// smooths the bumps over.
let snowySurfaces = null;

/** How much snow is lying (0 none .. 1 full cover). */
export function setSnowCover(cover) {
  if (!(cover > 0.01)) {
    snowySurfaces = null;
    return;
  }
  snowySurfaces = new Map(Object.values(SURFACES).map((s) => [s, {
    name: `${s.name} under snow`,
    // (Not so much more that a parked taildragger can't break away without
    // tipping onto its nose: snow lets go once it's moving.)
    roll: s.roll + 0.1 * cover,
    stiction: s.stiction * (1 - 0.5 * cover),
    // Foam sliding on snow: about half the friction it has on grass.
    drag: s.drag * (1 - 0.55 * cover),
    bump: s.bump * (1 - 0.5 * cover),
  }]));
}

export function surfaceAt(x, z) {
  const s = bareSurfaceAt(x, z);
  return snowySurfaces ? snowySurfaces.get(s) : s;
}

// Small bumps (~0.7 m across) on top of the terrain. Too small to see on the
// 25 m render grid, but the wheels feel them.
function bumpNoise(x, z) {
  return smoothNoise(x / 0.7 + 1000, z / 0.7 + 1000) * 0.65 + smoothNoise(x / 0.25 + 500, z / 0.25 + 500) * 0.35 - 0.5;
}

/** Bump height (m) at a point; scale > 1 for small wheels, which feel more. */
export function bumpAt(x, z, scale = 1) {
  return surfaceAt(x, z).bump * 2 * bumpNoise(x, z) * scale;
}

export function bumpyHeightAt(x, z) {
  return heightAt(x, z) + bumpAt(x, z);
}

/** Terrain as the gear feels it (bumpy), and its surface type. */
export const physicsGround = {
  heightAt: bumpyHeightAt,
  baseHeightAt: heightAt,
  bumpAt,
  normalAt(x, z, out) {
    const e = 0.05; // small enough to feel individual bumps
    const hx = bumpyHeightAt(x + e, z) - bumpyHeightAt(x - e, z);
    const hz = bumpyHeightAt(x, z + e) - bumpyHeightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  },
  surfaceAt,
};

export const ground = { heightAt, normalAt, surfaceAt };
