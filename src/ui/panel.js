// Settings / setup panel (plain DOM).
import { CHANNELS } from '../input/input.js';
import { CAMERA_LABELS } from '../view/cameras.js';
import { AIRCRAFT, getAircraft } from '../aircraft/index.js';

const CH_LABEL = { roll: 'Aileron (roll)', pitch: 'Elevator (pitch)', yaw: 'Rudder (yaw)', throttle: 'Throttle' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {object} opts { settings, input, onChange(key), onReset(), onClose() }
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.settings = opts.settings;
    this.input = opts.input;
    this.visible = false;
    this.tab = 'fly';
    this.detecting = null;
    this.calibrating = null;
    this.render();
  }

  show(v = !this.visible) {
    this.visible = v;
    this.root.classList.toggle('open', v);
    if (v) this.render();
  }

  #set(key, value) {
    this.settings[key] = value;
    this.opts.onChange(key, value);
  }

  #range(label, key, min, max, step, fmt = (v) => v) {
    const out = el('span', { class: 'val' }, fmt(this.settings[key]));
    const input = el('input', {
      type: 'range', min, max, step, value: this.settings[key],
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        out.textContent = fmt(v);
        this.#set(key, v);
      },
    });
    return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label), input, out);
  }

  #select(label, key, options) {
    const s = el('select', { onchange: (e) => this.#set(key, e.target.value) },
      Object.entries(options).map(([v, t]) => el('option', { value: v, selected: this.settings[key] === v }, t)));
    return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label), s);
  }

  #text(label, key, attrs = {}) {
    const i = el('input', {
      type: 'text', value: this.settings[key] ?? '', spellcheck: 'false', autocomplete: 'off', ...attrs,
      onchange: (e) => this.#set(key, e.target.value.trim()),
    });
    return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label), i);
  }

  #check(label, key) {
    const c = el('input', { type: 'checkbox', checked: this.settings[key], onchange: (e) => this.#set(key, e.target.checked) });
    return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label), c);
  }

  render() {
    const tabs = { fly: 'Flying', mp: 'Multiplayer', view: 'View', env: 'Weather', controls: 'Transmitter', help: 'Help' };
    this.root.replaceChildren(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, 'RC Flight Sim'),
          el('button', { class: 'close', onclick: () => this.opts.onClose() }, 'Resume ▶')),
        el('div', { class: 'tabs' }, Object.entries(tabs).map(([k, t]) =>
          el('button', { class: k === this.tab ? 'tab on' : 'tab', onclick: () => { this.tab = k; this.render(); } }, t))),
        el('div', { class: 'body' }, this[`tab_${this.tab}`]())));
  }

  tab_fly() {
    return [
      this.#select('Aircraft', 'aircraft', Object.fromEntries(AIRCRAFT.map((a) => [a.id, a.name]))),
      el('p', { class: 'hint' }, getAircraft(this.settings.aircraft).summary),
      this.#select('Flight assist', 'assist', { off: 'Off (manual)', as3x: 'AS3X (gyro stabilised)', safe: 'SAFE (self-levelling, angle limits)' }),
      this.#select('Start position', 'startMode', { runway: 'On the runway', air: 'In the air (30 m)' }),
      this.#select('Camera', 'cameraMode', CAMERA_LABELS),
      el('div', { class: 'row' }, el('button', { onclick: () => { this.opts.onReset(); this.opts.onClose(); } }, 'Reset aircraft (R)')),
      this.#range('Volume', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.#check('Show HUD / OSD (H)', 'showHud'),
    ];
  }

  tab_mp() {
    const mp = this.opts.mp;
    const o = this.opts;
    const status = {
      off: 'Not connected.',
      connecting: mp.error || 'Connecting…',
      on: `Connected to room ${mp.room}.`,
      error: mp.error || 'Connection failed.',
    }[mp.status];
    const out = [
      el('p', { class: 'hint' }, 'Fly with friends: everyone who joins the same room code sees each other\'s aeroplanes. Each player keeps their own weather.'),
      this.#text('Your name', 'mpName', { maxlength: 20 }),
      el('label', { class: 'row' },
        el('span', { class: 'lbl' }, 'Room code'),
        el('input', {
          type: 'text', value: this.settings.mpRoom, maxlength: 24, spellcheck: 'false', autocomplete: 'off', style: 'text-transform: uppercase',
          onchange: (e) => this.#set('mpRoom', e.target.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')),
        }),
        el('button', { onclick: () => { this.#set('mpRoom', o.newRoomCode()); this.render(); } }, 'New code')),
      el('div', { class: 'row' },
        mp.status === 'on' || mp.status === 'connecting'
          ? el('button', { onclick: () => o.onMpDisconnect() }, 'Disconnect')
          : el('button', { onclick: () => o.onMpConnect(), disabled: !this.settings.mpRoom }, 'Connect'),
        el('span', { class: mp.status === 'error' ? 'mp-status err' : 'mp-status' }, status)),
    ];
    if (mp.status === 'on') {
      const name = (id) => getAircraft(id)?.name || id;
      out.push(
        el('h3', {}, `Pilots in the room (${mp.peers.size + 1})`),
        el('ul', { class: 'mp-list' },
          el('li', {}, `${this.settings.mpName} (you): ${name(this.settings.aircraft)}`),
          [...mp.peers.values()].map((p) => el('li', {}, `${p.name}: ${name(p.aircraft)}`))),
        el('div', { class: 'row' },
          el('span', { class: 'lbl' }, 'Invite link'),
          el('input', { type: 'text', readonly: true, value: o.inviteLink(), onclick: (e) => e.target.select() }),
          el('button', {
            onclick: (e) => {
              navigator.clipboard?.writeText(o.inviteLink()).then(() => (e.target.textContent = 'Copied'), () => {});
            },
          }, 'Copy')),
      );
    }
    out.push(
      el('h3', {}, 'Advanced'),
      this.#text('Server', 'mpServer', { placeholder: o.defaultServer || 'wss://…' }),
      el('p', { class: 'hint' }, 'Leave blank to use the built-in server.'),
    );
    return out;
  }

  tab_view() {
    return [
      el('h3', {}, 'FPV'),
      this.#select('Camera mount', 'fpvMount', { cockpit: "Pilot's eye (cockpit)", wing: 'Top wing pod' }),
      this.#range('Camera uptilt', 'fpvTilt', -10, 40, 1, (v) => `${v}°`),
      this.#range('Field of view', 'fpvFov', 70, 150, 1, (v) => `${v}°`),
      this.#check('Motor vibration', 'fpvShake'),
      this.#check('Analog video effect', 'fpvAnalog'),
      el('h3', {}, 'Line of sight'),
      this.#range('Field of view', 'losFov', 20, 80, 1, (v) => `${v}°`),
      this.#select('Auto-zoom', 'losZoom', { 0: 'Off', 1: 'Gentle', 2: 'Strong' }),
      this.#range('Pilot position (left/right)', 'pilotX', -60, 60, 1, (v) => `${v} m`),
      this.#range('Pilot position (fwd/back)', 'pilotZ', -10, 30, 1, (v) => `${v} m`),
    ];
  }

  tab_env() {
    const compass = (v) => {
      const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      return `${v}° (${names[Math.round(v / 45) % 8]})`;
    };
    return [
      this.#range('Wind speed', 'windSpeed', 0, 12, 0.5, (v) => `${v} m/s (${Math.round(v * 3.6)} km/h)`),
      this.#range('Wind from', 'windDir', 0, 359, 5, compass),
      this.#range('Turbulence', 'turbulence', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.#range('Sun elevation', 'sunElevation', 2, 80, 1, (v) => `${v}°`),
      this.#range('Sun direction', 'sunAzimuth', 0, 359, 5, compass),
      el('p', { class: 'hint' }, 'You stand at the flight line facing north; the runway runs east–west in front of you.'),
    ];
  }

  tab_controls() {
    const inp = this.input;
    const cfg = inp.config;
    const pads = inp.listGamepads();
    const padSel = el('select', {
      onchange: (e) => { cfg.gamepadIndex = e.target.value === '' ? null : Number(e.target.value); inp.save(); },
    }, el('option', { value: '' }, pads.length ? 'First connected' : 'None detected — plug in and move a stick'),
    pads.map((p) => el('option', { value: p.index, selected: cfg.gamepadIndex === p.index }, `${p.index}: ${p.id}`)));

    const rows = CHANNELS.map((ch) => {
      const a = cfg.axes[ch];
      const axisSel = el('select', { onchange: (e) => { a.index = Number(e.target.value); inp.save(); } },
        Array.from({ length: 8 }, (_, i) => el('option', { value: i, selected: a.index === i }, `Axis ${i}`)));
      const bar = el('div', { class: 'bar' }, el('div', { class: 'fill', 'data-ch': ch }));
      return el('div', { class: 'chan' },
        el('span', { class: 'lbl' }, CH_LABEL[ch]),
        axisSel,
        el('label', { class: 'inv' }, el('input', { type: 'checkbox', checked: a.invert, onchange: (e) => { a.invert = e.target.checked; inp.save(); } }), 'Reverse'),
        el('button', { onclick: (e) => this.#detect(ch, e.target) }, 'Detect'),
        bar);
    });

    const expoRow = (ch) => el('div', { class: 'chan' },
      el('span', { class: 'lbl' }, CH_LABEL[ch]),
      el('span', {}, 'Expo'),
      el('input', { type: 'range', min: 0, max: 0.9, step: 0.05, value: cfg.expo[ch], oninput: (e) => { cfg.expo[ch] = parseFloat(e.target.value); inp.save(); } }),
      el('span', {}, 'Rate'),
      el('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: cfg.rates[ch], oninput: (e) => { cfg.rates[ch] = parseFloat(e.target.value); inp.save(); } }));

    const btnRow = (name, label) => el('div', { class: 'chan' },
      el('span', { class: 'lbl' }, label),
      el('span', { class: 'val' }, cfg.buttons[name] == null ? 'not set' : `Button ${cfg.buttons[name]}`),
      el('button', { onclick: (e) => this.#detectButton(name, e.target) }, 'Detect'));

    return [
      el('p', { class: 'hint' }, 'Connect your transmitter by USB (EdgeTX/OpenTX: choose "USB Joystick (HID)"), or use a USB sim dongle. Move a stick so the browser notices it.'),
      this.#select('On-screen sticks', 'touchControls', { auto: 'Auto (touch screens)', on: 'Always show', off: 'Off' }),
      this.#select('Stick mode', 'stickMode', { 2: 'Mode 2 (throttle left)', 1: 'Mode 1 (throttle right)' }),
      el('label', { class: 'row' }, el('span', { class: 'lbl' }, 'Device'), padSel),
      el('div', { class: 'status', id: 'pad-status' }, inp.gamepadName || 'No transmitter detected — keyboard active'),
      el('h3', {}, 'Channel mapping'),
      el('p', { class: 'hint' }, 'Bars should move right for: right aileron, pull back (up elevator), right rudder, throttle up. Use Reverse if not.'),
      ...rows,
      el('div', { class: 'row' },
        el('button', { onclick: (e) => this.#calibrate(e.target) }, this.calibrating ? 'Finish calibration' : 'Calibrate sticks'),
        el('button', { onclick: () => { inp.resetConfig(); this.render(); } }, 'Reset to defaults')),
      el('p', { class: 'hint', id: 'cal-hint' }, this.calibrating ? 'Move every stick to all its extremes, centre the sticks (throttle low), then press Finish.' : ''),
      el('h3', {}, 'Expo & rates'),
      ...['roll', 'pitch', 'yaw'].map(expoRow),
      el('h3', {}, 'Switches'),
      btnRow('reset', 'Reset aircraft'),
      btnRow('camera', 'Change camera'),
      btnRow('assist', 'Flight assist (cycle)'),
      el('h3', {}, 'Keyboard'),
      el('p', { class: 'hint' }, 'Arrows: aileron/elevator · A/D: rudder · W/S: throttle · R: reset · C: camera · G: flight assist · P: pause · H: HUD · Esc: menu'),
    ];
  }

  tab_help() {
    return [
      el('h3', {}, 'Flying the Buschtrottel'),
      el('ul', {},
        el('li', {}, 'A light, slow STOL foamie: it lifts off in a few metres at full power. Ease the throttle back once airborne.'),
        el('li', {}, 'The tail wheel steers with the rudder. The high-wing versions roll strongly with rudder, so you can fly them on three channels.'),
        el('li', {}, 'Power pitches the nose up a little; it is trimmed for hands-off cruise at about 40% throttle.')),
      el('h3', {}, 'Flying the S.E.5a'),
      el('ul', {},
        el('li', {}, 'Take off into wind (the windsock tail points downwind). Open the throttle smoothly and hold a little right rudder against the swing; let the tail come up, then ease back.'),
        el('li', {}, 'It is a biplane with lots of drag: it slows down fast when you throttle back. Keep speed up on the approach and flare gently for a three-pointer.'),
        el('li', {}, 'The 900 mm E-flite is light and quick: it reacts fast and stalls abruptly on full elevator.'),
        el('li', {}, 'Flight assist mirrors E-flite BNF receivers: AS3X damps gusts and wobbles; SAFE also levels the wings when you let go and limits bank and pitch. Switch modes in flight with G or an assigned transmitter switch.'),
        el('li', {}, 'Coordinate turns with rudder; the dihedral gives a strong rudder–roll coupling.'),
        el('li', {}, 'Low and slow in a turn will drop a wing. Unload (release elevator) to recover.')),
      el('h3', {}, 'Views'),
      el('ul', {},
        el('li', {}, 'Line of sight: you stand at the flight line like a real RC pilot. Auto-zoom keeps the model visible at distance.'),
        el('li', {}, "FPV: from the pilot's seat looking past the guns and the radiator, or a top-wing camera pod. Adjust uptilt and FOV under View."),
        el('li', {}, 'Chase: a follow camera, handy for learning.')),
    ];
  }

  /** Called every frame while open to animate live bars. */
  tick() {
    if (!this.visible || this.tab !== 'controls') return;
    for (const ch of CHANNELS) {
      const f = this.root.querySelector(`.fill[data-ch="${ch}"]`);
      if (!f) continue;
      const v = this.input.raw[ch];
      const pos = ch === 'throttle' ? v : (v + 1) / 2;
      f.style.width = `${Math.max(0, Math.min(1, pos)) * 100}%`;
    }
    const st = this.root.querySelector('#pad-status');
    if (st) st.textContent = this.input.gamepadName ? `Connected: ${this.input.gamepadName} (${this.input.source})` : 'No transmitter detected — keyboard active';
    const pad = this.input.getGamepad();
    if (this.calibrating && pad) {
      pad.axes.forEach((v, i) => {
        const c = this.calibrating;
        c.min[i] = Math.min(c.min[i] ?? v, v);
        c.max[i] = Math.max(c.max[i] ?? v, v);
      });
    }
  }

  #detect(ch, btn) {
    const pad = this.input.getGamepad();
    if (!pad) {
      btn.textContent = 'No device';
      return;
    }
    const base = [...pad.axes];
    btn.textContent = 'Move stick…';
    const start = performance.now();
    const poll = () => {
      const p = this.input.getGamepad();
      if (!p) return;
      let best = -1;
      let bestD = 0.4;
      p.axes.forEach((v, i) => {
        const d = Math.abs(v - base[i]);
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        this.input.config.axes[ch].index = best;
        this.input.save();
        this.render();
        return;
      }
      if (performance.now() - start < 8000) requestAnimationFrame(poll);
      else btn.textContent = 'Detect';
    };
    requestAnimationFrame(poll);
  }

  #detectButton(name, btn) {
    const pad = this.input.getGamepad();
    if (!pad) {
      btn.textContent = 'No device';
      return;
    }
    const base = pad.buttons.map((b) => b.pressed);
    btn.textContent = 'Flip switch…';
    const start = performance.now();
    const poll = () => {
      const p = this.input.getGamepad();
      const i = p ? p.buttons.findIndex((b, j) => b.pressed !== base[j]) : -1;
      if (i >= 0) {
        this.input.config.buttons[name] = i;
        this.input.save();
        this.render();
        return;
      }
      if (performance.now() - start < 8000) requestAnimationFrame(poll);
      else btn.textContent = 'Detect';
    };
    requestAnimationFrame(poll);
  }

  #calibrate() {
    const pad = this.input.getGamepad();
    if (!this.calibrating) {
      if (!pad) return;
      this.calibrating = { min: [], max: [] };
      this.render();
      return;
    }
    const c = this.calibrating;
    const cfg = this.input.config;
    if (pad) {
      for (const ch of CHANNELS) {
        const a = cfg.axes[ch];
        const lo = c.min[a.index];
        const hi = c.max[a.index];
        if (lo == null || hi == null || hi - lo < 0.2) continue;
        a.min = lo;
        a.max = hi;
        a.center = ch === 'throttle' ? (lo + hi) / 2 : pad.axes[a.index];
      }
    }
    this.calibrating = null;
    this.input.save();
    this.render();
  }
}
