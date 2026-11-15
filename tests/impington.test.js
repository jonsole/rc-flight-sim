// Impington Village College: the baked site loads, you start in the middle
// of its (L-shaped) playing field on grass, and take off from the grass.
import { describe, it, expect, beforeAll } from 'vitest';
import { setLocation, inField } from '../src/sim/location.js';
import data from '../src/locations/impington.json';

let terrain;
let Obstacles;
beforeAll(async () => {
  setLocation('impington', data);
  terrain = await import('../src/sim/terrain.js');
  ({ Obstacles } = await import('../src/sim/obstacles.js'));
});

describe('Impington Village College', () => {
  it('starts you on the playing field, on grass, at ground level', () => {
    expect(inField(0, 0)).toBe(true);
    expect(inField(0, -22)).toBe(true); // where take-offs start
    expect(terrain.surfaceAt(0, -22).name).toBe('field grass');
    expect(Math.abs(terrain.heightAt(0, 0))).toBeLessThan(0.3);
    // The college buildings to the north-west are off the field.
    expect(inField(-60, -200)).toBe(false);
    expect(terrain.surfaceAt(300, 300).name).toBe('rough grass');
  });

  it('has no trees or buildings in the middle of the field', () => {
    const ob = new Obstacles();
    expect(ob.trees.length).toBeGreaterThan(1000);
    expect(ob.near(0, -22, 30)).toHaveLength(0);
    expect(ob.trees.filter((t) => t.conifer)).toHaveLength(0);
  });
});
