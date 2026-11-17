// Site survey page (survey.html): walk a flying field with a phone and record
// GPS points, lines and photos, then export them to improve the site's layout.
//
// - Record point: stand still; GPS fixes are averaged for a few seconds.
// - Photo: a quick point at the current fix with a photo and compass heading.
// - Walk a line: a vertex every few metres as you walk (fences, hedges, edges).
// Everything is kept in IndexedDB until cleared, and exported as a zip of
// survey.json and the photos.
import { LOCATIONS, loadSiteData } from '../sim/location.js';
import { wgs84ToOsgb, osgbToLocal, averageFixes, distance } from './geo.js';
import { surveyZip } from './export.js';
import { openStore } from './store.js';
import './survey.css';

const $ = (id) => document.getElementById(id);
const LABELS = ['Fence corner', 'Fence', 'Gate', 'Hedge', 'Bush', 'Tree', 'Tree line', 'Pitch end', 'Pilot spot', 'Mown edge', 'Hut', 'Windsock', 'Car park', 'Other'];
const LINE_STEP = 3;     // metres between line vertices
const LINE_MAX_ACC = 15; // ignore worse fixes while walking a line
const PREFS = 'rc-survey-prefs';

const state = {
  features: [],
  fix: null,          // latest GPS fix { lat, lon, acc, alt, time }
  heading: null,      // compass heading, degrees from north
  site: null,         // { id, name, origin, image, ground }
  recording: null,    // { fixes, start, duration, timer }
  line: null,         // { vertices }
  view: { x: 0, z: 0, scale: 2, follow: true },
};

let store;

// ---------- preferences ----------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* not kept */ }
}

// ---------- helpers ----------
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
}
function local(p) {
  const g = wgs84ToOsgb(p.lat, p.lon);
  if (!state.site && !state.originFallback) state.originFallback = g;
  const origin = state.site?.origin || state.originFallback;
  return osgbToLocal(g, origin);
}
function labelText() {
  return $('label').value.trim();
}
function nextName(kind) {
  const n = state.features.filter((f) => f.kind === kind).length + 1;
  return kind === 'line' ? `Line ${n}` : `Point ${n}`;
}

// ---------- screen wake lock ----------
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) {
      await wake.release();
      wake = null;
    }
  } catch { /* not supported or refused */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.recording || state.line)) keepAwake(true);
});

// ---------- GPS ----------
function gpsStatus() {
  const el = $('gps');
  const f = state.fix;
  if (!f) return;
  const age = (Date.now() - f.time) / 1000;
  el.textContent = age > 10 ? `GPS lost (${Math.round(age)} s)` : `GPS ±${fmt(f.acc, 0)} m`;
  el.className = `pill ${age > 10 ? 'bad' : f.acc <= 5 ? 'good' : f.acc <= 12 ? 'ok' : 'bad'}`;
}

function startGps() {
  if (!window.isSecureContext) {
    $('gps').textContent = 'Needs https';
    $('gps').className = 'pill bad';
    return;
  }
  if (!('geolocation' in navigator)) {
    $('gps').textContent = 'No GPS';
    $('gps').className = 'pill bad';
    return;
  }
  navigator.geolocation.watchPosition(onFix, (e) => {
    $('gps').className = 'pill bad';
    $('gps').textContent = e.code === 1 ? 'Location blocked' : 'Waiting for GPS…';
    if (e.code === 1) toast('Allow location for this page (lock icon in the address bar → Permissions).');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  setInterval(gpsStatus, 1000);
}

function onFix(pos) {
  const c = pos.coords;
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, time: pos.timestamp || Date.now() };
  if (state.fix && state.fix.time === fix.time) return;
  state.fix = fix;
  if (!state.site && !state.originFallback) state.originFallback = wgs84ToOsgb(fix.lat, fix.lon);
  if (state.recording) state.recording.fixes.push(fix);
  if (state.line && fix.acc <= LINE_MAX_ACC) {
    const v = state.line.vertices;
    if (!v.length || distance(v[v.length - 1], fix) >= LINE_STEP) {
      v.push({ lat: fix.lat, lon: fix.lon, acc: fix.acc, time: fix.time });
      updateLineStatus();
    }
  }
  if (state.view.follow) {
    const l = local(fix);
    state.view.x = l.x;
    state.view.z = l.z;
  }
  gpsStatus();
  draw();
}

// ---------- compass ----------
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
  if (h === null) return;
  const screenAngle = screen.orientation?.angle || 0;
  state.heading = (h + screenAngle) % 360;
  draw();
}
function startCompass() {
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientation);
  else window.addEventListener('deviceorientation', onOrientation);
}
async function askCompass() {
  // iOS asks for motion permission from a tap.
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') {
    try { await D.requestPermission(); } catch { /* refused */ }
  }
}

