// An AI flyer: an aeroplane of its own, flown by trained neural networks
// (src/ml/policy.js, trained by ml/train.js), one per skill:
//
//   fly       fly at a point at a height and speed (circuits, recovering)
//   takeoff   roll along the strip and climb out (or a hand launch)
//   land      approach, flare, touch down and roll out
//   taxi      drive about on the ground
//   aero      fly commanded body rates (aerobatic manoeuvres)
//
// The flight is planned here, not learnt: a state machine picks the skill
// and works out its target each control step (src/ml/guidance.js, the same
// rules the skills were trained with). With every skill it flies a club
// day: parked in the pits, taxi out, wait for the runway, take off, fly
// circuits on the far side of the strip from the pilots (crosswind,
// downwind, base, final), now and then an aerobatic manoeuvre on the
// downwind leg, land (or a low pass and round again), taxi back, park, and
// do it all again. Hand-launched models are thrown from the start of the
// strip and belly-landed. With only the "fly" skill it wanders between
// random points over the field, as the first AI flyers did.
//
// Plain JavaScript with no browser parts, so it runs in the tests too.
import { Vector3 } from 'three';
import { Aircraft } from '../sim/aircraft.js';
import { Policy, toControls } from './policy.js';
import { observe, OBS_NAMES, OBS_SIZE, resolveInputs, selectInputs } from './observe.js';
import { rateLimits, RateController } from './rates.js';
import {
  takeoffTarget, landingTarget, taxiTarget, glideHeight, ManeuverRunner, maneuversFor, MANEUVERS,
} from './guidance.js';

const CONTROL_DT = 1 / 50; // the policies are trained at 50 Hz
const CARROT = 150; // m: how far ahead the "fly" target point is (as in training)
const REACHED = 30; // m (horizontally) from a waypoint to go on to the next
const RESPAWN = 4; // s after a crash (or a belly landing) before it's back
const MIN_AGL = 30; // m: when wandering, below this the target is raised
const CIRCUIT = 40; // m: circuit height
const SIDE = 65; // m: downwind leg out from the centreline
const deg = Math.PI / 180;

const cruiseCache = new WeakMap();
const flatGround = { heightAt: () => 0, normalAt: (x, z, o) => o.set(0, 1, 0), surfaceAt: () => ({ roll: 0.05, stiction: 1, drag: 1 }) };

/** The airspeed it settles at gliding hands-off, motor off (m/s). */
function glideTrim(def, start) {
  const ac = new Aircraft(def, { ground: flatGround });
  ac.assistMode = 'off';
  ac.resetInAir(new Vector3(0, 400, 0), 0, start);
  ac.throttleActual = 0;
  ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  let s = 0;
  let n = 0;
  for (let i = 0; i < 300 * 20; i++) {
    ac.step(1 / 300);
    if (i > 300 * 10) {
      s += ac.airspeed;
      n++;
    }
  }
  return s / n;
}

/**
 * A comfortable cruising airspeed (m/s): the speed at which the wing carries
 * the model's weight at a lift coefficient of 0.7 (within 0.4 m/s of the
 * hands-off glide speed for every model but one), or the glide speed if that
 * is much faster: the Mini F-22's flat wing never reaches 0.7, and 6.7 m/s
 * (against a real 13) had its landings stall in.
 */
export function cruiseSpeed(def) {
  if (cruiseCache.has(def)) return cruiseCache.get(def);
  const S = def.surfaces.filter((s) => s.wing).reduce((a, s) => a + s.area, 0);
  const est = Math.sqrt((2 * def.mass * 9.81) / (1.225 * S * 0.7));
  const trim = glideTrim(def, est * 1.3);
  const v = trim > 1.3 * est ? trim : est;
  cruiseCache.set(def, v);
  return v;
}

