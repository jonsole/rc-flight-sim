// The challenges' courses: hoops, balloons, limbo, a pylon race round
// inflatable posts, streamer cutting and spot landing. Each builds its things in the
// arena (src/game/arena.js), and each frame checks the aeroplane against
// them. The manager (src/game/challenges.js) runs the clock, the scores and
// the HUD.
//
// A course has:
//   group                three.js objects to add to the scene
//   state                'ready' (clock not started) | 'running' | 'done'
//   update(ctx)          ctx: see Challenges.update
//   status()             { line, big? } for the HUD
//   target()             a Vector3 to point the player at, or null
//   score()              { value, text } when done; `higher` on the class if
//                        more is better (else a time: less is better)
import {
  Group, Mesh, MeshStandardMaterial, MeshBasicMaterial, TorusGeometry, SphereGeometry, CylinderGeometry,
  ConeGeometry, BoxGeometry, PlaneGeometry, Vector3, Quaternion, Matrix4, BufferGeometry, Line, LineBasicMaterial,
  BufferAttribute, DoubleSide, TubeGeometry, CatmullRomCurve3, Shape, ShapeGeometry, RingGeometry, CircleGeometry,
} from 'three';
import { LOCATION, clubToWorld } from '../sim/location.js';
import { throughHoop, crossPlane, crossSegment2D, toBody, segmentTouches, ballTouches } from './geom.js';
import { arenaToWorld, blocked } from './arena.js';
import { Ribbon, RibbonMesh } from './ribbon.js';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _A = new Vector3();
const _B = new Vector3();

/** Seeded random numbers (a course looks the same each try). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Does the world segment a-b touch the aeroplane this frame? */
function touches(ctx, a, b) {
  toBody(ctx.pose, a, _A);
  toBody(ctx.pose, b, _B);
  return segmentTouches(ctx.shape, _A, _B, ctx.sweep) >= 0;
}

/** World point at arena (u, v), h metres above the ground there. */
function at(env, u, v, h) {
  const [x, z] = arenaToWorld(env.arena, u, v);
  return new Vector3(x, env.ground.heightAt(x, z) + h, z);
}

/** Raise a point (up to 12 m) until it is clear of the trees. */
function clearOf(env, p, r = 2) {
  for (let k = 0; k < 13; k++) {
    let hit = false;
    for (const [dx, dy, dz] of [[0, 0, 0], [r, 0, 0], [-r, 0, 0], [0, 0, r], [0, 0, -r], [0, r, 0], [0, -r, 0]]) {
      if (blocked(env.obstacles, env.ground, p.x + dx, p.y + dy, p.z + dz)) hit = true;
    }
    if (!hit) return p;
    p.y += 1;
  }
  return p;
}

/** Difficulty levels (Menu → Challenges). */
export const LEVELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
/** The value for this course's difficulty. */
const lv = (env, easy, normal, hard) => ({ easy, normal, hard })[env.level] ?? normal;

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
export const formatTime = fmt;

// --- Hoops -------------------------------------------------------------------

export class Hoops {
  static id = 'hoops';
  static title = 'Hoops';
  static about = 'Fly through the hoops in order, either way through. The next one is lit; the clock starts at the first.';

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.next = 0;
    this.radius = lv(env, 3.5, 2.5, 1.6);
    const R = env.arena.r;
    const heights = lv(env, [6, 7, 9, 8, 6, 8, 10, 7], [6, 9, 13, 8, 5, 11, 15, 7], [5, 11, 17, 7, 4, 13, 19, 6]);
    const n = heights.length;
    this.hoops = [];
    const geo = new TorusGeometry(this.radius + 0.14, 0.14, 10, 48);
    for (let k = 0; k < n; k++) {
      // Round a loop, in and out a little (a slalom), starting nearest the pilot.
      const th = -Math.PI / 2 + (k / n) * Math.PI * 2;
      const wob = k % 2 ? 0.85 : 1.1;
      const u = Math.cos(th) * 0.75 * R * wob;
      const v = Math.sin(th) * 0.55 * R * wob;
      const c = clearOf(env, at(env, u, v, heights[k]), this.radius + 0.5);
      // Facing along the loop (anticlockwise seen from above).
      const [x1, z1] = arenaToWorld(env.arena, -Math.sin(th) * 0.75 * R, Math.cos(th) * 0.55 * R);
      const [x0, z0] = arenaToWorld(env.arena, 0, 0);
      const n3 = new Vector3(x1 - x0, 0, z1 - z0).normalize();
      const mat = new MeshStandardMaterial({ color: '#d03030', roughness: 0.5, transparent: true });
      const mesh = new Mesh(geo, mat);
      mesh.position.copy(c);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), n3);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.hoops.push({ c, n: n3, mesh, mat });
    }
    this.#paint();
  }

  #paint() {
    this.hoops.forEach((h, k) => {
      const next = k === this.next;
      h.mat.color.set(k < this.next ? '#40c040' : next ? '#ffd020' : '#d03030');
      h.mat.emissive.set(next ? '#806000' : '#000000');
      h.mat.opacity = k < this.next ? 0.35 : 1;
    });
  }

  update(ctx) {
    if (this.state === 'done' || ctx.ac.crashed) return;
    const h = this.hoops[this.next];
    // Lit hoop pulses.
    h.mat.emissiveIntensity = 0.6 + 0.4 * Math.sin(ctx.time * 6);
    const r = throughHoop(ctx.prev, ctx.pose.p, h.c, h.n, this.radius);
    if (r === 'rim') {
      ctx.say('Clipped the edge: go round again');
      ctx.sfx('bump');
      return;
    }
    if (r) {
      this.next++;
      if (this.state === 'ready') this.state = 'running';
      if (this.next >= this.hoops.length) {
        this.state = 'done';
        ctx.sfx('finish');
      } else {
        ctx.say(`Hoop ${this.next} of ${this.hoops.length}`);
        ctx.sfx('ding');
      }
      this.#paint();
      return;
    }
    // Through the wrong one?
    this.hoops.forEach((o, k) => {
      if (k > this.next && typeof throughHoop(ctx.prev, ctx.pose.p, o.c, o.n, this.radius) === 'number' && throughHoop(ctx.prev, ctx.pose.p, o.c, o.n, this.radius)) {
        ctx.say(`Wrong hoop: the lit one (${this.next + 1}) is next`);
      }
    });
  }

  status() {
    return { line: this.state === 'done' ? 'All hoops!' : `Hoop ${this.next + 1} of ${this.hoops.length}` };
  }

  target() {
    return this.state === 'done' ? null : this.hoops[this.next].c;
  }

  score(time) {
    return { value: time, text: fmt(time) };
  }
}

// --- Balloons ----------------------------------------------------------------

const BALLOON_COLOURS = ['#e02828', '#2860e0', '#f0c020', '#30b040', '#e050c0', '#ff8020', '#f4f4f4', '#8040d0'];
export const BALLOON = {
  lift: 5, // m/s²: helium's pull up, less the balloon's weight
  drag: 1.6, // 1/s: how hard the air drags it along (free, it rises at lift / drag ≈ 3 m/s)
};
const _bw = new Vector3();
const _bd = new Vector3();

