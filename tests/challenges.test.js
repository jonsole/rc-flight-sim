import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { throughHoop, segmentTouches, bodyShape, crossSegment2D } from '../src/game/geom.js';
import { Ribbon, SEG } from '../src/game/ribbon.js';
import { findArena, arenaToWorld } from '../src/game/arena.js';
import { Hoops, Balloons, Balloon, Limbo, Pylons, Streamers, SpotLanding, LIMBO_HEIGHTS } from '../src/game/courses.js';
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
    expect(b.left).toBe(12); // normal: 12 up at once
    const one = b.balloons[3];
    const t = one.pos.clone();
    fly(b, [t.clone().add(new Vector3(-4, 0, 0)), t.clone().add(new Vector3(4, 0, 0))]);
    expect(one.popped).toBe(true);
    expect(b.burst).toBe(1);
    expect(b.left).toBe(11);
    // Another is tied up a couple of seconds later.
    fly(b, [new Vector3(arena.x, arena.g + 60, arena.z), new Vector3(arena.x + 30, arena.g + 60, arena.z)]);
    expect(b.left).toBe(12);
    expect(b.score().value).toBe(1);
  });

  it('balloons: easy has more, bigger balloons; hard fewer, smaller ones', () => {
    const e = new Balloons({ ...env(), level: 'easy' });
    const h = new Balloons({ ...env(), level: 'hard' });
    expect(e.left).toBeGreaterThan(h.left);
    expect(e.radius).toBeGreaterThan(h.radius * 2);
    // Easy ones all about the same height; hard ones anywhere from low down to high up.
    const spread = (c) => {
      const hs = c.balloons.map((b) => b.len);
      return Math.max(...hs) - Math.min(...hs);
    };
    expect(spread(e)).toBeLessThan(4);
    expect(spread(h)).toBeGreaterThan(12);
    expect(new Balloons({ ...env(), minutes: 2 }).limit).toBe(120);
    expect(new Balloons(env()).limit).toBe(300);
  });

  it('difficulty changes the other courses too', () => {
    expect(new Hoops({ ...env(), level: 'easy' }).radius).toBeGreaterThan(new Hoops({ ...env(), level: 'hard' }).radius);
    expect(new Limbo({ ...env(), level: 'easy' }).width).toBeGreaterThan(new Limbo({ ...env(), level: 'hard' }).width);
    expect([new Pylons({ ...env(), level: 'easy' }).laps, new Pylons(env()).laps, new Pylons({ ...env(), level: 'hard' }).laps]).toEqual([2, 3, 5]);
    const speeds = (level) => new Streamers({ ...env(), level }).drones.map((d) => d.o.speed);
    expect(Math.max(...speeds('easy'))).toBeLessThan(Math.min(...speeds('hard')));
  });

  it('a balloon on its string leans downwind and holds its length; cut free it floats up and away', () => {
    const peg = new Vector3(0, ground.heightAt(0, 0), 0);
    const b = new Balloon(peg, 10, 0.45);
    const breeze = (p, out) => out.set(4, 0, 0);
    for (let i = 0; i < 600; i++) b.step(1 / 60, breeze, floor);
    expect(b.pos.distanceTo(peg)).toBeCloseTo(10, 2);
    expect(b.pos.x).toBeGreaterThan(3); // blown over downwind
    expect(b.pos.y - peg.y).toBeGreaterThan(6); // but still well up
    b.cut(0.5);
    for (let i = 0; i < 600; i++) b.step(1 / 60, breeze, floor);
    expect(b.pos.y - peg.y).toBeGreaterThan(30); // rising at a few m/s
    expect(b.pos.x).toBeGreaterThan(30); // and drifting with the wind
    expect(b.trail.count).toBeGreaterThan(0);
  });

  it('balloons: flying through a string cuts it, and the balloon gets away', () => {
    const bs = new Balloons(env());
    fly(bs, [new Vector3(arena.x, arena.g + 60, arena.z), new Vector3(arena.x + 1, arena.g + 60, arena.z)]);
    const b = bs.balloons[5];
    // Across the string halfway up.
    const mid = b.peg.clone().lerp(b.pos, 0.5);
    fly(bs, [mid.clone().add(new Vector3(-4, 0, 0.01)), mid.clone().add(new Vector3(4, 0, 0.01))]);
    expect(b.free).toBe(true);
    expect(b.popped).toBe(false);
    // Left to go, it rises out of reach.
    fly(bs, [new Vector3(arena.x, arena.g + 200, arena.z), new Vector3(arena.x + 200, arena.g + 200, arena.z)], { stepLen: 0.05 });
    expect(b.gone).toBe(true);
    expect(bs.lost).toBe(1);
    expect(bs.left).toBe(12); // (replaced)
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

  /** An oval outside all three pylons, three times round from just before the line, then over it once more. */
  function raceLaps(way) {
    const R = arena.r;
    const pts = [];
    for (let lap = 0; lap < 3; lap++) {
      for (let k = 0; k <= 120; k++) {
        const th = -Math.PI / 2 - way * 0.3 + way * (k / 120) * Math.PI * 2;
        const u = Math.cos(th) * 1.2 * R;
        const v = Math.sin(th) * (Math.sin(th) < 0 ? 0.5 : 0.95) * R;
        const [x, z] = arenaToWorld(arena, u, v);
        pts.push(new Vector3(x, ground.heightAt(x, z) + 12, z));
      }
    }
    const [x, z] = arenaToWorld(arena, way * 10, -0.5 * R);
    pts.push(new Vector3(x, ground.heightAt(x, z) + 12, z));
    return pts;
  }

  it('pylon race: three laps round the outside, left to right', () => {
    const pr = new Pylons(env());
    const { ac } = fly(pr, raceLaps(1), { stepLen: 1 });
    expect(ac.crashed).toBe(false);
    expect(pr.cuts).toBe(0);
    expect(pr.state).toBe('done');
  });

  it('pylon race: crossing the line right to left races the other way round', () => {
    const pr = new Pylons(env());
    const { ac, said } = fly(pr, raceLaps(-1), { stepLen: 1 });
    expect(ac.crashed).toBe(false);
    expect(pr.order).toEqual([2, 1, 0]);
    expect(pr.cuts).toBe(0);
    expect(said.join()).not.toMatch(/Wrong way/);
    expect(pr.state).toBe('done');
  });

  it('pylon race: the arrows on the pylons point the way round, either way', () => {
    for (const way of [1, -1]) {
      const pr = new Pylons(env());
      const pts = raceLaps(way);
      fly(pr, pts.slice(0, 20), { stepLen: 1 }); // over the line: the direction's set
      for (const p of pr.pylons) {
        // Where the race path passes the pylon on the outside, which way is it going?
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(p.base) < pts[best].distanceTo(p.base)) best = i;
        const go = pts[best + 1].clone().sub(pts[best - 1]).setY(0).normalize();
        expect(go.dot(p.way)).toBeGreaterThan(0.5);
      }
    }
  });

  it('pylon race: each pylon\'s flag sticks out on the side to fly past (out of the course)', () => {
    const pr = new Pylons(env());
    const [cx, cz] = arenaToWorld(arena, 0, 0);
    for (const p of pr.pylons) {
      p.g.updateMatrixWorld(true);
      // The flag's point, in the world.
      const tip = new Vector3(p.flagLength, 0, 0).applyMatrix4(p.flag.matrixWorld);
      expect(Math.hypot(tip.x - cx, tip.z - cz)).toBeGreaterThan(Math.hypot(p.base.x - cx, p.base.z - cz) + 3.5);
    }
  });

  it('pylon race: the start line keeps clear of the pilot', () => {
    const pr = new Pylons(env());
    const [px, pz] = [arena.x - arena.away[0] * arena.d, arena.z - arena.away[1] * arena.d];
    expect(Math.hypot(pr.lineA.x - px, pr.lineA.z - pz)).toBeGreaterThan(14);
  });

  it('pylon race: the line crossed the wrong way after the start says so', () => {
    const pr = new Pylons(env());
    const R = arena.r;
    const P = (u, v) => {
      const [x, z] = arenaToWorld(arena, u, v);
      return new Vector3(x, ground.heightAt(x, z) + 12, z);
    };
    // Started left to right, round all three, then back over the line right to left.
    const pts = raceLaps(1).slice(0, 118);
    // (round the far end of the line, through the middle, to come at it from the right)
    const { said } = fly(pr, [...pts, P(-0.6 * R, -0.5 * R), P(-0.3 * R, 0.3 * R), P(0.3 * R, 0.3 * R), P(10, -0.5 * R), P(-10, -0.5 * R)], { stepLen: 1 });
    expect(pr.lap).toBe(0);
    expect(said.join()).toMatch(/Wrong way/);
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

  it('streamers: the planes fly slowly and smoothly, at steady heights clear of the ground', () => {
    const s = new Streamers(env());
    const ctx = { dt: 1 / 60, time: 0, ac: { crashed: false, held: null, onGround: true, velocity: new Vector3() }, pose: { p: new Vector3(0, -50, 0), q: new Quaternion() }, prev: new Vector3(0, -50, 0), span: 1, shape: bodyShape(1), sweep: 0, wind: still, floor, say: () => {}, sfx: () => {} };
    const last = s.drones.map((d) => d.pose.q.clone());
    const ys = s.drones.map(() => []);
    for (let i = 0; i < 60 * 40; i++) {
      s.update(ctx);
      s.drones.forEach((d, k) => {
        expect(d.vel.length()).toBeLessThan(9.5);
        // No sudden twitches: at most ~60 degrees a second of attitude change.
        expect(d.pose.q.angleTo(last[k])).toBeLessThan((60 * Math.PI) / 180 / 60);
        last[k].copy(d.pose.q);
        ys[k].push(d.pose.p.y);
        expect(d.pose.p.y).toBeGreaterThan(ground.heightAt(d.pose.p.x, d.pose.p.z) + 10);
      });
    }
    for (const y of ys) expect(Math.max(...y) - Math.min(...y)).toBeLessThan(3.5);
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

describe('spot landing', () => {
  /** A stand-in aeroplane and a way to move it, with the throttle and ground contact as given. */
  function pilot(course) {
    const ac = { crashed: false, held: null, onGround: true, velocity: new Vector3(12, 0, 0), controls: { throttle: 0.7 }, crash(r) { this.crashed = r; } };
    const pose = { p: new Vector3(), q: new Quaternion() };
    const prev = new Vector3();
    const said = [];
    let time = 0;
    const at = (x, z, h, { ground = false, throttle = ac.controls.throttle, speed = 12 } = {}) => {
      prev.copy(pose.p);
      pose.p.set(x, ground ? course.env.ground.heightAt(x, z) : course.env.ground.heightAt(x, z) + h, z);
      ac.onGround = ground;
      ac.controls.throttle = throttle;
      ac.velocity.set(speed, 0, 0);
      time += 0.05;
      course.env.me = { position: pose.p };
      course.update({ dt: 0.05, time, ac, pose, prev, span: 1, shape: bodyShape(1), sweep: 0, wind: still, floor, say: (t) => said.push(t), sfx: () => {} });
    };
    /** Fly round the spot at radius r, h up, through `deg` degrees, from its -x side. */
    const circle = (r, h, deg = 380) => {
      const { x, z } = course.spot;
      // (Starting on the side the climb ended, the pilot's way, -x.)
      for (let a = 180; a <= 180 + deg; a += 3) at(x + Math.cos((a * Math.PI) / 180) * r, z + Math.sin((a * Math.PI) / 180) * r, h);
    };
    return { ac, at, circle, said };
  }

  it('climb, circuit, cut the throttle, land: scored by the touchdown point', () => {
    const c = new SpotLanding(env());
    const { x, z } = c.spot;
    const f = pilot(c);
    f.at(x - 40, z, 0, { ground: true, speed: 0 });
    expect(c.state).toBe('ready');
    for (let h = 1; h <= 12; h++) f.at(x - 40 + h, z, h);
    expect(c.stage).toBe('circuit');
    f.circle(25, 12);
    expect(c.stage).toBe('cut');
    f.at(x - 25, z, 10, { throttle: 0 });
    expect(c.stage).toBe('glide');
    for (let k = 0; k < 20; k++) f.at(x - 25 + k, z + 1.5, 10 - k * 0.5, { throttle: 0 });
    f.at(x - 3, z + 1.5, 0, { ground: true, throttle: 0, speed: 6 });
    expect(c.stage).toBe('rolling');
    f.at(x - 1, z + 1.5, 0, { ground: true, throttle: 0, speed: 0.2 }); // stopped
    expect(c.state).toBe('done');
    // Measured from where it first touched, not where it stopped.
    expect(c.score().value).toBeCloseTo(Math.hypot(3, 1.5), 1);
    expect(c.score().text).toMatch(/Good|Superb/);
  });

  it('a circuit flown too close round the spot, or too low, does not count', () => {
    const c = new SpotLanding(env());
    const { x, z } = c.spot;
    const f = pilot(c);
    for (let h = 1; h <= 12; h++) f.at(x - 40 + h, z, h);
    f.circle(8, 12); // inside the 20 m minimum
    expect(c.stage).toBe('circuit');
    f.circle(30, 6); // below 10 m
    expect(c.stage).toBe('circuit');
    f.circle(30, 15);
    expect(c.stage).toBe('cut');
  });

  it('throttle after the cut, or a crash landing, means no score', () => {
    for (const how of ['throttle', 'crash']) {
      const c = new SpotLanding(env());
      const { x, z } = c.spot;
      const f = pilot(c);
      for (let h = 1; h <= 12; h++) f.at(x - 40 + h, z, h);
      f.circle(25, 12);
      f.at(x - 25, z, 10, { throttle: 0 });
      if (how === 'throttle') f.at(x - 20, z, 8, { throttle: 0.3 });
      else {
        f.at(x - 2, z, 0, { ground: true, throttle: 0, speed: 8 });
        f.ac.crashed = 'Crashed';
        f.at(x - 1, z, 0, { ground: true, throttle: 0, speed: 2 });
      }
      expect(c.state).toBe('done');
      expect(c.score().void).toBe(true);
    }
  });

  it('the on-screen steps tick off as you go, and say why the circuit isn\'t counting', () => {
    const c = new SpotLanding(env());
    const { x, z } = c.spot;
    const f = pilot(c);
    const now = () => c.steps().findIndex((st) => st.state === 'now');
    f.at(x - 40, z, 0, { ground: true, speed: 0 });
    expect(now()).toBe(0); // take off
    f.at(x - 39, z, 3);
    expect(now()).toBe(1); // climb
    expect(c.steps()[1].detail).toBe(''); // (the height's the big number in the box)
    for (let h = 4; h <= 12; h++) f.at(x - 40 + h, z, h);
    expect(now()).toBe(2); // circuit
    f.at(x - 5, z, 12); // too close in
    expect(c.steps()[2].detail).toMatch(/too close/);
    f.at(x - 30, z, 5); // too low
    expect(c.steps()[2].detail).toMatch(/too low/);
    f.circle(30, 12);
    expect(now()).toBe(3); // cut
    expect(c.steps().slice(0, 3).every((st) => st.state === 'done')).toBe(true);
    f.at(x - 30, z, 10, { throttle: 0 });
    expect(now()).toBe(4); // land
    f.at(x - 1, z, 0, { ground: true, throttle: 0, speed: 0.2 });
    f.at(x - 1, z, 0, { ground: true, throttle: 0, speed: 0.2 });
    expect(c.steps().every((st) => st.state === 'done')).toBe(true);
  });

  it('hard means higher and wider', () => {
    const e = new SpotLanding({ ...env(), level: 'easy' });
    const h = new SpotLanding({ ...env(), level: 'hard' });
    expect(h.climb).toBeGreaterThan(e.climb);
    expect(h.minR).toBeGreaterThan(e.minR);
    expect(new SpotLanding(env()).climb).toBe(10);
  });
});
