// Aircraft tuning (Menu → Tuning): your own changes to a model's flight
// settings, on top of its definition (src/aircraft). Saved per model in this
// browser; exported as a file to have them built in.
//
// Each tunable reads its default from the model's definition and writes a
// value into a copy of it. Values are stored only when they differ from the
// default, so a model's own changes still come through.

const KEY = 'rcsim.tuning.v1';
const deg = Math.PI / 180;

/** The first control on any surface for `input` ('roll' | 'pitch' | 'yaw'): its throw (null: none). */
function throwOf(def, input) {
  for (const s of def.surfaces) for (const c of s.controls ?? []) if (c.input === input && c.max) return c.max;
  return null;
}
const degOrNull = (r) => (r == null ? null : r / deg);
function scaleThrow(def, input, value) {
  const base = throwOf(def, input);
  if (!base) return;
  const k = (value * deg) / base;
  for (const s of def.surfaces) for (const c of s.controls ?? []) if (c.input === input) c.max *= k;
}

/** Effective dihedral of the wing panels (degrees), from their span vectors. */
function dihedralOf(def) {
  const w = def.surfaces.find((s) => s.wing && s.span);
  return w ? Math.atan2(Math.abs(w.span[1]), Math.abs(w.span[2])) / deg : null;
}
function setDihedral(def, value) {
  const delta = (value - dihedralOf(def)) * deg;
  for (const s of def.surfaces) {
    if (!s.wing || !s.span) continue;
    const side = Math.sign(s.span[1] || s.pos[2] || 1);
    const a = Math.atan2(Math.abs(s.span[1]), Math.abs(s.span[2])) + delta;
    s.span = [s.span[0], side * Math.sin(a), Math.cos(a) * Math.sign(s.span[2] || 1)];
  }
}

// The wing's root chord: the innermost panel (the top wing's on a biplane),
// whose position is its quarter-chord point.
function rootPanel(d) {
  const w = d.surfaces.filter((s) => s.wing);
  const minZ = Math.min(...w.map((s) => Math.abs(s.pos[2])));
  return w.filter((s) => Math.abs(s.pos[2]) - minZ < 0.02).reduce((b, s) => (s.pos[1] > b.pos[1] ? s : b));
}
const rootChord = (d) => rootPanel(d).chordLen ?? 0.2;
/** How far the root chord's leading edge is ahead of the CG (m). */
const rootLE = (d) => rootPanel(d).pos[0] + 0.25 * rootChord(d);
/** Move everything but the CG along x (the CG moves the other way relative to them). */
function shiftAll(d, dx) {
  for (const s of d.surfaces) s.pos = [s.pos[0] + dx, s.pos[1], s.pos[2]];
  for (const c of d.contacts) c.pos = [c.pos[0] + dx, c.pos[1], c.pos[2]];
  d.motor.position = [d.motor.position[0] + dx, d.motor.position[1], d.motor.position[2]];
}

// Geometry relative to the wing: the wing's mean panel position and
// incidence, and the tail surfaces (tailplane 'stab…', fin 'fin…').
const wingPanels = (d) => d.surfaces.filter((s) => s.wing);
const tailplane = (d) => d.surfaces.filter((s) => /^stab/.test(s.name));
const tailSurfaces = (d) => d.surfaces.filter((s) => /^(stab|fin)/.test(s.name));
const mean = (list, i) => list.reduce((t, s) => t + s.pos[i], 0) / list.length;
const incidence = (s) => Math.atan2(s.chord[1], s.chord[0]);
const meanInc = (list) => list.reduce((t, s) => t + incidence(s), 0) / list.length;
function shiftTail(d, axis, metres) {
  for (const s of tailSurfaces(d)) {
    const p = [...s.pos];
    p[axis] += metres;
    s.pos = p;
  }
}

