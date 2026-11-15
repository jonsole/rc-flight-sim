// Wind: a boundary-layer gradient, gusts, and the way trees disturb it.
//
// Upwind of a tree line the air slows near the ground and rises up over the
// trees. Behind them there is a sheltered zone with a downdraft just past the
// trees, then the wake: slower air full of tumbling eddies about the size of
// the trees, strongest a few tree-heights downwind and dying away by about
// twenty. Eddies are a swirling pattern carried along with the wind, sampled
// wherever you ask, so the two wings of a model can feel different air.
import { Vector3 } from 'three';
import { heightAt } from './terrain.js';
import { noise3 } from './treeShapes.js';

// Grid over the area round the field where tree effects are worked out.
const CELL = 5;
const X0 = -620;
const Z0 = -660;
const NX = 248;
const NZ = 248;
const REACH = 320; // how far up/downwind to look for trees (m)

export class Wind {
  constructor() {
    this.speed = 3;          // m/s at 10 m
    this.directionDeg = 270; // direction wind blows FROM, compass-style (0 = -z/"north")
    this.turbulence = 0.3;   // 0..1
    this.gust = new Vector3();
    this._t = 0;
    this.trees = null;
    this._fieldDir = null;
  }

  /** Trees that disturb the wind ({ x, z, h, conifer, crownW }). */
  setTrees(trees) {
    this.trees = trees;
    // Canopy height above the ground per cell (0 = open).
    this.canopy = new Float32Array(NX * NZ);
    for (const t of trees) {
      const r = t.conifer ? t.h * 0.18 : (t.crownW ?? t.h * 0.3) * 0.9;
      const i0 = Math.floor((t.x - r - X0) / CELL);
      const i1 = Math.floor((t.x + r - X0) / CELL);
      const j0 = Math.floor((t.z - r - Z0) / CELL);
      const j1 = Math.floor((t.z + r - Z0) / CELL);
      for (let i = Math.max(0, i0); i <= Math.min(NX - 1, i1); i++) {
        for (let j = Math.max(0, j0); j <= Math.min(NZ - 1, j1); j++) {
          const cx = X0 + (i + 0.5) * CELL - t.x;
          const cz = Z0 + (j + 0.5) * CELL - t.z;
          if (cx * cx + cz * cz > r * r + CELL * CELL * 0.25) continue;
          const k = i + j * NX;
          this.canopy[k] = Math.max(this.canopy[k], t.h);
        }
      }
    }
    this._fieldDir = null;
  }

