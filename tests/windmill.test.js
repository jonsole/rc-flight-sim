// A prop windmills in a glide with the throttle closed: it turns (seen and
// heard) and drags, but the motor isn't driving it.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { AIRCRAFT } from '../src/aircraft/index.js';
import { ground } from '../src/sim/terrain.js';

describe('windmilling prop', () => {
  for (const a of AIRCRAFT.filter((x) => !x.def.handLaunch)) {
    it(`${a.id}: glides with the throttle closed, prop turning and dragging`, () => {
      const ac = new Aircraft(a.def, { ground });
      ac.assistMode = 'off';
      ac.resetInAir(new Vector3(0, 400, 0), 0, 14);
      ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
      ac.update(4);
      const frac = ac.rpm / a.def.motor.maxRpm;
      expect(frac).toBeGreaterThan(0.1);
      expect(frac).toBeLessThan(0.6);
      expect(ac.thrust).toBeLessThan(0);
      expect(ac.motorRpm).toBeLessThan(1);
      expect(ac.battery.current).toBeLessThan(0.01);
    });
  }

  it('stopped on the ground and with a broken prop', () => {
    const a = AIRCRAFT[0];
    const ac = new Aircraft(a.def, { ground });
    ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    ac.update(5);
    expect(ac.rpm).toBeLessThan(20);
    ac.resetInAir(new Vector3(0, 400, 0), 0, 14);
    ac.propBroken = true;
    ac.update(5);
    expect(ac.rpm).toBeLessThan(20);
  });
});
