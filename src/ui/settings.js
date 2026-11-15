// Persistent simulator settings.
const KEY = 'rcsim.settings.v1';

export const DEFAULT_SETTINGS = {
  cameraMode: 'los',
  aircraft: 'eflite-se5a-900', // see src/aircraft/index.js
  startMode: 'runway', // 'runway' | 'air'
  location: 'home',    // flying field, see src/sim/location.js
  assist: 'as3x',      // 'off' | 'as3x' | 'safe'
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
  scenery: 'built',      // real sites: 'built' (from the site data) | 'google' (photorealistic 3D tiles)
  googleKey: '',         // your Google Maps Platform API key (stays in this browser)
  // Environment
  windSpeed: 3,
  windDir: 270,
  turbulence: 0.3,
  timeOfDay: 14,         // hours, local solar time
  cloudCover: 0.35,      // 0 clear .. 1 overcast
  useClock: false,       // follow the computer's clock instead
  // Misc
  volume: 0.6,
  showHud: true,
  // Touch screens
  touchControls: 'auto', // 'auto' | 'on' | 'off'
  stickMode: '2',        // '2' = throttle left, '1' = throttle right
  // Multiplayer
  mpName: '',            // set to "Pilot NNN" on first run
  mpRoom: '',
  mpServer: '',          // blank = the built-in relay
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
