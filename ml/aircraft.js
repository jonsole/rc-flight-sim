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

// Cruising speed: shared with the game's AI flyers.
export { cruiseSpeed } from '../src/ml/aiPilot.js';
