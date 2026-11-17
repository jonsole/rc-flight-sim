// HobbyZone AeroScout S 2 1.1m: a moulded-foam beginner trainer. High wing
// with dihedral, a cabin pod that drops into a slim tail boom, a pusher prop
// on top of the pod behind the wing, a conventional tail and tricycle gear
// with a nose wheel steered by the rudder servo. SAFE (Beginner: angle-limited
// and self-levelling; Experienced: AS3X only).
//
// Published: ~1095 mm span, ~870 mm long, 2306 2250Kv motor, 30 A ESC, 3S
// 1300-2200 mAh, CG 60-75 mm behind the wing's leading edge at the root (75 mm
// suggested), low rates 70%, flies level at 50-60% power. Estimated (not
// published): the planform and wing area, the prop (a 6x4 here), thrust,
// inertia, airfoil and drag figures, flying weight with a 2200 pack.
// The outline is drawn from those figures and the general layout, not traced
// off any drawing; the colours are a plain club trainer scheme.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';
import { propGeometry } from './prop.js';
import { createAeroScoutModel } from './aeroscoutModel.js';

const deg = Math.PI / 180;

/** The airframe's layout, shared by the flight model and the 3D model. */
function layout(o) {
  const span = o.span;
  const half = span / 2;
  const cg = o.cgFromLe; // CG behind the root leading edge
  const rootChord = 0.2;
  const tipChord = 0.15;
  const panelBreak = 0.24; // constant-chord centre section out to here (each side)
  const wingY = 0.075; // underside of the wing at the root
  return {
    span,
    half,
    rootChord,
    tipChord,
    panelBreak,
    wingLeX: cg,
    wingY,
    incidence: 2 * deg,
    dihedral: o.dihedral, // as built (each panel from the root)
    hinge: 0.75, // aileron hinge, fraction of the local chord
    ailFrom: 0.27, // aileron inboard end (m from the centreline)
    ailTo: half - 0.03,
    thickness: 0.11, // airfoil thickness / chord
    /** Chord and leading edge x at a spanwise station z (≥ 0). The outer panels taper on both edges. */
    chordAt(z) {
      if (z <= panelBreak) return rootChord;
      const t = Math.min(1, (z - panelBreak) / (half - panelBreak));
      return rootChord + (tipChord - rootChord) * t;
    },
    leAt(z) {
      if (z <= panelBreak) return cg;
      const t = Math.min(1, (z - panelBreak) / (half - panelBreak));
      return cg - 0.02 * t;
    },
    // Fuselage stations: x, half-width, bottom, top, corner radius. A rounded
    // nose, a cabin up to the wing, the top dropping steeply behind the wing
    // (the prop turns there) into a slim boom out to the tail.
    fuselage: [
      [0.285, 0.016, -0.03, 0.006, 0.014],
      [0.27, 0.03, -0.048, 0.022, 0.025],
      [0.235, 0.039, -0.06, 0.035, 0.03],
      [0.18, 0.044, -0.066, 0.043, 0.03],
      [0.13, 0.046, -0.067, 0.05, 0.028],
      [0.075, 0.047, -0.066, wingY, 0.02],
      [-0.02, 0.046, -0.062, wingY, 0.018],
      [-0.1, 0.04, -0.056, wingY - 0.002, 0.016],
      [-0.135, 0.032, -0.052, 0.055, 0.014],
      [-0.165, 0.022, -0.05, 0.0, 0.012],
      [-0.2, 0.016, -0.048, -0.022, 0.008],
      [-0.3, 0.013, -0.042, -0.022, 0.007],
      [-0.45, 0.011, -0.034, -0.016, 0.006],
      [-0.585, 0.008, -0.026, -0.012, 0.004],
    ],
    // Motor pylon on top of the pod behind the wing; the prop turns just
    // behind it, its lower blade passing over the boom.
    prop: { x: -0.175, y: 0.068, radius: o.prop.diameterIn * 0.0254 / 2, blades: o.prop.blades, pitchIn: o.prop.pitchIn, tip: o.prop.tip || 'square' },
    // Tailplane on top of the boom, fin above it.
    tail: { leX: -0.462, chord: 0.12, hingeFrac: 0.62, tipChord: 0.09, span: 0.4, y: -0.01, incidence: o.tailIncidence },
    // finScale: the fin and rudder's size relative to the drawn 140 mm one.
    fin: { leX: -0.44, rootChord: 0.15 * (o.finScale ?? 1), tipChord: 0.085 * (o.finScale ?? 1), height: 0.14 * (o.finScale ?? 1), hingeX: -0.44 - 0.09 * (o.finScale ?? 1), y: -0.008 },
    // Tricycle gear: wire main legs just behind the CG, steerable nose leg.
    mainWheel: { x: -0.035, y: -0.105, z: 0.115, radius: 0.033 },
    noseWheel: { x: 0.215, y: -0.107, radius: 0.03 },
  };
}

