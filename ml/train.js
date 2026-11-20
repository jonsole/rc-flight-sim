#!/usr/bin/env node
// Train a neural-network pilot with Evolution Strategies (ml/es.js).
//
//   node ml/train.js --aircraft hobbyzone-aeroscout --task hold --gens 150
//
// Writes to ml/runs/<name>/: config.json, log.csv (one row per generation),
// best.json (the best policy so far on the validation flights: load this one),
// latest.json (policy + optimiser state, for --resume).
// See ml/README.md for every option.
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ES } from './es.js';
import { Evaluator, Pool } from './evaluate.js';
import { makeRng, TASKS } from './env.js';
import { aircraftIds } from './aircraft.js';
import { Policy } from '../src/ml/policy.js';
import { resolveInputs } from '../src/ml/observe.js';

export const DEFAULTS = {
  aircraft: 'hobbyzone-aeroscout', // comma-separated ids, or "all"
  task: 'hold',
  inputs: 'sim', // 'sim' (all), 'hardware' (no alpha, beta, wing stall), or a list of names
  gens: 150,
  pairs: 24, // population = 2 × pairs
  episodes: 4, // flights per candidate per generation
  seconds: 20,
  hidden: '32,32',
  sigma: 0.05,
  lr: 0.03,
  l2: 0.005,
  wind: 4,
  controlHz: 50,
  substep: 1 / 600,
  evalEvery: 5,
  evalEpisodes: 16,
  workers: Math.max(1, cpus().length),
  seed: 1,
  name: '',
  out: fileURLToPath(new URL('./runs/', import.meta.url)),
  init: '', // start from this policy file
  resume: false,
  quiet: false,
};

export function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in DEFAULTS)) throw new Error(`unknown option ${a}`);
    if (typeof DEFAULTS[key] === 'boolean') o[key] = true;
    else {
      const v = argv[++i];
      o[key] = typeof DEFAULTS[key] === 'number' ? Number(v) : v;
    }
  }
  if (o.aircraft === 'all') o.aircraft = aircraftIds().join(',');
  if (!TASKS.includes(o.task)) throw new Error(`--task must be one of ${TASKS.join(', ')}`);
  return o;
}

/** Train; returns { best, bestScore, dir }. */
export async function train(opts) {
  const o = { ...DEFAULTS, ...opts };
  const aircraft = String(o.aircraft).split(',').filter(Boolean);
  const hidden = String(o.hidden).split(',').map(Number);
  const inputs = resolveInputs(o.inputs);
  const name = o.name || `${o.task}-${aircraft.length > 1 ? 'multi' : aircraft[0]}${o.inputs === 'sim' ? '' : `-${o.inputs.includes(',') ? 'custom' : o.inputs}`}`;
  const dir = `${o.out.replace(/\/$/, '')}/${name}`;
  mkdirSync(dir, { recursive: true });
  const config = {
    aircraft,
    hidden,
    env: { task: o.task, inputs, seconds: o.seconds, windMax: o.wind, controlHz: o.controlHz, substep: o.substep },
  };
  const log = (...a) => o.quiet || console.log(...a);

  const policy = new Policy(inputs.length, hidden).init(makeRng(o.seed));
  if (o.init) {
    const p = Policy.fromJSON(JSON.parse(readFileSync(o.init, 'utf8')));
    if (p.size !== policy.size) throw new Error(`--init policy has a different shape (${p.hidden})`);
    policy.params.set(p.params);
  }
  const es = new ES(policy.params, { pairs: o.pairs, sigma: o.sigma, lr: o.lr, l2: o.l2, seed: o.seed });
  let gen0 = 0;
  let bestScore = -Infinity;
  if (o.resume && existsSync(`${dir}/latest.json`)) {
    const s = JSON.parse(readFileSync(`${dir}/latest.json`, 'utf8'));
    policy.params.set(s.params);
    es.load(s.es);
    gen0 = s.meta.generation;
    bestScore = s.meta.bestScore ?? -Infinity;
    log(`resuming ${dir} at generation ${gen0}`);
  } else {
    writeFileSync(`${dir}/log.csv`, 'generation,seconds,popMean,popMax,valScore,valCrashRate,stepNorm\n');
  }
  writeFileSync(`${dir}/config.json`, JSON.stringify({ ...o, aircraft, hidden, inputs, params: policy.size, obsSize: inputs.length }, null, 2));

  // Validation: fixed flights, never trained on, to pick the best policy.
  const valEpisodes = Array.from({ length: o.evalEpisodes }, (_, i) => ({ seed: 1_000_000 + i, aircraft: i % aircraft.length }));
  const evaluator = new Evaluator(config);
  const pool = o.workers > 1 ? new Pool(config, o.workers) : null;
  const scoreAll = (list, eps) => (pool ? pool.scoreAll(list, eps) : Promise.resolve(list.map((p) => evaluator.score(p, eps).fitness)));
  const meta = (gen, score) => ({ aircraft, task: o.task, inputs, generation: gen, valScore: score, bestScore, hidden, trainedFor: o.seconds });

  log(`training ${name}: ${aircraft.join(', ')} | task ${o.task} | ${inputs.length} inputs | ${policy.size} weights | population ${2 * o.pairs} × ${o.episodes} flights | ${o.workers} workers`);
  const t0 = Date.now();
  try {
    for (let gen = gen0 + 1; gen <= o.gens; gen++) {
      // Fresh flights every generation (the same ones for every candidate).
      const rng = makeRng(o.seed * 7919 + gen);
      const episodes = Array.from({ length: o.episodes }, (_, i) => ({ seed: Math.floor(rng() * 2 ** 31), aircraft: (gen + i) % aircraft.length }));
      const cands = es.ask();
      const fit = await scoreAll(cands, episodes);
      const { stepNorm } = es.tell(fit);
      const popMean = fit.reduce((a, b) => a + b, 0) / fit.length;
      const popMax = Math.max(...fit);
      let val = '';
      let crash = '';
      if (gen % o.evalEvery === 0 || gen === o.gens) {
        const r = evaluator.score(policy.params, valEpisodes, true);
        val = r.fitness;
        crash = r.infos.filter((x) => x.crashed).length / r.infos.length;
        if (val > bestScore) {
          bestScore = val;
          writeFileSync(`${dir}/best.json`, JSON.stringify(policy.toJSON(meta(gen, val))));
        }
        writeFileSync(`${dir}/latest.json`, JSON.stringify({ ...policy.toJSON(meta(gen, val)), es: es.state() }));
      }
      const secs = (Date.now() - t0) / 1000;
      appendFileSync(`${dir}/log.csv`, `${gen},${secs.toFixed(1)},${popMean.toFixed(3)},${popMax.toFixed(3)},${val === '' ? '' : val.toFixed(3)},${crash},${stepNorm.toFixed(4)}\n`);
      log(
        `gen ${String(gen).padStart(4)}  pop mean ${popMean.toFixed(2).padStart(7)}  max ${popMax.toFixed(2).padStart(7)}` +
          (val === '' ? '' : `  | validation ${val.toFixed(2).padStart(7)}  crashes ${(100 * crash).toFixed(0).padStart(3)}%`) +
          `  (${secs.toFixed(0)} s)`,
      );
    }
  } finally {
    await pool?.close();
  }
  log(`best validation score ${bestScore.toFixed(2)} → ${dir}/best.json`);
  return { bestScore, dir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  train(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
