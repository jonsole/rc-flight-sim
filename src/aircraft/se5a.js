// Royal Aircraft Factory S.E.5a RC models.
//
// One parametric layout covers every size of S.E.5a: the airframe is drawn in
// reference units (the full-size aircraft's proportions at 1/5 scale) and
// scaled to the model's span, so the 3D model and the flight model always
// share one geometry. Each variant supplies its own mass, power system, CG and
// handling numbers.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';
import { createSE5aModel } from './se5aModel.js';

const deg = Math.PI / 180;
const REF_SPAN = 1.62;
const REF_CHORD = 0.28;
const REF_STAGGER = 0.06;

/** Reference layout, with the wings placed for a given CG position. */
function referenceLayout(cgFromUpperLeRef) {
  const upperLeX = cgFromUpperLeRef;
  return {
    span: REF_SPAN,
    chord: REF_CHORD,
    stagger: REF_STAGGER,
    lowerLeX: upperLeX - REF_STAGGER,
    upperLeX,
    lowerY: -0.10,
    upperY: 0.17,
    dihedral: 4.5 * deg,
    incidence: 2.0 * deg,
    lowerRootZ: 0.08,
    tail: { leX: -0.64, chord: 0.2, span: 0.66, y: 0.03, incidence: 2.5 * deg },
    fin: { leX: -0.70, chord: 0.19, height: 0.24, baseY: 0.04 },
    prop: { x: 0.43, y: 0.02, radius: 0.185 },
    wheel: { x: 0.2, y: -0.2, z: 0.15, radius: 0.07 },
    skid: { x: -0.80, y: -0.10 },
    pilotEye: { x: -0.21, y: 0.158, z: 0 },
  };
}

function scaleLayout(r, k) {
  const angle = new Set(['dihedral', 'incidence']);
  const out = {};
  for (const [key, v] of Object.entries(r)) {
    if (typeof v === 'object') {
      out[key] = {};
      for (const [k2, v2] of Object.entries(v)) out[key][k2] = angle.has(k2) ? v2 : v2 * k;
    } else out[key] = angle.has(key) ? v : v * k;
  }
  return out;
}

/**
 * Build an S.E.5a variant.
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.name
 * @param {string} o.summary        one-line spec for the menu
 * @param {number} o.span           m
 * @param {number} o.cgFromUpperLe  m behind the top-wing leading edge
 * @param {number} o.mass           kg, ready to fly
 * @param {number[]} o.inertia      [Ixx roll, Iyy yaw, Izz pitch] kg·m²
 * @param {number} o.propRadius     m
 * @param {object} o.foil           { cd0, alphaStall (rad) }
 * @param {object} o.motor          { staticThrust, pitchSpeed, spoolTime, torqueFactor, maxRpm }
 * @param {object} o.battery        { cells, capacity, maxCurrent, internalResistance }
 * @param {object} o.gear           { wheelK, wheelC, skidK, skidC, hardK, hardC, wheelCrash, skidCrash }
 * @param {object} [o.trim]         { roll, pitch, yaw } stick units
 * @param {string} [o.defaultAssist] 'off' | 'as3x' | 'safe'
 * @param {number} [o.upperWingDihedralEffect] extra effective dihedral of the upper wing (rad)
 */
