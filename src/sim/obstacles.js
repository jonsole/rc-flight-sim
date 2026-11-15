// Things you can fly into: trees, the club hut, the windsock pole, the fence
// and the flight-line table. One description drives both the physics
// (collision queries) and the 3D world (what gets drawn where).
//
// Shapes:
//   box       axis-aligned box: { min:[x,y,z], max:[x,y,z] }          solid
//   cylinder  vertical cylinder: { x, z, r, y0, y1 }                  solid
//   ellipsoid foliage: { cx, cy, cz, rx, ry, rz }                     soft
//   cone      foliage: { x, z, r (base radius), y0 (base), h }        soft
//   crown     foliage: a broadleaf crown's clumps, as drawn             soft
//   building  footprint polygon with a flat or pitched roof            solid
//
// Placement comes from the site (src/sim/location.js): at a real site the
// trees and buildings are the baked LIDAR ones.

import { heightAt } from './terrain.js';
import { CROWN_SEEDS, crownShape, lumpScale } from './treeShapes.js';
import { LOCATION } from './location.js';
import { prepareBuilding, roofAt, insideFootprint, nearestWall } from './buildings.js';

const _lp = { x: 0, y: 0, z: 0 };

const CELL = 12; // spatial-hash cell size (m)

/** Leaf colours, and for broadleaves the crown radius, for a new tree. */
function dressTree(tree, rand, crownW) {
  if (tree.conifer) {
    tree.hue = 0.3 + rand() * 0.04;
    tree.sat = 0.35;
    tree.light = 0.16 + rand() * 0.06;
  } else {
    tree.crownW = crownW ?? tree.h * (0.28 + rand() * 0.12);
    tree.hue = 0.22 + rand() * 0.07;
    tree.sat = 0.4 + rand() * 0.15;
    tree.light = 0.2 + rand() * 0.1;
  }
  return tree;
}

/** Trees at a real site: the LIDAR ones, then made-up woods far beyond. */
function realTrees() {
  const d = LOCATION.data;
  const trees = [];
  let rnd = 4242;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const L = LOCATION.layout;
  const t = d.trees;
  const raw = [];
  for (let i = 0; i < t.length; i += 4) raw.push({ x: t[i], z: t[i + 1], h: t[i + 2], r: t[i + 3] });
  for (const belt of L.treeBelts ?? []) growBelt(raw, belt, rand);
  for (const { x, z, h, r } of raw) {
    // Narrow for its height: probably a conifer (or a Lombardy poplar).
    const conifer = L.conifers !== false && r < h * 0.17 && h > 8;
    trees.push(dressTree({ x, y: heightAt(x, z), z, h, conifer, rot: rand() * Math.PI * 2 }, rand, Math.max(1.2, r)));
  }
  // Clumps of woodland on the skyline, outside the baked area.
  const half = d.size / 2;
  for (let c = 0; c < 40; c++) {
    const a = rand() * Math.PI * 2;
    const r = half + 150 + rand() * 1600;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const n = 6 + Math.floor(rand() * 18);
    for (let i = 0; i < n; i++) {
      const x = cx + (rand() - 0.5) * 120;
      const z = cz + (rand() - 0.5) * 60;
      if (Math.max(Math.abs(x), Math.abs(z)) < half + 60) continue;
      const h = 10 + rand() * 10;
      const conifer = L.conifers !== false && rand() < 0.15;
      trees.push(dressTree({ x, y: heightAt(x, z), z, h, conifer, rot: rand() * Math.PI * 2 }, rand));
    }
  }
  return trees;
}

/**
 * A tree line that has grown since the survey: its trees taller and wider,
 * and new ones in the gaps, so it reads as one belt.
 */
