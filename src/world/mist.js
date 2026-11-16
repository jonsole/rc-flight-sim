// Mist, fog and low cloud: spring and autumn mornings, or as set (Menu ->
// Weather). Mist thickens the haze (the scene fades into pale grey with
// distance, the sky and high clouds with it); low cloud is a broken layer of
// grey cloud a few tens of metres up that you can fly into (everything
// goes grey-white inside) and out of, above or below.
//
// The low cloud's pattern comes from noise worked out the same way on the
// GPU (drawing it) and here (to know when you're inside it): a hash with no
// sine (whose precision differs on GPUs), its steps in 32-bit floats.
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector2, DoubleSide, Group } from 'three';

const SIZE = 6000; // m across
const f = Math.fround;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fract = (x) => f(x - Math.floor(x));

/** 2D hash, as the shader's (32-bit floats, step by step). */
function hash(x, y) {
  let a = fract(f(x * f(0.1031)));
  let b = fract(f(y * f(0.1031)));
  let c = a; // p3 = fract(vec3(p.xyx) * .1031)
  const d = f(f(f(a * f(b + f(33.33))) + f(b * f(c + f(33.33)))) + f(c * f(a + f(33.33))));
  a = f(a + d);
  b = f(b + d);
  c = f(c + d);
  return fract(f(f(a + b) * c));
}
function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y) {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < 4; i++) {
    s += a * vnoise(x, y);
    x = x * 2.1 + 5.3;
    y = y * 2.1 + 1.7;
    a *= 0.5;
  }
  return s;
}

const NOISE_GLSL = /* glsl */ `
float lcHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float lcNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = lcHash(i), b = lcHash(i + vec2(1.0, 0.0)), c = lcHash(i + vec2(0.0, 1.0)), d = lcHash(i + vec2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float lcFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * lcNoise(p); p = p * 2.1 + vec2(5.3, 1.7); a *= 0.5; }
  return s;
}
// Low cloud cover (0 clear .. 1 cloud) at world (x, z).
float lcCover(vec2 xz) {
  float n = lcFbm((xz + lcOffset) / 260.0);
  float t = mix(0.7, 0.16, lcAmount);
  return smoothstep(t, t + 0.12, n);
}`;

/** The weather for a day and time: mist (0-1) and low cloud ({ amount, base, top }). */
export function weatherFor(settings, day, hours) {
  // Spring (March to May) and autumn (September to November, foggiest).
  const spring = smooth(60, 85, day) * (1 - smooth(130, 155, day));
  const autumn = smooth(245, 275, day) * (1 - smooth(320, 345, day));
  const season = Math.max(spring * 0.7, autumn);
  const r = (k) => fract(Math.sin(day * 12.9898 + k * 78.233) * 43758.5453);
  // Mist: some days, mostly in the morning, burning off by late morning
  // (and coming back a little in the evening).
  const morning = 1 - smooth(8.5, 11.5, hours) + 0.35 * smooth(18, 21.5, hours);
  let mist = 0;
  if (settings.mist === 'light') mist = 0.55; // (about 600 m)
  else if (settings.mist === 'thick') mist = 1;
  else if (settings.mist !== 'off' && r(1) < 0.55 * season) mist = Math.min(1, morning) * (0.3 + 0.7 * r(2));
  // Low cloud: some days, through the day, lifting a little by afternoon.
  let amount = 0;
  if (settings.lowCloud === 'broken') amount = 0.5;
  else if (settings.lowCloud === 'overcast') amount = 0.95;
  else if (settings.lowCloud !== 'off' && r(3) < 0.45 * season) amount = 0.35 + 0.55 * r(4);
  const base = 45 + r(5) * 45 + smooth(10, 15, hours) * 20;
  return { mist, lowCloud: { amount, base, top: base + 30 + r(6) * 25 } };
}

export class LowCloud {
  constructor() {
    this.offset = new Vector2();
    this.amount = 0;
    this.base = 60;
    this.top = 100;
    this.uniforms = {
      lcOffset: { value: this.offset },
      lcAmount: { value: 0 },
      lcLight: { value: new Color(1, 1, 1) },
      lcShade: { value: new Color(0.6, 0.63, 0.68) },
      lcHaze: { value: new Color('#c3d5e8') },
      lcFog: { value: 0 },
    };
    const make = (top) => {
      const mat = new ShaderMaterial({
        uniforms: { ...this.uniforms, lcTop: { value: top ? 1 : 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec2 lcOffset; uniform float lcAmount; uniform vec3 lcLight; uniform vec3 lcShade;
          uniform vec3 lcHaze; uniform float lcFog; uniform float lcTop;
          varying vec3 vWorld;
          ${NOISE_GLSL}
          void main() {
            float d = lcCover(vWorld.xz);
            if (d < 0.01) discard;
            // Its top in the sun, its underside grey, darker where thick.
            vec3 c = lcTop > 0.5 ? lcLight : mix(lcLight * 0.85, lcShade, d);
            float dist = length(vWorld - cameraPosition);
            // Into the haze (and mist) with distance.
            float haze = smoothstep(200.0, 2800.0, dist);
            c = mix(c, lcHaze, max(haze * 0.8, lcFog));
            float a = min(1.0, d * 1.4) * (1.0 - smoothstep(2200.0, 2900.0, dist));
            gl_FragColor = vec4(c, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        fog: false,
      });
      const geo = new PlaneGeometry(SIZE, SIZE, 1, 1);
      geo.rotateX(-Math.PI / 2);
      const m = new Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = -1;
      return m;
    };
    this.under = make(false);
    this.over = make(true);
    this.group = new Group();
    this.group.add(this.under, this.over);
    this.group.visible = false;
  }

  /** Cover (0-1) at world (x, z), as drawn. */
  coverAt(x, z) {
    const n = fbm((x + this.offset.x) / 260, (z + this.offset.y) / 260);
    const t = 0.7 + (0.16 - 0.7) * this.amount;
    return smooth(t, t + 0.12, n);
  }

  /** How far into the cloud a point is (0 clear .. 1 inside). */
  inside(p) {
    if (this.amount <= 0) return 0;
    const inBand = smooth(this.base - 6, this.base + 4, p.y) * (1 - smooth(this.top - 4, this.top + 6, p.y));
    if (inBand <= 0) return 0;
    return inBand * smooth(0.3, 0.7, this.coverAt(p.x, p.z));
  }

  set(amount, base, top) {
    this.amount = amount;
    this.base = base;
    this.top = top;
    this.uniforms.lcAmount.value = amount;
    this.group.visible = amount > 0.01;
  }

  /** Follow the camera (the layer is finite) and drift with the wind. */
  update(dt, wind, cam) {
    this.offset.x -= wind.x * 1.2 * dt;
    this.offset.y -= wind.z * 1.2 * dt;
    this.under.position.set(cam.x, this.base, cam.z);
    this.over.position.set(cam.x, this.top, cam.z);
  }
}
