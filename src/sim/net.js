// Insect-net challenge (Menu → Flying → Challenge): tow a drag net on a cord
// from the tail and sweep it through swarms of insects.
//
// The net is a small mass on the end of an elastic cord. It starts folded up
// and opens in the airflow: its mouth opens with the dynamic pressure on it,
// a fraction of a second behind, and folds up again when it goes slack or
// slow. Open, it drags hard (a mesh cone, about Cd 0.5 on its mouth). The
// cord pulls on the aeroplane's tail only when taut. Dragged along the
// ground it rubs; caught in a tree it holds, and a hard enough pull snaps
// the cord.
//
// Difficulty is the net's size: its open-mouth drag at 10 m/s is a share of
// the model's static thrust (12%, 22% or 35%), so each difficulty asks about
// as much of every model. The Tuning tab can change the net's size, its
// drag and the cord's length, per model and difficulty.
import { Vector3 } from 'three';
import { Obstacles } from './obstacles.js';

const RHO = 1.225;
const G = 9.81;
const NET_CD = 0.5; // open mesh cone, on its mouth area
const REF_Q = 0.5 * RHO * 10 * 10; // dynamic pressure at 10 m/s

export const DIFFICULTIES = {
  easy: { name: 'Easy (small net)', short: 'easy', share: 0.12 },
  medium: { name: 'Medium', short: 'medium', share: 0.22 },
  hard: { name: 'Hard (large net)', short: 'hard', share: 0.35 },
};
export const DEFAULT_CORD = 3; // m

/** The net's mouth diameter (m) for a model and difficulty, before any tuning. */
export function defaultNetSize(def, difficulty) {
  const share = (DIFFICULTIES[difficulty] ?? DIFFICULTIES.medium).share;
  const area = (share * def.motor.staticThrust) / (NET_CD * REF_Q);
  return Math.sqrt((4 * area) / Math.PI);
}

// --- Your tuning of the net (Menu → Tuning, while the challenge is on) ----------
const KEY = 'rcsim.net.v1';
function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}
/** { size (cm), drag (×), cord (m) }: only what's been changed, for this model and difficulty. */
export function loadNetTuning(id, difficulty) {
  return loadAll()[id]?.[difficulty] ?? {};
}
export function saveNetTuning(id, difficulty, values) {
  const all = loadAll();
  all[id] = { ...all[id], [difficulty]: values };
  if (!Object.keys(values).length) delete all[id][difficulty];
  if (!Object.keys(all[id]).length) delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: lasts this session */
  }
}

/** The net settings shown in the Tuning tab, with their defaults for this model and difficulty. */
export function netTunables(def, difficulty) {
  const size = Math.round(defaultNetSize(def, difficulty) * 100);
  return [
    { key: 'size', label: 'Net size (mouth across)', unit: 'cm', dflt: size, min: 5, max: Math.max(120, size * 2), step: 1 },
    { key: 'drag', label: 'Net drag factor', unit: '×', dflt: 1, min: 0.2, max: 3, step: 0.05 },
    { key: 'cord', label: 'Cord length', unit: 'm', dflt: DEFAULT_CORD, min: 0.5, max: 15, step: 0.25 },
  ];
}

/** The net as flown: { diameter (m), dragFactor, cordLength (m), tuned }. */
export function netConfig(def, id, difficulty) {
  const t = loadNetTuning(id, difficulty);
  return {
    diameter: t.size != null ? t.size / 100 : defaultNetSize(def, difficulty),
    dragFactor: t.drag ?? 1,
    cordLength: t.cord ?? DEFAULT_CORD,
    tuned: Object.keys(t).length > 0,
  };
}

// --- The net and cord ----------------------------------------------------------
const _a = new Vector3();
const _va = new Vector3();
const _d = new Vector3();
const _u = new Vector3();
const _f = new Vector3();
const _wind = new Vector3();
const _r = new Vector3();
const _w = new Vector3();

