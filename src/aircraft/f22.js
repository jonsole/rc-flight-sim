// Flite Test Mighty Mini F-22 (FT Mini F-22 v1.0, Josh Bixler, 2016): a
// foam-board "prop-in-slot" jet. A flat diamond wing with the motor in the
// middle of it, pushing through a T-shaped slot, two all-moving elevons
// hinged behind the wing and two fixed fins canted out 20°. No rudder, no
// landing gear: it is hand-launched and belly-landed.
//
// Published (plan sheet): 508 mm span, 667 mm long, 14.2 dm² wing area,
// 134 g dry, 211 g all up, CG 305 mm from the nose (marked on the wing),
// elevons ±25° with 30% expo, set with 8° of up reflex (the plan's reflex
// gauge). Power: 2204 2300Kv (or 1806 2280Kv), 6x4.5 prop, 12 A ESC, 3S
// 800 mAh, two 5 g servos. This one has a 2600Kv motor and a 5" five-blade
// prop (see below).
//
// The outlines below are traced off the 1:1 plan sheets in plan pixels
// (40 dpi render, 0.635 mm each, scaled to the published 508 mm span), so the
// flight model and the 3D model use the same shapes. Thrust and inertia are
// estimates.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';
import { createF22Model } from './f22Model.js';

const deg = Math.PI / 180;

// Plan pixels -> body axes. The centreline is plan column 591 and the CG is
// at the plan's marks, row 285 (305 mm from the nose). The build article
// says 14 in (355 mm), but the plan's CG goes with the plan's 8° of elevon
// reflex: together they trim at ~10° angle of attack, like the real one.
const K = (0.635 / 1000) * (508 / 498);
const CG_ROW = 285;
const P = ([col, row]) => [(CG_ROW - row) * K, (col - 591) * K];

/** Polygon area and centroid [x, z] (shoelace). */
export function polyProps(pts) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    const cr = x0 * z1 - x1 * z0;
    a += cr;
    cx += (x0 + x1) * cr;
    cz += (z0 + z1) * cr;
  }
  return { area: Math.abs(a) / 2, x: cx / (3 * a), z: cz / (3 * a) };
}

/** Keep the part of a polygon [[x, z]...] with z between z0 and z1. */
function clipZ(pts, z0, z1) {
  const clip = (poly, zc, keepAbove) => {
    const inside = (p) => (keepAbove ? p[1] >= zc : p[1] <= zc);
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const t = (zc - a[1]) / (b[1] - a[1]);
        out.push([a[0] + (b[0] - a[0]) * t, zc]);
      }
    }
    return out;
  };
  return clip(clip(pts, z0, true), z1, false);
}

