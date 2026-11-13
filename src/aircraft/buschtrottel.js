// Buschtrottel: Thomas Buchwald's 6 mm Depron bush plane (Flugmodell, 2020),
// in its three published styles:
//   ShockCub   - high wing, rounded (elliptical) tail
//   Highlander - high wing, angular tail
//   Agro       - low wing with V-struts to the upper fuselage, angular tail
//
// Published: ~900 mm span, ~730-755 mm long, ~430 g, KFm2 airfoil,
// 19.8 g/dm² wing loading (≈ 22 dm² wing area), 2814-class motor on 3S.
// This build: T-Motor AT2308 1450Kv on 3S 1350 mAh, 8x6 prop (Agro: 8x4.5
// three-blade), fixed leading-edge slats, no gyro. Assumed: 450 g
// ready to fly, tail-dragger with a rudder-linked tail wheel. High-wing
// geometry (fuselage, 220 mm chord, CG, tail and tip shapes) is measured off
// the 1:1 plan retraced by Jivaro-models (2022); inertia is estimated.
//
// Body axes (metres, origin at the centre of gravity):
//   +x forward, +y up, +z right (right-handed).

import { liftSlope } from '../sim/aero.js';
import { Group } from 'three';
import { createBuschtrottelModel } from './buschtrottelModel.js';

const deg = Math.PI / 180;

/** Catmull-Rom through points (closed = false), for smooth outlines. */
function smooth(pts, n = 4) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Polygon area (shoelace). */
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * Tail outlines from the 1:1 plan (Jivaro-models retrace, 2022), in body axes:
 * fin as [x, y] (side view), stab as [x, z] (top view, both halves).
 * ShockCub: elliptical stab and rounded fin; Highlander/Agro: angular.
 * The elevator has a V cut-out at the centre for the rudder.
 */
function tailOutlines(round, dy) {
  const fin = (round
    ? [[-0.33, 0.02], ...smooth([[-0.345, 0.058], [-0.365, 0.09], [-0.395, 0.135], [-0.425, 0.178], [-0.455, 0.198], [-0.487, 0.19], [-0.51, 0.155], [-0.524, 0.095], [-0.527, 0.045], [-0.517, 0.01], [-0.49, -0.007], [-0.44, -0.012]])]
    : [[-0.33, 0.02], [-0.345, 0.058], [-0.43, 0.195], [-0.515, 0.19], [-0.545, 0.013], [-0.44, -0.012]]
  ).map(([x, y]) => [x, y + dy]);
  const hinge = -0.44;
  const half = 0.19;
  // Right half, LE from the centre out to the tip, then the TE back in.
  let le;
  let te;
  if (round) {
    const zs = Array.from({ length: 13 }, (_, i) => half * Math.sin((i / 12) * Math.PI / 2));
    le = zs.map((z) => [hinge + 0.095 * Math.sqrt(Math.max(0, 1 - (z / half) ** 2)), z]);
    te = zs.slice().reverse().map((z) => [hinge - 0.07 * Math.max(0, 1 - (z / half) ** 2) ** 0.3, z]);
  } else {
    le = [[-0.345, 0], [-0.378, half]];
    te = [[-0.484, half], [-0.512, 0.051]];
  }
  // Rudder cut-out in the elevator.
  te = te.filter(([, z]) => z > 0.051);
  if (round) te.push([hinge - 0.07 * (1 - (0.051 / half) ** 2) ** 0.3, 0.051]);
  te.push([-0.457, 0.009], [-0.457, 0]);
  const right = [...le, ...te.slice(0, -1)];
  const stab = [...right, ...right.slice().reverse().map(([x, z]) => [x, -z])];
  return { fin, stab, stabHinge: hinge, rudderHinge: -0.461 };
}

