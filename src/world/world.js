// The flying field: sky, lighting, terrain, runway, trees and props.
import {
  Scene, Color, Fog, HemisphereLight, DirectionalLight, Mesh, PlaneGeometry, MeshStandardMaterial,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, InstancedMesh, CylinderGeometry, IcosahedronGeometry,
  Object3D, BoxGeometry, ConeGeometry, Group, Vector3, MathUtils, DoubleSide, Float32BufferAttribute,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, gridHeight, TERRAIN_SIZE, TERRAIN_SEGMENTS } from '../sim/terrain.js';

export const RUNWAY = { x: 0, z: -22, length: 180, width: 18 };
export const PILOT_POS = new Vector3(0, 0, 0);

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5d7a3a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const l = 30 + Math.random() * 25;
    ctx.fillStyle = `hsl(${80 + Math.random() * 25}, ${35 + Math.random() * 20}%, ${l}%)`;
    ctx.fillRect(x, y, 1 + Math.random() * 1.5, 1 + Math.random() * 3);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function runwayTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d');
  // Mowing stripes along the runway
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? '#7f9c4c' : '#6e8d40';
    ctx.fillRect((i * 512) / 16, 0, 512 / 16 + 1, 64);
  }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 60},${70 + Math.random() * 60},30,0.35)`;
    ctx.fillRect(Math.random() * 512, Math.random() * 64, 1, 2);
  }
  // Edge markers
  ctx.fillStyle = 'rgba(240,240,230,0.9)';
  for (let i = 0; i < 512; i += 32) {
    ctx.fillRect(i, 1, 10, 2);
    ctx.fillRect(i, 61, 10, 2);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class World {
  /** @param {import('../sim/obstacles.js').Obstacles} obstacles */
  constructor(obstacles) {
    this.obstacles = obstacles;
    this.scene = new Scene();
    this.scene.background = new Color('#9cc3e6');
    this.scene.fog = new Fog('#b9d1e6', 400, 3200);
    this.sunDir = new Vector3();

    this.#sky();
    this.#lights();
    this.#terrain();
    this.#runway();
    this.#trees();
    this.#props();
    this.setSun(35, 220);
  }

  #sky() {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.2;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    this.sky = sky;
    this.scene.add(sky);
  }

  #lights() {
    this.hemi = new HemisphereLight('#cfe3ff', '#4d5a33', 1.1);
    this.scene.add(this.hemi);
    const sun = new DirectionalLight('#fff3df', 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 6;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 200 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.sun = sun;
    this.scene.add(sun, sun.target);
  }

  /** Sun elevation/azimuth in degrees (azimuth: 0 = north/-z, 90 = east/+x). */
  setSun(elevationDeg, azimuthDeg) {
    const el = MathUtils.degToRad(elevationDeg);
    const az = MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const day = MathUtils.clamp(elevationDeg / 25, 0.15, 1);
    this.sun.intensity = 2.8 * day;
    this.hemi.intensity = 0.4 + 0.8 * day;
    const warm = MathUtils.clamp(1 - elevationDeg / 20, 0, 1);
    this.sun.color.setRGB(1, 0.95 - warm * 0.25, 0.88 - warm * 0.45);
    this.scene.fog.color.setRGB(0.72 * day + 0.1, 0.8 * day + 0.08, 0.9 * day + 0.08);
  }

  /** Keep the shadow camera centred on the aircraft so its shadow is crisp. */
  followShadow(target) {
    this.sun.position.copy(target).addScaledVector(this.sunDir, 80);
    this.sun.target.position.copy(target);
  }

  #terrain() {
    // Same grid the physics uses (src/sim/terrain.js), so they always agree.
    const size = TERRAIN_SIZE;
    const seg = TERRAIN_SEGMENTS;
    const geo = new PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const colors = [];
    // Vertex colours multiply the grass texture, so keep them light.
    const c1 = new Color('#f2ffd8');
    const c2 = new Color('#c4d79c');
    const c3 = new Color('#e8e2c0');
    const tmp = new Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      // PlaneGeometry vertex i is grid point (i % (seg+1), floor(i / (seg+1))).
      const h = gridHeight(i % (seg + 1), Math.floor(i / (seg + 1)));
      p.setY(i, h);
      const n = Math.sin(x * 0.011) * Math.cos(z * 0.013) * 0.5 + 0.5;
      tmp.copy(c1).lerp(c2, n * 0.8);
      if (h > 40) tmp.lerp(c3, Math.min(1, (h - 40) / 120));
      // Patchwork fields far away
      const fx = Math.floor(x / 180);
      const fz = Math.floor(z / 140);
      const r = Math.abs(Math.sin(fx * 12.9898 + fz * 78.233) * 43758.5453) % 1;
      if (Math.hypot(x, z) > 500) tmp.offsetHSL((r - 0.5) * 0.06, 0, (r - 0.5) * 0.08);
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = grassTexture();
    tex.repeat.set(size / 6, size / 6);
    const mat = new MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1 });
    const ground = new Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  #runway() {
    const g = new PlaneGeometry(RUNWAY.length, RUNWAY.width);
    g.rotateX(-Math.PI / 2);
    const rw = new Mesh(g, new MeshStandardMaterial({ map: runwayTexture(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
    // Just above the physics ground (y = 0); polygonOffset prevents z-fighting.
    rw.position.set(RUNWAY.x, 0.002, RUNWAY.z);
    rw.receiveShadow = true;
    this.scene.add(rw);

    // Pilot box (gravel pad) and safety fence line
    const pad = new Mesh(new PlaneGeometry(6, 4), new MeshStandardMaterial({ color: '#a39a86', roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.002, 0.5);
    pad.receiveShadow = true;
    this.scene.add(pad);

    const postGeo = new CylinderGeometry(0.04, 0.04, 1.1, 6);
    const postMat = new MeshStandardMaterial({ color: '#6b5b45' });
    const posts = new InstancedMesh(postGeo, postMat, 40);
    const o = new Object3D();
    for (let i = 0; i < 40; i++) {
      o.position.set(-100 + i * 5.1, 0.55, 6);
      o.updateMatrix();
      posts.setMatrixAt(i, o.matrix);
    }
    posts.castShadow = true;
    this.scene.add(posts);
    const rail = new Mesh(new BoxGeometry(200, 0.04, 0.04), postMat);
    rail.position.set(0, 1.0, 6);
    this.scene.add(rail);
  }

  #trees() {
    const count = this.obstacles.trees.length;
    const trunkGeo = new CylinderGeometry(0.25, 0.4, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = new IcosahedronGeometry(1, 1);
    const coniferGeo = new ConeGeometry(1, 1, 8);
    coniferGeo.translate(0, 0.5, 0);
    const trunkMat = new MeshStandardMaterial({ color: '#4b3a2a', roughness: 1 });
    const crownMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true });
    const trunks = new InstancedMesh(trunkGeo, trunkMat, count);
    const crowns = new InstancedMesh(crownGeo, crownMat, count);
    const conifers = new InstancedMesh(coniferGeo, crownMat, count);
    const o = new Object3D();
    const col = new Color();
    let nc = 0;
    let nf = 0;
    // Same layout the physics collides with (src/sim/obstacles.js).
    this.obstacles.trees.forEach((t, i) => {
      const { x, y, z, h } = t;
      o.rotation.set(0, t.rot, 0);
      o.position.set(x, y - 0.2, z);
      o.scale.set(1, h * 0.45, 1);
      o.updateMatrix();
      trunks.setMatrixAt(i, o.matrix);
      col.setHSL(t.hue, t.sat, t.light);
      if (t.conifer) {
        o.position.set(x, y + h * 0.15, z);
        o.scale.set(h * 0.22, h * 0.9, h * 0.22);
        o.updateMatrix();
        conifers.setMatrixAt(nf, o.matrix);
        conifers.setColorAt(nf++, col);
      } else {
        o.position.set(x, y + h * 0.62, z);
        o.scale.set(t.crownW, h * 0.38, t.crownW);
        o.updateMatrix();
        crowns.setMatrixAt(nc, o.matrix);
        crowns.setColorAt(nc++, col);
      }
    });
    crowns.count = nc;
    conifers.count = nf;
    for (const m of [trunks, crowns, conifers]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
    this.trees = { trunks, crowns, conifers };
  }

  #props() {
    // Windsock
    const ws = new Group();
    const pole = new Mesh(new CylinderGeometry(0.04, 0.05, 5, 8), new MeshStandardMaterial({ color: '#dddddd' }));
    pole.position.y = 2.5;
    pole.castShadow = true;
    ws.add(pole);
    const sock = new Group();
    sock.position.y = 4.85;
    // Wide mouth at the pole, tapering to the narrow downwind end. Rotating
    // +90° about z sends the cylinder's top (first radius) to -x, the far end.
    const coneGeo = new CylinderGeometry(0.12, 0.28, 1.6, 12, 4, true);
    coneGeo.rotateZ(Math.PI / 2);
    coneGeo.translate(-0.8, 0, 0);
    // Five crisp bands (orange at the mouth) from a stripe texture along the
    // sock's length (the cylinder's v texture coordinate).
    const bands = document.createElement('canvas');
    bands.width = 4;
    bands.height = 80;
    const bctx = bands.getContext('2d');
    for (let i = 0; i < 5; i++) {
      bctx.fillStyle = i % 2 ? '#f2f2f2' : '#ff5a1f';
      bctx.fillRect(0, i * 16, 4, 16);
    }
    const bandTex = new CanvasTexture(bands);
    bandTex.colorSpace = SRGBColorSpace;
    const sockMesh = new Mesh(coneGeo, new MeshStandardMaterial({ map: bandTex, side: DoubleSide, roughness: 0.9 }));
    sockMesh.castShadow = true;
    sock.add(sockMesh);
    ws.add(sock);
    ws.position.set(-35, 0, -42);
    this.scene.add(ws);
    this.windsock = sock;

    // Club hut / hangar behind the pilot
    const hut = new Group();
    const body = new Mesh(new BoxGeometry(10, 3, 6), new MeshStandardMaterial({ color: '#8b6b4a', roughness: 0.9 }));
    body.position.y = 1.5;
    const roof = new Mesh(new BoxGeometry(10.6, 0.25, 7), new MeshStandardMaterial({ color: '#3d4a52', roughness: 0.7 }));
    roof.position.y = 3.3;
    roof.rotation.x = 0.06;
    hut.add(body, roof);
    hut.traverse((m) => {
      m.castShadow = true;
      m.receiveShadow = true;
    });
    hut.position.set(-24, 0, 26);
    this.scene.add(hut);

    // Flight-line table
    const table = new Mesh(new BoxGeometry(2, 0.06, 0.8), new MeshStandardMaterial({ color: '#c8c8c8' }));
    table.position.set(6, 0.75, 3);
    table.castShadow = true;
    this.scene.add(table);
    for (const dx of [-0.9, 0.9]) {
      for (const dz of [-0.3, 0.3]) {
        const leg = new Mesh(new CylinderGeometry(0.02, 0.02, 0.75), table.material);
        leg.position.set(6 + dx, 0.375, 3 + dz);
        this.scene.add(leg);
      }
    }
  }

  /** Point the windsock with the wind (world velocity vector). */
  updateWindsock(wind) {
    const speed = Math.hypot(wind.x, wind.z);
    // Sock tail points downwind (sock geometry extends along -x).
    const yaw = Math.atan2(wind.z, -wind.x);
    this.windsock.rotation.set(0, yaw, 0);
    const droop = Math.max(0, 1 - speed / 7) * 1.2;
    this.windsock.rotateZ(droop);
  }
}
