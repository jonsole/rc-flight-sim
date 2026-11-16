// Trees and bushes out of leaf catch less: only their inner branches, and
// less firmly (src/sim/obstacles.js setLeafiness).
import { describe, it, expect, afterEach } from 'vitest';
import { Obstacles, setLeafiness } from '../src/sim/obstacles.js';

/** A crown-frame point to the world (as drawn: turned and sized). */
function toWorld(s, [lx, ly, lz]) {
  return [s.cx + (lx * s.cos + lz * s.sin) * s.sx, s.cy + ly * s.sy, s.cz + (-lx * s.sin + lz * s.cos) * s.sx];
}
/** Out at fraction f of an outer clump's radius, away from the crown's middle. */
function outerPoint(s, f) {
  const [cx, cy, cz, r] = s.clumps.reduce((a, b) => (Math.hypot(b[0], b[1], b[2]) > Math.hypot(a[0], a[1], a[2]) ? b : a));
  const d = Math.hypot(cx, cy, cz);
  return toWorld(s, [cx + (cx / d) * r * f, cy + (cy / d) * r * f, cz + (cz / d) * r * f]);
}

describe('bare trees', () => {
  afterEach(() => setLeafiness(1));
  const ob = new Obstacles();
  const crown = ob.shapes.find((s) => s.type === 'crown');
  const bush = ob.shapes.find((s) => s.type === 'ellipsoid' && s.deciduous);

  it('in leaf the whole crown catches; bare, only its middle', () => {
    expect(crown).toBeTruthy();
    const outer = outerPoint(crown, 0.7);
    const [cx, cy, cz] = crown.clumps[crown.clumps.length - 1]; // the big one in the middle
    const inner = toWorld(crown, [cx, cy, cz]);
    setLeafiness(1);
    expect(Obstacles.test(crown, ...outer)?.soft).toBe(true);
    expect(Obstacles.test(crown, ...outer).sparse).toBe(0);
    setLeafiness(0);
    expect(Obstacles.test(crown, ...outer)).toBeNull();
    const hit = Obstacles.test(crown, ...inner);
    expect(hit?.soft).toBe(true);
    expect(hit.sparse).toBe(1);
  });

  it('bushes too', () => {
    if (!bush) return;
    const edge = [bush.cx + bush.rx * 0.8, bush.cy, bush.cz];
    setLeafiness(1);
    expect(Obstacles.test(bush, ...edge)?.soft).toBe(true);
    setLeafiness(0);
    expect(Obstacles.test(bush, ...edge)).toBeNull();
  });
});
