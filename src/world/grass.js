// Real grass close to the camera: thin, tapered, curved blades, a dozen or
// so per patch, one patch per cell of a grid that follows the camera, so
// only one draw call and no per-frame CPU work. Each tuft's place, size,
// turn and colour come from a hash of its world cell, so nothing jumps as
// the grid moves; tufts shrink away towards the edge of the patch, where
// the ground texture takes over. Blade height follows the same zones as the
// ground: short on the runway and mown areas, longer field grass, long rough.
// Grass only grows on the flat flying field (the hills are left to the
// ground texture).
import {
  Mesh, MeshLambertMaterial, InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute,
  Vector2, Vector3, DoubleSide,
} from 'three';
import { RUNWAY } from '../sim/terrain.js';
import { cloudUniforms } from './clouds.js';

const FIELD = { x: 0, z: -40, r: 250 };

/**
 * One patch of grass for a grid cell: `count` thin, tapered, slightly bent
 * blades scattered over the cell, unit height. Attributes: position,
 * aBlade (per-blade random 0..1) and aT (0 at the root .. 1 at the tip).
 */
function patchGeometry(count, cell, radius) {
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos = []; // root position + width offset (m, not scaled)
  const leanA = []; // lean of the blade at this point, per metre of height
  const blade = [];
  const tt = [];
  const idx = [];
  const SEG = 3;
  for (let b = 0; b < count; b++) {
    const x0 = (rnd() - 0.5) * cell;
    const z0 = (rnd() - 0.5) * cell;
    const ang = rnd() * Math.PI * 2; // which way the blade faces
    const bend = 0.15 + rnd() * 0.35; // how far the tip leans over
    const hgt = 0.6 + rnd() * 0.4;
    const w = 0.0035 + rnd() * 0.002; // half-width at the root (m)
    const r = rnd();
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const base = pos.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      const y = t * hgt;
      const lean = bend * t * t * hgt; // curves over towards the tip
      const half = w * (1 - t * 0.85);
      // Width across the blade (perpendicular to its lean direction); the
      // lean is kept separately so it scales with the blade's height.
      pos.push(x0 - sa * half, y, z0 + ca * half, x0 + sa * half, y, z0 - ca * half);
      leanA.push(ca * lean, sa * lean, ca * lean, sa * lean);
      blade.push(r, r);
      tt.push(t, t);
    }
    // Pointed tip.
    pos.push(x0, hgt * 1.04, z0);
    leanA.push(ca * bend * hgt * 1.05, sa * bend * hgt * 1.05);
    blade.push(r);
    tt.push(1);
    for (let k = 0; k < SEG; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const last = base + SEG * 2;
    idx.push(last, last + 1, base + (SEG + 1) * 2);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aBlade', new BufferAttribute(new Float32Array(blade), 1));
  g.setAttribute('aLean', new BufferAttribute(new Float32Array(leanA), 2));
  g.setAttribute('aT', new BufferAttribute(new Float32Array(tt), 1));
  g.setIndex(idx);
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
  constructor({ cell = 0.18, radius = 13, blades = 14 } = {}) {
    this.cell = cell;
    this.radius = radius;
    const geo = patchGeometry(blades, cell, radius);
    this.n = geo.userData.n;
    this.uniforms = {
      uOrigin: { value: new Vector2() },
      uCam: { value: new Vector3() },
      uRadius: { value: radius },
      uCell: { value: cell },
      uTime: { value: 0 },
      uWind: { value: new Vector2() },
    };
    // Lawn green (matches the ground texture), shaded per blade in the shader.
    const mat = new MeshLambertMaterial({ color: '#7fa24a', side: DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, cloudUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `#include <common>
          attribute vec2 iOffset;
          attribute float aBlade;
          attribute float aT;
          attribute vec2 aLean;
          varying float vT;
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
          // Lawn heights: field 7-8 cm, mown 5 cm, runway 3 cm, rough 18 cm.
          float hgt = mix(0.075, 0.05, mown);
          hgt = mix(hgt, 0.03, onRunway);
          hgt = mix(hgt, 0.18, rough);
          // Bare: the pilot's gravel pad, car park and beyond the flat field.
          float bare = 1.0 - step(0.01, rectDist(at, vec2(0.0, 0.5), vec2(3.0, 2.0)));
          bare = max(bare, 1.0 - step(0.01, rectDist(at, vec2(-38.5, 31.0), vec2(7.5, 9.0))));
          bare = max(bare, step(${FIELD.r.toFixed(1)}, rField));
          // Shrink away towards the edge of the patch.
          float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius * 0.95, dist);
          float s = hgt * (0.75 + 0.5 * h3) * fade * (1.0 - bare);
          vec3 p0 = position;
          float ang = h4 * 6.2832;
          float ca = cos(ang), sa = sin(ang);
          // Blade sideways spread scales with height (the lean); width stays thin.
          vec2 q = p0.xz + aLean * s;
          vec2 xz = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
          float y = p0.y * s;
          // Sway in the wind, more at the tips.
          float sway = sin(uTime * 2.2 + at.x * 0.6 + at.y * 0.4) * 0.5 + 0.5;
          xz += uWind * (0.004 + 0.006 * sway) * aT * aT;
          vec3 transformed = vec3(cellW.x + xz.x, y, cellW.y + xz.y);
          vTint = fract(aBlade + h1);
          vT = aT;
          vCloudWorld = transformed;`)
        .replace('#include <project_vertex>', /* glsl */ `
          vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(transformed, 1.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `#include <common>
          varying float vTint;
          varying float vT;
          varying vec3 vCloudWorld;
          uniform vec2 cloudOffset; uniform float cloudCover; uniform vec3 cloudSunDir; uniform float cloudShadowStrength;
          float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y); }
          float cFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * cNoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s; }
          float cloudDensity(vec2 xz) { vec2 p = (xz + cloudOffset) / 700.0; float n = cFbm(p) * 0.8 + cFbm(p * 3.7 + 4.0) * 0.2;
            float t = mix(0.66, 0.30, cloudCover); return smoothstep(t, t + 0.09, n); }`)
        .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
          // Darker towards the root (shaded by the other blades), lighter,
          // slightly yellower tips, and a little variety blade to blade.
          diffuseColor.rgb *= mix(0.78, 1.15, vT) * (0.9 + 0.2 * vTint);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.04, 0.85), vT * vTint);`)
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
