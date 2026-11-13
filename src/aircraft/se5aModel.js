// Procedural 3D model of an S.E.5a RC model, built in the same body axes as the
// flight model (+x forward, +y up, +z right, metres, origin at the CG).
//
// Colour scheme: PC10 (khaki-brown) upper surfaces, clear-doped linen
// undersides, RFC/RAF roundels and blue-white-red rudder stripes.

import {
  Group, Mesh, MeshStandardMaterial, Vector3, Color, CylinderGeometry, BoxGeometry,
  SphereGeometry, TorusGeometry, CircleGeometry, DoubleSide, LineSegments,
  BufferGeometry, Float32BufferAttribute, LineBasicMaterial, CanvasTexture, SRGBColorSpace,
  Quaternion, PlaneGeometry,
} from 'three';
import { loft, mirrorZ, airfoilRing, naca } from './geom.js';

const PC10 = new Color('#5a5536');
const LINEN = new Color('#d9cfae');
const GREY = new Color('#7a7c76');
const METAL = new Color('#8f918c');
const DARK = new Color('#1c1b19');
const WOOD = new Color('#6e4a2a');
const ROUNDEL_BLUE = new Color('#1d2f6b');
const ROUNDEL_RED = new Color('#a3202a');
const WHITE = new Color('#ece8dc');

const deg = Math.PI / 180;
const WING_T = 0.08;   // thickness/chord
const WING_M = 0.04;   // camber

function std(color, extra = {}) {
  return new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...extra });
}

const fabric = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });

/** Point on a wing surface (right half, z >= 0). */
function wingPoint(w, frac, z, yNorm) {
  const relx = -frac * w.chord;
  const y = yNorm * w.chord;
  const ci = Math.cos(w.incidence);
  const si = Math.sin(w.incidence);
  const x = w.leX + relx * ci - y * si;
  const yy = w.y + relx * si + y * ci + Math.tan(w.dihedral) * z;
  return new Vector3(x, yy, z);
}

/** Chord scale for rounded tips (s = 0 root .. 1 tip). */
function tipScale(s) {
  if (s < 0.9) return 1;
  const t = (s - 0.9) / 0.1;
  return Math.max(0.3, Math.sqrt(1 - t * t * 0.92));
}

/** Loft part of a wing half between spanwise z0..z1, chord fractions f0..f1. */
function wingLoft(w, z0, z1, f0, f1, nSpan, topColor, bottomColor) {
  const n = 14;
  const half = w.span / 2;
  const rings = [];
  for (let i = 0; i <= nSpan; i++) {
    const z = z0 + ((z1 - z0) * i) / nSpan;
    const sc = tipScale(z / half);
    // Rounded tip: scale the chord about the 35% point.
    const ring = airfoilRing(f0, f1, n, WING_T, WING_M).map(([f, y]) => {
      const fs = 0.35 + (f - 0.35) * sc;
      return wingPoint(w, fs, z, y * sc);
    });
    rings.push(ring);
  }
  const topCount = n + 1;
  return loft(rings, { color: (_p, _ri, pi) => (pi < topCount ? topColor : bottomColor) });
}

/** A roundel decal conforming to a wing surface. */
function wingRoundel(w, fracCentre, zCentre, radius, top) {
  const g = new Group();
  const rings = [
    [radius, ROUNDEL_BLUE, 0.0012],
    [radius * 0.66, WHITE, 0.0018],
    [radius * 0.33, ROUNDEL_RED, 0.0024],
  ];
  for (const [r, color, off] of rings) {
    const disc = new CircleGeometry(r, 40, 0, Math.PI * 2);
    const p = disc.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i);
      const dz = p.getY(i);
      const frac = fracCentre + dx / w.chord;
      const z = zCentre + dz;
      const s = naca(frac, WING_T, WING_M);
      const yN = (top ? s.upper : s.lower) + (top ? off : -off) / w.chord;
      const v = wingPoint(w, frac, z, yN);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    disc.computeVertexNormals();
    g.add(new Mesh(disc, std(color, { side: DoubleSide })));
  }
  return g;
}

