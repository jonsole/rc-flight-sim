// Night-flying LEDs, like the ones RC pilots fit for flying in the dark:
// red on the left wingtip, green on the right, white on the tail, and a
// double-flash white strobe on the wingtips. They glow at a fixed size on
// screen so the aeroplane stays visible far out, and fade in at dusk.
import { Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending, Vector3 } from 'three';

let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new CanvasTexture(c);
  return glowTex;
}

/** Extreme points of a model (its own axes): wingtips and tail. */
function extremes(root) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const v = new Vector3();
  const minZ = new Vector3(0, 0, Infinity);
  const maxZ = new Vector3(0, 0, -Infinity);
  const minX = new Vector3(Infinity, 0, 0);
  root.traverseVisible((o) => {
    const pos = o.isMesh && o.geometry?.attributes?.position;
    if (!pos) return;
    const m = o.matrixWorld.clone().premultiply(inv);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.z < minZ.z) minZ.copy(v);
      if (v.z > maxZ.z) maxZ.copy(v);
      if (v.x < minX.x) minX.copy(v);
    }
  });
  return { left: minZ, right: maxZ, tail: minX };
}

function led(color, px) {
  const s = new Sprite(new SpriteMaterial({ map: glow(), color, blending: AdditiveBlending, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false }));
  s.userData.px = px;
  s.renderOrder = 6;
  return s;
}

/**
 * Add LEDs to a model. Call update(night 0..1, seconds, camera, viewportHeight)
 * every frame.
 */
export function addNavLights(model) {
  const root = model.root;
  const e = extremes(root);
  // Lights hang off the model's root so they move with it.
  const holder = root;
  const L = led('#ff2a1a', 9);
  const R = led('#1aff4a', 9);
  const T = led('#ffffff', 7);
  const SL = led('#ffffff', 14);
  const SR = led('#ffffff', 14);
  const nudge = 0.01;
  L.position.copy(e.left).add(new Vector3(0, 0, -nudge));
  R.position.copy(e.right).add(new Vector3(0, 0, nudge));
  T.position.copy(e.tail).add(new Vector3(-nudge, 0, 0));
  SL.position.copy(L.position);
  SR.position.copy(R.position);
  const all = [L, R, T, SL, SR];
  for (const s of all) {
    s.userData.navLight = true;
    holder.add(s);
  }
  // A wingtip or tail that broke off takes its light with it.
  const partOf = new Map([[L, 'wingL'], [SL, 'wingL'], [R, 'wingR'], [SR, 'wingR'], [T, 'tail']]);
  return {
    lights: all,
    update(night, t, camera, viewH, broken) {
      const on = night > 0.05;
      const k = (2 * 1) / (viewH * camera.projectionMatrix.elements[5]); // scale per screen pixel
      // Double flash about once a second.
      const ph = t % 1.1;
      const strobe = ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0;
      for (const s of all) {
        s.visible = on && (s !== SL && s !== SR ? true : strobe > 0) && !broken?.has(partOf.get(s));
        if (!s.visible) continue;
        s.material.opacity = Math.min(1, night * 1.3);
        const px = s.userData.px * (0.6 + 0.4 * night);
        s.scale.setScalar(px * k);
      }
    },
  };
}
