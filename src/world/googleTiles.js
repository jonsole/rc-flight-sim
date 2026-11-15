// Google Photorealistic 3D Tiles as the scenery at a real site (optional:
// Menu → View → Graphics → Scenery, with your own Google Maps Platform API
// key). Only the look comes from Google: the ground, trees, buildings and
// fences the aircraft hits, and the wind, still come from the baked site data
// (src/sim), which lines up with the real place.
//
// The tiles are placed with the site's pilot spot at the origin, east +x,
// north -z, and then levelled so the ground under the pilot is at y = 0, as
// the baked terrain is. Google's logo and data credits are shown on screen
// whenever the tiles are, as their terms require.
import { Raycaster, Vector3, MathUtils, Group } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin, TileCompressionPlugin, UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins';

const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const LOGO_URL = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';
// How much screen-space error (pixels) the tiles may show, by graphics quality.
const ERROR_TARGET = { low: 24, medium: 14, high: 8 };
const ROOT_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
// Height of the geoid above the WGS84 ellipsoid in eastern England (m): the
// tiles are placed this much plus the site's ground height (above mean sea
// level) up, then levelled exactly once the ground under the pilot loads.
const GEOID_UK_EAST = 46;

export class GoogleTiles {
  /**
   * @param {{ apiKey: string, lat: number, lon: number, groundHeight?: number, trueNorth?: number,
   *   quality: string, creditEl: HTMLElement }} opts
   *   lat/lon in degrees of the pilot spot; groundHeight: its height above
   *   sea level (m); trueNorth: bearing of true north from the sim's north
   *   (grid north), degrees
   */
  constructor({ apiKey, lat, lon, groundHeight = 0, trueNorth = 0, quality, creditEl }) {
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true, logoUrl: LOGO_URL }));
    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    tiles.registerPlugin(new ReorientationPlugin({
      lat: MathUtils.degToRad(lat), lon: MathUtils.degToRad(lon), height: groundHeight + GEOID_UK_EAST, recenter: true,
    }));
    tiles.errorTarget = ERROR_TARGET[quality] ?? ERROR_TARGET.medium;
    // Something failed: ask Google why (only then: each root request is a
    // billable Google session, so there's no separate check up front).
    tiles.addEventListener('load-error', (e) => {
      if (this.error || this.checking) return;
      this.checking = true;
      this.#showError(`Google 3D tiles: ${String(e?.error?.message ?? e?.error ?? 'load error')}`);
      this.#checkKey(apiKey);
    });
    // Each root tileset load starts a Google session (what Google bills).
    tiles.addEventListener('load-root-tileset', () => countGoogleSession());
    // See-through tiles (editor): applied to each tile as it loads.
    this.opacity = 1;
    tiles.addEventListener('load-model', ({ scene }) => this.#fade(scene));
    this.tiles = tiles;
    // The plugin puts the pilot spot at the origin with +y up, +z north and
    // +x west; the sim has -z (grid) north and +x east: turn half round, and
    // by the grid's angle to true north.
    this.group = new Group();
    this.group.rotation.y = Math.PI - MathUtils.degToRad(trueNorth);
    this.group.add(tiles.group);
    this.creditEl = creditEl;
    this.levelled = false;
    this.levelTimer = 0;
    this.creditTimer = 0;
    this._ray = new Raycaster(new Vector3(0, 2000, 0), new Vector3(0, -1, 0), 0, 5000);
  }

  /** Every frame, after the camera has moved. */
  update(camera, renderer, dt) {
    const t = this.tiles;
    t.setCamera(camera);
    t.setResolutionFromRenderer(camera, renderer);
    camera.updateMatrixWorld();
    t.update();
    // Level the tiles: put the ground under the pilot at y = 0, once the
    // detailed tiles there have loaded (re-checked for the first while, as
    // finer tiles arrive).
    if ((this.levelTimer -= dt) <= 0 && this.levelChecks !== 0) {
      this.levelTimer = 2;
      this.levelChecks = (this.levelChecks ?? 90) - 1;
      this.group.updateMatrixWorld(true);
      this._ray.ray.origin.set(0, 2000, 0);
      const hit = this._ray.intersectObject(this.group, true)[0];
      if (hit) {
        this.group.position.y -= hit.point.y;
        this.levelled = true;
      }
    }
    if (!this.error && (this.creditTimer -= dt) <= 0) {
      this.creditTimer = 2;
      this.#credits();
    }
  }

  /**
   * Ask Google for the tileset once ourselves, so that if the key is refused
   * the reason Google gives is shown (and stays) on screen.
   */
  async #checkKey(apiKey) {
    try {
      const r = await fetch(`${ROOT_URL}?key=${encodeURIComponent(apiKey)}`);
      if (r.ok) return; // the key is fine: keep the error the tiles gave
      let why = '';
      try {
        why = (await r.json())?.error?.message ?? '';
      } catch {
        /* not JSON */
      }
      this.#showError(`Google 3D tiles refused the API key (${r.status}${why ? `: ${why}` : ''}). Check the Map Tiles API is enabled, billing is on, and the key allows this site.`);
    } catch (e) {
      this.#showError(`Google 3D tiles: could not reach Google (${e.message}).`);
    }
  }

  #showError(msg) {
    this.error = msg;
    this.creditEl.textContent = msg;
    this.creditEl.classList.add('error');
    this.creditEl.style.display = 'block';
  }

  /** Google's logo and the data credits of the tiles in view. */
  #credits() {
    const items = this.tiles.getAttributions();
    const text = items.filter((a) => a.type === 'string').map((a) => a.value).join('; ').replace(/[<>&"]/g, '');
    const html = `<img class="g-logo" src="${LOGO_URL}" alt="Google"> ${text}`;
    if (html !== this.lastCredits) {
      this.creditEl.innerHTML = html;
      this.lastCredits = html;
    }
    this.creditEl.style.display = 'block';
  }

  /** Show or hide the tiles (hidden: nothing loads, the session is kept). */
  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
    if (v && this.lastCredits) this.creditEl.style.display = 'block';
    if (!v && !this.error) this.creditEl.style.display = 'none';
  }

  /** How solid the tiles are, 0 (invisible) to 1. */
  setOpacity(v) {
    this.opacity = v;
    this.tiles.group.traverse((o) => this.#fade(o));
  }

  #fade(root) {
    const v = this.opacity;
    root.traverse((o) => {
      if (!o.material) return;
      for (const m of [o.material].flat()) {
        m.transparent = v < 1;
        m.opacity = v;
        m.depthWrite = v >= 1;
      }
    });
  }

  dispose() {
    this.tiles.dispose();
    this.creditEl.style.display = 'none';
  }
}

// Google sessions started from this browser, per calendar month: shown in
// the menu so you can keep an eye on your allowance.
const SESSIONS_KEY = 'rcsim.googleSessions';

export function googleSessions() {
  const month = new Date().toISOString().slice(0, 7);
  try {
    const s = JSON.parse(localStorage.getItem(SESSIONS_KEY));
    if (s?.month === month) return s;
  } catch {
    /* none, or storage blocked */
  }
  return { month, count: 0 };
}

function countGoogleSession() {
  const s = googleSessions();
  s.count++;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}
