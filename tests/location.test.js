// A real flying site (Waterbeach): baked terrain, trees and buildings load,
// the field is level, and buildings are solid. The site has to be chosen
// before the world modules load, so they are imported after setLocation.
import { describe, it, expect, beforeAll } from 'vitest';
import { setLocation, inField, worldToClub, clubToWorld } from '../src/sim/location.js';
import data from '../src/locations/waterbeach.json';

let terrain;
let Obstacles;
beforeAll(async () => {
  setLocation('waterbeach', data);
  terrain = await import('../src/sim/terrain.js');
  ({ Obstacles } = await import('../src/sim/obstacles.js'));
});

describe('Waterbeach', () => {
  it('has a level field at the pilot and real ground beyond', () => {
    expect(terrain.heightAt(0, 0)).toBeCloseTo(0, 3);
    expect(terrain.heightAt(40, -100)).toBeCloseTo(0, 3);
    expect(inField(0, -22)).toBe(true);
    // Fenland: within a few metres of the field everywhere near by.
    for (const [x, z] of [[500, 300], [-700, -600], [900, 900], [3000, -2000]]) {
      expect(Math.abs(terrain.heightAt(x, z))).toBeLessThan(12);
    }
  });

  it('uses the cricket pitch as the runway, turned to its real heading', () => {
    const r = terrain.RUNWAY;
    // The pitch's ends as surveyed (52.277766,0.192194 and 52.277709,0.192599).
    const ends = [[-27.7 + 18.1, -77.1 + 52.7], [0.1 + 18.1, -71.6 + 52.7]];
    for (const [x, z] of ends) {
      expect(inField(x, z)).toBe(true);
      const [cx, cz] = worldToClub(x, z);
      expect(Math.abs(Math.abs(cx - r.x) - r.length / 2)).toBeLessThan(0.5);
      expect(Math.abs(cz - r.z)).toBeLessThan(0.5);
    }
    const [mx, mz] = clubToWorld(r.x, r.z);
    expect(terrain.surfaceAt(mx, mz).name).toBe('cricket pitch');
    // 3 m off the pitch's side: grass.
    const [gx, gz] = clubToWorld(r.x, r.z - 3);
    expect(terrain.surfaceAt(gx, gz).name).toBe('field grass');
  });

  it('has short grass on the mown oval and rectangle, long grass elsewhere on the field', () => {
    expect(terrain.surfaceAt(0, -8).name).toBe('field grass'); // in front of the pilot, in the oval
    expect(terrain.surfaceAt(40, 50).name).toBe('field grass'); // the rectangle
    expect(terrain.surfaceAt(-45, -100).name).toBe('rough grass');
    expect(terrain.surfaceAt(80, 0).name).toBe('rough grass');
  });

  it('loads the LIDAR trees and keeps them off the runway', () => {
    const ob = new Obstacles();
    expect(ob.trees.length).toBeGreaterThan(1000);
    const r = terrain.RUNWAY;
    const onRunway = ob.trees.filter((t) => {
      const [cx, cz] = worldToClub(t.x, t.z);
      return Math.abs(cx - r.x) < r.length / 2 + 5 && Math.abs(cz - r.z) < r.width / 2 + 5;
    });
    expect(onRunway).toHaveLength(0);
  });

  it('has only broadleaf trees, a grown east belt and a solid chain-link fence behind it', () => {
    const ob = new Obstacles();
    expect(ob.trees.filter((t) => t.conifer)).toHaveLength(0);
    const belt = ob.trees.filter((t) => t.x > 88 && t.x < 118 && t.z > -100 && t.z < 150);
    expect(belt.length).toBeGreaterThan(30);
    expect(Math.min(...belt.map((t) => t.h))).toBeGreaterThanOrEqual(10);
    // Fence from (121.1, -167.3) to (100.1, 162.7): solid below 3 m, clear above.
    const fence = ob.shapes.find((s) => s.name === 'the chain-link fence');
    const x = (121.1 + 100.1) / 2;
    const z = (-167.3 + 162.7) / 2;
    expect(Obstacles.test(fence, x, 1.5, z)).not.toBeNull();
    expect(Obstacles.test(fence, x, 3.5, z)).toBeNull();
  });

  it('makes buildings solid, with the roof as their top', () => {
    const ob = new Obstacles();
    expect(ob.buildings.length).toBeGreaterThan(500);
    const shape = ob.shapes.find((s) => s.type === 'building' && s.b.gable);
    const b = shape.b;
    const { cx, cz } = b.gable;
    const inside = Obstacles.test(shape, cx, (b.y0 + b.eave) / 2, cz);
    expect(inside).not.toBeNull();
    expect(inside.depth).toBeGreaterThan(0);
    expect(Obstacles.test(shape, cx, b.ridge + 0.5, cz)).toBeNull();
    // Found through the spatial hash too.
    expect(ob.near(cx, cz, 1)).toContain(shape);
  });
});
