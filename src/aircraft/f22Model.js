// Procedural 3D model of the FT Mighty Mini F-22: flat 5 mm foam board, in
// body axes (+x forward, +y up, +z right, metres, origin at the CG). The
// outlines come from f22.js, so the model and the flight model agree.

import { Group, Mesh, MeshStandardMaterial, Vector3, CylinderGeometry, Shape, ExtrudeGeometry } from 'three';
import { loft } from './geom.js';
import { createProp } from './prop.js';

const T = 0.005; // foam board thickness

const foam = (color) => new MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, flatShading: true });

/** Flat plate from an outline [[a, b]...] in the x-y plane, `t` thick, centred on z = 0. */
function slab(pts, t = T) {
  const shape = new Shape(pts.map(([a, b]) => ({ x: a, y: b })));
  const g = new ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -t / 2);
  return g;
}

/** Plate from a plan-view outline [[x, z]...], lying flat (thickness along y). */
function flatSlab(pts) {
  // Shape in (x, -z), then rotate the extrusion axis (z) up to y.
  const g = slab(pts.map(([x, z]) => [x, -z]));
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Rounded-box ring for the fuselage loft: half-width hw, from yb up to yt. */
function boxRing(x, hw, yb, yt, rMax = 0.006) {
  const r = Math.min(rMax, hw * 0.6, (yt - yb) * 0.4);
  const pts = [];
  const arc = (cz, cy, a0) => {
    for (let i = 0; i <= 2; i++) {
      const a = ((a0 + 45 * i) * Math.PI) / 180;
      pts.push(new Vector3(x, cy + r * Math.sin(a), cz + r * Math.cos(a)));
    }
  };
  arc(hw - r, yt - r, 0);
  arc(-hw + r, yt - r, 90);
  arc(-hw + r, yb + r, 180);
  arc(hw - r, yb + r, 270);
  return pts;
}

export function createF22Model(G) {
  const C = G.colors;
  const root = new Group();
  root.name = 'FT Mini F-22';
  const mainMat = foam(C.main);
  const darkMat = foam(C.dark);
  const metal = new MeshStandardMaterial({ color: '#9a9c9e', roughness: 0.4, metalness: 0.6 });
  const wingTop = G.wingY + T / 2;

  // --- Wing: one flat sheet in two halves (each can break off) ---------------
  const mirror = (pts) => pts.map(([x, z]) => [x, -z]);
  const wingR = new Mesh(flatSlab(G.wing), mainMat);
  const wingL = new Mesh(flatSlab(mirror(G.wing)), mainMat);
  for (const w of [wingR, wingL]) w.position.y = G.wingY;
  wingR.userData.part = 'wingR';
  wingL.userData.part = 'wingL';
  root.add(wingR, wingL);

  // --- Elevons: all-moving, hinged on the wing's trailing edge ----------------
  const elevons = [-1, 1].map((side) => {
    const pts = (side > 0 ? G.elevon : mirror(G.elevon)).map(([x, z]) => [x - G.hingeX, z]);
    const pivot = new Group();
    pivot.position.set(G.hingeX - 0.001, G.wingY, 0);
    pivot.add(new Mesh(flatSlab(pts), darkMat));
    pivot.userData.part = 'tail';
    root.add(pivot);
    return { pivot, name: side > 0 ? 'stab-R' : 'stab-L' };
  });

  // --- Fins: canted out, tabs through the wing --------------------------------
  for (const side of [-1, 1]) {
    const fin = new Mesh(slab(G.fin), darkMat);
    fin.position.set(0, wingTop, side * G.finZ);
    fin.rotation.x = side * G.cant;
    fin.userData.part = 'tail';
    root.add(fin);
  }

  // --- Fuselage: a 40 mm box, deep nose through the wing, low box behind -------
  const F = G.fuselage;
  const floor = wingTop - F.wingStep;
  // Folded foam: full width right to the sharp tip, crisp corners.
  const box = new Mesh(loft(F.stations.map(([x, b, t], i) => boxRing(x, F.halfWidth, floor + b, floor + t + (i === 0 ? 0.0008 : 0), 0.0015))), foam(C.box));
  root.add(box);
  const topAt = (x) => {
    const st = F.stations;
    for (let i = 0; i < st.length - 1; i++) {
      if (x <= st[i][0] && x >= st[i + 1][0]) return floor + st[i][2] + ((st[i + 1][2] - st[i][2]) * (st[i][0] - x)) / (st[i][0] - st[i + 1][0]);
    }
    return floor + st[st.length - 1][2];
  };

  // Canopy (parts 03 and 04): a full-width hump on top of the nose box.
  const canopyMat = new MeshStandardMaterial({ color: C.canopy, roughness: 0.15, metalness: 0.5, flatShading: true });
  const canopyRings = G.canopy.profile.map(([d, h]) => {
    const x = G.canopy.front - d;
    const base = topAt(x) - 0.0005;
    return boxRing(x, F.halfWidth + 0.0005, base, base + Math.max(h, 0.0003), 0.004);
  });
  const canopy = new Mesh(loft(canopyRings), canopyMat);
  canopy.userData.part = 'canopy';
  root.add(canopy);

  // --- Underneath: side plates down to the belly pan (the intakes) -----------
  const U = G.underbody;
  const under = G.wingY - T / 2; // underside of the wing
  const bottom = under - U.depth;
  for (const side of [-1, 1]) {
    for (let i = 0; i < U.plate.length - 1; i++) {
      const [ax, az] = U.plate[i];
      const [bx, bz] = U.plate[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      // Plate segment in its own (along, up) plane; the front end is cut back
      // at the bottom.
      const cut = i === 0 ? 0.016 : 0;
      const seg = new Mesh(slab([[0, 0], [-len, 0], [-len, -U.depth], [-cut, -U.depth]]), darkMat);
      seg.position.set(ax, under, side * az);
      seg.rotation.y = Math.atan2(-(side * (bz - az)), bx - ax) + Math.PI;
      root.add(seg);
    }
  }
  // Belly pan: between the plates, from their front ends back 159 mm.
  const plateZ = (x) => {
    for (let i = 0; i < U.plate.length - 1; i++) {
      const [ax, az] = U.plate[i];
      const [bx, bz] = U.plate[i + 1];
      if (x <= ax && x >= bx) return az + ((bz - az) * (ax - x)) / (ax - bx);
    }
    return U.plate[U.plate.length - 1][1];
  };
  const panXs = [U.plate[0][0] - 0.016, U.plate[1][0], U.panEnd].filter((x, i, a) => i === 0 || x < a[0]).sort((a, b) => b - a);
  const panRight = panXs.map((x) => [x, plateZ(x) - T / 2]);
  const pan = new Mesh(flatSlab([...panRight, ...panRight.slice().reverse().map(([x, z]) => [x, -z])]), darkMat);
  pan.position.y = bottom + T / 2;
  root.add(pan);

  // --- Power pod: motor at the back of the box, pusher prop in the slot --------
  const P = G.prop;
  const motor = new Mesh(new CylinderGeometry(0.012, 0.012, 0.02, 16), metal);
  motor.rotation.z = Math.PI / 2;
  motor.position.set(P.x + 0.017, P.y, 0);
  root.add(motor);
  const propeller = createProp(P, { spinner: 0.008 });
  // Spinner and blades face aft: turn the prop round to push.
  const propMount = new Group();
  propMount.position.set(P.x, P.y, 0);
  propMount.rotation.y = Math.PI;
  propMount.add(propeller.group);
  propMount.userData.part = 'prop';
  root.add(propMount);

  root.traverse((m) => m.isMesh && (m.castShadow = true));

  const parts = {};
  for (const o of root.children) {
    const p = o.userData.part;
    if (p) (parts[p] ||= []).push(o);
  }

  return {
    root,
    parts,
    // The cockpit camera sits under the canopy.
    setPilotVisible(v) {
      canopy.visible = v;
    },
    update(aircraft, dt) {
      for (const e of elevons) {
        const s = aircraft.surfaces.find((k) => k.name === e.name);
        // TE down positive, from the reflex the elevons are trimmed to.
        e.pivot.rotation.z = (s ? s.deflection : 0) - G.reflex;
      }
      propeller.update(aircraft.rpm, dt, aircraft.propBroken);
    },
  };
}
