// Start-up: pick the flying site, load its baked data (real sites) and the
// aircraft's 3D model files, then start the simulator. The site is fixed for the session; changing it in the
// menu reloads the page with ?field=<id>.
import { LOCATIONS, setLocation } from './sim/location.js';
import { loadSettings, saveSettings } from './ui/settings.js';

const settings = loadSettings();
const asked = new URLSearchParams(location.search).get('field');
const site = LOCATIONS.find((l) => l.id === (asked || settings.location)) || LOCATIONS[0];
if (settings.location !== site.id) saveSettings({ ...settings, location: site.id });

const status = document.querySelector('#splash .sub');
const start = document.getElementById('start');
// Not until the site and the aircraft have loaded.
if (start) start.disabled = true;

async function load() {
  if (!site.load) return null;
  if (status) status.textContent = `Loading ${site.name}…`;
  const data = { ...(await site.load()).default };
  // The ground colour map, decoded before the world is built.
  const img = new Image();
  img.src = `data:image/png;base64,${data.ground.png}`;
  await img.decode();
  data.groundImage = img;
  return data;
}

// The aircraft's model files load alongside the site.
const models = import('./aircraft/index.js').then((m) => m.loadModelFiles());

load()
  .then((data) => setLocation(site.id, data))
  .catch((e) => {
    console.error(e);
    alert(`Could not load ${site.name}; flying at the club field instead.`);
    setLocation('home');
  })
  .then(() => {
    if (status) status.textContent = 'Loading aircraft…';
    return models;
  })
  .then(() => import('./main.js'))
  .then(() => {
    if (status) status.textContent = 'Choose your aircraft';
    if (start) start.disabled = false;
  });
