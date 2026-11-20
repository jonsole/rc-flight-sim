// A small fully-connected neural network (multi-layer perceptron) that flies
// a model: observation features in (src/ml/observe.js), stick and throttle
// positions out. Plain JavaScript with no dependencies, so the same code runs
// in the training harness (ml/, under Node) and in the browser.
//
// Layers: obsSize → hidden[0] → hidden[1] … → 4, tanh after every layer.
// Outputs are roll, pitch, yaw in -1..1 and throttle mapped from -1..1 to 0..1.
// All weights live in one flat Float64Array (`params`), which is what the
// trainer perturbs; layer by layer, the weight matrix (out × in, row-major)
// then the biases.

export const ACT_SIZE = 4;

/** Number of parameters for a network with these layer sizes. */
export function paramCount(obsSize, hidden, actSize = ACT_SIZE) {
  const sizes = [obsSize, ...hidden, actSize];
  let n = 0;
  for (let i = 1; i < sizes.length; i++) n += sizes[i] * (sizes[i - 1] + 1);
  return n;
}

export class Policy {
  /**
   * @param {number} obsSize
   * @param {number[]} hidden  hidden layer widths, e.g. [32, 32]
   * @param {Float64Array|number[]} [params]  flat weights (zeros if left out)
   */
  constructor(obsSize, hidden, params) {
    this.obsSize = obsSize;
    this.hidden = hidden.slice();
    this.sizes = [obsSize, ...hidden, ACT_SIZE];
    this.size = paramCount(obsSize, hidden);
    this.params = params ? Float64Array.from(params) : new Float64Array(this.size);
    if (this.params.length !== this.size) throw new Error(`policy needs ${this.size} params, got ${this.params.length}`);
    const widest = Math.max(...this.sizes);
    this._a = new Float64Array(widest);
    this._b = new Float64Array(widest);
  }

  /**
   * Network outputs (each -1..1) for one observation, written to `out`
   * (a length-4 array; a new one if left out).
   */
  forward(obs, out = new Float64Array(ACT_SIZE)) {
    const p = this.params;
    const s = this.sizes;
    let x = this._a;
    let y = this._b;
    for (let i = 0; i < s[0]; i++) x[i] = obs[i];
    let k = 0;
    for (let l = 1; l < s.length; l++) {
      const nIn = s[l - 1];
      const nOut = s[l];
      const bias = k + nOut * nIn;
      for (let o = 0; o < nOut; o++) {
        let sum = p[bias + o];
        const row = k + o * nIn;
        for (let i = 0; i < nIn; i++) sum += p[row + i] * x[i];
        y[o] = Math.tanh(sum);
      }
      k = bias + nOut;
      const t = x;
      x = y;
      y = t;
    }
    for (let o = 0; o < ACT_SIZE; o++) out[o] = x[o];
    return out;
  }

  /** Random starting weights (scaled for tanh), from rng() in 0..1; output layer small. */
  init(rng) {
    const s = this.sizes;
    let k = 0;
    for (let l = 1; l < s.length; l++) {
      const nIn = s[l - 1];
      const nOut = s[l];
      const scale = (l === s.length - 1 ? 0.1 : 1) / Math.sqrt(nIn);
      for (let i = 0; i < nOut * nIn; i++) this.params[k++] = gaussian(rng) * scale;
      for (let i = 0; i < nOut; i++) this.params[k++] = 0;
    }
    return this;
  }

  toJSON(meta = {}) {
    return { format: 'rc-flight-sim-policy', version: 1, obsSize: this.obsSize, hidden: this.hidden, actSize: ACT_SIZE, meta, params: Array.from(this.params) };
  }

  static fromJSON(j) {
    if (j.format !== 'rc-flight-sim-policy') throw new Error('not a policy file');
    return new Policy(j.obsSize, j.hidden, j.params);
  }
}

/** Network outputs (-1..1 each) to the aircraft's control positions. */
export function toControls(a, out = {}) {
  out.roll = a[0];
  out.pitch = a[1];
  out.yaw = a[2];
  out.throttle = 0.5 * (a[3] + 1);
  return out;
}

/** Standard normal sample (Box-Muller) from a uniform rng. */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
