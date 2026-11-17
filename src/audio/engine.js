// Synthesised electric motor + propeller sound (no audio files needed).
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

    // Blade-pass whine: a tone at the blade-pass frequency, which is what
    // makes a many-bladed prop sound high pitched.
    this.blade = ctx.createOscillator();
    this.blade.type = 'triangle';
    this.bladeGain = ctx.createGain();
    this.bladeGain.gain.value = 0;
    this.blade.connect(this.bladeGain).connect(this.master);

    // Wind rush
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

    this.motor.start();
    this.motor2.start();
    this.noise.start();
    this.am.start();
    this.blade.start();
    this.wind.start(0, 0.7);
  }

  update(aircraft, listenerDistance, fpv) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = aircraft.propBroken ? 0 : aircraft.rpm;
    const m = aircraft.def.motor;
    // The prop as fitted or tuned (Menu → Tuning).
    const blades = m.prop?.blades || m.blades || 2;
    // Square-tipped (bullnose) blades are much noisier than tapered ones: the
    // wide, blunt tips shed strong tip vortices, a louder and harsher buzz.
    // A pusher's blades chop through the wake of the wing and fuselage ahead
    // of them every turn, which adds a rasping, tonal blade-pass note.
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
    this.motor.frequency.setTargetAtTime(motorHz, t, 0.05);
    this.motor2.frequency.setTargetAtTime(motorHz * 1.502, t, 0.05);
    this.motorFilter.frequency.setTargetAtTime(motorHz * 1.5, t, 0.05);
    this.am.frequency.setTargetAtTime(bladeHz, t, 0.05);
    const on = rpm > 50 ? 1 : 0;
    // Motor whine with the power going in; a faint tick when freewheeling.
    this.motorGain.gain.setTargetAtTime(on * (0.012 * Math.min(1, rpm / (m.maxRpm || 10000)) + 0.09 * load), t, 0.05);
    // Prop buzz: louder with tip speed and with how hard it's pushing.
    // A windmilling prop just whirrs softly.
    const buzz = on * Math.min(0.4 * loud, loud * (whoosh * (0.08 + 0.13 * Math.min(1.5, load)) + 0.04 * Math.min(1, tip / 30)));
    this.noiseGain.gain.setTargetAtTime(buzz, t, 0.05);
    // Chopping through a wake modulates the buzz harder at the blade-pass rate.
    this.amGain.gain.setTargetAtTime(buzz * (pusher ? 1 : 0.8), t, 0.05);
    // Big props sound deeper (a whoosh), small ones sharper (a buzz); the
    // buzz reaches up to the blade-pass frequency.
    const tone = (0.2032 / dia) ** 0.7; // 1 for an 8" prop
    const bright = square ? 1.6 : 1;
    this.noiseFilter.frequency.setTargetAtTime(Math.max((350 + 1500 * Math.min(1, load + 0.15)) * tone * bright, bladeHz * 1.6), t, 0.1);
    // Two-blade props: the buzz alone; each extra blade adds whine. Square
    // tips and a pusher's wake add a blade-pass note of their own, rich in
    // harmonics (a rasp rather than a hum).
    const rasp = (square ? 0.02 : 0) + (pusher ? 0.03 : 0);
    const bladeType = rasp ? 'sawtooth' : 'triangle';
    if (this.blade.type !== bladeType) this.blade.type = bladeType;
    this.blade.frequency.setTargetAtTime(bladeHz, t, 0.05);
    this.bladeGain.gain.setTargetAtTime(on * whoosh * (0.025 * Math.max(0, blades - 2) + rasp) * (0.4 + 0.6 * Math.min(1, load)), t, 0.05);
    const ws = Math.min(1, aircraft.airspeed / 25);
    this.windGain.gain.setTargetAtTime(fpv ? ws * ws * 0.35 : ws * ws * 0.05, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + ws * 900, t, 0.1);
    // Distance attenuation (LOS) — inverse distance, gentle.
    const att = fpv ? 0.6 : Math.min(1, 6 / Math.max(6, listenerDistance)) ** 0.8;
    const vol = this.muted ? 0 : this.volume * att;
    this.master.gain.setTargetAtTime(vol, t, 0.05);
  }
}
