// Barrack Field: trees on three sides, so in a stronger wind the AI flyers
// land on a strip near you with a steeper approach over them (never a take-off
// only strip with nowhere to land).
import { describe, it, expect, beforeAll } from 'vitest';
import { setLocation, pilotSpot } from '../src/sim/location.js';
import data from '../src/locations/waterbeach.json';

let ground;
let obstacles;
let chooseStrip;
let stripClear;
let windVector;
beforeAll(async () => {
  setLocation('waterbeach', data);
  ({ physicsGround: ground } = await import('../src/sim/terrain.js'));
  const { Obstacles } = await import('../src/sim/obstacles.js');
  obstacles = new Obstacles();
  ({ chooseStrip, stripClear, windVector } = await import('../src/ml/fieldStrip.js'));
});

const deg = Math.PI / 180;

describe('Barrack Field strips', () => {
  for (const from of [0, 90, 180, 270]) {
    it(`lands into a 5 m/s wind from ${from}°, near you, over the trees`, () => {
      const [px, pz] = pilotSpot();
      const s = chooseStrip({ windFromDeg: from, windSpeed: 5, ground, obstacles, pilot: { x: px, z: pz } });
      expect(s.landing).not.toBe(false);
      const w = windVector(from);
      expect(-(s.dir.x * w.x + s.dir.z * w.z)).toBeGreaterThan(Math.cos(31 * deg));
      expect(Math.hypot(s.x - px, s.z - pz)).toBeLessThanOrEqual(50);
      const glide = s.glide ?? 7 * deg;
      expect(glide).toBeLessThanOrEqual(13.01 * deg);
      // Clear at its own angle; if steeper than 7°, because 7° isn't.
      expect(stripClear(s, ground, obstacles)).toBe(true);
      if (s.glide) {
        const flat = Object.assign(Object.create(Object.getPrototypeOf(s)), s);
        delete flat.glide;
        expect(stripClear(flat, ground, obstacles)).toBe(false);
      }
    });
  }

  it('flies steeper approaches in an east or west wind', () => {
    const [px, pz] = pilotSpot();
    for (const from of [90 + 180, 315]) {
      const s = chooseStrip({ windFromDeg: from, windSpeed: 5, ground, obstacles, pilot: { x: px, z: pz } });
      expect(s.glide).toBeGreaterThan(7 * deg);
    }
  });
});
