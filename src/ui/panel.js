// Settings / setup panel (plain DOM).
import { CHANNELS, rawInput } from '../input/input.js';
import { CAMERA_LABELS } from '../view/cameras.js';
import { AIRCRAFT, getAircraft } from '../aircraft/index.js';
import { formatHours } from '../world/sun.js';
import { formatDay } from '../world/seasons.js';
import { LOCATIONS, LOCATION } from '../sim/location.js';
import { QUALITY, DISTANCES } from '../world/quality.js';
import { googleSessions } from '../world/googleTiles.js';
import { tunablesFor, loadTuning, saveTuning, tunedDef, powerSummary } from '../sim/tuning.js';
import { DIFFICULTIES, netTunables, loadNetTuning, saveNetTuning, bestTime } from '../sim/net.js';

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
    if (v && !this.visible) this.openedAt = performance.now();
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
    const tabs = { fly: 'Flying', tune: 'Tuning', mp: 'Multiplayer', view: 'View', env: 'Weather', controls: 'Transmitter', help: 'Help' };
    this.root.replaceChildren(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, 'RC Flight Sim'),
          // (Not the tap that opened the menu, landing where this now is.)
          el('button', { class: 'close', onclick: () => performance.now() - (this.openedAt ?? 0) > 400 && this.opts.onClose() }, 'Resume ▶')),
        el('div', { class: 'tabs' }, Object.entries(tabs).map(([k, t]) =>
          el('button', { class: k === this.tab ? 'tab on' : 'tab', onclick: () => { this.tab = k; this.render(); } }, t))),
        el('div', { class: 'body' }, this[`tab_${this.tab}`]())));
  }

  tab_fly() {
    return [
      this.#select('Aircraft', 'aircraft', Object.fromEntries(AIRCRAFT.map((a) => [a.id, a.name]))),
      el('p', { class: 'hint' }, getAircraft(this.settings.aircraft).summary),
      this.#select('Flying field', 'location', Object.fromEntries(LOCATIONS.map((l) => [l.id, l.name]))),
      el('p', { class: 'hint' }, `${LOCATION.summary} Changing field reloads the simulator.`),
      this.#select('Flight assist', 'assist', { off: 'Off (manual)', as3x: 'AS3X (gyro stabilised)', safe: 'SAFE (self-levelling, angle limits)' }),
      this.#select('Start position', 'startMode', { runway: 'On the runway', air: 'In the air (30 m)' }),
      this.#select('Challenge', 'challenge', { off: 'None (free flying)', net: 'Insect net tow' }),
      ...(this.settings.challenge === 'net' ? [
        this.#select('Difficulty', 'netDifficulty', Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, d]) => [k, d.name]))),
        el('p', { class: 'hint' }, this.#netHint()),
      ] : []),
      this.#select('Camera', 'cameraMode', CAMERA_LABELS),
      el('div', { class: 'row' }, el('button', { onclick: () => { this.opts.onReset(); this.opts.onClose(); } }, 'Reset aircraft (R)')),
      el('div', { class: 'row' },
        el('button', { onclick: () => this.opts.onStartHere() }, 'Start here next time'),
        el('button', { onclick: () => { this.opts.onDefaultStart(); this.opts.onClose(); } }, 'Default start')),
      el('p', { class: 'hint' }, 'Take-offs from the ground start where the model now sits (land and stop first). A hand launch starts where you last walked to and turned before throwing. Saved for this field in this browser.'),
      el('div', { class: 'row' }, el('button', { onclick: () => this.opts.onEditScenery() }, 'Edit scenery (E)')),
      el('p', { class: 'hint' }, 'Move, resize or delete trees, buildings and fences, or add new ones. Edits are saved in this browser for this field.'),
      this.#range('Volume', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.#check('Show HUD / OSD (H)', 'showHud'),
    ];
  }

  #netHint() {
    const id = this.settings.aircraft;
    const best = bestTime(id, this.settings.netDifficulty);
    const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    return `Tow a drag net on a cord from the tail and fly it through the swarms of insects (follow the yellow marker). The net starts folded and opens in the airflow, and drags hard: the harder the difficulty, the bigger the net. Fill it to finish; a tree will snag it. Net size, drag and cord length are under Tuning. ${best != null ? `Your best with the ${getAircraft(id).name} on this difficulty: ${fmt(best)}.` : ''}`;
  }

  /** Tuning: the flight settings of the model you're flying (src/sim/tuning.js), in collapsible groups. */
  tab_tune() {
    const entry = this.opts.aircraftEntry();
    const values = loadTuning(entry.id);
    const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
    const fmt = (t, v) => (t.choices ? t.choices[Math.round(v)] : `${Number(v).toFixed(decimals(t.step))}${t.unit ? ` ${t.unit}` : ''}`);
    // Which groups are open (remembered in this browser).
    let open = {};
    try {
      open = JSON.parse(localStorage.getItem('rcsim.tuneOpen')) ?? {};
    } catch {
      /* none */
    }
    const saveOpen = () => {
      try {
        localStorage.setItem('rcsim.tuneOpen', JSON.stringify(open));
      } catch {
        /* storage blocked */
      }
    };
    // Save, rebuild the flight model, and redraw where you were.
    const commit = () => {
      saveTuning(entry.id, values);
      this.opts.onRetune();
      const body = this.root.querySelector('.body');
      const top = body?.scrollTop ?? 0;
      this.render();
      const b2 = this.root.querySelector('.body');
      if (b2) b2.scrollTop = top;
    };
    const setValue = (t, v, vals = values, save = commit) => {
      const nv = Math.min(t.max, Math.max(t.min, Math.round(v / t.step) * t.step));
      if (Math.abs(nv - t.dflt) < t.step / 2) delete vals[t.key];
      else vals[t.key] = Number(nv.toFixed(6));
      save();
    };
    const tuned = tunedDef(entry.def, values);

    // (A row for one setting, kept in `vals` and saved by `save`: the model's
    // tuning, or the challenge's net.)
    const row = (t, vals = values, save = commit) => {
      const v = vals[t.key] ?? t.dflt;
      const changed = vals[t.key] != null;
      const show = el('span', { class: 'val' }, fmt(t, v));
      const note = t.note ? el('small', { class: 'tune-note' }, t.note(tuned, v)) : null;
      // A setting with named choices is a drop-down rather than a slider.
      if (t.choices) {
        const sel = el('select', { class: 'tune-choice', onchange: (e) => setValue(t, Number(e.target.value), vals, save) },
          Object.entries(t.choices).map(([k, label]) => el('option', { value: k, selected: Number(k) === Math.round(v) }, label)));
        return el('div', { class: changed ? 'tune-row tuned' : 'tune-row' },
          el('div', { class: 'tune-head' },
            el('span', { class: 'tune-lbl' }, t.label),
            el('small', {}, `default ${fmt(t, t.dflt)}`),
            el('button', {
              class: 'tune-reset', title: `Back to ${fmt(t, t.dflt)}`, disabled: !changed,
              onclick: () => { delete vals[t.key]; save(); },
            }, '↺')),
          el('div', { class: 'tune-ctl' }, sel));
      }
      const input = el('input', {
        type: 'range', min: t.min, max: t.max, step: t.step, value: v,
        oninput: (e) => {
          show.textContent = fmt(t, e.target.value);
          if (note) note.textContent = t.note(tuned, Number(e.target.value));
        },
        onchange: (e) => setValue(t, Number(e.target.value), vals, save),
      });
      const btn = (label, d, title) => el('button', { class: 'tune-step', title, onclick: (e) => { e.preventDefault(); setValue(t, v + d * t.step, vals, save); } }, label);
      return el('div', { class: changed ? 'tune-row tuned' : 'tune-row' },
        el('div', { class: 'tune-head' },
          el('span', { class: 'tune-lbl' }, t.label),
          el('small', {}, `default ${fmt(t, t.dflt)}`),
          el('button', {
            class: 'tune-reset', title: `Back to ${fmt(t, t.dflt)}`, disabled: !changed,
            onclick: () => { delete vals[t.key]; save(); },
          }, '↺')),
        el('div', { class: 'tune-ctl' }, btn('−', -1, 'Less'), input, btn('+', 1, 'More'), show),
        note);
    };

    // Summaries shown at the end of a group.
    const after = {
      Battery: () => {
        const p = powerSummary(tuned);
        return el('p', { class: 'hint' }, `Full throttle on a fresh pack: ${Math.round(p.rpm / 100) * 100} rpm, ${p.current.toFixed(1)} A, ${Math.round(p.watts)} W; ${p.thrust.toFixed(1)} N static thrust, ${p.pitchSpeed.toFixed(1)} m/s pitch speed. Battery about ${Math.round(p.batteryGrams)} g (bigger packs add weight); about ${p.fullThrottleMinutes.toFixed(1)} min at full throttle.`);
      },
    };

    const groups = [];
    for (const t of tunablesFor(entry.def)) {
      let g = groups.find((x) => x.name === t.group);
      if (!g) groups.push((g = { name: t.group, items: [] }));
      g.items.push(t);
    }
    const out = [
      el('p', { class: 'hint' }, `${entry.name}. Changes apply straight away, in flight too, and are saved in this browser for this model. Export them to send in and have them built in.`),
    ];
    // The insect net, while that challenge is on: per model and difficulty.
    if (this.settings.challenge === 'net') {
      const diff = this.settings.netDifficulty;
      const netVals = loadNetTuning(entry.id, diff);
      const saveNet = () => {
        saveNetTuning(entry.id, diff, netVals);
        this.opts.onNetRetune();
        const body = this.root.querySelector('.body');
        const top = body?.scrollTop ?? 0;
        this.render();
        const b2 = this.root.querySelector('.body');
        if (b2) b2.scrollTop = top;
      };
      const n = Object.keys(netVals).length;
      const det = el('details', { class: 'tune-group', open: open.net !== false },
        el('summary', {}, `Insect net (${DIFFICULTIES[diff]?.short ?? diff})`, n ? el('span', { class: 'tune-count' }, `${n} changed`) : null),
        ...netTunables(entry.def, diff).map((t) => row(t, netVals, saveNet)),
        el('p', { class: 'hint' }, 'For the insect-net challenge, on this model and difficulty. Changing the net starts the challenge again; best times only count with the standard net.'));
      det.addEventListener('toggle', () => {
        open.net = det.open;
        saveOpen();
      });
      out.push(det);
    }
    for (const g of groups) {
      const n = g.items.filter((t) => values[t.key] != null).length;
      const det = el('details', { class: 'tune-group', open: !!open[g.name] },
        el('summary', {}, g.name, n ? el('span', { class: 'tune-count' }, `${n} changed`) : null),
        ...g.items.map(row),
        after[g.name]?.());
      det.addEventListener('toggle', () => {
        open[g.name] = det.open;
        saveOpen();
      });
      out.push(det);
    }

    const fileIn = el('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none',
      onchange: async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const j = JSON.parse(await f.text());
          if (j.aircraft && j.aircraft !== entry.id && !confirm(`This tuning is for "${j.aircraft}", not the ${entry.name}. Load it anyway?`)) return;
          for (const k of Object.keys(values)) delete values[k];
          Object.assign(values, j.tuning ?? j);
          commit();
        } catch (err) {
          alert(`Couldn't read that file: ${err.message}`);
        }
      },
    });
    out.push(el('div', { class: 'row tune-files' },
      el('button', {
        onclick: () => {
          if (!Object.keys(values).length || !confirm(`Put all the ${entry.name}'s settings back to default?`)) return;
          for (const k of Object.keys(values)) delete values[k];
          commit();
        },
      }, 'Reset all'),
      el('button', {
        onclick: () => {
          const blob = new Blob([JSON.stringify({ aircraft: entry.id, tuning: values }, null, 1)], { type: 'application/json' });
          const a2 = el('a', { href: URL.createObjectURL(blob), download: `${entry.id}-tuning.json` });
          document.body.append(a2);
          a2.click();
          a2.remove();
        },
      }, 'Export'),
      el('button', { onclick: () => fileIn.click() }, 'Import'),
      fileIn));
    return out;
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
          // Save on every keystroke so Connect enables as soon as there is a code.
          oninput: (e) => {
            this.#set('mpRoom', e.target.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, ''));
            const btn = this.root.querySelector('#mp-connect');
            if (btn) btn.disabled = !this.settings.mpRoom;
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' && this.settings.mpRoom && (mp.status === 'off' || mp.status === 'error')) o.onMpConnect();
          },
        }),
        el('button', { onclick: () => { this.#set('mpRoom', o.newRoomCode()); this.render(); } }, 'New code')),
      el('div', { class: 'row' },
        mp.status === 'on' || mp.status === 'connecting'
          ? el('button', { onclick: () => o.onMpDisconnect() }, 'Disconnect')
          : el('button', { id: 'mp-connect', onclick: () => o.onMpConnect(), disabled: !this.settings.mpRoom }, 'Connect'),
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
      this.#range('Field of view (across)', 'fpvFov', 70, 170, 1, (v) => `${v}°`),
      this.#check('Motor vibration', 'fpvShake'),
      this.#check('Analog video effect', 'fpvAnalog'),
      el('h3', {}, 'Line of sight'),
      this.#range('Field of view (across)', 'losFov', 30, 170, 1, (v) => `${v}°`),
      this.#select('Auto-zoom', 'losZoom', { 0: 'Off', 1: 'Gentle', 2: 'Strong' }),
      this.#range('Pilot position (left/right)', 'pilotX', -60, 60, 1, (v) => `${v} m`),
      this.#range('Pilot position (fwd/back)', 'pilotZ', -10, 30, 1, (v) => `${v} m`),
      el('h3', {}, 'Graphics'),
      this.#select('Quality', 'graphics', Object.fromEntries(Object.entries(QUALITY).map(([k, q]) => [k, q.name]))),
      this.#select('Scenery distance', 'viewDistance', DISTANCES),
      this.#select('Trees and bushes', 'treeStyle', { fluffy: 'Leafy', classic: 'Classic (solid)' }),
      this.#check('Leaves face the camera (off: face the screen, as before)', 'cardsFaceCamera'),
      this.#check('Sun glare', 'sunGlare'),
      el('p', { class: 'hint' }, 'Lower these if the picture is jerky. Low draws simpler trees and fewer pixels; a shorter distance leaves out far trees and brings the haze in. Leafy trees lose their leaves in winter; classic ones are a little quicker to draw. Changing any of these reloads the simulator.'),
      ...(LOCATION.data ? [
        this.#select('Scenery', 'scenery', { built: 'Built in (LIDAR and OpenStreetMap)', google: 'Google photorealistic 3D' }),
        this.#text('Google Maps API key', 'googleKey', { type: 'password', placeholder: 'AIza…' }),
        el('p', { class: 'hint' }, 'Google photorealistic 3D needs your own Google Maps Platform API key with the Map Tiles API enabled (and billing set up). The key stays in this browser. Google\'s tiles replace the ground and buildings; the trees, hedges and fences stay, and are what you fly into. Press O to switch them on and off in flight.'),
        el('p', { class: 'hint' }, `Google bills per session: each page load that shows the tiles starts one (good for 3 hours); switching off and on again doesn't. Sessions started from this browser this month: ${googleSessions().count}. Tip: leave the tiles off while reloading a lot, and set a daily cap on root tileset requests in the Google Cloud console.`),
      ] : []),
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
      this.#range('Time of day', 'timeOfDay', 0, 24, 0.25, formatHours),
      this.#range('Time of year', 'dayOfYear', 1, 365, 1, formatDay),
      this.#check('Use my clock (time and date)', 'useClock'),
      this.#range('Cloud cover', 'cloudCover', 0, 1, 0.05, (v) => (v < 0.05 ? 'Clear' : v > 0.85 ? 'Overcast' : `${Math.round(v * 100)}%`)),
      this.#select('Mist and fog', 'mist', { seasonal: 'Seasonal (spring and autumn mornings)', off: 'Off', light: 'Light mist', thick: 'Thick fog' }),
      this.#select('Low cloud', 'lowCloud', { seasonal: 'Seasonal (spring and autumn)', off: 'Off', broken: 'Broken', overcast: 'Overcast' }),
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
      const pad = inp.getGamepad();
      const nAxes = Math.max(8, pad?.axes.length ?? 0);
      const nButtons = pad?.buttons.length ?? 0;
      const isBtn = a.kind === 'button';
      const axisSel = el('select', {
        onchange: (e) => {
          const v = e.target.value;
          a.kind = v[0] === 'b' ? 'button' : 'axis';
          a.index = Number(v.slice(1));
          inp.save();
        },
      },
      Array.from({ length: nAxes }, (_, i) => el('option', { value: `a${i}`, selected: !isBtn && a.index === i }, `Axis ${i}`)),
      Array.from({ length: nButtons }, (_, i) => el('option', { value: `b${i}`, selected: isBtn && a.index === i }, `Button ${i} (analog)`)));
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
      el('div', { class: 'hint', id: 'pad-raw', style: 'font-family: monospace; word-break: break-all' }, ''),
      el('p', { class: 'hint' }, 'On phones the browser may move or drop some joystick axes, or report them as analog buttons. Use Detect and move just that stick; if a channel never responds, set your radio\'s USB joystick to map the channels to X, Y, Z and Rz.'),
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
        el('li', {}, 'The 900 mm E-flite is light and quick: it reacts fast, and hauled back when slow it stalls abruptly and drops a wing.'),
        el('li', {}, 'Flight assist mirrors E-flite BNF receivers: AS3X damps gusts and wobbles; SAFE also levels the wings when you let go and limits bank and pitch. Switch modes in flight with G or an assigned transmitter switch.'),
        el('li', {}, 'Coordinate turns with a little rudder; rudder alone also rolls it, slowly.'),
        el('li', {}, 'Low and slow in a turn will drop a wing. Unload (release elevator) to recover.')),
      el('h3', {}, 'Insect-net challenge'),
      el('ul', {},
        el('li', {}, 'Choose it under Flying → Challenge. Take off gently: the folded net drags along the grass until it lifts and opens.'),
        el('li', {}, 'Open, the net drags hard: keep the power up and the speed above the stall, and turn wide and gently.'),
        el('li', {}, 'The net hangs a few metres behind and below: fly a little above a swarm so the net goes through the middle. Follow the yellow marker to the nearest one.'),
        el('li', {}, 'Keep the net clear of trees: it snags, and a hard pull snaps the cord.')),
      el('h3', {}, 'Views'),
      el('ul', {},
        el('li', {}, 'Line of sight: you stand at the flight line like a real RC pilot. Auto-zoom keeps the model visible at distance.'),
        el('li', {}, "FPV: from the pilot's seat looking past the guns and the radiator, or a top-wing camera pod. Adjust uptilt and FOV under View."),
        el('li', {}, 'Chase: a follow camera, handy for learning.')),
      ...(LOCATION.data ? [el('h3', {}, `${LOCATION.name} scenery`), el('p', { class: 'hint' }, LOCATION.data.credits)] : []),
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
    const rawEl = this.root.querySelector('#pad-raw');
    if (rawEl) {
      const pressed = pad?.buttons.map((b, i) => (b.value ? `${i}:${b.value.toFixed(2)}` : null)).filter(Boolean);
      rawEl.textContent = pad
        ? `Axes: ${pad.axes.map((v, i) => `${i}:${v.toFixed(2)}`).join(' ')} | Buttons: ${pressed.join(' ') || 'none'} | mapping: ${pad.mapping || 'none'}`
        : '';
    }
    if (this.calibrating && pad) {
      const c = this.calibrating;
      const note = (key, v) => {
        c.min[key] = Math.min(c.min[key] ?? v, v);
        c.max[key] = Math.max(c.max[key] ?? v, v);
      };
      pad.axes.forEach((v, i) => note(`a${i}`, v));
      pad.buttons.forEach((b, i) => note(`b${i}`, b.value * 2 - 1));
    }
  }

  #detect(ch, btn) {
    const pad = this.input.getGamepad();
    if (!pad) {
      btn.textContent = 'No device';
      return;
    }
    const read = (p) => [...p.axes.map((v, i) => ['axis', i, v]), ...p.buttons.map((b, i) => ['button', i, b.value * 2 - 1])];
    const base = read(pad);
    btn.textContent = 'Move stick…';
    const start = performance.now();
    const poll = () => {
      const p = this.input.getGamepad();
      if (!p) return;
      let best = null;
      let bestD = 0.4;
      read(p).forEach(([kind, i, v], k) => {
        const d = Math.abs(v - (base[k]?.[2] ?? v));
        if (d > bestD) {
          bestD = d;
          best = [kind, i];
        }
      });
      if (best) {
        this.input.config.axes[ch].kind = best[0];
        this.input.config.axes[ch].index = best[1];
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
        const key = `${a.kind === 'button' ? 'b' : 'a'}${a.index}`;
        const lo = c.min[key];
        const hi = c.max[key];
        if (lo == null || hi == null || hi - lo < 0.2) continue;
        a.min = lo;
        a.max = hi;
        a.center = ch === 'throttle' ? (lo + hi) / 2 : rawInput(pad, a.kind, a.index);
      }
    }
    this.calibrating = null;
    this.input.save();
    this.render();
  }
}
