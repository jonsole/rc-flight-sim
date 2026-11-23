// Training tasks for the phases of a flight other than flying from point to
// point (those are in ml/env.js): take-off, landing, taxiing and aerobatics.
// Each sets the aeroplane up (reset), says where it should go (target, using
// src/ml/guidance.js just as the game's AI flyers do) and scores every
// control step (step). Rewards are roughly "1 per second of doing it well",
// plus bonuses for the moments that matter (a gentle touchdown, stopping
// where it should) and penalties for crashing.
import { Vector3, Quaternion } from 'three';
import { rateLimits } from '../src/ml/rates.js';
import {
  Strip, climbProfile, takeoffTarget, glideHeight, landingTarget, taxiTarget, TAXI_SPEED, GLIDE, LIGHT_WIND,
} from '../src/ml/guidance.js';

const deg = Math.PI / 180;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * A strip and ground surface for this episode: anything from a mown runway
 * to rough grass. In more than a light wind it points into the wind (within
 * 30°), as the AI flyers' strips do in the game; in a light wind, any way.
 */
function randomStrip(env, rng) {
  const mean = env.ac.env.wind?.mean;
  let a = rng() * 2 * Math.PI;
  if (mean && Math.hypot(mean.x, mean.z) > LIGHT_WIND) a = Math.atan2(-mean.z, -mean.x) + (rng() - 0.5) * 60 * deg;
  env.surface = { roll: 0.04 + rng() * 0.14, stiction: 2, drag: 0.9 + rng() * 0.5, bump: 0.002 + rng() * 0.018 };
  return new Strip({ x: 0, z: 0, dir: { x: Math.cos(a), z: Math.sin(a) }, length: 60 + rng() * 120, width: 10 + rng() * 10 });
}

/** Angle (rad) between the aeroplane's nose (horizontally) and the strip direction. */
function alignError(ac, strip) {
  const f = new Vector3(1, 0, 0).applyQuaternion(ac.orientation);
  return Math.atan2(f.x * strip.dir.z - f.z * strip.dir.x, f.x * strip.dir.x + f.z * strip.dir.z);
}

function groundSpeed(ac) {
  return Math.hypot(ac.velocity.x, ac.velocity.z);
}

/** Any airframe point (not a wheel or skid) on the ground: a wing tip, the nose... */
function scraping(ac) {
  return ac.contacts.some((c) => c.onGround && c.type !== 'wheel' && c.type !== 'skid' && !ac.def.handLaunch);
}

// --- Take-off ---------------------------------------------------------------------
// From standing at the start of the strip (or in the pilot's hand, for a
// hand-launched model) to 35 m up the climb-out, straight along the strip.
const takeoff = {
  reset(env, rng) {
    const ac = env.ac;
    const strip = (env.strip = randomStrip(env, rng));
    const p = strip.point(strip.startS, (rng() - 0.5) * 2);
    const heading = strip.heading + (rng() - 0.5) * 10 * deg;
    if (env.def.handLaunch) ac.resetHandLaunch(p.x, p.z, heading);
    else ac.resetOnGround(p.x, p.z, heading);
    env.st = { s: strip.along(ac.position), airborne: false, lateralSum: 0, n: 0 };
  },
  target(env) {
    takeoffTarget(env.ac, env.strip, env.groundY, env.vCruise, env.target);
  },
  step(env, dtc) {
    const ac = env.ac;
    const strip = env.strip;
    const st = env.st;
    const s = strip.along(ac.position);
    const lat = strip.lateral(ac.position);
    const agl = ac.position.y - env.groundY(ac.position.x, ac.position.z);
    // Distance along pays ~1 per second at cruise, but on the ground only
    // up to the end of the strip (else racing along the grass for ever
    // pays as well as flying: the first networks learnt exactly that).
    // In the air, only until 60 m past the end: further on, cruising at
    // full speed (the F-22 at 3 × its estimated cruise) paid more than
    // climbing out did. After that it's height and the climb-out bonus,
    // with a small cost for every second not yet there.
    const onStrip = s < strip.length / 2;
    const paid = onStrip || (agl > 1 && s < strip.length / 2 + 60);
    let r = paid ? Math.max(-0.5, (s - st.s) / env.vCruise) : 0;
    if (!ac.held) r -= dtc * 0.3;
    st.s = s;
    // Height gained (to 35 m) pays 10 in all, however long it takes.
    const h = Math.min(35, Math.max(0, agl));
    r += ((h - (st.h ?? h)) / 35) * 10;
    st.h = h;
    if (agl > 1) st.airborne = true;
    st.lateralSum += Math.abs(lat);
    st.n++;
    if (agl < 5) r -= dtc * clamp01(Math.abs(lat) / (strip.width / 2));
    if (!ac.onGround && !ac.held) {
      r -= dtc * 0.5 * clamp01(Math.abs(agl - climbProfile(strip, s)) / 10);
      if (ac.airspeed < 0.85 * env.vCruise && agl > 2) r -= dtc;
    }
    if (scraping(ac)) r -= dtc * 2;
    if (ac.crashed) return { reward: r - 10, done: true, reason: ac.crashReason };
    if (agl < 5 && Math.abs(lat) > strip.width / 2 + 5) return { reward: r - 5, done: true, reason: 'ran off the strip' };
    if (agl < 1 && s > strip.length / 2 + 10) return { reward: r - 8, done: true, reason: 'ran out of strip' };
    if (agl > 35) return { reward: r + 20, done: true, reason: 'climbed out', success: true };
    if (env.t >= env.seconds) return { reward: r, done: true, reason: 'time' };
    return { reward: r, done: false };
  },
  summary(env) {
    return { meanLateral: env.st.lateralSum / Math.max(1, env.st.n) };
  },
};

