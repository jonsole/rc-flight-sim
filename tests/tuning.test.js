// Aircraft tuning (src/sim/tuning.js): each setting reads its default from
// the model and changes only what it should.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { AIRCRAFT, getAircraft } from '../src/aircraft/index.js';
import { tunablesFor, tunedDef } from '../src/sim/tuning.js';
import { Aircraft } from '../src/sim/aircraft.js';
import { ground } from '../src/sim/terrain.js';

const value = (def, key) => tunablesFor(def).find((t) => t.key === key)?.dflt;

describe('aircraft tuning', () => {
  it('every model has sensible defaults, and no tuning leaves it alone', () => {
    for (const a of AIRCRAFT) {
      const ts = tunablesFor(a.def);
      for (const t of ts) {
        expect(Number.isFinite(t.dflt)).toBe(true);
        expect(t.dflt).toBeGreaterThanOrEqual(t.min - 1e-9);
        expect(t.dflt).toBeLessThanOrEqual(t.max + 1e-9);
      }
      expect(tunedDef(a.def, {})).toBe(a.def);
    }
    expect(value(getAircraft('ft-mini-f22').def, 'rudder')).toBeUndefined(); // no rudder
  });

  it('sets what it says, and reads it back', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const d = tunedDef(def, { elevator: 10, dihedral: value(def, 'dihedral') + 4, mass: 1000, thrust: 2 * def.motor.staticThrust });
    expect(value(d, 'elevator')).toBeCloseTo(10);
    expect(value(d, 'dihedral')).toBeCloseTo(value(def, 'dihedral') + 4);
    expect(d.mass).toBeCloseTo(1);
    expect(d.inertia[0] / def.inertia[0]).toBeCloseTo(1 / def.mass);
    // More thrust, the same motor torque.
    expect(d.motor.staticThrust * d.motor.torqueFactor).toBeCloseTo(def.motor.staticThrust * def.motor.torqueFactor);
    // The model itself is untouched.
    expect(value(def, 'elevator')).toBeCloseTo(12);
  });

  it('moves the CG: everything else shifts back', () => {
    const def = getAircraft('buschtrottel-shockcub').def;
    const d = tunedDef(def, { cg: 10 });
    expect(d.surfaces[0].pos[0]).toBeCloseTo(def.surfaces[0].pos[0] - 0.01);
    expect(d.contacts[0].pos[0]).toBeCloseTo(def.contacts[0].pos[0] - 0.01);
    expect(d.motor.position[0]).toBeCloseTo(def.motor.position[0] - 0.01);
  });

  it('more drag: a shorter glide', () => {
    const glide = (def) => {
      const ac = new Aircraft(def, { ground });
      ac.assistMode = 'off';
      ac.resetInAir(new Vector3(0, 400, 0), 0, 12);
      ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
      ac.update(6);
      const p0 = ac.position.clone();
      ac.update(10);
      const dd = ac.position.clone().sub(p0);
      return Math.hypot(dd.x, dd.z) / -dd.y;
    };
    const def = getAircraft('buschtrottel-shockcub').def;
    expect(glide(tunedDef(def, { profileDrag: 2, bodyDrag: 2 }))).toBeLessThan(glide(def) * 0.85);
  });
});
