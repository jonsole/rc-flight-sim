#!/usr/bin/env python3
"""Bake a real flying site into a data file the simulator loads.

Sources (all free):
  England:
  - Environment Agency LIDAR composite, 1 m (Open Government Licence):
      DTM  bare ground height          -> terrain
      DSM  first-return surface height -> building heights
      VOM  Vegetation Object Model     -> tree positions, heights and crowns
  Austria (source 'bev', tools/bev.py):
  - BEV ALS DTM and DSM, 1 m (CC BY 4.0): terrain, buildings, and trees
    from the surface height above the ground off the buildings; also the
    mountains round about, from the files' coarser levels (`far`)
  - basemap.at orthophoto (CC BY 4.0): the ground's colours, round the
    field (`ground`) and out to the mountains (`farGround`)
  Both:
  - OpenStreetMap (ODbL): building footprints, roads, paths, water, land use
      -> buildings and the colour map painted on the ground

Usage:
  pip install numpy scipy pyproj tifffile pillow imagecodecs
  python3 tools/bake_location.py waterbeach --cache /tmp/waterbeach-data

Writes src/locations/<id>.json. The local frame matches the sim: origin at the
pilot's spot, +x east, -z north, y up, metres. Heights are relative to the
ground at the pilot's spot.
"""
import argparse
import base64
import io
import json
import math
import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
import tifffile
from PIL import Image, ImageDraw, ImageFilter
from pyproj import Transformer
from scipy import ndimage

SITES = {
    # Barrack Field, Waterbeach (Cambridgeshire): by the old barracks.
    'waterbeach': {
        'name': 'Barrack Field',
        'pilot': (549666.2, 266652.5),  # OSGB easting, northing where the pilot stands (10 m south of the cricket pitch)
        'half': 1000,                    # metres either side of the pilot baked in
    },
    # Impington Village College sports field (Cambridgeshire).
    'impington': {
        'name': 'Impington Village College',
        'centre': (544587.4, 262930.1),  # middle of the baked area
        'pilot': (544662.4, 262900.1),   # middle of the main playing field
        'half': 1000,
    },
    # Modellflugplatz Glocknerhof, Berg im Drautal (Carinthia, Austria): the
    # hotel's field in the Drau valley below it.
    'glocknerhof': {
        'name': 'Modellflugplatz Glocknerhof',
        'source': 'bev',
        'pilot_ll': (46.7437090, 13.1528585),  # lat, lon: at the net in front of the pits
        'half': 1000,
        'far_half': 7040,  # the mountains: out to here, every 32 m
        'far_cell': 32,
    },
}

EA = 'https://environment.data.gov.uk/spatialdata'
COVERAGES = {
    'dtm': ('lidar-composite-digital-terrain-model-dtm-1m',
            '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m'),
    'dsm': ('lidar-composite-digital-surface-model-first-return-dsm-1m',
            'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m'),
    'vom': ('vegetation-object-model',
            'ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022'),
}
UA = {'User-Agent': 'rc-flight-sim location baker'}


def fetch(url, path, check=None):
    if os.path.exists(path):
        return path
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            if check and not check(data):
                raise ValueError(f'unexpected response: {data[:120]!r}')
            with open(path, 'wb') as f:
                f.write(data)
            return path
        except Exception as e:  # the EA server is flaky: retry
            print(f'  retry {attempt + 1}: {e}', file=sys.stderr)
            time.sleep(4 * (attempt + 1))
    raise SystemExit(f'failed to download {url}')


def download(site, cache):
    os.makedirs(cache, exist_ok=True)
    # The baked area is centred on 'centre' if given (so the pilot spot can
    # move without new downloads), otherwise on the pilot.
    e0, n0 = site.get('centre', site['pilot'])
    h = site['half']
    box = (e0 - h, n0 - h, e0 + h, n0 + h)
    out = {}
    for key, (ds, cov) in COVERAGES.items():
        print(f'LIDAR {key}...')
        out[key] = fetch_mosaic(ds, cov, box, os.path.join(cache, f'{key}_E{box[0]:.0f}_N{box[1]:.0f}_{box[2] - box[0]:.0f}.tif'), cache, key)
    to_ll = Transformer.from_crs(27700, 4326, always_xy=True)
    lon0, lat0 = to_ll.transform(box[0], box[1])
    lon1, lat1 = to_ll.transform(box[2], box[3])
    print('OpenStreetMap...')
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lon0:.5f},{lat0:.5f},{lon1:.5f},{lat1:.5f}'
    out['osm'] = fetch(url, os.path.join(cache, 'osm.xml'), lambda d: b'<osm' in d[:400])
    return box, out