/** One trained network and the inputs it takes. */
class Skill {
  constructor(json) {
    this.policy = Policy.fromJSON(json);
    this.inputIdx = resolveInputs(json.meta?.inputs ?? 'v1').map((n) => OBS_NAMES.indexOf(n));
    if (this.inputIdx.length !== this.policy.obsSize) throw new Error('policy inputs do not match its network');
    this.obs = new Float64Array(this.inputIdx.length);
  }

  act(full, out) {
    return this.policy.forward(selectInputs(full, this.inputIdx, this.obs), out);
  }
}

export class AiPilot {
  /**
   * @param {object} def     aircraft definition (registry entry.def)
   * @param {object} skills  saved policies: { fly, takeoff?, land?, taxi?, aero? } (fly may also be passed alone)
   * @param {object} env     { ground, wind, obstacles } as for Aircraft
   * @param {object} field   { x, z, radius }: the area to fly over; with
   *                         `strip` (a guidance.js Strip), `pilot` { x, z }
   *                         and `runway` ({ owner } shared by all AI flyers),
   *                         a full circuit day when the skills are there;
   *                         `blocked()` (optional) says someone else (you)
   *                         is on the strip
   * @param {() => number} [rng] 0..1
   * @param {object} [o]     { id, slot (its parking spot), airborne (start
   *                         in the circuit rather than in the pits) }
   */
  constructor(def, skills, env, field, rng = Math.random, o = {}) {
    if (skills.format) skills = { fly: skills }; // just the one policy
    this.def = def;
    this.env = env;
    this.field = field;
    this.rng = rng;
    this.id = o.id ?? 'ai';
    this.slot = o.slot ?? 0;
    this.skills = Object.fromEntries(Object.entries(skills).filter(([, j]) => j).map(([k, j]) => [k, new Skill(j)]));
    if (!this.skills.fly) throw new Error('an AI flyer needs at least the "fly" skill');
    this.vCruise = cruiseSpeed(def);
    this.hand = !!def.handLaunch;
    // Aerobatics: a trained "aero" skill if there is one, else the classic
    // rate controller (src/ml/rates.js), which tracks rates far better than
    // the networks trained so far.
    this.maneuvers = maneuversFor(def);
    if (!this.skills.aero) this.rateCtl = new RateController(def, rateLimits(def, this.vCruise));
    // A full day needs a strip, take-off and landing. Without taxiing (or
    // hand-launched), it's carried out to the start and back to the pits.
    this.canCircuit = !!(this.skills.takeoff && this.skills.land);
    this.carried = this.hand || !this.skills.taxi;
    this.full = new Float64Array(OBS_SIZE);
    this.act = new Float64Array(4);
    this.prev = new Float64Array(4);
    this.target = { x: 0, y: 0, z: 0, speed: 0, line: null, rates: null };
    this.crashes = 0;
    this.flights = 0; // take-offs
    this.landings = 0;
    this.done = []; // manoeuvres flown, latest last
    this.ac = null;
    if (this.circuits && o.airborne) this.startInCircuit();
    else if (this.circuits) this.#park();
    else this.spawn();
  }

  /** Straight into the circuit: in the air on the crosswind leg. */
  startInCircuit() {
    const strip = this.field.strip;
    this.#fresh();
    this.runner = null;
    const p = this.#pt(strip.length / 2 + 20, 20, CIRCUIT);
    // Heading out to the circuit side (Aircraft's heading sense).
    const out = { x: strip.dir.x + this.#side * strip.right.x, z: strip.dir.z + this.#side * strip.right.z };
    this.ac.resetInAir(new Vector3(p.x, p.y, p.z), Math.atan2(-out.z, out.x), this.vCruise * 1.3);
    this.ac.controls.throttle = 0.5;
    this.ac.step(1e-6);
    this.laps = 1 + Math.floor(this.rng() * 2);
    this.#goto('crosswind');
  }

  groundY = (x, z) => this.env.ground.heightAt(x, z);

  #fresh() {
    // A new flight model each time: nothing left over from the last flight.
    this.ac = new Aircraft(this.def, this.env);
    this.ac.assistMode = 'off';
    this.prev.fill(0);
    this.nextControl = 0;
    this.downFor = 0;
  }

