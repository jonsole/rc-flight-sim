// Buildings at a real site, drawn as one mesh: walls round each footprint,
// and a flat roof or (small four-cornered ones) a pitched roof with gable
// ends. Shapes and heights come from src/sim/buildings.js, the same ones the
// collisions use.
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshLambertMaterial, ShapeUtils, Vector2, Color, DoubleSide } from 'three';

const WALLS = {
  house: ['#9c5f45', '#a87457', '#b9a58a', '#8f5240', '#c9c0ae'],
  other: ['#b8b4aa', '#a9aaa6', '#c4bda9', '#8d9091'],
};
const ROOFS = {
  pitched: ['#4b3a33', '#5a3b30', '#3f4246', '#6b4a3a'],
  flat: ['#6d6d6a', '#7c7b76', '#5d5f60', '#8a8a86'],
};

/** @param {ReturnType<import('../sim/buildings.js').prepareBuilding>[]} buildings */
export function buildingsMesh(buildings) {
  const pos = [];
  const col = [];
  const c = new Color();
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const tri = (a, b, d, colour) => {
    pos.push(...a, ...b, ...d);
    for (let i = 0; i < 3; i++) col.push(colour.r, colour.g, colour.b);
  };
  const quad = (a, b, d, e, colour) => {
    tri(a, b, d, colour);
    tri(a, d, e, colour);
  };
  const wallCol = new Color();
  const roofCol = new Color();
  for (const b of buildings) {
    const house = /house|residential|terrace|detached|semi|bungalow|garage/.test(b.kind) || (b.gable && b.kind === 'yes');
    wallCol.set(pick(house ? WALLS.house : WALLS.other)).multiplyScalar(0.92 + rnd() * 0.16);
    roofCol.set(pick(b.gable ? ROOFS.pitched : ROOFS.flat)).multiplyScalar(0.9 + rnd() * 0.2);
    const top = b.gable ? b.eave : b.ridge;
    const p = b.pts;
    // Walls.
    for (let i = 0; i < p.length; i++) {
      const [x0, z0] = p[i];
      const [x1, z1] = p[(i + 1) % p.length];
      // A little darker on alternate walls, so corners read.
      c.copy(wallCol).multiplyScalar(i % 2 ? 0.94 : 1);
      quad([x0, b.y0, z0], [x1, b.y0, z1], [x1, top, z1], [x0, top, z0], c);
    }
    if (b.gable) {
      // Start the ring on a long side: a-c long, c-d short.
      let [a, cc, d, e] = p;
      if (Math.hypot(cc[0] - a[0], cc[1] - a[1]) < Math.hypot(d[0] - cc[0], d[1] - cc[1])) [a, cc, d, e] = [cc, d, e, a];
      const mid = (u, v) => [(u[0] + v[0]) / 2, b.ridge, (u[1] + v[1]) / 2];
      const r1 = mid(cc, d);
      const r2 = mid(e, a);
      const at = (u) => [u[0], b.eave, u[1]];
      // Roof slopes, overhanging nothing (keeps it simple and exact).
      quad(at(a), at(cc), r1, r2, roofCol);
      c.copy(roofCol).multiplyScalar(0.85);
      quad(at(d), at(e), r2, r1, c);
      // Gable ends.
      tri(at(cc), at(d), r1, wallCol);
      tri(at(e), at(a), r2, wallCol);
    } else {
      const contour = p.map(([x, z]) => new Vector2(x, z));
      for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
        tri([p[i][0], top, p[i][1]], [p[j][0], top, p[j][1]], [p[k][0], top, p[k][1]], roofCol);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new Mesh(g, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
