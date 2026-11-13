import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { AIRCRAFT, getAircraft } from '../src/aircraft/index.js';
import { ground } from '../src/sim/terrain.js';
import { coefficients, liftSlope } from '../src/sim/aero.js';
import { applyExpo } from '../src/input/input.js';

const deg = Math.PI / 180;

// Aircraft definition under test (set per registry entry below).
let def = AIRCRAFT[0].def;

function airborne(speed = 13, throttle = 0.5, assist = 'off') {
  const ac = new Aircraft(def, { ground });
  ac.resetInAir(new Vector3(0, 150, 0), 0, speed);
  ac.assistMode = assist;
  ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle };
  return ac;
}

/** Aerodynamic pitching moment at a given body angle of attack (no thrust). */
function pitchMomentAt(alphaDeg, speed = 14) {
  const ac = airborne(speed, 0);
  ac.throttleActual = 0;
  ac.orientation.setFromAxisAngle(new Vector3(0, 0, 1), alphaDeg * deg);
  ac.velocity.set(speed, 0, 0);
  ac.step(1e-6);
  return { mz: ac.lastForces.moment.z, lift: ac.lastForces.aero.y };
}

describe('aerodynamic coefficients', () => {
  const foil = { cla: liftSlope(6), alpha0: 0, alphaStall: 13 * deg, cd0: 0.012, ar: 6, e: 0.8 };

  it('is linear below the stall', () => {
    const a = coefficients(4 * deg, foil);
    expect(a.cl).toBeCloseTo(foil.cla * 4 * deg, 2);
    expect(a.stalled).toBeLessThan(0.01);
  });

  it('loses lift past the stall', () => {
    const peak = Math.max(...[10, 12, 13, 14].map((d) => coefficients(d * deg, foil).cl));
    expect(coefficients(30 * deg, foil).cl).toBeLessThan(peak);
    expect(coefficients(30 * deg, foil).cd).toBeGreaterThan(0.3);
  });

  it('is finite at any angle', () => {
    for (let d = -360; d <= 360; d += 7) {
      const c = coefficients(d * deg, foil);
      expect(Number.isFinite(c.cl) && Number.isFinite(c.cd)).toBe(true);
      expect(c.cd).toBeGreaterThan(0);
    }
  });
});

