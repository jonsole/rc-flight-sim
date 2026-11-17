// Clouds: a low layer of cumulus (or stratocumulus) and, by type, a high,
// streaky layer of cirrus. Both drift with the wind aloft and change shape
// slowly.
//
// The low layer is drawn on one big sheet at its base by a noise shader:
// the cloud bases, darker under deeper cloud, lighter at their thin edges
// and where the sun shines through. The same noise darkens the sunlight on
// the ground below (cloud shadows), so they always match.
//
// Types (setType): fair-weather cumulus, towering cumulus, stratocumulus,
// cirrus only, or cumulus with cirrus above.
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector2, Vector3, Vector4, DoubleSide, ShaderChunk } from 'three';
import { fog4, FIELD_GLSL } from './volfog.js';

const SIZE = 14000;

/**
 * Each type: base and depth of the low layer (m), its lumps' size (m), how
 * soft their edges, how stretched (into rolls, along the wind), how grey,
 * how dark its shadows, and whether there's cirrus above.
 */
export const CLOUD_TYPES = {
  fair: { name: 'Fair-weather cumulus', base: 700, thick: 380, scale: 700, edge: 0.09, stretch: 1, grey: 0, dark: 1, cirrus: 0 },
  towering: { name: 'Towering cumulus', base: 650, thick: 1500, scale: 950, edge: 0.07, stretch: 1, grey: 0.12, dark: 1.15, cirrus: 0 },
  strato: { name: 'Stratocumulus (grey, broken)', base: 550, thick: 220, scale: 1300, edge: 0.22, stretch: 2.2, grey: 0.35, dark: 0.85, cirrus: 0 },
  cirrus: { name: 'High cirrus only', base: 700, thick: 380, scale: 700, edge: 0.09, stretch: 1, grey: 0, dark: 0, cirrus: 1, noLow: true },
  mixed: { name: 'Cumulus with cirrus above', base: 700, thick: 380, scale: 700, edge: 0.09, stretch: 1, grey: 0, dark: 1, cirrus: 0.8 },
};

/**
 * "Changing" clouds: a type for the day and hour, by season - towering
 * cumulus on summer afternoons, stratocumulus more in winter, cirrus ahead
 * of changes now and then.
 */
export function cloudTypeFor(day, hours) {
  const r = (Math.sin(day * 12.9898 + 4.1) * 43758.5453) % 1;
  const rnd = Math.abs(r);
  const summer = Math.cos(((day - 196) / 365) * 2 * Math.PI) * 0.5 + 0.5; // 1 in mid-July
  const afternoon = hours > 12 && hours < 19;
  if (summer > 0.6 && afternoon && rnd < 0.35) return 'towering';
  if (rnd < 0.15 + 0.35 * (1 - summer)) return 'strato';
  if (rnd > 0.88) return 'cirrus';
  if (rnd > 0.6) return 'mixed';
  return 'fair';
}

/** Shared by the cloud layer and every material that shows cloud shadows. */
export const cloudUniforms = {
  cloudOffset: { value: new Vector2() }, // drift (m)
  cloudEvolve: { value: new Vector2() }, // the small detail's own slow change (noise units)
  cloudCover: { value: 0.35 }, // 0 clear .. 1 overcast
  cloudSunDir: { value: new Vector3(0, 1, 0) },
  cloudShadowStrength: { value: 0.6 },
  // The type (CLOUD_TYPES): base, depth (m), lump size (m), edge softness.
  cloudShape: { value: new Vector4(700, 380, 700, 0.09) },
  // Stretch along the wind (rolls), the way it blows (x, z), how dark its shadows.
  cloudRoll: { value: new Vector4(1, 1, 0, 1) },
};