function growBelt(trees, belt, rand) {
  const [ax, az] = belt.from;
  const [bx, bz] = belt.to;
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const along = [];
  for (const t of trees) {
    const s = (t.x - ax) * ux + (t.z - az) * uz;
    const off = -(t.x - ax) * uz + (t.z - az) * ux;
    if (s < 0 || s > len || Math.abs(off) > belt.width / 2) continue;
    t.h = Math.max(belt.minH, t.h * belt.grow);
    t.r = Math.max(t.r * belt.grow, t.h * 0.3);
    along.push({ s, off });
  }
  along.sort((p, q) => p.s - q.s);
  // Fill the gaps (including either end) with trees like their neighbours.
  const stops = [{ s: -belt.spacing / 2, off: 0 }, ...along, { s: len + belt.spacing / 2, off: 0 }];
  for (let i = 1; i < stops.length; i++) {
    const gap = stops[i].s - stops[i - 1].s;
    const n = Math.floor(gap / belt.spacing);
    for (let k = 1; k <= n; k++) {
      const s = stops[i - 1].s + (gap * k) / (n + 1);
      const off = (rand() - 0.5) * belt.width * 0.4;
      const h = belt.minH + rand() * belt.minH * 0.5;
      trees.push({ x: ax + ux * s - uz * off, z: az + uz * s + ux * off, h, r: h * (0.3 + rand() * 0.1) });
    }
  }
}

/** Deterministic tree layout (tree lines around the field and woods beyond). */
function makeTrees() {
  if (LOCATION.data) return realTrees();
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
    trees.push(dressTree({ x, y, z, h, conifer, rot }, rand));
  }
  return trees;
}

