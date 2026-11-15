import { WebGLRenderer, ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector3 } from 'three';
import { Aircraft } from './sim/aircraft.js';
import { physicsGround as ground } from './sim/terrain.js';
import { Obstacles } from './sim/obstacles.js';
import { Wind } from './sim/wind.js';
import { World, RUNWAY } from './world/world.js';
import { AIRCRAFT, getAircraft } from './aircraft/index.js';
import { Input } from './input/input.js';
import { TouchControls, isTouchDevice } from './input/touch.js';
import { CameraRig, CAMERA_LABELS } from './view/cameras.js';
import { Debris } from './view/debris.js';
import { Shadows } from './world/shadows.js';
import { PlaneShadow } from './view/planeShadow.js';
import { Peers } from './view/peers.js';
import { addNavLights } from './view/navlights.js';
import { Multiplayer } from './net/multiplayer.js';
import { DEFAULT_MP_SERVER } from './net/config.js';
import { Chat } from './ui/chat.js';
import { clockHours, dayOfYear } from './world/sun.js';
import { OSD } from './ui/osd.js';
import { Panel } from './ui/panel.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { EngineSound } from './audio/engine.js';
import { LOCATION, LOCATIONS, clubAngle, clubToWorld } from './sim/location.js';
import { QUALITY, qualityPreset, viewDistance } from './world/quality.js';
import { GoogleTiles } from './world/googleTiles.js';
import { loadEdits } from './sim/edits.js';
import { Editor } from './editor/editor.js';

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
if (!settings.mpName) settings.mpName = `Pilot ${100 + Math.floor(Math.random() * 900)}`;
// Invite links: ?room=CODE fills in the room and joins when you start flying.
const inviteRoom = new URLSearchParams(location.search).get('room');
if (inviteRoom) settings.mpRoom = inviteRoom.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
saveSettings(settings);

// --- Renderer ----------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// Graphics quality and scenery distance: on first run, low on phones and
// tablets, medium elsewhere (Menu → View → Graphics).
const TOUCH_DEVICE = isTouchDevice();
if (!settings.graphics) settings.graphics = TOUCH_DEVICE ? 'low' : 'medium';
if (settings.viewDistance === '' || settings.viewDistance == null) settings.viewDistance = TOUCH_DEVICE ? '1000' : '2000';
saveSettings(settings);
const quality = qualityPreset(settings);
const MAX_DPR = quality.pixelRatio;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

// --- Simulation ----------------------------------------------------------------
// Scenery edits for this field (src/sim/edits.js), before anything is built.
loadEdits(LOCATION.id, LOCATION.layout.edits);
const obstacles = new Obstacles();
const world = new World(obstacles, { quality, viewDistance: viewDistance(settings) });
const wind = new Wind();
wind.setTrees(obstacles.trees); // trees shelter the field and stir up the air behind them
const input = new Input();
const rig = new CameraRig(settings);
// Scenery shadows (redrawn only when the sun moves; smaller map on phones),
// and the aeroplane's own shadow, drawn every frame.
world.attachShadows(new Shadows(world.sun, { mapSize: quality.shadowMap }));
const planeShadow = new PlaneShadow(world.scene, ground);

// Google Photorealistic 3D Tiles in place of the built scenery, at real
// sites, when chosen and a key is set (Menu → View → Graphics).
let googleTiles = null;
if (LOCATION.data && settings.scenery === 'google' && settings.googleKey) {
  googleTiles = new GoogleTiles({
    apiKey: settings.googleKey,
    lat: LOCATION.data.origin.lat,
    lon: LOCATION.data.origin.lon,
    groundHeight: LOCATION.data.origin.height,
    trueNorth: LOCATION.data.origin.trueNorth,
    quality: settings.graphics,
    creditEl: document.getElementById('map-credits'),
  });
  world.scene.add(googleTiles.group);
  world.setGoogleMode(true);
}

// Scenery editor (E, or Menu → Flying → Edit scenery). It shows the built
// scenery, with Google's tiles underneath only if you switch them on.
let pausedBeforeEdit = false;
const editor = new Editor({
  world,
  obstacles,
  camera: rig.camera,
  canvas,
  root: document.getElementById('editor'),
  onRebuilt: () => wind.setTrees(obstacles.trees),
  setGoogle: googleTiles ? (on) => {
    googleTiles.group.visible = on;
    world.setGoogleMode(on);
  } : null,
  onExit: () => {
    if (googleTiles) {
      googleTiles.group.visible = true;
      world.setGoogleMode(true);
    }
    document.getElementById('menu-btn').style.display = '';
    rig.setMode(rig.mode);
    rig.resize(window.innerWidth / window.innerHeight);
    paused = pausedBeforeEdit;
  },
});
function openEditor() {
  if (editor.active) return;
  setMenu(false);
  pausedBeforeEdit = false;
  paused = true;
  if (googleTiles) {
    googleTiles.group.visible = false;
    world.setGoogleMode(false);
  }
  document.getElementById('menu-btn').style.display = 'none';
  editor.open();
}

