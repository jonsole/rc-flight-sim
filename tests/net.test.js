import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { AIRCRAFT, getAircraft } from '../src/aircraft/index.js';
import { ground } from '../src/sim/terrain.js';
import { NetTow, FigureEightChallenge, COURSE, defaultNetSize, DIFFICULTIES } from '../src/sim/net.js';

const cfg = (def, difficulty, extra = {}) => ({ diameter: defaultNetSize(def, difficulty), dragFactor: 1, cordLength: 3, ...extra });

function flying(def, net, throttle = 0.7) {
  const ac = new Aircraft(def, { ground });
  ac.resetInAir(new Vector3(0, 100, 0), 0, 13);
  ac.assistMode = 'safe';
  ac.controls = { roll: 0, pitch: 0, yaw: 0, throttle };
  if (net) {
    ac.tow = new NetTow(net, ac);
    ac.tow.place(ac);
  }
  return ac;
}

describe('insect net', () => {
  it('bigger nets for harder difficulties, and for more powerful models', () => {
    const se5a = getAircraft('eflite-se5a-900').def;
    const easystar = getAircraft('multiplex-easystar').def;
    expect(defaultNetSize(se5a, 'easy')).toBeLessThan(defaultNetSize(se5a, 'medium'));
    expect(defaultNetSize(se5a, 'medium')).toBeLessThan(defaultNetSize(se5a, 'hard'));
    expect(defaultNetSize(easystar, 'hard')).toBeLessThan(defaultNetSize(se5a, 'hard'));
  });

  for (const entry of AIRCRAFT) {
    it(`${entry.id}: tows each net steadily, opened, and slower the bigger it is`, () => {
      const speeds = {};
      const free = flying(entry.def, null);
      for (let i = 0; i < 8 * 60; i++) free.update(1 / 60);
      speeds.none = free.velocity.length();
      for (const d of Object.keys(DIFFICULTIES)) {
        const ac = flying(entry.def, cfg(entry.def, d));
        for (let i = 0; i < 8 * 60; i++) ac.update(1 / 60);
        expect(Number.isFinite(ac.tow.position.x)).toBe(true);
        expect(ac.tow.snapped).toBe(false);
        expect(ac.tow.open).toBeGreaterThan(0.9);
        // Trailing about a cord's length behind.
        const dist = ac.tow.position.distanceTo(ac.tow.attachPoint(ac));
        expect(dist).toBeGreaterThan(2.9);
        expect(dist).toBeLessThan(3.2);
        speeds[d] = ac.velocity.length();
      }
      expect(speeds.easy).toBeLessThan(speeds.none);
      expect(speeds.medium).toBeLessThan(speeds.easy);
      expect(speeds.hard).toBeLessThan(speeds.medium);
    });
  }

  it('starts folded on the ground behind a parked model, and opens once flying', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = new Aircraft(def, { ground });
    ac.resetOnGround(0, 0, 0);
    const net = new NetTow(cfg(def, 'medium'), ac);
    ac.tow = net;
    net.place(ac);
    expect(net.open).toBe(0);
    expect(net.position.x).toBeLessThan(ac.position.x - 2);
    expect(net.position.y).toBeLessThan(ground.heightAt(net.position.x, net.position.z) + 0.1);
    ac.update(1);
    expect(net.tension).toBe(0); // slack while parked
  });

  const course = (net) => new FigureEightChallenge(net, { ground, base: 0, center: { x: 0, z: 0 }, axis: { x: 1, z: 0 }, side: { x: 0, z: -1 } });

  it('figure of 8: two loops, one each way, gates in order, only at height', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'));
    const ch = course(ac.tow);
    expect(ch.turnA).not.toBe(ch.turnB);
    // Low: the start gate doesn't count.
    const p = new Vector3(0, 5, 0);
    ch.update(0.1, p);
    expect(ch.started).toBe(false);
    expect(ch.directions(p, 0).climb).toBe(1);
    // Fly every gate at height, in order: done after COURSE.laps figure-8s.
    let n = 0;
    while (!ch.done && n < 100) {
      const g = ch.nextGate().pos;
      ch.update(0.5, new Vector3(g.x + 3, COURSE.height, g.z));
      n++;
    }
    expect(ch.done).toBe(true);
    expect(n).toBe(1 + 8 * COURSE.laps);
    expect(ch.time).toBeGreaterThan(0);
    // Skipping a gate doesn't count the one after it.
    const ch2 = course(ac.tow);
    ch2.update(0.1, ch2.nextGate().pos.clone());
    const skip = ch2.lap[1].pos.clone();
    ch2.update(0.1, skip);
    expect(ch2.gateIndex).toBe(1);
  });

  it('says which way to turn for the next gate', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'));
    const ch = course(ac.tow);
    ch.reachedHeight = true;
    // The start gate is at the origin. Heading +x (0) from z = +50 (south of
    // it, seen from above with -z north): it's off to the left.
    expect(ch.directions(new Vector3(-50, COURSE.height, 50), 0).turn).toBe('left');
    expect(ch.directions(new Vector3(-50, COURSE.height, -50), 0).turn).toBe('right');
    expect(ch.directions(new Vector3(-50, COURSE.height, 0), 0).turn).toBe(null);
  });

  it('the loops turn the way the directions say', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'));
    const ch = course(ac.tow);
    // Going round loop A (gates 0, 1, 2): the heading from gate to gate turns towards turnA.
    const hd = (a, b) => Math.atan2(-(b.z - a.z), b.x - a.x);
    const l = ch.lap.map((g) => g.pos);
    const d = Math.atan2(Math.sin(hd(l[1], l[2]) - hd(l[0], l[1])), Math.cos(hd(l[1], l[2]) - hd(l[0], l[1])));
    expect(d > 0 ? 'left' : 'right').toBe(ch.turnA);
  });

  it('catches insects at height with the net open, and none folded', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'));
    const ch = course(ac.tow);
    ac.tow.position.set(0, COURSE.height, 0);
    ac.tow.open = 1;
    ac.tow.airspeed = 12;
    ch.update(1, new Vector3(500, 0, 0));
    expect(ch.caught).toBeGreaterThan(0);
    const before = ch.caught;
    ac.tow.open = 0;
    ch.update(1, new Vector3(500, 0, 0));
    expect(ch.caught - before).toBeLessThan(1e-9);
  });
});
