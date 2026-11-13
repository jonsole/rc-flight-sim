// Camera modes: line-of-sight (pilot on the ground), FPV, and chase.
import { PerspectiveCamera, Vector3, Quaternion, MathUtils } from 'three';
import { geometry as G } from '../sim/se5a.js';

export const CAMERA_MODES = ['los', 'fpv', 'chase'];
export const CAMERA_LABELS = { los: 'Line of sight', fpv: 'FPV', chase: 'Chase' };

const _v = new Vector3();
const _q = new Quaternion();

/** Convert a horizontal FOV (deg) to three.js vertical FOV for an aspect. */
function hToVFov(hDeg, aspect) {
  const h = MathUtils.degToRad(hDeg);
  return MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect));
}

export class CameraRig {
  constructor(settings) {
    this.settings = settings;
    this.camera = new PerspectiveCamera(50, 1, 0.05, 20000);
    this.mode = 'los';
    this.chasePos = new Vector3();
    this.chaseInit = false;
    this.losLook = new Vector3();
    this.losInit = false;
    this.shake = new Vector3();
  }

  setMode(mode) {
    this.mode = mode;
    this.chaseInit = false;
    this.losInit = false;
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  resize(aspect) {
    this.aspect = aspect;
    this.camera.aspect = aspect;
  }

  pilotEye() {
    const s = this.settings;
    return new Vector3(s.pilotX, 1.7, s.pilotZ);
  }

  update(aircraft, dt) {
    const s = this.settings;
    const cam = this.camera;
    const aspect = this.aspect || 16 / 9;

    if (this.mode === 'los') {
      const eye = this.pilotEye();
      cam.position.copy(eye);
      // Light smoothing so the view tracks like a human head, not a turret.
      if (!this.losInit) {
        this.losLook.copy(aircraft.position);
        this.losInit = true;
      }
      const k = 1 - Math.exp(-dt * 18);
      this.losLook.lerp(aircraft.position, k);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.losLook);
      const dist = eye.distanceTo(aircraft.position);
      let fov = s.losFov;
      if (s.losZoom > 0) {
        // Auto-zoom: keep the model from shrinking to a dot at range.
        const apparent = MathUtils.radToDeg(2 * Math.atan(G.span / 2 / Math.max(dist, 1)));
        const wanted = apparent * (s.losZoom >= 2 ? 6 : 10);
        fov = MathUtils.clamp(wanted, 8, s.losFov);
      }
      cam.fov = MathUtils.lerp(cam.fov, fov, 1 - Math.exp(-dt * 4));
      cam.near = 0.1;
    } else if (this.mode === 'fpv') {
      const mount = s.fpvMount === 'wing'
        ? new Vector3(G.upperLeX - 0.05, G.upperY + 0.05, 0)
        : new Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
      _v.copy(mount).applyQuaternion(aircraft.orientation).add(aircraft.position);
      // Engine vibration
      const vib = aircraft.throttleActual * 0.0012 * (s.fpvShake ? 1 : 0);
      this.shake.set((Math.random() - 0.5) * vib, (Math.random() - 0.5) * vib, (Math.random() - 0.5) * vib);
      cam.position.copy(_v).add(this.shake);
      // Camera looks along +x of the body, tilted up by the uptilt angle.
      // Three.js cameras look down -z; rotate -90° about y to look down +x.
      _q.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
      cam.quaternion.copy(aircraft.orientation).multiply(_q);
      cam.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(s.fpvTilt)));
      cam.fov = hToVFov(s.fpvFov, aspect);
      cam.near = 0.02;
    } else {
      // Chase: behind and above along the flight path.
      const back = new Vector3(-2.1, 0.6, 0).applyQuaternion(aircraft.orientation);
      back.y = Math.max(back.y, 0.4);
      const target = _v.copy(aircraft.position).add(back);
      if (!this.chaseInit) {
        this.chasePos.copy(target);
        this.chaseInit = true;
      }
      this.chasePos.lerp(target, 1 - Math.exp(-dt * 5));
      cam.position.copy(this.chasePos);
      cam.up.set(0, 1, 0);
      cam.lookAt(aircraft.position);
      cam.fov = hToVFov(80, aspect);
      cam.near = 0.05;
    }
    cam.updateProjectionMatrix();
  }
}
