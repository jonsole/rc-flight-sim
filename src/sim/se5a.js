// Royal Aircraft Factory S.E.5a, as a ~1/5 scale electric RC model.
//
// Full-size: span 8.11 m, length 6.38 m, wing area 22.67 m².
// Model:     span 1.62 m, length ~1.28 m, wing area ~0.90 m², AUW 2.2 kg.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from './aero.js';

const deg = Math.PI / 180;

const SPAN = 1.62;
const CHORD = 0.28;
const STAGGER = 0.06;           // upper wing ahead of lower
const LOWER_LE_X = 0.054;       // puts CG at ~30% of mean chord
const UPPER_LE_X = LOWER_LE_X + STAGGER;
const LOWER_Y = -0.10;
const UPPER_Y = 0.17;
const DIHEDRAL = 4.5 * deg;
const WING_INCIDENCE = 2.0 * deg;
const WING_AR = (SPAN * SPAN) / (SPAN * CHORD);

export const geometry = {
  span: SPAN,
  chord: CHORD,
  stagger: STAGGER,
  lowerLeX: LOWER_LE_X,
  upperLeX: UPPER_LE_X,
  lowerY: LOWER_Y,
  upperY: UPPER_Y,
  dihedral: DIHEDRAL,
  incidence: WING_INCIDENCE,
  lowerRootZ: 0.08,
  tail: { leX: -0.64, chord: 0.2, span: 0.66, y: 0.03, incidence: 2.5 * deg },
  fin: { leX: -0.70, chord: 0.19, height: 0.24, baseY: 0.04 },
  prop: { x: 0.43, y: 0.02, radius: 0.185 },
  wheel: { x: 0.2, y: -0.2, z: 0.15, radius: 0.07 },
  skid: { x: -0.80, y: -0.10 },
  pilotEye: { x: -0.21, y: 0.158, z: 0 },
};

function airfoil(ar, extra = {}) {
  return {
    cla: liftSlope(ar) * 0.92, // biplane interference
    alpha0: -2.5 * deg,        // cambered RAF 15-ish section
    alphaStall: 13 * deg,
    cd0: 0.014,
    ar,
    e: 0.8,
    ...extra,
  };
}

/** Build the panels for one wing (upper or lower), both halves. */
function wingPanels(name, leX, y, rootZ, segments, aileronFrom) {
  const panels = [];
  const half = SPAN / 2;
  const segSpan = (half - rootZ) / segments;
  const qcX = leX - CHORD * 0.25;
  const foil = airfoil(WING_AR);
  for (const side of [-1, 1]) {
    for (let i = 0; i < segments; i++) {
      const zMid = rootZ + segSpan * (i + 0.5);
      // Tip segment has rounded tips: a bit less area.
      const area = segSpan * CHORD * (i === segments - 1 ? 0.9 : 1);
      // Spanwise vector always points to +z (right); for left wing that's inboard.
      // Right wing rises as z grows; left wing rises as z decreases.
      const span = [0, side * Math.sin(DIHEDRAL), Math.cos(DIHEDRAL)];
      const chordDir = [Math.cos(WING_INCIDENCE), Math.sin(WING_INCIDENCE), 0];
      const isAileron = zMid >= aileronFrom;
      panels.push({
        name: `${name}-${side > 0 ? 'R' : 'L'}${i}`,
        pos: [qcX, y + Math.tan(DIHEDRAL) * (zMid), side * zMid],
        chord: chordDir,
        span,
        area,
        foil,
        wing: true,
        // aileron: right stick -> right aileron up (less lift) -> roll right
        controls: isAileron ? [{ input: 'roll', gain: -side, max: 18 * deg, tau: 0.42 }] : [],
        propwash: i === 0 && name === 'lower' ? 0.4 : 0,
      });
    }
  }
  return panels;
}

function tailPanels() {
  const t = geometry.tail;
  const f = geometry.fin;
  const tailAr = (t.span * t.span) / (t.span * t.chord);
  const tailFoil = { ...airfoil(tailAr), alpha0: 0, alphaStall: 16 * deg, cla: liftSlope(tailAr) };
  const panels = [];
  for (const side of [-1, 1]) {
    panels.push({
      name: `stab-${side > 0 ? 'R' : 'L'}`,
      pos: [t.leX - t.chord * 0.25, t.y, side * t.span * 0.25],
      chord: [Math.cos(t.incidence), Math.sin(t.incidence), 0],
      span: [0, 0, 1],
      area: (t.span / 2) * t.chord * 0.92,
      foil: tailFoil,
      downwash: true,
      propwash: 0.75,
      controls: [{ input: 'pitch', gain: -1, max: 22 * deg, tau: 0.5 }],
    });
  }
  const finAr = 1.4;
  panels.push({
    name: 'fin',
    pos: [f.leX - f.chord * 0.3, f.baseY + f.height * 0.4, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0], // normal = +z (right)
    area: f.chord * f.height * 0.95,
    foil: { ...airfoil(finAr), alpha0: 0, alphaStall: 20 * deg, cla: liftSlope(finAr) },
    propwash: 0.8,
    controls: [{ input: 'yaw', gain: -1, max: 28 * deg, tau: 0.55 }],
  });
  // Fuselage side area: weak, low aspect-ratio surface, slightly ahead of CG.
  panels.push({
    name: 'fuselage-side',
    pos: [0.05, 0.0, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0],
    area: 0.16,
    foil: { cla: liftSlope(0.4), alpha0: 0, alphaStall: 25 * deg, cd0: 0.02, ar: 0.4, e: 0.5 },
    controls: [],
  });
  // Fuselage plan area (top/bottom): adds a little pitch damping.
  panels.push({
    name: 'fuselage-plan',
    pos: [-0.1, 0.0, 0],
    chord: [1, 0, 0],
    span: [0, 0, 1],
    area: 0.12,
    foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.0, ar: 0.3, e: 0.5 },
    controls: [],
  });
  return panels;
}

