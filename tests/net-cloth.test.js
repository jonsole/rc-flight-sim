import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { NetCloth } from '../src/view/netCloth.js';

const still = new Vector3();

function finite(c) {
  return c.pos.every((v) => Number.isFinite(v));
}

/** Widest the bag gets across the flow (x), and how far the tail trails. */
function shape(c, center) {
  let r = 0;
  for (let k = c.S; k < c.count; k++) {
    const p = c.point(k);
    r = Math.max(r, Math.hypot(p.y - center.y, p.z - center.z));
  }
  const tip = c.point(c.tip);
  return { r, trail: center.x - tip.x, sag: center.y - tip.y };
}

describe('insect net fabric', () => {
  it('streams out behind a towed hoop, billowed open, without stretching', () => {
    const c = new NetCloth(0.44);
    const center = new Vector3(0, 40, 0);
    const n = new Vector3(1, 0, 0);
    c.reset(center, n);
    for (let i = 0; i < 180; i++) {
      center.x += 12 / 60;
      c.step(1 / 60, center, n, still, 0, i / 60);
    }
    expect(finite(c)).toBe(true);
    const s = shape(c, center);
    expect(s.trail).toBeGreaterThan(0.75 * c.length);
    expect(s.trail).toBeLessThan(1.15 * c.length);
    expect(Math.abs(s.sag)).toBeLessThan(0.25 * c.length); // flying out, not hanging
    expect(s.r).toBeGreaterThan(0.8 * c.R); // filled with air
    expect(s.r).toBeLessThan(1.35 * c.R); // (billowing out a little past the hoop)
  });

  it('hangs and folds when the hoop stops in the air', () => {
    const c = new NetCloth(0.44);
    const center = new Vector3(0, 40, 0);
    const n = new Vector3(1, 0, 0);
    c.reset(center, n);
    for (let i = 0; i < 240; i++) c.step(1 / 60, center, n, still, 0, i / 60);
    expect(finite(c)).toBe(true);
    // The tail hangs below the hoop.
    expect(center.y - c.point(c.tip).y).toBeGreaterThan(0.6 * c.length);
  });

  it('crumples on the grass, never through it', () => {
    const c = new NetCloth(0.44);
    const center = new Vector3(0, 0.05, 0);
    const n = new Vector3(0, 1, 0); // hoop lying flat
    c.reset(center, n);
    for (let i = 0; i < 240; i++) c.step(1 / 60, center, n, still, 0, i / 60);
    expect(finite(c)).toBe(true);
    let top = -Infinity;
    for (let k = c.S; k < c.count; k++) {
      const y = c.point(k).y;
      expect(y).toBeGreaterThanOrEqual(0.009);
      top = Math.max(top, y);
    }
    expect(top).toBeLessThan(0.1); // a pile of fabric, not a standing cone
  });

  it('survives a jerky, uneven frame rate', () => {
    const c = new NetCloth(0.6);
    const center = new Vector3(0, 20, 0);
    const n = new Vector3(1, 0, 0);
    c.reset(center, n);
    for (let i = 0; i < 200; i++) {
      const dt = i % 7 === 0 ? 0.05 : 1 / 90;
      center.x += 20 * dt;
      center.y += Math.sin(i / 5) * 0.3;
      n.set(1, Math.sin(i / 9) * 0.5, Math.cos(i / 4) * 0.3).normalize();
      c.step(dt, center, n, new Vector3(3, 0, 1), 0, i / 60);
    }
    expect(finite(c)).toBe(true);
    expect(c.point(c.tip).distanceTo(center)).toBeLessThan(1.3 * c.length + c.R);
  });
});
