import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { throughHoop, segmentTouches, bodyShape, crossSegment2D } from '../src/game/geom.js';
import { Ribbon, SEG } from '../src/game/ribbon.js';
import { findArena, arenaToWorld } from '../src/game/arena.js';
import { Hoops, Balloons, Limbo, Pylons, Streamers, LIMBO_HEIGHTS } from '../src/game/courses.js';
import { Obstacles } from '../src/sim/obstacles.js';
import { physicsGround as ground } from '../src/sim/terrain.js';
import { Aircraft } from '../src/sim/aircraft.js';
import { getAircraft } from '../src/aircraft/index.js';

const obstacles = new Obstacles();
const arena = findArena(obstacles, ground);
const entry = getAircraft('eflite-se5a-900');
const env = () => ({ arena, ground, obstacles, droneTypes: [entry], makeProxy: (e) => new Aircraft(e.def, { ground }) });
const still = (p, out) => out.set(0, 0, 0);
const floor = (x, z) => ground.heightAt(x, z);

/** Fly a course along points (wings level, nose along the way it's going), in small steps. */
function fly(course, pts, { stepLen = 0.3, span = 0.9, ac = {} } = {}) {
  const said = [];
  const a = { crashed: false, held: null, onGround: false, velocity: new Vector3(15, 0, 0), crash(r) { this.crashed = r; }, ...ac };
  const pose = { p: new Vector3().copy(pts[0]), q: new Quaternion() };
  const prev = pts[0].clone();
  let time = 0;
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(pts[i].distanceTo(pts[i - 1]) / stepLen));
    pose.q.setFromUnitVectors(new Vector3(1, 0, 0), pts[i].clone().sub(pts[i - 1]).setY(0).normalize());
    for (let k = 1; k <= n; k++) {
      prev.copy(pose.p);
      pose.p.lerpVectors(pts[i - 1], pts[i], k / n);
      time += 0.02;
      course.update({ dt: 0.02, time, ac: a, pose, prev, span, shape: bodyShape(span), sweep: prev.distanceTo(pose.p), wind: still, floor, say: (t) => said.push(t), sfx: () => {} });
    }
  }
  return { ac: a, said };
}

describe('challenge geometry', () => {
  it('knows through a hoop from round it', () => {
    const c = new Vector3(0, 10, 0);
    const n = new Vector3(1, 0, 0);
    expect(throughHoop(new Vector3(-1, 10.5, 0.5), new Vector3(1, 10.5, 0.5), c, n, 2.5)).toBe(1);
    expect(throughHoop(new Vector3(1, 10, 0), new Vector3(-1, 10, 0), c, n, 2.5)).toBe(-1);
    expect(throughHoop(new Vector3(-1, 12.7, 0), new Vector3(1, 12.7, 0), c, n, 2.5)).toBe('rim');
    expect(throughHoop(new Vector3(-1, 20, 0), new Vector3(1, 20, 0), c, n, 2.5)).toBe(0);
    expect(throughHoop(new Vector3(-1, 10, 0), new Vector3(-0.5, 10, 0), c, n, 2.5)).toBe(0);
  });

  it('a streamer across the wing touches it, one above it does not', () => {
    const s = bodyShape(1);
    // Hanging down through the right wing.
    expect(segmentTouches(s, new Vector3(0, 0.2, 0.3), new Vector3(0, -0.2, 0.3), 0)).toBeGreaterThanOrEqual(0);
    // Out past the wing tip.
    expect(segmentTouches(s, new Vector3(0, 0.2, 0.8), new Vector3(0, -0.2, 0.8), 0)).toBe(-1);
    // A metre above.
    expect(segmentTouches(s, new Vector3(0, 1.2, 0.3), new Vector3(0, 0.8, 0.3), 0)).toBe(-1);
    // Just behind the wing, but flown through this frame (swept).
    expect(segmentTouches(s, new Vector3(-0.5, 0.2, 0.3), new Vector3(-0.5, -0.2, 0.3), 0)).toBe(-1);
    expect(segmentTouches(s, new Vector3(-0.5, 0.2, 0.3), new Vector3(-0.5, -0.2, 0.3), 0.5)).toBeGreaterThanOrEqual(0);
    // Lying across the nose, through the fuselage's plane.
    expect(segmentTouches(s, new Vector3(0.3, 0.05, -0.2), new Vector3(0.3, 0.05, 0.2), 0)).toBeGreaterThanOrEqual(0);
  });

  it('crosses a line on the ground', () => {
    expect(crossSegment2D(-1, 0, 1, 0, 0, -5, 0, 5)).toMatchObject({ t: 0.5, u: 0.5 });
    expect(crossSegment2D(-1, 6, 1, 6, 0, -5, 0, 5)).toBeNull();
  });
});