let entry = null; // selected aircraft (registry entry)
let aircraft = null; // flight model
let model = null; // 3D model

/** Swap in another aircraft: new flight model, 3D model and camera mounts. */
const debris = new Debris(world.scene, ground);

/** (Re)build the 3D model, clearing any parts that broke off. */
function replaceModel() {
  debris.clear();
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
  model = entry.createModel();
  navLights = addNavLights(model, { shine: true });
  planeShadow.setModel(model, entry.def.wingSpan);
  world.scene.add(model.root);
}
let navLights = null;

function loadAircraft(id) {
  entry = getAircraft(id);
  settings.aircraft = entry.id;
  aircraft = new Aircraft(entry.def, { ground, wind, obstacles });
  aircraft.assistMode = settings.assist;
  replaceModel();
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

/** Sun, sky and light for the chosen time of day (or the clock). */
function applyTime() {
  const now = new Date();
  const hours = settings.useClock ? clockHours(now) : Number(settings.timeOfDay);
  world.setTime(hours, dayOfYear(now));
  renderer.toneMappingExposure = world.exposure;
}
let clockTimer = 0;

function applySettings() {
  aircraft.assistMode = settings.assist;
  wind.speed = settings.windSpeed;
  wind.directionDeg = settings.windDir;
  wind.turbulence = settings.turbulence;
  applyTime();
  world.setClouds(Number(settings.cloudCover));
  sound.volume = settings.volume;
  osd.showHud = settings.showHud;
  const showTouch = settings.touchControls === 'on' || (settings.touchControls === 'auto' && (TOUCH_DEVICE || touchSeen));
  touch.setVisible(showTouch);
  touch.setMode(Number(settings.stickMode));
  if (rig.mode !== settings.cameraMode) rig.setMode(settings.cameraMode);
}

function resetAircraft() {
  // Put the model back together if anything broke off.
  if (aircraft.broken.size || debris.items.length) replaceModel();
  // Take off into wind along the runway (which may be turned: the club frame).
  const A = clubAngle();
  const windRad = (settings.windDir * Math.PI) / 180;
  const dir = Math.sin(windRad - A) > 0 ? 1 : -1; // +1: wind from the runway's +x end
  const heading = (dir > 0 ? 0 : Math.PI) - A;
  // Start a little in from the downwind end (40 m on a long runway).
  const run = Math.min(40, RUNWAY.length / 2 - 3);
  // In multiplayer, each player starts in their own lane so nobody spawns
  // inside someone else's aeroplane.
  const lane = mp.connected ? ((mp.myId - 1) % 4) - 1.5 : 0;
  mpGraceUntil = performance.now() / 1000 + 3;
  if (settings.startMode === 'air') {
    const [ax, az] = clubToWorld(RUNWAY.x, RUNWAY.z - 10 + lane * 8);
    aircraft.resetInAir(new Vector3(ax, 30 + lane * 4, az), heading, 14);
    input.kb.throttle = 0.5;
  } else if (entry.def.handLaunch) {
    // In the pilot's right hand at the flight line, half a metre ahead,
    // pointing along the runway into wind.
    const hx = settings.pilotX + lane * 3 + Math.cos(heading) * 0.5 + Math.sin(heading) * 0.3;
    const hz = settings.pilotZ - Math.sin(heading) * 0.5 + Math.cos(heading) * 0.3;
    aircraft.resetHandLaunch(hx, hz, heading);
  } else {
    const [gx, gz] = clubToWorld(RUNWAY.x - dir * run, RUNWAY.z + lane * 4);
    aircraft.resetOnGround(gx, gz, heading);
  }
  osd.reset();
  rig.chaseInit = false;
  rig.losInit = false;
}

/** User picked a different model: load it with its default flight assist. */
function selectAircraft(id) {
  loadAircraft(id);
  mp.setInfo(settings.mpName, entry.id);
  settings.assist = entry.defaultAssist;
  applySettings();
  saveSettings(settings);
  resetAircraft();
  if (panel?.visible) panel.render();
  updateSplash();
}

// --- Multiplayer -------------------------------------------------------------
const mp = new Multiplayer();
let mpGraceUntil = 0; // no collisions just after a reset
const peers = new Peers(world.scene, ground);
peers.addShadow = (model, span) => {
  const s = new PlaneShadow(world.scene, ground);
  s.setModel(model, span);
  return s;
};
const mpBadge = document.getElementById('mp-badge');
const mpToast = document.getElementById('mp-toast');
const mpServer = () => settings.mpServer || DEFAULT_MP_SERVER;
function toast(text) {
  const d = document.createElement('div');
  d.textContent = text;
  mpToast.append(d);
  setTimeout(() => (d.style.opacity = '0'), 3500);
  setTimeout(() => d.remove(), 4200);
}
const chatBtn = document.getElementById('chat-btn');
const chat = new Chat({
  onSend(text) {
    const sent = mp.sendChat(text);
    if (sent) chat.add(settings.mpName, sent, true);
  },
});
chatBtn.addEventListener('click', () => chat.show());
/** Open the chat box (after the key that asked for it has been handled). */
function openChat() {
  if (mp.connected && !panel.visible) setTimeout(() => chat.show(), 0);
}
function mpConnect() {
  if (!settings.mpRoom) return;
  mp.connect(mpServer(), fieldRoom(settings.mpRoom), settings.mpName, entry.id);
  mp.baseRoom = settings.mpRoom;
}
mp.onEvent = (type, p, m) => {
  if (type === 'chat') {
    chat.add(p.name, m.text);
    return;
  }
  if (type === 'hit' && !aircraft.crashed && !paused) {
    aircraft.crash(`Collided with ${p.name}`);
    aircraft.breakAt({ part: m.part, crashSpeed: 3 }, Number(m.speed) || 5);
    const other = p.buf.items[p.buf.items.length - 1];
    if (other) aircraft.velocity.lerp(other.v, 0.5);
    return;
  }
  if (type === 'join') toast(`${p.name} joined (${getAircraft(p.aircraft).name})`);
  if (type === 'leave' && mp.connected) toast(`${p.name} left`);
  if (type === 'status' && mp.status === 'on') {
    toast(`Joined room ${mp.room}`);
    // Still parked where everyone starts? Move to this player's own lane so
    // we don't sit inside someone else's aeroplane.
    if (aircraft.onGround && aircraft.velocity.length() < 1) resetAircraft();
  }
  if (type === 'status' && mp.status === 'error') toast(`Multiplayer: ${mp.error}`);
  if (type === 'status' && mp.status === 'connecting' && mp.error) toast(mp.error);
  mpBadge.style.display = mp.connected ? 'block' : 'none';
  chatBtn.style.display = mp.connected ? 'block' : 'none';
  if (!mp.connected) chat.close();
  mpBadge.textContent = `Room ${mp.room} · ${mp.peers.size + 1} ${mp.peers.size ? 'pilots' : 'pilot'}`;
  if (panel?.visible && panel.tab === 'mp') panel.render();
};
/** Reload at another flying field (keeping any invite room). */
function changeField(id) {
  if (id === LOCATION.id) return;
  settings.location = id;
  reloadKeepingRoom(id);
}

/** Reload the page (at `field`), staying in any multiplayer room. */
function reloadKeepingRoom(field = LOCATION.id) {
  saveSettings(settings);
  const q = new URLSearchParams(location.search);
  q.set('field', field);
  if (mp.connected) q.set('room', mp.baseRoom ?? settings.mpRoom);
  location.search = q.toString();
}
// Players only meet others at the same field: the room on the server is
// the code plus the field (none for the made-up field).
const fieldRoom = (room) => (LOCATION.data ? `${room.slice(0, 20)}-${LOCATION.id.slice(0, 3).toUpperCase()}` : room);

function newRoomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => a[Math.floor(Math.random() * a.length)]).join('');
}

