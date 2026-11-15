// Scenery edits made in the sim's editor (src/editor/editor.js): trees,
// buildings and fences moved, resized, changed, deleted or added, on top of
// the site's baked data. Saved per field in this browser, and can be
// exported to a file (and, sent in, built into the field for everyone: a
// site's layout can carry `edits`, used until you make your own).
//
// Objects are known by stable ids, so edits survive a rebuild:
//   trees      `x,z` of where the tree was before any edit (0.1 m)
//   buildings  index in the site's baked building list
//   fences     index in the site layout's fence list
//
// {
//   trees:     { removed: [id], changed: { id: { x, z, h, r, conifer } }, added: [{ x, z, h, r, conifer }] },
//   buildings: { removed: [i], changed: { i: { dx, dz, h } } },
//   fences:    { removed: [i], changed: { i: { path, height, kind } }, added: [{ path, height, kind }] },
// }

const KEY = (site) => `rcsim.edits.${site}`;

export function emptyEdits() {
  return {
    trees: { removed: [], changed: {}, added: [] },
    buildings: { removed: [], changed: {} },
    fences: { removed: [], changed: {}, added: [] },
  };
}

/** The edits in force: one object, changed in place by the editor. */
export const EDITS = emptyEdits();

/** Normalise edits read from storage or a file (missing parts filled in). */
export function normaliseEdits(e) {
  const out = emptyEdits();
  for (const k of Object.keys(out)) Object.assign(out[k], e?.[k] ?? {});
  return out;
}

/** Load the edits for a site: this browser's, else the site's own. */
export function loadEdits(site, defaults = null) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY(site)));
  } catch {
    /* none, or storage blocked */
  }
  replaceEdits(normaliseEdits(saved ?? defaults));
}

export function saveEdits(site) {
  try {
    localStorage.setItem(KEY(site), JSON.stringify(EDITS));
  } catch {
    /* storage blocked: the edits last this session only */
  }
}

/** Put `e` in force (keeps the EDITS object, which modules hold on to). */
export function replaceEdits(e) {
  const n = normaliseEdits(e);
  for (const k of Object.keys(n)) EDITS[k] = n[k];
}

export function editCount(e = EDITS) {
  return e.trees.removed.length + Object.keys(e.trees.changed).length + e.trees.added.length
    + e.buildings.removed.length + Object.keys(e.buildings.changed).length
    + e.fences.removed.length + Object.keys(e.fences.changed).length + e.fences.added.length;
}

export const treeId = (x, z) => `${x.toFixed(1)},${z.toFixed(1)}`;

/**
 * Trees with the edits applied. Each input tree needs { x, z, h, conifer,
 * crownW }; `make(spec, seed)` builds a full tree for an added one.
 */
export function applyTreeEdits(trees, make) {
  const { removed, changed, added } = EDITS.trees;
  const gone = new Set(removed);
  const out = [];
  for (const t of trees) {
    t.id ??= treeId(t.x, t.z);
    if (gone.has(t.id)) continue;
    const c = changed[t.id];
    out.push(c ? make({ ...c, id: t.id }, t) : t);
  }
  added.forEach((a, i) => out.push(make({ ...a, id: `new:${i}` }, null)));
  return out;
}

/** Baked buildings ({ pts, h, eave }) with the edits applied; each gets `index`. */
export function applyBuildingEdits(list) {
  const { removed, changed } = EDITS.buildings;
  const gone = new Set(removed.map(Number));
  const out = [];
  list.forEach((b, i) => {
    if (gone.has(i)) return;
    const c = changed[i];
    if (!c) {
      out.push({ ...b, index: i });
      return;
    }
    const k = c.h != null ? c.h / b.h : 1;
    out.push({
      ...b,
      index: i,
      pts: b.pts.map(([x, z]) => [x + (c.dx ?? 0), z + (c.dz ?? 0)]),
      h: b.h * k,
      eave: b.eave * k,
    });
  });
  return out;
}

/** The site's fences with the edits applied; each gets `index` (added: 'new:i'). */
export function applyFenceEdits(list) {
  const { removed, changed, added } = EDITS.fences;
  const gone = new Set(removed.map(Number));
  const out = [];
  list.forEach((f, i) => {
    if (gone.has(i)) return;
    out.push({ ...f, ...(changed[i] ?? {}), index: i });
  });
  added.forEach((f, i) => out.push({ ...f, index: `new:${i}` }));
  return out;
}
