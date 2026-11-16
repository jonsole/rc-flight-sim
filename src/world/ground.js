// Ground detail, drawn per pixel from the world position so it stays crisp
// at any distance from the coarse terrain grid:
//  - the grass texture sampled twice at different scales and angles, so its
//    repeat doesn't show;
//  - mown, striped grass around the runway and pits; field grass; longer,
//    darker rough beyond the flying field (the same boundary the physics
//    uses for its surfaces);
//  - a patchwork of farm fields with hedgerows on the hills;
//  - a dirt track and a gravel car park by the club hut.
// At a real site the baked colour map (roads, paths, water, gardens, fields
// from OpenStreetMap) replaces the made-up zones, with the grass texture's
// detail on top; the made-up farmland only carries on beyond it.
import { CanvasTexture, SRGBColorSpace, Vector2, Vector3, RepeatWrapping, NoColorSpace } from 'three';
import { RUNWAY } from '../sim/terrain.js';
import { LOCATION, clubAngle } from '../sim/location.js';

const FIELD = { x: 0, z: -40, r: 260 };

/** Grass colour for the season (src/world/seasons.js), shared by the ground's shader. */
export const groundUniforms = {
  uGrassTint: { value: new Vector3(1, 1, 1) },
  uGrassDry: { value: 0 }, // late summer: long grass yellows more than mown
  uGrassLen: { value: 0 }, // how long the grass is grown (0-1): coarser blades
};

/** GLSL polyFieldDist(p): distance outside a polygon field (0 inside). */
function polyGlsl() {
  const poly = LOCATION.layout.field.poly;
  if (!poly) return '';
  const v = (q) => `vec2(${q[0].toFixed(1)}, ${q[1].toFixed(1)})`;
  const edges = poly.map((q, i) => [q, poly[(i + 1) % poly.length]]);
  return `float polyFieldDist(vec2 p) {
  float d = 1e9;
  bool inside = false;
  vec2 a, b;
  ${edges.map(([a, b]) => `a = ${v(a)}; b = ${v(b)};
  d = min(d, segDist(p, a, b));
  if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;`).join('\n  ')}
  return inside ? 0.0 : d;
}`;
}

/** GLSL: distance outside the club's field (0 on it). */
function fieldDist() {
  const f = LOCATION.layout.field;
  if (f.poly) return 'polyFieldDist(p)';
  if (f.r !== undefined) return `max(0.0, length(p - vec2(${f.x.toFixed(1)}, ${f.z.toFixed(1)})) - ${f.r.toFixed(1)})`;
  return `rectDist(p, vec2(${((f.x0 + f.x1) / 2).toFixed(1)}, ${((f.z0 + f.z1) / 2).toFixed(1)}), vec2(${((f.x1 - f.x0) / 2).toFixed(1)}, ${((f.z1 - f.z0) / 2).toFixed(1)}))`;
}

/**
 * GLSL for a site's mown areas (layout.mown): sets `mown` (0..1) and
 * darkens the long grass around them; ovals are cut in rings, rectangles
 * in stripes. Nothing without a list (the runway-and-pits zone stays).
 */
function mownGlsl() {
  const list = LOCATION.layout.mown;
  if (!list) return '';
  const f = (v) => v.toFixed(2);
  const parts = list.map((a, i) => {
    if (a.oval) {
      const r = Math.min(a.rx, a.rz);
      return `{
          vec2 q = abs(${a.club ? 'pc' : 'p'} - vec2(${f(a.oval[0])}, ${f(a.oval[1])})) / vec2(${f(a.rx)}, ${f(a.rz)});
          float d = pow(pow(q.x, ${f(a.p)}) + pow(q.y, ${f(a.p)}), ${f(1 / a.p)});
          float m${i} = 1.0 - smoothstep(1.0 - 0.6 / ${f(r)}, 1.0 + 0.6 / ${f(r)}, d);
          float ring = step(0.5, fract(d * ${f(r)} / 2.2));
          cut = max(cut, m${i});
          pattern = mix(pattern, ring, m${i});
        }`;
    }
    return `{
          float m${i} = 1.0 - smoothstep(0.0, 0.6, rectDist(p, vec2(${f((a.x0 + a.x1) / 2)}, ${f((a.z0 + a.z1) / 2)}), vec2(${f((a.x1 - a.x0) / 2)}, ${f((a.z1 - a.z0) / 2)})));
          float stripe = step(0.5, fract((p.x - ${f(a.x0)}) / 5.0));
          cut = max(cut, m${i});
          pattern = mix(pattern, stripe, m${i});
        }`;
  });
  return `        float cut = 0.0;
        float pattern = 0.0;
        ${parts.join('\n        ')}
        // Long grass: darker, browner, tufty. Cut grass: paler, in its pattern.
        vec3 longGrass = g * vec3(0.86, 0.84, 0.66) * (0.85 + 0.3 * gNoise(p / 2.5));
        vec3 shortGrass = g * vec3(1.04, 1.06, 0.94) * (1.0 + 0.08 * pattern);
        g = mix(longGrass, shortGrass, cut);
        mown = max(cut, 1.0 - smoothstep(0.0, 1.5, dRunway));`;
}

