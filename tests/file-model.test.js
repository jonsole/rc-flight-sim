// 3D models from files (src/aircraft/fileModel.js): the named parts move the
// right way however they're turned in the file.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { createFileModel, nameIs } from '../src/aircraft/fileModel.js';

/** A control surface: hinge at `hinge`, its panel behind (aft of) it, the node's X along `axis` either way round. */
function surface(name, hinge, axis, panel) {
  const node = new Group();
  node.name = name;
  node.position.copy(hinge);
  node.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), axis.clone().normalize());
  const mesh = new Mesh(new BoxGeometry(...panel.size), new MeshStandardMaterial());
  // Panel centre in the node's frame.
  mesh.position.copy(panel.offset).applyQuaternion(node.quaternion.clone().invert());
  mesh.quaternion.copy(node.quaternion.clone().invert());
  node.add(mesh);
  return node;
}

function centreOf(model, name) {
  let n = null;
  model.root.traverse((o) => !n && nameIs(o.name, name) && (n = o));
  model.root.updateMatrixWorld(true);
  return n.children[0].getWorldPosition(new Vector3());
}

const aircraftWith = (defl) => ({
  surfaces: [
    { name: 'wing-R', pos: new Vector3(0, 0, 0.3), controls: [{ input: 'roll' }], deflection: defl.roll },
    { name: 'wing-L', pos: new Vector3(0, 0, -0.3), controls: [{ input: 'roll' }], deflection: -defl.roll },
    { name: 'stab-R', pos: new Vector3(-0.6, 0, 0.1), controls: [{ input: 'pitch' }], deflection: defl.pitch },
    { name: 'fin', pos: new Vector3(-0.6, 0.1, 0), controls: [{ input: 'yaw' }], deflection: defl.yaw },
  ],
  rpm: 0,
  velocity: new Vector3(),
  orientation: new Quaternion(),
  contacts: [],
  servo: { yaw: 0 },
});

describe('3D model files', () => {
  it('names: Blender and three.js endings are the same part', () => {
    for (const n of ['aileron_R', 'aileron_R.001', 'aileron_R001', 'aileron_R_1']) expect(nameIs(n, 'aileron_R')).toBe(true);
    for (const n of ['aileron_L', 'aileron_Rx', 'my_aileron_R']) expect(nameIs(n, 'aileron_R')).toBe(false);
  });

  for (const flip of [1, -1]) {
    it(`positive deflection: aileron and elevator trailing edges down, rudder to the left (hinge axis ${flip > 0 ? 'outboard' : 'inboard'})`, () => {
      const scene = new Group();
      const panel = { size: [0.04, 0.005, 0.2], offset: new Vector3(-0.02, 0, 0) };
      scene.add(surface('aileron_R.001', new Vector3(-0.05, 0, 0.35), new Vector3(0.1, 0, flip), panel));
      scene.add(surface('aileron_L', new Vector3(-0.05, 0, -0.35), new Vector3(0.1, 0, -flip), panel));
      scene.add(surface('elevator', new Vector3(-0.6, 0, 0), new Vector3(0, 0, flip), panel));
      scene.add(surface('rudder', new Vector3(-0.6, 0.05, 0), new Vector3(0, flip, 0), { size: [0.04, 0.1, 0.005], offset: new Vector3(-0.02, 0, 0) }));
      const m = createFileModel(scene);
      m.update(aircraftWith({ roll: 0, pitch: 0, yaw: 0 }), 0);
      const rest = Object.fromEntries(['aileron_R', 'aileron_L', 'elevator', 'rudder'].map((k) => [k, centreOf(m, k)]));
      m.update(aircraftWith({ roll: 0.3, pitch: 0.3, yaw: 0.3 }), 0);
      expect(centreOf(m, 'aileron_R').y).toBeLessThan(rest.aileron_R.y - 0.004); // right TE down
      expect(centreOf(m, 'aileron_L').y).toBeGreaterThan(rest.aileron_L.y + 0.004); // left TE up
      expect(centreOf(m, 'elevator').y).toBeLessThan(rest.elevator.y - 0.004);
      expect(centreOf(m, 'rudder').z).toBeLessThan(rest.rudder.z - 0.004);
    });
  }

  it('groups what breaks off, and hides the pilot in the cockpit view', () => {
    const scene = new Group();
    for (const n of ['wing_R', 'wing_L', 'tail', 'gear_R', 'canopy', 'prop', 'pilot']) {
      const g = new Group();
      g.name = n;
      scene.add(g);
    }
    const m = createFileModel(scene);
    expect(Object.keys(m.parts).sort()).toEqual(['canopy', 'prop', 'tail', 'wheelR', 'wingL', 'wingR']);
    m.setPilotVisible(false);
    let pilot = null;
    m.root.traverse((o) => o.name === 'pilot' && (pilot = o));
    expect(pilot.visible).toBe(false);
  });

  it('each aircraft file names a model file that is there', () => {
    const dir = new URL('../src/aircraft/models/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      if (j.model) expect(existsSync(new URL(j.model, dir)), `${f}: ${j.model}`).toBe(true);
    }
  });
});
