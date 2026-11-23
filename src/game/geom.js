// Geometry for the challenges (src/game/): did the aeroplane fly through a
// hoop, under a bar, past a line, into a balloon or across a streamer?
// Plain maths on three.js vectors, no rendering, so it can be tested.
import { Vector3, Quaternion } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _qi = new Quaternion();

/**
 * Where the step from `p0` to `p1` crosses the plane through `c` with
 * normal `n`: null if it doesn't, else { t (0..1 along the step), side
 * (+1 crossing along n, -1 against it), point }.
 */
export function crossPlane(p0, p1, c, n, out = new Vector3()) {
  const d0 = _a.copy(p0).sub(c).dot(n);
  const d1 = _b.copy(p1).sub(c).dot(n);
  if ((d0 < 0) === (d1 < 0) || d0 === d1) return null;
  const t = d0 / (d0 - d1);
  out.lerpVectors(p0, p1, t);
  return { t, side: d1 > d0 ? 1 : -1, point: out };
}

/**
 * Through a hoop (centre `c`, axis `n`, inside radius `r`) on this step?
 * Returns 0 (no), +1 / -1 (through, along / against the axis), or 'rim'
 * when it crossed the hoop's plane just outside the opening (within `rim`).
 */
export function throughHoop(p0, p1, c, n, r, rim = 0.4) {
  const x = crossPlane(p0, p1, c, n);
  if (!x) return 0;
  const d = x.point.distanceTo(c);
  if (d < r) return x.side;
  if (d < r + rim) return 'rim';
  return 0;
}

/**
 * Crossing of a 2-D line segment (a to b, in x/z) by the step p0 to p1
 * (in x/z): null, or { t (0..1 along the step), u (0..1 along a-b) }.
 */
export function crossSegment2D(p0x, p0z, p1x, p1z, ax, az, bx, bz) {
  const rx = p1x - p0x;
  const rz = p1z - p0z;
  const sx = bx - ax;
  const sz = bz - az;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = ax - p0x;
  const qz = az - p0z;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Closest distance from point `p` to segment a-b. */
export function pointSegDist(p, a, b) {
  const ab = _a.copy(b).sub(a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? Math.min(1, Math.max(0, _b.copy(p).sub(a).dot(ab) / len2)) : 0;
  return _b.copy(a).addScaledVector(ab, t).distanceTo(p);
}

/**
 * The aeroplane, for touching things, as two flat boxes in its own axes
 * (x nose, y up, z right wing): the wing (span by a chord band) and the
 * fuselage (length by height), each stretched back by `sweep`, the distance
 * flown this frame, so a fast pass can't skip over something thin.
 *   span: wing span (m)
 */
export function bodyShape(span) {
  return {
    halfSpan: span / 2,
    chordFwd: 0.14 * span,
    chordAft: 0.14 * span,
    noseFwd: 0.45 * span,
    tailAft: 0.6 * span,
    bodyDown: 0.08 * span,
    bodyUp: 0.14 * span,
  };
}

/** World point to body axes of a pose { p, q } (into `out`). */
export function toBody(pose, w, out) {
  _qi.copy(pose.q).invert();
  return out.copy(w).sub(pose.p).applyQuaternion(_qi);
}

/**
 * Does the segment a-b (body axes) touch the aeroplane `shape`, swept back
 * by `sweep` metres? Tests the wing's plane (y = 0) and the fuselage's
 * plane (z = 0). Returns the fraction along a-b where it touches, or -1.
 */
export function segmentTouches(shape, a, b, sweep) {
  // The wing plane, y = 0.
  if ((a.y < 0) !== (b.y < 0) && a.y !== b.y) {
    const t = a.y / (a.y - b.y);
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (Math.abs(z) <= shape.halfSpan && x <= shape.chordFwd && x >= -shape.chordAft - sweep) return t;
  }
  // The fuselage plane, z = 0.
  if ((a.z < 0) !== (b.z < 0) && a.z !== b.z) {
    const t = a.z / (a.z - b.z);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (y >= -shape.bodyDown && y <= shape.bodyUp && x <= shape.noseFwd && x >= -shape.tailAft - sweep) return t;
  }
  return -1;
}

/**
 * Does a ball (centre `c` in body axes, radius r) touch the aeroplane
 * `shape`, swept back by `sweep`? A box test, generous on the thin sides.
 */
export function ballTouches(shape, c, r, sweep) {
  const inWing = Math.abs(c.z) <= shape.halfSpan + r && Math.abs(c.y) <= r + 0.04 && c.x <= shape.chordFwd + r && c.x >= -shape.chordAft - sweep - r;
  if (inWing) return true;
  return Math.abs(c.z) <= r + 0.06 && c.y >= -shape.bodyDown - r && c.y <= shape.bodyUp + r && c.x <= shape.noseFwd + r && c.x >= -shape.tailAft - sweep - r;
}