/** A string drawn from a ribbon's points (strings fall and trail like streamers). */
class StringLine {
  constructor(ribbon) {
    this.ribbon = ribbon;
    const geo = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array((ribbon.max + 1) * 3), 3));
    this.line = new Line(geo, new LineBasicMaterial({ color: '#dddddd' }));
    this.line.frustumCulled = false;
  }

  update() {
    const r = this.ribbon;
    const a = this.line.geometry.attributes.position.array;
    for (let i = 0; i <= r.count; i++) r.points[i].toArray(a, i * 3);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.setDrawRange(0, r.count + 1);
    this.line.visible = r.count > 0;
  }
}

/**
 * A helium balloon: pulled up by its lift and along by the wind (gusts and
 * all), held by its string to a peg in the ground. Cut the string and it
 * rises away downwind, trailing what's left of the string.
 */
export class Balloon {
  constructor(peg, len, radius) {
    this.peg = peg.clone();
    this.len = len;
    this.radius = radius;
    this.pos = peg.clone().setY(peg.y + len);
    this.vel = new Vector3();
    this.free = false; // the string's been cut
    this.popped = false;
    this.gone = false; // floated out of reach
    this.trail = null; // string hanging from a free balloon (Ribbon)
    this.stub = null; // string left on the peg (Ribbon)
  }

  /** Where the string meets the balloon. */
  knot(out) {
    return out.copy(this.pos).setY(this.pos.y - this.radius * 1.18 - 0.08);
  }

  step(dt, wind, floor) {
    if (this.popped || this.gone || dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      wind(this.pos, _bw);
      // Dragged towards the wind's speed, lifted by the helium.
      this.vel.addScaledVector(_bw.sub(this.vel), BALLOON.drag * h);
      this.vel.y += BALLOON.lift * h;
      this.pos.addScaledVector(this.vel, h);
      if (!this.free) {
        // The string holds it (taut: it can't go further than its length).
        _bd.copy(this.pos).sub(this.peg);
        const d = _bd.length();
        if (d > this.len) {
          _bd.divideScalar(d);
          this.pos.copy(this.peg).addScaledVector(_bd, this.len);
          const out = this.vel.dot(_bd);
          if (out > 0) this.vel.addScaledVector(_bd, -out);
        }
      }
      const g = floor(this.pos.x, this.pos.z) + this.radius;
      if (this.pos.y < g) {
        this.pos.y = g;
        this.vel.y = Math.max(0, this.vel.y);
      }
    }
  }

  /**
   * Cut the string `t` of the way up from the peg: the balloon goes free
   * with the rest of the string; the part left on the peg falls.
   */
  cut(t) {
    if (this.free) return;
    this.free = true;
    const top = this.knot(new Vector3());
    const at = new Vector3().lerpVectors(this.peg, top, t);
    const below = Math.max(0.5, this.len * t);
    const above = Math.max(0.5, this.len * (1 - t));
    this.stub = new Ribbon({ length: below, width: 0.01, color: '#dddddd' });
    this.stub.place(this.peg, _bd.copy(at).sub(this.peg).normalize());
    this.trail = new Ribbon({ length: above, width: 0.01, color: '#dddddd' });
    this.trail.place(top, _bd.copy(at).sub(top).normalize());
  }
}

