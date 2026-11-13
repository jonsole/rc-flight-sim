// Parts that break off in a crash: they leave the model with its momentum,
// tumble, bounce on the ground and come to rest. Purely visual.
import { Group, Vector3, Box3, Quaternion } from 'three';

const GRAVITY = 9.81;
const _box = new Box3();
const _size = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3();

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
    this.items.push({ group, vel, spin, radius: Math.max(0.02, Math.min(_size.x, _size.y, _size.z) * 0.5 + 0.01), resting: false });
  }

  update(dt) {
    for (const it of this.items) {
      if (it.resting) continue;
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
      const floor = this.ground.heightAt(g.position.x, g.position.z) + it.radius;
      if (g.position.y < floor) {
        g.position.y = floor;
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
