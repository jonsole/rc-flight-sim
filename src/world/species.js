// Tree species and their year, for the leafy trees (src/world/fluffy.js):
// each broadleaf tree is one of a mix of common English trees, each with its
// own summer green, autumn colour and timing, so a wood turns through the
// year rather than all at once.
//
// The year (an average English tree; see src/world/seasons.js):
//   leaves come out from early April, full by mid May      (out: days later)
//   new leaves: pale lime green for a few weeks, deepening
//   to a strong green by June, a little darker and duller
//   in late summer
//   autumn colour from late September through October      (turn: days later)
//   leaves fall mid October to mid December                (also by turn)
//
// Horse chestnut leafs early and browns early (from August: leaf miner);
// oak and ash leaf late, oak holds its leaves into November.
import { Color, SRGBColorSpace } from 'three';

// Colours as [hue 0-1, saturation, lightness] (sRGB). Autumn: the turning
// colour, and the dead-leaf brown it ends as before falling.
// The wood: bark colour, trunk thickness (x the usual), and the branches'
// spread (x the usual, out from the trunk) and bend (+ tips turned up,
// - hanging down; crown widths, at the tips).
export const SPECIES = {
  oak: { bark: [0.08, 0.12, 0.22], thick: 1.35, spread: 1.15, bend: -0.06, out: 14, turn: 16, summer: [0.27, 0.62, 0.22], autumn: [0.1, 0.62, 0.3], dead: [0.075, 0.5, 0.22] },
  ash: { bark: [0.1, 0.05, 0.38], thick: 0.95, spread: 0.92, bend: 0.14, out: 20, turn: -4, summer: [0.24, 0.55, 0.3], autumn: [0.17, 0.6, 0.38], dead: [0.12, 0.4, 0.3] },
  beech: { bark: [0.09, 0.04, 0.46], thick: 1.1, spread: 1.0, bend: 0.1, out: 2, turn: 8, summer: [0.26, 0.66, 0.26], autumn: [0.075, 0.75, 0.34], dead: [0.065, 0.6, 0.25] },
  sycamore: { bark: [0.07, 0.1, 0.32], thick: 1.05, spread: 1.0, bend: 0.05, out: -6, turn: 0, summer: [0.28, 0.6, 0.22], autumn: [0.12, 0.7, 0.38], dead: [0.09, 0.45, 0.25] },
  horseChestnut: { bark: [0.06, 0.18, 0.26], thick: 1.2, spread: 1.05, bend: 0.2, out: -14, turn: -28, summer: [0.29, 0.6, 0.2], autumn: [0.065, 0.62, 0.3], dead: [0.06, 0.5, 0.2] },
  birch: { bark: [0.1, 0.05, 0.8], thick: 0.68, spread: 0.85, bend: -0.3, out: -10, turn: -10, summer: [0.24, 0.58, 0.3], autumn: [0.13, 0.8, 0.44], dead: [0.11, 0.55, 0.32] },
  // Conifers (evergreen: no leaf fall, a little paler new growth in late
  // spring), and larch, which turns gold and drops its needles.
  scotsPine: { conifer: true, evergreen: true, bark: [0.06, 0.45, 0.32], thick: 1.1, out: 20, turn: 0, summer: [0.36, 0.35, 0.22], autumn: [0.36, 0.35, 0.22], dead: [0.36, 0.35, 0.22] },
  spruce: { conifer: true, evergreen: true, bark: [0.07, 0.2, 0.22], thick: 1, out: 25, turn: 0, summer: [0.33, 0.5, 0.15], autumn: [0.33, 0.5, 0.15], dead: [0.33, 0.5, 0.15] },
  leyland: { conifer: true, evergreen: true, bark: [0.05, 0.3, 0.22], thick: 0.9, out: 15, turn: 0, summer: [0.27, 0.55, 0.22], autumn: [0.27, 0.55, 0.22], dead: [0.27, 0.55, 0.22] },
  larch: { conifer: true, bark: [0.04, 0.25, 0.28], thick: 0.9, out: -8, turn: 22, summer: [0.25, 0.55, 0.3], autumn: [0.12, 0.85, 0.45], dead: [0.09, 0.6, 0.32] },
  corsicanPine: { conifer: true, evergreen: true, leaf: 'scotsPine', bark: [0.06, 0.14, 0.24], thick: 1.15, out: 22, turn: 0, summer: [0.33, 0.38, 0.18], autumn: [0.33, 0.38, 0.18], dead: [0.33, 0.38, 0.18] },
  stonePine: { conifer: true, evergreen: true, leaf: 'scotsPine', bark: [0.05, 0.35, 0.3], thick: 1.2, out: 22, turn: 0, summer: [0.3, 0.45, 0.22], autumn: [0.3, 0.45, 0.22], dead: [0.3, 0.45, 0.22] },
  cedar: { conifer: true, evergreen: true, bark: [0.05, 0.1, 0.22], thick: 1.4, out: 20, turn: 0, summer: [0.42, 0.24, 0.26], autumn: [0.42, 0.24, 0.26], dead: [0.42, 0.24, 0.26] },
  douglasFir: { conifer: true, evergreen: true, leaf: 'spruce', bark: [0.05, 0.3, 0.2], thick: 1.1, out: 20, turn: 0, summer: [0.31, 0.5, 0.18], autumn: [0.31, 0.5, 0.18], dead: [0.31, 0.5, 0.18] },
  lawson: { conifer: true, evergreen: true, leaf: 'leyland', bark: [0.05, 0.3, 0.25], thick: 0.9, out: 15, turn: 0, summer: [0.4, 0.33, 0.22], autumn: [0.4, 0.33, 0.22], dead: [0.4, 0.33, 0.22] },
  yew: { conifer: true, evergreen: true, bark: [0.03, 0.4, 0.3], thick: 1.3, out: 25, turn: 0, summer: [0.32, 0.55, 0.12], autumn: [0.32, 0.55, 0.12], dead: [0.32, 0.55, 0.12] },
  // Bushes and hedges: hawthorn, early out, rusty red-brown in autumn.
  hawthorn: { bark: [0.06, 0.25, 0.22], thick: 1, spread: 1, bend: 0, out: -14, turn: -4, summer: [0.28, 0.58, 0.22], autumn: [0.035, 0.6, 0.28], dead: [0.05, 0.45, 0.2] },
};

