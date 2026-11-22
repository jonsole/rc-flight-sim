import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Aircraft } from '../src/sim/aircraft.js';
import { AIRCRAFT, getAircraft } from '../src/aircraft/index.js';
import { ground } from '../src/sim/terrain.js';
import { NetTow, InsectChallenge, defaultNetSize, DIFFICULTIES } from '../src/sim/net.js';

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

  it('catches insects flying through a swarm, and none when folded', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'));
    const ch = new InsectChallenge(ac.tow, { ground, center: { x: 0, z: 0 }, rand: () => 0.5 });
    ch.started = true;
    const s = ch.swarms[0];
    ac.tow.position.copy(s.pos);
    ac.tow.open = 1;
    ac.tow.airspeed = 12;
    ch.update(0.05);
    expect(ch.caught).toBeGreaterThan(0);
    const before = ch.caught;
    ac.tow.open = 0;
    ch.update(0.05);
    expect(ch.caught - before).toBeLessThan(1e-9);
  });

  it('a pass through a swarm catches up to about an eighth of the target', () => {
    const def = getAircraft('eflite-se5a-900').def;
    const ac = flying(def, cfg(def, 'medium'), 0.8);
    const ch = new InsectChallenge(ac.tow, { ground, center: { x: 0, z: 0 }, rand: () => 0.5 });
    ch.started = true;
    // Line up 40 m short of a swarm, flying straight at it at its height; hold the
    // swarm still and fly on through.
    const s = ch.swarms[0];
    s.home.set(60, 100, 0);
    ac.resetInAir(new Vector3(20, 100, 0), 0, 13);
    ac.tow.place(ac);
    for (let i = 0; i < 6 * 60; i++) {
      ac.update(1 / 60);
      s.phase = 0;
      s.home.set(60, ac.tow.position.y, 0); // (level with the net, wherever it sags to)
      ch.update(1 / 60);
    }
    expect(ac.tow.position.x).toBeGreaterThan(70);
    expect(ch.caught / ch.target).toBeGreaterThan(0.06); // (the swarm drifts, and thins as it's caught)
    expect(ch.caught / ch.target).toBeLessThan(0.17);
  });
});