/** Shared layout; `style` picks the variant differences. */
function layout(style) {
  const high = style.mount === 'high';
  return {
    style,
    span: 0.9,
    // From the plan: 220 mm constant chord, CG 62 mm behind the LE.
    chord: high ? 0.22 : 0.24,
    wingLeX: high ? 0.062 : 0.07,  // CG ≈ 28% chord
    incidence: 2 * deg,
    wingY: high ? 0.094 : -0.065,  // underside of the wing at the root
    dihedral: (high ? 0 : 5) * deg, // as built (what you see); high wing: none
    // Effective dihedral for the aerodynamics: a high wing adds stability
    // (≈ +10° here, tuned so it is close to spirally neutral like a real
    // Cub-type), a low wing gives less.
    aeroDihedral: (high ? 12 : 6) * deg,
    rootZ: high ? 0 : 0.04,        // low wing joins the fuselage side
    slats: style.slats ? { from: high ? 0.05 : 0.045, to: 0.42 } : null, // spanwise extent (m)
    hinge: high ? 0.68 : 0.75,     // aileron hinge, fraction of chord (plan: 70 mm flaperons)
    // Aileron inboard end (m from centreline): full span from the fuselage
    // side, or outboard ailerons only.
    ailFrom: style.fullSpanAilerons ? (high ? 0.045 : 0.041) : 0.15,
    thickFront: 0.012,             // KFm2: two 6 mm layers ahead of the step
    thickRear: 0.006,              //       one layer behind it
    step: high ? 0.45 : 0.5,       // upper layer covers the front 45% (plan)
    fuselage: high
      // Stations: x, half-width, bottom, top, corner radius; measured off the
      // plan's side and top views. Small 68 x 40 mm firewall, the hood and
      // belly curving out to a deep (150 mm) cabin, a 45° windscreen up to
      // the wing, then straight lines to the sternpost.
      ? [[0.223, 0.03, -0.02, 0.004, 0.008], [0.215, 0.033, -0.03, 0.012, 0.008], [0.2, 0.034, -0.038, 0.027, 0.007], [0.185, 0.035, -0.045, 0.034, 0.006], [0.14, 0.037, -0.051, 0.039, 0.005], [0.105, 0.039, -0.056, 0.04, 0.004], [0.06, 0.04, -0.052, 0.085, 0.004], [0.05, 0.041, -0.0515, 0.091, 0.004], [0.015, 0.042, -0.0486, 0.094, 0.003], [-0.085, 0.0425, -0.039, 0.088, 0.003], [-0.165, 0.04, -0.032, 0.078, 0.003], [-0.265, 0.026, -0.022, 0.065, 0.003], [-0.345, 0.015, -0.0154, 0.055, 0.002], [-0.427, 0.005, -0.0076, 0.045, 0.002]]
      : [[0.215, 0.034, -0.045, 0.03, 0.018], [0.19, 0.039, -0.058, 0.04, 0.016], [0.14, 0.041, -0.064, 0.045, 0.01], [0.07, 0.041, -0.065, 0.05, 0.004], [-0.17, 0.038, -0.06, 0.05, 0.003], [-0.30, 0.025, -0.04, 0.04, 0.003], [-0.43, 0.006, -0.012, 0.033, 0.002]],
    outlines: tailOutlines(style.tail === 'round', style.lowTail ? -0.01 : 0),
    // Tailplane on top of the tail, or set into the fuselage side about 10 mm
    // below the top (Agro; the fuselage top there is at y ≈ 0.035).
    // Tailplane slotted through the fuselage about 10 mm below the top.
    tail: { leX: -0.345, chord: 0.165, fixed: 0.095, span: 0.38, y: style.lowTail ? 0.025 : 0.035, incidence: style.tailIncidence },
    fin: { leX: -0.345, hingeX: -0.461 },
    prop: { x: high ? 0.243 : 0.235, y: high ? -0.005 : 0, radius: 0.1016, blades: style.prop.blades, pitchIn: style.prop.pitchIn }, // 8" prop
    wheel: high ? { x: 0.085, y: -0.119, z: 0.09, radius: 0.05 } : { x: 0.12, y: -0.145, z: 0.09, radius: 0.05 }, // 100 mm foam wheels
    tailWheel: { x: -0.43, y: high ? -0.024 : -0.03, radius: 0.01 },
    // Tip plates ("saumons"), traced off the plan: a 176 mm lens with a notch
    // at the back to clear the aileron, centred vertically on the wing and
    // starting at the leading edge. [distance from the LE, height above the
    // wing's mid-thickness].
    tipPlate: [[33, 46.5], [40, 38.5], [50, 31], [62, 26], [75, 22], [100, 18], [115, 17.5], [150, 19], [175, 21], [200, 25], [209, 27.5], [205, 34], [203.5, 40], [204.5, 47], [209, 58.5], [200, 60], [175, 62.5], [150, 64.5], [115, 66], [100, 65.5], [75, 62], [62, 59], [50, 55], [40, 51]]
      .map(([x, y]) => [(x - 33) / 1000, (42 - y) / 1000]),
  };
}

