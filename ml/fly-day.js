#!/usr/bin/env node
// Fly AI flyers (src/ml/aiPilot.js) through a day at the club field, in the
// game's own world (terrain, trees, wind), without the browser, and log
// every change of phase: taxi, take-off, circuits, aerobatics, landing.
//
//   node ml/fly-day.js --aircraft hobbyzone-aeroscout --minutes 10
//   node ml/fly-day.js --aircraft mix --flyers 4 --quiet
//   node ml/fly-day.js --field waterbeach --wind 7 --windDir 200
//
// Uses the policies in src/ml/policies/ (as the game does).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setLocation } from '../src/sim/location.js';

const o = { aircraft: 'hobbyzone-aeroscout', flyers: 1, minutes: 10, seed: 1, wind: 3, windDir: 270, field: 'home', airborne: false, stripOnly: false, trace: '', from: 0, quiet: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].slice(2);
  if (!(k in o)) {
    console.error(`unknown option ${argv[i]}`);
    process.exit(1);
  }
  if (typeof o[k] === 'boolean') o[k] = true;
  else o[k] = typeof o[k] === 'number' ? Number(argv[++i]) : argv[++i];
}

// The field first: the terrain and trees are built from it when loaded.
if (o.field !== 'home') {
  const data = JSON.parse(readFileSync(fileURLToPath(new URL(`../src/locations/${o.field}.json`, import.meta.url)), 'utf8'));
  setLocation(o.field, data);
}
const { physicsGround: ground, RUNWAY } = await import('../src/sim/terrain.js');
const { Obstacles } = await import('../src/sim/obstacles.js');
const { Wind } = await import('../src/sim/wind.js');
const { clubToWorld, pilotSpot } = await import('../src/sim/location.js');
const { AiPilot } = await import('../src/ml/aiPilot.js');
const { chooseStrip } = await import('../src/ml/fieldStrip.js');
const { makeRng } = await import('./env.js');
const { getEntry, aircraftIds } = await import('./aircraft.js');

