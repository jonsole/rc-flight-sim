// Hotel Glocknerhof (Berg im Drautal, Austria): the baked site loads with
// the mountains round the valley, the runway is clear and mown, and the
// pyramid tent and the safety net are solid.
import { describe, it, expect, beforeAll } from 'vitest';
import { setLocation, inField, clubToWorld } from '../src/sim/location.js';
import data from '../src/locations/glocknerhof.json';

let terrain;
let Obstacles;
beforeAll(async () => {
  setLocation('glocknerhof', data);
  terrain = await import('../src/sim/terrain.js');
  ({ Obstacles } = await import('../src/sim/obstacles.js'));
});

describe('Hotel Glocknerhof', () => {
  it('has a level field in a valley with real mountains round it', () => {
    expect(terrain.heightAt(0, 0)).toBeCloseTo(0, 3);
    expect(inField(0, 0)).toBe(true);
    // The terrain covers the mountains (14 km), not the usual 7 km.
    expect(terrain.TERRAIN_SIZE).toBeGreaterThan(13000);
    // The hotel sits on the hillside about 600 m north-west, ~60 m up...
    const hotel = terrain.heightAt(-560, -620);
    expect(hotel).toBeGreaterThan(30);
    expect(hotel).toBeLessThan(120);
    // ...and the peaks 4-6 km away stand well over 1000 m above the valley.
    let peak = 0;
    for (let x = -6000; x <= 6000; x += 250) {
      for (const z of [-5500, -4500, 4500, 5500]) peak = Math.max(peak, terrain.heightAt(x, z));
    }
    expect(peak).toBeGreaterThan(1000);
  });

  it('has a clear 200 m mown runway in front of the pilot', () => {
    const r = terrain.RUNWAY;
    expect(r.length).toBe(200);
    const ob = new Obstacles();
    for (let t = -0.49; t <= 0.49; t += 0.07) {
      const [x, z] = clubToWorld(r.x + t * r.length, r.z);
      expect(terrain.surfaceAt(x, z).name).toBe('mown runway');
      expect(Math.abs(terrain.heightAt(x, z))).toBeLessThan(0.05);
      // Nothing to hit across it, from the grass to 10 m up.
      for (let w = -0.5; w <= 0.5; w += 0.1) {
        const [px, pz] = clubToWorld(r.x + t * r.length, r.z + w * r.width);
        for (const y of [0.3, 2, 5, 10]) {
          expect(ob.near(px, pz, 1).filter((s) => Obstacles.test(s, px, y, pz))).toHaveLength(0);
        }
      }
    }
  });

  it('has the pyramid tent instead of a tree there, and the safety net, both solid', () => {
    const ob = new Obstacles();
    expect(ob.trees.length).toBeGreaterThan(1000);
    expect(ob.trees.filter((t) => Math.hypot(t.x + 4, t.z - 30) < 8)).toHaveLength(0);
    // Solid (a depth and a normal to push out along), not soft like foliage.
    const hit = (x, y, z, name) => ob.near(x, z, 1).filter((s) => s.name === name).map((s) => Obstacles.test(s, x, y, z)).find((h) => h);
    for (const y of [1, 3, 6]) expect(hit(-4 + 1, y, 30, 'the tent')?.depth).toBeGreaterThan(0);
    expect(hit(-4, 8, 30, 'the tent')).toBeUndefined(); // over the top
    // The net, 2.5 m west of the pilot, 2 m up.
    expect(hit(-2.49, 2, 0, 'the safety net')?.depth).toBeGreaterThan(0);
  });
});
