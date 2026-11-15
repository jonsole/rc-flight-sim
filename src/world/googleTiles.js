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

export class GoogleTiles {
  /**
   * @param {{ apiKey: string, lat: number, lon: number, trueNorth: number, quality: string,
   *   creditEl: HTMLElement, onError?: (msg: string) => void }} opts
   *   lat/lon in degrees of the pilot spot; trueNorth: bearing of true north
   *   from the sim's north (grid north), degrees
   */
  constructor({ apiKey, lat, lon, trueNorth = 0, quality, creditEl, onError }) {
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true, logoUrl: LOGO_URL }));
    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    tiles.registerPlugin(new ReorientationPlugin({ lat: MathUtils.degToRad(lat), lon: MathUtils.degToRad(lon), height: 0, recenter: true }));
    tiles.errorTarget = ERROR_TARGET[quality] ?? ERROR_TARGET.medium;
    tiles.addEventListener('load-error', (e) => {
      const msg = String(e?.error?.message ?? e?.error ?? 'load error');
      if (!this.errorShown) onError?.(msg);
      this.errorShown = true;
    });
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
      this.levelTimer = 1;
      this.levelChecks = (this.levelChecks ?? 20) - 1;
      this.group.updateMatrixWorld(true);
      this._ray.ray.origin.set(0, 2000, 0);
      const hit = this._ray.intersectObject(this.group, true)[0];
      if (hit) {
        this.group.position.y -= hit.point.y;
        this.levelled = true;
      }
    }
    if ((this.creditTimer -= dt) <= 0) {
      this.creditTimer = 2;
      this.#credits();
    }
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

  dispose() {
    this.tiles.dispose();
    this.creditEl.style.display = 'none';
  }
}
