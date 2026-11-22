// What the insect-net challenge looks like (src/sim/net.js): the cord and
// its bridle, the net (a wire hoop with a soft fine-mesh bag, simulated as
// fabric in src/view/netCloth.js), and the figure-of-8 course with its
// gates. Owned
// by the challenge's course (src/game/netTow.js); the marker on the next
// gate is the challenges' own.
import {
  Group, Mesh, TorusGeometry, MeshStandardMaterial, MeshBasicMaterial, CanvasTexture, RepeatWrapping, DoubleSide,
  Line, LineSegments, LineBasicMaterial, LineDashedMaterial, BufferGeometry, BufferAttribute, Vector3, Quaternion,
} from 'three';
import { NetCloth } from './netCloth.js';

const CORD_POINTS = 16;
const _up = new Vector3(0, 1, 0);
const _a = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _t = new Vector3();
const _wind = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();

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

    // The bag: soft netting, its shape from the fabric (built in set()).
    this.netMat = new MeshStandardMaterial({ color: 0xf4f4ee, map: meshTexture(), transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.9 });
    this.bag = null;
    // A thin wire hoop holds the mouth open (unit size: scaled to the net).
    this.hoop = new Mesh(new TorusGeometry(0.5, 0.006, 6, 48).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: 0x8a8a84, metalness: 0.6, roughness: 0.4 }));
    this.group.add(this.hoop);
    // Three bridle lines from the hoop to the cord.
    const bg = new BufferGeometry();
    bg.setAttribute('position', new BufferAttribute(new Float32Array(6 * 3), 3));
    this.bridle = new LineSegments(bg, new LineBasicMaterial({ color: 0x2a2a2a }));
    this.bridle.frustumCulled = false;
    this.group.add(this.bridle);
    this.facing = new Vector3(1, 0, 0); // the way the mouth faces
    this.hoopAt = new Vector3(); // where it's drawn (lifted clear of the ground)

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
    if (this.bag) {
      this.group.remove(this.bag);
      this.bag.geometry.dispose();
      this.bag = null;
    }
    this.cloth = null;
    if (!challenge) return;
    this.cloth = new NetCloth(challenge.net.diameter);
    this.bag = new Mesh(this.#bagGeometry(this.cloth), this.netMat);
    this.bag.frustumCulled = false;
    this.group.add(this.bag);
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

  /** The bag's surface: a ring of vertices per ring of fabric (the seam doubled for the netting's pattern), closed at the tail. */
  #bagGeometry(c) {
    const cols = c.S + 1;
    const n = (c.N + 1) * cols + 1;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    const uv = new Float32Array(n * 2);
    const idx = [];
    for (let j = 0; j <= c.N; j++) {
      for (let i = 0; i <= c.S; i++) {
        const k = j * cols + i;
        uv[k * 2] = i / c.S;
        uv[k * 2 + 1] = j / c.N;
        if (j < c.N && i < c.S) {
          const a = k;
          const b = k + 1;
          const d = k + cols;
          const e = k + cols + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
    }
    const tip = n - 1;
    uv[tip * 2] = 0.5;
    uv[tip * 2 + 1] = 1;
    for (let i = 0; i < c.S; i++) idx.push(c.N * cols + i, tip, c.N * cols + i + 1);
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  /** Copy the fabric's points into the bag's surface. */
  #drawBag() {
    const c = this.cloth;
    const pos = this.bag.geometry.attributes.position;
    const cols = c.S + 1;
    for (let j = 0; j <= c.N; j++) {
      for (let i = 0; i <= c.S; i++) {
        const k = c.idx(j, i % c.S) * 3;
        pos.setXYZ(j * cols + i, c.pos[k], c.pos[k + 1], c.pos[k + 2]);
      }
    }
    const k = c.tip * 3;
    pos.setXYZ(pos.count - 1, c.pos[k], c.pos[k + 1], c.pos[k + 2]);
    pos.needsUpdate = true;
    this.bag.geometry.computeVertexNormals();
  }

  update(aircraft, t, dt = 0) {
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
        _p.lerpVectors(a, this.knot ?? net.position, f);
        _p.y -= sag * 4 * f * (1 - f);
        _p.y = Math.max(_p.y, aircraft.env.ground.heightAt(_p.x, _p.z) + 0.02); // (lying on the grass)
        pos.setXYZ(i, _p.x, _p.y, _p.z);
      }
      pos.needsUpdate = true;
    }

    // --- Hoop: faces up the cord when it pulls; dropped, it lies flat ---------
    const floor = aircraft.env.ground.heightAt(net.position.x, net.position.z);
    const R = net.diameter / 2;
    _t.subVectors(a, net.position);
    const d = _t.length();
    let want = null;
    if (!net.snapped && (net.tension > 0.05 || (!net.onGround && d > 0.97 * net.cordLength))) want = _t.multiplyScalar(1 / d);
    else if (net.onGround) want = _t.set(0, 1, 0);
    const fresh = !this.cloth.ready || this.hoopAt.distanceTo(net.position) > 3;
    if (want) {
      if (fresh) this.facing.copy(want);
      else this.facing.lerp(want, Math.min(1, dt * 6)).normalize();
    }
    // Clear of the ground: the rim rests on it.
    this.hoopAt.copy(net.position);
    this.hoopAt.y = Math.max(this.hoopAt.y, floor + R * Math.sqrt(Math.max(0, 1 - this.facing.y ** 2)) + 0.01);
    this.hoop.position.copy(this.hoopAt);
    this.hoop.quaternion.setFromUnitVectors(_up, this.facing);
    this.hoop.scale.set(net.diameter, net.diameter, net.diameter);

    // --- Bridle: three lines from the rim to where the cord's tied, ahead -----------
    _e1.set(this.facing.y, -this.facing.x, 0);
    if (_e1.lengthSq() < 1e-6) _e1.set(0, this.facing.z, -this.facing.y);
    _e1.normalize();
    _e2.crossVectors(this.facing, _e1);
    const knot = _p.copy(this.hoopAt).addScaledVector(this.facing, R * 0.9);
    const bp = this.bridle.geometry.attributes.position;
    for (let k = 0; k < 3; k++) {
      const ang = (k / 3) * Math.PI * 2;
      bp.setXYZ(k * 2, knot.x, knot.y, knot.z);
      bp.setXYZ(k * 2 + 1,
        this.hoopAt.x + R * (Math.cos(ang) * _e1.x + Math.sin(ang) * _e2.x),
        this.hoopAt.y + R * (Math.cos(ang) * _e1.y + Math.sin(ang) * _e2.y),
        this.hoopAt.z + R * (Math.cos(ang) * _e1.z + Math.sin(ang) * _e2.z));
    }
    bp.needsUpdate = true;
    this.knot = knot.clone();

    // --- Bag: soft fabric in the airflow -------------------------------------------------
    const wind = aircraft.env.wind ? aircraft.env.wind.at(this.hoopAt, aircraft.time, _wind, this.hoopAt.y - floor) : _wind.set(0, 0, 0);
    if (fresh) this.cloth.reset(this.hoopAt, this.facing);
    this.cloth.step(Math.min(dt, 0.05), this.hoopAt, this.facing, wind, floor, t);
    this.#drawBag();

    // --- Gates: the next one lit, pulsing ------------------------------------------
    const next = ch.done ? null : ch.nextGate();
    for (const g of this.gates) {
      const on = g.userData.gate === next;
      g.material = on ? this.nextMat : this.gateMat;
      g.scale.setScalar(on ? 1 + 0.05 * Math.sin(t * 5) : 1);
    }
  }
}
