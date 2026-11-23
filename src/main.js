import { WebGLRenderer, ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector3, Box3 } from 'three';
import { Aircraft } from './sim/aircraft.js';
import { physicsGround as ground, setSnowCover } from './sim/terrain.js';
import { Obstacles, setLeafiness } from './sim/obstacles.js';
import { seasonFor } from './world/seasons.js';
import { Wind } from './sim/wind.js';
import { World, RUNWAY } from './world/world.js';
import { AIRCRAFT, getAircraft, loadModelFile, loadModelFiles, onModelLoaded } from './aircraft/index.js';
import { AircraftPreview } from './ui/preview.js';
import { Input } from './input/input.js';
import { TouchControls, isTouchDevice } from './input/touch.js';
import { CameraRig, CAMERA_LABELS } from './view/cameras.js';
import { Debris } from './view/debris.js';
import { SnowTracks, snowDepth } from './world/snowTracks.js';
import { canFullscreen, enterFullscreen, toggleFullscreen, isIPhone } from './ui/fullscreen.js';
import { Shadows } from './world/shadows.js';
import { PlaneShadow } from './view/planeShadow.js';
import { Peers } from './view/peers.js';
import { addNavLights } from './view/navlights.js';
import { Multiplayer } from './net/multiplayer.js';
import { Chat } from './ui/chat.js';
import { clockHours, dayOfYear } from './world/sun.js';
import { cloudTypeFor } from './world/clouds.js';
import { OSD } from './ui/osd.js';
import { Panel } from './ui/panel.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { EngineSound } from './audio/engine.js';
import { LOCATION, listedLocations, clubAngle, clubToWorld, pilotSpot } from './sim/location.js';
import { QUALITY, qualityPreset, viewDistance } from './world/quality.js';
import { tunedDef, loadTuning } from './sim/tuning.js';
import { GoogleTiles } from './world/googleTiles.js';
import { cardUniforms } from './world/fluffy.js';
import { setStage, nextFrame } from './ui/loading.js';
import { SunGlare } from './view/glare.js';
import { weatherFor } from './world/mist.js';
import { snowFor, snowLineFor, snowAtHeight } from './world/snow.js';
import { loadEdits } from './sim/edits.js';
import { Editor } from './editor/editor.js';
import { AiFlyers } from './ml/aiFlyers.js';
import { chooseStrip, sameStrip } from './ml/fieldStrip.js';
import { Challenges, MODES, LEVELS } from './game/challenges.js';

