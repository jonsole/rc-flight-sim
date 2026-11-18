// A lake (the made-up club field: LOCATION.layout.lake), carved into the
// terrain as an exact shape: the terrain grid (25 m) is far too coarse for a
// shoreline, so the height the physics uses (src/sim/terrain.js heightAt)
// adds the lake's carve to the grid's, and the drawing does the same (a
// fine mesh for the bed and banks, the grid's terrain left out there, and
// the water on top: src/world/water.js). The same shape in GLSL (LAKE_GLSL)
// for the shaders.
//
// The outline is a turned ellipse with a wobble round it (q: 0 in the
// middle, 1 at the water's edge). Grass banks slope down to the water over
// the last part (q 1 .. BANK); under the water the bed shelves to its
// deepest in the middle.
import { LOCATION } from './location.js';

export const LAKE = LOCATION.layout.lake ?? null;
const BANK = 1.3; // q where the bank starts down to the water
const EDGE = 0.05; // m: the bed at the water's edge, below the water

const L = LAKE ?? { x: 0, z: 0, rx: 1, rz: 1, angle: 0, level: 0, depth: 0 };
const ANG = (L.angle * Math.PI) / 180;
const COS = Math.cos(ANG);
const SIN = Math.sin(ANG);

/** How far out (x, z) is, 0 in the middle, 1 at the water's edge. */
export function lakeQ(x, z) {
  const dx = x - L.x;
  const dz = z - L.z;
  const u = (dx * COS + dz * SIN) / L.rx;
  const v = (-dx * SIN + dz * COS) / L.rz;
  const t = Math.atan2(v, u);
  const wobble = 1 + 0.16 * Math.sin(2 * t + 1.3) + 0.09 * Math.sin(3 * t + 0.4) + 0.05 * Math.sin(5 * t + 2.2);
  return Math.hypot(u, v) / wobble;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much lower the ground is here (m, ≤ 0): the banks and the bed. */
export function lakeCarve(x, z) {
  if (!LAKE) return 0;
  const q = lakeQ(x, z);
  if (q >= BANK) return 0;
  const edge = L.level - EDGE;
  if (q >= 1) return edge * (1 - smooth(1, BANK, q));
  return edge - (L.depth - EDGE) * Math.pow(1 - q * q, 0.6);
}

/** Water depth at (x, z) (m; 0 on dry land). */
export function waterDepthAt(x, z, groundY) {
  if (!LAKE) return 0;
  return Math.max(0, L.level - groundY);
}

/** Is (x, z) in the lake (under its water)? */
export function inLake(x, z) {
  return !!LAKE && lakeQ(x, z) < 1 + EDGE;
}

/** Half the size of a square round the lake that holds it and its banks (m). */
export function lakeExtent() {
  if (!LAKE) return 0;
  return Math.max(L.rx, L.rz) * BANK * 1.32 + 4;
}

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * GLSL: lakeQ(vec2 xz), lakeCarve(vec2 xz), as above, and LAKE_LEVEL.
 * Empty (and HAS_LAKE undefined) without a lake. (Once per shader, however
 * many times it's included.)
 */
export const LAKE_GLSL = !LAKE ? '' : /* glsl */ `
#ifndef HAS_LAKE
#define HAS_LAKE 1
#define LAKE_LEVEL ${f(L.level)}
#define LAKE_CENTRE vec2(${f(L.x)}, ${f(L.z)})
float lakeQ(vec2 p) {
  vec2 d = p - vec2(${f(L.x)}, ${f(L.z)});
  float u = (d.x * ${f(COS)} + d.y * ${f(SIN)}) / ${f(L.rx)};
  float v = (-d.x * ${f(SIN)} + d.y * ${f(COS)}) / ${f(L.rz)};
  float t = atan(v, u);
  float wobble = 1.0 + 0.16 * sin(2.0 * t + 1.3) + 0.09 * sin(3.0 * t + 0.4) + 0.05 * sin(5.0 * t + 2.2);
  return length(vec2(u, v)) / wobble;
}
float lakeCarve(vec2 p) {
  float q = lakeQ(p);
  if (q >= ${f(BANK)}) return 0.0;
  float edge = ${f(L.level - EDGE)};
  if (q >= 1.0) return edge * (1.0 - smoothstep(1.0, ${f(BANK)}, q));
  return edge - ${f(L.depth - EDGE)} * pow(max(1.0 - q * q, 0.0), 0.6);
}
#endif
`;
