// Rigid-body flight model built from individual lifting surfaces.
//
// Every wing segment, tail surface and fin is evaluated separately using the
// local airflow it sees (including rotation, prop wash and downwash), so
// stability, damping, adverse yaw, tip stalls and spins emerge naturally
// rather than being scripted.

import { Vector3, Quaternion } from 'three';
import { coefficients } from './aero.js';

const RHO = 1.225;
const G = 9.81;

const _v = new Vector3();
const _w = new Vector3();
const _u = new Vector3();
const _up = new Vector3();
const _lift = new Vector3();
const _f = new Vector3();
const _m = new Vector3();
const _r = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _n = new Vector3();
const _vt = new Vector3();
const _tmp = new Vector3();
const _fw = new Vector3();

function vec(a) {
  return new Vector3(a[0], a[1], a[2]);
}

export class Aircraft {
  /**
   * @param {object} def   aircraft definition (see se5a.js)
   * @param {object} env   { ground: { heightAt(x,z), normalAt(x,z,out) }, wind: { at(pos,t,out) } }
   */
  constructor(def, env) {
    this.def = def;
    this.env = env;
    this.mass = def.mass;
    this.inertia = vec(def.inertia);

    this.surfaces = def.surfaces.map((s) => {
      const chord = vec(s.chord).normalize();
      const span = vec(s.span).normalize();
      // Orthonormalise chord against span.
      chord.addScaledVector(span, -chord.dot(span)).normalize();
      const normal = new Vector3().crossVectors(span, chord).normalize();
      return { ...s, pos: vec(s.pos), chord, span, normal, alpha: 0, cl: 0, stalled: 0, deflection: 0 };
    });
    this.contacts = def.contacts.map((c) => ({ ...c, pos: vec(c.pos), load: 0, onGround: false }));
    this.motorPos = vec(def.motor.position);

    // State
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.orientation = new Quaternion();
    this.omega = new Vector3(); // body frame rad/s

    this.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    /** Control positions actually sent to the servos (after flight assist). */
    this.servo = { roll: 0, pitch: 0, yaw: 0 };
    /** 'off' | 'as3x' (rate damping) | 'safe' (self-levelling with angle limits) */
    this.assistMode = def.assist ? 'as3x' : 'off';
    this.throttleActual = 0;
    this.thrust = 0;
    this.propWash = 0;
    this.rpm = 0;
    this.time = 0;

    this.battery = { used: 0, voltage: def.battery.cells * 4.2, current: 0 };

    this.crashed = false;
    this.crashReason = '';
    this.propBroken = false;

    // Telemetry (updated each step)
    this.airspeed = 0;
    this.alpha = 0;
    this.beta = 0;
    this.wingCL = 0;
    this.onGround = false;
    this.lastForces = { aero: new Vector3(), moment: new Vector3() };
  }

