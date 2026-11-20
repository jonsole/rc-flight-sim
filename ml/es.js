// Evolution Strategies (Salimans et al. 2017, "Evolution Strategies as a
// Scalable Alternative to Reinforcement Learning"): try many small random
// changes to the network's weights, fly each, and move the weights towards
// the changes that flew better. It needs no gradients through the flight
// model, copes with crashes and other discontinuities, and every candidate
// flies independently, so it spreads across CPU cores.
//
// Details: mirrored sampling (θ+σε and θ-σε), centred-rank fitness shaping,
// Adam on the estimated gradient, and a little weight decay.
import { makeRng } from './env.js';
import { gaussian } from '../src/ml/policy.js';

export class ES {
  /**
   * @param {Float64Array} theta  starting weights (updated in place)
   * @param {object} o
   * @param {number} [o.pairs]     mirrored pairs per generation (population = 2 × pairs)
   * @param {number} [o.sigma]     noise scale
   * @param {number} [o.lr]        Adam step size
   * @param {number} [o.l2]        weight decay
   * @param {number} [o.seed]
   */
  constructor(theta, o = {}) {
    this.theta = theta;
    this.n = theta.length;
    this.pairs = o.pairs ?? 32;
    this.sigma = o.sigma ?? 0.05;
    this.lr = o.lr ?? 0.02;
    this.l2 = o.l2 ?? 0.005;
    this.rng = makeRng(o.seed ?? 1);
    this.m = new Float64Array(this.n);
    this.v = new Float64Array(this.n);
    this.t = 0;
    this.eps = [];
  }

  /** Candidate weight vectors for this generation (2 × pairs, mirrored). */
  ask() {
    const out = [];
    this.eps = [];
    for (let i = 0; i < this.pairs; i++) {
      const e = new Float64Array(this.n);
      for (let k = 0; k < this.n; k++) e[k] = gaussian(this.rng);
      this.eps.push(e);
      const plus = new Float64Array(this.n);
      const minus = new Float64Array(this.n);
      for (let k = 0; k < this.n; k++) {
        plus[k] = this.theta[k] + this.sigma * e[k];
        minus[k] = this.theta[k] - this.sigma * e[k];
      }
      out.push(plus, minus);
    }
    return out;
  }

  /** Scores for the candidates from ask(), in the same order. Updates theta. */
  tell(fitness) {
    const N = fitness.length;
    const ranks = centredRanks(fitness);
    const g = new Float64Array(this.n);
    for (let i = 0; i < this.pairs; i++) {
      const w = ranks[2 * i] - ranks[2 * i + 1];
      const e = this.eps[i];
      for (let k = 0; k < this.n; k++) g[k] += w * e[k];
    }
    // Ascent direction; Adam minimises, so negate.
    this.t++;
    const b1 = 0.9;
    const b2 = 0.999;
    const a = (this.lr * Math.sqrt(1 - b2 ** this.t)) / (1 - b1 ** this.t);
    let step2 = 0;
    for (let k = 0; k < this.n; k++) {
      const grad = -g[k] / (N * this.sigma) + this.l2 * this.theta[k];
      this.m[k] = b1 * this.m[k] + (1 - b1) * grad;
      this.v[k] = b2 * this.v[k] + (1 - b2) * grad * grad;
      const d = (a * this.m[k]) / (Math.sqrt(this.v[k]) + 1e-8);
      this.theta[k] -= d;
      step2 += d * d;
    }
    return { stepNorm: Math.sqrt(step2) };
  }

  state() {
    return { t: this.t, m: Array.from(this.m), v: Array.from(this.v) };
  }

  load(s) {
    this.t = s.t;
    this.m = Float64Array.from(s.m);
    this.v = Float64Array.from(s.v);
  }
}

/** Fitness → ranks spread evenly over -0.5..0.5 (ties broken by order). */
export function centredRanks(x) {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Array(x.length);
  const n = x.length;
  idx.forEach((i, rank) => {
    r[i] = n > 1 ? rank / (n - 1) - 0.5 : 0;
  });
  return r;
}
