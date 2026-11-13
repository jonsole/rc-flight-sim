import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { AIRCRAFT, getAircraft } from '../src/aircraft/index.js';
import { buildBuschtrottel } from '../src/aircraft/buschtrottel.js';
import { ground } from '../src/sim/terrain.js';
import { Obstacles } from '../src/sim/obstacles.js';
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

/** Slowest speed at which the aircraft can make lift equal to weight. */
function stallSpeed() {
  let maxLift = 0;
  for (let a = 0; a <= 20; a += 1) maxLift = Math.max(maxLift, pitchMomentAt(a, 10).lift);
  return 10 * Math.sqrt((def.mass * 9.81) / maxLift);
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

      it('trims in pitch at a sensible cruise speed (wings held level)', () => {
        const vs = stallSpeed();
        const ac = airborne(vs * 1.6, 0.5);
        for (let t = 0; t < 20; t += 0.05) {
          ac.controls.roll = Math.max(-1, Math.min(1, -2 * ac.attitude().roll));
          ac.update(0.05);
        }
        const att = ac.attitude();
        expect(ac.airspeed).toBeGreaterThan(vs * 1.2);
        expect(ac.airspeed).toBeLessThan(vs * 2.5);
        expect(Math.abs(att.pitch)).toBeLessThan(15 * deg);
        expect(Math.abs(ac.omega.z)).toBeLessThan(0.15);
      });

      it('stays close to wings-level hands-off at gentle cruise power', () => {
        const ac = airborne(stallSpeed() * 1.6, 0.3);
        ac.update(20);
        expect(Math.abs(ac.attitude().roll)).toBeLessThan(25 * deg);
      });

      it('stalls at a plausible speed for its wing loading', () => {
        const vStall = stallSpeed();
        expect(vStall).toBeGreaterThan(4);
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

      // Elevator commands below are after the default expo (0.3) and rate (1.0):
      // half stick ≈ 0.39, full stick = 1.
      function pullFromCruise(cmd, seconds = 2) {
        const ac = airborne(stallSpeed() * 1.7, 0.5);
        ac.update(1);
        let stalled = 0;
        let rollRate = 0;
        for (let t = 0; t < seconds; t += 0.02) {
          ac.controls.pitch = cmd;
          ac.update(0.02);
          const w = ac.surfaces.filter((s) => s.wing);
          stalled = Math.max(stalled, w.reduce((sum, s) => sum + s.stalled, 0) / w.length);
          rollRate = Math.max(rollRate, Math.abs(ac.omega.x));
        }
        return { stalled, rollRate };
      }

      it('does not stall in a moderate pull at cruise speed (half stick)', () => {
        // First second only: hold it longer and it loops, slowing over the top.
        expect(pullFromCruise(0.39, 1).stalled).toBeLessThan(0.2);
      });

      it('does not drop a wing when the stick is yanked fully back', () => {
        expect(pullFromCruise(1).rollRate).toBeLessThan(2.6); // rad/s, ~150°/s (a biplane may snap a little)
      });

      it('sits on its main wheels and tail skid / tail wheel', () => {
        const ac = new Aircraft(def, { ground });
        ac.resetOnGround(0, 0, 0);
        ac.update(3);
        expect(ac.crashed).toBe(false);
        const total = ac.contacts.reduce((s, c) => s + c.load, 0);
        expect(total).toBeCloseTo(def.mass * 9.81, 0);
        const gear = ac.contacts.filter((c) => c.type === 'wheel' || c.type === 'skid');
        const tail = gear.reduce((a, b) => (b.pos.x < a.pos.x ? b : a));
        expect(tail.load).toBeGreaterThan(0.1 * def.mass * 9.81);
        expect(ac.attitude().pitch).toBeGreaterThan(5 * deg); // tail-down
      });

      it('takes off under full power with a touch of up elevator', () => {
        const ac = new Aircraft(def, { ground });
        ac.resetOnGround(0, 0, 0);
        ac.controls.throttle = 1;
        let liftoff = null;
        for (let t = 0; t < 10; t += 0.05) {
          // A simple pilot: hold the wings level, ease back after 2.5 s,
          // then relax the stick and throttle back once airborne.
          const att = ac.attitude();
          ac.controls.roll = Math.max(-1, Math.min(1, -2 * att.roll));
          ac.controls.pitch = liftoff ? Math.max(-0.3, Math.min(0.3, -1.5 * (att.pitch - 0.15))) : t > 2.5 ? 0.15 : 0;
          if (liftoff) ac.controls.throttle = 0.6;
          ac.update(0.05);
          if (!liftoff && ac.position.y > 1.5) liftoff = ac.position.x;
        }
        expect(ac.crashed).toBe(false);
        expect(liftoff).not.toBeNull();
        expect(liftoff).toBeLessThan(80);
      });

      it('has a dihedral effect: sideslip rolls it away from the slip', () => {
        const ac = airborne(10, 0);
        ac.throttleActual = 0;
        const beta = 5 * deg;
        ac.velocity.set(10 * Math.cos(beta), 0, 10 * Math.sin(beta)); // slipping right
        ac.step(1e-6);
        const q = 0.5 * 1.225 * 100;
        const clBeta = ac.lastForces.moment.x / (q * def.wingArea * ac.wingSpan) / beta;
        expect(clBeta).toBeLessThan(-0.08); // rolls left, raising the right wing
      });

      it('rolls back towards level when a bank is released (hands off)', () => {
        const ac = airborne(stallSpeed() * 1.7, 0.45);
        ac.update(3);
        ac.orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 30 * deg));
        ac.update(10);
        expect(Math.abs(ac.attitude().roll)).toBeLessThan(15 * deg);
      });

      it('gets ground effect: more lift and less drag just above the ground', () => {
        const forcesAt = (heightInSpans) => {
          const ac = airborne(9, 0);
          ac.throttleActual = 0;
          ac.orientation.setFromAxisAngle(new Vector3(0, 0, 1), 5 * deg);
          ac.velocity.set(9, 0, 0);
          const lowestWing = Math.min(...ac.surfaces.filter((s) => s.wing).map((s) => s.pos.y));
          ac.position.set(0, heightInSpans * ac.wingSpan - lowestWing, 0);
          ac.step(1e-6);
          return { lift: ac.lastForces.aero.y, drag: -ac.lastForces.aero.x, ge: ac.groundEffect };
        };
        const near = forcesAt(0.1);
        const far = forcesAt(3);
        expect(near.lift).toBeGreaterThan(far.lift * 1.03);
        expect(near.drag).toBeLessThan(far.drag * 0.9);
        expect(near.ge).toBeGreaterThan(0.1); // biplanes get less: the upper wing is higher
        expect(far.ge).toBeLessThan(0.01);
      });

      it('runs straight on a hands-off, full-power takeoff', () => {
        const ac = new Aircraft(def, { ground });
        ac.assistMode = 'off';
        ac.resetOnGround(0, 0, 0);
        ac.controls.throttle = 1;
        const h0 = ac.attitude().heading;
        let swing = 0;
        for (let t = 0; t < 5 && ac.position.y < 0.5; t += 0.02) {
          ac.update(0.02);
          swing = Math.max(swing, Math.abs(ac.attitude().heading - h0));
        }
        expect(swing).toBeLessThan(3 * deg);
      });

      it('can be steered on the ground with rudder', () => {
        const ac = new Aircraft(def, { ground });
        ac.assistMode = 'off';
        ac.resetOnGround(0, 0, 0);
        ac.controls = { roll: 0, pitch: 0, yaw: 1, throttle: 0.35 };
        const h0 = ac.attitude().heading;
        ac.update(1.5); // short enough that the heading can't wrap past 180°
        expect(ac.onGround).toBe(true);
        expect(ac.attitude().heading - h0).toBeGreaterThan(15 * deg); // turned right
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
        const ac = airborne(stallSpeed() * 1.6, 1);
        const v0 = ac.battery.voltage;
        ac.update(30);
        const fullPower = (def.battery.maxCurrent * 30 * 1000) / 3600; // mAh in 30 s
        expect(ac.battery.used).toBeGreaterThan(0.8 * fullPower);
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
        // Some models self-level partly on their own; SAFE must do clearly better.
        const safe = bankedRelease('safe');
        expect(safe).toBeLessThan(5 * deg);
        expect(safe).toBeLessThan(bankedRelease('off') * 0.5);
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

describe('Buschtrottel leading-edge slats', () => {
  const style = {
    id: 'test', name: 'test', summary: '', mount: 'high', tips: 'round', tail: 'round',
    mass: 0.45, tailIncidence: 3 * deg, rollTrim: 0, colors: { main: '#fff', accent: '#000', wing: '#fff', tail: '#fff' },
  };

  it('lower the stall speed', () => {
    const vs = (slats) => {
      def = buildBuschtrottel({ ...style, slats }).def;
      return stallSpeed();
    };
    expect(vs(true)).toBeLessThan(vs(false) * 0.92);
  });

  // Classic stall: wings level, ease the elevator fully back over 7 s and hold.
  function stallTest(id, throttle) {
    def = getAircraft(id).def;
    const ac = airborne(10, throttle);
    ac.update(2);
    let maxRoll = 0;
    for (let t = 0; t < 10; t += 0.02) {
      ac.controls.pitch = Math.min(1, t / 7); // to full stick (default rate 100%)
      ac.update(0.02);
      maxRoll = Math.max(maxRoll, Math.abs(ac.attitude().roll));
    }
    return maxRoll;
  }

  for (const id of ['buschtrottel-shockcub', 'buschtrottel-highlander', 'buschtrottel-agro']) {
    it(`${id} stalls straight ahead without dropping a wing`, () => {
      expect(stallTest(id, 0)).toBeLessThan(10 * deg);
      // With power a little motor torque may slowly roll it (more with a
      // three-blade prop), but no wing drop.
      expect(stallTest(id, 0.2)).toBeLessThan(20 * deg);
    });
  }
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

describe('collisions with obstacles', () => {
  const obstacles = new Obstacles();
  const def = getAircraft('buschtrottel-shockcub').def;
  // A broadleaf tree reasonably close to the field.
  const tree = obstacles.trees.find((t) => !t.conifer && Math.hypot(t.x, t.z) < 300);

  /** Fly level along +x at `speed`, aimed so the nose reaches (x, y, z) after ~1 s. */
  function flyAt(target, speed, seconds = 3) {
    const ac = new Aircraft(def, { ground, obstacles });
    ac.assistMode = 'off';
    ac.resetInAir(new Vector3(target.x - speed * 1.2, target.y, target.z), 0, speed);
    ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0.6 };
    ac.update(seconds);
    return ac;
  }

  it('crashes into a tree trunk', () => {
    const ac = flyAt({ x: tree.x, y: tree.y + 1.2, z: tree.z }, 9);
    expect(ac.crashed).toBe(true);
    expect(ac.crashReason).toMatch(/tree trunk/);
    expect(ac.position.x).toBeLessThan(tree.x + 1); // stopped, not passed through
  });

  it('crashes into the club hut', () => {
    const ac = flyAt({ x: -29, y: 1.5, z: 26 }, 10);
    expect(ac.crashed).toBe(true);
    expect(ac.crashReason).toMatch(/club hut/);
  });

  it('crashes into foliage at speed', () => {
    const ac = flyAt({ x: tree.x - tree.crownW, y: tree.y + tree.h * 0.62, z: tree.z }, 10);
    expect(ac.crashed).toBe(true);
    expect(ac.crashReason).toMatch(/tree/);
  });

  it('is caught by the branches when it drifts in slowly', () => {
    const ac = new Aircraft(def, { ground, obstacles });
    ac.assistMode = 'off';
    const cy = tree.y + tree.h * 0.62;
    ac.resetInAir(new Vector3(tree.x - tree.crownW - 0.3, cy, tree.z), 0, 2.5);
    ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    let caught = false;
    for (let t = 0; t < 2; t += 0.02) {
      ac.update(0.02);
      caught ||= ac.inFoliage;
    }
    expect(caught).toBe(true);
    expect(ac.crashed).toBe(false);
    expect(ac.velocity.length()).toBeLessThan(2); // held back by the foliage
  });

  it('leaves the runway and the circuit clear', () => {
    const ac = new Aircraft(def, { ground, obstacles });
    ac.assistMode = 'off';
    ac.resetOnGround(40, -22, Math.PI);
    ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 1 };
    for (let t = 0; t < 8; t += 0.05) {
      ac.controls.roll = Math.max(-1, Math.min(1, -2 * ac.attitude().roll));
      ac.controls.pitch = Math.max(-0.3, Math.min(0.3, -1.5 * (ac.attitude().pitch - 0.2)));
      ac.update(0.05);
    }
    expect(ac.crashed).toBe(false);
  });
});

describe('terrain', () => {
  it('physics ground height matches the rendered terrain triangles exactly', async () => {
    const { PlaneGeometry, Vector3: V } = await import('three');
    const { heightAt, gridHeight, TERRAIN_SIZE, TERRAIN_SEGMENTS } = await import('../src/sim/terrain.js');
    // Build the render mesh exactly as the world does.
    const geo = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, gridHeight(i % (TERRAIN_SEGMENTS + 1), Math.floor(i / (TERRAIN_SEGMENTS + 1))));
    const idx = geo.index.array;
    const cell = TERRAIN_SIZE / TERRAIN_SEGMENTS;
    const a = new V();
    const b = new V();
    const c = new V();
    let rnd = 7;
    const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    let worst = 0;
    let tested = 0;
    for (let k = 0; k < 400; k++) {
      // Points out in the hills (the flat field is trivially zero everywhere).
      const ang = rand() * Math.PI * 2;
      const r = 500 + rand() * 1500;
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const ix = Math.floor((x + TERRAIN_SIZE / 2) / cell);
      const iz = Math.floor((z + TERRAIN_SIZE / 2) / cell);
      const t0 = (iz * TERRAIN_SEGMENTS + ix) * 6; // two triangles per cell
      for (const t of [t0, t0 + 3]) {
        a.fromBufferAttribute(pos, idx[t]);
        b.fromBufferAttribute(pos, idx[t + 1]);
        c.fromBufferAttribute(pos, idx[t + 2]);
        // Barycentric coordinates in the xz plane.
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        const w1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
        const w2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        const meshY = w1 * a.y + w2 * b.y + w3 * c.y;
        worst = Math.max(worst, Math.abs(meshY - heightAt(x, z)));
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(390);
    expect(worst).toBeLessThan(1e-3); // metres
  });
});

describe('ground surfaces', () => {
  it('long grass has more rolling resistance than the runway, and gear rides bumps', async () => {
    const { physicsGround, surfaceAt } = await import('../src/sim/terrain.js');
    expect(surfaceAt(0, -22).name).toMatch(/runway/);
    expect(surfaceAt(0, -60).name).toMatch(/grass/);
    for (const e of AIRCRAFT) {
      const rollout = (x, z) => {
        const ac = new Aircraft(e.def, { ground: physicsGround });
        ac.assistMode = 'off';
        ac.resetOnGround(x, z, Math.PI);
        ac.update(0.5);
        ac.velocity.set(-7, 0, 0);
        const x0 = ac.position.x;
        let bounce = 0;
        for (let t = 0; t < 10; t += 0.02) {
          ac.update(0.02);
          bounce = Math.max(bounce, Math.abs(ac.velocity.y));
        }
        return { dist: Math.abs(ac.position.x - x0), bounce };
      };
      const runway = rollout(0, -22);
      const grass = rollout(0, -60);
      expect(grass.dist).toBeLessThan(runway.dist * 0.85);
      expect(grass.bounce).toBeGreaterThan(0.02); // the bumps are felt
    }
  });

  it('has stiction: a parked model stays put and needs some throttle to roll', async () => {
    const { physicsGround } = await import('../src/sim/terrain.js');
    for (const e of AIRCRAFT) {
      const moved = (throttle) => {
        const ac = new Aircraft(e.def, { ground: physicsGround });
        ac.assistMode = 'off';
        ac.resetOnGround(0, -60, Math.PI);
        ac.update(1);
        const p0 = ac.position.clone();
        ac.controls.throttle = throttle;
        ac.update(2);
        return ac.position.distanceTo(p0);
      };
      expect(moved(0.15)).toBeLessThan(0.1);
      expect(moved(0.8)).toBeGreaterThan(1);
    }
  });
});
