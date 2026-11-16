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
//   leaves fall late October to late November              (also by turn)
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
  // Bushes and hedges: hawthorn, early out, rusty red-brown in autumn.
  hawthorn: { bark: [0.06, 0.25, 0.22], thick: 1, spread: 1, bend: 0, out: -14, turn: -4, summer: [0.28, 0.58, 0.22], autumn: [0.035, 0.6, 0.28], dead: [0.05, 0.45, 0.2] },
};

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
export function speciesAt(x, z) {
  let r = hash(x, z, 1) * TOTAL;
  let name = MIX[0][0];
  for (const [n, w] of MIX) {
    if (r < w) {
      name = n;
      break;
    }
    r -= w;
  }
  return { name, days: (hash(x, z, 2) - 0.5) * 12, tone: hash(x, z, 3) - 0.5 };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A tree's species: as the map or editor set it (t.species), or from where it stands. */
export function speciesOf(t) {
  const who = speciesAt(t.x, t.z);
  if (t.species && SPECIES[t.species]) who.name = t.species;
  return who;
}

const _a = new Color();
const _b = new Color();
const hsl = (out, [h, s, l], dl = 0) => out.setHSL(h, s, Math.max(0.02, l + dl));

/**
 * One tree's leaves on a day of the year (1-366): how bare (0 in full leaf,
 * 1 bare) and their colour (linear, into `out`).
 * @param {{ name: string, days: number, tone: number }} who  (speciesAt)
 */
export function leafState(who, day, out = new Color()) {
  const sp = SPECIES[who.name] ?? SPECIES.oak;
  const o = sp.out + who.days;
  const t = sp.turn + who.days;
  const leafOut = smooth(92 + o, 135 + o, day);
  const fall = smooth(300 + t, 332 + t, day);
  const bare = Math.min(1, Math.max(0, 1 - leafOut + fall));
  // Colour: lime when new, deepening to the summer green; a little darker
  // and duller in late summer; then turning, and browning before falling.
  const fresh = 1 - smooth(110 + o, 165 + o, day);
  const late = smooth(195, 245, day);
  const turn = smooth(262 + t, 300 + t, day);
  const dead = smooth(292 + t, 318 + t, day);
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
  return { name: 'hawthorn', days: (hash(x, z, 5) - 0.5) * 12, tone: hash(x, z, 6) - 0.5 };
}

/** The default bark (conifers, and trees of no species). */
export const BARK = [0.083, 0.27, 0.27];

/** A tree's bark colour (linear, into `out`): its species', a little lighter or darker tree by tree. */
export function barkColor(t, out = new Color()) {
  // (Bark colours are as on screen: sRGB.)
  if (t.conifer) return out.setHSL(...BARK, SRGBColorSpace);
  const who = speciesOf(t);
  const [h, s, l] = SPECIES[who.name]?.bark ?? BARK;
  return out.setHSL(h, s, Math.max(0.03, l + who.tone * 0.06), SRGBColorSpace);
}

/** A tree's trunk thickness (x the usual) for its species. */
export function trunkThickness(t) {
  if (t.conifer) return 1;
  return SPECIES[speciesOf(t).name]?.thick ?? 1;
}