def fetch_mosaic(ds, cov, box, path, cache, key, tile=500):
    """One coverage over the box, fetched in tiles (the server times out on
    big requests) and stitched into a single GeoTIFF-less array file."""
    if os.path.exists(path):
        return path
    # Named by where they are, so a different box never reuses the wrong ones.
    n = int(box[2] - box[0])
    full = np.full((n, n), np.nan, np.float32)
    for i in range(0, n, tile):
        for j in range(0, n, tile):
            e0, e1 = box[0] + i, box[0] + min(n, i + tile)
            n0, n1 = box[1] + j, box[1] + min(n, j + tile)
            url = (f'{EA}/{ds}/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId={cov}'
                   f'&format=image/tiff&subset=E({e0:.0f},{e1:.0f})&subset=N({n0:.0f},{n1:.0f})')
            part = fetch(url, os.path.join(cache, f'{key}_E{e0:.0f}_N{n0:.0f}_{tile}.tif'), lambda d: d[:2] in (b'II', b'MM'))
            a = tifffile.imread(part).astype(np.float32)
            # Row 0 is the north edge.
            r0 = n - (j + a.shape[0])
            full[r0:r0 + a.shape[0], i:i + a.shape[1]] = a
    tifffile.imwrite(path, full)
    return path


def read_tif(path, n):
    a = tifffile.imread(path).astype(np.float32)
    a[~np.isfinite(a) | (a < -1000)] = np.nan
    assert a.shape == (n, n), a.shape
    return a


def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode()


def r1(v):
    return round(float(v), 1)


# --- OpenStreetMap -------------------------------------------------------------

def load_osm(path, to_local):
    root = ET.parse(path).getroot()
    nodes = {}
    for n in root.findall('node'):
        nodes[n.get('id')] = (float(n.get('lon')), float(n.get('lat')))
    ways = {}
    for w in root.findall('way'):
        refs = [nd.get('ref') for nd in w.findall('nd')]
        if any(r not in nodes for r in refs):
            refs = [r for r in refs if r in nodes]
        tags = {t.get('k'): t.get('v') for t in w.findall('tag')}
        pts = [to_local(*nodes[r]) for r in refs]
        ways[w.get('id')] = {'tags': tags, 'pts': pts, 'closed': len(refs) > 3 and refs[0] == refs[-1]}
    # Multipolygon relations: just their outer rings, tagged like the relation.
    areas = [w for w in ways.values() if w['closed']]
    for rel in root.findall('relation'):
        tags = {t.get('k'): t.get('v') for t in rel.findall('tag')}
        if tags.get('type') != 'multipolygon':
            continue
        for m in rel.findall('member'):
            if m.get('type') == 'way' and m.get('role') == 'outer' and m.get('ref') in ways:
                w = ways[m.get('ref')]
                if w['closed']:
                    areas.append({'tags': {**w['tags'], **tags}, 'pts': w['pts'], 'closed': True})
    lines = [w for w in ways.values() if not w['closed'] or 'highway' in w['tags'] and w['tags'].get('area') != 'yes']
    return areas, lines


# --- Ground colour map ------------------------------------------------------------

# Flat colours (sRGB) the shader adds grass and gravel detail to.
COL = {
    'rough': (122, 135, 78),
    'grass': (110, 140, 66),
    'mown': (104, 146, 62),
    'garden': (100, 128, 60),
    'farmland': (132, 136, 82),
    'wood': (64, 82, 44),
    'scrub': (92, 108, 58),
    'bare': (150, 138, 112),
    'paved': (128, 126, 120),
    'asphalt': (84, 84, 84),
    'track': (140, 122, 92),
    'path': (150, 146, 136),
    'water': (52, 70, 66),
    'roof': (110, 108, 104),
}