const panel = new Panel(document.getElementById('panel'), {
  settings,
  input,
  mp,
  defaultServer: DEFAULT_MP_SERVER,
  newRoomCode,
  inviteLink: () => `${location.origin}${location.pathname}?room=${encodeURIComponent(mp.baseRoom ?? mp.room)}${LOCATION.data ? `&field=${LOCATION.id}` : ''}`,
  onMpConnect: () => {
    mpConnect();
    panel.render();
  },
  onMpDisconnect: () => {
    mp.disconnect();
    panel.render();
  },
  onChange(key, value) {
    if (key === 'mpName') {
      settings.mpName = value || settings.mpName;
      mp.setInfo(settings.mpName, entry.id);
    }
    if (key === 'losZoom') settings.losZoom = Number(value);
    applySettings();
    saveSettings(settings);
    if (key === 'aircraft') selectAircraft(value);
    if (key === 'location') changeField(value);
    // The scenery is built for these once, so they take effect on a reload.
    if (key === 'graphics' || key === 'viewDistance' || key === 'scenery' || (key === 'googleKey' && settings.scenery === 'google')) reloadKeepingRoom();
    if (key === 'startMode') resetAircraft();
  },
  onReset: resetAircraft,
  onEditScenery: () => openEditor(),
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
  if (editor.active) return; // the editor has the keyboard
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
    case 'KeyE':
      openEditor();
      break;
    case 'Enter':
    case 'NumpadEnter':
    case 'KeyT':
      openChat();
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
const splashField = document.getElementById('splash-field');
for (const l of LOCATIONS) splashField.append(new Option(l.name, l.id));
splashField.value = LOCATION.id;
splashField.addEventListener('change', (e) => changeField(e.target.value));
const splashGraphics = document.getElementById('splash-graphics');
for (const [k, q] of Object.entries(QUALITY)) splashGraphics.append(new Option(q.name, k));
splashGraphics.value = settings.graphics;
splashGraphics.addEventListener('change', (e) => {
  settings.graphics = e.target.value;
  reloadKeepingRoom();
});
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
  if (inviteRoom) mpConnect();
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
const windsockPos = new Vector3(obstacles.windsock?.x ?? 0, obstacles.windsock?.height ?? 5, obstacles.windsock?.z ?? 0);
let rssi = 99;

function frame(now) {
  requestAnimationFrame(frame);
  // (The first frame's timestamp can be just before `last`.)
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  const ctl = input.update(dt);
  touch.setSticks(!input.gamepadName); // a plugged-in transmitter replaces the thumb sticks
  panel.tick();

  if (!paused) {
    Object.assign(aircraft.controls, ctl);
    wind.update(dt);
    aircraft.update(dt);
    // Parts that broke off in a crash fly away as debris.
    while (aircraft.breakEvents.length) {
      const ev = aircraft.breakEvents.shift();
      debris.spawn(model.parts?.[ev.part], aircraft, ev.speed);
    }
    debris.update(dt);
    osd.update(dt, aircraft);
  }
  // Following the clock: move the sun along every 20 s.
  if (settings.useClock && (clockTimer -= dt) <= 0) {
    clockTimer = 20;
    applyTime();
  }
  // Others see you even while your menu is open.
  mp.update(dt, aircraft);

  model.root.position.copy(aircraft.position);
  model.root.quaternion.copy(aircraft.orientation);
  model.update(aircraft, paused ? 0 : dt);
  navLights.update(world.night, now / 1000, rig.camera, window.innerHeight, aircraft.broken);

  const fpv = rig.mode === 'fpv';
  model.setPilotVisible(!(fpv && settings.fpvMount === 'cockpit'));
  if (editor.active) editor.update(dt);
  else rig.update(aircraft, dt);
  googleTiles?.update(rig.camera, renderer, dt);
  // Other players (after the camera has moved, so their labels line up).
  rig.camera.updateMatrixWorld();
  const solid = mp.connected && !paused && !aircraft.crashed && now / 1000 > mpGraceUntil;
  peers.night = world.night;
  // Aeroplane shadows as dark as the scenery's.
  const shadowDark = world.shadowDarkness();
  peers.shadowCtx = { renderer, lightDir: world.lightDir, strength: shadowDark };
  const hit = peers.update(mp.peers, dt, rig.camera, { aircraft, id: entry.id, solid });
  if (hit) {
    // Mid-air (or on the ground): the part that hit breaks off, and the other
    // player is told so they crash too (their view of us is a little older).
    aircraft.crash(`Collided with ${hit.peer.name}`);
    aircraft.breakAt({ part: hit.sample.part, crashSpeed: 3 }, hit.relSpeed);
    aircraft.velocity.lerp(hit.velocity, 0.5);
    mp.sendHit(hit.peer.id, hit.theirPart, hit.relSpeed);
  }
  world.updateShadows();
  world.updateTrees(now / 1000, wind.speed + wind.gust.length() * 0.5, wind.directionDeg);
  planeShadow.update(renderer, aircraft.position, world.lightDir, shadowDark);
  world.updateWindsock(wind.at(windsockPos, 0, windTmp), dt, now / 1000);
  if (!paused) world.updateClouds(dt, windTmp);

  const eye = rig.pilotEye();
  const dist = eye.distanceTo(aircraft.position);
  // Fake RSSI / video quality falls off with range and when low behind terrain.
  rssi = Math.max(0, Math.min(99, Math.round(99 - dist / 8)));
  analog.style.opacity = fpv && settings.fpvAnalog ? String(0.06 + Math.max(0, (dist - 250) / 900)) : '0';

  renderer.render(world.scene, rig.camera);
  if (editor.active) osd.clear();
  else osd.draw(rig.mode, aircraft, {
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
  renderer,
  rig,
  mp,
  input,
  settings,
  selectAircraft,
  /** Debug: set the time of day (hours). */
  setTime(h) {
    settings.timeOfDay = h;
    settings.useClock = false;
    applyTime();
  },
};