export class Balloons {
  static id = 'balloons';
  static title = 'Balloon burst';
  static about = 'How many helium balloons can you burst before the time\'s up? They are tied to pegs on strings and blown about by the wind, and new ones keep being tied up. Clip a string and the balloon floats away: chase it and burst it before it gets out of reach. The clock starts when you take off; crash and R puts you back in the air with the clock still running.';
  static higher = true;

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.limit = (env.minutes ?? 5) * 60; // seconds to burst as many as you can
    this.radius = lv(env, 0.8, 0.5, 0.3); // 1.6 m, 1 m, 0.6 m across
    this.up = lv(env, 15, 12, 9); // balloons up at once
    this.strings = lv(env, [8, 11], [4, 18], [2, 25]); // string lengths (m): how high they fly, and how much that varies
    this.rand = rng(1234 + Math.round(env.arena.r));
    this.geo = new SphereGeometry(this.radius, 18, 14);
    this.geo.scale(1, 1.18, 1);
    this.knot = new ConeGeometry(0.06, 0.1, 8);
    this.balloons = [];
    this.bits = [];
    this.burst = 0;
    this.lost = 0;
    this.made = 0;
    this.waiting = []; // seconds until each replacement is tied up
    for (let k = 0; k < this.up; k++) this.#spawn();
  }

  /** Tie up a new balloon somewhere in the course. */
  #spawn() {
    const env = this.env;
    const R = env.arena.r;
    const rand = this.rand;
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * 0.85 * R;
    const [lo, hi] = this.strings;
    const h = lo + rand() * (hi - lo);
    const peg = at(env, Math.cos(a) * d, Math.sin(a) * d, 0);
    const top = clearOf(env, peg.clone().setY(peg.y + h), 1.2);
    const mat = new MeshStandardMaterial({ color: BALLOON_COLOURS[this.made++ % BALLOON_COLOURS.length], roughness: 0.25, metalness: 0.05 });
    const mesh = new Mesh(this.geo, mat);
    mesh.castShadow = true;
    const k2 = new Mesh(this.knot, mat);
    k2.position.y = -this.radius * 1.18 - 0.03;
    k2.rotation.x = Math.PI;
    mesh.add(k2);
    const line = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)), new LineBasicMaterial({ color: '#dddddd' }));
    line.frustumCulled = false;
    this.group.add(mesh, line);
    const b = new Balloon(peg, top.y - peg.y, this.radius);
    Object.assign(b, { mesh, line, strings: [] });
    this.balloons.push(b);
    return b;
  }

  /** One's gone (burst or away): tidy it up and tie up another shortly. */
  #replace(b) {
    this.group.remove(b.mesh, b.line);
    b.line.geometry.dispose();
    for (const s of b.strings) {
      this.group.remove(s.line);
      s.line.geometry.dispose();
    }
    this.waiting.push(2);
  }

  /** Balloons up now. */
  get left() {
    return this.balloons.filter((b) => !b.popped && !b.gone).length;
  }

  update(ctx) {
    const live = !ctx.ac.crashed && this.state !== 'done';
    for (const b of this.balloons) {
      if (b.popped || b.gone) continue;
      b.step(ctx.dt, ctx.wind, ctx.floor);
      // Leaning along its string (or, free, along the way it's going).
      b.mesh.position.copy(b.pos);
      const lean = b.free ? _a.copy(b.vel).multiplyScalar(-0.15).add(_b.set(0, 1, 0)) : _a.copy(b.pos).sub(b.peg);
      b.mesh.quaternion.setFromUnitVectors(_b.set(0, 1, 0), lean.normalize());
      const top = b.knot(_c);
      if (!b.free) {
        const arr = b.line.geometry.attributes.position.array;
        b.peg.toArray(arr, 0);
        top.toArray(arr, 3);
        b.line.geometry.attributes.position.needsUpdate = true;
      } else {
        b.trail.step(ctx.dt, top, ctx.wind, ctx.floor);
        b.stub.step(ctx.dt, b.peg, ctx.wind, ctx.floor);
        for (const s of b.strings) s.update();
        // Out of reach: high up or blown far away.
        if (b.pos.y > b.peg.y + 120 || b.pos.distanceTo(b.peg) > 350) {
          b.gone = true;
          b.mesh.visible = false;
          for (const s of b.strings) s.line.visible = false;
          this.lost++;
          if (live) ctx.say('One got away!');
          this.#replace(b);
          continue;
        }
      }
      if (!live) continue;
      if (ballTouches(ctx.shape, toBody(ctx.pose, b.pos, _b), this.radius, ctx.sweep)) {
        this.#pop(b, ctx);
        continue;
      }
      // Clipped the string?
      if (!b.free) {
        toBody(ctx.pose, b.peg, _A);
        toBody(ctx.pose, top, _B);
        const t = segmentTouches(ctx.shape, _A, _B, ctx.sweep);
        if (t >= 0) {
          b.cut(t);
          b.line.visible = false;
          b.strings = [new StringLine(b.trail), new StringLine(b.stub)];
          for (const s of b.strings) this.group.add(s.line);
          if (this.state === 'ready') this.state = 'running';
          ctx.sfx('tick');
          ctx.say('Cut the string: it\'s getting away!');
        }
      }
    }
    // Shreds of rubber falling.
    for (const s of this.bits) {
      s.v.y -= 9.81 * ctx.dt * 0.4;
      s.v.multiplyScalar(1 - 2 * ctx.dt);
      s.m.position.addScaledVector(s.v, ctx.dt);
      s.m.rotation.x += ctx.dt * s.spin;
      s.m.rotation.y += ctx.dt * s.spin * 0.7;
      s.life -= ctx.dt;
      if (s.m.position.y < this.env.ground.heightAt(s.m.position.x, s.m.position.z) + 0.02) s.v.set(0, 0, 0);
    }
    for (const s of this.bits.filter((x) => x.life <= 0)) {
      this.group.remove(s.m);
      s.m.geometry.dispose();
    }
    this.bits = this.bits.filter((x) => x.life > 0);
    // New balloons to replace the ones gone.
    this.waiting = this.waiting.map((t) => t - ctx.dt);
    while (this.waiting.length && this.waiting[0] <= 0) {
      this.waiting.shift();
      if (this.state !== 'done') this.#spawn();
    }
    this.balloons = this.balloons.filter((b) => !b.gone && !b.popped);
    if (this.state === 'ready' && !ctx.ac.held && !ctx.ac.onGround && ctx.ac.velocity.length() > 3) this.state = 'running';
  }

  #pop(b, ctx) {
    b.popped = true;
    b.mesh.visible = false;
    b.line.visible = false;
    this.burst++;
    if (this.state === 'ready') this.state = 'running';
    ctx.sfx('pop');
    for (let i = 0; i < 9; i++) {
      const m = new Mesh(new PlaneGeometry(0.12, 0.08), new MeshBasicMaterial({ color: b.mesh.material.color, side: DoubleSide }));
      m.position.copy(b.pos);
      const v = new Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(6).addScaledVector(ctx.ac.velocity, 0.3);
      this.group.add(m);
      this.bits.push({ m, v, spin: 5 + Math.random() * 10, life: 6 });
    }
    this.#replace(b);
    ctx.say(`Pop! ${this.burst}`);
  }

  status() {
    return { line: `${this.burst} burst${this.lost ? ` · ${this.lost} got away` : ''}` };
  }

  target() {
    // A balloon that's getting away.
    let best = null;
    for (const b of this.balloons) if (b.free && !b.popped && !b.gone && (!best || b.pos.y < best.y)) best = b.pos;
    return best;
  }

  score() {
    return { value: this.burst, text: `${this.burst} balloon${this.burst === 1 ? '' : 's'}` };
  }
}

// --- Limbo -------------------------------------------------------------------

export const LIMBO_HEIGHTS = [8, 6.5, 5, 4, 3.2, 2.6, 2.1, 1.7, 1.4, 1.15, 0.95, 0.8, 0.65, 0.55, 0.45, 0.38, 0.32];

export class Limbo {
  static id = 'limbo';
  static title = 'Limbo';
  static about = 'Fly under the bar between the two poles, either way. It drops after every pass: how low can you go? Over the top doesn\'t count; touch the bar and it\'s over.';
  static higher = true;

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.level = 0;
    this.passes = 0;
    this.width = lv(env, 14, 10, 7);
    const a = env.arena;
    // About 35 m in front of the pilot, the bar running away from you, so you
    // fly across your view under it and see the gap side on.
    const v0 = Math.max(-0.6 * a.r, Math.min(0.6 * a.r, 35 - a.d));
    this.near = at(env, 0, v0 - this.width / 2, 0);
    this.far = at(env, 0, v0 + this.width / 2, 0);
    this.centre = new Vector3().lerpVectors(this.near, this.far, 0.5);
    this.normal = new Vector3(a.across[0], 0, a.across[1]);
    this.poleH = 9.5;
    const stripe = (len, r, n, c1, c2) => {
      const g = new Group();
      const geo = new CylinderGeometry(r, r, len / n, 10);
      const m1 = new MeshStandardMaterial({ color: c1, roughness: 0.6 });
      const m2 = new MeshStandardMaterial({ color: c2, roughness: 0.6 });
      for (let i = 0; i < n; i++) {
        const s = new Mesh(geo, i % 2 ? m2 : m1);
        s.position.y = (i + 0.5) * (len / n);
        s.castShadow = true;
        g.add(s);
      }
      return g;
    };
    for (const p of [this.near, this.far]) {
      const pole = stripe(this.poleH, 0.06, 19, '#f2f2f2', '#2050c0');
      pole.position.copy(p);
      this.group.add(pole);
      const base = new Mesh(new CylinderGeometry(0.35, 0.4, 0.12, 16), new MeshStandardMaterial({ color: '#333' }));
      base.position.copy(p).setY(p.y + 0.06);
      this.group.add(base);
    }
    // The bar: a striped pole across the tops of the pegs.
    const len = this.width;
    this.bar = stripe(len, 0.035, 10, '#e02020', '#f6f6f6');
    this.bar.children.forEach((c) => (c.position.y -= len / 2));
    this.bar.position.copy(this.centre);
    this.bar.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), _a.copy(this.far).sub(this.near).normalize());
    this.group.add(this.bar);
    this.fall = null;
    this.#setBar();
  }

  get barHeight() {
    return LIMBO_HEIGHTS[Math.min(this.level, LIMBO_HEIGHTS.length - 1)];
  }

  #setBar() {
    this.barY = this.centre.y + this.barHeight;
    this.bar.position.y = this.barY;
  }

  update(ctx) {
    if (this.fall) {
      // Knocked off: it drops to the ground.
      this.fall.v -= 9.81 * ctx.dt;
      this.bar.position.y = Math.max(this.centre.y + 0.05, this.bar.position.y + this.fall.v * ctx.dt);
      this.bar.rotateZ(ctx.dt * this.fall.spin);
    }
    if (this.state === 'done' || ctx.ac.crashed) return;
    // Lowered once you're well clear of it.
    if (this.lower && Math.abs(_a.copy(ctx.pose.p).sub(this.centre).dot(this.normal)) > 8) {
      this.lower = false;
      this.level++;
      this.#setBar();
      ctx.say(`Bar down to ${this.barHeight.toFixed(2)} m`);
    }
    // The poles are solid.
    for (const p of [this.near, this.far]) {
      if (touches(ctx, p, _c.copy(p).setY(p.y + this.poleH))) {
        ctx.ac.crash('Hit a limbo pole');
        return;
      }
    }
    // Touched the bar?
    const a = _a.copy(this.near).setY(this.barY);
    const b = _b.copy(this.far).setY(this.barY);
    if (touches(ctx, a, b)) {
      this.fall = { v: 0, spin: 2 };
      this.state = 'done';
      ctx.say('Knocked the bar off!');
      ctx.sfx('fail');
      return;
    }
    const x = crossPlane(ctx.prev, ctx.pose.p, this.centre, this.normal, _c);
    if (!x) return;
    // Between the poles?
    const along = _a.copy(x.point).sub(this.near).dot(_b.copy(this.far).sub(this.near).normalize());
    if (along < 0 || along > this.width) return;
    if (this.lower) return; // (back through before it's been lowered)
    if (x.point.y > this.barY) {
      ctx.say('Over the top doesn\'t count: under it!');
      return;
    }
    this.passes++;
    if (this.state === 'ready') this.state = 'running';
    if (this.level >= LIMBO_HEIGHTS.length - 1) {
      this.state = 'done';
      ctx.sfx('finish');
      return;
    }
    this.lower = true;
    ctx.sfx('ding');
    ctx.say(`Under ${this.barHeight.toFixed(2)} m!`);
  }

  status() {
    return { line: `Bar ${this.barHeight.toFixed(2)} m · ${this.passes} under`, big: `${this.barHeight.toFixed(2)} m` };
  }

  target() {
    return this.state === 'done' ? null : this.centre;
  }

  score() {
    const lowest = this.passes ? LIMBO_HEIGHTS[this.passes - 1] : 0;
    return { value: this.passes, text: this.passes ? `${this.passes} under, lowest ${lowest.toFixed(2)} m` : 'none under' };
  }
}

