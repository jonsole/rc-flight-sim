// The lake (src/sim/lake.js): its bed and banks as a fine mesh (the terrain
// grid leaves them out), and the water on top.
//
// The water: a flat sheet at the lake's level, cut to its outline (where
// the bank rises out of it, the bank hides the rest). Ripples (a few waves
// running with the wind, finer ones on top) tilt its surface; it reflects
// the sky (more of it looking across the water than straight down: Fresnel),
// glints where the sun's reflection falls, and underneath it's clear in the
// shallows (the bed shows), dark peaty green-brown where it's deep. Built on
// a Lambert material so it takes the scene's light, haze and mist.
import { PlaneGeometry, Mesh, MeshLambertMaterial, Color, Vector3, Vector2, Float32BufferAttribute } from 'three';
import { LAKE, LAKE_GLSL, lakeExtent } from '../sim/lake.js';
import { heightAt } from '../sim/terrain.js';
import { addGroundDetail } from './ground.js';
import { addCloudShadows } from './clouds.js';
import { addSnowCover } from './snow.js';

const BED_STEP = 1.25; // m between the bed mesh's points

/** Shared by the water's shader: set every frame (World.updateWater). */
export const waterUniforms = {
  uWaterTime: { value: 0 },
  uWaterWind: { value: new Vector2(1, 0) }, // where the ripples run (m/s, world x, z)
  uSkyHorizon: { value: new Color(0.7, 0.78, 0.88) }, // (linear)
  uSkyZenith: { value: new Color(0.25, 0.4, 0.7) },
  uSunDir: { value: new Vector3(0, 1, 0) },
  uSunGlint: { value: new Color(1, 1, 1) }, // the sun's colour and strength in the glint
  uTreeLine: { value: new Color(0.03, 0.05, 0.02) }, // the far banks' trees, as lit now (reflected low down)
};

/**
 * The lake's meshes ({ bed, water }), or null without a lake.
 * @param {object} groundTexture  the terrain's grass texture (repeat set)
 */
