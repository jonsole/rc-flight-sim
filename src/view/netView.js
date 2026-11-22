// What the insect-net challenge looks like (src/sim/net.js): the cord, the
// net streaming behind it (a fine mesh cone on a thin hoop, folded thin
// until the air opens it), and the figure-of-8 course with its gates. Owned
// by the challenge's course (src/game/netTow.js); the marker on the next
// gate is the challenges' own.
import {
  Group, Mesh, ConeGeometry, TorusGeometry, MeshStandardMaterial, MeshBasicMaterial, CanvasTexture, RepeatWrapping, DoubleSide,
  Line, LineBasicMaterial, LineDashedMaterial, BufferGeometry, BufferAttribute, Vector3, Quaternion,
} from 'three';

const CORD_POINTS = 16;
const _up = new Vector3(0, 1, 0);
const _a = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();

/** Fine netting: thin threads on a faint gauze, many to the metre. */
function meshTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.22)'; // the fine mesh between the threads
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 64; i += 8) {
    g.fillRect(i, 0, 1, 64);
    g.fillRect(0, i, 64, 1);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(8, 6); // (64 threads round, 48 along)
  t.anisotropy = 4;
  return t;
}

export class NetView {
  constructor(parent) {
    this.group = new Group();
    this.group.visible = false;
    parent.add(this.group);
    // (Not in the course's still shadow: the net moves, and the gates are high up.)
    this.group.userData.noShadow = true;

    // The net: unit cone, mouth at the origin, tail along +y.
    const cone = new ConeGeometry(0.5, 1, 32, 1, true);
    cone.translate(0, 0.5, 0); // the open base (the mouth) at 0, the closed end at +1
    this.netMat = new MeshStandardMaterial({ color: 0xf4f4ee, map: meshTexture(), transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.9 });
    this.bag = new Mesh(cone, this.netMat);
    // A thin wire hoop holds the mouth open.
    this.hoop = new Mesh(new TorusGeometry(0.5, 0.006, 6, 48).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: 0x8a8a84, metalness: 0.6, roughness: 0.4 }));
    this.net = new Group();
    this.net.add(this.bag, this.hoop);
    this.group.add(this.net);

    const cg = new BufferGeometry();
    cg.setAttribute('position', new BufferAttribute(new Float32Array(CORD_POINTS * 3), 3));
    this.cord = new Line(cg, new LineBasicMaterial({ color: 0x1a1a1a }));
    this.cord.frustumCulled = false;
    this.group.add(this.cord);

    // The course: a dashed figure of 8 at the sampling height, and a ring at each gate.
    this.course = new Group();
    this.group.add(this.course);
    this.gateMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, fog: false });
    this.nextMat = new MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
    this.gates = [];
  }

  /** Show a challenge (or nothing: null). */
  set(challenge) {
    this.challenge = challenge;
    this.group.visible = !!challenge;
    for (const o of [...this.course.children]) {
      this.course.remove(o);
      o.geometry.dispose();
    }
    this.gates = [];
    if (!challenge) return;
    const path = new BufferGeometry().setFromPoints(challenge.path);
    const line = new Line(path, new LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.5, fog: false }));
    line.computeLineDistances();
    this.course.add(line);
    // A gate ring, as tall as the height band, standing across the course.
    const lap = challenge.lap;
    for (let i = 0; i < lap.length; i++) {
      if (i === 3) continue; // (the centre is one gate, passed twice a lap)
      const g = lap[i];
      const ring = new Mesh(new TorusGeometry(challenge.course.band, 0.15, 6, 48), this.gateMat);
      ring.position.copy(g.pos);
      // Facing along the course: from the gate before to the one after.
      const prev = lap[(i + 7) % 8].pos;
      const next = lap[(i + 1) % 8].pos;
      const dir = _p.subVectors(next, prev).setY(0).normalize();
      ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
      ring.userData.gate = g;
      this.course.add(ring);
      this.gates.push(ring);
    }
    // The middle one: across the crossing (both loops pass it the same way).
    const mid = this.gates.find((m) => m.userData.gate === lap[7]);
    if (mid) mid.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), _p.subVectors(lap[4].pos, lap[2].pos).setY(0).normalize());
  }

  update(aircraft, t) {
    const ch = this.challenge;
    if (!ch) return;
    const net = ch.net;

    // --- Cord: straight when taut, sagging when slack -----------------------
    const a = net.attachPoint(aircraft, _a);
    const pos = this.cord.geometry.attributes.position;
    this.cord.visible = !net.snapped;
    if (!net.snapped) {
      const d = a.distanceTo(net.position);
      const sag = 0.5 * Math.sqrt(Math.max(0, net.cordLength * net.cordLength - d * d));
      for (let i = 0; i < CORD_POINTS; i++) {
        const f = i / (CORD_POINTS - 1);
        _p.lerpVectors(a, net.position, f);
        _p.y -= sag * 4 * f * (1 - f);
        _p.y = Math.max(_p.y, aircraft.env.ground.heightAt(_p.x, _p.z) + 0.02); // (lying on the grass)
        pos.setXYZ(i, _p.x, _p.y, _p.z);
      }
      pos.needsUpdate = true;
    }

    // --- Net: the mouth opens, the bag streams behind --------------------------
    const open = net.open;
    const across = net.diameter * (0.12 + 0.88 * open);
    const length = net.diameter * (1.8 + 1.2 * (1 - open));
    this.net.position.copy(net.position);
    _q.setFromUnitVectors(_up, net.axis);
    this.net.quaternion.copy(_q);
    this.bag.scale.set(across, length, across);
    this.hoop.scale.set(across, net.diameter, across);

    // --- Gates: the next one lit, pulsing ------------------------------------------
    const next = ch.done ? null : ch.nextGate();
    for (const g of this.gates) {
      const on = g.userData.gate === next;
      g.material = on ? this.nextMat : this.gateMat;
      g.scale.setScalar(on ? 1 + 0.05 * Math.sin(t * 5) : 1);
    }
  }
}
