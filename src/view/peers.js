// Draws the other players' aeroplanes: their own model, moved to the smoothed
// pose from the network, with control surfaces, prop and damage. Each has a
// small name label; players out of view get a label pinned to the edge of
// the screen with an arrow pointing their way. Also checks for mid-air
// collisions with this player's aeroplane.
import { Vector3, Quaternion } from 'three';
import { Aircraft } from '../sim/aircraft.js';
import { getAircraft } from '../aircraft/index.js';
import { buildShape, sweptHit } from '../net/collide.js';

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      m?.map?.dispose();
      m?.dispose();
    }
  });
}

const shapes = new Map(); // aircraft id -> collision shape
/** Collision shape for an aeroplane type (built once from a spare model). */
export function shapeFor(id) {
  if (!shapes.has(id)) {
    const m = getAircraft(id).createModel();
    shapes.set(id, buildShape(m.root));
    dispose(m.root);
  }
  return shapes.get(id);
}

const _v = new Vector3();
const _c = new Vector3();

export class Peers {
  /**
   * @param {import('three').Scene} scene
   * @param {object} ground  physics ground (for the stand-in flight model)
   */
  constructor(scene, ground) {
    this.scene = scene;
    this.ground = ground;
    this.views = new Map(); // peer id -> view
    this.layer = document.createElement('div');
    this.layer.id = 'mp-labels';
    document.body.append(this.layer);
  }

  #build(peer) {
    const entry = getAircraft(peer.aircraft);
    // A flight model that is never stepped: it just carries the received
    // state in the shape the 3D model's update() expects.
    const proxy = new Aircraft(entry.def, { ground: this.ground });
    const model = entry.createModel();
    model.setPilotVisible(true);
    this.scene.add(model.root);
    const label = document.createElement('div');
    label.className = 'mp-label';
    // A narrow arrow pointing up, rotated towards the player. (A plain
    // triangle looks the same every 120°, so it can't show direction.)
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.innerHTML = '<svg viewBox="0 0 10 14" width="8" height="11"><path d="M5 0 L10 8 L6.5 8 L6.5 14 L3.5 14 L3.5 8 L0 8 Z" fill="currentColor"/></svg>';
    const text = document.createElement('span');
    label.append(arrow, text);
    this.layer.append(label);
    return {
      aircraft: peer.aircraft,
      name: peer.name,
      proxy,
      model,
      label,
      arrow,
      text,
      tagHeight: 0.15 + 0.3 * (entry.def.wingSpan || 1),
      broken: '',
      pose: { p: new Vector3(), q: new Quaternion(), state: null },
      sweep: {},
      shown: false,
    };
  }

  #remove(id) {
    const v = this.views.get(id);
    if (!v) return;
    this.scene.remove(v.model.root);
    dispose(v.model.root);
    v.label.remove();
    this.views.delete(id);
  }

  /**
   * @param {Map} peers  Multiplayer.peers
   * @param {number} dt
   * @param {import('three').PerspectiveCamera} camera
   * @param {object} me  { aircraft, id (aircraft type), solid } this player
   * @returns {{ peer, sample, relSpeed }|null} a collision with this player's aeroplane
   */
  update(peers, dt, camera, me) {
    for (const id of this.views.keys()) if (!peers.has(id)) this.#remove(id);
    const now = performance.now() / 1000;
    const w = window.innerWidth;
    const h = window.innerHeight;
    let hit = null;
    const myShape = me ? shapeFor(me.id) : null;
    const myPose = me ? { p: me.aircraft.position, q: me.aircraft.orientation } : null;
    for (const peer of peers.values()) {
      let v = this.views.get(peer.id);
      if (v && (v.aircraft !== peer.aircraft || v.name !== peer.name)) {
        this.#remove(peer.id); // changed aeroplane or name: rebuild
        v = null;
      }
      if (!v) {
        v = this.#build(peer);
        this.views.set(peer.id, v);
      }
      const ok = peer.buf.sample(now, v.pose);
      // Hide players we have not heard from for a while.
      const visible = ok && peer.buf.age(now) < 3;
      v.model.root.visible = visible;
      v.label.style.display = visible ? '' : 'none';
      if (!visible) {
        v.sweep = {};
        continue;
      }
      const s = v.pose.state;
      const ac = v.proxy;
      ac.position.copy(v.pose.p);
      ac.orientation.copy(v.pose.q);
      ac.velocity.fromArray(s.v || [0, 0, 0]);
      ac.rpm = s.rpm || 0;
      ac.propBroken = !!s.propBroken;
      ac.servo.yaw = s.yaw || 0;
      const d = s.d || [];
      let i = 0;
      for (const srf of ac.surfaces) if (srf.controls.length) srf.deflection = d[i++] || 0;
      // Parts that broke off in a crash: hide them (no debris for others).
      const broken = (s.broken || []).join(',');
      if (broken !== v.broken) {
        v.broken = broken;
        for (const [part, objs] of Object.entries(v.model.parts || {})) {
          const gone = s.broken?.includes(part);
          for (const o of objs) o.visible = !gone;
        }
      }
      v.model.root.position.copy(ac.position);
      v.model.root.quaternion.copy(ac.orientation);
      v.model.update(ac, dt);

      // Mid-air collision with me (against the aeroplane as drawn).
      if (me?.solid && !hit) {
        const c = sweptHit(myShape, myPose, shapeFor(peer.aircraft), v.pose, v.sweep);
        if (c) hit = { peer, sample: c.sample, theirPart: c.theirPart, relSpeed: _v.copy(me.aircraft.velocity).sub(ac.velocity).length(), velocity: ac.velocity.clone() };
      } else if (!me?.solid) {
        v.sweep = {};
      }

      // Label: above the aeroplane when in view, else pinned to the screen edge.
      const dist = me ? me.aircraft.position.distanceTo(ac.position) : 0;
      v.text.textContent = dist > 30 ? `${peer.name} ${Math.round(dist)} m` : peer.name;
      _v.copy(ac.position);
      _v.y += v.tagHeight;
      _c.copy(_v).applyMatrix4(camera.matrixWorldInverse);
      const behind = _c.z > 0;
      _v.project(camera);
      let x = _v.x;
      let y = _v.y;
      const inView = !behind && Math.abs(x) <= 1 && Math.abs(y) <= 1;
      if (!inView) {
        if (behind) {
          x = -x;
          y = -y;
          if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;
        }
        const m = Math.max(Math.abs(x) / 0.94, Math.abs(y) / 0.9, 1e-6);
        x /= m;
        y /= m;
        // Arrow points from the screen centre towards the player.
        v.arrow.style.transform = `rotate(${Math.atan2(x * w, y * h)}rad)`;
      }
      v.label.classList.toggle('edge', !inView);
      let px = ((x + 1) / 2) * w;
      let py = ((1 - y) / 2) * h;
      if (!inView) {
        // Keep the whole label on screen.
        const lw = v.label.offsetWidth / 2 + 6;
        const lh = v.label.offsetHeight / 2 + 6;
        px = Math.min(w - lw, Math.max(lw, px));
        py = Math.min(h - lh, Math.max(lh, py));
      }
      v.label.style.left = `${px}px`;
      v.label.style.top = `${py}px`;
    }
    return hit;
  }

  clear() {
    for (const id of [...this.views.keys()]) this.#remove(id);
  }
}