def area_class(t):
    lu = t.get('landuse')
    le = t.get('leisure')
    na = t.get('natural')
    if na == 'water' or t.get('water') or lu in ('reservoir', 'basin'):
        return 'water', 5
    if t.get('amenity') == 'parking' or t.get('highway') in ('pedestrian',) or t.get('area:highway'):
        return 'asphalt', 4
    # (A 'construction' site here is mostly still grass: left as rough.)
    if lu in ('brownfield', 'quarry', 'landfill') or na in ('sand', 'bare_rock'):
        return 'bare', 2
    if lu in ('commercial', 'industrial', 'retail', 'military', 'railway', 'garages'):
        return 'paved', 1
    if lu in ('forest',) or na in ('wood',):
        return 'wood', 2
    if na in ('scrub', 'heath') or lu in ('meadow',):
        return 'scrub', 2
    if lu in ('farmland', 'farmyard', 'orchard', 'allotments'):
        return 'farmland', 1
    if lu in ('residential',):
        return 'garden', 1
    if le in ('pitch', 'park', 'garden', 'playground', 'recreation_ground', 'sports_centre') or lu in ('grass', 'recreation_ground', 'village_green', 'cemetery'):
        return 'grass', 3
    return None, 0


ROAD_WIDTH = {
    'motorway': 14, 'trunk': 10, 'primary': 8, 'secondary': 7.5, 'tertiary': 7, 'unclassified': 6,
    'residential': 6, 'living_street': 5.5, 'service': 4, 'busway': 7,
    'track': 3, 'footway': 2, 'path': 1.6, 'cycleway': 2.5, 'bridleway': 2, 'steps': 2, 'pedestrian': 4,
}


def paint_ground(areas, lines, buildings, vom, size_m, px):
    """RGB colour map, `px` pixels over `size_m` metres, north up."""
    s = px / size_m  # pixels per metre
    half = size_m / 2

    def P(pts):
        return [((x + half) * s, (z + half) * s) for x, z in pts]

    img = Image.new('RGB', (px, px), COL['rough'])
    d = ImageDraw.Draw(img)
    ranked = []
    for a in areas:
        cls, pri = area_class(a['tags'])
        if cls:
            ranked.append((pri, cls, a))
    ranked.sort(key=lambda r: r[0])
    for _, cls, a in ranked:
        if len(a['pts']) >= 3:
            d.polygon(P(a['pts']), fill=COL[cls])
    for w in lines:
        t = w['tags']
        hw = t.get('highway')
        if w['tags'].get('waterway') in ('drain', 'ditch', 'stream', 'river', 'canal'):
            wid = {'river': 12, 'canal': 10, 'stream': 3}.get(t['waterway'], 2.2)
            d.line(P(w['pts']), fill=COL['water'], width=max(1, round(wid * s)), joint='curve')
        if hw in ROAD_WIDTH:
            wid = float(t.get('width', ROAD_WIDTH[hw])) if t.get('width', '').replace('.', '').isdigit() else ROAD_WIDTH[hw]
            surf = t.get('surface', '')
            if hw == 'track' or surf in ('dirt', 'ground', 'grass', 'earth', 'gravel', 'compacted', 'fine_gravel', 'unpaved'):
                col = COL['track']
            elif hw in ('footway', 'path', 'cycleway', 'bridleway', 'steps'):
                col = COL['path']
            else:
                col = COL['asphalt']
            pts = P(w['pts'])
            if len(pts) >= 2:
                d.line(pts, fill=col, width=max(1, round(wid * s)), joint='curve')
    for b in buildings:
        d.polygon(P(b['pts']), fill=COL['paved'])
    # Ground in tree shade is darker and barer; resample the 1 m canopy map.
    canopy = (np.nan_to_num(vom) > 2.5).astype(np.float32)
    shade = Image.fromarray((canopy * 255).astype(np.uint8)).resize((px, px), Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.5 * s))
    a = np.asarray(img).astype(np.float32)
    k = np.asarray(shade).astype(np.float32)[..., None] / 255
    a = a * (1 - 0.35 * k)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue(), img