function sideRoundel(x, y, z, radius, sign) {
  const g = new Group();
  const layers = [
    [radius, ROUNDEL_BLUE, 0],
    [radius * 0.66, WHITE, 0.0008],
    [radius * 0.33, ROUNDEL_RED, 0.0016],
  ];
  for (const [r, color, off] of layers) {
    const m = new Mesh(new CircleGeometry(r, 32), std(color, { side: DoubleSide }));
    m.position.set(x, y, z + sign * off);
    g.add(m);
  }
  g.rotation.y = sign > 0 ? -2 * deg : 2 * deg;
  return g;
}

function fuselage() {
  // Stations: x, half-width, bottom y, top y
  const st = [
    [0.405, 0.075, -0.075, 0.07],
    [0.395, 0.085, -0.085, 0.085],
    [0.30, 0.09, -0.095, 0.10],
    [0.12, 0.09, -0.10, 0.112],
    [-0.12, 0.088, -0.10, 0.118],
    [-0.30, 0.074, -0.085, 0.095],
    [-0.48, 0.055, -0.06, 0.07],
    [-0.64, 0.032, -0.03, 0.05],
    [-0.76, 0.012, -0.008, 0.04],
  ];
  const nP = 32;
  const rings = st.map(([x, hw, yb, yt]) => {
    const ring = [];
    const yc = (yb + yt) / 2;
    const b = (yt - yb) / 2;
    for (let j = 0; j < nP; j++) {
      const th = (j / nP) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const nExp = sn > 0 ? 2.2 : 4; // round top decking, boxy bottom
      const z = hw * Math.sign(cs) * Math.abs(cs) ** (2 / nExp);
      const y = yc + b * Math.sign(sn) * Math.abs(sn) ** (2 / nExp);
      ring.push(new Vector3(x, y, z));
    }
    return ring;
  });
  const geo = loft(rings, {
    color: (p) => {
      if (p.x > 0.18) return GREY; // engine cowling panels
      return p.y < -0.06 ? LINEN : PC10;
    },
  });
  return new Mesh(geo, fabric);
}

