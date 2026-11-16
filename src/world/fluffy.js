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
  BufferGeometry, Float32BufferAttribute, CanvasTexture, DoubleSide, MeshLambertMaterial,
  MeshDepthMaterial, RGBADepthPacking, Sphere, Vector3, InstancedMesh, IcosahedronGeometry, MeshBasicMaterial,
  CatmullRomCurve3, TubeGeometry, ShaderChunk,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, noise3, crownShape, CROWN_SEEDS } from '../sim/treeShapes.js';
import { leafUniforms } from './trees.js';

/** Cards per clump for a detail level (2 full, 1, 0, 'blob' for far away). */
const CARDS = { 2: 16, 1: 10, 0: 6, blob: 4 };

/**
 * Leaves: about LEAF_M long on every tree and bush. A card's leaf picture
 * scales with the card, and cards with their tree, so the picture comes in
 * four versions, from big leaves to many small ones, and each card picks the
 * one that gives leaves of that size (CARD_VERTEX). And each species has its
 * own leaf shape: one row of the atlas each (LEAF_ROWS, src/world/species.js).
 */
const LEAF_M = 0.28;
/** The versions' leaf sizes, relative to the first (the atlas's columns). */
const LEAF_SIZES = [1, 0.7, 0.5, 0.35];
/** Leaf length in the first version, as a fraction of the card's width. */
const LEAF_FRAC = 0.1;
/** The atlas's rows: a leaf shape each (in the species' order, SPECIES_ORDER). */
export const LEAF_ROWS = ['oak', 'ash', 'beech', 'sycamore', 'horseChestnut', 'birch', 'hawthorn'];
/**
 * Each species' leaf: how big against the 22 cm average, how many more to
 * cover as much (open, compound leaves need more), and its outline, drawn
 * tip up from (0, -len) to the stalk at (0, len).
 */
const LEAF_FORMS = {
  // Lobed, wavy edged.
  oak: { size: 1, more: 1.15, draw: (g, len) => outline(g, len, (t) => 0.42 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.62 + 0.38 * Math.abs(Math.sin(t * Math.PI * 4.5)))) },
  // Rows of small pointed leaflets along a stalk.
  ash: { size: 1.25, more: 1.7, draw: (g, len) => {
    for (let k = 0; k < 4; k++) {
      const y = -len * 0.55 + k * len * 0.42;
      for (const sd of [-1, 1]) leaflet(g, sd * len * 0.2, y, len * 0.3, len * 0.09, sd * (Math.PI / 2 - 0.5));
    }
    leaflet(g, 0, -len * 0.8, len * 0.28, len * 0.09, 0);
    g.fillRect(-len * 0.02, -len * 0.7, len * 0.04, len * 1.6);
  } },
  // Plain oval.
  beech: { size: 0.9, more: 1, draw: (g, len) => outline(g, len, (t) => 0.36 * Math.pow(Math.sin(Math.PI * t), 0.75)) },
  // Five pointed lobes, like a maple's.
  sycamore: { size: 1.15, more: 1.1, draw: (g, len) => palmate(g, len, 5, 0.42, 1.1) },
  // A hand of five to seven broad leaflets.
  horseChestnut: { size: 1.5, more: 1.8, draw: (g, len) => {
    for (let k = 0; k < 7; k++) {
      const a = (k - 3) * 0.42;
      const l = len * (k === 3 ? 0.95 : 0.8 - Math.abs(k - 3) * 0.08);
      leaflet(g, Math.sin(a) * l * 0.5, len * 0.45 - Math.cos(a) * l * 0.5, l * 0.5, l * 0.17, a);
    }
  } },
  // Small, triangular, pointed.
  birch: { size: 0.7, more: 1, draw: (g, len) => outline(g, len, (t) => 0.4 * Math.min(1, t * 1.25) * Math.pow(1 - t, 0.35)) },
  // Small and deeply lobed.
  hawthorn: { size: 0.7, more: 1.25, draw: (g, len) => palmate(g, len, 3, 0.3, 0.85) },
};

/** A leaf from its half-width along it (t 0 at the tip, 1 at the stalk), x len. */
function outline(g, len, half) {
  const N = 20;
  g.beginPath();
  g.moveTo(0, -len);
  for (let i = 1; i <= N; i++) g.lineTo(half(i / N) * len * 2, -len + (2 * len * i) / N);
  for (let i = N - 1; i >= 1; i--) g.lineTo(-half(i / N) * len * 2, -len + (2 * len * i) / N);
  g.closePath();
  g.fill();
}

