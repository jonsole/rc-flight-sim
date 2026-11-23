#!/usr/bin/env node
// Fly a trained policy on flights it never trained on and report how it did.
//
//   node ml/eval.js --policy ml/runs/hold-hobbyzone-aeroscout/best.json
//   node ml/eval.js --policy none --task hold      (hands off: the baseline)
//   node ml/eval.js --policy <file> --trace trace.csv   (every step of flight 1)
//
// Aircraft and task default to the ones the policy was trained for.
import { readFileSync, writeFileSync } from 'node:fs';
import { FlightEnv, runEpisode } from './env.js';
import { PHASE_TASKS, TASK_SECONDS } from './tasks.js';
import { getEntry } from './aircraft.js';
import { Policy, toControls } from '../src/ml/policy.js';
import { OBS_NAMES } from '../src/ml/observe.js';

const o = { policy: 'none', aircraft: '', task: '', episodes: 20, seconds: 0, wind: 4, seed: 5_000_000, trace: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i].slice(2);
  if (!(k in o)) {
    console.error(`unknown option ${argv[i]}`);
    process.exit(1);
  }
  o[k] = typeof o[k] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
}

let policy;
let meta = {};
if (o.policy === 'none') {
  // Hands off at half throttle.
  policy = { forward: (_, a) => a.fill(0) };
} else {
  const j = JSON.parse(readFileSync(o.policy, 'utf8'));
  policy = Policy.fromJSON(j);
  meta = j.meta || {};
}
const aircraft = (o.aircraft || (meta.aircraft || ['hobbyzone-aeroscout']).join(',')).split(',');
const task = o.task || meta.task || 'hold';
const seconds = o.seconds || (PHASE_TASKS[task] ? TASK_SECONDS[task] : meta.trainedFor) || 20;

const rows = [];
let trace = null;
for (const id of aircraft) {
  const env = new FlightEnv(getEntry(id).def, { task, seconds, windMax: o.wind, inputs: meta.inputs ?? (o.policy === 'none' ? 'sim' : 'v1') });
  for (let i = 0; i < o.episodes; i++) {
    const seed = o.seed + i;
    let onStep;
    if (o.trace && !trace) {
      trace = [];
      const c = {};
      onStep = (e, a, r) => {
        const ac = e.ac;
        const at = ac.attitude();
        toControls(a, c);
        trace.push([
          e.t.toFixed(2), ac.position.x.toFixed(2), ac.position.y.toFixed(2), ac.position.z.toFixed(2),
          ((at.heading * 180) / Math.PI).toFixed(1), ((at.pitch * 180) / Math.PI).toFixed(1), ((at.roll * 180) / Math.PI).toFixed(1),
          ac.airspeed.toFixed(2), e.target.x.toFixed(1), e.target.y.toFixed(1), e.target.z.toFixed(1), e.target.speed.toFixed(2),
          c.roll.toFixed(3), c.pitch.toFixed(3), c.yaw.toFixed(3), c.throttle.toFixed(3), r.toFixed(4),
          ...Array.from(e.full, (x) => x.toFixed(3)),
        ].join(','));
      };
    }
    const r = runEpisode(env, policy, seed, onStep);
    rows.push({ aircraft: id, seed, ret: r.ret, ...r.info });
  }
}

const f = (x, d = 1) => (x == null ? '   -' : x.toFixed(d).padStart(6));
console.log(`policy ${o.policy} | inputs ${meta.inputs ? meta.inputs.length : 'all'} | task ${task} | ${seconds} s flights | wind up to ${o.wind} m/s\n`);
const phase = !!PHASE_TASKS[task];
const short = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v));
if (phase) {
  // Take-off, landing, taxi, aerobatics: their own figures (ml/tasks.js summary()).
  for (const r of rows) {
    const extra = Object.entries(r).filter(([k]) => !['aircraft', 'seed', 'ret', 'reason', 'crashed', 'success', 'waypoints', 'meanAltErr', 'meanHdgErrDeg', 'meanSpdErr'].includes(k));
    console.log(`${r.aircraft.padEnd(24)} ${String(r.seed).padStart(8)} ${f(r.ret, 2)}  ${r.reason.slice(0, 22).padEnd(22)} ${extra.map(([k, v]) => `${k} ${v == null ? '-' : short(v)}`).join('  ')}`);
  }
  const ok = rows.filter((r) => r.success).length;
  console.log(`\nmean return ${(rows.reduce((a, r) => a + r.ret, 0) / rows.length).toFixed(2)} | succeeded ${ok}/${rows.length} | crashes ${rows.filter((r) => r.crashed).length}/${rows.length}`);
}
if (!phase) console.log('aircraft                  seed     return  end            alt err  hdg err  spd err  min AGL  wpts');
for (const r of phase ? [] : rows) {
  console.log(
    `${r.aircraft.padEnd(24)} ${String(r.seed).padStart(8)} ${f(r.ret, 2)}  ${r.reason.slice(0, 14).padEnd(14)} ${f(r.meanAltErr)} m ${f(r.meanHdgErrDeg)}°  ${f(r.meanSpdErr)}  ${f(r.minAgl)}   ${r.waypoints}`,
  );
}
const mean = (k) => {
  const v = rows.map((r) => r[k]).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
if (!phase) console.log(
  `\nmean return ${mean('ret').toFixed(2)} | crashes ${rows.filter((r) => r.crashed).length}/${rows.length}` +
    (mean('meanAltErr') != null ? ` | alt err ${mean('meanAltErr').toFixed(1)} m | heading err ${mean('meanHdgErrDeg').toFixed(1)}° | speed err ${mean('meanSpdErr').toFixed(2)} m/s` : '') +
    (task === 'waypoints' ? ` | waypoints ${mean('waypoints').toFixed(1)} per flight` : ''),
);
if (trace) {
  const head = 't,x,y,z,headingDeg,pitchDeg,rollDeg,airspeed,targetX,targetY,targetZ,targetSpeed,roll,pitch,yaw,throttle,reward,' + OBS_NAMES.map((n) => `obs_${n}`).join(',');
  writeFileSync(o.trace, `${head}\n${trace.join('\n')}\n`);
  console.log(`trace of flight 1 → ${o.trace}`);
}
