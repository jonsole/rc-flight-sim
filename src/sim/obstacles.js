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
import { lakeQ, LAKE } from './lake.js';
import { CROWN_SEEDS, crownShape, lumpScale, crownOf } from './treeShapes.js';
import { trunkThickness, coniferBase, coniferWidth } from '../world/species.js';
import { LOCATION, clubAngle, clubToWorld, inMown } from './location.js';
import { prepareBuilding, roofAt, insideFootprint, nearestWall } from './buildings.js';
import { EDITS, applyTreeEdits, applyBushEdits, applyBuildingEdits, applyFenceEdits, treeId } from './edits.js';

const _lp = { x: 0, y: 0, z: 0 };

/**
 * How leafy the broadleaf trees, bushes and hedges are (1 in leaf, 0 bare in
 * winter; src/world/seasons.js), for their collisions: a bare or thinning
 * crown is mostly open twigs, so only its inner branches catch a model, and
 * less firmly. Conifers keep their needles.
 */
let leafiness = 1;
export function setLeafiness(v) {
  leafiness = Math.min(1, Math.max(0, v));
}
/** How much of a leafy shape still catches (clump size), and how sparse it is (0 in full leaf). */
const caught = () => 0.45 + 0.55 * leafiness;
const SPARSE = () => 1 - leafiness;

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
  // (`treeKinds`, where baked: each one's kind seen from above, c conifer.)
  for (let i = 0; i < t.length; i += 4) raw.push({ x: t[i], z: t[i + 1], h: t[i + 2], r: t[i + 3], kind: d.treeKinds?.[i / 4] });
  for (const g of L.treeGrowth ?? []) {
    for (const t of raw) {
      if (t.x < g.x0 || t.x > g.x1 || t.z < g.z0 || t.z > g.z1) continue;
      t.h = Math.max(g.minH, t.h * g.grow);
      t.r = Math.max(t.r * g.grow, t.h * 0.3);
    }
  }
  for (const belt of L.treeBelts ?? []) growBelt(raw, belt, rand);
  for (const group of L.trees ?? []) {
    for (const [x, z] of group.at) raw.push({ x, z, h: group.h * (0.9 + rand() * 0.2), r: group.r * (0.9 + rand() * 0.2), species: group.species });
  }
  // Not trees: things the survey saw standing there (the site's tents).
  const clear = L.noTrees ?? [];
  for (const { x, z, h, r, species, kind } of raw.filter((t) => !clear.some((c) => Math.hypot(t.x - c.x, t.z - c.z) < c.r))) {
    // Narrow for its height: probably a conifer (or a Lombardy poplar).
    const conifer = kind ? kind === 'c' : L.conifers !== false && r < h * 0.17 && h > 8;
    const t = dressTree({ x, y: heightAt(x, z), z, h, conifer, rot: rand() * Math.PI * 2 }, rand, Math.max(1.2, r));
    // Its species, if the site says (else a natural mix: src/world/species.js).
    const area = (L.treeSpecies ?? []).find((a) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1);
    if (!conifer && (species || area)) t.species = species ?? area.species;
    trees.push(t);
  }
  // Clumps of woodland on the skyline, outside the baked area (unless the
  // site has its real country round about: its map shows the woods).
  const half = d.size / 2;
  for (let c = 0; c < (d.far ? 0 : 40); c++) {
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
    const tree = dressTree({ x, y, z, h, conifer, rot }, rand);
    // None in the lake or on its banks (src/sim/lake.js). (After drawing its
    // numbers, so the trees elsewhere stay as they were.)
    if (LAKE && lakeQ(x, z) < 1.45) continue;
    trees.push(tree);
  }
  return trees;
}

/**
 * Bushes and hedges: { id, x, z, h (height), w (half-width), turn, tint
 * [h, s, l], shape (0/1) }. Real sites: the LIDAR's 1-3 m vegetation (on a
 * 3 m grid, so neighbours overlap into hedges) and the layout's bush belts;
 * the made-up field: a ring in front of the tree line.
 */
