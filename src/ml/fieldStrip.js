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
import { DOWNWIND_END, BASE_POINT } from './aiPilot.js';

const deg = Math.PI / 180;
const STRIP_LENGTH = 90;
const STRIP_WIDTH = 14;
const BEYOND = 150; // m checked beyond each end
const PILOT_CLEAR = 25; // m: the strip's line must pass at least this far from the pilots
const NEAR = 90; // m: no strip centred further than this from the pilots (they take off near you)

/** Wind (compass degrees it blows FROM, as settings and Wind) to the way the air moves { x, z }. */
export function windVector(fromDeg) {
  const r = fromDeg * deg;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

const RUNWAY_USE = 100; // m: the most of the runway they use (the part in front of the pilots)
const LANE = 5; // m: their lane is this far beside the runway's centreline, away from the pilots

/**
 * The runway as a strip, rolling from the end that faces into the wind (or
 * the other end): no more than RUNWAY_USE of it, the part opposite the
 * pilots, so the circuit stays close (line of sight).
 */
export function runwayStrip(windFromDeg, otherEnd = false, pilot = null) {
  const A = clubAngle();
  const windRad = windFromDeg * deg;
  const heading = (Math.sin(windRad - A) > 0 !== otherEnd ? 0 : Math.PI) - A; // as main.js resetAircraft
  const [rx, rz] = clubToWorld(RUNWAY.x, RUNWAY.z);
  const dir = { x: Math.cos(heading), z: -Math.sin(heading) };
  const length = Math.min(Math.max(RUNWAY.length, 90), RUNWAY_USE);
  // Centred on the point of the runway opposite the pilots (within its ends).
  const room = Math.max(0, (Math.max(RUNWAY.length, 90) - length) / 2);
  const s = pilot ? Math.max(-room, Math.min(room, (pilot.x - rx) * dir.x + (pilot.z - rz) * dir.z)) : 0;
  // Their own lane, alongside the runway and LANE further from the pilots:
  // you start on the runway itself, and they waited for ever for you to
  // clear it.
  const right = { x: -dir.z, z: dir.x };
  const pl = pilot ? (pilot.x - rx) * right.x + (pilot.z - rz) * right.z : -1;
  const l = pl > 0 ? -LANE : LANE;
  return new Strip({ x: rx + dir.x * s + right.x * l, z: rz + dir.z * s + right.z * l, dir, length, width: 14 });
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
/** Why the last stripClear() failed: { what, s, l, y }, for debugging. */
export let lastFail = null;
function fail(what, s, l, y) {
  lastFail = { what, s: Math.round(s), l, y: Math.round(y * 10) / 10 };
  return false;
}

export function stripClear(strip, ground, obstacles, landing = true) {
  const near = [];
  const hit = (x, y, z) => {
    for (const s of obstacles.near(x, z, 2, near)) if (fatHit(s, x, y, z) || Obstacles.test(s, x, y, z)) return true;
    return y < ground.heightAt(x, z);
  };
  const L = strip.length / 2;
  const g0 = ground.heightAt(strip.x, strip.z);
  // From where final starts (the base turn, 115 m before the aim point) to
  // the end of the climb-out; every metre on the strip (fences and trunks
  // are thin), every 3 beyond.
  // (Take-off only: from the start of the roll.)
  const from = landing ? Math.min(-L - BEYOND, strip.aimS - 125) : strip.startS - 3;
  for (let s = from; s <= L + BEYOND; s += Math.abs(s) <= L + 3 ? 1 : 3) {
    const on = Math.abs(s) <= L;
    const bands = [];
    if (landing && s <= strip.aimS) bands.push(glideHeight(strip, s)); // landing
    // Going around: from 3 m up with 25 m of strip left, climbing 1 in 4
    // (as steeply as a take-off, but from lower and further along: the
    // AeroScout hit trees past the end at Impington going around).
    if (landing && s >= L - 25) bands.push(3 + (s - L + 25) / 4);
    if (s >= strip.startS) bands.push(climbProfile(strip, s)); // taking off
    for (const l of on ? [-6, -4, -3, -2, -1, 0, 1, 2, 3, 4, 6] : [-15, -10, -5, 0, 5, 10, 15]) {
      const p = strip.point(s, l);
      const gy = on ? ground.heightAt(p.x, p.z) : g0;
      if (on && Math.abs(gy - g0) > 3) return fail('slope', s, l, gy - g0); // too much slope on the strip
      if (on && Math.abs(l) <= 3 && (hit(p.x, gy + 0.3, p.z) || hit(p.x, gy + 1, p.z))) return fail('ground roll', s, l, 1); // the ground roll
      for (const h of bands) {
        for (let y = Math.max(1, h - 4); y <= h + 3; y += 2) if (hit(p.x, gy + y, p.z)) return fail('flight path', s, l, y);
      }
      // An overrun for landings: the first 25 m past the far end clear from
      // the ground up (a late go-around passes low over it). (Not for
      // take-off only: the climb-out path above covers that.)
      if (landing && s > L && s < L + 25) {
        const top = climbProfile(strip, s) + 3;
        for (let y = 1; y <= top; y += 2) if (hit(p.x, gy + y, p.z)) return fail('overrun', s, l, y);
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
 * Is the base turn clear? The aeroplane turns from the end of the downwind
 * leg down to the base point (src/ml/aiPilot.js) on the circuit side (away
 * from the pilots), cutting the corner or swinging wide, so the whole
 * region round it is checked: from 25 m before the base point to 20 m past
 * the downwind end, from the centreline to 35 m beyond the downwind leg,
 * between 4 m below the base point's height and 3 m above circuit height.
 */
export function baseLegClear(strip, side, ground, obstacles) {
  const near = [];
  const g0 = ground.heightAt(strip.x, strip.z);
  const s0 = strip.aimS + BASE_POINT.s - 25;
  const s1 = strip.aimS + DOWNWIND_END.s + 20;
  const lo = glideHeight(strip, strip.aimS + BASE_POINT.s) + BASE_POINT.above - 4;
  const hi = DOWNWIND_END.h + 3;
  for (let s = s0; s <= s1; s += 4) {
    for (let l = 0; l <= DOWNWIND_END.l + 35; l += 4) {
      const p = strip.point(s, side * l);
      for (let y = Math.max(1, lo); y <= hi; y += 3) {
        const py = g0 + y;
        if (py < ground.heightAt(p.x, p.z)) return false;
        for (const o of obstacles.near(p.x, p.z, 2, near)) if (Obstacles.test(o, p.x, py, p.z)) return false;
      }
    }
  }
  return true;
}

/** Do segments a-b and c-d (each [x, z]) cross? */
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/**
 * Is any part of the strip across a site fence from the pilots (the far side
 * of the field)? (Not the club field's safety fence, which is meant to be
 * between the pilots and the runway.)
 */
function beyondFence(strip, pilot, obstacles) {
  if (!pilot || !obstacles.fences?.length) return false;
  const P = [pilot.x, pilot.z];
  const ends = [strip.point(-strip.length / 2), strip.point(0), strip.point(strip.length / 2)].map((p) => [p.x, p.z]);
  for (const f of obstacles.fences) {
    for (let i = 1; i < f.path.length; i++) {
      for (const e of ends) if (crosses(P, e, f.path[i - 1], f.path[i])) return true;
    }
  }
  return false;
}

/** Which side the circuit is flown on: away from the pilots (as src/ml/aiPilot.js). */
function circuitSide(strip, pilot) {
  return pilot && strip.lateral(pilot) > 0 ? -1 : 1;
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
  const runway = runwayStrip(windFromDeg, false, pilot);
  runway.kind = 'runway';
  if (!obstacles) return runway; // (no scenery to hit)
  const near = (st) => !pilot || Math.hypot(st.x - pilot.x, st.z - pilot.z) <= NEAR;
  const placeOk = (st) => near(st) && !beyondFence(st, pilot, obstacles) && !(pilot && Math.abs(st.lateral(pilot)) < PILOT_CLEAR && Math.abs(st.along(pilot)) < st.length / 2 + BEYOND);
  const ok = (st) => placeOk(st) && stripClear(st, ground, obstacles) && baseLegClear(st, circuitSide(st, pilot), ground, obstacles);
  if ((light || headwind(runway) >= Math.cos(30 * deg)) && !beyondFence(runway, pilot, obstacles) && stripClear(runway, ground, obstacles) && baseLegClear(runway, circuitSide(runway, pilot), ground, obstacles)) return runway;
  // Strips by the runway, away from the pilots so they don't run over their heads.
  // (From the runway itself, not the AI lane beside it.)
  const [cx0, cz0] = clubToWorld(RUNWAY.x, RUNWAY.z);
  const ax = cx0 - (pilot?.x ?? cx0);
  const az = cz0 - (pilot?.z ?? cz0);
  const an = Math.hypot(ax, az) || 1;
  const away = { x: ax / an, z: az / an };
  const into = Math.atan2(-w.z, -w.x); // the way to roll
  // Places by the runway, nearest the pilots first (the circuit has to stay
  // in sight), none further than NEAR; then the next furthest.
  const places = [];
  for (const shift of [0, 20, 40, 60, 80, 100, 120]) {
    for (const slide of [0, -30, 30, -60, 60, -90, 90]) {
      const x = cx0 + away.x * shift + runway.dir.x * slide;
      const z = cz0 + away.z * shift + runway.dir.z * slide;
      places.push({ x, z, d: pilot ? Math.hypot(x - pilot.x, z - pilot.z) : Math.hypot(shift, slide) });
    }
  }
  places.sort((a, b) => a.d - b.d);
  // Longest first: down to 60 m (the shortest the skills trained on) at a
  // small field. Near the pilots matters more than exactly into wind
  // (within 30° of it anyway).
  const search = (turns, test = ok) => {
    for (const length of [STRIP_LENGTH, 70, 60]) {
      for (const p of places) {
        if (p.d > NEAR) break;
        for (const turn of turns) {
          const a = into + turn * deg;
          const strip = new Strip({ x: p.x, z: p.z, dir: { x: Math.cos(a), z: Math.sin(a) }, length, width: STRIP_WIDTH });
          if (test(strip)) {
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
    const other = runwayStrip(windFromDeg, true, pilot);
    other.kind = 'runway';
    if (!beyondFence(other, pilot, obstacles) && stripClear(other, ground, obstacles) && baseLegClear(other, circuitSide(other, pilot), ground, obstacles)) return other;
    const any = search(EVERY_WAY);
    if (any) {
      any.kind = 'clear way';
      return any;
    }
  }
  // Nowhere near with a clear approach: take off from near the pilots
  // anyway (the runway, either end, or a strip by it with a clear climb-out)
  // and fly round, but don't come in to land over the trees.
  const takeoffOnly = (st) => placeOk(st) && stripClear(st, ground, obstacles, false);
  const other = runwayStrip(windFromDeg, true, pilot);
  // (Within 30° of the wind unless it's light: take-off trained with no
  // more crosswind than that, and the AeroScout flipped over in more.)
  const intoWind = (st) => light || headwind(st) >= Math.cos(30 * deg);
  // Smooth ground first (mown grass or runway): a nose-heavy tail-dragger
  // noses over on rough grass (the S.E.5a struck its prop every time).
  const smooth = (st) => {
    if (!ground.surfaceAt) return true;
    for (let s = st.startS; s <= st.length / 2; s += 5) {
      const p = st.point(s);
      if (ground.surfaceAt(p.x, p.z).roll > 0.17) return false;
    }
    return true;
  };
  const runways = [runway, ...(light ? [other] : [])].filter((st) => intoWind(st) && !beyondFence(st, pilot, obstacles) && stripClear(st, ground, obstacles, false));
  const turns = [0, 10, -10, 20, -20, 30, -30];
  const anyTurns = [45, -45, 90, -90, 135, -135, 180];
  const launch = runways.find(smooth)
    ?? search(turns, (st) => takeoffOnly(st) && smooth(st))
    ?? (light ? search(anyTurns, (st) => takeoffOnly(st) && smooth(st)) : null)
    ?? runways[0]
    ?? search(turns, takeoffOnly)
    ?? (light ? search(anyTurns, takeoffOnly) : null);
  if (launch) {
    launch.kind = 'take-off only';
    launch.landing = false;
    // Somewhere to land when the battery runs low: a strip near the pilots
    // with a clear approach, any way the wind allows (no more than 3 m/s
    // across it and 1.5 m/s behind).
    launch.landAt = search(EVERY_WAY, (st) => {
      const c = headwind(st);
      return windSpeed * Math.sqrt(Math.max(0, 1 - c * c)) <= 3 && -windSpeed * c <= 1.5 && ok(st);
    });
    if (launch.landAt) launch.landAt.kind = 'landing (battery low)';
    return launch;
  }
  return null;
}

/** Turns from into wind, every 10° round (after the first 30° either side). */
const EVERY_WAY = [40, -40, 50, -50, 60, -60, 70, -70, 80, -80, 90, -90, 100, -100, 110, -110, 120, -120, 130, -130, 140, -140, 150, -150, 160, -160, 170, -170, 180];

/** Same strip? (Close enough that the AI flyers needn't start over.) */
export function sameStrip(a, b) {
  if (!a || !b) return a === b;
  return a.dir.x * b.dir.x + a.dir.z * b.dir.z > Math.cos(15 * deg) && Math.hypot(a.x - b.x, a.z - b.z) < 10;
}
