// The time of year (Menu → Weather → Time of year): the sun's path comes
// from the date (src/world/sun.js); this is what the date does to the
// plants, for England.
//
//   bare     0 in leaf .. 1 bare (broadleaf trees, bushes and hedges)
//   autumn   0 green .. 1 full autumn colour
//   fresh    0 .. 1 the pale fresh green of new leaves
//   grass    colour multiplier for the grass
//
// Leaves come out through April and are full by mid May; they turn from
// late September, through October, and fall from mid October to mid
// December (each species and tree in its own time: src/world/species.js).

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** @param {number} day day of the year, 1-366 */
export function seasonFor(day) {
  const leafOut = smooth(92, 135, day); // April to mid May
  const leafFall = smooth(285, 345, day); // mid October to mid December
  const bare = 1 - leafOut + leafFall;
  const autumn = smooth(262, 300, day) * (1 - smooth(340, 355, day));
  const fresh = smooth(100, 120, day) * (1 - smooth(140, 170, day));
  // Grass: dull in winter, bright in spring; drying out yellow through a
  // dry late summer (late July to early September), greening again with
  // the autumn rain (later September, October), and growing longer then.
  const winter = Math.max(1 - smooth(60, 110, day), smooth(310, 350, day));
  const dry = smooth(195, 230, day) * (1 - smooth(250, 280, day));
  const regrow = smooth(255, 285, day) * (1 - smooth(315, 340, day)); // fresh autumn green
  const grass = [
    1 - 0.08 * winter + 0.2 * dry + 0.02 * fresh,
    1 - 0.14 * winter - 0.02 * dry + 0.05 * fresh + 0.04 * regrow,
    1 - 0.05 * winter - 0.32 * dry - 0.03 * regrow,
  ];
  // How long the grass is (0 short .. 1 long): a spring flush, then long
  // and lush in autumn (growing again, mown less often).
  const length = Math.min(1, 0.35 * smooth(105, 140, day) * (1 - smooth(160, 190, day)) + smooth(255, 300, day) * (1 - smooth(330, 360, day)));
  return { bare: Math.min(1, Math.max(0, bare)), autumn, fresh, grass, dry, length };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Jun" for a day of the year (a non-leap year). */
export function formatDay(day) {
  const d = new Date(Date.UTC(2025, 0, 1) + (Math.round(day) - 1) * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
