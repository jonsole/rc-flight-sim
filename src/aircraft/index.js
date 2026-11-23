// Aircraft registry. Each model's settings live in a JSON file in
// src/aircraft/models/ (readable and editable on GitHub): which builder makes
// it ("builder": se5a | buschtrottel | f22 | aeroscout | easystar), its name and summary, and the
// builder's options (units: metres, kilograms, newtons, seconds; angles in
// degrees where the name ends in "Deg"). A "tuning" section holds built-in
// changes in the Tuning tab's terms (src/sim/tuning.js), applied on top.
// Adding a JSON file adds an aircraft. "model": "<file>.glb" names its 3D model
// file in the same folder (glTF, made in Blender: see src/aircraft/fileModel.js).
//
// Each entry: { id, name, summary, defaultAssist, def, geometry, views, createModel(opts) }
import { buildEntry, fromJson } from './defs.js';
import { createFileModel } from './fileModel.js';
import { propModel } from './prop.js';
import { Group } from 'three';

/** Stands in until the model file has loaded (and in tests, which don't load them). */
function emptyModel() {
  return { root: new Group(), parts: {}, update() {}, setPilotVisible() {} };
}

export { fromJson };

/** An aircraft from its JSON file. */
export function buildAircraft(json) {
  const modelFile = json.model;
  const entry = buildEntry(json);
  // The 3D model: its file (loadModelFiles), with the propeller drawn in code
  // at the file's prop marker, so a prop changed in Tuning shows.
  const withFile = {
    ...entry,
    modelFile: modelFile || null,
    fileScene: null,
    /** opts.prop: the prop as tuned ({ diameterIn, pitchIn, blades, tip }); default the model's own. */
    createModel(o = {}) {
      if (!withFile.fileScene) return emptyModel();
      return createFileModel(withFile.fileScene, { propFrom: propModel(o.prop || withFile.def.motor.prop) });
    },
  };
  return withFile;
}

// Every model file, in this order first (the first is the default), then any others.
const ORDER = ['eflite-se5a-900', 'buschtrottel-shockcub', 'buschtrottel-highlander', 'buschtrottel-agro', 'ft-mini-f22', 'hobbyzone-aeroscout', 'multiplex-easystar'];
const files = Object.values(import.meta.glob('./models/*.json', { eager: true, import: 'default' }));
files.sort((a, b) => {
  const ia = ORDER.indexOf(a.id);
  const ib = ORDER.indexOf(b.id);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.id.localeCompare(b.id);
});

export const AIRCRAFT = files.map(buildAircraft);

// Model files (.glb) in the models folder, as URLs to load.
const MODEL_URLS = Object.fromEntries(
  Object.entries(import.meta.glob('./models/*.glb', { eager: true, query: '?url', import: 'default' })).map(([path, url]) => [path.split('/').pop(), url]),
);

let gltf = null;
const loads = new Map(); // aircraft id -> promise of its model file
/**
 * Load one aircraft's model file (once; later calls share it). Resolves
 * true once its model is ready, false if it has none or it failed.
 */
export function loadModelFile(id, onProgress) {
  const a = getAircraft(id);
  if (!loads.has(a.id)) {
    loads.set(a.id, (async () => {
      if (!a.modelFile) return false;
      const url = MODEL_URLS[a.modelFile];
      if (!url) {
        console.warn(`${a.id}: no model file ${a.modelFile} in src/aircraft/models`);
        return false;
      }
      try {
        gltf ||= import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader());
        a.fileScene = (await (await gltf).loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total))).scene;
        sharpenTextures(a.fileScene);
        for (const f of modelListeners) f(a.id);
        return true;
      } catch (e) {
        console.warn(`${a.id}: couldn't load ${a.modelFile}`, e);
        return false;
      }
    })());
  }
  return loads.get(a.id);
}

/**
 * Anisotropic filtering on a model's textures, so printed markings stay sharp
 * seen edge-on and from a distance (a wing at a shallow angle smears without
 * it). three.js caps it to what the GPU allows.
 */
function sharpenTextures(scene) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        if (m?.[k]) m[k].anisotropy = 8;
      }
    }
  });
}

const modelListeners = new Set();
/** Call `f(id)` whenever an aircraft's model file has loaded (to redraw it). */
export function onModelLoaded(f) {
  modelListeners.add(f);
}

/** Load every aircraft's model file. Resolves with the ids now using theirs. */
export async function loadModelFiles() {
  const ok = await Promise.all(AIRCRAFT.map((a) => loadModelFile(a.id)));
  return AIRCRAFT.filter((_, i) => ok[i]).map((a) => a.id);
}

export const DEFAULT_AIRCRAFT_ID = AIRCRAFT[0].id;

export function getAircraft(id) {
  return AIRCRAFT.find((a) => a.id === id) || AIRCRAFT.find((a) => a.id === DEFAULT_AIRCRAFT_ID);
}