// ---------- site ----------
async function chooseSite(id) {
  savePrefs({ site: id });
  const loc = LOCATIONS.find((l) => l.id === id && l.dataUrl);
  if (!loc) {
    state.site = null;
    setFollow(true);
    renderList();
    return;
  }
  $('map-info').textContent = `Loading ${loc.name} map…`;
  try {
    const data = await loadSiteData(loc);
    const image = new Image();
    image.src = `data:image/png;base64,${data.ground.png}`;
    await image.decode();
    state.site = { id: loc.id, name: loc.name, origin: data.origin, ground: data.ground, image };
    $('map-info').textContent = '';
    if (!state.fix) {
      state.view.x = 0;
      state.view.z = 0;
    } else if (state.view.follow) {
      const l = local(state.fix);
      state.view.x = l.x;
      state.view.z = l.z;
    }
  } catch (e) {
    console.error(e);
    state.site = null;
    $('map-info').textContent = `Could not load the ${loc.name} map.`;
  }
  draw();
  renderList();
}

// ---------- map ----------
const canvas = $('map');
const ctx = canvas.getContext('2d');

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  draw();
}

function toScreen(x, z) {
  const { view } = state;
  const dpr = window.devicePixelRatio || 1;
  return [canvas.width / 2 + (x - view.x) * view.scale * dpr, canvas.height / 2 + (z - view.z) * view.scale * dpr];
}

function draw() {
  if (!canvas.width) return;
  const dpr = window.devicePixelRatio || 1;
  const { view } = state;
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--map-bg') || '#ccc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const origin = state.site?.origin || state.originFallback;

  if (state.site) {
    const g = state.site.ground;
    const [sx, sy] = toScreen(g.x0, g.z0);
    ctx.imageSmoothingEnabled = view.scale < 4;
    ctx.drawImage(state.site.image, sx, sy, g.size * view.scale * dpr, g.size * view.scale * dpr);
    // the pilot (site origin)
    const [px, py] = toScreen(0, 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(px - 6 * dpr, py); ctx.lineTo(px + 6 * dpr, py);
    ctx.moveTo(px, py - 6 * dpr); ctx.lineTo(px, py + 6 * dpr);
    ctx.stroke();
  }
  if (!origin) return;

  // scale bar
  const bar = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((m) => m * view.scale >= 60) || 500;
  ctx.fillStyle = '#000a';
  ctx.fillRect(8 * dpr, canvas.height - 26 * dpr, (bar * view.scale + 40) * dpr, 20 * dpr);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(14 * dpr, canvas.height - 12 * dpr);
  ctx.lineTo((14 + bar * view.scale) * dpr, canvas.height - 12 * dpr);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.fillText(`${bar} m`, (18 + bar * view.scale) * dpr, canvas.height - 9 * dpr);

  const lines = [...state.features.filter((f) => f.kind === 'line')];
  if (state.line) lines.push({ vertices: state.line.vertices, live: true });
  for (const f of lines) {
    if (f.vertices.length < 1) continue;
    ctx.strokeStyle = f.live ? '#ff3b30' : '#ffcc00';
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    f.vertices.forEach((v, i) => {
      const l = local(v);
      const [sx, sy] = toScreen(l.x, l.z);
      if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
    });
    ctx.stroke();
  }
  for (const f of state.features) {
    if (f.kind !== 'point') continue;
    const l = local(f);
    const [sx, sy] = toScreen(l.x, l.z);
    ctx.fillStyle = f.id === state.selected ? '#ff3b30' : '#ffcc00';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (view.scale >= 1.5) {
      ctx.font = `${12 * dpr}px system-ui, sans-serif`;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = '#000';
      ctx.strokeText(f.label, sx + 8 * dpr, sy + 4 * dpr);
      ctx.fillStyle = '#fff';
      ctx.fillText(f.label, sx + 8 * dpr, sy + 4 * dpr);
    }
  }

  // you
  const f = state.fix;
  if (f) {
    const l = local(f);
    const [sx, sy] = toScreen(l.x, l.z);
    ctx.fillStyle = '#0a84ff33';
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, f.acc * view.scale * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (state.heading !== null) {
      const a = (state.heading - 90) * Math.PI / 180;
      ctx.fillStyle = '#0a84ffaa';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, 28 * dpr, a - 0.4, a + 0.4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#0a84ff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, 7 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function zoom(k) {
  state.view.scale = Math.min(32, Math.max(0.25, state.view.scale * k));
  savePrefs({ scale: state.view.scale });
  draw();
}

function setFollow(on) {
  state.view.follow = on;
  $('follow').classList.toggle('on', on);
  if (on && state.fix) {
    const l = local(state.fix);
    state.view.x = l.x;
    state.view.z = l.z;
  }
  draw();
}

// drag to pan, pinch to zoom
const pointers = new Map();
let pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: state.view.scale };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 2 && pinch) {
    p.x = e.clientX; p.y = e.clientY;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    state.view.scale = Math.min(32, Math.max(0.25, pinch.scale * d / pinch.d));
    draw();
    return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (Math.abs(dx) + Math.abs(dy) < 1) return;
  p.x = e.clientX; p.y = e.clientY;
  if (state.view.follow) setFollow(false);
  state.view.x -= dx / state.view.scale;
  state.view.z -= dy / state.view.scale;
  draw();
});
const up = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) {
    if (pinch) savePrefs({ scale: state.view.scale });
    pinch = null;
  }
};
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });

