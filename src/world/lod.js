// Level of detail for leafy crowns and bushes: the ones near the camera are
// drawn leafy (src/world/fluffy.js), the rest as plain solid shapes, which
// cost far less to draw. Re-sorted as the camera moves (not every frame:
// only once it has gone a little way), so flying FPV past a far wood brings
// its trees in leafy.
import { InstancedMesh, Color, Matrix4, InstancedBufferAttribute, Sphere, Vector3, Box3 } from 'three';
import { leafState, leafName } from './species.js';
import { LEAF_ROWS } from './fluffy.js';

const _c = new Color();
/**
 * The cross-fade: when a tree changes between leafy and its picture, both
 * are drawn for FADE_TIME seconds, each in a complementary scatter of
 * pixels that shifts from one to the other (addLodFade), so it fades
 * rather than pops. At rest nothing is faded.
 */
export const FADE_TIME = 1.0;
/** The clock the fades run by (seconds), shared by every faded material. */
export const lodFadeUniforms = { uLodTime: { value: 0 } };

/**
 * The close tier: trees nearer the camera than this (m) get detailed trunks
 * and branches. The switch is made per vertex, by the camera's live
 * position (addCloseSwitch), so the plain and detailed never both show.
 */
export const closeUniforms = { uCloseR: { value: 0 } };
/** The plain and detailed wood fade into each other over this either side of uCloseR (m). */
const CLOSE_BAND = 4;

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
      .replace('#include <common>', '#include <common>\nuniform float uCloseR;\nvarying float vCloseD;')
      .replace('#include <project_vertex>', `
        #ifdef USE_INSTANCING
        {
          float d = length(cameraPosition.xz - (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz);
          vCloseD = d;
          // Out of its range (and the fade band): folded away to nothing.
          if (${near ? 'd > uCloseR + CLOSE_BAND' : 'd < uCloseR - CLOSE_BAND'}) transformed = vec3(0.0);
        }
        #else
          vCloseD = 1e6;
        #endif
        #include <project_vertex>`)
      .replace('#include <common>', `#define CLOSE_BAND ${CLOSE_BAND.toFixed(1)}\n#include <common>`);
    // Across the band, plain and detailed share it pixel by pixel.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uCloseR;\nvarying float vCloseD;\n#define CLOSE_BAND ${CLOSE_BAND.toFixed(1)}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          float farK = smoothstep(uCloseR - CLOSE_BAND, uCloseR + CLOSE_BAND, vCloseD); // 0 close .. 1 far
          float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(91.345, 47.853))) * 24634.6345);
          ${near ? 'if (n < farK) discard;' : 'if (n >= farK) discard;'}
        }`);
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
    this.leafRow = items.map((_, i) => Math.max(0, LEAF_ROWS.indexOf(leafName(this.who?.[i]?.name))));
    // Bark colours (the branches drawn with the leafy crowns, by species).
    this.bark = items.map((it) => (o.bark ? o.bark(it, new Color()) : new Color(0x5a4632)));
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
    // The wood (o.wood), by crown shape and species (each grows its own):
    // plain branches with the leafy crowns (they fade with them), and close
    // to the camera detailed branches and trunks instead.
    const w = o.wood;
    this.woodMeshes = [];
    if (w) {
      this.closeR = w.closeRadius ?? 0;
      this.spName = items.map((_, i) => this.who?.[i]?.name ?? '');
      this.tm = w.trunkMatrix ? items.map((it) => w.trunkMatrix(it, new Matrix4())) : null;
      this.trunkKind = items.map((it) => w.trunkKind?.(it) ?? 0);
      // (Its geometry is only made when a tree first needs it: woodMesh.)
      const make = (map, key, geo, mat, role) => {
        if (!map.has(key)) {
          map.set(key, { geo, mat, role, n: 0 });
        }
        map.get(key).n++;
      };
      const plain = new Map();
      const close = new Map();
      const trunks = new Map();
      this.plainKey = [];
      this.closeKey = [];
      this.trunkKey = [];
      items.forEach((_, i) => {
        const sp = this.spName[i];
        const shape = this.shape[i];
        const kp = `${shape}|${sp}`;
        this.plainKey[i] = kp;
        make(plain, kp, () => w.plain(shape, sp), w.plainMat, 'twigs');
        if (w.close) {
          this.closeKey[i] = kp;
          make(close, kp, () => w.close(shape, sp), w.closeMat, 'closeWood');
        }
        if (w.trunk) {
          const kt = `${this.trunkKind[i]}|${sp}`;
          this.trunkKey[i] = kt;
          make(trunks, kt, () => w.trunk(this.trunkKind[i], sp), w.trunkMat, 'closeTrunk');
        }
      });
      this.plainWood = plain;
      this.closeWood = close;
      this.closeTrunk = trunks;
    }
    this.isLeafy = items.map(() => false);
    this.since = items.map(() => -1e4); // when it last changed (long ago: no fade)
    this.fadingUntil = 0;
    this.at = null;
  }

  /**
   * The mesh drawing one kind of wood (a crown shape and species, plain or
   * close up; or a trunk), made the first time a tree needs it: most kinds
   * are never needed (close-up wood only for trees right by the camera).
   * o.wood.added(mesh) puts a new one in the scene.
   */
  woodMesh(map, key) {
    const e = map.get(key);
    if (!e) return null;
    if (!e.mesh) {
      const geo = e.geo();
      const m = new InstancedMesh(geo, e.mat, e.n);
      m.count = 0;
      m.userData.role = e.role;
      // (Fades with its crown, for the plain branches.)
      geo.setAttribute('aLod', new InstancedBufferAttribute(new Float32Array(e.n), 1));
      m.boundingSphere = this.sphere;
      e.mesh = m;
      this.woodMeshes.push(m);
      this.o.wood.added?.(m);
    }
    return e.mesh;
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
    // (Fades run in the shaders by the clock: one more re-sort when they've
    // finished, to drop the faded-out copies, not one every frame.)
    const fadeDone = this.fadingUntil > 0 && t > this.fadingUntil + 0.05;
    if (!force && !moved && !fadeDone) return false;
    if (moved) this.at = [x, z];
    if (fadeDone) this.fadingUntil = 0;
    const [cx, cz] = this.at;
    // A little either way, so a tree on the edge doesn't keep swapping.
    const r2in = (this.radius * 0.97) ** 2;
    const r2out = (this.radius * 1.03) ** 2;
    const closeSortA = ((this.closeR ?? 0) + this.radius * 0.04 + 5) ** 2;
    // First, just see whether anything changes tier: rewriting every
    // instance (and sending it all to the GPU again) only when one does.
    this.isClose ||= this.items.map(() => false);
    let changed = force || fadeDone;
    for (let i = 0; i < this.items.length; i++) {
      const dx = this.pos[i][0] - cx;
      const dz = this.pos[i][1] - cz;
      const d2 = dx * dx + dz * dz;
      const leafy = d2 < (this.isLeafy[i] ? r2out : r2in);
      const close = d2 < closeSortA;
      if (leafy !== this.isLeafy[i] || close !== this.isClose[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const counts = this.meshes.map(() => 0);
    const nLeafy = this.leafy.length;
    const closeSort2 = ((this.closeR ?? 0) + this.radius * 0.04 + 5) ** 2;
    const woodCounts = new Map();
    const putWood = (mesh, m, i, lod = -1e4) => {
      const slot = woodCounts.get(mesh) ?? 0;
      woodCounts.set(mesh, slot + 1);
      mesh.setMatrixAt(slot, m);
      mesh.setColorAt(slot, this.bark[i]);
      mesh.geometry.attributes.aLod.array[slot] = lod;
    };
    const put = (i, k, lod) => {
      const mesh = this.meshes[k];
      const slot = counts[k]++;
      mesh.setMatrixAt(slot, this.m[i]);
      mesh.setColorAt(slot, _c.copy(this.col[i]));
      mesh.geometry.attributes.aLod.array[slot] = lod;
      mesh.geometry.attributes.aBare.array[slot] = this.bare[i];
      mesh.geometry.attributes.aSpecies.array[slot] = this.leafRow[i];
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
      this.isClose[i] = d2 < closeSortA;
      const fading = t - this.since[i] < FADE_TIME;
      const s = this.since[i];
      const a = leafy || fading ? put(i, this.shape[i], leafy ? s : -s) : null;
      const b = !leafy || fading ? put(i, nLeafy + this.shape[i], leafy ? -s : s) : null;
      // Where the editor moves it: the one it is becoming.
      const [mesh, slot] = (leafy ? a : b) ?? a ?? b;
      this.o.onDraw(this.items[i], mesh, slot);
      if (this.plainWood) {
        // Plain branches with the leafy crown (fading with it).
        if (a) putWood(this.woodMesh(this.plainWood, this.plainKey[i]), this.m[i], i, leafy ? s : -s);
        // Close: detailed wood (sorted generously: the shader makes the
        // switch at exactly closeR from where the camera is now).
        if (d2 < closeSort2) {
          if (this.closeKey[i]) putWood(this.woodMesh(this.closeWood, this.closeKey[i]), this.m[i], i);
          if (this.tm && this.trunkKey[i]) putWood(this.woodMesh(this.closeTrunk, this.trunkKey[i]), this.tm[i], i);
        }
      }
    }
    for (const m of this.woodMeshes) {
      m.count = woodCounts.get(m) ?? 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.attributes.aLod.needsUpdate = true;
      m.boundingSphere = this.sphere;
    }
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.geometry.attributes.aLod.needsUpdate = true;
      m.geometry.attributes.aBare.needsUpdate = true;
      m.geometry.attributes.aSpecies.needsUpdate = true;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.boundingSphere = this.sphere;
    });
    return true;
  }
}
