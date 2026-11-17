// Multiplex EasyStar (the original, 2003): a moulded Elapor foam powered
// glider and trainer. A slim pod and tapering boom, a long, high wing whose
// tips curve up (lots of effective dihedral), a pusher Permax 400 on top of
// the pod behind the wing, and a conventional tail. Rudder and elevator only:
// no ailerons, and no landing gear (hand-launched, belly-landed).
//
// Published: 1370 mm span, 868 mm long, 24 dm² wing, ~680 g flying weight,
// Permax 400 6V brushed motor on 7-cell NiMH (8.4 V), 5x4 pusher prop,
// CG 78 mm behind the leading edge at the root. Estimated (not published):
// thrust, rpm and current, inertia, airfoil and drag figures.
// The geometry (wing planform, dihedral, tail, prop position) is measured
// off the 3D model file, src/aircraft/models/multiplex-easystar.glb (made in
// Blender), whose origin is the CG.
//
// Controls: with no ailerons, the roll stick also works the rudder (as most
// EasyStar pilots set it up on one stick); the rudder stick does too.
// "rollToRudder": false in the JSON file leaves the roll stick doing nothing.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';

const deg = Math.PI / 180;

/**
 * The airframe's layout, measured off the model file. Wing stations out from
 * the root (right half): [z, leading edge x, trailing edge x, underside y].
 * The flat centre panels have about 2° of dihedral; outboard of 0.45 m the
 * tips sweep back and curve up.
 */
function layout(o) {
  const wing = [
    [0, 0.078, -0.118, 0.025],
    [0.1, 0.079, -0.118, 0.028],
    [0.2, 0.08, -0.118, 0.032],
    [0.3, 0.08, -0.117, 0.034],
    [0.4, 0.079, -0.115, 0.038],
    [0.45, 0.077, -0.112, 0.043],
    [0.5, 0.07, -0.108, 0.049],
    [0.55, 0.057, -0.104, 0.059],
    [0.6, 0.034, -0.099, 0.078],
    [0.65, 0.0, -0.093, 0.109],
    [0.685, -0.059, -0.09, 0.153],
  ];
  return {
    span: 1.37,
    half: 0.685,
    wing,
    rootChord: 0.196,
    thickness: 0.11,
    incidence: o.wingIncidence,
    // Pod and boom: nose at x 0.249, boom end -0.621; pod bottom -0.077.
    noseX: 0.249,
    podBottom: -0.077,
    boomEnd: -0.621,
    // Canopy (battery hatch) on top of the pod ahead of the wing.
    canopy: { front: 0.19, back: 0.083, top: 0.048 },
    // Motor on its pylon behind the wing; the pusher prop just behind it.
    prop: { x: -0.143, y: 0.085, radius: (o.prop.diameterIn * 0.0254) / 2, blades: o.prop.blades, pitchIn: o.prop.pitchIn },
    // Tailplane on the boom: fixed stab -0.535..-0.615, elevator hinge at
    // -0.615, elevator 53 mm chord; 494 mm span over the rounded tips.
    tail: { leX: -0.535, hingeX: -0.615, chord: 0.12, span: 0.494, y: 0.003, incidence: o.tailIncidence },
    // Swept fin above the boom, rudder behind it.
    fin: { leX: -0.5, rootChord: 0.135, tipChord: 0.045, height: 0.16, hingeX: -0.634, y: 0.002 },
  };
}

/**
 * @param {object} o  settings from the JSON file (angles in radians by now)
 */
