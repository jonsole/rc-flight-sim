// Procedural 3D model of the AeroScout trainer, in body axes (+x forward,
// +y up, +z right, metres, origin at the CG). The layout object comes from
// aeroscout.js, so the model and the flight model always agree.
//
// Painted foam: a smooth (not faceted) finish, a plain club trainer scheme
// set by the JSON file's "colors".

import {
  Group, Mesh, MeshStandardMaterial, Vector3, Color, CylinderGeometry, BufferGeometry,
  SphereGeometry, TorusGeometry, BoxGeometry, DoubleSide, Shape, ExtrudeGeometry,
  Quaternion,
} from 'three';
import { loft, mirrorZ, airfoilRing, naca } from './geom.js';
import { createProp, shownRpm } from './prop.js';

const paint = (color) => new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0 });

function cylinderBetween(a, b, radius, material, segments = 8) {
  const dir = new Vector3().subVectors(b, a);
  const m = new Mesh(new CylinderGeometry(radius, radius, dir.length(), segments), material);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** Flat plate from an outline [[x, y]...], `t` thick, centred on z = 0. */
function slab(pts, t) {
  const shape = new Shape(pts.map(([x, y]) => ({ x, y })));
  const g = new ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -t / 2);
  return g;
}

/** Clip polygon `pts` to the convex polygon `win` ([[x, y]...], either winding). */
function clipPoly(pts, win) {
  let out = pts;
  let area = 0;
  for (let i = 0; i < win.length; i++) {
    const [x0, y0] = win[i];
    const [x1, y1] = win[(i + 1) % win.length];
    area += x0 * y1 - x1 * y0;
  }
  const sgn = Math.sign(area) || 1;
  for (let i = 0; i < win.length && out.length; i++) {
    const a = win[i];
    const b = win[(i + 1) % win.length];
    const side = (p) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k];
      const q = out[(k + 1) % out.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
  }
  return out;
}

/** Rounded-rectangle cross-section ring at station x. */
function ring(x, hw, yb, yt, rIn, n = 4) {
  const r = Math.min(rIn, hw * 0.98, (yt - yb) * 0.49);
  const pts = [];
  const corner = (cz, cy, a0) => {
    for (let i = 0; i <= n; i++) {
      const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
      pts.push(new Vector3(x, cy + r * Math.sin(a), cz + r * Math.cos(a)));
    }
  };
  corner(hw - r, yt - r, 0); // top right
  corner(-hw + r, yt - r, 90); // top left
  corner(-hw + r, yb + r, 180); // bottom left
  corner(hw - r, yb + r, 270); // bottom right
  return pts;
}

/** Fuselage size at x, interpolated between the layout's stations. */
function fusAt(L, x) {
  const st = L.fuselage;
  if (x >= st[0][0]) return st[0];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i];
    const b = st[i + 1];
    if (x <= a[0] && x >= b[0]) {
      const t = (a[0] - x) / (a[0] - b[0]);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return st[st.length - 1];
}

