// A layer of fair-weather cumulus about 700 m up, drawn on one big plane by
// a noise shader, drifting with the wind. The same noise darkens the
// sunlight on the ground below (cloud shadows), so they always match.
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector2, Vector3, DoubleSide } from 'three';

export const CLOUD_HEIGHT = 700;
const SIZE = 14000;

/** Shared by the cloud layer and every material that shows cloud shadows. */
export const cloudUniforms = {
  cloudOffset: { value: new Vector2() }, // drift (m)
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
  float n = cFbm(p) * 0.8 + cFbm(p * 3.7 + 4.0) * 0.2;
  float t = mix(0.66, 0.30, cloudCover);
  return smoothstep(t, t + 0.09, n);
}
`;

const UNIFORM_DECLS = /* glsl */ `
uniform vec2 cloudOffset;
uniform float cloudCover;
uniform vec3 cloudSunDir;
uniform float cloudShadowStrength;
`;

export class CloudLayer {
  constructor() {
    this.uniforms = {
      ...cloudUniforms,
      lightColor: { value: new Color(1, 1, 1) }, // sun on the cloud tops
      shadeColor: { value: new Color(0.62, 0.66, 0.72) }, // their undersides
      hazeColor: { value: new Color('#c3d5e8') },
      night: { value: 0 },
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
        uniform vec3 lightColor; uniform vec3 shadeColor; uniform vec3 hazeColor; uniform float night;
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
          float a = min(1.0, d * 1.5) * (1.0 - smoothstep(5000.0, 6800.0, dist)) * mix(1.0, 0.8, night);
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

  /** Drift with the wind (world velocity m/s; stronger aloft). */
  update(dt, wind) {
    const o = cloudUniforms.cloudOffset.value;
    o.x -= wind.x * 1.8 * dt;
    o.y -= wind.z * 1.8 * dt;
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
    Object.assign(shader.uniforms, cloudUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_INSTANCING
          vCloudWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${UNIFORM_DECLS}\nvarying vec3 vCloudWorld;\n${NOISE}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // Follow the sun ray up to the cloud layer.
          float up = max(cloudSunDir.y, 0.08);
          vec2 at = vCloudWorld.xz + cloudSunDir.xz / up * (${CLOUD_HEIGHT.toFixed(1)} - vCloudWorld.y);
          float shade = 1.0 - cloudShadowStrength * cloudDensity(at);
          reflectedLight.directDiffuse *= shade;
          reflectedLight.directSpecular *= shade;
        }`);
  };
  material.customProgramCacheKey = () => 'cloudShadows';
  material.needsUpdate = true;
  return material;
}