/**
 * How each species' wood grows (src/world/fluffy.js crownWood: the limbs,
 * side branches and twigs, in the crown) and its trunk (src/world/trees.js
 * trunk: where it forks and how its main limbs leave it). Unset: average.
 */
export const WOOD = {
  // Oak: short thick trunk forking low into long, gnarled, near-level limbs;
  // short zig-zag twigs.
  oak: {
    crown: { start: [-0.55, -0.2], bow: 0.02, crook: 0.3, thick: 1.35, sides: [2, 5], sideLen: [0.6, 1.0], sideUp: [-0.1, 0.35], sideCrook: 0.4, twigs: [2, 5], twigLen: [0.15, 0.3], twigUp: [0.0, 0.6] },
    trunk: { top: 0.38, limbs: [3, 4], y0: [0.24, 0.36], up: [0.2, 0.55], len: [0.22, 0.34], limbR: 1.25 },
  },
  // Silver birch: a slender leader to the top, many short limbs angled up
  // then drooping, long fine hanging twigs.
  birch: {
    crown: { leader: true, start: [-0.45, 0.55], bow: 0.05, crook: 0.05, thick: 0.55, sides: [3, 6], sideLen: [0.6, 1.1], sideUp: [0.35, 0.75], sideDroop: 0.35, sideCrook: 0.08, twigs: [3, 6], twigLen: [0.4, 0.7], twigUp: [-0.3, 0.2], twigDroop: 0.6, twigThick: 0.6, twigDark: 0.9 },
    trunk: { top: 0.85, limbs: [6, 8], y0: [0.35, 0.75], up: [0.6, 0.95], len: [0.07, 0.13], limbR: 0.6 },
  },
  // Ash: tall and straight, few steeply rising limbs, stout upturned twigs.
  ash: {
    crown: { leader: true, start: [-0.4, 0.3], bow: 0.2, crook: 0.08, sides: [1, 3], sideLen: [0.6, 0.9], sideUp: [0.8, 1.2], twigs: [0, 2], twigLen: [0.12, 0.22], twigUp: [0.8, 1.3], twigThick: 1.5 },
    trunk: { top: 0.75, limbs: [4, 5], y0: [0.4, 0.62], up: [0.8, 1.1], len: [0.12, 0.2] },
  },
  // Beech: limbs fanning up at about 45 degrees, fine twigs in flat sprays.
  beech: {
    crown: { start: [-0.4, 0.0], bow: 0.15, crook: 0.06, sides: [3, 5], sideUp: [0.3, 0.7], sideCrook: 0.1, twigs: [3, 5], twigLen: [0.2, 0.35], twigUp: [0.0, 0.3], twigThick: 0.8 },
    trunk: { top: 0.5, limbs: [5, 6], y0: [0.3, 0.45], up: [0.6, 0.9], len: [0.17, 0.25] },
  },
  // Horse chestnut: sturdy, rising limbs, twigs sweeping up at the tips.
  horseChestnut: {
    crown: { start: [-0.4, 0.0], bow: 0.1, crook: 0.1, thick: 1.15, sides: [2, 4], sideUp: [0.1, 0.5], sideDroop: 0.2, twigs: [1, 3], twigLen: [0.2, 0.35], twigUp: [0.9, 1.3], twigThick: 1.3 },
    trunk: { top: 0.5, limbs: [4, 6], y0: [0.3, 0.45], up: [0.5, 0.8], len: [0.18, 0.26], limbR: 1.1 },
  },
  // Sycamore: sturdy, dense rising limbs, many short twigs.
  sycamore: {
    crown: { start: [-0.35, 0.05], bow: 0.16, crook: 0.1, sides: [3, 6], sideUp: [0.5, 1.0], twigs: [2, 5], twigLen: [0.18, 0.3], twigUp: [0.4, 0.9] },
    trunk: { top: 0.55, limbs: [5, 7], y0: [0.32, 0.48], up: [0.6, 1.0], len: [0.15, 0.24] },
  },
  // Hawthorn (bushes and hedges): zig-zag stems, short twigs.
  hawthorn: {
    crown: { crook: 0.3, sides: [2, 5], sideCrook: 0.35, twigs: [2, 5], twigLen: [0.15, 0.25] },
  },
};

