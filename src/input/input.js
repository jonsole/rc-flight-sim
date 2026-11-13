// Control input: RC transmitter (as USB joystick / gamepad) and keyboard.
//
// Most modern transmitters (EdgeTX/OpenTX radios, Spektrum, FrSky, Radiomaster,
// or a USB dongle) appear to the PC as a game controller, so the browser
// Gamepad API can read them. Channel→axis order varies, so axes are mappable.

const STORAGE_KEY = 'rcsim.input.v1';

export const CHANNELS = ['roll', 'pitch', 'yaw', 'throttle'];

const DEFAULT_CONFIG = {
  gamepadIndex: null, // null = first connected
  axes: {
    // AETR channel order is the most common default for USB transmitters.
    roll: { index: 0, invert: false, min: -1, max: 1, center: 0 },
    pitch: { index: 1, invert: true, min: -1, max: 1, center: 0 },
    throttle: { index: 2, invert: false, min: -1, max: 1, center: 0 },
    yaw: { index: 3, invert: false, min: -1, max: 1, center: 0 },
  },
  buttons: { reset: null, camera: null },
  expo: { roll: 0.35, pitch: 0.3, yaw: 0.2 },
  rates: { roll: 0.8, pitch: 0.85, yaw: 1.0 },
  deadband: 0.02,
};

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

export function applyExpo(x, expo) {
  return (1 - expo) * x + expo * x * x * x;
}

export class Input {
  constructor() {
    this.config = this.#load();
    this.keys = new Set();
    this.kb = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.output = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.raw = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.source = 'keyboard';
    this.onAction = () => {};
    this.gamepadName = '';
    this._prevButtons = [];
    this._lastGamepadActivity = -Infinity;
    this.useGamepad = false;

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.onAction(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', () => (this.useGamepad = true));
  }

  #load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s) return deepMerge(structuredClone(DEFAULT_CONFIG), s);
    } catch {
      /* ignore */
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      /* ignore */
    }
  }

  resetConfig() {
    this.config = structuredClone(DEFAULT_CONFIG);
    this.save();
  }

  getGamepad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (!pads.length) return null;
    const idx = this.config.gamepadIndex;
    return pads.find((p) => p.index === idx) || pads[0];
  }

  listGamepads() {
    return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  }

  /** Normalised value (-1..1) for a mapped axis using calibration. */
  axisValue(pad, a) {
    let v = pad.axes[a.index] ?? 0;
    const lo = a.min;
    const hi = a.max;
    const c = a.center ?? (lo + hi) / 2;
    v = v >= c ? (v - c) / Math.max(1e-3, hi - c) : (v - c) / Math.max(1e-3, c - lo);
    v = clamp(v, -1, 1);
    return a.invert ? -v : v;
  }

  update(dt) {
    const cfg = this.config;
    // --- Keyboard (smoothed so taps are not full-deflection jolts) ---
    const k = this.keys;
    const target = {
      roll: (k.has('ArrowRight') || k.has('KeyL') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyJ') ? 1 : 0),
      pitch: (k.has('ArrowDown') || k.has('KeyK') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyI') ? 1 : 0),
      yaw: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
    };
    const rate = 6 * dt;
    for (const ch of ['roll', 'pitch', 'yaw']) {
      const d = target[ch] - this.kb[ch];
      this.kb[ch] += clamp(d, -rate, rate);
    }
    if (k.has('KeyW')) this.kb.throttle = clamp(this.kb.throttle + dt * 0.6, 0, 1);
    if (k.has('KeyS')) this.kb.throttle = clamp(this.kb.throttle - dt * 0.6, 0, 1);
    const kbActive = target.roll || target.pitch || target.yaw || k.has('KeyW') || k.has('KeyS');

    // --- Gamepad / transmitter ---
    const pad = this.getGamepad();
    let padVals = null;
    if (pad) {
      this.gamepadName = pad.id;
      padVals = {};
      for (const ch of CHANNELS) {
        const v = this.axisValue(pad, cfg.axes[ch]);
        padVals[ch] = ch === 'throttle' ? (v + 1) / 2 : v;
      }
      // Buttons (edge-triggered)
      pad.buttons.forEach((b, i) => {
        const was = this._prevButtons[i];
        if (b.pressed && !was) {
          if (i === cfg.buttons.reset) this.onAction('KeyR');
          if (i === cfg.buttons.camera) this.onAction('KeyC');
        }
        this._prevButtons[i] = b.pressed;
      });
      this.useGamepad = true;
    } else {
      this.gamepadName = '';
      this.useGamepad = false;
    }

    // Transmitter when present; keyboard overrides any stick it is moving.
    this.source = padVals && !kbActive ? 'transmitter' : 'keyboard';
    for (const ch of CHANNELS) {
      const kbUsed = ch === 'throttle' ? !padVals : Math.abs(this.kb[ch]) > 1e-3;
      this.raw[ch] = padVals && !kbUsed ? padVals[ch] : this.kb[ch];
    }

    for (const ch of ['roll', 'pitch', 'yaw']) {
      let v = this.raw[ch];
      if (Math.abs(v) < cfg.deadband) v = 0;
      this.output[ch] = applyExpo(v, cfg.expo[ch]) * cfg.rates[ch];
    }
    this.output.throttle = clamp(this.raw.throttle, 0, 1);
    return this.output;
  }
}

function deepMerge(base, over) {
  for (const key of Object.keys(over)) {
    const v = over[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') deepMerge(base[key], v);
    else base[key] = v;
  }
  return base;
}
