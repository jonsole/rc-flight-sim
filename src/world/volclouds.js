// Volumetric clouds (High graphics): real 3D cumulus - lumpy, sunlit on one
// side and shadowed on the other, with soft, wispy edges - in place of the
// flat cloud bases (src/world/clouds.js) the other settings draw.
//
// After the open-source volumetric-clouds demo (github.com/leoawen/
// volumetric-clouds, MIT), made cheap enough for a game:
//   - Where the clouds are and how tall: the same 2D pattern the cloud
//     shadows on the ground use (clouds.js cloudNoise), drawn into a small
//     map around the camera every few frames - so shadows and clouds match.
//   - Their detail: a small 3D noise texture made once, which eats into the
//     edges (puffs, wisps).
//   - Drawn at half the screen's width and height (a quarter of the pixels)
//     and stretched over the sky: clouds are soft, it hardly shows.
//   - Along each line of sight through the cloud layer, a fixed number of
//     samples (the same for every pixel: no grain), each lit by a few more
//     samples towards the sun (light through the cloud: Beer-Lambert, with a
//     forward-scattering glow around the sun).
// Drawn behind everything (at the far distance), faded into the haze far
// off and by any mist in between, like the flat clouds.
import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, RepeatWrapping, WebGLRenderTarget, ShaderMaterial,
  Mesh, BufferGeometry, Float32BufferAttribute, Vector2, Vector3, Matrix4, HalfFloatType, Color,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CLOUD_GLSL, cloudUniforms } from './clouds.js';
import { fog4, FIELD_GLSL } from './volfog.js';

const MAP = 512; // the cloud pattern map (texels a side)
const SPAN = 16000; // ... covering this many metres around the camera
const N3 = 48; // 3D noise texture size

