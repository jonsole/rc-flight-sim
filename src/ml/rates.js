// How fast a model can roll, pitch and yaw (rad/s): measured once per
// aircraft definition by flying it at full stick in the flight model, at
// 1.6 × cruise. Aerobatic rate commands (src/ml/guidance.js manoeuvres,
// the ml/tasks.js "aero" task) are fractions of these, so a nimble foamie
// rolls fast and a trainer gently, and nothing is asked for that the model
// can't do.
import { Vector3 } from 'three';
import { Aircraft } from '../sim/aircraft.js';

const cache = new WeakMap();
const flat = { heightAt: () => 0, normalAt: (x, z, o) => o.set(0, 1, 0), surfaceAt: () => ({ roll: 0.05, stiction: 1, drag: 1 }) };

/** { roll, pitch, yaw } peak rates at full stick (rad/s). `vCruise` from aiPilot.cruiseSpeed. */
export function rateLimits(def, vCruise) {
  if (cache.has(def)) return cache.get(def);
  const peak = (ctl, axis) => {
    const ac = new Aircraft(def, { ground: flat });
    ac.assistMode = 'off';
    ac.resetInAir(new Vector3(0, 200, 0), 0, 1.6 * vCruise);
    ac.throttleActual = 1;
    ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 1, ...ctl };
    let p = 0;
    for (let i = 0; i < 300; i++) {
      ac.step(1 / 300);
      p = Math.max(p, Math.abs(ac.omega[axis]));
    }
    return p;
  };
  const r = { roll: peak({ roll: 1 }, 'x'), pitch: peak({ pitch: 1 }, 'z'), yaw: peak({ yaw: 1 }, 'y') };
  cache.set(def, r);
  return r;
}