// --- Power system: propeller, motor, battery ----------------------------------
// A brushless motor on a LiPo turning a prop, at full throttle:
//   motor current   I = (V − rpm/Kv) / (R_motor + R_battery)
//   motor torque    Q = Kt (I − I_noload),  Kt = 60 / (2π Kv)
//   prop torque     Q = kq · n²,  kq ∝ Bf · (P/D)^1.3 · D⁵,  Bf = (blades/2)^0.75
// It settles where the two torques meet. Static thrust ∝ Bf^0.85 · (P/D)^0.6
// · n² · D⁴ and pitch speed = pitch × n follow. Calibrated per model from its
// own prop, motor and battery (the rpm and current it's known to run at
// full throttle), so the defaults fly exactly as before; the winding
// resistance is worked out from that.
const VCELL = 3.95; // a fresh LiPo cell under load (V)
const MAH_GRAMS = 0.027; // LiPo weight per mAh per cell (g): 3S 1350 ≈ 110 g
const bladeFactor = (b) => (b / 2) ** 0.75;

/** The model's own full-throttle operating point and the constants behind it. */
function calibrate(d) {
  const m = d.motor;
  const b = d.battery;
  if (!m.prop || !m.kv || !m.maxRpm) return null;
  const n0 = m.maxRpm / 60;
  const v0 = b.cells * VCELL;
  const emf0 = (60 * n0) / m.kv;
  const rMotor = Math.max(0.005, (v0 - emf0) / b.maxCurrent - b.internalResistance);
  const kt0 = 60 / (2 * Math.PI * m.kv);
  const q0 = kt0 * (b.maxCurrent - (m.noLoadCurrent ?? 0));
  return {
    prop: { ...m.prop }, kv: m.kv, rMotor, cells: b.cells, capacity: b.capacity, cellR: b.internalResistance / b.cells,
    n0, q0, kq0: q0 / (n0 * n0), thrust0: m.staticThrust, pitchSpeed0: m.pitchSpeed, discArea0: m.discArea,
    torque0: m.staticThrust * m.torqueFactor, noLoad: m.noLoadCurrent ?? 0,
  };
}

/** Re-solve the full-throttle operating point with the tuned prop, motor and battery. */
function solvePower(d, ref, pw) {
  const m = d.motor;
  const p = pw.prop;
  const pd = p.pitchIn / p.diameterIn;
  const pd0 = ref.prop.pitchIn / ref.prop.diameterIn;
  const dr = p.diameterIn / ref.prop.diameterIn;
  const bf = bladeFactor(p.blades) / bladeFactor(ref.prop.blades);
  const kq = ref.kq0 * bf * (pd / pd0) ** 1.3 * dr ** 5;
  const kt = 60 / (2 * Math.PI * pw.kv);
  const v = pw.cells * VCELL;
  const rTot = pw.rMotor + pw.cellR * pw.cells;
  const current = (n) => (v - (60 * n) / pw.kv) / rTot;
  // Motor torque falls with rpm, prop torque rises: bisect for where they meet.
  let lo = 0;
  let hi = (v * pw.kv) / 60;
  for (let i = 0; i < 60; i++) {
    const n = (lo + hi) / 2;
    if (kt * (current(n) - ref.noLoad) > kq * n * n) lo = n;
    else hi = n;
  }
  const n = lo;
  const r = n / ref.n0;
  m.prop = { ...p };
  m.kv = pw.kv;
  m.maxRpm = n * 60;
  m.staticThrust = ref.thrust0 * bf ** 0.85 * (pd / pd0) ** 0.6 * r * r * dr ** 4;
  m.pitchSpeed = ref.pitchSpeed0 * (p.pitchIn / ref.prop.pitchIn) * r;
  if (ref.discArea0) m.discArea = ref.discArea0 * dr * dr;
  // The prop-strike points sit at the tips: a bigger prop reaches lower.
  if (dr !== 1) {
    for (const c of d.contacts) {
      if (c.type !== 'prop') continue;
      const [, my, mz] = m.position;
      c.pos = [c.pos[0], my + (c.pos[1] - my) * dr, mz + (c.pos[2] - mz) * dr];
    }
  }
  m.torqueFactor = (ref.torque0 * (kq * n * n) / ref.q0) / Math.max(1e-6, m.staticThrust);
  m.resistance = pw.rMotor;
  d.battery = { ...d.battery, cells: pw.cells, capacity: pw.capacity, internalResistance: pw.cellR * pw.cells, maxCurrent: Math.max(0.5, current(n)) };
  // A bigger battery weighs more.
  const dm = ((pw.cells * pw.capacity - ref.cells * ref.capacity) * MAH_GRAMS) / 1000;
  if (dm) {
    const k = (d.mass + dm) / d.mass;
    d.mass += dm;
    d.inertia = d.inertia.map((x) => x * k);
  }
}

