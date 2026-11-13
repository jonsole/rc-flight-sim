// On-screen display: FPV OSD (Betaflight/INAV style) and a small LOS HUD.

export class OSD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.flightTime = 0;
    this.armed = false;
    this.showHud = true;
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  update(dt, aircraft) {
    if (aircraft.throttleActual > 0.05) this.armed = true;
    if (this.armed && !aircraft.crashed) this.flightTime += dt;
  }

  reset() {
    this.flightTime = 0;
    this.armed = false;
  }

  draw(mode, aircraft, info) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.showHud) return;
    if (mode === 'fpv') this.#fpv(aircraft, info);
    else this.#los(aircraft, info);
  }

  #text(str, x, y, align = 'left', size = 18) {
    const ctx = this.ctx;
    ctx.font = `bold ${size}px "Consolas", "Courier New", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = '#f4f4f4';
    ctx.fillText(str, x, y);
  }

  #fpv(ac, info) {
    const ctx = this.ctx;
    const { w, h } = this;
    const s = Math.min(1.4, Math.max(0.8, h / 720));
    const fs = 18 * s;
    const pad = 28 * s;
    // Touch screens: keep clear of the button bar on top and the sticks below.
    const top = pad + (info.touch ? 40 : 0);
    const att = ac.attitude();

    // Artificial horizon, scaled to match the real horizon for this FOV.
    const ppr = h / 2 / Math.tan(((info.vfov || 60) * Math.PI) / 360); // px per radian (small-angle)
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-att.roll);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 3;
    for (const deg of [-20, -10, 0, 10, 20]) {
      const y = Math.tan(att.pitch + (info.tilt || 0) - (deg * Math.PI) / 180) * ppr;
      const len = deg === 0 ? 120 * s : 26 * s;
      const gap = deg === 0 ? 40 * s : 12 * s;
      ctx.beginPath();
      ctx.moveTo(-len, y);
      ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y);
      ctx.lineTo(len, y);
      ctx.stroke();
    }
    ctx.restore();

    // Crosshair
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 22 * s, h / 2);
    ctx.lineTo(w / 2 - 8 * s, h / 2);
    ctx.moveTo(w / 2 + 8 * s, h / 2);
    ctx.lineTo(w / 2 + 22 * s, h / 2);
    ctx.moveTo(w / 2, h / 2 - 8 * s);
    ctx.lineTo(w / 2, h / 2 - 2 * s);
    ctx.stroke();

    const v = ac.battery.voltage;
    const cells = ac.def.battery.cells;
    const low = v / cells < 3.5;
    this.#text(`${v.toFixed(1)}V${low && Math.floor(performance.now() / 400) % 2 ? ' LOW' : ''}`, pad, top, 'left', fs);
    this.#text(`${Math.round(ac.battery.used)}mAh  ${ac.battery.current.toFixed(1)}A`, pad, top + fs * 1.3, 'left', fs * 0.85);
    const t = this.flightTime;
    this.#text(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`, w - pad, top, 'right', fs);
    this.#text(`RSSI ${info.rssi}`, w - pad, top + fs * 1.3, 'right', fs * 0.85);

    // Speed / altitude
    this.#text(`${Math.round(ac.airspeed * 3.6)} km/h`, pad, h / 2, 'left', fs);
    this.#text(`${Math.round(ac.position.y)} m`, w - pad, h / 2, 'right', fs);
    const vs = ac.velocity.y;
    this.#text(`${vs >= 0 ? '+' : ''}${vs.toFixed(1)} m/s`, w - pad, h / 2 + fs * 1.3, 'right', fs * 0.8);

    // Home arrow and distance
    const dx = info.home.x - ac.position.x;
    const dz = info.home.z - ac.position.z;
    const dist = Math.hypot(dx, dz);
    const bearing = Math.atan2(dz, dx); // world angle to home
    // Arrow up = home straight ahead; heading/bearing share the x→z angle convention.
    const rel = bearing - att.heading - Math.PI / 2;
    ctx.save();
    ctx.translate(w / 2, h - pad * 2.2);
    ctx.rotate(rel);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14 * s, 0);
    ctx.lineTo(-8 * s, -8 * s);
    ctx.lineTo(-4 * s, 0);
    ctx.lineTo(-8 * s, 8 * s);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    this.#text(`H ${Math.round(dist)}m`, w / 2, h - pad, 'center', fs * 0.9);

    const thrY = info.touch ? h / 2 - fs * 1.4 : h - pad; // above the speed, clear of the left stick
    this.#text(`THR ${Math.round(ac.controls.throttle * 100)}%`, pad, thrY, 'left', info.touch ? fs * 0.85 : fs);
    const hdg = ((90 + (att.heading * 180) / Math.PI) % 360 + 360) % 360; // compass, north = -z
    this.#text(`${String(Math.round(hdg) % 360).padStart(3, '0')}°`, w / 2, top, 'center', fs);
    this.#text(info.assist, pad, top + fs * 2.5, 'left', fs * 0.85);
    if (info.assistFlash) this.#text(`ASSIST: ${info.assist}`, w / 2, h / 2 + 70 * s, 'center', fs * 1.2);
    if (!ac.crashed && ac.inFoliage) this.#text('IN THE TREES', w / 2, h / 2 - 60 * s, 'center', fs * 1.3);
    if (ac.held) this.#text('THROTTLE UP TO LAUNCH', w / 2, h / 2 - 60 * s, 'center', fs * 1.3);
    if (ac.crashed) this.#text(`CRASH: ${ac.crashReason.toUpperCase()}`, w / 2, h / 2 - 60 * s, 'center', fs * 1.3);
    else if (info.paused) this.#text('PAUSED', w / 2, h / 2 - 60 * s, 'center', fs * 1.3);
  }

  #los(ac, info) {
    const { h } = this;
    const fs = 14;
    const x = 16;
    // Bottom-left normally; top-left when the touch sticks occupy the bottom.
    let y = info.touch ? 64 : h - 16 - fs * 4.2;
    const lines = [
      `SPD ${Math.round(ac.airspeed * 3.6)} km/h`,
      `ALT ${ac.position.y.toFixed(1)} m`,
      `THR ${Math.round(ac.controls.throttle * 100)}%   BAT ${ac.battery.voltage.toFixed(1)}V`,
      `${{ transmitter: 'TX', touch: 'TOUCH', keyboard: 'KEYS' }[info.inputSource]}   ${info.assist}   ${info.cameraLabel}`,
    ];
    for (const l of lines) {
      this.#text(l, x, y, 'left', fs);
      y += fs * 1.35;
    }
    if (info.assistFlash) this.#text(`Flight assist: ${info.assist}`, this.w / 2, 120, 'center', 20);
    if (ac.held) this.#text('Hand launch: throttle up to throw it', this.w / 2, info.touch ? 150 : 80, 'center', info.touch ? 18 : 22);
    if (!ac.crashed && ac.inFoliage) this.#text(`Caught in a tree - ${info.touch ? 'tap RESET' : 'press R to reset'}`, this.w / 2, info.touch ? 150 : 80, 'center', info.touch ? 18 : 22);
    if (ac.crashed) this.#text(`Crashed: ${ac.crashReason} - ${info.touch ? 'tap RESET' : 'press R to reset'}`, this.w / 2, info.touch ? 150 : 80, 'center', info.touch ? 18 : 22);
    else if (info.paused) this.#text('PAUSED', this.w / 2, 80, 'center', 22);
  }
}
