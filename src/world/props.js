// Flying-club scenery: clubhouse, shipping container, cars in the car park,
// a pits gazebo with table and chairs, bushes along the field edge and a
// gravel pilot pad. Placement comes from src/sim/obstacles.js, which also
// makes the solid ones collide.
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, MeshLambertMaterial, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, Object3D, Color, DoubleSide, BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import { heightAt } from '../sim/terrain.js';
import { broadleafCrown } from './trees.js';

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 4;
  return t;
}

/** Vertical weatherboards with gaps and grain. */
function planks(base = [118, 86, 56]) {
  const rnd = rng(17);
  return canvasTex(256, 256, (g, w, h) => {
    const boards = 8;
    for (let i = 0; i < boards; i++) {
      const k = 0.85 + rnd() * 0.25;
      g.fillStyle = `rgb(${base[0] * k},${base[1] * k},${base[2] * k})`;
      g.fillRect((i * w) / boards, 0, w / boards, h);
      g.strokeStyle = 'rgba(40,25,15,0.25)';
      for (let j = 0; j < 6; j++) {
        const x = (i + rnd()) * (w / boards);
        g.beginPath();
        g.moveTo(x, 0);
        g.bezierCurveTo(x + 3, h * 0.3, x - 3, h * 0.6, x + 2, h);
        g.stroke();
      }
      g.fillStyle = 'rgba(25,15,8,0.6)';
      g.fillRect((i * w) / boards, 0, 2, h);
    }
  });
}

const lambert = (o) => new MeshLambertMaterial(o);

function box(w, h, d, mat, x, y, z) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Clubhouse: weatherboarded walls, pitched roof, door, windows, bench, sign. */
export function clubhouse(hut) {
  const g = new Group();
  const { w, d, wall, ridge } = hut;
  const wood = lambert({ map: planks() });
  wood.map.repeat.set(w / 2.4, 1);
  const walls = box(w, wall, d, wood, 0, wall / 2, 0);
  g.add(walls);
  // Gable ends (triangles of boarding).
  const tri = new BufferGeometry();
  const hd = d / 2;
  tri.setAttribute('position', new Float32BufferAttribute([0, wall, -hd, 0, wall, hd, 0, ridge, 0], 3));
  tri.setAttribute('uv', new Float32BufferAttribute([0, 0, d / 2.4, 0, d / 4.8, (ridge - wall) / wall], 2));
  tri.computeVertexNormals();
  const gableMat = lambert({ map: wood.map, side: DoubleSide });
  for (const s of [-1, 1]) {
    const m = new Mesh(tri, gableMat);
    m.position.x = (s * w) / 2;
    g.add(m);
  }
  // Roof: two sloping sheets of dark felt with an overhang.
  const roofMat = lambert({ color: '#3c4246' });
  const slope = Math.atan2(ridge - wall, hd);
  const len = Math.hypot(ridge - wall, hd) + 0.45;
  for (const s of [-1, 1]) {
    const r = box(w + 0.8, 0.08, len, roofMat, 0, (wall + ridge) / 2 + 0.06, (s * hd) / 2 + s * 0.12);
    r.rotation.x = s * slope;
    g.add(r);
  }
  // Front (field side, -z): door and two windows.
  const front = -hd - 0.02;
  const door = box(0.95, 2.0, 0.06, lambert({ color: '#2f5d43' }), -2.6, 1.0, front);
  const frameMat = lambert({ color: '#eeeeea' });
  const glass = new MeshStandardMaterial({ color: '#2a3a46', roughness: 0.15, metalness: 0.3 });
  g.add(door);
  for (const x of [0.4, 3.0]) {
    g.add(box(1.5, 1.05, 0.06, frameMat, x, 1.55, front));
    g.add(box(1.32, 0.88, 0.07, glass, x, 1.55, front - 0.01));
  }
  // Bench under the windows.
  const benchMat = lambert({ color: '#7a5b3c' });
  g.add(box(2.2, 0.06, 0.4, benchMat, 1.7, 0.45, front - 0.45));
  for (const x of [0.8, 2.6]) g.add(box(0.06, 0.45, 0.35, benchMat, x, 0.22, front - 0.45));
  // Club sign over the door.
  const sign = canvasTex(256, 64, (c, cw, ch) => {
    c.fillStyle = '#1f3d5a';
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = '#f2f2ea';
    c.font = 'bold 30px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('RC FLYING CLUB', cw / 2, ch / 2 + 2);
  });
  sign.wrapS = sign.wrapT = 1001; // clamp
  g.add(box(2.4, 0.6, 0.05, lambert({ map: sign }), -0.8, 2.45, front - 0.03));
  g.position.set(hut.x, 0, hut.z);
  return g;
}

