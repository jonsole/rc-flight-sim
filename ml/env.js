// A training environment around the game's own flight model
// (src/sim/aircraft.js): reset it, give it stick positions, get back what the
// pilot sees and a score. Same idea as an OpenAI Gym / Gymnasium environment.
//
// The world is kept simple and fast: flat grass, no trees, and a made-up
// gusty wind (SimpleWind), so what is learnt is flying, not one field.
// Every episode is set up from its seed, so the same seed always gives the
// same flight: the trainer scores every candidate on the same seeds.
//
// Tasks (all use the same observations, src/ml/observe.js):
//   hold       fly at a commanded heading, height and airspeed; the command
//              changes every 6-14 s.
//   waypoints  fly through a chain of points in the sky, one after another.
//   recover    start in an upset (steep bank, inverted, nose high or low,
//              slow), then hold heading and height as in "hold".
import { Vector3, Quaternion } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { observe, OBS_SIZE, OBS_NAMES, resolveInputs, selectInputs } from '../src/ml/observe.js';
import { toControls } from '../src/ml/policy.js';
import { cruiseSpeed } from './aircraft.js';

export const TASKS = ['hold', 'waypoints', 'recover'];

/** Small fast seeded random number generator (mulberry32): rng() is 0..1. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flatGround = {
  heightAt: () => 0,
  normalAt: (x, z, out) => out.set(0, 1, 0),
  surfaceAt: () => ({ roll: 0.05, stiction: 0.5, drag: 1 }),
};

/**
 * Wind: a steady breeze that drops off towards the ground (log profile),
 * plus gusts made of a few sine waves in time and space with random phases,
 * so each wing can feel slightly different air. Same interface as the
 * game's Wind (at(pos, t, out, agl)).
 */
export class SimpleWind {
  constructor(rng, { speed = 3, turbulence = 0.3 } = {}) {
    const dir = rng() * 2 * Math.PI;
    this.mean = new Vector3(Math.cos(dir), 0, Math.sin(dir)).multiplyScalar(speed);
    this.waves = [];
    const amp = turbulence * (0.6 + 0.25 * speed);
    for (let i = 0; i < 4; i++) {
      this.waves.push({
        a: new Vector3((rng() - 0.5) * 2, (rng() - 0.5) * 0.8, (rng() - 0.5) * 2).multiplyScalar(amp / (i + 1)),
        w: 0.3 + rng() * 1.5 * (i + 1), // rad/s
        k: (0.02 + rng() * 0.08) * (i + 1), // rad/m
        p: rng() * 2 * Math.PI,
      });
    }
  }

  at(pos, t, out, agl = 10) {
    const h = Math.max(0.3, agl);
    out.copy(this.mean).multiplyScalar(Math.min(1.3, Math.log(h / 0.05) / Math.log(10 / 0.05)));
    for (const g of this.waves) {
      const s = Math.sin(g.w * t + g.k * (pos.x + 0.7 * pos.z) + g.p);
      out.addScaledVector(g.a, s);
    }
    return out;
  }
}

export class FlightEnv {
  /**
   * @param {object} def       aircraft definition (entry.def)
   * @param {object} [o]
   * @param {string} [o.task]            'hold' | 'waypoints' | 'recover'
   * @param {number} [o.seconds]         episode length
   * @param {number} [o.controlHz]       how often the pilot moves the sticks
   * @param {number} [o.substep]         physics step (the game uses 1/600)
   * @param {number} [o.windMax]         strongest mean wind (m/s), 0 for calm
   * @param {boolean} [o.randomizeMass] vary weight and inertia ±10% per episode
   * @param {string|string[]} [o.inputs] which observations the policy gets: 'sim' (all), 'hardware', or names
   */
  constructor(def, o = {}) {
    if (!TASKS.includes(o.task ?? 'hold')) throw new Error(`unknown task "${o.task}"; have: ${TASKS.join(', ')}`);
    this.def = def;
    this.task = o.task ?? 'hold';
    this.seconds = o.seconds ?? 30;
    this.controlHz = o.controlHz ?? 50;
    this.substep = o.substep ?? 1 / 600;
    this.windMax = o.windMax ?? 4;
    this.randomizeMass = o.randomizeMass ?? true;
    this.vCruise = cruiseSpeed(def);
    this.ac = new Aircraft(def, { ground: flatGround, wind: null });
    this.ac.assistMode = 'off';
    this.target = { x: 0, y: 0, z: 0, speed: 0 };
    this.prev = new Float64Array(4);
    this.inputs = resolveInputs(o.inputs ?? 'sim');
    this.inputIdx = this.inputs.map((n) => OBS_NAMES.indexOf(n));
    this.full = new Float64Array(OBS_SIZE); // every feature (what --trace writes)
    this.obs = new Float64Array(this.inputs.length); // the ones the policy sees
    this.ctl = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  }