function makeBushes() {
  let rnd = 78;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const out = [];
  const add = (x, z, h, w) => out.push({
    id: treeId(x, z), x, z, h, w, turn: rand() * Math.PI * 2,
    tint: [0.24 + rand() * 0.05, 0.36 + rand() * 0.12, 0.13 + rand() * 0.05], shape: out.length % 2,
  });
  if (LOCATION.data) {
    const p = LOCATION.data.bushes;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] + (rand() - 0.5) * 1.5;
      const z = p[i + 1] + (rand() - 0.5) * 1.5;
      const h = p[i + 2];
      const w = Math.min(1.5 + rand() * 0.8, 0.7 + h * 0.7); // low scrub is narrower too
      if (inMown(x, z)) continue; // the club keeps its mown grass clear
      add(x, z, h, w);
    }
    // Belts of tall bushes from the site layout: two staggered rows, 2.5 m apart.
    for (const b of LOCATION.layout.bushBelts ?? []) {
      const [ax, az] = b.from;
      const [bx, bz] = b.to;
      const len = Math.hypot(bx - ax, bz - az);
      const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
      for (let s = 0; s <= len; s += 2.5) {
        for (const row of [-0.25, 0.25]) {
          const off = row * b.width + (rand() - 0.5) * 1.2;
          add(ax + ux * (s + row * 2.5) - uz * off, az + uz * (s + row * 2.5) + ux * off, b.minH + rand() * (b.maxH - b.minH), 1.5 + rand() * 0.8);
        }
      }
    }
  } else {
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      const r = 150 + rand() * 22;
      const x = Math.cos(a) * r * 1.3;
      let z = Math.sin(a) * r - 40;
      if (z > 20 && Math.abs(x) < 60) z += 80; // keep the view behind the pilot open
      const size = 0.6 + rand() * 0.9;
      add(x, z, size * 1.4, size * 1.3);
    }
    // None in the lake or on its banks (src/sim/lake.js).
    if (LAKE) return out.filter((b) => lakeQ(b.x, b.z) >= 1.4);
  }
  return out;
}

/** A whole bush from an edited or added one ({ x, z, h, w }). */
function editedBush(spec, orig) {
  const k = hashId(spec.id);
  return {
    id: spec.id,
    x: spec.x ?? orig.x,
    z: spec.z ?? orig.z,
    h: spec.h ?? orig?.h ?? 2,
    w: spec.w ?? orig?.w ?? 1.6,
    turn: orig?.turn ?? k * Math.PI * 2,
    tint: orig?.tint ?? [0.25, 0.42, 0.15],
    shape: orig?.shape ?? (k < 0.5 ? 0 : 1),
  };
}

/** A whole tree from an edited or added one ({ x, z, h, r, conifer, species }), keeping what it can of `orig`. */
function editedTree(spec, orig) {
  let rnd = Math.floor(hashId(spec.id) * 2147483646) + 1;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const conifer = spec.conifer ?? orig?.conifer ?? false;
  const h = spec.h ?? orig?.h ?? 12;
  const t = { id: spec.id, x: spec.x ?? orig.x, z: spec.z ?? orig.z, h, conifer, rot: orig?.rot ?? rand() * Math.PI * 2 };
  t.y = heightAt(t.x, t.z);
  // Its species: set in the editor ('mixed' for the natural mix), else as it was.
  const species = spec.species !== undefined ? spec.species : orig?.species;
  if (species && species !== 'mixed') t.species = species; // (of its kind: speciesOf checks)
  const base = spec.base ?? orig?.base;
  if (base != null) t.base = base;
  if (orig && orig.conifer === conifer) {
    Object.assign(t, { hue: orig.hue, sat: orig.sat, light: orig.light });
    t.crownW = spec.r ?? orig.crownW;
    return t;
  }
  dressTree(t, rand, spec.r ?? h * 0.33);
  // Conifers keep their own (narrower) default unless given a radius.
  t.crownW = spec.r ?? (conifer ? undefined : t.crownW);
  return t;
}

/** 0..1 from a tree's id, so its crown shape doesn't change when others are edited. */
function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000003) / 1000003;
}

