// 3D models from files (glTF .glb, e.g. made or edited in Blender), named
// so the game can find the parts that move. See "3D models" in README.md.
//
// Nodes, found by name anywhere in the file (Blender's ".001" endings are fine):
//   aileron_R, aileron_L, elevon_R, elevon_L, elevator, rudder
//                  control surfaces: the origin on the hinge line and the
//                  local X axis along it (either way: the game works out
//                  which way is trailing edge down)
//   wheel_R, wheel_L   roll about their local X axis on the ground
//   tailwheel          steers with the rudder about its local X axis
//   prop               an empty on the prop shaft: the propeller as set in the
//                      Tuning tab is drawn there, spinning about the empty's X
//   pilot              hidden in the cockpit (FPV) view
//   wing_R, wing_L, tail, gear_R, gear_L, canopy
//                      what breaks off in a crash (everything inside them goes)
// Materials named decal… (markings laid just over a surface) are drawn in
// front of what they sit on, so they don't flicker.
// Axes: x forward (nose), y up, z out along the right wing; in Blender, whose
// Z is up: nose towards +X, right wing towards -Y. Metres.
import { Box3, Group, Matrix4, Quaternion, Vector3 } from 'three';

const CONTROLS = ['aileron_R', 'aileron_L', 'elevon_R', 'elevon_L', 'elevator', 'rudder'];
const PARTS = { wing_R: 'wingR', wing_L: 'wingL', tail: 'tail', gear_R: 'wheelR', gear_L: 'wheelL', canopy: 'canopy', prop: 'prop' };

/** Does a node's name stand for `key`? "aileron_R", "aileron_R.001", "aileron_R001" and "aileron_R_1" all do. */
export function nameIs(name, key) {
  return new RegExp(`^${key}(?:[._]?\\d+)?$`).test(name || '');
}

function findAll(root, key) {
  const out = [];
  root.traverse((o) => nameIs(o.name, key) && out.push(o));
  return out;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _box = new Box3();

/** A node's local X axis and origin in `root`'s frame. */
function axisIn(root, node) {
  root.updateMatrixWorld(true);
  _m.copy(root.matrixWorld).invert().multiply(node.matrixWorld);
  const origin = new Vector3().setFromMatrixPosition(_m);
  const axis = new Vector3(1, 0, 0).transformDirection(_m);
  return { origin, axis };
}

/** Middle of a node's meshes in `root`'s frame. */
function centreIn(root, node) {
  root.updateMatrixWorld(true);
  _box.makeEmpty();
  node.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    _m.copy(root.matrixWorld).invert().multiply(o.matrixWorld);
    _box.union(o.geometry.boundingBox.clone().applyMatrix4(_m));
  });
  return _box.isEmpty() ? null : _box.getCenter(new Vector3());
}

/**
 * Which way a positive turn about a control's local X moves its trailing edge:
 * +1 when it moves it the way the flight model's positive deflection does
 * (down for ailerons, elevons and elevators; towards -z, left, for a rudder).
 */
export function controlSign(root, node, kind) {
  const { origin, axis } = axisIn(root, node);
  const c = centreIn(root, node);
  if (!c) return 1;
  const move = new Vector3().crossVectors(axis, c.sub(origin)); // velocity of the middle for +1 rad/s
  return (kind === 'rudder' ? move.z : move.y) < 0 ? 1 : -1;
}

/** The flight-model surface that drives a control (by its inputs and side). */
function surfaceFor(surfaces, kind) {
  const has = (s, input) => s.controls?.some((c) => c.input === input);
  const z = (s) => (s.pos?.z ?? s.pos?.[2] ?? 0);
  if (kind === 'rudder') return surfaces.find((s) => has(s, 'yaw'));
  if (kind === 'elevator') return surfaces.find((s) => has(s, 'pitch') && !has(s, 'roll') && z(s) >= 0) || surfaces.find((s) => has(s, 'pitch') && !has(s, 'roll'));
  const right = kind.endsWith('_R');
  return surfaces.find((s) => has(s, 'roll') && (right ? z(s) > 0 : z(s) < 0));
}

const isBroken = (o) => {
  for (let p = o; p; p = p.parent) if (p.userData.broken) return true;
  return false;
};

/**
 * A playable model from a loaded file's scene.
 * @param {import('three').Object3D} scene  the file's scene (cloned here)
 * @param {object} [o]
 * @param {{ parts?: object, update?: Function }} [o.propFrom]  a built-in model
 *   whose propeller (sized as tuned) is drawn at the file's `prop` empty
 * @returns {{ root, parts, setPilotVisible(v), update(aircraft, dt) }}
 */
