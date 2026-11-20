// What the neural-network pilot (src/ml/policy.js) sees: a fixed list of
// numbers worked out from the aircraft's state and where it has been asked to
// go. Everything is in the aircraft's own frame (x forward, y up, z right)
// and scaled to roughly -1..1, so one set of features suits every model.
// Shared by the training harness (ml/) and the game, so a policy trained
// there sees exactly the same thing when it flies here.
//
// The target is a point to fly towards plus an airspeed to fly at:
// { x, y, z, speed }. Holding a heading and height is "fly at a point a long
// way ahead at that height"; following waypoints is "fly at the next one".
import { Quaternion, Vector3 } from 'three';

export const OBS_SIZE = 23;

/** Names of the features, in order (for logs and debugging). */
export const OBS_NAMES = [
  'airspeed', 'alpha', 'beta',
  'rollRate', 'yawRate', 'pitchRate',
  'upX', 'upY', 'upZ',
  'agl', 'climbRate',
  'toTargetX', 'toTargetY', 'toTargetZ', 'targetDist',
  'heightError', 'speedError',
  'throttle', 'wingStall',
  'prevRoll', 'prevPitch', 'prevYaw', 'prevThrottle',
];

/**
 * Named choices of inputs (a policy can be trained on a subset of OBS_NAMES).
 *   sim       everything
 *   hardware  only what a real flight controller can measure: gyro rates,
 *             attitude, airspeed (pitot), height and climb rate (baro/GPS),
 *             target from GPS. Leaves out angle of attack and sideslip
 *             (they need vanes or a multi-hole probe) and wing stall
 *             (no sensor gives it).
 */
export const INPUT_SETS = {
  sim: OBS_NAMES,
  hardware: OBS_NAMES.filter((n) => !['alpha', 'beta', 'wingStall'].includes(n)),
};

/** Input names from a set name ("sim", "hardware") or a comma-separated list of names. */
export function resolveInputs(spec = 'sim') {
  const names = Array.isArray(spec) ? spec : INPUT_SETS[spec] ?? String(spec).split(',').map((s) => s.trim());
  for (const n of names) if (!OBS_NAMES.includes(n)) throw new Error(`unknown input "${n}"; have: ${OBS_NAMES.join(', ')}`);
  return names.slice();
}

/** Copy the chosen inputs (indices into the full observation) into `out`. */
export function selectInputs(full, indices, out = new Float64Array(indices.length)) {
  for (let i = 0; i < indices.length; i++) out[i] = full[indices[i]];
  return out;
}

const _qi = new Quaternion();
const _v = new Vector3();
const clip = (x, lim = 1) => (x > lim ? lim : x < -lim ? -lim : x);

/**
 * Fill `out` (length OBS_SIZE) for aircraft `ac`.
 * @param {object} ac          src/sim/aircraft.js Aircraft (after at least one step)
 * @param {object} target      { x, y, z, speed } in world metres and m/s
 * @param {ArrayLike<number>} prev  last network outputs (4 values, -1..1)
 * @param {number} groundY     ground height under the aircraft
 */
export function observe(ac, target, prev, groundY, out = new Float64Array(OBS_SIZE)) {
  _qi.copy(ac.orientation).invert();
  const w = ac.omega;
  let i = 0;
  out[i++] = ac.airspeed / 10 - 1;
  out[i++] = clip(ac.alpha / 0.5, 3);
  out[i++] = clip(ac.beta / 0.5, 3);
  out[i++] = clip(w.x / 3, 3);
  out[i++] = clip(w.y / 3, 3);
  out[i++] = clip(w.z / 3, 3);
  _v.set(0, 1, 0).applyQuaternion(_qi); // world up, seen from the aircraft
  out[i++] = _v.x;
  out[i++] = _v.y;
  out[i++] = _v.z;
  out[i++] = clip((ac.position.y - groundY) / 30 - 1, 3);
  out[i++] = clip(ac.velocity.y / 5, 3);
  _v.set(target.x - ac.position.x, target.y - ac.position.y, target.z - ac.position.z);
  const dist = _v.length();
  _v.applyQuaternion(_qi).divideScalar(Math.max(dist, 1e-6));
  out[i++] = _v.x;
  out[i++] = _v.y;
  out[i++] = _v.z;
  out[i++] = clip(dist / 100, 2);
  out[i++] = clip((target.y - ac.position.y) / 20, 2);
  out[i++] = clip((target.speed - ac.airspeed) / 5, 2);
  out[i++] = ac.throttleActual * 2 - 1;
  out[i++] = ac.wingStall;
  for (let k = 0; k < 4; k++) out[i++] = prev[k];
  return out;
}
