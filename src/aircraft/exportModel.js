// Turns a built-in (code-drawn) 3D model into a file in the layout that
// fileModel.js reads: moving parts found and named, each turned so it moves
// about its own X axis, the breakable parts grouped, the prop left as an empty.
// Used by scripts/export-models.mjs (in a browser) to make the starting .glb
// files for editing in Blender.
import { Box3, Group, Quaternion, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const X = new Vector3(1, 0, 0);
const GROUPS = { wingR: 'wing_R', wingL: 'wing_L', tail: 'tail', wheelR: 'gear_R', wheelL: 'gear_L', canopy: 'canopy' };

/** A flight model at rest, in the shape the models' update() reads. */
function restAircraft(def) {
  return {
    surfaces: def.surfaces.map((s) => ({ ...s, pos: new Vector3(...[s.pos].flat()), deflection: 0 })),
    rpm: 0,
    propBroken: false,
    velocity: new Vector3(),
    orientation: new Quaternion(),
    contacts: [],
    servo: { roll: 0, pitch: 0, yaw: 0 },
  };
}

/** Deflections as the flight model makes them for these stick inputs. */
function deflect(ac, input) {
  for (const s of ac.surfaces) {
    let d = 0;
    for (const c of s.controls || []) d += (input[c.input] || 0) * c.gain * c.max;
    if (s.maxDeflection && Math.abs(d) > s.maxDeflection) d = Math.sign(d) * s.maxDeflection;
    s.deflection = d;
  }
}

/** Nodes that turn when `poke` changes the aircraft, with the axis they turn about (local frame). */
function movers(model, def, poke) {
  const nodes = [];
  model.root.traverse((o) => nodes.push(o));
  const rest = restAircraft(def);
  model.update(rest, 0);
  const before = nodes.map((o) => o.quaternion.clone());
  const pos = nodes.map((o) => o.position.clone());
  const ac = restAircraft(def);
  const dt = poke(ac) ?? 0;
  model.update(ac, dt);
  const out = [];
  nodes.forEach((o, i) => {
    const d = before[i].clone().invert().multiply(o.quaternion);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(d.w)));
    if (angle > 1e-4) {
      const axis = new Vector3(d.x, d.y, d.z).normalize();
      out.push({ node: o, axis });
    }
  });
  // Back to rest.
  nodes.forEach((o, i) => {
    o.quaternion.copy(before[i]);
    o.position.copy(pos[i]);
  });
  // Only the outermost turning node of each moving part.
  return out.filter((m) => !out.some((n) => n !== m && n.node !== m.node && isAncestor(n.node, m.node)));
}

