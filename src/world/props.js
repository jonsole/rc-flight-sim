// Flying-club scenery: clubhouse, shipping container, cars in the car park,
// a pits gazebo with table and chairs, bushes along the field edge and a
// gravel pilot pad. Placement comes from src/sim/obstacles.js, which also
// makes the solid ones collide.
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, MeshLambertMaterial, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, Object3D, Color, DoubleSide, BufferGeometry,
  Float32BufferAttribute, Shape, ShapeGeometry, ExtrudeGeometry, Vector2, Vector3, Matrix4,
} from 'three';
import { heightAt } from '../sim/terrain.js';
import { LOCATION } from '../sim/location.js';
import { broadleafCrown, blobCrown } from './trees.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
  const paint = new MeshStandardMaterial({ color: c.color, roughness: 0.4, metalness: 0.25 });
  const glass = new MeshStandardMaterial({ color: '#1b242c', roughness: 0.08, metalness: 0.4, side: DoubleSide });
  const black = lambert({ color: '#151515' });
  const lightMat = lambert({ color: '#f4f2e6', emissive: '#222' });
  // Side profile (z along the car, nose at -z; y up): bonnet, sloping
  // windscreen, roof, rear hatch. Extruded across the car's width.
  const W = 1.76;
  const prof = [
    [-2.05, 0.3], [2.05, 0.3], [2.05, 0.95], [1.95, 1.05], // tail
    [1.6, 1.42], [-0.45, 1.46], // rear hatch, roof
    [-1.15, 1.0], [-2.0, 0.9], [-2.07, 0.75], // windscreen, bonnet, nose
  ];
  const shape = new Shape(prof.map(([z, y]) => new Vector2(z, y)));
  const bodyGeo = new ExtrudeGeometry(shape, { depth: W, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 1 });
  // Shape is in (x=z, y); extrusion along +z: turn it so the length runs
  // along z and the width along x.
  bodyGeo.translate(0, 0, -W / 2);
  bodyGeo.rotateY(-Math.PI / 2);
  const body = new Mesh(bodyGeo, paint);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Glass laid on the body's own surfaces, a fraction proud of the paint.
  const quad = (a, b, width) => {
    // A pane between two profile points (z, y), across `width`, lying on
    // the slope between them and facing outwards (up and away).
    const [za, ya] = a;
    const [zb, yb] = b;
    const len = Math.hypot(zb - za, yb - ya);
    const d = new Vector3(0, (yb - ya) / len, (zb - za) / len);
    const pane = new Mesh(new PlaneGeometry(width, len - 0.12), glass);
    const basis = new Matrix4().makeBasis(new Vector3(-1, 0, 0), d, new Vector3(0, d.z, -d.y));
    pane.quaternion.setFromRotationMatrix(basis);
    pane.position.set(0, (ya + yb) / 2, (za + zb) / 2);
    pane.translateZ(0.05); // just proud of the paint (and its bevel)
    return pane;
  };
  g.add(quad([-1.15, 1.0], [-0.45, 1.46], W - 0.22)); // windscreen
  g.add(quad([1.6, 1.42], [1.95, 1.05], W - 0.3)); // rear window
  // Side windows: the glasshouse outline, inset, on both flanks.
  const side = new Shape([
    [-1.0, 1.02], [1.5, 1.02], [1.5, 1.32], [-0.45, 1.38],
  ].map(([z, y]) => new Vector2(z, y)));
  const sideGeo = new ShapeGeometry(side);
  for (const sx of [-1, 1]) {
    const m = new Mesh(sideGeo, glass);
    m.rotation.y = -Math.PI / 2; // shape's x runs along the car (+z) on both flanks
    m.position.x = sx * (W / 2 + 0.045);
    g.add(m);
  }
  // Pillar between the side windows.
  for (const sx of [-1, 1]) g.add(box(0.02, 0.36, 0.1, paint, sx * (W / 2 + 0.05), 1.2, 0.35));
  // Lights, bumpers, wheels.
  for (const x of [-0.6, 0.6]) g.add(box(0.36, 0.12, 0.05, lightMat, x, 0.78, -2.1));
  for (const x of [-0.6, 0.6]) g.add(box(0.3, 0.1, 0.05, lambert({ color: '#8a1414' }), x, 0.92, 2.1));
  g.add(box(W + 0.04, 0.16, 0.12, black, 0, 0.38, -2.07));
  g.add(box(W + 0.04, 0.16, 0.12, black, 0, 0.38, 2.07));
  for (const [x, z] of [[-0.86, -1.3], [0.86, -1.3], [-0.86, 1.3], [0.86, 1.3]]) {
    const w = new Mesh(new CylinderGeometry(0.32, 0.32, 0.22, 16), black);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.32, z);
    w.castShadow = true;
    g.add(w);
  }
  g.position.set(c.x, heightAt(c.x, c.z), c.z);
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

/**
 * Bushes along the edge of the field, in front of the tree line.
 * `detail` is the crown detail (src/world/quality.js); bushes further than
 * `distance` from the pilot are left out.
 */
