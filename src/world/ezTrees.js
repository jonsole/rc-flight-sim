// Realistic trees for the ring of woods round the flying field, from
// EZ-Tree (MIT, github.com/dgreenheck/ez-tree): branching trunks with bark
// textures and leaf cards with alpha cut-outs. A handful of variants are
// generated once, scaled to unit height, and instanced at the same spots
// and sizes the physics uses (src/sim/obstacles.js). The library is about
// 4 MB (mostly textures), so it's loaded after the game starts.
import {
  InstancedMesh, MeshLambertMaterial, MeshDepthMaterial, RGBADepthPacking, DoubleSide, Object3D, Color, Box3, Vector3,
} from 'three';
import { addCloudShadows } from './clouds.js';

// Variants: [preset, how many leaves to keep (performance), kind]
const DECIDUOUS = [['Oak Medium', 0.35], ['Ash Medium', 0.32], ['Aspen Medium', 0.6], ['Oak Large', 0.3]];
const CONIFERS = [['Pine Medium', 0.3], ['Pine Large', 0.35], ['Pine Small', 0.3]];
// Most round segments per branch level (trunk first).
const SEGMENTS = [5, 3, 3, 3];

/** Generate one variant: { branches, leaves } geometry normalised to 1 m tall, and materials. */
function variant(Tree, preset, leafKeep, seed) {
  const tree = new Tree();
  tree.loadPreset(preset);
  tree.options.seed = seed;
  // Lighter meshes (about 2-5k triangles a tree): fewer, bigger single leaf
  // cards and fewer sections and round segments along the branches.
  const o = tree.options;
  o.leaves.billboard = 'single';
  o.leaves.count = Math.max(3, Math.round(o.leaves.count * leafKeep));
  o.leaves.size *= 1.45;
  for (const k of Object.keys(o.branch.sections)) {
    o.branch.sections[k] = Math.max(k === '0' ? 4 : 1, Math.round(o.branch.sections[k] * (k === '0' ? 0.4 : 0.25)));
  }
  for (const k of Object.keys(o.branch.segments)) o.branch.segments[k] = Math.min(o.branch.segments[k], SEGMENTS[k] ?? 3);
  tree.generate();
  const bGeo = tree.branchesMesh.geometry;
  const lGeo = tree.leavesMesh.geometry;
  const box = new Box3().setFromBufferAttribute(bGeo.attributes.position);
  box.expandByPoint(new Box3().setFromBufferAttribute(lGeo.attributes.position).max);
  const h = box.max.y - Math.min(0, box.min.y);
  for (const g of [bGeo, lGeo]) {
    g.scale(1 / h, 1 / h, 1 / h);
    g.computeBoundingSphere();
  }
  const bSrc = tree.branchesMesh.material;
  const lSrc = tree.leavesMesh.material;
  const bark = addCloudShadows(new MeshLambertMaterial({ map: bSrc.map, normalMap: bSrc.normalMap, color: bSrc.color }));
  const leafMap = lSrc.map;
  const leaves = addCloudShadows(new MeshLambertMaterial({ map: leafMap, color: lSrc.color, alphaTest: lSrc.alphaTest ?? 0.5, side: DoubleSide }));
  addSway(leaves);
  // Leaf shadows follow the cut-outs, not whole cards.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: leafMap, alphaTest: lSrc.alphaTest ?? 0.5 });
  return { branches: bGeo, leaves: lGeo, bark, leafMat: leaves, depth };
}

/** Leaves sway a little in the wind (works with instancing). */
const swayUniforms = { uTime: { value: 0 } };
function addSway(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uTime = swayUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 w = position * 37.0;
          #ifdef USE_INSTANCING
            w += instanceMatrix[3].xyz * 0.37;
          #endif
          float s = sin(uTime * 1.3 + w.x + w.z) * 0.6 + sin(uTime * 2.7 + w.y * 1.7) * 0.4;
          transformed.xz += vec2(0.006, 0.004) * s * position.y;
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|treeSway`;
}

/**
 * Build the EZ-Tree woods for the given trees and add them to the scene.
 * @param {object[]} trees  obstacle trees to replace ({ x, y, z, h, conifer, rot })
 * @returns {Promise<{ meshes: InstancedMesh[], update(t: number): void }>}
 */
export async function buildEzTrees(scene, trees) {
  const { Tree } = await import('@dgreenheck/ez-tree');
  const pause = () => new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  const kinds = { false: [], true: [] };
  for (const [i, [preset, keep]] of DECIDUOUS.entries()) {
    kinds.false.push(variant(Tree, preset, keep, 1000 + i * 77));
    await pause();
  }
  for (const [i, [preset, keep]] of CONIFERS.entries()) {
    kinds.true.push(variant(Tree, preset, keep, 2000 + i * 91));
    await pause();
  }
  // Which variant each tree gets.
  const groups = new Map();
  trees.forEach((t, i) => {
    const list = kinds[String(!!t.conifer)];
    const k = Math.floor(((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1 * list.length) % list.length;
    const v = list[k];
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(t);
  });
  const o = new Object3D();
  const col = new Color();
  const meshes = [];
  for (const [v, ts] of groups) {
    const b = new InstancedMesh(v.branches, v.bark, ts.length);
    const l = new InstancedMesh(v.leaves, v.leafMat, ts.length);
    l.customDepthMaterial = v.depth;
    ts.forEach((t, i) => {
      o.position.set(t.x, t.y - 0.15, t.z);
      o.rotation.set(0, t.rot, 0);
      // A little taller than the physics' trunk-to-crown height reads right.
      o.scale.setScalar(t.h * 1.05);
      o.updateMatrix();
      b.setMatrixAt(i, o.matrix);
      l.setMatrixAt(i, o.matrix);
      // Slight colour differences between neighbouring trees.
      const k = 0.85 + (((Math.sin(t.x * 3.1 + t.z) * 9999) % 1 + 1) % 1) * 0.3;
      col.setRGB(k, k, k * 0.95);
      l.setColorAt(i, col);
    });
    for (const m of [b, l]) {
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      meshes.push(m);
    }
  }
  return {
    meshes,
    update(t) {
      swayUniforms.uTime.value = t;
    },
  };
}
