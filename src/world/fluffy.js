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
export const LEAF_ROWS = ['oak', 'ash', 'beech', 'sycamore', 'horseChestnut', 'birch', 'hawthorn', 'scotsPine', 'spruce', 'leyland', 'larch', 'yew', 'cedar'];
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
  // Conifers' needles.
  // Scots pine: tufts of long paired needles.
  scotsPine: { size: 1.5, more: 1.3, draw: (g, len) => {
    for (let k = 0; k < 12; k++) needle(g, 0, len * 0.6, ((k / 11) - 0.5) * 2.2, len * 1.5, len * 0.07);
  } },
  // Spruce: bottlebrush twigs of short stiff needles.
  spruce: { size: 1.1, more: 1.1, draw: (g, len) => {
    g.fillRect(-len * 0.04, -len, len * 0.08, len * 2);
    for (let k = 0; k < 14; k++) {
      const y = -len * 0.9 + (k / 13) * len * 1.8;
      for (const sd of [-1, 1]) needle(g, 0, y, sd * 0.9, len * 0.38, len * 0.06);
    }
  } },
  // Leyland cypress: flat feathery fronds of tiny scale-leaves.
  leyland: { size: 1.1, more: 1.05, draw: (g, len) => {
    for (let k = -2; k <= 2; k++) {
      const a = k * 0.35;
      for (let j = 0; j < 6; j++) {
        const d = len * (0.15 + j * 0.17);
        leaflet(g, Math.sin(a) * d, len * 0.8 - Math.cos(a) * d, len * 0.13, len * 0.07, a);
      }
    }
  } },
  // Larch: soft rosettes of short needles.
  larch: { size: 0.7, more: 1.2, draw: (g, len) => {
    for (let k = 0; k < 16; k++) needle(g, 0, 0, (k / 16) * Math.PI * 2, len * 0.75, len * 0.07);
  } },
  // Cedar: dense little rosettes of short stiff needles.
  cedar: { size: 0.8, more: 1.3, draw: (g, len) => {
    for (let k = 0; k < 22; k++) needle(g, 0, 0, (k / 22) * Math.PI * 2 + 0.1, len * 0.55, len * 0.09);
  } },
  // Yew: flat sprays of short flat needles either side of a twig.
  yew: { size: 0.9, more: 1.05, draw: (g, len) => {
    g.fillRect(-len * 0.03, -len, len * 0.06, len * 2);
    for (let k = 0; k < 11; k++) {
      const y = -len * 0.85 + (k / 10) * len * 1.7;
      for (const sd of [-1, 1]) needle(g, 0, y, sd * 1.35, len * 0.42, len * 0.1);
    }
  } },
};

