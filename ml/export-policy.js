#!/usr/bin/env node
// Copy a trained policy into the game, for AI flyers (src/ml/aiFlyers.js):
//
//   node ml/export-policy.js ml/runs/hold-hobbyzone-aeroscout/best.json
//
// Writes src/ml/policies/<aircraft id>.json, with the weights rounded to 5
// significant figures (about half the size; flies the same).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Policy } from '../src/ml/policy.js';

const [file, idArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node ml/export-policy.js <policy.json> [aircraft id]');
  process.exit(1);
}
const j = JSON.parse(readFileSync(file, 'utf8'));
Policy.fromJSON(j); // checks it
const aircraft = j.meta?.aircraft ?? [];
const id = idArg || (aircraft.length === 1 ? aircraft[0] : null);
if (!id) {
  console.error('policy is for several aircraft: give the aircraft id to export it for');
  process.exit(1);
}
if (j.meta?.task && j.meta.task !== 'hold') console.warn(`warning: trained on "${j.meta.task}"; AI flyers expect a "hold" policy`);
const out = {
  ...j,
  meta: { aircraft: [id], task: j.meta?.task, inputs: j.meta?.inputs, generation: j.meta?.generation, valScore: j.meta?.valScore && Number(j.meta.valScore.toFixed(3)), source: file },
  params: j.params.map((x) => Number(x.toPrecision(5))),
};
const dir = fileURLToPath(new URL('../src/ml/policies/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}${id}.json`, `${JSON.stringify(out)}\n`);
console.log(`→ src/ml/policies/${id}.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
