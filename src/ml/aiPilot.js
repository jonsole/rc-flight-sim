// An AI flyer: an aeroplane of its own, flown round the field by a trained
// neural-network policy (src/ml/policy.js, trained by ml/train.js).
//
// It wanders between random waypoints over the field at 40-70 m, high enough
// to clear the trees. The policy was trained to fly at a point a long way
// ahead at a height and speed (the "hold" task), so it is given a point
// 150 m along the way to the next waypoint, at the waypoint's height above
// the ground there: exactly what it saw in training. After a crash it is
// put back in the air a few seconds later.
//
// Plain JavaScript with no browser parts, so it runs in the tests too.
import { Vector3 } from 'three';
import { Aircraft } from '../sim/aircraft.js';
import { Policy, toControls } from './policy.js';
import { observe, OBS_NAMES, OBS_SIZE, resolveInputs, selectInputs } from './observe.js';

const CONTROL_DT = 1 / 50; // the policies are trained at 50 Hz
const CARROT = 150; // m: how far ahead the target point is (as in training)
const REACHED = 30; // m (horizontally) from a waypoint to go on to the next
const RESPAWN = 4; // s after a crash
const MIN_AGL = 30; // m: below this the target is raised (hills, a bad dive)

/**
 * A comfortable cruising airspeed (m/s): the speed at which the wing carries
 * the model's weight at a lift coefficient of 0.7.
 */
export function cruiseSpeed(def) {
  const S = def.surfaces.filter((s) => s.wing).reduce((a, s) => a + s.area, 0);
  return Math.sqrt((2 * def.mass * 9.81) / (1.225 * S * 0.7));
}

export class AiPilot {
  /**
   * @param {object} def         aircraft definition (registry entry.def)
   * @param {object} policyJson  saved policy (format rc-flight-sim-policy)
   * @param {object} env         { ground, wind, obstacles } as for Aircraft
   * @param {object} area        { x, z, radius }: where to fly (world metres)
   * @param {() => number} [rng] 0..1
   */
  constructor(def, policyJson, env, area, rng = Math.random) {
    this.def = def;
    this.env = env;
    this.area = area;
    this.rng = rng;
    this.policy = Policy.fromJSON(policyJson);
    const inputs = resolveInputs(policyJson.meta?.inputs ?? 'sim');
    this.inputIdx = inputs.map((n) => OBS_NAMES.indexOf(n));
    if (this.inputIdx.length !== this.policy.obsSize) throw new Error('policy inputs do not match its network');
    this.vCruise = cruiseSpeed(def);
    this.full = new Float64Array(OBS_SIZE);
    this.obs = new Float64Array(this.inputIdx.length);
    this.act = new Float64Array(4);
    this.prev = new Float64Array(4);
    this.target = { x: 0, y: 0, z: 0, speed: 0 };
    this.waypoint = null;
    this.crashes = 0;
    this.spawn();
  }

  /** Into the air at the edge of the area, heading across it. */
  spawn() {
    const { x, z, radius } = this.area;
    const ground = this.env.ground;
    const a = this.rng() * 2 * Math.PI;
    const px = x + Math.cos(a) * radius * 0.8;
    const pz = z + Math.sin(a) * radius * 0.8;
    const toward = Math.atan2(-(z - pz), x - px) + (this.rng() - 0.5) * 0.8; // (Aircraft's heading sense)
    // A fresh flight model each time: nothing left over from the last flight.
    this.ac = new Aircraft(this.def, this.env);
    this.ac.assistMode = 'off';
    this.ac.resetInAir(new Vector3(px, ground.heightAt(px, pz) + 45 + this.rng() * 15, pz), toward, this.vCruise * 1.3);
    this.ac.controls.throttle = 0.5;
    this.ac.step(1e-6); // sets its airspeed and the rest, for the first look
    this.prev.fill(0);
    this.nextControl = 0;
    this.downFor = 0;
    this.waypoint = null;
    this.#nextWaypoint();
  }

  #nextWaypoint() {
    const { x, z, radius } = this.area;
    const p = this.ac.position;
    // Somewhere in the area, at least 80 m from here.
    let wx = x;
    let wz = z;
    for (let i = 0; i < 20; i++) {
      const r = radius * Math.sqrt(this.rng());
      const a = this.rng() * 2 * Math.PI;
      wx = x + Math.cos(a) * r;
      wz = z + Math.sin(a) * r;
      if (Math.hypot(wx - p.x, wz - p.z) > 80) break;
    }
    this.waypoint = { x: wx, z: wz, agl: 40 + this.rng() * 30, speed: this.vCruise * (1.2 + 0.3 * this.rng()), since: 0 };
  }

  #updateTarget() {
    const p = this.ac.position;
    const w = this.waypoint;
    const dx = w.x - p.x;
    const dz = w.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < REACHED || w.since > 60) {
      this.#nextWaypoint();
      return this.#updateTarget();
    }
    const ground = this.env.ground;
    const t = this.target;
    t.x = p.x + (dx / d) * CARROT;
    t.z = p.z + (dz / d) * CARROT;
    // The waypoint's height above the ground there, and never too low over
    // the ground here or just ahead.
    const floor = Math.max(ground.heightAt(p.x, p.z), ground.heightAt(p.x + (dx / d) * 60, p.z + (dz / d) * 60)) + MIN_AGL;
    t.y = Math.max(ground.heightAt(w.x, w.z) + w.agl, floor);
    t.speed = w.speed;
  }

  /** Advance by `dt` seconds: the policy moves the sticks 50 times a second. */
  update(dt) {
    const ac = this.ac;
    if (ac.crashed || (ac.onGround && ac.airspeed < 2)) {
      ac.controls.throttle = 0;
      ac.update(dt);
      this.downFor += dt;
      if (this.downFor > RESPAWN) {
        this.crashes++;
        this.spawn();
      }
      return;
    }
    this.nextControl -= dt;
    if (this.nextControl <= 0) {
      this.nextControl += CONTROL_DT;
      if (this.nextControl < 0) this.nextControl = 0;
      this.waypoint.since += CONTROL_DT;
      this.#updateTarget();
      const gy = this.env.ground.heightAt(ac.position.x, ac.position.z);
      observe(ac, this.target, this.prev, gy, this.full);
      this.policy.forward(selectInputs(this.full, this.inputIdx, this.obs), this.act);
      this.prev.set(this.act);
      toControls(this.act, ac.controls);
    }
    ac.update(dt);
  }
}