// The version running: the GitHub commit it was built from, and its date.
{
  const v = typeof __VERSION__ !== 'undefined' ? __VERSION__ : {};
  const line = document.createElement('p');
  line.className = 'version';
  if (v.sha) {
    const d = new Date(v.date);
    const when = isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const a = document.createElement('a');
    a.href = `https://github.com/jonsole/rc-flight-sim/commit/${v.sha}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = v.sha.slice(0, 7);
    line.append('Version ', a, when ? ` · ${when}` : '');
  } else line.textContent = 'Version: local build';
  document.querySelector('#splash h1')?.after(line);
}

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
// Invite links: ?room=CODE fills in the room and joins when you start
// flying, and &server=wss://... the relay to meet on (there's no built-in
// one: it's set in Menu → Multiplayer, and invite links carry it).
const inviteRoom = new URLSearchParams(location.search).get('room');
if (inviteRoom) settings.mpRoom = inviteRoom.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
const inviteServer = new URLSearchParams(location.search).get('server');
if (inviteServer && /^wss?:\/\/[^\s]+$/i.test(inviteServer)) settings.mpServer = inviteServer.slice(0, 200);
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
const world = new World(obstacles, { quality, viewDistance: viewDistance(settings), treeStyle: settings.treeStyle, renderer, defer: true });
// Built a step at a time, the start screen showing how far it's got.
await world.build((f) => setStage('Building the scenery…', f), nextFrame);
const wind = new Wind();
wind.setTrees(obstacles.trees); // trees shelter the field and stir up the air behind them
const input = new Input();
const rig = new CameraRig(settings);
// Scenery shadows (redrawn only when the sun moves; smaller map on phones),
// and the aeroplane's own shadow, drawn every frame.
world.attachShadows(new Shadows(world.sun, { mapSize: quality.shadowMap }));
const planeShadow = new PlaneShadow(world.scene, ground, { project: true }); // (onto trees and buildings too)
// Looking into the sun washes the picture out (src/view/glare.js).
const glare = new SunGlare();

// Google Photorealistic 3D Tiles in place of the built ground and buildings,
// at real sites, with a key set (Menu → View → Graphics, or O to switch).
// Google bills per session (one root tileset request, good for 3 hours), so
// the tiles only start when first wanted, and switching them off just hides
// them: switching back on is free.
let googleTiles = null;
const googleAvailable = () => !!(LOCATION.data && settings.googleKey);
function showGoogle(on) {
  if (on && !googleTiles && googleAvailable()) {
    googleTiles = new GoogleTiles({
      apiKey: settings.googleKey,
      lat: LOCATION.data.origin.lat,
      lon: LOCATION.data.origin.lon,
      groundHeight: LOCATION.data.origin.height,
      geoid: LOCATION.data.origin.geoid,
      trueNorth: LOCATION.data.origin.trueNorth,
      quality: settings.graphics,
      creditEl: document.getElementById('map-credits'),
    });
    world.scene.add(googleTiles.group);
  }
  googleTiles?.setVisible(on);
  world.setGoogleMode(on && !!googleTiles);
}
/** The scenery the settings ask for (not while editing: the editor has its own switch). */
function applyScenery() {
  if (editor?.active) return;
  googleTiles?.setOpacity(1);
  showGoogle(settings.scenery === 'google');
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
  onRebuilt: () => {
    wind.setTrees(obstacles.trees);
    windsockPos.set(obstacles.windsock?.x ?? 0, obstacles.windsock?.height ?? 5, obstacles.windsock?.z ?? 0);
    challenges.relayout();
  },
  setGoogle: googleAvailable() ? (on) => showGoogle(on) : null,
  setGoogleOpacity: (v) => googleTiles?.setOpacity(v),
  onExit: () => {
    applyScenery();
    document.getElementById('menu-btn').style.display = '';
    rig.setMode(rig.mode);
    rig.resize(window.innerWidth / window.innerHeight);
    paused = pausedBeforeEdit;
  },
});
applyScenery();
function openEditor() {
  if (editor.active) return;
  setMenu(false);
  pausedBeforeEdit = false;
  paused = true;
  showGoogle(false);
  document.getElementById('menu-btn').style.display = 'none';
  editor.open();
}

let entry = null; // selected aircraft (registry entry)
let aircraft = null; // flight model
let model = null; // 3D model
let modelBack = 0; // how far the model reaches behind its middle (m; set in replaceModel, for handHold)

/** Swap in another aircraft: new flight model, 3D model and camera mounts. */
const debris = new Debris(world.scene, ground);
// Tracks in lying snow from the wheels, skids and airframe (src/world/snowTracks.js).
const snowTracks = new SnowTracks();
world.scene.add(snowTracks.mesh);

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
  // Showing the prop as tuned (Menu → Tuning), if it's been changed.
  const tuning = loadTuning(entry.id);
  const tunedProp = ['propDiameter', 'propPitch', 'propBlades', 'propTips'].some((k) => tuning[k] != null) ? tunedDef(entry.def, tuning).motor.prop : null;
  model = entry.createModel(tunedProp ? { prop: tunedProp } : {});
  // How far the model reaches behind its middle (body axes, before it's
  // placed anywhere): for holding it in a hand launch (handHold).
  const box = new Box3().setFromObject(model.root);
  modelBack = box.isEmpty() ? 0 : Math.max(0, -box.min.x);
  navLights = addNavLights(model, { shine: true });
  planeShadow.setModel(model, entry.def.wingSpan);
  world.scene.add(model.root);
  snowTracks.setModel(model);
}
let navLights = null;

function loadAircraft(id) {
  entry = getAircraft(id);
  settings.aircraft = entry.id;
  // With your own tuning (Menu → Tuning, src/sim/tuning.js) applied.
  aircraft = new Aircraft(tunedDef(entry.def, loadTuning(entry.id)), { ground, wind, obstacles });
  aircraft.assistMode = settings.assist;
  replaceModel();
  rig.setAircraft(entry);
}

/** The tuning changed: rebuild the flight model, carrying on from where it is. */
function retune() {
  const old = aircraft;
  const oldProp = JSON.stringify(old.def.motor.prop);
  aircraft = new Aircraft(tunedDef(entry.def, loadTuning(entry.id)), { ground, wind, obstacles });
  for (const k of ['position', 'velocity', 'orientation', 'omega']) aircraft[k].copy(old[k]);
  for (const k of ['controls', 'servo', 'assistMode', 'throttleActual', 'held', 'crashed', 'crashReason', 'propBroken', 'battery', 'time']) aircraft[k] = old[k];
  for (const part of old.broken) aircraft.broken.add(part);
  aircraft.tow = old.tow; // (the insect net, still on)
  // A different prop: show it.
  if (JSON.stringify(aircraft.def.motor.prop) !== oldProp) replaceModel();
}
// The 3D model files (src/aircraft/models/*.glb) were loaded before this
// module (src/boot.js).
loadAircraft(settings.aircraft);
// A plane chosen by link (?plane=): with its own flight assist.
if (!settings.assist) settings.assist = entry.defaultAssist;
// Checked: an unknown challenge is free flying, an unknown level normal.
if (!MODES[settings.challenge]) settings.challenge = 'none';
if (!LEVELS[settings.challengeLevel]) settings.challengeLevel = 'normal';
saveSettings(settings);

/**
 * The address shows what you're flying, to share or bookmark:
 * ?field=&plane=&challenge=&level= (and &minutes= for the balloon burst),
 * keeping anything else there (a room). Updated as they change.
 */
function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.set('field', LOCATION.id);
  q.set('plane', entry.id);
  const ch = MODES[settings.challenge] && settings.challenge !== 'none' ? settings.challenge : null;
  for (const k of ['challenge', 'level', 'minutes']) q.delete(k);
  if (ch) {
    q.set('challenge', ch);
    q.set('level', settings.challengeLevel);
    if (ch === 'balloons') q.set('minutes', String(settings.balloonMinutes));
  }
  const url = `${location.pathname}?${q.toString()}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url);
}
const osd = new OSD(document.getElementById('osd'));
const sound = new EngineSound();
// Challenges: hoops, balloons, limbo, pylon race, streamer cutting (src/game/).
const challenges = new Challenges({
  scene: world.scene,
  obstacles,
  ground,
  wind,
  sound,
  root: document.getElementById('challenge'),
  marker: document.getElementById('challenge-mark'),
  aircraftId: () => entry.id,
  aircraftDef: () => entry.def,
  // The streamer planes: the loaded models, yours last.
  aircraftTypes: () => {
    const loaded = AIRCRAFT.filter((a) => a.fileScene && a.id !== entry.id);
    return loaded.length ? loaded : [entry];
  },
  makeProxy: (e) => new Aircraft(e.def, { ground }),
  aircraftName: () => entry.name,
});
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
  const day = settings.useClock ? dayOfYear(now) : Number(settings.dayOfYear);
  world.setTime(hours, day);
  world.setSeason(day);
  // Mist and low cloud: as set, or spring and autumn mornings (src/world/mist.js).
  world.setWeather(weatherFor(settings, day, hours));
  // Snow: as set, or some winter days (src/world/snow.js). Lying snow slows
  // the wheels (src/sim/terrain.js).
  // Mountain sites: snow above the snow line for the time of year, and on
  // the field too once the line comes down to it.
  const weatherSnow = snowFor(settings, day, hours);
  const snowLine = snowLineFor(LOCATION.layout.snowLine, settings, day);
  const ground0 = LOCATION.data?.origin?.height ?? 0;
  const snow = { ...weatherSnow, cover: Math.max(weatherSnow.cover, snowAtHeight(ground0, snowLine)) };
  world.setSnow(snow, snowLine.line - ground0, snowLine.aspect);
  setSnowCover(snow.cover);
  // Snowing: the sky is overcast (grey stratocumulus).
  world.setClouds(Math.max(Number(settings.cloudCover), snow.falling > 0 ? 0.75 + 0.25 * snow.falling : 0));
  world.setCloudType(snow.falling > 0 ? 'strato' : settings.cloudType && settings.cloudType !== 'auto' ? settings.cloudType : cloudTypeFor(day, hours));
  // Bare trees and bushes catch less (src/sim/obstacles.js).
  setLeafiness(1 - seasonFor(day).bare);
  renderer.toneMappingExposure = world.exposure;
}
let clockTimer = 0;

