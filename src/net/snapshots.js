// Smoothing for other players' aeroplanes. States arrive ~15 times a second
// with network jitter; each peer is drawn a little in the past (DELAY) by
// interpolating between the two states either side of that moment, and
// briefly extrapolated along its velocity if the next state is late.
import { Vector3, Quaternion } from 'three';

export const DELAY = 0.12; // s behind real time
const MAX_EXTRAPOLATE = 0.25; // s
const KEEP = 40; // states kept per peer

export class SnapshotBuffer {
  constructor() {
    this.items = []; // { t (sender clock, s), p: Vector3, q: Quaternion, v: Vector3, state }
    this.offset = null; // local clock - sender clock (s), smallest seen
  }

  /**
   * @param {number} senderT  sender's timestamp (s)
   * @param {number} localT   when it arrived (s, local clock)
   * @param {object} s        { p: [x,y,z], q: [x,y,z,w], v: [x,y,z], ...rest }
   */
  push(senderT, localT, s) {
    const off = localT - senderT;
    // The smallest offset is the least-delayed packet. Let it creep up slowly
    // so a clock drift or route change doesn't freeze the peer.
    this.offset = this.offset === null ? off : Math.min(off, this.offset + 0.002);
    const last = this.items[this.items.length - 1];
    if (last && senderT <= last.t) return; // out of order / duplicate
    this.items.push({
      t: senderT,
      p: new Vector3().fromArray(s.p),
      q: new Quaternion().fromArray(s.q).normalize(),
      v: new Vector3().fromArray(s.v || [0, 0, 0]),
      state: s,
    });
    if (this.items.length > KEEP) this.items.shift();
  }

  /**
   * Pose at local time `localT` (s), written into `out` ({ p, q, state }).
   * Returns false if there is nothing to show yet.
   */
  sample(localT, out) {
    const n = this.items.length;
    if (!n || this.offset === null) return false;
    const t = localT - this.offset - DELAY;
    const it = this.items;
    if (t <= it[0].t) {
      out.p.copy(it[0].p);
      out.q.copy(it[0].q);
      out.state = it[0].state;
      return true;
    }
    for (let i = n - 1; i > 0; i--) {
      const a = it[i - 1];
      const b = it[i];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        out.p.lerpVectors(a.p, b.p, k);
        out.q.slerpQuaternions(a.q, b.q, k);
        out.state = k < 0.5 ? a.state : b.state;
        return true;
      }
    }
    // Newer than anything received: carry on along the last velocity a little.
    const last = it[n - 1];
    const dt = Math.min(MAX_EXTRAPOLATE, t - last.t);
    out.p.copy(last.p).addScaledVector(last.v, dt);
    out.q.copy(last.q);
    out.state = last.state;
    return true;
  }

  /** Seconds since the last state arrived (local clock). */
  age(localT) {
    const last = this.items[this.items.length - 1];
    return last ? localT - this.offset - last.t : Infinity;
  }
}
