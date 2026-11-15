// Where you fly. The made-up club field is drawn from code; real sites come
// from a baked data file (tools/bake_location.py): LIDAR terrain, trees and
// buildings, and a ground colour map from OpenStreetMap.
//
// The site is picked before the simulation loads (src/boot.js) and stays for
// the session: switching reloads the page. Every module that lays out the
// world reads LOCATION when it is first used.
//
// Layout. World frame: pilot at the origin, +x east, -z north, metres.
// The club's own things are laid out in a "club frame" turned `angle` degrees
// (clockwise seen from above) about the pilot, so the runway runs along its x
// axis and the pilot faces its -z: runway, pilotPad, hut, container, gazebo,
// table, windsock and fence. Everything else is in the world frame.
//   angle               club frame turn from east, degrees (0: runway east-west)
//   runway, pilotPad    runway strip and gravel pad {x, z, length, width}; runway.style
//                       'mown' (striped grass) or 'cricket' (a rolled cricket pitch)
//   field               the flying field: { x0, x1, z0, z1 } rectangle, or { x, z, r } circle
//   mown                (optional) the short-cut areas on it, world frame:
//                       { oval: [x, z], rx, rz, p } rounded oval (p: 2 ellipse, lower more diamond,
//                       mown in rings), or { x0, x1, z0, z1 } rectangle (mown in stripes).
//                       club: true puts an oval in the club frame. Without a
//                       list the whole field is short grass.
//   trees               real sites: extra trees { at: [[x, z], ...], h, r } (grown since the survey)
//   flat                ground forced level to y = 0 here (rectangle), fading out over `fade` m
//   hut, container      club buildings (null for none)
//   gazebo, table, windsock, fence   (club frame; null for none)
//   cars                parked cars (world frame)
//   conifers            real sites: guess conifers from narrow crowns (false: all broadleaf)
//   treeBelts           real sites: tree lines grown since the LIDAR survey:
//                       { from, to, width, grow, minH, spacing } scales trees within
//                       width/2 of the line and fills gaps longer than `spacing`
//   fences              tall fences: { from: [x, z], to: [x, z], height }
//   bushBelts           real sites: lines of tall bushes: { from, to, width, minH, maxH }

const HOME = {
  id: 'home',
  name: 'Club field',
  summary: 'A made-up club field in rolling country.',
  layout: {
    runway: { x: 0, z: -22, length: 180, width: 18 },
    pilotPad: { x: 0, z: 0.5, length: 6, width: 4 },
    field: { x: 0, z: -40, r: 260 },
    hut: { x: -24, z: 26, w: 10, d: 6, wall: 2.8, ridge: 4.3 },
    container: { x: -11.5, z: 27, l: 6.06, w: 2.44, h: 2.59 },
    cars: [
      { x: -43, z: 29, color: '#b8202a' },
      { x: -39.5, z: 29.4, color: '#c9ccd0' },
      { x: -36, z: 28.8, color: '#284f8f' },
    ],
    gazebo: { x: 12, z: 12, size: 3, h: 2.5 },
    table: { x: 6, z: 3 },
    windsock: { x: -35, z: -42, height: 5 },
    fence: { z: 6, x0: -100, x1: 100 },
  },
};

const WATERBEACH = {
  id: 'waterbeach',
  name: 'Waterbeach',
  summary: 'The real field at Waterbeach, Cambridgeshire, from Environment Agency LIDAR and OpenStreetMap.',
  load: () => import('../locations/waterbeach.json'),
  layout: {
    // The cricket pitch in the middle of the field is the runway: 28 m,
    // heading about 101°/281°. You stand 10 m south of its middle, facing it.
    // No pits, tables, fence or windsock: just the field.
    angle: 11.19,
    runway: { x: 0, z: -10, length: 28.4, width: 3.05, style: 'cricket' },
    pilotPad: null,
    // The field: about 160 m east-west by 210 m north-south, long grass
    // except about 32 m round the pitch, and a mown rectangle south of it.
    field: { x0: -64.3, x1: 93.7, z0: -117.2, z1: 92.8 },
    flat: { x0: -64.3, x1: 93.7, z0: -117.2, z1: 92.8, fade: 40 },
    mown: [
      { oval: [0, -10], rx: 14.2 + 32, rz: 1.5 + 32, p: 1.7, club: true },
      { x0: -16.7, x1: 62.7, z0: 40.9, z1: 85.5 },
    ],
    hut: null,
    container: null,
    cars: [],
    gazebo: null,
    table: null,
    windsock: null,
    fence: null,
    // Young trees along the curved path west of the pitch, grown since the survey.
    trees: [{
      at: [[-21.2, -65.4], [-26.6, -58.3], [-31.6, -51.9], [-35.3, -45.7], [-39.9, -40.1], [-48.2, -32.6], [-56.1, -27.6]],
      h: 9, r: 3.2,
    }],
    // All deciduous round the field.
    conifers: false,
    // The east hedge's trees have grown a lot since the LIDAR (2022)...
    treeBelts: [{ from: [113.8, -155.5], to: [92.8, 174.5], width: 22, grow: 1.4, minH: 10, spacing: 7 }],
    // ...and there is a 3 m chain-link fence behind them.
    fences: [{ from: [118.8, -155.5], to: [97.8, 174.5], height: 3 }],
    // High bushes just behind the fence.
    bushBelts: [{ from: [122.8, -155.5], to: [101.8, 174.5], width: 5, minH: 3.5, maxH: 5 }],
  },
};

export const LOCATIONS = [HOME, WATERBEACH];

export const LOCATION = { ...HOME, data: null };

export function findLocation(id) {
  return LOCATIONS.find((l) => l.id === id) || HOME;
}

/** Make `id` (with its baked data, if any) the site for this session. */
export function setLocation(id, data = null) {
  Object.assign(LOCATION, findLocation(id), { data });
}

/** The club frame's turn (radians); world = club turned this much from +x towards +z. */
export function clubAngle() {
  return ((LOCATION.layout.angle ?? 0) * Math.PI) / 180;
}

/** Club-frame point to world [x, z]. */
export function clubToWorld(cx, cz) {
  const a = clubAngle();
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [cx * c - cz * s, cx * s + cz * c];
}

/** World point to club frame [x, z]. */
export function worldToClub(x, z) {
  const a = clubAngle();
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c + z * s, -x * s + z * c];
}

/** Is (x, z) on short-cut grass? */
export function inMown(x, z) {
  const m = LOCATION.layout.mown;
  if (!m) return inField(x, z);
  return m.some((a) => {
    if (!a.oval) return x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
    const [px, pz] = a.club ? worldToClub(x, z) : [x, z];
    return ovalDist(a, px, pz) < 1;
  });
}

/** Rounded-oval "radius" of a point: < 1 inside. */
export function ovalDist(a, x, z) {
  const u = Math.abs(x - a.oval[0]) / a.rx;
  const v = Math.abs(z - a.oval[1]) / a.rz;
  return (u ** a.p + v ** a.p) ** (1 / a.p);
}

/** Is (x, z) on the club's flying field? */
export function inField(x, z) {
  const f = LOCATION.layout.field;
  if (f.r !== undefined) return Math.hypot(x - f.x, z - f.z) < f.r;
  return x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1;
}
