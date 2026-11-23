// Where the neural-network pilots are told to go, for each phase of a flight:
// take-off, landing and taxiing along a strip, and aerobatic manoeuvres as
// sequences of body rates. Shared by the training harness (ml/tasks.js) and
// the AI flyers in the game (src/ml/aiPilot.js), so a skill is always given
// the same kind of target it was trained on.
//
// Every target is { x, y, z, speed, line?, rates? } (see src/ml/observe.js).

/**
 * A straight strip of ground to take off from and land on: the runway, or a
 * stretch of mown field. `dir` is the way aeroplanes roll along it (into
 * wind), a horizontal unit vector { x, z }.
 */
export class Strip {
  constructor({ x, z, dir, length, width }) {
    this.x = x;
    this.z = z;
    const n = Math.hypot(dir.x, dir.z);
    this.dir = { x: dir.x / n, z: dir.z / n };
    this.right = { x: -this.dir.z, z: this.dir.x }; // to the right of the way along it
    this.length = length;
    this.width = width;
  }

  /** Distance along the strip from its middle (-length/2 at the start, + at the end). */
  along(p) {
    return (p.x - this.x) * this.dir.x + (p.z - this.z) * this.dir.z;
  }

  /** Distance to the right of the centreline. */
  lateral(p) {
    return (p.x - this.x) * this.right.x + (p.z - this.z) * this.right.z;
  }

  /** World { x, z } at `s` along and `l` to the right. */
  point(s, l = 0, out = {}) {
    out.x = this.x + this.dir.x * s + this.right.x * l;
    out.z = this.z + this.dir.z * s + this.right.z * l;
    return out;
  }

  /** Where a take-off roll starts (a few metres in from the start). */
  get startS() {
    return -this.length / 2 + Math.min(6, this.length * 0.1);
  }

  /** Where landings aim to touch down (a quarter of the way along, at least 10 m in). */
  get aimS() {
    return -this.length / 2 + Math.max(10, this.length * 0.25);
  }

  /** The aeroplane's heading (Aircraft.resetOnGround sense) to roll along it. */
  get heading() {
    return Math.atan2(-this.dir.z, this.dir.x);
  }
}

/**
 * Up to this wind speed (m/s) take-offs and landings use the runway (from
 * whichever end faces the wind most); above it they are made straight into
 * the wind, across the field if need be.
 */
export const LIGHT_WIND = 3;

const LIFT_AFTER = 20; // m of roll before the target point starts to rise
const CLIMB = 0.25; // climb-out gradient of the target (1 in 4)
const CLIMB_TO = 40; // m: where a take-off ends

/** Take-off climb-out: target height above the strip at `s` along it. */
export function climbProfile(strip, s) {
  return Math.min(CLIMB_TO, Math.max(0, (s - strip.startS - LIFT_AFTER) * CLIMB));
}

/**
 * Take-off (or hand launch): a point 60 m ahead on the centreline, rising
 * along the climb-out profile, at 1.3 × cruise.
 */
export function takeoffTarget(ac, strip, groundY, vCruise, out) {
  const s = strip.along(ac.position) + 60;
  strip.point(s, 0, out);
  out.y = groundY(out.x, out.z) + climbProfile(strip, s);
  out.speed = 1.3 * vCruise;
  out.line = strip.dir;
  out.rates = null;
  return out;
}

export const GLIDE = (7 * Math.PI) / 180; // approach angle

/** Height above the strip of the glide path at `s` along it (0 past the aim point). */
export function glideHeight(strip, s) {
  return Math.max(0, (strip.aimS - s) * Math.tan(GLIDE));
}

/**
 * Landing: a point 40 m ahead of the aeroplane along the centreline, on the
 * glide path (which meets the ground at the aim point, so the point is on
 * the ground for the last 40 m: the flare is the pilot's job). Approach
 * speed until it is down, then stop.
 */
export function landingTarget(ac, strip, groundY, vApproach, touchedDown, out) {
  const s = strip.along(ac.position) + 40;
  strip.point(s, 0, out);
  out.y = groundY(out.x, out.z) + glideHeight(strip, s);
  out.speed = touchedDown ? 0 : vApproach;
  out.line = strip.dir;
  out.rates = null;
  return out;
}

export const TAXI_SPEED = 2.5; // m/s, a brisk walk

/**
 * Taxiing: to `point` { x, z } on the ground at taxi speed, slowing to a
 * stop as it gets there if `stop`. `line` (optional) is the way to face.
 */
export function taxiTarget(ac, point, groundY, stop, line, out) {
  out.x = point.x;
  out.z = point.z;
  out.y = groundY(point.x, point.z);
  const d = Math.hypot(point.x - ac.position.x, point.z - ac.position.z);
  out.speed = stop ? Math.min(TAXI_SPEED, Math.max(0, (d - 1) * 0.5)) : TAXI_SPEED;
  const dx = point.x - ac.position.x;
  const dz = point.z - ac.position.z;
  out.line = line ?? (d > 0.5 ? { x: dx / d, z: dz / d } : null);
  out.rates = null;
  return out;
}

