// Insect-net challenge (Menu → Challenges → Insect net tow; the course is
// src/game/netTow.js): tow a drag net on a cord
// from under the belly, climb to the sampling height and fly figure-of-8 circuits
// through the gates, catching the insects drifting up there.
//
// The net is a small mass on the end of an elastic cord. It starts folded up
// and opens in the airflow: its mouth opens with the dynamic pressure on it,
// a fraction of a second behind, and folds up again when it goes slack or
// slow. Open, it drags hard (a mesh cone, about Cd 0.5 on its mouth). The
// cord pulls on the aeroplane (tied on under the CG) only when taut. Dragged along the
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
  normal: { name: 'Normal', short: 'normal', share: 0.22 },
  hard: { name: 'Hard (large net)', short: 'hard', share: 0.35 },
};
export const DEFAULT_CORD = 3; // m

/** The net's mouth diameter (m) for a model and difficulty, before any tuning. */
export function defaultNetSize(def, difficulty) {
  const share = (DIFFICULTIES[difficulty] ?? DIFFICULTIES.normal).share;
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
    // Tied on under the belly, right below the CG (the body frame's origin),
    // so the pull hardly turns the model: the bottom of the fuselage is the
    // lowest of its centre-line touch points (not the wheels or the prop).
    const belly = aircraft.def.contacts.filter((c) => Math.abs(c.pos[2]) < 0.05 && c.type !== 'wheel' && c.type !== 'prop' && !/prop/.test(c.name));
    const y = belly.length ? Math.min(...belly.map((c) => c.pos[1])) : -0.05;
    this.attach = new Vector3(0, y - 0.01, 0);
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
    // The tie-on point's position and velocity.
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
          // The same pull on the model, towards the net.
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

// --- The course: climb, then figure-of-8 circuits --------------------------------
// Insect-sampling flights tow a net at height. Climb to the sampling height
// (40 m, ±10), then fly figure-of-8 circuits over the field: two touching
// loops, one flown to the left and one to the right, through gates around
// them, in order, at that height. A gate counts when the model passes
// within 15 m of it (across) while in the height band. The net catches the
// insects drifting at that height on the way round.
export const COURSE = {
  height: 40, // m above the pilot's ground
  band: 10, // ± m
  radius: 45, // each loop's radius (m)
  gate: 15, // how near a gate to pass (m, across)
  laps: 3, // figure-of-8s to fly
};
const AERIAL_DENSITY = 0.6; // insects per m³ drifting at height (fewer lower down)

export class FigureEightChallenge {
  /**
   * @param {NetTow} net
   * @param {object} opts { ground, base: ground height to measure from, center: {x, z}, axis: {x, z}
   *   (along the 8, unit), side: {x, z} (across it, unit), course: overrides of COURSE }
   */
  constructor(net, opts) {
    this.net = net;
    this.ground = opts.ground;
    this.course = { ...COURSE, ...opts.course };
    const c = this.course;
    this.base = opts.base ?? 0;
    this.y = this.base + c.height;
    // Two loops touching at the centre: A on the +axis side flown one way,
    // B on the −axis side the other, both crossing the centre going +side.
    const { center: o, axis: u, side: v } = opts;
    const R = c.radius;
    const at = (cx, cz, th) => new Vector3(cx + R * (Math.cos(th) * u.x + Math.sin(th) * v.x), this.y, cz + R * (Math.cos(th) * u.z + Math.sin(th) * v.z));
    const ax = o.x + u.x * R;
    const az = o.z + u.z * R;
    const bx = o.x - u.x * R;
    const bz = o.z - u.z * R;
    const mid = new Vector3(o.x, this.y, o.z);
    // Gates: A at 90°, 0°, −90° (its far side), the centre, B at 90°, 180°, 270°, the centre.
    this.lap = [
      at(ax, az, Math.PI / 2), at(ax, az, 0), at(ax, az, -Math.PI / 2), mid,
      at(bx, bz, Math.PI / 2), at(bx, bz, Math.PI), at(bx, bz, 1.5 * Math.PI), mid,
    ].map((p, i) => ({ pos: p, loop: i < 3 ? 'A' : i === 3 ? 'mid' : i < 7 ? 'B' : 'mid' }));
    // The whole route, for drawing: both circles.
    this.path = [];
    for (let i = 0; i <= 64; i++) this.path.push(at(ax, az, Math.PI - (2 * Math.PI * i) / 64));
    for (let i = 0; i <= 64; i++) this.path.push(at(bx, bz, (2 * Math.PI * i) / 64));
    // The A loop turns one way and B the other, seen from above.
    this.turnA = u.x * v.z - u.z * v.x < 0 ? 'right' : 'left';
    this.turnB = this.turnA === 'left' ? 'right' : 'left';
    this.gateIndex = 0; // the centre gate first, then round loop A …
    this.started = false; // the clock starts at the first gate
    this.reachedHeight = false;
    this.lapsDone = 0;
    this.caught = 0;
    this.time = 0;
    this.done = false;
  }

  /** The gate to fly through next (the first is the centre, where the loops touch). */
  nextGate() {
    return this.gateIndex === 0 ? this.lap[7] : this.lap[(this.gateIndex - 1) % 8];
  }

  get gatesPerLap() {
    return 8;
  }

  /** Height above the field. */
  heightOf(p) {
    return p.y - this.base;
  }

  /**
   * Advance by dt with the aircraft at `pos` (world): gates passed, insects
   * caught, the clock.
   */
  update(dt, pos) {
    if (this.done) return;
    const c = this.course;
    const h = this.heightOf(pos);
    const inBand = Math.abs(h - c.height) <= c.band;
    if (inBand) this.reachedHeight = true;
    const g = this.nextGate();
    if (inBand && Math.hypot(pos.x - g.pos.x, pos.z - g.pos.z) < c.gate) {
      if (this.gateIndex === 0) this.started = true;
      else if (this.gateIndex % 8 === 0) this.lapsDone++;
      this.gateIndex++;
      if (this.lapsDone >= c.laps) {
        this.done = true;
        return;
      }
    }
    if (this.started) this.time += dt;
    // Insects drift thicker the higher you go, up to the sampling height.
    const net = this.net;
    if (!net.snapped && !net.snagged) {
      const nh = this.heightOf(net.position);
      const density = AERIAL_DENSITY * Math.max(0, Math.min(1, (nh - 3) / (c.height - 3)));
      this.caught += density * net.sweptArea() * net.airspeed * dt;
    }
  }

  /**
   * What to do now, in words: { text, turn: 'left' | 'right' | null, climb: −1 | 0 | 1 },
   * for the model at `pos` heading `heading` (world radians about the vertical, 0 = +x).
   */
  directions(pos, heading) {
    const c = this.course;
    const h = this.heightOf(pos);
    const climb = h < c.height - c.band ? 1 : h > c.height + c.band ? -1 : 0;
    if (this.done) return { text: 'Course complete! Land, or R to fly it again', turn: null, climb: 0 };
    const g = this.nextGate();
    // Which way to the gate.
    const want = Math.atan2(-(g.pos.z - pos.z), g.pos.x - pos.x);
    let d = want - heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const turn = Math.abs(d) < 0.3 ? null : d > 0 ? 'left' : 'right';
    let text;
    if (!this.reachedHeight) text = `Climb to ${c.height} m (now ${Math.max(0, Math.round(h))} m)`;
    else if (climb > 0) text = `Too low: climb to ${c.height} m`;
    else if (climb < 0) text = `Too high: down to ${c.height} m`;
    else if (this.gateIndex === 0) text = 'Fly through the start gate, where the loops meet';
    else {
      const loop = g.loop === 'mid' ? 'to the crossing' : `${g.loop === 'A' ? this.turnA : this.turnB}-hand loop`;
      text = `Gate ${((this.gateIndex - 1) % 8) + 1} of 8, ${loop}`;
    }
    return { text, turn, climb };
  }
}