export function bushes(material, { detail = 1, distance = Infinity } = {}) {
  if (LOCATION.data) return realBushes(material, detail, distance);
  const rnd = rng(77);
  const shapes = bushShapes(detail);
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
    const size = 0.6 + rnd() * 0.9;
    o.position.set(x, heightAt(x, z) + size * 0.55, z);
    o.rotation.set(0, rnd() * Math.PI * 2, 0);
    o.scale.set(size * (1 + rnd() * 0.6), size * 0.75, size * (1 + rnd() * 0.6));
    o.updateMatrix();
    const k = i % shapes.length;
    meshes[k].setMatrixAt(counts[k], o.matrix);
    col.setHSL(0.25 + rnd() * 0.05, 0.38 + rnd() * 0.12, 0.13 + rnd() * 0.05);
    meshes[k].setColorAt(counts[k]++, col);
  }
  meshes.forEach((m, k) => {
    m.count = counts[k];
    m.receiveShadow = true;
  });
  return meshes;
}

/** Two bush shapes at a quality's detail (a number, or 'blob'). */
function bushShapes(detail) {
  return detail === 'blob' ? [blobCrown(101), blobCrown(131)] : [broadleafCrown(101, detail), broadleafCrown(131, detail)];
}

/** Hedges and shrubs at a real site: the LIDAR's 1-3 m vegetation. */
function realBushes(material, detail, distance) {
  const rnd = rng(78);
  const pts = [...LOCATION.data.bushes];
  // Belts of tall bushes from the site layout: two staggered rows, 2.5 m apart.
  for (const b of LOCATION.layout.bushBelts ?? []) {
    const [ax, az] = b.from;
    const [bx, bz] = b.to;
    const len = Math.hypot(bx - ax, bz - az);
    const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
    for (let s = 0; s <= len; s += 2.5) {
      for (const row of [-0.25, 0.25]) {
        const off = row * b.width + (rnd() - 0.5) * 1.2;
        pts.push(ax + ux * (s + row * 2.5) - uz * off, az + uz * (s + row * 2.5) + ux * off, b.minH + rnd() * (b.maxH - b.minH));
      }
    }
  }
  const n = pts.length / 3;
  const shapes = bushShapes(detail);
  const meshes = shapes.map((s) => new InstancedMesh(s, material, n));
  const counts = shapes.map(() => 0);
  const o = new Object3D();
  const col = new Color();
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] + (rnd() - 0.5) * 1.5;
    const z = pts[i + 1] + (rnd() - 0.5) * 1.5;
    const h = pts[i + 2];
    const w = 1.5 + rnd() * 0.8; // half-width: neighbours (3 m apart) overlap into a hedge
    const turn = rnd() * Math.PI * 2;
    const tint = [0.24 + rnd() * 0.05, 0.36 + rnd() * 0.12, 0.13 + rnd() * 0.05];
    if (Math.hypot(x, z) > distance) continue;
    o.position.set(x, heightAt(x, z) + h * 0.5, z);
    o.rotation.set(0, turn, 0);
    o.scale.set(w, h * 0.55, w);
    o.updateMatrix();
    const k = (i / 3) % shapes.length;
    meshes[k].setMatrixAt(counts[k], o.matrix);
    col.setHSL(...tint);
    meshes[k].setColorAt(counts[k]++, col);
  }
  meshes.forEach((m, k) => {
    m.count = counts[k];
    m.receiveShadow = true;
    m.castShadow = true;
  });
  return meshes;
}

/**
 * A site fence along its path (src/sim/location.js): chain link, or
 * temporary mesh panels.
 * @param {{ path: number[][], height: number, kind?: string }} f
 */
export function siteFence(f) {
  const g = new Group();
  for (let i = 1; i < f.path.length; i++) {
    const stretch = f.kind === 'panels' ? tempPanels : chainLink;
    g.add(stretch(f.path[i - 1], f.path[i], f.height));
  }
  // Hundreds of panels, tubes and posts: one draw call per material.
  return mergeByMaterial(g);
}

/** The meshes of a group baked into one mesh per material. */
function mergeByMaterial(group) {
  group.updateMatrixWorld(true);
  const byMat = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (!g.index) g = g.toNonIndexed();
    if (!byMat.has(o.material)) byMat.set(o.material, { geos: [], cast: false, receive: false });
    const e = byMat.get(o.material);
    e.geos.push(g.index ? g.toNonIndexed() : g);
    e.cast ||= o.castShadow;
    e.receive ||= o.receiveShadow;
  });
  const out = new Group();
  for (const [mat, e] of byMat) {
    const m = new Mesh(mergeGeometries(e.geos), mat);
    m.castShadow = e.cast;
    m.receiveShadow = e.receive;
    out.add(m);
  }
  return out;
}

/**
 * Temporary fencing: 3.5 m mesh panels in a tube frame, wired to wooden
 * posts, every panel a little out of line.
 */