  get obsSize() {
    return this.inputs.length;
  }

  #observe() {
    observe(this.ac, this.target, this.prev, 0, this.full);
    return selectInputs(this.full, this.inputIdx, this.obs);
  }

  /** Start a new episode, set up from `seed`. Returns the first observation. */
  reset(seed) {
    const rng = (this.rng = makeRng(seed));
    const ac = this.ac;
    const v = this.vCruise;
    ac.env.wind = this.windMax > 0 ? new SimpleWind(rng, { speed: rng() * this.windMax, turbulence: 0.1 + rng() * 0.4 }) : null;
    if (this.randomizeMass) {
      const m = 0.9 + 0.2 * rng();
      ac.mass = this.def.mass * m;
      ac.inertia.set(...this.def.inertia).multiplyScalar(0.9 + 0.2 * rng());
    }
    const heading = rng() * 2 * Math.PI;
    const alt = 30 + rng() * 30;
    const speed = v * (1.1 + 0.5 * rng());
    ac.resetInAir(new Vector3(0, alt, 0), heading, speed);
    ac.throttleActual = 0.3 + 0.4 * rng();
    // Left over from the last flight and read on the first step (downwash,
    // wake, battery voltage): clear them so a seed always flies the same.
    ac.wingCL = 0;
    ac.wingStall = 0;
    ac.battery.restFrac = 1;
    Object.assign(ac.controls, { roll: 0, pitch: 0, yaw: 0, throttle: ac.throttleActual });
    if (this.task === 'recover') this.#upset(rng, speed);
    else {
      // A little disturbance so it can't just learn one perfect start.
      const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (rng() - 0.5) * 0.4);
      ac.orientation.multiply(q);
    }
    this.t = 0;
    this.steps = 0;
    this.prev.fill(0);
    this.reached = 0;
    this.minAgl = alt;
    this.errSum = { alt: 0, hdg: 0, spd: 0, n: 0 };
    this.cmd = null;
    this.nextCmdAt = 0;
    this.waypoint = null;
    this.#updateTarget(true);
    // One tiny step so the aircraft's telemetry (airspeed, alpha...) is set.
    ac.step(1e-6);
    this.lastDist = this.#dist();
    return this.#observe();
  }

  #upset(rng, speed) {
    const ac = this.ac;
    const roll = (rng() - 0.5) * 2 * Math.PI; // anything, inverted included
    const pitch = (rng() - 0.5) * 1.6; // ±45°
    const heading = rng() * 2 * Math.PI;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading);
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch));
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), roll));
    ac.orientation.copy(q);
    const s = speed * (0.5 + 0.8 * rng());
    ac.velocity.set(s, 0, 0).applyQuaternion(q);
    ac.omega.set((rng() - 0.5) * 3, (rng() - 0.5) * 1, (rng() - 0.5) * 2);
    ac.position.y = 50 + rng() * 30;
  }

  /** Horizontal heading (rad, same sense as Aircraft.attitude) of a world vector. */
  static headingOf(x, z) {
    return Math.atan2(z, x);
  }

  #updateTarget(first = false) {
    const ac = this.ac;
    const rng = this.rng;
    const p = ac.position;
    if (this.task === 'waypoints') {
      let from = p;
      if (!first && this.#dist() < 10) {
        this.reached++;
        from = this.waypoint;
        this.waypoint = null;
      }
      if (!this.waypoint) {
        // Next point: 60-140 m on from the last, turning up to ±150° from the way we're going.
        const hv = first ? ac.attitude().heading : Math.atan2(ac.velocity.z, ac.velocity.x);
        const h = hv + (rng() - 0.5) * (first ? 1.5 : 5.2);
        const d = 60 + rng() * 80;
        this.waypoint = { x: from.x + Math.cos(h) * d, y: 20 + rng() * 50, z: from.z + Math.sin(h) * d };
        this.target.speed = this.vCruise * (1.2 + 0.4 * rng());
        if (!first) this.lastDist = Math.hypot(this.waypoint.x - p.x, this.waypoint.y - p.y, this.waypoint.z - p.z);
      }
      Object.assign(this.target, this.waypoint);
      return;
    }
    // hold / recover: a command (heading, height, speed), changed every 6-14 s.
    if (first || (this.task === 'hold' && this.t >= this.nextCmdAt)) {
      const prev = this.cmd;
      this.cmd = {
        heading: prev ? prev.heading + (rng() - 0.5) * 2 * (2 * Math.PI) / 3 : first && this.task === 'recover' ? rng() * 2 * Math.PI : ac.attitude().heading + (rng() - 0.5) * 1.0,
        alt: 25 + rng() * 45,
        speed: this.vCruise * (1.1 + 0.6 * rng()),
      };
      this.nextCmdAt = this.t + 6 + 8 * rng();
    }
    // A point 150 m ahead along the commanded heading, at the commanded height.
    const c = this.cmd;
    this.target.x = p.x + Math.cos(c.heading) * 150;
    this.target.z = p.z + Math.sin(c.heading) * 150;
    this.target.y = c.alt;
    this.target.speed = c.speed;
  }

  #dist() {
    const p = this.ac.position;
    const t = this.target;
    return Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
  }

  /**
   * Fly one control period with the network's outputs `a` (4 values, -1..1).
   * Returns { obs, reward, done, info }.
   */
  step(a) {
    const ac = this.ac;
    const dtc = 1 / this.controlHz;
    toControls(a, this.ctl);
    Object.assign(ac.controls, this.ctl);
    ac.update(dtc, this.substep);
    this.t += dtc;
    this.steps++;

    let change = 0;
    for (let k = 0; k < 4; k++) {
      change += Math.abs(a[k] - this.prev[k]);
      this.prev[k] = a[k];
    }

    const agl = ac.position.y;
    this.minAgl = Math.min(this.minAgl, agl);
    let reward = 0;
    let done = false;
    let reason = '';
    const v = this.vCruise;

    if (this.task === 'waypoints') {
      const before = this.reached;
      this.#updateTarget();
      const d = this.#dist();
      if (this.reached > before) reward += 5;
      else reward += (this.lastDist - d) / v; // ~1 per second flying straight at it at cruise
      this.lastDist = d;
    } else {
      this.#updateTarget();
      const c = this.cmd;
      const hv = Math.atan2(ac.velocity.z, ac.velocity.x);
      let dh = hv - c.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const altErr = Math.abs(agl - c.alt);
      const spdErr = Math.abs(ac.airspeed - c.speed);
      reward += dtc * (1 - 0.4 * Math.min(1, altErr / 15) - 0.4 * Math.min(1, Math.abs(dh) / (Math.PI / 2)) - 0.2 * Math.min(1, spdErr / 4));
      this.errSum.alt += altErr;
      this.errSum.hdg += Math.abs(dh);
      this.errSum.spd += spdErr;
      this.errSum.n++;
    }
    // Shared penalties: getting low, stalling, and jerky sticks.
    if (agl < 10) reward -= dtc * (10 - agl) / 10;
    reward -= dtc * 0.5 * ac.wingStall;
    reward -= dtc * 0.05 * change * this.controlHz / 10;

    if (ac.crashed || agl < 1.5) {
      done = true;
      reason = ac.crashed ? ac.crashReason : 'hit the ground';
      reward -= 10;
    } else if (Math.hypot(ac.position.x, ac.position.z) > 2000) {
      done = true;
      reason = 'flew away';
      reward -= 10;
    } else if (this.t >= this.seconds - 1e-9) {
      done = true;
      reason = 'time';
    }
    return { obs: this.#observe(), reward, done, info: done ? this.summary(reason) : null };
  }

  summary(reason) {
    const e = this.errSum;
    const n = Math.max(1, e.n);
    return {
      reason,
      seconds: this.t,
      crashed: reason !== 'time',
      waypoints: this.reached,
      minAgl: this.minAgl,
      meanAltErr: e.n ? e.alt / n : null,
      meanHdgErrDeg: e.n ? ((e.hdg / n) * 180) / Math.PI : null,
      meanSpdErr: e.n ? e.spd / n : null,
    };
  }
}

/**
 * Fly one episode with `policy` (anything with forward(obs, out)).
 * `onStep(env, action, reward)` is called after every control step if given.
 * Returns { ret, info }.
 */
export function runEpisode(env, policy, seed, onStep) {
  let obs = env.reset(seed);
  const a = new Float64Array(4);
  let ret = 0;
  for (;;) {
    policy.forward(obs, a);
    const r = env.step(a);
    ret += r.reward;
    if (onStep) onStep(env, a, r.reward);
    if (r.done) return { ret, info: r.info };
    obs = r.obs;
  }
}
