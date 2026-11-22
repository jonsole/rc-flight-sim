// Crepe-paper streamers, towed from the wing tips in the streamer-cutting
// challenge: a chain of points (Verlet) that falls under gravity, is dragged
// hard towards the wind's speed, and flutters, tied at one end to the tow
// point. Cutting one leaves the front part on the aeroplane and drops the
// rest, which flutters down to the ground.
import { Vector3, BufferGeometry, BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide } from 'three';

export const SEG = 0.5; // m between points
const DRAG = 7; // 1/s: paper falls at about g / DRAG = 1.4 m/s
const G = 9.81;
const _v = new Vector3();
const _w = new Vector3();
const _t = new Vector3();
const _s = new Vector3();
const _s2 = new Vector3();
const UP = new Vector3(0, 1, 0);

export class Ribbon {
  /**
   * @param {object} o  { length (m), width (m), color, seed }
   */
  constructor({ length = 8, width = 0.1, color = '#e83030', seed = Math.random() * 100 } = {}) {
    this.max = Math.round(length / SEG); // segments when whole
    this.count = this.max;
    this.width = width;
    this.color = color;
    this.seed = seed;
    this.attached = true;
    this.points = Array.from({ length: this.max + 1 }, () => new Vector3());
    this.prev = Array.from({ length: this.max + 1 }, () => new Vector3());
    this.time = 0;
    this.age = 0; // seconds since it was cut off (a loose piece)
  }

  /** Metres of streamer left. */
  get length() {
    return this.count * SEG;
  }

  /** Laid out straight from `anchor` along `back` (a unit vector), at rest. */
  place(anchor, back) {
    for (let i = 0; i <= this.max; i++) {
      this.points[i].copy(anchor).addScaledVector(back, i * SEG);
      this.prev[i].copy(this.points[i]);
    }
  }

  /**
   * Move it on by dt. `anchor` is the tow point now (ignored for a loose
   * piece); `wind(pos, out)` gives the air's velocity; `floor(x, z)` the
   * ground height. Paper this light has next to no inertia: each point
   * drifts with the air, sinking at its falling speed, and flutters from
   * side to side harder the faster the air rushes past; then each is put
   * back a segment's length behind the one in front.
   */
  step(dt, anchor, wind, floor) {
    if (dt <= 0) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const a0 = this.attached ? _s2.copy(this.points[0]) : null;
    // How fast it's being pulled through the air (the tow point's speed).
    const speed = this.attached ? a0.distanceTo(anchor) / dt : 1.5;
    for (let k = 1; k <= n; k++) {
      this.time += h;
      if (!this.attached) this.age += h;
      if (this.attached) {
        this.prev[0].copy(this.points[0]);
        this.points[0].lerpVectors(a0, anchor, k / n);
      }
      const first = this.attached ? 1 : 0;
      for (let i = first; i <= this.count; i++) {
        const p = this.points[i];
        this.prev[i].copy(p);
        wind(p, _w);
        _w.y -= G / DRAG;
        // Flutter: a sideways wave running down the streamer, stronger at the tail.
        const along = Math.max(0.15, i / this.max);
        const f = Math.sin(this.time * 17 + this.seed - i * 0.9) * 0.22 * speed * along;
        _t.copy(this.points[Math.max(0, i - 1)]).sub(this.points[Math.min(this.count, i + 1)]);
        _s.crossVectors(_t, UP);
        if (_s.lengthSq() > 1e-6) _w.addScaledVector(_s.normalize(), f);
        _w.y += Math.cos(this.time * 13 + this.seed * 1.7 - i * 0.7) * 0.1 * speed * along;
        p.addScaledVector(_w, h);
        const g = floor(p.x, p.z) + 0.02;
        if (p.y < g) p.y = g;
      }
      // Each point a segment's length on from the one before.
      for (let i = 1; i <= this.count; i++) {
        _v.copy(this.points[i]).sub(this.points[i - 1]);
        const d = _v.length();
        if (d > 1e-6) this.points[i].copy(this.points[i - 1]).addScaledVector(_v, SEG / d);
        const g = floor(this.points[i].x, this.points[i].z) + 0.02;
        if (this.points[i].y < g) this.points[i].y = g;
      }
    }
  }

  /**
   * Cut it in segment i (between points i-1 and i), `t` of the way along:
   * this one keeps the front part; returns the loose rest (or null when
   * there was too little to fall).
   */
  cut(i, t = 0.5) {
    if (i < 1 || i > this.count) return null;
    const at = new Vector3().lerpVectors(this.points[i - 1], this.points[i], t);
    const rest = this.count - i + 1; // segments behind the cut
    let piece = null;
    if (rest >= 1) {
      piece = new Ribbon({ length: rest * SEG, width: this.width, color: this.color, seed: this.seed + 3 });
      piece.attached = false;
      piece.time = this.time;
      piece.points[0].copy(at);
      piece.prev[0].copy(at);
      for (let k = 1; k <= rest; k++) {
        piece.points[k].copy(this.points[i - 1 + k] ?? this.points[this.count]);
        piece.prev[k].copy(this.prev[i - 1 + k] ?? this.prev[this.count]);
      }
    }
    this.count = Math.max(0, i - 1);
    return piece;
  }

  /** Shorten to `count` segments (cut by someone else, in multiplayer). */
  shorten(count) {
    this.count = Math.max(0, Math.min(this.count, Math.round(count)));
  }
}

/** A streamer as drawn: a twisting strip, updated from its ribbon each frame. */
export class RibbonMesh {
  constructor(ribbon) {
    this.ribbon = ribbon;
    const n = ribbon.max + 1;
    const geo = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(n * 2 * 3), 3);
    geo.setAttribute('position', this.pos);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mesh = new Mesh(geo, new MeshBasicMaterial({ color: ribbon.color, side: DoubleSide }));
    this.mesh.frustumCulled = false;
    this.update();
  }

  update() {
    const r = this.ribbon;
    const P = r.points;
    const a = this.pos.array;
    const hw = r.width / 2;
    for (let i = 0; i <= r.count; i++) {
      _t.copy(P[Math.min(r.count, i + 1)]).sub(P[Math.max(0, i - 1)]);
      if (_t.lengthSq() < 1e-8) _t.set(1, 0, 0);
      _t.normalize();
      _s.crossVectors(_t, UP);
      if (_s.lengthSq() < 1e-6) _s.set(0, 0, 1);
      _s.normalize();
      // Twisting as it flutters (none at the tow point).
      const tw = Math.sin(r.time * 9 + r.seed - i * 0.8) * 1.1 * Math.min(1, i / 3);
      _s2.crossVectors(_t, _s);
      _s.multiplyScalar(Math.cos(tw)).addScaledVector(_s2, Math.sin(tw));
      const k = i * 6;
      a[k] = P[i].x - _s.x * hw;
      a[k + 1] = P[i].y - _s.y * hw;
      a[k + 2] = P[i].z - _s.z * hw;
      a[k + 3] = P[i].x + _s.x * hw;
      a[k + 4] = P[i].y + _s.y * hw;
      a[k + 5] = P[i].z + _s.z * hw;
    }
    this.pos.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, r.count * 6);
    this.mesh.visible = r.count > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