/** A needle from (x, y), pointing at angle a (0 up), l long, w wide. */
function needle(g, x, y, a, l, w) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(-w / 2, 0);
  g.lineTo(0, -l);
  g.lineTo(w / 2, 0);
  g.closePath();
  g.fill();
  g.restore();
}

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
let leafSpecies = null;
/** The leaf pictures needed (species' leaf names: species.js leafName): set before the first leafy tree. */
export function setLeafSpecies(names) {
  if (!leafTex) leafSpecies = new Set(names);
}
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
  LEAF_ROWS.forEach((name, row) => {
    // Only the species at this site (setLeafSpecies): the rest left blank.
    if (leafSpecies && !leafSpecies.has(name)) return;
    const rnd = rng(77 + row * 101); // (each its own: the same whichever are drawn)
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
        const k = Math.round(Math.min(255, 170 + (i / count) * 35 + rnd() * 30 + sk * 0.6)); // (brightness, leaf to leaf and sprig to sprig)
        // Red: the leaf's brightness. Green: when it falls (it's gone once the
        // season's leaf fall passes this; see LEAF_FALL). Blue: its own tint,
        // from a little bluer-green (0) to a little yellower (255).
        g.fillStyle = `rgb(${k},${Math.round(5 + rnd() * 250)},${Math.round(rnd() * 255)})`;
        // Leaves point roughly outwards from the middle of their sprig.
        const turn = a + Math.PI / 2 + (rnd() - 0.5) * 1.6;
        if (len < 3) {
          // Only a few pixels: a plain lozenge looks the same, far quicker.
          const ux = -Math.sin(turn) * len;
          const uy = Math.cos(turn) * len;
          const w = 0.4;
          g.beginPath();
          g.moveTo(x - ux, y - uy);
          g.lineTo(x - uy * w, y + ux * w);
          g.lineTo(x + ux, y + uy);
          g.lineTo(x + uy * w, y - ux * w);
          g.fill();
          continue;
        }
        g.save();
        g.translate(x, y);
        g.rotate(turn);
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
      n.set(p.x - cx, p.y - cy, p.z - cz).normalize().multiplyScalar(0.35).add(out).normalize();
      // Lit softly top to bottom: leaves let light through and catch it at
      // all angles, so their normals lean only a little up or down (else
      // the top faces the midday sun square on and the underside none of it).
      n.y = n.y * 0.35 + 0.2;
      n.normalize();
      // Shade: darker deep inside and underneath, lighter on top.
      const inner = Math.min(1, p.length());
      // (Gently: neighbouring cards should blend, not stand out as patches.)
      const shade = (0.66 + 0.34 * inner) * (0.86 + 0.12 * (p.y * 0.5 + 0.5)) * (0.9 + 0.2 * noise3(p.x * 6, p.y * 6, p.z * 6 + seed));
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
 * How a tree's wood grows, in its crown's own space (unit crown; clump radii
 * r): where its limbs leave the trunk, how they bow and wander, how many
 * side branches and twigs, at what angles and how long, drooping or turned
 * up. Each species has its own (src/world/species.js `wood`); this is an
 * average tree.
 */
export const DEFAULT_WOOD = {
  leader: false, // a single stem on up through the crown (birch, ash)
  start: [-0.35, 0.05], // where limbs leave the trunk (crown y)
  bow: 0.12, // limbs bowing upwards (x their length)
  crook: 0.12, // and wandering
  thick: 1, // limb thickness (x)
  sides: [1, 5], // side branches per limb
  sideLen: [0.7, 1.2], // their length (x r)
  sideUp: [0.15, 1.05], // their angle up from level (radians)
  sideCrook: 0.2,
  sideDroop: 0, // their tips sagging (x length)
  twigs: [0, 4], // twigs per side branch
  twigLen: [0.25, 0.5], // their length (x r)
  twigUp: [0.4, 1.0], // their angle up (radians)
  twigDroop: 0, // hanging (x length)
  twigThick: 1,
  twigDark: 0, // twigs darker than the trunk out towards the tips (birch: dark twigs on a white tree)
};

const between = (rnd, [a, b]) => a + rnd() * (b - a);
const intBetween = (rnd, [a, b]) => a + Math.floor(rnd() * (b - a + 1));

/** A direction at `up` radians above level, roughly away from `out` (horizontal). */
function heading(rnd, up, out, outK) {
  const a = rnd() * Math.PI * 2;
  const d = new Vector3(Math.cos(a) * Math.cos(up), Math.sin(up), Math.sin(a) * Math.cos(up));
  const o = new Vector3(out.x, 0, out.z);
  if (o.lengthSq() > 1e-6) d.addScaledVector(o.normalize(), outK);
  // (Keep the angle up after leaning it outwards.)
  const h = Math.hypot(d.x, d.z) || 1;
  return new Vector3((d.x / h) * Math.cos(up), Math.sin(up), (d.z / h) * Math.cos(up)).normalize();
}

/**
 * A crown's wood: limbs out to each leaf clump, side branches along them and
 * twigs off those, as the species grows them. `close`: detailed (round,
 * smooth, an extra level of fine twigs) for close up; else plain, for the
 * middle distance. `from`: where the stems start (a bush's at the ground).
 */
export function crownWood(seed, { from, wood = DEFAULT_WOOD, close = false, twigs = true } = {}) {
  const W = { ...DEFAULT_WOOD, ...wood };
  const { clumps, hi } = crownShape(seed);
  // Two sets of random choices: the skeleton (limbs and side branches),
  // made the same way plain or close up, so the two match and switching
  // between them doesn't rearrange the tree; and the close-up extras (bends,
  // fine twigs) apart from it.
  const rnd = rng(seed * 13 + 5);
  const rx = rng(seed * 29 + 11);
  const bush = from != null;
  const parts = [];
  const T = close ? roundTube : (pts, r0, r1, radial, segs) => tube(pts, r0, r1, Math.max(3, radial - 2), Math.max(2, segs - 2));
  const path = (a, b, n, bow, crookK) => (close ? crooked(rx, a, b, n, bow, crookK) : [a, a.clone().lerp(b, 0.5).add(new Vector3(0, bow * a.distanceTo(b), 0)), b]);
  // A leader: one stem on up through the crown.
  if (W.leader && !bush) {
    parts.push(T(path(new Vector3(0, -0.6, 0), new Vector3(0, hi * 0.95, 0), 5, 0, 0.03), 0.02 * W.thick, 0.003, 7, 8));
  }
  for (const [cx, cy, cz, r] of clumps.slice(0, -1)) {
    const end = new Vector3(cx, cy, cz).multiplyScalar(0.85 + rnd() * 0.1);
    let y0 = bush ? from : between(rnd, W.start);
    if (W.leader && !bush) y0 = Math.min(y0, end.y - 0.05); // off the leader, below its clump
    if (end.y < y0 + 0.1 && !W.leader) y0 = end.y - 0.1; // low limbs leave the trunk lower
    const start = new Vector3(0, y0, 0);
    const limb = path(start, end, 4, W.bow, W.crook);
    const lr0 = (bush ? 0.011 : W.leader ? 0.009 : 0.015) * W.thick;
    parts.push(T(limb, lr0, 0.0042 * Math.sqrt(W.thick), 7, 8));
    const curve = new CatmullRomCurve3(limb);
    if (close) {
      // ... carrying on past the end as a twig, so no limb ends in a stub.
      const dir = curve.getTangentAt(1);
      const tipEnd = end.clone().addScaledVector(dir, r * 0.55).add(new Vector3(0, r * (0.1 - W.twigDroop * 0.3), 0));
      parts.push(T(crooked(rx, end, tipEnd, 2, 0.05, 0.2), 0.0042 * Math.sqrt(W.thick), 0.0009, 5, 4));
    }
    if (!twigs) continue;
    // Side branches along the limb (the same plain or close up), and close
    // up their twigs.
    const nSide = intBetween(rnd, W.sides);
    for (let k = 0; k < nSide; k++) {
      const at = curve.getPointAt(Math.min(0.97, 0.3 + ((k + rnd() * 0.8) / nSide) * 0.65));
      const d = heading(rnd, between(rnd, W.sideUp), end, 0.8);
      const len = r * between(rnd, W.sideLen);
      const tip = at.clone().addScaledVector(d, len);
      tip.y -= W.sideDroop * len;
      const side = path(at, tip, 3, 0.08 + W.sideDroop * 0.25, W.sideCrook);
      parts.push(T(side, 0.0048, 0.0018, 5, 5));
      if (!close) continue;
      const sc = new CatmullRomCurve3(side);
      const nTwig = intBetween(rx, W.twigs);
      for (let j = 0; j < nTwig; j++) {
        const at2 = sc.getPointAt(Math.min(0.95, 0.3 + ((j + rx() * 0.8) / Math.max(1, nTwig)) * 0.6));
        const d2 = heading(rx, between(rx, W.twigUp), d, 0.9);
        const l2 = r * between(rx, W.twigLen);
        const tip2 = at2.clone().addScaledVector(d2, l2);
        tip2.y -= W.twigDroop * l2;
        parts.push(T(crooked(rx, at2, tip2, 2, 0.06 + W.twigDroop * 0.3, 0.25), 0.0018 * W.twigThick, 0.0008 * W.twigThick, 4, 3));
      }
    }
  }
  const geo = mergeGeometries(close ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  if (!close) geo.computeVertexNormals();
  return barkShade(geo, W.twigDark);
}

/** The plain bare branches (middle distance): see crownWood. */
export function crownBranches(seed, opts = {}) {
  return crownWood(seed, { ...opts, close: false });
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
    if (uFacePos > 0.5) {
      // Facing the camera's position, kept upright: turning, pitching or
      // rolling the camera changes nothing (as with real leaves); only moving
      // past turns them, smoothly. (Facing the screen, every card swings
      // round as the view turns, swapping which is in front and where its
      // shadows fall: popping.)
      #ifdef USE_INSTANCING
        vec3 cw = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
      #else
        vec3 cw = (modelMatrix * vec4(position, 1.0)).xyz;
      #endif
      vec3 toCam = normalize(cameraPosition - cw);
      vec3 r = cross(vec3(0.0, 1.0, 0.0), toCam);
      camR = dot(r, r) < 1e-6 ? camR : normalize(r);
      camU = cross(toCam, camR);
    }
    vec3 off = camR * cr.x + camU * cr.y;
    // The tree's typical card half-size (m): one leaf size for all its cards.
    float h = uCardTypical;
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 is2 = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      // Sized by the crown's width, in the (possibly squashed) crown's space.
      float isc = sqrt((is2.x + is2.z) * 0.5);
      h *= isc;
    #endif
    if (dot(aFlat, aFlat) > 1e-6) {
      // A flat spray (conifer boughs): lying along its bough (aFlat, in the
      // crown's space), not turned to the camera.
      vec3 along = normalize(aFlat);
      vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), along) + vec3(1e-4, 0.0, 0.0));
      vec2 cf = aCorner * aCard.x * grow;
      transformed += along * cf.y * 1.2 + across * cf.x * 0.85;
    } else {
      #ifdef USE_INSTANCING
        transformed += (transpose(im) * (off * isc)) / is2;
      #else
        transformed += off;
      #endif
    }
    ${leafCellGlsl()}
    // Lighter up the crown, darker underneath: by height in the whole crown
    // (unit crown, its leaves about -0.6 to 0.7), so it runs smoothly across
    // the cards rather than shading each as a ball of its own.
    vCardUp = clamp((transformed.y + 0.6) / 1.3, 0.0, 1.0);
    // For soft depth (makeFluffy): where on the card, and its half-size (m).
    vCardXY = aCorner;
    vCardR = h / max(uCardTypical, 1e-4) * aCard.x * grow;
    // Fading out as it nears the camera: a card faces the camera, all of it
    // at one depth, so at the near clipping plane it would vanish whole in
    // one frame. Gone (dithered away) before then, over the last few metres
    // plus its own size.
    {
      #ifdef USE_INSTANCING
        vec4 cv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      #else
        vec4 cv = viewMatrix * modelMatrix * vec4(position, 1.0);
      #endif
      vNearFade = smoothstep(0.6, 2.5 + vCardR * 1.4, -cv.z);
    }
  }
