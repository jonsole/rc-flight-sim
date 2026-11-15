// Scenery edits (src/sim/edits.js) change what the aircraft hits: deleted
// trees are gone, resized ones are as big as drawn, and added trees and
// fences are solid; buildings move and change height.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setLocation } from '../src/sim/location.js';
import { EDITS, replaceEdits, emptyEdits, editCount } from '../src/sim/edits.js';
import data from '../src/locations/waterbeach.json';

let Obstacles;
beforeAll(async () => {
  setLocation('waterbeach', data);
  ({ Obstacles } = await import('../src/sim/obstacles.js'));
});
beforeEach(() => replaceEdits(emptyEdits()));

const hitsAt = (ob, x, y, z, name) => ob.near(x, z, 1).filter((s) => (!name || s.name === name) && Obstacles.test(s, x, y, z));

describe('scenery edits', () => {
  it('deletes, resizes and keeps the other trees as they were', () => {
    const before = new Obstacles();
    const [a, b] = before.trees;
    EDITS.trees.removed.push(a.id);
    EDITS.trees.changed[b.id] = { h: b.h * 2 };
    const ob = new Obstacles();
    expect(ob.trees.length).toBe(before.trees.length - 1);
    expect(ob.trees.find((t) => t.id === a.id)).toBeUndefined();
    const b2 = ob.trees.find((t) => t.id === b.id);
    expect(b2.h).toBeCloseTo(b.h * 2);
    expect(b2.variant).toBe(b.variant); // same crown shape
    // Its trunk now reaches up to the taller crown.
    expect(hitsAt(ob, b.x, b2.y + b2.h * 0.3, b.z, 'a tree trunk').length).toBe(1);
    expect(editCount()).toBe(2);
  });

  it('plants a solid tree and a solid fence', () => {
    EDITS.trees.added.push({ x: 30, z: -40, h: 12, r: 4, conifer: false });
    EDITS.fences.added.push({ path: [[-30, -60], [-10, -60]], height: 2, kind: 'panels' });
    const ob = new Obstacles();
    const t = ob.trees.find((tr) => tr.id === 'new:0');
    expect(t).toBeTruthy();
    expect(hitsAt(ob, 30, t.y + 2, -40, 'a tree trunk').length).toBe(1);
    expect(hitsAt(ob, -20, 1, -60, 'the temporary fence').length).toBe(1);
    expect(hitsAt(ob, -20, 2.5, -60, 'the temporary fence').length).toBe(0);
  });

  it('moves a building and changes its height', () => {
    const before = new Obstacles();
    const b = before.buildings[0];
    EDITS.buildings.changed[b.index] = { dx: 50, dz: 0, h: 20 };
    const ob = new Obstacles();
    const b2 = ob.buildings.find((x) => x.index === b.index);
    expect(b2.x0).toBeCloseTo(b.x0 + 50, 0);
    expect(b2.ridge - (b2.y0 + 0.3)).toBeCloseTo(20, 0);
    EDITS.buildings.removed.push(b.index);
    expect(new Obstacles().buildings.find((x) => x.index === b.index)).toBeUndefined();
  });
});