export const SE5a = {
  name: 'S.E.5a (1/5 scale)',
  mass: 2.2, // kg
  inertia: [0.14, 0.24, 0.11], // Ixx (roll), Iyy (yaw), Izz (pitch) kg·m²
  // Parasite drag of everything not modelled as a surface: struts, wires,
  // radiator, undercarriage, guns... as an equivalent flat-plate area (m²).
  parasite: { x: 0.022, y: 0.08, z: 0.06 },
  surfaces: [
    ...wingPanels('upper', UPPER_LE_X, UPPER_Y, 0.0, 3, 0.4),
    ...wingPanels('lower', LOWER_LE_X, LOWER_Y, geometry.lowerRootZ, 3, 0.4),
    ...tailPanels(),
  ],
  wingAspectRatio: WING_AR,
  wingArea: 2 * SPAN * CHORD,
  downwashGain: 0.9, // scales classical 2·CL/(π·AR) downwash at the tail
  motor: {
    staticThrust: 17,   // N at full throttle (≈0.8 thrust/weight)
    pitchSpeed: 30,     // m/s, thrust → 0 at this airspeed
    spoolTime: 0.12,    // s, throttle lag
    torqueFactor: 0.008, // N·m of reaction torque per N of thrust
    maxRpm: 8500,
    position: [geometry.prop.x, geometry.prop.y, 0],
    discArea: Math.PI * geometry.prop.radius ** 2,
  },
  battery: {
    cells: 4,
    capacity: 3300,     // mAh
    maxCurrent: 45,     // A at full throttle
    internalResistance: 0.012 * 4, // Ω whole pack
  },
  // Ground contact points (body frame). type: wheel | skid | hard
  contacts: [
    { name: 'wheel-L', pos: [geometry.wheel.x, geometry.wheel.y - geometry.wheel.radius, -geometry.wheel.z], type: 'wheel', k: 3500, c: 45, crashSpeed: 7 },
    { name: 'wheel-R', pos: [geometry.wheel.x, geometry.wheel.y - geometry.wheel.radius, geometry.wheel.z], type: 'wheel', k: 3500, c: 45, crashSpeed: 7 },
    { name: 'skid', pos: [geometry.skid.x, geometry.skid.y, 0], type: 'skid', k: 1500, c: 20, mu: 0.45, crashSpeed: 6 },
    { name: 'nose', pos: [0.40, -0.06, 0], type: 'hard', crashSpeed: 2.5 },
    { name: 'prop-low', pos: [geometry.prop.x + 0.02, geometry.prop.y - geometry.prop.radius, 0], type: 'prop', crashSpeed: 0 },
    { name: 'upper-tip-L', pos: [UPPER_LE_X - CHORD / 2, UPPER_Y + Math.tan(DIHEDRAL) * SPAN / 2, -SPAN / 2], type: 'hard', crashSpeed: 3.5 },
    { name: 'upper-tip-R', pos: [UPPER_LE_X - CHORD / 2, UPPER_Y + Math.tan(DIHEDRAL) * SPAN / 2, SPAN / 2], type: 'hard', crashSpeed: 3.5 },
    { name: 'lower-tip-L', pos: [LOWER_LE_X - CHORD / 2, LOWER_Y + Math.tan(DIHEDRAL) * SPAN / 2, -SPAN / 2], type: 'hard', crashSpeed: 3.5 },
    { name: 'lower-tip-R', pos: [LOWER_LE_X - CHORD / 2, LOWER_Y + Math.tan(DIHEDRAL) * SPAN / 2, SPAN / 2], type: 'hard', crashSpeed: 3.5 },
    { name: 'upper-centre', pos: [UPPER_LE_X - CHORD / 2, UPPER_Y + 0.02, 0], type: 'hard', crashSpeed: 2.5 },
    { name: 'fin-top', pos: [geometry.fin.leX - 0.1, geometry.fin.baseY + geometry.fin.height, 0], type: 'hard', crashSpeed: 2.5 },
    { name: 'tail-end', pos: [-0.88, 0.0, 0], type: 'hard', crashSpeed: 3 },
  ],
};
