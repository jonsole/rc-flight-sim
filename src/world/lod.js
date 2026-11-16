// Level of detail for leafy crowns and bushes: the ones near the camera are
// drawn leafy (src/world/fluffy.js), the rest as plain solid shapes, which
// cost far less to draw. Re-sorted as the camera moves (not every frame:
// only once it has gone a little way), so flying FPV past a far wood brings
// its trees in leafy.
import { InstancedMesh, Color, Matrix4, InstancedBufferAttribute, Sphere, Vector3, Box3 } from 'three';
import { leafState } from './species.js';
import { LEAF_ROWS } from './fluffy.js';

const _c = new Color();
/**
 * The cross-fade: when a tree changes between leafy and its picture, both
 * are drawn for FADE_TIME seconds, each in a complementary scatter of
 * pixels that shifts from one to the other (addLodFade), so it fades
 * rather than pops. At rest nothing is faded.
 */
export const FADE_TIME = 0.6;
/** The clock the fades run by (seconds), shared by every faded material. */
export const lodFadeUniforms = { uLodTime: { value: 0 } };

/**
 * The close tier: trees nearer the camera than this (m) get detailed trunks
 * and branches. The switch is made per vertex, by the camera's live
 * position (addCloseSwitch), so the plain and detailed never both show.
 */
export const closeUniforms = { uCloseR: { value: 0 } };

/**
 * Draw a material's instances only near the camera (`near` true: the
 * detailed wood), or only away from it (the plain wood): the others fold
 * away to nothing.
 */
export function addCloseSwitch(material, near) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, closeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uCloseR;')
      .replace('#include <project_vertex>', `
        #ifdef USE_INSTANCING
        {
          float d = length(cameraPosition.xz - (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz);
          if (${near ? 'd > uCloseR' : 'd < uCloseR'}) transformed = vec3(0.0);
        }
        #endif
        #include <project_vertex>`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|close${near ? 'In' : 'Out'}`;
  material.needsUpdate = true;
  return material;
}
const now = () => performance.now() / 1000;

/**
 * Fade a material's instances by their aLod attribute: when they started
 * fading in (positive), or out (negative). `far` for the pictures, whose
 * pixel scatter is the leafy ones' opposite.
 */
export function addLodFade(material, far) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, lodFadeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLod;\nvarying float vLodKeep;\nuniform float uLodTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float t = clamp((uLodTime - abs(aLod)) / ${FADE_TIME.toFixed(2)}, 0.0, 1.0);
          vLodKeep = aLod >= 0.0 ? t : 1.0 - t;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLodKeep;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLodKeep < 0.999) {
          float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
          ${far ? 'if (1.0 - n > vLodKeep) discard;' : 'if (n >= vLodKeep) discard;'}
        }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|lodFade${far ? 'Far' : 'Near'}`;
  material.needsUpdate = true;
  return material;
}

