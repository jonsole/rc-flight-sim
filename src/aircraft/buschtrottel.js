// Buschtrottel: Thomas Buchwald's 6 mm Depron bush plane (Flugmodell, 2020),
// in its three published styles:
//   ShockCub   - high wing, rounded tail and tips
//   Highlander - high wing, angular tail and square tips
//   Agro       - low wing with V-struts to the upper fuselage, angular tail
//
// Published: ~900 mm span, ~730-755 mm long, ~430 g, KFm2 airfoil,
// 19.8 g/dm² wing loading (≈ 22 dm² wing area), 2814-class motor on 3S.
// This build: T-Motor AT2308 1450Kv on 3S 1350 mAh, fixed leading-edge slats,
// no gyro. Assumed: 8x4 prop, 450 g
// ready to fly, tail-dragger with a rudder-linked tail wheel. Chord, tail
// sizes, CG and inertia are estimates from the published figures.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';
import { Group } from 'three';
import { createBuschtrottelModel } from './buschtrottelModel.js';

const deg = Math.PI / 180;

/** Shared layout; `style` picks the variant differences. */
function layout(style) {
  const high = style.mount === 'high';
  return {
    style,
    span: 0.9,
    chord: 0.24,
    wingLeX: 0.07,                 // CG ≈ 29% chord
    incidence: 2 * deg,
    wingY: high ? 0.075 : -0.065,  // underside of the wing at the root
    dihedral: (high ? 2 : 5) * deg, // as built (what you see)
    // Effective dihedral for the aerodynamics: a high wing adds stability
    // (≈ +10° here, tuned so it is close to spirally neutral like a real
    // Cub-type), a low wing gives less.
    aeroDihedral: (high ? 12 : 6) * deg,
    rootZ: high ? 0 : 0.04,        // low wing joins the fuselage side
    slats: style.slats ? { from: high ? 0.05 : 0.045, to: 0.42 } : null, // spanwise extent (m)
    hinge: 0.75,                   // aileron hinge, fraction of chord
    // Aileron inboard end (m from centreline): full span from the fuselage
    // side, or outboard ailerons only.
    ailFrom: style.fullSpanAilerons ? 0.041 : 0.15,
    thickFront: 0.012,             // KFm2: two 6 mm layers ahead of the step
    thickRear: 0.006,              //       one layer behind it
    step: 0.5,
    fuselage: high
      ? [[0.20, 0.03, -0.04, 0.035], [0.15, 0.037, -0.055, 0.05], [0.07, 0.04, -0.06, 0.075], [-0.17, 0.038, -0.055, 0.075], [-0.30, 0.025, -0.035, 0.045], [-0.50, 0.006, -0.008, 0.03]]
      : [[0.20, 0.03, -0.04, 0.035], [0.15, 0.037, -0.055, 0.045], [0.07, 0.04, -0.065, 0.05], [-0.17, 0.038, -0.06, 0.05], [-0.30, 0.025, -0.04, 0.04], [-0.50, 0.006, -0.008, 0.03]],
    tail: { leX: -0.36, chord: 0.13, fixed: 0.07, span: 0.34, y: 0.035, incidence: style.tailIncidence },
    fin: { leX: -0.37, baseY: 0.04, height: 0.13, chord: 0.15, hingeX: -0.44, bottomY: 0.04 },
    prop: { x: 0.235, y: 0.0, radius: 0.1016 }, // 8" prop
    wheel: { x: 0.12, y: -0.145, z: 0.09, radius: 0.035 },
    tailWheel: { x: -0.48, y: -0.033, radius: 0.012 },
  };
}

/** Planform scale factors for the shapes. */
const SHAPE_AREA = { round: 0.85, square: 0.97 };

