import { WebGLRenderer, ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector3 } from 'three';
import { Aircraft } from './sim/aircraft.js';
import { ground } from './sim/terrain.js';
import { Wind } from './sim/wind.js';
import { World, RUNWAY } from './world/world.js';
import { AIRCRAFT, getAircraft } from './aircraft/index.js';
import { Input } from './input/input.js';
import { TouchControls, isTouchDevice } from './input/touch.js';
import { CameraRig, CAMERA_LABELS } from './view/cameras.js';
import { OSD } from './ui/osd.js';
import { Panel } from './ui/panel.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { EngineSound } from './audio/engine.js';

// Development builds (the /dev/ page) are badged so they're never mistaken for live.
if (import.meta.env.VITE_CHANNEL === 'dev') {
  document.title = `[DEV] ${document.title}`;
  const badge = document.createElement('div');
  badge.id = 'dev-badge';
  badge.textContent = 'DEV';
  badge.title = 'Development build: may be unfinished. Live version is one folder up.';
  document.body.append(badge);
  document.querySelector('#splash h1')?.append(' (dev)');
}

const settings = loadSettings();
settings.losZoom = Number(settings.losZoom);

// --- Renderer ----------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// Phones and tablets: cap the resolution a little lower to keep the frame rate up.
const TOUCH_DEVICE = isTouchDevice();
const MAX_DPR = TOUCH_DEVICE ? 1.5 : 2;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

// --- Simulation ----------------------------------------------------------------
const world = new World();
if (TOUCH_DEVICE) world.sun.shadow.mapSize.set(1024, 1024);
const wind = new Wind();
const input = new Input();
const rig = new CameraRig(settings);

let entry = null; // selected aircraft (registry entry)
let aircraft = null; // flight model
let model = null; // 3D model

/** Swap in another aircraft: new flight model, 3D model and camera mounts. */
function loadAircraft(id) {
  entry = getAircraft(id);
  settings.aircraft = entry.id;
  if (model) {
    world.scene.remove(model.root);
    model.root.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) {
        m?.map?.dispose();
        m?.dispose();
      }
    });
  }
  aircraft = new Aircraft(entry.def, { ground, wind });
  aircraft.assistMode = settings.assist;
  model = entry.createModel();
  world.scene.add(model.root);
  rig.setAircraft(entry);
}
loadAircraft(settings.aircraft);
const osd = new OSD(document.getElementById('osd'));
const sound = new EngineSound();
const analog = document.getElementById('analog');
{
  // Static noise tile for the analog-video effect.
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  analog.style.setProperty('--noise', `url(${c.toDataURL()})`);
}

let paused = false;
let assistFlash = 0; // seconds to show the assist-mode banner
let touchSeen = false; // a real finger touched the screen (auto-enables the sticks)

function applySettings() {
  aircraft.assistMode = settings.assist;
  wind.speed = settings.windSpeed;
  wind.directionDeg = settings.windDir;
  wind.turbulence = settings.turbulence;
  world.setSun(settings.sunElevation, settings.sunAzimuth);
  sound.volume = settings.volume;
  osd.showHud = settings.showHud;
  const showTouch = settings.touchControls === 'on' || (settings.touchControls === 'auto' && (TOUCH_DEVICE || touchSeen));
  touch.setVisible(showTouch);
  touch.setMode(Number(settings.stickMode));
  if (rig.mode !== settings.cameraMode) rig.setMode(settings.cameraMode);
}

function resetAircraft() {
  // Take off into wind along the runway.
  const windFromEast = Math.sin((settings.windDir * Math.PI) / 180) > 0; // wind from E half
  const dir = windFromEast ? 1 : -1; // fly towards the wind (+x = east)
  const heading = dir > 0 ? 0 : Math.PI;
  const startX = RUNWAY.x - dir * 40;
  if (settings.startMode === 'air') {
    aircraft.resetInAir(new Vector3(startX + dir * 40, 30, RUNWAY.z - 10), heading, 14);
    input.kb.throttle = 0.5;
  } else {
    aircraft.resetOnGround(startX, RUNWAY.z, heading);
  }
  osd.reset();
  rig.chaseInit = false;
  rig.losInit = false;
}

/** User picked a different model: load it with its default flight assist. */
function selectAircraft(id) {
  loadAircraft(id);
  settings.assist = entry.defaultAssist;
  applySettings();
  saveSettings(settings);
  resetAircraft();
  if (panel?.visible) panel.render();
  updateSplash();
}

const panel = new Panel(document.getElementById('panel'), {
  settings,
  input,
  onChange(key, value) {
    if (key === 'losZoom') settings.losZoom = Number(value);
    applySettings();
    saveSettings(settings);
    if (key === 'aircraft') selectAircraft(value);
    if (key === 'startMode') resetAircraft();
  },
  onReset: resetAircraft,
  onClose: () => setMenu(false),
});

