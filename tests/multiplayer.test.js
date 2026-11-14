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
