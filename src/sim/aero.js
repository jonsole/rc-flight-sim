// Airfoil / lifting-surface coefficients.
//
// Each surface uses a linear lift curve up to the stall, then blends smoothly
// into flat-plate behaviour so the model stays sane at any angle of attack
// (spins, tail slides, flying backwards after a crash...).

const TWO_PI = Math.PI * 2;

/** 3D lift-curve slope (per radian) from aspect ratio (Helmbold-ish). */
export function liftSlope(aspectRatio) {
  const ar = aspectRatio;
  return (TWO_PI * ar) / (2 + Math.sqrt(4 + ar * ar));
}

/**
 * Lift and drag coefficients at angle of attack `alpha` (radians, any value).
 * @param {number} alpha
 * @param {object} p  { cla, alpha0, alphaStall, cd0, ar, e, stallWidth? }
 * @returns {{cl:number, cd:number, stalled:number}} stalled: 0..1 blend factor
 */
export function coefficients(alpha, p) {
  // Wrap to [-pi, pi]
  let a = alpha;
  if (a > Math.PI) a -= TWO_PI * Math.ceil((a - Math.PI) / TWO_PI);
  if (a < -Math.PI) a += TWO_PI * Math.ceil((-Math.PI - a) / TWO_PI);

  const aLin = a - p.alpha0;
  // Stall blend: 0 = attached flow, 1 = fully separated (flat plate).
  // Stall transition width: ~1° (abrupt) by default; slotted/slatted wings
  // stall later and more gently.
  const width = p.stallWidth ?? 0.018;
  const over = Math.abs(aLin) - p.alphaStall - 1.5 * width;
  const sigma = 1 / (1 + Math.exp(-over / width));

  const clLin = p.cla * aLin;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const clPlate = 0.95 * 2 * s * c;
  const cdPlate = 0.05 + 1.9 * s * s;

  const cl = (1 - sigma) * clLin + sigma * clPlate;
  const cdInduced = (clLin * clLin) / (Math.PI * p.e * p.ar);
  const cd = (1 - sigma) * (p.cd0 + cdInduced) + sigma * cdPlate;
  return { cl, cd, stalled: sigma };
}