function applySettings() {
  aircraft.assistMode = settings.assist;
  // Leaf cards: facing the camera's position (upright) or, the old way, the screen.
  cardUniforms.uFacePos.value = settings.cardsFaceCamera === false ? 0 : 1;
  wind.speed = settings.windSpeed;
  wind.directionDeg = settings.windDir;
  wind.turbulence = settings.turbulence;
  applyTime(); // (and the cloud cover)
  world.setGodRays(settings.godRays === false ? 0 : 1);
  world.setVolumetricClouds(settings.clouds3d !== false);
  sound.volume = settings.volume;
  osd.showHud = settings.showHud;
  const showTouch = settings.touchControls === 'on' || (settings.touchControls === 'auto' && (TOUCH_DEVICE || touchSeen));
  touch.setVisible(showTouch);
  touch.setMode(Number(settings.stickMode));
  if (rig.mode !== settings.cameraMode) rig.setMode(settings.cameraMode);
}

// Your saved start position, per field, kept in this browser (settings):
// { [site]: { saved: { kind, x, y, z, h, speed, wx, wz } } } (world metres,
// heading in radians). kind: 'ground' (sat on the ground), 'air' (flying:
// height y and speed too) or 'hand' (in your hand before a hand launch;
// wx, wz: where you'd walked to from your spot). Start: Saved position
// starts there; X (or Menu -> Flying -> Save position) saves it.
let noSavedSaid = false; // (said once a session)
function savedSpot() {
  const site = settings.startSpots?.[LOCATION.id];
  if (!site) return null;
  // (From before there was one saved position: a ground or hand spot.)
  if (!site.saved && (site.ground || site.hand)) site.saved = site.ground ? { kind: 'ground', ...site.ground } : { kind: 'hand', ...site.hand };
  return site.saved ?? null;
}
/** The world heading the aircraft faces (about the vertical). */
function headingOf(q) {
  const f = new Vector3(1, 0, 0).applyQuaternion(q);
  return Math.atan2(-f.z, f.x);
}
/** Save where the aircraft is now as the start position here, and start there from now on. */
function savePosition() {
  let spot;
  if (aircraft.crashed) {
    toast('Can\'t save a crash: restart first');
    return;
  }
  if (aircraft.held) {
    const h = aircraft.held;
    spot = { kind: 'hand', x: h.pos.x, z: h.pos.z, h: headingOf(h.q), wx: rig.walk.x, wz: rig.walk.z };
  } else if (aircraft.onGround) {
    if (aircraft.velocity.length() > 1) {
      toast('Stop first: the start is saved where the model sits');
      return;
    }
    spot = { kind: 'ground', x: aircraft.position.x, z: aircraft.position.z, h: headingOf(aircraft.orientation) };
  } else {
    const p = aircraft.position;
    spot = { kind: 'air', x: p.x, y: p.y, z: p.z, h: headingOf(aircraft.orientation), speed: Math.max(8, aircraft.velocity.length()) };
  }
  settings.startSpots ||= {};
  settings.startSpots[LOCATION.id] = { saved: spot };
  settings.startMode = 'saved';
  saveSettings(settings);
  toast({ ground: 'Start position saved (on the ground)', air: `Start position saved (in the air, ${Math.round(spot.y - ground.heightAt(spot.x, spot.z))} m up)`, hand: 'Start position saved (in your hand)' }[spot.kind]);
  if (panel?.visible) panel.render();
}
/** What's saved here, in words (for the menu). */
function savedSpotText() {
  const s = savedSpot();
  if (!s) return 'Press X where you want to start (on the ground, in the air, or in your hand) to save a position here.';
  if (s.kind === 'air') return `Saved here: in the air, ${Math.round(s.y - ground.heightAt(s.x, s.z))} m up.`;
  return s.kind === 'hand' ? 'Saved here: in your hand, ready to throw.' : 'Saved here: on the ground.';
}

