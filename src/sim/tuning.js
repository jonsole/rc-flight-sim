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

/** The settings, by group. `get` reads the default from a definition, `set` writes into a copy. */
export const TUNABLES = [
  { group: 'Weight', key: 'mass', label: 'All-up weight', unit: 'g', min: 0.5, max: 2, rel: true, step: 5,
    get: (d) => d.mass * 1000,
    set: (d, v) => {
      const k = v / 1000 / d.mass;
      d.mass = v / 1000;
      d.inertia = d.inertia.map((i) => i * k); // heavier: harder to turn, in proportion
    } },
  { group: 'Weight', key: 'cg', label: 'CG forward (+) / back (−)', unit: 'mm', min: -30, max: 30, step: 1,
    get: () => 0,
    set: (d, v) => {
      // Everything is placed relative to the CG: moving it forward moves the rest back.
      const dx = v / 1000;
      for (const s of d.surfaces) s.pos = [s.pos[0] - dx, s.pos[1], s.pos[2]];
      for (const c of d.contacts) c.pos = [c.pos[0] - dx, c.pos[1], c.pos[2]];
      d.motor.position = [d.motor.position[0] - dx, d.motor.position[1], d.motor.position[2]];
    } },
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
  return TUNABLES.map((t) => {
    const dflt = t.get(def);
    if (dflt == null) return null;
    // `rel` ranges are multiples of the default.
    const [min, max] = t.rel ? [t.min * dflt, t.max * dflt] : [t.min, t.max];
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

/** A copy of `def` with `values` applied (in TUNABLES order). */
export function tunedDef(def, values) {
  if (!values || !Object.keys(values).length) return def;
  const d = { ...def };
  for (const k of ['surfaces', 'contacts']) d[k] = def[k].map((x) => structuredClone({ ...x }));
  d.motor = { ...def.motor };
  d.parasite = { ...def.parasite };
  d.inertia = [...def.inertia];
  for (const t of TUNABLES) if (values[t.key] != null) t.set(d, Number(values[t.key]));
  return d;
}
