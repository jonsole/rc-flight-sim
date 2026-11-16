// Scenery editor: fly a free camera round the site, select trees, buildings
// and fences to move, resize, change or delete them, and add new trees and
// fences. Edits are kept in src/sim/edits.js (saved in this browser, can be
// exported); every change rebuilds the obstacles (what the aircraft hits and
// the wind) and the drawn scenery, so what you see is what you fly in.
//
// Keys: W A S D (or arrows) move, Q / E down / up, Shift faster; right-drag
// (or Alt + drag) to look; wheel to move forward and back; click to select
// or place; Delete removes the selection; Ctrl+Z undoes; Esc finishes a
// fence, clears the selection, then leaves the editor.
import {
  Raycaster, Vector2, Vector3, Box3, Box3Helper, Object3D, Color, BufferGeometry, Line, LineBasicMaterial, Float32BufferAttribute,
  Mesh, CylinderGeometry, MeshBasicMaterial,
} from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { heightAt } from '../sim/terrain.js';
import { LOCATION } from '../sim/location.js';
import { EDITS, saveEdits, replaceEdits, emptyEdits, editCount } from '../sim/edits.js';
import { insideFootprint } from '../sim/buildings.js';
import { crownOf } from '../sim/treeShapes.js';
import { buildingsMesh } from '../world/buildings.js';
import { pilotSpot } from '../sim/location.js';

/** Tree types in the editor (species: src/world/species.js). */
const TREE_KINDS = {
  mixed: 'Broadleaf (mixed)', oak: 'Oak', ash: 'Ash', sycamore: 'Sycamore', birch: 'Birch', beech: 'Beech', horseChestnut: 'Horse chestnut',
  conifer: 'Conifer (mixed)', scotsPine: 'Scots pine', spruce: 'Norway spruce', leyland: 'Leyland cypress', larch: 'Larch', yew: 'Yew',
};
/** The conifer ones among them. */
const CONIFER_KINDS = new Set(['conifer', 'scotsPine', 'spruce', 'leyland', 'larch', 'yew']);

