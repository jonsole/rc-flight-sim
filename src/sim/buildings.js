// Buildings at real sites: footprints from OpenStreetMap (or boxes round
// structures the LIDAR shows), heights measured from the LIDAR. Flat roofs,
// or for small four-cornered buildings a pitched roof along the long side.
// One description serves both the collisions (src/sim/obstacles.js) and the
// drawing (src/world/buildings.js).

import { heightAt } from './terrain.js';

/**
 * @param {{ pts: number[][], h: number, eave: number, kind: string }} b  baked building
 * @returns prepared building: { pts, y0, eave, ridge, gable?, x0, z0, x1, z1 }
 */
export function prepareBuilding(b) {
  const pts = b.pts;
  let y0 = Infinity;
  let base = Infinity;
  for (const [x, z] of pts) {
    const g = heightAt(x, z);
    y0 = Math.min(y0, g - 0.3); // sunk a little so it sits on sloping ground
    base = Math.min(base, g);
  }
  const out = {
    pts,
    y0,
    eave: base + b.eave,
    ridge: base + b.h,
    kind: b.kind,
    x0: Math.min(...pts.map((p) => p[0])),
    x1: Math.max(...pts.map((p) => p[0])),
    z0: Math.min(...pts.map((p) => p[1])),
    z1: Math.max(...pts.map((p) => p[1])),
  };
  if (pts.length === 4 && b.h - b.eave > 0.5) {
    // Ridge along the longer pair of sides, through the middle.
    const [a, c, d, e] = pts;
    const l1 = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const l2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
    const [p, q] = l1 >= l2 ? [a, c] : [c, d];
    const len = Math.max(l1, l2);
    const ax = (q[0] - p[0]) / len;
    const az = (q[1] - p[1]) / len;
    const cx = (a[0] + c[0] + d[0] + e[0]) / 4;
    const cz = (a[1] + c[1] + d[1] + e[1]) / 4;
    out.gable = { cx, cz, ax, az, halfW: Math.min(l1, l2) / 2, halfL: len / 2 };
  }
  return out;
}

/** Roof height over (x, z) (assumed inside the footprint). */
export function roofAt(b, x, z) {
  const g = b.gable;
  if (!g) return b.ridge;
  // Distance across the ridge line.
  const d = Math.abs(-(x - g.cx) * g.az + (z - g.cz) * g.ax);
  return b.ridge - (b.ridge - b.eave) * Math.min(1, d / g.halfW);
}

/** Point in the footprint polygon? */
export function insideFootprint(b, x, z) {
  if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false;
  const p = b.pts;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest wall to (x, z): { d, nx, nz } with the outward normal. */
export function nearestWall(b, x, z) {
  const p = b.pts;
  let best = { d: Infinity, nx: 1, nz: 0 };
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [x0, z0] = p[j];
    const [x1, z1] = p[i];
    const ex = x1 - x0;
    const ez = z1 - z0;
    const L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / L2));
    const px = x0 + ex * t - x;
    const pz = z0 + ez * t - z;
    const d = Math.hypot(px, pz);
    if (d < best.d) {
      // Outward is away from the inside point, towards the wall.
      const n = d > 1e-6 ? 1 / d : 0;
      best = { d, nx: px * n, nz: pz * n };
    }
  }
  return best;
}