# --- Trees -------------------------------------------------------------------------

def find_trees(vom, xs, zs, max_trees):
    """Tree tops in the 1 m vegetation height model: (x, z, h, crown radius).

    LIDAR flown with the leaves off sees a speckled canopy, full of holes,
    so it is closed up first (gaps of a few metres filled with the heights
    round them). Then tree tops are found, each with the crown out to where
    the canopy falls below half its height, and any canopy still not under
    a crown gets trees of its own, so woods come out as dense as they are.
    """
    raw = np.nan_to_num(vom)
    v = ndimage.gaussian_filter(ndimage.grey_closing(raw, size=(5, 5)), 1.2)
    # Smoothing takes the tops off: a tree's height is the raw LIDAR's
    # highest point near its top.
    tops = ndimage.maximum_filter(raw, size=5)
    peaks = (v >= 3.0) & (v == ndimage.maximum_filter(v, size=5))
    iy, ix = np.nonzero(peaks)
    order = np.argsort(-v[iy, ix])
    taken = []
    occ = np.zeros(v.shape, bool)
    under = np.zeros(v.shape, bool)  # canopy under an accepted crown
    dirs = [(math.cos(a), math.sin(a)) for a in np.linspace(0, 2 * math.pi, 12, endpoint=False)]

    def crown(y, x, h):
        # Out to where the (smoothed) canopy falls below 40% of its top.
        top = float(v[y, x])
        rs = []
        for dx, dy in dirs:
            r = 1
            while r < 0.6 * h + 3:
                xx, yy = int(round(x + dx * r)), int(round(y + dy * r))
                if not (0 <= xx < v.shape[1] and 0 <= yy < v.shape[0]) or v[yy, xx] < 0.4 * top:
                    break
                r += 1
            rs.append(r)
        return float(np.clip(np.mean(rs), 1.2, 0.6 * h))

    def accept(y, x, h, cr):
        taken.append((xs[x], zs[y], h, cr))
        # The next tree's top must be outside most of this crown.
        sep = max(2, int(cr * 0.85))
        occ[max(0, y - sep):y + sep + 1, max(0, x - sep):x + sep + 1] |= _disc(sep, y, x, v.shape)
        rr = max(1, int(cr))
        under[max(0, y - rr):y + rr + 1, max(0, x - rr):x + rr + 1] |= _disc(rr, y, x, v.shape)

    for k in order:
        y, x = iy[k], ix[k]
        if occ[y, x]:
            continue
        h = float(tops[y, x])
        accept(y, x, h, crown(y, x, h))
    # Canopy left uncovered: a tree at the tallest point of each patch.
    for _ in range(3):
        holes = (v >= 3.5) & ~under
        lab, n = ndimage.label(holes)
        if not n:
            break
        added = 0
        for i, sl in enumerate(ndimage.find_objects(lab), start=1):
            m = lab[sl] == i
            area = int(m.sum())
            if area < 10:
                continue
            w = np.where(m, v[sl], 0)
            yy, xx = np.unravel_index(np.argmax(w), w.shape)
            y, x = yy + sl[0].start, xx + sl[1].start
            h = float(tops[y, x])
            accept(y, x, h, float(np.clip(math.sqrt(area / math.pi), 1.5, 0.6 * h)))
            added += 1
        if not added:
            break
    # Nearest the field first, so a cap drops the far ones.
    taken.sort(key=lambda t: t[0] ** 2 + t[1] ** 2)
    return taken[:max_trees]


def _disc(r, y, x, shape):
    yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
    m = xx * xx + yy * yy <= r * r
    y0, x0 = y - r, x - r
    sy0, sx0 = max(0, -y0), max(0, -x0)
    sy1 = m.shape[0] - max(0, y0 + m.shape[0] - shape[0])
    sx1 = m.shape[1] - max(0, x0 + m.shape[1] - shape[1])
    return m[sy0:sy1, sx0:sx1]


