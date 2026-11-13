// Terrain height field shared by physics and rendering.
//
// The flying field (a ~400 m circle around the pilot) is flat at y = 0;
// beyond it, gentle rolling hills rise towards the horizon.

const FIELD_RADIUS = 260;
const BLEND = 200;

function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * smoothNoise(x * freq, z * freq);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 1.875;
}

export function heightAt(x, z) {
  const r = Math.hypot(x, z + 40);
  if (r < FIELD_RADIUS) return 0;
  const t = Math.min(1, (r - FIELD_RADIUS) / BLEND);
  const blend = t * t * (3 - 2 * t);
  const hills = fbm(x / 220, z / 220) * 55 + fbm(x / 60, z / 60) * 6;
  const far = Math.max(0, (r - 900) / 1200) * 120 * fbm(x / 600 + 7, z / 600 + 3);
  return blend * (hills - 8) + far;
}

export function normalAt(x, z, out) {
  const e = 0.5;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  out.set(-hx, 2 * e, -hz).normalize();
  return out;
}

export const ground = { heightAt, normalAt };