export function createFileModel(scene, { propFrom = null } = {}) {
  const root = new Group();
  const model = scene.clone(true);
  root.add(model);
  root.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    for (const m of [o.material].flat()) {
      if (/^decal/i.test(m?.name || '') && !m.polygonOffset) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -4;
        m.needsUpdate = true;
      }
    }
  });

  // Control surfaces, each turned about its own X axis from where it's drawn.
  const controls = [];
  for (const kind of CONTROLS) {
    for (const node of findAll(model, kind)) {
      controls.push({ kind, node, base: node.quaternion.clone(), sign: controlSign(root, node, kind) });
    }
  }
  // Wheels: roll forwards on the ground, and ride up as the tyre squashes.
  const wheels = [];
  for (const [key, contact] of [['wheel_R', 'wheel-R'], ['wheel_L', 'wheel-L']]) {
    for (const node of findAll(model, key)) {
      const { axis } = axisIn(root, node);
      // Bottom of the wheel goes backwards (-x) when rolling forwards.
      const sign = new Vector3().crossVectors(axis, new Vector3(0, -1, 0)).x < 0 ? 1 : -1;
      // Root "up" in the wheel's parent frame, to lift it.
      node.parent.updateMatrixWorld(true);
      _m.copy(node.parent.matrixWorld).invert().multiply(root.matrixWorld);
      const up = new Vector3(0, 1, 0).transformDirection(_m);
      const size = centreIn(root, node) ? _box.getSize(new Vector3()) : new Vector3(0.1, 0.1, 0.1);
      const radius = Math.max(0.01, Math.max(size.x, size.y) / 2);
      wheels.push({ node, contact, sign, up, radius, base: node.position.clone(), angle: 0, rest: node.quaternion.clone() });
    }
  }
  const tailwheels = findAll(model, 'tailwheel').map((node) => {
    const { axis } = axisIn(root, node);
    return { node, base: node.quaternion.clone(), sign: axis.y >= 0 ? 1 : -1 };
  });
  const pilots = findAll(model, 'pilot');

  // Breakable parts.
  const parts = {};
  for (const [key, id] of Object.entries(PARTS)) {
    const nodes = findAll(model, key);
    if (nodes.length) parts[id] = nodes;
  }

  // The propeller: borrowed from the built-in model, so it is the prop set
  // in the Tuning tab and spins as before.
  const propNode = findAll(model, 'prop')[0];
  const borrowed = propFrom?.parts?.prop?.[0];
  if (propNode && borrowed) {
    borrowed.removeFromParent();
    borrowed.position.set(0, 0, 0);
    borrowed.quaternion.identity();
    borrowed.scale.set(1, 1, 1);
    borrowed.traverse((o) => o.isMesh && (o.castShadow = true));
    propNode.add(borrowed);
  }

  const fwd = new Vector3();
  const inv = new Quaternion();
  return {
    root,
    parts,
    setPilotVisible(v) {
      for (const p of pilots) p.visible = v;
    },
    update(aircraft, dt) {
      const surfaces = aircraft.surfaces || [];
      for (const c of controls) {
        const s = surfaceFor(surfaces, c.kind);
        let d = s ? s.deflection : 0;
        if (!s && c.kind.endsWith('_L')) d = -(surfaceFor(surfaces, c.kind.replace('_L', '_R'))?.deflection || 0);
        _q.setFromAxisAngle(_v.set(1, 0, 0), c.sign * d);
        c.node.quaternion.copy(c.base).multiply(_q);
      }
      if (wheels.length) {
        fwd.copy(aircraft.velocity).applyQuaternion(inv.copy(aircraft.orientation).invert());
        for (const w of wheels) {
          if (isBroken(w.node)) continue;
          const k = aircraft.contacts?.find((c) => c.name === w.contact);
          const lift = Math.min(k?.depth ?? 0, 0.05);
          w.node.position.copy(w.base).addScaledVector(w.up, lift);
          if (k?.onGround) w.angle += (w.sign * fwd.x * dt) / w.radius;
          _q.setFromAxisAngle(_v.set(1, 0, 0), w.angle);
          w.node.quaternion.copy(w.rest).multiply(_q);
        }
      }
      const tailC = aircraft.contacts?.find((c) => c.steer);
      for (const t of tailwheels) {
        const a = tailC ? (aircraft.servo?.yaw || 0) * tailC.steer : 0;
        _q.setFromAxisAngle(_v.set(1, 0, 0), t.sign * a);
        t.node.quaternion.copy(t.base).multiply(_q);
      }
      // The built-in model spins its prop (and nothing else of it is shown).
      propFrom?.update?.(aircraft, dt);
    },
  };
}