/** Outlines from the plan, right half, [x, z] in body axes. */
export function f22Outlines() {
  // Main wing, right half: round from the centreline at the bottom of the
  // front slot (the fuselage box drops in there), out along the chine and
  // the leading edge to the tip, in along the trailing edge to the elevon
  // hinge, then back up the centreline round the T-shaped prop slot.
  const wing = [
    [591, 205], [623, 205], [623, 85], [694, 109], [730, 272], [983, 463], [983, 545], [928, 615],
    [780, 661], [591, 661], [591, 493], [730, 493], [730, 437], [615, 437], [615, 328], [591, 328],
  ].map(P);
  // Elevon (an all-moving tail half hinged to the wing's trailing edge).
  const elevon = [
    [592, 662], [780, 662], [863, 740], [863, 812], [730, 845], [645, 765], [645, 725], [622, 733], [595, 720], [592, 672],
  ].map(P);
  const hingeX = P([0, 662])[0];
  // Fin, side view [x, height above the wing]. Tabs go into wing slots at
  // plan column 660; the fin's root runs from row 517 to the hinge.
  const finZ = (660 - 591) * K;
  const fin = [[165, 265], [237, 82], [305, 82], [362, 200], [305, 265]]
    .map(([u, v]) => [(CG_ROW - (547 + (u - 195))) * K, (265 - v) * K]);
  // T-shaped prop slot: the prop spins in the cross bar.
  const slot = { front: P([0, 437])[0], back: P([0, 493])[0], halfWidth: (730 - 591) * K, stemFront: P([0, 328])[0], stemHalf: (615 - 591) * K };
  // Under the wing (parts 05, 06 and 08): two side plates hang 28 mm below
  // it, down the chine line (bent at their score line), then straight back
  // to the hinge either side of the prop. The belly pan closes the bottom of
  // the front 159 mm between them, leaving a square intake at the front.
  const plate = [[694, 109], [733, 290], [735, 661]].map(P);
  const underbody = { plate, depth: 0.028, panEnd: plate[0][0] - 0.159 };
  // Fuselage, from the printed front section (F22_Fuselage_FRONT_Rev03):
  // [STL x, bottom z, top z, half-width], mm, measured off the model. Its
  // open back channel (x 264-342) fills the wing's 76 mm front notch, with
  // the wing sheet resting on ledges 40 mm up so the top is flush with it:
  // the fuselage hangs under the wing, and the nose fairing ahead of the wing
  // rises in one line into the canopy, 4.5 mm proud at the wing's front edge.
  // Heights below are from the underside of the wing. Behind the section the
  // same 41 mm box carries on under the wing to the motor (assumed).
  const stlX = (x) => P([0, 205])[0] + (342 - x) / 1000;
  const fuselage = {
    stations: [
      [182.5, 20.9, 23.3, 2.4], [184, 20, 24.4, 4.75], [186, 19.2, 25.6, 6.3], [188, 18.5, 26.7, 7.5],
      [191, 17.4, 28.4, 9.15], [195, 16, 30.4, 11.2], [200, 14.4, 32.6, 13.45], [205, 12.9, 34.6, 15.35],
      [210, 11.4, 36.4, 17], [215, 10.1, 38.1, 18.3], [220, 8.9, 39.7, 19.35], [225, 7.7, 41.2, 20],
      [230, 6.7, 42.6, 20], [240, 4.8, 45.1, 20], [250, 3.4, 47.4, 20], [260, 2.3, 49.3, 20],
      [261.5, 2.1, 49.5, 20.3], [263, 2, 48.5, 20.6], [265, 1.8, 44.8, 20.6], [280, 0.9, 44.8, 20.6],
      [300, 0, 44.8, 20.6], [342, 0, 44.8, 20.6],
    ].map(([x, b, t, hw]) => [stlX(x), (b - 40) / 1000, (t - 40) / 1000, hw / 1000]),
  };
  // Foam box on behind, under the wing, to the motor.
  fuselage.stations.push([P([0, 415])[0], -0.04, 0, 0.0206]);
  // Canopy: the top of the fairing, from part way along the nose to the wing.
  const canopy = { front: stlX(215), back: stlX(262.5) };
  return { wing, elevon, hingeX, fin, finZ, slot, underbody, fuselage, canopy, nose: fuselage.stations[0][0] };
}

