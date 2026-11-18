// The club field's lake (src/sim/lake.js).
import { describe, it, expect } from 'vitest';
import { LAKE, lakeQ, lakeCarve, inLake, LAKE_GLSL } from '../src/sim/lake.js';
import { heightAt } from '../src/sim/terrain.js';
import { Obstacles } from '../src/sim/obstacles.js';
import { RUNWAY } from '../src/sim/terrain.js';

describe('lake', () => {
  it('is carved into the field: deepest in the middle, the water at its level, banks up to the field', () => {
    expect(LAKE).toBeTruthy();
    const mid = heightAt(LAKE.x, LAKE.z);
    expect(mid).toBeCloseTo(LAKE.level - LAKE.depth, 1);
    expect(inLake(LAKE.x, LAKE.z)).toBe(true);
    // Walking out east: down under the water, up the bank, the field.
    let x = LAKE.x;
    while (lakeQ(x, LAKE.z) < 1) x += 0.5;
    expect(heightAt(x, LAKE.z)).toBeLessThan(LAKE.level + 0.01);
    while (lakeQ(x, LAKE.z) < 1.35) x += 0.5;
    expect(heightAt(x, LAKE.z)).toBeCloseTo(0, 3);
    expect(lakeCarve(x, LAKE.z)).toBe(0);
  });

  it('is clear of the runway, and has no trees or bushes in it or on its banks', () => {
    for (let x = RUNWAY.x - RUNWAY.length / 2; x <= RUNWAY.x + RUNWAY.length / 2; x += 5) {
      expect(lakeCarve(x, RUNWAY.z)).toBe(0);
    }
    const ob = new Obstacles();
    expect(ob.trees.filter((t) => lakeQ(t.x, t.z) < 1.4).length).toBe(0);
    expect(ob.bushes.filter((b) => lakeQ(b.x, b.z) < 1.3).length).toBe(0);
  });

  it('has the same shape in the shaders', () => {
    expect(LAKE_GLSL).toContain('float lakeQ(vec2 p)');
    expect(LAKE_GLSL).toContain(`#define LAKE_LEVEL ${LAKE.level}`);
  });
});