def find_bushes(vom, xs, zs, no_plant, max_bushes, step=3):
    """Bushes and scrub: (x, z, h), nearest the field first.

    The leaf-off LIDAR sees shrubs as sparse speckles, so the canopy is
    closed up first; then every 3 m cell whose low vegetation (0.6-4 m)
    covers 15% of it gets a bush. Woodland and tree lines also have a fringe
    of scrub the LIDAR barely sees: some bushes are scattered along the open
    edge of the tree canopy. Nothing on roads, paths, car parks, buildings or
    water (`no_plant`, from OpenStreetMap).
    """
    raw = np.nan_to_num(vom)
    v = ndimage.grey_closing(raw, size=(3, 3))
    h2 = step // 2
    out = []
    for y in range(h2, v.shape[0], step):
        for x in range(h2, v.shape[1], step):
            if no_plant[y, x]:
                continue
            cell = v[y - h2:y + h2 + 1, x - h2:x + h2 + 1]
            h = float(cell.max())
            if 0.6 <= h < 4.0 and (cell > 0.5).mean() > 0.15:
                out.append((xs[x], zs[y], h))
    # Scrub along the open edge of the tree canopy (within 5 m of it).
    canopy = v > 4
    edge = ndimage.binary_dilation(canopy, iterations=5) & ~canopy & (raw < 0.5) & ~no_plant
    rng = np.random.default_rng(7)
    for y in range(h2, v.shape[0], step):
        for x in range(h2, v.shape[1], step):
            if edge[y, x] and rng.random() < 0.3:
                jx, jy = rng.uniform(-1, 1, 2)
                out.append((xs[x] + jx, zs[y] + jy, float(rng.uniform(0.8, 2.4))))
    out.sort(key=lambda b: b[0] ** 2 + b[1] ** 2)
    return out[:max_bushes]


def no_plant_mask(areas, lines, buildings, x0, z0, n):
    """1 m cells where no bush grows: roads, paths, car parks, paved and
    commercial land, buildings and water (from OpenStreetMap)."""
    img = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(img)

    def P(pts):
        return [(x - x0, z - z0) for x, z in pts]

    for a in areas:
        cls, _ = area_class(a['tags'])
        if cls in ('asphalt', 'paved', 'water') and len(a['pts']) >= 3:
            d.polygon(P(a['pts']), fill=1)
    for w in lines:
        hw = w['tags'].get('highway')
        if hw in ROAD_WIDTH and len(w['pts']) >= 2:
            d.line(P(w['pts']), fill=1, width=max(1, round(ROAD_WIDTH[hw] + 1)))
        if w['tags'].get('waterway') and len(w['pts']) >= 2:
            d.line(P(w['pts']), fill=1, width=3)
    for b in buildings:
        d.polygon(P(b['pts']), fill=1)
    return np.asarray(img, bool)


# --- Buildings -----------------------------------------------------------------------

def poly_area(pts):
    a = 0
    for (x0, z0), (x1, z1) in zip(pts, pts[1:] + pts[:1]):
        a += x0 * z1 - x1 * z0
    return a / 2


