// Tracks in the snow: where a wheel, skid, belly or any other part of the
// airframe (wing tip, nose, tail) runs over lying snow it leaves a groove
// behind it, its own width (a fuselage sliding on its belly: a wide one),
// deeper the harder it's pressed. Pieces that break off in a crash leave
// theirs where they tumble and slide, and anything hitting hard leaves a
// dent. Drawn just above the ground: blue-grey shade in the groove, a
// lighter rim of pushed-up snow. Only where snow lies (the same pattern as
// the ground's: src/world/snow.js SNOW_GLSL), and falling snow slowly fills
// them in.
//
// The most recent MAX pieces are kept (a ring), so a long session of
// circuits leaves its tracks until the oldest give way. They go when the
// snow does.
import { BufferGeometry, BufferAttribute, Mesh, MeshLambertMaterial, Vector3, Quaternion, DoubleSide } from 'three';
import { heightAt } from '../sim/terrain.js';
import { addCloudShadows } from './clouds.js';
import { SNOW_GLSL, snowUniforms } from './snow.js';

const MAX = 6000; // pieces (segments and dents)
const STEP = 0.06; // m between track points
const LIFT = 0.006; // m above the ground (and a polygon offset)
// Track width (m) by contact type, unless the contact gives its own
// (trackWidth: a belly, say).
const WIDTH = { wheel: 0.045, skid: 0.02, hard: 0.04 };
// Snow fallen since (arbitrary units: 1 = a few minutes of heavy snow) that
// fills a full-depth track.
const FILL_RATE = 1 / 240;
// Pressed this hard (times its share of the weight... or the whole
// weight) on first touching, a contact leaves a dent.
const DENT_LOAD = 2.5;

const _p = new Vector3();
const _q = new Quaternion();