  /** A full day needs a strip (none when nowhere at the field is clear for this wind). */
  get circuits() {
    return this.canCircuit && !!this.field.strip;
  }

  /** What it's doing, for labels and debugging. */
  get status() {
    const m = this.runner ? ` (${MANEUVERS[this.runner.key].name})` : '';
    return `${this.phase}${m}`;
  }

  // --- Wandering (only the "fly" skill) -------------------------------------------

  /** Into the air at the edge of the area, heading across it. */
  spawn() {
    if (this.circuits) {
      this.#park();
      return;
    }
    const { x, z, radius } = this.field;
    const a = this.rng() * 2 * Math.PI;
    const px = x + Math.cos(a) * radius * 0.8;
    const pz = z + Math.sin(a) * radius * 0.8;
    const toward = Math.atan2(-(z - pz), x - px) + (this.rng() - 0.5) * 0.8; // (Aircraft's heading sense)
    this.#fresh();
    this.ac.resetInAir(new Vector3(px, this.groundY(px, pz) + 45 + this.rng() * 15, pz), toward, this.vCruise * 1.3);
    this.ac.controls.throttle = 0.5;
    this.ac.step(1e-6); // sets its airspeed and the rest, for the first look
    this.phase = 'wander';
    this.waypoint = null;
    this.#nextWanderPoint();
  }

  #nextWanderPoint() {
    const { x, z, radius } = this.field;
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