export function buildF22(style) {
  const O = f22Outlines();
  const wingY = -0.01; // wing mid-plane: the battery and box sit above it
  const wingP = polyProps(O.wing);
  const elevP = polyProps(O.elevon);
  const SPAN = 2 * Math.max(...O.wing.map((p) => p[1]));
  const AREA = 2 * (wingP.area + elevP.area); // whole planform, as published
  const AR = SPAN ** 2 / AREA;

  // Flat 5 mm foam board. A low-aspect-ratio diamond: a shallow lift curve
  // and a late, gentle stall (the swept leading edge keeps a vortex going).
  const plate = {
    cla: liftSlope(AR) * 1.05,
    alpha0: 0,
    alphaStall: 24 * deg,
    stallWidth: 0.04,
    stallDrop: 0.6,
    cd0: 0.025,
    ar: AR,
    e: 0.85,
  };

  const plateEarly = { ...plate, alphaStall: plate.alphaStall - style.stallAsymmetry };

  // Spanwise strips of the main wing, each with its own area, centroid and
  // chord, swept along the quarter-chord line.
  const bands = [0, 0.045, 0.1, 0.16, 0.21, SPAN / 2];
  const strips = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const pp = polyProps(clipZ(O.wing, bands[i], bands[i + 1]));
    const chord = pp.area / (bands[i + 1] - bands[i]);
    strips.push({ ...pp, chord, qc: pp.x + 0.25 * chord });
  }
  // Each strip's lift acts just ahead of its centroid, not at its quarter
  // chord: on a slender delta the load sits further back, putting the
  // aerodynamic centre near the planform's centroid (about 2/3 of the root
  // chord back).
  for (const s of strips) {
    s.ac = s.x + 0.05 * s.chord;
  }
  const sweep = Math.atan2(strips[1].qc - strips[strips.length - 1].qc, strips[strips.length - 1].z - strips[1].z);

  const wing = [];
  for (const side of [-1, 1]) {
    strips.forEach((s, i) => {
      wing.push({
        name: `wing-${side > 0 ? 'R' : 'L'}${i}`,
        pos: [s.ac, wingY, side * s.z],
        chord: [1, 0, 0],
        span: [-side * Math.tan(sweep), side * Math.sin(style.aeroDihedral), 1],
        area: s.area,
        // No foam-board model is built perfectly true: one wing stalls a
        // little earlier, so at the stall it falls off to that side.
        foil: side < 0 ? plateEarly : plate,
        wing: true,
        chordLen: s.chord,
        controls: [],
        // The prop draws air over the inner wing ahead of the slot.
        propwash: i === 0 ? 0.15 : 0,
      });
    });
  }

  // Elevons: all-moving tail halves, mixed for pitch and roll.
  const elevAr = (2 * Math.max(...O.elevon.map((p) => p[1]))) ** 2 / (2 * elevP.area);
  const elevChord = elevP.area / Math.max(...O.elevon.map((p) => p[1]));
  // Low aspect ratio (~2): it stalls late.
  // Hinged straight onto the trailing edge, they act partly as the back of
  // the low-aspect-ratio planform rather than as a separate tail: a lift
  // slope between the two.
  const elevFoil = { cla: liftSlope((AR + elevAr) / 2), alpha0: 0, alphaStall: 28 * deg, stallWidth: 0.03, cd0: 0.025, ar: elevAr, e: 0.75 };
  const inc = -style.reflex;
  const elevons = [-1, 1].map((side) => ({
    name: `stab-${side > 0 ? 'R' : 'L'}`,
    pos: [elevP.x + 0.15 * elevChord, wingY, side * elevP.z],
    chord: [Math.cos(inc), Math.sin(inc), 0],
    span: [0, 0, 1],
    area: elevP.area,
    foil: elevFoil,
    downwash: true,
    // The inner part sits in the slipstream: less of it behind a smaller prop.
    propwash: 0.2 * (style.prop.diameterIn / 6) ** 2,
    // Right behind the wing: as it stalls they sit in its dead air and stop
    // answering the stick.
    wake: style.elevonWake,
    maxDeflection: style.throws.max,
    controls: [
      { input: 'pitch', gain: -1, max: style.throws.pitch, tau: 0.9 },
      { input: 'roll', gain: -side, max: style.throws.roll, tau: 0.9 },
    ],
  }));

  // Fins canted out at 20°, no rudder.
  const finP = polyProps(O.fin);
  const finH = Math.max(...O.fin.map((p) => p[1]));
  const cant = style.finCant;
  const fins = [-1, 1].map((side) => ({
    name: `fin-${side > 0 ? 'R' : 'L'}`,
    pos: [finP.x, wingY + finP.z * Math.cos(cant), side * (O.finZ + finP.z * Math.sin(cant))],
    chord: [1, 0, 0],
    span: [0, -Math.cos(cant), -side * Math.sin(cant)],
    area: finP.area,
    foil: { cla: liftSlope(1.4), alpha0: 0, alphaStall: 20 * deg, cd0: 0.025, ar: 1.4, e: 0.7 },
    propwash: 0.1,
    controls: [],
  }));

  // Fuselage box on top and the side plates underneath, side-on.
  const body = [{
    name: 'fuselage-side',
    pos: [0.0, -0.025, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0],
    area: 0.024,
    foil: { cla: liftSlope(0.2), alpha0: 0, alphaStall: 25 * deg, cd0: 0.02, ar: 0.2, e: 0.5 },
    controls: [],
  }];

  const tip = O.wing.reduce((a, b) => (b[1] > a[1] ? b : a));
  const elevTip = O.elevon.reduce((a, b) => (b[0] < a[0] ? b : a));
  const hard = (name, pos, crashSpeed = 4) => ({ name, pos, type: 'hard', k: 800, c: 6, crashSpeed });
  const propX = (O.slot.front + O.slot.back) / 2;
  // The prop spins in the slot centred on the wing sheet: half the disc
  // above it, half below.
  const propY = wingY;
  const radius = style.prop.diameterIn * 0.0254 / 2;
  const U = O.underbody;
  const bottomY = wingY - 0.0025 - U.depth;
  const under = wingY - 0.0025; // underside of the wing: fuselage heights are from here
  const keelY = under - 0.04; // bottom of the fuselage

  const def = {
    name: style.name,
    mass: style.mass,
    // Roll, yaw, pitch (estimated): ~120 g of foam spread over the span and
    // the 667 mm length, battery at the CG, motor 7 cm behind it.
    inertia: [0.0025, 0.006, 0.004],
    parasite: { x: 0.0035, y: 0.02, z: 0.03 },
    surfaces: [...wing, ...elevons, ...fins, ...body],
    wingAspectRatio: AR,
    wingArea: AREA,
    wingSpan: SPAN,
    downwashGain: style.downwashGain,
    motor: {
      staticThrust: style.prop.staticThrust,
      pitchSpeed: style.prop.pitchSpeed,
      spoolTime: 0.05,
      torqueFactor: 0.001,
      downThrust: 0,
      rightThrust: 0,
      maxRpm: style.prop.rpm,
      blades: style.prop.blades,
      position: [propX, propY, 0],
      discArea: Math.PI * radius ** 2,
    },
    battery: { cells: 3, capacity: 800, maxCurrent: style.prop.current, internalResistance: 0.03 * 3 },
    trim: { pitch: style.pitchTrim || 0 },
    // No gyro on the real one; the assist modes are there to learn with.
    assist: {
      rateGain: { roll: 0.04, pitch: 0.05, yaw: 0 },
      refSpeed: 10,
      maxBank: 45 * deg,
      maxPitch: 30 * deg,
      levelGain: { roll: 1.2, pitch: 1.4 },
    },
    // Flies level hands-off at a bit over half throttle (~50 km/h).
    cruiseThrottle: 0.55,
    // Thrown from shoulder height once the motor is up to speed.
    handLaunch: { height: 1.5, speed: 7.5, pitch: 12 * deg, throttle: 0.6 },
    contacts: [
      // Belly-landed on the belly pan and the side plates.
      { name: 'belly-front', pos: [U.plate[0][0] - 0.02, bottomY, 0], type: 'skid', k: 300, c: 4, mu: 0.45, crashSpeed: 3.5 },
      { name: 'belly-rear', pos: [U.plate[2][0] + 0.01, bottomY, 0], type: 'skid', k: 300, c: 4, mu: 0.45, crashSpeed: 3.5 },
      // The pusher prop hangs below the wing in its slot.
      { name: 'prop-low', pos: [propX, propY - radius, 0], type: 'prop', k: 600, c: 5, crashSpeed: 0 },
      hard('nose', [O.nose - 0.002, under + O.fuselage.stations[0][1], 0], 3),
      { name: 'chin', pos: [O.fuselage.stations[20][0], keelY, 0], type: 'skid', k: 300, c: 4, mu: 0.45, crashSpeed: 3.5 },
      { name: 'keel-rear', pos: [O.fuselage.stations[22][0] + 0.005, keelY, 0], type: 'skid', k: 300, c: 4, mu: 0.45, crashSpeed: 3.5 },
      hard('wing-tip-L', [tip[0] - 0.02, wingY, -tip[1]]),
      hard('wing-tip-R', [tip[0] - 0.02, wingY, tip[1]]),
      hard('cabin-top', [O.canopy.back + 0.005, under + 0.0095, 0], 3),
      hard('fin-top-L', [O.fin[2][0], wingY + finH * Math.cos(cant), -(O.finZ + finH * Math.sin(cant))], 3),
      hard('fin-top-R', [O.fin[2][0], wingY + finH * Math.cos(cant), O.finZ + finH * Math.sin(cant)], 3),
      hard('tail-end-L', [elevTip[0], wingY, -elevTip[1]], 3.5),
      hard('tail-end-R', [elevTip[0], wingY, elevTip[1]], 3.5),
    ],
  };

  const geometry = { ...O, wingY, cant, finH, prop: { x: propX, y: propY, radius, pitchIn: style.prop.pitchIn, blades: style.prop.blades }, reflex: style.reflex, colors: style.colors };

  return {
    id: style.id,
    name: style.name,
    summary: style.summary,
    defaultAssist: 'off',
    def,
    geometry,
    views: {
      span: SPAN,
      // Under the canopy, and a camera on top of the fuselage box.
      // Under the canopy, and a camera on the box behind it.
      cockpit: [O.canopy.back + 0.02, under + 0.002, 0],
      pod: [0.0, under + 0.012, 0],
      chase: { back: 1.4, up: 0.45 },
    },
    createModel: () => createF22Model(geometry),
  };
}

