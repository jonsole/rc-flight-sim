// Synthesised electric motor + propeller sound (no audio files needed).
import { propOrders } from './propTones.js';
import { playImpact } from './impacts.js';
export class EngineSound {
  constructor() {
    this.ctx = null;
    this.volume = 0.6;
    this.muted = false;
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Motor whine (two detuned oscillators through a band-pass)
    this.motor = ctx.createOscillator();
    this.motor.type = 'sawtooth';
    this.motor2 = ctx.createOscillator();
    this.motor2.type = 'square';
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'bandpass';
    this.motorFilter.Q.value = 2;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0.12;
    this.motor.connect(this.motorFilter);
    this.motor2.connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain).connect(this.master);

    // Prop buzz: amplitude-modulated noise at blade-pass frequency
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.frequency.value = 900;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.am = ctx.createOscillator();
    this.am.type = 'sine';
    this.amGain = ctx.createGain();
    this.amGain.gain.value = 0;
    this.am.connect(this.amGain).connect(this.noiseGain.gain);
    this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master);

    // The prop's tones: one wave at the shaft rate with a level for each
    // multiple of it (src/audio/propTones.js, or the aircraft's own).
    this.harm = ctx.createOscillator();
    this.harmGain = ctx.createGain();
    this.harmGain.gain.value = 0;
    this.harm.connect(this.harmGain).connect(this.master);
    this.harmKey = null;

    // Air over the wings: a whoosh that grows steeply with airspeed (heard
    // best gliding fast with the motor off), more at high angles of attack,
    // and a low, shaking rumble when the wing stalls (buffet).
    this.wind = ctx.createBufferSource();
    this.wind.buffer = buf;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.buffetFilter = ctx.createBiquadFilter();
    this.buffetFilter.type = 'lowpass';
    this.buffetFilter.frequency.value = 160;
    this.buffetGain = ctx.createGain();
    this.buffetGain.gain.value = 0;
    // The shaking: the rumble's level wobbles a few times a second.
    this.shake = ctx.createOscillator();
    this.shake.frequency.value = 7;
    this.shakeGain = ctx.createGain();
    this.shakeGain.gain.value = 0;
    this.shake.connect(this.shakeGain).connect(this.buffetGain.gain);
    this.wind.connect(this.buffetFilter).connect(this.buffetGain).connect(this.master);

    // Leaves and twigs brushing past while it's in a tree's foliage.
    this.noiseBuf = buf;
    this.rustle = ctx.createBufferSource();
    this.rustle.buffer = buf;
    this.rustle.loop = true;
    this.rustleFilter = ctx.createBiquadFilter();
    this.rustleFilter.type = 'highpass';
    this.rustleFilter.frequency.value = 1800;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    this.rustle.connect(this.rustleFilter).connect(this.rustleGain).connect(this.master);

    this.motor.start();
    this.shake.start();
    this.rustle.start(0, 1.3);
    this.motor2.start();
    this.harm.start();
    this.noise.start();
    this.am.start();
    this.wind.start(0, 0.7);
  }

  /**
   * @param listenerDistance  from the listener to the aircraft (m)
   * @param fpv  listening on board (no distance or Doppler)
   * @param [listener]  the listener's position (Vector3), for the Doppler shift
   */
  update(aircraft, listenerDistance, fpv, listener = null) {
    // Things hit since last time (src/audio/impacts.js).
    const hits = aircraft.impacts?.splice(0) ?? [];
    if (!this.ctx) return;
    if (!this.muted) for (const h of hits) playImpact(this.ctx, this.master, this.noiseBuf, h);
    const t = this.ctx.currentTime;
    // Doppler: higher coming towards the listener, lower going away.
    let dop = 1;
    if (!fpv && listener && aircraft.velocity && aircraft.position && listenerDistance > 0.5) {
      const p = aircraft.position;
      const v = aircraft.velocity;
      const towards = ((listener.x - p.x) * v.x + (listener.y - p.y) * v.y + (listener.z - p.z) * v.z) / listenerDistance;
      dop = Math.min(1.5, Math.max(0.7, 343 / (343 - towards)));
    }
    const rpm = aircraft.propBroken ? 0 : aircraft.rpm;
    const m = aircraft.def.motor;
    // The prop's tones (src/audio/propTones.js): its own, measured, if it has
    // them, else from its blades, tips and whether it's a pusher.
    // (Its own only with the prop they were measured with, not one changed in Tuning.)
    const blades = m.prop?.blades || m.blades || 2;
    const snd = aircraft.def.sound;
    const measured = snd?.shaftOrders && snd.forProp === `${blades}${m.prop?.tip}` ? snd.shaftOrders : null;
    const key = measured || `${blades}${m.prop?.tip}${!!m.pusher}`;
    if (key !== this.harmKey) {
      const orders = measured || propOrders({ blades, tip: m.prop?.tip, pusher: !!m.pusher });
      const real = new Float32Array(orders.length + 1);
      const imag = new Float32Array(orders.length + 1);
      orders.forEach((a, i) => (imag[i + 1] = a));
      this.harm.setPeriodicWave(this.ctx.createPeriodicWave(real, imag));
      this.harmKey = key;
    }
    const level = aircraft.def.sound?.level ?? 1;
    // (The prop as fitted or tuned, Menu → Tuning.)
    // Square-tipped (bullnose) blades are much noisier than tapered ones: the
    // wide, blunt tips shed strong tip vortices, a louder and harsher buzz.
    // A pusher's blades chop through the wake of the wing and fuselage ahead
    // of them every turn, which adds a rasp (propTones.js).
    const square = m.prop?.tip === 'square';
    const pusher = !!m.pusher;
    const loud = (square ? 1.7 : 1) * (pusher ? 1.25 : 1);
    const dia = m.prop?.diameterIn ? m.prop.diameterIn * 0.0254 : 2 * Math.sqrt((m.discArea || 0.03) / Math.PI);
    const motorHz = 40 + (rpm / 60) * 7; // 14-pole motor electrical freq / 2
    const bladeHz = Math.max(1, (rpm / 60) * blades);
    // How hard the motor works: the power from the battery, from a gentle
    // ~60 W to a hot setup's 600 W+ (none while the prop windmills).
    const watts = Math.max(0, (aircraft.battery?.current || 0) * (aircraft.battery?.voltage || 0));
    const load = Math.min(1.8, Math.sqrt(watts / 250));
    // Prop noise climbs steeply with blade tip speed (windmilling too).
    const tip = (rpm / 60) * Math.PI * dia;
    const whoosh = Math.min(1.6, (tip / 110) ** 2);
    this.motor.frequency.setTargetAtTime(motorHz * dop, t, 0.05);
    this.motor2.frequency.setTargetAtTime(motorHz * 1.502 * dop, t, 0.05);
    this.motorFilter.frequency.setTargetAtTime(motorHz * 1.5 * dop, t, 0.05);
    this.am.frequency.setTargetAtTime(bladeHz * dop, t, 0.05);
    const on = rpm > 50 ? 1 : 0;
    // Motor whine with the power going in; a faint tick when freewheeling.
    this.motorGain.gain.setTargetAtTime(0.35 * on * (0.012 * Math.min(1, rpm / (m.maxRpm || 10000)) + 0.09 * load), t, 0.05);
    // Prop buzz: louder with tip speed and with how hard it's pushing.
    // A windmilling prop just whirrs softly.
    // (Kept low: too much of it sounds like wind rather than a prop; the
    // tones carry the prop's sound.)
    const buzz = 0.45 * on * Math.min(0.4 * loud, loud * (whoosh * (0.08 + 0.13 * Math.min(1.5, load)) + 0.04 * Math.min(1, tip / 30)));
    this.noiseGain.gain.setTargetAtTime(buzz * 0.5, t, 0.05);
    this.harm.frequency.setTargetAtTime(Math.max(1, rpm / 60) * dop, t, 0.05);
    // The tones: louder with tip speed and how hard it's pushing, and for
    // square tips and pushers.
    this.harmGain.gain.setTargetAtTime(on * level * Math.sqrt(loud) * 0.25 * Math.min(1.4, whoosh + 0.15) * (0.5 + 0.5 * Math.min(1, load)), t, 0.05);
    // Chopping through a wake modulates the buzz harder at the blade-pass rate.
    this.amGain.gain.setTargetAtTime(buzz * 0.5 * (pusher ? 1 : 0.8), t, 0.05);
    // Big props sound deeper (a whoosh), small ones sharper (a buzz); the
    // buzz reaches up to the blade-pass frequency.
    const tone = (0.2032 / dia) ** 0.7; // 1 for an 8" prop
    const bright = square ? 1.6 : 1;
    this.noiseFilter.frequency.setTargetAtTime(Math.max((250 + 900 * Math.min(1, load + 0.15)) * tone * bright, bladeHz * 1.6) * dop, t, 0.1);
    this.noise.playbackRate.setTargetAtTime(dop, t, 0.05);
    // Air over the wings. Airframe noise climbs steeply with speed (its power
    // goes as speed^5 or so); higher pitched the faster it goes. Loudest on
    // board (FPV), where it's right by the microphone.
    const v = Math.max(0, aircraft.airspeed || 0);
    const aero = Math.min(1.6, (v / 22) ** 2.5);
    const aoa = Math.min(1, Math.max(0, (Math.abs(aircraft.alpha || 0) - 0.1) / 0.2)); // from ~6°, full by ~17°
    const stall = Math.min(1, aircraft.wingStall || 0);
    this.windGain.gain.setTargetAtTime((fpv ? 0.5 : 0.4) * aero * (1 + 1.2 * aoa), t, 0.1);
    this.windFilter.frequency.setTargetAtTime((220 + 38 * Math.min(v, 45)) * dop, t, 0.1);
    this.wind.playbackRate.setTargetAtTime(dop, t, 0.05);
    const rumble = (fpv ? 1.2 : 0.8) * stall * Math.min(1, (v / 14) ** 2);
    this.buffetGain.gain.setTargetAtTime(rumble, t, 0.08);
    this.shakeGain.gain.setTargetAtTime(rumble * 0.8, t, 0.08);
    // Pushing through leaves: a rustle, louder the faster (it flickers as
    // they brush past).
    const fol = Math.min(1, (aircraft.foliageSpeed || 0) / 8);
    this.rustleGain.gain.setTargetAtTime((fpv ? 0.6 : 0.4) * fol * (0.6 + 0.4 * Math.random()), t, 0.03);
    // Distance attenuation (LOS) — inverse distance, gentle.
    const att = fpv ? 0.6 : Math.min(1, 6 / Math.max(6, listenerDistance)) ** 0.8;
    const vol = this.muted ? 0 : this.volume * att;
    this.master.gain.setTargetAtTime(vol, t, 0.05);
  }
}