export function buildSE5a(o) {
  const k = o.span / REF_SPAN;
  const s = (v) => v * k;
  const s2 = (v) => v * k * k;

  const ref = referenceLayout(o.cgFromUpperLe / k);
  ref.prop.radius = o.propRadius / k;
  const G = scaleLayout(ref, k);

  const SPAN = G.span;
  const CHORD = G.chord;
  const DIHEDRAL = G.dihedral;
  const INCIDENCE = G.incidence;
  const WING_AR = SPAN / CHORD;
  const upperBonus = o.upperWingDihedralEffect ?? 0;

  const airfoil = (ar, extra = {}) => ({
    cla: liftSlope(ar) * 0.92, // biplane interference
    alpha0: -2.5 * deg,        // cambered section
    alphaStall: o.foil.alphaStall,
    stallWidth: o.foil.stallWidth,
    cd0: o.foil.cd0,
    ar,
    e: 0.8,
    ...extra,
  });

  function wingPanels(name, leX, y, rootZ, segments, aileronFrom) {
    const panels = [];
    const half = SPAN / 2;
    const segSpan = (half - rootZ) / segments;
    const qcX = leX - CHORD * 0.25;
    const foil = airfoil(WING_AR);
    for (const side of [-1, 1]) {
      for (let i = 0; i < segments; i++) {
        const zMid = rootZ + segSpan * (i + 0.5);
        panels.push({
          name: `${name}-${side > 0 ? 'R' : 'L'}${i}`,
          pos: [qcX, y + Math.tan(DIHEDRAL) * zMid, side * zMid],
          chord: [Math.cos(INCIDENCE), Math.sin(INCIDENCE), 0],
          // Spanwise vector always points to +z; for the left wing that's inboard.
          // Aerodynamic dihedral: geometric, plus the "high wing" effect of the
          // upper wing sitting well above the CG (adds roll stability).
          span: [0, side * Math.sin(DIHEDRAL + (name === 'upper' ? upperBonus : 0)), Math.cos(DIHEDRAL + (name === 'upper' ? upperBonus : 0))],
          // Rounded tips: the tip segment has a little less area.
          area: segSpan * CHORD * (i === segments - 1 ? 0.9 : 1),
          foil,
          wing: true,
          chordLen: CHORD,
          // right stick -> right aileron up (less lift) -> roll right
          controls: zMid >= aileronFrom ? [{ input: 'roll', gain: -side, max: 18 * deg, tau: 0.42 }] : [],
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
        // Sport/low-rate throw: enough for loops without snapping at full stick.
        controls: [{ input: 'pitch', gain: -1, max: o.elevatorThrow, tau: 0.5 }],
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

  const gr = o.gear;
  const tipY = (y) => y + Math.tan(DIHEDRAL) * SPAN / 2;
  const hard = (name, pos, crashSpeed) => ({ name, pos, type: 'hard', k: gr.hardK, c: gr.hardC, crashSpeed });

  const def = {
    name: o.name,
    mass: o.mass,
    inertia: o.inertia,
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
    wingSpan: SPAN,
    downwashGain: 0.9, // scales classical 2·CL/(π·AR) downwash at the tail
    motor: {
      ...o.motor,
      position: [G.prop.x, G.prop.y, 0],
      discArea: Math.PI * G.prop.radius ** 2,
    },
    battery: o.battery,
    trim: o.trim || {},
    // AS3X / SAFE style flight assist (see Aircraft#assist). Gains are in stick
    // units, so they suit any size of S.E.5a.
    assist: {
      rateGain: { roll: 0.06, pitch: 0.07, yaw: 0.08 },
      refSpeed: 11,
      maxBank: 45 * deg,
      maxPitch: 30 * deg,
      levelGain: { roll: 1.6, pitch: 1.8 },
    },
    // Ground contact points (body frame). type: wheel | skid | hard | prop
    contacts: [
      { name: 'wheel-L', pos: [G.wheel.x, G.wheel.y - G.wheel.radius, -G.wheel.z], type: 'wheel', k: gr.wheelK, c: gr.wheelC, crashSpeed: gr.wheelCrash },
      { name: 'wheel-R', pos: [G.wheel.x, G.wheel.y - G.wheel.radius, G.wheel.z], type: 'wheel', k: gr.wheelK, c: gr.wheelC, crashSpeed: gr.wheelCrash },
      // The skid slides forwards (mu) but digs into the grass sideways (muLat),
      // and is linked to the rudder (steer), as on most RC scale models.
      { name: 'skid', pos: [G.skid.x, G.skid.y, 0], type: 'skid', k: gr.skidK, c: gr.skidC, mu: 0.35, muLat: 0.9, steer: gr.skidSteer ?? 0, crashSpeed: gr.skidCrash },
      { name: 'prop-low', pos: [G.prop.x + s(0.02), G.prop.y - G.prop.radius, 0], type: 'prop', k: gr.hardK, c: gr.hardC, crashSpeed: 0 },
      hard('nose', [s(0.40), s(-0.06), 0], 2.5),
      hard('upper-tip-L', [G.upperLeX - CHORD / 2, tipY(G.upperY), -SPAN / 2], 3.5),
      hard('upper-tip-R', [G.upperLeX - CHORD / 2, tipY(G.upperY), SPAN / 2], 3.5),
      hard('lower-tip-L', [G.lowerLeX - CHORD / 2, tipY(G.lowerY), -SPAN / 2], 3.5),
      hard('lower-tip-R', [G.lowerLeX - CHORD / 2, tipY(G.lowerY), SPAN / 2], 3.5),
      hard('upper-centre', [G.upperLeX - CHORD / 2, G.upperY + s(0.02), 0], 2.5),
      hard('fin-top', [G.fin.leX - s(0.1), G.fin.baseY + G.fin.height, 0], 2.5),
      hard('tail-end', [s(-0.88), 0, 0], 3),
    ],
  };

  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    defaultAssist: o.defaultAssist || 'off',
    def,
    geometry: G,
    // Camera mounts and framing, in metres (body frame).
    views: {
      span: SPAN,
      cockpit: [G.pilotEye.x, G.pilotEye.y, G.pilotEye.z],
      pod: [G.upperLeX - s(0.09), G.upperY + s(0.09), 0],
      chase: { back: SPAN * 2.0 + 0.3, up: SPAN * 0.5 + 0.15 },
    },
    createModel: () => createSE5aModel(ref, k),
  };
}

// --- Variants ---------------------------------------------------------------

/**
 * E-flite S.E.5a 900mm (EFL10950 BNF / EFL10975 PNP), ~1/9 scale foam.
 * Published: span 899 mm, length 716 mm, 1303 g with battery, 3513-1100Kv,
 * 10x5 prop, 45 A ESC, 3S/4S 2200–3200 mAh, CG 72 mm (±5) behind the top-wing
 * leading edge, AS3X+ and SAFE Select. Estimated: wing area (~0.28 m², scale
 * outline), inertia, airfoil and drag figures, thrust curve.
 */
export const EFLITE_SE5a_900 = buildSE5a({
  id: 'eflite-se5a-900',
  name: 'E-flite S.E.5a 900mm',
  summary: 'E-flite foam BNF — 899 mm span, 1.3 kg on 4S 2200 mAh, 3513-1100Kv, 10x5 prop, AS3X+/SAFE.',
  span: 0.899,
  cgFromUpperLe: 0.072,
  mass: 1.303,
  inertia: [0.026, 0.044, 0.02],
  propRadius: 0.127,
  foil: { cd0: 0.02, alphaStall: 14 * deg, stallWidth: 0.03 }, // foam wing: softish stall
  elevatorThrow: 16 * deg,
  // 3513-1100Kv on 4S with a 10x5: ~12,500 rpm loaded, ≈1.25:1 thrust/weight.
  motor: { staticThrust: 16, pitchSpeed: 26, spoolTime: 0.08, torqueFactor: 0.0055, maxRpm: 12500 },
  battery: { cells: 4, capacity: 2200, maxCurrent: 38, internalResistance: 0.015 * 4 },
  gear: { wheelK: 2000, wheelC: 20, skidK: 900, skidC: 9, hardK: 2500, hardC: 20, wheelCrash: 6, skidCrash: 5, skidSteer: 20 * deg },
  trim: { roll: 0.002 }, // aileron trim against motor torque at cruise
  upperWingDihedralEffect: 5 * deg, // top wing well above the CG acts like a high wing
  defaultAssist: 'as3x',
});
