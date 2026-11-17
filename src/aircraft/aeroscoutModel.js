// Procedural 3D model of the AeroScout trainer, in body axes (+x forward,
// +y up, +z right, metres, origin at the CG). The layout object comes from
// aeroscout.js, so the model and the flight model always agree.
//
// Painted foam: a smooth (not faceted) finish, a plain club trainer scheme
// set by the JSON file's "colors".

import {
  Group, Mesh, MeshStandardMaterial, Vector3, Color, CylinderGeometry,
  SphereGeometry, TorusGeometry, BoxGeometry, DoubleSide, Shape, ExtrudeGeometry,
  Quaternion,
} from 'three';
import { loft, mirrorZ, airfoilRing } from './geom.js';
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
  const C = { main: '#f4f4f0', trim: '#d8322a', second: '#1f3f8f', canopy: '#1d2a36', ...colors };
  const root = new Group();
  root.name = 'AeroScout';
  const mainMat = paint(C.main);
  const trimMat = paint(C.trim);
  const secondMat = paint(C.second);
  const vcMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const dark = new MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.8 });
  const metal = new MeshStandardMaterial({ color: '#a4a6a8', roughness: 0.35, metalness: 0.7 });
  const glass = new MeshStandardMaterial({ color: C.canopy, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85, side: DoubleSide });
  const parts = {};
  const tag = (o, part) => {
    o.userData.part = part;
    (parts[part] ||= []).push(o);
    return o;
  };

  // --- Fuselage: rounded pod into a slim boom --------------------------------
  // Paint: main colour, with the trim colour on the nose.
  const cMain = new Color(C.main);
  const cTrim = new Color(C.trim);
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

  // Cabin windows: a windscreen sloping up to the wing and side windows.
  {
    const ws = [0.16, 0.13, 0.1, 0.085];
    const scr = ws.map((x) => {
      const [, hw, , yt] = fusAt(L, x);
      const top = Math.min(L.wingY - 0.002, yt + 0.0015);
      return [new Vector3(x, top - 0.012, hw * 0.75), new Vector3(x, top + 0.0015, hw * 0.55), new Vector3(x, top + 0.0015, -hw * 0.55), new Vector3(x, top - 0.012, -hw * 0.75)];
    });
    // Windscreen: a curved panel just over the top of the nose.
    const screen = new Mesh(loft(scr.map((r) => r.map((p) => p.clone())), { caps: false }), glass);
    root.add(screen);
    for (const s of [-1, 1]) {
      const [, hw] = fusAt(L, 0.02);
      const g = slab([[0.105, 0.03], [0.075, 0.068], [-0.06, 0.068], [-0.075, 0.03]], 0.002);
      const w = new Mesh(g, glass);
      w.position.z = s * (hw + 0.0005);
      root.add(w);
    }
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
  const cTip = new Color(C.trim);
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

  // --- Motor pylon, motor and pusher prop ------------------------------------
  const P = L.prop;
  const pylon = new Mesh(new BoxGeometry(0.05, P.y - 0.04, 0.03), secondMat);
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
  const elev = new Group();
  elev.position.set(hingeX, T.y, 0);
  const elevGeo = layFlat(slab(clipX(stabOutline, hingeX - 0.002, false), tailT));
  elevGeo.translate(-hingeX, -T.y, 0);
  elev.add(new Mesh(elevGeo, trimMat));
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
  rudder.add(new Mesh(rudGeo, trimMat));
  root.add(tag(rudder, 'tail'));
  // A stripe of the second colour across the top of the fin.
  {
    const band = slab([[F.leX - 0.08, F.y + F.height * 0.62], [F.leX - 0.095, F.y + F.height * 0.8], [F.hingeX + 0.001, F.y + F.height * 0.8], [F.hingeX + 0.001, F.y + F.height * 0.62]], tailT + 0.0008);
    const m = new Mesh(band, secondMat);
    root.add(tag(m, 'tail'));
  }

  // --- Tricycle gear ---------------------------------------------------------------
  const MW = L.mainWheel;
  const tyreMat = new MeshStandardMaterial({ color: '#232323', roughness: 0.95 });
  const hubMat = paint(C.second);
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