/**
 * The heading to hand-launch on from (x, z): the one, within 100 degrees
 * of `wanted` (into wind), with the longest climb-out clear of trees and
 * buildings (a gentle 1-in-12 climb from shoulder height, checked to 250 m),
 * favouring headings nearer into wind.
 */
function clearHeading(x, z, wanted) {
  const y0 = ground.heightAt(x, z) + 1.8;
  let best = wanted;
  let bestScore = -1;
  const near = [];
  for (let k = -10; k <= 10; k++) {
    const h = wanted + (k * 10 * Math.PI) / 180;
    const cx = Math.cos(h);
    const cz = -Math.sin(h);
    let clear = 250;
    for (let d = 2; d <= 250; d += 2) {
      const px = x + cx * d;
      const pz = z + cz * d;
      const py = y0 + d / 12;
      if (py < ground.heightAt(px, pz)) {
        clear = d;
        break;
      }
      let hit = false;
      for (const s of obstacles.near(px, pz, 2, near)) {
        if (Obstacles.test(s, px, py, pz)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        clear = d;
        break;
      }
    }
    const score = clear * (0.75 + 0.25 * Math.cos((k * 10 * Math.PI) / 180));
    if (score > bestScore + 1e-6) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

/**
 * Where a hand-launched model is held, from your eye: `fwd` metres ahead
 * (its middle, far enough out that its tail is a third of a metre clear of
 * your face) and `side` to the right. The tail is the furthest back of its
 * contact points and its 3D model, so any aircraft works.
 */
function handHold(def) {
  const contacts = Math.max(0, ...def.contacts.map((c) => -(Array.isArray(c.pos) ? c.pos[0] : c.pos.x)));
  return { fwd: Math.max(0.6, Math.max(contacts, modelBack) + 0.3), side: 0.35 };
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
  rig.walk.x = rig.walk.z = 0; // back at your spot on the flight line
  // Start: Saved position, if there is one here.
  let saved = settings.startMode === 'saved' ? savedSpot() : null;
  if (settings.startMode === 'saved' && !saved && !noSavedSaid) {
    toast('No saved position here yet: starting on the runway. Press X where you want to start.');
    noSavedSaid = true;
  }
  // (Saved in the air: start in the air there, whatever the aircraft.)
  if (saved?.kind === 'air') {
    aircraft.resetInAir(new Vector3(saved.x, saved.y, saved.z), saved.h, saved.speed);
    input.kb.throttle = 0.5;
    saved = 'done';
  }
  if (saved === 'done') {
    // (Started.)
  } else if (settings.startMode === 'air') {
    const [ax, az] = clubToWorld(RUNWAY.x, RUNWAY.z - 10 + lane * 8);
    aircraft.resetInAir(new Vector3(ax, 30 + lane * 4, az), heading, 14);
    input.kb.throttle = 0.5;
  } else if (entry.def.handLaunch) {
    // In the pilot's right hand at the flight line, half a metre ahead,
    // pointing along the runway into wind.
    // Facing the clearest way: from into wind, turned (up to 100 degrees
    // either way) to where it can climb out furthest before any tree.
    const [px, pz] = pilotSpot();
    const ex = px + settings.pilotX + lane * 3;
    const ez = pz + settings.pilotZ;
    // A saved spot: where you'd walked to (a hand-launch one), or out to a
    // ground one (saved with a wheeled model).
    const mine = saved && (saved.kind === 'hand' ? saved : { h: saved.h, wx: saved.x - ex, wz: saved.z - ez });
    // Held out in your right hand at arm's length: its middle far enough
    // ahead that the tail is clear of your face.
    const { fwd, side } = handHold(entry.def);
    const hold = (x, z, h) => aircraft.resetHandLaunch(x + Math.cos(h) * fwd + Math.sin(h) * side, z - Math.sin(h) * fwd + Math.cos(h) * side, h);
    if (mine) {
      // Where you saved it, here.
      rig.walk.x = mine.wx;
      rig.walk.z = mine.wz;
      hold(ex + mine.wx, ez + mine.wz, mine.h);
    } else {
      hold(ex, ez, clearHeading(ex, ez, heading));
    }
  } else if (saved) {
    // Your saved start position here (on the ground; or, saved with a
    // hand-launch model, on the ground where it was in your hand).
    aircraft.resetOnGround(saved.x, saved.z, saved.h);
  } else if (LOCATION.layout.takeoff) {
    // The site's own take-off spot and direction (side by side in multiplayer).
    const t = LOCATION.layout.takeoff;
    const h = Math.PI / 2 - (t.heading * Math.PI) / 180; // compass to the world's heading
    aircraft.resetOnGround(t.x + Math.sin(h) * lane * 4, t.z + Math.cos(h) * lane * 4, h);
  } else {
    const [gx, gz] = clubToWorld(RUNWAY.x - dir * run, RUNWAY.z + lane * 4);
    aircraft.resetOnGround(gx, gz, heading);
  }
  osd.reset();
  challenges.onReset();
  rig.chaseInit = false;
  rig.losInit = false;
}

/** User picked a different model: load it with its default flight assist. */
function selectAircraft(id) {
  loadAircraft(id);
  // Its model file, if not loaded yet: drawn once it has (onModelLoaded).
  loadModelFile(entry.id);
  mp.setInfo(settings.mpName, entry.id);
  settings.assist = entry.defaultAssist;
  applySettings();
  saveSettings(settings);
  resetAircraft();
  if (panel?.visible) panel.render();
  updateSplash();
  syncUrl();
}

// --- Multiplayer -------------------------------------------------------------
const mp = new Multiplayer();
mp.extra = () => challenges.netState();
let mpGraceUntil = 0; // no collisions just after a reset
const peers = new Peers(world.scene, ground);
peers.addShadow = (model, span) => {
  const s = new PlaneShadow(world.scene, ground);
  s.setModel(model, span);
  return s;
};
// AI flyers (Menu → Flying): aeroplanes flown by trained neural networks
// (src/ml/), flying circuits from the runway (taking off and landing into
// wind, as you do) or round the middle of the field. Drawn like other players.
/** Where they take off and land: the runway, or straight into a stronger wind (src/ml/fieldStrip.js). */
function aiStrip() {
  const [px, pz] = pilotSpot();
  return chooseStrip({ windFromDeg: settings.windDir, windSpeed: settings.windSpeed, ground, obstacles, pilot: { x: px, z: pz } });
}
let aiStripNow = aiStrip();
const ai = (() => {
  const [x, z] = clubToWorld(RUNWAY.x, RUNWAY.z);
  const [px, pz] = pilotSpot();
  return new AiFlyers({ ground, wind, obstacles }, { x, z, radius: 150, strip: aiStripNow, pilot: { x: px, z: pz }, windSpeed: settings.windSpeed }, getAircraft);
})();
// You on the runway (rolling, or sat on it): they hold short, or go around.
ai.field.blocked = () => {
  const p = aircraft.position;
  const s = ai.field.strip;
  if (!s) return false;
  return p.y - ground.heightAt(p.x, p.z) < 5 && Math.abs(s.lateral(p)) < s.width / 2 + 4 && Math.abs(s.along(p)) < s.length / 2 + 15;
};
/** The wind changed enough to move their strip: they start again from the pits. */
function updateAiStrip() {
  const s = aiStrip();
  // (Wind speed alone: only if it crosses a model's circuit limit does
  // anything change, but starting again then is simplest.)
  if (sameStrip(s, aiStripNow) && Math.abs(settings.windSpeed - (ai.field.windSpeed ?? 0)) < 1) return;
  aiStripNow = s;
  ai.setStrip(s, settings.windSpeed);
}
function applyAi() {
  ai.set(Number(settings.aiFlyers) || 0, settings.aiAircraft, entry.id).catch((e) => console.warn('AI flyers:', e));
}
const mpBadge = document.getElementById('mp-badge');
const mpToast = document.getElementById('mp-toast');
const mpServer = () => settings.mpServer || ''; // (no built-in server)
function toast(text, ms = 3500) {
  const d = document.createElement('div');
  d.textContent = text;
  mpToast.append(d);
  setTimeout(() => (d.style.opacity = '0'), ms);
  setTimeout(() => d.remove(), ms + 700);
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
  if (type === 'cut') {
    challenges.onCut(p.name, m.side, m.count);
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
  newRoomCode,
  inviteLink: () => `${location.origin}${location.pathname}?room=${encodeURIComponent(mp.baseRoom ?? mp.room)}${LOCATION.data ? `&field=${LOCATION.id}` : ''}${settings.mpServer ? `&server=${encodeURIComponent(settings.mpServer)}` : ''}`,
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
    if (key === 'aircraft' || key === 'aiFlyers' || key === 'aiAircraft') applyAi();
    if (key === 'aiFlyers') panel.render(); // shows or hides the AI aircraft choice
    if (key === 'windDir' || key === 'windSpeed') updateAiStrip();
    if (key === 'location') changeField(value);
    // The scenery is built for these once, so they take effect on a reload.
    if (key === 'graphics' || key === 'viewDistance' || key === 'treeStyle') reloadKeepingRoom();
    if (key === 'googleKey' && googleTiles) {
      // A new key needs a new session.
      world.scene.remove(googleTiles.group);
      googleTiles.dispose();
      googleTiles = null;
    }
    if (key === 'scenery' || key === 'googleKey') applyScenery();
    if (key === 'startMode') resetAircraft();
    if (key === 'challenge' || key === 'challengeLevel' || key === 'balloonMinutes') {
      challenges.setMode(settings.challenge, false);
      challenges.setLevel(settings.challengeLevel, settings.balloonMinutes);
      challenges.restart();
      resetAircraft();
      panel?.render(); // (the tab's options and description depend on the challenge)
      syncUrl();
    }
  },
  onReset: resetAircraft,
  onRestartChallenge: () => {
    challenges.restart();
    resetAircraft();
  },
  challenges: () => challenges,
  hasSavedSpot: () => !!savedSpot(),
  savedSpotText: () => savedSpotText(),
  aircraftEntry: () => entry,
  onRetune: () => retune(),
  onNetRetune: () => challenges.restart(), // (the insect net changed: a new one, and start again)
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
    case 'KeyX':
      savePosition();
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
    case 'KeyF':
      toggleFullscreen();
      break;
    case 'KeyE':
      openEditor();
      break;
    case 'KeyO':
      // Google photorealistic scenery on / off.
      if (googleAvailable()) {
        settings.scenery = settings.scenery === 'google' ? 'built' : 'google';
        saveSettings(settings);
        applyScenery();
        if (panel.visible) panel.render();
      }
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
for (const l of listedLocations(LOCATION.id)) splashField.append(new Option(l.name, l.id));
splashField.value = LOCATION.id;
splashField.addEventListener('change', (e) => changeField(e.target.value));
const splashGraphics = document.getElementById('splash-graphics');
for (const [k, q] of Object.entries(QUALITY)) splashGraphics.append(new Option(q.name, k));
splashGraphics.value = settings.graphics;
const splashChallenge = document.getElementById('splash-challenge');
for (const [k, m] of Object.entries(MODES)) splashChallenge.append(new Option(m.title, k));
splashChallenge.value = MODES[settings.challenge] ? settings.challenge : 'none';
splashChallenge.addEventListener('change', (e) => {
  settings.challenge = e.target.value;
  saveSettings(settings);
  challenges.setMode(settings.challenge, false);
  challenges.restart();
  resetAircraft();
  syncUrl();
});
const splashLevel = document.getElementById('splash-level');
for (const [k, t] of Object.entries(LEVELS)) splashLevel.append(new Option(t, k));
splashLevel.value = LEVELS[settings.challengeLevel] ? settings.challengeLevel : 'normal';
// (No difficulty for free flying.)
const showLevel = () => (splashLevel.style.display = splashChallenge.value === 'none' ? 'none' : '');
showLevel();
splashChallenge.addEventListener('change', showLevel);
splashLevel.addEventListener('change', (e) => {
  settings.challengeLevel = e.target.value;
  saveSettings(settings);
  challenges.setLevel(settings.challengeLevel, settings.balloonMinutes);
  challenges.restart();
  resetAircraft();
  syncUrl();
});
splashGraphics.addEventListener('change', (e) => {
  settings.graphics = e.target.value;
  reloadKeepingRoom();
});
// The selected aircraft turning slowly above its description.
const preview = new AircraftPreview(document.getElementById('splash-preview'));
function updateSplash() {
  if (!splashSelect.isConnected) return;
  splashSelect.value = entry.id;
  splashSummary.textContent = entry.summary;
  if (preview.shown !== entry.id) {
    preview.setAircraft(entry);
    preview.shown = entry.id;
  }
}
updateSplash();
// A model file arriving later (another aircraft chosen, or a peer's): draw it.
onModelLoaded((id) => {
  if (id === entry.id) {
    replaceModel();
    // Still in your hand: held out by the real model's size now it's here.
    if (aircraft.held) resetAircraft();
    preview.shown = null;
    updateSplash();
  }
});
// The other aircraft's models after the start, while you choose or fly.
setTimeout(() => loadModelFiles(), 1500);

document.getElementById('start').addEventListener('click', () => {
  // Phones and tablets: the whole screen (src/ui/fullscreen.js). Asked for
  // here, as the browser only allows it in answer to a tap.
  if (TOUCH_DEVICE && settings.fullscreen !== false) {
    if (canFullscreen()) enterFullscreen();
    else if (isIPhone() && !localStorage.getItem('rcsim.homeScreenTip')) {
      // iPhone Safari has no full screen for pages: the home screen does it.
      setTimeout(() => toast('For full screen on iPhone: tap Share, then Add to Home Screen, and open it from there.', 9000), 1500);
      try {
        localStorage.setItem('rcsim.homeScreenTip', '1');
      } catch {
        /* ignore */
      }
    }
  }
  document.getElementById('splash').remove();
  preview.dispose();
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
challenges.setMode(settings.challenge, false);
challenges.setLevel(settings.challengeLevel, settings.balloonMinutes);
syncUrl();
resetAircraft();
applyAi();
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
  touch.setKeepAwake(aircraft.crashed || aircraft.inFoliage);
  touch.setSticks(!input.gamepadName); // a plugged-in transmitter replaces the thumb sticks
  panel.tick();

  if (!paused) {
    Object.assign(aircraft.controls, ctl);
    // In the hand before a hand launch: the sticks turn you round (roll or
    // rudder) and walk you forward and back (elevator), to aim it clear of
    // the trees. Throttle up throws it, as before.
    if (aircraft.held) {
      const turn = -(ctl.roll + ctl.yaw) * 1.2 * dt; // ~70 deg/s at full stick
      const fwd = new Vector3(1, 0, 0).applyQuaternion(aircraft.held.q).setY(0).normalize();
      const step = -ctl.pitch * 3 * dt; // walking pace
      aircraft.moveHeld(turn, fwd.x * step, fwd.z * step);
      rig.walk.x += fwd.x * step;
      rig.walk.z += fwd.z * step;
      // You turn with it: it stays in your right hand, half a metre ahead.
      if (turn) {
        const eye = rig.pilotEye();
        const p = aircraft.held.pos;
        const dx = p.x - eye.x;
        const dz = p.z - eye.z;
        const c = Math.cos(-turn);
        const s = Math.sin(-turn);
        aircraft.moveHeld(0, eye.x + dx * c - dz * s - p.x, eye.z + dx * s + dz * c - p.z);
      }
    }
    wind.update(dt);
    // Snow on the ground: drag where the airframe ploughs into it (the same
    // points on the model as its tracks: src/world/snowTracks.js).
    if (aircraft.snowSamples !== snowTracks.samples) aircraft.setSnowPoints(snowTracks.samples);
    aircraft.snowDepth = snowDepth(world.snow.cover);
    aircraft.update(dt);
    // Parts that broke off in a crash fly away as debris.
    while (aircraft.breakEvents.length) {
      const ev = aircraft.breakEvents.shift();
      debris.spawn(model.parts?.[ev.part], aircraft, ev.speed);
      snowTracks.setModel(model); // (without the part that came off)
    }
    debris.update(dt);
    ai.update(dt);
    snowTracks.update(aircraft, dt, world.snow, debris.items);
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
  const cockpitCam = fpv && settings.fpvMount === 'cockpit';
  model.setPilotVisible(!cockpitCam, cockpitCam ? entry.views.cockpit : null);
  if (editor.active) editor.update(dt);
  else {
    // Towing (the insect net): the chase camera stands back to see it.
    rig.towReach = aircraft.tow && !aircraft.tow.snapped ? aircraft.tow.cordLength + aircraft.tow.diameter * 2 : 0;
    rig.update(aircraft, dt);
  }
  if (googleTiles?.visible) googleTiles.update(rig.camera, renderer, dt);
  // Other players (after the camera has moved, so their labels line up).
  rig.camera.updateMatrixWorld();
  const solid = !paused && !aircraft.crashed && now / 1000 > mpGraceUntil;
  peers.night = world.night;
  // Aeroplane shadows as dark as the scenery's.
  const shadowDark = world.shadowDarkness();
  peers.shadowCtx = { renderer, lightDir: world.lightDir, strength: shadowDark };
  // (AI flyers are drawn the same way, alongside them.)
  const others = ai.peers.size ? new Map([...mp.peers, ...ai.peers]) : mp.peers;
  const hit = peers.update(others, dt, rig.camera, { aircraft, id: entry.id, solid });
  if (hit) {
    // Mid-air (or on the ground): the part that hit breaks off, and the other
    // player is told so they crash too (their view of us is a little older).
    aircraft.crash(`Collided with ${hit.peer.name}`);
    aircraft.breakAt({ part: hit.sample.part, crashSpeed: 3 }, hit.relSpeed);
    aircraft.velocity.lerp(hit.velocity, 0.5);
    if (hit.peer.ai) ai.hit(hit.peer.id, hit.theirPart, hit.relSpeed);
    else mp.sendHit(hit.peer.id, hit.theirPart, hit.relSpeed);
  }
  challenges.update(dt, { aircraft, entry, camera: rig.camera, paused: paused || editor.active, peers, mp, shadow: { renderer, lightDir: world.lightDir, strength: shadowDark } });
  world.updateShadows();
  world.updateTrees(now / 1000, wind.speed + wind.gust.length() * 0.5, wind.directionDeg);
  world.updateLod(rig.camera.position); // leafy crowns near the camera (src/world/lod.js)
  planeShadow.update(renderer, aircraft.position, world.lightDir, shadowDark);
  world.updateWindsock(wind.at(windsockPos, 0, windTmp), dt, now / 1000);
  if (!paused) world.updateClouds(dt, wind); // (the steady wind: drift aloft)
  world.updateWeather(rig.camera.position, paused ? 0 : dt, windTmp);
  world.updateSnowfall(paused ? 0 : dt, windTmp, rig.camera, renderer.domElement.height);
  world.updateWater(paused ? 0 : dt, windTmp);

  const eye = rig.pilotEye();
  const dist = eye.distanceTo(aircraft.position);
  // Fake RSSI / video quality falls off with range and when low behind terrain.
  rssi = Math.max(0, Math.min(99, Math.round(99 - dist / 8)));
  analog.style.opacity = fpv && settings.fpvAnalog ? String(0.06 + Math.max(0, (dist - 250) / 900)) : '0';

  // In fog, nothing beyond what can be seen is drawn (smoother in thick fog).
  {
    const far = Math.min(20000, world.visibleFar ?? Infinity);
    if (Math.abs(rig.camera.far - far) > 1) {
      rig.camera.far = far;
      rig.camera.updateProjectionMatrix();
    }
  }
  glare.update(rig.camera, world, obstacles, dt, settings.sunGlare !== false && !editor?.active);
  world.renderClouds(renderer, rig.camera); // (3D clouds, High graphics)
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
    challenge: challenges.active,
    assistFlash: (assistFlash = Math.max(0, assistFlash - dt)) > 0,
    vfov: rig.camera.fov,
    tilt: (settings.fpvTilt * Math.PI) / 180,
  });
  sound.update(aircraft, dist, fpv, eye);
}

// Before the Fly button comes on: get the graphics card ready, so the first
// frame isn't one long stall (the page can't redraw until it's done, so the
// loading screen would sit at 100%). The shaders compile in the background
// where the browser can (the loading screen keeps going meanwhile), then
// one frame is drawn behind the start screen: the scenery's shadow map, the
// leafy crowns near you, and everything's first trip to the graphics card.
setStage('Preparing the graphics…', 0);
await nextFrame();
rig.update(aircraft, 0);
rig.camera.updateMatrixWorld();
try {
  await renderer.compileAsync(world.scene, rig.camera);
} catch (e) {
  console.warn('Compiling the shaders ahead failed; they compile on the first frame instead.', e);
}
setStage('Preparing the graphics…', 0.6);
await nextFrame();
world.updateLod(rig.camera.position);
world.updateShadows();
renderer.render(world.scene, rig.camera);
{
  // Wait for the graphics card to have done it: drawing is queued, so
  // without this the work would land on the first frames after Fly comes on.
  const gl = renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}
setStage('Preparing the graphics…', 1);
await nextFrame();
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
  /** AI flyers (src/ml/aiFlyers.js). */
  ai,
  input,
  settings,
  challenges,
  selectAircraft,
  /** Debug: set the time of day (hours). */
  setTime(h) {
    settings.timeOfDay = h;
    settings.useClock = false;
    applyTime();
  },
};