export class NetTow {
  /**
   * @param {object} cfg  { diameter, dragFactor, cordLength }
   * @param {object} aircraft  the flight model it's tied to (its def, mass, env)
   */
  constructor(cfg, aircraft) {
    this.diameter = cfg.diameter;
    this.dragFactor = cfg.dragFactor;
    this.cordLength = cfg.cordLength;
    this.mouthArea = (Math.PI * cfg.diameter * cfg.diameter) / 4;
    // A light mesh bag on a hoop: heavier as it gets bigger.
    this.mass = 0.01 + 0.08 * this.mouthArea;
    // The cord: a little stretch under the net's pull, and a damper on it.
    this.stiffness = 400;
    this.damping = 3;
    // Snaps well above anything the model can pull in the air: a tree has it.
    this.breakStrength = Math.max(25, 4 * aircraft.mass * G, 2.5 * aircraft.def.motor.staticThrust);
    // Tied on at the tail: the rearmost point of the model, on the centre line.
    const tail = aircraft.def.contacts.reduce((a, c) => (c.pos[0] < a.pos[0] ? c : a));
    this.attach = new Vector3(tail.pos[0], tail.pos[1], 0);
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.open = 0; // 0 folded up .. 1 fully open
    this.tension = 0;
    this.snapped = false;
    this.snagged = false; // caught in a tree
    this.onGround = false;
    this.airspeed = 0;
    this.axis = new Vector3(-1, 0, 0); // which way the bag streams (world)
    this._near = [];
  }

  /** Where the cord is tied on (world). */
  attachPoint(aircraft, out = new Vector3()) {
    return out.copy(this.attach).applyQuaternion(aircraft.orientation).add(aircraft.position);
  }

  /** Lay the net out behind the aeroplane, folded: on the ground, or trailing in the air. */
  place(aircraft) {
    const p = this.attachPoint(aircraft, _a);
    const back = new Vector3(-1, 0, 0).applyQuaternion(aircraft.orientation).setY(0);
    if (back.lengthSq() < 1e-6) back.set(-1, 0, 0);
    back.normalize();
    const ground = aircraft.env.ground;
    const L = this.cordLength * 0.95; // a little slack
    this.snapped = false;
    this.snagged = false;
    this.tension = 0;
    this.velocity.copy(aircraft.velocity);
    if (aircraft.velocity.length() > 3) {
      // Flying: streaming out behind, open.
      this.position.copy(p).addScaledVector(back, this.cordLength);
      this.open = 1;
    } else {
      const h = p.y - ground.heightAt(p.x, p.z);
      const reach = L > h ? Math.sqrt(L * L - h * h) : 0;
      this.position.copy(p).addScaledVector(back, reach);
      this.position.y = reach > 0 ? ground.heightAt(this.position.x, this.position.z) : p.y - L;
      this.open = 0;
    }
    this.axis.copy(back);
  }

