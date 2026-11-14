// Mid-air collisions between players. Each aeroplane type gets a coarse
// voxel shape built from its 3D model (body axes). Every frame this player's
// surface sample points are moved into each other player's body frame and
// tested against that player's voxels, swept along the relative motion since
// the last frame so a fast head-on pass can't slip between frames.
import { Vector3, Quaternion, Matrix4 } from 'three';

const CELL = 0.035; // m
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
const _m = new Matrix4();

const key = (i, j, k) => `${i},${j},${k}`;

/** Surface points of the visible meshes of a model at the origin: [{ p: Vector3, part }]. */
function surfacePoints(root, step) {
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);
  const out = [];
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let part = '';
    for (let q = o; q && !part; q = q.parent) part = q.userData?.part || '';
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    _m.copy(o.matrixWorld);
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      _a.fromBufferAttribute(pos, i0).applyMatrix4(_m);
      _b.fromBufferAttribute(pos, i1).applyMatrix4(_m);
      _c.fromBufferAttribute(pos, i2).applyMatrix4(_m);
      // Sample the triangle on a grid finer than `step`.
      const len = Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a));
      const k = Math.min(40, Math.max(1, Math.ceil(len / step)));
      for (let u = 0; u <= k; u++) {
        for (let v = 0; u + v <= k; v++) {
          const w = k - u - v;
          out.push({ p: new Vector3().addScaledVector(_a, u / k).addScaledVector(_b, v / k).addScaledVector(_c, w / k), part });
        }
      }
    }
  });
  return out;
}

/**
 * Collision shape of a model: an occupancy grid (for being hit) and a thinned
 * set of sample points (for hitting others), both in body axes.
 */
export function buildShape(root) {
  const pts = surfacePoints(root, CELL * 0.7);
  const cells = new Set();
  let radius = 0;
  for (const { p } of pts) {
    cells.add(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    radius = Math.max(radius, p.length());
  }
  // One sample per coarse cell keeps the per-frame cost low.
  const seen = new Set();
  const samples = [];
  const S = CELL * 1.5;
  for (const s of pts) {
    const k = key(Math.floor(s.p.x / S), Math.floor(s.p.y / S), Math.floor(s.p.z / S));
    if (seen.has(k)) continue;
    seen.add(k);
    samples.push(s);
  }
  return { cells, samples, radius };
}

/** Is a body-frame point inside the shape (within one cell)? */
export function occupied(shape, p) {
  return shape.cells.has(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
}

/**
 * Swept test of this aeroplane's samples against another's shape.
 * Poses are { p: Vector3, q: Quaternion }; `prev` is the relative transform
 * from the last frame (or null). Returns { sample } on a hit, else null, and
 * stores the new relative transform in `state`. A hit also says which of
 * the other aeroplane's parts was struck (`theirPart`).
 */
export function sweptHit(mine, minePose, other, otherPose, state) {
  // Relative transform: my body -> their body.
  const inv = state.inv || (state.inv = new Quaternion());
  inv.copy(otherPose.q).invert();
  const rq = (state.rq ||= new Quaternion()).copy(inv).multiply(minePose.q);
  const rt = (state.rt ||= new Vector3()).copy(minePose.p).sub(otherPose.p).applyQuaternion(inv);
  const had = state.prq !== undefined;
  const prq = (state.prq ||= new Quaternion().copy(rq));
  const prt = (state.prt ||= new Vector3().copy(rt));
  if (!had) {
    prq.copy(rq);
    prt.copy(rt);
  }
  let hit = null;
  const reach = mine.radius + other.radius;
  // Quick reject on bounding spheres (now and last frame).
  if (rt.length() < reach + 0.1 || prt.length() < reach + 0.1) {
    const move = rt.distanceTo(prt) + mine.radius * 2 * Math.min(1, rq.angleTo(prq));
    const steps = Math.min(32, Math.max(1, Math.ceil(move / (CELL * 0.8))));
    const q = new Quaternion();
    const t = new Vector3();
    for (let s = 1; s <= steps && !hit; s++) {
      const f = s / steps;
      q.slerpQuaternions(prq, rq, f);
      t.lerpVectors(prt, rt, f);
      for (const smp of mine.samples) {
        _p.copy(smp.p).applyQuaternion(q).add(t);
        if (_p.lengthSq() > other.radius * other.radius) continue;
        if (occupied(other, _p)) {
          // Which of their parts was hit: the nearest of their samples.
          let best = Infinity;
          let theirPart = '';
          for (const o of other.samples) {
            const d = o.p.distanceToSquared(_p);
            if (d < best) {
              best = d;
              theirPart = o.part;
            }
          }
          hit = { sample: smp, theirPart };
          break;
        }
      }
    }
  }
  prq.copy(rq);
  prt.copy(rt);
  return hit;
}
