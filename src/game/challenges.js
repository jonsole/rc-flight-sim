// Challenges (Menu → Challenges): hoops, balloon burst, limbo, a pylon race,
// streamer cutting and spot landing, laid out in the most open part of the field
// (src/game/arena.js). This runs the chosen course (src/game/courses.js):
// its clock, best scores (kept in this browser per field), the HUD, the
// marker pointing at what's next, and the sounds. Pressing R (reset)
// starts the course again.
//
// Streamer cutting in multiplayer: everyone in the challenge tows two
// streamers. Each player sends how much of theirs is left with their
// state (`rib`), and a cut of someone else's (`cut: [[id, side, segments]]`);
// the owner shortens theirs when told.
import { Vector3 } from 'three';
import { findArena } from './arena.js';
import { COURSES, Streamers, formatTime, LEVELS } from './courses.js';
import { Ribbon, RibbonMesh } from './ribbon.js';
import { bodyShape } from './geom.js';
import { LOCATION } from '../sim/location.js';
import { getAircraft } from '../aircraft/index.js';

export { LEVELS };
export const MINUTES = [2, 5, 10]; // balloon burst time limits

/**
 * Best-score key: per challenge, difficulty and field (and the balloon
 * burst's time limit). Normal keeps the key used before there were
 * levels, so earlier bests still count.
 */
export function bestKey(mode, level, field, minutes) {
  if (mode === 'balloons') return `balloons:${level}:${minutes}min:${field}`;
  return level === 'normal' ? `${mode}:${field}` : `${mode}:${level}:${field}`;
}

export const MODES = { none: { title: 'Free flying', about: 'No challenge: just fly.' } };
for (const C of COURSES) MODES[C.id] = { title: C.title, about: C.about, Course: C };

const BEST_KEY = 'rcsim.best.v1';
const _v = new Vector3();
const _w = new Vector3();
const _c = new Vector3();

export function loadBest() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveBest(all) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked */
  }
}

/** Short synthesised sounds for the challenges. */
function sfx(sound, kind) {
  const ctx = sound?.ctx;
  if (!ctx || sound.muted) return;
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.5 * (sound.volume ?? 0.6);
  out.connect(ctx.destination);
  const tone = (f0, f1, start, len, type = 'sine', vol = 0.5) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t + start);
    o.frequency.exponentialRampToValueAtTime(f1, t + start + len);
    g.gain.setValueAtTime(0, t + start);
    g.gain.linearRampToValueAtTime(vol, t + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + start + len);
    o.connect(g).connect(out);
    o.start(t + start);
    o.stop(t + start + len + 0.05);
  };
  const noise = (len, freq, q, vol) => {
    const n = Math.round(ctx.sampleRate * len);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    s.connect(f).connect(g).connect(out);
    s.start(t);
  };
  switch (kind) {
    case 'pop': noise(0.12, 1800, 0.6, 3); tone(300, 80, 0, 0.08, 'triangle', 0.4); break;
    case 'cut': noise(0.18, 4000, 1.2, 1.6); break;
    case 'ding': tone(880, 880, 0, 0.25); tone(1320, 1320, 0.08, 0.3); break;
    case 'tick': tone(1200, 1200, 0, 0.08, 'square', 0.15); break;
    case 'bump': tone(160, 90, 0, 0.15, 'triangle', 0.5); break;
    case 'fail': tone(330, 140, 0, 0.45, 'sawtooth', 0.25); break;
    case 'finish': [523, 659, 784, 1047].forEach((f, i) => tone(f, f, i * 0.11, 0.35, 'triangle', 0.4)); break;
    default:
  }
  setTimeout(() => out.disconnect(), 2000);
}

export class Challenges {
  /**
   * @param {object} o { scene, obstacles, ground, wind, sound, aircraftTypes() -> entries for the
   *                     streamer planes, makeProxy(entry), root (HUD element), marker (element) }
   */
  constructor(o) {
    this.o = o;
    this.mode = 'none';
    this.level = 'normal'; // LEVELS
    this.minutes = 5; // balloon burst time limit
    this.course = null;
    this.arena = null;
    this.time = 0; // the clock (s)
    this.clock = 0; // for animations
    this.finished = null; // { text, best, record }
    this.prev = new Vector3();
    this.hasPrev = false;
    this.mine = null; // your own streamers: [{ ribbon, mesh }]
    this.theirs = new Map(); // peer id -> { ribbons, meshes, sent: [n, n] }
    this.pendingCuts = [];
    this.msgTimer = 0;
    this.#buildHud();
  }

