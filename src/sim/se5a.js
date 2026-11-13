// E-flite S.E.5a 900mm (EFL10950 BNF / EFL10975 PNP) — a ~1/9 scale foam
// park-flyer of the Royal Aircraft Factory S.E.5a.
//
// Published specs: span 899 mm, length 716 mm, 1303 g with battery,
// Spektrum 3513-1100Kv outrunner, 10x5 prop, 45 A ESC, 3S/4S 2200–3200 mAh,
// CG 72 mm (±5) behind the top-wing leading edge, AS3X+ and SAFE Select.
// Not published (estimated here): wing area (~0.28 m², scale outline),
// inertia, airfoil and drag figures, thrust curve.
//
// The layout below is drawn in reference units (the proportions of the full-
// size aircraft at 1/5 scale) and scaled by SCALE to the 900 mm model, so the
// 3D model and the flight model share one geometry.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from './aero.js';

const deg = Math.PI / 180;

const REF_SPAN = 1.62;
export const SCALE = 0.899 / REF_SPAN;
const s = (v) => v * SCALE;     // length
const s2 = (v) => v * SCALE * SCALE; // area

const CG_FROM_UPPER_LE = 0.072; // m, from the E-flite manual

// --- Reference layout (1/5 proportions; the 3D model is built from these) ---
const REF_CHORD = 0.28;
const REF_STAGGER = 0.06;
const REF_UPPER_LE_X = CG_FROM_UPPER_LE / SCALE;
const REF_LOWER_LE_X = REF_UPPER_LE_X - REF_STAGGER;

export const refGeometry = {
  span: REF_SPAN,
  chord: REF_CHORD,
  stagger: REF_STAGGER,
  lowerLeX: REF_LOWER_LE_X,
  upperLeX: REF_UPPER_LE_X,
  lowerY: -0.10,
  upperY: 0.17,
  dihedral: 4.5 * deg,
  incidence: 2.0 * deg,
  lowerRootZ: 0.08,
  tail: { leX: -0.64, chord: 0.2, span: 0.66, y: 0.03, incidence: 2.5 * deg },
  fin: { leX: -0.70, chord: 0.19, height: 0.24, baseY: 0.04 },
  prop: { x: 0.43, y: 0.02, radius: 0.127 / SCALE }, // 10" prop
  wheel: { x: 0.2, y: -0.2, z: 0.15, radius: 0.07 },
  skid: { x: -0.80, y: -0.10 },
  pilotEye: { x: -0.21, y: 0.158, z: 0 },
};

// --- Real-size geometry (metres) ------------------------------------------
function scaleGeometry(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'object') {
      out[k] = {};
      for (const [k2, v2] of Object.entries(v)) out[k][k2] = k2 === 'incidence' ? v2 : s(v2);
    } else out[k] = ['dihedral', 'incidence'].includes(k) ? v : s(v);
  }
  return out;
}
export const geometry = scaleGeometry(refGeometry);

const G = geometry;
const SPAN = G.span;
const CHORD = G.chord;
const DIHEDRAL = G.dihedral;
const WING_INCIDENCE = G.incidence;
const WING_AR = (SPAN * SPAN) / (SPAN * CHORD);

function airfoil(ar, extra = {}) {
  return {
    cla: liftSlope(ar) * 0.92, // biplane interference
    alpha0: -2.5 * deg,        // cambered section
    alphaStall: 14 * deg,      // from zero-lift; cambered foam wing
    cd0: 0.02,
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
      // Spanwise vector always points to +z (right); for the left wing that's inboard.
      const span = [0, side * Math.sin(DIHEDRAL), Math.cos(DIHEDRAL)];
      const chordDir = [Math.cos(WING_INCIDENCE), Math.sin(WING_INCIDENCE), 0];
      const isAileron = zMid >= aileronFrom;
      panels.push({
        name: `${name}-${side > 0 ? 'R' : 'L'}${i}`,
        pos: [qcX, y + Math.tan(DIHEDRAL) * zMid, side * zMid],
        chord: chordDir,
        span,
        area,
        foil,
        wing: true,
        // right stick -> right aileron up (less lift) -> roll right
        controls: isAileron ? [{ input: 'roll', gain: -side, max: 18 * deg, tau: 0.42 }] : [],
        propwash: i === 0 && name === 'lower' ? 0.4 : 0,
      });
    }
  }
  return panels;
}

function tailPanels() {
  const t = G.tail;
  const f = G.fin;
  const tailAr = t.span / t.chord;
  const tailFoil = { ...airfoil(tailAr), alpha0: 0, alphaStall: 15 * deg, cla: liftSlope(tailAr) };
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
    pos: [s(0.05), 0, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0],
    area: s2(0.16),
    foil: { cla: liftSlope(0.4), alpha0: 0, alphaStall: 25 * deg, cd0: 0.02, ar: 0.4, e: 0.5 },
    controls: [],
  });
  // Fuselage plan area (top/bottom): adds a little pitch damping.
  panels.push({
    name: 'fuselage-plan',
    pos: [s(-0.1), 0, 0],
    chord: [1, 0, 0],
    span: [0, 0, 1],
    area: s2(0.12),
    foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.0, ar: 0.3, e: 0.5 },
    controls: [],
  });
  return panels;
}

