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
 * Snow lying on a Lambert/Standard material: on surfaces facing up, by
 * how much snow there is (snowUniforms.uSnow), patchy where it's thin.
 * @param {object} material
 * @param {{ flatness?: number }} [opts]  how flat a surface has to be (the
 *   cosine of its slope where snow starts to stay; default ~55°)
 */
export function addSnowCover(material, opts = {}) {
  const flat = (opts.flatness ?? 0.55).toFixed(3);
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
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (uSnow > 0.0) {
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          // (Either face of a double-sided surface.)
          float facing = abs(dot(normal, upV));
          float onTop = smoothstep(${flat}, ${flat} + 0.25, facing);
          vec2 sp = vSnowWorld.xz;
          // Drifts and bare patches (metres to tens of metres), and the
          // grass poking through close up. Each octave turned and the
          // whole gently warped, so no square grid shows in the edges.
          // (Not by the ground's colour: its texture's pixels showed.)
          vec2 w = sp + 6.0 * vec2(snNoise(sp / 17.0 + 11.0), snNoise(sp / 17.0 + 29.0));
          float n = 0.5 * snNoise(mat2(0.8, -0.6, 0.6, 0.8) * w / 23.0)
                  + 0.27 * snNoise(mat2(0.28, -0.96, 0.96, 0.28) * w / 7.3 + 7.3)
                  + 0.15 * snNoise(mat2(-0.5, -0.87, 0.87, -0.5) * w / 2.3 + 3.1)
                  + 0.08 * snNoise(mat2(0.97, 0.26, -0.26, 0.97) * w / 0.7 + 5.7);
          float t = 1.0 - uSnow * 1.2;
          // The edge soft by how much the pattern changes across a pixel
          // (no stair-steps far off), a little soft close up.
          float e = max(0.05, 1.5 * fwidth(n));
          float s = smoothstep(t - e, t + e, n) * onTop;
          // Snow: blue-white (brighter than a plain colour can be: snow
          // reflects nearly all the light), a faint grain, shaded hollows.
          vec3 snowCol = vec3(1.15, 1.18, 1.24) * (0.93 + 0.07 * snNoise(sp / 1.7)) * (0.96 + 0.04 * n);
          diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, s);
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|snow${flat}`;
  material.needsUpdate = true;
  return material;
}