// --- Pylon race --------------------------------------------------------------

export class Pylons {
  static id = 'pylons';
  static title = 'Pylon race';
  static about = 'Laps round the inflatable pylons (2 easy, 3 normal, 5 hard), on the outside of each: cross the start line either way (that sets which way round you race), then round the lit pylon each time on the side its yellow flag sticks out, the way its curved arrow points. Cutting inside one means going back round it. Don\'t touch them!';

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.laps = lv(env, 2, 3, 5);
    this.lap = 0;
    this.next = -1; // -1: the start line; 0..2 the pylons in racing order
    this.order = [0, 1, 2]; // which pylons, in the order raced (set at the start)
    this.sign = 0; // +1 crossed the line left to right, -1 right to left
    this.cuts = 0;
    const R = env.arena.r;
    this.h = 7;
    this.rad = 0.8;
    const spots = [[0.75 * R, -0.35 * R], [0, 0.7 * R], [-0.75 * R, -0.35 * R]]; // right, far, left
    const mid = [0, 0];
    this.pylons = spots.map(([u, v], k) => {
      const base = at(env, u, v, 0);
      const out = new Vector3(u - mid[0], 0, v - mid[1]).normalize();
      // Outward in the world.
      const [ox, oz] = arenaToWorld(env.arena, out.x, out.z);
      const [cx, cz] = arenaToWorld(env.arena, 0, 0);
      const dir = new Vector3(ox - cx, 0, oz - cz).normalize();
      const g = new Group();
      const bands = 6;
      const mats = [new MeshStandardMaterial({ color: '#ff6a10', roughness: 0.7 }), new MeshStandardMaterial({ color: '#f8f8f8', roughness: 0.7 })];
      for (let i = 0; i < bands; i++) {
        const r0 = this.rad * (1 - 0.35 * (i / bands));
        const r1 = this.rad * (1 - 0.35 * ((i + 1) / bands));
        const m = new Mesh(new CylinderGeometry(r1, r0, this.h / bands, 20), mats[i % 2]);
        m.position.y = (i + 0.5) * (this.h / bands);
        m.castShadow = true;
        g.add(m);
      }
      const top = new Mesh(new SphereGeometry(this.rad * 0.65, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats[0]);
      top.position.y = this.h;
      g.add(top);
      const lamp = new Mesh(new SphereGeometry(0.3, 12, 8), new MeshStandardMaterial({ color: '#ffe060', emissive: '#ffd000', emissiveIntensity: 0 }));
      lamp.position.y = this.h + this.rad * 0.65 + 0.2;
      lamp.scale.setScalar(0.8);
      g.add(lamp);
      g.position.copy(base);
      this.group.add(g);
      return { base, dir, lamp, g, arrows: null };
    });
    // The start line: across the near leg, in the middle, a white line on
    // the grass between two flags, from well in front of the pilot out to
    // the middle of the course. Crossed either way, at any height.
    // (Its near end at least 15 m in front of the pilot, who stands at v = -d.)
    this.lineA = at(env, 0, Math.max(-0.35 * R - 35, -(env.arena.d ?? 1e9) + 15), 0);
    this.lineB = at(env, 0, 0, 0);
    this.lineDir = new Vector3(env.arena.across[0], 0, env.arena.across[1]); // left to right, seen by the pilot
    const len = this.lineA.distanceTo(this.lineB);
    const stripe = new Mesh(new PlaneGeometry(len, 0.5), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }));
    stripe.position.lerpVectors(this.lineA, this.lineB, 0.5);
    stripe.position.y = Math.max(this.lineA.y, this.lineB.y) + 0.06;
    stripe.rotation.x = -Math.PI / 2;
    stripe.rotation.z = -Math.atan2(-(this.lineB.z - this.lineA.z), this.lineB.x - this.lineA.x);
    stripe.renderOrder = 2;
    this.group.add(stripe);
    for (const p of [this.lineA, this.lineB]) {
      const pole = new Mesh(new CylinderGeometry(0.04, 0.04, 3, 6), new MeshStandardMaterial({ color: '#ddd' }));
      pole.position.copy(p).setY(p.y + 1.5);
      const flag = new Mesh(new PlaneGeometry(0.9, 0.6), new MeshStandardMaterial({ color: '#111', side: DoubleSide }));
      flag.position.set(0.45, 1.15, 0);
      pole.add(flag);
      this.group.add(pole);
    }
    this.#arrows();
    this.#light();
  }

  /**
   * Markers on each pylon: a curved 3D arrow wrapped round the outside
   * showing the way round (readable from any side and from the cockpit),
   * and a yellow pennant on top sticking out to the side to fly past.
   * Redrawn when the race's direction is set at the start.
   */
  #arrows() {
    const yellow = new MeshStandardMaterial({ color: '#ffd400', emissive: '#806a00', emissiveIntensity: 0.6, roughness: 0.5 });
    const black = new MeshStandardMaterial({ color: '#141414', roughness: 0.8, side: DoubleSide });
    const n = this.pylons.length;
    this.order.forEach((idx, k) => {
      const p = this.pylons[idx];
      if (p.arrows) {
        p.g.remove(p.arrows);
        p.arrows.traverse((o) => o.geometry?.dispose());
      }
      const prev = this.pylons[this.order[(k + n - 1) % n]];
      const next = this.pylons[this.order[(k + 1) % n]];
      // The way you're going as you pass it: from the last pylon towards the next.
      const t = new Vector3().subVectors(next.base, prev.base).setY(0).normalize();
      const d = p.dir; // out of the course
      const side = t.clone().addScaledVector(d, -t.dot(d)).normalize(); // along the outside, the way you go
      p.way = side;
      const up = new Vector3(0, 1, 0);
      const a = new Group();
      // Curved arrow round the outside, about two thirds up.
      const R = 2.1;
      const y = this.h * 0.62;
      const arc = (phi) => new Vector3().addScaledVector(d, Math.cos(phi) * R).addScaledVector(side, Math.sin(phi) * R).setY(y);
      const pts = [];
      const end = (95 * Math.PI) / 180;
      for (let i = 0; i <= 16; i++) pts.push(arc(-end + (i / 16) * 2 * end));
      const tube = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 32, 0.2, 8, false), yellow);
      tube.castShadow = true;
      a.add(tube);
      const tip = arc(end);
      const tdir = new Vector3().addScaledVector(d, -Math.sin(end)).addScaledVector(side, Math.cos(end)).normalize();
      const head = new Mesh(new ConeGeometry(0.55, 1.2, 14), yellow);
      head.position.copy(tip).addScaledVector(tdir, 0.5);
      head.quaternion.setFromUnitVectors(up, tdir);
      a.add(head);
      // A short spoke holding it to the pylon (it's a sign, not to be hit).
      const spoke = new Mesh(new CylinderGeometry(0.06, 0.06, R, 6), black);
      spoke.position.copy(d).multiplyScalar(R / 2).setY(y);
      spoke.quaternion.setFromUnitVectors(up, d);
      a.add(spoke);
      // A pennant on a pole on top, sticking out to the side you fly past:
      // keep the flag's side. Yellow, with a black chevron pointing out too.
      const top = this.h + this.rad * 0.65;
      const poleH = 3;
      const pole = new Mesh(new CylinderGeometry(0.05, 0.05, poleH, 6), black);
      pole.position.set(0, top + poleH / 2, 0);
      a.add(pole);
      const L = 4.5; // pennant length
      const H = 2; // and its height at the pole
      const pen = new Shape();
      pen.moveTo(0, -H / 2);
      pen.lineTo(L, 0);
      pen.lineTo(0, H / 2);
      pen.closePath();
      const flagMat = new MeshStandardMaterial({ color: '#ffd400', emissive: '#806a00', emissiveIntensity: 0.6, roughness: 0.6, side: DoubleSide });
      const chevMat = new MeshBasicMaterial({ color: '#141414', side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const chev = new Shape();
      const cx = L * 0.32;
      const cw = L * 0.13;
      const ch = H * 0.3;
      chev.moveTo(cx - cw, -ch);
      chev.lineTo(cx, -ch);
      chev.lineTo(cx + cw, 0);
      chev.lineTo(cx, ch);
      chev.lineTo(cx - cw, ch);
      chev.lineTo(cx, 0);
      chev.closePath();
      const flag = new Group();
      flag.add(new Mesh(new ShapeGeometry(pen), flagMat), new Mesh(new ShapeGeometry(chev), chevMat));
      // Its length along the outward direction, upright.
      flag.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(d, up, new Vector3().crossVectors(d, up)));
      flag.position.set(0, top + poleH - H / 2 - 0.05, 0);
      a.add(flag);
      p.flag = flag;
      p.flagLength = L;
      p.g.add(a);
      p.arrows = a;
    });
  }

  /** The pylon to round next (null: the line). */
  get nextPylon() {
    return this.next < 0 ? null : this.pylons[this.order[this.next]];
  }

  #light() {
    const lit = this.nextPylon;
    this.pylons.forEach((p) => {
      p.lamp.material.emissiveIntensity = p === lit ? 2 : 0;
      p.lamp.visible = true;
    });
  }

  update(ctx) {
    const lit = this.nextPylon;
    if (lit) lit.lamp.visible = Math.sin(ctx.time * 8) > -0.3;
    if (this.state === 'done' || ctx.ac.crashed) return;
    const p0 = ctx.prev;
    const p1 = ctx.pose.p;
    // Pylons are solid.
    for (const p of this.pylons) {
      if (touches(ctx, _a.copy(p.base).setY(p.base.y + 0.2), _b.copy(p.base).setY(p.base.y + this.h)) || (Math.hypot(p1.x - p.base.x, p1.z - p.base.z) < this.rad && p1.y < p.base.y + this.h + 0.3)) {
        ctx.ac.crash('Hit a pylon');
        return;
      }
    }
    if (this.next === -1) {
      // Over the start line: the first crossing, either way, sets the
      // way round; after that it must be the same way.
      const x = crossSegment2D(p0.x, p0.z, p1.x, p1.z, this.lineA.x, this.lineA.z, this.lineB.x, this.lineB.z);
      const way = Math.sign(_a.copy(p1).sub(p0).dot(this.lineDir));
      if (x && way && this.state !== 'ready' && way !== this.sign) {
        ctx.say('Wrong way over the line: round the last pylon and back');
        ctx.sfx('fail');
        return;
      }
      if (x && way) {
        if (this.state === 'ready') {
          this.state = 'running';
          this.sign = way;
          // Left to right: the right pylon first, then the far one, then the left.
          this.order = way > 0 ? [0, 1, 2] : [2, 1, 0];
          if (way < 0) this.#arrows();
          ctx.say('Go! Round the lit pylon');
          ctx.sfx('ding');
        } else {
          this.lap++;
          if (this.lap >= this.laps) {
            this.state = 'done';
            ctx.sfx('finish');
            this.#light();
            return;
          }
          ctx.say(`Lap ${this.lap + 1} of ${this.laps}`);
          ctx.sfx('ding');
        }
        this.next = 0;
        this.#light();
      }
      return;
    }
    const p = this.nextPylon;
    const n = this.next + 1;
    const far = _c.copy(p.base).addScaledVector(p.dir, 200);
    if (crossSegment2D(p0.x, p0.z, p1.x, p1.z, p.base.x, p.base.z, far.x, far.z)) {
      this.next = this.next + 1 >= this.pylons.length ? -1 : this.next + 1;
      ctx.sfx('tick');
      ctx.say(this.next === -1 ? 'Now over the line' : `Pylon ${n} round: on to ${this.next + 1}`);
      this.#light();
      return;
    }
    const centre = at(this.env, 0, 0, 0);
    if (crossSegment2D(p0.x, p0.z, p1.x, p1.z, p.base.x, p.base.z, centre.x, centre.z)) {
      this.cuts++;
      ctx.say(`Cut pylon ${n}! Go back round it`);
      ctx.sfx('fail');
    }
  }

  status() {
    if (this.state === 'ready') return { line: 'Cross the start line (either way) to start' };
    if (this.state === 'done') return { line: `${this.laps} laps` };
    return { line: `Lap ${this.lap + 1} of ${this.laps} · ${this.next === -1 ? 'to the line' : `pylon ${this.next + 1}`}` };
  }

  target() {
    if (this.state === 'done') return null;
    if (this.next === -1) return _c.lerpVectors(this.lineA, this.lineB, 0.5).setY(this.lineA.y + 3);
    const p = this.nextPylon;
    return _c.copy(p.base).setY(p.base.y + this.h);
  }

  score(time) {
    return { value: time, text: fmt(time) };
  }
}

