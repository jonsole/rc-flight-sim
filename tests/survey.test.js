import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { wgs84ToOsgb, projectOsgb, osgbToLocal, averageFixes, distance } from '../src/survey/geo.js';
import { crc32, makeZip } from '../src/survey/zip.js';
import { surveyJson, surveyZip } from '../src/survey/export.js';

const DEG = Math.PI / 180;
const dms = (d, m, s) => (d + m / 60 + s / 3600) * DEG;

describe('National Grid conversion', () => {
  it('projects OSGB36 lat/lon like the Ordnance Survey worked example', () => {
    // A guide to coordinate systems in Great Britain, appendix C.
    const g = projectOsgb(dms(52, 39, 27.2531), dms(1, 43, 4.5177));
    expect(g.easting).toBeCloseTo(651409.903, 2);
    expect(g.northing).toBeCloseTo(313177.270, 2);
  });

  it('matches pyproj\'s Helmert WGS84 -> OSGB36 (what the location baker used)', () => {
    // pyproj Transformer.from_crs(4326, 27700) without the OSTN15 grid.
    for (const [lat, lon, e, n] of [
      [52.283, 0.1885, 549384.710, 267239.519],
      [51.5072, -0.1276, 530043.195, 180358.209],
      [55.9533, -3.1883, 325897.218, 674001.202],
    ]) {
      const g = wgs84ToOsgb(lat, lon);
      expect(Math.abs(g.easting - e)).toBeLessThan(0.05);
      expect(Math.abs(g.northing - n)).toBeLessThan(0.05);
    }
  });

  it('puts the site origin at the world origin, north along -z', () => {
    const origin = { easting: 549666.2, northing: 266652.5 };
    expect(osgbToLocal(origin, origin)).toEqual({ x: 0, z: -0 });
    const l = osgbToLocal({ easting: 549676.2, northing: 266672.5 }, origin);
    expect(l.x).toBeCloseTo(10);
    expect(l.z).toBeCloseTo(-20);
  });
});

describe('averaging fixes', () => {
  it('weights good fixes and drops bad ones', () => {
    const base = { lat: 52.283, lon: 0.1885 };
    const fixes = [
      { ...base, acc: 4 },
      { lat: base.lat + 0.00001, lon: base.lon, acc: 4 },
      { lat: base.lat - 0.00001, lon: base.lon, acc: 4 },
      { lat: base.lat + 0.001, lon: base.lon, acc: 40 }, // 110 m off, poor fix
    ];
    const a = averageFixes(fixes);
    expect(a.n).toBe(3);
    expect(a.dropped).toBe(1);
    expect(distance(a, base)).toBeLessThan(0.1);
    expect(a.acc).toBe(4);
    expect(a.spread).toBeGreaterThan(0.5);
    expect(a.spread).toBeLessThan(1.5);
  });

  it('returns null without usable fixes', () => {
    expect(averageFixes([])).toBeNull();
    expect(averageFixes([{ lat: 1, lon: 1, acc: 500 }])).toBeNull();
  });

  it('measures distance in metres', () => {
    expect(distance({ lat: 52, lon: 0 }, { lat: 52.001, lon: 0 })).toBeCloseTo(111.2, 0);
  });
});

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a stored archive with readable entries', () => {
    const data = new TextEncoder().encode('hello');
    const z = makeZip([{ name: 'a.txt', data }, { name: 'b/c.txt', data }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cenStart = v.getUint32(end + 16, true);
    expect(v.getUint32(cenStart, true)).toBe(0x02014b50);
    expect(new TextDecoder().decode(z.slice(30 + 5, 30 + 5 + 5))).toBe('hello');
  });
});

describe('survey export', () => {
  const site = { id: 'waterbeach', name: 'Waterbeach', origin: { easting: 549666.2, northing: 266652.5 } };
  const features = [
    { id: 'p1', kind: 'point', label: 'Fence corner', note: 'chain link', time: 2, lat: 52.283, lon: 0.1885, acc: 3.2, spread: 1.1, n: 15, alt: 10, photos: [{ id: 'ph1', time: 3, heading: 91.6 }] },
    { id: 'l1', kind: 'line', label: 'Hedge', time: 1, vertices: [{ lat: 52.283, lon: 0.1885, acc: 4 }, { lat: 52.2831, lon: 0.1885, acc: 4 }], photos: [] },
  ];

  it('adds grid and site positions, oldest first', () => {
    const j = surveyJson(features, site, new Date(0));
    expect(j.format).toBe('rc-flight-sim-survey');
    expect(j.features.map((f) => f.id)).toEqual(['l1', 'p1']);
    const p = j.features[1];
    expect(p.osgb.easting).toBeCloseTo(549384.71, 1);
    expect(p.local.x).toBeCloseTo(549384.71 - 549666.2, 1);
    expect(p.local.z).toBeCloseTo(-(267239.52 - 266652.5), 1);
    expect(p.photos[0]).toMatchObject({ file: 'photos/ph1.jpg', heading: 92 });
    expect(j.features[0].vertices[1].local.z).toBeLessThan(j.features[0].vertices[0].local.z); // north is -z
  });

  it('leaves out site positions without a site', () => {
    const j = surveyJson(features, null);
    expect(j.site).toBeNull();
    expect(j.features[1].local).toBeUndefined();
  });

  it('zips the json and the photos', () => {
    const z = surveyZip(features, site, new Map([['ph1', new Uint8Array([1, 2, 3])]]));
    const v = new DataView(z.buffer);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(2);
  });

  it('knows the Waterbeach origin the page loads', () => {
    const w = JSON.parse(readFileSync(new URL('../src/locations/waterbeach.json', import.meta.url)));
    expect(w.origin.easting).toBe(site.origin.easting);
    expect(w.origin.northing).toBe(site.origin.northing);
  });
});