// ---------- recording a point ----------
function setBusy(busy) {
  for (const id of ['rec', 'photo', 'line', 'export', 'clear']) $(id).disabled = busy;
}

function startRecording() {
  if (!state.fix) { toast('Waiting for a GPS fix first.'); return; }
  const duration = Number($('dur').value) * 1000;
  const r = { fixes: state.fix && Date.now() - state.fix.time < 2000 ? [state.fix] : [], start: Date.now(), duration };
  state.recording = r;
  keepAwake(true);
  setBusy(true);
  $('progress').hidden = false;
  r.timer = setInterval(() => {
    const t = Date.now() - r.start;
    $('bar').style.width = `${Math.min(100, (100 * t) / r.duration)}%`;
    const avg = averageFixes(r.fixes);
    $('prog-text').textContent = `Hold still… ${Math.ceil(Math.max(0, r.duration - t) / 1000)} s · ${r.fixes.length} fixes${avg ? ` · ±${fmt(avg.acc, 0)} m, wander ${fmt(avg.spread)} m` : ''}`;
    if (t >= r.duration) finishRecording();
  }, 250);
}

async function finishRecording(cancel = false) {
  const r = state.recording;
  if (!r) return;
  clearInterval(r.timer);
  state.recording = null;
  keepAwake(false);
  setBusy(false);
  $('progress').hidden = true;
  $('bar').style.width = '0';
  if (cancel) return;
  const avg = averageFixes(r.fixes);
  if (!avg) { toast('No usable GPS fixes; try again in the open.'); return; }
  const alts = r.fixes.map((f) => f.alt).filter(Number.isFinite);
  const f = {
    id: uid(), kind: 'point', label: labelText() || nextName('point'), note: '', time: Date.now(),
    lat: avg.lat, lon: avg.lon, acc: avg.acc, spread: avg.spread, n: avg.n,
    alt: alts.length ? alts.reduce((s, v) => s + v, 0) / alts.length : null,
    photos: [],
  };
  await addFeature(f);
  toast(`Saved "${f.label}" (±${fmt(avg.acc, 0)} m, ${avg.n} fixes)`);
}

// ---------- walking a line ----------
function updateLineStatus() {
  const v = state.line.vertices;
  let len = 0;
  for (let i = 1; i < v.length; i++) len += distance(v[i - 1], v[i]);
  $('prog-text').textContent = `Walking a line: ${v.length} points, ${fmt(len, 0)} m. Tap Finish at the end.`;
}

async function toggleLine() {
  if (!state.line) {
    if (!state.fix) { toast('Waiting for a GPS fix first.'); return; }
    state.line = { vertices: [] };
    if (state.fix.acc <= LINE_MAX_ACC) state.line.vertices.push({ lat: state.fix.lat, lon: state.fix.lon, acc: state.fix.acc, time: state.fix.time });
    keepAwake(true);
    for (const id of ['rec', 'photo', 'export', 'clear']) $(id).disabled = true;
    $('line').textContent = 'Finish line';
    $('line').classList.add('primary');
    $('progress').hidden = false;
    $('bar').style.width = '100%';
    updateLineStatus();
    draw();
    return;
  }
  const v = state.line.vertices;
  if (state.fix && state.fix.acc <= LINE_MAX_ACC && (!v.length || distance(v[v.length - 1], state.fix) > 0.5)) {
    v.push({ lat: state.fix.lat, lon: state.fix.lon, acc: state.fix.acc, time: state.fix.time });
  }
  state.line = null;
  keepAwake(false);
  setBusy(false);
  $('line').textContent = 'Walk a line';
  $('line').classList.remove('primary');
  $('progress').hidden = true;
  $('bar').style.width = '0';
  if (v.length < 2) { toast('Line too short; not saved.'); draw(); return; }
  const f = { id: uid(), kind: 'line', label: labelText() || nextName('line'), note: '', time: Date.now(), vertices: v, photos: [] };
  await addFeature(f);
  toast(`Saved line "${f.label}" (${v.length} points)`);
}