describe('streamers', () => {
  it('trails out behind a model flying along, keeping its length', () => {
    const r = new Ribbon({ length: 8 });
    const anchor = new Vector3(0, 30, 0);
    r.place(anchor, new Vector3(-1, 0, 0));
    for (let i = 0; i < 180; i++) {
      anchor.x += 15 / 60;
      r.step(1 / 60, anchor, still, floor);
    }
    const tail = r.points[r.count];
    expect(anchor.x - tail.x).toBeGreaterThan(6.5); // streaming back
    expect(anchor.y - tail.y).toBeLessThan(3.5); // not hanging down
    for (let i = 1; i <= r.count; i++) expect(r.points[i].distanceTo(r.points[i - 1])).toBeCloseTo(SEG, 3);
  });

  it('hangs down when the model stops, and the loose end falls to the ground', () => {
    const r = new Ribbon({ length: 4 });
    const anchor = new Vector3(0, 10, 0);
    r.place(anchor, new Vector3(-1, 0, 0));
    for (let i = 0; i < 600; i++) r.step(1 / 60, anchor, still, floor);
    expect(r.points[r.count].y).toBeLessThan(anchor.y - 3);
    const piece = r.cut(4, 0.5);
    expect(r.count).toBe(3);
    expect(piece.attached).toBe(false);
    expect(piece.count).toBe(5);
    for (let i = 0; i < 60 * 15; i++) piece.step(1 / 60, null, still, floor);
    expect(piece.points[0].y).toBeLessThan(ground.heightAt(0, 0) + 0.2);
  });
});

