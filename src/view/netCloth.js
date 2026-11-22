// The insect net's bag as soft fabric (drawn by src/view/netView.js): a
// cone of points sewn to the wire hoop, joined by threads that resist
// stretching but not squashing, so it crumples when slack and falls in
// folds on the grass. In the air the flow drags each point downstream, the
// air caught in the bag pushes the fabric out (it billows), and the flow
// past it makes it ripple and flutter. Position-based dynamics: each
// sub-step moves the points, then pulls the threads back to length.
//
// It only affects how the net looks: the drag on the aeroplane is the
// net's own (src/sim/net.js).
import { Vector3 } from 'three';

const RHO = 1.225;
const G = 9.81;
const AREAL = 0.04; // kg per m² of netting (with the hem and seams)
const CD = 0.8; // drag of the porous mesh, per point
const INFLATE = 0.1; // share of the dynamic pressure held inside the bag
const BILLOW = 0.8; // slow waves running down the bag, denting it in and out
const FLUTTER = 0.35; // quick ripple, as a share of the dynamic pressure
const SWAY = 0.12; // the tail swinging slowly about, like a windsock's
const SUBSTEP = 1 / 120;
const ITERATIONS = 10;

const _c = new Vector3();
const _n = new Vector3();
const _e2 = new Vector3();
const _t = new Vector3();

export class NetCloth {
  /**
   * @param {number} diameter  the hoop's (m)
   * @param {object} o { segments round, rings along }
   */
  constructor(diameter, { segments = 18, rings = 11 } = {}) {
    this.R = diameter / 2;
    this.length = 1.9 * diameter; // the bag, mouth to tail
    this.S = segments;
    this.N = rings; // rings 1..N are fabric; ring 0 is sewn to the hoop
    const count = (rings + 1) * segments + 1; // + the tail point
    this.count = count;
    this.tip = count - 1;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.pred = new Float32Array(count * 3);
    this.mid = new Float32Array((rings + 1) * 3);
    this.phase = new Float32Array(count * 3).map(() => Math.random() * Math.PI * 2);
    this.rest = this.#restShape();
    this.constraints = this.#threads();
    // Tethers: how far each point can be from its own column's point on the
    // hoop, the length of fabric between them (stops it stretching under
    // the drag without many more passes of the threads).
    this.tether = new Float32Array(count);
    let along = 0;
    for (let j = 1; j <= rings; j++) {
      along += Math.hypot(this.rest[j][0] - this.rest[j - 1][0], this.rest[j][1] - this.rest[j - 1][1]);
      for (let i = 0; i < segments; i++) this.tether[this.idx(j, i)] = along;
    }
    // The hoop: centre, mouth's facing (out of the mouth, towards the cord)
    // and a direction across it (carried round without twisting).
    this.center = new Vector3();
    this.n = new Vector3(1, 0, 0);
    this.e1 = new Vector3(0, 1, 0);
    this.ready = false;
  }

  idx(j, i) {
    return j * this.S + (((i % this.S) + this.S) % this.S);
  }