/**
 * Conifer shapes (src/world/fluffy.js fluffyConifer): `base` where the
 * crown starts (fraction of the height: a Scots pine's trunk is bare to
 * half way), `profile` its radius up the crown (0 bottom to 1 top), `tiers`
 * of boughs (0: none, a dense mass), how they `droop`, `open` (gaps between
 * the tiers' sprays), and the boughs' `up` angle (radians, + up); `crownW`
 * its crown's radius (x height), `cards` and `size` more and bigger sprays.
 */
export const CONIFER = {
  scotsPine: { base: 0.5, crownW: 0.27, width: 1, profile: (y) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + y)), 0.5) * (1 - 0.3 * y), tiers: 0, droop: 0, open: 0.3, up: 0.3, clumpy: 0.75, cards: 1.1, size: 1.25 },
  spruce: { base: 0.06, crownW: 0.22, width: 1, profile: (y) => Math.pow(1 - y, 1.05), tiers: 11, droop: 0.22, open: 0.2, up: -0.05, clumpy: 0.1 },
  leyland: { base: 0.06, crownW: 0.19, width: 1, profile: (y) => Math.pow(1 - y, 0.6) * (0.85 + 0.15 * Math.sin(Math.PI * y)), tiers: 0, droop: 0, open: 0, up: 0.6, clumpy: 0.15, cards: 2.4, size: 1.3 },
  larch: { base: 0.12, crownW: 0.2, width: 1, profile: (y) => Math.pow(1 - y, 1.1), tiers: 9, droop: 0.3, open: 0.4, up: 0.1, clumpy: 0.15 },
  // Corsican pine: straighter, darker, a narrower crown high up.
  corsicanPine: { base: 0.42, crownW: 0.2, width: 1, profile: (y) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + y * 0.95)), 0.55) * (1 - 0.45 * y), tiers: 0, droop: 0, open: 0.3, up: 0.35, clumpy: 0.65, cards: 1.1, size: 1.2 },
  // Stone pine: a flat umbrella on a bare trunk.
  stonePine: { base: 0.62, crownW: 0.45, width: 1, profile: (y) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.2 + y * 0.8)), 0.3) * (1 - 0.15 * y), tiers: 0, droop: 0, open: 0.2, up: 0.5, clumpy: 0.6, cards: 1.6, size: 1.25 },
  // Cedar of Lebanon: very broad, flat, level layers.
  cedar: { base: 0.18, crownW: 0.45, width: 1, profile: (y) => Math.pow(1 - y, 0.55), tiers: 6, droop: -0.04, open: 0.55, up: 0.0, clumpy: 0.1, cards: 1.4 },
  // Douglas fir: a tall soft cone of drooping tiers.
  douglasFir: { base: 0.08, crownW: 0.2, width: 1, profile: (y) => Math.pow(1 - y, 1.0), tiers: 12, droop: 0.14, open: 0.25, up: 0.02, clumpy: 0.1 },
  // Lawson cypress: a dense narrow cone.
  lawson: { base: 0.04, crownW: 0.16, width: 1, profile: (y) => Math.pow(1 - y, 0.85), tiers: 0, droop: 0, open: 0, up: 0.6, clumpy: 0.1, cards: 2.3, size: 1.25 },
  yew: { base: 0.1, crownW: 0.36, width: 1, profile: (y) => Math.pow(Math.sin(Math.PI * (0.1 + 0.75 * y)), 0.8) * (1 - 0.35 * y), tiers: 0, droop: 0, open: 0.05, up: 0.4, clumpy: 0.25, cards: 3, size: 1.25, fill: 0.7 },
};
/** The conifers at an English site, by how common they are. */
const CONIFER_MIX = [['leyland', 22], ['spruce', 15], ['scotsPine', 15], ['corsicanPine', 10], ['larch', 9], ['douglasFir', 8], ['lawson', 8], ['yew', 6], ['cedar', 4], ['stonePine', 3]];
const CONIFER_TOTAL = CONIFER_MIX.reduce((a, [, w]) => a + w, 0);