// --- Streamer cutting ------------------------------------------------------

/** World position of a body-axes point of a pose. */
function fromBody(pose, x, y, z, out) {
  return out.set(x, y, z).applyQuaternion(pose.q).add(pose.p);
}

/**
 * A model aeroplane flying itself round a loop, towing a streamer from
 * each wing tip. Not a flight model: it follows its path, banked for the
 * turn.
 */
export class Drone {
  /**
   * @param {object} o { path(s) -> Vector3 (s 0..1 round the loop), speed, entry (aircraft), span, colour }
   */
  constructor(o, env) {
    this.o = o;
    this.env = env;
    this.s = o.start ?? 0;
    this.span = o.span;
    this.pose = { p: new Vector3(), q: new Quaternion() };
    this.vel = new Vector3();
    this.down = null; // crashed: { v, spin }
    this.ribbons = [new Ribbon({ length: o.length, color: o.colour, seed: o.seed }), new Ribbon({ length: o.length, color: o.colour, seed: o.seed + 1.7 })];
    this.meshes = this.ribbons.map((r) => new RibbonMesh(r));
    this.#place(0);
    for (const [i, r] of this.ribbons.entries()) r.place(this.tip(i, _a), _b.copy(this.vel).normalize().negate());
  }

  /** Wing tip (0 left, 1 right) in the world. */
  tip(i, out) {
    return fromBody(this.pose, -0.05 * this.span, 0, (i ? 1 : -1) * this.span * 0.48, out);
  }

