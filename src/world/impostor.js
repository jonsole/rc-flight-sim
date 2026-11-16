// Distant leafy crowns and bushes as "impostors": each leafy shape
// (src/world/fluffy.js) is drawn once, at start-up, into a texture (an
// atlas) as seen from a few heights: level, from 35° up and from 70° up. A
// distant tree is then one card showing that picture, turned to face the
// camera, the two nearest heights blended. Its leaves are lit with the
// directions (normals) drawn alongside, so the sun and the time of day work
// as for the leafy ones; and its bare branches are drawn too, so it goes
// through the seasons with them.
//
// Atlases (one column per shape, one row per height):
//   albedo  leaf colour, alpha = leaf there
//   normal  leaf normal (as seen by the drawing camera), alpha = the
//           season's leaf fall (uBare) by which that leaf has gone
//   bark    branch colour, alpha = branch there
import {
  WebGLRenderTarget, OrthographicCamera, Scene, Mesh, ShaderMaterial, BufferGeometry,
  Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter, DoubleSide, Color, SRGBColorSpace,
} from 'three';
import { leafTexture, LEAF_ROWS } from './fluffy.js';
import { SPECIES, BARK } from './species.js';
import { leafUniforms } from './trees.js';

/** Viewing heights drawn (degrees above level). */
export const ROWS = [0, 35, 70];
/** Sides drawn (azimuths, a quarter turn apart), so a tree turned any way shows the side you see. */
export const AZ = 4;
/** The card's half-size, in unit crowns (the leaf cards reach ~1.35). */
const FRAME = 1.45;

const BAKE_VERT = /* glsl */ `
  attribute vec2 aCorner;
  attribute vec3 aCard;
  attribute vec3 aFlat;
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vN;
  varying float vWhen;
  varying float vUp;
  uniform float uLeafy;
  uniform float uStretch;
  void main() {
    vUp = 0.5;
    // The crown stretched to its typical height (its leaf tufts kept round,
    // as the leafy trees draw them).
    vec3 transformed = position * vec3(1.0, uStretch, 1.0);
    if (uLeafy > 0.5) {
      float an = aCard.z * 6.2831853;
      vec2 cr = mat2(cos(an), sin(an), -sin(an), cos(an)) * aCorner * aCard.x;
      vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 off = camR * cr.x + camU * cr.y;
      if (dot(aFlat, aFlat) > 1e-6) {
        // (Flat sprays along their boughs, as on the leafy conifers.)
        vec3 along = normalize(aFlat);
        vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), along) + vec3(1e-4, 0.0, 0.0));
        vec2 cf = aCorner * aCard.x;
        off = along * cf.y * 1.2 + across * cf.x * 0.85;
      }
      transformed += off;
      vUp = clamp((transformed.y / uStretch + 0.6) / 1.3, 0.0, 1.0); // (as the leafy cards: up the crown)
      vWhen = aCard.y;
    } else vWhen = 1.0;
    vUv = uv;
    vCol = color;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }`;
const BAKE_FRAG = /* glsl */ `
  #define LEAF_GRID vec2(4.0, ${LEAF_ROWS.length}.0)
  uniform sampler2D uLeaf;
  uniform float uMode; // 0 colour, 1 normal and when
  uniform float uLeafRow;
  uniform float uLeafy;
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vN;
  varying float vWhen;
  varying float vUp;
  void main() {
    vec3 c = vCol;
    float fallAt = 1.0;
    if (uLeafy > 0.5) {
      // The leaf picture (src/world/fluffy.js leafTexture): brightness, and
      // the leaf's fall time, here turned into the season's leaf fall
      // (uBare) at which it has gone (fluffy.js LEAF_FALL, solved for it).
      vec4 t = texture2D(uLeaf, (vUv + vec2(1.0, uLeafRow)) / LEAF_GRID); // (its leaves, the second size: typical crowns, far off)
      if (t.a < 0.5) discard;
      float kk = pow(t.r / t.a, 2.2);
      c *= vec3(kk, kk, kk * 0.83);
      c *= mix(0.86, 1.06, vUp);
      float tint = t.b / t.a - 0.5; // each leaf's own tint (as on the leafy cards)
      c *= vec3(1.0 + tint * 0.25, 1.0 + tint * 0.05, 1.0 - tint * 0.35) * (1.0 + tint * 0.06);
      fallAt = clamp((t.g / t.a) / 1.02 / (1.0 + 0.8 * (1.0 - vWhen)), 0.0, 1.0);
    }
    // (Bark is drawn at half brightness: its colours go over 1.)
    if (uMode < 0.5) gl_FragColor = vec4(uLeafy > 0.5 ? c : c * 0.5, 1.0);
    else gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, fallAt);
  }`;

