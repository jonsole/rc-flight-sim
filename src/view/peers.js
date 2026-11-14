// Draws the other players' aeroplanes: their own model, moved to the smoothed
// pose from the network, with control surfaces, prop and damage, and a name
// tag that stays readable at any distance.
import { Sprite, SpriteMaterial, CanvasTexture, SRGBColorSpace, Vector3, Quaternion } from 'three';
import { Aircraft } from '../sim/aircraft.js';
import { getAircraft } from '../aircraft/index.js';

function nameTag(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px system-ui, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 24);
  g.fillStyle = 'rgba(15,18,22,0.6)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 10, w, 44, 10);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  // Fixed size on screen (no perspective shrink), always on top.
  const s = new Sprite(new SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: false, transparent: true }));
  s.scale.set(0.22, 0.055, 1);
  s.renderOrder = 10;
  return s;
}

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      m?.map?.dispose();
      m?.dispose();
    }
  });
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
    this.pose = { p: new Vector3(), q: new Quaternion(), state: null };
  }

  #build(peer) {
    const entry = getAircraft(peer.aircraft);
    // A flight model that is never stepped: it just carries the received
    // state in the shape the 3D model's update() expects.
    const proxy = new Aircraft(entry.def, { ground: this.ground });
    const model = entry.createModel();
    model.setPilotVisible(true);
    const tag = nameTag(peer.name);
    this.scene.add(model.root, tag);
    return { aircraft: peer.aircraft, name: peer.name, proxy, model, tag, broken: '' };
  }

  #remove(id) {
    const v = this.views.get(id);
    if (!v) return;
    this.scene.remove(v.model.root, v.tag);
    dispose(v.model.root);
    dispose(v.tag);
    this.views.delete(id);
  }

  /**
   * @param {Map} peers  Multiplayer.peers
   * @param {number} dt
   */
  update(peers, dt) {
    for (const id of this.views.keys()) if (!peers.has(id)) this.#remove(id);
    const now = performance.now() / 1000;
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
      const ok = peer.buf.sample(now, this.pose);
      // Hide players we have not heard from for a while.
      const visible = ok && peer.buf.age(now) < 3;
      v.model.root.visible = v.tag.visible = visible;
      if (!visible) continue;
      const s = this.pose.state;
      const ac = v.proxy;
      ac.position.copy(this.pose.p);
      ac.orientation.copy(this.pose.q);
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
      v.tag.position.copy(ac.position).y += 0.9;
    }
  }

  clear() {
    for (const id of [...this.views.keys()]) this.#remove(id);
  }
}
