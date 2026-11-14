// Real grass close to the camera: tens of thousands of small tufts (two
// crossed, alpha-cut quads of blades) on a grid that follows the camera, so
// only one draw call and no per-frame CPU work. Each tuft's place, size,
// turn and colour come from a hash of its world cell, so nothing jumps as
// the grid moves; tufts shrink away towards the edge of the patch, where
// the ground texture takes over. Blade height follows the same zones as the
// ground: short on the runway and mown areas, longer field grass, long rough.
// Grass only grows on the flat flying field (the hills are left to the
// ground texture).
import {
  Mesh, MeshLambertMaterial, InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute,
  CanvasTexture, SRGBColorSpace, Vector2, Vector3, DoubleSide,
} from 'three';
import { RUNWAY } from '../sim/terrain.js';
import { cloudUniforms } from './clouds.js';

const FIELD = { x: 0, z: -40, r: 250 };

function bladeTexture() {
  const W = 128;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Tapered blades from the bottom edge, leaning a little, darker at the root.
  for (let i = 0; i < 48; i++) {
    const x0 = 4 + rnd() * (W - 8);
    const h = H * (0.4 + rnd() * 0.6);
    const lean = (rnd() - 0.5) * 34;
    const w = 2 + rnd() * 2.5;
    const grad = g.createLinearGradient(0, H, 0, H - h);
    // Same greens as the ground, a little darker at the root, lighter tips.
    const l = 30 + rnd() * 14;
    grad.addColorStop(0, `hsl(${84 + rnd() * 12}, 42%, ${l * 0.8}%)`);
    grad.addColorStop(1, `hsl(${74 + rnd() * 22}, ${42 + rnd() * 16}%, ${l + 14}%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - w, H);
    g.quadraticCurveTo(x0 - w * 0.6 + lean * 0.4, H - h * 0.6, x0 + lean, H - h);
    g.quadraticCurveTo(x0 + w * 0.6 + lean * 0.4, H - h * 0.6, x0 + w, H);
    g.closePath();
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Two crossed quads, 1 m tall and 0.35 m wide, standing on y = 0. */
function tuftGeometry(cell, radius) {
  const quads = [0, Math.PI / 3, (2 * Math.PI) / 3];
  const pos = [];
  const uv = [];
  const idx = [];
  quads.forEach((a, q) => {
    const cx = Math.cos(a) * 0.175;
    const cz = Math.sin(a) * 0.175;
    const b = q * 4;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  // One instance per grid cell in a square around the camera.
  const n = Math.ceil((radius * 2) / cell);
  const offs = new Float32Array(n * n * 2);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      offs[k++] = i * cell;
      offs[k++] = j * cell;
    }
  }
  g.setAttribute('iOffset', new InstancedBufferAttribute(offs, 2));
  g.instanceCount = n * n;
  g.userData.n = n;
  return g;
}

export class GrassField {
  /**
   * @param {object} opts { cell (m between tufts), radius (m) }
   */
  constructor({ cell = 0.2, radius = 22 } = {}) {
    this.cell = cell;
    this.radius = radius;
    const geo = tuftGeometry(cell, radius);
    this.n = geo.userData.n;
    this.uniforms = {
      uOrigin: { value: new Vector2() },
      uCam: { value: new Vector3() },
      uRadius: { value: radius },
      uCell: { value: cell },
      uTime: { value: 0 },
      uWind: { value: new Vector2() },
    };
    const mat = new MeshLambertMaterial({ map: bladeTexture(), alphaTest: 0.5, side: DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, cloudUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `#include <common>
          attribute vec2 iOffset;
          uniform vec2 uOrigin; uniform vec3 uCam; uniform float uRadius; uniform float uCell; uniform float uTime; uniform vec2 uWind;
          varying float vTint;
          varying vec3 vCloudWorld;
          float gH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float rectDist(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return length(max(d, 0.0)); }`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', /* glsl */ `
          vec2 cellW = uOrigin + iOffset;
          vec2 key = floor(cellW / uCell + 0.5);
          float h1 = gH(key), h2 = gH(key + 17.0), h3 = gH(key + 31.0), h4 = gH(key + 47.0);
          vec2 at = cellW + (vec2(h1, h2) - 0.5) * uCell;
          float dist = length(at - uCam.xz);
          // Height by zone, like the ground: mown near the runway and pits.
          float rField = length(at - vec2(${FIELD.x.toFixed(1)}, ${FIELD.z.toFixed(1)}));
          float dRun = rectDist(at, vec2(${RUNWAY.x.toFixed(1)}, ${RUNWAY.z.toFixed(1)}), vec2(${(RUNWAY.length / 2).toFixed(1)}, ${(RUNWAY.width / 2).toFixed(1)}));
          float dPits = rectDist(at, vec2(-8.0, 12.0), vec2(40.0, 16.0));
          float onRunway = 1.0 - step(0.01, dRun);
          float mown = 1.0 - smoothstep(18.0, 26.0, min(dRun, dPits));
          float rough = smoothstep(${(FIELD.r - 30).toFixed(1)}, ${(FIELD.r - 5).toFixed(1)}, rField);
          float hgt = mix(0.13, 0.07, mown);
          hgt = mix(hgt, 0.045, onRunway);
          hgt = mix(hgt, 0.26, rough);
          // Bare: the pilot's gravel pad, car park and beyond the flat field.
          float bare = 1.0 - step(0.01, rectDist(at, vec2(0.0, 0.5), vec2(3.0, 2.0)));
          bare = max(bare, 1.0 - step(0.01, rectDist(at, vec2(-38.5, 31.0), vec2(7.5, 9.0))));
          bare = max(bare, step(${FIELD.r.toFixed(1)}, rField));
          // Shrink away towards the edge of the patch.
          float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius * 0.95, dist);
          float s = hgt * (0.6 + 0.8 * h3) * fade * (1.0 - bare);
          vec3 p0 = position;
          float ang = h4 * 6.2832;
          float ca = cos(ang), sa = sin(ang);
          vec2 xz = vec2(p0.x * ca - p0.z * sa, p0.x * sa + p0.z * ca) * (0.55 + hgt * 2.0);
          float y = p0.y * s;
          // Sway in the wind, more at the tips.
          float sway = sin(uTime * 2.2 + at.x * 0.6 + at.y * 0.4) * 0.5 + 0.5;
          xz += uWind * (0.012 + 0.02 * sway) * p0.y * p0.y * s * 4.0;
          vec3 transformed = vec3(at.x + xz.x, y, at.y + xz.y);
          vTint = h1;
          vCloudWorld = transformed;`)
        .replace('#include <project_vertex>', /* glsl */ `
          vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(transformed, 1.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `#include <common>
          varying float vTint;
          varying vec3 vCloudWorld;
          uniform vec2 cloudOffset; uniform float cloudCover; uniform vec3 cloudSunDir; uniform float cloudShadowStrength;
          float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y); }
          float cFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * cNoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s; }
          float cloudDensity(vec2 xz) { vec2 p = (xz + cloudOffset) / 700.0; float n = cFbm(p) * 0.8 + cFbm(p * 3.7 + 4.0) * 0.2;
            float t = mix(0.66, 0.30, cloudCover); return smoothstep(t, t + 0.09, n); }`)
        .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
          diffuseColor.rgb *= 0.85 + 0.3 * vTint;`)
        .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
          {
            float up = max(cloudSunDir.y, 0.08);
            vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (700.0 - vCloudWorld.y);
            float shade = 1.0 - cloudShadowStrength * cloudDensity(at);
            reflectedLight.directDiffuse *= shade;
          }`);
    };
    mat.customProgramCacheKey = () => 'grassField';
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 0;
  }

  /** Follow the camera; sway with the wind (world m/s). */
  update(camera, t, wind) {
    const u = this.uniforms;
    const c = camera.position;
    // Only near the ground: from high up the tufts are too small to see.
    this.mesh.visible = c.y < 40;
    const half = (this.n * this.cell) / 2;
    u.uOrigin.value.set(Math.floor(c.x / this.cell) * this.cell - half, Math.floor(c.z / this.cell) * this.cell - half);
    u.uCam.value.copy(c);
    u.uTime.value = t;
    u.uWind.value.set(wind.x, wind.z);
  }
}