/**
 * Close-up grass: a metre of blades, drawn as brightness and tint (not
 * colour: 0.5 is no change), dark gaps between them, lighter tips. Laid
 * over the ground near the camera (addGroundDetail) at two scales, so close
 * up you see blades, not a smooth green.
 */
let fineTex = null;
const fineMean = { x: 0.5 };
function grassFineTexture() {
  if (fineTex) return fineTex;
  const N = 512;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // The shade at the base of the sward.
  g.fillStyle = 'rgb(92, 96, 88)';
  g.fillRect(0, 0, N, N);
  g.lineCap = 'round';
  // Blades, shortest and darkest first, longer, lighter ones on top; drawn
  // wrapping round the edges so the tile repeats seamlessly.
  for (let i = 0; i < 14000; i++) {
    const k = i / 14000;
    const x = rnd() * N;
    const y = rnd() * N;
    const len = 6 + rnd() * 14 + k * 8;
    const a = rnd() * Math.PI * 2; // seen from above: every way
    const v = 104 + k * 50 + rnd() * 30;
    const yel = rnd() * 14; // some yellower, some bluer
    g.strokeStyle = `rgb(${Math.round(v + yel)}, ${Math.round(v + 4)}, ${Math.round(v - 10 - yel)})`;
    g.lineWidth = 1.6 + rnd() * 1.8;
    for (const ox of [-N, 0, N]) {
      for (const oy of [-N, 0, N]) {
        const x0 = x + ox;
        const y0 = y + oy;
        if (x0 < -40 || x0 > N + 40 || y0 < -40 || y0 > N + 40) continue;
        g.beginPath();
        g.moveTo(x0, y0);
        g.quadraticCurveTo(x0 + Math.cos(a) * len * 0.6 + 2, y0 + Math.sin(a) * len * 0.6, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
        g.stroke();
      }
    }
  }
  // Its average brightness, to scale it to no change on average.
  const px = g.getImageData(0, 0, N, N).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
  fineMean.x = sum / (px.length / 4) / 3 / 255;
  fineTex = new CanvasTexture(c);
  fineTex.wrapS = fineTex.wrapT = RepeatWrapping;
  fineTex.colorSpace = NoColorSpace;
  fineTex.anisotropy = 8;
  return fineTex;
}

function realGround() {
  const d = LOCATION.data;
  if (!d?.groundImage) return null;
  const tex = new CanvasTexture(d.groundImage);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, origin: new Vector2(d.ground.x0, d.ground.z0), size: d.ground.size };
}

// Track: from the car park by the hut, out through the field gate and away.
const TRACK = [[-36, 32], [-70, 60], [-150, 95], [-260, 120], [-420, 210], [-700, 260]];
const CAR_PARK = { x0: -46, x1: -31, z0: 22, z1: 40 };

const GLSL = /* glsl */ `
varying vec3 vGroundWorld;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * gNoise(p); p = p * 2.07 + vec2(5.3, 1.7); a *= 0.5; }
  return s;
}
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// Distance outside an axis-aligned rectangle (0 inside).
float rectDist(vec2 p, vec2 c, vec2 half_) {
  vec2 d = abs(p - c) - half_;
  return length(max(d, 0.0));
}
`;

function vec2s(pts) {
  return pts.map(([x, z]) => `vec2(${x.toFixed(1)}, ${z.toFixed(1)})`);
}

