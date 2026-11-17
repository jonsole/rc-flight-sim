// An aeroplane's shadow, drawn every frame.
//
// The model's silhouette is rendered from the sun's direction into a small
// texture, blurred by the aeroplane's height above the ground (a model on
// the runway casts a crisp shadow; the higher it flies the softer and
// fainter it gets, as the sun is a disc, not a point). With `project` (the
// player's own aeroplane) it falls on everything lit by the sun beyond it -
// the ground, trees, bushes, buildings, cars (src/world/clouds.js
// planeShadowUniforms, in every material with addCloudShadows); otherwise
// (other players') it is laid on the ground as a decal.
import {
  OrthographicCamera, WebGLRenderTarget, MeshBasicMaterial, ShaderMaterial, Mesh, PlaneGeometry, Vector2, Vector3,
  Scene, Color, LinearFilter,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { planeShadowUniforms } from '../world/clouds.js';

const RES = 256;
const SUN_TAN = Math.tan((0.53 * Math.PI) / 180);
const SOFTEN = 2.2; // a little softer than strict geometry, as in haze
let nextLayer = 2;

const blurMat = () => new ShaderMaterial({
  uniforms: { src: { value: null }, dir: { value: new Vector2() } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D src; uniform vec2 dir; varying vec2 vUv;
    void main() {
      // 13-tap Gaussian along dir (dir already scaled to the blur radius).
      float w[7]; w[0] = 0.1596; w[1] = 0.1494; w[2] = 0.1226; w[3] = 0.0882; w[4] = 0.0556; w[5] = 0.0307; w[6] = 0.0149;
      float s = texture2D(src, vUv).r * w[0];
      for (int i = 1; i < 7; i++) {
        s += texture2D(src, vUv + dir * float(i)).r * w[i];
        s += texture2D(src, vUv - dir * float(i)).r * w[i];
      }
      gl_FragColor = vec4(vec3(s), 1.0);
    }`,
  depthTest: false,
  depthWrite: false,
});

export class PlaneShadow {
  /**
   * @param {import('three').Scene} scene  the world (the silhouette is drawn from it)
   * @param {{ heightAt(x: number, z: number): number }} ground
   * @param {{ project?: boolean }} [opts]  project: onto everything (only one may)
   */
  constructor(scene, ground, { project = false } = {}) {
    this.scene = scene;
    this.project = project;
    this.ground = ground;
    this.layer = nextLayer++;
    if (nextLayer > 31) nextLayer = 2;
    this.cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
    this.cam.layers.set(this.layer);
    const opts = { magFilter: LinearFilter, minFilter: LinearFilter, depthBuffer: true };
    this.rtA = new WebGLRenderTarget(RES, RES, opts);
    this.rtB = new WebGLRenderTarget(RES, RES, { ...opts, depthBuffer: false });
    this.black = new MeshBasicMaterial({ color: 0xffffff });
    this.blur = new FullScreenQuad(blurMat());
    // Ground decal: works out, for each point it covers, where that point is
    // in the sun's view, and darkens it by the blurred silhouette there.
    this.decalMat = new ShaderMaterial({
      uniforms: {
        mask: { value: this.rtB.texture },
        camPos: { value: new Vector3() },
        right: { value: new Vector3() },
        up: { value: new Vector3() },
        halfSize: { value: 1 },
        strength: { value: 0.6 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D mask; uniform vec3 camPos; uniform vec3 right; uniform vec3 up; uniform float halfSize; uniform float strength;
        varying vec3 vWorld;
        void main() {
          vec3 d = vWorld - camPos;
          vec2 uv = vec2(dot(d, right), dot(d, up)) / (2.0 * halfSize) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          float m = texture2D(mask, uv).r;
          gl_FragColor = vec4(0.0, 0.0, 0.0, m * strength);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.decal = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.decalMat);
    this.decal.renderOrder = 2;
    this.decal.frustumCulled = false;
    if (!project) scene.add(this.decal);
    this.model = null;
  }

  /** Use this model (puts its meshes on our silhouette layer, out of the scenery shadow map). */
  setModel(model, span) {
    this.model = model;
    this.span = span;
    model.root.traverse((o) => {
      if (o.isMesh) {
        o.layers.enable(this.layer);
        o.castShadow = false;
        o.receiveShadow = true; // trees, buildings etc. shade the plane
      }
    });
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {Vector3} position  the aeroplane
   * @param {Vector3} towards   unit vector towards the sun (or moon)
   * @param {number} strength   0..1 how dark, matching the scenery's shadows (World.shadowDarkness)
   */
  update(renderer, position, towards, strength) {
    if (this.project) planeShadowUniforms.psOn.value = 0;
    if (!this.model || !this.model.root.visible || strength < 0.02 || towards.y < 0.05) {
      this.decal.visible = false;
      return;
    }
    const groundY = this.ground.heightAt(position.x, position.z);
    const height = Math.max(0, position.y - groundY);
    // Where the shadow lands (along the sun ray down to the ground).
    const t = height / towards.y;
    const land = new Vector3().copy(position).addScaledVector(towards, -t);
    // Blur: the sun's angular size times the height (softened a little).
    const blurM = height * SUN_TAN * SOFTEN;
    const half = this.span * 0.6 + blurM * 1.5 + 0.1;
    if (blurM > this.span * 1.2) {
      this.decal.visible = false; // spread too thin to see
      return;
    }
    // Sun's-eye camera centred on the aeroplane, looking down the sun ray.
    const cam = this.cam;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.position.copy(position).addScaledVector(towards, 20);
    cam.up.set(0, 1, 0);
    if (Math.abs(towards.y) > 0.99) cam.up.set(1, 0, 0);
    cam.lookAt(position);
    cam.near = 1;
    cam.far = 40;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // 1. Silhouette (white on black).
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const s = this.scene;
    const bg = s.background;
    const fog = s.fog;
    const over = s.overrideMaterial;
    s.background = null;
    s.fog = null;
    s.overrideMaterial = this.black;
    renderer.setRenderTarget(this.rtA);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(s, cam);
    s.background = bg;
    s.fog = fog;
    s.overrideMaterial = over;
    // 2. Blur, horizontally then vertically.
    const px = blurM / (2 * half); // blur radius as a fraction of the texture
    const step = Math.max(px / 6, 0.5 / RES);
    const bm = this.blur.material;
    bm.uniforms.src.value = this.rtA.texture;
    bm.uniforms.dir.value.set(step, 0);
    renderer.setRenderTarget(this.rtB);
    this.blur.render(renderer);
    bm.uniforms.src.value = this.rtB.texture;
    bm.uniforms.dir.value.set(0, step);
    renderer.setRenderTarget(this.rtA);
    this.blur.render(renderer);
    // Final blurred mask lives in rtA.
    this.decalMat.uniforms.mask.value = this.rtA.texture;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;

    if (this.project) {
      // 3. Onto everything beyond it from the sun (src/world/clouds.js).
      const p = planeShadowUniforms;
      p.psMask.value = this.rtA.texture;
      p.psCam.value.copy(cam.position);
      p.psRight.value.setFromMatrixColumn(cam.matrixWorld, 0);
      p.psUp.value.setFromMatrixColumn(cam.matrixWorld, 1);
      p.psHalf.value = half;
      p.psSun.value.copy(towards);
      // (Its own materials don't take this, so it doesn't shade itself.)
      p.psDepth.value = position.dot(towards);
      p.psOn.value = 1;
      return;
    }
    // 3. Lay it on the ground. The decal is a flat square big enough for the
    // shadow's footprint (stretched along the ground in low sun).
    const u = this.decalMat.uniforms;
    u.camPos.value.copy(cam.position);
    u.right.value.setFromMatrixColumn(cam.matrixWorld, 0);
    u.up.value.setFromMatrixColumn(cam.matrixWorld, 1);
    u.halfSize.value = half;
    u.strength.value = strength;
    const stretch = 1 / Math.max(0.15, towards.y);
    const size = half * 2 * stretch + 1;
    this.decal.scale.set(size, 1, size);
    this.decal.position.set(land.x, groundY + 0.03, land.z);
    this.decal.visible = true;
  }

  dispose() {
    if (this.project) planeShadowUniforms.psOn.value = 0;
    this.scene.remove(this.decal);
    this.rtA.dispose();
    this.rtB.dispose();
    this.decalMat.dispose();
    this.blur.dispose();
  }
}
