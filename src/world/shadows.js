// Scenery shadows: one big shadow map over the flying area for the trees,
// bushes, buildings, cars and gazebo. They never move, so the map is only
// redrawn when the sun does (time of day), not every frame. The built-in
// soft filter gives naturally soft edges. Aeroplanes are left out of it:
// their shadows are drawn separately (src/view/planeShadow.js), every
// frame, blurred by their height above the ground.

const AREA = 700; // m either side of the field centre
const CENTRE = { x: 0, z: -40 };

export class Shadows {
  /**
   * @param {import('three').DirectionalLight} light  the sun (or moon) light
   * @param {{ mapSize?: number }} opts
   */
  constructor(light, { mapSize = 4096 } = {}) {
    this.light = light;
    light.castShadow = true;
    light.shadow.mapSize.set(mapSize, mapSize);
    Object.assign(light.shadow.camera, { left: -AREA, right: AREA, top: AREA, bottom: -AREA, near: 100, far: 2600 });
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.bias = -0.00005;
    light.shadow.normalBias = 0.25;
    light.shadow.autoUpdate = false;
    this.dirty = true;
  }

  /** Point the light along `towards` (unit vector to the sun/moon). */
  setDirection(towards) {
    const l = this.light;
    l.target.position.set(CENTRE.x, 0, CENTRE.z);
    l.position.copy(towards).multiplyScalar(1500).add(l.target.position);
    l.target.updateMatrixWorld();
    l.updateMatrixWorld();
    this.dirty = true;
  }

  /** Redraw the shadow map on the next frame if the sun has moved. */
  update() {
    if (this.dirty) {
      this.light.shadow.needsUpdate = true;
      this.dirty = false;
    }
  }
}
