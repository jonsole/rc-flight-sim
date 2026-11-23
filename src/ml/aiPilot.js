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
const CIRCUIT = 35; // m: circuit height
const SIDE = 55; // m: downwind leg out from the centreline
const LOW_PASS = 3.5; // m: low passes along the strip (belly-landers: 20, see lowPass)
const LOW_BATTERY = 0.35; // charge left at which it comes in to land
const LOS = 180; // m from the pilots: further than this and it turns back (line of sight)
// Circuit corners, in metres along the strip from the aim point (negative:
// before it) and out to the circuit side: the end of the downwind leg, and
// the base point final starts from. (Also checked clear by fieldStrip.js.)
export const DOWNWIND_END = { s: -85, l: SIDE, h: CIRCUIT };
export const BASE_POINT = { s: -105, l: 8, above: 5 }; // (above the glide path)
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
   *                         is on the strip; `windSpeed` (m/s), too windy
   *                         for circuits over 70% of the model's cruise
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
    // Every flight starts on the ground (or in the hand) with a take-off, if
    // it has the skill; only without one does it start in the air.
    if (this.circuits && o.airborne) this.startInCircuit();
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

  /**
   * A full day needs a strip (none when nowhere at the field is clear for
   * this wind), and wind under 70% of the model's cruise speed: in more, a
   * light model hardly moves into wind on final, sinks below the glide path
   * and can't climb away (the EasyStar flew into trees at 6 m/s), so it just
   * flies round, as a pilot would leave it in the car.
   */
  get circuits() {
    return this.canCircuit && !!this.field.strip && this.field.strip.landing !== false && (this.field.windSpeed ?? 0) <= 0.7 * this.vCruise;
  }

  /** Can it take off (and so start every flight on the ground)? Without landing it then just flies round. */
  get canLaunch() {
    // (Three take-off crashes running: give up and start in the air, rather
    // than crash over and over in front of the pilots.)
    return !!(this.skills.takeoff && this.field.strip) && (this.takeoffCrashes ?? 0) < 3;
  }

  /**
   * The strip it's flying the circuit to: the field's, or, when the battery
   * forced it to land and the field's strip is for take-off only, the
   * landing strip found for that (fieldStrip.js landAt).
   */
  get #strip() {
    return (this.diverted && this.field.strip?.landAt) || this.field.strip;
  }

  /** Battery charge left, 0..1 (the flight model drains it as the motor runs). */
  get charge() {
    return Math.max(0, 1 - this.ac.battery.used / this.def.battery.capacity);
  }

  /**
   * Time to land: no more aerobatics or extra laps, in on the next circuit
   * (a pilot lands with some charge left, not when the pack is flat).
   */
  get lowBattery() {
    return this.charge < LOW_BATTERY;
  }

  /** What it's doing, for labels and debugging. */
  get status() {
    const m = this.runner ? ` (${MANEUVERS[this.runner.key].name})` : '';
    return `${this.phase}${m}`;
  }

  // --- Wandering (only the "fly" skill) -------------------------------------------

  /** Into the air at the edge of the area, heading across it. */
  spawn() {
    if (this.canLaunch) {
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
  #flyTo(wx, wz, y, speed, minAgl = null) {
    const p = this.ac.position;
    const dx = wx - p.x;
    const dz = wz - p.z;
    const d = Math.hypot(dx, dz) || 1;
    const t = this.target;
    t.x = p.x + (dx / d) * CARROT;
    t.z = p.z + (dz / d) * CARROT;
    // Never too low over the ground here or just ahead.
    const floor = Math.max(this.groundY(p.x, p.z), this.groundY(p.x + (dx / d) * 60, p.z + (dz / d) * 60)) + (minAgl ?? MIN_AGL * (this.phase === 'wander' ? 1 : 0.5));
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
  #followLine(lat, y, speed, minAgl = null) {
    const strip = this.#strip;
    const d = strip.dir;
    const v = this.ac.velocity;
    const latSoon = lat + 3 * (v.x * strip.right.x + v.z * strip.right.z);
    this.latSum = Math.max(-300, Math.min(300, (this.latSum ?? 0) + lat * CONTROL_DT));
    const cut = Math.max(-40 * deg, Math.min(40 * deg, (-2 * latSoon - 0.15 * this.latSum) * deg));
    const c = Math.cos(cut);
    const s = Math.sin(cut);
    // The strip direction turned by `cut` (towards the line).
    const hx = d.x * c - d.z * s;
    const hz = d.z * c + d.x * s;
    const p = this.ac.position;
    this.#flyTo(p.x + hx * CARROT, p.z + hz * CARROT, y, speed, minAgl);
  }

  #wander() {
    // Battery getting low and it can land: come in, on the strip it took off
    // from or, if that's for take-off only (trees on its approaches), on the
    // landing strip found for it (fieldStrip.js landAt). With neither, there
    // is nowhere safe to land, and it flies on.
    const landable = this.field.strip && (this.field.strip.landing !== false || this.field.strip.landAt);
    if (this.lowBattery && this.canCircuit && landable && this.ac.position.y - this.groundY(this.ac.position.x, this.ac.position.z) > 20) {
      this.diverted = this.field.strip.landing === false;
      this.laps = 0;
      this.#goto('downwind', { aeroPlanned: null });
      return this.#plan(0);
    }
    const w = this.waypoint;
    w.since += CONTROL_DT;
    const d = this.#flyTo(w.x, w.z, this.groundY(w.x, w.z) + w.agl, w.speed);
    if (d < REACHED || w.since > 60) this.#nextWanderPoint();
    return 'fly';
  }

  // --- A day at the field -----------------------------------------------------------

  /** Which side of the strip the circuit is flown on: away from the pilots. */
  get #side() {
    const { pilot } = this.field;
    const strip = this.#strip;
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
    this.diverted = false;
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
    // The first time, one after another by parking slot (the runway takes
    // one at a time anyway); after that a rest of 4-14 s between flights.
    this.wait = this.parkedBefore ? 4 + this.rng() * 10 : 2 + 6 * this.slot + this.rng() * 3;
    this.parkedBefore = true;
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
    // Each take-off trained from rest, with no earlier stick movements: the
    // networks see their own last outputs, and the taxi network's ones made
    // the take-off network shove the nose down and flip over.
    if (phase === 'takeoff') this.prev.fill(0);
    Object.assign(this, extra);
  }

  /** The circuit's points: { s along, l to the side (on the circuit side), h above ground }. */
  #pt(s, l, h) {
    const strip = this.#strip;
    const p = strip.point(s, l * this.#side);
    return { x: p.x, z: p.z, y: this.groundY(p.x, p.z) + h };
  }

  /** A day at the field: pick the phase's skill and target. */
  #plan(dt) {
    const ac = this.ac;
    const strip = this.#strip;
    const t = this.target;
    const L = strip.length;
    this.legT = (this.legT ?? 0) + dt;
    const sNow = strip.along(ac.position);
    const lat = strip.lateral(ac.position);
    const agl = ac.position.y - this.groundY(ac.position.x, ac.position.z);
    const speed = 1.3 * this.vCruise;
    // Line of sight: wandering off past LOS from the pilots (blown away
    // after a manoeuvre, a long go-around), head back to the downwind leg.
    const pilot = this.field.pilot;
    if (pilot && Math.hypot(ac.position.x - pilot.x, ac.position.z - pilot.z) > LOS) {
      if (['crosswind', 'goAround', 'recover', 'lowPass'].includes(this.phase)) this.#goto('downwind', { aeroPlanned: null });
      // (Not downwind: it's already heading back; cutting to base from far
      // away flew it straight across the trees.)
    }
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
        // Stuck (rough grass, a hedge, turning in circles): taxiing out, it's
        // carried out to the start instead (parking again, it tried the
        // same taxi for ever); taxiing in, back to the pits.
        if (this.legT > 60) {
          if (this.phase === 'taxiOut') {
            this.#fresh();
            const p = strip.point(strip.startS, 0);
            this.ac.resetOnGround(p.x, p.z, strip.heading);
            this.ac.step(1e-6);
            this.#goto('holding');
          } else this.#park();
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
          // A fresh aircraft standing just here, as each take-off trained
          // from: after a taxi the flight model still holds the wing's stall
          // state, the spinning-down motor and so on, and the take-off
          // network sat at idle.
          // Facing along the strip (the taxi network can get to the spot
          // turned round, and then took off backwards: idle, it sat there).
          const p = ac.position;
          this.#fresh();
          this.ac.resetOnGround(p.x, p.z, strip.heading);
          this.ac.step(1e-6);
          this.#goto('takeoff');
          return null;
        }
        if (this.legT > 40) {
          this.#park();
          return null;
        }
        taxiTarget(ac, pt, this.groundY, true, strip.dir, t);
        return 'taxi';
      }
      case 'takeoff':
      case 'climbOut': {
        if (agl > 10) this.#release();
        // The take-off skill rolls and lifts off; once well clear of the
        // ground the fly skill climbs out along the centreline (the take-off
        // network let the Agro drift 30 m sideways, out over the trees).
        // Only if it drifts off the centreline (8 m) once 15 m up: the fly
        // skill, taking over a slow, just-airborne model, gives up height for
        // speed (the Highlander struck its prop taking over at 8 m, and met
        // trees past the end taking over at 15).
        if (this.phase === 'takeoff' && agl > 15 && Math.abs(lat) > 8 && !this.hand) this.#goto('climbOut');
        // Up, or well past the end of the strip and 25 m up, clear of the
        // trees (a slow climb-out otherwise takes it far out of sight before
        // turning; turning at 15 m, the Buschtrottels met trees at Impington).
        if (agl > 30 || (agl > 25 && sNow > L / 2 + 60)) {
          this.flights++;
          this.#release();
          if (!this.circuits) {
            // No landing skill (or too windy for circuits): fly round.
            this.phase = 'wander';
            this.#nextWanderPoint();
            return this.#wander();
          }
          this.laps = 1 + Math.floor(this.rng() * 3);
          this.#goto('crosswind');
          return this.#plan(0);
        }
        if (this.phase === 'climbOut') {
          const ahead = this.#pt(sNow + 20, 0, CIRCUIT);
          // (The speed it has, at least cruise: asked for more, it dives for it.)
          this.#followLine(lat, ahead.y, Math.max(this.vCruise, Math.min(ac.airspeed, 1.3 * this.vCruise)));
          return 'fly';
        }
        takeoffTarget(ac, strip, this.groundY, this.vCruise, t);
        return 'takeoff';
      }
      case 'crosswind': {
        const c = this.#pt(L / 2 + 40, SIDE, CIRCUIT);
        this.#flyTo(c.x, c.z, c.y, speed);
        // Done once near the corner or out past it to the side (not just near
        // it: swinging round to get to a point it missed took it far away).
        if (Math.hypot(c.x - ac.position.x, c.z - ac.position.z) < REACHED || lat * this.#side > SIDE - 10 || this.legT > 40) {
          // Now and then something aerobatic on the way down the far side,
          // higher and further out.
          const aero = this.maneuvers.length && !this.lowBattery && this.rng() < 0.6;
          this.#goto('downwind', { aeroPlanned: aero ? this.#pickManeuver() : null });
        }
        return 'fly';
      }
      case 'downwind': {
        const planned = this.aeroPlanned;
        const end = this.#pt(strip.aimS + DOWNWIND_END.s, planned ? SIDE + 30 : SIDE, planned ? 80 : CIRCUIT);
        this.#flyTo(end.x, end.z, end.y, planned ? 1.6 * this.vCruise : speed);
        // Halfway along, high and fast enough, heading down the leg: go.
        const along = -(ac.velocity.x * strip.dir.x + ac.velocity.z * strip.dir.z) / Math.max(1, Math.hypot(ac.velocity.x, ac.velocity.z));
        const minH = MANEUVERS[planned]?.minHeight ?? 65;
        if (planned && sNow < L / 2 && agl > minH && ac.airspeed > 1.25 * this.vCruise && along > 0.9) {
          this.aeroPlanned = null;
          this.runner = new ManeuverRunner(planned, rateLimits(this.def, this.vCruise));
          this.#goto('aerobatics');
          return this.#plan(0);
        }
        if (Math.hypot(end.x - ac.position.x, end.z - ac.position.z) < REACHED || sNow < strip.aimS + DOWNWIND_END.s || this.legT > 50) {
          this.laps--;
          if (this.lowBattery) this.laps = 0; // (land this time)
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
        // (5 m above the glide path there, so final starts high, not low.)
        const b = this.#pt(strip.aimS + BASE_POINT.s, BASE_POINT.l, glideHeight(strip, strip.aimS + BASE_POINT.s) + BASE_POINT.above);
        this.#flyTo(b.x, b.z, b.y, speed);
        // Done near the base point, or once past it along the strip and near
        // the centreline (rather than circling back to it from a wide turn,
        // far away; but not from out wide either, over unchecked trees).
        if (Math.hypot(b.x - ac.position.x, b.z - ac.position.z) < 20 || (sNow < strip.aimS + BASE_POINT.s - 10 && Math.abs(lat) < 25) || this.legT > 40) {
          // Landing this time (if the runway's free), or round again.
          const landing = (this.laps <= 0 || this.lowBattery) && this.#claim();
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
        if (agl < glideHeight(strip, sNow) - 4 && sNow < strip.aimS - 30) {
          this.#goAround();
          return this.#plan(0);
        }
        // Its track over the ground against the strip (not its nose: in a
        // crosswind it flies crabbed, nose 15-20° into the wind, and the
        // Highlander never got lined up by its nose).
        const v = ac.velocity;
        const vh = Math.hypot(v.x, v.z) || 1;
        const align = Math.abs(Math.atan2((v.x * strip.dir.z - v.z * strip.dir.x) / vh, (v.x * strip.dir.x + v.z * strip.dir.z) / vh));
        // (The landing skill trained from 40-160 m out: it takes over from 100.)
        // (Within 15 m: the landing skill closes in on the centreline itself;
        // at 12 a steady crosswind kept it just outside, going round for ever.)
        if (Math.abs(lat) < 15 && align < 25 * deg && Math.abs(ac.attitude().roll) < 45 * deg && sNow > strip.aimS - 100) {
          this.#goto('landing', { down: false });
          return this.#plan(0);
        }
        if (sNow > strip.aimS - 45 || this.legT > 45) this.#goAround();
        return 'fly';
      }
      case 'landing': {
        if (ac.onGround) this.down = true;
        // Going wrong: off the side, low on the approach (trees!), long (not
        // down with 25 m of strip left: landing long is fine while there's
        // room, and going around from a float is slow to climb away), or
        // someone on the strip. A belly-lander just lands long: it stops in a
        // few metres, and the EasyStar climbs too slowly to go around that late.
        // (The strip is checked clear to 4 m below the glide path.)
        const low = sNow < strip.aimS - 50 && agl < glideHeight(strip, sNow) - 4;
        if (!this.down && (Math.abs(lat) > strip.width / 2 + 12 || low || (sNow > L / 2 - 25 && agl > 3 && !this.hand) || (agl > 4 && this.field.blocked?.()))) {
          this.#goAround();
          return this.#plan(0);
        }
        landingTarget(ac, strip, this.groundY, 1.15 * this.vCruise, this.down, t);
        const gs = Math.hypot(ac.velocity.x, ac.velocity.z);
        if (this.down && gs < 0.5) {
          this.landings++;
          // Carried back if it can't taxi, or if the pits are a long way off
          // across the field (the AeroScout tipped over taxiing 70 m home
          // through long grass in a crosswind).
          const spot0 = this.#parkingSpot();
          if (this.carried || Math.hypot(spot0.x - ac.position.x, spot0.z - ac.position.z) > 40) {
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
        // A low pass: down the glide path (the strip was checked clear under
        // it) to 3 m along the strip, then climb away straight ahead.
        // (Hand-launched belly-landers at 20 m: the EasyStar climbs too slowly
        // to get away from 3 m over the trees past the end.)
        const want = Math.max(this.hand ? 20 : LOW_PASS, glideHeight(strip, sNow));
        const here = this.#pt(sNow, 0, want);
        this.#followLine(lat, here.y, 1.3 * this.vCruise, 1);
        // Sagging below the glide path on the way down, or too near the
        // ground over the strip, or with 25 m of strip left (where the
        // go-around climb is checked clear from): climb away.
        if ((agl < want - 4 && sNow < strip.aimS - 30) || agl < 2 || sNow > L / 2 - 25 || this.legT > 50) {
          this.#goAround();
          return this.#plan(0);
        }
        return 'fly';
      }
      case 'goAround': {
        this.#release();
        // Straight ahead along the centreline, climbing (a point to reach
        // past the end swung round behind it if it got there low, and it
        // turned back steeply into the trees).
        const ahead = this.#pt(sNow + 20, 0, CIRCUIT);
        this.#followLine(lat, ahead.y, speed);
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
    const d = this.#strip.dir;
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
    // Upside down on the ground, or still not off it long after starting
    // the take-off: as good as crashed (it would otherwise sit there).
    const upside = ac.onGround && 1 - 2 * (ac.orientation.x ** 2 + ac.orientation.z ** 2) < 0;
    if (!ac.crashed && (upside || (this.phase === 'takeoff' && this.legT > 30 && ac.onGround))) ac.crash(upside ? 'Turned over' : 'Never got off the ground');
    if (ac.crashed || (this.phase === 'wander' && stopped)) {
      ac.controls.throttle = 0;
      ac.update(dt);
      this.downFor += dt;
      if (this.downFor > RESPAWN) {
        if (ac.crashed) this.crashes++;
        this.takeoffCrashes = this.phase === 'takeoff' || this.phase === 'climbOut' ? (this.takeoffCrashes ?? 0) + 1 : 0;
        this.#release();
        this.spawn();
      }
      return;
    }
    this.nextControl -= dt;
    if (this.nextControl <= 0) {
      this.nextControl += CONTROL_DT;
      if (this.nextControl < 0) this.nextControl = 0;
      const skillName = this.phase === 'wander' ? this.#wander() : this.#plan(CONTROL_DT);
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