const NOISE = /* glsl */ `
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y);
}
float cFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * cNoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}
// Where in the noise a point on the layer is (stretched into rolls along the wind).
vec2 cloudP(vec2 xz) {
  vec2 q = xz + cloudOffset;
  vec2 w = cloudRoll.yz;
  q = vec2(dot(q, w) / cloudRoll.x, dot(q, vec2(-w.y, w.x)));
  return q / cloudShape.z;
}
float cloudThreshold() { return mix(0.66, 0.30, cloudCover) - max(cloudShape.w - 0.1, 0.0) * 0.6; }
// The small detail's noise (3 octaves: cheaper, and enough at that size).
float cFbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * cNoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s / 0.875;
}
// The cloud pattern at a point on the layer (world x, z in m): above
// cloudThreshold() is cloud. Large lumps with crisp, cauliflower edges.
// (The small detail changes slowly on its own as it drifts: clouds building
// at one edge and thinning at another.)
float cloudNoise(vec2 xz) {
  vec2 p = cloudP(xz);
  return cFbm(p + cloudEvolve * 0.15) * 0.8 + cFbm3(p * 3.7 + 4.0 + cloudEvolve) * 0.2;
}
// Cloud density (0..1) at a point on the cloud layer.
float cloudDensity(vec2 xz) {
  float t = cloudThreshold();
  return smoothstep(t, t + cloudShape.w, cloudNoise(xz));
}
`;

const UNIFORM_DECLS = /* glsl */ `
uniform vec2 cloudOffset;
uniform vec2 cloudEvolve;
uniform float cloudCover;
uniform vec3 cloudSunDir;
uniform float cloudShadowStrength;
uniform vec4 cloudShape;
uniform vec4 cloudRoll;
`;

/**
 * The aeroplane's shadow, on whatever it falls on (src/view/planeShadow.js
 * sets these each frame): its blurred silhouette seen from the sun, placed by
 * that view's centre and axes, and how far towards the sun the aeroplane is
 * (only what's beyond it, away from the sun, is shaded).
 */
export const planeShadowUniforms = {
  psMask: { value: null },
  psCam: { value: new Vector3() },
  psRight: { value: new Vector3(1, 0, 0) },
  psUp: { value: new Vector3(0, 1, 0) },
  psHalf: { value: 1 },
  psSun: { value: new Vector3(0, 1, 0) },
  psDepth: { value: 0 },
  psOn: { value: 0 },
};

const PLANE_DECLS = /* glsl */ `
uniform sampler2D psMask;
uniform vec3 psCam;
uniform vec3 psRight;
uniform vec3 psUp;
uniform float psHalf;
uniform vec3 psSun;
uniform float psDepth;
uniform float psOn;
`;