/** A 20 ft shipping container, corrugated and a little weathered. */
export function shippingContainer(c) {
  const rnd = rng(29);
  const tex = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#2f5a3c';
    g.fillRect(0, 0, w, h);
    // Corrugations.
    for (let x = 0; x < w; x += 8) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x, 0, 3, h);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(x + 5, 0, 2, h);
    }
    // Rust streaks.
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(${120 + rnd() * 40},${60 + rnd() * 20},30,${0.15 + rnd() * 0.2})`;
      g.fillRect(rnd() * w, 0, 1 + rnd() * 3, h * (0.2 + rnd() * 0.5));
    }
  }, [3, 1]);
  const mat = lambert({ map: tex });
  const g = new Group();
  g.add(box(c.l, c.h, c.w, mat, 0, c.h / 2, 0));
  // Door bars on the end.
  const bar = lambert({ color: '#9aa29b' });
  for (const z of [-0.6, -0.2, 0.2, 0.6]) g.add(box(0.05, c.h - 0.2, 0.05, bar, c.l / 2 + 0.03, c.h / 2, z));
  g.position.set(c.x, 0, c.z);
  return g;
}

/** A simple hatchback in a body colour. */
export function car(c) {
  const g = new Group();
  const paint = new MeshStandardMaterial({ color: c.color, roughness: 0.35, metalness: 0.4 });
  const glass = new MeshStandardMaterial({ color: '#1d262e', roughness: 0.1, metalness: 0.5 });
  const black = lambert({ color: '#151515' });
  const lightMat = lambert({ color: '#f4f2e6', emissive: '#222' });
  // Along z: nose at -z (towards the field).
  g.add(box(1.78, 0.62, 4.1, paint, 0, 0.62, 0));
  const cabin = box(1.6, 0.55, 2.2, paint, 0, 1.2, 0.35);
  g.add(cabin);
  g.add(box(1.62, 0.42, 2.0, glass, 0, 1.2, 0.35)); // windows band
  const wind = box(1.5, 0.05, 0.75, glass, 0, 1.12, -0.95);
  wind.rotation.x = 0.75;
  g.add(wind);
  for (const x of [-0.6, 0.6]) g.add(box(0.35, 0.12, 0.04, lightMat, x, 0.72, -2.06));
  for (const [x, z] of [[-0.85, -1.3], [0.85, -1.3], [-0.85, 1.35], [0.85, 1.35]]) {
    const w = new Mesh(new CylinderGeometry(0.32, 0.32, 0.22, 14), black);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.32, z);
    w.castShadow = true;
    g.add(w);
  }
  g.position.set(c.x, 0, c.z);
  g.rotation.y = (c.x * 7.3) % 0.12; // not parked perfectly straight
  return g;
}

/** Pop-up gazebo with a pits table and folding chairs. */
export function gazebo(gz) {
  const g = new Group();
  const s = gz.size / 2;
  const frame = lambert({ color: '#d8d8d8' });
  for (const [x, z] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
    const leg = new Mesh(new CylinderGeometry(0.025, 0.025, gz.h - 0.3, 6), frame);
    leg.position.set(x, (gz.h - 0.3) / 2, z);
    leg.castShadow = true;
    g.add(leg);
  }
  const canvasMat = lambert({ color: '#2e5fa8', side: DoubleSide });
  const top = new Mesh(new ConeGeometry(gz.size * 0.72, 0.55, 4, 1, true), canvasMat);
  top.rotation.y = Math.PI / 4;
  top.position.y = gz.h - 0.3 + 0.27;
  top.castShadow = true;
  g.add(top);
  // Valance strips round the edge.
  for (const [x, z, w, d] of [[0, -s, gz.size, 0.02], [0, s, gz.size, 0.02], [-s, 0, 0.02, gz.size], [s, 0, 0.02, gz.size]]) {
    g.add(box(w, 0.22, d, canvasMat, x, gz.h - 0.4, z));
  }
  // Table with a model box and a radio case on it.
  const white = lambert({ color: '#f0f0ec' });
  g.add(box(2, 0.05, 0.8, white, 0, 0.74, 0.6));
  for (const [x, z] of [[-0.9, 0.3], [0.9, 0.3], [-0.9, 0.9], [0.9, 0.9]]) g.add(box(0.03, 0.72, 0.03, frame, x, 0.36, z));
  g.add(box(0.5, 0.25, 0.35, lambert({ color: '#c47a1b' }), -0.5, 0.89, 0.6));
  g.add(box(0.45, 0.14, 0.3, lambert({ color: '#222' }), 0.45, 0.84, 0.55));
  // Folding chairs.
  const seatMat = lambert({ color: '#26323f' });
  for (const [x, z, r] of [[-0.6, -0.3, 0.2], [0.6, -0.35, -0.15], [1.6, 0.9, -1.2]]) {
    const ch = new Group();
    ch.add(box(0.48, 0.05, 0.45, seatMat, 0, 0.45, 0));
    ch.add(box(0.48, 0.45, 0.04, seatMat, 0, 0.7, -0.22));
    for (const [lx, lz] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) ch.add(box(0.025, 0.45, 0.025, frame, lx, 0.22, lz));
    ch.position.set(x, 0, z);
    ch.rotation.y = Math.PI + r;
    g.add(ch);
  }
  g.position.set(gz.x, 0, gz.z);
  return g;
}

/** Gravel for the pilot pad. */
export function gravelTexture() {
  const rnd = rng(41);
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#7b7568';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      const k = 70 + rnd() * 90;
      g.fillStyle = `rgb(${k + 8},${k + 4},${k - 6})`;
      const r = 0.6 + rnd() * 2;
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2);
      g.fill();
    }
  }, [2, 1.4]);
}

/** Bushes along the edge of the field, in front of the tree line. */
export function bushes(material) {
  const rnd = rng(77);
  const shapes = [broadleafCrown(101), broadleafCrown(131)];
  const n = 260;
  const meshes = shapes.map((s) => new InstancedMesh(s, material, n));
  const counts = shapes.map(() => 0);
  const o = new Object3D();
  const col = new Color();
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 150 + rnd() * 22;
    const x = Math.cos(a) * r * 1.3;
    let z = Math.sin(a) * r - 40;
    if (z > 20 && Math.abs(x) < 60) z += 80; // keep the view behind the pilot open
    const size = 0.8 + rnd() * 1.4;
    o.position.set(x, heightAt(x, z) + size * 0.55, z);
    o.rotation.set(0, rnd() * Math.PI * 2, 0);
    o.scale.set(size * (1 + rnd() * 0.6), size * 0.75, size * (1 + rnd() * 0.6));
    o.updateMatrix();
    const k = i % shapes.length;
    meshes[k].setMatrixAt(counts[k], o.matrix);
    col.setHSL(0.24 + rnd() * 0.06, 0.4 + rnd() * 0.15, 0.24 + rnd() * 0.08);
    meshes[k].setColorAt(counts[k]++, col);
  }
  meshes.forEach((m, k) => {
    m.count = counts[k];
    m.receiveShadow = true;
  });
  return meshes;
}