  get out() {
    return this.ribbons.every((r) => r.count < 3);
  }

  #place(dt) {
    const path = this.o.path;
    // Constant speed round the loop.
    const ds = 1e-3;
    const d = path(this.s + ds).sub(path(this.s)).length() / ds;
    this.s = (this.s + (this.o.speed * dt) / Math.max(1e-3, d)) % 1;
    const p = path(this.s);
    const f = path(this.s + ds).sub(path(this.s - ds)).divideScalar(2 * ds);
    const acc = path(this.s + ds).add(path(this.s - ds)).sub(_c.copy(p).multiplyScalar(2)).divideScalar(ds * ds);
    // Into real units: velocity and the acceleration along the path at this speed.
    const sp = f.length();
    const v = f.multiplyScalar(this.o.speed / sp);
    const ac = acc.multiplyScalar((this.o.speed / sp) ** 2);
    const x = v.clone().normalize();
    const lift = ac.add(new Vector3(0, 9.81, 0));
    const y = lift.sub(x.clone().multiplyScalar(lift.dot(x))).normalize();
    const z = new Vector3().crossVectors(x, y);
    // Rolling smoothly into and out of the turns, as a pilot would.
    const want = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    if (dt > 0) this.pose.q.slerp(want, 1 - Math.exp(-dt / 0.5));
    else this.pose.q.copy(want);
    this.pose.p.copy(p);
    this.vel.copy(v);
  }

  update(dt, ctx) {
    if (this.down) {
      // Tumbling down after a mid-air.
      if (this.pose.p.y > this.env.ground.heightAt(this.pose.p.x, this.pose.p.z) + 0.2) {
        this.vel.y -= 9.81 * dt;
        this.pose.p.addScaledVector(this.vel, dt);
        this.pose.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0.3, 0).normalize(), this.down.spin * dt));
      } else this.vel.set(0, 0, 0);
    } else this.#place(dt);
    this.ribbons.forEach((r, i) => r.step(dt, this.tip(i, _a), ctx.wind, ctx.floor));
    for (const m of this.meshes) m.update();
  }
}