function tempPanels([ax, az], [bx, bz], height) {
  const g = new Group();
  const len = Math.hypot(bx - ax, bz - az);
  const yaw = Math.atan2(-(bz - az), bx - ax);
  const steel = new MeshStandardMaterial({ color: '#a4a9ab', roughness: 0.45, metalness: 0.6 });
  const wood = lambert({ color: '#6e5638' });
  // Welded mesh, 75 x 225 mm: an upright-rectangle grid of thin wire.
  const TW = 0.6;
  const mesh = canvasTex(64, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(176,180,182,1)';
    for (let i = 0; i < 8; i++) c.fillRect((i * w) / 8, 0, 1.4, h);
    for (let j = 0; j < 3; j++) c.fillRect(0, (j * h) / 3 + h / 6, w, 1.4);
  });
  const meshMat = new MeshStandardMaterial({ map: mesh, transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.5, metalness: 0.5 });
  const n = Math.max(1, Math.round(len / 3.5));
  const pw = len / n;
  const rnd = rng(Math.round(ax * 7 + az * 13) & 0xffff || 1);
  const tube = (l, w, h, x, y, rot) => {
    const m = new Mesh(new BoxGeometry(l, h, w), steel);
    m.position.set(x, y, 0);
    m.rotation.z = rot;
    return m;
  };
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const xm = ax + (bx - ax) * t;
    const zm = az + (bz - az) * t;
    const y = heightAt(xm, zm);
    const panel = new Group();
    const mp = new Mesh(new PlaneGeometry(pw - 0.08, height - 0.08), meshMat);
    const uv = mp.geometry.attributes.uv.array;
    for (let k = 0; k < uv.length; k += 2) {
      uv[k] *= (pw - 0.08) / TW;
      uv[k + 1] *= (height - 0.08) / (TW * 1.5);
    }
    panel.add(mp);
    // Tube frame round the mesh.
    panel.add(tube(pw, 0.04, 0.04, 0, height / 2 - 0.02, 0), tube(pw, 0.04, 0.04, 0, -height / 2 + 0.02, 0));
    panel.add(tube(0.04, 0.04, height, -pw / 2 + 0.02, 0, 0), tube(0.04, 0.04, height, pw / 2 - 0.02, 0, 0));
    // Raised a little off the ground, leaning and twisted a touch.
    panel.position.set(xm, y + height / 2 + 0.05, zm);
    panel.rotation.set(0, yaw + (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.02, 'YXZ');
    panel.rotateX((rnd() - 0.5) * 0.05);
    panel.traverse((o) => {
      if (o.isMesh && o.material === steel) o.castShadow = true;
    });
    g.add(panel);
  }
  // Wooden posts at each joint, a little taller than the panels.
  const postGeo = new CylinderGeometry(0.05, 0.06, height + 0.25, 7);
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const z = az + ((bz - az) * i) / n;
    const post = new Mesh(postGeo, wood);
    post.position.set(x, heightAt(x, z) + (height + 0.25) / 2, z);
    post.castShadow = true;
    g.add(post);
  }
  return g;
}

/**
 * Tall chain-link fence along a line: galvanised diamond mesh (see-through,
 * a grey haze from a distance) on square concrete posts every 3 m.
 */
function chainLink([ax, az], [bx, bz], height) {
  const g = new Group();
  const f = { height };
  const len = Math.hypot(bx - ax, bz - az);
  const yaw = Math.atan2(-(bz - az), bx - ax); // local x along the fence
  const concrete = lambert({ color: '#b3afa6' });
  // 0.4 m of mesh per tile: 50 mm diamonds of thin wire.
  const TILE = 0.4;
  const mesh = canvasTex(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(170,176,178,1)';
    c.lineWidth = 1.6;
    const n = 8; // diamonds across a tile
    const d = w / n;
    c.beginPath();
    for (let i = -n; i <= 2 * n; i++) {
      c.moveTo(i * d, 0);
      c.lineTo(i * d + h, h);
      c.moveTo(i * d, 0);
      c.lineTo(i * d - h, h);
    }
    c.stroke();
  });
  const meshMat = new MeshStandardMaterial({
    map: mesh, transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.5, metalness: 0.5,
  });
  const steps = Math.max(1, Math.round(len / 3));
  const bayLen = len / steps;
  // One panel per bay, following the ground.
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const xm = ax + (bx - ax) * t;
    const zm = az + (bz - az) * t;
    const bay = new Mesh(new PlaneGeometry(bayLen, f.height), meshMat);
    const uv = bay.geometry.attributes.uv.array;
    for (let k = 0; k < uv.length; k += 2) {
      uv[k] *= bayLen / TILE;
      uv[k + 1] *= f.height / TILE;
    }
    bay.position.set(xm, heightAt(xm, zm) + f.height / 2, zm);
    bay.rotation.y = yaw;
    bay.receiveShadow = true;
    g.add(bay);
  }
  // Square concrete posts, 125 mm, a little taller than the mesh.
  const postH = f.height + 0.1;
  const postGeo = new BoxGeometry(0.125, postH, 0.125);
  for (let i = 0; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps;
    const z = az + ((bz - az) * i) / steps;
    const post = new Mesh(postGeo, concrete);
    post.position.set(x, heightAt(x, z) + postH / 2, z);
    post.rotation.y = yaw;
    post.castShadow = true;
    post.receiveShadow = true;
    g.add(post);
  }
  return g;
}
