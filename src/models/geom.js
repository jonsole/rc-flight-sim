// Small procedural-geometry helpers: lofting rings into closed meshes.
import { BufferGeometry, Float32BufferAttribute, Vector3, Color } from 'three';

/**
 * Loft a list of closed rings (each an array of Vector3, equal length) into a
 * closed mesh with end caps. Winding is auto-oriented outward.
 * @param {Vector3[][]} rings
 * @param {object} [opts]
 * @param {(p:Vector3, ringIdx:number, ptIdx:number)=>Color} [opts.color]
 * @param {boolean} [opts.caps=true]
 */
export function loft(rings, opts = {}) {
  const { color, caps = true } = opts;
  const nR = rings.length;
  const nP = rings[0].length;
  const pos = [];
  const col = [];
  const idx = [];
  const c = new Color();
  const push = (p, ri, pi) => {
    pos.push(p.x, p.y, p.z);
    if (color) {
      c.copy(color(p, ri, pi));
      col.push(c.r, c.g, c.b);
    }
    return pos.length / 3 - 1;
  };
  for (let i = 0; i < nR; i++) for (let j = 0; j < nP; j++) push(rings[i][j], i, j);
  const side = [];
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < nP; j++) {
      const j1 = (j + 1) % nP;
      const a = i * nP + j;
      const b = (i + 1) * nP + j;
      const cc = (i + 1) * nP + j1;
      const d = i * nP + j1;
      side.push(a, b, d, b, cc, d);
    }
  }
  orient(side, pos, centroidOf(pos));
  idx.push(...side);

  if (caps) {
    for (const [ri, other] of [[0, 1], [nR - 1, nR - 2]]) {
      const ring = rings[ri];
      const ctr = new Vector3();
      ring.forEach((p) => ctr.add(p));
      ctr.divideScalar(nP);
      const away = ctr.clone().sub(centroidRing(rings[other]));
      if (away.lengthSq() < 1e-12) continue;
      const start = pos.length / 3;
      for (let j = 0; j < nP; j++) push(ring[j], ri, j);
      const ci = push(ctr, ri, 0);
      const tris = [];
      for (let j = 0; j < nP; j++) tris.push(ci, start + j, start + ((j + 1) % nP));
      // Flip if the fan faces inward.
      let sum = 0;
      for (let t = 0; t < tris.length; t += 3) sum += triNormal(pos, tris[t], tris[t + 1], tris[t + 2]).dot(away);
      if (sum < 0) flipTris(tris);
      idx.push(...tris);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  if (color) g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function centroidOf(pos) {
  const c = new Vector3();
  const n = pos.length / 3;
  for (let i = 0; i < pos.length; i += 3) c.set(c.x + pos[i], c.y + pos[i + 1], c.z + pos[i + 2]);
  return c.divideScalar(n);
}

function centroidRing(ring) {
  const c = new Vector3();
  ring.forEach((p) => c.add(p));
  return c.divideScalar(ring.length);
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
function triNormal(pos, i, j, k) {
  _a.fromArray(pos, i * 3);
  _b.fromArray(pos, j * 3);
  _c.fromArray(pos, k * 3);
  return new Vector3().subVectors(_b, _a).cross(_c.clone().sub(_a));
}

function orient(tris, pos, centroid) {
  let sum = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const n = triNormal(pos, tris[t], tris[t + 1], tris[t + 2]);
    const fc = new Vector3()
      .fromArray(pos, tris[t] * 3)
      .add(new Vector3().fromArray(pos, tris[t + 1] * 3))
      .add(new Vector3().fromArray(pos, tris[t + 2] * 3))
      .divideScalar(3)
      .sub(centroid);
    sum += n.dot(fc);
  }
  if (sum < 0) flipTris(tris);
}

function flipTris(tris) {
  for (let t = 0; t < tris.length; t += 3) {
    const tmp = tris[t + 1];
    tris[t + 1] = tris[t + 2];
    tris[t + 2] = tmp;
  }
}

/** Mirror a geometry across the z = 0 plane, keeping faces outward. */
export function mirrorZ(geometry) {
  const g = geometry.clone();
  g.scale(1, 1, -1);
  const index = g.getIndex();
  const arr = index.array;
  for (let t = 0; t < arr.length; t += 3) {
    const tmp = arr[t + 1];
    arr[t + 1] = arr[t + 2];
    arr[t + 2] = tmp;
  }
  index.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** NACA 4-digit style section: returns {upper, lower} y at chord fraction x (0..1). */
export function naca(x, t, m = 0, p = 0.4) {
  const xc = Math.min(1, Math.max(0, x));
  const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  let yc = 0;
  if (m > 0) yc = xc < p ? (m / (p * p)) * (2 * p * xc - xc * xc) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * xc - xc * xc);
  return { upper: yc + yt, lower: yc - yt };
}

/**
 * Closed airfoil ring between chord fractions f0..f1 as [frac, y] pairs
 * (y normalised by chord). Goes along the upper surface towards the LE, then
 * back along the lower surface.
 */
export function airfoilRing(f0, f1, n, t, m) {
  const pts = [];
  const spacing = (s) => 0.5 - 0.5 * Math.cos(Math.PI * s);
  for (let i = 0; i <= n; i++) {
    const f = f1 - (f1 - f0) * spacing(i / n);
    pts.push([f, naca(f, t, m).upper]);
  }
  // Blunt ends (cut sections) keep both corner points; sharp LE/TE share one.
  const iStart = f0 > 0 ? 0 : 1;
  const iEnd = f1 < 1 ? n : n - 1;
  for (let i = iStart; i <= iEnd; i++) {
    const f = f0 + (f1 - f0) * spacing(i / n);
    pts.push([f, naca(f, t, m).lower]);
  }
  return pts;
}
