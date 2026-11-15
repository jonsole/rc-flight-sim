// Tree shapes for the instanced woods: a few broadleaf and conifer variants
// so neighbouring trees don't look identical.
//  - Broadleaf crowns: several lumpy blobs merged into one billowy canopy,
//    darker underneath and inside, lighter on top.
//  - Conifers: stacked tiers with ragged lower edges.
//  - Trunks with a couple of branch stubs.
// Shapes are unit sized: crowns fit a radius-1 sphere at the origin;
// conifers stand on y = 0 with radius 1 at the base and height 1; trunks
// rise from y = 0 to 1. Colours are per vertex (shading), tinted per tree.
import { IcosahedronGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Vector3, CatmullRomCurve3, TubeGeometry } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, noise3, crownClumps, lumpScale } from '../sim/treeShapes.js';

const ni = (g) => (g.index ? g.toNonIndexed() : g);

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

/**
 * A billowy broadleaf crown (unit radius): distinct leaf clumps with dark
 * gaps between them. `detail` 2 is full detail (~2200 triangles); 1 (~550)
 * and 0 (~140) are for trees further away and slower devices.
 */
export function broadleafCrown(seed, detail = 2) {
  // Clump layout shared with the collisions (src/sim/treeShapes.js).
  const parts = crownClumps(seed).map(([x, y, z, r]) => new IcosahedronGeometry(r, detail).translate(x, y, z));
  let geo = mergeGeometries(parts.map(ni));
  // Leafy lumps on each clump.
  const p = geo.attributes.position;
  const v = new Vector3();
  let max = 0;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(lumpScale(v, seed));
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

/**
 * A distant broadleaf crown (unit radius): one lumpy blob, ~80 triangles,
 * shaded like the full crown. Reads as a tree from a few hundred metres.
 */
export function blobCrown(seed) {
  let geo = ni(new IcosahedronGeometry(1, 1));
  const p = geo.attributes.position;
  const v = new Vector3();
  let max = 0;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(0.85 + 0.3 * noise3(v.x * 1.7 + seed, v.y * 1.7, v.z * 1.7));
    p.setXYZ(i, v.x, v.y, v.z);
    max = Math.max(max, v.length());
  }
  geo.scale(1 / max, 1 / max, 1 / max);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  return shade(geo, (pos, nrm) => {
    const top = 0.62 + 0.28 * (pos.y * 0.5 + 0.5) + 0.12 * Math.max(0, nrm.y);
    const k = 0.85 * top * (0.9 + 0.2 * noise3(pos.x * 5, pos.y * 5, pos.z * 5 + seed));
    return [k, k * 1.02, k * 0.9];
  });
}

/**
 * A conifer, radius 1 at the base and 1 tall: many overlapping tiers of
 * drooping boughs with uneven, star-shaped edges (bough tips), getting
 * narrower towards a thin spire. Drawn double-sided so the undersides of the
 * boughs show from below.
 */