/**
 * The nose-up attitude (rad) to touch down in: a tail-dragger halfway to its
 * three-point attitude (a "wheel landing", mains first, as RC pilots land
 * them: the full three-point attitude is near the stall on these foamies,
 * and training for it ended in wing-tip strikes), a tricycle a few degrees
 * nose-up on its mains, a belly-lander nearly level.
 */
export function touchdownPitch(def) {
  const gear = def.contacts.filter((c) => c.type === 'wheel' || c.type === 'skid');
  if (gear.length < 2) return 3 * deg;
  const front = gear.reduce((a, b) => (b.pos[0] > a.pos[0] ? b : a));
  const back = gear.reduce((a, b) => (b.pos[0] < a.pos[0] ? b : a));
  const sitting = Math.atan2(back.pos[1] - front.pos[1], front.pos[0] - back.pos[0]);
  return Math.max(4 * deg, sitting / 2);
}

// --- Landing ----------------------------------------------------------------------
// From 90-160 m out on the approach, a little off the centreline and heading,
// down the 7° glide path, flare, touch down gently near the aim point, and
// roll to a stop on the strip with the motor off.
const land = {
  reset(env, rng) {
    const ac = env.ac;
    const strip = (env.strip = randomStrip(env, rng));
    // Half from the full approach (90-160 m out, as the AI flyers hand over),
    // half from short final (40-90 m), for more practice at the touchdown.
    const s0 = strip.aimS - (rng() < 0.5 ? 90 + rng() * 70 : 40 + rng() * 50);
    const lat = (rng() - 0.5) * 24;
    const p = strip.point(s0, lat);
    const h = glideHeight(strip, s0) + (rng() - 0.5) * 8;
    const heading = strip.heading + (rng() - 0.5) * 40 * deg;
    env.vApproach = 1.15 * env.vCruise;
    ac.resetInAir(new Vector3(p.x, env.groundY(p.x, p.z) + Math.max(6, h), p.z), heading, env.vApproach * (0.95 + 0.25 * rng()));
    ac.throttleActual = 0.2 + 0.2 * rng();
    env.st = { down: false, bounces: 0, sink: null, touchS: null, touchLat: null, touchAlign: null, wasDown: false, flarePitch: touchdownPitch(env.def) };
  },
  target(env) {
    landingTarget(env.ac, env.strip, env.groundY, env.vApproach, env.st.down, env.target);
  },
  step(env, dtc) {
    const ac = env.ac;
    const strip = env.strip;
    const st = env.st;
    const s = strip.along(ac.position);
    const lat = strip.lateral(ac.position);
    const agl = ac.position.y - env.groundY(ac.position.x, ac.position.z);
    let r = 0;
    const touching = ac.onGround;
    if (!st.down) {
      // On the approach: getting nearer the aim point pays (up to ~0.5 per
      // second at approach speed: progress, not time, so staying up longer
      // doesn't pay), less for being off the centreline or the glide path
      // (until the flare, the last 15 m before the aim point: that's up to it).
      const sc = Math.min(s, strip.aimS);
      r += (0.5 * (sc - (st.sPrev ?? sc))) / env.vApproach;
      st.sPrev = sc;
      // (Steering costs, kept small: summed over a whole flight they must
      // stay well short of the cost of crashing.)
      r -= dtc * 0.15 * clamp01(Math.abs(lat) / 15);
      // Getting nearer the centreline pays, moving away costs (progress,
      // so it can't pile up over a long flight; with only the small cost
      // above, the ShockCub drifted off and touched down beside the strip).
      r += (Math.abs(st.latPrev ?? lat) - Math.abs(lat)) / 3;
      st.latPrev = lat;
      // Below the glide path costs more than above (at a real field there
      // are trees under it), but not so much that staying up is safer.
      if (s < strip.aimS - 15) {
        const e = agl - glideHeight(strip, s);
        r -= dtc * (e < 0 ? 0.3 * clamp01(-e / 6) : 0.15 * clamp01(e / 8));
      } else {
        // Near and past the aim point: being up at all costs (get it down).
        r -= dtc * 0.15 * clamp01(agl / 4);
      }
      // The last few metres: in the touchdown attitude (tail-draggers tail
      // down, or the prop hits the ground), motor at idle.
      if (agl < 3 && s > strip.aimS - 40) {
        const at = ac.attitude();
        // (Guidance, not the goal: 0.3 at most each, or a network that skims
        // the strip without landing collects more cost than crashing.)
        r -= dtc * 0.3 * (clamp01(Math.abs(at.pitch - st.flarePitch) / (8 * deg)) + ac.throttleActual);
        // Wings level (or a tip hits) and sinking gently.
        r -= dtc * 0.3 * (clamp01(Math.abs(at.roll) / (10 * deg)) + clamp01((-ac.velocity.y - 1) / 2));
      }
      // Over the far end still flying: overshot.
      if (s > strip.length / 2) return { reward: r - 20, done: true, reason: 'overshot' };
      if (agl > 3) r -= dtc * 0.3 * ac.wingStall;
      if (touching) {
        st.down = true;
        st.wasDown = true;
        st.sink = Math.max(0, -ac.velocity.y);
        st.touchS = s;
        st.touchLat = lat;
        st.touchAlign = alignError(ac, strip);
        const onStrip = Math.abs(lat) < strip.width / 2 && s > -strip.length / 2 && s < strip.length / 2;
        // Down anywhere but the strip: at a real field that's the hedge.
        // (At -5 the Agro learnt to land gently 100 m short every time.)
        if (!onStrip) {
          const why = s < -strip.length / 2 ? 'landed short' : s > strip.length / 2 ? 'landed long' : 'landed beside the strip';
          return { reward: r - 15, done: true, reason: why };
        }
        r += 10 * Math.exp(-st.sink / 1.2); // gentle
        r += 5 * (1 - clamp01(Math.abs(s - strip.aimS) / (strip.length / 2)));
        r -= 3 * clamp01(Math.abs(st.touchAlign) / (30 * deg));
      }
    } else {
      // Rolling out: on the strip, motor off, slowing down. Bounces cost.
      r -= dtc * clamp01(Math.abs(lat) / (strip.width / 2));
      r -= dtc * 2 * ac.throttleActual;
      if (st.wasDown && agl > 0.6 && !touching) {
        st.bounces++;
        r -= 2;
        st.wasDown = false;
      }
      if (touching) st.wasDown = true;
      if (scraping(ac)) r -= dtc * 2;
      if (groundSpeed(ac) < 0.5) return { reward: r + 5, done: true, reason: 'stopped', success: true };
    }
    // Crashing must always be the worst outcome: worse than not landing at
    // all (-20 plus small steering costs), else a network that can't yet land learns to crash quickly
    // rather than pile up the costs of staying up (the ShockCub did).
    if (ac.crashed) return { reward: r - 50, done: true, reason: ac.crashReason };
    if (env.t >= env.seconds) return { reward: r - (st.down ? 0 : 20), done: true, reason: st.down ? 'still rolling' : 'never landed' };
    return { reward: r, done: false };
  },
  summary(env) {
    const st = env.st;
    return { sink: st.sink, touchFromAim: st.touchS == null ? null : st.touchS - env.strip.aimS, touchLat: st.touchLat, bounces: st.bounces };
  },
};