export class CloudLayer {
  constructor() {
    this.uniforms = {
      ...cloudUniforms,
      lightColor: { value: new Color(1, 1, 1) }, // sun on the cloud tops
      shadeColor: { value: new Color(0.62, 0.66, 0.72) }, // their undersides
      hazeColor: { value: new Color('#c3d5e8') },
      night: { value: 0 },
      mistFade: { value: 0 }, // hidden by mist (0 clear .. 1 gone)
      grey: { value: 0 }, // the type's greyness
      fogMistA: { value: fog4.a },
      fogMistB: { value: fog4.b },
      fogSun: { value: fog4.sun },
      fogUnder: { value: fog4.under },
      fogTop: { value: fog4.top },
    };
    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      // (Drawn at the far distance whatever the camera's far plane: they're
      // part of the sky, faded by any mist in between, not cut off by it.)
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        ${UNIFORM_DECLS}
        uniform vec3 lightColor; uniform vec3 shadeColor; uniform vec3 hazeColor; uniform float night; uniform float mistFade; uniform float grey;
        varying vec3 vWorld;
        ${NOISE}
        ${FIELD_GLSL}
        // How deep the cloud is over a point (0..1) where its pattern is n:
        // the densest parts the deepest (and darkest underneath).
        float cloudH(float n) {
          float k = (n - cloudThreshold()) / (cloudShape.w * 3.0 + 0.1);
          return k <= 0.0 ? 0.0 : pow(min(k, 1.0), 0.6);
        }
        void main() {
          vec3 dir = normalize(vWorld - cameraPosition);
          if (dir.y < 0.002) discard;
          float base = cloudShape.x, T = cloudShape.y;
          // Where the line of sight meets the cloud base. (Following it on
          // up to find the clouds' sides came out as streaks near the
          // horizon: the bases are drawn, shaded for their depth.)
          float t0 = (base - cameraPosition.y) / dir.y;
          vec3 q = cameraPosition + dir * t0;
          float n = cloudNoise(q.xz);
          float dist = length(q.xz - cameraPosition.xz);
          // (Edges a little softer far away.)
          float d = smoothstep(cloudThreshold(), cloudThreshold() + cloudShape.w * (1.0 + dist / 2500.0), n);
          if (d < 0.005) discard;
          // Darker under deeper cloud; lighter at the thin edges, and where
          // the sun shines through a thin part (a bright rim on the sun's side).
          float deep = cloudH(n);
          float towardSun = cloudDensity(q.xz + cloudSunDir.xz / max(cloudSunDir.y, 0.15) * T * 0.4);
          float lit = mix(0.5, 0.05, deep) + 0.35 * (1.0 - d) + 0.25 * (1.0 - towardSun);
          vec3 c = mix(shadeColor, lightColor, lit);
          c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))) * 0.85, grey);
          // Fade into the horizon haze far away.
          float haze = smoothstep(1500.0, 6500.0, dist);
          c = mix(c, hazeColor, haze * 0.85);
          // (The base fades out at its edge; a side is solid.)
          float a = min(1.0, d * 1.5) * (1.0 - smoothstep(5000.0, 6800.0, dist)) * mix(1.0, 0.8, night) * (1.0 - mistFade);
          // Mist and low cloud between here and it hide it (gradually).
          if (fogMistA.x > 0.0 || fogMistA.z > 0.0) a *= exp(-vfAlong(cameraPosition, q, hazeColor).x);
          if (a < 0.005) discard;
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
    this.mesh = new Mesh(geo, mat);
    this.mesh.position.y = CLOUD_TYPES.fair.base;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;

    // Cirrus: high (7 km), thin, white and streaky, combed out along the wind.
    this.cirrusUniforms = {
      cirrusOffset: { value: new Vector2() },
      cirrusAmount: { value: 0 },
      cirrusDir: { value: new Vector2(1, 0) },
      lightColor: this.uniforms.lightColor,
      hazeColor: this.uniforms.hazeColor,
      mistFade: this.uniforms.mistFade,
      night: this.uniforms.night,
      cloudSunDir: cloudUniforms.cloudSunDir,
      fogMistA: { value: fog4.a },
      fogMistB: { value: fog4.b },
      fogSun: { value: fog4.sun },
      fogUnder: { value: fog4.under },
      fogTop: { value: fog4.top },
    };
    const cmat = new ShaderMaterial({
      uniforms: this.cirrusUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec2 cirrusOffset; uniform float cirrusAmount; uniform vec2 cirrusDir;
        uniform vec3 lightColor; uniform vec3 hazeColor; uniform float mistFade; uniform float night; uniform vec3 cloudSunDir;
        varying vec3 vWorld;
        float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float cNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y);
        }
        float cFbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { s += a * cNoise(p); p = p * 2.1 + vec2(3.7, 8.1); a *= 0.5; }
          return s;
        }
        ${FIELD_GLSL}
        void main() {
          vec2 q = vWorld.xz + cirrusOffset;
          // Combed out along the wind: long strands, hooked by a slow warp.
          vec2 a = vec2(dot(q, cirrusDir), dot(q, vec2(-cirrusDir.y, cirrusDir.x)));
          vec2 p = vec2(a.x / 9000.0, a.y / 900.0);
          p.y += 0.6 * cFbm(p * vec2(1.0, 0.3) + 3.0);
          float n = cFbm(p * vec2(1.0, 3.0));
          float patches = smoothstep(0.35, 0.65, cFbm(q / 14000.0 + 7.0));
          float d = smoothstep(0.48, 0.75, n) * patches * cirrusAmount;
          float dist = length(vWorld.xz - cameraPosition.xz);
          float alpha = d * 0.55 * (1.0 - smoothstep(20000.0, 30000.0, dist)) * mix(1.0, 0.5, night) * (1.0 - mistFade);
          vec3 dir = normalize(vWorld - cameraPosition);
          if (fogMistA.x > 0.0 || fogMistA.z > 0.0) alpha *= exp(-vfAlong(cameraPosition, cameraPosition + dir * 3000.0, hazeColor).x);
          if (alpha < 0.005) discard;
          // White, brighter towards the sun; into the haze low down.
          vec3 c = lightColor * (1.05 + 0.4 * pow(max(dot(dir, cloudSunDir), 0.0), 6.0));
          c = mix(c, hazeColor, smoothstep(8000.0, 28000.0, dist) * 0.8);
          gl_FragColor = vec4(c, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });
    const cgeo = new PlaneGeometry(60000, 60000, 1, 1);
    cgeo.rotateX(-Math.PI / 2);
    this.cirrus = new Mesh(cgeo, cmat);
    this.cirrus.position.y = 7000;
    this.cirrus.renderOrder = -1.5;
    this.cirrus.frustumCulled = false;
    this.cirrus.visible = false;
    this.mesh.add(this.cirrus); // (positioned in the world: see setType)
    this.setType('fair');
  }

  /** A cloud type (CLOUD_TYPES key). */
  setType(id) {
    const T = CLOUD_TYPES[id] || CLOUD_TYPES.fair;
    this.type = id in CLOUD_TYPES ? id : 'fair';
    cloudUniforms.cloudShape.value.set(T.base, T.thick, T.scale, T.edge);
    cloudUniforms.cloudRoll.value.x = T.stretch;
    cloudUniforms.cloudRoll.value.w = T.noLow ? 0 : T.dark;
    this.uniforms.grey.value = T.grey;
    this.mesh.position.y = T.base;
    this.cirrus.position.y = 7000 - T.base;
    this.cirrusUniforms.cirrusAmount.value = T.cirrus;
    this.lowOn = !T.noLow;
    this.#show();
  }

  /** Show the low layer in 3D instead (src/world/volclouds.js), or flat. */
  setVolumetric(on) {
    this.volumetric = on;
    this.#show();
  }

  /** Cover (0..1): how much of the sky the low layer covers (cirrus shows whatever it is). */
  setCover(cover) {
    this.cover = cover;
    this.#show();
  }

  #show() {
    const cover = this.cover ?? 0.35;
    // (The sheet carries the cirrus too, so it stays visible; its own
    // clouds are left out by cover 0.)
    cloudUniforms.cloudCover.value = this.lowOn ? cover : 0;
    const cirrus = this.cirrusUniforms.cirrusAmount.value > 0;
    // (The flat layer hidden while the 3D clouds show: src/world/volclouds.js.)
    this.mesh.material.visible = this.lowOn && cover > 0.01 && !this.volumetric;
    this.mesh.visible = (this.lowOn && cover > 0.01) || cirrus;
    this.cirrus.visible = cirrus;
  }

  /**
   * Drift with the wind up at the clouds, and change shape slowly as they go.
   * @param {{ speed: number, directionDeg: number }} wind  the wind at the field (m/s, from)
   */
  update(dt, wind) {
    // Aloft the wind is stronger than at the ground and veered (turned
    // clockwise) by friction's absence; clouds still drift on a calm day.
    const speed = Math.max(4, 2.5 * (wind.speed || 0));
    const from = (((wind.speed > 0.3 ? wind.directionDeg : 250) + 20) * Math.PI) / 180;
    const wx = -Math.sin(from);
    const wz = Math.cos(from);
    const o = cloudUniforms.cloudOffset.value;
    o.x -= wx * speed * dt;
    o.y -= wz * speed * dt;
    // (Rolls lie along the wind.)
    cloudUniforms.cloudRoll.value.y = wx;
    cloudUniforms.cloudRoll.value.z = wz;
    // About one small lump's size every couple of minutes.
    const e = cloudUniforms.cloudEvolve.value;
    e.x += 0.006 * dt;
    e.y -= 0.0045 * dt;
    // Cirrus: in the jet stream, faster, from further round.
    const c = this.cirrusUniforms;
    const cf = from + 0.5;
    c.cirrusOffset.value.x += Math.sin(cf) * speed * 2.5 * dt;
    c.cirrusOffset.value.y -= Math.cos(cf) * speed * 2.5 * dt;
    c.cirrusDir.value.set(-Math.sin(cf), Math.cos(cf));
  }

  /** Colours for the light of the moment (called with the time of day). */
  setLight(sunColor, sunIntensity, hazeColor, night) {
    const u = this.uniforms;
    const k = Math.min(1, sunIntensity / 2.2);
    // By moonlight clouds are only faintly grey against the night sky.
    const dim = 1 - 0.85 * night;
    u.lightColor.value.copy(sunColor).multiplyScalar((0.35 + 0.75 * k) * dim).addScalar(0.08 * (1 - night));
    // (Undersides a mid grey: the white tops and sides stand out against them.)
    u.shadeColor.value.setRGB(0.36, 0.39, 0.45).multiplyScalar((0.25 + 0.85 * k) * dim).lerp(hazeColor, 0.15);
    u.hazeColor.value.copy(hazeColor);
    u.night.value = night;
  }
}

