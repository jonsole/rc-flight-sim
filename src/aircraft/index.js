// Aircraft registry. Each model's settings live in a JSON file in
// src/aircraft/models/ (readable and editable on GitHub): which builder makes
// it ("builder": se5a | buschtrottel | f22), its name and summary, and the
// builder's options (units: metres, kilograms, newtons, seconds; angles in
// degrees where the name ends in "Deg"). A "tuning" section holds built-in
// changes in the Tuning tab's terms (src/sim/tuning.js), applied on top.
// Adding a JSON file adds an aircraft.
//
// Each entry: { id, name, summary, defaultAssist, def, geometry, views, createModel(opts) }
import { buildSE5a } from './se5a.js';
import { buildF22 } from './f22.js';
import { buildBuschtrottel } from './buschtrottel.js';
import { tunedDef } from '../sim/tuning.js';

const BUILDERS = { se5a: buildSE5a, buschtrottel: buildBuschtrottel, f22: buildF22 };

/** JSON options to the builders' terms: `…Deg` angles to radians (key without "Deg"); notes dropped. */
export function fromJson(o) {
  if (Array.isArray(o)) return o.map(fromJson);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'notes') continue;
    if (k.endsWith('Deg') && typeof v === 'number') out[k.slice(0, -3)] = (v * Math.PI) / 180;
    else if (k.endsWith('Deg') && v && typeof v === 'object') {
      // e.g. "throwsDeg": { "aileron": 22 } (a group of angles)
      out[k.slice(0, -3)] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, (vv * Math.PI) / 180]));
    } else out[k] = fromJson(v);
  }
  return out;
}

/** An aircraft from its JSON file. */
export function buildAircraft(json) {
  const { builder, tuning, ...opts } = json;
  const build = BUILDERS[builder];
  if (!build) throw new Error(`${json.id}: unknown builder "${builder}"`);
  const entry = build(fromJson(opts));
  if (tuning && Object.keys(tuning).length) {
    // Built-in tuning: becomes the model's defaults. A changed prop is drawn too.
    const def = tunedDef(entry.def, tuning);
    const create = entry.createModel;
    const propChanged = ['propDiameter', 'propPitch', 'propBlades'].some((k) => tuning[k] != null);
    return { ...entry, def, createModel: (o = {}) => create(o.prop || !propChanged ? o : { ...o, prop: def.motor.prop }) };
  }
  return entry;
}

// Every model file, in this order first (the first is the default), then any others.
const ORDER = ['eflite-se5a-900', 'buschtrottel-shockcub', 'buschtrottel-highlander', 'buschtrottel-agro', 'ft-mini-f22'];
const files = Object.values(import.meta.glob('./models/*.json', { eager: true, import: 'default' }));
files.sort((a, b) => {
  const ia = ORDER.indexOf(a.id);
  const ib = ORDER.indexOf(b.id);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.id.localeCompare(b.id);
});

export const AIRCRAFT = files.map(buildAircraft);

export const DEFAULT_AIRCRAFT_ID = AIRCRAFT[0].id;

export function getAircraft(id) {
  return AIRCRAFT.find((a) => a.id === id) || AIRCRAFT.find((a) => a.id === DEFAULT_AIRCRAFT_ID);
}