/**
 * @param {object} o  settings from the JSON file (angles in radians by now)
 */
export function buildAeroScout(o) {
  o = {
    span: 1.095,
    cgFromLe: 0.075,
    dihedral: 4 * deg,
    aeroDihedral: 2 * deg,
    mass: 0.85,
    tailIncidence: 2 * deg,
    throws: { aileron: 20 * deg, elevator: 18 * deg, rudder: 30 * deg },
    prop: { diameterIn: 6, pitchIn: 4, blades: 2, rpm: 20500, staticThrust: 7.8, current: 22 },
    battery: { cells: 3, capacity: 2200 },
    ...o,
  };
  const L = layout(o);
  const HALF = L.half;

  // Wing panels: a constant-chord centre section and tapered outer panels.
  const stations = [0, 0.12, L.panelBreak, 0.345, 0.45, HALF];
  let wingArea = 0;
  for (let i = 0; i < stations.length - 1; i++) {
    wingArea += 2 * (stations[i + 1] - stations[i]) * (L.chordAt(stations[i]) + L.chordAt(stations[i + 1])) / 2;
  }
  const AR = L.span ** 2 / wingArea;
  const foil = {
    cla: liftSlope(AR) * 0.95,
    alpha0: -3 * deg, // cambered, flat-bottomed trainer section
    alphaStall: 14 * deg,
    stallWidth: 0.03,
    stallDrop: o.stallDrop ?? 1.2,
    // A stalled wing stays stalled until the nose is well down (src/sim/aircraft.js).
    stallHysteresis: o.stallHysteresis ?? 4 * deg,
    cd0: o.cd0 ?? 0.028, // moulded foam, exposed hinges and servo arms
    ar: AR,
    e: 0.78,
  };
  const wing = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < stations.length - 1; i++) {
      const z0 = stations[i];
      const z1 = stations[i + 1];
      const zMid = (z0 + z1) / 2;
      const chord = L.chordAt(zMid);
      const qcX = L.leAt(zMid) - chord * 0.25;
      const tip = i === stations.length - 2;
      wing.push({
        name: `wing-${side > 0 ? 'R' : 'L'}${i}`,
        pos: [qcX, L.wingY + 0.012 + Math.tan(L.dihedral) * zMid, side * zMid],
        chord: [Math.cos(L.incidence), Math.sin(L.incidence), 0],
        span: [0, side * Math.sin(o.aeroDihedral), Math.cos(o.aeroDihedral)],
        area: (z1 - z0) * chord,
        // The left tip stalls a touch first, so a held stall drops a wing gently.
        foil: tip && side < 0 ? { ...foil, alphaStall: foil.alphaStall - (o.tipStallBias ?? 1.5 * deg) } : foil,
        wing: true,
        chordLen: chord,
        controls: zMid > L.ailFrom ? [{ input: 'roll', gain: -side, max: o.throws.aileron, tau: 0.45 }] : [],
        // Differential ailerons (less down than up): less adverse yaw.
        ...(zMid > L.ailFrom && o.aileronDrag ? { aileronDrag: o.aileronDrag } : {}),
        // Pusher: no slipstream over the wing.
      });
    }
  }

  const T = L.tail;
  const tailArea = T.span * (T.chord + T.tipChord) / 2;
  const tailAr = T.span ** 2 / tailArea;
  const tailFoil = { cla: liftSlope(tailAr), alpha0: 0, alphaStall: 16 * deg, cd0: 0.03, ar: tailAr, e: 0.75 };
  const tail = [-1, 1].map((side) => ({
    name: `stab-${side > 0 ? 'R' : 'L'}`,
    pos: [T.leX - T.chord * 0.3, T.y, side * T.span * 0.24],
    chord: [Math.cos(T.incidence), Math.sin(T.incidence), 0],
    span: [0, 0, 1],
    area: tailArea / 2,
    foil: tailFoil,
    downwash: true,
    // The pusher's slipstream runs back along the boom: the tail, below the
    // thrust line, sits in its lower part.
    propwash: 0.45,
    controls: [{ input: 'pitch', gain: -1, max: o.throws.elevator, tau: 0.5 }],
  }));

  const F = L.fin;
  const finArea = F.height * (F.rootChord + F.tipChord) / 2;
  const finAr = (F.height ** 2) / finArea;
  const fin = {
    name: 'fin',
    pos: [F.hingeX + 0.03, F.y + F.height * 0.42, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0], // normal = +z (right)
    area: finArea,
    foil: { cla: liftSlope(finAr), alpha0: 0, alphaStall: 20 * deg, cd0: 0.03, ar: finAr, e: 0.7 },
    propwash: 0.6,
    controls: [{ input: 'yaw', gain: -1, max: o.throws.rudder, tau: 0.55 }],
  };

  const body = [
    {
      name: 'fuselage-side',
      pos: [0.02, 0, 0],
      chord: [1, 0, 0],
      span: [0, -1, 0],
      area: o.sideArea ?? 0.06,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.025, ar: 0.3, e: 0.5 },
      controls: [],
    },
    {
      name: 'fuselage-plan',
      pos: [0.05, 0, 0],
      chord: [1, 0, 0],
      span: [0, 0, 1],
      area: 0.04,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0, ar: 0.3, e: 0.5 },
      controls: [],
    },
  ];

  const tipZ = HALF;
  const tipY = L.wingY + 0.012 + Math.tan(L.dihedral) * HALF;
  const tipLe = L.leAt(HALF);
  const hard = (name, pos, crashSpeed = 4) => ({ name, pos, type: 'hard', k: 1500, c: 10, crashSpeed });
  const MW = L.mainWheel;
  const NW = L.noseWheel;
  const P = o.prop;

  const def = {
    name: o.name,
    mass: o.mass,
    inertia: o.inertia ?? [0.035, 0.06, 0.035], // roll, yaw, pitch (estimated)
    ...(o.rateDamping ? { rateDamping: o.rateDamping } : {}),
    parasite: { x: o.parasiteX ?? 0.012, y: 0.035, z: 0.05 }, // gear legs, wheels, motor pylon, servo arms
    surfaces: [...wing, ...tail, fin, ...body],
    wingAspectRatio: AR,
    wingArea,
    wingSpan: L.span,
    downwashGain: 0.9,
    tricycle: true,
    // Spirally neutral: a bank stays put hands-off (SAFE's Beginner mode levels it).
    holdsBank: true,
    motor: {
      // Square-tipped (bullnose) blades: noisy (src/audio/engine.js).
      prop: { diameterIn: P.diameterIn, pitchIn: P.pitchIn, blades: P.blades, tip: P.tip || 'square' },
      pusher: true, // runs in the wing's wake: a rasping buzz
      kv: 2250,
      noLoadCurrent: 1.0,
      staticThrust: P.staticThrust,
      pitchSpeed: P.pitchIn * 0.0254 * P.rpm / 60,
      spoolTime: 0.06,
      torqueFactor: 0.0015,
      // The thrust line is well above the CG, so power pitches the nose down;
      // the motor is angled up a little to take most of that out.
      downThrust: o.downThrust ?? -4 * deg,
      rightThrust: 0,
      maxRpm: P.rpm,
      blades: P.blades,
      position: [L.prop.x, L.prop.y, 0],
      discArea: Math.PI * L.prop.radius ** 2,
    },
    battery: { cells: o.battery.cells, capacity: o.battery.capacity, maxCurrent: P.current, internalResistance: 0.015 * o.battery.cells },
    cruiseThrottle: 0.55, // "flies level at 50-60% power"
    trim: { roll: 0 },
    // SAFE: Beginner mode limits bank and pitch and levels the wings when the
    // sticks are let go; Experienced mode is the AS3X rate damping alone.
    assist: {
      rateGain: { roll: 0.06, pitch: 0.07, yaw: 0.08 },
      refSpeed: 10,
      maxBank: 40 * deg,
      maxPitch: 25 * deg,
      levelGain: { roll: 1.6, pitch: 1.8 },
    },
    contacts: [
      // Wire main legs, a little give.
      { name: 'wheel-L', pos: [MW.x, MW.y - MW.radius, -MW.z], type: 'wheel', k: 450, c: 6, rollScale: 0.9, crashSpeed: 4.5 },
      { name: 'wheel-R', pos: [MW.x, MW.y - MW.radius, MW.z], type: 'wheel', k: 450, c: 6, rollScale: 0.9, crashSpeed: 4.5 },
      // Nose wheel on the rudder servo: right rudder points it right.
      { name: 'nose-wheel', pos: [NW.x, NW.y - NW.radius, 0], type: 'wheel', k: 400, c: 6, rollScale: 1.1, crashSpeed: 4, steer: -22 * deg },
      { name: 'prop-low', pos: [L.prop.x, L.prop.y - L.prop.radius, 0], type: 'prop', k: 1000, c: 8, crashSpeed: 0 },
      hard('nose', [0.285, -0.015, 0], 3),
      hard('wing-tip-L', [tipLe - L.tipChord / 2, tipY, -tipZ]),
      hard('wing-tip-R', [tipLe - L.tipChord / 2, tipY, tipZ]),
      hard('wing-tip-L-le', [tipLe - 0.01, tipY, -tipZ + 0.01]),
      hard('wing-tip-R-le', [tipLe - 0.01, tipY, tipZ - 0.01]),
      hard('wing-tip-L-te', [tipLe - L.tipChord + 0.01, tipY, -tipZ + 0.01]),
      hard('wing-tip-R-te', [tipLe - L.tipChord + 0.01, tipY, tipZ - 0.01]),
      hard('stab-tip-L', [T.leX - T.chord * 0.4, T.y, -T.span / 2 + 0.01], 3.5),
      hard('stab-tip-R', [T.leX - T.chord * 0.4, T.y, T.span / 2 - 0.01], 3.5),
      hard('wing-top', [L.wingLeX - L.rootChord * 0.3, L.wingY + 0.025, 0], 3),
      hard('fin-top', [F.hingeX + 0.01, F.y + F.height, 0], 3),
      hard('tail-end', [-0.585, -0.028, 0], 3.5),
      hard('belly', [0.05, -0.066, 0], 3),
    ],
  };

  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    defaultAssist: o.defaultAssist || 'safe',
    def,
    geometry: L,
    views: {
      span: L.span,
      cockpit: [0.12, 0.045, 0], // behind the windscreen
      pod: [0.06, L.wingY + 0.05, 0], // a camera on the wing centre
      chase: { back: L.span * 1.8 + 0.3, up: L.span * 0.45 + 0.15 },
    },
    // opts.prop: the prop as tuned (Menu → Tuning), shown instead of the standard one.
    createModel: (opts = {}) => createAeroScoutModel(
      opts.prop ? { ...L, prop: { ...L.prop, ...propGeometry(opts.prop) } } : L,
      o.colors,
    ),
  };
}
