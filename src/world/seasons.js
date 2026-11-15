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
// late September, through October, and fall from late October to the end
// of November.

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** @param {number} day day of the year, 1-366 */
export function seasonFor(day) {
  const leafOut = smooth(92, 135, day); // April to mid May
  const leafFall = smooth(298, 330, day); // late October to late November
  const bare = 1 - leafOut + leafFall;
  const autumn = smooth(262, 300, day) * (1 - smooth(330, 345, day));
  const fresh = smooth(100, 120, day) * (1 - smooth(140, 170, day));
  // Grass: dull and yellowish in winter, bright in spring, a touch dry in
  // late summer.
  const winter = Math.max(1 - smooth(60, 110, day), smooth(310, 350, day));
  const dry = smooth(190, 225, day) * (1 - smooth(255, 280, day));
  const grass = [
    1 - 0.08 * winter + 0.04 * dry + 0.02 * fresh,
    1 - 0.14 * winter - 0.04 * dry + 0.05 * fresh,
    1 - 0.05 * winter - 0.08 * dry,
  ];
  return { bare: Math.min(1, Math.max(0, bare)), autumn, fresh, grass };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Jun" for a day of the year (a non-leap year). */
export function formatDay(day) {
  const d = new Date(Date.UTC(2025, 0, 1) + (Math.round(day) - 1) * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