export function conifer(seed) {
  const rnd = rng(seed);
  const parts = [];
  const tiers = 7 + Math.floor(rnd() * 2);
  const SIDES = 14;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = (1 - t * 0.86) * (0.9 + rnd() * 0.14);
    const h = 0.24 - t * 0.09;
    const g = new ConeGeometry(r, h, SIDES, 2, true);
    const p = g.attributes.position;
    const phase = rnd() * 10;
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k);
      const x = p.getX(k);
      const z = p.getZ(k);
      const rim = (h / 2 - y) / h; // 0 at the tip, 1 at the rim
      if (rim < 0.01) continue;
      // Bough tips: the rim pokes out and in, and droops between them.
      const a = Math.atan2(z, x);
      const lobe = noise3(Math.cos(a) * 2.2 + phase, Math.sin(a) * 2.2, i * 3.7);
      const s = 1 + (lobe - 0.5) * 0.32 * rim;
      p.setXYZ(k, x * s, y - rim * rim * (0.02 + (1 - lobe) * 0.05), z * s);
    }
    // Each tier a little off-centre and turned, so they don't line up.
    g.rotateY(rnd() * Math.PI);
    g.translate((rnd() - 0.5) * 0.04 * r, 0.05 + t * 0.8 + h / 2, (rnd() - 0.5) * 0.04 * r);
    parts.push(ni(g));
  }
  // Thin spire.
  parts.push(ni(new ConeGeometry(0.07, 0.16, 7, 1, true).translate(0, 0.05 + 0.8 + 0.08, 0)));
  let geo = mergeGeometries(parts);
  let top = 0;
  const pp = geo.attributes.position;
  for (let i = 0; i < pp.count; i++) top = Math.max(top, pp.getY(i));
  geo.scale(1, 1 / top, 1);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  geo = shade(geo, (pos) => {
    // Darker low down and deep inside each tier, lighter bough tips.
    const rr = Math.hypot(pos.x, pos.z);
    const outer = rr / Math.max(0.08, 1 - pos.y * 0.86);
    const k = (0.5 + 0.45 * pos.y) * (0.7 + 0.4 * Math.min(1, outer)) * (0.9 + 0.2 * noise3(pos.x * 9, pos.y * 9, pos.z * 9));
    return [k * 0.92, k, k * 0.95];
  });
  return geo;
}

/**
 * A tube along a curve whose radius tapers from r0 to r1 (end may be capped
 * by the crown, so it's left open).
 */
function taperedTube(points, r0, r1, radial = 6, segs = 5) {
  const curve = new CatmullRomCurve3(points);
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const p = g.attributes.position;
  const v = new Vector3();
  const c = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r).add(c);
      p.setXYZ(k, v.x, v.y, v.z);
    }
  }
  return ni(g);
}

/**
 * A broadleaf trunk for a tree 1 unit tall (scaled by the tree height): a
 * flared, slightly crooked trunk that forks into a handful of limbs reaching
 * up and out into the crown, each with a smaller side branch.
 */
export function trunk(seed) {
  const rnd = rng(seed);
  const lean = (rnd() - 0.5) * 0.02;
  const top = 0.56;
  const parts = [
    taperedTube([
      new Vector3(0, 0, 0),
      new Vector3(lean * 0.3 + (rnd() - 0.5) * 0.006, top * 0.35, (rnd() - 0.5) * 0.006),
      new Vector3(lean * 0.7, top * 0.7, (rnd() - 0.5) * 0.01),
      new Vector3(lean, top, 0),
    ], 0.024, 0.009, 7, 6),
    // Root flare.
    ni(new CylinderGeometry(0.022, 0.034, 0.03, 7, 1, true).translate(0, 0.015, 0)),
  ];
  const limbs = 5 + Math.floor(rnd() * 2);
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + rnd() * 0.8;
    const y0 = 0.3 + rnd() * 0.16;
    const up = 0.55 + rnd() * 0.45; // 30-55 degrees above level
    const len = 0.17 + rnd() * 0.1;
    const dir = new Vector3(Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up));
    const start = new Vector3(lean * (y0 / top), y0, 0);
    const mid = start.clone().addScaledVector(dir, len * 0.5);
    mid.y += len * 0.04;
    const end = start.clone().addScaledVector(dir, len);
    end.y += len * 0.15; // curving upwards
    const r0 = 0.0085 - (y0 - 0.3) * 0.02;
    parts.push(taperedTube([start, mid, end], r0, 0.0025, 5, 4));
    // A side branch from about halfway along.
    const az2 = az + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.5);
    const d2 = new Vector3(Math.cos(az2) * 0.7, 0.7, Math.sin(az2) * 0.7).normalize();
    const s2 = mid.clone();
    parts.push(taperedTube([s2, s2.clone().addScaledVector(d2, len * 0.3), s2.clone().addScaledVector(d2, len * 0.55).add(new Vector3(0, len * 0.06, 0))], r0 * 0.55, 0.0018, 4, 3));
  }
  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  return shade(geo, (pos) => {
    // Darker at the foot and in the crown's shade, a little mottled.
    const k = (0.7 + 0.5 * Math.min(1, pos.y / 0.3)) * (pos.y > 0.4 ? 0.8 : 1) * (0.9 + 0.2 * noise3(pos.x * 90, pos.y * 40, pos.z * 90));
    return [k, k, k];
  });
}