describe('challenge courses', () => {
  it('finds open sky for the courses at the club field', () => {
    expect(arena.r).toBeGreaterThanOrEqual(30);
    expect(Math.hypot(...arena.away)).toBeCloseTo(1, 6);
  });

  it('hoops: through in order, the clock starts at the first', () => {
    const h = new Hoops(env());
    expect(h.hoops.length).toBe(8);
    // Through hoop 2 first: not counted.
    const o = h.hoops[1];
    fly(h, [o.c.clone().addScaledVector(o.n, -5), o.c.clone().addScaledVector(o.n, 5)]);
    expect(h.next).toBe(0);
    expect(h.state).toBe('ready');
    for (const k of h.hoops.keys()) {
      const hp = h.hoops[k];
      fly(h, [hp.c.clone().addScaledVector(hp.n, -5), hp.c.clone().addScaledVector(hp.n, 5)]);
      expect(h.next).toBe(k + 1);
      if (k === 0) expect(h.state).toBe('running');
    }
    expect(h.state).toBe('done');
  });

  it('hoops are clear of the trees', () => {
    const h = new Hoops(env());
    for (const { c } of h.hoops) {
      for (const s of obstacles.near(c.x, c.z, 3)) expect(Obstacles.test(s, c.x, c.y, c.z)).toBeNull();
    }
  });

  it('balloons burst when flown into', () => {
    const b = new Balloons(env());
    fly(b, [new Vector3(arena.x, arena.g + 40, arena.z), new Vector3(arena.x + 1, arena.g + 40, arena.z)]); // to sway them into place
    expect(b.left).toBe(15);
    const t = b.balloons[3].pos.clone();
    fly(b, [t.clone().add(new Vector3(-4, 0, 0)), t.clone().add(new Vector3(4, 0, 0))]);
    expect(b.balloons[3].popped).toBe(true);
    expect(b.left).toBe(14);
  });

  it('limbo: under lowers the bar, over does not count, touching it ends it', () => {
    const l = new Limbo(env());
    const n = l.normal;
    const pass = (h) => fly(l, [l.centre.clone().addScaledVector(n, -12).setY(l.centre.y + h), l.centre.clone().addScaledVector(n, 12).setY(l.centre.y + h)]);
    pass(LIMBO_HEIGHTS[0] - 1.5);
    expect(l.passes).toBe(1);
    expect(l.barHeight).toBe(LIMBO_HEIGHTS[1]);
    const { said } = pass(LIMBO_HEIGHTS[1] + 2);
    expect(l.passes).toBe(1);
    expect(said.join()).toMatch(/Over the top/);
    pass(LIMBO_HEIGHTS[1]); // right into it
    expect(l.state).toBe('done');
    expect(l.score().value).toBe(1);
  });

  it('limbo: flying into a pole crashes', () => {
    const l = new Limbo(env());
    const p = l.near;
    const { ac } = fly(l, [p.clone().addScaledVector(l.normal, -4).setY(p.y + 3), p.clone().addScaledVector(l.normal, 4).setY(p.y + 3)]);
    expect(ac.crashed).toMatch(/pole/);
  });

  it('pylon race: three laps round the outside', () => {
    const pr = new Pylons(env());
    const R = arena.r;
    // An oval outside all three pylons, anticlockwise from the start line.
    const pts = [];
    for (let lap = 0; lap < 3; lap++) {
      for (let k = 0; k <= 120; k++) {
        const th = -Math.PI / 2 - 0.3 + (k / 120) * Math.PI * 2;
        const u = Math.cos(th) * 1.2 * R;
        const v = Math.sin(th) * (Math.sin(th) < 0 ? 0.5 : 0.95) * R;
        const [x, z] = arenaToWorld(arena, u, v);
        pts.push(new Vector3(x, ground.heightAt(x, z) + 12, z));
      }
    }
    // Then over the line once more.
    const [x, z] = arenaToWorld(arena, 10, -0.5 * R);
    pts.push(new Vector3(x, ground.heightAt(x, z) + 12, z));
    const { ac } = fly(pr, pts, { stepLen: 1 });
    expect(ac.crashed).toBe(false);
    expect(pr.cuts).toBe(0);
    expect(pr.state).toBe('done');
  });

  it('pylon race: cutting inside a pylon does not count it', () => {
    const pr = new Pylons(env());
    const R = arena.r;
    const P = (u, v) => {
      const [x, z] = arenaToWorld(arena, u, v);
      return new Vector3(x, ground.heightAt(x, z) + 12, z);
    };
    // Over the start line, then straight up the middle past the right pylon on the inside.
    const { said } = fly(pr, [P(-10, -0.5 * R), P(10, -0.5 * R), P(0.5 * R, -0.45 * R), P(0.5 * R, 0)], { stepLen: 1 });
    expect(pr.state).toBe('running');
    expect(pr.next).toBe(0);
    expect(pr.cuts).toBe(1);
    expect(said.join()).toMatch(/Cut pylon 1/);
  });

  it('pylon race: a pylon is solid', () => {
    const pr = new Pylons(env());
    const b = pr.pylons[0].base;
    const { ac } = fly(pr, [b.clone().add(new Vector3(-5, 3, 0)), b.clone().add(new Vector3(5, 3, 0))]);
    expect(ac.crashed).toMatch(/pylon/);
  });

  it('streamers: the planes fly their loops, and a streamer flown through is cut', () => {
    const s = new Streamers(env());
    const ctx = { dt: 1 / 60, time: 0, ac: { crashed: false, held: null, onGround: true, velocity: new Vector3() }, pose: { p: new Vector3(0, -50, 0), q: new Quaternion() }, prev: new Vector3(0, -50, 0), span: 1, shape: bodyShape(1), sweep: 0, wind: still, floor, say: () => {}, sfx: () => {} };
    for (let i = 0; i < 240; i++) s.update(ctx);
    const d = s.drones[0];
    // Banked into the turn, flying above the ground, streamers out behind.
    expect(d.pose.p.y).toBeGreaterThan(ground.heightAt(d.pose.p.x, d.pose.p.z) + 15);
    const r = d.ribbons[0];
    expect(r.points[r.count].distanceTo(r.points[0])).toBeGreaterThan(5);
    // Put the wing across the streamer's middle.
    const mid = r.points[8].clone().lerp(r.points[9], 0.5);
    ctx.pose.p.copy(mid).add(new Vector3(0, 0, 0.1));
    const before = r.count;
    // Streamer running roughly up/down through the wing: turn our wing to cross it.
    const along = r.points[9].clone().sub(r.points[8]).normalize();
    ctx.pose.q.setFromUnitVectors(new Vector3(0, 1, 0), along);
    expect(s.tryCut(r, ctx)).toBe(true);
    expect(r.count).toBeLessThan(before);
    expect(s.loose.length).toBe(1);
  });
});