// --- Aerobatics ---------------------------------------------------------------
// A manoeuvre is a list of steps, each a body-rate command held until the
// aeroplane has turned so far about that axis (measured, not commanded) or
// for a time. Rates are fractions of what the model can do at full stick
// (src/ml/rates.js): roll right, pitch up, yaw left positive, as
// Aircraft.omega. `pitch: 'loop'` means the pitch rate for a loop of
// `radius` at the speed flown (no more than 3/4 of the model's best). A step
// with no pitch command holds the flight path level, as a pilot feeds in
// elevator through a roll (pushing when inverted), so rolls and inverted
// flight don't lose much height.
// needsRoll: only for models that can roll on ailerons or elevons.

const T = 2 * Math.PI;
export const MANEUVERS = {
  loop: { name: 'Loop', steps: [{ pitch: 'loop', until: { pitch: T } }] },
  roll: { name: 'Aileron roll', needsRoll: true, steps: [{ roll: 0.6, until: { roll: T } }] },
  rollLeft: { name: 'Aileron roll (left)', needsRoll: true, steps: [{ roll: -0.6, until: { roll: T } }] },
  twoRolls: { name: 'Two rolls', needsRoll: true, steps: [{ roll: 0.75, until: { roll: 2 * T } }] },
  immelmann: { name: 'Immelmann', needsRoll: true, steps: [{ pitch: 'loop', until: { pitch: T / 2 } }, { roll: 0.6, until: { roll: T / 2 } }] },
  splitS: { name: 'Split S', needsRoll: true, minHeight: 60, steps: [{ roll: 0.6, until: { roll: T / 2 } }, { pitch: 'loop', until: { pitch: T / 2 } }] },
  cuban8: {
    name: 'Cuban eight',
    needsRoll: true,
    steps: [
      { pitch: 'loop', until: { pitch: (5 * T) / 8 } },
      { roll: 0.6, until: { roll: T / 2 } },
      { pitch: 'loop', until: { pitch: (3 * T) / 4 } },
      { roll: 0.6, until: { roll: T / 2 } },
      { pitch: 'loop', until: { pitch: T / 8 } },
    ],
  },
  barrelRoll: { name: 'Barrel roll', needsRoll: true, steps: [{ roll: 0.3, pitch: 0.3, until: { roll: T } }] },
  invertedPass: {
    name: 'Inverted pass',
    needsRoll: true,
    steps: [{ roll: 0.6, until: { roll: T / 2 } }, { until: { time: 2.5 } }, { roll: 0.6, until: { roll: T / 2 } }],
  },
};

/** The manoeuvres a model can fly (no rolls without ailerons or elevons). */
export function maneuversFor(def) {
  const canRoll = def.surfaces.some((s) => s.controls.some((c) => c.input === 'roll') && !s.controls.some((c) => c.input === 'yaw'));
  return Object.keys(MANEUVERS).filter((k) => canRoll || !MANEUVERS[k].needsRoll);
}

/**
 * Flies one manoeuvre: call update(ac, dt) each control step; it fills
 * `target.rates` and returns false once the manoeuvre is finished.
 */
export class ManeuverRunner {
  /** `limits`: the model's rates at full stick (src/ml/rates.js). */
  constructor(key, limits, { radius = 14 } = {}) {
    this.m = MANEUVERS[key];
    this.key = key;
    this.limits = limits;
    this.radius = radius;
    this.i = 0;
    this.turned = { roll: 0, pitch: 0, yaw: 0, time: 0 };
    this.rates = { roll: 0, pitch: 0, yaw: 0 };
  }

  get done() {
    return this.i >= this.m.steps.length;
  }

  update(ac, dt) {
    if (this.done) return false;
    const step = this.m.steps[this.i];
    const w = ac.omega;
    const t = this.turned;
    t.roll += Math.abs(w.x) * dt;
    t.pitch += Math.abs(w.z) * dt;
    t.yaw += Math.abs(w.y) * dt;
    t.time += dt;
    const [axis, amount] = Object.entries(step.until)[0];
    if (t[axis] >= amount) {
      this.i++;
      this.turned = { roll: 0, pitch: 0, yaw: 0, time: 0 };
      if (this.done) return false;
      return this.update(ac, 0);
    }
    const L = this.limits;
    const loopRate = Math.min(0.75 * L.pitch, Math.max(1, ac.airspeed / this.radius));
    this.rates.roll = (step.roll ?? 0) * L.roll;
    if (step.pitch === 'loop') this.rates.pitch = loopRate;
    else if (step.pitch != null) this.rates.pitch = step.pitch * L.pitch;
    else {
      // Hold the flight path level: pitch towards it by how far it's off,
      // the right way up or upside down (body "up" against world up).
      const v = ac.velocity;
      const gamma = Math.asin(Math.max(-1, Math.min(1, v.y / Math.max(1, v.length()))));
      const q = ac.orientation;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // world y of the body's up axis
      this.rates.pitch = Math.max(-0.5 * L.pitch, Math.min(0.5 * L.pitch, -2 * gamma * upY));
    }
    this.rates.yaw = (step.yaw ?? 0) * L.yaw;
    return true;
  }
}
