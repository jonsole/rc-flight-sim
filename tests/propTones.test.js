import { describe, it, expect } from 'vitest';
import { propOrders, ORDERS } from '../src/audio/propTones.js';

describe('prop tones', () => {
  it('is strongest at the blade-pass rate', () => {
    for (const blades of [2, 3, 5]) {
      const o = propOrders({ blades });
      expect(o).toHaveLength(ORDERS);
      expect(o[blades - 1]).toBe(1);
      expect(Math.max(...o)).toBe(1);
    }
  });
  it('has its strong tones at multiples of the blade count', () => {
    const o = propOrders({ blades: 3 });
    expect(o[5]).toBeGreaterThan(5 * o[4]); // 6th vs 5th
    expect(o[8]).toBeGreaterThan(5 * o[7]);
  });
  it('square tips and pushers are brighter (harmonics fade slower)', () => {
    const h = (p) => propOrders(p)[7]; // the 4th blade-pass harmonic of a two-blade prop
    expect(h({ tip: 'square' })).toBeGreaterThan(h({ tip: 'tapered' }));
    expect(h({ pusher: true })).toBeGreaterThan(h({}));
    expect(h({ tip: 'square', pusher: true })).toBeGreaterThan(h({ tip: 'square' }));
  });
  it('a pusher rasps: more between the blade-pass tones', () => {
    expect(propOrders({ pusher: true })[2]).toBeGreaterThan(propOrders({})[2]);
  });
});
