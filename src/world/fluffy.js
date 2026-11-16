// Leafy ("fluffy") tree crowns and bushes, the stylised way: each leaf
// clump of the crown (the same clumps the collisions use, from
// src/sim/treeShapes.js) is filled with cards carrying a cut-out picture of
// a cluster of leaves. The cards turn to face the camera, and are lit as if
// they were the round clump they make up (their normals point out of the
// crown), so the crown reads as soft, leafy balls with ragged edges rather
// than flat cards or a solid lump.
//
// The seasons work card by card: leaves come out (cards grow) through the
// spring and fall (shrink away) in autumn, in each card's own order, leaving
// the branches (crownBranches) bare in winter.
import {
  BufferGeometry, Float32BufferAttribute, CanvasTexture, SRGBColorSpace, DoubleSide, MeshLambertMaterial,
  MeshDepthMaterial, RGBADepthPacking, Sphere, Vector3, InstancedMesh, IcosahedronGeometry, MeshBasicMaterial,
  CatmullRomCurve3, TubeGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, noise3, crownShape } from '../sim/treeShapes.js';
import { leafUniforms } from './trees.js';

/** Cards per clump for a detail level (2 full, 1, 0, 'blob' for far away). */
const CARDS = { 2: 16, 1: 10, 0: 6, blob: 4 };

/** Leaf size: 1 was the first, rather big, leaves. */
const LEAF = 0.55;
const leafTex = {};
/**
 * A cluster of small leaves, white-ish (tinted per tree), cut out round its
 * edge. Fewer, bigger cards (lower `detail`) get more, smaller leaves in
 * their picture, so the leaves come out the same size at every quality.
 */
export function leafTexture(detail = 2) {
  if (leafTex[detail]) return leafTex[detail];
  const scale = Math.sqrt(CARDS[2] / (CARDS[detail] ?? CARDS[2])); // this card size / the full-detail one
  const count = Math.round((70 / (LEAF * LEAF)) * scale * scale);
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = rng(77);
  // Leaves scattered over a round cluster, denser in the middle; the ones
  // underneath darker, so the cluster has some depth.
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * S * 0.36;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const len = (S * (0.07 + rnd() * 0.05) * LEAF) / scale;
    const k = Math.round(150 + (i / count) * 80 + rnd() * 25);
    g.fillStyle = `rgb(${k},${k},${Math.round(k * 0.92)})`;
    g.save();
    g.translate(x, y);
    // Leaves point roughly outwards from the middle.
    g.rotate(a + Math.PI / 2 + (rnd() - 0.5) * 1.6);
    g.beginPath();
    g.moveTo(0, -len);
    g.quadraticCurveTo(len * 0.55, -len * 0.1, 0, len);
    g.quadraticCurveTo(-len * 0.55, -len * 0.1, 0, -len);
    g.fill();
    g.restore();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  leafTex[detail] = t;
  return t;
}

/**
 * A leafy crown (unit size, like broadleafCrown): cards over its clumps.
 * Every card is four vertices at its centre; the shader spreads them out to
 * face the camera (aCorner), at its size, turned (aCard: size, the point in
 * the year's leafing it comes and goes at, spin).
 */