/** A small pointed oval at (x, y), half-length l, half-width w, turned by a. */
function leaflet(g, x, y, l, w, a) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(0, -l);
  g.quadraticCurveTo(w * 2, 0, 0, l);
  g.quadraticCurveTo(-w * 2, 0, 0, -l);
  g.fill();
  g.restore();
}

/** A palmate leaf: `n` pointed lobes fanned over the top, `deep` how far the gaps cut in. */
function palmate(g, len, n, deep, spread) {
  const N = 48;
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = (t - 0.5) * Math.PI * spread * 1.6; // fan, centred on straight up
    const lobe = Math.pow(Math.abs(Math.cos((t - 0.5) * Math.PI * n)), 3);
    const r = len * (1 - deep + deep * lobe);
    const x = Math.sin(a) * r;
    const y = len * 0.35 - Math.cos(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.lineTo(0, len);
  g.closePath();
  g.fill();
}

let leafTex = null;
let leafPx = 192;
/** Pixels per picture in the leaf atlas (set before the first leafy tree: smaller on phones). */
export function setLeafDetail(px) {
  if (!leafTex) leafPx = px;
}
/**
 * The leaf pictures: clusters of small leaves, white-ish (tinted per tree),
 * cut out round a ragged edge; a row per species, a column per leaf size.
 */
export function leafTexture() {
  if (leafTex) return leafTex;
  const T = leafPx;
  const cols = LEAF_SIZES.length;
  const rows = LEAF_ROWS.length;
  const c = document.createElement('canvas');
  c.width = T * cols;
  c.height = T * rows;
  const g = c.getContext('2d');
  const rnd = rng(77);
  LEAF_ROWS.forEach((name, row) => {
    const form = LEAF_FORMS[name];
    LEAF_SIZES.forEach((size, col) => {
      const ox = col * T;
      // (Canvas rows run downwards; texture rows upwards.)
      const oy = (rows - 1 - row) * T;
      const sz = size * form.size;
      // About the same cover whatever the leaf size: more, smaller ones.
      const count = Math.round((230 * form.more) / (sz * sz));
      g.save();
      g.beginPath();
      g.rect(ox, oy, T, T); // (leaves stay in their own picture)
      g.clip();
      // The leaves grow in sprigs: little bunches (the same few per picture
      // whatever the leaf size) with gaps between, so a crown of small
      // leaves still shows tufts, not an even fuzz.
      const sprigs = [[0, 0, 0.13 * T, 0]];
      const nSprig = 7;
      for (let k = 1; k < nSprig; k++) {
        const a = (k / (nSprig - 1)) * Math.PI * 2 + rnd() * 0.6;
        const r = T * (0.17 + rnd() * 0.09);
        sprigs.push([Math.cos(a) * r, Math.sin(a) * r, T * (0.1 + rnd() * 0.04), (rnd() - 0.5) * 30]);
      }
      for (let i = 0; i < count; i++) {
        const [sx, sy, sr, sk] = sprigs[Math.floor(rnd() * sprigs.length)];
        const a = rnd() * Math.PI * 2;
        // Within its sprig (a few strays reaching further).
        const d = rnd() < 0.05 ? sr * (1 + rnd() * 0.6) : sr * Math.sqrt(rnd());
        const x = ox + T / 2 + sx + Math.cos(a) * d;
        const y = oy + T / 2 + sy + Math.sin(a) * d;
        // Half the length (tip to stalk), varying a little.
        const len = (T * LEAF_FRAC * sz * (0.88 + rnd() * 0.24)) / 2;
        const k = Math.round(Math.min(255, 150 + (i / count) * 50 + rnd() * 55 + sk)); // (brightness, leaf to leaf and sprig to sprig)
        // Red: the leaf's brightness. Green: when it falls (it's gone once the
        // season's leaf fall passes this; see LEAF_FALL). Blue: its own tint,
        // from a little bluer-green (0) to a little yellower (255).
        g.fillStyle = `rgb(${k},${Math.round(5 + rnd() * 250)},${Math.round(rnd() * 255)})`;
        g.save();
        g.translate(x, y);
        // Leaves point roughly outwards from the middle of their sprig.
        g.rotate(a + Math.PI / 2 + (rnd() - 0.5) * 1.6);
        form.draw(g, len);
        g.restore();
      }
      g.restore();
    });
  });
  const t = new CanvasTexture(c);
  // (Not colour: brightness and fall time, read by LEAF_FRAGMENT, which
  // divides them by coverage: so they're stored multiplied by it, which
  // also keeps the smaller copies (mipmaps) right at the leaves' edges.)
  t.premultiplyAlpha = true;
  t.anisotropy = 4;
  leafTex = t;
  return t;
}

/** The atlas's grid (columns, rows), for the shaders. */
const LEAF_GRID = `vec2(${LEAF_SIZES.length}.0, ${LEAF_ROWS.length}.0)`;

/**
 * Which leaf picture (atlas cell, see leafTexture) a card of half-size h
 * metres shows: its species' row (aSpecies), and the column giving leaves of
 * about LEAF_M whatever the card's size.
 */
function leafCellGlsl() {
  // Leaf length = LEAF_FRAC x card width x version size = LEAF_FRAC 2h size.
  // Switch half way between the versions.
  const want = (size) => LEAF_M / (LEAF_FRAC * 2 * size); // h at which a version is just right
  const edges = [0, 1, 2].map((k) => Math.sqrt(want(LEAF_SIZES[k]) * want(LEAF_SIZES[k + 1])).toFixed(3));
  return `vLeafCell = vec2(h < ${edges[0]} ? 0.0 : h < ${edges[1]} ? 1.0 : h < ${edges[2]} ? 2.0 : 3.0, aSpecies);`;
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
      n.set(p.x - cx, p.y - cy, p.z - cz).normalize().multiplyScalar(0.35).add(out).add(new Vector3(0, 0.25, 0)).normalize();
      // Shade: darker deep inside and underneath, lighter on top.
      const inner = Math.min(1, p.length());
      // (Gently: neighbouring cards should blend, not stand out as patches.)
      const shade = (0.56 + 0.44 * inner) * (0.74 + 0.24 * (p.y * 0.5 + 0.5)) * (0.9 + 0.2 * noise3(p.x * 6, p.y * 6, p.z * 6 + seed));
      const size = r * sizeK * (0.85 + rnd() * 0.3);
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

const typical = {};
/** The average card half-size (unit crowns) at a detail level, to pick one leaf size per tree. */
export function typicalCard(detail = 2) {
  if (typical[detail] == null) {
    const a = fluffyCrown(CROWN_SEEDS[0], detail).attributes.aCard;
    let sum = 0;
    for (let i = 0; i < a.count; i++) sum += a.getX(i);
    typical[detail] = sum / a.count;
  }
  return typical[detail];
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
    parts.push(tube([start, mid, end], bush ? 0.011 : 0.014, 0.005, twigs ? 4 : 3, twigs ? 3 : 2));
    if (!twigs) continue;
    for (let k = 0; k < 3; k++) {
      const a = rnd() * Math.PI * 2;
      const up = 0.15 + rnd() * 1.0;
      const d = new Vector3(Math.cos(a) * Math.cos(up), Math.sin(up), Math.sin(a) * Math.cos(up)).add(end.clone().normalize().multiplyScalar(0.6)).normalize();
      const from2 = mid.clone().lerp(end, 0.5 + rnd() * 0.5);
      const tip = from2.clone().addScaledVector(d, r * (0.8 + rnd() * 0.5));
      const bend = from2.clone().lerp(tip, 0.5).add(new Vector3(0, r * 0.1, 0));
      parts.push(tube([from2, bend, tip], 0.0045, 0.0022, 3, 2));
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
// Leaf fall: how far through it this card is (0 in leaf, 1 bare), by its
// tree's own year (aBare, src/world/species.js) and the card (some lose their leaves sooner: aCard.y).
// Each leaf in the picture goes once this passes its own fall time, so the
// crown thins out leaf by leaf; a card with none left isn't drawn at all.
const LEAF_FALL = 'clamp(aBare * (1.0 + 0.8 * (1.0 - aCard.y)), 0.0, 1.0)';
const CARD_VERTEX = /* glsl */ `
  {
    vLeafDrop = ${LEAF_FALL};
    float grow = vLeafDrop < 0.995 ? 1.0 : 0.0;
    float an = aCard.z * 6.2831853;
    vec2 cr = mat2(cos(an), sin(an), -sin(an), cos(an)) * aCorner * aCard.x * grow;
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 off = camR * cr.x + camU * cr.y;
    // The tree's typical card half-size (m): one leaf size for all its cards.
    float h = uCardTypical;
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 is2 = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      // Sized by the crown's width, in the (possibly squashed) crown's space.
      float isc = sqrt((is2.x + is2.z) * 0.5);
      transformed += (transpose(im) * (off * isc)) / is2;
      h *= isc;
    #else
      transformed += off;
    #endif
    ${leafCellGlsl()}
    // Lighter up the crown, darker underneath: by height in the whole crown
    // (unit crown, its leaves about -0.6 to 0.7), so it runs smoothly across
    // the cards rather than shading each as a ball of its own.
    vCardUp = clamp((transformed.y + 0.6) / 1.3, 0.0, 1.0);
  }
`;
const CARD_DECLS = 'attribute vec2 aCorner;\nattribute vec3 aCard;\nattribute float aBare;\nattribute float aSpecies;\nuniform float uBare;\nuniform float uCardTypical;\nvarying float vCardUp;\nvarying float vLeafDrop;\nvarying vec2 vLeafCell;';
const CARD_FRAG_DECLS = 'varying float vLeafDrop;\nvarying vec2 vLeafCell;\nvarying float vCardUp;';

/**
 * Read the leaf picture (see leafTexture): its brightness (as colour) into
 * diffuseColor, and leave out the leaves fallen by now (vLeafDrop). Colours
 * are divided by coverage: the smaller copies of the picture (mipmaps) mix
 * leaf pixels with clear ones.
 */
export const LEAF_FRAGMENT = /* glsl */ `
  {
    vec4 tx = texture2D(map, (vMapUv + vLeafCell) / ${LEAF_GRID});
    float cov = max(tx.a, 0.01);
    float kk = pow(tx.r / cov, 2.2);
    diffuseColor.rgb *= vec3(kk, kk, kk * 0.83);
    // Each leaf's own tint: yellower or bluer-green.
    float tint = tx.b / cov - 0.5;
    diffuseColor.rgb *= vec3(1.0 + tint * 0.55, 1.0 + tint * 0.12, 1.0 - tint * 0.75) * (1.0 + tint * 0.12);
    // Shaded up the crown (vCardUp).
    diffuseColor.rgb *= mix(0.68, 1.15, vCardUp);
    diffuseColor.a *= tx.a;
    if (tx.g / cov <= vLeafDrop * 1.02) discard;
  }
`;

/**
 * Turn a leaf material (after addCloudShadows and addLeafShading) into the
 * leafy-card one: cut-out leaf texture, cards facing the camera.
 */
export function makeFluffy(material, { smooth = true, detail = 2 } = {}) {
  material.map = leafTexture();
  material.alphaTest = 0.5;
  // Soft cut-out edges with the screen's anti-aliasing (skipped on phones).
  material.alphaToCoverage = smooth;
  material.side = DoubleSide;
  // SPECIES: each tree's colour through the year is its instance colour
  // (src/world/species.js), not worked out here.
  material.defines = { ...(material.defines || {}), FLUFFY: '', SPECIES: '' };
  const prev = material.onBeforeCompile;
  const cardTypical = { value: typicalCard(detail) };
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.uniforms.uCardTypical = cardTypical;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERTEX}`);
    // Far away the texture's smaller copies (mipmaps) blur the leaves'
    // edges and the cards would fade away: keep them solid.
    // Shadows on the leaves at part strength: the scenery shadow map is
    // coarse (most of a metre a texel), fine on the ground but blocky with
    // straight edges where leaves shade leaves; softened, the crowns keep
    // their darker hollows without the blocks.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin.replace(
      'directionalLightShadow.shadowIntensity,', 'directionalLightShadow.shadowIntensity * LEAF_SHADOW,'));
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n#define LEAF_SHADOW 0.45\n${CARD_FRAG_DECLS}`).replace('#include <map_fragment>', `${LEAF_FRAGMENT}
      {
        vec2 tsz = vec2(textureSize(map, 0));
        vec2 ddx = dFdx(vMapUv * tsz / ${LEAF_GRID});
        vec2 ddy = dFdy(vMapUv * tsz / ${LEAF_GRID});
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
  const depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: leafTexture(), alphaTest: 0.5 });
  depthMats[detail] = depthMat;
  depthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.uniforms.uCardTypical = { value: typicalCard(detail) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERTEX}
        // The card that casts faces the sun, the one you see faces you: they
        // cross, and part of each card would sit in its own shadow. Pushed
        // back from the sun by more than its half-diagonal (1.41 x its
        // half-size), a card shades the leaves behind it (and the ground)
        // but never itself.
        {
          vec3 away = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          #ifdef USE_INSTANCING
            mat3 im2 = mat3(instanceMatrix);
            vec3 s2 = vec3(dot(im2[0], im2[0]), dot(im2[1], im2[1]), dot(im2[2], im2[2]));
            transformed += (transpose(im2) * (away * aCard.x * 1.5 * sqrt((s2.x + s2.z) * 0.5))) / s2;
          #else
            transformed += away * aCard.x * 1.5;
          #endif
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CARD_FRAG_DECLS}`)
      .replace('#include <map_fragment>', LEAF_FRAGMENT);
  };
  depthMat.customProgramCacheKey = () => `fluffyDepth${detail}`;
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

// --- Close-up wood -----------------------------------------------------------
// Trees near the camera (src/world/lod.js, the close tier) get detailed
// trunks and branches: rounder (more sides), smoothly lit, gently crooked,
// and branching once more into fine twigs, ending in twigs rather than
// sharp points. Further out the plainer ones above do.

/** A smooth, indexed tapering tube (normals kept round). */
function roundTube(points, r0, r1, radial, segs) {
  const curve = new CatmullRomCurve3(points);
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const pp = g.attributes.position;
  const v = new Vector3();
  const c = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pp, k).sub(c).multiplyScalar(r).add(c);
      pp.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.deleteAttribute('uv');
  return g;
}

/** Points from a to b, bowed by `bow` (upwards) and wandering by `crook`. */
function crooked(rnd, a, b, n, bow, crook) {
  const pts = [];
  const len = a.distanceTo(b);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    const w = Math.sin(Math.PI * t);
    p.y += bow * len * w;
    if (i > 0 && i < n) p.add(new Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.5, rnd() - 0.5).multiplyScalar(crook * len * w));
    pts.push(p);
  }
  return pts;
}