  #buildHud() {
    const root = this.o.root;
    if (!root) return;
    root.innerHTML = '<div class="ch-title"></div><div class="ch-big"></div><div class="ch-line"></div><div class="ch-best"></div>';
    this.hud = {
      title: root.querySelector('.ch-title'),
      big: root.querySelector('.ch-big'),
      line: root.querySelector('.ch-line'),
      best: root.querySelector('.ch-best'),
    };
    this.msg = document.createElement('div');
    this.msg.id = 'challenge-msg';
    root.after(this.msg);
  }

  get active() {
    return !!this.course;
  }

  /** Best-score key: per challenge and field. */
  get key() {
    return bestKey(this.mode, this.level, LOCATION.id, this.minutes);
  }

  /** Difficulty and the balloon burst's time limit; take effect at the next restart. */
  setLevel(level, minutes = this.minutes) {
    this.level = LEVELS[level] ? level : 'normal';
    this.minutes = MINUTES.includes(Number(minutes)) ? Number(minutes) : 5;
  }

  /**
   * The aircraft was reset (R): start the challenge again, except in the
   * middle of a timed one (balloon burst), where you just fly on with the
   * clock still running.
   */
  onReset() {
    if (this.course?.limit && this.course.state === 'running') {
      this.hasPrev = false;
      return;
    }
    this.restart();
  }

  /** Choose the challenge ('none' for free flying); `restart` false leaves it for the next reset. */
  setMode(mode, restart = true) {
    if (!MODES[mode]) mode = 'none';
    this.mode = mode;
    if (restart) this.restart();
  }

  /** The scenery changed (editor): find the open sky again. */
  relayout() {
    this.arena = null;
    if (this.course) this.restart();
  }

  /** (Re)build the course from scratch: clock to zero. */
  restart() {
    this.#clear();
    this.finished = null;
    this.time = 0;
    this.hasPrev = false;
    const M = MODES[this.mode];
    document.body.classList.toggle('challenge', !!M.Course);
    if (!M.Course) {
      if (this.o.root) this.o.root.style.display = 'none';
      if (this.o.marker) this.o.marker.style.display = 'none';
      return;
    }
    this.arena ||= findArena(this.o.obstacles, this.o.ground);
    const env = {
      arena: this.arena,
      ground: this.o.ground,
      obstacles: this.o.obstacles,
      level: this.level,
      minutes: this.minutes,
      droneTypes: this.o.aircraftTypes?.() ?? [],
      makeProxy: this.o.makeProxy,
    };
    this.course = new M.Course(env);
    this.o.scene.add(this.course.group);
    if (M.Course === Streamers) this.#towMine();
    if (this.o.root) this.o.root.style.display = '';
    this.say(M.title);
  }

  #clear() {
    if (this.course) {
      this.o.scene.remove(this.course.group);
      this.course.dispose?.();
      this.course.group.traverse((x) => x.geometry?.dispose());
      this.course = null;
    }
    for (const m of this.mine ?? []) {
      this.o.scene.remove(m.mesh.mesh);
      m.mesh.dispose();
    }
    this.mine = null;
    for (const id of [...this.theirs.keys()]) this.#dropPeer(id);
    this.pendingCuts.length = 0;
  }

  /** Your own pair of streamers (streamer cutting). */
  #towMine() {
    this.mine = ['#ff40c0', '#ff40c0'].map((color, i) => {
      const ribbon = new Ribbon({ color, seed: 50 + i * 2.3 });
      const mesh = new RibbonMesh(ribbon);
      this.o.scene.add(mesh.mesh);
      return { ribbon, mesh, placed: false };
    });
  }

  #dropPeer(id) {
    const t = this.theirs.get(id);
    if (!t) return;
    for (const m of t.meshes) {
      this.o.scene.remove(m.mesh);
      m.dispose();
    }
    this.theirs.delete(id);
  }

  /** A flash message in the middle of the screen. */
  say(text) {
    if (!this.msg) return;
    this.msg.textContent = text;
    this.msg.classList.remove('show');
    void this.msg.offsetWidth; // restart the fade
    this.msg.classList.add('show');
  }

  sfx(kind) {
    sfx(this.o.sound, kind);
  }

  /** Extra state to send with this aeroplane's (multiplayer). */
  netState() {
    const out = {};
    if (this.mine) out.rib = this.mine.map((m) => m.ribbon.count);
    if (this.pendingCuts.length) {
      out.cut = this.pendingCuts.slice(0, 8);
      this.pendingCuts.length = 0;
    }
    return out;
  }

  /** Someone cut one of your streamers. */
  onCut(name, side, count) {
    const m = this.mine?.[side];
    if (!m || count >= m.ribbon.count) return;
    const piece = m.ribbon.cut(Math.max(1, count + 1), 0.5);
    this.course?.drop?.(piece);
    this.say(`${name} cut your streamer!`);
    this.sfx('cut');
  }

  /**
   * Every frame.
   * @param {number} dt
   * @param {object} c { aircraft, entry, camera, paused, peers (view/peers.js), mp (net/multiplayer.js) }
   */
  update(dt, c) {
    if (!this.course) return;
    const ac = c.aircraft;
    const wind = (p, out) => this.o.wind.at(p, 0, out);
    const floor = (x, z) => this.o.ground.heightAt(x, z);
    if (!this.hasPrev || ac.position.distanceTo(this.prev) > 30) {
      this.prev.copy(ac.position); // (after a reset: no step to check)
      this.hasPrev = true;
    }
    const span = c.entry.def.wingSpan || 1;
    const step = dt > 0 ? ac.position.distanceTo(this.prev) : 0;
    const ctx = {
      dt: c.paused ? 0 : dt,
      time: (this.clock += c.paused ? 0 : dt),
      ac,
      pose: { p: ac.position, q: ac.orientation },
      prev: this.prev,
      span,
      shape: bodyShape(span),
      sweep: step,
      wind,
      floor,
      say: (t) => this.say(t),
      sfx: (k) => this.sfx(k),
    };
    this.course.env.me = ac;
    if (!c.paused) {
      const was = this.course.state;
      this.course.update(ctx);
      const limit = this.course.limit;
      // (A timed challenge's clock keeps going through a crash.)
      if (this.course.state === 'running' && (!ac.crashed || limit)) this.time += dt;
      if (limit && this.course.state === 'running' && this.time >= limit) {
        this.time = limit;
        this.course.state = 'done';
        this.sfx('finish');
      }
      if (was !== 'done' && this.course.state === 'done') this.#finish();
      this.#streamers(ctx, c);
    }
    this.prev.copy(ac.position);
    this.#hud(ac, c.camera);
  }

  /** Your streamers, other players' streamers, and cutting theirs. */
  #streamers(ctx, c) {
    const ac = ctx.ac;
    const span = ctx.span;
    if (this.mine) {
      this.mine.forEach((m, i) => {
        _v.set(-0.05 * span, 0, (i ? 1 : -1) * span * 0.48).applyQuaternion(ac.orientation).add(ac.position);
        if (!m.placed) {
          m.ribbon.place(_v, _w.set(-1, 0, 0).applyQuaternion(ac.orientation).setY(0).normalize());
          m.placed = true;
        }
        m.ribbon.step(ctx.dt, _v, ctx.wind, ctx.floor);
        m.mesh.update();
      });
    }
    // Other players towing streamers.
    const peers = c.mp?.connected ? c.mp.peers : new Map();
    for (const id of [...this.theirs.keys()]) if (!peers.has(id)) this.#dropPeer(id);
    if (!(this.course instanceof Streamers)) return;
    for (const peer of peers.values()) {
      const view = c.peers?.views.get(peer.id);
      const st = view?.pose.state;
      if (!view || !st || !Array.isArray(st.rib) || !view.model.root.visible) {
        if (this.theirs.has(peer.id) && !(st && Array.isArray(st.rib))) this.#dropPeer(peer.id);
        continue;
      }
      const pspan = getAircraft(peer.aircraft)?.def.wingSpan || 1;
      let t = this.theirs.get(peer.id);
      const tip = (i, out) => out.set(-0.05 * pspan, 0, (i ? 1 : -1) * pspan * 0.48).applyQuaternion(view.pose.q).add(view.pose.p);
      if (!t) {
        const ribbons = [0, 1].map((i) => new Ribbon({ color: '#ff40c0', seed: peer.id * 7 + i * 2.3 }));
        ribbons.forEach((r, i) => r.place(tip(i, _v), _w.set(-1, 0, 0).applyQuaternion(view.pose.q).setY(0).normalize()));
        const meshes = ribbons.map((r) => new RibbonMesh(r));
        for (const m of meshes) this.o.scene.add(m.mesh);
        t = { ribbons, meshes };
        this.theirs.set(peer.id, t);
      }
      t.ribbons.forEach((r, i) => {
        // Cut by someone else (or reset: grown back).
        const n = Number(st.rib[i]) || 0;
        if (n < r.count) this.course.drop(r.cut(n + 1, 0.5));
        else if (n > r.count && n === r.max) {
          r.count = r.max;
          r.place(tip(i, _v), _w.set(-1, 0, 0).applyQuaternion(view.pose.q).setY(0).normalize());
        }
        r.step(ctx.dt, tip(i, _v), ctx.wind, ctx.floor);
        if (!ac.crashed && this.course.state !== 'done' && this.course.tryCut(r, ctx)) {
          this.course.cuts++;
          this.pendingCuts.push([peer.id, i, r.count]);
          this.say(`Cut ${peer.name}'s streamer!`);
          this.sfx('cut');
        }
      });
      for (const m of t.meshes) m.update();
    }
  }

  #finish() {
    const s = this.course.score(this.time);
    if (s.void) {
      // (Disqualified: nothing to save.)
      this.finished = { text: s.text, void: true };
      return;
    }
    const Course = MODES[this.mode].Course;
    const all = loadBest();
    const old = all[this.key];
    const better = !old || (Course.higher ? s.value > old.value : s.value < old.value);
    if (better && (!Course.higher || s.value > 0)) {
      all[this.key] = { value: s.value, text: s.text, aircraft: this.o.aircraftName?.() ?? '', date: Date.now() };
      saveBest(all);
    }
    this.finished = { text: s.text, record: better && !!old };
    const end = this.course.limit ? 'Time\'s up' : 'Finished';
    this.say(better && old ? `New best! ${s.text}` : `${end}: ${s.text}`);
  }

  #hud(ac, camera) {
    if (!this.hud) return;
    const M = MODES[this.mode];
    const st = this.course.status();
    const best = loadBest()[this.key];
    this.hud.title.textContent = `${M.title} · ${LEVELS[this.level]}`;
    const limit = this.course.limit;
    let big = st.big ?? formatTime(limit ? Math.max(0, limit - this.time) : this.time);
    let line = st.line;
    if (ac.crashed && this.course.state !== 'done') line = limit && this.course.state === 'running' ? 'Crashed: R to fly on (the clock\'s running)' : 'Crashed: R to try again';
    if (this.finished) line = this.finished.void ? `${this.finished.text} · R to go again` : `${this.finished.record ? 'New best! ' : 'Done! '}${this.finished.text} · R to go again`;
    if (this.mode === 'limbo' && this.course.state === 'done') big = `${this.course.passes} under`;
    this.hud.big.textContent = big;
    this.hud.line.textContent = line;
    this.hud.best.textContent = best ? `Best ${best.text}${best.aircraft ? ` (${best.aircraft})` : ''}` : '';
    this.#marker(camera, ac);
  }

  /** Pointer to what's next: round it when in view, on the screen edge when not. */
  #marker(camera, ac) {
    const el = this.o.marker;
    if (!el) return;
    const t = this.course.target();
    if (!t || !camera) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dist = t.distanceTo(ac.position);
    el.querySelector('.d').textContent = `${Math.round(dist)} m`;
    _c.copy(t).applyMatrix4(camera.matrixWorldInverse);
    _v.copy(t).project(camera);
    const inView = _c.z < 0 && Math.abs(_v.x) <= 0.95 && Math.abs(_v.y) <= 0.95;
    el.classList.toggle('edge', !inView);
    let x;
    let y;
    if (inView) {
      x = ((_v.x + 1) / 2) * w;
      y = ((1 - _v.y) / 2) * h;
      el.querySelector('.a').style.transform = '';
    } else {
      let u = _c.x;
      let v = _c.y;
      if (_c.z > 0) v -= _c.z * 0.7;
      const len = Math.hypot(u, v) || 1;
      u /= len;
      v /= len;
      const k = Math.min((w / 2 - 40) / Math.max(1e-6, Math.abs(u)), (h / 2 - 60) / Math.max(1e-6, Math.abs(v)));
      x = w / 2 + u * k;
      y = h / 2 - v * k;
      el.querySelector('.a').style.transform = `rotate(${Math.atan2(u, v)}rad)`;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }
}
