// The camera rig (src/view/cameras.js).
import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { CameraRig } from '../src/view/cameras.js';
import { DEFAULT_SETTINGS } from '../src/ui/settings.js';
import { getAircraft } from '../src/aircraft/index.js';
import { heightAt } from '../src/sim/terrain.js';

describe('camera rig', () => {
  it('never goes under the ground: a wreck on its back, seen from the cockpit or chasing it', () => {
    const entry = getAircraft('eflite-se5a-900');
    for (const mode of ['fpv', 'los', 'chase']) {
      const rig = new CameraRig({ ...DEFAULT_SETTINGS });
      rig.setAircraft(entry);
      rig.setMode(mode);
      const g = heightAt(10, -40);
      // On its back, just off the grass, nose down a little.
      const wreck = {
        position: new Vector3(10, g + 0.08, -40),
        orientation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3)),
        velocity: new Vector3(),
        throttleActual: 0,
        held: null,
      };
      for (let i = 0; i < 60; i++) rig.update(wreck, 1 / 60);
      const p = rig.camera.position;
      expect(p.y).toBeGreaterThanOrEqual(heightAt(p.x, p.z) + 0.14);
    }
  });

  it('lets a model held in your hand come close without cutting it off', () => {
    const rig = new CameraRig({ ...DEFAULT_SETTINGS });
    rig.setAircraft(getAircraft('multiplex-easystar'));
    const eye = rig.pilotEye();
    const held = { position: eye.clone().add(new Vector3(0.9, -0.1, 0.35)), orientation: new Quaternion(), velocity: new Vector3(), throttleActual: 0, held: {} };
    rig.update(held, 1 / 60);
    expect(rig.camera.near).toBeLessThan(0.2);
    // Flying away: back to the far-reaching setting.
    const away = { ...held, held: null, position: eye.clone().add(new Vector3(60, 20, 0)) };
    rig.update(away, 1 / 60);
    expect(rig.camera.near).toBe(0.5);
  });
});