/** The power-system tunables: { key: (pw, value) => void } and their defaults from the calibration. */
const POWER = {
  propDiameter: (pw, v) => (pw.prop.diameterIn = v),
  propPitch: (pw, v) => (pw.prop.pitchIn = v),
  propBlades: (pw, v) => (pw.prop.blades = v),
  kv: (pw, v) => (pw.kv = v),
  motorResistance: (pw, v) => (pw.rMotor = v / 1000),
  cells: (pw, v) => (pw.cells = v),
  capacity: (pw, v) => (pw.capacity = v),
  cellResistance: (pw, v) => (pw.cellR = v / 1000),
};

/** The settings, by group. `get` reads the default from a definition, `set` writes into a copy. */
export const TUNABLES = [
  { group: 'Weight', key: 'mass', label: 'All-up weight', unit: 'g', min: 0.5, max: 2, rel: true, step: 5,
    get: (d) => d.mass * 1000,
    set: (d, v) => {
      const k = v / 1000 / d.mass;
      d.mass = v / 1000;
      d.inertia = d.inertia.map((i) => i * k); // heavier: harder to turn, in proportion
    } },
  { group: 'Weight', key: 'cgFromLE', label: 'CG behind the leading edge', unit: 'mm', min: -40, max: 40, step: 1, around: true,
    get: (d) => rootLE(d) * 1000,
    note: (d, v) => `${Math.round((v / 1000 / rootChord(d)) * 100)}% of the root chord`,
    set: (d, v) => shiftAll(d, (v - rootLE(d) * 1000) / 1000) },
  // (Older saves: CG moved forward by mm.)
  { group: 'Weight', key: 'cg', hidden: true, get: () => 0, set: (d, v) => shiftAll(d, -v / 1000) },
  { group: 'Motor', key: 'thrust', label: 'Static thrust', unit: 'N', min: 0.3, max: 2.5, rel: true, step: 0.1,
    get: (d) => d.motor.staticThrust,
    set: (d, v) => {
      // Torque comes from thrust: keep it the same unless changed itself.
      d.motor.torqueFactor *= d.motor.staticThrust / v;
      d.motor.staticThrust = v;
    } },
  { group: 'Motor', key: 'pitchSpeed', label: 'Prop pitch speed (top speed)', unit: 'm/s', min: 0.5, max: 1.6, rel: true, step: 0.5,
    get: (d) => d.motor.pitchSpeed, set: (d, v) => (d.motor.pitchSpeed = v) },
  { group: 'Motor', key: 'torque', label: 'Motor torque', unit: '×', min: 0, max: 3, step: 0.05,
    get: () => 1, set: (d, v) => (d.motor.torqueFactor *= v) },
  { group: 'Motor', key: 'downThrust', label: 'Down-thrust', unit: '°', min: -5, max: 12, step: 0.5,
    get: (d) => (d.motor.downThrust ?? 0) / deg, set: (d, v) => (d.motor.downThrust = v * deg) },
  { group: 'Motor', key: 'rightThrust', label: 'Right-thrust', unit: '°', min: -5, max: 8, step: 0.5,
    get: (d) => (d.motor.rightThrust ?? 0) / deg, set: (d, v) => (d.motor.rightThrust = v * deg) },
  { group: 'Propeller', key: 'propDiameter', label: 'Diameter', unit: 'in', min: 0.6, max: 1.5, rel: true, step: 0.5, power: true,
    get: (d) => calibrate(d)?.prop.diameterIn ?? null },
  { group: 'Propeller', key: 'propPitch', label: 'Pitch', unit: 'in', min: 0.5, max: 2, rel: true, step: 0.5, power: true,
    get: (d) => calibrate(d)?.prop.pitchIn ?? null },
  { group: 'Propeller', key: 'propBlades', label: 'Blades', unit: '', min: 2, max: 6, step: 1, power: true,
    get: (d) => calibrate(d)?.prop.blades ?? null },
  // Blade tips: only the look and the sound (square tips are much noisier).
  { group: 'Propeller', key: 'propTips', label: 'Blade tips', unit: '', min: 0, max: 1, step: 1,
    choices: { 0: 'Tapered', 1: 'Square (bullnose)' },
    get: (d) => (d.motor.prop ? (d.motor.prop.tip === 'square' ? 1 : 0) : null),
    set: (d, v) => (d.motor.prop = { ...d.motor.prop, tip: v ? 'square' : 'tapered' }) },
  { group: 'Electric motor', key: 'kv', label: 'Kv', unit: 'rpm/V', min: 0.5, max: 2, rel: true, step: 10, power: true,
    get: (d) => calibrate(d)?.kv ?? null },
  { group: 'Electric motor', key: 'motorResistance', label: 'Winding resistance', unit: 'mΩ', min: 0.3, max: 3, rel: true, step: 1, power: true,
    get: (d) => (calibrate(d) ? calibrate(d).rMotor * 1000 : null) },
  { group: 'Battery', key: 'cells', label: 'Cells (S)', unit: 'S', min: 1, max: 6, step: 1, power: true,
    get: (d) => (calibrate(d) ? d.battery.cells : null) },
  { group: 'Battery', key: 'capacity', label: 'Capacity', unit: 'mAh', min: 0.3, max: 3, rel: true, step: 50, power: true,
    get: (d) => (calibrate(d) ? d.battery.capacity : null) },
  { group: 'Battery', key: 'cellResistance', label: 'Internal resistance per cell', unit: 'mΩ', min: 3, max: 60, step: 1, power: true,
    get: (d) => (calibrate(d) ? (d.battery.internalResistance / d.battery.cells) * 1000 : null) },
  { group: 'Layout', key: 'thrustHeight', label: 'Thrust line vs wing (+ above)', unit: 'mm', min: -150, max: 150, step: 1, around: true,
    get: (d) => (d.motor.position[1] - mean(wingPanels(d), 1)) * 1000,
    set: (d, v) => {
      const p = [...d.motor.position];
      p[1] = mean(wingPanels(d), 1) + v / 1000;
      d.motor.position = p;
    } },
  { group: 'Layout', key: 'tailArm', label: 'Tail arm (wing to tailplane)', unit: 'mm', min: 0.6, max: 1.6, rel: true, step: 5,
    get: (d) => (tailplane(d).length ? (mean(wingPanels(d), 0) - mean(tailplane(d), 0)) * 1000 : null),
    set: (d, v) => shiftTail(d, 0, -(v / 1000 - (mean(wingPanels(d), 0) - mean(tailplane(d), 0)))) },
  { group: 'Layout', key: 'tailHeight', label: 'Tailplane height vs wing (+ above)', unit: 'mm', min: -150, max: 150, step: 1, around: true,
    get: (d) => (tailplane(d).length ? (mean(tailplane(d), 1) - mean(wingPanels(d), 1)) * 1000 : null),
    set: (d, v) => shiftTail(d, 1, v / 1000 - (mean(tailplane(d), 1) - mean(wingPanels(d), 1))) },
  { group: 'Layout', key: 'tailIncidence', label: 'Tailplane incidence vs wing', unit: '°', min: -6, max: 6, step: 0.25, around: true,
    get: (d) => (tailplane(d).length ? (meanInc(tailplane(d)) - meanInc(wingPanels(d))) / deg : null),
    set: (d, v) => {
      const delta = v * deg - (meanInc(tailplane(d)) - meanInc(wingPanels(d)));
      for (const s of tailplane(d)) {
        const a = incidence(s) + delta;
        s.chord = [Math.cos(a), Math.sin(a), s.chord[2] ?? 0];
      }
    } },
  { group: 'Drag', key: 'profileDrag', label: 'Wing and tail drag', unit: '×', min: 0.3, max: 3, step: 0.05,
    get: () => 1,
    set: (d, v) => {
      for (const s of d.surfaces) if (s.foil) s.foil = { ...s.foil, cd0: s.foil.cd0 * v };
    } },
  { group: 'Drag', key: 'bodyDrag', label: 'Body drag', unit: '×', min: 0.3, max: 3, step: 0.05,
    get: () => 1, set: (d, v) => (d.parasite = { ...d.parasite, x: d.parasite.x * v }) },
  { group: 'Controls', key: 'aileron', label: 'Aileron throw', unit: '°', min: 0, max: 40, step: 0.5,
    get: (d) => degOrNull(throwOf(d, 'roll')), set: (d, v) => scaleThrow(d, 'roll', v) },
  { group: 'Controls', key: 'elevator', label: 'Elevator throw', unit: '°', min: 0, max: 40, step: 0.5,
    get: (d) => degOrNull(throwOf(d, 'pitch')), set: (d, v) => scaleThrow(d, 'pitch', v) },
  { group: 'Controls', key: 'rudder', label: 'Rudder throw', unit: '°', min: 0, max: 45, step: 0.5,
    get: (d) => degOrNull(throwOf(d, 'yaw')), set: (d, v) => scaleThrow(d, 'yaw', v) },
  { group: 'Stability', key: 'dihedral', label: 'Effective dihedral', unit: '°', min: -5, max: 15, step: 0.5,
    get: (d) => dihedralOf(d), set: (d, v) => setDihedral(d, v) },
];

