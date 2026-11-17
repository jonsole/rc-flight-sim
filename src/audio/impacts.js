// One-off sounds for things the model hits (src/sim/aircraft.js `impacts`):
// short bursts of filtered noise and decaying tones, louder the harder the
// hit. Played through the engine's output, so they fade with distance too.
//   ground  a dull thud and a swish of grass
//   wheel   a tyre's bump on touching down
//   wood    a tree trunk or branch: a sharp crack and a low knock
//   hard    a building, a table: a hollow thud
//   metal   a fence, a car, a pole: a clang that rings on
//   twigs   flying into a tree's leaves: twigs snapping, leaves thrashing
//   crunch  a wing, tail or wheel breaking off: foam crackling
//   prop    a prop strike: a quick clatter of the blades

/** A burst of filtered noise. */
function burst(ctx, out, buf, at, { type = 'bandpass', freq = 1000, q = 1, dur = 0.1, gain = 0.5 }) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.002);
  g.gain.setTargetAtTime(0, at + 0.002, dur / 3);
  src.connect(f).connect(g).connect(out);
  src.start(at, Math.random() * (buf.duration - 1));
  src.stop(at + dur * 2 + 0.05);
}

/** A decaying tone, dropping in pitch (a knock, a thud, a ring). */
function tone(ctx, out, at, { freq = 100, to = freq, dur = 0.15, gain = 0.5, type = 'sine' }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.003);
  g.gain.setTargetAtTime(0, at + 0.003, dur / 3);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur * 2 + 0.05);
}

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Play the sound of a hit.
 * @param {AudioContext} ctx
 * @param {AudioNode} out
 * @param {AudioBuffer} buf  white noise (a second or more)
 * @param {{ kind: string, speed: number }} hit
 */
export function playImpact(ctx, out, buf, { kind, speed }) {
  const at = ctx.currentTime + 0.005;
  // How hard: ~0.2 for a gentle touch, 1 for a crash-speed hit.
  const s = Math.min(1.4, Math.max(0.15, speed / 6)) * 0.6;
  switch (kind) {
    case 'ground':
      tone(ctx, out, at, { freq: 75, to: 45, dur: 0.16, gain: 0.9 * s });
      burst(ctx, out, buf, at, { type: 'lowpass', freq: 320, dur: 0.18, gain: 1.2 * s });
      burst(ctx, out, buf, at, { freq: 2600, q: 0.7, dur: 0.12, gain: 0.25 * s });
      break;
    case 'wheel':
      tone(ctx, out, at, { freq: 120, to: 85, dur: 0.08, gain: 0.5 * s });
      burst(ctx, out, buf, at, { type: 'lowpass', freq: 600, dur: 0.06, gain: 0.35 * s });
      break;
    case 'wood':
      burst(ctx, out, buf, at, { freq: 2300, q: 3, dur: 0.04, gain: 1.4 * s });
      tone(ctx, out, at, { freq: 200, to: 150, dur: 0.12, gain: 0.7 * s, type: 'triangle' });
      burst(ctx, out, buf, at, { type: 'lowpass', freq: 450, dur: 0.1, gain: 0.6 * s });
      break;
    case 'hard':
      tone(ctx, out, at, { freq: 100, to: 70, dur: 0.2, gain: 0.8 * s });
      burst(ctx, out, buf, at, { freq: 700, q: 1.5, dur: 0.12, gain: 0.8 * s });
      break;
    case 'metal':
      burst(ctx, out, buf, at, { type: 'highpass', freq: 3000, dur: 0.03, gain: 0.6 * s });
      [820, 1310, 2150, 3370].forEach((f, i) => tone(ctx, out, at, { freq: f * rand(0.97, 1.03), dur: 0.6 - i * 0.1, gain: (0.3 * s) / (1 + i * 0.6) }));
      break;
    case 'twigs':
      burst(ctx, out, buf, at, { type: 'highpass', freq: 1800, dur: 0.4, gain: 0.5 * s });
      for (let i = 0; i < 9; i++) burst(ctx, out, buf, at + rand(0, 0.35), { freq: rand(2500, 4500), q: 4, dur: 0.02, gain: rand(0.5, 1.1) * s });
      break;
    case 'crunch':
      burst(ctx, out, buf, at, { type: 'lowpass', freq: 400, dur: 0.1, gain: 0.7 * s });
      for (let i = 0; i < 14; i++) burst(ctx, out, buf, at + rand(0, 0.2), { freq: rand(1500, 3200), q: 2, dur: 0.015, gain: rand(0.4, 0.9) * s });
      break;
    case 'prop':
      for (let i = 0; i < 8; i++) {
        const t = at + i * 0.028;
        const g = (1 - i / 9) * 0.9 * Math.max(s, 0.4);
        burst(ctx, out, buf, t, { freq: 3000, q: 2, dur: 0.012, gain: g });
        tone(ctx, out, t, { freq: 650, to: 500, dur: 0.02, gain: 0.3 * g, type: 'square' });
      }
      break;
  }
}
