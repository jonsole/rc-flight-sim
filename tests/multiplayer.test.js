import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { SnapshotBuffer, DELAY } from '../src/net/snapshots.js';
import { encodeState } from '../src/net/multiplayer.js';
import { Aircraft } from '../src/sim/aircraft.js';
import { getAircraft } from '../src/aircraft/index.js';
import { ground } from '../src/sim/terrain.js';

const state = (x, v = 10) => ({ p: [x, 5, 0], q: [0, 0, 0, 1], v: [v, 0, 0] });
const out = () => ({ p: new Vector3(), q: new Quaternion(), state: null });

describe('multiplayer smoothing', () => {
  it('interpolates between states, drawn slightly in the past', () => {
    const b = new SnapshotBuffer();
    // Sender clock is 100 s behind ours; 50 ms network delay.
    for (let i = 0; i <= 10; i++) b.push(i / 15, 100 + i / 15 + 0.05, state(i / 15 * 10));
    const o = out();
    const now = 100 + 0.5 + 0.05 + DELAY; // shows the sender's t = 0.5 s
    expect(b.sample(now, o)).toBe(true);
    expect(o.p.x).toBeCloseTo(5, 3);
  });

  it('copes with jitter: a late packet does not move the clock', () => {
    const b = new SnapshotBuffer();
    b.push(0, 10.05, state(0));
    b.push(1 / 15, 10.05 + 1 / 15 + 0.2, state(10 / 15)); // 200 ms late
    expect(b.offset).toBeLessThan(10.06); // only creeps up slowly
  });

  it('extrapolates briefly along the velocity when states stop', () => {
    const b = new SnapshotBuffer();
    b.push(0, 10, state(0));
    b.push(0.1, 10.1, state(1));
    const o = out();
    b.sample(10.1 + DELAY + 0.1, o); // 0.1 s past the last state
    expect(o.p.x).toBeCloseTo(2, 3);
    b.sample(10.1 + DELAY + 5, o); // but not forever
    expect(o.p.x).toBeCloseTo(1 + 10 * 0.25, 3);
  });

  it('ignores out-of-order states', () => {
    const b = new SnapshotBuffer();
    b.push(0.2, 10.2, state(2));
    b.push(0.1, 10.25, state(1));
    expect(b.items.length).toBe(1);
  });
});

describe('multiplayer state message', () => {
  it('carries pose, prop, control surfaces and damage compactly', () => {
    const ac = new Aircraft(getAircraft('buschtrottel-shockcub').def, { ground });
    ac.resetInAir(new Vector3(10, 30, -5), 0, 12);
    ac.controls = { roll: 0.5, pitch: -0.3, yaw: 0.2, throttle: 0.6 };
    ac.update(0.5);
    ac.breakAt({ part: 'wingL' }, 5);
    const m = encodeState(ac);
    expect(m.t).toBe('s');
    expect(m.p.length).toBe(3);
    expect(m.q.length).toBe(4);
    expect(m.d.length).toBe(ac.surfaces.filter((s) => s.controls.length).length);
    expect(m.broken).toEqual(['wingL']);
    expect(JSON.stringify(m).length).toBeLessThan(400);
  });
});

import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { buildShape, sweptHit } from '../src/net/collide.js';

describe('mid-air collisions', () => {
  // A 0.9 m "wing" plate with a fuselage box: roughly a model aeroplane.
  function plane() {
    const g = new Group();
    const wing = new Mesh(new BoxGeometry(0.2, 0.01, 0.9), new MeshBasicMaterial());
    wing.userData.part = 'wingR';
    const fus = new Mesh(new BoxGeometry(0.7, 0.08, 0.08), new MeshBasicMaterial());
    g.add(wing, fus);
    return buildShape(g);
  }
  const shape = plane();
  const pose = (x, y = 0, z = 0) => ({ p: new Vector3(x, y, z), q: new Quaternion() });

  it('builds a shape with a sensible size', () => {
    expect(shape.radius).toBeGreaterThan(0.44);
    expect(shape.radius).toBeLessThan(0.5);
    expect(shape.samples.length).toBeGreaterThan(50);
    expect(shape.samples.length).toBeLessThan(2000);
  });

  it('detects overlapping aeroplanes', () => {
    expect(sweptHit(shape, pose(0.3, 0, 0.2), shape, pose(0), {})).not.toBeNull();
  });

  it('does not flag a near miss', () => {
    expect(sweptHit(shape, pose(0, 0.3, 0), shape, pose(0), {})).toBeNull();
    expect(sweptHit(shape, pose(0, 0, 1.0), shape, pose(0), {})).toBeNull();
  });

  it('catches a fast head-on pass between two frames', () => {
    // Closing fast: in one frame it goes from just short to just past.
    const state = {};
    expect(sweptHit(shape, pose(0.8), shape, pose(0), state)).toBeNull(); // nose to nose, 10 cm apart
    expect(sweptHit(shape, pose(-0.8), shape, pose(0), state)).not.toBeNull(); // a frame later: through and out
  });

  it('catches a pass that jumps right through in one frame', () => {
    const state = {};
    expect(sweptHit(shape, pose(0, 1.0, 0), shape, pose(0), state)).toBeNull(); // 1 m above
    expect(sweptHit(shape, pose(0, -1.0, 0), shape, pose(0), state)).not.toBeNull(); // 1 m below: went through
  });

  it('a pass well clear stays clear', () => {
    const state = {};
    expect(sweptHit(shape, pose(-3, 0, 2), shape, pose(0), state)).toBeNull();
    expect(sweptHit(shape, pose(3, 0, 2), shape, pose(0), state)).toBeNull();
  });
});