/**
 * Draw the atlases.
 * @param {import('three').WebGLRenderer} renderer
 * @param {{ leafy: BufferGeometry, twigs: BufferGeometry }[]} shapes  unit crowns
 * @param {number} tile  pixels per picture
 */
export function bakeImpostors(renderer, shapes, tile = 128) {
  const W = shapes.length * tile;
  const H = ROWS.length * AZ * tile;
  const target = () => {
    // Mipmaps for the distance: the pictures' edges are clear (and the
    // colours are divided by coverage when read), so they don't bleed.
    const t = new WebGLRenderTarget(W, H, { depthBuffer: true, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter });
    return t;
  };
  const albedo = target();
  const normal = target();
  const bark = target();
  const mat = new ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: { uLeaf: { value: leafTexture() }, uMode: { value: 0 }, uLeafy: { value: 1 }, uLeafRow: { value: LEAF_ROWS.indexOf('beech') }, uStretch: { value: 1 } },
    vertexColors: true,
    side: DoubleSide,
  });
  const scene = new Scene();
  const cam = new OrthographicCamera(-FRAME, FRAME, FRAME, -FRAME, 0.1, 20);
  const prev = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new Color()), alpha: renderer.getClearAlpha(), auto: renderer.autoClear, xr: renderer.xr.enabled, shadow: renderer.shadowMap.autoUpdate };
  renderer.xr.enabled = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  for (const [rt, mode, leafy] of [[albedo, 0, 1], [normal, 1, 1], [bark, 0, 0]]) {
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    mat.uniforms.uMode.value = mode;
    mat.uniforms.uLeafy.value = leafy;
    shapes.forEach((s, col) => {
      // (Its own leaves: a row of the leaf atlas; broadleaf crowns, beech.)
      mat.uniforms.uLeafRow.value = s.leafRow ?? LEAF_ROWS.indexOf('beech');
      const R = s.stretch ?? 1; // its height for its width, typically
      mat.uniforms.uStretch.value = R;
      const mesh = new Mesh(leafy ? s.leafy : s.twigs, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      ROWS.forEach((deg, row) => {
        for (let az = 0; az < AZ; az++) {
          const e = (deg * Math.PI) / 180;
          const th = (az / AZ) * Math.PI * 2;
          const D = 10 * Math.max(1, R);
          cam.position.set(Math.cos(e) * Math.cos(th) * D, Math.sin(e) * D, Math.cos(e) * Math.sin(th) * D);
          cam.up.set(0, 1, 0);
          cam.lookAt(0, 0, 0);
          // Framed as the card is drawn (makeImpostor: tall = sy cos + sx sin).
          const tall = R * Math.cos(e) + Math.sin(e);
          cam.top = FRAME * tall;
          cam.bottom = -FRAME * tall;
          cam.far = 20 * Math.max(1, R);
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld();
          const y = (row * AZ + az) * tile;
          rt.viewport.set(col * tile, y, tile, tile);
          rt.scissor.set(col * tile, y, tile, tile);
          rt.scissorTest = true;
          renderer.setRenderTarget(rt);
          renderer.clearDepth();
          renderer.render(scene, cam);
        }
      });
      scene.remove(mesh);
    });
    rt.scissorTest = false;
    rt.viewport.set(0, 0, W, H);
  }
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.color, prev.alpha);
  renderer.autoClear = prev.auto;
  renderer.xr.enabled = prev.xr;
  mat.dispose();
  return { albedo: albedo.texture, normal: normal.texture, bark: bark.texture, columns: shapes.length };
}

/** The impostor card for shape `index` (a quad, -1..1, that knows its shape). */
export function impostorGeometry(index) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setAttribute('aShape', new Float32BufferAttribute([index, index, index, index], 1));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeBoundingSphere();
  g.boundingSphere.radius = FRAME * 1.5;
  return g;
}

/**
 * Turn a leaf material (after addCloudShadows and addLeafShading, with the
 * FLUFFY define) into the impostor one.
 */
