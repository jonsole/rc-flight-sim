// Camera modes: line-of-sight (pilot on the ground), FPV, and chase.
import { PerspectiveCamera, Vector3, Quaternion, MathUtils } from 'three';
import { pilotSpot } from '../sim/location.js';
import { heightAt } from '../sim/terrain.js';

export const CAMERA_MODES = ['los', 'fpv', 'chase'];
export const CAMERA_LABELS = { los: 'Line of sight', fpv: 'FPV', chase: 'Chase' };

const _v = new Vector3();
const _q = new Quaternion();
const _m = new Vector3();

/** Convert a horizontal FOV (deg) to three.js vertical FOV for an aspect. */
function hToVFov(hDeg, aspect) {
  const h = MathUtils.degToRad(hDeg);
  return MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect));
}

export class CameraRig {
  constructor(settings) {
    this.walk = { x: 0, z: 0 }; // where the pilot has walked from their spot (m: hand launch)
    this.settings = settings;
    this.camera = new PerspectiveCamera(50, 1, 0.05, 20000);
    this.mode = 'los';
    this.chasePos = new Vector3();
    this.chaseInit = false;
    this.losLook = new Vector3();
    this.losInit = false;
    this.shake = new Vector3();
    this.views = null;
  }

  /** Use the camera mounts and framing of an aircraft registry entry. */
  setAircraft(entry) {
    this.views = entry.views;
    this.chaseInit = false;
    this.losInit = false;
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

  /** Your eye: at the site's flight line (pilotSpot), moved by your pilot-position setting. */
  pilotEye() {
    const s = this.settings;
    const [px, pz] = pilotSpot();
    // (Plus where you've walked to, with a hand-launch model: walk.)
    const x = px + s.pilotX + this.walk.x;
    const z = pz + s.pilotZ + this.walk.z;
    return new Vector3(x, heightAt(x, z) + 1.7, z);
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
      // losFov is across the screen, like FPV's.
      let fov = hToVFov(Math.min(s.losFov, 170), aspect);
      if (s.losZoom > 0) {
        // Auto-zoom: keep the model from shrinking to a dot at range.
        const apparent = MathUtils.radToDeg(2 * Math.atan(this.views.span / 2 / Math.max(dist, 1)));
        // Gentle: the model about 1/25 of the screen's height, at most ~2.5x
        // zoom (20 deg); strong: about 1/12, at most ~5x (10 deg).
        const strong = s.losZoom >= 2;
        const wanted = apparent * (strong ? 12 : 25);
        fov = MathUtils.clamp(wanted, Math.min(fov, strong ? 10 : 20), fov);
      }
      cam.fov = MathUtils.lerp(cam.fov, fov, 1 - Math.exp(-dt * 4));
      // Nothing is ever this close to the pilot. Every bit nearer costs depth
      // precision far away (where leaf cards of trees, only centimetres
      // apart, would flicker through each other).
      cam.near = 0.5;
    } else if (this.mode === 'fpv') {
      const mount = _m.fromArray(s.fpvMount === 'wing' ? this.views.pod : this.views.cockpit);
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
      // (Further back and up when towing, to see what's on the end of the
      // cord: this.towReach, metres behind the tail.)
      const c = this.views.chase;
      const reach = this.towReach ?? 0;
      const cb = Math.max(c.back, reach > 0 ? reach * 1.2 + 1.5 : 0);
      const cu = c.up + reach * 0.3;
      const back = new Vector3(-cb, cu, 0).applyQuaternion(aircraft.orientation);
      back.y = Math.max(back.y, cu * 0.7);
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
      cam.near = 0.25; // (as LOS: depth precision for the trees)
    }
    cam.updateProjectionMatrix();
  }
}
