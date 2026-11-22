// A propeller's tones: how loud each multiple of its shaft rate is (the 1st,
// 2nd, ... 24th), for src/audio/engine.js to play as one wave at the shaft
// rate. Measured off recordings, a prop's sound is mostly these tones, with
// little hiss:
//   - The blade-pass tones are the strong ones: every Bth multiple for B
//     blades (every 2nd for a two-blade prop), each step up quieter.
//   - Tapered tips: they fade fast (a softer, smoother sound). Square
//     ("bull-nose") tips shed stronger tip vortices: they fade slower,
//     brighter and harsher.
//   - A pusher's blades chop through the wake of the wing and fuselage ahead
//     every turn: sharper pulses, so the tones fade slower still, and the
//     multiples in between (each blade meeting the wake a little differently)
//     come through too, a rasp.
//   - Above the 12th multiple everything is turned down further (it sounded
//     tinny).
// An aircraft can give its own, measured off a recording, as
// sound.shaftOrders in its JSON (the AeroScout does).

export const ORDERS = 24;

/**
 * @param {{ blades?: number, tip?: 'square'|'tapered', pusher?: boolean }} p
 * @returns {number[]} level of the 1st...24th multiple of the shaft rate (the strongest 1)
 */
export function propOrders({ blades = 2, tip = 'tapered', pusher = false } = {}) {
  const B = Math.max(1, Math.round(blades));
  // How fast the blade-pass tones fade: level = m^-fall for the mth.
  const fall = (tip === 'square' ? 1.0 : 1.5) - (pusher ? 0.4 : 0);
  // The multiples in between: a slight imbalance; more for a pusher.
  const between = pusher ? 0.12 : 0.04;
  const out = [];
  for (let n = 1; n <= ORDERS; n++) {
    let a = n % B === 0 ? (n / B) ** -fall : between / n ** 0.5;
    if (n > 12) a *= (12 / n) ** 2;
    out.push(Math.round(a * 1000) / 1000);
  }
  return out;
}
