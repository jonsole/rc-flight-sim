// A real flying site (Waterbeach): baked terrain, trees and buildings load,
// the field is level, and buildings are solid. The site has to be chosen
// before the world modules load, so they are imported after setLocation.
import { describe, it, expect, beforeAll } from 'vitest';
import { setLocation, inField } from '../src/sim/location.js';
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

  it('puts the runway on the mown field', () => {
    const r = terrain.RUNWAY;
    expect(inField(r.x - r.length / 2, r.z)).toBe(true);
    expect(inField(r.x + r.length / 2, r.z)).toBe(true);
    expect(terrain.surfaceAt(0, -22).name).toBe('mown runway');
  });

  it('loads the LIDAR trees and keeps them off the runway', () => {
    const ob = new Obstacles();
    expect(ob.trees.length).toBeGreaterThan(1000);
    const r = terrain.RUNWAY;
    const onRunway = ob.trees.filter((t) => Math.abs(t.x - r.x) < r.length / 2 && Math.abs(t.z - r.z) < r.width / 2);
    expect(onRunway).toHaveLength(0);
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
