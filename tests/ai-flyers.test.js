import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { physicsGround as ground } from '../src/sim/terrain.js';
import { Obstacles } from '../src/sim/obstacles.js';
import { Wind } from '../src/sim/wind.js';
import { makeRng } from '../ml/env.js';
import { AiPilot } from '../src/ml/aiPilot.js';
import { AiFlyers, AI_AIRCRAFT } from '../src/ml/aiFlyers.js';
import { getAircraft } from '../src/aircraft/index.js';

const policyFile = (id) => JSON.parse(readFileSync(new URL(`../src/ml/policies/${id}.json`, import.meta.url), 'utf8'));

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
});
