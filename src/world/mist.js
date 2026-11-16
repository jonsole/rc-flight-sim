// Mist, fog and low cloud: spring and autumn mornings, or as set (Menu ->
// Weather). Mist thickens the haze (the scene fades into pale grey with
// distance, the sky and high clouds with it); low cloud is a broken layer of
// grey cloud a few tens of metres up that you can fly into (everything
// goes grey-white inside) and out of, above or below.
//
// The low cloud's pattern comes from noise worked out the same way on the
// GPU (drawing it: src/world/volfog.js) and here (to know when you're inside
// it): a hash with no sine (whose precision differs on GPUs), its steps in
// 32-bit floats.
import { Vector2 } from 'three';

const f = Math.fround;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fract = (x) => f(x - Math.floor(x));

/** 2D hash, as the shader's (32-bit floats, step by step). */
function hash(x, y) {
  let a = fract(f(x * f(0.1031)));
  let b = fract(f(y * f(0.1031)));
  let c = a; // p3 = fract(vec3(p.xyx) * .1031)
  const d = f(f(f(a * f(b + f(33.33))) + f(b * f(c + f(33.33)))) + f(c * f(a + f(33.33))));
  a = f(a + d);
  b = f(b + d);
  c = f(c + d);
  return fract(f(f(a + b) * c));
}
function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}


/** The weather for a day and time: mist (0-1), its depth (mistTop, m) and low cloud ({ amount, base, top }). */
export function weatherFor(settings, day, hours) {
  // Spring (March to May) and autumn (September to November, foggiest).
  const spring = smooth(60, 85, day) * (1 - smooth(130, 155, day));
  const autumn = smooth(245, 275, day) * (1 - smooth(320, 345, day));
  const season = Math.max(spring * 0.7, autumn);
  const r = (k) => fract(Math.sin(day * 12.9898 + k * 78.233) * 43758.5453);
  // Mist: some days, mostly in the morning, burning off by late morning
  // (and coming back a little in the evening).
  const morning = 1 - smooth(8.5, 11.5, hours) + 0.35 * smooth(18, 21.5, hours);
  let mist = 0;
  if (settings.mist === 'light') mist = 0.55; // (about 600 m)
  else if (settings.mist === 'thick') mist = 1;
  else if (settings.mist !== 'off' && r(1) < 0.55 * season) mist = Math.min(1, morning) * (0.3 + 0.7 * r(2));
  // Low cloud: some days, through the day, lifting a little by afternoon.
  let amount = 0;
  if (settings.lowCloud === 'broken') amount = 0.5;
  else if (settings.lowCloud === 'overcast') amount = 0.95;
  else if (settings.lowCloud !== 'off' && r(3) < 0.45 * season) amount = 0.35 + 0.55 * r(4);
  const base = 45 + r(5) * 45 + smooth(10, 15, hours) * 20;
  // How deep the mist lies over the ground (m): thick fog low and dense,
  // light mist higher.
  const mistTop = settings.mist === 'thick' ? 30 : settings.mist === 'light' ? 55 : 25 + r(7) * 35;
  return { mist, mistTop, lowCloud: { amount, base, top: base + 30 + r(6) * 25 } };
}

export class LowCloud {
  constructor() {
    this.offset = new Vector2(); // drift (m)
    this.amount = 0;
    this.base = 60;
    this.top = 100;
  }

  /** Cover (0-1) at world (x, z), as drawn (src/world/volfog.js vfCover). */
  coverAt(x, z) {
    const px = (x + this.offset.x) / 260;
    const py = (z + this.offset.y) / 260;
    const n = (0.5 * vnoise(px, py) + 0.25 * vnoise(px * 2.1 + 5.3, py * 2.1 + 1.7)) / 0.75;
    const t = 0.7 + (0.16 - 0.7) * this.amount;
    return smooth(t, t + 0.12, n);
  }

  /** How far into the cloud a point is (0 clear .. 1 inside). */
  inside(p) {
    if (this.amount <= 0) return 0;
    const inBand = smooth(this.base - 6, this.base + 4, p.y) * (1 - smooth(this.top - 4, this.top + 6, p.y));
    if (inBand <= 0) return 0;
    return inBand * smooth(0.3, 0.7, this.coverAt(p.x, p.z));
  }

  set(amount, base, top) {
    this.amount = amount;
    this.base = base;
    this.top = top;
  }

  /** Drift with the wind. */
  update(dt, wind) {
    this.offset.x -= wind.x * 1.2 * dt;
    this.offset.y -= wind.z * 1.2 * dt;
  }
}
