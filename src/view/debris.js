// Parts that break off in a crash: they leave the model with its momentum,
// tumble, bounce on the ground and come to rest. Purely visual.
import { Group, Vector3, Box3, Quaternion, Matrix4 } from 'three';

const GRAVITY = 9.81;
const _box = new Box3();
const _size = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3();
const _p = new Vector3();
const _m = new Matrix4();
const _inv = new Matrix4();

export class Debris {
  /**
   * @param {import('three').Scene} scene
   * @param {{ heightAt(x:number, z:number): number }} ground
   */
  constructor(scene, ground) {
    this.scene = scene;
    this.ground = ground;
    this.items = [];
  }

  /**
   * Detach objects from the model and throw them clear.
   * @param {import('three').Object3D[]} objects  the part's pieces
   * @param {object} aircraft  flight model (velocity, angular velocity)
   * @param {number} speed     impact speed (m/s), scales the scatter
   */
  spawn(objects, aircraft, speed = 3) {
    if (!objects?.length) return;
    // One container for the whole part, centred on it, so it tumbles about
    // its own middle.
    _box.makeEmpty();
    for (const o of objects) _box.expandByObject(o);
    if (_box.isEmpty()) return;
    const group = new Group();
    _box.getCenter(group.position);
    _box.getSize(_size);
    this.scene.add(group);
    group.updateMatrixWorld();
    for (const o of objects) {
      o.userData.broken = true;
      group.attach(o); // keeps its world transform
      o.traverse((m) => m.isMesh && (m.castShadow = true));
    }
    const scatter = Math.min(4, 0.8 + speed * 0.3);
    const vel = aircraft.velocity.clone().multiplyScalar(0.8);
    vel.x += (Math.random() - 0.5) * scatter;
    vel.y += Math.random() * scatter * 0.8 + 0.5;
    vel.z += (Math.random() - 0.5) * scatter;
    const spin = new Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(12);
    // Points on the pieces (in the container's frame) to keep above the
    // ground: a spread of each mesh's vertices, so a long wing tumbling end
    // over end can't poke through.
    const pts = [];
    group.updateMatrixWorld(true);
    _inv.copy(group.matrixWorld).invert();
    group.traverse((m) => {
      const pos = m.isMesh && m.geometry?.attributes.position;
      if (!pos) return;
      _m.multiplyMatrices(_inv, m.matrixWorld);
      const step = Math.max(1, Math.floor(pos.count / 48));
      for (let i = 0; i < pos.count; i += step) pts.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(_m));
    });
    const every = Math.ceil(pts.length / 200); // keep it cheap
    // Tracks in the snow (src/world/snowTracks.js): where it touches (touch),
    // where it landed hard (thud), and how wide a groove it leaves.
    const markHalf = Math.min(0.08, Math.max(0.02, Math.min(_size.x, _size.z) * 0.25));
    this.items.push({ group, vel, spin, pts: pts.filter((_, i) => i % every === 0), resting: false, touch: null, thud: null, markHalf });
  }

  update(dt) {
    for (const it of this.items) {
      if (it.resting) {
        it.touch = null;
        continue;
      }
      const g = it.group;
      it.vel.y -= GRAVITY * dt;
      it.vel.multiplyScalar(1 - Math.min(1, 0.6 * dt)); // air drag on light foam
      g.position.addScaledVector(it.vel, dt);
      const spinRate = it.spin.length();
      if (spinRate > 1e-3) {
        _axis.copy(it.spin).divideScalar(spinRate);
        _q.setFromAxisAngle(_axis, spinRate * dt);
        g.quaternion.premultiply(_q);
      }
      // How far the lowest point is below the ground.
      g.updateMatrix();
      let under = 0;
      let lx = 0;
      let lz = 0;
      for (const p of it.pts) {
        _p.copy(p).applyMatrix4(g.matrix);
        const u = this.ground.heightAt(_p.x, _p.z) - _p.y;
        if (u > under) {
          under = u;
          lx = _p.x;
          lz = _p.z;
        }
      }
      it.touch = under > 0 ? { x: lx, z: lz } : null;
      if (under > 0) {
        if (it.vel.y < -2) it.thud = { x: lx, z: lz };
        g.position.y += under;
        if (it.vel.y < 0) it.vel.y *= -0.3;
        it.vel.x *= 0.6;
        it.vel.z *= 0.6;
        it.spin.multiplyScalar(0.6);
        if (it.vel.length() < 0.15 && spinRate < 0.3) it.resting = true;
      }
    }
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.group);
      it.group.traverse((o) => {
        o.geometry?.dispose();
      });
    }
    this.items.length = 0;
  }
}