  /** "fly" target: a point 150 m along the way to (wx, wz), at height y (world). */
  #flyTo(wx, wz, y, speed) {
    const p = this.ac.position;
    const dx = wx - p.x;
    const dz = wz - p.z;
    const d = Math.hypot(dx, dz) || 1;
    const t = this.target;
    t.x = p.x + (dx / d) * CARROT;
    t.z = p.z + (dz / d) * CARROT;
    // Never too low over the ground here or just ahead.
    const floor = Math.max(this.groundY(p.x, p.z), this.groundY(p.x + (dx / d) * 60, p.z + (dz / d) * 60)) + MIN_AGL * (this.phase === 'wander' ? 1 : 0.5);
    // Climbs and descents as a ramp: never more than 12 m above or 25 m
    // below where it is. (A target 60-90 m up at once made it pull up hard
    // at low speed, stall and spin in: it trained with smaller steps.)
    t.y = Math.min(p.y + 12, Math.max(p.y - 25, Math.max(y, floor)));
    t.speed = speed;
    t.line = null;
    t.rates = null;
    return d;
  }

  /**
   * "fly" target to follow the strip's centreline (final, low pass): head in
   * at an angle that shrinks as it closes (2° per metre off, at most 40°),
   * judged on where it will be in 3 s (it turns slowly) so it turns onto the
   * line without swinging through it, plus a slowly growing correction for
   * an offset that persists (the fly skill tends to hold a few degrees off).
   */
  #followLine(lat, y, speed) {
    const strip = this.field.strip;
    const d = strip.dir;
    const v = this.ac.velocity;
    const latSoon = lat + 3 * (v.x * strip.right.x + v.z * strip.right.z);
    this.latSum = Math.max(-300, Math.min(300, (this.latSum ?? 0) + lat * CONTROL_DT));
    const cut = Math.max(-40 * deg, Math.min(40 * deg, (-2 * latSoon - 0.05 * this.latSum) * deg));
    const c = Math.cos(cut);
    const s = Math.sin(cut);
    // The strip direction turned by `cut` (towards the line).
    const hx = d.x * c - d.z * s;
    const hz = d.z * c + d.x * s;
    const p = this.ac.position;
    this.#flyTo(p.x + hx * CARROT, p.z + hz * CARROT, y, speed);
  }

  #wander() {
    const w = this.waypoint;
    w.since += CONTROL_DT;
    const d = this.#flyTo(w.x, w.z, this.groundY(w.x, w.z) + w.agl, w.speed);
    if (d < REACHED || w.since > 60) this.#nextWanderPoint();
    return 'fly';
  }

  // --- A day at the field -----------------------------------------------------------

  /** Which side of the strip the circuit is flown on: away from the pilots. */
  get #side() {
    const { strip, pilot } = this.field;
    return pilot && strip.lateral(pilot) > 0 ? -1 : 1;
  }

  /** Its spot in the pits: beside the start of the strip, on the far side from the pilots. */
  #parkingSpot() {
    const s = this.field.strip;
    const p = s.point(s.startS + 4 + 7 * this.slot, this.#side * (s.width / 2 + 10));
    return p;
  }

  #park() {
    this.#fresh();
    const s = this.field.strip;
    this.runner = null;
    this.#release();
    if (this.hand) {
      // In the pilot's hand at the start of the strip, pointing along it.
      const p = s.point(s.startS, this.#side * 3);
      this.ac.resetHandLaunch(p.x, p.z, s.heading);
    } else {
      const p = this.#parkingSpot();
      // Facing the strip.
      const h = Math.atan2(this.#side * s.right.z, -this.#side * s.right.x);
      this.ac.resetOnGround(p.x, p.z, h);
    }
    this.ac.step(1e-6);
    this.phase = 'parked';
    this.wait = 4 + this.rng() * 10;
  }

  /** The runway, shared with the other AI flyers: one on it (or landing) at a time. */
  #claim() {
    if (this.field.blocked?.()) {
      this.#release();
      return false;
    }
    const r = this.field.runway;
    if (!r) return true;
    if (!r.owner || r.owner === this.id) {
      r.owner = this.id;
      return true;
    }
    return false;
  }

  #release() {
    const r = this.field.runway;
    if (r && r.owner === this.id) r.owner = null;
  }

  #goto(phase, extra = {}) {
    this.phase = phase;
    this.legT = 0;
    this.latSum = 0;
    Object.assign(this, extra);
  }

  /** The circuit's points: { s along, l to the side (on the circuit side), h above ground }. */
  #pt(s, l, h) {
    const strip = this.field.strip;
    const p = strip.point(s, l * this.#side);
    return { x: p.x, z: p.z, y: this.groundY(p.x, p.z) + h };
  }

  /** A day at the field: pick the phase's skill and target. */
  #plan(dt) {
    const ac = this.ac;
    const strip = this.field.strip;
    const t = this.target;
    const L = strip.length;
    this.legT = (this.legT ?? 0) + dt;
    const sNow = strip.along(ac.position);
    const lat = strip.lateral(ac.position);
    const agl = ac.position.y - this.groundY(ac.position.x, ac.position.z);
    const speed = 1.3 * this.vCruise;
    switch (this.phase) {
      case 'parked': {
        // Waiting in the pits (or in the hand), motor off.
        this.#hold();
        if ((this.wait -= dt) > 0) return null;
        if (this.hand) {
          if (!this.#claim()) return null;
          this.#goto('takeoff');
          return this.#plan(0);
        }
        if (this.carried) {
          // Carried out to the start of the strip once it's free.
          if (!this.#claim()) return null;
          this.#fresh();
          const p = strip.point(strip.startS, 0);
          this.ac.resetOnGround(p.x, p.z, strip.heading);
          this.ac.step(1e-6);
          this.#goto('takeoff');
          return null;
        }
        this.#goto('taxiOut', { taxiPts: [this.#pt(strip.startS - 15, 0, 0)], taxiStop: true });
        return this.#plan(0);
      }
      case 'taxiOut':
      case 'taxiIn': {
        const pts = this.taxiPts;
        const pt = pts[0];
        const last = pts.length === 1;
        const d = Math.hypot(pt.x - ac.position.x, pt.z - ac.position.z);
        const gs = Math.hypot(ac.velocity.x, ac.velocity.z);
        if (d < 3 && (!last || !this.taxiStop || gs < 0.5)) {
          pts.shift();
          if (!pts.length) {
            if (this.phase === 'taxiOut') this.#goto('holding');
            else this.#park();
            return this.#plan(0);
          }
          return this.#plan(0);
        }
        // Stuck (in a hedge, or turned round in circles): give up and start over.
        if (this.legT > 60) {
          this.#park();
          return null;
        }
        taxiTarget(ac, pt, this.groundY, last && this.taxiStop, this.taxiLine ?? null, t);
        return 'taxi';
      }
      case 'holding': {
        // Short of the strip on its centreline: wait for it to be clear.
        this.#hold();
        if (!this.#claim()) return null;
        this.#goto('lineUp', { taxiPts: [this.#pt(strip.startS, 0, 0)], taxiStop: true, taxiLine: strip.dir });
        return this.#plan(0);
      }
      case 'lineUp': {
        const pt = this.taxiPts[0];
        const d = Math.hypot(pt.x - ac.position.x, pt.z - ac.position.z);
        const gs = Math.hypot(ac.velocity.x, ac.velocity.z);
        if ((d < 3 && gs < 0.5) || sNow > strip.startS + 2) {
          this.taxiLine = null;
          this.#goto('takeoff');
          return this.#plan(0);
        }
        if (this.legT > 40) {
          this.#park();
          return null;
        }
        taxiTarget(ac, pt, this.groundY, true, strip.dir, t);
        return 'taxi';
      }
      case 'takeoff': {
        takeoffTarget(ac, strip, this.groundY, this.vCruise, t);
        if (agl > 10) this.#release();
        if (agl > 30) {
          this.flights++;
          this.laps = 1 + Math.floor(this.rng() * 3);
          this.#goto('crosswind');
        }
        return 'takeoff';
      }
      case 'crosswind': {
        const c = this.#pt(L / 2 + 60, SIDE, CIRCUIT);
        this.#flyTo(c.x, c.z, c.y, speed);
        if (Math.hypot(c.x - ac.position.x, c.z - ac.position.z) < REACHED || this.legT > 40) {
          // Now and then something aerobatic on the way down the far side,
          // higher and further out.
          const aero = this.maneuvers.length && this.rng() < 0.6;
          this.#goto('downwind', { aeroPlanned: aero ? this.#pickManeuver() : null });
        }
        return 'fly';
      }
      case 'downwind': {
        const planned = this.aeroPlanned;
        const end = this.#pt(strip.aimS - 110, planned ? SIDE + 35 : SIDE, planned ? 90 : CIRCUIT - 5);
        this.#flyTo(end.x, end.z, end.y, planned ? 1.6 * this.vCruise : speed);
        // Halfway along, high and fast enough, heading down the leg: go.
        const along = -(ac.velocity.x * strip.dir.x + ac.velocity.z * strip.dir.z) / Math.max(1, Math.hypot(ac.velocity.x, ac.velocity.z));
        const minH = MANEUVERS[planned]?.minHeight ?? 70;
        if (planned && sNow < L / 2 && agl > minH && ac.airspeed > 1.25 * this.vCruise && along > 0.9) {
          this.aeroPlanned = null;
          this.runner = new ManeuverRunner(planned, rateLimits(this.def, this.vCruise));
          this.#goto('aerobatics');
          return this.#plan(0);
        }
        if (Math.hypot(end.x - ac.position.x, end.z - ac.position.z) < REACHED || this.legT > 50) {
          this.laps--;
          this.#goto('base');
        }
        return 'fly';
      }
      case 'aerobatics': {
        const r = this.runner;
        // Done, or taking too long, or getting low: recover.
        if (!r.update(ac, dt) || this.legT > 20 || agl < 45) {
          this.done.push(r.key);
          this.runner = null;
          this.#goto('recover', { steady: 0 });
          return this.#plan(0);
        }
        // Rates are what matter; the point ahead and speed are for the other inputs.
        const v = ac.velocity;
        const h = Math.hypot(v.x, v.z) || 1;
        t.x = ac.position.x + (v.x / h) * CARROT;
        t.z = ac.position.z + (v.z / h) * CARROT;
        t.y = ac.position.y;
        t.speed = 1.5 * this.vCruise;
        t.line = null;
        t.rates = r.rates;
        return 'aero';
      }
      case 'recover': {
        // After a manoeuvre: wings level and climbing, straight ahead, then
        // back into the circuit once it's been steady for a couple of seconds.
        const v = ac.velocity;
        const h = Math.hypot(v.x, v.z) || 1;
        this.#flyTo(ac.position.x + (v.x / h) * CARROT, ac.position.z + (v.z / h) * CARROT, this.groundY(ac.position.x, ac.position.z) + Math.max(agl + 15, 60), 1.4 * this.vCruise);
        const at = ac.attitude();
        const steady = Math.abs(at.roll) < 0.35 && v.y > -1 && agl > 40;
        this.steady = steady ? this.steady + dt : 0;
        if (this.steady > 2 || this.legT > 25) this.#goto('downwind', { aeroPlanned: null });
        return 'fly';
      }
      case 'base': {
        // To a point nearly on the centreline well out, so final starts lined up.
        const b = this.#pt(strip.aimS - 190, 8, 24);
        this.#flyTo(b.x, b.z, b.y, speed);
        if (Math.hypot(b.x - ac.position.x, b.z - ac.position.z) < 20 || this.legT > 40) {
          // Landing this time (if the runway's free), or round again.
          const landing = this.laps <= 0 && this.#claim();
          this.#goto(landing ? 'final' : 'lowPass');
        }
        return 'fly';
      }
      case 'final': {
        // Turning onto the centreline (fly skill, the point 150 m ahead on
        // it), then the landing skill once lined up, as it trained.
        const here = strip.point(sNow, 0);
        // A little above the glide path (the landing skill takes it from there).
        this.#followLine(lat, this.groundY(here.x, here.z) + Math.max(glideHeight(strip, sNow) + 2, 10), 1.15 * this.vCruise);
        // Sagging below the glide path (trees under it at a real field): go around.
        if (agl < glideHeight(strip, sNow) - 3 && sNow < strip.aimS - 30) {
          this.#goAround();
          return this.#plan(0);
        }
        const align = Math.abs(this.#alignError());
        // (The landing skill trained from 90-160 m out: it takes over at about 110.)
        if (Math.abs(lat) < 12 && align < 20 * deg && sNow > strip.aimS - 115) {
          this.#goto('landing', { down: false });
          return this.#plan(0);
        }
        if (sNow > strip.aimS - 70 || this.legT > 45) this.#goAround();
        return 'fly';
      }
      case 'landing': {
        if (ac.onGround) this.down = true;
        // Going wrong: off the side, low on the approach (trees!), long, or
        // still up over the far end, or someone on the strip.
        // (The strip is checked clear to 4 m below the glide path.)
        const low = sNow < strip.aimS - 50 && agl < glideHeight(strip, sNow) - 4;
        if (!this.down && (Math.abs(lat) > strip.width / 2 + 12 || low || sNow > L / 2 - 10 || (agl > 4 && this.field.blocked?.()))) {
          this.#goAround();
          return this.#plan(0);
        }
        landingTarget(ac, strip, this.groundY, 1.15 * this.vCruise, this.down, t);
        const gs = Math.hypot(ac.velocity.x, ac.velocity.z);
        if (this.down && gs < 0.5) {
          this.landings++;
          if (this.carried) {
            // Walk out and pick it up.
            this.#release();
            this.#goto('pickUp', { wait: RESPAWN });
            return null;
          }
          // Off the strip to the pits.
          const spot = this.#parkingSpot();
          const off = this.#pt(sNow, strip.width / 2 + 6, 0);
          this.#goto('taxiIn', { taxiPts: [off, { x: spot.x, z: spot.z }], taxiStop: true, taxiLine: null });
          return this.#plan(0);
        }
        return 'land';
      }
      case 'pickUp': {
        this.#hold();
        if ((this.wait -= dt) <= 0) this.#park();
        return null;
      }
      case 'lowPass': {
        // Along the strip at 20 m (a point 150 m ahead on the centreline,
        // so it turns onto it), then round again.
        // Down the glide path (the strip was checked clear under it), then 20 m along it.
        const want = Math.max(20, glideHeight(strip, sNow));
        const here = this.#pt(sNow, 0, want);
        this.#followLine(lat, here.y, speed);
        if (agl < want - 4 && sNow < strip.aimS) {
          this.#goAround();
          return this.#plan(0);
        }
        if (sNow > L / 2 + 10 || this.legT > 50) this.#goto('crosswind');
        return 'fly';
      }
      case 'goAround': {
        this.#release();
        const b = this.#pt(L / 2 + 40, 0, CIRCUIT);
        this.#flyTo(b.x, b.z, b.y, speed);
        if (agl > 25 && (sNow > L / 2 || this.legT > 30)) this.#goto('crosswind');
        return 'fly';
      }
      default:
        return this.#wander();
    }
  }

  #goAround() {
    this.#release();
    this.laps = Math.max(this.laps ?? 0, 0);
    this.#goto('goAround');
  }

  #pickManeuver() {
    // Not the same one twice running.
    const last = this.done[this.done.length - 1];
    const choice = this.maneuvers.filter((k) => k !== last);
    const pool = choice.length ? choice : this.maneuvers;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  #alignError() {
    const f = new Vector3(1, 0, 0).applyQuaternion(this.ac.orientation);
    const d = this.field.strip.dir;
    return Math.atan2(f.x * d.z - f.z * d.x, f.x * d.x + f.z * d.z);
  }

  /** Sticks central, motor off (parked, waiting). */
  #hold() {
    Object.assign(this.ac.controls, { roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    this.prev.fill(0);
    this.prev[3] = -1;
  }

  /** Advance by `dt` seconds: the planner and policies move the sticks 50 times a second. */
  update(dt) {
    const ac = this.ac;
    // Crashed (or, wandering, landed somewhere): back a few seconds later.
    const stopped = ac.onGround && ac.airspeed < 2 && !ac.held;
    if (ac.crashed || (this.phase === 'wander' && stopped)) {
      ac.controls.throttle = 0;
      ac.update(dt);
      this.downFor += dt;
      if (this.downFor > RESPAWN) {
        if (ac.crashed) this.crashes++;
        this.#release();
        this.spawn();
      }
      return;
    }
    this.nextControl -= dt;
    if (this.nextControl <= 0) {
      this.nextControl += CONTROL_DT;
      if (this.nextControl < 0) this.nextControl = 0;
      const skillName = this.circuits ? this.#plan(CONTROL_DT) : this.#wander();
      const skill = skillName && (this.skills[skillName] ?? (skillName === 'aero' ? null : this.skills.fly));
      if (skillName === 'aero' && !skill) {
        this.rateCtl.act(this.ac, this.target.rates, this.act);
        this.prev.set(this.act);
        toControls(this.act, this.ac.controls);
      } else if (skill) {
        observe(this.ac, this.target, this.prev, this.groundY(this.ac.position.x, this.ac.position.z), this.full);
        skill.act(this.full, this.act);
        this.prev.set(this.act);
        toControls(this.act, this.ac.controls);
      }
    }
    this.ac.update(dt);
  }
}