// --- Taxiing ----------------------------------------------------------------------
// On the ground: to one point, then on to a second and stop there, at a
// walking pace, without taking off, tipping or scraping a wing.
const taxi = {
  reset(env, rng) {
    if (env.def.handLaunch) throw new Error(`${env.def.name ?? 'this model'} has no wheels to taxi on`);
    const ac = env.ac;
    randomStrip(env, rng);
    const heading = rng() * 2 * Math.PI;
    ac.resetOnGround(0, 0, heading);
    const fwd = { x: Math.cos(heading), z: -Math.sin(heading) };
    const b1 = Math.atan2(fwd.z, fwd.x) + (rng() - 0.5) * 300 * deg;
    const d1 = 15 + rng() * 25;
    const p1 = { x: Math.cos(b1) * d1, z: Math.sin(b1) * d1 };
    const b2 = b1 + (rng() - 0.5) * 200 * deg;
    const d2 = 10 + rng() * 20;
    const p2 = { x: p1.x + Math.cos(b2) * d2, z: p1.z + Math.sin(b2) * d2 };
    env.st = { points: [p1, p2], i: 0, d: d1, reached: 0, maxSpeed: 0 };
  },
  target(env) {
    const st = env.st;
    taxiTarget(env.ac, st.points[st.i], env.groundY, st.i === st.points.length - 1, null, env.target);
  },
  step(env, dtc) {
    const ac = env.ac;
    const st = env.st;
    const pt = st.points[st.i];
    const d = Math.hypot(pt.x - ac.position.x, pt.z - ac.position.z);
    const gs = groundSpeed(ac);
    st.maxSpeed = Math.max(st.maxSpeed, gs);
    let r = (st.d - d) / TAXI_SPEED; // ~1 per second at taxi speed
    st.d = d;
    r -= dtc * Math.max(0, gs - 4);
    if (!ac.onGround) r -= dtc * 3;
    if (scraping(ac)) r -= dtc * 3;
    const last = st.i === st.points.length - 1;
    if (ac.crashed) return { reward: r - 10, done: true, reason: ac.crashReason };
    if (gs > 7) return { reward: r - 5, done: true, reason: 'too fast' };
    if (!last && d < 3) {
      st.i++;
      st.reached++;
      const n = st.points[st.i];
      st.d = Math.hypot(n.x - ac.position.x, n.z - ac.position.z);
      r += 3;
    } else if (last && d < 3 && gs < 0.5) {
      st.reached++;
      return { reward: r + 5, done: true, reason: 'stopped', success: true };
    }
    if (env.t >= env.seconds) return { reward: r, done: true, reason: 'time' };
    return { reward: r, done: false };
  },
  summary(env) {
    return { reached: env.st.reached, maxSpeed: env.st.maxSpeed };
  },
};

