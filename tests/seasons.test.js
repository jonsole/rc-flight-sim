// The time of year's effect on the plants (src/world/seasons.js).
import { describe, it, expect } from 'vitest';
import { seasonFor, formatDay } from '../src/world/seasons.js';

describe('seasons', () => {
  it('bare in winter, in leaf in summer, autumn colours in October', () => {
    expect(seasonFor(15).bare).toBeGreaterThan(0.99); // January
    const july = seasonFor(196);
    expect(july.bare).toBeLessThan(0.01);
    expect(july.autumn).toBeLessThan(0.01);
    const oct = seasonFor(288); // mid October
    expect(oct.autumn).toBeGreaterThan(0.6);
    expect(oct.bare).toBeLessThan(0.3);
    expect(seasonFor(325).bare).toBeGreaterThan(0.7); // late November
    expect(seasonFor(115).fresh).toBeGreaterThan(0.5); // late April: new leaves
  });

  it('names the date', () => {
    expect(formatDay(1)).toBe('1 Jan');
    expect(formatDay(172)).toBe('21 Jun');
    expect(formatDay(365)).toBe('31 Dec');
  });
});