const DIR = fileURLToPath(new URL('../src/ml/policies/', import.meta.url));
const read = (name) => (existsSync(`${DIR}${name}.json`) ? JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8')) : null);
const skillsFor = (id) => ({ fly: read(id), takeoff: read(`${id}.takeoff`), land: read(`${id}.land`), taxi: read(`${id}.taxi`), aero: read(`${id}.aero`) });
const withPolicies = aircraftIds().filter((id) => read(id) && read(`${id}.takeoff`) && read(`${id}.land`)); // (as the game's AI_AIRCRAFT)
const ids = o.aircraft === 'mix' ? Array.from({ length: o.flyers }, (_, i) => withPolicies[i % withPolicies.length]) : Array(o.flyers).fill(o.aircraft);

const obstacles = new Obstacles();
const wind = new Wind();
wind.setTrees(obstacles.trees);
wind.speed = o.wind;
wind.directionDeg = o.windDir;
const [cx, cz] = clubToWorld(RUNWAY.x, RUNWAY.z);
const [px, pz] = pilotSpot();
const strip = chooseStrip({ windFromDeg: o.windDir, windSpeed: o.wind, ground, obstacles, pilot: { x: px, z: pz } });
const heading = strip?.heading ?? 0;
const glideDeg = (st) => Math.round(((st?.glide ?? (7 * Math.PI) / 180) * 180) / Math.PI);
if (o.stripOnly) {
  const compass = strip ? (Math.atan2(strip.dir.x, -strip.dir.z) * 180) / Math.PI : 0;
  if (!strip) console.log(`${o.field}, wind ${o.wind} m/s from ${o.windDir}°: nowhere clear (they fly round)`);
  else console.log(`${o.field}, wind ${o.wind} m/s from ${o.windDir}°: ${strip.kind}, ${strip.length} m, ${glideDeg(strip)}° approach, centre ${strip.x.toFixed(0)},${strip.z.toFixed(0)}, rolling toward ${Math.round((compass + 360) % 360)}°`);
  process.exit(0);
}
const field = { x: cx, z: cz, radius: 90, strip, pilot: { x: px, z: pz }, runway: { owner: null }, windSpeed: o.wind };
const rng = makeRng(o.seed);
const pilots = ids.map((id, i) => new AiPilot(getEntry(id).def, skillsFor(id), { ground, wind, obstacles }, field, rng, { id: `ai${i + 1}`, slot: i, airborne: o.airborne }));

const log = (...a) => o.quiet || console.log(...a);
log(`${ids.join(', ')} | ${strip?.kind ?? 'no'} strip ${strip?.length ?? 0} m ${glideDeg(strip)}° approach, heading ${((heading * 180) / Math.PI).toFixed(0)}° | wind ${o.wind} m/s from ${o.windDir}° | circuits: ${pilots.map((p) => p.circuits).join(', ')}`);
const dt = 1 / 60;
const last = pilots.map(() => '');
const crashes = pilots.map(() => 0);
const farthest = pilots.map(() => 0); // horizontal distance from the pilots (line of sight)
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
for (let t = 0; t < o.minutes * 60; t += dt) {
  wind.update(dt);
  pilots.forEach((p, i) => {
    p.update(dt);
    const ac = p.ac;
    if (!ac.onGround) p.minCharge = Math.min(p.minCharge ?? 1, p.charge);
    const dist = Math.hypot(ac.position.x - px, ac.position.z - pz);
    if (dist > farthest[i]) {
      farthest[i] = dist;
      p._farPhase = p.status;
    }
    if (p.crashes > crashes[i]) {
      crashes[i] = p.crashes;
      log(`${fmt(t)}  ai${i + 1}  CRASHED (${p.lastCrash ?? 'see above'})`);
    }
    if (ac.crashed && !p._logged) {
      p._logged = true;
      log(`${fmt(t)}  ai${i + 1}  crash: ${ac.crashReason} in ${p.status} at ${(ac.position.y - ground.heightAt(ac.position.x, ac.position.z)).toFixed(1)} m up, s ${(strip?.along(ac.position) ?? 0).toFixed(0)} side ${(strip?.lateral(ac.position) ?? 0).toFixed(0)} (aim ${(strip?.aimS ?? 0).toFixed(0)}), ${ac.airspeed.toFixed(1)} m/s`);
    } else if (!ac.crashed) p._logged = false;
    // --trace ai3 --from 360: that flyer once a second from then.
    if (o.trace === `ai${i + 1}` && t >= o.from && Math.floor(t) !== Math.floor(t - dt)) {
      const at = ac.attitude();
      const agl = ac.position.y - ground.heightAt(ac.position.x, ac.position.z);
      const d = (r) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
      console.log(`${fmt(t)}  ${p.status.padEnd(22)} agl ${agl.toFixed(1).padStart(5)}  vy ${ac.velocity.y.toFixed(1).padStart(5)}  air ${ac.airspeed.toFixed(1).padStart(4)}  pitch ${d(at.pitch)} roll ${d(at.roll)}  thr ${ac.controls.throttle.toFixed(2)}  stall ${ac.wingStall.toFixed(2)}  target dy ${(p.target.y - ac.position.y).toFixed(0)} spd ${p.target.speed.toFixed(1)}`);
    }
    if (p.status !== last[i]) {
      last[i] = p.status;
      const agl = ac.position.y - ground.heightAt(ac.position.x, ac.position.z);
      log(`${fmt(t)}  ai${i + 1}  ${p.status.padEnd(28)} s ${(strip?.along(ac.position) ?? 0).toFixed(0).padStart(5)}  side ${(strip?.lateral(ac.position) ?? 0).toFixed(0).padStart(5)}  agl ${agl.toFixed(1).padStart(5)}  ${ac.airspeed.toFixed(1)} m/s`);
    }
  });
}
console.log('\nai    aircraft                  flights  landings  crashes  furthest  manoeuvres');
pilots.forEach((p, i) => console.log(`ai${i + 1}   ${ids[i].padEnd(24)}  ${String(p.flights).padStart(7)}  ${String(p.landings).padStart(8)}  ${String(p.crashes + (p.ac.crashed ? 1 : 0)).padStart(7)}  ${String(Math.round(farthest[i])).padStart(6)} m (${p._farPhase})  charge ${Math.round(p.charge * 100)}%${p.minCharge != null ? `, lowest ${Math.round(p.minCharge * 100)}%` : ''}  ${p.done.join(' ')}`));
