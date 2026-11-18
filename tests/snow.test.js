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

  it('a belly leaves a track as wide as the fuselage; a hard touchdown a dent', () => {
    const t = new SnowTracks();
    const a = plane();
    a.contacts = [{ type: 'skid', trackWidth: 0.07, pos: new Vector3(0, -0.1, 0), onGround: true, load: 40 }];
    roll(t, a, { cover: 1, falling: 0 }, 1);
    // First piece: the dent (touching down at 4x the weight), then the groove.
    const P = t.pos.array;
    const width = Math.hypot(P[12 + 0] - P[12 + 3], P[12 + 2] - P[12 + 5]);
    expect(width).toBeCloseTo(0.07, 3);
    const T = t.track.array;
    expect(T[1]).toBe(-1); // the dent's 'along' (a track's is 0)
    expect(T[16 + 1]).toBe(0);
  });

  it('wreckage leaves grooves where it slides, and dents where it lands', () => {
    const t = new SnowTracks();
    const piece = { touch: null, thud: { x: 1, z: 1 }, markHalf: 0.05 };
    const snow = { cover: 1, falling: 0 };
    t.update(null, 1 / 60, snow, [piece]);
    expect(t.used).toBe(1);
    expect(piece.thud).toBe(null);
    for (let i = 0; i < 20; i++) {
      piece.touch = { x: 1 + i * 0.1, z: 1 };
      t.update(null, 1 / 60, snow, [piece]);
    }
    expect(t.used).toBeGreaterThan(15);
  });

  it('a wing dipping into the snow marks it, though no contact touches', async () => {
    const { Group, Mesh, BoxGeometry, MeshBasicMaterial } = await import('three');
    const t = new SnowTracks();
    const root = new Group();
    const wing = new Mesh(new BoxGeometry(0.2, 0.01, 1.2), new MeshBasicMaterial());
    wing.position.set(0, 0.03, 0); // its underside 2.5 cm up: in 4 cm of snow
    root.add(wing);
    t.setModel({ root, parts: {} });
    expect(t.samples.length).toBeGreaterThan(0);
    const a = plane();
    a.position.set(0, 0, 0);
    a.contacts = [];
    roll(t, a, { cover: 1, falling: 0 }, 1);
    expect(t.used).toBeGreaterThan(5);
    // Higher up, clear of the snow: nothing.
    const t2 = new SnowTracks();
    t2.setModel({ root, parts: {} });
    const b = plane();
    b.position.set(0, 0.2, 0);
    b.contacts = [];
    roll(t2, b, { cover: 1, falling: 0 }, 1);
    expect(t2.used).toBe(0);
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