export function makeLake(groundTexture) {
  if (!LAKE) return null;
  const half = lakeExtent();
  const seg = Math.ceil((half * 2) / BED_STEP);

  // The bed and banks: the same ground material as the terrain (grass,
  // snow, cloud shadows), drawing only where the lake carves the ground.
  const bedGeo = new PlaneGeometry(half * 2, half * 2, seg, seg);
  bedGeo.rotateX(-Math.PI / 2);
  bedGeo.translate(LAKE.x, 0, LAKE.z);
  const p = bedGeo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    p.setY(i, heightAt(p.getX(i), p.getZ(i)));
    // (Vertex colours as light as the terrain's round here.)
    colors.set([0.9, 0.97, 0.8], i * 3);
  }
  bedGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  bedGeo.computeVertexNormals();
  const bedMat = addSnowCover(addCloudShadows(addGroundDetail(new MeshLambertMaterial({ map: groundTexture, vertexColors: true }), { lakeBed: true })));
  const bed = new Mesh(bedGeo, bedMat);
  bed.receiveShadow = true;
  bed.userData.kind = 'terrain';

  // The water.
  const waterGeo = new PlaneGeometry(half * 2, half * 2, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const mat = new MeshLambertMaterial({ color: new Color(0.035, 0.06, 0.05), transparent: true, depthWrite: false });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, waterUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWaterWorld;
        uniform float uWaterTime;
        uniform vec2 uWaterWind;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyZenith;
        uniform vec3 uSunDir;
        uniform vec3 uSunGlint;
        uniform vec3 uTreeLine;
        ${LAKE_GLSL}
        // Slope of the ripples at p (dh/dx, dh/dz): waves running with the
        // wind (bigger and faster in more wind), and a little cross-chop.
        // pf: how much water one pixel covers (m): waves smaller than a few
        // pixels are left out (they'd only alias into stripes).
        vec2 ripple(vec2 p, float pf) {
          float w = length(uWaterWind);
          vec2 d = w > 0.05 ? uWaterWind / w : vec2(1.0, 0.0);
          vec2 s = vec2(-d.y, d.x);
          float a = 0.004 + 0.012 * min(w / 6.0, 1.0); // wave slope
          float t = uWaterTime;
          vec2 g = vec2(0.0);
          // (wave: direction, wavelength (m), speed (m/s))
          #define WAVE(dir, len, spd, amp) { vec2 k = (dir) * (6.2832 / (len)); float ph = dot(k, p) - (spd) * t * (6.2832 / (len)); g += k * cos(ph) * (amp) * (1.0 - smoothstep(0.08 * (len), 0.3 * (len), pf)); }
          WAVE(d, 1.7, 1.6, a)
          WAVE(normalize(d + 0.6 * s), 1.1, 1.3, a * 0.8)
          WAVE(normalize(d - 0.5 * s), 0.73, 1.05, a * 0.6)
          WAVE(normalize(s + 0.3 * d), 0.41, 0.8, a * 0.5)
          WAVE(normalize(d * 0.8 - s), 0.29, 0.66, a * 0.4)
          return g;
        }`)
      .replace('#include <opaque_fragment>', /* glsl */ `
        {
          vec2 xz = vWaterWorld.xz;
          // Cut to the lake (the banks hide the water past the edge).
          if (lakeQ(xz) > 1.12) discard;
          float depth = max(0.0, LAKE_LEVEL - lakeCarve(xz)); // to the bed (m)
          vec3 toEye = cameraPosition - vWaterWorld;
          float dist = length(toEye);
          vec3 v = toEye / dist;
          // Ripples, each fading out where it's too small to see (far off,
          // a smooth sheet).
          vec2 fw = fwidth(xz);
          vec2 sl = ripple(xz, max(fw.x, fw.y));
          vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
          float cosv = max(dot(n, v), 0.02);
          // Fresnel (water, Schlick): ~2% looking straight down, all of it
          // at a grazing angle.
          float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
          vec3 r = reflect(-v, n);
          vec3 sky = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.6, r.y));
          // Low down it reflects the trees round the far banks, not sky
          // (their tops ~0.1 above the horizon from across the lake), raggedly.
          float az = atan(r.z, r.x);
          float tops = 0.07 + 0.025 * sin(az * 9.0 + 1.0) + 0.015 * sin(az * 23.0 + 2.0) + 0.008 * sin(az * 57.0);
          sky = mix(uTreeLine, sky, smoothstep(tops - 0.03, tops + 0.03, r.y));
          // The water itself: the bed through the shallows, peaty and dark
          // where deep (the lit colour of the material, as the scene lights it).
          vec3 body = outgoingLight;
          float murk = 1.0 - exp(-depth * 2.2);
          // The sun's glint.
          float glint = pow(max(dot(r, uSunDir), 0.0), 600.0) * 60.0 + pow(max(dot(r, uSunDir), 0.0), 60.0) * 0.6;
          // Blended over the bed already drawn: what's reflected, plus what
          // comes up through the water (its own colour where it's deep, the
          // bed's where it's shallow: that part is the bed showing through).
          murk *= 0.95;
          float a = 1.0 - (1.0 - fres) * (1.0 - murk);
          // (A soft edge where it meets the bank.)
          a *= smoothstep(0.0, 0.04, depth);
          vec3 col = sky * fres + body * (1.0 - fres) * murk + uSunGlint * glint;
          outgoingLight = col / max(a, 0.001);
          diffuseColor.a = a;
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'lakeWater';
  const water = new Mesh(waterGeo, mat);
  water.position.set(LAKE.x, LAKE.level, LAKE.z);
  water.renderOrder = 1; // after the ground and its bed
  water.userData.kind = 'water';
  return { bed, water };
}
