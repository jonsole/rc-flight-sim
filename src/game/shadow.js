// Shadows for the challenges (src/game/). The scenery's shadow map
// (src/world/shadows.js) is too coarse for poles and hoops and is only
// redrawn when the sun moves, so the courses have their own:
//
// - CourseShadow: everything in a course that stays put (pylons, hoops,
//   poles, cones, flags), drawn from the sun into one sharp silhouette and
//   laid over the ground on a sheet that follows its bumps. Redrawn only
//   when something in it moves (markDirty) or the sun does.
// - blob shadows for balloons: a soft round shadow each, cast along the
//   sun, fainter and softer the higher the balloon.
// (The streamer planes use the aeroplane shadow, src/view/planeShadow.js.)
import {
  OrthographicCamera, WebGLRenderTarget, MeshBasicMaterial, ShaderMaterial, Mesh, PlaneGeometry, Vector2, Vector3,
  Color, LinearFilter, Box3, BufferGeometry, BufferAttribute,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { takeLayer } from '../view/planeShadow.js';

const RES = 1024;
const GRID = 48; // ground sheet squares each way

const decalShader = {
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
      if (m < 0.004) discard;
      gl_FragColor = vec4(0.0, 0.0, 0.0, m * strength);
    }`,
};

const blurShader = {
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D src; uniform vec2 dir; varying vec2 vUv;
    void main() {
      float s = texture2D(src, vUv).r * 0.38 + (texture2D(src, vUv + dir).r + texture2D(src, vUv - dir).r) * 0.24
        + (texture2D(src, vUv + 2.0 * dir).r + texture2D(src, vUv - 2.0 * dir).r) * 0.07;
      gl_FragColor = vec4(vec3(s), 1.0);
    }`,
};

/**
 * Left out of the course's still shadow: things that move (userData.mover:
 * they have shadows of their own) and things flat on the ground
 * (userData.noShadow: paint on the grass).
 */
function moving(o) {
  for (let q = o; q; q = q.parent) if (q.userData?.mover || q.userData?.noShadow) return true;
  return false;
}

