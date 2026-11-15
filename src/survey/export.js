// The survey export: survey.json plus the photos, zipped.
//
// Features are points ({ kind: 'point', lat, lon, acc, spread, n, ... }) and
// lines ({ kind: 'line', vertices: [{ lat, lon, acc, time }] }), each with a
// label, note, time and photos: [{ id, heading, time }]. The export keeps the
// raw GPS values and adds the National Grid position (osgb) and, with a site
// chosen, the position in that site's world frame (local: x east, z south of
// the pilot, metres) so they drop straight into src/sim/location.js.
import { wgs84ToOsgb, osgbToLocal } from './geo.js';
import { makeZip } from './zip.js';

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

function place(p, origin) {
  const g = wgs84ToOsgb(p.lat, p.lon);
  const out = { osgb: { easting: round(g.easting), northing: round(g.northing) } };
  if (origin) {
    const l = osgbToLocal(g, origin);
    out.local = { x: round(l.x), z: round(l.z) };
  }
  return out;
}

export const photoFile = (id) => `photos/${id}.jpg`;

export function surveyJson(features, site, exported = new Date()) {
  const origin = site?.origin || null;
  return {
    format: 'rc-flight-sim-survey',
    version: 1,
    exported: exported.toISOString(),
    site: site ? { id: site.id, name: site.name, origin } : null,
    conversion: 'WGS84 to OSGB36 by the OS 7-parameter Helmert shift (about 2 m), as tools/bake_location.py uses',
    frame: 'local: x east, z south (-z north), metres from the pilot',
    features: [...features]
      .sort((a, b) => a.time - b.time)
      .map((f) => {
        const base = {
          id: f.id,
          kind: f.kind,
          label: f.label,
          note: f.note || '',
          time: new Date(f.time).toISOString(),
          photos: (f.photos || []).map((p) => ({ file: photoFile(p.id), heading: round(p.heading, 0), time: new Date(p.time).toISOString() })),
        };
        if (f.kind === 'line') {
          return {
            ...base,
            vertices: f.vertices.map((v) => ({ lat: round(v.lat, 7), lon: round(v.lon, 7), acc: round(v.acc, 1), ...place(v, origin) })),
          };
        }
        return {
          ...base,
          lat: round(f.lat, 7),
          lon: round(f.lon, 7),
          acc: round(f.acc, 1),
          spread: round(f.spread, 1),
          fixes: f.n,
          altitude: round(f.alt, 1),
          ...place(f, origin),
        };
      }),
  };
}

/** photos: Map id -> Uint8Array of JPEG data. */
export function surveyZip(features, site, photos, exported = new Date()) {
  const enc = new TextEncoder();
  const files = [{ name: 'survey.json', data: enc.encode(JSON.stringify(surveyJson(features, site, exported), null, 2)), date: exported }];
  for (const f of features) {
    for (const p of f.photos || []) {
      if (photos.has(p.id)) files.push({ name: photoFile(p.id), data: photos.get(p.id), date: new Date(p.time) });
    }
  }
  return makeZip(files);
}