/** The trees of an English wood, by how common they are. */
const MIX = [['oak', 30], ['ash', 18], ['sycamore', 16], ['birch', 14], ['beech', 10], ['horseChestnut', 12]];
const TOTAL = MIX.reduce((a, [, w]) => a + w, 0);

const hash = (x, z, k) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * A tree's species and its own few days either way, from where it stands
 * (so it stays the same tree after edits elsewhere).
 */
export function speciesAt(x, z, conifer = false) {
  const mix = conifer ? CONIFER_MIX : MIX;
  let r = hash(x, z, 1) * (conifer ? CONIFER_TOTAL : TOTAL);
  let name = mix[0][0];
  for (const [n, w] of mix) {
    if (r < w) {
      name = n;
      break;
    }
    r -= w;
  }
  return { name, days: (hash(x, z, 2) - 0.5) * 20, tone: hash(x, z, 3) - 0.5 };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A tree's species: as the map or editor set it (t.species), or from where it stands. */
export function speciesOf(t) {
  const who = speciesAt(t.x, t.z, !!t.conifer);
  // (Its own species, if set and of its kind: a conifer's for a conifer.)
  if (t.species && SPECIES[t.species] && !!SPECIES[t.species].conifer === !!t.conifer) who.name = t.species;
  return who;
}

/** Where a conifer's crown starts (fraction of its height), for its species. */
export function coniferBase(t) {
  return CONIFER[speciesOf(t).name]?.base ?? 0.06;
}

/** A conifer's crown radius (m) for its species and height (yew broad, Leyland narrow). */
export function coniferWidth(t) {
  return t.h * (CONIFER[speciesOf(t).name]?.crownW ?? 0.22);
}

const _a = new Color();
const _b = new Color();
// (Colours as on screen, sRGB, as the bark: read as linear light they came
// out pale and grey. The lightnesses were set for that, so are lifted here.)
const hsl = (out, [h, s, l], dl = 0) => out.setHSL(h, s, Math.max(0.03, (l + dl) * 1.5 + 0.04), SRGBColorSpace);

/**
 * One tree's leaves on a day of the year (1-366): how bare (0 in full leaf,
 * 1 bare) and their colour (linear, into `out`).
 * @param {{ name: string, days: number, tone: number }} who  (speciesAt)
 */
export function leafState(who, day, out = new Color()) {
  const sp = SPECIES[who.name] ?? SPECIES.oak;
  if (sp.evergreen) {
    // Evergreen: always in leaf; new growth a little paler in late spring.
    const fresh = smooth(120 + sp.out, 150 + sp.out, day) * (1 - smooth(165 + sp.out, 215 + sp.out, day));
    hsl(out, sp.summer, who.tone * 0.04);
    out.lerp(hsl(_a, [sp.summer[0] - 0.05, sp.summer[1] + 0.1, sp.summer[2] + 0.12]), fresh * 0.5);
    return { bare: 0, color: out };
  }
  const o = sp.out + who.days;
  const t = sp.turn + who.days;
  const leafOut = smooth(92 + o, 135 + o, day);
  const fall = smooth(285 + t, 345 + t, day); // two months or so, leaf by leaf
  const bare = Math.min(1, Math.max(0, 1 - leafOut + fall));
  // Colour: lime when new, deepening to the summer green; a little darker
  // and duller in late summer; then turning, and browning before falling.
  const fresh = 1 - smooth(110 + o, 165 + o, day);
  const late = smooth(195, 245, day);
  const turn = smooth(262 + t, 300 + t, day);
  const dead = smooth(285 + t, 330 + t, day);
  const tone = who.tone * 0.05; // a little lighter or darker, tree by tree
  hsl(out, sp.summer, tone - late * 0.025);
  // (Duller late in the summer.)
  out.lerp(_a.setRGB(out.r, out.g, out.b).multiplyScalar(0.92), late);
  out.lerp(hsl(_a, [0.215, 0.72, 0.4], tone), fresh); // spring lime
  out.lerp(hsl(_b, sp.autumn, tone), turn);
  out.lerp(hsl(_b, sp.dead, tone), dead);
  return { bare, color: out };
}

/** A bush or hedge (hawthorn), with its own few days and tone. */
export function bushSpeciesAt(x, z) {
  return { name: 'hawthorn', days: (hash(x, z, 5) - 0.5) * 20, tone: hash(x, z, 6) - 0.5 };
}

/** The default bark (conifers, and trees of no species). */
export const BARK = [0.083, 0.27, 0.27];

/** A tree's bark colour (linear, into `out`): its species', a little lighter or darker tree by tree. */
export function barkColor(t, out = new Color()) {
  // (Bark colours are as on screen: sRGB.)
  const who = speciesOf(t);
  const [h, s, l] = SPECIES[who.name]?.bark ?? BARK;
  return out.setHSL(h, s, Math.max(0.03, l + who.tone * 0.06), SRGBColorSpace);
}

/** A tree's trunk thickness (x the usual) for its species. */
export function trunkThickness(t) {
  return SPECIES[speciesOf(t).name]?.thick ?? 1;
}

/** Which leaf picture (row of the leaf atlas, src/world/fluffy.js) a species uses: its own, or a close relative's. */
export function leafName(name) {
  return SPECIES[name]?.leaf ?? name;
}
