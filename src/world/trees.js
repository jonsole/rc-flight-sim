// Tree shapes for the instanced woods: a few broadleaf and conifer variants
// so neighbouring trees don't look identical.
//  - Broadleaf crowns: several lumpy blobs merged into one billowy canopy,
//    darker underneath and inside, lighter on top.
//  - Conifers: stacked tiers with ragged lower edges.
//  - Trunks with a couple of branch stubs.
// Shapes are unit sized: crowns fit a radius-1 sphere at the origin;
// conifers stand on y = 0 with radius 1 at the base and height 1; trunks
// rise from y = 0 to 1. Colours are per vertex (shading), tinted per tree.
import { IcosahedronGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const ni = (g) => (g.index ? g.toNonIndexed() : g);

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// Smooth 3D value noise for the lumps.
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise3(x, y, z) {
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

function shade(geo, fn) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const col = [];
  const v = new Vector3();
  const nv = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    nv.fromBufferAttribute(n, i);
    const c = fn(v, nv);
    col.push(c[0], c[1], c[2]);
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/** A billowy broadleaf crown (unit radius): distinct leaf clumps with dark gaps between them. */
export function broadleafCrown(seed) {
  const rnd = rng(seed);
  const parts = [];
  // Clumps scattered over a slightly squashed dome, more of them up top,
  // poking out by different amounts so the outline is ragged, not round.
  const clumps = 11 + Math.floor(rnd() * 5);
  for (let i = 0; i < clumps; i++) {
    const r = 0.26 + rnd() * 0.2;
    const g = new IcosahedronGeometry(r, 2);
    const a = rnd() * Math.PI * 2;
    const y = Math.min(1, Math.max(-0.6, rnd() * 1.5 - 0.5)); // -0.5..1, biased upwards
    const ring = Math.sqrt(1 - y * y);
    const out = (1 - r) * (0.75 + rnd() * 0.35);
    g.translate(Math.cos(a) * ring * out, y * out * 0.8, Math.sin(a) * ring * out);
    parts.push(g);
  }
  parts.push(new IcosahedronGeometry(0.6, 2)); // fill the middle
  let geo = mergeGeometries(parts.map(ni));
  // Leafy lumps on each clump: two octaves of noise.
  const p = geo.attributes.position;
  const v = new Vector3();
  let max = 0;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = noise3(v.x * 3 + seed, v.y * 3, v.z * 3) - 0.5 + (noise3(v.x * 9, v.y * 9 + seed, v.z * 9) - 0.5) * 0.45;
    v.multiplyScalar(1 + n * 0.32);
    p.setXYZ(i, v.x, v.y, v.z);
    max = Math.max(max, v.length());
  }
  geo.scale(1 / max, 1 / max, 1 / max);
  // Weld shared corners so the canopy is smoothly lit, not faceted.
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  const ss = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  geo = shade(geo, (pos, nrm) => {
    // Gaps between clumps (closer to the middle) fall into shadow; the
    // underside is darker, sunlit tops lighter.
    const gap = 0.5 + 0.55 * ss(0.45, 0.95, pos.length());
    const top = 0.62 + 0.28 * (pos.y * 0.5 + 0.5) + 0.12 * Math.max(0, nrm.y);
    const k = gap * top * (0.88 + 0.24 * noise3(pos.x * 7, pos.y * 7, pos.z * 7 + seed));
    return [k, k * 1.02, k * 0.9];
  });
  return geo;
}

/** A conifer: stacked tiers, radius 1 at the base, height 1. */
export function conifer(seed) {
  const rnd = rng(seed);
  const parts = [];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = (1 - t * 0.78) * (0.95 + rnd() * 0.1);
    const h = 0.42 - t * 0.05;
    const g = new ConeGeometry(r, h, 11, 1, true);
    // Ragged lower edge.
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      if (p.getY(k) < 0) p.setY(k, p.getY(k) - rnd() * 0.06);
    }
    g.translate(0, t * 0.62 + h / 2, 0);
    parts.push(ni(g));
  }
  let geo = mergeGeometries(parts);
  const box = { min: 0, max: 0 };
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) box.max = Math.max(box.max, p.getY(i));
  geo.translate(0, 0.04, 0);
  geo.scale(1, 1 / (box.max + 0.04), 1);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  geo = shade(geo, (pos) => {
    const k = 0.55 + 0.5 * pos.y;
    return [k * 0.92, k, k * 0.95];
  });
  return geo;
}

/** A trunk (0..1 tall) with a few branch stubs into the crown. */
export function trunk(seed, branches = true) {
  const rnd = rng(seed);
  const parts = [ni(new CylinderGeometry(0.2, 0.36, 1, 7).translate(0, 0.5, 0))];
  if (branches) {
    for (let i = 0; i < 3; i++) {
      const b = new CylinderGeometry(0.06, 0.12, 0.5, 5);
      b.translate(0, 0.25, 0);
      b.rotateZ(0.7 + rnd() * 0.4);
      b.rotateY(rnd() * Math.PI * 2);
      b.translate(0, 0.75 + rnd() * 0.2, 0);
      parts.push(ni(b));
    }
  }
  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  return shade(geo, (pos) => {
    const k = 0.75 + 0.25 * pos.y;
    return [k, k, k];
  });
}
