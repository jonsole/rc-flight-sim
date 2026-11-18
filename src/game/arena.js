// Where to put a challenge course at this field: the most open piece of sky
// near the pilot. Candidate centres on a grid round the pilot are scored by
// how far out a ring of points (4 to 22 m up) stays clear of the trees,
// buildings and fences, less a little for being far from the pilot. Works
// for any field, scenery edits included.
import { Obstacles } from '../sim/obstacles.js';
import { pilotSpot, inField, clubAngle } from '../sim/location.js';

const HEIGHTS = [4, 9, 15, 22];
const DIRS = 16;
const near = [];

/** Is anything solid or leafy at (x, y, z)? */
export function blocked(obstacles, ground, x, y, z) {
  if (y < ground.heightAt(x, z)) return true;
  for (const s of obstacles.near(x, z, 1, near)) if (Obstacles.test(s, x, y, z)) return true;
  return false;
}

/** How far (m, in steps of `step`, up to `max`) the ring round (x, z) stays clear. */
export function clearRadius(obstacles, ground, x, z, max = 90, step = 10) {
  const g = ground.heightAt(x, z);
  for (let r = 0; r <= max; r += step) {
    const n = r === 0 ? 1 : Math.max(DIRS, Math.ceil((2 * Math.PI * r) / 6)); // every ~6 m round
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      for (const h of HEIGHTS) if (blocked(obstacles, ground, px, g + h, pz)) return Math.max(0, r - step);
    }
  }
  return max;
}

/**
 * The course area: { x, z, r, g (ground height there), across (unit [x, z]
 * across the pilot's view of it), away (unit [x, z] from the pilot towards
 * it) }.
 */
export function findArena(obstacles, ground) {
  const [px, pz] = pilotSpot();
  // The way the pilot faces (the club frame's -z).
  const a = clubAngle();
  const fx = Math.sin(a);
  const fz = -Math.cos(a);
  let best = null;
  for (let i = -8; i <= 8; i++) {
    for (let j = -8; j <= 8; j++) {
      const x = px + i * 20;
      const z = pz + j * 20;
      const d = Math.hypot(x - px, z - pz);
      if (d > 170 || (d > 20 && !inField(x, z))) continue;
      // The course is kept clear of the pilot (stood outside its near edge).
      const r = Math.min(clearRadius(obstacles, ground, x, z), 75, (d - 25) / 0.5);
      if (r < 30) continue;
      // Open sky counts most; nearer the pilot is easier to fly and see,
      // and in front better than off to the side or behind.
      const ahead = ((x - px) * fx + (z - pz) * fz) / d;
      const score = r - 0.22 * Math.max(0, d - 60) + 6 * ahead;
      if (!best || score > best.score) best = { x, z, r, score, d };
    }
  }
  const out = best ?? { x: px, z: pz - 60, r: 40, d: 60 };
  // Facing it from the pilot.
  let ax;
  let az;
  if (out.d > 15) {
    ax = (out.x - px) / out.d;
    az = (out.z - pz) / out.d;
  } else {
    ax = fx;
    az = fz;
  }
  out.away = [ax, az];
  out.across = [-az, ax]; // to the pilot's right
  out.g = ground.heightAt(out.x, out.z);
  return out;
}

/** Arena-local (u across to the right, v away from the pilot) to world [x, z]. */
export function arenaToWorld(arena, u, v) {
  return [arena.x + arena.across[0] * u + arena.away[0] * v, arena.z + arena.across[1] * u + arena.away[1] * v];
}
