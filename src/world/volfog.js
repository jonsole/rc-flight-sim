// Volumetric fog, mist and low cloud. One density field in the air:
//   haze   the clear-day haze, everywhere (exponential-squared with distance)
//   mist   over the ground: dense up to its top, thinning out above; in
//          banks and patches, its top lumpy
//   cloud  low cloud between a base and a top, in lumps (its cover from
//          src/world/mist.js's noise)
// Every fogged pixel samples the field along its line of sight from the
// camera (where that line is low enough to meet any) and fogs by how much
// it passes through, coloured by what it is: grey-white mist, cloud grey
// from below and sunlit from above, a little brighter towards the sun. The
// sky (src/world/world.js) does the same, so cloud seen against the sky
// and against the ground match.
//
// Built into three.js's fog shader code (so every built-in material gets
// it), with its settings shared by every material (fogUniforms: plain
// objects, which three.js shares rather than copies).
import { ShaderLib, ShaderChunk } from 'three';

/** Shared by every fogged material and the sky. Plain objects: x, y, z, w. */
export const fog4 = {
  a: { x: 0, y: 0, z: 0, w: 0 }, // mist density (/m), mist top (m), cloud amount (0-1), cloud density (/m)
  b: { x: 60, y: 100, z: 0, w: 0 }, // cloud base, cloud top (m), drift x, z (m)
  sun: { x: 0, y: 1, z: 0, w: 0 }, // towards the sun (world), w: forward-scatter strength
  under: { x: 0.6, y: 0.62, z: 0.66, w: 0 }, // cloud colour from below (screen colours)
  top: { x: 1, y: 1, z: 1, w: 0 }, // ... sunlit, from above
};

/** The field's GLSL (fogged materials and the sky). Needs the fog4 uniforms. */
export const FIELD_GLSL = /* glsl */ `
uniform vec4 fogMistA;
uniform vec4 fogMistB;
uniform vec4 fogSun;
uniform vec4 fogUnder;
uniform vec4 fogTop;
float vfHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vfNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vfHash(i), b = vfHash(i + vec2(1.0, 0.0)), c = vfHash(i + vec2(0.0, 1.0)), d = vfHash(i + vec2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
// Low cloud cover at (x, z): as src/world/mist.js coverAt (two octaves).
float vfCover(vec2 xz) {
  vec2 p = (xz + fogMistB.zw) / 260.0;
  float n = 0.5 * vfNoise(p) + 0.25 * vfNoise(p * 2.1 + vec2(5.3, 1.7));
  n *= 1.0 / 0.75;
  float t = mix(0.7, 0.16, fogMistA.z);
  return smoothstep(t, t + 0.12, n);
}
// Mist and cloud density (/m) at a point; cloud's share in .y.
vec2 vfDensity(vec3 p, float ground) {
  vec2 d = vec2(0.0);
  if (fogMistA.x > 0.0) {
    // Banks and patches, a lumpy top.
    float bank = vfNoise((p.xz + fogMistB.zw * 0.3) / 140.0);
    float top = fogMistA.y + (vfNoise(p.xz / 90.0 + 7.0) - 0.5) * fogMistA.y * 0.6;
    float H = max(top * 0.3, 4.0);
    d.x = fogMistA.x * (0.35 + 1.3 * bank) * exp(-max(p.y - ground - top, 0.0) / H);
  }
  if (fogMistA.z > 0.0) {
    float c = vfCover(p.xz);
    if (c > 0.0) {
      // Lumpy base and top: thickest where the cover is.
      float lump = (c - 0.5) * 14.0;
      float band = smoothstep(fogMistB.x - lump - 6.0, fogMistB.x - lump + 6.0, p.y) * (1.0 - smoothstep(fogMistB.y + lump - 8.0, fogMistB.y + lump + 4.0, p.y));
      d.y = fogMistA.w * c * band;
    }
  }
  return d;
}
// Fog along the line of sight from the camera to p (world): how much
// (optical depth, .x) and the colour it takes on (.yzw, screen colours),
// given the haze colour. groundAt: the ground height here (sea level 0).
vec4 vfAlong(vec3 from, vec3 to, vec3 hazeCol) {
  vec3 ray = to - from;
  float len = length(ray);
  vec3 dir = ray / max(len, 1e-4);
  // Only where the line is low enough to meet mist or cloud.
  float ymax = max(fogMistA.y * 1.6 + 30.0, fogMistA.z > 0.0 ? fogMistB.y + 14.0 : 0.0);
  float t0 = 0.0, t1 = len;
  if (abs(dir.y) > 1e-4) {
    float tTop = (ymax - from.y) / dir.y;
    if (dir.y > 0.0) t1 = min(t1, max(tTop, 0.0)); else t0 = max(t0, tTop);
  } else if (from.y > ymax) t1 = 0.0;
  float odMist = 0.0, odCloud = 0.0;
  if (t1 > t0) {
    // A few samples, jittered per pixel (no banding).
    const int N = 7;
    float j = vfHash(gl_FragCoord.xy * 1.37 + 0.5); // (random: no stripes)
    float step = (t1 - t0) / float(N);
    for (int i = 0; i < N; i++) {
      vec3 p = from + dir * (t0 + (float(i) + j) * step);
      vec2 d = vfDensity(p, 0.0);
      odMist += d.x * step;
      odCloud += d.y * step;
    }
  }
  // Cloud: grey from below, white from above (the camera's side of it).
  float fromAbove = smoothstep(fogMistB.x, fogMistB.y, from.y);
  vec3 cloudCol = mix(fogUnder.rgb, fogTop.rgb, fromAbove);
  float od = odMist + odCloud;
  vec3 col = od > 0.0 ? mix(hazeCol, cloudCol, odCloud / od) : hazeCol;
  // Brighter looking towards the sun (light scattered forwards).
  float s = max(dot(dir, fogSun.xyz), 0.0);
  col *= 1.0 + fogSun.w * pow(s, 8.0);
  return vec4(od, col);
}
`;

/** Build the field into three.js's fog shader code (once, before any material compiles). */
export function installVolumetricFog(hazeDensity) {
  // Every built-in material with fog shares the field's settings.
  for (const lib of Object.values(ShaderLib)) {
    if (!lib.uniforms?.fogColor) continue;
    lib.uniforms.fogMistA = { value: fog4.a };
    lib.uniforms.fogMistB = { value: fog4.b };
    lib.uniforms.fogSun = { value: fog4.sun };
    lib.uniforms.fogUnder = { value: fog4.under };
    lib.uniforms.fogTop = { value: fog4.top };
  }
  ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif`;
  ShaderChunk.fog_vertex = `#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// World position (from the view position).
	vFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`;
  ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	uniform float fogNear;
	uniform float fogFar;
	uniform float fogDensity;
	${FIELD_GLSL}
#endif`;
  ShaderChunk.fog_fragment = `#ifdef USE_FOG
	{
		float hz = ${hazeDensity.toFixed(7)} * vFogDepth;
		float od = hz * hz;
		vec3 col = fogColor;
		if ( fogMistA.x > 0.0 || fogMistA.z > 0.0 ) {
			vec4 f = vfAlong( cameraPosition, vFogWorld, fogColor );
			// Mist and cloud over the haze (the nearer of them, mostly).
			col = mix( fogColor, f.yzw, f.x / max( f.x + od, 1e-5 ) );
			od += f.x;
		}
		gl_FragColor.rgb = mix( gl_FragColor.rgb, col, 1.0 - exp( - od ) );
	}
#endif`;
}
