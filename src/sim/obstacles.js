// Things you can fly into: trees, the club hut, the windsock pole, the fence
// and the flight-line table. One description drives both the physics
// (collision queries) and the 3D world (what gets drawn where).
//
// Shapes:
//   box       axis-aligned box: { min:[x,y,z], max:[x,y,z] }          solid
//   cylinder  vertical cylinder: { x, z, r, y0, y1 }                  solid
//   ellipsoid foliage: { cx, cy, cz, rx, ry, rz }                     soft
//   cone      foliage: { x, z, r (base radius), y0 (base), h }        soft

import { heightAt } from './terrain.js';

const CELL = 12; // spatial-hash cell size (m)

/** Deterministic tree layout (tree lines around the field and woods beyond). */
function makeTrees() {
  const trees = [];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1800; i++) {
    let x;
    let z;
    if (i < 500) {
      const a = rand() * Math.PI * 2;
      const r = 170 + rand() * 60;
      x = Math.cos(a) * r * 1.3;
      z = Math.sin(a) * r - 40;
      if (z > 20 && Math.abs(x) < 60) z += 80; // keep the view behind the pilot open
    } else {
      const cx = Math.floor(rand() * 14);
      const ca = cx * 0.45 + 0.3;
      const cr = 300 + (cx % 5) * 160;
      x = Math.cos(ca * 2.1) * cr + (rand() - 0.5) * 140;
      z = Math.sin(ca * 2.1) * cr + (rand() - 0.5) * 140;
    }
    const y = heightAt(x, z);
    const h = 9 + rand() * 12;
    const conifer = rand() < 0.3;
    const rot = rand() * Math.PI * 2;
    const tree = { x, y, z, h, conifer, rot };
    if (conifer) {
      tree.hue = 0.3 + rand() * 0.04;
      tree.sat = 0.35;
      tree.light = 0.16 + rand() * 0.06;
    } else {
      tree.crownW = h * (0.28 + rand() * 0.12);
      tree.hue = 0.22 + rand() * 0.07;
      tree.sat = 0.4 + rand() * 0.15;
      tree.light = 0.2 + rand() * 0.1;
    }
    trees.push(tree);
  }
  return trees;
}

export class Obstacles {
  constructor() {
    this.trees = makeTrees();
    this.shapes = [];
    for (const t of this.trees) {
      // Trunk (solid). Rendered as a 0.25-0.4 m tapered cylinder.
      this.shapes.push({ type: 'cylinder', name: 'a tree trunk', x: t.x, z: t.z, r: 0.33, y0: t.y - 0.2, y1: t.y - 0.2 + t.h * 0.45 });
      if (t.conifer) {
        this.shapes.push({ type: 'cone', name: 'a tree', x: t.x, z: t.z, r: t.h * 0.22, y0: t.y + t.h * 0.15, h: t.h * 0.9 });
      } else {
        this.shapes.push({ type: 'ellipsoid', name: 'a tree', cx: t.x, cy: t.y + t.h * 0.62, cz: t.z, rx: t.crownW, ry: t.h * 0.38, rz: t.crownW });
      }
    }
    // Club hut (body + roof overhang), behind the pilot.
    this.hut = { x: -24, z: 26 };
    this.shapes.push({ type: 'box', name: 'the club hut', min: [-29, 0, 23], max: [-19, 3.45, 29] });
    this.shapes.push({ type: 'box', name: 'the club hut roof', min: [-29.3, 3.15, 22.5], max: [-18.7, 3.45, 29.5] });
    // Windsock pole.
    this.windsock = { x: -35, z: -42, height: 5 };
    this.shapes.push({ type: 'cylinder', name: 'the windsock pole', x: -35, z: -42, r: 0.05, y0: 0, y1: 5 });
    // Safety fence: posts and the top rail along z = 6.
    this.fence = { z: 6, posts: Array.from({ length: 40 }, (_, i) => -100 + i * 5.1), height: 1.1, railY: 1.0 };
    for (const px of this.fence.posts) this.shapes.push({ type: 'cylinder', name: 'the fence', x: px, z: 6, r: 0.04, y0: 0, y1: 1.1 });
    this.shapes.push({ type: 'box', name: 'the fence', min: [-100, 0.98, 5.98], max: [100, 1.02, 6.02] });
    // Flight-line table.
    this.table = { x: 6, z: 3 };
    this.shapes.push({ type: 'box', name: 'the table', min: [5, 0, 2.6], max: [7, 0.78, 3.4] });

    // Spatial hash over each shape's horizontal footprint.
    this.grid = new Map();
    for (const s of this.shapes) {
      const [x0, z0, x1, z1] = footprint(s);
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const k = `${i},${j}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(s);
        }
      }
    }
  }

  /** Shapes whose footprint may overlap a circle of `radius` around (x, z). */
  near(x, z, radius, out = []) {
    out.length = 0;
    const seen = new Set();
    for (let i = Math.floor((x - radius) / CELL); i <= Math.floor((x + radius) / CELL); i++) {
      for (let j = Math.floor((z - radius) / CELL); j <= Math.floor((z + radius) / CELL); j++) {
        const list = this.grid.get(`${i},${j}`);
        if (!list) continue;
        for (const s of list) {
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  /**
   * Is a world point inside a shape? Returns null, or
   * { depth, nx, ny, nz } (outward normal) for solids, { soft: true } for foliage.
   */
  static test(s, x, y, z) {
    switch (s.type) {
      case 'box': {
        if (x < s.min[0] || x > s.max[0] || y < s.min[1] || y > s.max[1] || z < s.min[2] || z > s.max[2]) return null;
        // Push out through the nearest face.
        const d = [x - s.min[0], s.max[0] - x, y - s.min[1], s.max[1] - y, z - s.min[2], s.max[2] - z];
        let k = 0;
        for (let i = 1; i < 6; i++) if (d[i] < d[k]) k = i;
        const n = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]][k];
        return { depth: d[k], nx: n[0], ny: n[1], nz: n[2] };
      }
      case 'cylinder': {
        if (y < s.y0 || y > s.y1) return null;
        const dx = x - s.x;
        const dz = z - s.z;
        const r = Math.hypot(dx, dz);
        if (r >= s.r) return null;
        const side = s.r - r;
        const top = s.y1 - y;
        if (top < side) return { depth: top, nx: 0, ny: 1, nz: 0 };
        const inv = r > 1e-6 ? 1 / r : 0;
        return { depth: side, nx: r > 1e-6 ? dx * inv : 1, ny: 0, nz: dz * inv };
      }
      case 'ellipsoid': {
        const u = (x - s.cx) / s.rx;
        const v = (y - s.cy) / s.ry;
        const w = (z - s.cz) / s.rz;
        return u * u + v * v + w * w < 1 ? { soft: true } : null;
      }
      case 'cone': {
        const t = (y - s.y0) / s.h;
        if (t < 0 || t > 1) return null;
        return Math.hypot(x - s.x, z - s.z) < s.r * (1 - t) ? { soft: true } : null;
      }
      default:
        return null;
    }
  }
}

function footprint(s) {
  switch (s.type) {
    case 'box':
      return [s.min[0], s.min[2], s.max[0], s.max[2]];
    case 'cylinder':
    case 'cone':
      return [s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r];
    case 'ellipsoid':
      return [s.cx - s.rx, s.cz - s.rz, s.cx + s.rx, s.cz + s.rz];
    default:
      return [0, 0, 0, 0];
  }
}