export class Streamers {
  static id = 'streamers';
  static title = 'Streamer cutting';
  static about = 'Three model aeroplanes fly slowly round towing a crepe-paper streamer from each wing tip. Cut them with your wings or prop, again and again, down to the stubs. Don\'t hit the aeroplanes! In multiplayer you tow streamers too, and everyone can cut everyone\'s.';

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.cuts = 0;
    this.loose = []; // cut-off pieces falling
    const a = env.arena;
    const R = a.r;
    // At steady heights above the course's middle (not following every
    // bump in the ground below, which made them twitch about).
    const P = (u, v, h) => {
      const [x, z] = arenaToWorld(a, u, v);
      return new Vector3(x, a.g + h, z);
    };
    const paths = [
      // A wide oval, anticlockwise.
      (s) => { const t = s * Math.PI * 2; return P(Math.cos(t) * 0.65 * R, Math.sin(t) * 0.45 * R, 22); },
      // A big, lazy figure of eight, a little higher, gently up and down.
      (s) => { const t = s * Math.PI * 2; return P(Math.sin(t) * 0.75 * R, Math.sin(t) * Math.cos(t) * 1.0 * R, 28 + 1.5 * Math.sin(t)); },
      // An oval the other way round, lower.
      (s) => { const t = -s * Math.PI * 2; return P(Math.cos(t) * 0.5 * R, 0.1 * R + Math.sin(t) * 0.55 * R, 16); },
    ];
    const colours = ['#ff2a2a', '#ffd400', '#2a8cff'];
    this.drones = paths.map((path, k) => {
      const entry = env.droneTypes[k % env.droneTypes.length];
      const d = new Drone({ path, speed: lv(env, 6.5, 8, 11) + k * 0.5, length: lv(env, 12, 8, 6), span: entry.def.wingSpan || 1, colour: colours[k], seed: k * 11.3, start: k * 0.31 }, env);
      d.entry = entry;
      d.model = entry.createModel();
      d.proxy = env.makeProxy(entry);
      d.model.setPilotVisible?.(true);
      this.group.add(d.model.root);
      for (const m of d.meshes) this.group.add(m.mesh);
      return d;
    });
  }

  update(ctx) {
    const dt = ctx.dt;
    for (const d of this.drones) {
      d.update(dt, ctx);
      d.model.root.position.copy(d.pose.p);
      d.model.root.quaternion.copy(d.pose.q);
      d.proxy.position.copy(d.pose.p);
      d.proxy.orientation.copy(d.pose.q);
      d.proxy.velocity.copy(d.vel);
      d.proxy.rpm = d.proxy.motorRpm = d.down ? 0 : 9000;
      d.model.update(d.proxy, dt);
    }
    // Loose pieces flutter down, and go after a while on the ground.
    for (const l of this.loose) {
      l.ribbon.step(dt, null, ctx.wind, ctx.floor);
      l.mesh.update();
    }
    for (const l of this.loose.filter((x) => x.ribbon.age > 25)) {
      this.group.remove(l.mesh.mesh);
      l.mesh.dispose();
    }
    this.loose = this.loose.filter((x) => x.ribbon.age <= 25);
    if (this.state === 'ready' && !ctx.ac.held && !ctx.ac.onGround && ctx.ac.velocity.length() > 3) this.state = 'running';
    if (this.state === 'done' || ctx.ac.crashed) return;
    for (const d of this.drones) {
      // Mid-air with a drone.
      if (!d.down && d.pose.p.distanceTo(ctx.pose.p) < 0.3 * (d.span + ctx.span)) {
        d.down = { spin: 6 };
        ctx.ac.crash('Collided with a streamer plane');
        ctx.sfx('fail');
        return;
      }
      for (const r of d.ribbons) {
        if (this.tryCut(r, ctx)) {
          this.cuts++;
          ctx.sfx('cut');
          ctx.say(d.out ? 'Cut! That one\'s done' : `Cut! ${this.cuts} so far`);
        }
      }
    }
    if (this.drones.every((d) => d.out)) {
      this.state = 'done';
      ctx.sfx('finish');
    }
  }

  /** Cut a ribbon if the aeroplane touches it this frame; the rest falls. Returns true on a cut. */
  tryCut(r, ctx) {
    if (r.count < 1) return false;
    if (r.points[0].distanceTo(ctx.pose.p) > r.count * 0.5 + ctx.span + ctx.sweep + 1) return false;
    for (let i = 1; i <= r.count; i++) {
      toBody(ctx.pose, r.points[i - 1], _A);
      toBody(ctx.pose, r.points[i], _B);
      const t = segmentTouches(ctx.shape, _A, _B, ctx.sweep);
      if (t < 0) continue;
      this.drop(r.cut(i, t));
      return true;
    }
    return false;
  }

  /** A cut-off piece: let it fall. */
  drop(piece) {
    if (!piece) return;
    const mesh = new RibbonMesh(piece);
    this.group.add(mesh.mesh);
    this.loose.push({ ribbon: piece, mesh });
  }

  status() {
    const left = this.drones.reduce((n, d) => n + d.ribbons.reduce((m, r) => m + (r.count >= 3 ? 1 : 0), 0), 0);
    return { line: `${this.cuts} cuts · ${left} streamer${left === 1 ? '' : 's'} left` };
  }

  target() {
    // The nearest aeroplane with streamer left.
    let best = null;
    let bd = Infinity;
    for (const d of this.drones) {
      if (d.out || d.down) continue;
      const dist = d.pose.p.distanceTo(this.env.me?.position ?? d.pose.p);
      if (dist < bd) {
        bd = dist;
        best = d.pose.p;
      }
    }
    return best;
  }

  score(time) {
    return { value: time, text: `${fmt(time)} (${this.cuts} cuts)` };
  }

  dispose() {
    for (const d of this.drones) for (const m of d.meshes) m.dispose();
    for (const l of this.loose) l.mesh.dispose();
  }
}

// --- Spot landing ------------------------------------------------------------

export const SPOT_RINGS = [2, 5, 10]; // m: the white rings round the bullseye
const SPOT_BULL = 1; // m: the red bullseye's radius

/**
 * Take off, climb to the height, fly a full circuit round the spot, then
 * cut the throttle and land as close to the spot as you can. Scored by how
 * far from its centre you touch down.
 */