// Cloud and aeroplane shadows dim only the sun's (or moon's) light, the
// directional light - not lamps such as the aeroplane's navigation lights,
// whose glow on the ground they would otherwise cut holes in. A material
// with them sets sunShade (and SUN_SHADE) before the lights are added up.
// (Patched into three.js's lighting code once, before anything compiles;
// src/world/fluffy.js builds its own version of it from this one.)
ShaderChunk.lights_fragment_begin = ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\t#ifdef SUN_SHADE\n\t\tdirectLight.color *= sunShade;\n\t\t#endif',
);

/**
 * Let a MeshStandardMaterial show cloud shadows: direct sunlight is dimmed
 * where a cloud lies between the point and the sun.
 */
export function addCloudShadows(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, cloudUniforms, planeShadowUniforms);
    // CLOUD_PER_VERTEX (leaf cards, the distant trees' pictures: small next
    // to a cloud's shadow): worked out once per vertex, not per pixel, as
    // their many overlapping layers would make it costly.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCloudWorld;\n#ifdef CLOUD_PER_VERTEX\n${UNIFORM_DECLS}\nvarying float vCloudShade;\n${NOISE}\n#endif`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_INSTANCING
          vCloudWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        #ifdef CLOUD_PER_VERTEX
        {
          float up = max(cloudSunDir.y, 0.08);
          vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (cloudShape.x - vCloudWorld.y);
          vCloudShade = 1.0 - cloudShadowStrength * cloudRoll.w * cloudDensity(at);
        }
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${UNIFORM_DECLS}\n${PLANE_DECLS}\nvarying vec3 vCloudWorld;\n#ifdef CLOUD_PER_VERTEX\nvarying float vCloudShade;\n#endif\n${NOISE}`)
      .replace('#include <lights_fragment_begin>', `
        #define SUN_SHADE
        float sunShade;
        {
          #ifdef CLOUD_PER_VERTEX
          float shade = vCloudShade;
          #else
          // Follow the sun ray up to the cloud layer.
          float up = max(cloudSunDir.y, 0.08);
          vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (cloudShape.x - vCloudWorld.y);
          float shade = 1.0 - cloudShadowStrength * cloudRoll.w * cloudDensity(at);
          #endif
          // The aeroplane's shadow: no direct sun where its silhouette falls,
          // beyond it from the sun.
          if (psOn > 0.5) {
            vec3 d = vCloudWorld - psCam;
            vec2 uv = vec2(dot(d, psRight), dot(d, psUp)) / (2.0 * psHalf) + 0.5;
            if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
              float beyond = psDepth - dot(vCloudWorld, psSun);
              shade *= 1.0 - texture2D(psMask, uv).r * smoothstep(-0.02, 0.03, beyond);
            }
          }
          sunShade = shade;
        }
        #include <lights_fragment_begin>`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|cloudShadows`;
  material.needsUpdate = true;
  return material;
}

/** The clouds' pattern for other shaders (the sky's sunbeams): uniforms and functions. */
export const CLOUD_GLSL = UNIFORM_DECLS + NOISE;
