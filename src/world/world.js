// The flying field: sky, lighting, terrain, runway, trees and props.
import {
  Scene, Color, FogExp2, HemisphereLight, Points, PointsMaterial, BufferGeometry, Sprite, SpriteMaterial, DirectionalLight, Mesh, PlaneGeometry, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, CylinderGeometry, IcosahedronGeometry,
  Object3D, BoxGeometry, ConeGeometry, Group, Vector3, MathUtils, DoubleSide, Float32BufferAttribute,
  MeshBasicMaterial, ShaderMaterial, SphereGeometry, BackSide, MeshLambertMaterial, Matrix4, ShaderChunk,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, gridHeight, TERRAIN_SIZE, TERRAIN_SEGMENTS, RUNWAY, PILOT_PAD } from '../sim/terrain.js';
import { buildingsMesh } from './buildings.js';
import { clubAngle } from '../sim/location.js';
import { sunPosition, moonPosition, solarHours } from './sun.js';
import { CloudLayer, cloudUniforms, addCloudShadows, CLOUD_GLSL } from './clouds.js';
import { addGroundDetail, groundUniforms } from './ground.js';
import { seasonFor } from './seasons.js';
import { broadleafCrown, conifer, trunk, coniferTrunk, simpleTrunk, blobCrown, addLeafShading, leafUniforms } from './trees.js';
import { fluffyCrown, crownWood, fluffyConifer, coniferWood, makeFluffy, fluffyDepthMaterial, pickAsBall, setLeafDetail, setLeafSpecies, leafTexture, LEAF_ROWS } from './fluffy.js';
import { CrownLod, addLodFade, addCloseSwitch, closeUniforms } from './lod.js';
import { LowCloud } from './mist.js';
import { addSnowCover, snowUniforms, snowVisibility } from './snow.js';
import { Snowfall } from './snowfall.js';
import { installVolumetricFog, fog4, FIELD_GLSL } from './volfog.js';
import { speciesOf, bushSpeciesAt, barkColor, trunkThickness, SPECIES, WOOD, CONIFER, leafName } from './species.js';
import { bakeImpostors, impostorGeometry, makeImpostor } from './impostor.js';
import { QUALITY } from './quality.js';
import { CROWN_SEEDS, crownOf } from '../sim/treeShapes.js';
import { clubhouse, shippingContainer, car, gazebo, gravelTexture, bushes, bushMatrix, siteFence, bushShapes, leafyBushShapes, bushTwigShapes } from './props.js';

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
  [20, new Color('#a9c7ec')],
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