export function createAeroScoutModel(L, colors = {}) {
  // main: foam; accent and dark: the stripes; canopy; hub; optional nose and
  // tip colours (default: main).
  const C = { main: '#eeeeec', accent: '#e2552b', dark: '#3a3e44', canopy: '#141618', hub: '#8c9198', panel: '#66788a', ...colors };
  const root = new Group();
  root.name = 'AeroScout';
  const mainMat = paint(C.main);
  const vcMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const dark = new MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.8 });
  const metal = new MeshStandardMaterial({ color: '#a4a6a8', roughness: 0.35, metalness: 0.7 });
  // Painted-on canopy: opaque, glossy.
  const glass = new MeshStandardMaterial({ color: C.canopy, roughness: 0.25, metalness: 0.2, side: DoubleSide });
  // Stripes, laid just over the surface (see fileModel.js: "decal" materials).
  const decal = (color, name) => {
    const m = new MeshStandardMaterial({ color, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: DoubleSide });
    m.name = name;
    return m;
  };
  const accentDecal = decal(C.accent, 'decal_accent');
  const darkDecal = decal(C.dark, 'decal_dark');
  const panelDecal = decal(C.panel, 'decal_panel');
  const parts = {};
  const tag = (o, part) => {
    o.userData.part = part;
    (parts[part] ||= []).push(o);
    return o;
  };

  // --- Fuselage: rounded pod into a slim boom --------------------------------
  // Paint: main colour, with the trim colour on the nose.
  const cMain = new Color(C.main);
  const cTrim = new Color(C.nose || C.main);
  const xs = [];
  const st = L.fuselage;
  for (let i = 0; i < st.length - 1; i++) {
    const n = i < 2 ? 2 : 3;
    for (let k = 0; k < n; k++) xs.push(st[i][0] + ((st[i + 1][0] - st[i][0]) * k) / n);
  }
  xs.push(st[st.length - 1][0]);
  // The nose paint ends on a line: the ring there twice, one of each colour.
  const NOSE_X = 0.215;
  const iNose = xs.findIndex((x) => x < NOSE_X);
  xs.splice(iNose, 0, NOSE_X, NOSE_X);
  const rings = xs.map((x) => {
    const [, hw, yb, yt, r] = fusAt(L, x);
    return ring(x, hw, yb, yt, r);
  });
  const fus = new Mesh(
    loft(rings, {
      color: (_p, ri) => {
        return ri <= iNose ? cTrim : cMain; // painted nose
      },
    }),
    vcMat,
  );
  root.add(fus);

  // Points on the fuselage surface, for paint laid over it.
  /** z of the fuselage's side at station x and height y (rounded corners). */
  const sideZ = (x, y) => {
    const [, hw, yb, yt, rIn] = fusAt(L, x);
    const r = Math.min(rIn, hw * 0.98, (yt - yb) * 0.49);
    const dy = y > yt - r ? y - (yt - r) : y < yb + r ? yb + r - y : 0;
    return hw - r + Math.sqrt(Math.max(0, r * r - dy * dy));
  };
  /** A stripe on both sides: centre height (fraction of the local depth) and half-width (m) along x. */
  const stripe = (x0, x1, centre, halfW, mat, n = 40) => {
    for (const side of [-1, 1]) {
      const rs = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n;
        const f = i / n;
        const [, , yb, yt] = fusAt(L, x);
        const yc = yb + (yt - yb) * centre(f);
        const h = halfW(f);
        const lo = new Vector3(x, yc - h, side * (sideZ(x, yc - h) + 0.0008));
        const hi = new Vector3(x, yc + h, side * (sideZ(x, yc + h) + 0.0008));
        rs.push([lo, hi]);
      }
      const pos = [];
      for (let i = 0; i < n; i++) {
        const [a, b] = rs[i];
        const [c, d] = rs[i + 1];
        pos.push(a, c, b, b, c, d);
      }
      const g = new BufferGeometry().setFromPoints(pos);
      g.computeVertexNormals();
      root.add(new Mesh(g, mat));
    }
  };
  // A long pinstripe from under the cabin back along the boom, and a pair of
  // swept flashes on the cabin side, curving up towards the wing.
  const ease = (f) => f * f * (3 - 2 * f);
  stripe(0.2, -0.5, (f) => 0.26 + 0.2 * ease(Math.min(1, f * 1.6)), (f) => 0.0035 * (1 - 0.6 * f), accentDecal);
  stripe(0.16, -0.085, (f) => 0.42 + 0.3 * f * f, (f) => 0.006 * Math.sin(Math.PI * Math.min(1, 0.1 + f * 0.9)) + 0.001, accentDecal);
  stripe(0.11, -0.09, (f) => 0.6 + 0.22 * f * f, (f) => 0.0035 * Math.sin(Math.PI * Math.min(1, 0.1 + f * 0.9)) + 0.0008, darkDecal);

  // A thin pinstripe along the belly, from under the nose back under the cabin.
  {
    const pos = [];
    const n = 30;
    const at = (x, dz) => {
      const [, hw, yb, , rIn] = fusAt(L, x);
      const r = Math.min(rIn, hw * 0.98);
      // On the rounded bottom: the corner arc meets the flat bottom at |z| = hw - r.
      const z = Math.max(-(hw - 0.001), Math.min(hw - 0.001, dz));
      const flat = hw - r;
      const y = Math.abs(z) <= flat ? yb : yb + r - Math.sqrt(Math.max(0, r * r - (Math.abs(z) - flat) ** 2));
      return new Vector3(x, y - 0.0009, z);
    };
    for (let i = 0; i < n; i++) {
      const x0 = 0.27 - (0.27 + 0.06) * (i / n);
      const x1 = 0.27 - (0.27 + 0.06) * ((i + 1) / n);
      pos.push(at(x0, -0.0015), at(x0, 0.0015), at(x1, -0.0015), at(x0, 0.0015), at(x1, 0.0015), at(x1, -0.0015));
    }
    const g = new BufferGeometry().setFromPoints(pos);
    g.computeVertexNormals();
    root.add(new Mesh(g, accentDecal));
  }

  // Canopy: painted over the top and upper sides of the cabin, from the nose
  // back under the wing; its lower edge dips at the front of the cabin.
  {
    const xs = [];
    for (let i = 0; i <= 24; i++) xs.push(0.245 - (0.245 + 0.03) * (i / 24));
    const edge = (x) => {
      const f = (0.245 - x) / 0.275; // 0 at the front, 1 at the back
      return 0.62 - 0.22 * Math.sin(Math.PI * Math.min(1, f * 1.3)) + 0.25 * Math.max(0, f - 0.8) / 0.2;
    };
    const m = 14; // points around each half
    const rings = xs.map((x) => {
      const [, hw, yb, yt] = fusAt(L, x);
      const yTop = Math.min(yt, L.wingY - 0.001);
      const y0 = yb + (yt - yb) * Math.min(0.95, edge(x));
      const pts = [];
      // Right side up from the edge, over the top, down the left side.
      for (let k = 0; k <= m; k++) {
        const y = y0 + (yTop - y0) * (k / m);
        pts.push(new Vector3(x, y + 0.0009, sideZ(x, y) + 0.0009));
      }
      for (let k = m; k >= 0; k--) {
        const y = y0 + (yTop - y0) * (k / m);
        pts.push(new Vector3(x, y + 0.0009, -(sideZ(x, y) + 0.0009)));
      }
      void hw;
      return pts;
    });
    root.add(new Mesh(loft(rings, { caps: false }), glass));
  }
  // Pilot (hidden in the cockpit view).
  const pilot = new Group();
  const head = new Mesh(new SphereGeometry(0.016, 12, 8), new MeshStandardMaterial({ color: '#6b4a32', roughness: 0.7 }));
  head.position.set(0.04, 0.045, 0);
  pilot.add(head);
  root.add(pilot);

  // --- Wing: trainer section, dihedral, rounded tips -------------------------
  const ci = Math.cos(L.incidence);
  const si = Math.sin(L.incidence);
  const tOverC = L.thickness;
  /** Point on the wing: chord fraction f, section height yN (/chord), span z ≥ 0. */
  const wingPoint = (f, yN, z) => {
    const c = L.chordAt(z);
    const relx = -f * c;
    const y = yN * c;
    return new Vector3(
      L.leAt(z) + relx * ci - y * si,
      L.wingY + 0.004 + relx * si + y * ci + Math.tan(L.dihedral) * z,
      z,
    );
  };
  const section = (f0, f1) => airfoilRing(f0, f1, 10, tOverC, 0.04);
  const cWing = new Color(C.main);
  const cTip = new Color(C.tip || C.main);
  const wingPart = (z0, z1, f0, f1, n, tipFrom = Infinity) => {
    const sec = section(f0, f1);
    const rs = [];
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      rs.push(sec.map(([f, y]) => wingPoint(f, y, z)));
    }
    return loft(rs, { color: (p) => (p.z >= tipFrom - 1e-6 ? cTip : cWing) });
  };
  // Painted tips: the trim colour on the outer 120 mm.
  const tipFrom = L.half - 0.12;
  const wingR = new Group();
  wingR.add(new Mesh(wingPart(0, L.panelBreak, 0, 1, 2), vcMat));
  wingR.add(new Mesh(wingPart(L.panelBreak, L.ailFrom, 0, 1, 1), vcMat));
  // Aileron bay: the fixed part ahead of the hinge, the aileron behind.
  const a0 = L.ailFrom;
  const a1 = L.ailTo;
  // Split the fixed part at the paint line so the colour change is crisp.
  wingR.add(new Mesh(wingPart(a0, tipFrom, 0, L.hinge, 2), vcMat));
  wingR.add(new Mesh(wingPart(tipFrom, a1, 0, L.hinge, 1, tipFrom), vcMat));
  wingR.add(new Mesh(wingPart(a1, L.half, 0, 1, 1, tipFrom), vcMat));
  // Rounded tip cap: the section shrinking to the tip in a few steps.
  {
    const sec = section(0, 1);
    const rs = [];
    for (let i = 0; i <= 4; i++) {
      const k = Math.cos((i / 4) * (Math.PI / 2)); // 1 → 0
      const z = L.half + 0.025 * Math.sin((i / 4) * (Math.PI / 2));
      rs.push(sec.map(([f, y]) => {
        const p = wingPoint(0.5 + (f - 0.5) * (0.35 + 0.65 * k), y * (0.2 + 0.8 * k), L.half);
        p.z = z;
        p.y += Math.tan(L.dihedral) * (z - L.half);
        return p;
      }));
    }
    wingR.add(new Mesh(loft(rs, { color: () => cTip }), vcMat));
  }
  // Aileron, pivoting on its hinge line.
  const ailGeoParts = [
    wingPart(a0 + 0.002, tipFrom, L.hinge + 0.004, 1, 2),
    wingPart(tipFrom, a1 - 0.002, L.hinge + 0.004, 1, 1, tipFrom),
  ];
  const hA = wingPoint(L.hinge, 0, a0);
  const hB = wingPoint(L.hinge, 0, a1);
  const ailR = new Group();
  ailR.position.copy(hA);
  for (const g of ailGeoParts) {
    g.translate(-hA.x, -hA.y, -hA.z);
    ailR.add(new Mesh(g, vcMat));
  }
  const axisR = new Vector3().subVectors(hB, hA).normalize();
  const wingL = new Group();
  for (const m of wingR.children) wingL.add(new Mesh(mirrorZ(m.geometry), vcMat));
  const ailL = new Group();
  ailL.position.set(hA.x, hA.y, -hA.z);
  for (const m of ailR.children) ailL.add(new Mesh(mirrorZ(m.geometry), vcMat));
  const axisL = new Vector3(axisR.x, axisR.y, -axisR.z);
  root.add(tag(wingR, 'wingR'), tag(wingL, 'wingL'), tag(ailR, 'wingR'), tag(ailL, 'wingL'));
  const ailerons = [
    { pivot: ailR, axis: axisR },
    { pivot: ailL, axis: axisL },
  ];

  // Wing bands: on each wing's top, an accent band along the front of the
  // wing out to the tip that curves back near the root to the trailing
  // edge, with a thinner dark band just behind and outboard of it.
  {
    const wingTop = (u, z) => {
      const c = L.chordAt(z);
      const f = Math.min(0.99, Math.max(0.01, u / c));
      return wingPoint(f, naca(f, tOverC, 0.04).upper + 0.0012 / c, z);
    };
    /**
     * Centreline in (u = metres aft of the leading edge, z): from the
     * trailing edge at zTe, slanting outboard and forward to a rounded corner
     * at (uSpan, zCorner), then spanwise at uSpan (as a fraction of the
     * local chord) out to the tip.
     */
    const path = (zTe, zCorner, uSpan, radius) => {
      const pts = [];
      const uTe = L.chordAt(zTe) - 0.004;
      const a = [uTe, zTe];
      const b = [uSpan + radius, zCorner];
      for (let i = 0; i <= 10; i++) pts.push([a[0] + (b[0] - a[0]) * (i / 10), a[1] + (b[1] - a[1]) * (i / 10)]);
      // Rounded corner: a quadratic curve through the corner.
      const p1 = [uSpan, zCorner];
      const p2 = [uSpan, zCorner + radius];
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        pts.push([0, 1].map((k) => (1 - t) ** 2 * b[k] + 2 * (1 - t) * t * p1[k] + t * t * p2[k]));
      }
      const fSpan = uSpan / L.chordAt(zCorner + radius);
      const zEnd = L.half - 0.004;
      for (let i = 1; i <= 16; i++) {
        const z = zCorner + radius + (zEnd - zCorner - radius) * (i / 16);
        pts.push([fSpan * L.chordAt(z), z]);
      }
      return pts;
    };
    const band = (pts, width, mat) => {
      const pos = [];
      const edges = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        const du = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(du, dz) || 1;
        const [nu, nz] = [-dz / len, du / len];
        return [wingTop(p[0] + nu * width / 2, p[1] + nz * width / 2), wingTop(p[0] - nu * width / 2, p[1] - nz * width / 2)];
      });
      for (let i = 0; i < edges.length - 1; i++) {
        const [a, b] = edges[i];
        const [c, d] = edges[i + 1];
        pos.push(a, c, b, b, c, d);
      }
      const g = new BufferGeometry().setFromPoints(pos);
      g.computeVertexNormals();
      wingR.add(new Mesh(g, mat));
      wingL.add(new Mesh(mirrorZ(g), mat));
    };
    band(path(0.07, 0.1, 0.03, 0.06), 0.022, accentDecal);
    band(path(0.105, 0.13, 0.058, 0.045), 0.011, darkDecal);

    // Underneath: two grey-blue panels under each wing (servo bays).
    const wingBottom = (f, z) => wingPoint(f, naca(f, tOverC, 0.04).lower - 0.0012 / L.chordAt(z), z);
    for (const [zc, w] of [[0.23, 0.075], [0.42, 0.075]]) {
      const rs = [];
      for (let i = 0; i <= 6; i++) {
        const f = 0.14 + 0.5 * (i / 6);
        rs.push([wingBottom(f, zc - w / 2), wingBottom(f, zc + w / 2)]);
      }
      const pos = [];
      for (let i = 0; i < 6; i++) {
        const [a, b] = rs[i];
        const [c, d] = rs[i + 1];
        pos.push(a, b, c, b, d, c);
      }
      const g = new BufferGeometry().setFromPoints(pos);
      g.computeVertexNormals();
      wingR.add(new Mesh(g, panelDecal));
      wingL.add(new Mesh(mirrorZ(g), panelDecal));
    }
  }

  // --- Motor pylon, motor and pusher prop ------------------------------------
  const P = L.prop;
  const pylon = new Mesh(new BoxGeometry(0.05, P.y - 0.04, 0.03), mainMat);
  pylon.position.set(P.x + 0.04, (P.y + 0.04) / 2 + 0.005, 0);
  root.add(pylon);
  const motor = new Mesh(new CylinderGeometry(0.0145, 0.0145, 0.026, 18), metal);
  motor.rotation.z = Math.PI / 2;
  motor.position.set(P.x + 0.018, P.y, 0);
  root.add(motor);
  const propeller = createProp(P, { spinner: 0.009 });
  const prop = propeller.group;
  // A pusher: turned round so the spinner points aft.
  const propHolder = new Group();
  propHolder.position.set(P.x, P.y, 0);
  propHolder.rotation.y = Math.PI;
  propHolder.add(prop);
  root.add(propHolder);
  parts.prop = [propHolder];
  propHolder.userData.part = 'prop';

  // --- Tail: flat foam plates ---------------------------------------------------
  const T = L.tail;
  const hingeX = T.leX - T.chord * T.hingeFrac;
  const hs = T.span / 2;
  // Stab outline (right half then left, [x, z]): straight LE with a slight
  // sweep, rounded tips.
  const stabOutline = [
    [T.leX, 0], [T.leX - 0.02, hs - 0.02], [T.leX - 0.035, hs], [T.leX - T.tipChord, hs], [T.leX - T.chord, hs - 0.015],
    [T.leX - T.chord, -(hs - 0.015)], [T.leX - T.tipChord, -hs], [T.leX - 0.035, -hs], [T.leX - 0.02, -(hs - 0.02)],
  ];
  const clipX = (pts, x0, keepAbove) => {
    const inside = (p) => (keepAbove ? p[0] >= x0 : p[0] <= x0);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const t = (x0 - a[0]) / (b[0] - a[0]);
        out.push([x0, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  const tailT = 0.005;
  const layFlat = (g) => {
    g.rotateX(Math.PI / 2); // (x, y, w) → (x, -w, y): the outline's y becomes z
    g.translate(-hingeX, 0, 0);
    g.rotateZ(T.incidence);
    g.translate(hingeX, T.y, 0);
    return g;
  };
  const stab = new Mesh(layFlat(slab(clipX(stabOutline, hingeX, true), tailT)), mainMat);
  root.add(tag(stab, 'tail'));
  // Stab bands: accent and dark along the front, curving back at the tips.
  for (const [mat, xc, w, zc] of [[accentDecal, T.leX - 0.014, 0.012, hs - 0.02], [darkDecal, T.leX - 0.032, 0.007, hs - 0.04]]) {
    const n = 24;
    const centre = [];
    for (let i = 0; i <= n; i++) {
      const z = -hs + ((2 * hs) * i) / n;
      const over = Math.max(0, Math.abs(z) - (zc - 0.05));
      centre.push([xc - (over * over) / 0.012, z]);
    }
    const pts = [...centre.map(([x, z]) => [x + w / 2, z]), ...centre.reverse().map(([x, z]) => [x - w / 2, z])];
    const piece = clipX(clipPoly(pts, stabOutline), hingeX, true);
    if (piece.length >= 3) {
      // On the top only: the underside of the tailplane is plain.
      const g = layFlat(slab(piece, 0.0006));
      g.translate(0, tailT / 2 + 0.0004, 0);
      root.add(tag(new Mesh(g, mat), 'tail'));
    }
  }
  const elev = new Group();
  elev.position.set(hingeX, T.y, 0);
  const elevGeo = layFlat(slab(clipX(stabOutline, hingeX - 0.002, false), tailT));
  elevGeo.translate(-hingeX, -T.y, 0);
  elev.add(new Mesh(elevGeo, mainMat));
  root.add(tag(elev, 'tail'));

  const F = L.fin;
  const finOutline = [
    [F.leX, F.y], [F.leX - 0.06, F.y + F.height * 0.75], [F.leX - F.rootChord + F.tipChord - 0.01, F.y + F.height],
    [F.leX - F.rootChord - 0.005, F.y + F.height], [F.leX - F.rootChord - 0.015, F.y + 0.01], [F.leX - F.rootChord, F.y],
  ];
  const finMesh = new Mesh(slab(clipX(finOutline, F.hingeX, true), tailT), mainMat);
  root.add(tag(finMesh, 'tail'));
  const rudder = new Group();
  rudder.position.set(F.hingeX, 0, 0);
  const rudGeo = slab(clipX(finOutline, F.hingeX - 0.002, false), tailT);
  rudGeo.translate(-F.hingeX, 0, 0);
  rudder.add(new Mesh(rudGeo, mainMat));
  root.add(tag(rudder, 'tail'));
  // Two curved bands across the upper fin and rudder: accent over dark,
  // rising towards the back. Split at the hinge so the rudder's part moves.
  for (const [mat, k0, k1] of [[accentDecal, 0.64, 0.76], [darkDecal, 0.52, 0.575]]) {
    const n = 10;
    const xa = F.leX + 0.01;
    const xb = F.leX - F.rootChord - 0.03;
    const yAt = (f, k) => F.y + F.height * (k + 0.14 * f * f);
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push([xa + (xb - xa) * (i / n), yAt(i / n, k0)]);
    for (let i = n; i >= 0; i--) pts.push([xa + (xb - xa) * (i / n), yAt(i / n, k1)]);
    const band = clipPoly(pts, finOutline);
    if (band.length < 3) continue;
    for (const [part, keep] of [[null, true], [rudder, false]]) {
      const piece = clipX(band, keep ? F.hingeX : F.hingeX - 0.002, keep);
      if (piece.length < 3) continue;
      const g = slab(piece, tailT + 0.0012);
      if (part) {
        g.translate(-F.hingeX, 0, 0);
        part.add(new Mesh(g, mat));
      } else {
        root.add(tag(new Mesh(g, mat), 'tail'));
      }
    }
  }

  // --- Tricycle gear ---------------------------------------------------------------
  const MW = L.mainWheel;
  const tyreMat = new MeshStandardMaterial({ color: '#232323', roughness: 0.95 });
  const hubMat = paint(C.hub);
  const makeWheel = (radius, width) => {
    const g = new Group();
    const tube = width / 2;
    g.add(new Mesh(new TorusGeometry(radius - tube, tube, 10, 24), tyreMat));
    const hub = new Mesh(new CylinderGeometry(radius * 0.5, radius * 0.5, width * 1.05, 16), hubMat);
    hub.rotation.x = Math.PI / 2;
    g.add(hub);
    return g;
  };
  const mainWheels = [];
  for (const s of [-1, 1]) {
    const [, hw, yb] = fusAt(L, MW.x + 0.01);
    const top = new Vector3(MW.x + 0.01, yb + 0.004, s * hw * 0.6);
    const axle = new Vector3(MW.x, MW.y, s * (MW.z - 0.012));
    const leg = cylinderBetween(top, axle, 0.0018, metal);
    const stub = cylinderBetween(axle, new Vector3(MW.x, MW.y, s * MW.z), 0.0018, metal);
    const part = s > 0 ? 'wheelR' : 'wheelL';
    root.add(tag(leg, part), tag(stub, part));
    const wheel = makeWheel(MW.radius, 0.018);
    wheel.position.set(MW.x, MW.y, s * MW.z);
    root.add(tag(wheel, part));
    mainWheels.push({ side: s, wheel });
  }
  // Nose leg: steers with the rudder about a vertical pivot at the firewall.
  const NW = L.noseWheel;
  const noseLeg = new Group();
  noseLeg.position.set(NW.x, 0, 0);
  const [, , ybNose] = fusAt(L, NW.x);
  noseLeg.add(cylinderBetween(new Vector3(0, ybNose + 0.01, 0), new Vector3(0, NW.y + 0.012, 0), 0.0018, metal));
  noseLeg.add(cylinderBetween(new Vector3(0, NW.y + 0.012, 0.0), new Vector3(0, NW.y + 0.012, 0.012), 0.0018, metal));
  noseLeg.add(cylinderBetween(new Vector3(0, NW.y + 0.012, 0.012), new Vector3(0, NW.y, 0.012), 0.0018, metal));
  const nWheel = makeWheel(NW.radius, 0.014);
  nWheel.position.set(0, NW.y, 0);
  noseLeg.add(nWheel);
  root.add(noseLeg);

  root.traverse((m) => m.isMesh && (m.castShadow = true));
  const tmpQ = new Quaternion();

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
        tmpQ.setFromAxisAngle(a.axis, ailDefl);
        a.pivot.quaternion.copy(tmpQ);
      }
      const stabR = aircraft.surfaces.find((s) => s.name === 'stab-R');
      elev.rotation.z = stabR ? stabR.deflection : 0;
      const fin = aircraft.surfaces.find((s) => s.name === 'fin');
      rudder.rotation.y = fin ? -fin.deflection : 0;
      // Main wheels roll along the ground and ride up as the legs give.
      const fwdSpeed = aircraft.velocity.clone().applyQuaternion(aircraft.orientation.clone().invert()).x;
      for (const g of mainWheels) {
        if (g.wheel.userData.broken) continue;
        const c = aircraft.contacts.find((k) => k.name === (g.side > 0 ? 'wheel-R' : 'wheel-L'));
        g.wheel.position.y = MW.y + Math.min(c?.depth ?? 0, 0.03);
        if (c?.onGround) g.wheel.rotation.z -= (fwdSpeed * dt) / MW.radius;
      }
      // Nose wheel follows the rudder servo.
      const nose = aircraft.contacts.find((c) => c.steer);
      noseLeg.rotation.y = nose ? aircraft.servo.yaw * nose.steer : 0;
      propeller.update(shownRpm(aircraft), dt, aircraft.propBroken);
    },
  };
}
