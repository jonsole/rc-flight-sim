// Sun glare: looking towards the sun the picture washes out to white, as a
// camera or your eyes would, most when it's square in view and low in the
// sky. Trees, the ground and buildings in front of the sun block it, and
// cloud cover dims it.
// A screen overlay: a white veil, and a bright bloom where the sun is.
import { Vector3 } from 'three';
import { heightAt } from '../sim/terrain.js';
import { Obstacles } from '../sim/obstacles.js';
import { cloudUniforms } from '../world/clouds.js';

const _f = new Vector3();
const _p = new Vector3();
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class SunGlare {
  constructor() {
    const root = document.createElement('div');
    root.id = 'glare';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3;mix-blend-mode:screen;';
    this.veil = document.createElement('div');
    this.veil.style.cssText = 'position:absolute;inset:0;background:#fffaf0;opacity:0;';
    this.bloom = document.createElement('div');
    this.bloom.style.cssText = 'position:absolute;inset:0;opacity:0;';
    root.append(this.veil, this.bloom);
    document.body.append(root);
    this.level = 0;
    this.seen = 1; // how much of the sun is in view (not blocked)
    this.frame = 0;
  }

  /**
   * @param {import('three').PerspectiveCamera} camera
   * @param {{ sunDir: Vector3, sunElevation: number }} world
   * @param {Obstacles} obstacles
   */
  update(camera, world, obstacles, dt, enabled = true) {
    let target = 0;
    const sun = world.sunDir;
    if (enabled && world.sunElevation > -1) {
      camera.getWorldDirection(_f);
      const toward = _f.dot(sun); // 1 looking straight at it
      // Within ~40 degrees of looking at it, strongest straight on.
      const aim = Math.pow(smooth(Math.cos((40 * Math.PI) / 180), 1, toward), 1.6);
      if (aim > 0) {
        // Is it blocked? (Every few frames: it changes slowly.)
        if (this.frame++ % 3 === 0) this.seen = this.#visible(camera.position, sun, obstacles);
        // A low sun dazzles most; a high one less (it's rarely in view anyway).
        const low = 0.65 + 0.35 * (1 - smooth(10, 50, world.sunElevation));
        const day = smooth(-1, 6, world.sunElevation);
        // (Mist and cloud around you diffuse the sun: no glare.)
        target = aim * this.seen * low * day * (1 - Math.min(1, (world.fogNow ?? 0) * 1.2));
      }
    }
    // Eyes and cameras adjust quickly, not instantly.
    this.level += (target - this.level) * (1 - Math.exp(-dt * 8));
    const g = this.level;
    // Up to almost white straight into a clear sun.
    this.veil.style.opacity = Math.min(0.93, g * 1.05).toFixed(3);
    if (g > 0.01) {
      _p.copy(camera.position).addScaledVector(sun, 1000).project(camera);
      const x = (_p.x * 0.5 + 0.5) * 100;
      const y = (-_p.y * 0.5 + 0.5) * 100;
      this.bloom.style.background = `radial-gradient(circle at ${x.toFixed(1)}% ${y.toFixed(1)}%, rgba(255,252,240,1) 0%, rgba(255,246,225,0.85) 6%, rgba(255,240,215,0.35) 22%, rgba(255,240,215,0) 55%)`;
    }
    this.bloom.style.opacity = Math.min(1, g * 1.3).toFixed(3);
  }

  /** How much of the sun gets through (0-1): the ground, scenery and clouds in the way. */
  #visible(from, sun, obstacles) {
    let through = 1;
    // Clouds: by the cover (their pattern is worked out on the GPU, which
    // can't be matched here): a few scattered ones barely dim it, overcast
    // hides the sun.
    through *= 1 - 0.95 * smooth(0.35, 0.85, cloudUniforms.cloudCover.value);
    // Along the ray for 300 m: the ground, then trees and buildings.
    const near = [];
    for (let d = 1; d < 300 && through > 0.02; d += d < 40 ? 1.5 : 4) {
      const x = from.x + sun.x * d;
      const y = from.y + sun.y * d;
      const z = from.z + sun.z * d;
      if (y < heightAt(x, z)) return 0;
      if (y > 60) break; // (above everything)
      for (const s of obstacles.near(x, z, 1, near)) {
        const hit = Obstacles.test(s, x, y, z);
        if (hit) through *= hit.soft ? 0.55 + 0.4 * (hit.sparse ?? 0) : 0;
      }
    }
    return through;
  }
}