export function buildEasyStar(o) {
  o = {
    mass: 0.68,
    wingIncidence: 3 * deg,
    tailIncidence: 0,
    throws: { elevator: 15 * deg, rudder: 30 * deg },
    prop: { diameterIn: 5, pitchIn: 4, blades: 2, rpm: 14000, staticThrust: 2.6, current: 10 },
    battery: { cells: 2, capacity: 1500 },
    rollToRudder: true,
    ...o,
  };
  const L = layout(o);

  // Wing panels between the stations, each with its own dihedral (the
  // curved-up tips give the dihedral effect a rudder-only model steers by).
  const foil = {
    cla: 0,
    alpha0: -3.5 * deg, // undercambered glider section
    alphaStall: 13 * deg,
    stallWidth: 0.04,
    stallDrop: o.stallDrop ?? 0.7, // a gentle, forgiving stall
    stallHysteresis: o.stallHysteresis ?? 3 * deg,
    cd0: o.cd0 ?? 0.022,
    ar: 0,
    e: 0.85,
  };
  let wingArea = 0;
  const panels = [];
  for (let i = 0; i < L.wing.length - 1; i++) {
    const [z0, le0, te0, y0] = L.wing[i];
    const [z1, le1, te1, y1] = L.wing[i + 1];
    const c0 = le0 - te0;
    const c1 = le1 - te1;
    const area = ((z1 - z0) * (c0 + c1)) / 2;
    wingArea += 2 * area;
    panels.push({ i, z0, z1, le: (le0 + le1) / 2, chord: (c0 + c1) / 2, y: (y0 + y1) / 2, area, dih: Math.atan2(y1 - y0, z1 - z0) });
  }
  const AR = L.span ** 2 / wingArea;
  foil.cla = liftSlope(AR) * 0.95;
  foil.ar = AR;
  // Dihedral the aerodynamics see: the panels' own, scaled (o.dihedralScale)
  // to tune the roll the rudder makes.
  const dScale = o.dihedralScale ?? 1;
  const wing = [];
  for (const side of [-1, 1]) {
    for (const p of panels) {
      const zMid = (p.z0 + p.z1) / 2;
      const dih = p.dih * dScale;
      const tip = p.i === panels.length - 1;
      wing.push({
        name: `wing-${side > 0 ? 'R' : 'L'}${p.i}`,
        pos: [p.le - p.chord * 0.25, p.y + 0.012, side * zMid],
        chord: [Math.cos(L.incidence), Math.sin(L.incidence), 0],
        span: [0, side * Math.sin(dih), Math.cos(dih)],
        area: p.area,
        // The left tip stalls a touch first: a held stall drops a wing gently.
        foil: tip && side < 0 ? { ...foil, alphaStall: foil.alphaStall - (o.tipStallBias ?? 1 * deg) } : foil,
        wing: true,
        chordLen: p.chord,
        controls: [],
      });
    }
  }

  const T = L.tail;
  const tailArea = T.span * T.chord * 0.92; // rounded tips
  const tailAr = T.span ** 2 / tailArea;
  const tailFoil = { cla: liftSlope(tailAr), alpha0: 0, alphaStall: 16 * deg, cd0: 0.025, ar: tailAr, e: 0.75 };
  const tail = [-1, 1].map((side) => ({
    name: `stab-${side > 0 ? 'R' : 'L'}`,
    pos: [T.leX - T.chord * 0.3, T.y, side * T.span * 0.22],
    chord: [Math.cos(T.incidence), Math.sin(T.incidence), 0],
    span: [0, 0, 1],
    area: tailArea / 2,
    foil: tailFoil,
    downwash: true,
    // The pusher's slipstream runs back along the boom, just over the tail.
    propwash: 0.3,
    controls: [{ input: 'pitch', gain: -1, max: o.throws.elevator, tau: 0.45 }],
  }));

  const F = L.fin;
  const finArea = (F.height * (F.rootChord + F.tipChord)) / 2;
  const finAr = F.height ** 2 / finArea;
  const rudder = o.throws.rudder;
  const fin = {
    name: 'fin',
    pos: [F.leX - F.rootChord * 0.45, F.y + F.height * 0.42, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0], // normal = +z (right)
    area: finArea,
    foil: { cla: liftSlope(finAr), alpha0: 0, alphaStall: 20 * deg, cd0: 0.025, ar: finAr, e: 0.7 },
    propwash: 0.5,
    // Rudder stick, and the roll stick mixed in (both full: no more than full rudder).
    controls: [
      { input: 'yaw', gain: -1, max: rudder, tau: 0.5 },
      ...(o.rollToRudder ? [{ input: 'roll', gain: -1, max: rudder, tau: 0.5 }] : []),
    ],
    maxDeflection: rudder,
  };

  const body = [
    {
      name: 'fuselage-side',
      pos: [-0.05, 0, 0],
      chord: [1, 0, 0],
      span: [0, -1, 0],
      area: o.sideArea ?? 0.07,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.02, ar: 0.3, e: 0.5 },
      controls: [],
    },
    {
      name: 'fuselage-plan',
      pos: [0.05, 0, 0],
      chord: [1, 0, 0],
      span: [0, 0, 1],
      area: 0.03,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0, ar: 0.3, e: 0.5 },
      controls: [],
    },
  ];

  const [tz, tle, tte, ty] = L.wing[L.wing.length - 1];
  const [bz, ble, bte, by] = L.wing[5]; // where the tip starts to curve up
  const hard = (name, pos, crashSpeed = 4) => ({ name, pos, type: 'hard', k: 1500, c: 10, crashSpeed });
  // Elapor skids along on its belly.
  const belly = (name, x, y) => ({ name, pos: [x, y, 0], type: 'skid', k: 350, c: 5, mu: 0.4, crashSpeed: 3.5 });
  const P = o.prop;

  const def = {
    name: o.name,
    mass: o.mass,
    inertia: o.inertia ?? [0.045, 0.06, 0.03], // roll, yaw, pitch (estimated)
    parasite: { x: o.parasiteX ?? 0.006, y: 0.03, z: 0.04 }, // motor, pylon, pushrods, horns
    surfaces: [...wing, ...tail, fin, ...body],
    wingAspectRatio: AR,
    wingArea,
    wingSpan: L.span,
    downwashGain: 0.9,
    motor: {
      prop: { diameterIn: P.diameterIn, pitchIn: P.pitchIn, blades: P.blades },
      pusher: true, // runs in the wing's wake: a rasping buzz
      kv: o.kv ?? 2600, // Permax 400 6V (brushed)
      noLoadCurrent: 1.2,
      staticThrust: P.staticThrust,
      pitchSpeed: (P.pitchIn * 0.0254 * P.rpm) / 60,
      spoolTime: 0.12, // a brushed can motor: slower to wind up
      torqueFactor: 0.001,
      // Thrust line well above the CG: power pitches the nose down; the
      // motor is angled up a little to take most of that out.
      downThrust: o.downThrust ?? -3 * deg,
      rightThrust: 0,
      maxRpm: P.rpm,
      blades: P.blades,
      position: [L.prop.x, L.prop.y, 0],
      discArea: Math.PI * L.prop.radius ** 2,
    },
    // 7-cell NiMH: 8.4 V charged, the same as a 2S LiPo (as which it's modelled).
    battery: { cells: o.battery.cells, capacity: o.battery.capacity, maxCurrent: P.current, internalResistance: 0.025 * o.battery.cells },
    cruiseThrottle: o.cruiseThrottle ?? 0.5,
    trim: { pitch: o.pitchTrim || 0 },
    // No gyro on the real one; the assist modes are there to learn with
    // (through the rudder: it has no ailerons).
    assist: {
      rateGain: { roll: 0.05, pitch: 0.06, yaw: 0.06 },
      refSpeed: 9,
      maxBank: 40 * deg,
      maxPitch: 25 * deg,
      levelGain: { roll: 2.5, pitch: 1.6 },
    },
    // Thrown from shoulder height once the motor is up to speed.
    handLaunch: { height: 1.6, speed: 8, pitch: 10 * deg, throttle: 0.7 },
    contacts: [
      belly('belly-front', 0.18, -0.068),
      belly('belly-mid', 0.0, -0.077),
      belly('belly-rear', -0.2, -0.058),
      // The pusher prop sits high, behind the wing: its lower tip clears the boom.
      { name: 'prop-low', pos: [L.prop.x, L.prop.y - L.prop.radius, 0], type: 'prop', k: 600, c: 5, crashSpeed: 0 },
      hard('nose', [L.noseX, -0.02, 0], 3),
      hard('wing-tip-L', [(tle + tte) / 2, ty, -tz]),
      hard('wing-tip-R', [(tle + tte) / 2, ty, tz]),
      hard('wing-tip-L-le', [ble, by, -bz]),
      hard('wing-tip-R-le', [ble, by, bz]),
      hard('wing-tip-L-te', [bte, by, -bz]),
      hard('wing-tip-R-te', [bte, by, bz]),
      hard('stab-tip-L', [-0.6, T.y, -T.span / 2 + 0.01], 3.5),
      hard('stab-tip-R', [-0.6, T.y, T.span / 2 - 0.01], 3.5),
      hard('wing-top', [0.0, 0.06, 0], 3),
      hard('fin-top', [-0.63, F.y + F.height, 0], 3),
      hard('tail-end', [L.boomEnd, -0.025, 0], 3.5),
    ],
  };

  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    defaultAssist: o.defaultAssist || 'off',
    def,
    geometry: L,
    views: {
      span: L.span,
      cockpit: [0.17, 0.055, 0], // a camera on the canopy
      pod: [0.0, 0.08, 0], // on the wing centre
      chase: { back: L.span * 1.6 + 0.3, up: L.span * 0.4 + 0.15 },
    },
  };
}