export class CourseShadow {
  /**
   * @param {import('three').Scene} scene
   * @param {{ heightAt(x: number, z: number): number }} ground
   */
  constructor(scene, ground) {
    this.scene = scene;
    this.ground = ground;
    this.layer = takeLayer();
    this.cam = new OrthographicCamera(-1, 1, 1, -1, 1, 100);
    this.cam.layers.set(this.layer);
    const opts = { magFilter: LinearFilter, minFilter: LinearFilter };
    this.rtA = new WebGLRenderTarget(RES, RES, { ...opts, depthBuffer: true });
    this.rtB = new WebGLRenderTarget(RES, RES, { ...opts, depthBuffer: false });
    this.white = new MeshBasicMaterial({ color: 0xffffff });
    this.blur = new FullScreenQuad(new ShaderMaterial({ uniforms: { src: { value: null }, dir: { value: new Vector2() } }, ...blurShader, depthTest: false, depthWrite: false }));
    this.mat = new ShaderMaterial({
      uniforms: { mask: { value: this.rtA.texture }, camPos: { value: new Vector3() }, right: { value: new Vector3() }, up: { value: new Vector3() }, halfSize: { value: 1 }, strength: { value: 0.6 } },
      ...decalShader,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.sheet = new Mesh(new BufferGeometry(), this.mat);
    this.sheet.frustumCulled = false;
    this.sheet.renderOrder = 3; // (over paint on the grass too)
    this.sheet.visible = false;
    scene.add(this.sheet);
    this.group = null;
    this.dirty = true;
    this.sun = new Vector3();
  }

  /** The course's things to shade with (all its meshes not marked userData.mover). */
  setObjects(group) {
    this.group = group;
    this.box = new Box3();
    group?.updateMatrixWorld(true); // (things placed inside groups: where they really are)
    group?.traverse((o) => {
      if (!o.isMesh || moving(o)) return;
      o.layers.enable(this.layer);
      o.castShadow = false; // (not in the scenery's shadow map: it isn't redrawn as things move)
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      this.box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  /**
   * Every frame.
   * @param {import('three').WebGLRenderer} renderer
   * @param {Vector3} towards  unit vector towards the sun
   * @param {number} strength  how dark (World.shadowDarkness)
   */
  update(renderer, towards, strength) {
    this.mat.uniforms.strength.value = strength;
    const show = this.group && !this.box.isEmpty() && strength >= 0.02 && towards.y >= 0.05;
    this.sheet.visible = !!show;
    if (!show) return;
    if (this.sun.angleTo(towards) > 0.003) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.sun.copy(towards);
    const c = this.box.getCenter(new Vector3());
    const r = this.box.getSize(new Vector3()).length() / 2 + 1;
    // Sun's-eye view of the whole course.
    const cam = this.cam;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.position.copy(c).addScaledVector(towards, r + 20);
    cam.up.set(0, 1, 0);
    if (Math.abs(towards.y) > 0.99) cam.up.set(1, 0, 0);
    cam.lookAt(c);
    cam.near = 1;
    cam.far = 2 * r + 40;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // Silhouette, then a little softening.
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const s = this.scene;
    const keep = [s.background, s.fog, s.overrideMaterial];
    s.background = null;
    s.fog = null;
    s.overrideMaterial = this.white;
    this.sheet.visible = false;
    renderer.setRenderTarget(this.rtA);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(s, cam);
    [s.background, s.fog, s.overrideMaterial] = keep;
    const bm = this.blur.material;
    const px = 1 / RES;
    bm.uniforms.src.value = this.rtA.texture;
    bm.uniforms.dir.value.set(px, 0);
    renderer.setRenderTarget(this.rtB);
    this.blur.render(renderer);
    bm.uniforms.src.value = this.rtB.texture;
    bm.uniforms.dir.value.set(0, px);
    renderer.setRenderTarget(this.rtA);
    this.blur.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    this.sheet.visible = true;
    const u = this.mat.uniforms;
    u.mask.value = this.rtA.texture;
    u.camPos.value.copy(cam.position);
    u.right.value.setFromMatrixColumn(cam.matrixWorld, 0);
    u.up.value.setFromMatrixColumn(cam.matrixWorld, 1);
    u.halfSize.value = r;
    // The ground sheet: where the shadows can fall (the course's footprint
    // pushed away from the sun by how far its tallest things throw them),
    // following the ground's bumps.
    const reach = (this.box.max.y - this.box.min.y + 2) / Math.max(0.15, towards.y);
    const h = Math.hypot(towards.x, towards.z) || 1;
    const ox = (-towards.x / h) * reach * 0.5;
    const oz = (-towards.z / h) * reach * 0.5;
    const half = Math.max(this.box.max.x - this.box.min.x, this.box.max.z - this.box.min.z) / 2 + reach * 0.5 + 2;
    this.#sheet(c.x + ox, c.z + oz, half);
  }

  #sheet(cx, cz, half) {
    const n = GRID;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    let k = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = cx - half + (2 * half * i) / n;
        const z = cz - half + (2 * half * j) / n;
        pos[k++] = x;
        pos[k++] = this.ground.heightAt(x, z) + 0.05;
        pos[k++] = z;
      }
    }
    const idx = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.sheet.geometry.dispose();
    this.sheet.geometry = g;
  }

  dispose() {
    this.scene.remove(this.sheet);
    this.sheet.geometry.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.mat.dispose();
    this.blur.dispose();
  }
}

/** A soft round shadow's material (one per balloon: each has its own darkness and softness). */
export function blobMaterial() {
  return new ShaderMaterial({
    uniforms: { opacity: { value: 0 }, soft: { value: 0.3 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float opacity; uniform float soft; varying vec2 vUv;
      void main() {
        float d = length(vUv * 2.0 - 1.0);
        float a = opacity * (1.0 - smoothstep(1.0 - soft, 1.0, d));
        if (a < 0.003) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

const SUN_TAN = Math.tan((0.53 * Math.PI) / 180) * 2.2; // (as the aeroplane's: the sun's a disc, softened a little)

/**
 * Put a ball's blob shadow (a flat mesh, made with blobMaterial) where the
 * sun casts it: on the ground along the sun from `pos`, `radius` the
 * ball's, stretched along the sun's direction when it's low.
 */
export function placeBlob(blob, pos, radius, ground, towards, strength) {
  if (!towards || strength < 0.02 || towards.y < 0.05) {
    blob.visible = false;
    return;
  }
  const gy = ground.heightAt(pos.x, pos.z);
  const height = Math.max(0, pos.y - gy);
  const t = height / towards.y;
  const x = pos.x - towards.x * t;
  const z = pos.z - towards.z * t;
  const blur = height * SUN_TAN;
  const d = 2 * radius + blur;
  blob.position.set(x, ground.heightAt(x, z) + 0.04, z);
  blob.rotation.set(0, -Math.atan2(towards.z, towards.x), 0);
  blob.scale.set(d / Math.max(0.25, towards.y), 1, d);
  const u = blob.material.uniforms;
  u.opacity.value = strength * 0.85 * Math.min(1, (2 * radius) / d) ** 2;
  u.soft.value = Math.min(0.95, 0.15 + blur / d);
  blob.visible = u.opacity.value > 0.01;
}

/** A flat unit square lying on the ground (x along, z across), for a blob shadow. */
export function blobGeometry() {
  return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}
