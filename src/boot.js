// Start-up: pick the flying site, load its baked data (real sites) and the
// chosen aircraft's 3D model file, then start the simulator. The site is fixed for the session; changing it in the
// menu reloads the page with ?field=<id>.
import { LOCATIONS, setLocation, loadSiteData } from './sim/location.js';
import { setStage, nextFrame } from './ui/loading.js';
import { loadSettings, saveSettings } from './ui/settings.js';

const settings = loadSettings();
const asked = new URLSearchParams(location.search).get('field');
const site = LOCATIONS.find((l) => l.id === (asked || settings.location)) || LOCATIONS[0];
if (settings.location !== site.id) saveSettings({ ...settings, location: site.id });

const start = document.getElementById('start');
// Not until the site and the aircraft have loaded.
if (start) start.disabled = true;

// Each stage with its progress (src/ui/loading.js). The site's data and
// the chosen aircraft's model download together; the scenery is built
// after (main.js), then the Fly button comes on.
const progress = { site: site.dataUrl ? 0 : 1, plane: 0 };
const show = () => {
  if (progress.site < 1) setStage(`Loading ${site.name}…`, progress.site);
  else setStage('Loading aircraft…', progress.plane);
};
show();

async function load() {
  const data = await loadSiteData(site, (f) => {
    progress.site = f;
    show();
  });
  if (!data) return null;
  // The ground colour map, decoded before the world is built.
  const img = new Image();
  img.src = `data:image/png;base64,${data.ground.png}`;
  await img.decode();
  data.groundImage = img;
  return data;
}

// The chosen aircraft's model file loads alongside the site (the others
// after the start: main.js), not every one of them.
const models = import('./aircraft/index.js').then((m) => m.loadModelFile(settings.aircraft, (f) => {
  progress.plane = f;
  show();
}));

load()
  .then((data) => setLocation(site.id, data))
  .catch((e) => {
    console.error(e);
    alert(`Could not load ${site.name}; flying at the club field instead.`);
    setLocation('home');
  })
  .then(() => {
    progress.site = 1;
    show();
    return models;
  })
  .then(() => {
    setStage('Building the scenery…', 0);
    return nextFrame().then(() => import('./main.js'));
  })
  .then(() => {
    setStage('Choose your aircraft', null);
    if (start) start.disabled = false;
  });