const tipY = (y) => y + Math.tan(DIHEDRAL) * SPAN / 2;

export const SE5a = {
  name: 'E-flite S.E.5a 900mm',
  mass: 1.303, // kg, with 4S 2200 mAh pack
  inertia: [0.026, 0.044, 0.02], // Ixx (roll), Iyy (yaw), Izz (pitch) kg·m² (estimated)
  // Parasite drag of everything not modelled as a surface: struts, wires,
  // radiator, undercarriage, guns... as an equivalent flat-plate area (m²).
  parasite: { x: s2(0.024), y: s2(0.08), z: s2(0.06) },
  surfaces: [
    ...wingPanels('upper', G.upperLeX, G.upperY, 0.0, 3, s(0.4)),
    ...wingPanels('lower', G.lowerLeX, G.lowerY, G.lowerRootZ, 3, s(0.4)),
    ...tailPanels(),
  ],
  wingAspectRatio: WING_AR,
  wingArea: 2 * SPAN * CHORD,
  downwashGain: 0.9, // scales classical 2·CL/(π·AR) downwash at the tail
  motor: {
    // 3513-1100Kv on 4S with a 10x5: ~12,500 rpm loaded.
    staticThrust: 16,    // N (≈1.25 thrust/weight)
    pitchSpeed: 26,      // m/s (5" pitch × rpm), thrust → 0 here
    spoolTime: 0.08,     // s, throttle lag
    torqueFactor: 0.0055, // N·m of reaction torque per N of thrust
    maxRpm: 12500,
    position: [G.prop.x, G.prop.y, 0],
    discArea: Math.PI * G.prop.radius ** 2,
  },
  battery: {
    cells: 4,
    capacity: 2200,      // mAh
    maxCurrent: 38,      // A at full throttle (45 A ESC)
    internalResistance: 0.015 * 4, // Ω whole pack
  },
  // Aileron trim against motor torque at cruise power.
  trim: { roll: 0.007 },
  // AS3X+ / SAFE Select style flight assist (see Aircraft#assist).
  assist: {
    rateGain: { roll: 0.06, pitch: 0.07, yaw: 0.08 }, // stick per rad/s at reference speed
    refSpeed: 11,          // m/s at which rateGain applies; scales with 1/V²
    maxBank: 45 * deg,     // SAFE angle limits
    maxPitch: 30 * deg,
    levelGain: { roll: 1.6, pitch: 1.8 }, // stick per rad of attitude error
  },
  // Ground contact points (body frame). type: wheel | skid | hard | prop
  contacts: [
    { name: 'wheel-L', pos: [G.wheel.x, G.wheel.y - G.wheel.radius, -G.wheel.z], type: 'wheel', k: 2000, c: 20, crashSpeed: 6 },
    { name: 'wheel-R', pos: [G.wheel.x, G.wheel.y - G.wheel.radius, G.wheel.z], type: 'wheel', k: 2000, c: 20, crashSpeed: 6 },
    { name: 'skid', pos: [G.skid.x, G.skid.y, 0], type: 'skid', k: 900, c: 9, mu: 0.45, crashSpeed: 5 },
    { name: 'nose', pos: [s(0.40), s(-0.06), 0], type: 'hard', k: 2500, c: 20, crashSpeed: 2.5 },
    { name: 'prop-low', pos: [G.prop.x + s(0.02), G.prop.y - G.prop.radius, 0], type: 'prop', k: 2500, c: 20, crashSpeed: 0 },
    { name: 'upper-tip-L', pos: [G.upperLeX - CHORD / 2, tipY(G.upperY), -SPAN / 2], type: 'hard', k: 2500, c: 20, crashSpeed: 3.5 },
    { name: 'upper-tip-R', pos: [G.upperLeX - CHORD / 2, tipY(G.upperY), SPAN / 2], type: 'hard', k: 2500, c: 20, crashSpeed: 3.5 },
    { name: 'lower-tip-L', pos: [G.lowerLeX - CHORD / 2, tipY(G.lowerY), -SPAN / 2], type: 'hard', k: 2500, c: 20, crashSpeed: 3.5 },
    { name: 'lower-tip-R', pos: [G.lowerLeX - CHORD / 2, tipY(G.lowerY), SPAN / 2], type: 'hard', k: 2500, c: 20, crashSpeed: 3.5 },
    { name: 'upper-centre', pos: [G.upperLeX - CHORD / 2, G.upperY + s(0.02), 0], type: 'hard', k: 2500, c: 20, crashSpeed: 2.5 },
    { name: 'fin-top', pos: [G.fin.leX - s(0.1), G.fin.baseY + G.fin.height, 0], type: 'hard', k: 2500, c: 20, crashSpeed: 2.5 },
    { name: 'tail-end', pos: [s(-0.88), 0, 0], type: 'hard', k: 2500, c: 20, crashSpeed: 3 },
  ],
};