export function buildBuschtrottel(style) {
  const L = layout(style);
  const SPAN = L.span;
  const CHORD = L.chord;
  const HALF = SPAN / 2;
  const AR = SPAN / CHORD;

  // Fixed leading-edge slats keep the flow attached to a much higher angle of
  // attack: the stall comes ~7° later and more gently, and maximum lift rises
  // by roughly half, for a little extra drag.
  const kfm2 = {
    cla: liftSlope(AR) * 0.95,
    alpha0: -3 * deg,
    alphaStall: (style.slats ? 20 : 13) * deg,
    stallWidth: style.slats ? 0.035 : 0.018,
    // Slats keep lift almost constant well past the stall, so a dropping wing
    // doesn't lose lift and autorotate: it mushes and the nose drops instead.
    stallDrop: style.slats ? 0.3 : 1.6,
    cd0: style.slats ? 0.036 : 0.03, // stepped foam section, exposed edges (+ slats)
    ar: AR,
    e: 0.75,
  };

  const wing = [];
  const segments = 3;
  const segSpan = (HALF - L.rootZ) / segments;
  const qcX = L.wingLeX - CHORD * 0.25;
  const yQc = L.wingY + 0.008;
  for (const side of [-1, 1]) {
    for (let i = 0; i < segments; i++) {
      const zMid = L.rootZ + segSpan * (i + 0.5);
      const tip = i === segments - 1;
      wing.push({
        name: `wing-${side > 0 ? 'R' : 'L'}${i}`,
        pos: [qcX, yQc + Math.tan(L.dihedral) * zMid, side * zMid],
        chord: [Math.cos(L.incidence), Math.sin(L.incidence), 0],
        span: [0, side * Math.sin(L.aeroDihedral), Math.cos(L.aeroDihedral)],
        area: segSpan * CHORD * (tip ? (style.tips === 'round' ? 0.85 : 0.97) : 1),
        foil: kfm2,
        wing: true,
        chordLen: CHORD,
        controls: zMid >= L.ailFrom ? [{ input: 'roll', gain: -side, max: 20 * deg, tau: 0.45 }] : [],
        propwash: i === 0 ? 0.35 : 0,
      });
    }
  }

  const t = L.tail;
  const tailAr = t.span / t.chord;
  const tailArea = t.span * t.chord * SHAPE_AREA[style.tail];
  const tailFoil = { cla: liftSlope(tailAr), alpha0: 0, alphaStall: 16 * deg, cd0: 0.025, ar: tailAr, e: 0.75 };
  const tail = [-1, 1].map((side) => ({
    name: `stab-${side > 0 ? 'R' : 'L'}`,
    pos: [t.leX - t.chord * 0.3, t.y, side * t.span * 0.25],
    chord: [Math.cos(t.incidence), Math.sin(t.incidence), 0],
    span: [0, 0, 1],
    area: tailArea / 2,
    foil: tailFoil,
    downwash: true,
    propwash: 0.8,
    // Sport throw (~14°): loops easily without stalling at full stick.
    controls: [{ input: 'pitch', gain: -1, max: 14 * deg, tau: 0.55 }],
  }));

  const f = L.fin;
  const finH = f.height + (f.baseY - f.bottomY) * 0.5;
  const finAr = 1.3;
  const fin = {
    name: 'fin',
    pos: [f.leX - f.chord * 0.4, f.baseY + f.height * 0.35, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0], // normal = +z (right)
    area: finH * f.chord * SHAPE_AREA[style.tail],
    foil: { cla: liftSlope(finAr), alpha0: 0, alphaStall: 20 * deg, cd0: 0.025, ar: finAr, e: 0.7 },
    propwash: 0.85,
    controls: [{ input: 'yaw', gain: -1, max: 30 * deg, tau: 0.6 }],
  };

  const body = [
    {
      name: 'fuselage-side',
      pos: [0.0, 0, 0],
      chord: [1, 0, 0],
      span: [0, -1, 0],
      area: 0.065,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.02, ar: 0.3, e: 0.5 },
      controls: [],
    },
    {
      name: 'fuselage-plan',
      pos: [-0.12, 0, 0],
      chord: [1, 0, 0],
      span: [0, 0, 1],
      area: 0.045,
      foil: { cla: liftSlope(0.3), alpha0: 0, alphaStall: 25 * deg, cd0: 0.0, ar: 0.3, e: 0.5 },
      controls: [],
    },
  ];

  const tipY = L.wingY + 0.01 + Math.tan(L.dihedral) * HALF;
  const tipX = L.wingLeX - CHORD / 2;
  const hard = (name, pos, crashSpeed = 4) => ({ name, pos, type: 'hard', k: 1000, c: 8, crashSpeed });
  const W = L.wheel;
  const TW = L.tailWheel;

  const def = {
    name: style.name,
    mass: style.mass,
    inertia: [0.010, 0.020, 0.012], // roll, yaw, pitch (estimated)
    parasite: { x: style.mount === 'low' ? 0.010 : 0.009, y: 0.03, z: 0.04 },
    surfaces: [...wing, ...tail, fin, ...body],
    wingAspectRatio: AR,
    wingArea: SPAN * CHORD,
    wingSpan: SPAN,
    downwashGain: 0.9,
    motor: {
      // AT2308 1450Kv on 3S with an 8x4: ~12,000 rpm loaded.
      staticThrust: 6.5, // N (≈1.5:1 thrust/weight)
      pitchSpeed: 20,    // m/s
      spoolTime: 0.06,
      torqueFactor: 0.002, // net of slipstream swirl, which offsets part of the torque
      // Downthrust stops the nose rising with power (as on real Cubs).
      downThrust: 3 * deg,
      // No right thrust: it exists to cancel prop swirl/P-factor, which aren't
      // modelled, so here it would yaw the model right in slow, powered flight.
      rightThrust: 0,
      maxRpm: 12000,
      position: [L.prop.x, L.prop.y, 0],
      discArea: Math.PI * L.prop.radius ** 2,
    },
    battery: { cells: 3, capacity: 1350, maxCurrent: 17, internalResistance: 0.02 * 3 },
    trim: { roll: style.rollTrim }, // aileron trim for hands-off cruise
    assist: {
      rateGain: { roll: 0.05, pitch: 0.06, yaw: 0.07 },
      refSpeed: 8,
      maxBank: 45 * deg,
      maxPitch: 30 * deg,
      levelGain: { roll: 1.5, pitch: 1.7 },
    },
    contacts: [
      { name: 'wheel-L', pos: [W.x, W.y - W.radius, -W.z], type: 'wheel', k: 900, c: 8, crashSpeed: 5 },
      { name: 'wheel-R', pos: [W.x, W.y - W.radius, W.z], type: 'wheel', k: 900, c: 8, crashSpeed: 5 },
      { name: 'tail-wheel', pos: [TW.x, TW.y - TW.radius, 0], type: 'wheel', k: 500, c: 5, crashSpeed: 4, steer: 25 * deg },
      { name: 'prop-low', pos: [L.prop.x + 0.005, L.prop.y - L.prop.radius, 0], type: 'prop', k: 1000, c: 8, crashSpeed: 0 },
      hard('nose', [0.2, -0.04, 0], 3),
      hard('wing-tip-L', [tipX, tipY, -HALF]),
      hard('wing-tip-R', [tipX, tipY, HALF]),
      hard('wing-top', [L.wingLeX - CHORD * 0.3, L.wingY + 0.015, 0], 3),
      hard('cabin-top', [0.0, Math.max(...L.fuselage.map((s) => s[3])), 0], 3),
      hard('fin-top', [f.leX - 0.05, f.baseY + f.height, 0], 3),
      hard('tail-end', [-0.5, 0.0, 0], 3.5),
    ],
  };

  // The layout is drawn with the origin at mid-fuselage height. A low-wing
  // model carries its CG lower (wing and battery sit low), so shift the whole
  // airframe up relative to the CG: physics positions, camera mounts and the
  // 3D model alike.
  const cgDrop = style.cgDrop || 0;
  if (cgDrop) {
    for (const srf of def.surfaces) srf.pos = [srf.pos[0], srf.pos[1] + cgDrop, srf.pos[2]];
    for (const c of def.contacts) c.pos = [c.pos[0], c.pos[1] + cgDrop, c.pos[2]];
    def.motor.position = [def.motor.position[0], def.motor.position[1] + cgDrop, 0];
  }
  const up = (v) => [v[0], v[1] + cgDrop, v[2]];

  const high = style.mount === 'high';
  return {
    id: style.id,
    name: style.name,
    summary: style.summary,
    defaultAssist: 'off',
    def,
    geometry: L,
    views: {
      span: SPAN,
      // High wing: from the cabin under the wing. Agro: inside its canopy.
      cockpit: up(high ? [0.04, 0.058, 0] : [-0.12, 0.085, 0]),
      // Wing-top pod (high wing) or a nose-top camera (low wing).
      pod: up(high ? [0.05, L.wingY + 0.04, 0] : [0.17, 0.065, 0]),
      chase: { back: SPAN * 2.0 + 0.3, up: SPAN * 0.5 + 0.15 },
    },
    createModel: () => {
      const m = createBuschtrottelModel(L);
      if (cgDrop) {
        const inner = m.root;
        const outer = new Group();
        inner.position.y = cgDrop;
        outer.add(inner);
        return { ...m, root: outer };
      }
      return m;
    },
  };
}