function cricketPitchTexture(r) {
  // A rolled cricket pitch, lengthwise along the canvas: pale, dry, worn
  // grass, darker roller bands, scuffed ends where bowlers land, and the
  // white creases (bowling crease at each end, popping crease 1.22 m in
  // front of it, return creases along the sides).
  const ppm = 64; // pixels per metre
  const W = Math.round(r.length * ppm);
  const H = Math.round(r.width * ppm);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  let seed = 23;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = '#a7a467';
  ctx.fillRect(0, 0, W, H);
  // Roller bands along the pitch.
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(90,100,40,0.10)' : 'rgba(255,250,210,0.06)';
    ctx.fillRect(0, (i * H) / 4, W, H / 4 + 1);
  }
  for (let i = 0; i < 40000; i++) {
    const l = 45 + rnd() * 25;
    ctx.fillStyle = `hsla(${50 + rnd() * 25}, ${25 + rnd() * 20}%, ${l}%, 0.35)`;
    ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1);
  }
  // Bare, scuffed patches where the ball lands and the bowlers run in.
  const crease = (r.length - 20.12) / 2; // bowling creases 20.12 m apart
  for (const end of [0, 1]) {
    for (let i = 0; i < 60; i++) {
      const d = crease + 1.5 + rnd() * 5;
      const x = (end ? r.length - d : d) * ppm;
      const y = H / 2 + (rnd() - 0.5) * H * 0.7;
      const rad = 4 + rnd() * 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(150,125,85,0.45)');
      g.addColorStop(1, 'rgba(150,125,85,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }
  // Creases, 5 cm white lines.
  ctx.fillStyle = 'rgba(245,245,238,0.95)';
  const lw = 0.05 * ppm;
  for (const end of [0, 1]) {
    const bowl = end ? r.length - crease : crease;
    const pop = end ? bowl - 1.22 : bowl + 1.22;
    ctx.fillRect(bowl * ppm - lw / 2, H / 2 - 1.32 * ppm, lw, 2.64 * ppm);
    ctx.fillRect(pop * ppm - lw / 2, 0, lw, H);
    // Return creases: 1.32 m either side of the middle, from the popping
    // crease back 2.44 m towards the end of the pitch.
    const x0 = end ? pop : pop - 2.44;
    for (const side of [-1, 1]) ctx.fillRect(x0 * ppm, H / 2 + side * 1.32 * ppm - lw / 2, 2.44 * ppm, lw);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const _trunkM = new Matrix4();
const _crownM = new Matrix4();

/** A tree's trunk and crown matrices (unit trunk scaled by height; crown from crownOf). */
function treeMatrices(t, o, trunkM, crownM) {
  o.rotation.set(0, t.rot, 0);
  o.position.set(t.x, t.y - 0.15, t.z);
  // Thicker or slimmer for its species (src/world/species.js).
  const th = trunkThickness(t);
  o.scale.set(t.h * th, t.h, t.h * th);
  o.updateMatrix();
  trunkM.copy(o.matrix);
  const c = crownOf(t);
  if (t.conifer) {
    o.position.set(t.x, c.y0, t.z);
    o.scale.set(c.r, c.ch, c.r);
  } else {
    o.position.set(t.x, c.cy, t.z);
    o.scale.set(c.sx, c.sy, c.sx);
  }
  o.updateMatrix();
  crownM.copy(o.matrix);
}

/** Built scenery still drawn over Google's tiles. */
const KEEP_OVER_GOOGLE = new Set(['tree', 'bush', 'fence']);


/** The conifer species (src/world/species.js CONIFER), one shape each. */
const CONIFER_NAMES = Object.keys(CONIFER);
/** The plain near trunks' designs (trunk seeds), picked by tree. */
const TRUNK_SEEDS = [3, 41, 67];
/** The bush shapes' seeds (src/world/props.js). */
const BUSH_SEEDS = [101, 131];

const _mistColour = new Color();
const _cloudTop = new Color();
const _cloudSun = new Color();

export class World {
  /** @param {import('../sim/obstacles.js').Obstacles} obstacles */
  /**
   * @param {{ quality?: object, viewDistance?: number }} opts  graphics preset
   *   (src/world/quality.js) and how far scenery is drawn (m)
   */
  constructor(obstacles, opts = {}) {
    this.obstacles = obstacles;
    this.quality = opts.quality ?? QUALITY.high;
    // The ground, trees, buildings and fences drawn from the site data, which
    // Google's photorealistic tiles replace when they're on.
    this.builtScenery = [];
    this.viewDistance = opts.viewDistance ?? Infinity;
    // Leafy crowns and bushes (src/world/fluffy.js), or the classic solid ones.
    this.fluffy = opts.treeStyle !== 'classic';
    this.renderer = opts.renderer; // for drawing the distant trees' pictures (impostors)
    if (this.quality.leafy?.leafPx) setLeafDetail(this.quality.leafy.leafPx);
    // Only the leaves this site's trees and bushes have are drawn.
    setLeafSpecies([
      ...obstacles.trees.map((t) => leafName(speciesOf(t).name)),
      ...(obstacles.bushes.length ? ['hawthorn'] : []),
      'beech', // (the distant pictures' broadleaf leaves)
    ]);
    this.twigMeshes = [];
    this.scene = new Scene();
    this.scene.background = new Color('#9cc3e6');
    // Exponential haze: distant hills fade into the colour of the horizon.
    // A shorter scenery distance closes the haze in to match.
    const haze = Math.max(0.00028, 1.3 / (opts.viewDistance ?? Infinity));
    // Haze, mist and low cloud: src/world/volfog.js.
    installVolumetricFog(haze);
    this.scene.fog = new FogExp2('#c3d5e8', haze);
    this.hazeBase = new Color('#c3d5e8'); // the haze colour of the time of day
    this.weather = { mist: 0, lowCloud: { amount: 0, base: 60, top: 100 } };
    this.fogNow = 0; // how foggy it is where the camera is (0-1)
    this.sunDir = new Vector3(); // the sun, even below the horizon
    this.lightDir = new Vector3(); // where the main light comes from (sun, or moon at night)
    this.moonDir = new Vector3();
    this.night = 0; // 0 = day .. 1 = full night
    this.exposure = 0.9; // suggested renderer exposure

    this.#sky();
    this.clouds = new CloudLayer();
    this.scene.add(this.clouds.mesh);
    // Low cloud you can fly through: its pattern and drift (src/world/mist.js),
    // drawn by the volumetric fog (volfog.js).
    this.lowCloud = new LowCloud();
    // Snow lying (addSnowCover on the ground, roofs and so on) and falling
    // (src/world/snow.js, snowfall.js).
    this.snow = { cover: 0, falling: 0 };
    this.snowfall = new Snowfall(this.quality === QUALITY.low ? 8000 : this.quality === QUALITY.medium ? 18000 : 30000);
    this.scene.add(this.snowfall.mesh);
    this.#lights();
    // The rest, in steps (build): all now, or (opts.defer) by the caller,
    // with the start screen showing how far it's got.
    this.steps = [
      // [what, rough share of the time, do it]
      ['ground', 1, () => {
        this.#terrain();
        // The club's own things (runway, pad, fence, pits) in the club frame.
        this.club = new Group();
        this.club.rotation.y = -clubAngle();
        this.scene.add(this.club);
        this.#runway();
      }],
      ['leaves', 3, () => this.fluffy && leafTexture()],
      ['distant trees', 1, () => this.fluffy && this.#impostorMat()],
      ['trees and bushes', 4, () => this.#site()],
      ['the rest', 1, () => {
        this.#props();
        this.setTime(14, 172);
      }],
    ];
    if (!opts.defer) for (const [, , run] of this.steps) run();
  }

  /**
   * Build the rest of the world (opts.defer), a step at a time, letting the
   * screen update between them. onProgress(fraction 0-1).
   */
  async build(onProgress = () => {}, between = () => Promise.resolve()) {
    const total = this.steps.reduce((a, [, w]) => a + w, 0);
    let done = 0;
    for (const [, w, run] of this.steps) {
      run();
      done += w;
      onProgress(done / total);
      await between();
    }
  }

  #sky() {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    // Clear English summer air: a deeper blue overhead (less haze, more
    // Rayleigh blue), paler only down towards the horizon.
    u.turbidity.value = 2.2;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.0025;
    u.mieDirectionalG.value = 0.85;
    // The Preetham sky comes out very bright; tone mapping squeezed that to
    // a pale, almost white blue. Scaled down (and its blue deepened a
    // touch) before tone mapping, the blue survives.
    u.skyGain = { value: 0.36 };
    // Mist: the sky fades into the fog colour (updateWeather).
    u.skyFog = { value: 0 };
    u.skyFogColor = { value: new Color() };
    // ... and mist and low cloud along each line of sight (volfog.js).
    Object.assign(u, { fogMistA: { value: fog4.a }, fogMistB: { value: fog4.b }, fogSun: { value: fog4.sun }, fogUnder: { value: fog4.under }, fogTop: { value: fog4.top } });
    // Sunbeams (crepuscular rays) under the clouds, and how strong (0 off).
    Object.assign(u, cloudUniforms, { godRays: { value: 1 } });
    // The sun's disc: a little larger than life (it reads better on a
    // screen), larger still and orange low down (setTime).
    u.sunDiscCos = { value: Math.cos((0.8 * Math.PI) / 180 / 2) };
    u.sunDiscTint = { value: new Color(1, 1, 1) };
    sky.material.fragmentShader = sky.material.fragmentShader
      .replace(/const float sunAngularDiameterCos = [0-9.]+;/, 'uniform float sunDiscCos;\nuniform vec3 sunDiscTint;')
      .replace('float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );', 'float sundisk = smoothstep( sunDiscCos, sunDiscCos + ( 1.0 - sunDiscCos ) * 0.2, cosTheta );')
      .replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sunDiscTint * sundisk;')
      .replace('void main() {', `uniform float skyGain;\nuniform float skyFog;\nuniform vec3 skyFogColor;\nuniform float godRays;\n${FIELD_GLSL}\n${CLOUD_GLSL}\nvoid main() {`)
      .replace('#include <tonemapping_fragment>', `{
        vec3 c = gl_FragColor.rgb * skyGain;
        float l = dot(c, vec3(0.3, 0.55, 0.15));
        gl_FragColor.rgb = max(mix(vec3(l), c, 1.4), 0.0);
      }
      #include <tonemapping_fragment>`)
      // Mist: faded into the fog colour as the scene's fog does it (after
      // tone mapping), so the sky meets misty ground seamlessly.
      .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      {
        // Down to the horizon the sky turns into the haze the distant
        // ground fades into (the same colour, mixed the same way), so
        // there's no line where they meet.
        vec3 sd = normalize(vWorldPosition - cameraPosition);
        float toHaze = max(skyFog, 1.0 - smoothstep(-0.01, 0.16, sd.y));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, skyFogColor, toHaze);
        // Sunbeams: looking towards the sun, the hazy air under the clouds
        // is lit where sunlight comes through the gaps and dark in the
        // clouds' shadows - shafts fanning out from the sun. Along the line
        // of sight (up to the cloud base), how much of it is in sunlight.
        float toSun = dot(sd, cloudSunDir);
        if (godRays > 0.0 && cloudCover > 0.01 && toSun > 0.0 && cloudSunDir.y > 0.02) {
          float phase = toSun * toSun;
          float base = cloudShape.x;
          float tMax = sd.y > 0.02 ? min((base - cameraPosition.y) / sd.y, 5000.0) : 5000.0;
          float sunUp = max(cloudSunDir.y, 0.08);
          float lit = 0.0;
          for (int i = 0; i < 8; i++) {
            vec3 p = cameraPosition + sd * tMax * (float(i) + 0.5) / 8.0;
            vec2 at = p.xz + cloudSunDir.xz / sunUp * (base - p.y);
            float t = cloudThreshold();
            lit += 1.0 - smoothstep(t, t + cloudShape.w, cloudCoarse(at));
          }
          lit /= 8.0;
          // Brighter shafts, darker streaks (about the average, so the sky
          // doesn't change overall).
          gl_FragColor.rgb *= 1.0 + godRays * cloudShadowStrength * phase * (lit - 0.55) * 1.8;
        }
        // Mist and low cloud in the way (out to 3 km).
        if (fogMistA.x > 0.0 || fogMistA.z > 0.0) {
          vec4 f = vfAlong(cameraPosition, cameraPosition + sd * 3000.0, skyFogColor);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, f.yzw, 1.0 - exp(-f.x));
        }
      }`);
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
    // Layer 1: drawn into the shadow map only (the distant leafy trees'
    // shadows come from plain shapes; their pictures cast none).
    sun.shadow.camera.layers.enable(1);
    this.scene.add(sun, sun.target);
  }

  /**
   * Set the time of day: sun, moon, sky, light colours, haze and stars.
   * @param {number} hours  UK clock time (0-24: BST in summer)
   * @param {number} day    day of the year (1-366)
   */
  setTime(hours, day) {
    const solar = solarHours(hours, day);
    const sun = sunPosition(solar, day);
    const moon = moonPosition(solar, day);
    this.hours = hours;
    this.sunElevation = sun.elevation;
    {
      // The sun's disc: 1° high in the sky (a bit bigger than its real
      // 0.53°), swelling to ~2.2° and turning orange as it sets.
      const low = 1 - smooth(0, 18, sun.elevation);
      const diam = 1.0 + 1.3 * low * low;
      const su = this.sky.material.uniforms;
      su.sunDiscCos.value = Math.cos((diam * Math.PI) / 180 / 2);
      su.sunDiscTint.value.setRGB(1, 1 - 0.4 * low, 1 - 0.75 * low);
    }
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
    hazeColour(el, this.hazeBase);
    this.scene.fog.color.copy(this.hazeBase);
    this.scene.background.copy(this.scene.fog.color);
    // (Before mist dims them: updateWeather.)
    this.sunBase = this.sun.intensity;
    this.hemiBase = this.hemi.intensity;
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
  /**
   * Snow ({ cover, falling }, 0-1 each: src/world/snow.js snowFor). Call
   * after setTime (snow on the ground lights things from below).
   */
  setSnow(s) {
    this.snow = s;
    snowUniforms.uSnow.value = s.cover;
    // Light reflected up off the snow: the sky light from below turns white.
    const g = this.hemi.groundColor;
    const lum = Math.max(g.r, g.g, g.b) * 2.2;
    g.lerp(_mistColour.setRGB(lum * 0.95, lum, lum * 1.05), 0.8 * s.cover);
  }

  /** Mist (0-1) and low cloud ({ amount, base, top }): src/world/mist.js weatherFor. */
  setWeather(w) {
    this.weather = w;
    this.lowCloud.set(w.lowCloud.amount, w.lowCloud.base, w.lowCloud.top);
  }

  /**
   * Mist and low cloud where the camera is (every frame): the haze thickens
   * and turns pale grey, the sky and high clouds fade into it, the sun dims;
   * inside a cloud you see a few tens of metres.
   */
  updateWeather(camPos, dt, wind) {
    const lc = this.lowCloud;
    lc.update(dt, wind, camPos);
    const mist = this.weather.mist;
    const fog = this.scene.fog;
    // Daylight (dims through dusk, not just once it's night).
    const day = smooth(-6, 14, this.sunElevation ?? 30);
    // The field (volfog.js): mist density (thick fog ~90 m at the ground,
    // light mist ~600 m) and top; low cloud (~35 m inside it).
    const mistD = mist > 0 ? 3 / (650 - 560 * Math.pow(mist, 0.7)) : 0;
    const top = this.weather.mistTop ?? 45;
    fog4.a.x = mistD;
    fog4.a.y = top;
    fog4.a.z = lc.amount;
    fog4.a.w = 3 / 35;
    fog4.b.x = lc.base;
    fog4.b.y = lc.top;
    fog4.b.z = lc.offset.x;
    fog4.b.w = lc.offset.y;
    fog4.sun.x = this.sunDir.x;
    fog4.sun.y = this.sunDir.y;
    fog4.sun.z = this.sunDir.z;
    fog4.sun.w = 0.25 * smooth(-2, 10, this.sunElevation ?? 30);
    // How much is over and around the camera (the sky's light, the sun's).
    const inCloud = lc.inside(camPos);
    const H = Math.max(top * 0.3, 4);
    const overhead = mistD * (Math.max(0, top - camPos.y) + H * Math.exp(-Math.max(0, camPos.y - top) / H));
    const veil = 1 - Math.exp(-overhead * 1.2);
    // How far anything can be seen (m): in the mist (or a cloud), beyond the
    // point where it's all but solid fog there's no need to draw anything
    // (the camera's far plane: see main.js).
    const groundY = heightAt(camPos.x, camPos.z);
    const inMist = mistD > 0 ? 1 - smooth(groundY + top, groundY + top * 2 + 20, camPos.y) : 0;
    let far = Infinity;
    if (inMist > 0) far = 6 / (0.7 * mistD) / Math.max(inMist, 1e-3);
    if (inCloud > 0.3) far = Math.min(far, 350 / inCloud);
    // Falling snow: the air thickens evenly (volfog.js); nothing is seen
    // much past twice the visibility.
    const falling = this.snow.falling;
    const snowVis = snowVisibility(falling);
    fog4.under.w = falling > 0 ? 3 / snowVis : 0;
    far = Math.min(far, snowVis * 2.5);
    this.visibleFar = Math.max(250, far);
    const grey = Math.max(veil, inCloud);
    this.fogNow = grey;
    // The haze turns pale grey with mist: its own colour of the moment,
    // greyed and a little lighter (so it darkens through dusk with the sky).
    const h = this.hazeBase;
    const lum = 0.3 * h.r + 0.55 * h.g + 0.15 * h.b;
    // (No lighter than the haze itself: fogged trees shouldn't glow paler
    // than the sky behind them.)
    _mistColour.setRGB(lum, lum * 1.02, lum * 1.06).lerp(h, 0.35).multiplyScalar(0.92);
    fog.color.copy(h).lerp(_mistColour, Math.min(1, Math.max(mist * 1.2, falling * 1.5)));
    // Low cloud: underneath, the same grey as the mist (a shade darker);
    // on top, brighter in the sun (screen colours, as the fog uses them).
    _mistColour.setRGB(lum, lum * 1.02, lum * 1.06).lerp(h, 0.35).multiplyScalar(0.88);
    _cloudTop.copy(_mistColour);
    _mistColour.convertLinearToSRGB();
    Object.assign(fog4.under, { x: _mistColour.r, y: _mistColour.g, z: _mistColour.b });
    _cloudTop.lerp(_cloudSun.copy(this.sun.color).multiplyScalar(0.95), 0.6 * day).convertLinearToSRGB();
    Object.assign(fog4.top, { x: _cloudTop.r, y: _cloudTop.g, z: _cloudTop.b });
    this.scene.background.copy(fog.color);
    const su = this.sky.material.uniforms;
    // (In falling snow the sky is lost in it too.)
    su.skyFog.value = Math.min(1, falling * 1.4);
    su.skyFogColor.value.copy(fog.color).convertLinearToSRGB(); // (as the scene's fog uses it)
    this.clouds.uniforms.mistFade.value = Math.min(1, Math.max(grey * 1.3, falling * 1.5));
    // Sunlight through the mist above you, and below the low cloud.
    const overcast = camPos.y < lc.base ? lc.amount * 0.6 : 0;
    const dim = 1 - Math.max(veil * 0.75, overcast, inCloud * 0.8, Math.min(0.85, falling * 1.2));
    this.sun.intensity = (this.sunBase ?? this.sun.intensity) * dim;
    this.hemi.intensity = (this.hemiBase ?? this.hemi.intensity) * (1 + 0.15 * grey);
  }



  /**
   * Falling snow around the camera (every frame).
   * @param {number} screenH  drawing buffer height (pixels)
   */
  updateSnowfall(dt, wind, camera, screenH) {
    // Flakes take the colour of the light of the moment: the grey-white of
    // the snowy air, a little brighter.
    const c = this.scene.fog.color;
    this.snowfall.setLight(_cloudSun.setRGB(Math.min(1, c.r * 1.7), Math.min(1, c.g * 1.7), Math.min(1, c.b * 1.7)));
    this.snowfall.update(dt, wind, this.snow.falling, camera, screenH);
  }

  setClouds(cover) {
    this.clouds.setCover(cover);
  }

  /** Sunbeams through the gaps in the clouds (0 off .. 1). */
  setGodRays(k) {
    this.sky.material.uniforms.godRays.value = k;
  }

  /** The kind of clouds (src/world/clouds.js CLOUD_TYPES). */
  setCloudType(id) {
    if (id !== this.clouds.type) this.clouds.setType(id);
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
    const mat = addSnowCover(addCloudShadows(addGroundDetail(new MeshLambertMaterial({ map: tex, vertexColors: true }))));
    const ground = new Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.terrainMesh = ground;
    ground.userData.kind = 'terrain';
    this.builtScenery.push(ground);
  }

  #runway() {
    // A strip to draw, unless take-offs are just from the field's grass.
    if (RUNWAY.style !== 'none') {
      const g = new PlaneGeometry(RUNWAY.length, RUNWAY.width);
      g.rotateX(-Math.PI / 2);
      const tex = RUNWAY.style === 'cricket' ? cricketPitchTexture(RUNWAY) : runwayTexture();
      const rw = new Mesh(g, addSnowCover(addCloudShadows(new MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2 }))));
      // Just above the physics ground (y = 0); polygonOffset prevents z-fighting.
      rw.position.set(RUNWAY.x, 0.002, RUNWAY.z);
      rw.receiveShadow = true;
      rw.userData.kind = 'runway';
      this.club.add(rw);
      this.builtScenery.push(rw);
    }

    // Pilot box (gravel pad) and safety fence line, where the club has them.
    if (PILOT_PAD) {
      const pad = new Mesh(new PlaneGeometry(PILOT_PAD.length, PILOT_PAD.width), addSnowCover(addCloudShadows(new MeshLambertMaterial({ map: gravelTexture(), polygonOffset: true, polygonOffsetFactor: -2 }))));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(PILOT_PAD.x, 0.002, PILOT_PAD.z);
      pad.receiveShadow = true;
      this.club.add(pad);
    }
    const fence = this.obstacles.fence;
    if (!fence) return;
    const postGeo = new CylinderGeometry(0.04, 0.04, 1.1, 6);
    const postMat = new MeshStandardMaterial({ color: '#6b5b45' });
    const posts = new InstancedMesh(postGeo, postMat, fence.posts.length);
    const o = new Object3D();
    fence.posts.forEach((x, i) => {
      o.position.set(x, 0.55, fence.z);
      o.updateMatrix();
      posts.setMatrixAt(i, o.matrix);
    });
    posts.castShadow = true;
    this.club.add(posts);
    const rail = new Mesh(new BoxGeometry(fence.x1 - fence.x0, 0.04, 0.04), postMat);
    rail.position.set((fence.x0 + fence.x1) / 2, 1.0, fence.z);
    this.club.add(rail);
  }

  /**
   * Google photorealistic tiles on (or off): they replace the ground,
   * buildings and runway; the trees, hedges and fences (yours included) stay
   * on top, as Google's own look melted close up.
   */
  setGoogleMode(on) {
    this.googleMode = on;
    for (const o of this.builtScenery) o.visible = !on || KEEP_OVER_GOOGLE.has(o.userData.kind);
    for (const m of this.twigMeshes) m.visible = !!this.twigsOn; // bare branches only out of leaf
    if (this.shadows) this.shadows.dirty = true;
  }

  /**
   * The time of year (day 1-366): leaves (bare in winter, autumn colours,
   * fresh in spring) and grass. Bare crowns stop casting leafy shadows.
   */
  setSeason(day) {
    this.seasonDay = day;
    const s = seasonFor(day);
    leafUniforms.uBare.value = s.bare;
    leafUniforms.uAutumn.value = s.autumn;
    leafUniforms.uFresh.value = s.fresh;
    groundUniforms.uGrassTint.value.set(...s.grass);
    groundUniforms.uGrassDry.value = s.dry;
    groundUniforms.uGrassLen.value = s.length;
    // Branches show once leaves are going; leafy crowns' shadows follow their
    // leaves (the shadow map is only redrawn when they've changed a bit).
    // Leafy trees: each by its species (src/world/species.js).
    for (const lod of this.lods ?? []) {
      lod.setSeason(day);
      this.#syncTwigs(lod);
    }
    // Branches show once any tree's leaves are going (species differ).
    this.twigsOn = s.bare > 0.02 || (this.lods ?? []).some((l) => l.bare.some((b) => b > 0.02));
    for (const m of this.twigMeshes) m.visible = this.twigsOn;
    if (this.fluffy && Math.abs(s.bare - (this.shadowBare ?? -1)) > 0.04) {
      this.shadowBare = s.bare;
      if (this.shadows) this.shadows.dirty = true;
    }
    const leafy = s.bare < 0.5;
    if (leafy !== this.leafy) {
      this.leafy = leafy;
      // (Classic crowns only: leafy ones lose their shadow with their leaves.)
      for (const m of this.trees?.crowns ?? []) if (!m.userData.leafCards) m.castShadow = leafy;
      for (const o of this.siteObjects ?? []) if (o.userData.kind === 'bush' && !o.userData.leafCards) o.castShadow = leafy;
      if (this.shadows) this.shadows.dirty = true;
    }
  }

  /** Leaf sway and wind: time in seconds, wind speed m/s and direction it blows FROM (degrees). */
  updateTrees(t, windSpeed, windFromDeg) {
    leafUniforms.uLeafTime.value = t;
    leafUniforms.uWindSpeed.value = windSpeed;
    const from = (windFromDeg * Math.PI) / 180;
    leafUniforms.uWindDir.value.set(-Math.sin(from), 0, Math.cos(from));
  }

  /**
   * The site's trees, buildings and fences: what the scenery editor changes.
   * Built once, and again after each edit (rebuildSite).
   */
  #site() {
    this.siteObjects = [];
    this.twigMeshes = [];
    this.lods = [];
    const before = this.scene.children.length;
    this.#trees();
    const ob = this.obstacles;
    const q = this.quality;
    const near = { nearDetail: q.bushNear, nearRadius: Math.min(q.nearRadius, 250) };
    const bushFar = Math.min(this.viewDistance, q.bushDistance ?? Infinity);
    if (this.fluffy) {
      // Leafy near the camera, solid further away (src/world/lod.js).
      const list = ob.bushes.filter((b) => Math.hypot(b.x, b.z) <= bushFar);
      this.#addLod(new CrownLod(list, {
        matrix: (b, out) => bushMatrix(b, out),
        color: (b, out) => out.setHSL(...b.tint),
        shape: (b) => b.shape,
        species: (b) => bushSpeciesAt(b.x, b.z),
        bark: (b, out) => barkColor({ x: b.x, z: b.z, species: 'hawthorn' }, out),
        leafy: leafyBushShapes('blob'), // (bushes: the fewest, biggest cards)
        solid: [0, 1].map((k) => impostorGeometry(CROWN_SEEDS.length + k)),
        leafyMat: this.cardMat,
        solidMat: this.#impostorMat(),
        wood: {
          closeRadius: q.leafy.close ?? 0,
          plain: (k, sp) => this.#wood('plain', BUSH_SEEDS[k], sp, -0.9),
          close: (k, sp) => this.#wood('close', BUSH_SEEDS[k], sp, -0.9),
          plainMat: this.#plainWoodMat(),
          closeMat: this.#closeWoodMat(),
        },
        radius: q.leafy.radius, // (the same as the trees: one fade band)
        onDraw: (b, mesh, slot) => (b.drawn = [mesh, slot]),
      }), bushShapes('blob'), 'bush', list);
    } else {
      for (const m of bushes(this.leafMat, ob.bushes, { detail: q.bushDetail, ...near, distance: bushFar })) {
        m.userData.kind = 'bush';
        this.scene.add(m);
      }
    }
    if (ob.buildings.length) {
      const houses = buildingsMesh(ob.buildings);
      addSnowCover(addCloudShadows(houses.material));
      houses.userData.kind = 'building';
      this.scene.add(houses);
    }
    for (const f of ob.fences) {
      const o = siteFence(f);
      o.userData.kind = 'fence';
      o.userData.fenceIndex = f.index;
      o.traverse((m) => {
        if (!m.isMesh) return;
        m.userData.kind = 'fence';
        if (m.material && !m.material.userData.clouds) {
          addCloudShadows(m.material);
          m.material.userData.clouds = true;
        }
      });
      this.scene.add(o);
    }
    this.siteObjects = this.scene.children.slice(before);
    this.builtScenery.push(...this.siteObjects);
  }

  /** Redraw the site's trees, buildings and fences after the obstacles were reloaded with edits. */
  rebuildSite() {
    for (const o of this.siteObjects) {
      this.scene.remove(o);
      this.builtScenery.splice(this.builtScenery.indexOf(o), 1);
      o.traverse((m) => m.geometry?.dispose());
    }
    this.#site();
    this.placeWindsock();
    if (this.seasonDay != null) {
      this.leafy = undefined; // the new crowns' shadows follow the season too
      this.setSeason(this.seasonDay);
    }
    if (this.googleMode) this.setGoogleMode(true);
    if (this.shadows) this.shadows.dirty = true;
  }

  /** Put the windsock where the obstacles say (edited), or hide it. */
  placeWindsock() {
    const at = this.obstacles.windsock;
    this.windsockGroup.visible = !!at;
    if (at) this.windsockGroup.position.set(at.x, heightAt(at.x, at.z), at.z);
  }

  /** Redraw one bush as `spec` changes it (editor, before committing). */
  moveBushDrawing(b, spec) {
    if (!b.drawn) return;
    const [m, i] = b.drawn;
    m.setMatrixAt(i, bushMatrix({ ...b, ...spec }, _trunkM));
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
    if (m.userData.twigs) m.userData.twigs.frustumCulled = false;
  }

  /**
   * Redraw one tree as `spec` (its own x, z, h, crownW, base...), in the
   * slots it was drawn in: instant, for the editor while dragging or sliding.
   * The obstacles aren't changed until the edit is committed.
   */
  moveTreeDrawing(t, spec) {
    if (!t.drawn) return;
    const p = { ...t, ...spec };
    p.y = heightAt(p.x, p.z);
    const o = new Object3D();
    treeMatrices(p, o, _trunkM, _crownM);
    const [tm, ti] = t.drawn.trunk;
    const [cm, ci] = t.drawn.crown;
    tm.setMatrixAt(ti, _trunkM);
    cm.setMatrixAt(ci, _crownM);
    tm.instanceMatrix.needsUpdate = true;
    cm.instanceMatrix.needsUpdate = true;
    // Moved out of its set's bounds: don't let it be culled.
    tm.frustumCulled = false;
    cm.frustumCulled = false;
    if (cm.userData.twigs) cm.userData.twigs.frustumCulled = false;
  }

  #trees() {
    // Full-detail crowns near the pilot, simple ones further out, none
    // beyond the scenery distance (src/world/quality.js). Same layout and
    // crown shapes the physics collides with (src/sim/obstacles.js).
    const q = this.quality;
    const near = [];
    const far = [];
    // Leafy crowns (the costly part on a phone) only near the pilot; solid
    // ones beyond (quality.js `leafy`).
    const nearR = this.fluffy ? Math.min(q.nearRadius, q.leafy.radius) : q.nearRadius;
    for (const t of this.obstacles.trees) {
      const d = Math.hypot(t.x, t.z);
      if (d > this.viewDistance) continue;
      (d <= nearR ? near : far).push(t);
    }
    const leafMat = addLeafShading(addCloudShadows(new MeshLambertMaterial({ vertexColors: true })));
    this.leafMat = leafMat;
    const cardMat = this.fluffy ? addLodFade(makeFluffy(addLeafShading(addCloudShadows(new MeshLambertMaterial({ vertexColors: true }))), { smooth: q.leafy.smooth, detail: q.leafy.detail, softDepth: q.leafy.softDepth }), false) : null;
    this.cardMat = cardMat;
    // Bark: its colour per tree (instance colour, by species).
    const barkMat = addCloudShadows(new MeshLambertMaterial({ vertexColors: true }));
    this.barkMat = barkMat;
    const broadTrunkMat = this.fluffy ? addCloseSwitch(addCloudShadows(new MeshLambertMaterial({ vertexColors: true })), false) : barkMat;
    if (this.fluffy) closeUniforms.uCloseR.value = q.leafy.close ?? 0;
    // Conifers are open tiers of boughs: double-sided so their undersides show.
    const needleMat = addLeafShading(addCloudShadows(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide })));
    needleMat.defines = { CONIFER: '' };
    const conTrunk = coniferTrunk();
    // Leafy: the crowns are drawn by the level-of-detail sorters (leafy near
    // the camera, pictures beyond), so the classic solid crowns and conifers
    // aren't made at all (they took a good part of start-up).
    const SP = Object.keys(WOOD);
    const sets = this.fluffy
      ? [
        // Near trunks grown as their species grows them (where it forks, its
        // main limbs): a design per trunk pick and species.
        { trees: near, crowns: [], conifers: [], trunks: TRUNK_SEEDS.flatMap((seed) => SP.map((sp) => trunk(seed, false, WOOD[sp].trunk))),
          trunkIndex: (t) => (t.pick % 3) * SP.length + Math.max(0, SP.indexOf(speciesOf(t).name)) },
        { trees: far, crowns: [], conifers: [], trunks: [simpleTrunk()] },
      ]
      : [
        { trees: near, crowns: CROWN_SEEDS.map((s) => broadleafCrown(s, q.nearDetail)), trunks: [trunk(3), trunk(41), trunk(67)], conifers: [conifer(5), conifer(17), conifer(29)] },
        { trees: far, crowns: CROWN_SEEDS.map((s) => (q.farDetail === 'blob' ? blobCrown(s) : broadleafCrown(s, q.farDetail))), trunks: [simpleTrunk()], conifers: [conifer(5)] },
      ];
    const lodTrees = [];
    const lodConifers = [];
    this.trees = { trunks: [], conTrunks: [], crowns: [], conifers: [] };
    for (const set of sets) {
      if (!set.trees.length) continue;
      const count = set.trees.length;
      const mk = (geo, mat) => new InstancedMesh(geo, mat, count);
      // (Leafy style: the plain trunks give way to detailed ones close up.)
      const trunks = set.trunks.map((g) => mk(g, broadTrunkMat));
      const conTrunks = mk(conTrunk, barkMat);
      const crowns = set.crowns.map((g) => mk(g, set.leafMat ?? leafMat));
      const conifers = set.conifers.map((g) => mk(g, needleMat));
      const nTrunk = trunks.map(() => 0);
      const nCrown = crowns.map(() => 0);
      const nCon = conifers.map(() => 0);
      let nConTrunk = 0;
      const o = new Object3D();
      const col = new Color();
      for (const t of set.trees) {
        // Where this tree's trunk and crown are drawn: kept, so the editor
        // can move and resize it on the spot (moveTreeDrawing).
        const ti = set.trunkIndex ? set.trunkIndex(t) : t.pick % trunks.length;
        const trunkMesh = t.conifer ? conTrunks : trunks[ti];
        const trunkSlot = t.conifer ? nConTrunk++ : nTrunk[ti]++;
        treeMatrices(t, o, _trunkM, _crownM);
        trunkMesh.setMatrixAt(trunkSlot, _trunkM);
        trunkMesh.setColorAt(trunkSlot, barkColor(t, col));
        if (this.fluffy) {
          // Leafy style: crowns drawn by the level-of-detail sorters.
          t.drawn = { trunk: [trunkMesh, trunkSlot], crown: null };
          (t.conifer ? lodConifers : lodTrees).push(t);
          continue;
        }
        const crownMesh = t.conifer ? conifers[t.pick % conifers.length] : crowns[t.variant]; // the shape the collisions use
        const crownSlot = t.conifer ? nCon[t.pick % conifers.length]++ : nCrown[t.variant]++;
        t.drawn = { trunk: [trunkMesh, trunkSlot], crown: [crownMesh, crownSlot] };
        crownMesh.setMatrixAt(crownSlot, _crownM);
        // Leaf colour per tree, a little brighter than before (the shapes
        // carry their own shading).
        col.setHSL(t.hue, t.sat, t.light * 1.12 + 0.02);
        crownMesh.setColorAt(crownSlot, col);
      }
      crowns.forEach((m, k) => (m.count = nCrown[k]));
      conifers.forEach((m, k) => (m.count = nCon[k]));
      trunks.forEach((m, k) => (m.count = nTrunk[k]));
      conTrunks.count = nConTrunk;
      for (const m of [...trunks, conTrunks, ...crowns, ...conifers]) {
        if (!m.count) continue;
        m.castShadow = true;
        m.receiveShadow = true;
        // Cull a whole set when it's out of view (bounds of all its trees).
        m.computeBoundingSphere();
        m.userData.kind = 'tree';
        m.userData.trees = set.trees; // instance order isn't tree order: see treeAt in the editor
        this.scene.add(m);
      }
      this.trees.trunks.push(...trunks);
      this.trees.conTrunks.push(conTrunks);
      this.trees.crowns.push(...crowns);
      this.trees.conifers.push(...conifers);
    }
    if (this.fluffy && lodTrees.length) {
      const o = new Object3D();
      const lod = new CrownLod(lodTrees, {
        matrix: (t, out) => {
          treeMatrices(t, o, _trunkM, out);
          return out;
        },
        // A little brighter than the solid shapes (which carry their own shading).
        color: (t, out) => out.setHSL(t.hue, t.sat, t.light * 1.12 + 0.02),
        shape: (t) => t.variant, // the shape the collisions use
        species: (t) => speciesOf(t),
        bark: (t, out) => barkColor(t, out),
        leafy: CROWN_SEEDS.map((sd) => fluffyCrown(sd, q.leafy.detail)),
        solid: CROWN_SEEDS.map((_, k) => impostorGeometry(k)),
        leafyMat: cardMat,
        solidMat: this.#impostorMat(),
        radius: q.leafy.radius,
        // Its species' wood: plain branches with the leafy crown, detailed
        // branches and trunk near the camera.
        wood: {
          closeRadius: q.leafy.close ?? 0,
          plain: (k, sp) => this.#wood('plain', CROWN_SEEDS[k], sp),
          close: (k, sp) => this.#wood('close', CROWN_SEEDS[k], sp),
          trunk: (kind, sp) => this.#wood('trunk', TRUNK_SEEDS[kind], sp),
          plainMat: this.#plainWoodMat(),
          closeMat: this.#closeWoodMat(),
          trunkMat: this.closeTrunkMat ||= addCloseSwitch(addCloudShadows(new MeshLambertMaterial({ vertexColors: true })), true),
          trunkMatrix: (t, out) => {
            treeMatrices(t, o, out, _crownM);
            return out;
          },
          trunkKind: (t) => t.pick % 3, // as the plain near trunks
        },
        onDraw: (t, mesh, slot) => (t.drawn.crown = [mesh, slot]),
      });
      this.#addLod(lod, CROWN_SEEDS.map((sd) => blobCrown(sd)), 'tree', lodTrees);
      this.trees.crowns.push(...lod.meshes, ...lod.shadows);
    }
    if (this.fluffy && lodConifers.length) {
      // Conifers: a shape per species (src/world/species.js CONIFER), the
      // crown drawn centred, its height from its base to the top.
      const o = new Object3D();
      const lod = new CrownLod(lodConifers, {
        matrix: (t, out) => {
          const c = crownOf(t);
          o.position.set(t.x, c.y0 + c.ch / 2, t.z);
          o.rotation.set(0, t.rot, 0);
          o.scale.set(c.r, c.ch, c.r);
          o.updateMatrix();
          return out.copy(o.matrix);
        },
        color: (t, out) => out.setHSL(t.hue, t.sat, t.light * 1.12 + 0.02),
        shape: (t) => Math.max(0, CONIFER_NAMES.indexOf(speciesOf(t).name)),
        species: (t) => speciesOf(t),
        bark: (t, out) => barkColor(t, out),
        leafy: CONIFER_NAMES.map((sp) => fluffyConifer(CONIFER[sp], 11, q.leafy.detail)),
        solid: CONIFER_NAMES.map((_, k) => impostorGeometry(CROWN_SEEDS.length + 2 + k)),
        leafyMat: cardMat,
        solidMat: this.#impostorMat(),
        radius: q.leafy.radius,
        wood: {
          closeRadius: q.leafy.close ?? 0,
          plain: (k, sp) => this.#wood('coniferPlain', 11, CONIFER_NAMES[k]),
          close: (k, sp) => this.#wood('coniferClose', 11, CONIFER_NAMES[k]),
          plainMat: this.#plainWoodMat(),
          closeMat: this.#closeWoodMat(),
        },
        onDraw: (t, mesh, slot) => (t.drawn.crown = [mesh, slot]),
      });
      // (Their boughs always show: evergreens' tiers hang on them.)
      this.#addLod(lod, CONIFER_NAMES.map(() => new ConeGeometry(1, 1, 8)), 'tree', lodConifers, { woodAlways: true });
      this.trees.crowns.push(...lod.meshes, ...lod.shadows);
    }
  }

  /**
   * Add a level-of-detail crown set to the scene: its leafy meshes cast
   * leaf-card shadows and get bare branches (sharing their matrices).
   */
  #addLod(lod, shadowShapes, kind, list, { woodAlways = false } = {}) {
    this.lods.push(lod);
    // The pictures: no shadows of their own (and none falling on them, which
    // would cut across the card); plain shapes cast them instead.
    for (const m of lod.solid) {
      m.userData.leafCards = true;
      pickAsBall(m);
    }
    lod.shadows = lod.solid.map((m, k) => {
      const sh = new InstancedMesh(shadowShapes[k], this.leafMat, 1);
      sh.instanceMatrix = m.instanceMatrix;
      sh.layers.set(1);
      return sh;
    });
    for (const m of lod.leafy) {
      m.userData.leafCards = true;
      m.customDepthMaterial = fluffyDepthMaterial(this.quality.leafy.detail);
      pickAsBall(m);
    }
    lod.update(this.lodAt?.x ?? 0, this.lodAt?.z ?? 0, true);
    if (this.seasonDay != null) lod.setSeason(this.seasonDay);
    this.#syncTwigs(lod);
    for (const m of [...lod.meshes, ...lod.shadows]) {
      m.castShadow = !lod.solid.includes(m);
      // Leaf cards take shadows too (the dark gaps between tufts); the
      // pictures don't (their card would cut across them).
      m.receiveShadow = !lod.solid.includes(m) && !lod.shadows.includes(m);
      m.userData.kind = kind;
      if (kind === 'tree') m.userData.trees = list;
      this.scene.add(m);
    }
    // The wood: plain branches (with the leafy crowns), and close up the
    // detailed branches and trunks, each kind made when first needed (so
    // set up as it arrives). Branches show only out of leaf.
    const addWood = (m) => {
      const role = m.userData.role;
      m.castShadow = role === 'twigs'; // (the plain ones cast the shadows)
      m.receiveShadow = true;
      m.userData.kind = kind;
      if (kind === 'tree') m.userData.trees = list;
      this.scene.add(m);
      if (role !== 'closeTrunk' && !woodAlways) {
        this.twigMeshes.push(m);
        m.visible = this.twigsOn ?? true;
      }
      if (this.shadows && role === 'twigs') this.shadows.dirty = true;
    };
    for (const m of lod.woodMeshes) addWood(m);
    if (lod.o.wood) lod.o.wood.added = addWood;
  }

  /** A species' wood (cached): plain or close-up branches for a crown shape, or a close-up trunk. */
  #wood(kind, seed, sp, from) {
    this.woodCache ||= new Map();
    const key = `${kind}|${seed}|${sp}|${from ?? ''}`;
    if (!this.woodCache.has(key)) {
      const w = WOOD[sp] ?? {};
      let geo;
      if (kind === 'trunk') geo = trunk(seed, true, w.trunk);
      else if (kind.startsWith('conifer')) geo = coniferWood(CONIFER[sp], seed, { close: kind === 'coniferClose' });
      else geo = crownWood(seed, { from, wood: w.crown, close: kind === 'close' });
      this.woodCache.set(key, geo);
    }
    return this.woodCache.get(key);
  }

  /** The plain branches: bark coloured, fading with their crowns, away from the camera. */
  #plainWoodMat() {
    return (this.twigMat ||= addCloseSwitch(addLodFade(addCloudShadows(new MeshLambertMaterial({ color: 0xaaaaaa, vertexColors: true })), false), false));
  }

  #syncTwigs(lod) {
    lod.shadows.forEach((sh, k) => {
      sh.count = lod.solid[k].count;
      sh.boundingSphere = lod.sphere;
    });
  }

  /** Close-up branches: bark coloured, only near the camera. */
  #closeWoodMat() {
    return (this.closeWoodMat ||= addCloseSwitch(addCloudShadows(new MeshLambertMaterial({ color: 0xaaaaaa, vertexColors: true })), true));
  }

  /** The distant trees' material: pictures of the leafy crowns, drawn once. */
  #impostorMat() {
    if (this.impMat) return this.impMat;
    // Each shape drawn at its trees' typical height for their width (their
    // leaf tufts round), so the pictures match the leafy trees.
    const ob = this.obstacles;
    const avg = (list, f, dflt) => (list.length ? list.reduce((a, x) => a + f(x), 0) / list.length : dflt);
    const broad = ob.trees.filter((t) => !t.conifer);
    const treeR = (sd) => avg(broad.filter((t) => CROWN_SEEDS[t.variant] === sd), (t) => crownOf(t).sy / crownOf(t).sx, 1.8);
    const bushR = avg(ob.bushes, (b) => (b.h * 0.55) / b.w, 1);
    const coniferR = (sp) => avg(ob.trees.filter((t) => t.conifer && speciesOf(t).name === sp), (t) => crownOf(t).ch / crownOf(t).r, (1 - CONIFER[sp].base) / CONIFER[sp].crownW);
    // Columns: the broadleaf crowns, the bushes, then a conifer per species.
    // Only the shapes this site has are drawn (no conifer pictures at a
    // site without conifers): the rest are left empty.
    const has = new Set(ob.trees.filter((t) => t.conifer).map((t) => speciesOf(t).name));
    const anyBroad = broad.length > 0;
    const anyBush = ob.bushes.length > 0;
    const shapes = [
      // (Drawn from the same cards as the leafy ones at this quality.)
      ...CROWN_SEEDS.map((sd) => (anyBroad ? { leafy: fluffyCrown(sd, this.quality.leafy.detail), twigs: crownWood(sd), stretch: treeR(sd) } : null)),
      ...(anyBush ? leafyBushShapes('blob').map((g, k) => ({ leafy: g, twigs: bushTwigShapes()[k], leafRow: LEAF_ROWS.indexOf('hawthorn'), stretch: bushR })) : [null, null]),
      ...CONIFER_NAMES.map((sp) => (has.has(sp) ? { leafy: fluffyConifer(CONIFER[sp], 11, this.quality.leafy.detail), twigs: coniferWood(CONIFER[sp], 11), leafRow: LEAF_ROWS.indexOf(leafName(sp)), stretch: coniferR(sp) } : null)),
    ];
    const atlas = bakeImpostors(this.renderer, shapes, this.quality.leafy.tile);
    this.impMat = addLodFade(makeImpostor(addLeafShading(addCloudShadows(new MeshLambertMaterial())), atlas), true);
    return this.impMat;
  }

  /** Leafy crowns follow the camera (src/world/lod.js): call every frame. */
  updateLod(camPos) {
    this.lodAt = { x: camPos.x, z: camPos.z };
    for (const lod of this.lods ?? []) if (lod.update(camPos.x, camPos.z)) this.#syncTwigs(lod);
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
    // (Still worked out where a site has none: it's just not shown.)
    this.windsockGroup = ws;
    this.placeWindsock();
    this.scene.add(ws);
    this.windsock = sock;
    this.sockMesh = sockMesh;
    this.sockState = { yaw: 0, yawRate: 0, droop: 1.5, flutter: 0 };

    // Club scenery (placement and collisions from src/sim/obstacles.js).
    const ob = this.obstacles;
    const shadowy = (o) => o.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      if (m.material && !m.material.userData.clouds) {
        addSnowCover(addCloudShadows(m.material));
        m.material.userData.clouds = true;
      }
    });
    // Pits and club buildings in the club frame; cars and site fences in the world.
    const clubThings = ob.gazebo ? [gazebo(ob.gazebo)] : [];
    if (ob.hut) clubThings.push(clubhouse(ob.hut));
    if (ob.container) clubThings.push(shippingContainer(ob.container));
    for (const o of clubThings) {
      shadowy(o);
      this.club.add(o);
    }
    for (const o of ob.cars.map(car)) {
      shadowy(o);
      o.userData.kind = 'car';
      this.scene.add(o);
      this.builtScenery.push(o);
    }

    // Flight-line table
    if (!ob.table) return;
    const tx = ob.table.x;
    const tz = ob.table.z;
    const table = new Mesh(new BoxGeometry(2, 0.06, 0.8), new MeshStandardMaterial({ color: '#c8c8c8' }));
    table.position.set(tx, 0.75, tz);
    table.castShadow = true;
    shadowy(table);
    this.club.add(table);
    for (const dx of [-0.9, 0.9]) {
      for (const dz of [-0.3, 0.3]) {
        const leg = new Mesh(new CylinderGeometry(0.02, 0.02, 0.75), table.material);
        leg.position.set(tx + dx, 0.375, tz + dz);
        this.club.add(leg);
      }
    }
  }

  /**
   * Swing the windsock with the wind (world velocity vector). It has some
   * weight: it turns towards the wind faster the stronger it blows (in calm
   * air it stays where it was), fills out from about 1 m/s, is straight out
   * by about 7 m/s, and hangs limp down the pole when there's no wind.
   */
  updateWindsock(wind, dt, t = 0) {
    const st = this.sockState;
    dt = Math.min(dt, 0.05);
    const speed = Math.hypot(wind.x, wind.z);
    // Sock tail points downwind (sock geometry extends along -x).
    const target = Math.atan2(wind.z, -wind.x);
    let diff = target - st.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    // Aerodynamic pull grows with speed²; damping keeps it from spinning.
    const fill = Math.min(1, Math.max(0, (speed - 0.5) / 6.5)); // 0 limp .. 1 full
    st.yawRate += (diff * speed * speed * 0.6 * fill - st.yawRate * (1.5 + 2 * speed)) * dt;
    st.yaw += st.yawRate * dt;
    // Droop: hanging straight down when limp, horizontal when full.
    const droopTarget = 1.5 * (1 - fill) ** 1.4;
    // Falls under gravity quickly, lifts as fast as the wind fills it.
    const k = droopTarget > st.droop ? 1.6 : 0.8 + speed * 0.4;
    st.droop += (droopTarget - st.droop) * Math.min(1, k * dt);
    // A little flapping of the fabric in a breeze.
    const flap = fill * (1 - fill * 0.6) * 0.06 * Math.sin(t * (4 + speed)) ;
    this.windsock.rotation.set(0, st.yaw, 0);
    this.windsock.rotateZ(st.droop + flap);
    // Limp fabric folds up thinner.
    const r = 0.55 + 0.45 * Math.min(1, fill * 1.6);
    this.sockMesh.scale.set(1, r, r);
  }
}
