// Shadows for everything, near and far, with physically soft edges.
//
// Cascaded shadow maps (three's CSM add-on): several shadow maps along the
// view, sharp close to the camera and coarser further out, so the
// aeroplane, trees, buildings and cars all cast real shadows at any
// distance.
//
// Soft shadows: the sun is a disc about half a degree across, so a shadow
// blurs more the further the caster is above the surface it falls on (a
// model on the runway has a crisp shadow, at 30 m it is ~30 cm soft, at
// 100 m it has nearly gone). Each shadowed point first looks around it in
// the shadow map for blockers, takes their average height above it, and
// blurs by that height times the sun's angular size (PCSS).
import { ShaderChunk, Vector3, Material } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

const SUN_TAN = Math.tan((0.53 * Math.PI) / 180); // sun's angular diameter
const LIGHT_NEAR = 1;
const LIGHT_FAR = 1200;

const SOFT_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  // shadowRadius carries this cascade's width in metres (see shadows.js).
  #define PCSS_BLOCKER 16
  #define PCSS_SAMPLES 32
  vec2 pcssDisk(int i, int count, float rot) {
    // Golden-angle spiral, rotated per pixel to hide banding.
    float r = sqrt((float(i) + 0.5) / float(count));
    float a = float(i) * 2.39996323 + rot;
    return vec2(cos(a), sin(a)) * r;
  }
  // Depth comparison blended across the four nearest texels: smooth
  // gradients instead of a pixel pattern.
  float pcssCompare(sampler2D m, vec2 uv, float z, float texel) {
    vec2 g = uv / texel - 0.5;
    vec2 f = fract(g);
    vec2 b = (floor(g) + 0.5) * texel;
    float a = step(z, unpackRGBAToDepth(texture2D(m, b)));
    float c = step(z, unpackRGBAToDepth(texture2D(m, b + vec2(texel, 0.0))));
    float d = step(z, unpackRGBAToDepth(texture2D(m, b + vec2(0.0, texel))));
    float e = step(z, unpackRGBAToDepth(texture2D(m, b + vec2(texel))));
    return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
  }
  float getShadowSoft(sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float frustumWidth, vec4 shadowCoord) {
    shadowCoord.xyz /= shadowCoord.w;
    shadowCoord.z += shadowBias;
    bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0 && shadowCoord.z <= 1.0;
    if (!inFrustum) return 1.0;
    float texel = 1.0 / shadowMapSize.x;
    // A fixed sample pattern (no per-pixel noise, which shows as grain).
    float rot = 0.0;
    // 1. Blockers within ~1.2 m (or a few texels in coarse cascades).
    float searchUV = max(${(1.2).toFixed(2)} / frustumWidth, 3.0 * texel);
    float zSum = 0.0;
    float n = 0.0;
    for (int i = 0; i < PCSS_BLOCKER; i++) {
      float d = unpackRGBAToDepth(texture2D(shadowMap, shadowCoord.xy + pcssDisk(i, PCSS_BLOCKER, rot) * searchUV));
      if (d < shadowCoord.z) { zSum += d; n += 1.0; }
    }
    if (n < 0.5) return 1.0;
    // 2. Penumbra from the gap between the blockers and this point.
    float gap = (shadowCoord.z - zSum / n) * ${(LIGHT_FAR - LIGHT_NEAR).toFixed(1)};
    float penUV = max(gap * ${SUN_TAN.toFixed(5)} / frustumWidth, 1.5 * texel);
    penUV = min(penUV, searchUV * 1.5);
    // 3. Filter over the penumbra.
    float lit = 0.0;
    for (int i = 0; i < PCSS_SAMPLES; i++) {
      lit += pcssCompare(shadowMap, shadowCoord.xy + pcssDisk(i, PCSS_SAMPLES, rot + 1.7) * penUV, shadowCoord.z, texel);
    }
    lit /= float(PCSS_SAMPLES);
    return mix(1.0, lit, shadowIntensity);
  }
#endif
`;

let patched = false;
function patchChunks() {
  if (patched) return;
  patched = true;
  ShaderChunk.shadowmap_pars_fragment += SOFT_SHADOW;
  ShaderChunk.lights_fragment_begin = ShaderChunk.lights_fragment_begin.replaceAll('getShadow( directionalShadowMap', 'getShadowSoft( directionalShadowMap');
}

export class Shadows {
  /**
   * @param {import('three').Scene} scene
   * @param {import('three').PerspectiveCamera} camera
   * @param {{ mapSize?: number, maxFar?: number }} opts
   */
  constructor(scene, camera, { mapSize = 2048, maxFar = 600 } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: 4,
      maxFar,
      // Split distances (m): fine detail close to the camera, where shadows
      // are looked at most; a zoomed-in camera narrows them further.
      mode: 'custom',
      customSplitsCallback: (n, near, far, breaks) => {
        for (const d of [12, 45, 160]) breaks.push(Math.min(d, far) / far);
        breaks.push(1);
      },
      shadowMapSize: mapSize,
      lightDirection: new Vector3(-1, -1, -1).normalize(),
      lightIntensity: 2.8,
      lightNear: LIGHT_NEAR,
      lightFar: LIGHT_FAR,
      lightMargin: 250, // catch casters (hills, trees) up-sun of the view
      shadowBias: -0.00004,
    });
    for (const l of this.csm.lights) l.shadow.normalBias = 0.03;
    patchChunks(); // after CSM has installed its light chunks
    this.done = new WeakSet();
    this.fov = camera.fov;
    this.aspect = camera.aspect;
    this.#widths();
  }

  /** Pass each cascade's width (m) to the shader through shadow.radius. */
  #widths() {
    for (const l of this.csm.lights) {
      const c = l.shadow.camera;
      l.shadow.radius = c.right - c.left;
    }
  }

  /** Register the lit materials under an object (call before it is drawn). */
  prepare(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [o.material].flat()) {
        if (!m || this.done.has(m) || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
        this.done.add(m);
        const prev = m.onBeforeCompile;
        this.csm.setupMaterial(m);
        const hook = m.onBeforeCompile;
        m.onBeforeCompile = (shader, renderer) => {
          hook(shader, renderer);
          if (prev && prev !== Material.prototype.onBeforeCompile) prev.call(m, shader, renderer);
        };
        m.needsUpdate = true;
      }
    });
  }

  /** The light of the moment: direction towards it, strength, colour. */
  setLight(towards, intensity, color) {
    this.csm.lightDirection.copy(towards).negate().normalize();
    for (const l of this.csm.lights) {
      l.intensity = intensity;
      l.color.copy(color);
      l.castShadow = intensity > 0.02;
    }
  }

  /** Every frame, after the camera has moved. */
  update() {
    const cam = this.camera;
    if (cam.fov !== this.fov || cam.aspect !== this.aspect) {
      this.fov = cam.fov;
      this.aspect = cam.aspect;
      this.csm.updateFrustums();
      this.#widths();
    }
    this.csm.update();
  }
}
