// A layer of fair-weather cumulus about 700 m up, drawn on one big plane by
// a noise shader, drifting with the wind. The same noise darkens the
// sunlight on the ground below (cloud shadows), so they always match.
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector2, Vector3, DoubleSide } from 'three';

export const CLOUD_HEIGHT = 700;
const SIZE = 14000;

/** Shared by the cloud layer and every material that shows cloud shadows. */
export const cloudUniforms = {
  cloudOffset: { value: new Vector2() }, // drift (m)
  cloudEvolve: { value: new Vector2() }, // the small detail's own slow change (noise units)
  cloudCover: { value: 0.35 }, // 0 clear .. 1 overcast
  cloudSunDir: { value: new Vector3(0, 1, 0) },
  cloudShadowStrength: { value: 0.6 },
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
// Cloud density (0..1) at a point on the cloud layer (world x, z in m).
float cloudDensity(vec2 xz) {
  vec2 p = (xz + cloudOffset) / 700.0;
  // Large lumps with crisp, cauliflower edges.
  // (The small detail changes slowly on its own as it drifts: clouds
  // building at one edge and thinning at another.)
  float n = cFbm(p + cloudEvolve * 0.15) * 0.8 + cFbm(p * 3.7 + 4.0 + cloudEvolve) * 0.2;
  float t = mix(0.66, 0.30, cloudCover);
  return smoothstep(t, t + 0.09, n);
}
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

const UNIFORM_DECLS = /* glsl */ `
uniform vec2 cloudOffset;
uniform vec2 cloudEvolve;
uniform float cloudCover;
uniform vec3 cloudSunDir;
uniform float cloudShadowStrength;
`;

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
    };
    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${UNIFORM_DECLS}
        uniform vec3 lightColor; uniform vec3 shadeColor; uniform vec3 hazeColor; uniform float night; uniform float mistFade;
        varying vec3 vWorld;
        ${NOISE}
        void main() {
          float d = cloudDensity(vWorld.xz);
          if (d < 0.01) discard;
          // Thicker parts are darker underneath; thin edges catch the light.
          float thick = cloudDensity(vWorld.xz + cloudSunDir.xz * 120.0);
          vec3 c = mix(lightColor, shadeColor, clamp(thick * 0.9, 0.0, 1.0));
          // Fade into the horizon haze far away.
          float dist = length(vWorld.xz - cameraPosition.xz);
          float haze = smoothstep(1500.0, 6500.0, dist);
          c = mix(c, hazeColor, haze * 0.85);
          float a = min(1.0, d * 1.5) * (1.0 - smoothstep(5000.0, 6800.0, dist)) * mix(1.0, 0.8, night) * (1.0 - mistFade);
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
    this.mesh.position.y = CLOUD_HEIGHT;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
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
    const o = cloudUniforms.cloudOffset.value;
    o.x -= -Math.sin(from) * speed * dt;
    o.y -= Math.cos(from) * speed * dt;
    // About one small lump's size every couple of minutes.
    const e = cloudUniforms.cloudEvolve.value;
    e.x += 0.006 * dt;
    e.y -= 0.0045 * dt;
  }

  /** Colours for the light of the moment (called with the time of day). */
  setLight(sunColor, sunIntensity, hazeColor, night) {
    const u = this.uniforms;
    const k = Math.min(1, sunIntensity / 2.2);
    // By moonlight clouds are only faintly grey against the night sky.
    const dim = 1 - 0.85 * night;
    u.lightColor.value.copy(sunColor).multiplyScalar((0.35 + 0.75 * k) * dim).addScalar(0.08 * (1 - night));
    u.shadeColor.value.setRGB(0.5, 0.54, 0.6).multiplyScalar((0.25 + 0.85 * k) * dim).lerp(hazeColor, 0.25);
    u.hazeColor.value.copy(hazeColor);
    u.night.value = night;
  }
}

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
          vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (${CLOUD_HEIGHT.toFixed(1)} - vCloudWorld.y);
          vCloudShade = 1.0 - cloudShadowStrength * cloudDensity(at);
        }
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${UNIFORM_DECLS}\n${PLANE_DECLS}\nvarying vec3 vCloudWorld;\n#ifdef CLOUD_PER_VERTEX\nvarying float vCloudShade;\n#endif\n${NOISE}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          #ifdef CLOUD_PER_VERTEX
          float shade = vCloudShade;
          #else
          // Follow the sun ray up to the cloud layer.
          float up = max(cloudSunDir.y, 0.08);
          vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (${CLOUD_HEIGHT.toFixed(1)} - vCloudWorld.y);
          float shade = 1.0 - cloudShadowStrength * cloudDensity(at);
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
          reflectedLight.directDiffuse *= shade;
          reflectedLight.directSpecular *= shade;
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|cloudShadows`;
  material.needsUpdate = true;
  return material;
}