  /** The bag's own shape, open: [radius, distance behind the mouth] per ring. */
  #restShape() {
    const out = [];
    for (let j = 0; j <= this.N; j++) {
      const f = j / this.N;
      out.push([this.R * (1 - 0.9 * f ** 1.6), this.length * f]);
    }
    return out;
  }

  #local(j, i, out) {
    // In the hoop's frame: x across (e1), y across (e2), z back (−n).
    const [r, z] = this.rest[j];
    const a = (i / this.S) * Math.PI * 2;
    return out.set(r * Math.cos(a), r * Math.sin(a), z);
  }

  #threads() {
    const list = [];
    const p = [];
    for (let j = 0; j <= this.N; j++) for (let i = 0; i < this.S; i++) p[this.idx(j, i)] = this.#local(j, i, new Vector3());
    p[this.tip] = new Vector3(0, 0, this.length * 1.04);
    // (a, b, stiffness; 'min': only keeps them from closing right up)
    const add = (a, b, k, min = false) => {
      const d = p[a].distanceTo(p[b]);
      list.push({ a, b, rest: min ? d / 3 : d, k, min: !!min });
    };
    for (let j = 0; j <= this.N; j++) {
      for (let i = 0; i < this.S; i++) {
        const a = this.idx(j, i);
        if (j > 0) add(a, this.idx(j, i + 1), 1); // round
        if (j < this.N) {
          add(a, this.idx(j + 1, i), 1); // along
          add(a, this.idx(j + 1, i + 1), 0.5); // across the weave
          add(this.idx(j, i + 1), this.idx(j + 1, i), 0.5);
        }
        // Folds any way, but doesn't pass through itself to a point: points
        // two apart keep at least a third of their distance.
        if (j + 2 <= this.N) add(a, this.idx(j + 2, i), 1, 'min');
        if (j > 0) add(a, this.idx(j, i + 2), 1, 'min');
      }
    }
    for (let i = 0; i < this.S; i++) add(this.idx(this.N, i), this.tip, 1);
    return list;
  }

  /** The hoop's frame from its facing, carrying e1 round with it. */
  #frame(n) {
    this.e1.addScaledVector(n, -this.e1.dot(n));
    if (this.e1.lengthSq() < 1e-6) this.e1.set(n.y, -n.x, 0).lengthSq() > 1e-6 || this.e1.set(0, n.z, -n.y);
    this.e1.normalize();
    return _e2.crossVectors(n, this.e1);
  }

  /** Hang the bag straight back from the hoop at `center`, facing `n`. */
  reset(center, n) {
    this.center.copy(center);
    this.n.copy(n).normalize();
    const e2 = this.#frame(this.n);
    for (let j = 0; j <= this.N; j++) {
      for (let i = 0; i < this.S; i++) this.#place(this.idx(j, i), this.#local(j, i, _t), e2);
    }
    this.#place(this.tip, _t.set(0, 0, this.length * 1.04), e2);
    this.vel.fill(0);
    this.ready = true;
  }

  #place(k, l, e2) {
    const P = this.pos;
    P[k * 3] = this.center.x + this.e1.x * l.x + e2.x * l.y - this.n.x * l.z;
    P[k * 3 + 1] = this.center.y + this.e1.y * l.x + e2.y * l.y - this.n.y * l.z;
    P[k * 3 + 2] = this.center.z + this.e1.z * l.x + e2.z * l.y - this.n.z * l.z;
  }

  /**
   * Advance by dt.
   * @param {Vector3} center  the hoop's centre now
   * @param {Vector3} n       the way the mouth faces now (unit)
   * @param {Vector3} wind    the air's velocity there
   * @param {number} floor    the ground's height there
   * @param {number} time     seconds (for the flutter)
   */
  step(dt, center, n, wind, floor, time) {
    if (!this.ready) this.reset(center, n);
    if (dt <= 0) return;
    const steps = Math.min(8, Math.ceil(dt / SUBSTEP));
    const h = dt / steps;
    // The hoop's speed through the air sets the pressure in the bag.
    const vx = (center.x - this.center.x) / dt - wind.x;
    const vy = (center.y - this.center.y) / dt - wind.y;
    const vz = (center.z - this.center.z) / dt - wind.z;
    const speed = Math.hypot(vx, vy, vz);
    const q = 0.5 * RHO * speed * speed;
    // The air moves through the bag from the mouth to the tail.
    const fx = speed > 0.1 ? -vx / speed : -n.x;
    const fy = speed > 0.1 ? -vy / speed : -n.y;
    const fz = speed > 0.1 ? -vz / speed : -n.z;
    const inflate = (INFLATE * q) / AREAL;
    const flutter = (FLUTTER * q) / AREAL;
    const billow = (BILLOW * q) / AREAL;
    const wobble = 6 + speed * 0.8; // quick flutter (rad/s-ish)
    const wave = 2 * Math.PI * (0.8 + speed * 0.12); // billowing waves, rad/s
    const sway = (SWAY * q) / AREAL;
    // Two directions across the flow, for the tail's swing.
    let ax = -fz;
    let ay = 0;
    let az = fx;
    let al = Math.hypot(ax, az);
    if (al < 1e-3) {
      ax = 1;
      az = 0;
      al = 1;
    }
    ax /= al;
    az /= al;
    const bx = fy * az - fz * ay;
    const by = fz * ax - fx * az;
    const bz = fx * ay - fy * ax;
    const drag = (0.5 * RHO * CD) / AREAL;
    const c0 = _c.copy(this.center);
    const n0 = _n.copy(this.n);
    const P = this.pos;
    const V = this.vel;
    const Q = this.pred;
    const ringN = this.S;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const t = time - dt + f * dt;
      // Where the hoop is this sub-step, and the fabric sewn to it.
      this.center.lerpVectors(c0, center, f);
      this.n.lerpVectors(n0, n, f).normalize();
      const e2 = this.#frame(this.n);
      for (let i = 0; i < ringN; i++) {
        const k = i;
        const a = (i / ringN) * Math.PI * 2;
        const ca = Math.cos(a) * this.R;
        const sa = Math.sin(a) * this.R;
        const x = this.center.x + this.e1.x * ca + e2.x * sa;
        const y = this.center.y + this.e1.y * ca + e2.y * sa;
        const z = this.center.z + this.e1.z * ca + e2.z * sa;
        V[k * 3] = (x - P[k * 3]) / h;
        V[k * 3 + 1] = (y - P[k * 3 + 1]) / h;
        V[k * 3 + 2] = (z - P[k * 3 + 2]) / h;
        Q[k * 3] = x;
        Q[k * 3 + 1] = y;
        Q[k * 3 + 2] = z;
      }
      // The middle of each ring (where the air inside pushes out from).
      const M = this.mid;
      for (let j = 1; j <= this.N; j++) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (let i = 0; i < ringN; i++) {
          const o = (j * ringN + i) * 3;
          x += P[o];
          y += P[o + 1];
          z += P[o + 2];
        }
        M[j * 3] = x / ringN;
        M[j * 3 + 1] = y / ringN;
        M[j * 3 + 2] = z / ringN;
      }
      // The fabric: gravity, drag through the air, the air inside pushing it
      // out from the bag's middle, and the flutter.
      for (let k = ringN; k < this.count; k++) {
        const o = k * 3;
        let ux = V[o] - wind.x;
        let uy = V[o + 1] - G * h - wind.y;
        let uz = V[o + 2] - wind.z;
        const u = Math.hypot(ux, uy, uz);
        const damp = 1 / (1 + drag * u * h); // (implicit: steady with light cloth)
        ux *= damp;
        uy *= damp;
        uz *= damp;
        // Out from the middle of its own ring, across the flow: the air
        // caught in the bag pushes the fabric out wherever the bag is.
        const j = Math.floor(k / ringN);
        if (j <= this.N) {
          let dx = P[o] - this.mid[j * 3];
          let dy = P[o + 1] - this.mid[j * 3 + 1];
          let dz = P[o + 2] - this.mid[j * 3 + 2];
          const along = dx * fx + dy * fy + dz * fz;
          dx -= along * fx;
          dy -= along * fy;
          dz -= along * fz;
          const r = Math.hypot(dx, dy, dz);
          if (r > 1e-4) {
            // Pressure out, and the billow: two lobes round the bag that
            // run from the mouth to the tail, pulling the fabric in and out.
            const ang = ((k % ringN) / ringN) * Math.PI * 2;
            const lobe = Math.sin(wave * t - 0.9 * j + 2 * ang) + 0.6 * Math.sin(wave * 1.7 * t - 1.6 * j - 3 * ang + 1.3);
            const k2 = ((inflate + billow * lobe) * h) / r;
            ux += dx * k2;
            uy += dy * k2;
            uz += dz * k2;
          }
        }
        // The tail swings about, more the further back.
        const back = (Math.floor(k / ringN) / this.N) ** 2 * sway * h;
        const s1 = Math.sin(t * 4.1 + Math.sin(t * 1.3)) * back;
        const s2 = Math.sin(t * 3.3 + 1.7) * back;
        ux += ax * s1 + bx * s2;
        uy += ay * s1 + by * s2;
        uz += az * s1 + bz * s2;
        const ph = this.phase;
        const w = t * wobble;
        ux += flutter * h * Math.sin(w + ph[o]);
        uy += flutter * h * Math.sin(w * 1.13 + ph[o + 1]);
        uz += flutter * h * Math.sin(w * 0.91 + ph[o + 2]);
        V[o] = ux + wind.x;
        V[o + 1] = uy + wind.y;
        V[o + 2] = uz + wind.z;
        Q[o] = P[o] + V[o] * h;
        Q[o + 1] = P[o + 1] + V[o + 1] * h;
        Q[o + 2] = P[o + 2] + V[o + 2] * h;
      }
      // Threads back to length (the hoop's points are held).
      for (let it = 0; it < ITERATIONS; it++) {
        for (const c of this.constraints) {
          const a = c.a * 3;
          const b = c.b * 3;
          const dx = Q[b] - Q[a];
          const dy = Q[b + 1] - Q[a + 1];
          const dz = Q[b + 2] - Q[a + 2];
          const len = Math.hypot(dx, dy, dz);
          // Threads only pull (slack, it crumples); the 'min' ones only push.
          if (len < 1e-9 || (c.min ? len >= c.rest : len <= c.rest)) continue;
          const pinned = c.a < ringN;
          const corr = ((len - c.rest) / len) * c.k * (pinned ? 1 : 0.5);
          if (!pinned) {
            Q[a] += dx * corr;
            Q[a + 1] += dy * corr;
            Q[a + 2] += dz * corr;
          }
          Q[b] -= dx * corr;
          Q[b + 1] -= dy * corr;
          Q[b + 2] -= dz * corr;
        }
      }
      // Tethered to the hoop: no further from it than the fabric reaches.
      for (let k = ringN; k < this.tip; k++) {
        const o = k * 3;
        const r = (k % ringN) * 3;
        const dx = Q[o] - Q[r];
        const dy = Q[o + 1] - Q[r + 1];
        const dz = Q[o + 2] - Q[r + 2];
        const len = Math.hypot(dx, dy, dz);
        const max = this.tether[k];
        if (len > max) {
          const f2 = max / len;
          Q[o] = Q[r] + dx * f2;
          Q[o + 1] = Q[r + 1] + dy * f2;
          Q[o + 2] = Q[r + 2] + dz * f2;
        }
      }
      // The grass: it lies on it, and rubs.
      for (let k = ringN; k < this.count; k++) {
        const o = k * 3;
        if (Q[o + 1] < floor + 0.01) {
          Q[o + 1] = floor + 0.01;
          if (P[o + 1] < Q[o + 1]) P[o + 1] = Q[o + 1]; // (pushed out of the ground, not thrown up)
          Q[o] = P[o] + (Q[o] - P[o]) * 0.4;
          Q[o + 2] = P[o + 2] + (Q[o + 2] - P[o + 2]) * 0.4;
        }
      }
      for (let k = ringN; k < this.count; k++) {
        const o = k * 3;
        V[o] = (Q[o] - P[o]) / h;
        V[o + 1] = (Q[o + 1] - P[o + 1]) / h;
        V[o + 2] = (Q[o + 2] - P[o + 2]) / h;
      }
      P.set(Q);
    }
    this.center.copy(center);
    this.n.copy(n).normalize();
  }

  /** Point k (world). */
  point(k, out = new Vector3()) {
    return out.fromArray(this.pos, k * 3);
  }
}