def simplify(pts, tol=0.6):
    """Drop near-collinear corners (Douglas-Peucker on a closed ring)."""
    if pts[0] == pts[-1]:
        pts = pts[:-1]

    def dp(seg):
        if len(seg) < 3:
            return seg
        (x0, z0), (x1, z1) = seg[0], seg[-1]
        L = math.hypot(x1 - x0, z1 - z0) or 1e-9
        dmax, k = 0, 0
        for i in range(1, len(seg) - 1):
            x, z = seg[i]
            dd = abs((x1 - x0) * (z0 - z) - (x0 - x) * (z1 - z0)) / L
            if dd > dmax:
                dmax, k = dd, i
        if dmax > tol:
            return dp(seg[:k + 1])[:-1] + dp(seg[k:])
        return [seg[0], seg[-1]]

    n = len(pts)
    if n < 4:
        return pts
    # Split at the point furthest from the first.
    far = max(range(n), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a = dp(pts[:far + 1])
    b = dp(pts[far:] + [pts[0]])
    return a[:-1] + b[:-1]


def buildings_from(areas, ndsm, vom, xs, zs, lidar_only=False):
    """OSM footprints with heights measured from the LIDAR. OSM is kept up
    to date, the LIDAR is a few years old: a building OSM no longer has has
    usually been demolished, so LIDAR-only structures are left out unless
    `lidar_only` asks for them."""
    n = ndsm.shape[0]
    x0, z0 = xs[0] - 0.5, zs[0] - 0.5
    out = []
    covered = np.zeros((n, n), bool)
    for a in areas:
        t = a['tags']
        if 'building' not in t or t['building'] in ('no', 'roof', 'carport'):
            continue
        pts = simplify(a['pts'])
        if len(pts) < 3 or abs(poly_area(pts)) < 6:
            continue
        if poly_area(pts) < 0:  # counter-clockwise seen from above (x east, z south)
            pts = pts[::-1]
        bx0, bz0 = min(p[0] for p in pts), min(p[1] for p in pts)
        bx1, bz1 = max(p[0] for p in pts), max(p[1] for p in pts)
        if bx1 < xs[0] or bz1 < zs[0] or bx0 > xs[-1] or bz0 > zs[-1]:
            continue
        # Mask in a window round the footprint only.
        c0 = max(0, int(bx0 - x0) - 3)
        r0 = max(0, int(bz0 - z0) - 3)
        c1 = min(n, int(bx1 - x0) + 4)
        r1_ = min(n, int(bz1 - z0) + 4)
        img = Image.new('L', (c1 - c0, r1_ - r0), 0)
        ImageDraw.Draw(img).polygon([(x - x0 - c0, z - z0 - r0) for x, z in pts], fill=1)
        m = np.asarray(img, bool)
        win = (slice(r0, r1_), slice(c0, c1))
        covered[win] |= ndimage.binary_dilation(m, iterations=2)
        hs = ndsm[win][m & np.isfinite(ndsm[win])]
        area = abs(poly_area(pts))
        if hs.size >= 4 and np.percentile(hs, 90) > 1.8:
            top = float(np.percentile(hs, 90))
            eave = float(np.percentile(hs, 30))
        else:  # newer than the LIDAR (or too small to measure)
            levels = float(t.get('building:levels', '2') or 2) if t.get('building:levels', '2').replace('.', '').isdigit() else 2
            top = 3 * levels + (2.5 if area < 250 else 0.5)
            eave = top - (2.5 if area < 250 else 0.5)
        top = min(top, 40)
        gable = len(pts) == 4 and area < 400 and top - eave > 1.2
        out.append({'pts': [(r1(x), r1(z)) for x, z in pts], 'h': r1(top), 'eave': r1(max(2.3, min(eave, top - 0.3))) if gable else r1(top),
                    'kind': t['building']})
    if not lidar_only:
        return out
    # Unmapped: tall, non-vegetation blobs of at least 60 m^2.
    solid = (np.nan_to_num(ndsm) > 2.5) & (np.nan_to_num(vom) < 0.5) & ~covered
    solid = ndimage.binary_opening(solid, iterations=1)
    lab, k = ndimage.label(solid)
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        m = lab[sl] == i
        if m.sum() < 60:
            continue
        yy, xx = np.nonzero(m)
        px = np.stack([xs[xx + sl[1].start], zs[yy + sl[0].start]], 1)
        c = px.mean(0)
        u, s_, vt = np.linalg.svd(px - c, full_matrices=False)
        ax = vt[0]
        bx = np.array([-ax[1], ax[0]])
        pa, pb = (px - c) @ ax, (px - c) @ bx
        a0, a1, b0, b1 = pa.min() - 0.5, pa.max() + 0.5, pb.min() - 0.5, pb.max() + 0.5
        if (a1 - a0) * (b1 - b0) > 2.2 * m.sum():  # too irregular for a box
            continue
        corners = [c + ax * a + bx * b for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
        pts = [(r1(p[0]), r1(p[1])) for p in corners]
        if poly_area(pts) < 0:
            pts = pts[::-1]
        hs = ndsm[sl][m]
        top = float(np.percentile(hs, 75))
        out.append({'pts': pts, 'h': r1(top), 'eave': r1(top), 'kind': 'lidar'})
    return out


def true_north(e0, n0, to_ll, to_bng):
    lon, lat = to_ll.transform(e0, n0)
    e1, n1 = to_bng.transform(lon, lat + 0.01)
    return math.degrees(math.atan2(e1 - e0, n1 - n0))


# --- Main -----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site', choices=SITES)
    ap.add_argument('--cache', required=True, help='folder for the downloads')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'src', 'locations'))
    ap.add_argument('--max-trees', type=int, default=5000)
    ap.add_argument('--max-bushes', type=int, default=16000)
    ap.add_argument('--ground-px', type=int, default=2048)
    ap.add_argument('--lidar-buildings', action='store_true',
                    help='also add structures the LIDAR shows that OSM does not have (they may since have been demolished)')
    args = ap.parse_args()
    site = SITES[args.site]
    if site.get('source') == 'bev':
        from bev import bake_bev
        return bake_bev(args, site)
    box, files = download(site, args.cache)
    e0, n0 = site['pilot']
    n = int(box[2] - box[0])
    dtm, dsm, vom = (read_tif(files[k], n) for k in ('dtm', 'dsm', 'vom'))
    # Pixel centres in local coordinates (row 0 is the north edge).
    xs = box[0] + 0.5 + np.arange(n) - e0
    zs = -(box[3] - 0.5 - np.arange(n) - n0)
    # Ground height at the pilot's spot (the origin).
    pc, pr = int(e0 - box[0]), int(box[3] - n0)
    h0 = float(np.nanmedian(dtm[pr - 3:pr + 3, pc - 3:pc + 3]))
    ground = np.where(np.isnan(dtm), np.nanmedian(dtm), dtm) - h0
    ndsm = dsm - dtm

    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    to_ll_pt = Transformer.from_crs(27700, 4326, always_xy=True)

    def to_local(lon, lat):
        e, nn = to_bng.transform(lon, lat)
        return (e - e0, -(nn - n0))

    areas, lines = load_osm(files['osm'], to_local)
    print(f'{len(areas)} OSM areas, {len(lines)} lines')

    # Terrain: 4 m cells, centimetres.
    cell = 4
    tg = ndimage.zoom(ndimage.gaussian_filter(ground, cell / 2), 1 / cell, order=1)
    terrain = np.round(tg * 100).astype('<i2')

    trees = find_trees(vom, xs, zs, args.max_trees)
    buildings = buildings_from(areas, ndsm, vom, xs, zs, args.lidar_buildings)
    no_plant = no_plant_mask(areas, lines, buildings, float(xs[0] - 0.5), float(zs[0] - 0.5), n)
    bushes = find_bushes(vom, xs, zs, no_plant, args.max_bushes)
    print(f'{len(trees)} trees, {len(bushes)} bush points, {len(buildings)} buildings')
    png, img = paint_ground(areas, lines, buildings, vom, n, args.ground_px)
    img.save(os.path.join(args.cache, 'ground-preview.png'))

    out = {
        'id': args.site,
        'name': site['name'],
        'credits': 'Contains Environment Agency LIDAR data © Environment Agency copyright and/or database right, '
                   'licensed under the Open Government Licence v3.0. Map data © OpenStreetMap contributors (ODbL).',
        'origin': {'easting': e0, 'northing': n0, 'height': round(h0, 2),
                   'lat': round(to_ll_pt.transform(e0, n0)[1], 7), 'lon': round(to_ll_pt.transform(e0, n0)[0], 7),
                   # Bearing of true north from grid north (the sim's -z), degrees.
                   'trueNorth': round(true_north(e0, n0, to_ll_pt, to_bng), 4)},
        'size': n,
        'terrain': {'cell': cell, 'n': int(terrain.shape[0]), 'x0': float(xs[0] - 0.5 + cell / 2), 'z0': float(zs[0] - 0.5 + cell / 2),
                    'cm': b64(terrain)},
        'trees': [v for t in trees for v in (r1(t[0]), r1(t[1]), r1(t[2]), r1(t[3]))],
        'bushes': [v for b in bushes for v in (r1(b[0]), r1(b[1]), r1(b[2]))],
        'buildings': buildings,
        'ground': {'x0': float(xs[0] - 0.5), 'z0': float(zs[0] - 0.5), 'size': n, 'png': base64.b64encode(png).decode()},
    }
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f'{args.site}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