// ---------- photos ----------
let photoTarget = null; // { featureId } or { fix, heading } for a new point

function takePhoto(featureId = null) {
  if (!featureId && !state.fix) { toast('Waiting for a GPS fix first.'); return; }
  photoTarget = featureId ? { featureId, heading: state.heading } : { fix: state.fix, heading: state.heading, label: labelText() };
  savePending(photoTarget);
  $('cam').value = '';
  $('cam').click();
}

// The camera app can push the page out of memory; remember what the photo was for.
function savePending(p) {
  try { sessionStorage.setItem('rc-survey-pending', JSON.stringify(p)); } catch { /* not kept */ }
}
function loadPending() {
  try { return JSON.parse(sessionStorage.getItem('rc-survey-pending')); } catch { return null; }
}

async function shrink(file, max = 2048) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
}

$('cam').addEventListener('change', async () => {
  const file = $('cam').files[0];
  const target = photoTarget || loadPending();
  photoTarget = null;
  savePending(null);
  if (!file || !target) return;
  let blob;
  try { blob = await shrink(file); } catch (e) { console.error(e); blob = file; }
  const photo = { id: uid(), time: Date.now(), heading: Number.isFinite(target.heading) ? target.heading : null };
  await store.put('photos', { id: photo.id, blob });
  let f = target.featureId && state.features.find((x) => x.id === target.featureId);
  if (f) {
    f.photos.push(photo);
    await store.put('features', f);
    renderList();
    toast(`Photo added to "${f.label}"`);
    return;
  }
  const fix = target.fix;
  f = {
    id: uid(), kind: 'point', label: target.label || nextName('point'), note: '', time: Date.now(),
    lat: fix.lat, lon: fix.lon, acc: fix.acc, spread: 0, n: 1, alt: fix.alt, photos: [photo],
  };
  await addFeature(f);
  toast(`Saved photo point "${f.label}" (±${fmt(fix.acc, 0)} m)`);
});

// ---------- the list ----------
async function addFeature(f) {
  state.features.push(f);
  await store.put('features', f);
  renderList();
  draw();
}

async function removeFeature(f) {
  if (!confirm(`Delete "${f.label}"?`)) return;
  for (const p of f.photos) await store.remove('photos', p.id);
  await store.remove('features', f.id);
  state.features = state.features.filter((x) => x.id !== f.id);
  renderList();
  draw();
}

async function editFeature(f) {
  const label = prompt('What is it?', f.label);
  if (label === null) return;
  const note = prompt('Note (height, type, anything useful)', f.note || '');
  f.label = label.trim() || f.label;
  if (note !== null) f.note = note.trim();
  await store.put('features', f);
  renderList();
  draw();
}

const thumbs = new Map(); // photo id -> object URL

