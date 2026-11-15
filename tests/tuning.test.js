// Aircraft tuning (src/sim/tuning.js): each setting reads its default from
// the model and changes only what it should.
import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
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

describe('aircraft tuning: layout', () => {
  it('moves the thrust line and the tail relative to the wing, and reads them back', () => {
    for (const id of ['eflite-se5a-900', 'buschtrottel-shockcub']) {
      const def = getAircraft(id).def;
      const d = tunedDef(def, {
        thrustHeight: value(def, 'thrustHeight') + 30,
        tailArm: value(def, 'tailArm') + 50,
        tailHeight: value(def, 'tailHeight') - 20,
        tailIncidence: value(def, 'tailIncidence') + 1,
      });
      expect(value(d, 'thrustHeight')).toBeCloseTo(value(def, 'thrustHeight') + 30);
      expect(value(d, 'tailArm')).toBeCloseTo(value(def, 'tailArm') + 50);
      expect(value(d, 'tailHeight')).toBeCloseTo(value(def, 'tailHeight') - 20);
      expect(value(d, 'tailIncidence')).toBeCloseTo(value(def, 'tailIncidence') + 1);
      // The fin goes back with the tailplane; the wing stays put.
      const fin = (x) => x.surfaces.find((s) => s.name === 'fin');
      expect(fin(d).pos[0]).toBeCloseTo(fin(def).pos[0] - 0.05);
      expect(d.surfaces.find((s) => s.wing).pos[0]).toBe(def.surfaces.find((s) => s.wing).pos[0]);
    }
  });

  it('a longer tail arm makes it steadier in pitch (pushes the nose back harder)', () => {
    // Nose 3° up from steady flight: the pitching moment that brings it back.
    const restoring = (def) => {
      const ac = new Aircraft(def, { ground });
      ac.assistMode = 'off';
      ac.resetInAir(new Vector3(0, 300, 0), 0, 12);
      ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0.45 };
      ac.update(4);
      ac.omega.set(0, 0, 0);
      ac.step(1e-6);
      const m0 = ac.lastForces.moment.z;
      ac.orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 3 * Math.PI / 180));
      ac.step(1e-6);
      return m0 - ac.lastForces.moment.z; // nose-down moment gained
    };
    const def = getAircraft('buschtrottel-shockcub').def;
    const longer = tunedDef(def, { tailArm: value(def, 'tailArm') * 1.4 });
    expect(restoring(def)).toBeGreaterThan(0);
    expect(restoring(longer)).toBeGreaterThan(restoring(def) * 1.15);
  });
});

describe('aircraft tuning: propeller', () => {
  const motorWith = (id, change) => tunedDef(getAircraft(id).def, change).motor;
  it('the model\'s own prop flies exactly as before', () => {
    for (const a of AIRCRAFT) {
      const p = a.def.motor.prop;
      const m = motorWith(a.id, { propDiameter: p.diameterIn, propPitch: p.pitchIn, propBlades: p.blades });
      expect(m.staticThrust).toBeCloseTo(a.def.motor.staticThrust, 6);
      expect(m.pitchSpeed).toBeCloseTo(a.def.motor.pitchSpeed, 6);
      expect(m.staticThrust * m.torqueFactor).toBeCloseTo(a.def.motor.staticThrust * a.def.motor.torqueFactor, 6);
    }
  });

  it('bigger prop: more thrust, slower; coarser pitch: faster, a little less static thrust; more blades: a little more thrust, slower', () => {
    const id = 'buschtrottel-shockcub';
    const base = motorWith(id, {});
    const big = motorWith(id, { propDiameter: 9 });
    expect(big.staticThrust).toBeGreaterThan(base.staticThrust * 1.1);
    expect(big.maxRpm).toBeLessThan(base.maxRpm);
    const coarse = motorWith(id, { propPitch: 8 });
    expect(coarse.pitchSpeed).toBeGreaterThan(base.pitchSpeed);
    expect(coarse.staticThrust).toBeLessThan(base.staticThrust);
    const three = motorWith(id, { propBlades: 3 });
    expect(three.staticThrust).toBeGreaterThan(base.staticThrust);
    expect(three.pitchSpeed).toBeLessThan(base.pitchSpeed);
    // Same motor power in each case.
    for (const m of [big, coarse, three]) expect(m.powerScale).toBeCloseTo(1, 6);
  });

  it('a much smaller prop can\'t use all the power: the motor tops out', () => {
    const tiny = motorWith('buschtrottel-shockcub', { propDiameter: 5 });
    expect(tiny.powerScale).toBeLessThan(0.9);
    expect(tiny.maxRpm).toBeCloseTo(getAircraft('buschtrottel-shockcub').def.motor.maxRpm * 1.3, 0);
  });
});