/** Add the ground detail to the terrain's MeshStandardMaterial. */
export function addGroundDetail(material) {
  const prev = material.onBeforeCompile;
  const real = realGround();
  const track = vec2s(TRACK);
  const trackDist = track.slice(1).map((b, i) => `segDist(p, ${track[i]}, ${b})`).reduce((a, b) => `min(${a}, ${b})`);
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, groundUniforms);
    shader.uniforms.grassFine = { value: grassFineTexture() };
    shader.uniforms.grassFineMean = { value: fineMean.x };
    if (real) {
      shader.uniforms.groundMap = { value: real.tex };
      shader.uniforms.groundOrigin = { value: real.origin };
      shader.uniforms.groundSize = { value: real.size };
      shader.defines = { ...shader.defines, REAL_GROUND: '' };
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}\n${polyGlsl()}\nuniform vec3 uGrassTint;\nuniform float uGrassDry;\nuniform float uGrassLen;\nuniform sampler2D grassFine;\nuniform float grassFineMean;\n#ifdef REAL_GROUND\nuniform sampler2D groundMap; uniform vec2 groundOrigin; uniform float groundSize;\n#endif`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec2 p = vGroundWorld.xz;
        // Grass texture at two scales and angles, blended by a slow noise,
        // so no repeat pattern shows.
        vec2 uvA = vMapUv;
        vec2 q = p / 6.0;
        vec2 uvB = vec2(q.x * 0.81 - q.y * 0.59, q.x * 0.59 + q.y * 0.81) * 0.43 + 0.37;
        float mixAB = smoothstep(0.3, 0.7, gNoise(p / 37.0));
        vec4 grass = mix(texture2D(map, uvA), texture2D(map, uvB), mixAB);
        vec3 g = grass.rgb;
        // Large, soft patches of slightly lighter and darker grass.
        float patches = gFbm(p / 31.0);
        g *= 0.94 + 0.12 * patches;

        // Zones: mown around the runway and pits, field grass, then rough.
        float rField = length(p - vec2(${FIELD.x.toFixed(1)}, ${FIELD.z.toFixed(1)}));
        // The runway and pits are laid out in the club frame.
        vec2 pc = vec2(p.x * ${Math.cos(clubAngle()).toFixed(6)} + p.y * ${Math.sin(clubAngle()).toFixed(6)}, -p.x * ${Math.sin(clubAngle()).toFixed(6)} + p.y * ${Math.cos(clubAngle()).toFixed(6)});
        float dRunway = rectDist(pc, vec2(${RUNWAY.x.toFixed(1)}, ${RUNWAY.z.toFixed(1)}), vec2(${(RUNWAY.length / 2).toFixed(2)}, ${(RUNWAY.width / 2).toFixed(2)}));
        float dPits = rectDist(pc, vec2(-8.0, 12.0), vec2(40.0, 16.0));
        float mown = ${LOCATION.layout.mown ? '0.0' : '1.0 - smoothstep(18.0, 26.0, min(dRunway, dPits))'};
        // Mowing stripes along the runway, 3.5 m wide.
        float stripe = step(0.5, fract(pc.y / 7.0));
        g *= mix(1.0, 1.0 + 0.07 * stripe, mown);
        g = mix(g, g * vec3(1.02, 1.05, 0.95), mown); // short grass is a fresher green
#ifdef REAL_GROUND
        // The site's own colour map, with the grass texture's detail and
        // the soft patches on top (by brightness, so roads stay grey).
        vec2 guv = (p - groundOrigin) / groundSize;
        vec2 gEdge = min(guv, 1.0 - guv) * groundSize;
        float inMap = smoothstep(0.0, 60.0, min(gEdge.x, gEdge.y));
        vec3 site = texture2D(groundMap, vec2(guv.x, 1.0 - guv.y)).rgb;
        float detail = dot(grass.rgb, vec3(0.2126, 0.7152, 0.0722)) / 0.2;
        site *= mix(1.0, detail, 0.75) * (0.94 + 0.12 * patches);
        // The club's field is grass; short-cut areas are fresher, with their
        // mowing pattern, and the rest of the field is longer and browner.
        float onField = 1.0 - smoothstep(0.0, 8.0, ${fieldDist()});
${mownGlsl()}
        site = mix(site, g, max(mown, onField * 0.9));
        g = mix(g, site, inMap);
        float farm = 1.0 - inMap;
#else
        // Rough: longer, darker, browner grass with seed heads.
        float rough = smoothstep(${(FIELD.r - 15).toFixed(1)}, ${(FIELD.r + 25).toFixed(1)}, rField);
        vec3 roughCol = g * vec3(0.9, 0.86, 0.68) * (0.85 + 0.3 * gNoise(p / 3.0));
        g = mix(g, roughCol, rough);

        // Farmland beyond: fields on a jittered grid, each its own crop,
        // with dark hedgerows along the boundaries.
        float farm = smoothstep(380.0, 470.0, rField);
#endif
        if (farm > 0.0) {
          vec2 fp = vec2(p.x * 0.96 + p.y * 0.28, -p.x * 0.28 + p.y * 0.96); // fields don't line up with the runway
          vec2 cellSize = vec2(190.0, 140.0);
          vec2 cell = floor(fp / cellSize);
          vec2 f = fract(fp / cellSize);
          // Wobbly boundaries.
          vec2 wob = vec2(gNoise(fp / 60.0 + 3.0), gNoise(fp / 60.0 + 9.0)) - 0.5;
          f += wob * 0.08;
          float h = gHash(cell);
          vec3 field;
          if (h < 0.42) field = g * vec3(1.05, 1.08, 0.95);                      // pasture
          else if (h < 0.58) field = vec3(0.62, 0.55, 0.32) * (0.9 + 0.2 * gNoise(fp / 4.0)); // stubble
          else if (h < 0.7) field = vec3(0.36, 0.27, 0.19) * (0.8 + 0.35 * step(0.5, fract(fp.x / 1.6))); // ploughed, furrows
          else if (h < 0.86) field = vec3(0.42, 0.58, 0.22) * (0.85 + 0.3 * step(0.5, fract(fp.y / 2.2))); // crop rows
          else field = vec3(0.55, 0.62, 0.3) * (0.9 + 0.2 * gNoise(fp / 8.0));   // hay meadow
          // Hedgerows: 3 m wide, dark and lumpy.
          vec2 edge = min(f, 1.0 - f) * cellSize;
          float hedge = 1.0 - smoothstep(1.2, 3.2, min(edge.x, edge.y));
          vec3 hedgeCol = vec3(0.12, 0.2, 0.08) * (0.7 + 0.6 * gNoise(fp / 2.0));
          field = mix(field, hedgeCol, hedge);
          g = mix(g, field, farm);
        }

