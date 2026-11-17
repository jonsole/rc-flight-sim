// The aircraft JSON files (src/aircraft/models): valid, read the way the
// README says, and their built-in tuning becomes the model's defaults.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { AIRCRAFT, fromJson, buildAircraft } from '../src/aircraft/index.js';
import { tunablesFor } from '../src/sim/tuning.js';

const dir = new URL('../src/aircraft/models/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('aircraft JSON files', () => {
  it('every file is valid, names its builder, and is an aircraft in the list', () => {
    expect(files.length).toBe(AIRCRAFT.length);
    for (const f of files) {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(['se5a', 'buschtrottel', 'f22', 'aeroscout']).toContain(j.builder);
      expect(f).toBe(`${j.id}.json`);
      expect(AIRCRAFT.some((a) => a.id === j.id)).toBe(true);
    }
  });

  it('reads …Deg angles as degrees and leaves notes out', () => {
    const o = fromJson({ elevatorThrowDeg: 12, throws: { aileronDeg: 22 }, notes: { x: 'y' }, mass: 0.45 });
    expect(o.elevatorThrow).toBeCloseTo((12 * Math.PI) / 180);
    expect(o.throws.aileron).toBeCloseTo((22 * Math.PI) / 180);
    expect(o.notes).toBeUndefined();
    expect(o.mass).toBe(0.45);
  });

  it('built-in tuning becomes the model\'s defaults', () => {
    const j = JSON.parse(readFileSync(new URL('buschtrottel-shockcub.json', dir), 'utf8'));
    const a = buildAircraft({ ...j, tuning: { elevator: 10, cells: 4 } });
    const dflt = (key) => tunablesFor(a.def).find((t) => t.key === key).dflt;
    expect(dflt('elevator')).toBeCloseTo(10);
    expect(dflt('cells')).toBe(4);
    expect(a.def.motor.maxRpm).toBeGreaterThan(AIRCRAFT.find((x) => x.id === j.id).def.motor.maxRpm);
  });
});
