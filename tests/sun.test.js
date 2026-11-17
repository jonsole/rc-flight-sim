import { describe, it, expect } from 'vitest';
import { sunPosition, solarHours, isBST } from '../src/world/sun.js';

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

const elev = (clock, day) => sunPosition(solarHours(clock, day), day).elevation;

describe('sun by UK clock time', () => {
  it('knows British Summer Time (last Sunday of March to last Sunday of October)', () => {
    expect(isBST(15, 2026)).toBe(false); // January
    expect(isBST(180, 2026)).toBe(true); // late June
    expect(isBST(87, 2026)).toBe(false); // Sat 28 March 2026
    expect(isBST(88, 2026)).toBe(true); // Sun 29 March 2026
    expect(isBST(297, 2026)).toBe(true); // Sat 24 October 2026
    expect(isBST(298, 2026)).toBe(false); // Sun 25 October 2026
  });
  it('sets in late June at about 21:20 BST', () => {
    expect(elev(21.0, 180)).toBeGreaterThan(0);
    expect(elev(21.5, 180)).toBeLessThan(0);
  });
  it('sets in December at about 15:50 GMT', () => {
    expect(elev(15.5, 355)).toBeGreaterThan(0);
    expect(elev(16.1, 355)).toBeLessThan(0);
  });
  it('is due south about 13:00 in summer, 12:00 in winter', () => {
    expect(Math.abs(sunPosition(solarHours(13.05, 180), 180).azimuth - 180)).toBeLessThan(3);
    expect(Math.abs(sunPosition(solarHours(11.95, 355), 355).azimuth - 180)).toBeLessThan(3);
  });
});
