// The start screen's turntable: the selected aircraft's 3D model, turning
// slowly, in its own small renderer (stopped and freed once you fly).
import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight,
  Box3, Vector3, Quaternion, Group, SRGBColorSpace,
} from 'three';

const TURN = 0.45; // rad/s

/** A model at rest, in the shape its update() reads. */
function restAircraft(def) {
  return {
    def,
    surfaces: def.surfaces.map((s) => ({ ...s, pos: new Vector3(...s.pos), deflection: 0 })),
    contacts: [],
    servo: { roll: 0, pitch: 0, yaw: 0 },
    velocity: new Vector3(),
    orientation: new Quaternion(),
    rpm: 0,
    motorRpm: 0,
    propBroken: false,
  };
}

export class AircraftPreview {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      canvas.remove(); // no WebGL to spare: no preview
      return;
    }
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new Scene();
    this.scene.add(new HemisphereLight('#ffffff', '#6a7078', 2.0));
    const sun = new DirectionalLight('#ffffff', 2.2);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.camera = new PerspectiveCamera(30, 2, 0.01, 50);
    this.turntable = new Group();
    this.scene.add(this.turntable);
    this.model = null;
    this.angle = -0.6;
    this.last = performance.now();
    this.frame = requestAnimationFrame((t) => this._tick(t));
  }

  /** Show this aircraft (a registry entry). */
  setAircraft(entry) {
    if (!this.renderer) return;
    this._clear();
    const model = entry.createModel();
    this.rest = restAircraft(entry.def);
    model.update(this.rest, 0);
    model.setPilotVisible(true);
    // Centred on the turntable, the camera back far enough for its size.
    const box = new Box3().setFromObject(model.root);
    const centre = box.getCenter(new Vector3());
    model.root.position.sub(centre);
    this.turntable.add(model.root);
    const size = box.getSize(new Vector3());
    this.radius = Math.max(size.x, size.z) / 2; // as it turns, about this wide
    this.height = size.y;
    this.model = model;
  }

  _clear() {
    if (!this.model) return;
    this.turntable.remove(this.model.root);
    this.model.root.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) m?.dispose();
    });
    this.model = null;
  }

  _tick(t) {
    this.frame = requestAnimationFrame((tt) => this._tick(tt));
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.model) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.angle += TURN * dt;
    this.turntable.rotation.y = this.angle;
    this.model.update(this.rest, dt);
    // A little above, looking slightly down, close enough that it fills the
    // width as it turns (and the height, for a squat canvas).
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const d = Math.max((1.08 * this.radius) / (tanHalf * this.camera.aspect), (0.5 * this.height + 0.45 * this.radius) / tanHalf);
    this.camera.position.set(0, d * 0.32, d);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  /** Stop and free the renderer (the splash is gone). */
  dispose() {
    cancelAnimationFrame(this.frame);
    this._clear();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
  }
}
