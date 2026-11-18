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

describe('tracks in the snow', async () => {
  const { SnowTracks } = await import('../src/world/snowTracks.js');
  const { Vector3, Quaternion } = await import('three');
  const plane = () => ({
    position: new Vector3(0, 0.1, 0),
    orientation: new Quaternion(),
    mass: 1,
    held: null,
    contacts: [
      { type: 'wheel', pos: new Vector3(0, -0.1, 0.1), onGround: true, load: 4 },
      { type: 'prop', pos: new Vector3(0.2, -0.1, 0), onGround: true, load: 1 },
    ],
  });
  const roll = (tracks, a, snow, metres) => {
    for (let i = 0; i < metres * 10; i++) {
      a.position.x += 0.1;
      tracks.update(a, 1 / 60, snow);
    }
  };

  it('a wheel rolling over lying snow leaves a track (a prop strike does not)', () => {
    const t = new SnowTracks();
    roll(t, plane(), { cover: 1, falling: 0 }, 3);
    expect(t.used).toBeGreaterThan(20); // ~every 6 cm over 3 m, wheel only
    expect(t.used).toBeLessThan(60);
    expect(t.mesh.visible).toBe(true);
  });

  it('none without snow, or in the air, or carried', () => {
    const t = new SnowTracks();
    roll(t, plane(), { cover: 0, falling: 0 }, 3);
    expect(t.used).toBe(0);
    const a = plane();
    a.contacts[0].onGround = false;
    roll(t, a, { cover: 1, falling: 0 }, 3);
    expect(t.used).toBe(0);
    const b = plane();
    b.held = {};
    roll(t, b, { cover: 1, falling: 0 }, 3);
    expect(t.used).toBe(0);
  });

  it('the snow going clears them', () => {
    const t = new SnowTracks();
    const a = plane();
    roll(t, a, { cover: 1, falling: 0 }, 2);
    expect(t.used).toBeGreaterThan(0);
    t.update(a, 1 / 60, { cover: 0, falling: 0 });
    expect(t.used).toBe(0);
  });
});
