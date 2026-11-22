// What the insect-net challenge looks like (src/sim/net.js): the cord, the
// net streaming behind it (a mesh cone on a hoop, folded thin until the air
// opens it), the swarms of insects, and on-screen markers to find them.
import {
  Group, Mesh, ConeGeometry, TorusGeometry, MeshStandardMaterial, CanvasTexture, RepeatWrapping, DoubleSide,
  Line, LineBasicMaterial, BufferGeometry, BufferAttribute, Points, PointsMaterial, Vector3, Quaternion,
} from 'three';

const CORD_POINTS = 16;
const INSECTS = 140; // dots drawn per swarm
const _up = new Vector3(0, 1, 0);
const _a = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();

function meshTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.12)'; // the fine mesh between the cords
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 32, 32);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(10, 6);
  return t;
}

export class NetView {
  constructor(scene, markerRoot) {
    this.scene = scene;
    this.group = new Group();
    this.group.visible = false;
    scene.add(this.group);

    // The net: unit cone, mouth at the origin, tail along +y.
    const cone = new ConeGeometry(0.5, 1, 20, 1, true);
    cone.translate(0, 0.5, 0); // the open base (the mouth) at 0, the closed end at +1
    this.netMat = new MeshStandardMaterial({ color: 0xf2f2ea, map: meshTexture(), transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.9 });
    this.bag = new Mesh(cone, this.netMat);
    this.bag.castShadow = true;
    this.hoop = new Mesh(new TorusGeometry(0.5, 0.025, 6, 24).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: 0x303030, roughness: 0.6 }));
    this.net = new Group();
    this.net.add(this.bag, this.hoop);
    this.group.add(this.net);

    const cg = new BufferGeometry();
    cg.setAttribute('position', new BufferAttribute(new Float32Array(CORD_POINTS * 3), 3));
    this.cord = new Line(cg, new LineBasicMaterial({ color: 0x1a1a1a }));
    this.cord.frustumCulled = false;
    this.group.add(this.cord);

    this.swarmMat = new PointsMaterial({ color: 0x151510, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false });
    this.swarmViews = [];

    // On-screen markers: a ring on the nearest swarm, or an arrow at the
    // edge pointing to it.
    this.marker = document.createElement('div');
    this.marker.className = 'swarm-marker';
    this.marker.style.display = 'none';
    markerRoot.append(this.marker);
  }

  /** Show a challenge (or nothing: null). */
  set(challenge) {
    this.challenge = challenge;
    this.group.visible = !!challenge;
    for (const v of this.swarmViews) {
      this.group.remove(v.points);
      v.points.geometry.dispose();
    }
    this.swarmViews = [];
    this.marker.style.display = 'none';
  }

  #swarmView(s) {
    let v = this.swarmViews.find((x) => x.swarm === s);
    if (v) return v;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(INSECTS * 3), 3));
    const points = new Points(geo, this.swarmMat);
    points.frustumCulled = false;
    // Each insect: a spot in the swarm (Gaussian, σ 2 m) and its own buzz.
    const g = () => {
      const u = Math.random() || 1e-9;
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()) * 2;
    };
    const spots = Array.from({ length: INSECTS }, () => [g(), g() * 0.7, g(), Math.random() * 10, 2 + Math.random() * 4]);
    v = { swarm: s, points, spots };
    this.swarmViews.push(v);
    this.group.add(points);
    return v;
  }

  update(aircraft, camera, t, width, height) {
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
    const length = net.diameter * (1.6 + 1.2 * (1 - open));
    this.net.position.copy(net.position);
    _q.setFromUnitVectors(_up, net.axis);
    this.net.quaternion.copy(_q);
    this.bag.scale.set(across, length, across);
    this.hoop.scale.set(across, net.diameter, across);
    // (A snapped cord leaves the net where it fell.)

    // --- Swarms ---------------------------------------------------------------
    const live = new Set(ch.swarms);
    for (let i = this.swarmViews.length - 1; i >= 0; i--) {
      const v = this.swarmViews[i];
      if (!live.has(v.swarm)) {
        this.group.remove(v.points);
        v.points.geometry.dispose();
        this.swarmViews.splice(i, 1);
      }
    }
    for (const s of ch.swarms) {
      const v = this.#swarmView(s);
      const p = v.points.geometry.attributes.position;
      // Fewer as the net takes them; the last few scatter as it disperses.
      const n = Math.round(INSECTS * Math.min(1, (s.left / s.capacity) * 1.2));
      const spread = 1 + s.fade * 2;
      for (let k = 0; k < n; k++) {
        const [x, y, z, ph, fr] = v.spots[k];
        const w = t * fr + ph;
        p.setXYZ(k, s.pos.x + (x + 0.35 * Math.sin(w)) * spread, s.pos.y + (y + 0.25 * Math.sin(w * 1.7)) * spread, s.pos.z + (z + 0.35 * Math.cos(w * 1.3)) * spread);
      }
      p.needsUpdate = true;
      v.points.geometry.setDrawRange(0, n);
    }

    // --- Marker on the nearest swarm ---------------------------------------------
    const target = ch.done ? null : ch.nearest(net.position);
    if (!target) {
      this.marker.style.display = 'none';
      return;
    }
    _p.copy(target.pos).project(camera);
    const behind = _p.z > 1;
    let x = _p.x;
    let y = _p.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const on = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.95;
    const dist = Math.round(camera.position.distanceTo(target.pos));
    this.marker.style.display = '';
    if (on) {
      this.marker.className = 'swarm-marker ring';
      this.marker.style.transform = `translate(${((x + 1) / 2) * width}px, ${((1 - y) / 2) * height}px)`;
      this.marker.textContent = `${dist} m`;
    } else {
      // Pinned to the screen's edge, pointing the way.
      const k = 0.9 / Math.max(Math.abs(x), Math.abs(y), 1e-6);
      const ex = x * k;
      const ey = y * k;
      const ang = Math.atan2(-ey, ex);
      this.marker.className = 'swarm-marker edge';
      this.marker.style.transform = `translate(${((ex + 1) / 2) * width}px, ${((1 - ey) / 2) * height}px)`;
      this.marker.innerHTML = `<span style="transform: rotate(${ang}rad)">➤</span>${dist} m`;
    }
  }
}