/** A plain trunk for distant broadleaf trees: a tapering post into the crown. */
export function simpleTrunk() {
  const geo = taperedTube([new Vector3(0, 0, 0), new Vector3(0, 0.3, 0), new Vector3(0, 0.56, 0)], 0.022, 0.01, 5, 2);
  geo.computeVertexNormals();
  return shade(geo, (pos) => {
    const k = 0.7 + 0.45 * Math.min(1, pos.y / 0.3);
    return [k, k, k];
  });
}

/** A conifer trunk for a tree 1 unit tall: straight, tapering, up into the foliage. */
export function coniferTrunk() {
  const geo = taperedTube([new Vector3(0, 0, 0), new Vector3(0, 0.3, 0), new Vector3(0, 0.6, 0)], 0.018, 0.006, 6, 2);
  geo.computeVertexNormals();
  return shade(geo, (pos) => {
    const k = 0.75 + 0.4 * Math.min(1, pos.y / 0.2);
    return [k, k * 0.95, k * 0.9];
  });
}

/** Shared state for the leaf shader: time and wind (m/s, blowing towards dir). */
export const leafUniforms = {
  uLeafTime: { value: 0 },
  uWindSpeed: { value: 0 },
  uWindDir: { value: new Vector3(1, 0, 0) },
};

/**
 * Leaves: mottled colour (lighter and darker patches across each crown) and
 * a gentle sway that only starts once the wind is fairly strong. Add after
 * addCloudShadows, whose noise and world position this reuses.
 */
export function addLeafShading(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, leafUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLeafTime;\nuniform float uWindSpeed;\nuniform vec3 uWindDir;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          // Nothing in light winds, building up from 3 to 10 m/s.
          float k = smoothstep(3.0, 10.0, uWindSpeed);
          if (k > 0.0) {
            mat3 m = mat3(instanceMatrix);
            vec3 s2 = vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]));
            float hgt = sqrt(s2.y);
            vec3 org = instanceMatrix[3].xyz;
            float ph = org.x * 0.05 + org.z * 0.07; // gusts roll across the woods
            float gust = 0.45 + 0.4 * sin(uLeafTime * 0.9 - ph) + 0.15 * sin(uLeafTime * 2.1 - ph * 1.6);
            #ifdef CONIFER
              float bend = position.y * position.y; // shapes stand on y = 0, 1 tall
            #else
              float bend = smoothstep(-1.0, 1.0, position.y); // crowns centred on 0
              bend *= bend;
            #endif
            // Metres at the top of the tree, along the wind.
            float metres = k * gust * 0.11 * min(hgt, 8.0) * bend;
            // Small leafy flutter on top.
            vec3 fl = vec3(sin(uLeafTime * 5.3 + position.x * 9.0 + ph), 0.0, cos(uLeafTime * 4.7 + position.z * 9.0 + ph)) * 0.1 * k * bend;
            vec3 w = uWindDir * metres + fl;
            // World-space offset into the tree's own (rotated, scaled) space.
            transformed += (transpose(m) * w) / s2;
          }
        }
        #endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wp = vCloudWorld;
          float m = cNoise(wp.xz * 0.45 + wp.y * 0.6) * 0.6 + cNoise(wp.xz * 1.7 - wp.y * 1.3) * 0.4;
          diffuseColor.rgb *= mix(vec3(0.84, 0.86, 0.86), vec3(1.12, 1.12, 0.96), m);
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|leaves`;
  material.needsUpdate = true;
  return material;
}
