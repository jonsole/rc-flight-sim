// Broadleaf crown layout, shared by the physics (collisions) and the drawn
// trees, so you hit exactly the clumps you can see.
import { IcosahedronGeometry, Vector3 } from 'three';

/** The crown shapes in use (seeds); each tree picks one. */
export const CROWN_SEEDS = [11, 23, 37, 53, 71];

export function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise (0..1). */
export function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const f = (t) => t * t * (3 - 2 * t);
  const u = f(x - xi);
  const v = f(y - yi);
  const w = f(z - zi);
  let r = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const k = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        r += k * hash3(xi + dx, yi + dy, zi + dz);
      }
    }
  }
  return r;
}

/** Leafy lumps: how much a crown surface point is pushed out (factor). */
export function lumpScale(v, seed) {
  const n = noise3(v.x * 3 + seed, v.y * 3, v.z * 3) - 0.5 + (noise3(v.x * 9, v.y * 9 + seed, v.z * 9) - 0.5) * 0.45;
  return 1 + n * 0.32;
}

/**
 * Clumps (spheres [x, y, z, r]) scattered over a slightly squashed dome,
 * more of them up top, poking out by different amounts so the outline is
 * ragged, not round; plus one in the middle. Before normalising to unit size.
 */
export function crownClumps(seed) {
  const rnd = rng(seed);
  const out = [];
  const n = 11 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const r = 0.26 + rnd() * 0.2;
    const a = rnd() * Math.PI * 2;
    const y = Math.min(1, Math.max(-0.6, rnd() * 1.5 - 0.5)); // -0.5..1, biased upwards
    const ring = Math.sqrt(1 - y * y);
    const d = (1 - r) * (0.75 + rnd() * 0.35);
    out.push([Math.cos(a) * ring * d, y * d * 0.8, Math.sin(a) * ring * d, r]);
  }
  out.push([0, 0, 0, 0.6]);
  return out;
}

const cache = new Map();
/**
 * The crown as drawn, for collisions: clump spheres scaled to the unit crown
 * (the drawn mesh is normalised so its furthest lump is at radius 1).
 * @returns {{ clumps: number[][], norm: number }}
 */
export function crownShape(seed) {
  if (cache.has(seed)) return cache.get(seed);
  const clumps = crownClumps(seed);
  // Same vertices and lumps the drawn crown uses, to find its size.
  let max = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const v = new Vector3();
  for (const [x, y, z, r] of clumps) {
    const g = new IcosahedronGeometry(r, 2).translate(x, y, z);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = lumpScale(v, seed);
      max = Math.max(max, v.length() * k);
      lo = Math.min(lo, v.y * k);
      hi = Math.max(hi, v.y * k);
    }
    g.dispose();
  }
  // lo / hi: how far the leaves really reach down and up in the unit crown
  // (about -0.55 and +0.7: the clumps don't fill the unit sphere).
  const shape = { clumps: clumps.map(([x, y, z, r]) => [x / max, y / max, z / max, r / max]), norm: max, lo: lo / max, hi: hi / max };
  cache.set(seed, shape);
  return shape;
}

// Where a tree's leaves are, shared by the drawing (src/world/world.js), the
// collisions (src/sim/obstacles.js), the wind and the editor.
//   base     fraction of the height where the canopy starts (editable)
//   crownW   broadleaf: crown radius; conifer: radius of the bottom boughs
export const DEFAULT_BASE = { broadleaf: 0.18, conifer: 0.06 };

/**
 * Broadleaf: { cy, sx, sy } (crown centre height, horizontal and vertical
 * half-size); conifer: { y0, r, ch } (bough base height, base radius, cone
 * height up to just over the top). Both also give `base` and `radius`.
 */
export function crownOf(t) {
  const base = t.base ?? (t.conifer ? DEFAULT_BASE.conifer : DEFAULT_BASE.broadleaf);
  if (t.conifer) {
    const r = t.crownW ?? t.h * 0.22;
    return { base, radius: r, r, y0: t.y + t.h * base, ch: t.h * (1.05 - base) };
  }
  // Stretch the crown so its leaves run exactly from the canopy start to the
  // top of the tree (each shape reaches its own lo..hi of the unit crown).
  const { lo, hi } = t.variant != null ? crownShape(CROWN_SEEDS[t.variant]) : { lo: -0.55, hi: 0.7 };
  const sy = (t.h * (1 - base)) / (hi - lo);
  return { base, radius: t.crownW, sx: t.crownW * 1.05, sy, cy: t.y + t.h * base - lo * sy };
}