function isAncestor(a, b) {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/** Turn a node so `axis` (in its frame) becomes its X axis, without moving what it holds. */
function alignX(node, axis) {
  const q = new Quaternion().setFromUnitVectors(X, axis.clone().normalize());
  const qi = q.clone().invert();
  node.quaternion.multiply(q);
  for (const c of node.children) {
    c.position.applyQuaternion(qi);
    c.quaternion.premultiply(qi);
  }
}

// Which side a part is on, by where its pieces are (its pivot may be on the centre line).
const side = (node) => (new Box3().setFromObject(node).getCenter(new Vector3()).z >= 0 ? 'R' : 'L');

/**
 * The built-in model of an aircraft entry, laid out for a file.
 * @returns {Group}
 */
export function fileLayout(entry) {
  const def = entry.def;
  const model = (entry.createBuiltinModel || entry.createModel)();
  const scene = new Group();
  scene.add(model.root);
  model.update(restAircraft(def), 0);
  scene.updateMatrixWorld(true);

  const roll = movers(model, def, (ac) => deflect(ac, { roll: 1 }));
  const pitch = movers(model, def, (ac) => deflect(ac, { pitch: 1 }));
  const yaw = movers(model, def, (ac) => {
    deflect(ac, { yaw: 1 });
  });
  const steer = movers(model, def, (ac) => {
    ac.servo.yaw = 1;
    ac.contacts = def.contacts.map((c) => ({ ...c, onGround: false, depth: 0 }));
  });
  const roll2 = movers(model, def, (ac) => {
    ac.velocity.set(5, 0, 0);
    ac.contacts = def.contacts.map((c) => ({ ...c, onGround: true, depth: 0 }));
    return 0.05;
  });
  const inSet = (set, n) => set.some((m) => m.node === n);
  const named = new Map();
  const name = (m, n) => {
    if (named.has(m.node)) return;
    named.set(m.node, { name: n, axis: m.axis });
  };
  for (const m of roll) name(m, `${inSet(pitch, m.node) ? 'elevon' : 'aileron'}_${side(m.node)}`);
  for (const m of pitch) name(m, 'elevator');
  for (const m of yaw) name(m, 'rudder');
  for (const m of steer) if (!inSet(yaw, m.node)) name(m, 'tailwheel');
  for (const m of roll2) if (!named.has(m.node)) name(m, `wheel_${side(m.node)}`);

  // Hidden in the cockpit view.
  const shown = new Set();
  scene.traverse((o) => o.visible && shown.add(o));
  model.setPilotVisible(false);
  const pilots = [];
  scene.traverse((o) => shown.has(o) && !o.visible && pilots.push(o));
  model.setPilotVisible(true);

  for (const [node, { name: n, axis }] of named) {
    node.name = n;
    alignX(node, axis);
  }
  for (const p of pilots) p.name = 'pilot';

  // The prop: an empty (the game draws the tuned prop there).
  const prop = model.parts?.prop?.[0];
  if (prop) {
    prop.clear();
    prop.name = 'prop';
    prop.rotation.x = 0;
  }

  // Breakable parts gathered into groups; the rest is the body.
  scene.updateMatrixWorld(true);
  const out = new Group();
  out.name = entry.id;
  const body = model.root;
  body.name = 'body';
  out.add(body);
  for (const [id, objs] of Object.entries(model.parts || {})) {
    if (id === 'prop') continue;
    const g = new Group();
    g.name = GROUPS[id] || id;
    out.add(g);
    for (const o of objs) g.attach(o);
  }
  if (prop) out.attach(prop);
  // Hidden pieces (prop disc and the like) aren't wanted in the file.
  const hidden = [];
  out.traverse((o) => !o.visible && !pilots.includes(o) && hidden.push(o));
  for (const h of hidden) h.removeFromParent();
  // Name anything still anonymous after its part, for Blender's outliner.
  let n = 0;
  out.traverse((o) => {
    if (!o.name) o.name = `${o.isMesh ? 'mesh' : o.isLine || o.isLineSegments ? 'wire' : 'group'}${++n}`;
  });
  return out;
}

/** The entry's built-in model as a .glb file (ArrayBuffer). */
export async function exportGlb(entry) {
  const layout = fileLayout(entry);
  layout.traverse((o) => {
    if (!o.isMesh) return;
    const mats = [o.material].flat();
    // glTF has no flat shading: give flat-shaded meshes their facets' normals.
    if (mats.some((m) => m?.flatShading)) {
      o.geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      o.geometry.computeVertexNormals();
    }
    // Markings drawn just over a surface: "decal" materials get the polygon
    // offset back when loaded (glTF can't store it).
    for (const m of mats) if (m?.polygonOffset && !/^decal/.test(m.name)) m.name = `decal_${m.name || m.color?.getHexString?.() || ''}`;
    // Vertex colours a material doesn't use would be switched on when loaded.
    if (o.geometry.attributes.color && !mats.some((m) => m?.vertexColors)) {
      o.geometry = o.geometry.clone();
      o.geometry.deleteAttribute('color');
    }
  });
  return new GLTFExporter().parseAsync(layout, { binary: true, onlyVisible: true });
}