export class CrownLod {
  /**
   * @param {object[]} items     trees or bushes
   * @param {object} o
   * @param {(item: object, out: Matrix4) => Matrix4} o.matrix  its crown's matrix
   * @param {(item: object, out: Color) => Color} o.color       its leaf colour
   * @param {(item: object) => number} o.shape                  which shape (index)
   * @param {import('three').BufferGeometry[]} o.leafy   leafy shapes
   * @param {import('three').BufferGeometry[]} o.solid   solid shapes
   * @param {import('three').Material} o.leafyMat
   * @param {import('three').Material} o.solidMat
   * @param {number} o.radius    leafy within this of the camera (m)
   * @param {(item, mesh, slot) => void} o.onDraw  where an item is now drawn
   */
  constructor(items, o) {
    this.items = items;
    this.o = o;
    this.radius = o.radius;
    const n = Math.max(1, items.length);
    this.leafy = o.leafy.map((g) => new InstancedMesh(g, o.leafyMat, n));
    this.solid = o.solid.map((g) => new InstancedMesh(g, o.solidMat, n));
    this.meshes = [...this.leafy, ...this.solid];
    for (const m of this.meshes) {
      m.count = 0;
      // Per instance: when it began fading in (+) or out (-).
      m.geometry.setAttribute('aLod', new InstancedBufferAttribute(new Float32Array(n), 1));
      // Per instance: how bare its leaves are (its species' own year).
      m.geometry.setAttribute('aBare', new InstancedBufferAttribute(new Float32Array(n), 1));
      // ... and its leaf shape (row of the leaf atlas, by species).
      m.geometry.setAttribute('aSpecies', new InstancedBufferAttribute(new Float32Array(n), 1));
    }
    // Each item's matrix, colour and shape, worked out once.
    this.m = items.map((it) => o.matrix(it, new Matrix4()));
    this.col = items.map((it) => o.color(it, new Color()).clone());
    this.shape = items.map((it) => o.shape(it));
    // Species (src/world/species.js): colours and leaf fall through the year.
    this.who = o.species ? items.map((it) => o.species(it)) : null;
    this.bare = new Float32Array(items.length);
    this.leafRow = items.map((_, i) => Math.max(0, LEAF_ROWS.indexOf(this.who?.[i]?.name)));
    // Bark colours (the branches drawn with the leafy crowns, by species).
    this.bark = items.map((it) => (o.bark ? o.bark(it, new Color()) : new Color(0x5a4632)));
    this.barkAttr = this.leafy.map(() => new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    this.pos = items.map((it, i) => [this.m[i].elements[12], this.m[i].elements[14]]);
    // Bounds of the whole set, for culling: worked out once (re-sorting
    // often, recomputing them each time would be the slow part).
    const box = new Box3();
    const v = new Vector3();
    for (const m of this.m) {
      v.setFromMatrixPosition(m);
      box.expandByPoint(v);
    }
    let big = 1;
    for (const m of this.m) big = Math.max(big, m.getMaxScaleOnAxis());
    this.sphere = box.isEmpty() ? new Sphere(new Vector3(), 1) : box.getBoundingSphere(new Sphere());
    this.sphere.radius += big * 1.6;
    // The close tier (o.close): detailed branches (crown matrix, per crown
    // shape) and trunks (trunk matrix, per trunk design), for the trees
    // near the camera.
    const c = o.close;
    if (c) {
      this.closeR = c.radius;
      this.closeWood = c.wood.map((g) => new InstancedMesh(g, c.woodMat, n));
      this.closeTrunk = (c.trunks ?? []).map((g) => new InstancedMesh(g, c.trunkMat, n));
      for (const m of [...this.closeWood, ...this.closeTrunk]) {
        m.count = 0;
        m.geometry.setAttribute('aSpecies', new InstancedBufferAttribute(new Float32Array(n), 1));
      }
      this.tm = c.trunkMatrix ? items.map((it) => c.trunkMatrix(it, new Matrix4())) : null;
      this.trunkKind = items.map((it) => c.trunkKind?.(it) ?? 0);
    }
    this.isLeafy = items.map(() => false);
    this.since = items.map(() => -1e4); // when it last changed (long ago: no fade)
    this.fadingUntil = 0;
    this.at = null;
  }

  /** The time of year (day 1-366): each tree's colour and leaf fall, for its species. */
  setSeason(day) {
    if (!this.who) return;
    for (let i = 0; i < this.items.length; i++) this.bare[i] = leafState(this.who[i], day, this.col[i]).bare;
    if (this.at) this.update(this.at[0], this.at[1], true);
  }

  /**
   * Re-sort for a camera at (x, z): when it has moved a little way, and
   * every frame while trees are fading (to drop the faded-out copies).
   */
  update(x, z, force = false) {
    const t = now();
    lodFadeUniforms.uLodTime.value = t;
    const moved = !this.at || Math.hypot(x - this.at[0], z - this.at[1]) > this.radius * 0.03;
    if (!force && !moved && t > this.fadingUntil + 0.05) return false;
    if (moved) this.at = [x, z];
    const [cx, cz] = this.at;
    // A little either way, so a tree on the edge doesn't keep swapping.
    const r2in = (this.radius * 0.97) ** 2;
    const r2out = (this.radius * 1.03) ** 2;
    const counts = this.meshes.map(() => 0);
    const nLeafy = this.leafy.length;
    const closeSort2 = (this.closeR + this.radius * 0.04 + 5) ** 2;
    const closeCounts = new Map();
    const putClose = (mesh, m, i) => {
      const slot = closeCounts.get(mesh) ?? 0;
      closeCounts.set(mesh, slot + 1);
      mesh.setMatrixAt(slot, m);
      mesh.setColorAt(slot, this.bark[i]);
      mesh.geometry.attributes.aSpecies.array[slot] = this.leafRow[i];
    };
    const put = (i, k, lod) => {
      const mesh = this.meshes[k];
      const slot = counts[k]++;
      mesh.setMatrixAt(slot, this.m[i]);
      mesh.setColorAt(slot, _c.copy(this.col[i]));
      mesh.geometry.attributes.aLod.array[slot] = lod;
      mesh.geometry.attributes.aBare.array[slot] = this.bare[i];
      mesh.geometry.attributes.aSpecies.array[slot] = this.leafRow[i];
      if (k < nLeafy) this.barkAttr[k].setXYZ(slot, this.bark[i].r, this.bark[i].g, this.bark[i].b);
      return [mesh, slot];
    };
    for (let i = 0; i < this.items.length; i++) {
      const dx = this.pos[i][0] - cx;
      const dz = this.pos[i][1] - cz;
      const d2 = dx * dx + dz * dz;
      const leafy = d2 < (this.isLeafy[i] ? r2out : r2in);
      // (At the start, or after an edit, everything starts where it is.)
      if (leafy !== this.isLeafy[i] && !force) {
        this.since[i] = t;
        this.fadingUntil = t + FADE_TIME;
      }
      this.isLeafy[i] = leafy;
      const fading = t - this.since[i] < FADE_TIME;
      const s = this.since[i];
      const a = leafy || fading ? put(i, this.shape[i], leafy ? s : -s) : null;
      const b = !leafy || fading ? put(i, nLeafy + this.shape[i], leafy ? -s : s) : null;
      // Where the editor moves it: the one it is becoming.
      const [mesh, slot] = (leafy ? a : b) ?? a ?? b;
      this.o.onDraw(this.items[i], mesh, slot);
      // Close: detailed wood (sorted generously: the shader makes the switch
      // at exactly closeR from where the camera is now).
      if (this.closeWood && d2 < closeSort2) {
        putClose(this.closeWood[this.shape[i]], this.m[i], i);
        if (this.tm && this.closeTrunk.length) putClose(this.closeTrunk[this.trunkKind[i]], this.tm[i], i);
      }
    }
    for (const m of [...(this.closeWood ?? []), ...(this.closeTrunk ?? [])]) {
      m.count = closeCounts.get(m) ?? 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.attributes.aSpecies.needsUpdate = true;
      m.boundingSphere = this.sphere;
    }
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.geometry.attributes.aLod.needsUpdate = true;
      m.geometry.attributes.aBare.needsUpdate = true;
      m.geometry.attributes.aSpecies.needsUpdate = true;
      if (k < nLeafy) this.barkAttr[k].needsUpdate = true;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.boundingSphere = this.sphere;
    });
    return true;
  }
}