  /** Place the aircraft at rest on the ground in its three-point attitude. */
  resetOnGround(x, z, headingRad = 0) {
    const wheel = this.contacts.find((c) => c.type === 'wheel');
    const skid = this.contacts.find((c) => c.type === 'skid');
    const pitch = Math.atan2(skid.pos.y - wheel.pos.y, wheel.pos.x - skid.pos.x);
    this.#resetCommon();
    const qYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), headingRad);
    const qPitch = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch);
    this.orientation.copy(qYaw).multiply(qPitch);
    const g = this.env.ground.heightAt(x, z);
    // Lift so the wheels just touch.
    const w = wheel.pos.clone().applyQuaternion(this.orientation);
    this.position.set(x, g - w.y + 0.002, z);
  }

  /** Start in the air, wings level, flying at `speed` m/s. */
  resetInAir(pos, headingRad, speed) {
    this.#resetCommon();
    this.orientation.setFromAxisAngle(new Vector3(0, 1, 0), headingRad);
    this.position.copy(pos);
    this.velocity.set(speed, 0, 0).applyQuaternion(this.orientation);
    this.throttleActual = 0.5;
  }

  #resetCommon() {
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.throttleActual = 0;
    this.crashed = false;
    this.crashReason = '';
    this.propBroken = false;
    this.battery.used = 0;
    this.time = 0;
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
  }

  /** Advance the simulation by `dt` seconds using fixed sub-steps. */
  update(dt, substep = 1 / 600) {
    const n = Math.max(1, Math.ceil(dt / substep));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h);
  }

  step(dt) {
    const def = this.def;
    this.time += dt;
    const q = this.orientation;
    _qi.copy(q).invert();

    // --- Motor -----------------------------------------------------------
    const target = this.crashed || this.propBroken ? 0 : this.controls.throttle;
    const k = Math.min(1, dt / def.motor.spoolTime);
    this.throttleActual += (target - this.throttleActual) * k;

    // --- Air-relative velocity in body frame -----------------------------
    const wind = this.env.wind ? this.env.wind.at(this.position, this.time, _tmp) : _tmp.set(0, 0, 0);
    _v.copy(this.velocity).sub(wind).applyQuaternion(_qi); // body-frame air velocity
    const vAxial = Math.max(0, _v.x);
    this.airspeed = _v.length();
    this.alpha = Math.atan2(-_v.y, Math.max(0.001, _v.x));
    this.beta = Math.atan2(_v.z, Math.max(0.001, _v.x));

    // Thrust: simple linear fall-off to pitch speed.
    const tStatic = def.motor.staticThrust * this.throttleActual;
    const thrust = Math.max(0, tStatic * (1 - vAxial / def.motor.pitchSpeed));
    this.thrust = thrust;
    this.rpm = this.throttleActual * def.motor.maxRpm * (0.85 + 0.15 * Math.min(1, vAxial / def.motor.pitchSpeed));
    // Momentum theory: fully developed slipstream velocity increment.
    this.propWash = Math.sqrt(vAxial * vAxial + (2 * thrust) / (RHO * def.motor.discArea)) - vAxial;

    _f.set(0, 0, 0);
    _m.set(0, 0, 0);

    // Thrust force and reaction torque.
    _f.x += thrust;
    _r.copy(this.motorPos);
    _m.add(_tmp.set(thrust, 0, 0).cross(_r).negate()); // r × F
    _m.x -= thrust * def.motor.torqueFactor;

    // --- Aerodynamic surfaces --------------------------------------------
    // Downwash at the tail from the previous wing CL.
    const downwash = (def.downwashGain * 2 * this.wingCL) / (Math.PI * def.wingAspectRatio);
    let wingLift = 0;
    let wingArea = 0;
    const c = this.#assist(this.servo);
    for (const s of this.surfaces) {
      // Panel velocity through the air = V + ω × r
      _u.crossVectors(this.omega, s.pos).add(_v);
      if (s.propwash) _u.x += this.propWash * s.propwash;
      // Remove spanwise flow
      _up.copy(_u).addScaledVector(s.span, -_u.dot(s.span));
      const speed2 = _up.lengthSq();
      if (speed2 < 1e-6) continue;
      let alpha = Math.atan2(-_up.dot(s.normal), _up.dot(s.chord));
      if (s.downwash) alpha -= downwash;
      let defl = 0;
      for (const ctl of s.controls) {
        const input = c[ctl.input] || 0;
        defl += input * ctl.gain * ctl.max;
        alpha += input * ctl.gain * ctl.max * ctl.tau;
      }
      s.deflection = defl;
      const co = coefficients(alpha, s.foil);
      s.alpha = alpha;
      s.cl = co.cl;
      s.stalled = co.stalled;
      const qa = 0.5 * RHO * speed2 * s.area;
      // Control deflection adds a little profile drag.
      const cd = co.cd + 0.04 * defl * defl;
      _lift.crossVectors(s.span, _up).normalize();
      const invSpeed = 1 / Math.sqrt(speed2);
      _tmp.copy(_lift).multiplyScalar(co.cl * qa).addScaledVector(_up, -cd * qa * invSpeed);
      _f.add(_tmp);
      _m.add(_r.crossVectors(s.pos, _tmp));
      if (s.wing) {
        wingLift += co.cl * s.area;
        wingArea += s.area;
      }
    }
    this.wingCL = wingArea > 0 ? wingLift / wingArea : 0;

    // Parasite drag (per axis, quadratic).
    const p = def.parasite;
    _f.x -= 0.5 * RHO * p.x * _v.x * Math.abs(_v.x);
    _f.y -= 0.5 * RHO * p.y * _v.y * Math.abs(_v.y);
    _f.z -= 0.5 * RHO * p.z * _v.z * Math.abs(_v.z);

    // Small extra rotational damping for unmodelled structure.
    _m.addScaledVector(this.omega, -0.004);

    this.lastForces.aero.copy(_f);
    this.lastForces.moment.copy(_m);

    // --- Convert to world, add gravity and ground --------------------------
    const fWorld = _fw.copy(_f).applyQuaternion(q);
    fWorld.y -= this.mass * G;
    this.#groundContacts(fWorld, _m, q, _qi);

    // --- Integrate (semi-implicit Euler) ----------------------------------
    this.velocity.addScaledVector(fWorld, dt / this.mass);
    this.position.addScaledVector(this.velocity, dt);

    const I = this.inertia;
    const w = this.omega;
    // Euler's equations: I ω̇ = M − ω × (I ω)
    _w.set(I.x * w.x, I.y * w.y, I.z * w.z);
    _tmp.crossVectors(w, _w);
    w.x += ((_m.x - _tmp.x) / I.x) * dt;
    w.y += ((_m.y - _tmp.y) / I.y) * dt;
    w.z += ((_m.z - _tmp.z) / I.z) * dt;

    _q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
    _q.premultiply(q); // q * (ω dt / 2)
    q.set(q.x + _q.x, q.y + _q.y, q.z + _q.z, q.w + _q.w).normalize();

    // --- Battery -----------------------------------------------------------
    const b = def.battery;
    const current = b.maxCurrent * Math.pow(this.throttleActual, 1.6);
    this.battery.current = current;
    this.battery.used += (current * dt * 1000) / 3600;
    const soc = Math.max(0, 1 - this.battery.used / b.capacity);
    const restCell = 3.3 + 0.9 * soc - 0.25 * Math.pow(1 - soc, 6);
    this.battery.voltage = b.cells * restCell - current * b.internalResistance;
  }

  /** Mix stick inputs with gyro/attitude feedback, like AS3X+ and SAFE Select. */
  #assist(out) {
    const c = this.controls;
    const a = this.def.assist;
    // Transmitter trims (set once, like trimming on a first flight).
    const trim = this.def.trim || {};
    out.roll = c.roll + (trim.roll || 0);
    out.pitch = c.pitch + (trim.pitch || 0);
    out.yaw = c.yaw + (trim.yaw || 0);
    if (!a || this.assistMode === 'off' || this.crashed) return out;
    // Surface authority grows with V², so gains fall with 1/V².
    const v = Math.max(6, this.airspeed);
    const gs = Math.min(3, (a.refSpeed / v) ** 2);
    const w = this.omega;
    const g = a.rateGain;
    if (this.assistMode === 'safe') {
      // Stick commands an attitude; the controller flies to it.
      const q = this.orientation;
      _r.set(1, 0, 0).applyQuaternion(q);
      const pitch = Math.asin(Math.max(-1, Math.min(1, _r.y)));
      _r.set(0, 0, 1).applyQuaternion(q);
      _tmp.set(0, 1, 0).applyQuaternion(q);
      const roll = Math.atan2(-_r.y, _tmp.y);
      const rollErr = c.roll * a.maxBank - roll;
      const pitchErr = c.pitch * a.maxPitch - pitch;
      out.roll = (a.levelGain.roll * rollErr - 2.5 * g.roll * w.x) * gs + (trim.roll || 0);
      out.pitch = (a.levelGain.pitch * pitchErr - 2.5 * g.pitch * w.z) * gs;
    } else {
      // Rate damping, backed off as the pilot moves the stick.
      out.roll -= g.roll * w.x * gs * (1 - 0.6 * Math.abs(c.roll));
      out.pitch -= g.pitch * w.z * gs * (1 - 0.6 * Math.abs(c.pitch));
    }
    // Yaw: ω_y > 0 is yawing left, so add it (right rudder opposes).
    out.yaw += g.yaw * w.y * gs * (1 - 0.6 * Math.abs(c.yaw));
    out.roll = Math.max(-1, Math.min(1, out.roll));
    out.pitch = Math.max(-1, Math.min(1, out.pitch));
    out.yaw = Math.max(-1, Math.min(1, out.yaw));
    return out;
  }

  #groundContacts(fWorld, mBody, q, qi) {
    const ground = this.env.ground;
    let any = false;
    for (const c of this.contacts) {
      _r.copy(c.pos).applyQuaternion(q); // world-frame lever arm
      const px = this.position.x + _r.x;
      const py = this.position.y + _r.y;
      const pz = this.position.z + _r.z;
      const h = ground.heightAt(px, pz);
      const depth = h - py;
      c.onGround = depth > 0;
      if (!c.onGround) {
        c.load = 0;
        continue;
      }
      any = true;
      ground.normalAt(px, pz, _n);
      // Point velocity (world) = v + (q ω) × r
      _w.copy(this.omega).applyQuaternion(q);
      _vt.crossVectors(_w, _r).add(this.velocity);
      const vn = _vt.dot(_n);

      // Crash detection on impact speed.
      if (c.type === 'prop') {
        if (this.throttleActual > 0.05 || this.rpm > 500) {
          this.propBroken = true;
          if (this.velocity.length() > 2 || this.throttleActual > 0.3) this.crash('Prop strike');
        }
      } else if (-vn > c.crashSpeed) {
        this.crash(c.type === 'wheel' ? 'Undercarriage collapsed' : `Hit the ground (${c.name})`);
      }

      const kSpring = c.k ?? 4000;
      const damp = c.c ?? 50;
      let fn = kSpring * Math.min(depth, 0.05) - damp * vn;
      if (depth > 0.05) fn += 30000 * (depth - 0.05);
      if (fn < 0) fn = 0;
      c.load = fn;

      _f.copy(_n).multiplyScalar(fn);

      // Friction in the ground plane.
      _vt.addScaledVector(_n, -vn); // tangential velocity
      const vtLen = _vt.length();
      if (c.type === 'wheel') {
        // Rolling direction = body x projected on ground.
        _u.set(1, 0, 0).applyQuaternion(q);
        _u.addScaledVector(_n, -_u.dot(_n)).normalize();
        _lift.crossVectors(_n, _u); // lateral
        const vRoll = _vt.dot(_u);
        const vLat = _vt.dot(_lift);
        const muRoll = 0.035;
        const muLat = 0.7;
        const fRoll = -muRoll * fn * Math.tanh(vRoll / 0.2);
        const fLat = -muLat * fn * Math.tanh(vLat / 0.3);
        _f.addScaledVector(_u, fRoll).addScaledVector(_lift, fLat);
      } else if (vtLen > 1e-5) {
        const mu = c.mu ?? 0.6;
        _f.addScaledVector(_vt, (-mu * fn * Math.tanh(vtLen / 0.2)) / vtLen);
      }

      fWorld.add(_f);
      // Moment in body frame: r_body × F_body
      _tmp.copy(_f).applyQuaternion(qi);
      mBody.add(_tmp.crossVectors(c.pos, _tmp));
    }
    this.onGround = any;
  }

  /** Euler angles for display: { heading, pitch, roll } in radians. */
  attitude() {
    const fwd = new Vector3(1, 0, 0).applyQuaternion(this.orientation);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.orientation);
    const right = new Vector3(0, 0, 1).applyQuaternion(this.orientation);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const heading = Math.atan2(fwd.z, fwd.x); // 0 = +x, positive towards +z
    const roll = Math.atan2(-right.y, up.y);
    return { heading, pitch, roll };
  }
}
