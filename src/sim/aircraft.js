// Rigid-body flight model built from individual lifting surfaces.
//
// Every wing segment, tail surface and fin is evaluated separately using the
// local airflow it sees (including rotation, prop wash and downwash), so
// stability, damping, adverse yaw, tip stalls and spins emerge naturally
// rather than being scripted.

import { Vector3, Quaternion } from 'three';
import { coefficients, liftSlope } from './aero.js';
import { Obstacles } from './obstacles.js';

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
const _cp = new Vector3();
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
    // Wingspan for ground effect: given by the definition, else estimated from
    // the outermost wing panel.
    const wingZ = this.surfaces.filter((s) => s.wing).map((s) => Math.abs(s.pos.z));
    this.wingSpan = def.wingSpan || (wingZ.length ? 2.3 * Math.max(...wingZ) : 1);
    this.groundEffect = 0; // telemetry: 0 = none .. 1 = full
    this.contacts = def.contacts.map((c) => ({ ...c, pos: vec(c.pos), load: 0, onGround: false }));
    this.motorPos = vec(def.motor.position);

    // Points checked against obstacles (trees, buildings...): every ground
    // contact plus the leading edge of each wing panel, so a wing can't slice
    // through a trunk between its tip and the fuselage.
    this.collisionPoints = [...this.contacts];
    for (const s of this.surfaces) {
      if (!s.wing) continue;
      const le = s.pos.clone().addScaledVector(s.chord, 0.25 * (s.chordLen || 0));
      this.collisionPoints.push({ name: `${s.name}-le`, pos: le, type: 'hard', crashSpeed: 3.5 });
    }
    this.reach = Math.max(...this.collisionPoints.map((c) => c.pos.length())) + 0.5;
    this._near = [];
    this.inFoliage = false;

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
    // Main wheels = front-most gear contact; tail = rear-most (skid or tail wheel).
    const gear = this.contacts.filter((c) => c.type === 'wheel' || c.type === 'skid');
    const wheel = gear.reduce((a, b) => (b.pos.x > a.pos.x ? b : a));
    const skid = gear.reduce((a, b) => (b.pos.x < a.pos.x ? b : a));
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

    // Fixed-pitch prop: RPM rises with throttle (a little faster at low
    // throttle, where the motor is lightly loaded); static thrust goes as RPM²
    // and falls off linearly to the prop's pitch speed at that RPM. Above it
    // the prop windmills and adds drag.
    const rpmFrac = Math.pow(this.throttleActual, 0.75);
    const thrust = Math.max(
      -0.1 * def.motor.staticThrust * rpmFrac,
      def.motor.staticThrust * (rpmFrac * rpmFrac - (rpmFrac * vAxial) / def.motor.pitchSpeed),
    );
    this.thrust = thrust;
    this.rpm = rpmFrac * def.motor.maxRpm;
    // Momentum theory: fully developed slipstream velocity increment.
    this.propWash = Math.sqrt(vAxial * vAxial + (2 * Math.max(0, thrust)) / (RHO * def.motor.discArea)) - vAxial;

    _f.set(0, 0, 0);
    _m.set(0, 0, 0);

    // Thrust force and reaction torque.
    // Thrust line, with optional down- and right-thrust angles (radians).
    const dn = def.motor.downThrust || 0;
    const rt = def.motor.rightThrust || 0;
    _tmp.set(Math.cos(dn) * Math.cos(rt), -Math.sin(dn), Math.cos(dn) * Math.sin(rt)).multiplyScalar(thrust);
    _f.add(_tmp);
    _r.copy(this.motorPos);
    _m.add(_tmp.cross(_r).negate()); // r × F
    _m.x -= Math.max(0, thrust) * def.motor.torqueFactor;

    // --- Aerodynamic surfaces --------------------------------------------
    // Ground effect: within about a wingspan of the ground the wing's
    // downwash and tip vortices are blocked. McCormick's factor
    // phi = (16h/b)^2 / (1 + (16h/b)^2) scales induced drag and the downwash
    // at the tail, and the wing behaves as if its aspect ratio were AR/phi
    // (steeper lift curve). h = each panel's height above the terrain.
    let phiSum = 0;
    let phiN = 0;
    for (const s of this.surfaces) {
      if (!s.wing) continue;
      _cp.copy(s.pos).applyQuaternion(q).add(this.position);
      const h = Math.max(0.01, _cp.y - this.env.ground.heightAt(_cp.x, _cp.z));
      const x = (16 * h) / this.wingSpan;
      s.ge = (x * x) / (1 + x * x);
      phiSum += s.ge;
      phiN++;
    }
    const phiWing = phiN ? phiSum / phiN : 1;
    this.groundEffect = 1 - phiWing;
    // Downwash at the tail from the previous wing CL (reduced near the ground).
    const downwash = (phiWing * def.downwashGain * 2 * this.wingCL) / (Math.PI * def.wingAspectRatio);
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
      let cl = co.cl;
      // Control deflection adds a little profile drag.
      let cd = co.cd + 0.04 * defl * defl;
      if (s.wing && s.ge < 0.999) {
        const ar = s.foil.ar;
        cl *= liftSlope(ar / s.ge) / liftSlope(ar);
        cd -= co.cdInduced * (1 - s.ge);
      }
      s.alpha = alpha;
      s.cl = cl;
      s.stalled = co.stalled;
      const qa = 0.5 * RHO * speed2 * s.area;
      _lift.crossVectors(s.span, _up).normalize();
      const invSpeed = 1 / Math.sqrt(speed2);
      _tmp.copy(_lift).multiplyScalar(cl * qa).addScaledVector(_up, -cd * qa * invSpeed);
      _f.add(_tmp);
      // As a surface stalls its centre of pressure moves aft, from the quarter
      // chord towards mid-chord: the nose-down pitch break at the stall.
      if (s.chordLen) {
        _cp.copy(s.pos).addScaledVector(s.chord, -0.25 * s.chordLen * co.stalled);
        _m.add(_r.crossVectors(_cp, _tmp));
      } else {
        _m.add(_r.crossVectors(s.pos, _tmp));
      }
      if (s.wing) {
        wingLift += cl * s.area;
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
    if (this.env.obstacles) this.#obstacleContacts(fWorld, _m, q, _qi);

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

  /**
   * Collisions with obstacles. Solids (trunks, buildings, poles, fence) push
   * back like the ground, with friction, and crash the model on a hard enough
   * impact. Foliage is soft: it drags strongly on any point inside it, so a
   * fast hit is a crash and a slow one leaves the model caught in the branches.
   */
  #obstacleContacts(fWorld, mBody, q, qi) {
    const near = this.env.obstacles.near(this.position.x, this.position.z, this.reach, this._near);
    this.inFoliage = false;
    if (!near.length) return;
    const kSolid = 2000 * this.mass;
    const cSolid = 40 * this.mass;
    const cFoliage = 3 * this.mass; // N per (m/s) per point inside the foliage
    for (const c of this.collisionPoints) {
      _r.copy(c.pos).applyQuaternion(q);
      const px = this.position.x + _r.x;
      const py = this.position.y + _r.y;
      const pz = this.position.z + _r.z;
      for (const s of near) {
        const hit = Obstacles.test(s, px, py, pz);
        if (!hit) continue;
        // Point velocity (world) = v + (q ω) × r
        _w.copy(this.omega).applyQuaternion(q);
        _vt.crossVectors(_w, _r).add(this.velocity);
        if (hit.soft) {
          this.inFoliage = true;
          if (_vt.length() > 4) this.crash(`Flew into ${s.name}`);
          _f.copy(_vt).multiplyScalar(-cFoliage);
        } else {
          _n.set(hit.nx, hit.ny, hit.nz);
          const vn = _vt.dot(_n);
          if (c.type === 'prop' && this.rpm > 500) {
            this.propBroken = true;
            this.crash(`Prop hit ${s.name}`);
          } else if (-vn > (c.crashSpeed ?? 3)) {
            this.crash(`Hit ${s.name}`);
          }
          const fn = Math.max(0, kSolid * Math.min(hit.depth, 0.1) - cSolid * vn);
          _f.copy(_n).multiplyScalar(fn);
          // Friction along the surface.
          _vt.addScaledVector(_n, -vn);
          const vtLen = _vt.length();
          if (vtLen > 1e-5) _f.addScaledVector(_vt, (-0.6 * fn * Math.tanh(vtLen / 0.2)) / vtLen);
        }
        fWorld.add(_f);
        _tmp.copy(_f).applyQuaternion(qi);
        mBody.add(_tmp.crossVectors(c.pos, _tmp));
      }
    }
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
      c.depth = Math.max(0, depth); // spring compression, for the 3D model
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
        // Rolling direction = body x projected on ground. A steerable wheel
        // (tail wheel linked to the rudder) turns with the yaw servo: right
        // rudder points it left, so the tail swings left and the nose right.
        const steer = c.steer ? this.servo.yaw * c.steer : 0;
        _u.set(Math.cos(steer), 0, -Math.sin(steer)).applyQuaternion(q);
        _u.addScaledVector(_n, -_u.dot(_n)).normalize();
        _lift.crossVectors(_n, _u); // lateral
        const vRoll = _vt.dot(_u);
        const vLat = _vt.dot(_lift);
        const muRoll = c.muRoll ?? 0.035;
        const muLat = 0.7;
        const fRoll = -muRoll * fn * Math.tanh(vRoll / 0.2);
        // Tyre side force builds with slip angle (the angle between where the
        // wheel points and where it is going) and saturates around 10-15°,
        // rather than gripping fully at the slightest sideways motion. At a
        // standstill it still resists sideways sliding.
        const slip = Math.atan2(vLat, Math.abs(vRoll) + 0.3);
        const fLat = -muLat * fn * Math.tanh(slip / 0.2);
        _f.addScaledVector(_u, fRoll).addScaledVector(_lift, fLat);
      } else if (c.muLat !== undefined) {
        // Tail skid: slides forwards but digs into the grass sideways, which
        // keeps a skid-equipped tail-dragger straight until the tail lifts.
        // A steerable skid (linked to the rudder) turns like a tail wheel.
        const skidSteer = c.steer ? this.servo.yaw * c.steer : 0;
        _u.set(Math.cos(skidSteer), 0, -Math.sin(skidSteer)).applyQuaternion(q);
        _u.addScaledVector(_n, -_u.dot(_n)).normalize();
        _lift.crossVectors(_n, _u);
        const vAlong = _vt.dot(_u);
        const vSide = _vt.dot(_lift);
        _f.addScaledVector(_u, -(c.mu ?? 0.4) * fn * Math.tanh(vAlong / 0.2));
        _f.addScaledVector(_lift, -c.muLat * fn * Math.tanh(vSide / 0.05));
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
