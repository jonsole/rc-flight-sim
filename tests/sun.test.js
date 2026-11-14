import { describe, it, expect } from 'vitest';
import { sunPosition } from '../src/world/sun.js';

describe('sun position (52° N)', () => {
  it('is high in the south at midsummer noon', () => {
    const s = sunPosition(12, 172);
    expect(s.elevation).toBeCloseTo(90 - 52 + 23.44, 0); // ~61.4°
    expect(s.azimuth).toBeCloseTo(180, 0);
  });
  it('is low at midwinter noon', () => {
    expect(sunPosition(12, 355).elevation).toBeCloseTo(90 - 52 - 23.44, 0); // ~14.6°
  });
  it('rises in the east and sets in the west', () => {
    expect(sunPosition(9, 80).azimuth).toBeGreaterThan(90);
    expect(sunPosition(9, 80).azimuth).toBeLessThan(180);
    expect(sunPosition(17, 80).azimuth).toBeGreaterThan(180);
  });
  it('is below the horizon at midnight', () => {
    expect(sunPosition(0, 172).elevation).toBeLessThan(0);
    expect(sunPosition(0, 355).elevation).toBeLessThan(-50);
  });
  it('is near the horizon around 6 am at the equinox', () => {
    expect(Math.abs(sunPosition(6, 80).elevation)).toBeLessThan(3);
  });
});