export class Obstacles {
  constructor() {
    this.trees = makeTrees();
    // Which crown shape (and conifer shape) each tree is drawn with.
    this.trees.forEach((t, i) => {
      t.pick = Math.floor(((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 1000);
      t.variant = t.pick % CROWN_SEEDS.length;
    });
    this.shapes = [];
    for (const t of this.trees) {
      // Trunk (solid): drawn tapering from 0.024 h to under 0.01 h across.
      this.shapes.push({ type: 'cylinder', name: 'a tree trunk', x: t.x, z: t.z, r: t.h * (t.conifer ? 0.014 : 0.019), y0: t.y - 0.2, y1: t.y + t.h * (t.conifer ? 0.2 : 0.42) });
      if (t.conifer) {
        // As drawn: 0.22 h base radius, from 0.1 h up, 0.95 h tall.
        this.shapes.push({ type: 'cone', name: 'a tree', x: t.x, z: t.z, r: t.h * 0.22, y0: t.y + t.h * 0.1, h: t.h * 0.95 });
      } else {
        // The crown's own clumps, placed, sized and turned as drawn
        // (src/world/world.js): centre 0.62 h up, crownW wide, 0.4 h tall.
        const sx = t.crownW * 1.05;
        const sy = t.h * 0.4;
        this.shapes.push({
          type: 'crown', name: 'a tree', cx: t.x, cy: t.y + t.h * 0.62, cz: t.z, sx, sy,
          cos: Math.cos(t.rot), sin: Math.sin(t.rot), seed: CROWN_SEEDS[t.variant], ...crownShape(CROWN_SEEDS[t.variant]),
        });
      }
    }
    const L = LOCATION.layout;
    // Clubhouse behind the pilot: walls, pitched roof (eaves to ridge).
    this.hut = L.hut;
    if (L.hut) {
      const { x, z, w, d, wall, ridge } = L.hut;
      const [x0, x1, z0, z1] = [x - w / 2, x + w / 2, z - d / 2, z + d / 2];
      this.shapes.push({ type: 'box', name: 'the clubhouse', min: [x0, 0, z0], max: [x1, wall, z1] });
      this.shapes.push({ type: 'box', name: 'the clubhouse roof', min: [x0 - 0.4, wall - 0.1, z0 - 0.4], max: [x1 + 0.4, wall + 0.75, z1 + 0.4] });
      this.shapes.push({ type: 'box', name: 'the clubhouse roof', min: [x0 - 0.4, wall + 0.7, z0 + 1.6], max: [x1 + 0.4, ridge, z1 - 1.6] });
    }
    // Shipping container (20 ft) beside it.
    this.container = L.container;
    if (L.container) {
      const c = L.container;
      this.shapes.push({ type: 'box', name: 'the container', min: [c.x - c.l / 2, 0, c.z - c.w / 2], max: [c.x + c.l / 2, c.h, c.z + c.w / 2] });
    }
    // Cars in the car park, nose to the field.
    this.cars = L.cars;
    for (const c of this.cars) {
      const y = heightAt(c.x, c.z);
      this.shapes.push({ type: 'box', name: 'a car', min: [c.x - 0.9, y, c.z - 2.1], max: [c.x + 0.9, y + 1.45, c.z + 2.1] });
    }
    // Pop-up gazebo in the pits, behind the safety fence.
    this.gazebo = L.gazebo;
    const gz = L.gazebo;
    for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
      this.shapes.push({ type: 'cylinder', name: 'the gazebo', x: gz.x + dx, z: gz.z + dz, r: 0.03, y0: 0, y1: 2.2 });
    }
    this.shapes.push({ type: 'box', name: 'the gazebo', min: [gz.x - 1.6, 2.1, gz.z - 1.6], max: [gz.x + 1.6, 2.7, gz.z + 1.6] });
    this.shapes.push({ type: 'box', name: 'the pits table', min: [gz.x - 1, 0, gz.z + 0.2], max: [gz.x + 1, 0.75, gz.z + 1] });
    // Windsock pole.
    this.windsock = L.windsock;
    const ws = L.windsock;
    this.shapes.push({ type: 'cylinder', name: 'the windsock pole', x: ws.x, z: ws.z, r: 0.05, y0: 0, y1: ws.height });
    // Safety fence: posts and the top rail.
    const f = L.fence;
    const nPosts = Math.round((f.x1 - f.x0) / 5.1) + 1;
    this.fence = { z: f.z, posts: Array.from({ length: nPosts }, (_, i) => f.x0 + i * 5.1), height: 1.1, railY: 1.0, x0: f.x0, x1: f.x1 };
    for (const px of this.fence.posts) this.shapes.push({ type: 'cylinder', name: 'the fence', x: px, z: f.z, r: 0.04, y0: 0, y1: 1.1 });
    this.shapes.push({ type: 'box', name: 'the fence', min: [f.x0, 0.98, f.z - 0.02], max: [f.x1, 1.02, f.z + 0.02] });
    // Flight-line table.
    this.table = L.table;
    this.shapes.push({ type: 'box', name: 'the table', min: [L.table.x - 1, 0, L.table.z - 0.4], max: [L.table.x + 1, 0.78, L.table.z + 0.4] });
    // Buildings at a real site.
    this.buildings = (LOCATION.data?.buildings ?? []).map(prepareBuilding);
    for (const b of this.buildings) this.shapes.push({ type: 'building', name: 'a building', b });
    // Tall fences: a thin slab, solid like a wall (no flying through chain link).
    this.fences = (L.fences ?? []).map((f) => {
      const [ax, az] = f.from;
      const [bx, bz] = f.to;
      const len = Math.hypot(bx - ax, bz - az);
      const nx = (-(bz - az) / len) * 0.05;
      const nz = ((bx - ax) / len) * 0.05;
      const y = Math.min(heightAt(ax, az), heightAt(bx, bz));
      const pts = [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]];
      const b = {
        pts, y0: y - 0.3, eave: y + f.height, ridge: y + f.height, kind: 'fence',
        x0: Math.min(ax, bx) - 0.1, x1: Math.max(ax, bx) + 0.1, z0: Math.min(az, bz) - 0.1, z1: Math.max(az, bz) + 0.1,
      };
      this.shapes.push({ type: 'building', name: 'the chain-link fence', b });
      return f;
    });

    // Bounding sphere per shape, for a quick whole-aircraft check first.
    for (const s of this.shapes) s.bound = boundOf(s);
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
      case 'crown': {
        // Into the crown's own frame (undo its turn and size), then inside
        // any clump? Clumps are shrunk a touch: their lumpy surface dips in
        // as often as it bulges out.
        const dx = x - s.cx;
        const dz = z - s.cz;
        const lx = (dx * s.cos - dz * s.sin) / s.sx;
        const ly = (y - s.cy) / s.sy;
        const lz = (dx * s.sin + dz * s.cos) / s.sx;
        // 1. Outside the whole crown's bounding shell?
        if (lx * lx + ly * ly + lz * lz > 1.1) return null;
        for (const [cx, cy, cz, r] of s.clumps) {
          const ex = lx - cx;
          const ey = ly - cy;
          const ez = lz - cz;
          // 2. Outside this clump's sphere, allowing for lumps that bulge out?
          if (ex * ex + ey * ey + ez * ez > r * r * 1.45) continue;
          // 3. The leafy lumps exactly as drawn: the drawn surface is each
          //    clump pushed in or out by lumpScale (in the un-normalised
          //    crown), so undo that for this point and test the plain clump.
          _lp.x = lx * s.norm;
          _lp.y = ly * s.norm;
          _lp.z = lz * s.norm;
          const k = 1 / lumpScale(_lp, s.seed);
          const fx = lx * k - cx;
          const fy = ly * k - cy;
          const fz = lz * k - cz;
          if (fx * fx + fy * fy + fz * fz < r * r) return { soft: true };
        }
        return null;
      }
      case 'building': {
        const b = s.b;
        if (y < b.y0 || y > b.ridge || !insideFootprint(b, x, z)) return null;
        const top = roofAt(b, x, z) - y;
        if (top < 0) return null;
        const w = nearestWall(b, x, z);
        if (top < w.d) return { depth: top, nx: 0, ny: 1, nz: 0 };
        return { depth: w.d, nx: w.nx, ny: 0, nz: w.nz };
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

function boundOf(s) {
  switch (s.type) {
    case 'box': {
      const c = [0, 1, 2].map((i) => (s.min[i] + s.max[i]) / 2);
      return { x: c[0], y: c[1], z: c[2], r: Math.hypot(s.max[0] - c[0], s.max[1] - c[1], s.max[2] - c[2]) };
    }
    case 'cylinder':
      return { x: s.x, y: (s.y0 + s.y1) / 2, z: s.z, r: Math.hypot(s.r, (s.y1 - s.y0) / 2) };
    case 'cone':
      return { x: s.x, y: s.y0 + s.h / 2, z: s.z, r: Math.hypot(s.r, s.h / 2) };
    case 'crown':
      return { x: s.cx, y: s.cy, z: s.cz, r: Math.max(s.sx, s.sy) * 1.05 };
    case 'ellipsoid':
      return { x: s.cx, y: s.cy, z: s.cz, r: Math.max(s.rx, s.ry, s.rz) };
    case 'building': {
      const b = s.b;
      const c = [(b.x0 + b.x1) / 2, (b.y0 + b.ridge) / 2, (b.z0 + b.z1) / 2];
      return { x: c[0], y: c[1], z: c[2], r: Math.hypot(b.x1 - c[0], b.ridge - c[1], b.z1 - c[2]) };
    }
    default:
      return { x: 0, y: 0, z: 0, r: Infinity };
  }
}

function footprint(s) {
  switch (s.type) {
    case 'box':
      return [s.min[0], s.min[2], s.max[0], s.max[2]];
    case 'cylinder':
    case 'cone':
      return [s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r];
    case 'crown':
      return [s.cx - s.sx, s.cz - s.sx, s.cx + s.sx, s.cz + s.sx];
    case 'ellipsoid':
      return [s.cx - s.rx, s.cz - s.rz, s.cx + s.rx, s.cz + s.rz];
    case 'building':
      return [s.b.x0, s.b.z0, s.b.x1, s.b.z1];
    default:
      return [0, 0, 0, 0];
  }
}
