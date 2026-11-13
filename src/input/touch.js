// On-screen transmitter for phones and tablets: two virtual sticks plus a few
// buttons. Multi-touch via Pointer Events, so both thumbs work at once.
//
// Mode 2 (default): left = throttle (stays put) + rudder, right = elevator + aileron.
// Mode 1:           left = elevator + rudder,              right = throttle + aileron.

const clamp = (v) => Math.max(-1, Math.min(1, v));

class Stick {
  /**
   * @param {HTMLElement} parent
   * @param {'left'|'right'} side
   */
  constructor(parent, side) {
    this.x = 0;
    this.y = 0;
    this.holdY = false; // throttle axis: no spring in y
    this.pointer = null;
    this.zone = document.createElement('div');
    this.zone.className = `stick-zone ${side}`;
    this.base = document.createElement('div');
    this.base.className = 'stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.append(this.knob);
    this.zone.append(this.base);
    parent.append(this.zone);

    this.zone.addEventListener('pointerdown', (e) => {
      if (this.pointer !== null) return;
      this.pointer = e.pointerId;
      this.zone.setPointerCapture(e.pointerId);
      this.zone.classList.add('active');
      this.#move(e);
      e.preventDefault();
    });
    this.zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointer) this.#move(e);
    });
    const end = (e) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.zone.classList.remove('active');
      this.x = 0; // springs back to centre
      if (!this.holdY) this.y = 0;
      this.#render();
    };
    this.zone.addEventListener('pointerup', end);
    this.zone.addEventListener('pointercancel', end);
  }

  #move(e) {
    const r = this.base.getBoundingClientRect();
    const radius = r.width / 2;
    this.x = clamp((e.clientX - (r.left + radius)) / radius);
    this.y = clamp((e.clientY - (r.top + radius)) / radius);
    this.#render();
  }

  /** Throttle axis: -1 (top, full power) .. +1 (bottom, idle). */
  setHoldY(hold) {
    this.holdY = hold;
    if (hold && this.pointer === null) this.y = 1; // start at idle
    if (!hold && this.pointer === null) this.y = 0;
    this.#render();
  }

  #render() {
    // Knob travel is the base radius.
    const k = this.base.clientWidth / 2 || 60;
    this.knob.style.transform = `translate(${this.x * k}px, ${this.y * k}px)`;
  }
}

export class TouchControls {
  /**
   * @param {object} opts { onAction(code), onMenu() }
   */
  constructor(opts) {
    this.opts = opts;
    this.mode = 2;
    this.visible = false;
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.left = new Stick(this.root, 'left');
    this.right = new Stick(this.root, 'right');

    const bar = document.createElement('div');
    bar.className = 'touch-bar';
    const button = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      bar.append(b);
    };
    button('CAM', 'Change camera', () => opts.onAction('KeyC'));
    button('RESET', 'Reset aircraft', () => opts.onAction('KeyR'));
    button('ASSIST', 'Flight assist: manual / AS3X / SAFE', () => opts.onAction('KeyG'));
    button('☰', 'Menu', () => opts.onMenu());
    this.root.append(bar);
    document.body.append(this.root);
    this.setMode(2);
    this.setVisible(false);
  }

  setMode(mode) {
    this.mode = mode === 1 ? 1 : 2;
    this.left.setHoldY(this.mode === 2);
    this.right.setHoldY(this.mode === 1);
    this.root.dataset.mode = String(this.mode);
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
    document.body.classList.toggle('touch', v);
  }

  /** Stick positions as transmitter channels. */
  read() {
    const L = this.left;
    const R = this.right;
    const thrStick = this.mode === 2 ? L : R;
    const pitchStick = this.mode === 2 ? R : L;
    return {
      roll: R.x,
      yaw: L.x,
      pitch: pitchStick.y, // pull back (down the screen) = up elevator
      throttle: (1 - thrStick.y) / 2,
    };
  }
}

/** True on phones/tablets (coarse pointer or touch support). */
export function isTouchDevice() {
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
}