function barkShade(geo) {
  geo.computeBoundingSphere();
  const pp = geo.attributes.position;
  const col = new Float32Array(pp.count * 3);
  for (let i = 0; i < pp.count; i++) {
    // As crownBranches: lighter out towards the twigs, a little mottled.
    const k = (1.35 + 0.45 * Math.min(1, Math.hypot(pp.getX(i), pp.getZ(i)) * 1.2)) * (0.92 + 0.16 * noise3(pp.getX(i) * 40, pp.getY(i) * 40, pp.getZ(i) * 40));
    col.set([k, k * 1.08, k * 1.18], i * 3);
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/**
 * Detailed branches for a crown (unit crown space, as crownBranches): limbs
 * out to each clump, side branches along them, and fine twigs off those.
 */
export function detailedBranches(seed, { from } = {}) {
  const { clumps } = crownShape(seed);
  const rnd = rng(seed * 13 + 5);
  const bush = from != null;
  const parts = [];
  for (const [cx, cy, cz, r] of clumps.slice(0, -1)) {
    const start = new Vector3(0, bush ? from : -0.35 + rnd() * 0.4, 0);
    const end = new Vector3(cx, cy, cz).multiplyScalar(0.85 + rnd() * 0.1);
    if (end.y < start.y + 0.1) start.y = end.y - 0.1;
    const limb = crooked(rnd, start, end, 4, 0.12, 0.12);
    parts.push(roundTube(limb, bush ? 0.011 : 0.015, 0.0042, 7, 8));
    const curve = new CatmullRomCurve3(limb);
    // ... carrying on past the end as a twig, so no limb ends in a stub.
    const dir = curve.getTangentAt(1);
    const tipEnd = end.clone().addScaledVector(dir, r * 0.55).add(new Vector3(0, r * 0.1, 0));
    parts.push(roundTube(crooked(rnd, end, tipEnd, 2, 0.05, 0.2), 0.0042, 0.0009, 5, 4));
    // Side branches from along the limb, each with a few fine twigs.
    for (let k = 0; k < 3; k++) {
      const at = curve.getPointAt(0.45 + k * 0.18 + rnd() * 0.08);
      const a = rnd() * Math.PI * 2;
      const up = 0.15 + rnd() * 0.9;
      const d = new Vector3(Math.cos(a) * Math.cos(up), Math.sin(up), Math.sin(a) * Math.cos(up)).add(end.clone().normalize().multiplyScalar(0.7)).normalize();
      const tip = at.clone().addScaledVector(d, r * (0.7 + rnd() * 0.5));
      const side = crooked(rnd, at, tip, 3, 0.1, 0.2);
      parts.push(roundTube(side, 0.0048, 0.0018, 5, 5));
      const sc = new CatmullRomCurve3(side);
      for (let j = 0; j < 2; j++) {
        const at2 = sc.getPointAt(0.4 + j * 0.3 + rnd() * 0.1);
        const a2 = rnd() * Math.PI * 2;
        const d2 = d.clone().add(new Vector3(Math.cos(a2), 0.4 + rnd() * 0.6, Math.sin(a2)).multiplyScalar(0.9)).normalize();
        const tip2 = at2.clone().addScaledVector(d2, r * (0.25 + rnd() * 0.25));
        parts.push(roundTube(crooked(rnd, at2, tip2, 2, 0.08, 0.25), 0.0018, 0.0008, 4, 3));
      }
    }
  }
  const geo = mergeGeometries(parts);
  return barkShade(geo);
}
