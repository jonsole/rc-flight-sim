// Where the AI flyers take off and land at this field, for the wind blowing.
//
// Every strip they might use is checked (stripClear): the ground roll, the
// take-off climb and the landing glide path clear of trees, buildings and
// fences, and its line not over the pilots. In order of preference:
//   - the runway, rolling from the end facing the wind, if the wind is
//     light (up to LIGHT_WIND, src/ml/guidance.js) or within 30° of it;
//   - a 90 m strip by the runway straight into the wind (across the field
//     if need be, as you would), then up to 30° off it;
//   - in a light wind, the runway the other way, or a strip any way at all.
// If nothing is clear: null, and the AI flyers just fly round over the field
// rather than fly approaches into the trees.
import { Obstacles } from '../sim/obstacles.js';
import { RUNWAY } from '../sim/terrain.js';
import { clubAngle, clubToWorld } from '../sim/location.js';
import { Strip, LIGHT_WIND, glideHeight, climbProfile } from './guidance.js';

const deg = Math.PI / 180;
const STRIP_LENGTH = 90;
const STRIP_WIDTH = 14;
const BEYOND = 150; // m checked beyond each end
const PILOT_CLEAR = 25; // m: the strip's line must pass at least this far from the pilots

/** Wind (compass degrees it blows FROM, as settings and Wind) to the way the air moves { x, z }. */
export function windVector(fromDeg) {
  const r = fromDeg * deg;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

/** The runway as a strip, rolling from the end that faces into the wind (or the other end). */
export function runwayStrip(windFromDeg, otherEnd = false) {
  const A = clubAngle();
  const windRad = windFromDeg * deg;
  const heading = (Math.sin(windRad - A) > 0 !== otherEnd ? 0 : Math.PI) - A; // as main.js resetAircraft
  const [x, z] = clubToWorld(RUNWAY.x, RUNWAY.z);
  return new Strip({ x, z, dir: { x: Math.cos(heading), z: -Math.sin(heading) }, length: Math.max(RUNWAY.length, 90), width: Math.max(RUNWAY.width, 14) });
}

/**
 * Is the strip usable? Checks the whole flight path, not just the ground:
 * the take-off climb (src/ml/guidance.js climbProfile) and the landing
 * glide path, each as a band from 4 m below to 3 m above (the aeroplane
 * won't be exactly on it), along the strip and for 150 m beyond each end,
 * 6 m either side on the strip and 15 m beyond it (the landing skill starts
 * up to 12 m off the centreline); the ground roll a metre up; and the ground
 * along the strip fairly level.
 */
export function stripClear(strip, ground, obstacles) {
  const near = [];
  const hit = (x, y, z) => {
    for (const s of obstacles.near(x, z, 2, near)) if (fatHit(s, x, y, z) || Obstacles.test(s, x, y, z)) return true;
    return y < ground.heightAt(x, z);
  };
  const L = strip.length / 2;
  const g0 = ground.heightAt(strip.x, strip.z);
  // From where final starts (the base turn, 190 m before the aim point) to
  // the end of the climb-out; every metre on the strip (fences and trunks
  // are thin), every 3 beyond.
  for (let s = Math.min(-L - BEYOND, strip.aimS - 200); s <= L + BEYOND; s += Math.abs(s) <= L + 3 ? 1 : 3) {
    const on = Math.abs(s) <= L;
    const bands = [];
    if (s <= strip.aimS) bands.push(glideHeight(strip, s)); // landing
    if (s >= strip.startS) bands.push(climbProfile(strip, s)); // taking off
    for (const l of on ? [-6, -4, -3, -2, -1, 0, 1, 2, 3, 4, 6] : [-15, -10, -5, 0, 5, 10, 15]) {
      const p = strip.point(s, l);
      const gy = on ? ground.heightAt(p.x, p.z) : g0;
      if (on && Math.abs(gy - g0) > 3) return false; // too much slope on the strip
      if (on && Math.abs(l) <= 3 && (hit(p.x, gy + 0.3, p.z) || hit(p.x, gy + 1, p.z))) return false; // the ground roll
      for (const h of bands) {
        for (let y = Math.max(1, h - 4); y <= h + 3; y += 2) if (hit(p.x, gy + y, p.z)) return false;
      }
    }
  }
  return true;
}

const PAD = 0.6; // m: thin solids count from this far off (about half a small model's span)

/** Distance from (x, z) to the segment a-b. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

/**
 * Within PAD of a thin solid: a rail or other box, a post or pole, a site
 * fence. (A point test misses a 4 cm rail or post between samples a metre
 * apart; fattened, nothing solid fits between them.)
 */
function fatHit(s, x, y, z) {
  switch (s.type) {
    case 'box':
      return y >= s.min[1] - PAD && y <= s.max[1] + PAD && x >= s.min[0] - PAD && x <= s.max[0] + PAD && z >= s.min[2] - PAD && z <= s.max[2] + PAD;
    case 'cylinder':
      return y >= s.y0 && y <= s.y1 + PAD && Math.hypot(x - s.x, z - s.z) < s.r + PAD;
    case 'building': {
      const b = s.b;
      if (b.kind !== 'fence' || y < b.y0 || y > b.eave + PAD) return false;
      // The slab's long sides run pts[0]-pts[1] and pts[3]-pts[2].
      const [p0, p1] = b.pts;
      return segDist(x, z, p0[0], p0[1], p1[0], p1[1]) < PAD + 0.1;
    }
    default:
      return false;
  }
}

/**
 * The strip for the AI flyers in this wind.
 * @param {object} o  { windFromDeg, windSpeed, ground, obstacles, pilot: { x, z } }
 * @returns {Strip|null} (with .kind: 'runway', 'into wind' or 'clear way'), or null if nowhere is clear
 */
export function chooseStrip({ windFromDeg, windSpeed, ground, obstacles, pilot }) {
  const w = windVector(windFromDeg);
  const light = windSpeed <= LIGHT_WIND;
  const headwind = (st) => -(st.dir.x * w.x + st.dir.z * w.z); // cos of the angle off the wind
  const runway = runwayStrip(windFromDeg);
  runway.kind = 'runway';
  if (!obstacles) return runway; // (no scenery to hit)
  const ok = (st) => !(pilot && Math.abs(st.lateral(pilot)) < PILOT_CLEAR && Math.abs(st.along(pilot)) < st.length / 2 + BEYOND) && stripClear(st, ground, obstacles);
  if ((light || headwind(runway) >= Math.cos(30 * deg)) && stripClear(runway, ground, obstacles)) return runway;
  // Strips by the runway, away from the pilots so they don't run over their heads.
  const ax = runway.x - (pilot?.x ?? runway.x);
  const az = runway.z - (pilot?.z ?? runway.z);
  const an = Math.hypot(ax, az) || 1;
  const away = { x: ax / an, z: az / an };
  const into = Math.atan2(-w.z, -w.x); // the way to roll
  // Longest first: down to 60 m (the shortest the skills trained on) at a small field.
  const search = (turns) => {
    for (const length of [STRIP_LENGTH, 70, 60]) for (const turn of turns) {
      const a = into + turn * deg;
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      for (const shift of [0, 20, 40, 60, 80, 100, 120]) {
        for (const slide of [0, -30, 30, -60, 60, -90, 90]) {
          const strip = new Strip({ x: runway.x + away.x * shift + runway.dir.x * slide, z: runway.z + away.z * shift + runway.dir.z * slide, dir, length, width: STRIP_WIDTH });
          if (ok(strip)) {
            strip.kind = 'into wind';
            return strip;
          }
        }
      }
    }
    return null;
  };
  const found = search([0, 10, -10, 20, -20, 30, -30]);
  if (found) return found;
  if (light) {
    // Hardly any wind: whichever way is clear.
    const other = runwayStrip(windFromDeg, true);
    other.kind = 'runway';
    if (stripClear(other, ground, obstacles)) return other;
    const any = search([45, -45, 60, -60, 75, -75, 90, -90, 120, -120, 150, -150, 180]);
    if (any) {
      any.kind = 'clear way';
      return any;
    }
  }
  return null;
}

/** Same strip? (Close enough that the AI flyers needn't start over.) */
export function sameStrip(a, b) {
  if (!a || !b) return a === b;
  return a.dir.x * b.dir.x + a.dir.z * b.dir.z > Math.cos(15 * deg) && Math.hypot(a.x - b.x, a.z - b.z) < 10;
}