const COMMON = 'Fixed LE slats. AT2308 1450Kv, 8x4, 3S 1350 mAh, ~450 g.';

export const BUSCHTROTTEL_SHOCKCUB = buildBuschtrottel({
  id: 'buschtrottel-shockcub',
  name: 'Buschtrottel ShockCub',
  summary: `DIY 6 mm Depron bush plane, 900 mm. High wing, rounded tail. ${COMMON}`,
  mount: 'high',
  tips: 'round',
  tail: 'round',
  slats: true,
  mass: 0.45,
  tailIncidence: 3 * deg,
  rollTrim: 0,
  colors: { main: '#f2c230', accent: '#1d1d1d', wing: '#f2c230', tail: '#f2c230' },
});

export const BUSCHTROTTEL_HIGHLANDER = buildBuschtrottel({
  id: 'buschtrottel-highlander',
  name: 'Buschtrottel Highlander',
  summary: `DIY 6 mm Depron bush plane, 900 mm. High wing, angular tail, square tips. ${COMMON}`,
  mount: 'high',
  tips: 'square',
  tail: 'square',
  slats: true,
  mass: 0.45,
  tailIncidence: 3 * deg,
  rollTrim: 0,
  colors: { main: '#efefea', accent: '#c62828', wing: '#efefea', tail: '#c62828' },
});

export const BUSCHTROTTEL_AGRO = buildBuschtrottel({
  id: 'buschtrottel-agro',
  name: 'Buschtrottel Agro',
  summary: `DIY 6 mm Depron, 900 mm. Low wing with struts, full-span ailerons, framed glass cab, angular tail. ${COMMON}`,
  mount: 'low',
  fullSpanAilerons: true,
  tips: 'square',
  tail: 'square',
  slats: true,
  mass: 0.46,
  tailIncidence: 2 * deg,
  cgDrop: 0.03, // CG 3 cm lower in the airframe than the high-wing versions
  rollTrim: 0,
  // Orange and white: top third of the fuselage, tail and wing tops orange;
  // lower fuselage and wing undersides white; sky-blue ailerons.
  colors: { main: '#f4f4ef', top: '#f26b1d', split: 2 / 3, wing: '#f26b1d', wingBottom: '#f4f4ef', aileron: '#7cc6ee', tail: '#f26b1d' },
});
