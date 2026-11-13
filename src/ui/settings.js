// Persistent simulator settings.
const KEY = 'rcsim.settings.v1';

export const DEFAULT_SETTINGS = {
  cameraMode: 'los',
  startMode: 'runway', // 'runway' | 'air'
  // FPV
  fpvMount: 'cockpit', // 'cockpit' | 'wing'
  fpvTilt: 4,          // degrees of camera uptilt
  fpvFov: 120,         // horizontal degrees
  fpvShake: true,
  fpvAnalog: true,     // analog video noise effect
  // Line of sight
  losFov: 50,
  losZoom: 1,          // 0 off, 1 gentle, 2 strong
  pilotX: 0,
  pilotZ: 0,
  // Environment
  windSpeed: 3,
  windDir: 270,
  turbulence: 0.3,
  sunElevation: 38,
  sunAzimuth: 215,
  // Misc
  volume: 0.6,
  showHud: true,
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
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
