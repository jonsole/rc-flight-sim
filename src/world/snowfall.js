// Falling snow: flakes in a box around the camera, falling at about 1 m/s,
// carried by the wind and fluttering. Each flake's place is worked out on
// the GPU from where it started and how far the air has carried the snow
// (drift, kept here as the wind changes), wrapped round the box, so the
// box follows the camera and the flakes never run out.
//
// Further than the box, falling snow is the air thickening and turning
// grey-white (src/world/volfog.js, src/world/snow.js snowVisibility).
import { BufferGeometry, BufferAttribute, Points, ShaderMaterial, Vector3, Color, NormalBlending } from 'three';

const BOX = 36; // m across, and tall (further away, falling snow is the thickened air)
const FALL = 1.1; // m/s, a snowflake's speed through the air

export class Snowfall {
  /** @param {number} count  flakes in the box at heavy snowfall */
  constructor(count = 30000) {
    this.count = count;
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4] = Math.random();
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random(); // size, flutter phase, which flakes show in light snow
    }
    const geo = new BufferGeometry();
    // (Positions are made in the shader; three.js wants a position attribute.)
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('seed', new BufferAttribute(seed, 4));
    this.drift = new Vector3();
    this.uniforms = {
      uDrift: { value: this.drift },
      uTime: { value: 0 },
      uBox: { value: BOX },
      uAmount: { value: 0 },
      uScale: { value: 800 }, // pixels per metre at 1 m (from the camera's FOV and the screen height)
      uColor: { value: new Color(1, 1, 1) },
    };
    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform vec3 uDrift;
        uniform float uTime;
        uniform float uBox;
        uniform float uAmount;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          // Light snow: fewer flakes (each flake has its threshold).
          if (seed.w > uAmount) { vAlpha = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          // Each flake falls a little faster or slower, and flutters.
          vec3 p = seed.xyz * uBox + uDrift * vec3(1.0, 0.8 + 0.4 * seed.w, 1.0);
          float ph = seed.w * 61.0;
          p.x += 0.35 * sin(uTime * (1.1 + seed.y) + ph);
          p.z += 0.35 * cos(uTime * (0.9 + seed.x) + ph * 1.3);
          // Wrapped round a box centred on the camera.
          vec3 rel = mod(p - cameraPosition + 0.5 * uBox, uBox) - 0.5 * uBox;
          vec4 mv = viewMatrix * vec4(cameraPosition + rel, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 0.05);
          // Flakes drawn 2-4 cm across: bigger than they are (a few mm,
          // clumping to a centimetre or two), as the eye picks out moving
          // flakes that a still picture loses. At least 1.5 pixels (then
          // fainter).
          float size = (0.02 + 0.02 * fract(seed.w * 13.7)) * uScale / d;
          gl_PointSize = clamp(size, 1.5, 40.0);
          // Fade at the box's edge (no flakes popping in) and right by the lens.
          float edge = 1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, length(rel));
          vAlpha = edge * smoothstep(0.15, 0.6, d) * min(1.0, size * size / 4.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          float a = (1.0 - smoothstep(0.4, 1.0, r)) * vAlpha * 0.9;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new Points(geo, mat);
    this.mesh.frustumCulled = false; // (it's always around the camera)
    this.mesh.renderOrder = 10; // after the scenery
    this.mesh.visible = false;
  }

  /**
   * Every frame.
   * @param {number} dt
   * @param {import('three').Vector3} wind  the wind (world, m/s)
   * @param {number} amount  0 none .. 1 heavy
   * @param {import('three').PerspectiveCamera} camera
   * @param {number} screenH  drawing buffer height (pixels)
   */
  update(dt, wind, amount, camera, screenH) {
    this.mesh.visible = amount > 0.005;
    this.uniforms.uAmount.value = amount;
    if (!this.mesh.visible) return;
    this.drift.x += wind.x * dt;
    this.drift.y += (wind.y - FALL) * dt;
    this.drift.z += wind.z * dt;
    // (Kept small: float precision on the GPU.)
    for (const k of ['x', 'y', 'z']) this.drift[k] %= BOX * 100;
    this.uniforms.uTime.value = (this.uniforms.uTime.value + dt) % 1000;
    this.uniforms.uScale.value = screenH / 2 / Math.tan((camera.fov * Math.PI) / 360);
  }

  /** Flake colour: lit by the sky (and sun) of the moment. */
  setLight(color) {
    this.uniforms.uColor.value.copy(color);
  }
}