export function fluffyCrown(seed, detail = 2) {
  const { clumps } = crownShape(seed);
  const per = CARDS[detail] ?? CARDS[2];
  const rnd = rng(seed * 7 + 3);
  const pos = [];
  const nrm = [];
  const col = [];
  const uv = [];
  const corner = [];
  const card = [];
  const index = [];
  const p = new Vector3();
  const n = new Vector3();
  const out = new Vector3();
  // Bigger cards when there are fewer, so the crown stays as full.
  const sizeK = 0.95 * Math.sqrt(CARDS[2] / per);
  clumps.forEach(([cx, cy, cz, r], ci) => {
    const core = ci === clumps.length - 1; // the big one in the middle: mostly hidden
    const count = core ? Math.ceil(per * 0.35) : per;
    for (let k = 0; k < count; k++) {
      // A point in the clump, mostly towards its surface, more on top.
      let ux;
      let uy;
      let uz;
      do {
        ux = rnd() * 2 - 1;
        uy = rnd() * 2 - 1;
        uz = rnd() * 2 - 1;
      } while (ux * ux + uy * uy + uz * uz > 1 || ux * ux + uy * uy + uz * uz < 0.05);
      const l = Math.hypot(ux, uy, uz);
      const depth = core ? 0.4 + rnd() * 0.5 : 0.45 + Math.sqrt(rnd()) * 0.45;
      p.set(cx + (ux / l) * r * depth, cy + ((uy + 0.15) / l) * r * depth, cz + (uz / l) * r * depth);
      // Lit as the crown and its clump: out from the middle of both.
      out.copy(p).normalize();
      n.set(p.x - cx, p.y - cy, p.z - cz).normalize().multiplyScalar(0.45).add(out).add(new Vector3(0, 0.25, 0)).normalize();
      // Shade: darker deep inside and underneath, lighter on top.
      const inner = Math.min(1, p.length());
      const shade = (0.5 + 0.5 * inner) * (0.7 + 0.25 * (p.y * 0.5 + 0.5)) * (0.86 + 0.28 * noise3(p.x * 6, p.y * 6, p.z * 6 + seed));
      const size = r * sizeK * (0.75 + rnd() * 0.45) * (core ? 1.2 : 1);
      // Outer, sunnier cards leaf first in spring and drop last (a little).
      const when = Math.min(0.999, Math.max(0, rnd() * 0.85 + inner * 0.15));
      const spin = rnd();
      const base = pos.length / 3;
      for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        col.push(shade, shade * 1.02, shade * 0.9);
        uv.push(ax * 0.5 + 0.5, ay * 0.5 + 0.5);
        corner.push(ax, ay);
        card.push(size, when, spin);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('aCorner', new Float32BufferAttribute(corner, 2));
  geo.setAttribute('aCard', new Float32BufferAttribute(card, 3));
  geo.setIndex(index);
  // The cards reach out past their centres: bounds for culling.
  geo.boundingSphere = new Sphere(new Vector3(), 1.35);
  return geo;
}

function tube(points, r0, r1, radial, segs) {
  const curve = new CatmullRomCurve3(points);
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const pp = g.attributes.position;
  const v = new Vector3();
  const c = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pp, k).sub(c).multiplyScalar(r).add(c);
      pp.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.deleteAttribute('uv');
  return g.toNonIndexed();
}

/**
 * The bare branches inside a crown (unit crown space, drawn with the crown's
 * matrix): a limb from below the crown out to each leaf clump, and twigs
 * spreading through the clump. `from` is where they start (y): the top of
 * the trunk for a tree, the ground for a bush. `twigs` false: limbs only,
 * for far away.
 */
export function crownBranches(seed, { from, twigs = true } = {}) {
  const { clumps } = crownShape(seed);
  const rnd = rng(seed * 13 + 5);
  // A tree's trunk reaches about the middle of its crown (y 0); limbs
  // leave it at different heights up to there. A bush's stems all start at
  // the ground.
  const bush = from != null;
  const parts = [];
  for (const [cx, cy, cz, r] of clumps.slice(0, -1)) {
    const start = new Vector3(0, bush ? from : -0.35 + rnd() * 0.4, 0);
    const end = new Vector3(cx, cy, cz).multiplyScalar(0.85 + rnd() * 0.1);
    if (end.y < start.y + 0.1) start.y = end.y - 0.1; // low limbs leave the trunk lower
    const mid = start.clone().lerp(end, 0.5);
    mid.y += 0.06 + rnd() * 0.06; // bowing upwards
    mid.x *= 0.85;
    mid.z *= 0.85;
    parts.push(tube([start, mid, end], bush ? 0.016 : 0.02, 0.008, twigs ? 4 : 3, twigs ? 3 : 2));
    if (!twigs) continue;
    for (let k = 0; k < 3; k++) {
      const a = rnd() * Math.PI * 2;
      const up = 0.15 + rnd() * 1.0;
      const d = new Vector3(Math.cos(a) * Math.cos(up), Math.sin(up), Math.sin(a) * Math.cos(up)).add(end.clone().normalize().multiplyScalar(0.6)).normalize();
      const from2 = mid.clone().lerp(end, 0.5 + rnd() * 0.5);
      const tip = from2.clone().addScaledVector(d, r * (0.8 + rnd() * 0.5));
      const bend = from2.clone().lerp(tip, 0.5).add(new Vector3(0, r * 0.1, 0));
      parts.push(tube([from2, bend, tip], 0.007, 0.0025, 3, 2));
    }
  }
  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const pp = geo.attributes.position;
  for (let i = 0; i < n; i++) {
    // Grey-brown bark (the bark material is a dark brown: lifted and greyed),
    // lighter out towards the twigs.
    const k = 1.35 + 0.45 * Math.min(1, Math.hypot(pp.getX(i), pp.getZ(i)) * 1.2);
    col.set([k, k * 1.08, k * 1.18], i * 3);
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

// The card-spreading part of the vertex shader, shared by the drawing and the
// shadow (depth) materials. Cards whose leaves aren't out (by the season,
// uBare) shrink to nothing: no pixels drawn for them at all.
const CARD_VERTEX = /* glsl */ `
  {
    float grow = clamp((aCard.y + 0.15 - uBare * 1.15) / 0.15, 0.0, 1.0);
    float an = aCard.z * 6.2831853;
    vec2 cr = mat2(cos(an), sin(an), -sin(an), cos(an)) * aCorner * aCard.x * grow;
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 off = camR * cr.x + camU * cr.y;
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 is2 = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      // Sized by the crown's width, in the (possibly squashed) crown's space.
      float isc = sqrt((is2.x + is2.z) * 0.5);
      transformed += (transpose(im) * (off * isc)) / is2;
    #else
      transformed += off;
    #endif
  }
`;
const CARD_DECLS = 'attribute vec2 aCorner;\nattribute vec3 aCard;\nuniform float uBare;';

/**
 * Turn a leaf material (after addCloudShadows and addLeafShading) into the
 * leafy-card one: cut-out leaf texture, cards facing the camera.
 */
export function makeFluffy(material, { smooth = true, detail = 2 } = {}) {
  material.map = leafTexture(detail);
  material.alphaTest = 0.5;
  // Soft cut-out edges with the screen's anti-aliasing (skipped on phones).
  material.alphaToCoverage = smooth;
  material.side = DoubleSide;
  material.defines = { ...(material.defines || {}), FLUFFY: '' };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERTEX}`);
    // Far away the texture's smaller copies (mipmaps) blur the leaves'
    // edges and the cards would fade away: keep them solid.
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 tsz = vec2(textureSize(map, 0));
        vec2 ddx = dFdx(vMapUv * tsz);
        vec2 ddy = dFdy(vMapUv * tsz);
        float lod = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-6));
        diffuseColor.a *= 1.0 + max(lod, 0.0) * 0.35;
      }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|fluffy`;
  material.needsUpdate = true;
  return material;
}

const depthMats = {};
/** For the shadow map: the same cards (at this detail), facing the sun. */
export function fluffyDepthMaterial(detail = 2) {
  if (depthMats[detail]) return depthMats[detail];
  const depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: leafTexture(detail), alphaTest: 0.5 });
  depthMats[detail] = depthMat;
  depthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERTEX}`);
  };
  depthMat.customProgramCacheKey = () => 'fluffyDepth';
  return depthMat;
}

const pickMat = new MeshBasicMaterial();
/**
 * Pointer picking (the editor): the cards' vertices all sit at their
 * centres, so pick against a plain ball of the same size instead.
 */
export function pickAsBall(mesh) {
  const proxy = new InstancedMesh(new IcosahedronGeometry(0.9, 1), pickMat, mesh.instanceMatrix.count);
  mesh.raycast = (raycaster, hits) => {
    proxy.instanceMatrix = mesh.instanceMatrix;
    proxy.count = mesh.count;
    proxy.matrixWorld.copy(mesh.matrixWorld);
    proxy.boundingSphere = null; // trees may have been moved (editor)
    const mine = [];
    proxy.raycast(raycaster, mine);
    for (const h of mine) hits.push({ ...h, object: mesh });
  };
}
