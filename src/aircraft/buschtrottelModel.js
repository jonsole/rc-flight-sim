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

function cylinderBetween(a, b, radius, material, segments = 6) {
  const dir = new Vector3().subVectors(b, a);
  const m = new Mesh(new CylinderGeometry(radius, radius, dir.length(), segments), material);
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
  const pts = [[0, tf * 0.45], [0.008, tf * 0.1], [0.03, 0], [f1, 0], [f1, f1 > st ? tr : tf]];
  if (f1 > st) pts.push([st, tr], [st, tf]);
  pts.push([0.05, tf], [0.012, tf * 0.85]);
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
  let ringPaint = [];
  const rings = L.fuselage.map(([x, hw, yb, yt]) => {
    let pts;
    if (C.split) {
      const at = yb + C.split * (yt - yb);
      pts = [
        [hw, yb, 0], [hw, at, 0], [hw, at, 1], [hw, yt, 1],
        [-hw, yt, 1], [-hw, at, 1], [-hw, at, 0], [-hw, yb, 0],
      ];
    } else {
      const s1 = yb + 0.42 * (yt - yb);
      const s2 = yb + 0.58 * (yt - yb);
      pts = [
        [hw, yb, 0], [hw, s1, 0], [hw, s1, 1], [hw, s2, 1], [hw, s2, 0], [hw, yt, 0],
        [-hw, yt, 0], [-hw, s2, 0], [-hw, s2, 1], [-hw, s1, 1], [-hw, s1, 0], [-hw, yb, 0],
      ];
    }
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
      w.position.set(-0.03, 0.046, s * 0.0405);
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
    // Low wing: glass-enclosed cockpit on top of the fuselage.
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
    // Angular Air Tractor-style cab: flat glass panels in a painted frame.
    // Stations along x: windscreen foot, windscreen top, roof end, rear foot.
    const H = 0.055;
    const xs = [0.03, -0.035, -0.15, -0.25];
    const hs = [0.002, H, H, 0.002];
    const corner = (i, side, top) => {
      const { hw, yt } = fusAt(xs[i]);
      const base = hw * 0.97;
      const roof = hw * 0.72;
      const z = side * (top ? base + (roof - base) * (hs[i] / H) : base);
      return new Vector3(xs[i], yt + 0.001 + (top ? hs[i] : 0), z);
    };
    // Each ring: base right, roof right, roof left, base left.
    const cabRings = xs.map((_, i) => [corner(i, 1, false), corner(i, 1, true), corner(i, -1, true), corner(i, -1, false)]);
    const cab = new Mesh(
      loft(cabRings),
      new MeshStandardMaterial({ color: '#a9cbe0', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide, flatShading: true }),
    );
    cab.userData.noShadow = true;
    root.add(cab);
    // Frame: pillars and roof rails along every panel edge, plus a door post
    // and a windscreen centre bar.
    const frameMat = new MeshStandardMaterial({ color: C.top || C.main, roughness: 0.8 });
    const bar = (p, q) => root.add(cylinderBetween(p, q, 0.0016, frameMat));
    for (const side of [1, -1]) {
      const sideIdx = side > 0 ? [0, 1] : [3, 2]; // [base, roof] ring indices
      for (let i = 0; i < xs.length - 1; i++) {
        bar(cabRings[i][sideIdx[1]], cabRings[i + 1][sideIdx[1]]); // roof rail / sloped edges
      }
      for (const i of [1, 2]) bar(cabRings[i][sideIdx[0]], cabRings[i][sideIdx[1]]); // pillars
      // Door post between the windscreen pillar and the rear pillar.
      const t = 0.45;
      const pb = cabRings[1][sideIdx[0]].clone().lerp(cabRings[2][sideIdx[0]], t);
      const pt = cabRings[1][sideIdx[1]].clone().lerp(cabRings[2][sideIdx[1]], t);
      bar(pb, pt);
    }
    bar(cabRings[1][1], cabRings[1][2]); // windscreen header
    bar(cabRings[2][1], cabRings[2][2]); // rear roof edge
    const wsFoot = cabRings[0][0].clone().lerp(cabRings[0][3], 0.5);
    const wsTop = cabRings[1][1].clone().lerp(cabRings[1][2], 0.5);
    bar(wsFoot, wsTop); // windscreen centre bar
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
    const slatGeo = loft(rs, { color: (_p, _ri, pi) => (pi < 2 ? wingBottom : wingTop) });
    wingR.add(new Mesh(slatGeo, vcMat));
    wingL.add(new Mesh(mirrorZ(slatGeo), vcMat));
  }
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
        root.add(cylinderBetween(base, top, 0.0025, strutMat));
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
        root.add(cylinderBetween(base, top, 0.0025, strutMat));
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
  root.add(new Mesh(stabR, tailMat), new Mesh(mirrorZ(stabR), tailMat));
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
  root.add(new Mesh(finGeo, tailMat));
  const rudder = new Group();
  rudder.position.set(F.hingeX, 0, 0);
  const rudGeo = plate(hsFin, (h) => {
    const [, te] = finEdges(h);
    const xa = F.hingeX - 0.002;
    return [xa, Math.min(te, xa)];
  }, finMap, 0.003);
  rudGeo.translate(-F.hingeX, 0, 0);
  rudder.add(new Mesh(rudGeo, tailMat));
  root.add(rudder);

  // --- Landing gear: wire legs, bush wheels, rudder-linked tail wheel -----------
  const W = L.wheel;
  const fusBottomAtGear = high ? -0.06 : -0.065;
  for (const s of [-1, 1]) {
    const axle = new Vector3(W.x, W.y, s * (W.z - 0.012));
    root.add(cylinderBetween(new Vector3(0.1, fusBottomAtGear, s * 0.03), axle, 0.0016, metal));
    root.add(cylinderBetween(new Vector3(0.03, fusBottomAtGear, s * 0.03), axle, 0.0016, metal));
    const tyre = new Mesh(new TorusGeometry(W.radius - 0.011, 0.011, 8, 20), new MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.95 }));
    tyre.position.set(W.x, W.y, s * W.z);
    root.add(tyre);
    const hub = new Mesh(new CylinderGeometry(W.radius - 0.012, W.radius - 0.012, 0.012, 16), metal);
    hub.rotation.x = Math.PI / 2;
    hub.position.copy(tyre.position);
    root.add(hub);
  }
  const TW = L.tailWheel;
  const tailWheel = new Group();
  tailWheel.position.set(TW.x, 0, 0);
  const tw = new Mesh(new TorusGeometry(TW.radius * 0.65, TW.radius * 0.35, 6, 12), new MeshStandardMaterial({ color: '#2a2a2a' }));
  tw.position.set(0, TW.y, 0);
  tailWheel.add(tw, cylinderBetween(new Vector3(0.012, -0.005, 0), new Vector3(0, TW.y, 0), 0.0012, metal));
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
  for (const s of [-1, 1]) {
    const rings2 = [];
    for (let i = 0; i <= 6; i++) {
      const r = 0.01 + ((P.radius - 0.01) * i) / 6;
      const c = 0.02 * (1 - 0.5 * ((r - 0.045) / 0.06) ** 2) + 0.003;
      const twist = Math.atan(0.1016 / (2 * Math.PI * Math.max(r, 0.02)));
      const ring = [];
      for (let j = 0; j < 8; j++) {
        const th = (j / 8) * Math.PI * 2;
        const a = Math.cos(th) * c * 0.5;
        const b = Math.sin(th) * 0.0018;
        ring.push(new Vector3(b * Math.cos(twist) + a * Math.sin(twist), s * r, s * (a * Math.cos(twist) - b * Math.sin(twist))));
      }
      rings2.push(ring);
    }
    blades.add(new Mesh(loft(rings2), bladeMat));
  }
  const disc = new Mesh(new CircleGeometry(P.radius, 40), new MeshStandardMaterial({ map: propDiscTexture(), transparent: true, depthWrite: false, side: DoubleSide }));
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;
  prop.add(spinner, blades, disc);
  root.add(prop);

  shadowAll(root);
  let propAngle = 0;
  const tmpQ = new Quaternion();

  return {
    root,
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
