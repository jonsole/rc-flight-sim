// Draws the other players' aeroplanes: their own model, moved to the smoothed
// pose from the network, with control surfaces, prop and damage. Each has a
// small name label drawn in the scene (so your own aeroplane, trees and hills
// hide it when they are in front), kept a fixed size on screen. Players out
// of view get a marker on the screen edge (their side, or the bottom when
// behind) with an arrow pointing their way. Also checks for mid-air
// collisions with this player's aeroplane.
import { Vector3, Quaternion, Sprite, SpriteMaterial, CanvasTexture, SRGBColorSpace } from 'three';
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
const LABEL_PX = 17; // label height on screen
const RES = 3; // canvas pixels per screen pixel, for crisp text

/** Name label as a sprite; redraw(text) updates it. */
function labelSprite() {
  const canvas = document.createElement('canvas');
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true, depthWrite: false }));
  sprite.center.set(0.5, 0); // anchored at its bottom edge, above the aeroplane
  sprite.renderOrder = 5;
  let current = '';
  sprite.userData.redraw = (text) => {
    if (text === current) return;
    current = text;
    const h = LABEL_PX * RES;
    const g = canvas.getContext('2d');
    const font = `600 ${Math.round(11 * RES)}px system-ui, sans-serif`;
    g.font = font;
    const w = Math.ceil(g.measureText(text).width + 12 * RES);
    canvas.width = w;
    canvas.height = h;
    g.font = font;
    g.fillStyle = 'rgba(15,18,22,0.6)';
    g.beginPath();
    g.roundRect(0, 0, w, h, 4 * RES);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + RES);
    tex.dispose(); // canvas size changed: re-upload
    tex.needsUpdate = true;
    sprite.userData.aspect = w / h;
  };
  return sprite;
}

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
    const tag = labelSprite();
    this.scene.add(tag);
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
      tag,
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
    this.scene.remove(v.model.root, v.tag);
    dispose(v.model.root);
    dispose(v.tag);
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
      v.tag.visible = visible;
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

      // Label: in the scene above the aeroplane when in view; otherwise a
      // marker on the edge of the screen on the side the aeroplane is.
      const dist = me ? me.aircraft.position.distanceTo(ac.position) : 0;
      const text = dist > 30 ? `${peer.name} ${dist > 200 ? Math.round(dist / 10) * 10 : Math.round(dist)} m` : peer.name;
      v.tag.position.copy(ac.position);
      v.tag.position.y += v.tagHeight;
      _v.copy(v.tag.position).project(camera);
      _c.copy(v.tag.position).applyMatrix4(camera.matrixWorldInverse); // x right, y up, -z ahead
      const inView = _c.z < 0 && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1;
      v.tag.visible = inView;
      v.label.style.display = inView ? 'none' : '';
      if (inView) {
        v.tag.userData.redraw(text);
        // Constant size in pixels whatever the zoom: without size attenuation
        // a sprite's screen height is scale * projection[1][1] * height / 2.
        const sy = (2 * LABEL_PX) / (h * camera.projectionMatrix.elements[5]);
        v.tag.scale.set(sy * (v.tag.userData.aspect || 4), sy, 1);
        continue;
      }
      v.text.textContent = text;
      // A line from the screen centre towards the player, clipped at the
      // screen edge. Ahead of the camera that is the direction of their
      // projected position. Behind it, the same direction (which projection
      // would flip) tilted downwards the further behind they are, so it
      // moves smoothly round to the bottom edge: bottom centre is straight
      // behind.
      const tanV = Math.tan((camera.fov * Math.PI) / 360);
      const tanH = tanV * camera.aspect;
      let u = _c.x / tanH; // screen right, in half-widths per unit depth
      let vv = _c.y / tanV; // screen up
      if (_c.z >= 0) vv -= (_c.z / tanV) * 0.7;
      else {
        u /= -_c.z;
        vv /= -_c.z;
      }
      // To pixels from the centre, then scale the ray to the nearest edge.
      const dx = (u * w) / 2;
      const dy = (-vv * h) / 2;
      const lw = v.label.offsetWidth / 2 + 6;
      const top = 50; // clear of the room badge
      const bottom = h - (h > 500 ? 110 : 70); // and the flight readout
      const cx = w / 2;
      const cy = h / 2;
      let t = Infinity;
      if (dx > 1e-9) t = Math.min(t, (w - lw - cx) / dx);
      if (dx < -1e-9) t = Math.min(t, (lw - cx) / dx);
      if (dy > 1e-9) t = Math.min(t, (bottom - cy) / dy);
      if (dy < -1e-9) t = Math.min(t, (top - cy) / dy);
      if (!Number.isFinite(t)) t = 0;
      v.arrow.style.transform = `rotate(${Math.atan2(dx, -dy)}rad)`;
      v.label.classList.add('edge');
      v.label.style.left = `${cx + dx * t}px`;
      v.label.style.top = `${cy + dy * t}px`;
    }
    return hit;
  }

  clear() {
    for (const id of [...this.views.keys()]) this.#remove(id);
  }
}
