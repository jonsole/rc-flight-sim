// Aircraft registry. Each entry bundles a flight-model definition, its
// geometry, camera mounts and a 3D-model factory:
//   { id, name, summary, defaultAssist, def, geometry, views, createModel() }
// To add an aircraft, write a module that returns that shape and list it here.
import { EFLITE_SE5a_900 } from './se5a.js';
import { FT_MINI_F22 } from './f22.js';
import { BUSCHTROTTEL_SHOCKCUB, BUSCHTROTTEL_HIGHLANDER, BUSCHTROTTEL_AGRO } from './buschtrottel.js';

export const AIRCRAFT = [EFLITE_SE5a_900, BUSCHTROTTEL_SHOCKCUB, BUSCHTROTTEL_HIGHLANDER, BUSCHTROTTEL_AGRO, FT_MINI_F22];

export const DEFAULT_AIRCRAFT_ID = EFLITE_SE5a_900.id;

export function getAircraft(id) {
  return AIRCRAFT.find((a) => a.id === id) || AIRCRAFT.find((a) => a.id === DEFAULT_AIRCRAFT_ID);
}
