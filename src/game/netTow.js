// Insect net tow (Menu → Challenges): tow a fine net on a cord from the
// tail, climb to the sampling height and fly figure-of-8 circuits through
// the gates, catching the insects drifting up there. The difficulty is the
// net's size (easy: small, hard: large; Menu → Tuning has its size, drag and
// cord length while this challenge is on). The physics is src/sim/net.js;
// this puts it on the course: the figure of 8 is over the open part of the
// field (src/game/arena.js), along the pilot's view, its loops either side
// of the middle.
import { Group } from 'three';
import { NetTow, FigureEightChallenge, COURSE, netConfig } from '../sim/net.js';
import { NetView } from '../view/netView.js';
import { formatTime } from './courses.js';

export class NetTowCourse {
  static id = 'net';
  static title = 'Insect net tow';
  static about = 'Tow a fine insect net on a cord tied on under the model: climb to the sampling height, then fly three figures of 8 through the gates, following the directions on screen. The net starts folded and opens in the airflow, and drags hard: the harder the difficulty, the bigger the net. Gates only count at the sampling height. Keep the net out of the trees: it snags, and a hard pull snaps the cord. Net size, drag and cord length are under Tuning.';

  constructor(env) {
    this.env = env;
    this.group = new Group();
    this.state = 'ready';
    this.view = new NetView(this.group);
    const a = env.arena;
    // Loops a little bigger than the open ground: they're flown well above the trees.
    this.radius = Math.max(30, Math.min(COURSE.radius, a.r * 0.65));
    this.ch = null; // built on the first frame, once there's an aeroplane to tie the net to
  }

  #start(ac) {
    const env = this.env;
    const id = env.aircraftId ?? ac.def.id ?? 'model';
    const baseDef = env.aircraftDef ?? ac.def;
    this.cfg = netConfig(baseDef, id, env.level);
    const net = new NetTow(this.cfg, ac);
    ac.tow = net;
    net.place(ac);
    const a = env.arena;
    this.ch = new FigureEightChallenge(net, {
      ground: env.ground,
      base: a.g,
      center: { x: a.x, z: a.z },
      axis: { x: a.across[0], z: a.across[1] },
      side: { x: a.away[0], z: a.away[1] },
      course: { radius: this.radius },
    });
    this.view.set(this.ch);
    this.ac = ac;
  }

  update(ctx) {
    const ac = ctx.ac;
    // Tie the net on at the first frame. The flight model can be rebuilt in
    // flight (retuned): carry the same net on.
    if (!this.ch) this.#start(ac);
    else if (ac !== this.ac) {
      ac.tow = this.ch.net;
      this.ac = ac;
    }
    const ch = this.ch;
    const net = ch.net;
    this.view.update(ac, ctx.time, ctx.dt);
    if (this.state === 'done' || ac.crashed || net.snapped) {
      if (net.snapped && !this.snapSaid) {
        this.snapSaid = true;
        ctx.say('The cord snapped: net lost');
        ctx.sfx('fail');
      }
      return;
    }
    const before = ch.gateIndex;
    const wasHigh = ch.reachedHeight;
    ch.update(ctx.dt, ac.position);
    if (!wasHigh && ch.reachedHeight) ctx.say(`At ${COURSE.height} m: now the start gate`);
    if (ch.gateIndex !== before) {
      if (this.state === 'ready') this.state = 'running';
      if (ch.done) {
        this.state = 'done';
        ctx.sfx('finish');
      } else {
        const n = ((ch.gateIndex - 1) % 8);
        ctx.say(before === 0 ? 'Go! Figure 8 number 1' : n === 0 ? `Figure 8 number ${ch.lapsDone + 1}` : `Gate ${n} of 8`);
        ctx.sfx('ding');
      }
    }
  }

  /** Heading about the vertical (world), as the directions want it. */
  #heading(ac) {
    const q = ac.orientation;
    // Body +x in world: (1 - 2(y² + z²), 2(xy + wz), 2(xz − wy)).
    const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const fz = 2 * (q.x * q.z - q.w * q.y);
    return Math.atan2(-fz, fx);
  }

  status() {
    const ch = this.ch;
    if (!ch) return { line: '' };
    const net = ch.net;
    const insects = `${Math.floor(ch.caught)} insects`;
    if (this.state === 'done') return { line: `Three figures of 8! ${insects}` };
    if (net.snapped) return { line: 'Cord snapped: net lost · R to try again' };
    if (net.snagged) return { line: 'Net caught in a tree!' };
    const ac = this.ac;
    if (ac.held || (ac.onGround && !ch.reachedHeight)) return { line: `Take off and climb to ${COURSE.height} m · net ${Math.round(net.open * 100)}% open` };
    const d = ch.directions(ac.position, this.#heading(ac));
    const arrows = `${d.climb > 0 ? '⬆ ' : d.climb < 0 ? '⬇ ' : ''}${d.turn === 'left' ? '⬅ ' : d.turn === 'right' ? '➡ ' : ''}`;
    const turn = ch.reachedHeight ? (d.turn ? ` · turn ${d.turn}` : ' · straight on') : '';
    const fig = ch.started ? ` · figure 8: ${Math.min(ch.course.laps, ch.lapsDone + 1)} of ${ch.course.laps}` : '';
    return { line: `${arrows}${d.text}${turn}${fig} · ${insects}` };
  }

  target() {
    return this.ch && this.state !== 'done' && !this.ch.net.snapped ? this.ch.nextGate().pos : null;
  }

  score(time) {
    const text = `${formatTime(time)}, ${Math.floor(this.ch.caught)} insects`;
    // A tuned net isn't the standard one: no best.
    return this.cfg?.tuned ? { void: true, text: `${text} (tuned net: not a best)` } : { value: time, text };
  }

  dispose() {
    if (this.ac && this.ch && this.ac.tow === this.ch.net) this.ac.tow = null;
  }
}
