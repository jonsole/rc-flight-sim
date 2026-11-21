// Persistent simulator settings.
const KEY = 'rcsim.settings.v1';

export const DEFAULT_SETTINGS = {
  cameraMode: 'los',
  aircraft: 'eflite-se5a-900', // see src/aircraft/index.js
  startMode: 'runway', // 'runway' | 'air' | 'saved' (your saved position: X)
  location: 'waterbeach', // flying field, see src/sim/location.js (the Club field is hidden: ?field=home)
  assist: 'as3x',      // 'off' | 'as3x' | 'safe'
  challenge: 'none',   // src/game/challenges.js MODES
  challengeLevel: 'normal', // 'easy' | 'normal' | 'hard'
  balloonMinutes: 5,   // balloon burst time limit (2, 5 or 10)
  // FPV
  fpvMount: 'cockpit', // 'cockpit' | 'wing'
  fpvTilt: 4,          // degrees of camera uptilt
  fpvFov: 120,         // horizontal degrees
  fpvShake: true,
  fpvAnalog: true,     // analog video noise effect
  // Line of sight
  losFov: 80,          // degrees across the screen
  losFovAcross: true,  // (older saves measured it top to bottom: converted on load)
  losZoom: 1,          // 0 off, 1 gentle, 2 strong
  pilotX: 0,
  pilotZ: 0,
  // Graphics (src/world/quality.js); blank = chosen for the device on first run
  graphics: '',          // 'low' | 'medium' | 'high'
  viewDistance: '',      // metres as a string, '0' = unlimited
  treeStyle: 'fluffy',
  sunGlare: true,
  startSpots: {},        // your saved start position per field (main.js savedSpot; X saves it)
  mist: 'seasonal',      // 'seasonal' (spring and autumn mornings) | 'off' | 'light' | 'thick'  (src/world/mist.js)
  snow: 'seasonal',      // 'seasonal' (some winter days) | 'off' | 'dusting' | 'lying' | 'light' | 'heavy'  (src/world/snow.js)
  lowCloud: 'seasonal',  // 'seasonal' | 'off' | 'broken' | 'overcast'        // looking into the sun washes the picture out (src/view/glare.js)
  cardsFaceCamera: true, // leafy trees: leaf cards face the camera's position (false: the screen, as before)   // trees and bushes: 'fluffy' (leafy cards, src/world/fluffy.js) | 'classic' (solid)
  scenery: 'built',      // real sites: 'built' (from the site data) | 'google' (photorealistic 3D tiles)
  googleKey: '',         // your Google Maps Platform API key (stays in this browser)
  // Environment
  windSpeed: 3,
  windDir: 270,
  turbulence: 0.3,
  timeOfDay: 14,         // hours, local solar time
  dayOfYear: 172,        // time of year (21 Jun): the sun, and the trees and grass
  cloudCover: 0.35,      // 0 clear .. 1 overcast
  godRays: true,
  clouds3d: true,         // 3D clouds on High graphics (src/world/volclouds.js)         // sunbeams through gaps in the clouds
  cloudType: 'auto',     // src/world/clouds.js CLOUD_TYPES, or 'auto' (changing with the season and day)
  useClock: false,       // follow the computer's clock (time and date) instead
  // Misc
  volume: 0.6,
  showHud: true,
  fullscreen: true,      // phones and tablets: full screen when you press Fly (src/ui/fullscreen.js)
  // Touch screens
  touchControls: 'auto', // 'auto' | 'on' | 'off'
  stickMode: '2',        // '2' = throttle left, '1' = throttle right
  // Multiplayer
  mpName: '',            // set to "Pilot NNN" on first run
  mpRoom: '',
  mpServer: '',          // the relay's wss:// address (no built-in one; invite links carry it)
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && !s.losFovAcross && s.losFov != null) {
      // Line-of-sight FOV used to be top to bottom: the same view across a
      // 16:9 screen.
      const v = (Number(s.losFov) * Math.PI) / 180;
      s.losFov = Math.round((2 * Math.atan(Math.tan(v / 2) * (16 / 9)) * 180) / Math.PI);
      s.losFovAcross = true;
    }
    if (s) return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