export function buildBuschtrottel(style) {
  style = { throws: { aileron: 26 * deg, elevator: 20 * deg }, prop: PROP_8x6, ...style };
  const L = layout(style);
  const high = style.mount === 'high';
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
        area: segSpan * CHORD,
        foil: kfm2,
        wing: true,
        chordLen: CHORD,
        controls: zMid >= L.ailFrom ? [{ input: 'roll', gain: -side, max: style.throws.aileron, tau: 0.45 }] : [],
        propwash: i === 0 ? 0.35 : 0,
      });
    }
  }

  const t = L.tail;
  const tailArea = polyArea(L.outlines.stab);
  const tailAr = t.span ** 2 / tailArea;
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
    // Enough to reach the wing's lift limit crisply at cruise, but half stick
    // stays clear of the stall and full stick doesn't drop a wing.
    controls: [{ input: 'pitch', gain: -1, max: style.throws.elevator, tau: 0.55 }],
  }));

  const f = L.fin;
  const finPts = L.outlines.fin;
  const finTop = Math.max(...finPts.map((p) => p[1]));
  const finAr = 1.3;
  const fin = {
    name: 'fin',
    pos: [f.hingeX + 0.02, finTop * 0.45, 0],
    chord: [1, 0, 0],
    span: [0, -1, 0], // normal = +z (right)
    // Exposed area: the outline less the part buried in the fuselage.
    area: polyArea(finPts) * 0.85,
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
      // AT2308 1450Kv on 3S (~16,000 rpm unloaded), see style.prop.
      staticThrust: style.prop.staticThrust, // N
      pitchSpeed: style.prop.pitchSpeed,     // m/s = pitch × loaded rpm
      spoolTime: 0.06,
      torqueFactor: 0.002, // net of slipstream swirl, which offsets part of the torque
      // Downthrust stops the nose rising with power (as on real Cubs).
      downThrust: 3 * deg,
      // No right thrust: it exists to cancel prop swirl/P-factor, which aren't
      // modelled, so here it would yaw the model right in slow, powered flight.
      rightThrust: 0,
      maxRpm: style.prop.rpm,
      blades: style.prop.blades,
      position: [L.prop.x, L.prop.y, 0],
      discArea: Math.PI * L.prop.radius ** 2,
    },
    battery: { cells: 3, capacity: 1350, maxCurrent: style.prop.current, internalResistance: 0.02 * 3 },
    trim: { roll: style.rollTrim }, // aileron trim for hands-off cruise
    assist: {
      rateGain: { roll: 0.05, pitch: 0.06, yaw: 0.07 },
      refSpeed: 8,
      maxBank: 45 * deg,
      maxPitch: 30 * deg,
      levelGain: { roll: 1.5, pitch: 1.7 },
    },
    contacts: [
      // Springy wire legs: soft (~7 mm static sag), lightly damped, so the
      // model settles on the gear and bounces a little on a firm landing.
      // Big foam wheels roll more easily over grass (rollScale).
      { name: 'wheel-L', pos: [W.x, W.y - W.radius, -W.z], type: 'wheel', k: 250, c: 3.5, rollScale: 0.7, crashSpeed: 5 },
      { name: 'wheel-R', pos: [W.x, W.y - W.radius, W.z], type: 'wheel', k: 250, c: 3.5, rollScale: 0.7, crashSpeed: 5 },
      { name: 'tail-wheel', pos: [TW.x, TW.y - TW.radius, 0], type: 'wheel', k: 500, c: 5, crashSpeed: 4, steer: 25 * deg },
      { name: 'prop-low', pos: [L.prop.x + 0.005, L.prop.y - L.prop.radius, 0], type: 'prop', k: 1000, c: 8, crashSpeed: 0 },
      hard('nose', high ? [0.218, -0.025, 0] : [0.21, -0.045, 0], 3),
      hard('wing-tip-L', [tipX, tipY, -HALF]),
      hard('wing-tip-R', [tipX, tipY, HALF]),
      hard('wing-top', [L.wingLeX - CHORD * 0.3, L.wingY + 0.015, 0], 3),
      hard('cabin-top', [0.0, Math.max(...L.fuselage.map((s) => s[3])), 0], 3),
      hard('fin-top', [-0.46, finTop, 0], 3),
      hard('tail-end', [-0.52, 0.04, 0], 3.5),
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

  return {
    id: style.id,
    name: style.name,
    summary: style.summary,
    defaultAssist: 'off',
    def,
    geometry: L,
    views: {
      span: SPAN,
      // High wing: from the cabin under the wing. Agro: on the front of its
      // (opaque) canopy block.
      cockpit: up(high ? [0.04, 0.058, 0] : [-0.05, 0.108, 0]),
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

const COMMON = 'Fixed LE slats. AT2308 1450Kv, 3S 1350 mAh, ~450 g.';

// Props on the AT2308 1450Kv / 3S. Loaded rpm and static thrust are
// estimates from typical prop data; pitch speed = pitch × loaded rpm.
const PROP_8x6 = { blades: 2, pitchIn: 6, rpm: 11000, staticThrust: 6.2, pitchSpeed: 28, current: 16 };
const PROP_8x45x3 = { blades: 3, pitchIn: 4.5, rpm: 11000, staticThrust: 7.0, pitchSpeed: 21, current: 16 };

export const BUSCHTROTTEL_SHOCKCUB = buildBuschtrottel({
  id: 'buschtrottel-shockcub',
  name: 'Buschtrottel ShockCub',
  summary: `DIY 6 mm Depron bush plane, 900 mm. High wing, rounded tail. 8x6 prop. ${COMMON}`,
  prop: PROP_8x6,
  mount: 'high',
  fullSpanAilerons: true,
  tail: 'round',
  slats: true,
  throws: { aileron: 22 * deg, elevator: 20 * deg }, // full-span ailerons
  mass: 0.45,
  tailIncidence: 3 * deg,
  rollTrim: 0,
  colors: { main: '#f2c230', accent: '#1d1d1d', wing: '#f2c230', tail: '#f2c230' },
});

export const BUSCHTROTTEL_HIGHLANDER = buildBuschtrottel({
  id: 'buschtrottel-highlander',
  name: 'Buschtrottel Highlander',
  summary: `DIY 6 mm Depron bush plane, 900 mm. High wing, angular tail. 8x6 prop. ${COMMON}`,
  prop: PROP_8x6,
  mount: 'high',
  fullSpanAilerons: true,
  tail: 'square',
  slats: true,
  throws: { aileron: 22 * deg, elevator: 20 * deg }, // full-span ailerons
  mass: 0.45,
  tailIncidence: 3 * deg,
  rollTrim: 0,
  colors: { main: '#efefea', accent: '#c62828', wing: '#efefea', tail: '#c62828' },
});

export const BUSCHTROTTEL_AGRO = buildBuschtrottel({
  id: 'buschtrottel-agro',
  name: 'Buschtrottel Agro',
  summary: `DIY 6 mm Depron, 900 mm. Low wing with struts, full-span ailerons, black canopy, low tailplane. 8x4.5 three-blade prop. ${COMMON}`,
  prop: PROP_8x45x3,
  mount: 'low',
  fullSpanAilerons: true,
  lowTail: true,
  // Full-span ailerons are already powerful; the big plan tailplane needs
  // less elevator throw.
  throws: { aileron: 22 * deg, elevator: 16 * deg },
  tail: 'square',
  slats: true,
  mass: 0.46,
  tailIncidence: 2 * deg,
  cgDrop: 0.03, // CG 3 cm lower in the airframe than the high-wing versions
  rollTrim: 0,
  // Orange and white: top third of the fuselage, tail and wing tops orange;
  // lower fuselage and wing undersides white; sky-blue ailerons.
  colors: { main: '#f4f4ef', top: '#f26b1d', split: 2 / 3, wing: '#f26b1d', wingBottom: '#f4f4ef', aileron: '#7cc6ee', slatTop: '#7cc6ee', slatBottom: '#f4f4ef', tail: '#f26b1d' },
});