export class Obstacles {
  constructor() {
    this.trees = applyTreeEdits(makeTrees(), editedTree);
    // Which crown shape (and conifer shape) each tree is drawn with.
    this.trees.forEach((t) => {
      t.pick = Math.floor(hashId(t.id) * 1000);
      t.variant = t.pick % CROWN_SEEDS.length;
      // A conifer's crown starts where its species' does (a Scots pine's
      // trunk is bare to half way), unless edited.
      if (t.conifer && t.base == null) t.base = coniferBase(t);
      // ... and is as wide as its species grows (unless edited or surveyed).
      if (t.conifer && t.crownW == null) t.crownW = coniferWidth(t);
    });
    this.shapes = [];
    for (const t of this.trees) {
      // Trunk (solid): drawn tapering from 0.024 h to under 0.01 h across.
      // (As thick as its species' trunk is drawn: src/world/species.js.)
      this.shapes.push({ type: 'cylinder', name: 'a tree trunk', x: t.x, z: t.z, r: t.h * (t.conifer ? 0.014 : 0.019) * trunkThickness(t), y0: t.y - 0.2, y1: t.y + t.h * (t.conifer ? Math.max(0.2, t.base ?? 0) : 0.42) }); // (a conifer's up to its crown: a pine's bare trunk is solid)
      if (t.conifer) {
        // As drawn (crownOf): boughs from `base` up, cone of radius r.
        const c = crownOf(t);
        this.shapes.push({ type: 'cone', name: 'a tree', x: t.x, z: t.z, r: c.r, y0: c.y0, h: c.ch });
      } else {
        // The crown's own clumps, placed, sized and turned as drawn
        // (src/world/world.js, crownOf): from `base` up to the top, crownW wide.
        const { sx, sy, cy } = crownOf(t);
        this.shapes.push({
          type: 'crown', name: 'a tree', cx: t.x, cy, cz: t.z, sx, sy,
          cos: Math.cos(t.rot), sin: Math.sin(t.rot), seed: CROWN_SEEDS[t.variant], ...crownShape(CROWN_SEEDS[t.variant]),
        });
      }
    }
    const L = LOCATION.layout;
    // The club's own things, laid out in the club frame (src/sim/location.js)
    // and turned into the world below. Drawn in that frame by the world.
    const club = [];
    // Clubhouse behind the pilot: walls, pitched roof (eaves to ridge).
    this.hut = L.hut;
    if (L.hut) {
      const { x, z, w, d, wall, ridge } = L.hut;
      const [x0, x1, z0, z1] = [x - w / 2, x + w / 2, z - d / 2, z + d / 2];
      club.push({ type: 'box', name: 'the clubhouse', min: [x0, 0, z0], max: [x1, wall, z1] });
      club.push({ type: 'box', name: 'the clubhouse roof', min: [x0 - 0.4, wall - 0.1, z0 - 0.4], max: [x1 + 0.4, wall + 0.75, z1 + 0.4] });
      club.push({ type: 'box', name: 'the clubhouse roof', min: [x0 - 0.4, wall + 0.7, z0 + 1.6], max: [x1 + 0.4, ridge, z1 - 1.6] });
    }
    // Shipping container (20 ft) beside it.
    this.container = L.container;
    if (L.container) {
      const c = L.container;
      club.push({ type: 'box', name: 'the container', min: [c.x - c.l / 2, 0, c.z - c.w / 2], max: [c.x + c.l / 2, c.h, c.z + c.w / 2] });
    }
    // Pop-up gazebo in the pits, behind the safety fence.
    this.gazebo = L.gazebo;
    const gz = L.gazebo;
    if (gz) {
      for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
        club.push({ type: 'cylinder', name: 'the gazebo', x: gz.x + dx, z: gz.z + dz, r: 0.03, y0: 0, y1: 2.2 });
      }
      club.push({ type: 'box', name: 'the gazebo', min: [gz.x - 1.6, 2.1, gz.z - 1.6], max: [gz.x + 1.6, 2.7, gz.z + 1.6] });
      club.push({ type: 'box', name: 'the pits table', min: [gz.x - 1, 0, gz.z + 0.2], max: [gz.x + 1, 0.75, gz.z + 1] });
    }
    // Windsock pole (kept in world coordinates: it swings with the wind).
    // Placed in the editor (world frame), or taken away (false), or the site's own.
    const ws = L.windsock;
    const placed = EDITS.site.windsock;
    this.windsock = null;
    if (placed) {
      this.windsock = { height: 5, x: placed.x, z: placed.z };
      const y = heightAt(placed.x, placed.z);
      this.shapes.push({ type: 'cylinder', name: 'the windsock pole', x: placed.x, z: placed.z, r: 0.05, y0: y - 0.2, y1: y + 5 });
    } else if (ws && placed !== false) {
      const [wsx, wsz] = clubToWorld(ws.x, ws.z);
      this.windsock = { ...ws, x: wsx, z: wsz };
      club.push({ type: 'cylinder', name: 'the windsock pole', x: ws.x, z: ws.z, r: 0.05, y0: 0, y1: ws.height });
    }
    // Safety fence: posts and the top rail.
    const f = L.fence;
    this.fence = null;
    if (f) {
      const nPosts = Math.round((f.x1 - f.x0) / 5.1) + 1;
      this.fence = { z: f.z, posts: Array.from({ length: nPosts }, (_, i) => f.x0 + i * 5.1), height: 1.1, railY: 1.0, x0: f.x0, x1: f.x1 };
      for (const px of this.fence.posts) club.push({ type: 'cylinder', name: 'the fence', x: px, z: f.z, r: 0.04, y0: 0, y1: 1.1 });
      club.push({ type: 'box', name: 'the fence', min: [f.x0, 0.98, f.z - 0.02], max: [f.x1, 1.02, f.z + 0.02] });
    }
    // Flight-line table.
    this.table = L.table;
    if (L.table) club.push({ type: 'box', name: 'the table', min: [L.table.x - 1, 0, L.table.z - 0.4], max: [L.table.x + 1, 0.78, L.table.z + 0.4] });
    for (const sh of club) this.shapes.push(clubShapeToWorld(sh));
    // Marquees (world frame): solid walls and roof.
    this.tents = L.tents ?? [];
    for (const t of this.tents) {
      const y = heightAt(t.x, t.z);
      this.shapes.push({ type: 'cylinder', name: 'the tent', x: t.x, z: t.z, r: t.r, y0: y, y1: y + t.wall });
      this.shapes.push({ type: 'cone', name: 'the tent', solid: true, x: t.x, z: t.z, r: t.r, y0: y + t.wall, h: t.h - t.wall });
    }
    // Cars in the car park, nose to the field (world frame).
    this.cars = L.cars;
    for (const c of this.cars) {
      const y = heightAt(c.x, c.z);
      this.shapes.push({ type: 'box', name: 'a car', min: [c.x - 0.9, y, c.z - 2.1], max: [c.x + 0.9, y + 1.45, c.z + 2.1] });
    }
    // Bushes and hedges: soft, like foliage (they catch a model).
    this.bushes = applyBushEdits(makeBushes(), editedBush);
    for (const b of this.bushes) {
      const y = heightAt(b.x, b.z);
      this.shapes.push({ type: 'ellipsoid', name: 'a bush', cx: b.x, cy: y + b.h * 0.5, cz: b.z, rx: b.w * 0.9, ry: b.h * 0.5, rz: b.w * 0.9, deciduous: true });
    }
    // Buildings at a real site.
    this.buildings = applyBuildingEdits(LOCATION.data?.buildings ?? []).map((b) => ({ ...prepareBuilding(b), index: b.index }));
    for (const b of this.buildings) this.shapes.push({ type: 'building', name: 'a building', b });
    // Site fences: thin slabs along each stretch, solid like a wall (no
    // flying through chain link or mesh panels).
    this.fences = applyFenceEdits(L.fences ?? []).map((f) => {
      const path = f.path ?? [f.from, f.to];
      const name = { panels: 'the temporary fence', net: 'the safety net' }[f.kind] ?? 'the chain-link fence';
      for (let i = 1; i < path.length; i++) {
        const [ax, az] = path[i - 1];
        const [bx, bz] = path[i];
        const len = Math.hypot(bx - ax, bz - az);
        const nx = (-(bz - az) / len) * 0.05;
        const nz = ((bx - ax) / len) * 0.05;
        const y = Math.min(heightAt(ax, az), heightAt(bx, bz));
        const pts = [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]];
        const b = {
          pts, y0: y - 0.3, eave: y + f.height, ridge: y + f.height, kind: 'fence',
          x0: Math.min(ax, bx) - 0.1, x1: Math.max(ax, bx) + 0.1, z0: Math.min(az, bz) - 0.1, z1: Math.max(az, bz) + 0.1,
        };
        this.shapes.push({ type: 'building', name, b });
      }
      return { ...f, path };
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

  /** Rebuild everything from the site and the current edits (src/sim/edits.js). */
  reload() {
    Object.assign(this, new Obstacles());
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
        // (Bushes: lose their leaves like the trees.)
        const k = s.deciduous ? caught() : 1;
        const u = (x - s.cx) / (s.rx * k);
        const v = (y - s.cy) / (s.ry * k);
        const w = (z - s.cz) / (s.rz * k);
        return u * u + v * v + w * w < 1 ? { soft: true, sparse: s.deciduous ? SPARSE() : 0 } : null;
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
        // Out of leaf: only the clumps' inner branches catch.
        const shrink = caught();
        for (const [cx, cy, cz, r0] of s.clumps) {
          const r = r0 * shrink;
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
          if (fx * fx + fy * fy + fz * fz < r * r) return { soft: true, sparse: SPARSE() };
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
        const dx = x - s.x;
        const dz = z - s.z;
        const r = Math.hypot(dx, dz);
        const R = s.r * (1 - t);
        if (r >= R) return null;
        if (!s.solid) return { soft: true };
        // (A tent's roof: out through the slope, square to it.)
        const sl = Math.hypot(s.r, s.h);
        const inv = r > 1e-6 ? 1 / r : 0;
        return { depth: ((R - r) * s.h) / sl, nx: (dx * inv * s.h) / sl, ny: s.r / sl, nz: (dz * inv * s.h) / sl };
      }
      default:
        return null;
    }
  }
}

/** A club-frame shape in world coordinates: boxes become turned slabs. */
function clubShapeToWorld(s) {
  if (!clubAngle()) return s;
  if (s.type === 'cylinder') {
    const [x, z] = clubToWorld(s.x, s.z);
    return { ...s, x, z };
  }
  if (s.type === 'box') {
    const [x0, y0, z0] = s.min;
    const [x1, y1, z1] = s.max;
    const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => clubToWorld(x, z));
    const b = {
      pts, y0, eave: y1, ridge: y1, kind: 'club',
      x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
      z0: Math.min(...pts.map((p) => p[1])), z1: Math.max(...pts.map((p) => p[1])),
    };
    return { type: 'building', name: s.name, b };
  }
  return s;
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