// On-screen sticks and buttons (shown on touch screens; see Transmitter tab).
const touch = new TouchControls({
  onAction: (code) => input.onAction(code),
  onMenu: () => setMenu(!panel.visible),
});
input.touch = touch;
// Auto mode: if detection missed this device, show the sticks as soon as the
// screen is actually touched.
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && settings.touchControls === 'auto' && !touch.visible) {
    touchSeen = true;
    applySettings();
  }
});

function setMenu(open) {
  panel.show(open);
  paused = open;
  if (!open) sound.start();
}

input.onAction = (code) => {
  sound.start();
  switch (code) {
    case 'KeyR':
      resetAircraft();
      break;
    case 'KeyC':
      settings.cameraMode = rig.cycle();
      saveSettings(settings);
      if (panel.visible) panel.render();
      break;
    case 'KeyG': {
      const modes = ['off', 'as3x', 'safe'];
      settings.assist = modes[(modes.indexOf(settings.assist) + 1) % modes.length];
      aircraft.assistMode = settings.assist;
      saveSettings(settings);
      assistFlash = 2;
      if (panel.visible) panel.render();
      break;
    }
    case 'KeyP':
      paused = !paused;
      break;
    case 'KeyH':
      settings.showHud = !settings.showHud;
      osd.showHud = settings.showHud;
      saveSettings(settings);
      break;
    case 'KeyM':
      sound.muted = !sound.muted;
      break;
    case 'Escape':
      setMenu(!panel.visible);
      break;
    default:
  }
};

document.getElementById('menu-btn').addEventListener('click', () => setMenu(!panel.visible));
// Start screen: aircraft picker.
const splashSelect = document.getElementById('splash-aircraft');
const splashSummary = document.getElementById('splash-summary');
for (const a of AIRCRAFT) splashSelect.append(new Option(a.name, a.id));
splashSelect.addEventListener('change', (e) => selectAircraft(e.target.value));
function updateSplash() {
  if (!splashSelect.isConnected) return;
  splashSelect.value = entry.id;
  splashSummary.textContent = entry.summary;
}
updateSplash();

document.getElementById('start').addEventListener('click', () => {
  document.getElementById('splash').remove();
  sound.start();
  paused = false;
});
window.addEventListener('pointerdown', () => sound.start(), { once: true });

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w / h);
  osd.resize(w, h, Math.min(window.devicePixelRatio, MAX_DPR));
}
window.addEventListener('resize', resize);
resize();

applySettings();
rig.setMode(settings.cameraMode);
resetAircraft();
paused = true; // until the splash is dismissed

// --- Main loop -------------------------------------------------------------------
let last = performance.now();
const windTmp = new Vector3();
let rssi = 99;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const ctl = input.update(dt);
  panel.tick();

  if (!paused) {
    Object.assign(aircraft.controls, ctl);
    wind.update(dt);
    aircraft.update(dt);
    osd.update(dt, aircraft);
  }

  model.root.position.copy(aircraft.position);
  model.root.quaternion.copy(aircraft.orientation);
  model.update(aircraft, paused ? 0 : dt);

  const fpv = rig.mode === 'fpv';
  model.setPilotVisible(!(fpv && settings.fpvMount === 'cockpit'));
  rig.update(aircraft, dt);
  world.followShadow(aircraft.position);
  world.updateWindsock(wind.at(new Vector3(-35, 5, -42), 0, windTmp));

  const eye = rig.pilotEye();
  const dist = eye.distanceTo(aircraft.position);
  // Fake RSSI / video quality falls off with range and when low behind terrain.
  rssi = Math.max(0, Math.min(99, Math.round(99 - dist / 8)));
  analog.style.opacity = fpv && settings.fpvAnalog ? String(0.06 + Math.max(0, (dist - 250) / 900)) : '0';

  renderer.render(world.scene, rig.camera);
  osd.draw(rig.mode, aircraft, {
    home: eye,
    rssi,
    paused,
    inputSource: input.source,
    touch: touch.visible,
    cameraLabel: CAMERA_LABELS[rig.mode],
    assist: { off: 'MANUAL', as3x: 'AS3X', safe: 'SAFE' }[settings.assist],
    assistFlash: (assistFlash = Math.max(0, assistFlash - dt)) > 0,
    vfov: rig.camera.fov,
    tilt: (settings.fpvTilt * Math.PI) / 180,
  });
  sound.update(aircraft, dist, fpv);
}
requestAnimationFrame(frame);

// Expose for debugging in the console.
window.sim = {
  get aircraft() {
    return aircraft;
  },
  get entry() {
    return entry;
  },
  world,
  rig,
  input,
  settings,
  selectAircraft,
};