export class SnowTracks {
  constructor() {
    const pos = new Float32Array(MAX * 4 * 3);
    // across (-1..1), along (-1..1: dents; 0 for tracks), depth (0-1), snow fallen when made
    const track = new Float32Array(MAX * 4 * 4);
    const index = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const geo = new BufferGeometry();
    this.pos = new BufferAttribute(pos, 3);
    this.track = new BufferAttribute(track, 4);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aTrack', this.track);
    const up = new Float32Array(MAX * 4 * 3);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute('normal', new BufferAttribute(up, 3));
    geo.setIndex(new BufferAttribute(index, 1));
    this.geo = geo;
    this.next = 0; // ring slot for the next piece
    this.used = 0;
    this.added = false;
    this.cover = 0;
    this.fallen = { value: 0 }; // snow fallen so far (for filling in)
    this.state = new Map(); // per thing pressing: where its track last ended

    const mat = addCloudShadows(new MeshLambertMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide, // (either way round, by the direction of travel)
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }));
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      Object.assign(shader.uniforms, snowUniforms);
      shader.uniforms.uFallen = this.fallen;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aTrack;\nvarying vec4 vTrack;\nvarying vec2 vTrackXZ;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vTrack = aTrack;
          vTrackXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uSnow;
          uniform float uFallen;
          varying vec4 vTrack;
          varying vec2 vTrackXZ;
          ${SNOW_GLSL}`)
        .replace('#include <map_fragment>', /* glsl */ `
          {
            // Only where snow lies (as the ground draws it).
            float n = snPatch(vTrackXZ);
            float lie = smoothstep(-0.05, 0.05, n - snowThreshold(uSnow));
            // Filled in by snow fallen since it was made.
            float depth = vTrack.z * (1.0 - clamp((uFallen - vTrack.w) / (0.4 + vTrack.z), 0.0, 1.0));
            // Across a track; out from the middle of a dent.
            float a = length(vTrack.xy);
            float groove = 1.0 - smoothstep(0.45, 0.8, a);
            float rim = smoothstep(0.55, 0.8, a) * (1.0 - smoothstep(0.85, 1.0, a));
            vec3 snow = snowColour(vTrackXZ, n);
            // In the groove: shaded, bluer; on the rim: a little brighter.
            diffuseColor.rgb = snow * mix(vec3(1.0), vec3(0.66, 0.75, 0.92), groove * depth) * (1.0 + 0.1 * rim * depth);
            diffuseColor.a = lie * depth * max(groove, rim * 0.7);
          }`);
    };
    mat.customProgramCacheKey = () => 'snowTracks';
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // over the ground, under the falling snow
    this.mesh.visible = false;
    this.mesh.userData.kind = 'snowTracks';
  }

  /** Remove every track (the snow changed). */
  clear() {
    this.pos.array.fill(0);
    this.track.array.fill(0);
    this.pos.needsUpdate = true;
    this.track.needsUpdate = true;
    this.next = 0;
    this.used = 0;
    this.state.clear();
    this.mesh.visible = false;
  }

  /**
   * Something (`key`: a contact, a piece of wreckage) pressing into the snow
   * at (x, z): its track carries on from where it last was.
   * @param {object} key
   * @param {number} half   half its width (m)
   * @param {number} depth  0-1
   */
  press(key, x, z, half, depth) {
    if (!(this.cover > 0.01)) return;
    const s = this.state.get(key);
    if (!s || Math.hypot(x - s.x, z - s.z) > 5) {
      // Touching down (or moved a long way at once: reset, carried): start here.
      this.state.set(key, { x, z, lx: null, lz: 0, rx: 0, rz: 0, depth });
      return;
    }
    const dx = x - s.x;
    const dz = z - s.z;
    const d = Math.hypot(dx, dz);
    s.depth = Math.max(s.depth, depth); // (the hardest press since the last point)
    if (d < STEP) return;
    // Across the direction of travel.
    const nx = -dz / d;
    const nz = dx / d;
    const lx = x + nx * half;
    const lz = z + nz * half;
    const rx = x - nx * half;
    const rz = z - nz * half;
    // Start where the last segment ended (no gaps at bends).
    const first = s.lx == null;
    this.#piece(
      first ? s.x + nx * half : s.lx, first ? s.z + nz * half : s.lz,
      first ? s.x - nx * half : s.rx, first ? s.z - nz * half : s.rz,
      lx, lz, rx, rz, s.depth, 0, 0,
    );
    Object.assign(s, { x, z, lx, lz, rx, rz, depth });
  }

  /** It's left the snow (its next touch starts a new track). */
  lift(key) {
    this.state.delete(key);
  }

  /** A dent of radius r (m) at (x, z), depth 0-1: something hitting hard. */
  dent(x, z, r, depth = 1) {
    if (!(this.cover > 0.01)) return;
    // A square laid out from the middle (the shader rounds it).
    this.#piece(x - r, z + r, x + r, z + r, x - r, z - r, x + r, z - r, depth, -1, 1);
  }

  /**
   * Every frame, after the flight model has moved.
   * @param {object} aircraft  flight model (position, orientation, contacts, mass)
   * @param {number} dt
   * @param {{ cover: number, falling: number }} snow
   * @param {object[]} [debris]  pieces broken off (src/view/debris.js items: touch, thud)
   */
  update(aircraft, dt, snow, debris = []) {
    this.cover = snow.cover;
    this.fallen.value += snow.falling * dt * FILL_RATE;
    if (!(snow.cover > 0.01)) {
      // No snow: nothing to leave tracks in (and none left from before).
      if (this.used) this.clear();
      return;
    }
    if (aircraft) {
      _q.copy(aircraft.orientation);
      const weight = (aircraft.mass || 1) * 9.81;
      for (const c of aircraft.contacts) {
        if (c.type === 'prop' || !c.onGround || aircraft.held) {
          this.lift(c);
          continue;
        }
        _p.copy(c.pos).applyQuaternion(_q).add(aircraft.position);
        const half = (c.trackWidth ?? WIDTH[c.type] ?? 0.04) / 2;
        const press = c.load / weight;
        // Touching down hard: a dent first.
        if (!this.state.has(c) && press > DENT_LOAD) this.dent(_p.x, _p.z, half * 2.2, 1);
        // Deeper the harder it's pressed (its share of the weight, or more).
        this.press(c, _p.x, _p.z, half, Math.min(1, Math.max(0.3, 0.3 + press * 0.9)));
      }
    }
    // Wreckage: a groove where each piece slides or rolls, a dent where it lands hard.
    for (const it of debris) {
      if (it.thud) {
        this.dent(it.thud.x, it.thud.z, it.markHalf * 1.8, 0.9);
        it.thud = null;
      }
      if (it.touch) this.press(it, it.touch.x, it.touch.z, it.markHalf, 0.7);
      else this.lift(it);
    }
    if (this.added) {
      this.added = false;
      this.pos.needsUpdate = true;
      this.track.needsUpdate = true;
      this.mesh.visible = true;
    }
  }

  /** One quad: corners a-left, a-right, b-left, b-right; `along` at a and b (dents). */
  #piece(alx, alz, arx, arz, blx, blz, brx, brz, depth, alongA, alongB) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.used = Math.min(MAX, this.used + 1);
    this.added = true;
    const P = this.pos.array;
    const T = this.track.array;
    const put = (k, x, z, across, along) => {
      const o = (i * 4 + k) * 3;
      P[o] = x;
      P[o + 1] = heightAt(x, z) + LIFT;
      P[o + 2] = z;
      const t = (i * 4 + k) * 4;
      T[t] = across;
      T[t + 1] = along;
      T[t + 2] = depth;
      T[t + 3] = this.fallen.value;
    };
    put(0, alx, alz, 1, alongA);
    put(1, arx, arz, -1, alongA);
    put(2, blx, blz, 1, alongB);
    put(3, brx, brz, -1, alongB);
  }
}
