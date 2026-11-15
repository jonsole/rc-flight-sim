// Where you fly. The made-up club field is drawn from code; real sites come
// from a baked data file (tools/bake_location.py): LIDAR terrain, trees and
// buildings, and a ground colour map from OpenStreetMap.
//
// The site is picked before the simulation loads (src/boot.js) and stays for
// the session: switching reloads the page. Every module that lays out the
// world reads LOCATION when it is first used.
//
// Layout (local frame: pilot at the origin, +x east, -z north, metres):
//   runway, pilotPad    mown strip and gravel pad {x, z, length, width}
//   field               mown grass: { x0, x1, z0, z1 } rectangle, or { x, z, r } circle
//   flat                ground forced level to y = 0 here (rectangle), fading out over `fade` m
//   hut, container      club buildings (null for none)
//   cars, gazebo, table, windsock, fence

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
    // The mown field runs about 160 m east-west by 210 m north-south; you
    // stand near its south hedge looking north, runway east-west.
    runway: { x: 0, z: -22, length: 120, width: 16 },
    pilotPad: { x: 0, z: 0.5, length: 6, width: 4 },
    field: { x0: -80, x1: 78, z0: -182, z1: 28 },
    flat: { x0: -80, x1: 78, z0: -182, z1: 28, fade: 40 },
    hut: null,
    container: null,
    cars: [
      { x: -30, z: 44, color: '#b8202a' },
      { x: -26.5, z: 44.4, color: '#c9ccd0' },
      { x: -23, z: 43.8, color: '#284f8f' },
    ],
    gazebo: { x: 12, z: 12, size: 3, h: 2.5 },
    table: { x: 6, z: 3 },
    windsock: { x: -35, z: -42, height: 5 },
    fence: { z: 6, x0: -60, x1: 60 },
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

/** Is (x, z) on the club's mown field? */
export function inField(x, z) {
  const f = LOCATION.layout.field;
  if (f.r !== undefined) return Math.hypot(x - f.x, z - f.z) < f.r;
  return x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1;
}
