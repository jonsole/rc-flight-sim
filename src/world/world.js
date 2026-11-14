// The flying field: sky, lighting, terrain, runway, trees and props.
import {
  Scene, Color, FogExp2, HemisphereLight, Points, PointsMaterial, BufferGeometry, Sprite, SpriteMaterial, DirectionalLight, Mesh, PlaneGeometry, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, CylinderGeometry, IcosahedronGeometry,
  Object3D, BoxGeometry, ConeGeometry, Group, Vector3, MathUtils, DoubleSide, Float32BufferAttribute,
  MeshBasicMaterial, ShaderMaterial, SphereGeometry, BackSide,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, gridHeight, TERRAIN_SIZE, TERRAIN_SEGMENTS, RUNWAY } from '../sim/terrain.js';
import { sunPosition, moonPosition } from './sun.js';

const smooth = (e0, e1, x) => {
  const t = MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Direction (unit vector, +y up) for an elevation/azimuth in degrees (azimuth 0 = north/-z, 90 = east/+x). */
function skyDir(elevationDeg, azimuthDeg, out) {
  const el = MathUtils.degToRad(elevationDeg);
  const az = MathUtils.degToRad(azimuthDeg);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

// Horizon haze colours by sun elevation (degrees): night, deep twilight,
// sunset glow, golden hour, day.
const HAZE = [
  [-12, new Color('#070b16')],
  [-5, new Color('#28334f')],
  [0, new Color('#d39a72')],
  [8, new Color('#e3c7a4')],
  [20, new Color('#c3d5e8')],
];
function hazeColour(el, out) {
  if (el <= HAZE[0][0]) return out.copy(HAZE[0][1]);
  for (let i = 1; i < HAZE.length; i++) {
    if (el <= HAZE[i][0]) {
      const [e0, c0] = HAZE[i - 1];
      const [e1, c1] = HAZE[i];
      return out.copy(c0).lerp(c1, (el - e0) / (e1 - e0));
    }
  }
  return out.copy(HAZE[HAZE.length - 1][1]);
}

const TWILIGHT_ZENITH = new Color('#2a4069');
const NIGHT_ZENITH = new Color('#02050d');
const TWILIGHT_HORIZON = new Color('#8b6f86');
const NIGHT_HORIZON = new Color('#0c1528');
const TWILIGHT_GLOW = new Color('#e08a4a');

/** A gradient dome for twilight and night (the day sky model only does day). */
function nightDome() {
  const m = new ShaderMaterial({
    uniforms: {
      zenith: { value: new Color('#02050d') },
      horizon: { value: new Color('#0c1528') },
      glow: { value: new Color('#3a2a3a') }, // last light on the horizon towards the sun
      sunDir: { value: new Vector3(0, -1, 0) },
      opacity: { value: 0 },
    },
    vertexShader: `varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sunDir; uniform float opacity;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, zenith, pow(h, 0.45));
        // Faint glow low in the sky where the sun went down.
        vec2 a = normalize(vDir.xz + 1e-5);
        vec2 b = normalize(sunDir.xz + 1e-5);
        float toward = max(0.0, dot(a, b));
        c += glow * pow(toward, 3.0) * exp(-h * 8.0) * clamp(1.0 + sunDir.y * 6.0, 0.0, 1.0);
        gl_FragColor = vec4(c, opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const dome = new Mesh(new SphereGeometry(9800, 32, 16), m);
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  return dome;
}

function starField() {
  const n = 2500;
  const pos = [];
  const col = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    // Uniform on the upper sky (and a little below the horizon).
    const y = rnd() * 1.1 - 0.1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    pos.push(Math.cos(a) * r * 9000, y * 9000, Math.sin(a) * r * 9000);
    // Mostly faint stars, a few bright ones.
    const b = 0.18 + rnd() ** 6 * 0.82;
    const warm = rnd();
    col.push(b, b * (0.92 + warm * 0.08), b * (0.85 + (1 - warm) * 0.15));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  const m = new PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const pts = new Points(g, m);
  pts.renderOrder = -1;
  pts.frustumCulled = false;
  return pts;
}

function moonSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const glow = g.createRadialGradient(64, 64, 18, 64, 64, 64);
  glow.addColorStop(0, 'rgba(220,230,255,0.35)');
  glow.addColorStop(1, 'rgba(220,230,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#eef0f4';
  g.beginPath();
  g.arc(64, 64, 20, 0, Math.PI * 2);
  g.fill();
  // A few darker "seas".
  g.fillStyle = 'rgba(150,155,170,0.5)';
  for (const [x, y, r] of [[58, 58, 6], [70, 66, 5], [62, 72, 4], [72, 55, 3]]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  const sp = new Sprite(new SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  sp.scale.setScalar(900);
  sp.renderOrder = -1;
  return sp;
}

export { RUNWAY } from '../sim/terrain.js';
export const PILOT_POS = new Vector3(0, 0, 0);

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5d7a3a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const l = 30 + Math.random() * 25;
    ctx.fillStyle = `hsl(${80 + Math.random() * 25}, ${35 + Math.random() * 20}%, ${l}%)`;
    ctx.fillRect(x, y, 1 + Math.random() * 1.5, 1 + Math.random() * 3);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function runwayTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d');
  // Mowing stripes along the runway
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? '#7f9c4c' : '#6e8d40';
    ctx.fillRect((i * 512) / 16, 0, 512 / 16 + 1, 64);
  }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 60},${70 + Math.random() * 60},30,0.35)`;
    ctx.fillRect(Math.random() * 512, Math.random() * 64, 1, 2);
  }
  // Edge markers
  ctx.fillStyle = 'rgba(240,240,230,0.9)';
  for (let i = 0; i < 512; i += 32) {
    ctx.fillRect(i, 1, 10, 2);
    ctx.fillRect(i, 61, 10, 2);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class World {
  /** @param {import('../sim/obstacles.js').Obstacles} obstacles */
  constructor(obstacles) {
    this.obstacles = obstacles;
    this.scene = new Scene();
    this.scene.background = new Color('#9cc3e6');
    // Exponential haze: distant hills fade into the colour of the horizon.
    this.scene.fog = new FogExp2('#c3d5e8', 0.00028);
    this.sunDir = new Vector3(); // the sun, even below the horizon
    this.lightDir = new Vector3(); // where the main light comes from (sun, or moon at night)
    this.moonDir = new Vector3();
    this.night = 0; // 0 = day .. 1 = full night
    this.exposure = 0.9; // suggested renderer exposure

    this.#sky();
    this.#lights();
    this.#terrain();
    this.#runway();
    this.#trees();
    this.#props();
    this.setTime(14, 172);
  }

  #sky() {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.2;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    this.sky = sky;
    this.scene.add(sky);
    this.nightDome = nightDome();
    this.stars = starField();
    this.moon = moonSprite();
    this.scene.add(this.nightDome, this.stars, this.moon);
  }

  #lights() {
    this.hemi = new HemisphereLight('#cfe3ff', '#4d5a33', 1.1);
    this.scene.add(this.hemi);
    const sun = new DirectionalLight('#fff3df', 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 6;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 200 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.sun = sun;
    this.scene.add(sun, sun.target);
  }

  /**
   * Set the time of day: sun, moon, sky, light colours, haze and stars.
   * @param {number} hours  local solar time (0-24)
   * @param {number} day    day of the year (1-366)
   */
  setTime(hours, day) {
    const sun = sunPosition(hours, day);
    const moon = moonPosition(hours, day);
    this.hours = hours;
    this.sunElevation = sun.elevation;
    skyDir(sun.elevation, sun.azimuth, this.sunDir);
    skyDir(moon.elevation, moon.azimuth, this.moonDir);
    const el = sun.elevation;
    // The sky shader (Preetham) handles day, sunset and twilight colours.
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    // 0 in daylight, 1 once the sun is 10° below the horizon.
    const night = smooth(2, -10, el);
    this.night = night;
    // Daylight: strength and colour from the sun's height (warm and weak
    // near the horizon). At night the moon takes over, faint and blue.
    const daylight = smooth(-3, 14, el);
    const warm = 1 - smooth(2, 22, el);
    const moonUp = smooth(-3, 8, moon.elevation);
    if (el > -3) {
      this.lightDir.copy(this.sunDir);
      if (this.lightDir.y < 0.03) this.lightDir.y = 0.03;
      this.lightDir.normalize();
      this.sun.intensity = 2.8 * daylight;
      this.sun.color.setRGB(1, 0.95 - warm * 0.3, 0.88 - warm * 0.5);
    } else {
      this.lightDir.copy(this.moonDir);
      if (this.lightDir.y < 0.05) this.lightDir.y = 0.05;
      this.lightDir.normalize();
      this.sun.intensity = 0.32 * moonUp * night;
      this.sun.color.setRGB(0.62, 0.72, 1);
    }
    // Sky light: blue by day, deep blue at night (never quite black, so the
    // ground and aeroplanes stay readable).
    this.hemi.intensity = 0.12 + 1.0 * daylight + 0.08 * (1 - night);
    this.hemi.color.setRGB(0.81 - 0.45 * night, 0.89 - 0.42 * night, 1 - 0.3 * night);
    this.hemi.groundColor.setRGB(0.3 * (1 - night) + 0.03, 0.35 * (1 - night) + 0.04, 0.2 * (1 - night) + 0.06);
    hazeColour(el, this.scene.fog.color);
    this.scene.background.copy(this.scene.fog.color);
    // The night dome takes over from the day sky through twilight.
    // Twilight: deep blue overhead, a warm band on the horizon where the sun
    // went down; then full night.
    const u = this.nightDome.material.uniforms;
    const deep = smooth(-2, -12, el);
    u.opacity.value = smooth(3, -3, el);
    u.zenith.value.copy(TWILIGHT_ZENITH).lerp(NIGHT_ZENITH, deep);
    u.horizon.value.copy(TWILIGHT_HORIZON).lerp(NIGHT_HORIZON, smooth(0, -9, el));
    u.glow.value.copy(TWILIGHT_GLOW).multiplyScalar(1 - smooth(-4, -14, el));
    u.sunDir.value.copy(this.sunDir);
    // Stars fade in as it gets dark; the moon is shown when it is up.
    this.stars.material.opacity = night;
    this.moon.visible = moon.elevation > -2;
    this.moon.material.opacity = 0.25 + 0.75 * smooth(0, -8, el);
    this.moon.position.copy(this.moonDir).multiplyScalar(8500);
    // Brighten the picture a little at night, as eyes adapt.
    this.exposure = 0.9 + 0.5 * night;
    // Tree shadows: soft in low sun, faint by moonlight.
    if (this.treeShadows) this.treeShadows.material.opacity = 0.5 * daylight + 0.12 * moonUp * night;
    this.#updateTreeShadows();
  }

  /** Lay each tree's crown shadow on the ground, away from the sun. */
  #updateTreeShadows() {
    if (!this.treeShadows) return;
    const s = this.lightDir;
    const elev = Math.max(0.12, s.y);
    const horiz = Math.hypot(s.x, s.z) || 1;
    // Unit vector along the ground pointing away from the sun.
    const ax = -s.x / horiz;
    const az = -s.z / horiz;
    const yaw = Math.atan2(-az, ax);
    const stretch = Math.min(4, 1 / elev);
    const o = new Object3D();
    this.obstacles.trees.forEach((t, i) => {
      const hc = t.conifer ? t.h * 0.5 : t.h * 0.62; // crown centre height
      const rc = t.conifer ? t.h * 0.17 : t.crownW;
      const reach = (hc * Math.hypot(s.x, s.z)) / elev; // horizontal offset of the crown's shadow
      const x = t.x + ax * reach;
      const z = t.z + az * reach;
      o.position.set(x, heightAt(x, z) + 0.06, z);
      o.rotation.set(0, yaw, 0);
      o.scale.set(rc * stretch * 1.05, 1, rc * 1.05);
      o.updateMatrix();
      this.treeShadows.setMatrixAt(i, o.matrix);
    });
    this.treeShadows.instanceMatrix.needsUpdate = true;
  }

  /** Keep the shadow camera centred on the aircraft so its shadow is crisp. */
  followShadow(target) {
    this.sun.position.copy(target).addScaledVector(this.lightDir, 80);
    this.sun.target.position.copy(target);
  }

  #terrain() {
    // Same grid the physics uses (src/sim/terrain.js), so they always agree.
    const size = TERRAIN_SIZE;
    const seg = TERRAIN_SEGMENTS;
    const geo = new PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const colors = [];
    // Vertex colours multiply the grass texture, so keep them light.
    const c1 = new Color('#f2ffd8');
    const c2 = new Color('#c4d79c');
    const c3 = new Color('#e8e2c0');
    const tmp = new Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      // PlaneGeometry vertex i is grid point (i % (seg+1), floor(i / (seg+1))).
      const h = gridHeight(i % (seg + 1), Math.floor(i / (seg + 1)));
      p.setY(i, h);
      const n = Math.sin(x * 0.011) * Math.cos(z * 0.013) * 0.5 + 0.5;
      tmp.copy(c1).lerp(c2, n * 0.8);
      if (h > 40) tmp.lerp(c3, Math.min(1, (h - 40) / 120));
      // Patchwork fields far away
      const fx = Math.floor(x / 180);
      const fz = Math.floor(z / 140);
      const r = Math.abs(Math.sin(fx * 12.9898 + fz * 78.233) * 43758.5453) % 1;
      if (Math.hypot(x, z) > 500) tmp.offsetHSL((r - 0.5) * 0.06, 0, (r - 0.5) * 0.08);
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = grassTexture();
    tex.repeat.set(size / 6, size / 6);
    const mat = new MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1 });
    const ground = new Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  #runway() {
    const g = new PlaneGeometry(RUNWAY.length, RUNWAY.width);
    g.rotateX(-Math.PI / 2);
    const rw = new Mesh(g, new MeshStandardMaterial({ map: runwayTexture(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
    // Just above the physics ground (y = 0); polygonOffset prevents z-fighting.
    rw.position.set(RUNWAY.x, 0.002, RUNWAY.z);
    rw.receiveShadow = true;
    this.scene.add(rw);

    // Pilot box (gravel pad) and safety fence line
    const pad = new Mesh(new PlaneGeometry(6, 4), new MeshStandardMaterial({ color: '#a39a86', roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.002, 0.5);
    pad.receiveShadow = true;
    this.scene.add(pad);

    const postGeo = new CylinderGeometry(0.04, 0.04, 1.1, 6);
    const postMat = new MeshStandardMaterial({ color: '#6b5b45' });
    const posts = new InstancedMesh(postGeo, postMat, 40);
    const o = new Object3D();
    for (let i = 0; i < 40; i++) {
      o.position.set(-100 + i * 5.1, 0.55, 6);
      o.updateMatrix();
      posts.setMatrixAt(i, o.matrix);
    }
    posts.castShadow = true;
    this.scene.add(posts);
    const rail = new Mesh(new BoxGeometry(200, 0.04, 0.04), postMat);
    rail.position.set(0, 1.0, 6);
    this.scene.add(rail);
  }

  #trees() {
    const count = this.obstacles.trees.length;
    const trunkGeo = new CylinderGeometry(0.25, 0.4, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = new IcosahedronGeometry(1, 1);
    const coniferGeo = new ConeGeometry(1, 1, 8);
    coniferGeo.translate(0, 0.5, 0);
    const trunkMat = new MeshStandardMaterial({ color: '#4b3a2a', roughness: 1 });
    const crownMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true });
    const trunks = new InstancedMesh(trunkGeo, trunkMat, count);
    const crowns = new InstancedMesh(crownGeo, crownMat, count);
    const conifers = new InstancedMesh(coniferGeo, crownMat, count);
    const o = new Object3D();
    const col = new Color();
    let nc = 0;
    let nf = 0;
    // Same layout the physics collides with (src/sim/obstacles.js).
    this.obstacles.trees.forEach((t, i) => {
      const { x, y, z, h } = t;
      o.rotation.set(0, t.rot, 0);
      o.position.set(x, y - 0.2, z);
      o.scale.set(1, h * 0.45, 1);
      o.updateMatrix();
      trunks.setMatrixAt(i, o.matrix);
      col.setHSL(t.hue, t.sat, t.light);
      if (t.conifer) {
        o.position.set(x, y + h * 0.15, z);
        o.scale.set(h * 0.22, h * 0.9, h * 0.22);
        o.updateMatrix();
        conifers.setMatrixAt(nf, o.matrix);
        conifers.setColorAt(nf++, col);
      } else {
        o.position.set(x, y + h * 0.62, z);
        o.scale.set(t.crownW, h * 0.38, t.crownW);
        o.updateMatrix();
        crowns.setMatrixAt(nc, o.matrix);
        crowns.setColorAt(nc++, col);
      }
    });
    crowns.count = nc;
    conifers.count = nf;
    for (const m of [trunks, crowns, conifers]) {
      // Trees don't cast into the sun's shadow map (it only covers a few
      // metres around the model); they get soft ground shadows instead,
      // visible at any distance (see #updateTreeShadows).
      m.castShadow = false;
      m.receiveShadow = true;
      this.scene.add(m);
    }
    this.trees = { trunks, crowns, conifers };

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const shadowGeo = new PlaneGeometry(2, 2);
    shadowGeo.rotateX(-Math.PI / 2);
    this.treeShadows = new InstancedMesh(
      shadowGeo,
      new MeshBasicMaterial({ map: new CanvasTexture(c), transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: true }),
      count,
    );
    this.treeShadows.renderOrder = 1;
    this.scene.add(this.treeShadows);
  }

  #props() {
    // Windsock
    const ws = new Group();
    const pole = new Mesh(new CylinderGeometry(0.04, 0.05, 5, 8), new MeshStandardMaterial({ color: '#dddddd' }));
    pole.position.y = 2.5;
    pole.castShadow = true;
    ws.add(pole);
    const sock = new Group();
    sock.position.y = 4.85;
    // Wide mouth at the pole, tapering to the narrow downwind end. Rotating
    // +90° about z sends the cylinder's top (first radius) to -x, the far end.
    const coneGeo = new CylinderGeometry(0.12, 0.28, 1.6, 12, 4, true);
    coneGeo.rotateZ(Math.PI / 2);
    coneGeo.translate(-0.8, 0, 0);
    // Five crisp bands (orange at the mouth) from a stripe texture along the
    // sock's length (the cylinder's v texture coordinate).
    const bands = document.createElement('canvas');
    bands.width = 4;
    bands.height = 80;
    const bctx = bands.getContext('2d');
    for (let i = 0; i < 5; i++) {
      bctx.fillStyle = i % 2 ? '#f2f2f2' : '#ff5a1f';
      bctx.fillRect(0, i * 16, 4, 16);
    }
    const bandTex = new CanvasTexture(bands);
    bandTex.colorSpace = SRGBColorSpace;
    const sockMesh = new Mesh(coneGeo, new MeshStandardMaterial({ map: bandTex, side: DoubleSide, roughness: 0.9 }));
    sockMesh.castShadow = true;
    sock.add(sockMesh);
    ws.add(sock);
    ws.position.set(-35, 0, -42);
    this.scene.add(ws);
    this.windsock = sock;

    // Club hut / hangar behind the pilot
    const hut = new Group();
    const body = new Mesh(new BoxGeometry(10, 3, 6), new MeshStandardMaterial({ color: '#8b6b4a', roughness: 0.9 }));
    body.position.y = 1.5;
    const roof = new Mesh(new BoxGeometry(10.6, 0.25, 7), new MeshStandardMaterial({ color: '#3d4a52', roughness: 0.7 }));
    roof.position.y = 3.3;
    roof.rotation.x = 0.06;
    hut.add(body, roof);
    hut.traverse((m) => {
      m.castShadow = true;
      m.receiveShadow = true;
    });
    hut.position.set(-24, 0, 26);
    this.scene.add(hut);

    // Flight-line table
    const table = new Mesh(new BoxGeometry(2, 0.06, 0.8), new MeshStandardMaterial({ color: '#c8c8c8' }));
    table.position.set(6, 0.75, 3);
    table.castShadow = true;
    this.scene.add(table);
    for (const dx of [-0.9, 0.9]) {
      for (const dz of [-0.3, 0.3]) {
        const leg = new Mesh(new CylinderGeometry(0.02, 0.02, 0.75), table.material);
        leg.position.set(6 + dx, 0.375, 3 + dz);
        this.scene.add(leg);
      }
    }
  }

  /** Point the windsock with the wind (world velocity vector). */
  updateWindsock(wind) {
    const speed = Math.hypot(wind.x, wind.z);
    // Sock tail points downwind (sock geometry extends along -x).
    const yaw = Math.atan2(wind.z, -wind.x);
    this.windsock.rotation.set(0, yaw, 0);
    const droop = Math.max(0, 1 - speed / 7) * 1.2;
    this.windsock.rotateZ(droop);
  }
}