#ifndef REAL_GROUND
        // Dirt track and gravel car park by the club hut.
        float dTrack = ${trackDist};
        float trackMix = 1.0 - smoothstep(1.4, 2.4, dTrack);
        float ruts = 0.85 + 0.25 * smoothstep(0.2, 0.8, abs(dTrack - 0.9));
        vec3 dirt = vec3(0.45, 0.38, 0.28) * ruts * (0.85 + 0.3 * gNoise(p * 1.7));
        // Grass growing down the middle of the track.
        dirt = mix(dirt, g, (1.0 - smoothstep(0.25, 0.5, dTrack)) * 0.8);
        g = mix(g, dirt, trackMix);
        float dPark = rectDist(p, vec2(${((CAR_PARK.x0 + CAR_PARK.x1) / 2).toFixed(1)}, ${((CAR_PARK.z0 + CAR_PARK.z1) / 2).toFixed(1)}), vec2(${((CAR_PARK.x1 - CAR_PARK.x0) / 2).toFixed(1)}, ${((CAR_PARK.z1 - CAR_PARK.z0) / 2).toFixed(1)}));
        vec3 gravel = vec3(0.42, 0.39, 0.33) * (0.75 + 0.35 * gHash(floor(p * 9.0))) * (0.9 + 0.2 * gNoise(p / 3.0));
        g = mix(g, gravel, 1.0 - smoothstep(0.0, 0.8, dPark));
#endif

        // The season: on green (grassy) ground only, not roads and paths.
        float grassy = smoothstep(0.0, 0.06, g.g - max(g.r, g.b));
        // Close up: blades (grassFineTexture) at two scales and angles, and
        // tufts, fading out with distance (where they'd only shimmer). Longer
        // grass coarser and more uneven than the mown.
        {
          float camD = length(vGroundWorld - cameraPosition);
          // How long it is here: rough grass long, mown short (longer in
          // autumn, and the mown grass a little too).
          float len = clamp((1.0 - mown) * (0.75 + 0.25 * uGrassLen) + mown * 0.35 * uGrassLen, 0.0, 1.0);
          float near = 1.0 - smoothstep(10.0, 70.0 + 50.0 * len, camD);
          if (near > 0.0 && grassy > 0.0) {
            vec2 r1 = vec2(p.x * 0.94 - p.y * 0.34, p.x * 0.34 + p.y * 0.94);
            vec3 b1 = texture2D(grassFine, r1 / 0.9).rgb;
            vec3 b2 = texture2D(grassFine, vec2(p.y, -p.x) / 0.37 + 0.31).rgb;
            vec3 blades = mix(b1, b2, 0.4) / grassFineMean; // (1 on average)
            // Long grass: big coarse blades and deep tufts with shadowed
            // hollows between them.
            vec3 b3 = texture2D(grassFine, vec2(p.x * 0.6 + p.y * 0.8, -p.x * 0.8 + p.y * 0.6) / 2.6 + 0.17).rgb / grassFineMean;
            blades = mix(blades, mix(blades, b3, 0.6), len);
            vec3 contrast = mix(vec3(0.85), vec3(1.25), len);
            blades = 1.0 + (blades - 1.0) * contrast;
            float tuft = mix(0.92 + 0.16 * gNoise(p / 0.45), 0.72 + 0.56 * gNoise(p / 0.8) * gNoise(p / 2.3 + 5.0) * 1.6, len);
            float k = near * grassy;
            g *= mix(vec3(1.0), blades * tuft, k);
          }
        }
        g *= mix(vec3(1.0), uGrassTint, grassy);
        // Long grass (off the mown areas) dries out more: straw yellow.
        g *= mix(vec3(1.0), vec3(1.12, 1.0, 0.72), uGrassDry * (1.0 - mown) * grassy);
        diffuseColor.rgb *= g;
      `);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|groundDetail${real ? '|real' : ''}`;
  material.needsUpdate = true;
  return material;
}

export { TRACK, CAR_PARK };
