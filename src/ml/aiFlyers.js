// AI flyers in the game: a few aeroplanes flown by trained neural-network
// policies (src/ml/aiPilot.js), sharing the sky with you. Each one is shown
// to the multiplayer renderer (src/view/peers.js) as if it were another
// player, so it gets its model, name label, off-screen marker, shadow and
// nav lights, and can collide with you. Only you see them: they aren't sent
// to other players.
//
// Policies live in src/ml/policies/: <aircraft id>.json flies from point to
// point (every AI flyer needs it), and <aircraft id>.<skill>.json the other
// skills (takeoff, land, taxi, aero: see src/ml/aiPilot.js). They are made
// with ml/export-policy.js from a training run and loaded when first wanted.
// With take-off and landing (and taxiing, if it has wheels) a model flies a
// full day of circuits; without, it wanders over the field.
import { AiPilot } from './aiPilot.js';
import { encodeState } from '../net/multiplayer.js';

const POLICY_FILES = import.meta.glob('./policies/*.json', { import: 'default' });
const loaders = Object.fromEntries(Object.entries(POLICY_FILES).map(([path, load]) => [path.split('/').pop().replace(/\.json$/, ''), load]));

export const SKILLS = ['takeoff', 'land', 'taxi', 'aero'];

/** Aircraft ids that have a trained policy. */
export const AI_AIRCRAFT = Object.keys(loaders).filter((k) => !k.includes('.')).sort();

/** The skills an aircraft has policies for (besides flying from point to point). */
export function skillsOf(id) {
  return SKILLS.filter((s) => loaders[`${id}.${s}`]);
}

const cache = new Map();
function loadPolicy(key) {
  if (!cache.has(key)) cache.set(key, loaders[key]());
  return cache.get(key);
}

/** Every policy an aircraft has: { fly, takeoff?, land?, taxi?, aero? }. */
async function loadSkills(id) {
  const names = ['fly', ...skillsOf(id)];
  const files = await Promise.all(names.map((n) => loadPolicy(n === 'fly' ? id : `${id}.${n}`)));
  return Object.fromEntries(names.map((n, i) => [n, files[i]]));
}

export class AiFlyers {
  /**
   * @param {object} env   { ground, wind, obstacles } (as for Aircraft)
   * @param {object} field { x, z, radius } where they fly, and for circuits
   *                       `strip` (src/ml/guidance.js Strip) and `pilot` { x, z }
   * @param {(id: string) => object} getEntry  aircraft registry lookup
   */
  constructor(env, field, getEntry) {
    this.env = env;
    // One runway for them all: whoever has it is taking off or landing.
    this.field = { ...field, runway: { owner: null } };
    this.getEntry = getEntry;
    this.pilots = []; // { id, aircraft, pilot }
    /** For src/view/peers.js: id -> { id, name, aircraft, ai: true, buf }. */
    this.peers = new Map();
    this.wanted = '';
  }

  /** Which aircraft each of `count` flyers gets: 'mix', 'same' (as `mine`) or an aircraft id. */
  static choose(count, which, mine) {
    if (!AI_AIRCRAFT.length) return [];
    const pool = which === 'same' && AI_AIRCRAFT.includes(mine) ? [mine] : AI_AIRCRAFT.includes(which) ? [which] : AI_AIRCRAFT;
    return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
  }

  /**
   * Have `count` flyers of `which`. Flyers that keep their aircraft carry
   * on; the rest are replaced. Resolves once their policies have loaded.
   */
  async set(count, which, mine) {
    const ids = AiFlyers.choose(count, which, mine);
    const key = ids.join(',');
    this.wanted = key;
    const policies = await Promise.all(ids.map(loadSkills));
    if (this.wanted !== key) return; // asked for something else meanwhile
    const next = ids.map((aircraft, i) => {
      const old = this.pilots[i];
      if (old && old.aircraft === aircraft) return old;
      const def = this.getEntry(aircraft).def;
      const id = `ai${i + 1}`;
      // Every other one starts in the circuit, so there's something to watch at once.
      return { id, aircraft, pilot: new AiPilot(def, policies[i], this.env, this.field, Math.random, { id, slot: i, airborne: i % 2 === 1 }) };
    });
    this.pilots = next;
    this.peers.clear();
    for (const p of this.pilots) {
      const pilot = p.pilot;
      this.peers.set(p.id, {
        id: p.id,
        name: `AI ${p.id.slice(2)}`,
        aircraft: p.aircraft,
        ai: true,
        // A stand-in for the network snapshot buffer: always the live state.
        buf: {
          sample(_t, out) {
            const ac = pilot.ac;
            out.p.copy(ac.position);
            out.q.copy(ac.orientation);
            out.state = encodeState(ac);
            return true;
          },
          age: () => 0,
        },
      });
    }
  }

  /** Step them all (not while paused). */
  update(dt) {
    for (const p of this.pilots) p.pilot.update(dt);
  }

  /** You flew into one: it crashes, and the part that was hit breaks off. */
  hit(id, part, speed) {
    const p = this.pilots.find((x) => x.id === id);
    if (!p) return;
    p.pilot.ac.crash('Collided');
    p.pilot.ac.breakAt({ part, crashSpeed: 3 }, speed);
  }

  /** Start them all again (e.g. after the scenery changed). */
  respawnAll() {
    this.field.runway.owner = null;
    for (const p of this.pilots) p.pilot.spawn();
  }

  /** A new strip (the wind changed round): everyone starts again from the pits. */
  setStrip(strip) {
    this.field.strip = strip;
    this.respawnAll();
  }
}