`;
/** Leaf cards facing the camera's position (1, upright) or its screen (0, the old way). */
export const cardUniforms = { uFacePos: { value: 1 } };
const CARD_DECLS = 'attribute vec2 aCorner;\nattribute vec3 aCard;\nattribute vec3 aFlat;\nattribute float aBare;\nattribute float aSpecies;\nuniform float uBare;\nuniform float uCardTypical;\nuniform float uFacePos;\nvarying float vNearFade;\nvarying float vCardUp;\nvarying vec2 vCardXY;\nvarying float vCardR;\nvarying float vLeafDrop;\nvarying vec2 vLeafCell;';
const CARD_FRAG_DECLS = 'varying float vNearFade;\nvarying float vLeafDrop;\nvarying vec2 vLeafCell;\nvarying float vCardUp;\nvarying vec2 vCardXY;\nvarying float vCardR;';

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
    diffuseColor.rgb *= vec3(1.0 + tint * 0.25, 1.0 + tint * 0.05, 1.0 - tint * 0.35) * (1.0 + tint * 0.06);
    // Shaded up the crown (vCardUp).
    diffuseColor.rgb *= mix(0.86, 1.06, vCardUp);
    diffuseColor.a *= tx.a;
    if (tx.g / cov <= vLeafDrop * 1.02) discard;
    // (Near the camera: thinning away, leaf by leaf, by the leaf's own fall
    // time as a scatter, so it fades rather than pops.)
    if (vNearFade < 0.999 && fract(tx.g / cov * 7.31 + tx.b / cov * 3.7) >= vNearFade) discard;
  }
`;

