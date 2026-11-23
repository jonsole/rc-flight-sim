#!/usr/bin/env node
// Fly AI flyers (src/ml/aiPilot.js) through a day at the club field, in the
// game's own world (terrain, trees, wind), without the browser, and log
// every change of phase: taxi, take-off, circuits, aerobatics, landing.
//
//   node ml/fly-day.js --aircraft hobbyzone-aeroscout --minutes 10
//   node ml/fly-day.js --aircraft mix --flyers 4 --quiet
//
// Uses the policies in src/ml/policies/ (as the game does).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { physicsGround as ground } from '../src/sim/terrain.js';
import { Obstacles } from '../src/sim/obstacles.js';
import { Wind } from '../src/sim/wind.js';
import { clubAngle, clubToWorld, pilotSpot } from '../src/sim/location.js';
import { RUNWAY } from '../src/sim/terrain.js';
import { AiPilot } from '../src/ml/aiPilot.js';
import { Strip } from '../src/ml/guidance.js';
import { makeRng } from './env.js';
import { getEntry, aircraftIds } from './aircraft.js';

const o = { aircraft: 'hobbyzone-aeroscout', flyers: 1, minutes: 10, seed: 1, wind: 3, windDir: 270, airborne: false, quiet: false };
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

const DIR = fileURLToPath(new URL('../src/ml/policies/', import.meta.url));
const read = (name) => (existsSync(`${DIR}${name}.json`) ? JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8')) : null);
const skillsFor = (id) => ({ fly: read(id), takeoff: read(`${id}.takeoff`), land: read(`${id}.land`), taxi: read(`${id}.taxi`), aero: read(`${id}.aero`) });
const withPolicies = aircraftIds().filter((id) => read(id));
const ids = o.aircraft === 'mix' ? Array.from({ length: o.flyers }, (_, i) => withPolicies[i % withPolicies.length]) : Array(o.flyers).fill(o.aircraft);

const obstacles = new Obstacles();
const wind = new Wind();
wind.setTrees(obstacles.trees);
wind.speed = o.wind;
wind.directionDeg = o.windDir;
const A = clubAngle();
const heading = (Math.sin((o.windDir * Math.PI) / 180 - A) > 0 ? 0 : Math.PI) - A;
const [cx, cz] = clubToWorld(RUNWAY.x, RUNWAY.z);
const [px, pz] = pilotSpot();
const strip = new Strip({ x: cx, z: cz, dir: { x: Math.cos(heading), z: -Math.sin(heading) }, length: Math.max(RUNWAY.length, 90), width: Math.max(RUNWAY.width, 14) });
const field = { x: cx, z: cz, radius: 150, strip, pilot: { x: px, z: pz }, runway: { owner: null } };
const rng = makeRng(o.seed);
const pilots = ids.map((id, i) => new AiPilot(getEntry(id).def, skillsFor(id), { ground, wind, obstacles }, field, rng, { id: `ai${i + 1}`, slot: i, airborne: o.airborne }));

const log = (...a) => o.quiet || console.log(...a);
log(`${ids.join(', ')} | strip ${strip.length} m heading ${((heading * 180) / Math.PI).toFixed(0)}° | wind ${o.wind} m/s from ${o.windDir}° | circuits: ${pilots.map((p) => p.circuits).join(', ')}`);
const dt = 1 / 60;
const last = pilots.map(() => '');
const crashes = pilots.map(() => 0);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
for (let t = 0; t < o.minutes * 60; t += dt) {
  wind.update(dt);
  pilots.forEach((p, i) => {
    p.update(dt);
    const ac = p.ac;
    if (p.crashes > crashes[i]) {
      crashes[i] = p.crashes;
      log(`${fmt(t)}  ai${i + 1}  CRASHED (${p.lastCrash ?? 'see above'})`);
    }
    if (ac.crashed && !p._logged) {
      p._logged = true;
      log(`${fmt(t)}  ai${i + 1}  crash: ${ac.crashReason} in ${p.status} at ${ac.position.y.toFixed(1)} m, ${ac.airspeed.toFixed(1)} m/s`);
    } else if (!ac.crashed) p._logged = false;
    if (p.status !== last[i]) {
      last[i] = p.status;
      const agl = ac.position.y - ground.heightAt(ac.position.x, ac.position.z);
      log(`${fmt(t)}  ai${i + 1}  ${p.status.padEnd(28)} s ${strip.along(ac.position).toFixed(0).padStart(5)}  side ${strip.lateral(ac.position).toFixed(0).padStart(5)}  agl ${agl.toFixed(1).padStart(5)}  ${ac.airspeed.toFixed(1)} m/s`);
    }
  });
}
console.log('\nai    aircraft                  flights  landings  crashes  manoeuvres');
pilots.forEach((p, i) => console.log(`ai${i + 1}   ${ids[i].padEnd(24)}  ${String(p.flights).padStart(7)}  ${String(p.landings).padStart(8)}  ${String(p.crashes + (p.ac.crashed ? 1 : 0)).padStart(7)}  ${p.done.join(' ')}`));
