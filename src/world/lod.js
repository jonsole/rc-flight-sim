// Level of detail for leafy crowns and bushes: the ones near the camera are
// drawn leafy (src/world/fluffy.js), the rest as plain solid shapes, which
// cost far less to draw. Re-sorted as the camera moves (not every frame:
// only once it has gone a little way), so flying FPV past a far wood brings
// its trees in leafy.
import { InstancedMesh, Color, Matrix4 } from 'three';

const _c = new Color();

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
    for (const m of this.meshes) m.count = 0;
    // Each item's matrix, colour and shape, worked out once.
    this.m = items.map((it) => o.matrix(it, new Matrix4()));
    this.col = items.map((it) => o.color(it, new Color()).clone());
    this.shape = items.map((it) => o.shape(it));
    this.pos = items.map((it, i) => [this.m[i].elements[12], this.m[i].elements[14]]);
    this.isLeafy = items.map(() => false);
    this.at = null;
  }

  /** Re-sort for a camera at (x, z), if it has moved far enough since the last time. */
  update(x, z, force = false) {
    if (!force && this.at && Math.hypot(x - this.at[0], z - this.at[1]) < this.radius * 0.08) return false;
    this.at = [x, z];
    const r2in = (this.radius * 0.97) ** 2;
    const r2out = (this.radius * 1.03) ** 2;
    const counts = this.meshes.map(() => 0);
    const nLeafy = this.leafy.length;
    for (let i = 0; i < this.items.length; i++) {
      const dx = this.pos[i][0] - x;
      const dz = this.pos[i][1] - z;
      const d2 = dx * dx + dz * dz;
      // A little either way, so a tree on the edge doesn't keep swapping.
      const leafy = d2 < (this.isLeafy[i] ? r2out : r2in);
      this.isLeafy[i] = leafy;
      const k = leafy ? this.shape[i] : nLeafy + this.shape[i];
      const mesh = this.meshes[k];
      const slot = counts[k]++;
      mesh.setMatrixAt(slot, this.m[i]);
      mesh.setColorAt(slot, _c.copy(this.col[i]));
      this.o.onDraw(this.items[i], mesh, slot);
    }
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    });
    return true;
  }
}