/**
 * Turn a leaf material (after addCloudShadows and addLeafShading) into the
 * leafy-card one: cut-out leaf texture, cards facing the camera.
 */
export function makeFluffy(material, { smooth = true, detail = 2, softDepth = false } = {}) {
  material.map = leafTexture();
  material.alphaTest = 0.5;
  // Soft cut-out edges with the screen's anti-aliasing (skipped on phones).
  material.alphaToCoverage = smooth;
  material.side = DoubleSide;
  // SPECIES: each tree's colour through the year is its instance colour
  // (src/world/species.js), not worked out here.
  material.defines = { ...(material.defines || {}), FLUFFY: '', SPECIES: '', CLOUD_PER_VERTEX: '' };
  // Soft depth: each card is a gentle dome in depth (its middle nearer the
  // camera than its edges), so where cards overlap the boundary is a curve
  // that slides as you move, not the whole overlap flipping from one card
  // to the other as the view turns. Costs the GPU its early depth test on
  // leaves (fine on desktops; off on Low).
  if (softDepth) material.defines.SOFT_DEPTH = '';
  const prev = material.onBeforeCompile;
  const cardTypical = { value: typicalCard(detail) };
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.uniforms.uCardTypical = cardTypical;
    shader.uniforms.uFacePos = cardUniforms.uFacePos;
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
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      #ifdef SOFT_DEPTH
      {
        float rr = dot(vCardXY, vCardXY) * 0.5; // 0 in the middle, 1 at the corners
        vec3 vp = -vViewPosition;
        vp.z += vCardR * 0.7 * sqrt(max(0.0, 1.0 - rr)); // (nearer the camera)
        vec4 cp = projectionMatrix * vec4(vp, 1.0);
        gl_FragDepth = (cp.z / cp.w) * 0.5 + 0.5;
      }
      #endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n#define LEAF_SHADOW 0.45\nuniform mat4 projectionMatrix;\n${CARD_FRAG_DECLS}`).replace('#include <map_fragment>', `${LEAF_FRAGMENT}
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
    shader.uniforms.uFacePos = cardUniforms.uFacePos;
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

function barkShade(geo, twigDark = 0) {
  geo.computeBoundingSphere();
  const pp = geo.attributes.position;
  const col = new Float32Array(pp.count * 3);
  for (let i = 0; i < pp.count; i++) {
    // As crownBranches: lighter out towards the twigs, a little mottled.
    const out = Math.min(1, Math.hypot(pp.getX(i), pp.getZ(i)) * 1.2);
    let k = (1.35 + 0.45 * out) * (0.92 + 0.16 * noise3(pp.getX(i) * 40, pp.getY(i) * 40, pp.getZ(i) * 40));
    if (twigDark) k *= 1 - twigDark * 0.8 * out; // (birch: dark twigs)
    col.set([k, k * 1.08, k * 1.18], i * 3);
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/** Detailed branches for a crown (close up): see crownWood. */
export function detailedBranches(seed, opts = {}) {
  return crownWood(seed, { ...opts, close: true });
}

// --- Conifers ----------------------------------------------------------------
// Conifer crowns of needle cards, as the broadleaf ones (fluffyCrown) but
// shaped by species (src/world/species.js CONIFER): tiers of boughs (spruce,
// larch, pine), or a dense mass (Leyland cypress, yew). Unit space: the
// crown from y -0.5 (its base) to 0.5 (the top), radius 1 at its widest
// (drawn with the tree's crown radius and height: src/world/world.js).

/** A card's data, pushed onto the arrays (as fluffyCrown's cards). */
function cardPusher() {
  const a = { pos: [], nrm: [], col: [], uv: [], corner: [], card: [], flat: [], index: [] };
  a.push = (p, n, shade, size, when, spin, flat = null) => {
    const base = a.pos.length / 3;
    for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      a.pos.push(p.x, p.y, p.z);
      a.nrm.push(n.x, n.y, n.z);
      a.col.push(shade, shade * 1.02, shade * 0.9);
      a.uv.push(ax * 0.5 + 0.5, ay * 0.5 + 0.5);
      a.corner.push(ax, ay);
      a.card.push(size, when, spin);
      a.flat.push(flat?.x ?? 0, flat?.y ?? 0, flat?.z ?? 0);
    }
    a.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  a.geometry = (radius = 1.35) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(a.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(a.nrm, 3));
    geo.setAttribute('color', new Float32BufferAttribute(a.col, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(a.uv, 2));
    geo.setAttribute('aCorner', new Float32BufferAttribute(a.corner, 2));
    geo.setAttribute('aCard', new Float32BufferAttribute(a.card, 3));
    geo.setAttribute('aFlat', new Float32BufferAttribute(a.flat, 3));
    geo.setIndex(a.index);
    geo.boundingSphere = new Sphere(new Vector3(), radius);
    return geo;
  };
  return a;
}

/**
 * A conifer's crown of needle cards (unit space, see above).
 * @param {object} c  its shape (species.js CONIFER)
 */
export function fluffyConifer(c, seed, detail = 2) {
  const rnd = rng(seed);
  const A = cardPusher();
  const q = { 2: 1, 1: 0.7, 0: 0.5, blob: 0.35 }[detail] ?? 1;
  const sizeK = 1 / Math.sqrt(q);
  const p = new Vector3();
  const n = new Vector3();
  const card = (x, y, z, size, flat = null) => {
    p.set(x, y, z);
    const yn = y + 0.5;
    const out = Math.min(1, Math.hypot(x, z) / Math.max(0.05, c.profile(yn) * c.width));
    // Lit as the crown: out from its axis, and up.
    n.set(x, 0, z).normalize().multiplyScalar(0.8).add(new Vector3(0, 0.2, 0)).normalize();
    const shade = (0.62 + 0.38 * out) * (0.86 + 0.14 * yn) * (0.9 + 0.2 * noise3(x * 5, y * 5, z * 5 + seed));
    A.push(p, n, shade, size * sizeK * (0.85 + rnd() * 0.3), Math.min(0.999, rnd() * 0.85 + out * 0.15), rnd(), flat);
  };
  if (c.tiers) {
    // Tiers of boughs, a whorl at each, sprays of needles along them (more
    // out towards their tips), drooping or lifting.
    for (let i = 0; i < c.tiers; i++) {
      const yn = (i + 0.4 + rnd() * 0.2) / c.tiers;
      const R = c.profile(yn) * c.width;
      const nb = 5 + Math.floor(rnd() * 3);
      const turn = rnd() * Math.PI * 2;
      for (let b = 0; b < nb; b++) {
        const a = turn + (b / nb) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
        const len = R * (0.75 + rnd() * 0.3);
        const nCards = Math.max(2, Math.round((3 + len * 9) * q * (1 - c.open * 0.4)));
        for (let k = 0; k < nCards; k++) {
          const t = 0.3 + 0.7 * Math.sqrt((k + rnd()) / nCards);
          const d = len * t;
          const y = yn - 0.5 + c.up * d * 0.25 - c.droop * d * d * 0.5 + (rnd() - 0.5) * 0.05;
          const sp = (rnd() - 0.5) * 0.35 * (1 - c.open * 0.5);
          // Mostly flat sprays along the bough (sloping as it droops), some
          // turned to the camera for body.
          const slope = c.up * 0.25 - c.droop * d;
          const flat = rnd() < 0.7 ? new Vector3(Math.cos(a + sp), slope, Math.sin(a + sp)) : null;
          card(Math.cos(a + sp) * d, y, Math.sin(a + sp) * d, (0.11 + 0.06 * t + (1 - yn) * 0.03) * (flat ? 1.3 : 1), flat);
        }
      }
    }
    // The top: a spire of sprays.
    for (let k = 0; k < Math.round(6 * q); k++) card((rnd() - 0.5) * 0.08, 0.38 + rnd() * 0.12, (rnd() - 0.5) * 0.08, 0.08);
  } else {
    // A dense mass of sprays near its surface (in clumps, for a yew).
    const nCards = Math.round(260 * q * (c.cards ?? 1));
    const clumps = Array.from({ length: 9 }, () => [rnd() * Math.PI * 2, rnd()]);
    for (let k = 0; k < nCards; k++) {
      let a = rnd() * Math.PI * 2;
      let yn = Math.pow(rnd(), 0.9);
      if (rnd() < c.clumpy) {
        const [ca, cy] = clumps[Math.floor(rnd() * clumps.length)];
        a = ca + (rnd() - 0.5) * 0.7;
        yn = Math.min(1, Math.max(0, cy + (rnd() - 0.5) * 0.25));
      }
      // Filled right through (thickest towards the outside).
      const R = c.profile(yn) * c.width * (0.25 + 0.75 * Math.pow(rnd(), c.fill ?? 0.4));
      card(Math.cos(a) * R, yn - 0.5, Math.sin(a) * R, 0.15 * (c.size ?? 1));
    }
  }
  return A.geometry(Math.max(1.35, c.width * 1.3));
}

/**
 * A conifer's wood (unit crown space, as fluffyConifer): the trunk on up
 * through the crown, and its boughs (plain, or detailed close up), which
 * show where the needles are thin (pine, larch in winter).
 */
export function coniferWood(c, seed, { close = false, wood = {} } = {}) {
  const rnd = rng(seed * 3 + 1);
  const parts = [];
  const T = close ? roundTube : (pts, r0, r1, radial, segs) => tube(pts, r0, r1, Math.max(3, radial - 3), Math.max(2, segs - 2));
  const th = wood.thick ?? 1;
  parts.push(T([new Vector3(0, -0.55, 0), new Vector3(0, 0, 0), new Vector3(0, 0.48, 0)], 0.045 * th, 0.004, 8, 6));
  const tiers = c.tiers || 6;
  for (let i = 0; i < tiers; i++) {
    const yn = (i + 0.5) / tiers;
    const R = c.profile(yn) * c.width;
    const nb = c.tiers ? 4 + Math.floor(rnd() * 3) : 3;
    const turn = rnd() * Math.PI * 2;
    for (let b = 0; b < nb; b++) {
      const a = turn + (b / nb) * Math.PI * 2;
      const len = R * (0.7 + rnd() * 0.25) * (c.tiers ? 1 : 0.6);
      const pts = [0, 0.5, 1].map((t) => {
        const d = len * t;
        return new Vector3(Math.cos(a) * d, yn - 0.5 + c.up * d * 0.25 - c.droop * d * d * 0.5, Math.sin(a) * d);
      });
      parts.push(T(pts, 0.012 * th * (1 - yn * 0.5), 0.002, 5, 4));
    }
  }
  const geo = mergeGeometries(close ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  if (!close) geo.computeVertexNormals();
  return barkShade(geo);
}
