// Wind with a boundary-layer gradient and gusty turbulence.
import { Vector3 } from 'three';

export class Wind {
  constructor() {
    this.speed = 3;          // m/s at 10 m
    this.directionDeg = 270; // direction wind blows FROM, compass-style (0 = -z/"north")
    this.turbulence = 0.3;   // 0..1
    this.gust = new Vector3();
    this._t = 0;
  }

  /** Advance gust state (call once per frame). */
  update(dt) {
    // Ornstein–Uhlenbeck process per axis.
    const tau = 2.5;
    const sigma = this.turbulence * (0.6 + this.speed * 0.35);
    const a = Math.exp(-dt / tau);
    const b = sigma * Math.sqrt(1 - a * a);
    this.gust.x = this.gust.x * a + b * gauss();
    this.gust.y = this.gust.y * a + b * 0.5 * gauss();
    this.gust.z = this.gust.z * a + b * gauss();
  }

  /** Wind velocity (the direction air moves) in world space. */
  at(pos, _t, out) {
    const agl = Math.max(0.2, pos.y);
    const gradient = Math.min(1.25, Math.log(agl / 0.05) / Math.log(10 / 0.05));
    const from = (this.directionDeg * Math.PI) / 180;
    // "from" north (-z) means air moves towards +z.
    const dx = -Math.sin(from);
    const dz = Math.cos(from);
    const s = this.speed * gradient;
    const g = Math.min(1, agl / 3);
    return out.set(dx * s + this.gust.x * g, this.gust.y * g * Math.min(1, agl / 10), dz * s + this.gust.z * g);
  }
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
