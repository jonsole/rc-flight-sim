// Propeller for the procedural models: twisted blades for low rpm and a
// blurred disc once it spins up. Spins about the group's x axis.
import { Group, Mesh, MeshStandardMaterial, Vector3, ConeGeometry, CircleGeometry, CanvasTexture, DoubleSide, SRGBColorSpace } from 'three';
import { loft } from './geom.js';

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

/**
 * @param {{ radius:number, blades?:number, pitchIn?:number }} P
 * @param {object} [opts]  spinner: radius of the spinner cone (0 for none)
 * @returns {{ group: Group, update(rpm:number, dt:number, broken:boolean): void }}
 */
export function createProp(P, { spinner = 0.011 } = {}) {
  const group = new Group();
  if (spinner) {
    const cone = new Mesh(new ConeGeometry(spinner, spinner * 2, 16), new MeshStandardMaterial({ color: '#d0d0d0', metalness: 0.5, roughness: 0.3 }));
    cone.rotation.z = -Math.PI / 2;
    cone.position.x = spinner;
    group.add(cone);
  }
  const blades = new Group();
  const bladeMat = new MeshStandardMaterial({ color: '#1e1e1e', roughness: 0.5 });
  // One blade along +y with the twist of the prop's pitch, copied round the hub.
  const nBlades = P.blades || 2;
  const pitchM = (P.pitchIn || 4) * 0.0254;
  const scale = P.radius / 0.1016; // chord shape drawn for an 8" prop
  const rings = [];
  for (let i = 0; i <= 6; i++) {
    const r = 0.01 * scale + ((P.radius - 0.01 * scale) * i) / 6;
    const rr = r / scale;
    const c = (0.02 * (1 - 0.5 * ((rr - 0.045) / 0.06) ** 2) + 0.003) * scale;
    const twist = Math.atan(pitchM / (2 * Math.PI * Math.max(r, 0.02)));
    const ring = [];
    for (let j = 0; j < 8; j++) {
      const th = (j / 8) * Math.PI * 2;
      const a = Math.cos(th) * c * 0.5;
      const b = Math.sin(th) * 0.0018;
      ring.push(new Vector3(b * Math.cos(twist) + a * Math.sin(twist), r, a * Math.cos(twist) - b * Math.sin(twist)));
    }
    rings.push(ring);
  }
  const bladeGeo = loft(rings);
  for (let k = 0; k < nBlades; k++) {
    const blade = new Mesh(bladeGeo, bladeMat);
    blade.rotation.x = (k * 2 * Math.PI) / nBlades;
    blades.add(blade);
  }
  const disc = new Mesh(new CircleGeometry(P.radius, 40), new MeshStandardMaterial({ map: propDiscTexture(), transparent: true, depthWrite: false, side: DoubleSide }));
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;
  group.add(blades, disc);

  let angle = 0;
  return {
    group,
    update(rpm, dt, broken) {
      const fast = rpm > 1200;
      blades.visible = !fast;
      disc.visible = fast;
      angle += (rpm / 60) * Math.PI * 2 * dt;
      group.rotation.x = broken ? 0.4 : angle;
    },
  };
}