export function makeImpostor(material, atlas) {
  material.alphaTest = 0.5;
  material.side = DoubleSide;
  material.defines = { ...(material.defines || {}), FLUFFY: '', IMPOSTOR: '', SPECIES: '', CLOUD_PER_VERTEX: '' };
  const uniforms = {
    uImpAlbedo: { value: atlas.albedo },
    uImpNormal: { value: atlas.normal },
    uImpBark: { value: atlas.bark },
    uImpCols: { value: atlas.columns },
    uImpBarkCol: { value: LEAF_ROWS.map((n) => new Color().setHSL(...(SPECIES[n]?.bark ?? BARK), SRGBColorSpace)) },
  };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uBare = leafUniforms.uBare;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aShape;
        attribute float aBare;
        attribute float aSpecies;
        varying float vBare;
        varying float vSpecies;
        varying vec2 vImpUv;
        varying float vImpShape;
        varying float vImpRow;
        varying float vImpAz;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // Face the camera, kept upright (as the pictures were drawn).
          mat3 im = mat3(instanceMatrix);
          vec3 is2 = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
          vec3 org = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 toCam = normalize(cameraPosition - org);
          vec3 right = cross(vec3(0.0, 1.0, 0.0), toCam);
          right = length(right) < 1e-3 ? vec3(1.0, 0.0, 0.0) : normalize(right);
          vec3 up = cross(toCam, right);
          float el = asin(clamp(toCam.y, -1.0, 1.0));
          // Which pictures (heights) to blend.
          vImpRow = clamp(degrees(el) / 35.0, 0.0, ${ROWS.length - 1}.0 - 0.001);
          // ... and sides: the camera's direction in the tree's own (turned) frame.
          vec3 lc = (transpose(im) * toCam) / is2;
          vImpAz = mod(atan(lc.z, lc.x) / 6.2831853 * ${AZ}.0 + ${AZ}.0, ${AZ}.0);
          float sx = sqrt((is2.x + is2.z) * 0.5);
          float sy = sqrt(is2.y);
          // A squashed or stretched crown: the picture squashed to match.
          float tall = sy * cos(max(el, 0.0)) + sx * sin(max(el, 0.0));
          vec3 off = right * position.x * ${FRAME.toFixed(2)} * sx + up * position.y * ${FRAME.toFixed(2)} * tall;
          transformed = (transpose(im) * off) / is2;
          vImpUv = position.xy * 0.5 + 0.5;
          vImpShape = aShape;
          vBare = aBare;
          vSpecies = aSpecies;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uImpAlbedo;
        uniform sampler2D uImpNormal;
        uniform sampler2D uImpBark;
        uniform float uImpCols;
        varying vec2 vImpUv;
        varying float vImpShape;
        varying float vImpRow;
        varying float vImpAz;
        varying float vBare;
        varying float vSpecies;
        uniform vec3 uImpBarkCol[${LEAF_ROWS.length}];
        vec2 impAt(float row, float az) {
          return vec2((vImpShape + vImpUv.x) / uImpCols, (row * ${AZ}.0 + az + vImpUv.y) / ${ROWS.length * AZ}.0);
        }
        // A picture, blended between the two nearest heights and sides.
        vec4 impPick(sampler2D tex, float r0, float rt, float a0, float a1, float at) {
          vec4 lo = mix(texture2D(tex, impAt(r0, a0)), texture2D(tex, impAt(r0, a1)), at);
          vec4 hi = mix(texture2D(tex, impAt(r0 + 1.0, a0)), texture2D(tex, impAt(r0 + 1.0, a1)), at);
          return mix(lo, hi, rt);
        }`)
      .replace('#include <map_fragment>', `
        float r0 = floor(vImpRow);
        float rt = vImpRow - r0;
        float a0 = floor(vImpAz);
        float at = vImpAz - a0;
        float a1 = mod(a0 + 1.0, ${AZ}.0);
        vec4 alb = impPick(uImpAlbedo, r0, rt, a0, a1, at);
        vec4 nrm = impPick(uImpNormal, r0, rt, a0, a1, at);
        vec4 brk = impPick(uImpBark, r0, rt, a0, a1, at);
        // Leaves still on at this time of year (as on the leafy cards).
        float fallAt = nrm.a / max(alb.a, 0.01);
        bool leaf = alb.a > 0.35 && vBare < fallAt - 0.005;
        vec3 impN = vec3(0.0, 0.0, 1.0);
        if (leaf) {
          // (x0.8: the shade the leafy crowns' own leaves cast inside them,
          // which the picture, taking no shadows, lacks.)
          diffuseColor.rgb *= alb.rgb / max(alb.a, 0.01) * 0.8;
          impN = normalize(nrm.rgb / max(alb.a, 0.01) * 2.0 - 1.0);
        } else if (brk.a > 0.2) { // (twigs are thin: keep them joined up)
          // Bark: grey-brown, like the leafy trees' branches seen from afar
          // (and not the leaves' tint).
          // (Its species' bark, half way to the grey-brown of fine twigs.)
          diffuseColor.rgb *= brk.rgb / max(brk.a, 0.01) * mix(uImpBarkCol[int(vSpecies + 0.5)], vec3(0.1, 0.085, 0.075), 0.5);
          impN = normalize(vec3(0.0, 0.6, 0.8)); // twigs: lit mostly from above
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            diffuseColor.rgb /= max(vColor, vec3(0.05));
          #endif
        } else discard;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = impN;`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|impostor`;
  material.needsUpdate = true;
  return material;
}
