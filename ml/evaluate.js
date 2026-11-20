// Scoring policies: fly a set of episodes and average the return. Runs in
// the main thread (Evaluator) or spread over worker threads (Pool, with
// ml/worker.js), which give identical results for the same seeds.
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { FlightEnv, runEpisode } from './env.js';
import { getEntry } from './aircraft.js';
import { Policy } from '../src/ml/policy.js';
import { OBS_SIZE } from '../src/ml/observe.js';

/**
 * config: { aircraft: [ids], hidden: [..], env: { task, seconds, ... } }
 * An episode is { seed, aircraft } (an index into config.aircraft).
 */
export class Evaluator {
  constructor(config) {
    this.envs = config.aircraft.map((id) => new FlightEnv(getEntry(id).def, config.env));
    this.policy = new Policy(OBS_SIZE, config.hidden);
  }

  /** Mean return of `params` over `episodes`, plus each episode's summary. */
  score(params, episodes, details = false) {
    this.policy.params.set(params);
    let sum = 0;
    const infos = [];
    for (const ep of episodes) {
      const r = runEpisode(this.envs[ep.aircraft], this.policy, ep.seed);
      sum += r.ret;
      if (details) infos.push({ ...ep, ret: r.ret, ...r.info });
    }
    return { fitness: sum / episodes.length, infos };
  }
}

export class Pool {
  constructor(config, size = Math.max(1, cpus().length)) {
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: config });
      w.unref();
      this.workers.push(w);
    }
  }

  /** Scores for each params vector (all on the same episodes), in order. */
  scoreAll(paramsList, episodes) {
    return new Promise((resolve, reject) => {
      const out = new Array(paramsList.length);
      let next = 0;
      let done = 0;
      const feed = (w) => {
        if (next >= paramsList.length) return;
        const i = next++;
        w.postMessage({ i, params: paramsList[i], episodes });
      };
      for (const w of this.workers) {
        w.removeAllListeners('message');
        w.removeAllListeners('error');
        w.on('error', reject);
        w.on('message', (m) => {
          out[m.i] = m.fitness;
          if (++done === paramsList.length) resolve(out);
          else feed(w);
        });
        feed(w);
      }
    });
  }

  close() {
    return Promise.all(this.workers.map((w) => w.terminate()));
  }
}
