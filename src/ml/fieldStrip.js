// Where the AI flyers take off and land at this field, for the wind blowing.
//
// In a light wind (up to LIGHT_WIND, src/ml/guidance.js), or one within 30°
// of the runway, they use the runway, rolling from whichever end faces into
// the wind. In more wind than that they go straight into it, across the
// field if need be, as you would: a 90 m strip by the runway, pointing into
// the wind, used only where the ground run, the climb-out and the approach
// are clear of trees, buildings and fences and its line doesn't pass over
// the pilots. If none is clear straight into the wind, they try up to 30°
// off it, and failing that the runway.
import { Obstacles } from '../sim/obstacles.js';
import { RUNWAY } from '../sim/terrain.js';
import { clubAngle, clubToWorld } from '../sim/location.js';
import { Strip, LIGHT_WIND } from './guidance.js';

const deg = Math.PI / 180;
const STRIP_LENGTH = 90;
const STRIP_WIDTH = 14;
const CLIMB = 1 / 6; // approach and climb-out slope checked beyond each end
const BEYOND = 150; // m checked beyond each end
const PILOT_CLEAR = 25; // m: the strip's line must pass at least this far from the pilots

/** Wind (compass degrees it blows FROM, as settings and Wind) to the way the air moves { x, z }. */
export function windVector(fromDeg) {
  const r = fromDeg * deg;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

/** The runway as a strip, rolling from the end that faces into the wind. */
export function runwayStrip(windFromDeg) {
  const A = clubAngle();
  const windRad = windFromDeg * deg;
  const heading = (Math.sin(windRad - A) > 0 ? 0 : Math.PI) - A; // as main.js resetAircraft
  const [x, z] = clubToWorld(RUNWAY.x, RUNWAY.z);
  return new Strip({ x, z, dir: { x: Math.cos(heading), z: -Math.sin(heading) }, length: Math.max(RUNWAY.length, 90), width: Math.max(RUNWAY.width, 14) });
}

/**
 * Is the strip usable: nothing on it a metre up, nothing in the way of a
 * 1-in-6 climb-out or approach for 150 m beyond each end, and the ground
 * along it fairly level?
 */
export function stripClear(strip, ground, obstacles) {
  const near = [];
  const hit = (x, y, z) => {
    for (const s of obstacles.near(x, z, 2, near)) if (Obstacles.test(s, x, y, z)) return true;
    return y < ground.heightAt(x, z);
  };
  const L = strip.length / 2;
  const g0 = ground.heightAt(strip.x, strip.z);
  for (let s = -L - BEYOND; s <= L + BEYOND; s += 3) {
    const beyond = Math.max(0, Math.abs(s) - L);
    for (const l of [-4, 0, 4]) {
      const p = strip.point(s, l);
      const gy = ground.heightAt(p.x, p.z);
      if (beyond === 0 && Math.abs(gy - g0) > 3) return false; // too much slope on the strip
      if (hit(p.x, (beyond ? g0 : gy) + 1 + beyond * CLIMB, p.z)) return false;
    }
  }
  return true;
}

/**
 * The strip for the AI flyers in this wind.
 * @param {object} o  { windFromDeg, windSpeed, ground, obstacles, pilot: { x, z } }
 * @returns {Strip} (with .kind: 'runway' or 'into wind')
 */
export function chooseStrip({ windFromDeg, windSpeed, ground, obstacles, pilot }) {
  const runway = runwayStrip(windFromDeg);
  runway.kind = 'runway';
  const w = windVector(windFromDeg);
  const into = Math.atan2(-w.z, -w.x); // the way to roll
  const off = Math.acos(Math.max(-1, Math.min(1, -(runway.dir.x * w.x + runway.dir.z * w.z))));
  if (windSpeed <= LIGHT_WIND || off <= 30 * deg || !obstacles) return runway;
  // Away from the pilots, so the strip doesn't run over their heads.
  const ax = runway.x - (pilot?.x ?? runway.x);
  const az = runway.z - (pilot?.z ?? runway.z);
  const an = Math.hypot(ax, az) || 1;
  const away = { x: ax / an, z: az / an };
  for (const turn of [0, 10, -10, 20, -20, 30, -30]) {
    const a = into + turn * deg;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    for (const shift of [0, 20, 40, 60, 80]) {
      for (const slide of [0, -30, 30, -60, 60]) {
        const x = runway.x + away.x * shift + runway.dir.x * slide;
        const z = runway.z + away.z * shift + runway.dir.z * slide;
        const strip = new Strip({ x, z, dir, length: STRIP_LENGTH, width: STRIP_WIDTH });
        if (pilot && Math.abs(strip.lateral(pilot)) < PILOT_CLEAR && Math.abs(strip.along(pilot)) < STRIP_LENGTH / 2 + BEYOND) continue;
        if (!stripClear(strip, ground, obstacles)) continue;
        strip.kind = 'into wind';
        return strip;
      }
    }
  }
  return runway;
}

/** Same strip? (Close enough that the AI flyers needn't start over.) */
export function sameStrip(a, b) {
  return a.dir.x * b.dir.x + a.dir.z * b.dir.z > Math.cos(15 * deg) && Math.hypot(a.x - b.x, a.z - b.z) < 10;
}