// --- Aerobatics -------------------------------------------------------------------
// Fly commanded body rates (the way manoeuvres are flown, src/ml/guidance.js):
// a random sequence of loop-like pulls, rolls either way, barrel rolls,
// pushes and holds, high up and fast.
const aero = {
  reset(env, rng) {
    const ac = env.ac;
    const heading = rng() * 2 * Math.PI;
    // High enough that 12 s of following commands can't reach the ground:
    // from 70-100 m, height lost following them cost more than the rates
    // paid, and the first network learnt to ignore the commands.
    ac.resetInAir(new Vector3(0, 150 + rng() * 100, 0), heading, env.vCruise * (1.3 + 0.5 * rng()));
    ac.throttleActual = 0.6 + 0.4 * rng();
    const canRoll = env.def.surfaces.some((s) => s.controls.some((c) => c.input === 'roll') && !s.controls.some((c) => c.input === 'yaw'));
    env.st = { rng, canRoll, limits: rateLimits(env.def, env.vCruise), until: 0, rates: { roll: 0, pitch: 0, yaw: 0 }, err: 0, n: 0, minAgl: Infinity };
  },
  target(env) {
    const ac = env.ac;
    const st = env.st;
    if (env.t >= st.until) {
      const rng = st.rng;
      const kinds = st.canRoll ? ['loop', 'loop', 'roll', 'roll', 'barrel', 'push', 'hold'] : ['loop', 'loop', 'push', 'hold'];
      const k = kinds[Math.floor(rng() * kinds.length)];
      const sign = rng() < 0.5 ? -1 : 1;
      // Fractions of what this model can do at full stick (src/ml/rates.js).
      const R = st.rates;
      const L = st.limits;
      R.roll = (k === 'roll' ? sign * (0.35 + 0.45 * rng()) : k === 'barrel' ? sign * (0.2 + 0.2 * rng()) : 0) * L.roll;
      R.pitch = (k === 'loop' ? 0.3 + 0.45 * rng() : k === 'barrel' ? 0.2 + 0.2 * rng() : k === 'push' ? -(0.1 + 0.2 * rng()) : 0) * L.pitch;
      R.yaw = 0;
      st.until = env.t + 0.6 + 1.9 * rng();
    }
    // A point well ahead at the same height and a brisk speed, for the
    // other inputs: aerobatics are about the rates.
    const v = ac.velocity;
    const h = Math.hypot(v.x, v.z) || 1;
    env.target.x = ac.position.x + (v.x / h) * 150;
    env.target.z = ac.position.z + (v.z / h) * 150;
    env.target.y = ac.position.y;
    env.target.speed = 1.5 * env.vCruise;
    env.target.line = null;
    env.target.rates = st.rates;
  },
  step(env, dtc) {
    const ac = env.ac;
    const st = env.st;
    const R = st.rates;
    const w = ac.omega;
    const ep = Math.abs(w.x - R.roll);
    const eq = Math.abs(w.z - R.pitch);
    const er = Math.abs(w.y - R.yaw);
    st.err += ep + eq + er;
    st.n++;
    // Smooth in the error (no cap), scaled to what the model can do, so
    // a little better always scores a little more.
    const L = st.limits;
    let r = dtc * (1 - 0.5 * Math.tanh((4 * ep) / L.roll) - 0.5 * Math.tanh((4 * eq) / L.pitch) - 0.1 * Math.tanh(er));
    // (Not slowness: manoeuvres bleed speed, and penalising it taught the
    // first network to ignore the commands. Stalling still costs.)
    r -= dtc * 0.3 * ac.wingStall;
    const agl = ac.position.y - env.groundY(ac.position.x, ac.position.z);
    st.minAgl = Math.min(st.minAgl, agl);
    if (agl < 25) r -= (dtc * (25 - agl)) / 25;
    if (ac.crashed || agl < 3) return { reward: r - 10, done: true, reason: ac.crashed ? ac.crashReason : 'hit the ground' };
    if (env.t >= env.seconds) return { reward: r, done: true, reason: 'time', success: true };
    return { reward: r, done: false };
  },
  summary(env) {
    return { meanRateErr: env.st.err / Math.max(1, env.st.n), minAgl: env.st.minAgl };
  },
};

export const PHASE_TASKS = { takeoff, land, taxi, aero };
/** Episode lengths (s) that suit each task, used unless --seconds is given. */
export const TASK_SECONDS = { takeoff: 25, land: 35, taxi: 40, aero: 12 };
/** Strongest mean wind (m/s) trained in, unless --wind is given (hold & co: 4). */
export const TASK_WIND = { takeoff: 8, land: 8, taxi: 6, aero: 6 };
/**
 * Starting throttle of a fresh network (bias of its throttle output, before
 * tanh). On grass a model needs well over half throttle to start rolling; a
 * network that starts at half sits still, and every variation of it too, so
 * training learns nothing. Take-off starts near full. (Not taxiing: open, it
 * races off at take-off speed and noses over; at half it rolls on a runway
 * and sits still on long grass, and that mix is enough to learn from.)
 */
export const TASK_THROTTLE_BIAS = { takeoff: 1.2 };
export { GLIDE };