for (const entry of AIRCRAFT) {
  describe(entry.name, () => {
    beforeEach(() => {
      def = entry.def;
    });

    describe('flight model', () => {
      it('is statically stable in pitch', () => {
        const lo = pitchMomentAt(0).mz;
        const hi = pitchMomentAt(4).mz;
        expect(hi).toBeLessThan(lo); // nose-down moment grows with alpha
      });

      it('trims hands-off at a sensible cruise speed', () => {
        const ac = airborne(13, 0.5);
        ac.update(20);
        const att = ac.attitude();
        expect(ac.airspeed).toBeGreaterThan(9);
        expect(ac.airspeed).toBeLessThan(18);
        expect(Math.abs(att.pitch)).toBeLessThan(15 * deg);
        expect(Math.abs(ac.omega.z)).toBeLessThan(0.3);
      });

      it('stalls at a scale-like speed', () => {
        // Find the slowest speed at which lift can still equal weight.
        const weight = def.mass * 9.81;
        let maxLift = 0;
        for (let a = 0; a <= 20; a += 1) maxLift = Math.max(maxLift, pitchMomentAt(a, 10).lift);
        const vStall = 10 * Math.sqrt(weight / maxLift);
        expect(vStall).toBeGreaterThan(5);
        expect(vStall).toBeLessThan(10);
      });

      it('responds to the sticks in the right sense', () => {
        const rate = (ctl) => {
          const ac = airborne();
          Object.assign(ac.controls, ctl);
          ac.update(0.1); // the 900 mm model responds (and stalls) quickly
          return ac.omega;
        };
        expect(rate({ roll: 1 }).x).toBeGreaterThan(0.5); // right roll
        expect(rate({ roll: -1 }).x).toBeLessThan(-0.5);
        expect(rate({ pitch: 1 }).z).toBeGreaterThan(0.3); // nose up
        expect(rate({ pitch: -1 }).z).toBeLessThan(-0.3);
        expect(rate({ yaw: 1 }).y).toBeLessThan(-0.2); // nose right (−ω_y)
      });

      it('sits on its wheels and tail skid', () => {
        const ac = new Aircraft(def, { ground });
        ac.resetOnGround(0, 0, 0);
        ac.update(3);
        expect(ac.crashed).toBe(false);
        const total = ac.contacts.reduce((s, c) => s + c.load, 0);
        expect(total).toBeCloseTo(def.mass * 9.81, 0);
        expect(ac.contacts.find((c) => c.name === 'skid').load).toBeGreaterThan(1);
        expect(ac.attitude().pitch).toBeGreaterThan(5 * deg); // tail-down
      });

      it('takes off under full power with a touch of up elevator', () => {
        const ac = new Aircraft(def, { ground });
        ac.resetOnGround(0, 0, 0);
        ac.controls.throttle = 1;
        let liftoff = null;
        for (let t = 0; t < 10; t += 0.05) {
          ac.controls.pitch = t > 2.5 ? 0.15 : 0;
          ac.update(0.05);
          if (!liftoff && ac.position.y > 1.5) liftoff = ac.position.x;
        }
        expect(ac.crashed).toBe(false);
        expect(liftoff).not.toBeNull();
        expect(liftoff).toBeLessThan(80);
      });

      it('detects a nose-in crash', () => {
        const ac = airborne(15, 0.5);
        ac.position.y = 3;
        ac.orientation.setFromAxisAngle(new Vector3(0, 0, 1), -60 * deg);
        ac.velocity.set(10, -10, 0);
        ac.update(1);
        expect(ac.crashed).toBe(true);
      });

      it('drains the battery under power', () => {
        const ac = airborne(13, 1);
        const v0 = ac.battery.voltage;
        ac.update(30);
        expect(ac.battery.used).toBeGreaterThan(200);
        expect(ac.battery.voltage).toBeLessThan(v0);
      });
    });

    describe('flight assist', () => {
      function bankedRelease(mode) {
        const ac = airborne(13, 0.5, mode);
        ac.orientation.setFromAxisAngle(new Vector3(1, 0, 0), 40 * deg);
        ac.velocity.set(13, 0, 0);
        ac.update(4);
        return Math.abs(ac.attitude().roll);
      }

      it('SAFE levels the wings when the sticks are released', () => {
        expect(bankedRelease('safe')).toBeLessThan(5 * deg);
        expect(bankedRelease('off')).toBeGreaterThan(15 * deg);
      });

      it('SAFE limits the bank angle at full stick', () => {
        const ac = airborne(13, 0.6, 'safe');
        ac.controls.roll = 1;
        ac.update(4);
        expect(Math.abs(ac.attitude().roll)).toBeLessThan(55 * deg);
      });

      it('AS3X damps a pitch disturbance faster than manual', () => {
        const settle = (mode) => {
          const ac = airborne(13, 0.5, mode);
          ac.omega.set(0, 0, 1.5); // sudden nose-up gust
          let sum = 0;
          for (let i = 0; i < 40; i++) {
            ac.update(0.025);
            sum += Math.abs(ac.omega.z);
          }
          return sum;
        };
        expect(settle('as3x')).toBeLessThan(settle('off'));
      });
    });
  });
}

describe('E-flite S.E.5a 900mm specification', () => {
  beforeEach(() => {
    def = getAircraft('eflite-se5a-900').def;
  });

  it('matches the published size and weight', () => {
    const tips = ac => ac.contacts.filter((c) => c.name.startsWith('upper-tip'));
    const ac = new Aircraft(def, { ground });
    const [l, r] = tips(ac);
    expect(r.pos.z - l.pos.z).toBeCloseTo(0.899, 2);
    expect(def.mass).toBeCloseTo(1.303, 2);
    // CG 72 mm behind the top-wing leading edge (CG is the body origin).
    expect(getAircraft('eflite-se5a-900').geometry.upperLeX).toBeCloseTo(0.072, 3);
  });
});

describe('aircraft registry', () => {
  it('has unique ids and complete entries', () => {
    const ids = AIRCRAFT.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of AIRCRAFT) {
      expect(a.name && a.summary && a.def && a.views && a.createModel).toBeTruthy();
      expect(['off', 'as3x', 'safe']).toContain(a.defaultAssist);
    }
  });

  it('falls back to the default aircraft for unknown ids', () => {
    expect(getAircraft('nope').id).toBe('eflite-se5a-900');
  });
});

describe('input shaping', () => {
  it('expo keeps end points and softens the centre', () => {
    expect(applyExpo(1, 0.5)).toBeCloseTo(1);
    expect(applyExpo(-1, 0.5)).toBeCloseTo(-1);
    expect(applyExpo(0.3, 0.5)).toBeLessThan(0.3);
  });
});