export class SpotLanding {
  static id = 'spot';
  static title = 'Spot landing';
  static about = 'Take off and climb to 10 m, fly a nice gentle 360° turn (anywhere: a quick spin round doesn\'t count), then cut the throttle right back and glide in to land as close to the middle of the spot as you can. Scored by where you first touch down. Touch the throttle again after cutting it, or crash on landing, and there\'s no score.';

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.stage = 'climb'; // climb | circuit | glide | rolling | landed
    this.climb = lv(env, 10, 10, 20); // m above the ground to reach
    this.minR = lv(env, 10, 15, 20); // m: the 360 only counts while the turn is at least this wide
    this.lastTrack = null; // the way it was flying last frame (radians)
    this.rate = 0; // how fast it's turning, smoothed (rad/s)
    this.radius = Infinity; // and so how wide the turn is (m)
    this.turned = 0; // degrees round the spot so far
    this.result = null; // { dist, void?, why? }
    // The spot: the middle of the runway (or the course's middle if
    // something stands there).
    const rw = LOCATION.layout.runway;
    let [x, z] = clubToWorld(rw.x, rw.z);
    if (blocked(env.obstacles, env.ground, x, env.ground.heightAt(x, z) + 1, z)) [x, z] = [env.arena.x, env.arena.z];
    this.spot = new Vector3(x, env.ground.heightAt(x, z), z);
    // Painted on the grass: a red bullseye, white rings, orange cones round the outside.
    const paint = (geo, color) => {
      const m = new Mesh(geo, new MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(this.spot).setY(this.spot.y + 0.04);
      m.renderOrder = 2;
      this.group.add(m);
      return m;
    };
    paint(new CircleGeometry(SPOT_BULL, 40), '#e02020');
    for (const r of SPOT_RINGS) paint(new RingGeometry(r - 0.12, r + 0.12, 72), '#ffffff');
    paint(new RingGeometry(0.02, 0.18, 16), '#ffffff'); // centre dot
    const cone = new ConeGeometry(0.22, 0.6, 12);
    const coneMat = new MeshStandardMaterial({ color: '#ff6a10', roughness: 0.6 });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = SPOT_RINGS[SPOT_RINGS.length - 1] + 1;
      const cx = x + Math.cos(a) * r;
      const cz = z + Math.sin(a) * r;
      const c = new Mesh(cone, coneMat);
      c.position.set(cx, env.ground.heightAt(cx, cz) + 0.3, cz);
      c.castShadow = true;
      this.group.add(c);
    }
    // Where you touched down: a little flag, shown once you have.
    this.mark = new Group();
    const pole = new Mesh(new CylinderGeometry(0.02, 0.02, 1.2, 6), new MeshStandardMaterial({ color: '#eeeeee' }));
    pole.position.y = 0.6;
    const flag = new Mesh(new PlaneGeometry(0.5, 0.32), new MeshStandardMaterial({ color: '#1a5cff', side: DoubleSide }));
    flag.position.set(0.25, 1.04, 0);
    this.mark.add(pole, flag);
    this.mark.visible = false;
    this.group.add(this.mark);
  }

  update(ctx) {
    const ac = ctx.ac;
    if (this.state === 'done') return;
    const p = ctx.pose.p;
    const agl = p.y - this.env.ground.heightAt(p.x, p.z);
    const stick = ac.controls?.throttle ?? ac.throttleActual ?? 0;
    this.stick = stick;
    if (this.state === 'ready' && !ac.held && !ac.onGround && ac.velocity.length() > 3) this.state = 'running';
    if (this.state !== 'running') return;
    if (ac.crashed) {
      if (this.stage === 'glide' || this.stage === 'rolling') this.#void(ctx, 'Crashed landing: no score');
      return;
    }
    switch (this.stage) {
      case 'climb':
        if (agl >= this.climb) {
          this.stage = 'circuit';
          ctx.say(`${this.climb} m! Now a nice gentle 360° turn`);
          ctx.sfx('ding');
        }
        break;
      case 'circuit': {
        // A gentle 360: the way it's flying (its track over the ground)
        // swings right round, while high enough, in a turn at least minR
        // wide (a quick spin round doesn't count). Anywhere on the field.
        const dx = p.x - ctx.prev.x;
        const dz = p.z - ctx.prev.z;
        const step = Math.hypot(dx, dz);
        if (step > 1e-3 && ctx.dt > 0) {
          const track = Math.atan2(dz, dx);
          if (this.lastTrack !== null) {
            const d = Math.atan2(Math.sin(track - this.lastTrack), Math.cos(track - this.lastTrack));
            // Turn rate smoothed over about half a second; width = speed / rate.
            this.rate += (d / ctx.dt - this.rate) * Math.min(1, ctx.dt / 0.5);
            this.radius = Math.abs(this.rate) > 1e-3 ? step / ctx.dt / Math.abs(this.rate) : Infinity;
            this.high = agl >= this.climb;
            this.wide = this.radius >= this.minR;
            if (this.high && this.wide) this.turned += (d * 180) / Math.PI;
          }
          this.lastTrack = track;
        }
        if (ac.onGround) this.#nag(ctx, 'Landed before finishing the 360: take off again');
        if (Math.abs(this.turned) >= 360) {
          this.stage = 'cut';
          ctx.say('360° done! Cut the throttle and land on the spot');
          ctx.sfx('ding');
        }
        break;
      }
      case 'cut':
        // Waiting for the throttle to be cut right back.
        if (stick <= 0.02) {
          this.stage = 'glide';
          ctx.say('Power off: glide in to the spot');
          ctx.sfx('tick');
        } else if (ac.onGround) this.#nag(ctx, 'Cut the throttle first!');
        break;
      case 'glide':
        if (stick > 0.05) {
          this.#void(ctx, 'Throttle opened after the cut: no score');
          return;
        }
        if (ac.onGround) {
          // Touched down: this is where it's measured from.
          this.touch = new Vector3(p.x, this.env.ground.heightAt(p.x, p.z), p.z);
          this.mark.position.copy(this.touch);
          this.mark.visible = true;
          this.stage = 'rolling';
          this.rollTime = 0;
        }
        break;
      case 'rolling':
        // A moment to be sure it was a landing, not a crash.
        if (stick > 0.05) {
          this.#void(ctx, 'Throttle opened after the cut: no score');
          return;
        }
        this.rollTime += ctx.dt;
        if (this.rollTime > 1.5 || ac.velocity.length() < 0.5) {
          const dist = Math.hypot(this.touch.x - this.spot.x, this.touch.z - this.spot.z);
          this.result = { dist };
          this.stage = 'landed';
          this.state = 'done';
          ctx.sfx(dist <= SPOT_BULL ? 'finish' : 'ding');
        }
        break;
      default:
    }
  }

  /** A reminder, but not every frame. */
  #nag(ctx, text) {
    if (this.nagged === text && ctx.time - this.naggedAt < 4) return;
    this.nagged = text;
    this.naggedAt = ctx.time;
    ctx.say(text);
  }

  #void(ctx, why) {
    this.result = { void: true, why };
    this.stage = 'landed';
    this.state = 'done';
    ctx.say(why);
    ctx.sfx('fail');
  }

  /** How good a landing at `dist` metres was. */
  static grade(dist) {
    if (dist <= SPOT_BULL) return 'Bullseye!';
    if (dist <= SPOT_RINGS[0]) return 'Superb';
    if (dist <= SPOT_RINGS[1]) return 'Good';
    if (dist <= SPOT_RINGS[2]) return 'On the spot';
    return 'Missed the spot';
  }

  /**
   * The steps, for the checklist on screen: [{ text, detail?, state:
   * 'done' | 'now' | 'todo' | 'failed' }].
   */
  steps() {
    const p = this.env.me?.position;
    const agl = p ? Math.max(0, p.y - this.env.ground.heightAt(p.x, p.z)) : 0;
    const order = ['takeoff', 'climb', 'circuit', 'cut', 'glide', 'landed'];
    const at = this.state === 'ready' ? 0 : this.stage === 'rolling' ? 4 : order.indexOf(this.stage);
    const st = (i) => (i < at ? 'done' : i === at ? 'now' : 'todo');
    // (Height, degrees and distance are the big number in the box at the
    // top: here only what that doesn't say.)
    let why = '';
    if (at === 2 && agl < this.climb) why = `too low: back up to ${this.climb} m`;
    else if (at === 2 && this.wide === false) why = 'too tight: turn more gently';
    const list = [
      { text: 'Take off', detail: at === 0 ? 'throttle up' : '' },
      { text: `Climb to ${this.climb} m`, detail: '' },
      { text: 'Fly a gentle 360° turn', detail: at === 2 ? why : '' },
      { text: 'Cut the throttle right back', detail: at === 3 ? `throttle at ${Math.round((this.stick ?? 0) * 100)}%` : at > 3 ? 'keep it off!' : '' },
      { text: 'Glide in and land on the spot', detail: '' },
    ].map((x, i) => ({ ...x, state: st(i) }));
    if (this.stage === 'landed') {
      for (const x of list) x.state = 'done';
      if (this.result?.void) list[list.length - 1].state = 'failed';
    }
    return list;
  }

  status() {
    const p = this.env.me?.position;
    switch (this.stage) {
      case 'climb': {
        const agl = p ? Math.max(0, p.y - this.env.ground.heightAt(p.x, p.z)) : 0;
        return { line: `Take off and climb to ${this.climb} m`, big: `${Math.round(agl)} m` };
      }
      case 'circuit':
        return { line: `A gentle 360° turn, ${this.climb} m up or more`, big: `${Math.min(360, Math.round(Math.abs(this.turned)))}° / 360°` };
      case 'cut':
        return { line: 'Cut the throttle right back', big: 'CUT' };
      case 'glide':
      case 'rolling': {
        const d = p ? Math.hypot(p.x - this.spot.x, p.z - this.spot.z) : 0;
        return { line: 'Glide in and land on the spot', big: `${Math.round(d)} m` };
      }
      default:
        if (this.result?.void) return { line: this.result.why, big: '–' };
        return { line: SpotLanding.grade(this.result.dist), big: `${this.result.dist.toFixed(1)} m` };
    }
  }

  target() {
    return this.stage === 'glide' || this.stage === 'cut' ? this.spot : null;
  }

  score() {
    if (this.result?.void) return { void: true, text: this.result.why };
    const d = this.result.dist;
    return { value: Math.round(d * 10) / 10, text: `${d.toFixed(1)} m from the spot (${SpotLanding.grade(d)})` };
  }
}

export const COURSES = [Hoops, Balloons, Limbo, Pylons, Streamers, SpotLanding];