/** The tunables a model has (some have no rudder, say), with their defaults and ranges. */
export function tunablesFor(def) {
  return TUNABLES.filter((t) => !t.hidden).map((t) => {
    const dflt = t.get(def);
    if (dflt == null) return null;
    // `rel` ranges are multiples of the default; `around` ranges are either
    // side of it.
    const [min, max] = t.rel ? [t.min * dflt, t.max * dflt] : t.around ? [dflt + t.min, dflt + t.max] : [t.min, t.max];
    return { ...t, dflt, min, max };
  }).filter(Boolean);
}

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

/** Your tuning for a model: { key: value } (only what differs from its default). */
export function loadTuning(id) {
  return loadAll()[id] ?? {};
}

export function saveTuning(id, values) {
  const all = loadAll();
  if (Object.keys(values).length) all[id] = values;
  else delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: lasts this session */
  }
}

/** A copy of `def` with `values` applied (in TUNABLES order; the power system last). */
export function tunedDef(def, values) {
  if (!values || !Object.keys(values).length) return def;
  const d = { ...def };
  for (const k of ['surfaces', 'contacts']) d[k] = def[k].map((x) => structuredClone({ ...x }));
  d.motor = { ...def.motor, prop: def.motor.prop && { ...def.motor.prop } };
  d.battery = { ...def.battery };
  d.parasite = { ...def.parasite };
  d.inertia = [...def.inertia];
  for (const t of TUNABLES) if (!t.power && values[t.key] != null) t.set(d, Number(values[t.key]));
  const powerKeys = Object.keys(POWER).filter((k) => values[k] != null);
  const ref = powerKeys.length ? calibrate(d) : null;
  if (ref) {
    const pw = { prop: { ...ref.prop }, kv: ref.kv, rMotor: ref.rMotor, cells: ref.cells, capacity: ref.capacity, cellR: ref.cellR };
    for (const k of powerKeys) POWER[k](pw, Number(values[k]));
    solvePower(d, ref, pw);
  }
  return d;
}

/** The full-throttle numbers of a (tuned) model, for the Tuning tab. */
export function powerSummary(d) {
  const m = d.motor;
  const b = d.battery;
  const watts = b.maxCurrent * b.cells * VCELL;
  return {
    rpm: m.maxRpm, current: b.maxCurrent, watts, thrust: m.staticThrust, pitchSpeed: m.pitchSpeed,
    batteryGrams: b.cells * b.capacity * MAH_GRAMS, fullThrottleMinutes: (b.capacity / 1000 / b.maxCurrent) * 60 * 0.8,
  };
}
