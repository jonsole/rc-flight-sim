// Graphics quality and scenery distance (Menu → View → Graphics).
//
// Most of the cost is trees: a full-detail crown is ~2200 triangles, and a
// real site has thousands. So crowns are full detail only near the pilot
// (where you fly), simple further out, and not drawn at all beyond the
// scenery distance. Collisions and wind still use every tree.
//
//   pixelRatio   cap on the screen resolution (device pixels per CSS pixel)
//   shadowMap    scenery shadow map size
//   nearRadius   trees within this of the pilot get full-detail crowns (m)
//   nearDetail   crown detail for them (2 full, 1 medium, 0 low)
//   farDetail    crown detail for the rest ('blob': one ~80-triangle lump)
//   bushDetail   crown detail for bushes and hedges further out (or 'blob')
//   bushNear     ...and near the pilot (within nearRadius, at most 250 m)
//   bushDistance bushes further than this aren't drawn (m; they still catch you)

export const QUALITY = {
  low: { name: 'Low (phones)', pixelRatio: 1, shadowMap: 1024, nearRadius: 150, nearDetail: 1, farDetail: 'blob', bushDetail: 'blob', bushNear: 'blob', bushDistance: 300 },
  medium: { name: 'Medium', pixelRatio: 1.5, shadowMap: 2048, nearRadius: 250, nearDetail: 2, farDetail: 'blob', bushDetail: 'blob', bushNear: 0, bushDistance: 600 },
  high: { name: 'High', pixelRatio: 2, shadowMap: 4096, nearRadius: 500, nearDetail: 2, farDetail: 0, bushDetail: 'blob', bushNear: 1, bushDistance: 1000 },
};

/** Scenery distance choices (m); 0 = as far as there is scenery. */
export const DISTANCES = { 500: '500 m', 1000: '1 km', 2000: '2 km', 0: 'Unlimited' };

/** The preset for the settings (an unknown name falls back to medium). */
export function qualityPreset(settings) {
  return QUALITY[settings.graphics] ?? QUALITY.medium;
}

/** How far scenery is drawn (m) for the settings. */
export function viewDistance(settings) {
  const d = Number(settings.viewDistance);
  return d > 0 ? d : Infinity;
}