  /**
   * One physics sub-step, from inside the aeroplane's (src/sim/aircraft.js):
   * moves the net and adds the cord's pull on the aeroplane to its world
   * force and body moment.
   */
  step(aircraft, dt, fWorld, mBody, q, qi) {
    const env = aircraft.env;
    // The tail's position and velocity.
    _r.copy(this.attach).applyQuaternion(q);
    const a = _a.copy(_r).add(aircraft.position);
    _w.copy(aircraft.omega).applyQuaternion(q);
    const va = _va.crossVectors(_w, _r).add(aircraft.velocity);

    // --- Cord ---------------------------------------------------------------
    _f.set(0, -this.mass * G, 0);
    this.tension = 0;
    if (!this.snapped) {
      _d.copy(this.position).sub(a);
      const dist = _d.length();
      if (dist > this.cordLength && dist > 1e-6) {
        _d.multiplyScalar(1 / dist);
        const stretchRate = _u.copy(this.velocity).sub(va).dot(_d);
        const t = Math.max(0, this.stiffness * (dist - this.cordLength) + this.damping * stretchRate);
        this.tension = t;
        if (t > this.breakStrength) {
          this.snapped = true;
          this.tension = 0;
        } else {
          _f.addScaledVector(_d, -t);
          // The same pull on the tail, towards the net.
          _u.copy(_d).multiplyScalar(t);
          fWorld.add(_u);
          _u.applyQuaternion(qi);
          mBody.add(_u.crossVectors(this.attach, _u));
        }
      }
    }

    // --- Air on the net -----------------------------------------------------
    const W = env.wind;
    const agl = this.position.y - env.ground.heightAt(this.position.x, this.position.z);
    const wind = W ? W.at(this.position, aircraft.time, _wind, agl) : _wind.set(0, 0, 0);
    _u.copy(this.velocity).sub(wind);
    const speed = _u.length();
    this.airspeed = speed;
    const qd = 0.5 * RHO * speed * speed;
    // Opens with the airflow (about 2 m/s to start, fully by 6), quickly;
    // folds back up when slack or slow, more slowly.
    const want = Math.min(1, Math.max(0, (qd - 2.5) / 20));
    const tau = want > this.open ? 0.25 : 0.8;
    this.open += (want - this.open) * Math.min(1, dt / tau);
    // Folded, it's a small bundle; open, the full mouth.
    const area = this.mouthArea * (0.06 + 0.94 * this.open);
    if (speed > 1e-3) _f.addScaledVector(_u, -NET_CD * this.dragFactor * 0.5 * RHO * area * speed);
    // The bag streams downwind of the cord.
    if (speed > 0.5) this.axis.lerp(_u.multiplyScalar(-1 / speed), Math.min(1, dt / 0.1)).normalize();

    // --- Trees: the net catches and holds --------------------------------
    this.snagged = false;
    if (env.obstacles) {
      const p = this.position;
      for (const s of env.obstacles.near(p.x, p.z, 0.5, this._near)) {
        const hit = Obstacles.test(s, p.x, p.y, p.z);
        if (!hit) continue;
        this.snagged = true;
        if (!hit.soft) p.addScaledVector(_d.set(hit.nx, hit.ny, hit.nz), hit.depth);
        break;
      }
    }

    // --- Integrate ------------------------------------------------------------
    this.velocity.addScaledVector(_f, dt / this.mass);
    if (this.snagged) this.velocity.multiplyScalar(Math.exp(-dt * 30));
    this.position.addScaledVector(this.velocity, dt);
    // On the ground: rubs along the grass.
    const gy = env.ground.heightAt(this.position.x, this.position.z) + 0.03;
    this.onGround = this.position.y <= gy;
    if (this.onGround) {
      this.position.y = gy;
      if (this.velocity.y < 0) this.velocity.y = 0;
      const h = Math.hypot(this.velocity.x, this.velocity.z);
      if (h > 1e-6) {
        const k = Math.max(0, h - 0.8 * G * dt) / h;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
    }
  }

  /** The open mouth's area facing the air (m²): what sweeps up insects. */
  sweptArea() {
    return this.mouthArea * this.open;
  }
}

// --- Insect swarms and the score ----------------------------------------------
// Swarms hang a few metres up around the field, drifting a little. Each is a
// fuzzy ball (a Gaussian, σ = 2 m) of insects. Flying the open net through
// one catches what it sweeps: about 1000 per m² of mouth for a pass through
// the middle when it's full. A swarm runs out after about three good passes
// and disperses; a new one forms somewhere else. The target is eight good
// passes' worth, so it takes about as much flying with any net.
const SIGMA = 2;
const PEAK = 1000 / (SIGMA * Math.sqrt(2 * Math.PI)); // insects / m³ at the middle
const SWARMS = 5;

export class InsectChallenge {
  /**
   * @param {object} opts { ground, center: {x, z}, radius, rand, clear(x, y, z): is there room for a swarm here }
   */
  constructor(net, opts) {
    this.net = net;
    this.ground = opts.ground;
    this.center = opts.center;
    this.radius = opts.radius ?? 140;
    this.rand = opts.rand ?? Math.random;
    this.clear = opts.clear ?? (() => true);
    this.target = Math.max(10, Math.round((8 * 1000 * net.mouthArea) / 10) * 10);
    this.caught = 0;
    this.time = 0;
    this.done = false;
    this.started = false; // the clock starts once the model's moving (set by the caller)
    this.swarms = [];
    for (let i = 0; i < SWARMS; i++) this.swarms.push(this.#newSwarm());
  }

  #newSwarm() {
    // Somewhere around the field, clear of trees and buildings if it can be.
    let x;
    let y;
    let z;
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rand() * Math.PI * 2;
      const r = this.radius * (0.3 + 0.7 * Math.sqrt(this.rand()));
      x = this.center.x + Math.cos(a) * r;
      z = this.center.z + Math.sin(a) * r;
      y = this.ground.heightAt(x, z) + 4 + this.rand() * 12;
      if (this.clear(x, y, z)) break;
    }
    // Enough for about three good passes.
    const capacity = 3 * 1000 * this.net.mouthArea;
    return { pos: new Vector3(x, y, z), home: new Vector3(x, y, z), phase: this.rand() * 10, capacity, left: capacity, fade: 0 };
  }

