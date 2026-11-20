// The aircraft models' flight definitions, read straight from their JSON
// files (src/aircraft/models/) so the harness runs under plain Node.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEntry } from '../src/aircraft/defs.js';

const DIR = fileURLToPath(new URL('../src/aircraft/models/', import.meta.url));

let cache = null;
export function allAircraft() {
  cache ||= readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => buildEntry(JSON.parse(readFileSync(DIR + f, 'utf8'))));
  return cache;
}

export function aircraftIds() {
  return allAircraft().map((a) => a.id);
}

export function getEntry(id) {
  const e = allAircraft().find((a) => a.id === id);
  if (!e) throw new Error(`no aircraft "${id}"; have: ${aircraftIds().join(', ')}`);
  return e;
}

/**
 * A comfortable cruising airspeed (m/s) for a model: the speed at which its
 * wing carries its weight at a lift coefficient of 0.7. Used to scale
 * starting and target speeds so the same task suits every model.
 */
export function cruiseSpeed(def) {
  const S = def.surfaces.filter((s) => s.wing).reduce((a, s) => a + s.area, 0);
  return Math.sqrt((2 * def.mass * 9.81) / (1.225 * S * 0.7));
}