async function thumb(id) {
  if (!thumbs.has(id)) {
    const p = await store.get('photos', id);
    if (!p) return null;
    thumbs.set(id, URL.createObjectURL(p.blob));
  }
  return thumbs.get(id);
}

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('count').textContent = state.features.length;
  const items = [...state.features].sort((a, b) => b.time - a.time);
  for (const f of items) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'item-head';
    const title = document.createElement('strong');
    title.textContent = f.label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const at = f.kind === 'line' ? f.vertices[0] : f;
    const l = local(at);
    const where = state.site ? `x ${fmt(l.x, 0)}, z ${fmt(l.z, 0)} m` : `${fmt(at.lat, 6)}, ${fmt(at.lon, 6)}`;
    if (f.kind === 'line') {
      let len = 0;
      for (let i = 1; i < f.vertices.length; i++) len += distance(f.vertices[i - 1], f.vertices[i]);
      meta.textContent = `line · ${f.vertices.length} pts · ${fmt(len, 0)} m · from ${where}`;
    } else {
      meta.textContent = `±${fmt(f.acc, 0)} m${f.n > 1 ? ` (${f.n} fixes)` : ''} · ${where}`;
    }
    head.append(title, meta);
    if (f.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = f.note;
      head.append(note);
    }
    head.addEventListener('click', () => {
      state.selected = f.id;
      setFollow(false);
      state.view.x = l.x;
      state.view.z = l.z;
      draw();
      canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    const btns = document.createElement('div');
    btns.className = 'item-btns';
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      return b;
    };
    btns.append(mk('📷', 'Add photo', () => takePhoto(f.id)), mk('✎', 'Edit label and note', () => editFeature(f)), mk('🗑', 'Delete', () => removeFeature(f)));
    li.append(head, btns);
    if (f.photos.length) {
      const strip = document.createElement('div');
      strip.className = 'thumbs';
      for (const p of f.photos) {
        const img = document.createElement('img');
        img.alt = `Photo of ${f.label}`;
        thumb(p.id).then((u) => { if (u) img.src = u; });
        strip.append(img);
      }
      li.append(strip);
    }
    ul.append(li);
  }
  $('empty').hidden = state.features.length > 0;
}

// ---------- export ----------
async function exportZip() {
  if (!state.features.length) { toast('Nothing recorded yet.'); return; }
  const photos = new Map();
  for (const f of state.features) {
    for (const p of f.photos) {
      const rec = await store.get('photos', p.id);
      if (rec) photos.set(p.id, new Uint8Array(await rec.blob.arrayBuffer()));
    }
  }
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = `survey-${state.site?.id || 'gps'}-${stamp}.zip`;
  const zip = surveyZip(state.features, state.site, photos, now);
  const file = new File([zip], name, { type: 'application/zip' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'RC flight sim site survey' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Saved ${name} (${fmt(zip.length / 1e6)} MB)`);
}

async function clearAll() {
  if (!state.features.length) return;
  if (!confirm(`Delete all ${state.features.length} recorded items and their photos? Export first if you want to keep them.`)) return;
  await store.clear('features');
  await store.clear('photos');
  for (const u of thumbs.values()) URL.revokeObjectURL(u);
  thumbs.clear();
  state.features = [];
  renderList();
  draw();
}

// ---------- start ----------
async function init() {
  store = await openStore();
  if (!store.persistent) $('storage-note').textContent = 'This browser is not saving data for this page: export before you close it.';
  state.features = await store.all('features');

  const prefs = loadPrefs();
  if (prefs.scale) state.view.scale = prefs.scale;
  if (prefs.duration) $('dur').value = String(prefs.duration);

  const sel = $('site');
  for (const l of LOCATIONS.filter((x) => x.dataUrl)) sel.add(new Option(l.name, l.id));
  sel.add(new Option('No site (GPS only)', ''));
  sel.value = prefs.site ?? LOCATIONS.find((x) => x.dataUrl)?.id ?? '';
  sel.addEventListener('change', () => chooseSite(sel.value));

  const chips = $('chips');
  for (const t of LABELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.addEventListener('click', () => {
      $('label').value = t;
      for (const c of chips.children) c.classList.toggle('on', c === b);
    });
    chips.append(b);
  }
  $('label').addEventListener('input', () => {
    for (const c of chips.children) c.classList.toggle('on', c.textContent === $('label').value);
  });

  $('rec').addEventListener('click', () => { askCompass(); startRecording(); });
  $('stop').addEventListener('click', () => (state.line ? toggleLine() : finishRecording()));
  $('cancel').addEventListener('click', () => {
    if (state.line) {
      if (!confirm('Throw away this line?')) return;
      state.line.vertices.length = 0;
      toggleLine();
    } else finishRecording(true);
  });
  $('photo').addEventListener('click', () => { askCompass(); takePhoto(); });
  $('line').addEventListener('click', toggleLine);
  $('dur').addEventListener('change', () => savePrefs({ duration: Number($('dur').value) }));
  $('export').addEventListener('click', exportZip);
  $('clear').addEventListener('click', clearAll);
  $('zin').addEventListener('click', () => zoom(1.5));
  $('zout').addEventListener('click', () => zoom(1 / 1.5));
  $('follow').addEventListener('click', () => setFollow(true));
  $('pilot').addEventListener('click', () => {
    setFollow(false);
    state.view.x = 0;
    state.view.z = 0;
    draw();
  });

  window.addEventListener('resize', resize);
  resize();
  renderList();
  startGps();
  startCompass();
  await chooseSite(sel.value);
}

init();