  /** Insect density (per m³) at a point. */
  densityAt(p) {
    let d = 0;
    for (const s of this.swarms) {
      const r2 = p.distanceToSquared(s.pos);
      if (r2 > 25 * SIGMA * SIGMA) continue;
      d += PEAK * (s.left / s.capacity) * Math.exp(-r2 / (2 * SIGMA * SIGMA));
    }
    return d;
  }

  /** Advance by dt (seconds of flying). */
  update(dt) {
    for (let i = 0; i < this.swarms.length; i++) {
      const s = this.swarms[i];
      s.phase += dt;
      // Drifting about its spot.
      s.pos.set(s.home.x + Math.sin(s.phase * 0.31) * 1.5, s.home.y + Math.sin(s.phase * 0.53) * 0.6, s.home.z + Math.cos(s.phase * 0.23) * 1.5);
      if (s.left < 0.05 * s.capacity) {
        s.fade += dt;
        if (s.fade > 2) this.swarms[i] = this.#newSwarm();
      }
    }
    if (this.done || !this.started) return;
    this.time += dt;
    const net = this.net;
    if (net.snapped) return;
    const swept = net.sweptArea() * net.airspeed * dt; // m³ of air through the mouth
    if (swept <= 0) return;
    for (const s of this.swarms) {
      const r2 = net.position.distanceToSquared(s.pos);
      if (r2 > 25 * SIGMA * SIGMA) continue;
      const got = Math.min(s.left, swept * PEAK * (s.left / s.capacity) * Math.exp(-r2 / (2 * SIGMA * SIGMA)));
      s.left -= got;
      this.caught += got;
    }
    if (this.caught >= this.target) {
      this.caught = this.target;
      this.done = true;
    }
  }

  /** The nearest swarm with insects left (for the HUD's pointer). */
  nearest(p) {
    let best = null;
    let bd = Infinity;
    for (const s of this.swarms) {
      if (s.left < 0.05 * s.capacity) continue;
      const d = p.distanceToSquared(s.pos);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
}

// --- Best times, per model and difficulty (untuned nets only) --------------------
const BEST_KEY = 'rcsim.netBest.v1';
export function bestTime(id, difficulty) {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY))?.[`${id}/${difficulty}`] ?? null;
  } catch {
    return null;
  }
}
/** Record a time; true if it's a new best. */
export function recordTime(id, difficulty, seconds) {
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(BEST_KEY)) ?? {};
  } catch {
    /* none */
  }
  const k = `${id}/${difficulty}`;
  if (all[k] != null && all[k] <= seconds) return false;
  all[k] = seconds;
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked */
  }
  return true;
}