  /**
   * For each cell: distance back upwind to the nearest trees and their height
   * (the wake), and distance on downwind to trees ahead (the air rising over
   * them). Redone when the wind direction changes.
   */
  #buildField() {
    const from = (this.directionDeg * Math.PI) / 180;
    const fx = -Math.sin(from); // the way the air moves
    const fz = Math.cos(from);
    const n = NX * NZ;
    this.wakeD = new Float32Array(n).fill(Infinity);
    this.wakeH = new Float32Array(n);
    this.aheadD = new Float32Array(n).fill(Infinity);
    this.aheadH = new Float32Array(n);
    const C = this.canopy;
    const steps = Math.ceil(REACH / CELL);
    const look = (i, j, sign, outD, outH) => {
      const x = X0 + (i + 0.5) * CELL;
      const z = Z0 + (j + 0.5) * CELL;
      for (let s = 1; s <= steps; s++) {
        const ii = Math.floor((x + sign * fx * s * CELL - X0) / CELL);
        const jj = Math.floor((z + sign * fz * s * CELL - Z0) / CELL);
        if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) return;
        const h = C[ii + jj * NX];
        if (h > 0) {
          // Tallest trees in the belt just there.
          let hm = h;
          for (let e = 1; e <= 4; e++) {
            const i2 = Math.floor((x + sign * fx * (s + e) * CELL - X0) / CELL);
            const j2 = Math.floor((z + sign * fz * (s + e) * CELL - Z0) / CELL);
            if (i2 < 0 || j2 < 0 || i2 >= NX || j2 >= NZ) break;
            hm = Math.max(hm, C[i2 + j2 * NX]);
          }
          const k = i + j * NX;
          outD[k] = (s - 0.5) * CELL;
          outH[k] = hm;
          return;
        }
      }
    };
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const k = i + j * NX;
        if (C[k] > 0) {
          // Inside the canopy: its own trees are both "behind" and "ahead".
          this.wakeD[k] = 0;
          this.wakeH[k] = C[k];
          this.aheadD[k] = 0;
          this.aheadH[k] = C[k];
          continue;
        }
        look(i, j, -1, this.wakeD, this.wakeH);
        look(i, j, 1, this.aheadD, this.aheadH);
      }
    }
    this._fieldDir = this.directionDeg;
  }

  /** Advance gust state (call once per frame). */
  update(dt) {
    this._t += dt;
    // Ornstein–Uhlenbeck process per axis: the broad gusts in open air.
    const tau = 2.5;
    // In proportion to the wind: calm air is calm.
    const sigma = this.turbulence * this.speed * 0.4;
    const a = Math.exp(-dt / tau);
    const b = sigma * Math.sqrt(1 - a * a);
    this.gust.x = this.gust.x * a + b * gauss();
    this.gust.y = this.gust.y * a + b * 0.5 * gauss();
    this.gust.z = this.gust.z * a + b * gauss();
  }

  /**
   * How the trees change the air at a point: { slow (fraction of the speed
   * lost), lift (vertical air speed as a fraction of the wind speed),
   * eddy (turbulence strength as a fraction of the wind speed), size (m) }.
   */
  treeEffect(x, z, agl, out = {}) {
    out.slow = 0;
    out.lift = 0;
    out.eddy = 0;
    out.size = 10;
    if (!this.canopy) return out;
    if (this._fieldDir !== this.directionDeg) this.#buildField();
    const i = Math.floor((x - X0) / CELL);
    const j = Math.floor((z - Z0) / CELL);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return out;
    const k = i + j * NX;

    // Behind trees: shelter, a downdraft just past them, then the wake.
    const hw = this.wakeH[k];
    if (hw > 0) {
      const xs = this.wakeD[k] / hw;  // tree-heights downwind
      const zs = agl / hw;            // height in tree-heights
      // Only up to about twice the tree height, fading above.
      const env = zs < 1.2 ? 1 : Math.exp(-(((zs - 1.2) / 0.8) ** 2));
      out.slow = 0.75 * Math.exp(-xs / 7) * env;
      out.lift = -0.18 * Math.exp(-(((xs - 2.5) / 1.8) ** 2)) * (zs < 2 ? 1 : Math.exp(-(zs - 2)));
      // Eddies build to a peak about 4 tree-heights back, then die away.
      out.eddy = 0.35 * (xs / 4) * Math.exp(1 - xs / 4) * env;
      out.size = hw * 0.7;
    }
    // Ahead of trees: the air slows near the ground and rises up over them.
    const ha = this.aheadH[k];
    if (ha > 0) {
      const xu = this.aheadD[k] / ha;
      const zu = agl / ha;
      const near = Math.exp(-xu / 1.6);
      out.lift += 0.32 * near * Math.exp(-(((zu - 0.9) / 0.9) ** 2));
      out.slow = Math.max(out.slow, 0.35 * near * (zu < 0.8 ? 1 : Math.exp(-(((zu - 0.8) / 0.4) ** 2))));
    }
    return out;
  }

  /**
   * Wind velocity (the direction air moves) in world space. Pass the height
   * above ground if you already know it.
   */
  at(pos, _t, out, aglHint) {
    const agl = Math.max(0.2, aglHint ?? pos.y - heightAt(pos.x, pos.z));
    const gradient = Math.min(1.25, Math.log(agl / 0.05) / Math.log(10 / 0.05));
    const from = (this.directionDeg * Math.PI) / 180;
    // "from" north (-z) means air moves towards +z.
    const dx = -Math.sin(from);
    const dz = Math.cos(from);
    const U = this.speed;
    const fx = this.treeEffect(pos.x, pos.z, agl, _fx);
    const s = U * gradient * (1 - fx.slow);
    const g = Math.min(1, agl / 3);
    out.set(dx * s + this.gust.x * g, this.gust.y * g * Math.min(1, agl / 10) + U * fx.lift, dz * s + this.gust.z * g);
    if (fx.eddy > 0.005 && U > 0.1) {
      // Eddies: a swirling pattern carried along with the wind (and slowly
      // changing), as big as the trees that made them.
      const sigma = fx.eddy * U * (0.6 + this.turbulence);
      const L = Math.max(3, fx.size);
      const t = this._t;
      const px = (pos.x - dx * U * 0.8 * t) / L;
      const pz = (pos.z - dz * U * 0.8 * t) / L;
      const py = pos.y / L + t * 0.15;
      const amp = sigma * 3.4; // noise3 - 0.5 has a spread of about 0.3
      out.x += amp * (noise3(px, py, pz) - 0.5);
      out.y += amp * 0.8 * (noise3(px + 31.7, py, pz - 11.3) - 0.5) * Math.min(1, agl / 4);
      out.z += amp * 0.8 * (noise3(px - 17.1, py + 5.9, pz + 23.3) - 0.5);
    }
    return out;
  }
}

const _fx = {};

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
