import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Policy, paramCount, toControls } from '../src/ml/policy.js';
import { OBS_SIZE, OBS_NAMES, INPUT_SETS, resolveInputs } from '../src/ml/observe.js';
import { FlightEnv, runEpisode, makeRng } from '../ml/env.js';
import { ES, centredRanks } from '../ml/es.js';
import { getEntry, aircraftIds } from '../ml/aircraft.js';
import { AIRCRAFT } from '../src/aircraft/index.js';
import { train } from '../ml/train.js';

const handsOff = { forward: (_, a) => a.fill(0) };

describe('ML policy network', () => {
  it('has the expected number of weights and output range', () => {
    expect(paramCount(23, [32, 32])).toBe(32 * 24 + 32 * 33 + 4 * 33);
    const p = new Policy(OBS_SIZE, [16]).init(makeRng(3));
    const obs = Float64Array.from({ length: OBS_SIZE }, (_, i) => Math.sin(i) * 5);
    const a = p.forward(obs);
    expect(a.length).toBe(4);
    for (const x of a) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    expect(p.forward(obs)).toEqual(a);
    const c = toControls([0, 0, 0, -1]);
    expect(c.throttle).toBe(0);
  });

  it('survives a round trip through JSON', () => {
    const p = new Policy(OBS_SIZE, [8, 8]).init(makeRng(1));
    const q = Policy.fromJSON(JSON.parse(JSON.stringify(p.toJSON({ task: 'hold' }))));
    const obs = new Float64Array(OBS_SIZE).fill(0.3);
    expect(q.forward(obs)).toEqual(p.forward(obs));
  });
});

describe('ML training environment', () => {
  it('builds the same flight models as the game', () => {
    expect(aircraftIds().sort()).toEqual(AIRCRAFT.map((a) => a.id).sort());
    for (const a of AIRCRAFT) expect(getEntry(a.id).def).toEqual(a.def);
  });

  it('gives finite observations of the right size', () => {
    expect(OBS_NAMES.length).toBe(OBS_SIZE);
    for (const task of ['hold', 'waypoints', 'recover']) {
      const env = new FlightEnv(getEntry('buschtrottel-shockcub').def, { task, seconds: 1 });
      const obs = env.reset(7);
      expect(obs.length).toBe(OBS_SIZE);
      expect(Array.from(obs).every(Number.isFinite)).toBe(true);
    }
  });

  it('gives a policy only the inputs it was trained on', () => {
    expect(INPUT_SETS.hardware).not.toContain('alpha');
    expect(INPUT_SETS.hardware).not.toContain('wingStall');
    expect(resolveInputs('airspeed,rollRate')).toEqual(['airspeed', 'rollRate']);
    expect(() => resolveInputs('airspeed,nonsense')).toThrow();
    const def = getEntry('buschtrottel-shockcub').def;
    const full = new FlightEnv(def, { seconds: 1 });
    const hw = new FlightEnv(def, { seconds: 1, inputs: 'hardware' });
    expect(hw.obsSize).toBe(OBS_SIZE - 3);
    const a = full.reset(9);
    const b = hw.reset(9);
    expect(Array.from(b)).toEqual(INPUT_SETS.hardware.map((n) => a[OBS_NAMES.indexOf(n)]));
  });

  it('repeats a flight exactly from its seed', () => {
    const env = new FlightEnv(getEntry('buschtrottel-shockcub').def, { task: 'hold', seconds: 2 });
    const a = runEpisode(env, handsOff, 42);
    const b = runEpisode(env, handsOff, 42);
    const c = runEpisode(env, handsOff, 43);
    expect(b.ret).toBe(a.ret);
    expect(c.ret).not.toBe(a.ret);
    expect(a.info.reason).toBe('time');
  });

  it('ends the flight and penalises hitting the ground', () => {
    const env = new FlightEnv(getEntry('buschtrottel-shockcub').def, { task: 'hold', seconds: 30, windMax: 0 });
    // Full down elevator at full power: it bunts round until it hits the ground.
    const pushDown = { forward: (_, a) => { a.fill(0); a[1] = -1; a[3] = 1; return a; } };
    const crashed = runEpisode(env, pushDown, 1);
    expect(crashed.info.crashed).toBe(true);
    expect(crashed.ret).toBeLessThan(runEpisode(env, handsOff, 1).ret);
    expect(crashed.info.seconds).toBeLessThan(30);
  });
});

describe('Evolution Strategies', () => {
  it('ranks fitness evenly from -0.5 to 0.5', () => {
    expect(centredRanks([10, -3, 4])).toEqual([0.5, -0.5, 0]);
  });

  it('climbs a simple objective', () => {
    const target = Float64Array.from({ length: 20 }, (_, i) => Math.cos(i));
    const f = (x) => -x.reduce((s, v, i) => s + (v - target[i]) ** 2, 0);
    const theta = new Float64Array(20);
    const es = new ES(theta, { pairs: 16, sigma: 0.1, lr: 0.05, l2: 0, seed: 2 });
    const start = f(theta);
    for (let g = 0; g < 150; g++) es.tell(es.ask().map(f));
    expect(f(theta)).toBeGreaterThan(start * 0.05);
  });

  it('runs a short training session and saves a policy', async () => {
    const out = mkdtempSync(join(tmpdir(), 'rcml-'));
    try {
      const r = await train({ aircraft: 'buschtrottel-shockcub', gens: 2, pairs: 2, episodes: 1, seconds: 1, hidden: '4', evalEvery: 1, evalEpisodes: 1, workers: 1, out, name: 't', quiet: true });
      expect(existsSync(join(r.dir, 'best.json'))).toBe(true);
      const j = JSON.parse(readFileSync(join(r.dir, 'best.json'), 'utf8'));
      expect(Policy.fromJSON(j).hidden).toEqual([4]);
      expect(readFileSync(join(r.dir, 'log.csv'), 'utf8').trim().split('\n').length).toBe(3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('warm start', () => {
  it('flies exactly like the old policy until the new inputs are used', async () => {
    const { warmStart } = await import('../ml/train.js');
    const { INPUT_SETS: S } = await import('../src/ml/observe.js');
    const old = new Policy(S.v1.length, [8]).init(makeRng(5));
    const neu = warmStart(new Policy(S.sim.length, [8]), S.sim, old, S.v1);
    const full = Float64Array.from({ length: S.sim.length }, (_, i) => Math.cos(i * 1.7));
    const legacy = Float64Array.from(S.v1, (n) => full[S.sim.indexOf(n)]);
    expect(Array.from(neu.forward(full))).toEqual(Array.from(old.forward(legacy)));
  });
});
