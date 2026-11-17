import { describe, it, expect } from 'vitest';
import { snowFor, snowVisibility } from '../src/world/snow.js';
import { surfaceAt, setSnowCover } from '../src/sim/terrain.js';

const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('snow', () => {
  it('seasonal: some winter days have snow, summer never does', () => {
    const winter = [...days(1, 59), ...days(345, 365)].map((d) => snowFor({ snow: 'seasonal' }, d, 12));
    const snowy = winter.filter((s) => s.cover > 0).length;
    expect(snowy).toBeGreaterThan(2);
    expect(snowy).toBeLessThan(winter.length / 3);
    for (const d of days(91, 300)) expect(snowFor({ snow: 'seasonal' }, d, 12)).toEqual({ cover: 0, falling: 0 });
  });

  it('as set', () => {
    expect(snowFor({ snow: 'off' }, 20, 12)).toEqual({ cover: 0, falling: 0 });
    expect(snowFor({ snow: 'heavy' }, 172, 12)).toEqual({ cover: 1, falling: 1 });
    expect(snowFor({ snow: 'lying' }, 172, 12).falling).toBe(0);
  });

  it('heavy snow is harder to see through than light', () => {
    expect(snowVisibility(0)).toBe(Infinity);
    expect(snowVisibility(1)).toBeLessThan(snowVisibility(0.35));
    expect(snowVisibility(1)).toBeLessThan(500);
  });

  it('lying snow slows the wheels and lets a belly slide further', () => {
    const bare = surfaceAt(0, 0);
    setSnowCover(1);
    const snowy = surfaceAt(0, 0);
    setSnowCover(0);
    expect(snowy.roll).toBeGreaterThan(bare.roll);
    expect(snowy.drag).toBeLessThan(bare.drag);
    expect(surfaceAt(0, 0)).toBe(bare);
  });
});