const SPEED = 15; // m/s, x4 with Shift
// Where each kind's edits are kept (src/sim/edits.js).
const GROUP = { tree: 'trees', bush: 'bushes', building: 'buildings', fence: 'fences' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

export class Editor {
  /**
   * @param {{ world: import('../world/world.js').World, obstacles: import('../sim/obstacles.js').Obstacles,
   *   camera: import('three').PerspectiveCamera, canvas: HTMLCanvasElement, root: HTMLElement,
   *   onRebuilt: () => void, onExit: () => void, setGoogle?: (on: boolean) => void }} o
   *   setGoogle: show Google's tiles under your scenery while editing (sites with them on);
   *   setGoogleOpacity: how solid they are (0..1)
   */
  constructor(o) {
    Object.assign(this, o);
    this.active = false;
    this.tool = 'select'; // 'select' | 'tree' | 'fence'
    this.selected = null; // { kind: 'tree'|'building'|'fence', id }
    this.undo = [];
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = -0.3;
    this.fencePts = [];
    this._ray = new Raycaster();
    this._v = new Vector3();

    // Move gizmo, on a stand-in object at the selection.
    this.proxy = new Object3D();
    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setMode('translate');
    this.gizmo.showY = false;
    this.gizmo.setSpace('world');
    this.gizmo.attach(this.proxy);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      if (e.value) this.#dragStart();
      else {
        this.#dragEnd();
        this.#moved();
      }
    });
    // Show the move as it happens; it's committed on release.
    this.gizmo.addEventListener('objectChange', () => this.dragging && this.#dragPreview());
    this.gizmoHelper = this.gizmo.getHelper();
    this.highlight = new Box3Helper(new Box3(), new Color('#ffd400'));
    this.fenceLine = new Line(new BufferGeometry(), new LineBasicMaterial({ color: '#ffd400' }));
    this.fenceLine.frustumCulled = false;
    // Where pilots stand: the flight line, and a post at its middle.
    this.flightLine = new Line(new BufferGeometry(), new LineBasicMaterial({ color: '#4fd1ff' }));
    this.flightLine.frustumCulled = false;
    this.pilotMarker = new Mesh(new CylinderGeometry(0.25, 0.25, 1.8, 12).translate(0, 0.9, 0), new MeshBasicMaterial({ color: '#4fd1ff' }));

    this.#ui();
    this.#listen();
  }

  // --- Opening and closing -------------------------------------------------

  open() {
    this.active = true;
    const c = this.camera;
    // Start a little behind and above the pilot, looking at the field.
    c.position.set(0, 25, 45);
    this.yaw = 0;
    this.pitch = -0.35;
    c.fov = 60;
    c.updateProjectionMatrix();
    const s = this.world.scene;
    s.add(this.proxy, this.gizmoHelper, this.highlight, this.fenceLine, this.flightLine, this.pilotMarker);
    this.#drawFlightLine();
    this.#select(null);
    this.setTool('select');
    this.root.style.display = 'block';
    this.#status();
  }

  close() {
    this.active = false;
    const g = this.root.querySelector('.ed-google input');
    if (g) g.checked = false;
    this.#finishFence(false);
    this.#select(null);
    const s = this.world.scene;
    s.remove(this.proxy, this.gizmoHelper, this.highlight, this.fenceLine, this.flightLine, this.pilotMarker);
    this.root.style.display = 'none';
    this.onExit();
  }

  setTool(tool) {
    this.#finishFence(false);
    this.tool = tool;
    for (const b of this.root.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    this.#status();
  }

  // --- Every frame -----------------------------------------------------------

  update(dt) {
    const k = this.keys;
    const c = this.camera;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const step = SPEED * fast * dt;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const up = (k.has('KeyE') || k.has('PageUp') ? 1 : 0) - (k.has('KeyQ') || k.has('PageDown') ? 1 : 0);
    c.position.x += (-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * side) * step;
    c.position.z += (-Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * side) * step;
    c.position.y += up * step;
    // Never below the ground.
    c.position.y = Math.max(c.position.y, heightAt(c.position.x, c.position.z) + 1.5);
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    c.updateMatrixWorld();
  }

  // --- Input -------------------------------------------------------------------

  #listen() {
    const cv = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (!this.active || /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName ?? '')) return;
      this.keys.add(e.code);
      if (e.code === 'Escape') {
        if (this.fencePts.length) this.#finishFence(true);
        else if (this.selected) this.#select(null);
        else if (this.tool !== 'select') this.setTool('select');
        else this.close();
      } else if (e.code === 'Enter') this.#finishFence(true);
      else if (e.code === 'Delete' || e.code === 'Backspace') this.#delete();
      else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) this.#undo();
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Look: right-drag, or Alt + left-drag.
    cv.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.down = { x: e.clientX, y: e.clientY, look: e.button === 2 || e.altKey, moved: false, onGizmo: this.gizmoHover };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this.down) return;
      // Any real movement makes it a drag, not a click (gizmo drags included).
      const dx = e.clientX - this.down.x;
      const dy = e.clientY - this.down.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.down.moved = true;
      if (this.down.look && !this.dragging) {
        this.yaw -= e.movementX * 0.004;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.004));
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (!this.active || !this.down) return;
      const d = this.down;
      this.down = null;
      if (d.look || d.moved || d.onGizmo || this.dragging) return;
      if (e.target !== cv) return;
      this.#click(e);
    });
    cv.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const dir = this.camera.getWorldDirection(this._v);
      this.camera.position.addScaledVector(dir, -e.deltaY * 0.05);
    }, { passive: false });
    this.gizmo.addEventListener('hoveron', () => (this.gizmoHover = true));
    this.gizmo.addEventListener('hoveroff', () => (this.gizmoHover = false));
  }

  #pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Where a screen ray meets the ground (stepping along it), or null. */
  #groundAt(e) {
    this._ray.setFromCamera(this.#pointer(e), this.camera);
    const { origin, direction } = this._ray.ray;
    const p = new Vector3();
    let prev = 0;
    for (let t = 0; t < 4000; t += 1) {
      p.copy(origin).addScaledVector(direction, t);
      if (p.y <= heightAt(p.x, p.z)) {
        // Refine between the last two steps.
        let a = prev;
        let b = t;
        for (let i = 0; i < 12; i++) {
          const m = (a + b) / 2;
          p.copy(origin).addScaledVector(direction, m);
          if (p.y <= heightAt(p.x, p.z)) b = m;
          else a = m;
        }
        p.y = heightAt(p.x, p.z);
        return p;
      }
      prev = t;
      if (t > 200) t += 2; // coarser further out
    }
    return null;
  }

  #click(e) {
    if (this.tool === 'tree') {
      const g = this.#groundAt(e);
      if (!g) return;
      this.#commit(() => EDITS.trees.added.push({ x: round(g.x), z: round(g.z), h: 12, r: 4, conifer: false }));
      this.#select({ kind: 'tree', id: `new:${EDITS.trees.added.length - 1}` });
      return;
    }
    if (this.tool === 'bush') {
      const g = this.#groundAt(e);
      if (!g) return;
      this.#commit(() => EDITS.bushes.added.push({ x: round(g.x), z: round(g.z), h: 2, w: 1.6 }));
      this.#select({ kind: 'bush', id: `new:${EDITS.bushes.added.length - 1}` });
      return;
    }
    if (this.tool === 'windsock') {
      const g = this.#groundAt(e);
      if (!g) return;
      this.#commit(() => (EDITS.site.windsock = { x: round(g.x), z: round(g.z) }));
      this.setTool('select');
      this.#select({ kind: 'windsock' });
      return;
    }
    if (this.tool === 'fence' || this.tool === 'hedge' || this.tool === 'flightline') {
      const g = this.#groundAt(e);
      if (!g) return;
      this.fencePts.push([round(g.x), round(g.z)]);
      this.#drawFenceLine();
      // A flight line is just its two ends.
      if (this.tool === 'flightline' && this.fencePts.length === 2) this.#finishFence(true);
      this.#status();
      return;
    }
    // Select: the nearest site object under the pointer.
    this._ray.setFromCamera(this.#pointer(e), this.camera);
    const pickable = [...this.world.siteObjects, ...(this.obstacles.windsock ? [this.world.windsockGroup] : [])];
    const hits = this._ray.intersectObjects(pickable, true).filter((h) => h.object.userData.kind || h.object.parent?.userData.kind === 'windsock' || isIn(h.object, this.world.windsockGroup));
    const hit = hits[0];
    if (!hit) {
      this.#select(null);
      return;
    }
    const p = hit.point;
    const ob = this.obstacles;
    const kind = isIn(hit.object, this.world.windsockGroup) ? 'windsock' : hit.object.userData.kind;
    if (kind === 'windsock') {
      this.#select({ kind: 'windsock' });
      return;
    }
    if (kind === 'bush') {
      let best = null;
      let bd = Infinity;
      for (const b of ob.bushes) {
        const d = Math.hypot(b.x - p.x, b.z - p.z) - b.w;
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      this.#select(best ? { kind: 'bush', id: best.id } : null);
      return;
    }
    if (kind === 'tree') {
      let best = null;
      let bd = Infinity;
      for (const t of ob.trees) {
        const d = Math.hypot(t.x - p.x, t.z - p.z) - crownOf(t).radius;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      this.#select(best ? { kind: 'tree', id: best.id } : null);
    } else if (kind === 'building') {
      let best = ob.buildings.find((b) => insideFootprint(b, p.x, p.z));
      if (!best) {
        let bd = Infinity;
        for (const b of ob.buildings) {
          const d = Math.hypot((b.x0 + b.x1) / 2 - p.x, (b.z0 + b.z1) / 2 - p.z);
          if (d < bd) {
            bd = d;
            best = b;
          }
        }
      }
      this.#select(best ? { kind: 'building', id: best.index } : null);
    } else if (kind === 'fence') {
      let best = null;
      let bd = Infinity;
      for (const f of ob.fences) {
        for (let i = 1; i < f.path.length; i++) {
          const d = segDist(p.x, p.z, f.path[i - 1], f.path[i]);
          if (d < bd) {
            bd = d;
            best = f;
          }
        }
      }
      this.#select(best ? { kind: 'fence', id: best.index } : null);
    }
  }

  // --- Selection ---------------------------------------------------------------

  /** The selected object as it is now (after rebuilds), or null. */
  #current() {
    const s = this.selected;
    if (!s) return null;
    const ob = this.obstacles;
    if (s.kind === 'tree') return ob.trees.find((t) => t.id === s.id) ?? null;
    if (s.kind === 'bush') return ob.bushes.find((b) => b.id === s.id) ?? null;
    if (s.kind === 'building') return ob.buildings.find((b) => b.index === s.id) ?? null;
    if (s.kind === 'windsock') return ob.windsock;
    return ob.fences.find((f) => f.index === s.id) ?? null;
  }

  #select(sel) {
    this.selected = sel;
    const o = this.#current();
    if (!o) this.selected = null;
    this.gizmoHelper.visible = !!o;
    this.gizmo.enabled = !!o;
    this.highlight.visible = !!o;
    if (o) {
      const box = this.highlight.box;
      this.#boxFor(this.selected.kind, o, box);
      box.getCenter(this.proxy.position);
      this.proxy.position.y = box.min.y;
    }
    this.#panel();
  }

  /** The selection's bounds (a tree as `o`, possibly with changes not yet committed). */
  #boxFor(kind, o, box) {
    if (kind === 'tree') {
      const r = crownOf(o).radius;
      const y = heightAt(o.x, o.z);
      box.set(new Vector3(o.x - r, y, o.z - r), new Vector3(o.x + r, y + o.h, o.z + r));
    } else if (kind === 'bush') {
      const y = heightAt(o.x, o.z);
      box.set(new Vector3(o.x - o.w, y, o.z - o.w), new Vector3(o.x + o.w, y + o.h, o.z + o.w));
    } else if (kind === 'windsock') {
      const y = heightAt(o.x, o.z);
      box.set(new Vector3(o.x - 0.6, y, o.z - 0.6), new Vector3(o.x + 0.6, y + o.height + 0.3, o.z + 0.6));
    } else if (kind === 'building') {
      box.set(new Vector3(o.x0, o.y0, o.z0), new Vector3(o.x1, o.ridge, o.z1));
    } else {
      box.makeEmpty();
      for (const [x, z] of o.path) {
        const y = heightAt(x, z);
        box.expandByPoint(new Vector3(x, y, z));
        box.expandByPoint(new Vector3(x, y + o.height, z));
      }
    }
    return box;
  }

  // --- Live previews (before the edit is committed) -------------------------

  /** Tree: redraw it with `spec` changed, and box it. */
  #previewTree(spec) {
    const o = this.#current();
    if (!o || this.selected.kind !== 'tree') return;
    this.world.moveTreeDrawing(o, spec);
    const p = { ...o, ...spec };
    this.#boxFor('tree', p, this.highlight.box);
  }

  /** Bush: redraw it with `spec` changed, and box it. */
  #previewBush(spec) {
    const o = this.#current();
    if (!o || this.selected.kind !== 'bush') return;
    this.world.moveBushDrawing(o, spec);
    this.#boxFor('bush', { ...o, ...spec }, this.highlight.box);
  }

  #dragStart() {
    this.dragFrom = this.proxy.position.clone();
    this.boxFrom = this.highlight.box.clone();
    const o = this.#current();
    const s = this.selected;
    if (s?.kind === 'fence') this.dragObj = this.world.siteObjects.find((g) => g.userData.fenceIndex === o.index);
    if (s?.kind === 'building') {
      // The buildings are one mesh: drag a copy of this one.
      this.dragObj = buildingsMesh([o]);
      this.world.scene.add(this.dragObj);
    }
  }

  #dragPreview() {
    const dx = this.proxy.position.x - this.dragFrom.x;
    const dz = this.proxy.position.z - this.dragFrom.z;
    const o = this.#current();
    if (!o) return;
    if (this.selected.kind === 'tree') this.#previewTree({ x: o.x + dx, z: o.z + dz });
    else if (this.selected.kind === 'bush') this.#previewBush({ x: o.x + dx, z: o.z + dz });
    else if (this.selected.kind === 'windsock') {
      this.world.windsockGroup.position.set(o.x + dx, heightAt(o.x + dx, o.z + dz), o.z + dz);
      this.highlight.box.copy(this.boxFrom).translate(new Vector3(dx, 0, dz));
    } else {
      this.dragObj?.position.set(dx, 0, dz);
      this.highlight.box.copy(this.boxFrom).translate(new Vector3(dx, 0, dz));
    }
  }

  #dragEnd() {
    if (this.selected?.kind === 'building' && this.dragObj) {
      this.world.scene.remove(this.dragObj);
      this.dragObj.geometry.dispose();
    }
    this.dragObj = null;
  }

  // --- Changing things ---------------------------------------------------------

  /** Make a change to the edits: undoable, saved, and rebuilt into the world. */
  #commit(change) {
    this.undo.push(JSON.stringify(EDITS));
    if (this.undo.length > 100) this.undo.shift();
    change();
    this.#rebuild();
  }

  #rebuild() {
    saveEdits(LOCATION.id);
    this.obstacles.reload();
    this.world.rebuildSite();
    this.onRebuilt();
    this.#select(this.selected);
    this.#drawFlightLine();
    this.#status();
  }

  #undo() {
    const prev = this.undo.pop();
    if (!prev) return;
    replaceEdits(JSON.parse(prev));
    this.#rebuild();
  }

  /** The edit record for the selection: an added item, or the changes to a baked one. */
  #record(create = true) {
    const s = this.selected;
    const group = EDITS[GROUP[s.kind]];
    if (typeof s.id === 'string' && s.id.startsWith('new:')) return group.added[Number(s.id.slice(4))];
    if (!group.changed[s.id] && create) group.changed[s.id] = {};
    return group.changed[s.id];
  }

  /** Change properties of the selection (h, r, conifer, height, kind...). */
  #set(props) {
    if (!this.selected) return;
    this.#commit(() => Object.assign(this.#record(), props));
  }

  /** The gizmo was dragged: move the selection by as much. */
  #moved() {
    const o = this.#current();
    if (!o || !this.dragFrom) return;
    const dx = round(this.proxy.position.x - this.dragFrom.x);
    const dz = round(this.proxy.position.z - this.dragFrom.z);
    if (!dx && !dz) return;
    const s = this.selected;
    if (s.kind === 'windsock') {
      this.#commit(() => (EDITS.site.windsock = { x: round(o.x + dx), z: round(o.z + dz) }));
      return;
    }
    this.#commit(() => {
      const r = this.#record();
      if (s.kind === 'tree' || s.kind === 'bush') Object.assign(r, { x: round(o.x + dx), z: round(o.z + dz) });
      else if (s.kind === 'building') Object.assign(r, { dx: round((r.dx ?? 0) + dx), dz: round((r.dz ?? 0) + dz) });
      else r.path = o.path.map(([x, z]) => [round(x + dx), round(z + dz)]);
    });
  }

  #delete() {
    const s = this.selected;
    if (!s) return;
    if (s.kind === 'windsock') {
      this.#commit(() => (EDITS.site.windsock = false));
      this.#select(null);
      return;
    }
    this.#commit(() => {
      const group = EDITS[GROUP[s.kind]];
      if (typeof s.id === 'string' && s.id.startsWith('new:')) group.added.splice(Number(s.id.slice(4)), 1);
      else {
        group.removed.push(s.id);
        delete group.changed[s.id];
      }
    });
    this.#select(null);
  }

  #drawFenceLine() {
    const pts = this.fencePts.flatMap(([x, z]) => [x, heightAt(x, z) + 1.2, z]);
    this.fenceLine.geometry.setAttribute('position', new Float32BufferAttribute(pts, 3));
    this.fenceLine.geometry.computeBoundingSphere();
    this.fenceLine.visible = pts.length >= 6;
  }

  /** End the fence being drawn: add it (keep) or throw it away. */
  #finishFence(keep) {
    const pts = this.fencePts;
    this.fencePts = [];
    this.#drawFenceLine();
    if (keep && pts.length >= 2) {
      if (this.tool === 'hedge') {
        // A row of bushes every 2.5 m along the line.
        this.#commit(() => {
          for (let i = 1; i < pts.length; i++) {
            const [ax, az] = pts[i - 1];
            const [bx, bz] = pts[i];
            const len = Math.hypot(bx - ax, bz - az);
            for (let d = i === 1 ? 0 : 2.5; d <= len; d += 2.5) {
              const t = len ? d / len : 0;
              EDITS.bushes.added.push({ x: round(ax + (bx - ax) * t), z: round(az + (bz - az) * t), h: 2, w: 1.6 });
            }
          }
        });
      } else if (this.tool === 'flightline') {
        this.#commit(() => (EDITS.site.flightLine = pts.slice(0, 2)));
        this.setTool('select');
      } else {
        this.#commit(() => EDITS.fences.added.push({ path: pts, height: 2, kind: 'panels' }));
        this.#select({ kind: 'fence', id: `new:${EDITS.fences.added.length - 1}` });
      }
    }
    this.#status();
  }

  /** The flight line (where pilots stand) and the pilot's spot, while editing. */
  #drawFlightLine() {
    const fl = EDITS.site.flightLine;
    const g = this.flightLine.geometry;
    const pts = fl ? fl.flatMap(([x, z]) => [x, heightAt(x, z) + 0.15, z]) : [];
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    g.computeBoundingSphere();
    this.flightLine.visible = !!fl;
    const [px, pz] = pilotSpot();
    this.pilotMarker.position.set(px, heightAt(px, pz), pz);
  }

  // --- Panels -------------------------------------------------------------------

  #ui() {
    const tool = (id, label, title) => el('button', { 'data-tool': id, title, onclick: () => this.setTool(id) }, label);
    this.statusEl = el('span', { class: 'ed-status' });
    this.panelEl = el('div', { class: 'ed-panel' });
    const fileIn = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: (e) => this.#import(e) });
    this.root.replaceChildren(
      el('div', { class: 'ed-bar' },
        el('strong', {}, 'Scenery editor'),
        tool('select', 'Select', 'Click a tree, building or fence'),
        tool('tree', '+ Tree', 'Click the ground to plant a tree'),
        tool('bush', '+ Bush', 'Click the ground to plant a bush'),
        tool('hedge', '+ Hedge', 'Click points along the ground for a row of bushes, then Enter'),
        tool('fence', '+ Fence', 'Click points along the ground, then Enter'),
        tool('flightline', 'Flight line', 'Click the two ends of the line pilots stand along'),
        tool('windsock', 'Windsock', 'Click the ground to put the windsock there'),
        el('button', { onclick: () => this.#undo(), title: 'Ctrl+Z' }, 'Undo'),
        el('button', { onclick: () => this.#export(), title: 'Save your edits to a file' }, 'Export'),
        el('button', { onclick: () => fileIn.click(), title: 'Load edits from a file' }, 'Import'),
        el('button', { onclick: () => this.#clearAll(), title: 'Throw away all edits at this field' }, 'Clear all'),
        ...(this.setGoogle ? [el('label', { class: 'ed-google', title: 'Show Google photorealistic tiles with your scenery on top' },
          el('input', { type: 'checkbox', onchange: (e) => this.setGoogle(e.target.checked) }), ' Google tiles'),
        el('label', { class: 'ed-google', title: 'How see-through the Google tiles are' }, 'opacity',
          el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: 1, class: 'ed-opacity', oninput: (e) => this.setGoogleOpacity?.(Number(e.target.value)) }))] : []),
        el('button', { class: 'ed-done', onclick: () => this.close() }, 'Done ▶'),
        fileIn),
      this.statusEl,
      this.panelEl,
      el('div', { class: 'ed-help' }, 'W A S D move · Q / E down / up · Shift faster · right-drag look · wheel zoom · Delete removes · Ctrl+Z undo · Esc back'),
    );
  }

  #status() {
    const n = editCount();
    let hint = 'Click a tree, building or fence to select it.';
    if (this.tool === 'tree') hint = 'Click the ground to plant a tree.';
    if (this.tool === 'bush') hint = 'Click the ground to plant a bush.';
    if (this.tool === 'windsock') hint = 'Click the ground to put the windsock there.';
    if (this.tool === 'flightline') hint = this.fencePts.length ? 'Now click the other end of the flight line.' : 'Click one end of the line pilots stand along (you stand at its middle).';
    if (this.tool === 'fence' || this.tool === 'hedge') {
      const what = this.tool === 'fence' ? 'a new fence' : 'a hedge (a bush every 2.5 m)';
      hint = this.fencePts.length ? `${this.fencePts.length} point(s): click more, Enter to finish, Esc to cancel.` : `Click points along the ground for ${what}.`;
    }
    this.statusEl.textContent = `${LOCATION.name}: ${n} edit${n === 1 ? '' : 's'} (saved in this browser). ${hint}`;
  }

  #panel() {
    const o = this.#current();
    const s = this.selected;
    if (!o) {
      this.panelEl.style.display = 'none';
      return;
    }
    this.panelEl.style.display = 'block';
    // `live(v)`, if given, previews the value while the slider moves; `apply`
    // commits it on release.
    const slider = (label, value, min, max, stepV, unit, apply, live) => {
      const out = el('span', { class: 'ed-val' }, `${value.toFixed(1)} ${unit}`);
      const inp = el('input', {
        type: 'range', min, max, step: stepV, value,
        oninput: (e) => {
          out.textContent = `${Number(e.target.value).toFixed(1)} ${unit}`;
          live?.(Number(e.target.value));
        },
        onchange: (e) => apply(Number(e.target.value)),
      });
      return el('label', { class: 'ed-row' }, el('span', {}, label), inp, out);
    };
    const rows = [];
    if (s.kind === 'tree') {
      rows.push(el('h4', {}, 'Tree'));
      const c = crownOf(o);
      // Live: the tree as the sliders stand (height keeps where the canopy
      // starts in metres).
      const live = { h: o.h, crownW: c.radius, base: c.base };
      const show = (change) => {
        Object.assign(live, change);
        this.#previewTree({ ...live });
      };
      rows.push(slider('Height', o.h, 2, 35, 0.5, 'm', (v) => this.#set({ h: v, base: round3((c.base * o.h) / v) }),
        (v) => show({ h: v, base: (c.base * o.h) / v })));
      rows.push(slider(o.conifer ? 'Base radius' : 'Crown radius', c.radius, 0.5, 15, 0.25, 'm', (v) => this.#set({ r: v }),
        (v) => show({ crownW: v })));
      // Where the leaves start, in metres up the trunk (stored as a fraction of the height).
      rows.push(slider('Canopy starts', c.base * o.h, 0, o.h * 0.7, 0.1, 'm', (v) => this.#set({ base: round3(v / o.h) }),
        (v) => show({ base: v / live.h })));
      // Broadleaf (one species, or the natural mix) or conifer.
      const kind = o.conifer ? o.species ?? 'conifer' : o.species ?? 'mixed';
      const sel = el('select', {
        onchange: (e) => {
          const v = e.target.value;
          const conifer = CONIFER_KINDS.has(v);
          this.#set({ conifer, species: v === 'conifer' ? 'mixed' : v });
        },
      }, ...Object.entries(TREE_KINDS).map(([v, label]) => el('option', { value: v, selected: v === kind }, label)));
      rows.push(el('label', { class: 'ed-row' }, el('span', {}, 'Type'), sel));
    } else if (s.kind === 'bush') {
      const live = { h: o.h, w: o.w };
      const show = (change) => this.#previewBush(Object.assign(live, change));
      rows.push(el('h4', {}, 'Bush'));
      rows.push(slider('Height', o.h, 0.3, 6, 0.1, 'm', (v) => this.#set({ h: v }), (v) => show({ h: v })));
      rows.push(slider('Width', o.w * 2, 0.5, 10, 0.1, 'm', (v) => this.#set({ w: v / 2 }), (v) => show({ w: v / 2 })));
    } else if (s.kind === 'windsock') {
      rows.push(el('h4', {}, 'Windsock'));
    } else if (s.kind === 'building') {
      // Height above its lowest corner (prepareBuilding sinks y0 0.3 m below it).
      rows.push(el('h4', {}, `Building (${o.kind === 'yes' ? 'building' : o.kind})`));
      rows.push(slider('Height', o.ridge - (o.y0 + 0.3), 2, 40, 0.5, 'm', (v) => this.#set({ h: v })));
    } else {
      rows.push(el('h4', {}, 'Fence'));
      rows.push(slider('Height', o.height, 0.8, 4, 0.1, 'm', (v) => this.#set({ height: v })));
      const sel = el('select', { onchange: (e) => this.#set({ kind: e.target.value }) },
        el('option', { value: 'panels', selected: o.kind === 'panels' }, 'Temporary panels'),
        el('option', { value: 'chainlink', selected: o.kind !== 'panels' }, 'Chain link'));
      rows.push(el('label', { class: 'ed-row' }, el('span', {}, 'Type'), sel));
    }
    rows.push(el('p', { class: 'ed-hint' }, 'Drag the arrows to move it.'));
    rows.push(el('button', { class: 'ed-delete', onclick: () => this.#delete() }, 'Delete'));
    this.panelEl.replaceChildren(...rows);
  }

  // --- Files -------------------------------------------------------------------

  #export() {
    const blob = new Blob([JSON.stringify({ site: LOCATION.id, edits: EDITS }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${LOCATION.id}-scenery-edits.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async #import(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      if (j.site && j.site !== LOCATION.id && !confirm(`These edits are for "${j.site}", not ${LOCATION.name}. Load them anyway?`)) return;
      this.#commit(() => replaceEdits(j.edits ?? j));
    } catch (err) {
      alert(`Couldn't read that file: ${err.message}`);
    }
  }

  #clearAll() {
    if (!editCount() || !confirm(`Throw away all ${editCount()} edits at ${LOCATION.name}?`)) return;
    this.#commit(() => replaceEdits(emptyEdits()));
    this.#select(null);
  }
}

const round = (v) => Math.round(v * 10) / 10;

/** Is `o` (a picked mesh) part of `root`? */
function isIn(o, root) {
  for (let p = o; p; p = p.parent) if (p === root) return true;
  return false;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

function segDist(px, pz, [ax, az], [bx, bz]) {
  const ex = bx - ax;
  const ez = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(ax + ex * t - px, az + ez * t - pz);
}
