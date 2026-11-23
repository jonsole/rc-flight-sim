import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { physicsGround as ground } from '../src/sim/terrain.js';
import { Obstacles } from '../src/sim/obstacles.js';
import { Wind } from '../src/sim/wind.js';
import { makeRng } from '../ml/env.js';
import { AiPilot } from '../src/ml/aiPilot.js';
import { AiFlyers, AI_AIRCRAFT, skillsOf } from '../src/ml/aiFlyers.js';
import { MANEUVERS, maneuversFor, ManeuverRunner } from '../src/ml/guidance.js';
import { chooseStrip, windVector } from '../src/ml/fieldStrip.js';
import { RUNWAY } from '../src/sim/terrain.js';
import { clubToWorld, pilotSpot } from '../src/sim/location.js';
import { existsSync } from 'node:fs';
import { getAircraft } from '../src/aircraft/index.js';

const policyFile = (id) => JSON.parse(readFileSync(new URL(`../src/ml/policies/${id}.json`, import.meta.url), 'utf8'));
const skillFiles = (id) => Object.fromEntries([['fly', id], ...skillsOf(id).map((s) => [s, `${id}.${s}`])].map(([k, f]) => [k, policyFile(f)]));

describe('AI flyers', () => {
  it('has a policy for at least one aircraft', () => {
    expect(AI_AIRCRAFT.length).toBeGreaterThan(0);
    for (const id of AI_AIRCRAFT) expect(getAircraft(id).id).toBe(id);
  });

  it('shares out aircraft between flyers', () => {
    const one = AI_AIRCRAFT[0];
    expect(AiFlyers.choose(3, one, 'x')).toEqual([one, one, one]);
    expect(AiFlyers.choose(2, 'same', one)).toEqual([one, one]);
    expect(AiFlyers.choose(AI_AIRCRAFT.length, 'mix', 'x')).toEqual(AI_AIRCRAFT);
    expect(AiFlyers.choose(0, 'mix', 'x')).toEqual([]);
  });

  const obstacles = new Obstacles();
  const wind = new Wind();
  wind.setTrees(obstacles.trees);
  for (const id of AI_AIRCRAFT) {
    it(`${id}: flies round the field for two minutes in the real wind without crashing`, () => {
      const pilot = new AiPilot(getAircraft(id).def, policyFile(id), { ground, wind, obstacles }, { x: 0, z: 0, radius: 150 }, makeRng(3));
      let maxR = 0;
      let minAgl = Infinity;
      const dt = 1 / 60;
      for (let t = 0; t < 120; t += dt) {
        wind.update(dt);
        pilot.update(dt);
        const p = pilot.ac.position;
        maxR = Math.max(maxR, Math.hypot(p.x, p.z));
        minAgl = Math.min(minAgl, p.y - ground.heightAt(p.x, p.z));
      }
      expect(pilot.crashes + (pilot.ac.crashed ? 1 : 0)).toBe(0);
      expect(minAgl).toBeGreaterThan(15);
      expect(maxR).toBeLessThan(400); // stays round the field
    }, 60000);
  }

  // A full day for every model with all its skills: taxi out, take off,
  // circuits (and aerobatics), land, taxi back, and again.
  for (const id of AI_AIRCRAFT) {
    const def = getAircraft(id).def;
    const full = ['takeoff', 'land'].every((s) => skillsOf(id).includes(s));
    it.runIf(full)(`${id}: flies a day of circuits at the club field: takes off and lands without crashing`, () => {
      const [x, z] = clubToWorld(RUNWAY.x, RUNWAY.z);
      const [px, pz] = pilotSpot();
      const strip = chooseStrip({ windFromDeg: 270, windSpeed: 3, ground, obstacles, pilot: { x: px, z: pz } });
      const field = { x, z, radius: 150, strip, pilot: { x: px, z: pz }, runway: { owner: null } };
      const pilot = new AiPilot(def, skillFiles(id), { ground, wind, obstacles }, field, makeRng(11), { id: 'ai1', slot: 0 });
      expect(pilot.circuits).toBe(true);
      const dt = 1 / 60;
      for (let t = 0; t < 600; t += dt) {
        wind.update(dt);
        pilot.update(dt);
      }
      expect(pilot.crashes + (pilot.ac.crashed ? 1 : 0)).toBe(0);
      expect(pilot.flights).toBeGreaterThan(0);
      expect(pilot.landings).toBeGreaterThan(0);
    }, 120000);
  }
});

describe('aerobatic manoeuvres', () => {
  it('only offers rolls to models that can roll', () => {
    const easystar = getAircraft('multiplex-easystar').def;
    expect(maneuversFor(easystar)).toEqual(Object.keys(MANEUVERS).filter((k) => !MANEUVERS[k].needsRoll));
    expect(maneuversFor(getAircraft('hobbyzone-aeroscout').def)).toContain('roll');
  });

  it('steps through a manoeuvre as the aeroplane turns', () => {
    const r = new ManeuverRunner("immelmann", { roll: 6, pitch: 3, yaw: 2.5 });
    const ac = { airspeed: 15, omega: { x: 0, y: 0, z: 1.5 } };
    let t = 0;
    while (r.update(ac, 0.02) && r.i === 0) t += 0.02;
    expect(t).toBeCloseTo(Math.PI / 1.5, 1); // half a loop at 1.5 rad/s
    expect(r.rates.roll).toBeGreaterThan(0);
    ac.omega = { x: 3.5, y: 0, z: 0 };
    while (r.update(ac, 0.02));
    expect(r.done).toBe(true);
  });
});

describe('where AI flyers take off and land', () => {
  const obstacles = new Obstacles();
  const [px, pz] = pilotSpot();
  const pilot = { x: px, z: pz };
  for (const from of [0, 45, 90, 135, 180, 225, 270, 315]) {
    it(`goes into a ${from}° wind`, () => {
      const w = windVector(from);
      for (const speed of [2, 7]) {
        const s = chooseStrip({ windFromDeg: from, windSpeed: speed, ground, obstacles, pilot });
        const headwind = -(s.dir.x * w.x + s.dir.z * w.z); // cos of the angle off the wind
        expect(headwind).toBeGreaterThanOrEqual(0); // never downwind
        // More than a light wind: within 30° of it, unless nowhere is clear.
        if (speed > 3 && s.kind === 'into wind') expect(headwind).toBeGreaterThan(Math.cos((31 * Math.PI) / 180));
        if (speed <= 3) expect(s.kind).toBe('runway');
      }
    });
  }
});