/** A tileable 3D noise (inverted Worley cells with a little value noise): puffy detail. */
function detailTexture() {
  const n = N3;
  const data = new Uint8Array(n * n * n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Worley: one random point per cell, on a tiling grid.
  const C = 6;
  const pts = new Float32Array(C * C * C * 3);
  for (let i = 0; i < C * C * C; i++) {
    pts[i * 3] = rnd();
    pts[i * 3 + 1] = rnd();
    pts[i * 3 + 2] = rnd();
  }
  const worley = (x, y, z, cells) => {
    const fx = x * cells, fy = y * cells, fz = z * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells, wz = ((cz % cells) + cells) % cells;
          const k = ((wx % C) + (wy % C) * C + (wz % C) * C * C) * 3;
          const px = cx + pts[k], py = cy + pts[k + 1], pz = cz + pts[k + 2];
          const d = (px - fx) ** 2 + (py - fy) ** 2 + (pz - fz) ** 2;
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best);
  };
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n, w = z / n;
        // Three octaves of cells: big puffs, smaller ones, fine wisps.
        const a = 1 - Math.min(1, worley(u, v, w, 3));
        const b = 1 - Math.min(1, worley(u, v, w, 6));
        const c = 1 - Math.min(1, worley(u, v, w, 12));
        const val = a * 0.6 + b * 0.28 + c * 0.12;
        data[x + y * n + z * n * n] = Math.max(0, Math.min(255, Math.round(val * 255)));
      }
    }
  }
  const t = new Data3DTexture(data, n, n, n);
  t.format = RedFormat;
  t.type = UnsignedByteType;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class VolumetricClouds {
  /**
   * @param {import('./clouds.js').CloudLayer} layer  the flat clouds (their colours; hidden while these show)
   */
  constructor(layer) {
    this.layer = layer;
    this.frame = 0;
    // 1. The cloud pattern around the camera (clouds.js cloudNoise).
    this.mapCentre = new Vector2();
    this.map = new WebGLRenderTarget(MAP, MAP, { minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.mapPass = new FullScreenQuad(new ShaderMaterial({
      uniforms: { ...cloudUniforms, centre: { value: this.mapCentre } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${CLOUD_GLSL}
        uniform vec2 centre;
        varying vec2 vUv;
        void main() {
          vec2 xz = centre + (vUv - 0.5) * ${SPAN.toFixed(1)};
          gl_FragColor = vec4(clamp(cloudNoise(xz), 0.0, 1.0), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    }));

    // 2. The clouds, at half the screen's size.
    this.rt = new WebGLRenderTarget(2, 2, { minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, type: HalfFloatType });
    const L = layer.uniforms;
    this.uniforms = {
      ...cloudUniforms,
      cloudMap: { value: this.map.texture },
      centre: { value: this.mapCentre },
      detail: { value: detailTexture() },
      invProj: { value: new Matrix4() },
      camWorld: { value: new Matrix4() },
      camPos: { value: new Vector3() },
      lightColor: L.lightColor,
      shadeColor: L.shadeColor,
      hazeColor: L.hazeColor,
      night: L.night,
      mistFade: L.mistFade,
      grey: L.grey,
      fogMistA: { value: fog4.a },
      fogMistB: { value: fog4.b },
      fogSun: { value: fog4.sun },
      fogUnder: { value: fog4.under },
      fogTop: { value: fog4.top },
    };
    this.pass = new FullScreenQuad(new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        precision highp sampler3D;
        uniform vec2 cloudOffset;
        uniform vec2 cloudEvolve;
        uniform float cloudCover;
        uniform vec3 cloudSunDir;
        uniform float cloudShadowStrength;
        uniform vec4 cloudShape;
        uniform vec4 cloudRoll;
        uniform sampler2D cloudMap;
        uniform vec2 centre;
        uniform sampler3D detail;
        uniform mat4 invProj;
        uniform mat4 camWorld;
        uniform vec3 camPos;
        uniform vec3 lightColor; uniform vec3 shadeColor; uniform vec3 hazeColor;
        uniform float night; uniform float mistFade; uniform float grey;
        varying vec2 vUv;
        ${FIELD_GLSL}
        float cloudThreshold() { return mix(0.66, 0.30, cloudCover) - max(cloudShape.w - 0.1, 0.0) * 0.6; }
        // The pattern (from the map), 0 outside it.
        float pattern(vec2 xz) {
          vec2 uv = (xz - centre) / ${SPAN.toFixed(1)} + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          return texture2D(cloudMap, uv).r;
        }
        // Cloud density (0..1) at a point: the pattern says where and how
        // tall (flat bases, rounded tops, the densest parts tallest), the 3D
        // detail eats into it (puffs at the edges, wisps).
        // lod: 0 for the samples towards the sun (cheapest), 0.5 looking
        // for cloud, 1 inside it (all the detail).
        float density(vec3 p, float lod) {
          float h = (p.y - cloudShape.x) / cloudShape.y;
          if (h < 0.0 || h > 1.0) return 0.0;
          float t = cloudThreshold();
          // (Drifting with the clouds, rising a little.)
          vec3 q = vec3(p.x + cloudOffset.x, p.y - cloudEvolve.x * 300.0, p.z + cloudOffset.y) / 900.0;
          // The outline wobbles with height (the pattern is flat: unwobbled,
          // every cloud would be a straight-sided column, its shading in
          // vertical flutes).
          vec2 warp = vec2(0.0);
          if (lod > 0.25) {
            vec3 wq = q * 0.45;
            warp = vec2(texture(detail, wq).r, texture(detail, wq + vec3(0.37, 0.11, 0.53)).r) - 0.5;
          }
          float n = pattern(p.xz + warp * cloudShape.y * 0.4 * (0.25 + h));
          float k = (n - t) / (cloudShape.w * 3.0 + 0.1);
          if (k <= 0.0) return 0.0;
          float kk = min(k, 1.2);
          // A dome: narrower higher up, the strongest parts the tallest.
          float body = kk - 1.1 * h * h;
          // Its base: flattish, but higher under the thin edges (the
          // underside curving up to them), and lumpy from cloud to cloud.
          float lump = texture(detail, vec3(q.xz * 0.23, 0.37)).r;
          float k1 = min(kk, 1.0);
          float bottom = 0.16 * (1.0 - k1) * (1.0 - k1) + 0.07 * (lump - 0.5) + 0.03;
          float d = smoothstep(0.0, 0.18, body) * smoothstep(bottom, bottom + 0.1, h);
          if (d <= 0.0) return 0.0;
          float det = texture(detail, q).r;
          if (lod > 0.75) det = det * 0.7 + texture(detail, q * 3.1).r * 0.3;
          // Thin parts eaten away more than the cores, and the underside more
          // (ragged, not ruled flat).
          float under = 1.0 - smoothstep(bottom, bottom + 0.2, h);
          return clamp((d - (1.0 - det) * (0.55 + 0.35 * under) * (1.1 - d)) * 1.2, 0.0, 1.0);
        }
        void main() {
          vec4 v = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 dir = normalize((camWorld * vec4(v.xyz / v.w, 0.0)).xyz);
          float base = cloudShape.x, T = cloudShape.y;
          // Through the layer (slab) along the line of sight.
          if (abs(dir.y) < 1e-4) { gl_FragColor = vec4(0.0); return; }
          float ta = (base - camPos.y) / dir.y, tb = (base + T - camPos.y) / dir.y;
          float t0 = max(min(ta, tb), 0.0), t1 = max(ta, tb);
          if (t1 <= 0.0) { gl_FragColor = vec4(0.0); return; }
          t1 = min(t1, t0 + 7000.0); // (far off it's haze anyway)
          // Big steps through clear air; on meeting cloud, back a step and
          // through it in small ones (so tall clouds don't show as slices).
          float coarse = (t1 - t0) / 24.0;
          float trans = 1.0;
          vec3 light = vec3(0.0);
          float distW = 0.0;
          // Sigma: how much each metre of cloud dims the light.
          float sigma = 0.012 + 0.012 * cloudShape.w * 5.0;
          float g = dot(dir, cloudSunDir);
          // Two-lobe phase: a bright glow looking towards the sun, a little back-scatter.
          float hg1 = (1.0 - 0.64) / pow(1.0 + 0.64 - 1.6 * g, 1.5);
          float hg2 = (1.0 - 0.09) / pow(1.0 + 0.09 + 0.6 * g, 1.5);
          float phase = mix(hg2, hg1, 0.7) * 0.6;
          vec3 sunCol = lightColor * (1.0 - 0.3 * grey);
          // (A fixed pattern from pixel to pixel, smoothed away when the
          // picture is enlarged: the steps don't show as lines or bands.)
          float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float t = t0 + coarse * 0.5;
          bool fine = false;
          int empty = 0;
          for (int i = 0; i < 60; i++) {
            if (trans < 0.03 || t > t1) break;
            // (Smaller close up, larger far off.)
            float fineDt = min(coarse, 30.0 + t * 0.008);
            vec3 p = camPos + dir * t;
            float d = density(p, fine ? 1.0 : 0.5);
            if (d <= 0.001) {
              if (fine && ++empty >= 4) fine = false; // out the other side
              t += fine ? fineDt : coarse;
              continue;
            }
            if (!fine) {
              fine = true;
              empty = 0;
              // (Each pixel's small steps start a little differently.)
              t = max(t0, t - coarse + fineDt * dither);
              continue;
            }
            empty = 0;
            // Light reaching here from the sun: a few samples towards it.
            float tau = 0.0;
            // (Offset per pixel too, or the shading comes out in bands.)
            for (int j = 0; j < 5; j++) {
              float jj = float(j) + 0.3 + 0.7 * dither;
              float s = jj * jj * 20.0;
              tau += density(p + cloudSunDir * s, 0.0) * (jj * 40.0);
            }
            // (Plus light that has bounced around inside: it gets deeper in.)
            float sunT = exp(-tau * sigma * 0.9) + 0.3 * exp(-tau * sigma * 0.18);
            // Powder: the sunlit side's edges a touch darker (light only
            // scatters out once it's gone a little way in).
            float powder = 1.0 - exp(-d * 6.0);
            // Sky light: brighter higher in the cloud.
            float hh = clamp((p.y - base) / T, 0.0, 1.0);
            vec3 amb = mix(shadeColor * 0.42, mix(shadeColor, lightColor, 0.5) * 0.85, hh);
            vec3 S = sunCol * sunT * phase * mix(1.0, powder, 0.5) * 2.2 + amb;
            float a = 1.0 - exp(-d * sigma * fineDt);
            light += trans * a * S;
            distW += trans * a * t;
            trans *= 1.0 - a;
            t += fineDt;
          }
          float alpha = 1.0 - trans;
          if (alpha < 0.003) { gl_FragColor = vec4(0.0); return; }
          vec3 c = light / alpha;
          c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))) * 0.9, grey);
          // Into the haze far off; through any mist on the way.
          float dist = distW / alpha;
          vec3 at = camPos + dir * dist;
          float far = length(at.xz - camPos.xz);
          c = mix(c, hazeColor, smoothstep(1000.0, 5500.0, far) * 0.9);
          alpha *= (1.0 - smoothstep(4000.0, 7000.0, far)) * mix(1.0, 0.8, night) * (1.0 - mistFade);
          if (fogMistA.x > 0.0 || fogMistA.z > 0.0) alpha *= exp(-vfAlong(camPos, at, hazeColor).x);
          gl_FragColor = vec4(c, alpha);
        }`,
      depthTest: false,
      depthWrite: false,
    }));

    // 3. Laid over the sky, behind everything else.
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new Mesh(geo, new ShaderMaterial({
      uniforms: { tex: { value: this.rt.texture }, texel: { value: new Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tex;
        uniform vec2 texel;
        varying vec2 vUv;
        void main() {
          // Enlarged with a slight blur (four samples between texels): smooths
          // the clouds' step pattern.
          vec4 c = 0.25 * (texture2D(tex, vUv + texel * vec2(0.5, 0.5)) + texture2D(tex, vUv + texel * vec2(-0.5, 0.5))
            + texture2D(tex, vUv + texel * vec2(0.5, -0.5)) + texture2D(tex, vUv + texel * vec2(-0.5, -0.5)));
          if (c.a < 0.003) discard;
          gl_FragColor = c;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -0.5; // (after the sky and cirrus)
    this.enabled = true;
  }

  /** Draw the clouds for this frame (before the scene). */
  render(renderer, camera) {
    const show = this.enabled && this.layer.lowOn && (this.layer.cover ?? 0) > 0.01;
    this.mesh.visible = show;
    if (!show) return;
    const prev = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(this._clear ||= new Color());
    const clearAlpha = renderer.getClearAlpha();
    const camPos = this.uniforms.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    renderer.autoClear = true;
    // The pattern map, every few frames, centred on the camera (on whole texels).
    const step = SPAN / MAP;
    const cx = Math.round(camPos.x / step) * step;
    const cz = Math.round(camPos.z / step) * step;
    if (this.frame++ % 4 === 0 || cx !== this.mapCentre.x || cz !== this.mapCentre.y) {
      this.mapCentre.set(cx, cz);
      renderer.setRenderTarget(this.map);
      this.mapPass.render(renderer);
    }
    // The clouds, at half the screen's size (in CSS pixels).
    const size = renderer.getSize(new Vector2());
    const w = Math.max(64, Math.round(size.x / 2));
    const h = Math.max(64, Math.round(size.y / 2));
    if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h);
      this.mesh.material.uniforms.texel.value.set(1 / w, 1 / h);
    }
    const u = this.uniforms;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    this.pass.render(renderer);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.autoClear = autoClear;
  }
}