// This one: a 2204 2600Kv on 3S (~29,000 rpm unloaded) with a 5x4.5
// five-blade quad prop, loaded to ~22,000 rpm: about 510 g static thrust at
// ~16 A (estimated from typical 5" prop data). Pitch speed = pitch × loaded
// rpm, so it is faster flat out than the plan's 2300Kv and 6x4.5.
const PROP_5x45x5 = { diameterIn: 5, pitchIn: 4.5, blades: 5, rpm: 22000, staticThrust: 5.0, pitchSpeed: 42, current: 16 };

export const FT_MINI_F22 = buildF22({
  id: 'ft-mini-f22',
  name: 'Flite Test Mighty Mini F-22',
  summary: 'Foam-board pusher jet, 508 mm. Prop in a slot in the wing, elevons, canted fins. Hand launch. 2204 2600Kv, 5x4.5 five-blade, 3S 800 mAh, 211 g.',
  prop: PROP_5x45x5,
  mass: 0.211,
  // Elevons 25° each way on the plan, for roll and pitch. Mixed, they share
  // the 25° of servo travel.
  throws: { pitch: 25 * deg, roll: 25 * deg, max: 25 * deg },
  stallAsymmetry: 3 * deg, // left wing
  elevonWake: 0.95,
  reflex: 8 * deg, // elevons trimmed trailing edge up: the plan's reflex gauge
  downwashGain: 0.5,
  // Effective dihedral for the aerodynamics (the wing is flat): the swept
  // leading edge and the fins standing above the wing roll it away from a
  // sideslip.
  aeroDihedral: 10 * deg,
  finCant: 20 * deg,
  // Painted in two greys like the full-size Raptor, with a gold-tinted canopy.
  colors: { main: '#8d949b', dark: '#5f666d', canopy: '#6b5a2e', box: '#7f868d' },
});
