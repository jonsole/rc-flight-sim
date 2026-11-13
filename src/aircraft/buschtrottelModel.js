// Procedural 3D model of the Buschtrottel (6 mm Depron), in body axes
// (+x forward, +y up, +z right, metres, origin at the CG). The layout object
// comes from buschtrottel.js, so the model and flight model always agree.

import {
  Group, Mesh, MeshStandardMaterial, Vector3, Color, CylinderGeometry,
  SphereGeometry, TorusGeometry, CircleGeometry, ConeGeometry, PlaneGeometry, DoubleSide,
  CanvasTexture,
  SRGBColorSpace, Quaternion,
} from 'three';
import { loft, mirrorZ } from './geom.js';

const foam = (color) => new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, flatShading: true });

/** Re-aim an existing cylinderBetween() mesh at new end points. */
function aimCylinder(m, a, b) {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  m.scale.set(1, len / m.userData.len, 1);
}

function cylinderBetween(a, b, radius, material, segments = 6) {
  const dir = new Vector3().subVectors(b, a);
  const m = new Mesh(new CylinderGeometry(radius, radius, dir.length(), segments), material);
  m.userData.len = dir.length();
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  return m;
}

/**
 * Thin flat plate between two outline curves, lofted along v.
 * @param {number[]} vs        stations along the plate
 * @param {(v:number)=>[number,number]} xs  front and back x at station v
 * @param {(x:number, v:number, d:number)=>Vector3} map  to 3D (d = thickness offset)
 */
function plate(vs, xs, map, t) {
  const rings = vs.map((v) => {
    const [xa, xb] = xs(v);
    return [map(xa, v, t / 2), map(xb, v, t / 2), map(xb, v, -t / 2), map(xa, v, -t / 2)];
  });
  return loft(rings);
}

/** KFm2 section as a closed ring of [chordFraction, y/chord], between f0..f1. */
function kfm2Ring(f0, f1, L) {
  const tf = L.thickFront / L.chord;
  const tr = L.thickRear / L.chord;
  const st = L.step;
  if (f0 >= st) return [[f0, 0], [f1, 0], [f1, tr], [f0, tr]];
  // Fully rounded leading edge: a half-circle the depth of the front section.
  const r = tf / 2;
  const pts = [[r, 0], [f1, 0], [f1, f1 > st ? tr : tf]];
  if (f1 > st) pts.push([st, tr], [st, tf]);
  pts.push([r, tf]);
  for (const deg of [120, 150, 180, 210, 240]) {
    const a = (deg * Math.PI) / 180;
    pts.push([r + r * Math.cos(a), r + r * Math.sin(a)]);
  }
  return pts;
}

function propDiscTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(30,30,30,0)');
  g.addColorStop(0.2, 'rgba(30,30,30,0.45)');
  g.addColorStop(0.9, 'rgba(30,30,30,0.2)');
  g.addColorStop(1, 'rgba(30,30,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function createBuschtrottelModel(L) {
  const S = L.style;
  const high = S.mount === 'high';
  const root = new Group();
  root.name = 'Buschtrottel';
  // Colour scheme. Optional keys: top + split (two-tone fuselage), wingBottom,
  // aileron; otherwise the fuselage has a side stripe and the wing is one colour.
  const C = S.colors;
  const tailMat = foam(C.tail);
  const ailMat = foam(C.aileron || C.wing);
  const vcMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
  const wingTop = new Color(C.wing);
  const wingBottom = new Color(C.wingBottom || C.wing);
  const slatTop = new Color(C.slatTop || C.wing);
  const slatBottom = new Color(C.slatBottom || C.wingBottom || C.wing);
  const metal = new MeshStandardMaterial({ color: '#9a9c9e', roughness: 0.4, metalness: 0.6 });
  // Side windows read as dark glass from outside; the windscreen stays clear
  // enough to fly FPV through.
  const glass = new MeshStandardMaterial({ color: '#1b2a33', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.75, side: DoubleSide });
  const screenGlass = new MeshStandardMaterial({ color: '#cfe3ee', roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide });
  const shadowAll = (o) => o.traverse((m) => m.isMesh && !m.userData.noShadow && (m.castShadow = true));

  // --- Fuselage: Depron box, either two-tone (split) or with a side stripe -------
  // Each ring point carries a paint index; colour changes happen at duplicated
  // points so the boundary is a crisp line on the flat-shaded foam.
  const paints = C.split
    ? [new Color(C.main), new Color(C.top)] // 0 = lower part, 1 = top part
    : [new Color(C.main), new Color(C.accent)]; // 0 = body, 1 = stripe
  // Cross-section: a box with rounded corners (radius r; well rounded at the
  // cowl, almost square further back). Points run up the right side, over the
  // top, down the left side and back along the bottom; paint changes sit at
  // duplicated points on the sides.
  const arc = (cz, cy, r, a0, a1, n) => {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
      out.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  };
  let ringPaint = [];
  const rings = L.fuselage.map(([x, hw, yb, yt, rIn = 0.002]) => {
    const r = Math.min(rIn, hw * 0.95, (yt - yb) * 0.45);
    const lo = yb + r;
    const hi = yt - r;
    const clampY = (y) => Math.min(hi, Math.max(lo, y));
    // Paint bands on the side: [y, paintBelow, paintAbove]
    const bands = C.split
      ? [[clampY(yb + C.split * (yt - yb)), 0, 1]]
      : [[clampY(yb + 0.42 * (yt - yb)), 0, 1], [clampY(yb + 0.58 * (yt - yb)), 1, 0]];
    const topPaint = C.split ? 1 : 0;
    const pts = [];
    // Right side, bottom to top.
    pts.push([hw, lo, 0]);
    for (const [y, below, above] of bands) pts.push([hw, y, below], [hw, y, above]);
    pts.push([hw, hi, topPaint]);
    for (const [z, y] of arc(hw - r, hi, r, 0, 90, 3)) pts.push([z, y, topPaint]);
    for (const [z, y] of arc(-hw + r, hi, r, 90, 180, 3)) pts.push([z, y, topPaint]);
    // Left side, top to bottom.
    for (const [y, below, above] of [...bands].reverse()) pts.push([-hw, y, above], [-hw, y, below]);
    pts.push([-hw, lo, 0]);
    for (const [z, y] of arc(-hw + r, lo, r, 180, 270, 3)) pts.push([z, y, 0]);
    for (const [z, y] of arc(hw - r, lo, r, 270, 360, 3).slice(0, -1)) pts.push([z, y, 0]);
    ringPaint = pts.map((p) => p[2]);
    return pts.map(([z, y]) => new Vector3(x, y, z));
  });
  const fus = new Mesh(loft(rings, { color: (_p, _ri, pi) => paints[ringPaint[pi]] }), vcMat);
  root.add(fus);

  // Cabin windows (high wing) or open cockpit (Agro)
  const pilot = new Group();
  const head = new Mesh(new SphereGeometry(0.017, 12, 8), new MeshStandardMaterial({ color: '#6b4a32', roughness: 0.7 }));
  pilot.add(head);
  if (high) {
    for (const s of [-1, 1]) {
      const w = new Mesh(new PlaneGeometry(0.15, 0.045), glass);
      w.position.set(-0.03, 0.046, s * 0.0415);
      w.rotation.y = s > 0 ? 0 : Math.PI;
      root.add(w);
    }
    const ws = new Mesh(new PlaneGeometry(0.084, 0.07), screenGlass);
    ws.position.set(0.11, 0.064, 0);
    ws.rotation.set(-Math.PI / 2, 0, 0);
    ws.rotateOnWorldAxis(new Vector3(0, 0, 1), -Math.atan2(0.025, 0.08));
    root.add(ws);
    head.position.set(-0.02, 0.04, 0);
  } else {
    // Low wing (Agro): canopy block on top of the fuselage.
    const fusAt = (x) => {
      const st = L.fuselage;
      for (let i = 0; i < st.length - 1; i++) {
        const [x0, hw0, , yt0] = st[i];
        const [x1, hw1, , yt1] = st[i + 1];
        if (x <= x0 && x >= x1) {
          const t = (x0 - x) / (x0 - x1);
          return { hw: hw0 + (hw1 - hw0) * t, yt: yt0 + (yt1 - yt0) * t };
        }
      }
      return { hw: st[0][1], yt: st[0][3] };
    };
    // Solid black canopy block: an angular trapezoid prism with sloped front
    // and back and chamfered sides, with the receiver aerial poking out.
    const H = 0.05;
    // Front foot, front of the flat top, start of the long rear slope, rear foot.
    const xs = [0.0, -0.055, -0.13, -0.25];
    const hs = [0.002, H, H, 0.002];
    const corner = (i, side, top) => {
      const { hw, yt } = fusAt(xs[i]);
      const base = hw * 0.9;
      const roof = hw * 0.6;
      const z = side * (top ? base + (roof - base) * (hs[i] / H) : base);
      return new Vector3(xs[i], yt + 0.001 + (top ? hs[i] : 0), z);
    };
    const cabRings = xs.map((_, i) => [corner(i, 1, false), corner(i, 1, true), corner(i, -1, true), corner(i, -1, false)]);
    const canopy = new Mesh(loft(cabRings), new MeshStandardMaterial({ color: '#141414', roughness: 0.75, flatShading: true }));
    canopy.userData.part = 'canopy';
    root.add(canopy);
    const top = cabRings[2][1].clone().lerp(cabRings[2][2], 0.5);
    const aerial = [top.clone().add(new Vector3(0.005, 0, 0)), top.clone().add(new Vector3(-0.012, 0.06, 0)), top.clone().add(new Vector3(-0.04, 0.1, 0))];
    for (const [a, b] of [[aerial[0], aerial[1]], [aerial[1], aerial[2]]]) {
      const wire = cylinderBetween(a, b, 0.0008, new MeshStandardMaterial({ color: '#111' }));
      wire.userData.part = 'canopy';
      root.add(wire);
    }
    head.position.set(-0.13, 0.07, 0);
  }
  root.add(pilot);

  // --- Wing: KFm2 Depron, ailerons on their own hinges ------------------------
  const HALF = L.span / 2;
  const chordAt = (z) => {
    if (S.tips !== 'round') return 1;
    const s = z / HALF;
    if (s < 0.82) return 1;
    const t = (s - 0.82) / 0.18;
    return Math.max(0.35, Math.sqrt(1 - t * t * 0.9));
  };
  const wingPoint = (f, yN, z) => {
    const k = chordAt(z);
    const c = L.chord * k;
    const relx = -(0.3 * L.chord + (f - 0.3) * c); // tips shrink about the 30% line
    const y = yN * L.chord * Math.min(1, 0.6 + k * 0.4);
    const ci = Math.cos(L.incidence);
    const si = Math.sin(L.incidence);
    return new Vector3(
      L.wingLeX + relx * ci - y * si,
      L.wingY + relx * si + y * ci + Math.tan(L.dihedral) * z,
      z,
    );
  };
  const wingPart = (z0, z1, f0, f1, n) => {
    const ring = kfm2Ring(f0, f1, L);
    // Underside points (flat bottom of the KFm2) take the bottom colour.
    const lowY = (L.thickFront / L.chord) * 0.3;
    const isBottom = ring.map(([, y]) => y <= lowY);
    const rs = [];
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      rs.push(ring.map(([f, y]) => wingPoint(f, y, z)));
    }
    return loft(rs, { color: (_p, _ri, pi) => (isBottom[pi] ? wingBottom : wingTop) });
  };
  const rootZ = high ? 0 : L.rootZ - 0.006;
  const nTip = S.tips === 'round' ? 10 : 3;
  const wingR = new Group();
  if (L.ailFrom - rootZ > 0.003) wingR.add(new Mesh(wingPart(rootZ, L.ailFrom, 0, 1, 2), vcMat));
  wingR.add(new Mesh(wingPart(L.ailFrom, HALF, 0, L.hinge, nTip), vcMat));
  const ailGeo = wingPart(L.ailFrom + 0.002, HALF - 0.001, L.hinge + 0.004, 1, nTip);
  const hA = wingPoint(L.hinge, 0, L.ailFrom);
  const hB = wingPoint(L.hinge, 0, HALF * 0.8);
  ailGeo.translate(-hA.x, -hA.y, -hA.z);
  const ailR = new Group();
  ailR.position.copy(hA);
  ailR.add(new Mesh(ailGeo, ailMat));
  const axisR = new Vector3().subVectors(hB, hA).normalize();
  const wingL = new Group();
  for (const m of wingR.children) wingL.add(new Mesh(mirrorZ(m.geometry), vcMat));
  const ailL = new Group();
  ailL.position.set(hA.x, hA.y, -hA.z);
  ailL.add(new Mesh(mirrorZ(ailGeo), ailMat));
  const axisL = new Vector3(axisR.x, axisR.y, -axisR.z);
  // Fixed leading-edge slats: a Depron strip ahead of and above the leading
  // edge, leaving a slot for the air to flow through.
  if (L.slats) {
    const t = 0.006 / L.chord;
    const a = [-0.14, 0.0];
    const b = [-0.02, 0.072];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = [(-(b[1] - a[1]) / len) * t, ((b[0] - a[0]) / len) * t];
    const ring = [a, b, [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]];
    const zEnd = Math.min(L.slats.to, S.tips === 'round' ? HALF * 0.84 : HALF - 0.005);
    const rs = [];
    for (let i = 0; i <= 4; i++) {
      const z = L.slats.from + ((zEnd - L.slats.from) * i) / 4;
      rs.push(ring.map(([f, y]) => wingPoint(f, y, z)));
    }
    // Points 0-1 are the slat's underside, 2-3 its upper surface.
    const slatGeo = loft(rs, { color: (_p, _ri, pi) => (pi < 2 ? slatBottom : slatTop) });
    wingR.add(new Mesh(slatGeo, vcMat));
    wingL.add(new Mesh(mirrorZ(slatGeo), vcMat));
  }
  wingR.userData.part = ailR.userData.part = 'wingR';
  wingL.userData.part = ailL.userData.part = 'wingL';
  root.add(wingR, wingL, ailR, ailL);
  const ailerons = [
    { pivot: ailR, axis: axisR, side: 1 },
    { pivot: ailL, axis: axisL, side: -1 },
  ];

  // --- Wing struts ---------------------------------------------------------------
  const strutMat = new MeshStandardMaterial({ color: '#3a3c3e', roughness: 0.6 });
  if (high) {
    for (const s of [-1, 1]) {
      const base = new Vector3(0.02, -0.056, s * 0.04);
      for (const f of [0.15, 0.65]) {
        const top = wingPoint(f, -0.01, HALF * 0.55);
        top.z *= s;
        const strut = cylinderBetween(base, top, 0.0025, strutMat);
        strut.userData.part = s > 0 ? 'wingR' : 'wingL';
        root.add(strut);
      }
    }
  } else {
    // Low wing: V-struts from the fuselage side, about 3/4 of the way up, down
    // to the top of the wing.
    const fx = 0.0;
    const st = L.fuselage.find((r) => r[0] <= fx) || L.fuselage[0];
    const [, hw, yb, yt] = st;
    for (const s of [-1, 1]) {
      const base = new Vector3(fx, yb + 0.75 * (yt - yb), s * (hw + 0.002));
      for (const f of [0.15, 0.65]) {
        const top = wingPoint(f, L.thickFront / L.chord + 0.004, HALF * 0.55);
        top.z *= s;
        const strut = cylinderBetween(base, top, 0.0025, strutMat);
        strut.userData.part = s > 0 ? 'wingR' : 'wingL';
        root.add(strut);
      }
    }
  }

  // --- Tail: flat 3 mm Depron plates ------------------------------------------
  const T = L.tail;
  const hs = T.span / 2;
  const hingeX = T.leX - T.fixed;
  const stabEdges = (v) => {
    const s = v / hs;
    if (S.tail === 'round') {
      const c = T.chord * Math.max(0.12, (1 - s * s) ** 0.6);
      const le = T.leX - (T.chord - c) * 0.35;
      return [le, le - c];
    }
    return [T.leX - 0.03 * s, T.leX - T.chord + 0.02 * s];
  };
  const vs = Array.from({ length: 11 }, (_, i) => (hs * i) / 10);
  const tailMap = (x, v, d) => {
    const ci = Math.cos(T.incidence);
    const si = Math.sin(T.incidence);
    const dx = x - T.leX;
    return new Vector3(T.leX + dx * ci - d * si, T.y + dx * si + d * ci, v);
  };
  const stabR = plate(vs, (v) => {
    const [le, te] = stabEdges(v);
    return [le, Math.max(te, hingeX)];
  }, tailMap, 0.003);
  for (const g of [stabR, mirrorZ(stabR)]) {
    const m = new Mesh(g, tailMat);
    m.userData.part = 'tail';
    root.add(m);
  }
  const elev = new Group();
  const eh = tailMap(hingeX, 0, 0);
  elev.position.copy(eh);
  const elevR = plate(vs, (v) => {
    const [, te] = stabEdges(v);
    const xa = hingeX - 0.002;
    return [xa, Math.min(te, xa)];
  }, tailMap, 0.003);
  elevR.translate(-eh.x, -eh.y, -eh.z);
  elev.add(new Mesh(elevR, tailMat), new Mesh(mirrorZ(elevR), tailMat));
  elev.userData.part = 'tail';
  root.add(elev);

  const F = L.fin;
  const finEdges = (h) => {
    const s = h / F.height;
    const te = F.leX - F.chord;
    if (S.tail === 'round') {
      const c = F.chord * Math.max(0.15, (1 - s * s) ** 0.55);
      return [te + c, te];
    }
    return [F.leX - 0.075 * s, te];
  };
  const hsFin = Array.from({ length: 11 }, (_, i) => (F.height * i) / 10);
  const finMap = (x, h, d) => new Vector3(x, F.baseY + h, d);
  const finGeo = plate(hsFin, (h) => {
    const [le, te] = finEdges(h);
    return [le, Math.max(te, F.hingeX)];
  }, finMap, 0.003);
  const finMesh = new Mesh(finGeo, tailMat);
  finMesh.userData.part = 'tail';
  root.add(finMesh);
  const rudder = new Group();
  rudder.position.set(F.hingeX, 0, 0);
  const rudGeo = plate(hsFin, (h) => {
    const [, te] = finEdges(h);
    const xa = F.hingeX - 0.002;
    return [xa, Math.min(te, xa)];
  }, finMap, 0.003);
  rudGeo.translate(-F.hingeX, 0, 0);
  rudder.add(new Mesh(rudGeo, tailMat));
  rudder.userData.part = 'tail';
  root.add(rudder);

  // --- Landing gear: wire legs, bush wheels, rudder-linked tail wheel -----------
  const W = L.wheel;
  const fusBottomAtGear = high ? -0.06 : -0.065;
  const tyreMat = new MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.95 });
  const mainGear = [];
  for (const s of [-1, 1]) {
    // Wire legs (front and rear) from the fuselage to the axle. They are
    // re-aimed every frame as the springy wire flexes.
    const front = new Vector3(0.1, fusBottomAtGear, s * 0.03);
    const rear = new Vector3(0.03, fusBottomAtGear, s * 0.03);
    const legF = cylinderBetween(front, new Vector3(W.x, W.y, s * W.z), 0.0016, metal);
    const legR = cylinderBetween(rear, new Vector3(W.x, W.y, s * W.z), 0.0016, metal);
    legF.userData.part = legR.userData.part = s > 0 ? 'wheelR' : 'wheelL';
    root.add(legF, legR);
    // 100 mm foam wheel: fat tyre, small hub.
    const wheel = new Group();
    wheel.position.set(W.x, W.y, s * W.z);
    const tube = W.radius * 0.36;
    const tyre = new Mesh(new TorusGeometry(W.radius - tube, tube, 10, 28), tyreMat);
    const hub = new Mesh(new CylinderGeometry(W.radius * 0.45, W.radius * 0.45, tube * 1.6, 16), metal);
    hub.rotation.x = Math.PI / 2;
    const spoke = new Mesh(new CylinderGeometry(0.003, 0.003, (W.radius - tube) * 2, 6), tyreMat);
    wheel.add(tyre, hub, spoke);
    wheel.userData.part = s > 0 ? 'wheelR' : 'wheelL';
    root.add(wheel);
    mainGear.push({ side: s, front, rear, legF, legR, wheel, axle: new Vector3() });
  }
  const TW = L.tailWheel;
  const tailWheel = new Group();
  tailWheel.position.set(TW.x, 0, 0);
  const tw = new Mesh(new TorusGeometry(TW.radius * 0.65, TW.radius * 0.35, 6, 12), new MeshStandardMaterial({ color: '#2a2a2a' }));
  tw.position.set(0, TW.y, 0);
  tailWheel.add(tw, cylinderBetween(new Vector3(0.012, -0.005, 0), new Vector3(0, TW.y, 0), 0.0012, metal));
  tailWheel.userData.part = 'tail';
  root.add(tailWheel);

  // --- Motor, spinner, propeller ----------------------------------------------
  const P = L.prop;
  const motor = new Mesh(new CylinderGeometry(0.014, 0.014, 0.022, 16), metal);
  motor.rotation.z = Math.PI / 2;
  motor.position.set(0.212, P.y, 0);
  root.add(motor);
  const prop = new Group();
  prop.position.set(P.x, P.y, 0);
  const spinner = new Mesh(new ConeGeometry(0.011, 0.022, 16), new MeshStandardMaterial({ color: '#d0d0d0', metalness: 0.5, roughness: 0.3 }));
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 0.011;
  const blades = new Group();
  const bladeMat = new MeshStandardMaterial({ color: '#1e1e1e', roughness: 0.5 });
  // One blade along +y with the twist of the prop's pitch, copied round the hub.
  const nBlades = P.blades || 2;
  const pitchM = (P.pitchIn || 4) * 0.0254;
  const rings2 = [];
  for (let i = 0; i <= 6; i++) {
    const r = 0.01 + ((P.radius - 0.01) * i) / 6;
    const c = 0.02 * (1 - 0.5 * ((r - 0.045) / 0.06) ** 2) + 0.003;
    const twist = Math.atan(pitchM / (2 * Math.PI * Math.max(r, 0.02)));
    const ring = [];
    for (let j = 0; j < 8; j++) {
      const th = (j / 8) * Math.PI * 2;
      const a = Math.cos(th) * c * 0.5;
      const b = Math.sin(th) * 0.0018;
      ring.push(new Vector3(b * Math.cos(twist) + a * Math.sin(twist), r, a * Math.cos(twist) - b * Math.sin(twist)));
    }
    rings2.push(ring);
  }
  const bladeGeo = loft(rings2);
  for (let k = 0; k < nBlades; k++) {
    const blade = new Mesh(bladeGeo, bladeMat);
    blade.rotation.x = (k * 2 * Math.PI) / nBlades;
    blades.add(blade);
  }
  const disc = new Mesh(new CircleGeometry(P.radius, 40), new MeshStandardMaterial({ map: propDiscTexture(), transparent: true, depthWrite: false, side: DoubleSide }));
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;
  prop.add(spinner, blades, disc);
  prop.userData.part = 'prop';
  root.add(prop);

  shadowAll(root);
  let propAngle = 0;
  const tmpQ = new Quaternion();

  // Breakable parts (see src/view/debris.js), collected from the tags above.
  const parts = {};
  for (const o of root.children) {
    const p = o.userData.part;
    if (p) (parts[p] ||= []).push(o);
  }

  return {
    root,
    parts,
    setPilotVisible(v) {
      pilot.visible = v;
    },
    update(aircraft, dt) {
      const sAil = aircraft.surfaces.find((s) => s.name.startsWith('wing-R') && s.controls.length);
      const ailDefl = sAil ? sAil.deflection : 0; // right aileron, TE down positive
      for (const a of ailerons) {
        // Positive rotation about the outboard hinge axis moves the TE down.
        tmpQ.setFromAxisAngle(a.axis, ailDefl);
        a.pivot.quaternion.copy(tmpQ);
      }
      const stab = aircraft.surfaces.find((s) => s.name === 'stab-R');
      elev.rotation.z = stab ? stab.deflection : 0;
      const fin = aircraft.surfaces.find((s) => s.name === 'fin');
      rudder.rotation.y = fin ? -fin.deflection : 0;
      // Springy gear: lift each wheel by its spring compression, re-aim the
      // wire legs, and roll the wheels along the ground.
      const fwdSpeed = aircraft.velocity.clone().applyQuaternion(aircraft.orientation.clone().invert()).x;
      for (const g of mainGear) {
        if (g.wheel.userData.broken) continue; // fallen off
        const c = aircraft.contacts.find((k) => k.name === (g.side > 0 ? 'wheel-R' : 'wheel-L'));
        const lift = Math.min(c?.depth ?? 0, 0.05);
        g.axle.set(W.x, W.y + lift, g.side * W.z);
        g.wheel.position.copy(g.axle);
        aimCylinder(g.legF, g.front, g.axle);
        aimCylinder(g.legR, g.rear, g.axle);
        if (c?.onGround) g.wheel.rotation.z -= (fwdSpeed * dt) / W.radius;
      }
      // Tail wheel follows the rudder servo.
      const tailC = aircraft.contacts.find((c) => c.steer);
      tailWheel.rotation.y = tailC ? aircraft.servo.yaw * tailC.steer : 0;

      const rpm = aircraft.rpm;
      const fast = rpm > 1200;
      blades.visible = !fast;
      disc.visible = fast;
      propAngle += (rpm / 60) * Math.PI * 2 * dt;
      prop.rotation.x = aircraft.propBroken ? 0.4 : propAngle;
    },
  };
}
