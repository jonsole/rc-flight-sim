// Snow (Menu → Weather → Snow): snow lying on the ground and on roofs, and
// snow falling.
//
//   cover    0 none .. 1 a full white cover (patchy in between: grass and
//            the darker ground show through first)
//   falling  0 none .. 1 heavy snowfall (light snow ~0.35)
//
// Seasonal: snow is rare in lowland England. Some days from December to
// February (most likely in January and early February) have snow lying,
// and on some of those it is snowing.
//
// Lying snow is added to a material's colour (addSnowCover) on surfaces
// that face up: the ground, runway and pad, roofs, the tops of things.
// Falling snow: src/world/snowfall.js, and the air thickens with it
// (src/world/volfog.js: fog4.under.w).

import { LAKE_GLSL } from '../sim/lake.js';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);

/**
 * Snow for the settings, day of the year and time of day.
 * @returns {{ cover: number, falling: number }}
 */
export function snowFor(settings, day, hours) {
  switch (settings.snow) {
    case 'off': return { cover: 0, falling: 0 };
    case 'lying': return { cover: 1, falling: 0 };
    case 'dusting': return { cover: 0.45, falling: 0 };
    case 'light': return { cover: 0.6, falling: 0.35 };
    case 'heavy': return { cover: 1, falling: 1 };
    default: break;
  }
  // Seasonal: how wintry the day is (0 .. 1), peaking mid January to early
  // February (the day wraps at the year end).
  const d = day < 182 ? day + 365 : day;
  const winter = smooth(340, 380, d) * (1 - smooth(400, 430, d));
  if (winter <= 0) return { cover: 0, falling: 0 };
  // The day's own luck (other numbers than the mist's: src/world/mist.js).
  const r = (k) => fract(Math.sin(day * 91.3458 + k * 47.853) * 24634.6345);
  if (r(1) > 0.22 * winter) return { cover: 0, falling: 0 };
  // A snowy day: lying all day (thinning a little through a sunny
  // afternoon), snowing in spells.
  const cover = (0.4 + 0.6 * r(2)) * (1 - 0.25 * smooth(11, 15, hours) * r(3));
  let falling = 0;
  if (r(4) < 0.55) {
    // A spell of snow, a few hours long.
    const start = 4 + r(5) * 14;
    const len = 2 + r(6) * 6;
    falling = smooth(start - 0.5, start + 0.5, hours) * (1 - smooth(start + len - 0.5, start + len + 0.5, hours)) * (0.25 + 0.75 * r(7));
  }
  return { cover: Math.min(1, cover + 0.3 * falling), falling };
}

/** Shared by every material with snow cover. */
export const snowUniforms = {
  uSnow: { value: 0 }, // cover, 0-1
};

/** How far you can see (m) in falling snow of this amount (0-1), or Infinity. */
export function snowVisibility(falling) {
  if (falling <= 0) return Infinity;
  // Light snow ~2 km, heavy ~300 m.
  return 300 / Math.pow(falling, 1.6);
}

/**
 * The lying snow's pattern (GLSL), shared by everything with snow cover and
 * the tracks in it (src/world/snowTracks.js), so they agree where it lies:
 * snPatch(xz) is 0-1; snow lies where it's above snowThreshold(amount).
 */
export const SNOW_GLSL = /* glsl */ `
float snHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float snNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = snHash(i), b = snHash(i + vec2(1.0, 0.0)), c = snHash(i + vec2(0.0, 1.0)), d = snHash(i + vec2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
// Drifts and bare patches (metres to tens of metres), and the grass poking
// through close up. Each octave turned and the whole gently warped, so no
// square grid shows in the edges.
float snPatch(vec2 sp) {
  vec2 w = sp + 6.0 * vec2(snNoise(sp / 17.0 + 11.0), snNoise(sp / 17.0 + 29.0));
  return 0.5 * snNoise(mat2(0.8, -0.6, 0.6, 0.8) * w / 23.0)
       + 0.27 * snNoise(mat2(0.28, -0.96, 0.96, 0.28) * w / 7.3 + 7.3)
       + 0.15 * snNoise(mat2(-0.5, -0.87, 0.87, -0.5) * w / 2.3 + 3.1)
       + 0.08 * snNoise(mat2(0.97, 0.26, -0.26, 0.97) * w / 0.7 + 5.7);
}
float snowThreshold(float cover) { return 1.0 - cover * 1.2; }
// The snow's colour: blue-white (brighter than a plain colour can be: snow
// reflects nearly all the light), a faint grain, shaded hollows.
vec3 snowColour(vec2 sp, float n) {
  return vec3(1.15, 1.18, 1.24) * (0.93 + 0.07 * snNoise(sp / 1.7)) * (0.96 + 0.04 * n);
}
`;

