// The flying field: sky, lighting, terrain, runway, trees and props.
import {
  Scene, Color, FogExp2, HemisphereLight, Points, PointsMaterial, BufferGeometry, Sprite, SpriteMaterial, DirectionalLight, Mesh, PlaneGeometry, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, CylinderGeometry, IcosahedronGeometry,
  Object3D, BoxGeometry, ConeGeometry, Group, Vector3, MathUtils, DoubleSide, Float32BufferAttribute,
  MeshBasicMaterial, ShaderMaterial, SphereGeometry, BackSide, MeshLambertMaterial,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, gridHeight, TERRAIN_SIZE, TERRAIN_SEGMENTS, RUNWAY } from '../sim/terrain.js';
import { sunPosition, moonPosition } from './sun.js';
import { CloudLayer, cloudUniforms, addCloudShadows } from './clouds.js';
import { addGroundDetail } from './ground.js';
import { broadleafCrown, conifer, trunk } from './trees.js';
import { clubhouse, shippingContainer, car, gazebo, gravelTexture, bushes } from './props.js';

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
  // 6 m of lawn: an even mid green covered in fine, low-contrast blade
  // strokes, so from a distance it reads as smooth grass, not camouflage.
  const N = 512;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = '#6a8c3e';
  ctx.fillRect(0, 0, N, N);
  ctx.lineCap = 'round';
  for (let i = 0; i < 30000; i++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const len = 1.5 + rnd() * 3.5;
    const a = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
    const l = 30 + rnd() * 16;
    ctx.strokeStyle = `hsla(${80 + rnd() * 16}, ${36 + rnd() * 14}%, ${l}%, 0.55)`;
    ctx.lineWidth = 0.8 + rnd() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function runwayTexture() {
  // The mown strip, lengthwise along the canvas: two-tone mowing stripes
  // running down the runway, worn patches where models touch down and
  // lift off, and white edge markers.
  const W = 2048;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lanes = 5;
  for (let i = 0; i < lanes; i++) {
    ctx.fillStyle = i % 2 ? '#86a253' : '#729246';
    ctx.fillRect(0, (i * H) / lanes, W, H / lanes + 1);
  }
  // Fine grass texture.
  for (let i = 0; i < 60000; i++) {
    const l = 30 + rnd() * 25;
    ctx.fillStyle = `hsla(${78 + rnd() * 25}, 40%, ${l}%, 0.35)`;
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 3, 1);
  }
  // Wear: touchdown and lift-off areas a third of the way in from each end,
  // and faint wheel tracks down the middle.
  for (const cx of [0.28, 0.72]) {
    for (let i = 0; i < 70; i++) {
      const x = (cx + (rnd() - 0.5) * 0.22) * W;
      const y = H / 2 + (rnd() - 0.5) * H * 0.5;
      const r = 6 + rnd() * 24;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(120,105,70,0.35)');
      g.addColorStop(1, 'rgba(120,105,70,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  ctx.fillStyle = 'rgba(110,100,70,0.12)';
  for (const y of [0.44, 0.56]) ctx.fillRect(W * 0.15, H * y - 3, W * 0.7, 6);
  // Edge markers.
  ctx.fillStyle = 'rgba(240,240,230,0.95)';
  for (let i = 0; i < W; i += 128) {
    ctx.fillRect(i, 3, 44, 7);
    ctx.fillRect(i, H - 10, 44, 7);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class World {
  /** @param {import('../sim/obstacles.js').Obstacles} obstacles */
  constructor(obstacles, opts = {}) {
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
    this.clouds = new CloudLayer();
    this.scene.add(this.clouds.mesh);
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
    // The sun (or moon at night). Its shadow map covers the flying area and
    // is redrawn only when it moves (shadows.js).
    const sun = new DirectionalLight('#fff3df', 2.6);
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
    // Clouds: lit by the light of the moment; their shadows follow the sun.
    cloudUniforms.cloudSunDir.value.copy(this.lightDir);
    cloudUniforms.cloudShadowStrength.value = 0.75 * daylight + 0.2 * night;
    this.clouds.setLight(this.sun.color, this.sun.intensity, this.scene.fog.color, night);
    // Tree shadows: soft in low sun, faint by moonlight.
    this.shadows?.setDirection(this.lightDir);
  }

  /** Cloud cover, 0 (clear) to 1 (overcast). */
  setClouds(cover) {
    cloudUniforms.cloudCover.value = cover;
    this.clouds.mesh.visible = cover > 0.01;
  }

  /** Let the clouds drift with the wind (world velocity, m/s). */
  updateClouds(dt, wind) {
    this.clouds.update(dt, wind);
  }

  /**
   * How much darker a shadow on open ground is than the sunlit ground
   * around it (0 none .. 1 black), as it comes out on screen: the shadow
   * removes the direct sun but keeps the sky's light. Used for aeroplane
   * shadows so they match the scenery's.
   */
  shadowDarkness() {
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const sky = this.hemi.intensity * lum(this.hemi.color);
    const direct = this.sun.intensity * lum(this.sun.color) * Math.max(0, this.lightDir.y);
    if (direct <= 0) return 0;
    const ratio = sky / (sky + direct); // in linear light
    return 1 - ratio ** (1 / 2.2); // as displayed (sRGB)
  }

  /**
   * Swap the trees round the flying field for realistic EZ-Tree trees
   * (loaded in the background; see ezTrees.js). The simple versions of
   * those trees are hidden; the rest stay as they are.
   */
  async upgradeTrees() {
    const { buildEzTrees } = await import('./ezTrees.js');
    const near = [];
    const idx = [];
    this.obstacles.trees.forEach((t, i) => {
      if (Math.hypot(t.x, t.z + 40) < 320) {
        near.push(t);
        idx.push(i);
      }
    });
    this.ezTrees = await buildEzTrees(this.scene, near);
    const zero = new Object3D();
    zero.scale.setScalar(0);
    zero.updateMatrix();
    const touched = new Set();
    for (const i of idx) {
      const [mesh, slot] = this.treeSlots[i];
      mesh.setMatrixAt(slot, zero.matrix);
      this.trees.trunks.setMatrixAt(i, zero.matrix);
      touched.add(mesh);
    }
    for (const m of [...touched, this.trees.trunks]) m.instanceMatrix.needsUpdate = true;
    if (this.shadows) this.shadows.dirty = true;
    return near.length;
  }

  /** Scenery shadows (see shadows.js). */
  attachShadows(shadows) {
    this.shadows = shadows;
    shadows.setDirection(this.lightDir);
  }

  /** Every frame, after the camera has moved. */
  updateShadows() {
    this.shadows?.update();
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
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = grassTexture();
    tex.repeat.set(size / 6, size / 6);
    // Matte (no plastic sheen).
    const mat = addCloudShadows(addGroundDetail(new MeshLambertMaterial({ map: tex, vertexColors: true })));
    const ground = new Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  #runway() {
    const g = new PlaneGeometry(RUNWAY.length, RUNWAY.width);
    g.rotateX(-Math.PI / 2);
    const rw = new Mesh(g, addCloudShadows(new MeshLambertMaterial({ map: runwayTexture(), polygonOffset: true, polygonOffsetFactor: -2 })));
    // Just above the physics ground (y = 0); polygonOffset prevents z-fighting.
    rw.position.set(RUNWAY.x, 0.002, RUNWAY.z);
    rw.receiveShadow = true;
    this.scene.add(rw);

    // Pilot box (gravel pad) and safety fence line
    const pad = new Mesh(new PlaneGeometry(6, 4), addCloudShadows(new MeshLambertMaterial({ map: gravelTexture(), polygonOffset: true, polygonOffsetFactor: -2 })));
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
    // A few shapes of each kind, picked per tree, so the woods don't repeat.
    const crownGeos = [broadleafCrown(11), broadleafCrown(23), broadleafCrown(37)];
    const coniferGeos = [conifer(5), conifer(17)];
    const trunkGeo = trunk(3);
    const leafMat = addCloudShadows(new MeshLambertMaterial({ vertexColors: true }));
    this.leafMat = leafMat;
    const barkMat = addCloudShadows(new MeshLambertMaterial({ color: '#5a4632', vertexColors: true }));
    const mk = (geo, mat) => new InstancedMesh(geo, mat, count);
    const trunks = mk(trunkGeo, barkMat);
    const crowns = crownGeos.map((g) => mk(g, leafMat));
    const conifers = coniferGeos.map((g) => mk(g, leafMat));
    const nCrown = crowns.map(() => 0);
    this.treeSlots = []; // tree index -> [crown mesh, instance]
    const nCon = conifers.map(() => 0);
    const o = new Object3D();
    const col = new Color();
    // Same layout the physics collides with (src/sim/obstacles.js).
    this.obstacles.trees.forEach((t, i) => {
      const { x, y, z, h } = t;
      const pick = Math.floor(((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 1000);
      o.rotation.set(0, t.rot, 0);
      o.position.set(x, y - 0.2, z);
      o.scale.set(t.conifer ? 0.7 : 1, h * (t.conifer ? 0.3 : 0.5), t.conifer ? 0.7 : 1);
      o.updateMatrix();
      trunks.setMatrixAt(i, o.matrix);
      // Leaf colour per tree, a little brighter than before (the shapes
      // carry their own shading).
      col.setHSL(t.hue, t.sat, t.light * 1.12 + 0.02);
      if (t.conifer) {
        const k = pick % conifers.length;
        o.position.set(x, y + h * 0.1, z);
        o.scale.set(h * 0.22, h * 0.95, h * 0.22);
        o.updateMatrix();
        this.treeSlots[i] = [conifers[k], nCon[k]];
        conifers[k].setMatrixAt(nCon[k], o.matrix);
        conifers[k].setColorAt(nCon[k]++, col);
      } else {
        const k = pick % crowns.length;
        o.position.set(x, y + h * 0.62, z);
        o.scale.set(t.crownW * 1.05, h * 0.4, t.crownW * 1.05);
        o.updateMatrix();
        this.treeSlots[i] = [crowns[k], nCrown[k]];
        crowns[k].setMatrixAt(nCrown[k], o.matrix);
        crowns[k].setColorAt(nCrown[k]++, col);
      }
    });
    crowns.forEach((m, k) => (m.count = nCrown[k]));
    conifers.forEach((m, k) => (m.count = nCon[k]));
    for (const m of [trunks, ...crowns, ...conifers]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
    this.trees = { trunks, crowns, conifers };
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

    // Club scenery (placement and collisions from src/sim/obstacles.js).
    const ob = this.obstacles;
    const shadowy = (o) => o.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      if (m.material && !m.material.userData.clouds) {
        addCloudShadows(m.material);
        m.material.userData.clouds = true;
      }
    });
    for (const o of [clubhouse(ob.hut), shippingContainer(ob.container), gazebo(ob.gazebo), ...ob.cars.map(car)]) {
      shadowy(o);
      this.scene.add(o);
    }
    for (const b of bushes(this.leafMat)) this.scene.add(b);

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
