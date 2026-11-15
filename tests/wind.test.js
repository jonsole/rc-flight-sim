import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Wind } from '../src/sim/wind.js';
import { heightAt } from '../src/sim/terrain.js';

// A straight belt of 15 m trees running north-south at x = 0, wind from the
// west (blowing towards +x).
function setup() {
  const w = new Wind();
  w.speed = 8;
  w.directionDeg = 270;
  w.turbulence = 0.3;
  const trees = [];
  for (let z = -200; z <= 200; z += 6) trees.push({ x: 0, z, h: 15, crownW: 4 });
  w.setTrees(trees);
  return w;
}
const at = (w, x, agl, z = 0) => w.treeEffect(x, z, agl, {});
const air = (w, x, agl, z = 0) => w.at(new Vector3(x, heightAt(x, z) + agl, z), 0, new Vector3(), agl);

describe('wind round trees', () => {
  it('blows towards +x for a westerly', () => {
    const w = setup();
    expect(air(w, -400, 10, 300).x).toBeGreaterThan(5);
  });

  it('rises up over the trees on the upwind side', () => {
    const w = setup();
    expect(at(w, -12, 12).lift).toBeGreaterThan(0.1);
    expect(at(w, -150, 12).lift).toBeLessThan(0.01); // well upwind: nothing
  });

  it('is sheltered, with a downdraft, just behind the trees', () => {
    const w = setup();
    const e = at(w, 30, 5);
    expect(e.slow).toBeGreaterThan(0.4);
    expect(e.lift).toBeLessThan(-0.08);
  });

  it('is most turbulent a few tree-heights behind, dying away downwind', () => {
    const w = setup();
    const near = at(w, 10, 6).eddy;
    const peak = at(w, 60, 6).eddy;
    const far = at(w, 300, 6).eddy;
    expect(peak).toBeGreaterThan(near);
    expect(peak).toBeGreaterThan(0.25);
    expect(far).toBeLessThan(peak * 0.25);
    // ...and only low down: well above the trees the air is clean.
    expect(at(w, 60, 60).eddy).toBeLessThan(0.02);
  });

  it('eddies vary from place to place (one wing can be in a gust)', () => {
    const w = setup();
    const a = air(w, 60, 6, 0);
    const b = air(w, 60, 6, 6);
    expect(a.distanceTo(b)).toBeGreaterThan(0.3);
  });

  it('turns with the wind direction', () => {
    const w = setup();
    w.directionDeg = 90; // from the east: now x > 0 is upwind
    expect(at(w, 60, 6).eddy).toBeLessThan(0.02);
    expect(at(w, -60, 6).eddy).toBeGreaterThan(0.25);
  });
});