function cylinderBetween(a, b, radius, material, radialSegments = 8) {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new Mesh(new CylinderGeometry(radius, radius, len, radialSegments), material);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** Streamlined strut: an ellipse-section cylinder between two points. */
function strut(a, b, material, w = 0.009, t = 0.004) {
  const m = cylinderBetween(a, b, 1, material, 10);
  m.scale.set(w, 1, t);
  // Re-orient so the long section axis is fore-aft.
  const dir = new Vector3().subVectors(b, a).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
  m.quaternion.copy(q);
  return m;
}

function wires(points) {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(points.flatMap((p) => [p.x, p.y, p.z]), 3));
  return new LineSegments(geo, new LineBasicMaterial({ color: 0xb8b8b0, transparent: true, opacity: 0.8 }));
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const ctx = c.getContext('2d');
  const cols = ['#1d2f6b', '#ece8dc', '#a3202a'];
  cols.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect((i * 64) / 3, 0, 64 / 3 + 1, 8);
  });
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function propDiscTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(70,45,25,0.0)');
  g.addColorStop(0.15, 'rgba(70,45,25,0.55)');
  g.addColorStop(0.7, 'rgba(70,45,25,0.30)');
  g.addColorStop(0.93, 'rgba(70,45,25,0.22)');
  g.addColorStop(1, 'rgba(70,45,25,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Build the S.E.5a model. Returns { root, update(aircraft, dt), setPilotVisible(b) } */
/**
 * @param {object} G      reference layout (see se5a.js), drawn at 1/5 proportions
 * @param {number} scale  factor from the reference layout to the real model
 */
export function createSE5aModel(G, scale) {
  const outer = new Group();
  outer.name = 'SE5a';
  const root = new Group();
  root.scale.setScalar(scale);
  outer.add(root);
  const structure = std(WOOD);
  const metal = std(METAL, { metalness: 0.5, roughness: 0.45 });
  const dark = std(DARK, { roughness: 0.6 });

  // --- Fuselage ---------------------------------------------------------
  const fus = fuselage();
  fus.castShadow = true;
  root.add(fus);

  // Radiator front with shutters
  const rad = new Mesh(new PlaneGeometry(0.13, 0.13), std('#2a2a28', { roughness: 0.5, metalness: 0.4 }));
  rad.position.set(0.406, -0.003, 0);
  rad.rotation.y = Math.PI / 2;
  root.add(rad);
  for (let i = 0; i < 7; i++) {
    const s = new Mesh(new BoxGeometry(0.004, 0.006, 0.125), metal);
    s.position.set(0.408, -0.06 + i * 0.019, 0);
    root.add(s);
  }

  // Cockpit opening and coaming
  const cockpit = new Mesh(new CylinderGeometry(1, 1, 0.01, 24), dark);
  cockpit.scale.set(0.11, 1, 0.06);
  cockpit.position.set(-0.19, 0.114, 0);
  root.add(cockpit);
  const coaming = new Mesh(new TorusGeometry(1, 0.05, 6, 24), std('#3b2416', { roughness: 0.7 }));
  coaming.rotation.x = Math.PI / 2;
  coaming.scale.set(0.11, 0.065, 0.1);
  coaming.position.set(-0.19, 0.12, 0);
  root.add(coaming);

  // Windscreen
  const ws = new Mesh(new PlaneGeometry(0.05, 0.03), new MeshStandardMaterial({ color: 0xcfe6ee, transparent: true, opacity: 0.12, roughness: 0.05, side: DoubleSide, depthWrite: false }));
  ws.position.set(-0.07, 0.133, 0);
  ws.rotation.set(0, Math.PI / 2, 0);
  ws.rotateX(-25 * deg);
  root.add(ws);

  // Pilot head
  const pilot = new Group();
  const head = new Mesh(new SphereGeometry(0.033, 16, 12), std('#4a2e1a', { roughness: 0.6 }));
  head.position.set(-0.2, 0.15, 0);
  head.castShadow = true;
  pilot.add(head);
  const goggles = new Mesh(new TorusGeometry(0.034, 0.005, 6, 20, Math.PI), std('#222'));
  goggles.position.set(-0.2, 0.155, 0);
  goggles.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  pilot.add(goggles);
  const shoulders = new Mesh(new SphereGeometry(0.05, 12, 8), std('#4b3a26'));
  shoulders.scale.set(0.7, 0.5, 1);
  shoulders.position.set(-0.21, 0.11, 0);
  pilot.add(shoulders);
  root.add(pilot);

  // Exhaust pipes along both sides
  for (const s of [-1, 1]) {
    const a = new Vector3(0.3, 0.04, s * 0.094);
    const b = new Vector3(-0.15, 0.03, s * 0.094);
    const pipe = cylinderBetween(a, b, 0.009, std('#5d5750', { metalness: 0.4, roughness: 0.6 }));
    pipe.castShadow = true;
    root.add(pipe);
  }

  // Vickers gun on the cowl (left), Lewis gun on the top wing.
  const vickers = new Mesh(new BoxGeometry(0.16, 0.022, 0.022), dark);
  vickers.position.set(0.12, 0.118, -0.035);
  root.add(vickers);
  const vbarrel = cylinderBetween(new Vector3(0.2, 0.118, -0.035), new Vector3(0.33, 0.112, -0.035), 0.007, dark);
  root.add(vbarrel);
  const lewis = cylinderBetween(new Vector3(-0.05, G.upperY + 0.03, 0), new Vector3(0.17, G.upperY + 0.03, 0), 0.008, dark);
  root.add(lewis);
  const drum = new Mesh(new CylinderGeometry(0.02, 0.02, 0.01, 16), dark);
  drum.position.set(-0.01, G.upperY + 0.043, 0);
  root.add(drum);

  // --- Wings --------------------------------------------------------------
  const upper = { leX: G.upperLeX, y: G.upperY, chord: G.chord, span: G.span, dihedral: G.dihedral, incidence: G.incidence };
  const lower = { leX: G.lowerLeX, y: G.lowerY, chord: G.chord, span: G.span, dihedral: G.dihedral, incidence: G.incidence };
  const half = G.span / 2;
  const ailFrom = 0.4;
  const hinge = 0.76;
  const ailerons = [];

  function buildWing(w, rootZ, roundelTop) {
    const right = new Group();
    const inner = wingLoft(w, rootZ, ailFrom, 0, 1, 4, PC10, LINEN);
    const outer = wingLoft(w, ailFrom, half, 0, hinge, 10, PC10, LINEN);
    right.add(new Mesh(inner, fabric), new Mesh(outer, fabric));
    // Aileron with its own pivot along the hinge line
    const ailGeo = wingLoft(w, ailFrom + 0.003, half, hinge, 1, 10, PC10, LINEN);
    const hingeA = wingPoint(w, hinge, ailFrom, 0.02);
    const hingeB = wingPoint(w, hinge, half * 0.95, 0.02);
    const pivot = new Group();
    pivot.position.copy(hingeA);
    ailGeo.translate(-hingeA.x, -hingeA.y, -hingeA.z);
    const ail = new Mesh(ailGeo, fabric);
    ail.castShadow = true;
    pivot.add(ail);
    pivot.userData.axis = new Vector3().subVectors(hingeB, hingeA).normalize();
    right.add(pivot);
    right.children.forEach((m) => (m.castShadow = true));
    const rz = half * 0.72;
    right.add(wingRoundel(w, 0.42, rz, 0.105, roundelTop));
    return { right, pivot };
  }

  for (const [w, rootZ, top] of [[upper, 0.0, true], [lower, G.lowerRootZ, false]]) {
    const { right, pivot } = buildWing(w, rootZ, top);
    root.add(right);
    ailerons.push({ pivot, side: 1, base: pivot.quaternion.clone() });
    // Mirror for the left side
    const left = new Group();
    right.traverse((o) => {
      if (o.isMesh && o.parent === right) {
        const m = new Mesh(mirrorZ(o.geometry), o.material);
        m.castShadow = true;
        left.add(m);
      }
    });
    // Mirror roundel group
    const roundel = right.children.find((c) => c.isGroup && c !== pivot);
    const rl = roundel.clone();
    rl.scale.z = -1;
    left.add(rl);
    // Mirror aileron
    const pivotL = new Group();
    pivotL.position.copy(pivot.position).setZ(-pivot.position.z);
    const ailMesh = pivot.children[0];
    const mL = new Mesh(mirrorZ(ailMesh.geometry), ailMesh.material);
    mL.castShadow = true;
    pivotL.add(mL);
    const ax = pivot.userData.axis;
    pivotL.userData.axis = new Vector3(ax.x, ax.y, -ax.z);
    left.add(pivotL);
    root.add(left);
    ailerons.push({ pivot: pivotL, side: -1, base: pivotL.quaternion.clone() });
  }

  // --- Struts and wires ----------------------------------------------------
  const strutMat = std('#4a3a26', { roughness: 0.7 });
  const wirePts = [];
  for (const s of [-1, 1]) {
    for (const zf of [0.42, 0.78]) {
      const z = half * zf;
      const fl = wingPoint(lower, 0.12, z, 0.06);
      const fu = wingPoint(upper, 0.12, z, -0.02);
      const rl = wingPoint(lower, 0.72, z, 0.04);
      const ru = wingPoint(upper, 0.72, z, -0.01);
      for (const [a, b] of [[fl, fu], [rl, ru]]) {
        a.z *= s;
        b.z *= s;
        const m = strut(a, b, strutMat);
        m.castShadow = true;
        root.add(m);
      }
    }
    // Flying wires (lower root -> upper outer strut) and landing wires.
    const lr = wingPoint(lower, 0.3, G.lowerRootZ + 0.01, 0.02);
    const uo = wingPoint(upper, 0.3, half * 0.78, -0.01);
    const um = wingPoint(upper, 0.3, half * 0.42, -0.01);
    const lm = wingPoint(lower, 0.3, half * 0.42, 0.02);
    const ur = wingPoint(upper, 0.3, 0.1, -0.01);
    const lo = wingPoint(lower, 0.3, half * 0.78, 0.02);
    for (const [a, b] of [[lr, um], [lm, uo], [ur, lm], [um, lo]]) {
      a.z *= s;
      b.z *= s;
      wirePts.push(a, b);
      a.z *= s;
      b.z *= s;
    }
    // Cabane struts
    for (const xf of [0.15, 0.7]) {
      const top = wingPoint(upper, xf, 0.11, -0.02);
      top.z *= s;
      const bot = new Vector3(top.x - 0.01, 0.09, s * 0.07);
      root.add(strut(bot, top, strutMat, 0.007, 0.004));
    }
  }
  root.add(wires(wirePts));

  // --- Undercarriage ----------------------------------------------------------
  const W = G.wheel;
  for (const s of [-1, 1]) {
    const axle = new Vector3(W.x, W.y, s * (W.z - 0.025));
    root.add(strut(new Vector3(0.24, -0.09, s * 0.07), axle, strutMat, 0.008, 0.004));
    root.add(strut(new Vector3(0.05, -0.095, s * 0.07), axle, strutMat, 0.008, 0.004));
    const tyre = new Mesh(new TorusGeometry(W.radius * 0.8, W.radius * 0.2, 10, 24), std('#2b2b2b', { roughness: 0.9 }));
    tyre.position.set(W.x, W.y, s * W.z);
    tyre.castShadow = true;
    root.add(tyre);
    const hub = new Mesh(new CylinderGeometry(W.radius * 0.8, W.radius * 0.8, 0.02, 20), std(LINEN));
    hub.rotation.x = Math.PI / 2;
    hub.position.copy(tyre.position);
    root.add(hub);
  }
  root.add(cylinderBetween(new Vector3(W.x, W.y, -W.z), new Vector3(W.x, W.y, W.z), 0.005, metal));
  root.add(strut(new Vector3(-0.68, -0.02, 0), new Vector3(G.skid.x, G.skid.y, 0), structure, 0.008, 0.005));

  // --- Tail -----------------------------------------------------------------
  const T = G.tail;
  const tailW = { leX: T.leX, y: T.y, chord: T.chord, span: T.span, dihedral: 0, incidence: T.incidence };
  const elevHinge = 0.58;
  const stabR = wingLoft(tailW, 0.0, T.span / 2, 0, elevHinge, 8, PC10, LINEN);
  root.add(new Mesh(stabR, fabric), new Mesh(mirrorZ(stabR), fabric));
  const elevPivot = new Group();
  const eh = wingPoint(tailW, elevHinge, 0, 0.0);
  elevPivot.position.copy(eh);
  const elevR = wingLoft(tailW, 0.015, T.span / 2, elevHinge, 1, 8, PC10, LINEN);
  elevR.translate(-eh.x, -eh.y, -eh.z);
  elevPivot.add(new Mesh(elevR, fabric), new Mesh(mirrorZ(elevR), fabric));
  elevPivot.children.forEach((m) => (m.castShadow = true));
  root.add(elevPivot);

  // Fin (small) and large striped rudder
  const F = G.fin;
  const finRings = [];
  const rudderHingeX = F.leX - F.chord * 0.42;
  for (let i = 0; i <= 4; i++) {
    const h = F.baseY + (F.height * 0.75 * i) / 4;
    const lead = F.leX - (i / 4) * 0.06;
    const c = Math.max(0.01, lead - rudderHingeX);
    finRings.push(airfoilRing(0, 1, 8, 0.1, 0).map(([f, y]) => new Vector3(lead - f * c, h, y * c)));
  }
  const fin = new Mesh(loft(finRings, { color: () => PC10 }), fabric);
  fin.castShadow = true;
  root.add(fin);

  const rudderPivot = new Group();
  rudderPivot.position.set(rudderHingeX, 0, 0);
  const rRings = [];
  const rBottom = -0.07;
  const rTop = F.baseY + F.height;
  for (let i = 0; i <= 10; i++) {
    const s = i / 10;
    const y = rBottom + (rTop - rBottom) * s;
    // Rounded rudder outline
    const c = 0.17 * Math.sqrt(Math.max(0.05, 1 - ((s - 0.45) / 0.58) ** 2));
    rRings.push(airfoilRing(0, 1, 8, 0.08, 0).map(([f, yy]) => new Vector3(-f * c, y, yy * 0.17)));
  }
  const rGeo = loft(rRings);
  // UVs from chord position for stripes (blue at hinge, red at trailing edge).
  const rp = rGeo.attributes.position;
  const uv = [];
  for (let i = 0; i < rp.count; i++) uv.push(Math.min(0.999, -rp.getX(i) / 0.17), 0.5);
  rGeo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  const rudder = new Mesh(rGeo, new MeshStandardMaterial({ map: stripeTexture(), roughness: 0.85 }));
  rudder.castShadow = true;
  rudderPivot.add(rudder);
  root.add(rudderPivot);

  // Fuselage roundels
  for (const s of [-1, 1]) root.add(sideRoundel(-0.42, 0.005, s * 0.064, 0.048, s));

  // --- Propeller ------------------------------------------------------------
  const P = G.prop;
  const prop = new Group();
  prop.position.set(P.x, P.y, 0);
  const propWood = std('#5b3a1e', { roughness: 0.5 });
  const blades = new Group();
  for (const s of [-1, 1]) {
    const rings = [];
    for (let i = 0; i <= 8; i++) {
      const r = 0.02 + ((P.radius - 0.02) * i) / 8;
      const c = 0.04 * (1 - 0.45 * ((r - 0.08) / 0.11) ** 2) + 0.004;
      const twist = Math.atan(0.22 / (2 * Math.PI * Math.max(r, 0.03)));
      const ring = [];
      for (let j = 0; j < 10; j++) {
        const th = (j / 10) * Math.PI * 2;
        const a = Math.cos(th) * c * 0.5;
        const b = Math.sin(th) * 0.004;
        // section in (x: thickness/fore-aft, z: chord) rotated by twist
        const x = b * Math.cos(twist) + a * Math.sin(twist);
        const z = a * Math.cos(twist) - b * Math.sin(twist);
        ring.push(new Vector3(x, s * r, s * z));
      }
      rings.push(ring);
    }
    const bm = new Mesh(loft(rings), propWood);
    bm.castShadow = true;
    blades.add(bm);
  }
  const hubM = new Mesh(new CylinderGeometry(0.018, 0.022, 0.03, 16), metal);
  hubM.rotation.z = Math.PI / 2;
  prop.add(blades, hubM);
  const disc = new Mesh(new CircleGeometry(P.radius, 48), new MeshStandardMaterial({ map: propDiscTexture(), transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.6 }));
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;
  prop.add(disc);
  root.add(prop);

  let propAngle = 0;
  const tmpQ = new Quaternion();

  return {
    root: outer,
    pilot,
    setPilotVisible(v) {
      pilot.visible = v;
    },
    /** Sync control surfaces and prop with the flight model. */
    update(aircraft, dt) {
      const sAil = aircraft.surfaces.find((s) => s.name.startsWith('upper-R') && s.controls.length);
      const ailDefl = sAil ? sAil.deflection : 0; // right aileron (TE down positive)
      for (const a of ailerons) {
        const d = a.side > 0 ? ailDefl : -ailDefl;
        // Positive rotation about the hinge axis (pointing outboard) for right side
        // moves the trailing edge down.
        tmpQ.setFromAxisAngle(a.pivot.userData.axis, a.side > 0 ? d : -d);
        a.pivot.quaternion.copy(a.base).multiply(tmpQ);
      }
      const elev = aircraft.surfaces.find((s) => s.name === 'stab-R');
      // Positive deflection = trailing edge down = positive rotation about +z.
      elevPivot.rotation.z = elev ? elev.deflection : 0;
      const fin = aircraft.surfaces.find((s) => s.name === 'fin');
      // fin normal is +z; positive deflection = TE towards -z
      rudderPivot.rotation.y = fin ? -fin.deflection : 0;

      const rpm = aircraft.rpm;
      const fast = rpm > 1200;
      blades.visible = !fast;
      disc.visible = fast;
      if (fast) disc.material.opacity = Math.min(1, 0.35 + rpm / 9000);
      propAngle += (rpm / 60) * Math.PI * 2 * dt;
      prop.rotation.x = aircraft.propBroken ? 0.4 : propAngle;
    },
  };
}
