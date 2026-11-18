// Tracks in the snow: where a wheel, skid or the airframe (belly, wing
// tip, tail) runs over lying snow it leaves a groove behind it, the width of
// the wheel or skid, deeper the harder it's pressed (a heavy landing, a
// belly slide). Drawn just above the ground as strips: blue-grey shade in
// the groove, a lighter rim of pushed-up snow. Only where snow lies (the
// same pattern as the ground's: src/world/snow.js SNOW_GLSL), and falling
// snow slowly fills them in.
//
// The most recent MAX segments are kept (a ring), so a long session of
// circuits leaves its tracks until the oldest give way.
import { BufferGeometry, BufferAttribute, Mesh, MeshLambertMaterial, Vector3, Quaternion, DoubleSide } from 'three';
import { heightAt } from '../sim/terrain.js';
import { addCloudShadows } from './clouds.js';
import { SNOW_GLSL, snowUniforms } from './snow.js';

const MAX = 6000; // segments
const STEP = 0.06; // m between track points
const LIFT = 0.006; // m above the ground (and a polygon offset)
// Track width (m) by contact type, unless the contact gives one (trackWidth).
const WIDTH = { wheel: 0.045, skid: 0.02, hard: 0.06 };
// Snow fallen since (arbitrary units: 1 = a few minutes of heavy snow) that
// fills a full-depth track.
const FILL_RATE = 1 / 240;

const _p = new Vector3();
const _q = new Quaternion();

export class SnowTracks {
  constructor() {
    const pos = new Float32Array(MAX * 4 * 3);
    const track = new Float32Array(MAX * 4 * 3); // across (-1..1), depth (0-1), snow fallen when made
    const index = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const geo = new BufferGeometry();
    this.pos = new BufferAttribute(pos, 3);
    this.track = new BufferAttribute(track, 3);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aTrack', this.track);
    const up = new Float32Array(MAX * 4 * 3);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute('normal', new BufferAttribute(up, 3));
    geo.setIndex(new BufferAttribute(index, 1));
    this.geo = geo;
    this.next = 0; // ring slot for the next segment
    this.used = 0;
    this.fallen = { value: 0 }; // snow fallen so far (for filling in)
    this.state = new Map(); // per contact: { x, z, lx, lz, rx, rz } where its track last ended

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
        .replace('#include <common>', '#include <common>\nattribute vec3 aTrack;\nvarying vec3 vTrack;\nvarying vec2 vTrackXZ;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vTrack = aTrack;
          vTrackXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uSnow;
          uniform float uFallen;
          varying vec3 vTrack;
          varying vec2 vTrackXZ;
          ${SNOW_GLSL}`)
        .replace('#include <map_fragment>', /* glsl */ `
          {
            // Only where snow lies (as the ground draws it).
            float n = snPatch(vTrackXZ);
            float lie = smoothstep(-0.05, 0.05, n - snowThreshold(uSnow));
            // Filled in by snow fallen since it was made.
            float depth = vTrack.y * (1.0 - clamp((uFallen - vTrack.z) / (0.4 + vTrack.y), 0.0, 1.0));
            float a = abs(vTrack.x);
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
   * Every frame, after the flight model has moved.
   * @param {object} aircraft  flight model (position, orientation, contacts, mass)
   * @param {number} dt
   * @param {{ cover: number, falling: number }} snow
   */
  update(aircraft, dt, snow) {
    this.fallen.value += snow.falling * dt * FILL_RATE;
    if (!(snow.cover > 0.01)) {
      // No snow: nothing to leave tracks in (and none left from before).
      if (this.used) this.clear();
      return;
    }
    if (!aircraft) return;
    _q.copy(aircraft.orientation);
    const weight = (aircraft.mass || 1) * 9.81;
    let added = false;
    for (const c of aircraft.contacts) {
      if (c.type === 'prop' || !c.onGround || aircraft.held) {
        this.state.delete(c);
        continue;
      }
      _p.copy(c.pos).applyQuaternion(_q).add(aircraft.position);
      const x = _p.x;
      const z = _p.z;
      const half = (c.trackWidth ?? WIDTH[c.type] ?? 0.04) / 2;
      // Deeper the harder it's pressed (its share of the weight, or more).
      const depth = Math.min(1, Math.max(0.3, 0.3 + (c.load / weight) * 0.9));
      const s = this.state.get(c);
      if (!s) {
        this.state.set(c, { x, z, lx: null, lz: 0, rx: 0, rz: 0, depth });
        continue;
      }
      const dx = x - s.x;
      const dz = z - s.z;
      const d = Math.hypot(dx, dz);
      if (d > 5) {
        // Jumped (reset, or moved by hand): start afresh here.
        this.state.set(c, { x, z, lx: null, lz: 0, rx: 0, rz: 0, depth });
        continue;
      }
      s.depth = Math.max(s.depth, depth); // (the hardest press since the last point)
      if (d < STEP) continue;
      // Across the direction of travel.
      const nx = -dz / d;
      const nz = dx / d;
      const lx = x + nx * half;
      const lz = z + nz * half;
      const rx = x - nx * half;
      const rz = z - nz * half;
      // Start where the last segment ended (no gaps at bends).
      const slx = s.lx ?? s.x + nx * half;
      const slz = s.lx == null ? s.z + nz * half : s.lz;
      const srx = s.lx == null ? s.x - nx * half : s.rx;
      const srz = s.lx == null ? s.z - nz * half : s.rz;
      this.#segment(slx, slz, srx, srz, lx, lz, rx, rz, s.depth);
      added = true;
      Object.assign(s, { x, z, lx, lz, rx, rz, depth });
    }
    if (added) {
      this.pos.needsUpdate = true;
      this.track.needsUpdate = true;
      this.mesh.visible = true;
    }
  }

  #segment(alx, alz, arx, arz, blx, blz, brx, brz, depth) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.used = Math.min(MAX, this.used + 1);
    const P = this.pos.array;
    const T = this.track.array;
    const o = i * 12;
    const put = (k, x, z, across) => {
      P[o + k * 3] = x;
      P[o + k * 3 + 1] = heightAt(x, z) + LIFT;
      P[o + k * 3 + 2] = z;
      T[o + k * 3] = across;
      T[o + k * 3 + 1] = depth;
      T[o + k * 3 + 2] = this.fallen.value;
    };
    put(0, alx, alz, 1);
    put(1, arx, arz, -1);
    put(2, blx, blz, 1);
    put(3, brx, brz, -1);
  }
}
