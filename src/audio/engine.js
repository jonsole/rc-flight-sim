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
    this.wind.start(0, 0.7);
  }

  update(aircraft, listenerDistance, fpv) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = aircraft.propBroken ? 0 : aircraft.rpm;
    const thr = aircraft.throttleActual;
    const motorHz = 40 + (rpm / 60) * 7; // 14-pole motor electrical freq / 2
    const bladeHz = Math.max(1, (rpm / 60) * (aircraft.def.motor.blades || 2));
    this.motor.frequency.setTargetAtTime(motorHz, t, 0.05);
    this.motor2.frequency.setTargetAtTime(motorHz * 1.502, t, 0.05);
    this.motorFilter.frequency.setTargetAtTime(motorHz * 1.5, t, 0.05);
    this.am.frequency.setTargetAtTime(bladeHz, t, 0.05);
    const on = rpm > 50 ? 1 : 0;
    this.motorGain.gain.setTargetAtTime(on * (0.04 + thr * 0.1), t, 0.05);
    this.noiseGain.gain.setTargetAtTime(on * thr * 0.25, t, 0.05);
    this.amGain.gain.setTargetAtTime(on * thr * 0.2, t, 0.05);
    this.noiseFilter.frequency.setTargetAtTime(400 + thr * 1500, t, 0.1);
    const ws = Math.min(1, aircraft.airspeed / 25);
    this.windGain.gain.setTargetAtTime(fpv ? ws * ws * 0.35 : ws * ws * 0.05, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + ws * 900, t, 0.1);
    // Distance attenuation (LOS) — inverse distance, gentle.
    const att = fpv ? 0.6 : Math.min(1, 6 / Math.max(6, listenerDistance)) ** 0.8;
    const vol = this.muted ? 0 : this.volume * att;
    this.master.gain.setTargetAtTime(vol, t, 0.05);
  }
}