/**
 * Snow lying on a Lambert/Standard material: on surfaces facing up, by
 * how much snow there is (snowUniforms.uSnow), patchy where it's thin.
 * Trees and bushes too: the tops of branches and twigs, and snow caught
 * on the upper sides of the leafy and needle crowns.
 * @param {object} material
 * @param {{ flatness?: number, amount?: number, strength?: number, foliage?: boolean }} [opts]
 *   flatness  how flat a surface has to be (the cosine of its slope where
 *             snow starts to stay; default ~55°)
 *   amount    how much of the lying snow it holds (default 1; foliage less)
 *   strength  how white it can go (default 1; less for things drawn as a
 *             mass of fine twigs, where the dark wood shows between)
 *   foliage   leaves and needles: their normals say little (they lean
 *             only a little up or down, and a conifer's all lean the same:
 *             src/world/fluffy.js), so snow is dappled through the crown
 *             in clumps, more of it the more a card faces up
 */
export function addSnowCover(material, opts = {}) {
  const flat = (opts.flatness ?? 0.55).toFixed(3);
  const amount = (opts.amount ?? 1).toFixed(3);
  const strength = (opts.strength ?? 1).toFixed(3);
  const foliage = !!opts.foliage;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, snowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vSnowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_INSTANCING
          vSnowWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSnow;
        varying vec3 vSnowWorld;
        ${SNOW_GLSL}
        ${LAKE_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // (After every change to the normal: the distant trees' pictures
        // set theirs in normal_fragment_maps.)
        if (uSnow > 0.0) {
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          vec2 sp = vSnowWorld.xz;
          #if ${foliage ? 1 : 0}
          // Clumps of snow through the crown (by height too, so the sides
          // aren't streaked), mostly on the upper side.
          vec2 fp = sp + vec2(1.7, -1.3) * vSnowWorld.y;
          float clump = 0.6 * snNoise(fp / 0.45) + 0.4 * snNoise(fp / 1.3 + 4.1);
          // (Either face: cards turned to the camera often show their back,
          // whose normal is flipped.)
          float up = abs(dot(normal, upV));
          // (Only a little by the normal: a tall narrow crown's normals,
          // stretched with it, point almost sideways, and they hold clumps
          // too.)
          float v = clump + 0.4 * up;
          float s = smoothstep(-0.05, 0.05, v - (1.0 - 0.55 * uSnow * ${amount})) * ${strength};
          vec3 snowCol = vec3(1.1, 1.13, 1.19) * (0.9 + 0.1 * clump);
          #else
          // (Either face of a double-sided surface.)
          float facing = abs(dot(normal, upV));
          float onTop = smoothstep(${flat}, ${flat} + 0.25, facing);
          // (Not by the ground's colour: its texture's pixels showed.)
          float n = snPatch(sp);
          float t = snowThreshold(uSnow * ${amount});
          // The edge soft by how much the pattern changes across a pixel
          // (no stair-steps far off), a little soft close up.
          float e = max(0.05, 1.5 * fwidth(n));
          float s = smoothstep(t - e, t + e, n) * onTop * ${strength};
          #ifdef HAS_LAKE
          // None on the lake's bed under its water.
          if (lakeQ(sp) < 1.15) s *= smoothstep(-0.01, 0.03, vSnowWorld.y - LAKE_LEVEL);
          #endif
          vec3 snowCol = snowColour(sp, n);
          #endif
          diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, s);
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|snow${flat}|${amount}|${strength}|${foliage}`;
  material.needsUpdate = true;
  return material;
}
