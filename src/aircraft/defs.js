// The flight-model half of the aircraft registry, with nothing that needs
// Vite or a browser: turns a model's JSON file (src/aircraft/models/) into
// its builder's entry ({ id, name, def, ... }) with the built-in tuning
// applied. src/aircraft/index.js adds the 3D models on top; the ML training
// harness (ml/) uses this directly under plain Node.
import { buildSE5a } from './se5a.js';
import { buildF22 } from './f22.js';
import { buildBuschtrottel } from './buschtrottel.js';
import { buildAeroScout } from './aeroscout.js';
import { buildEasyStar } from './easystar.js';
import { tunedDef } from '../sim/tuning.js';

export const BUILDERS = { se5a: buildSE5a, buschtrottel: buildBuschtrottel, f22: buildF22, aeroscout: buildAeroScout, easystar: buildEasyStar };

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

/** A builder's entry from a model's JSON file, built-in tuning applied (no 3D model). */
export function buildEntry(json) {
  const { builder, tuning, model: _model, ...opts } = json;
  const build = BUILDERS[builder];
  if (!build) throw new Error(`${json.id}: unknown builder "${builder}"`);
  const entry = build(fromJson(opts));
  // Built-in tuning: becomes the model's defaults (a changed prop is drawn too).
  if (tuning && Object.keys(tuning).length) return { ...entry, def: tunedDef(entry.def, tuning) };
  return entry;
}
