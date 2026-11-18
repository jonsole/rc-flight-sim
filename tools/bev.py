"""Austrian sites for tools/bake_location.py: BEV laser-scan heights and
basemap.at orthophotos.

  - BEV (Bundesamt für Eich- und Vermessungswesen) ALS DTM and DSM, 1 m,
    CC BY 4.0: one GeoTIFF per 50 km square (ETRS89-LAEA, EPSG:3035), about
    6 GB each, but tiled with coarser levels inside, so only the parts round
    the site are read, over HTTP range requests.
  - basemap.at orthophoto (CC BY 4.0), web-mercator tiles: the ground's
    colours, round the field (about 1 m a pixel) and out to the mountains.

Everything is resampled into a local frame centred on the pilot with true
north up (an azimuthal equidistant projection), so the sim's -z is true
north and distances are true: trueNorth is 0.
"""
import base64
import io
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np
import tifffile
from PIL import Image
from pyproj import Transformer
from scipy import ndimage

import bake_location as bl

BEV = 'https://data.bev.gv.at/download/ALS/{kind}/{date}/ALS_{kind}_CRS3035RES50000mN{n}E{e}.tif'
BEV_DATE = '20250915'
ORTHO = 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg'
UA = {'User-Agent': 'rc-flight-sim location baker'}


class HttpFile(io.RawIOBase):
    """A read-only, seekable file over HTTP range requests, cached in blocks
    (and the blocks kept on disk, so a second bake downloads nothing)."""

    def __init__(self, url, cache_dir, block=1 << 16):
        self.url, self.block, self.pos = url, block, 0
        self.dir = os.path.join(cache_dir, os.path.basename(url) + '.blocks')
        os.makedirs(self.dir, exist_ok=True)
        size_file = os.path.join(self.dir, 'size')
        if os.path.exists(size_file):
            self.size = int(open(size_file).read())
        else:
            req = urllib.request.Request(url, method='HEAD', headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                self.size = int(r.headers['Content-Length'])
            open(size_file, 'w').write(str(self.size))
        self.mem = {}

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _have(self, b):
        if b in self.mem:
            return True
        path = os.path.join(self.dir, str(b))
        if os.path.exists(path):
            self.mem[b] = open(path, 'rb').read()
            return True
        return False

    def _fetch(self, b0, b1):
        lo, hi = b0 * self.block, min(self.size, (b1 + 1) * self.block) - 1
        req = urllib.request.Request(self.url, headers={**UA, 'Range': f'bytes={lo}-{hi}'})
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    data = r.read()
                if len(data) != hi - lo + 1:
                    raise ValueError(f'short read {len(data)} of {hi - lo + 1}')
                break
            except Exception as e:
                print(f'  retry {attempt + 1}: {e}', file=sys.stderr)
                if attempt == 5:
                    raise
                time.sleep(3 * (attempt + 1))
        for b in range(b0, b1 + 1):
            chunk = data[(b - b0) * self.block:(b - b0 + 1) * self.block]
            self.mem[b] = chunk
            with open(os.path.join(self.dir, str(b)), 'wb') as f:
                f.write(chunk)

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b''
        b0, b1 = self.pos // self.block, (self.pos + n - 1) // self.block
        missing = [b for b in range(b0, b1 + 1) if not self._have(b)]
        if missing:
            self._fetch(missing[0], missing[-1])
        buf = b''.join(self.mem[b] for b in range(b0, b1 + 1))
        off = self.pos - b0 * self.block
        out = buf[off:off + n]
        self.pos += len(out)
        return out

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


class BevRaster:
    """One BEV height file (a 50 km square), any of its levels."""

    def __init__(self, kind, e, n, cache):
        self.e, self.n = e, n
        url = BEV.format(kind=kind, date=BEV_DATE, n=n, e=e)
        self.fh = HttpFile(url, cache)
        self.tif = tifffile.TiffFile(self.fh)

    def level_for(self, metres):
        """The coarsest level whose pixels are no bigger than `metres`."""
        best = 0
        for i, p in enumerate(self.tif.pages):
            if 50001 / p.imagewidth <= metres * 1.01:
                best = i
        return best

    def sample(self, level, es, ns):
        """Heights (bilinear) at EPSG:3035 points; NaN where there is no data."""
        page = self.tif.pages[level]
        ps = 50001 / page.imagewidth
        # Pixel (0, 0)'s corner is half a metre west and north of the square's corner.
        cols = (es - (self.e - 0.5)) / ps - 0.5
        rows = ((self.n + 50000.5) - ns) / ps - 0.5
        r0, c0 = int(math.floor(rows.min())) - 2, int(math.floor(cols.min())) - 2
        r1, c1 = int(math.ceil(rows.max())) + 3, int(math.ceil(cols.max())) + 3
        if r0 < 0 or c0 < 0 or r1 > page.imagelength or c1 > page.imagewidth:
            raise SystemExit('the site runs off the edge of its BEV file: not handled yet')
        win = self._window(page, r0, c0, r1 - r0, c1 - c0)
        bad = ~np.isfinite(win)
        if bad.all():
            raise SystemExit('no BEV data here')
        if bad.any():  # fill holes from the nearest data
            idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
            win = win[tuple(idx)]
        return ndimage.map_coordinates(win, [rows - r0, cols - c0], order=1, mode='nearest')

    def _window(self, page, r0, c0, h, w):
        tl, tw = page.tilelength, page.tilewidth
        across = -(-page.imagewidth // tw)
        out = np.full((h, w), np.nan, np.float32)
        for ty in range(r0 // tl, (r0 + h - 1) // tl + 1):
            for tx in range(c0 // tw, (c0 + w - 1) // tw + 1):
                i = ty * across + tx
                self.fh.seek(page.dataoffsets[i])
                data = self.fh.read(page.databytecounts[i])
                seg, _, _ = page.decode(data, i)
                tile = seg.reshape(tl, tw).astype(np.float32)
                # Where this tile and the window overlap.
                ya, xa = ty * tl, tx * tw
                y0, y1 = max(r0, ya), min(r0 + h, ya + tl)
                x0, x1 = max(c0, xa), min(c0 + w, xa + tw)
                out[y0 - r0:y1 - r0, x0 - c0:x1 - c0] = tile[y0 - ya:y1 - ya, x0 - xa:x1 - xa]
        out[(out < -1000) | (out > 9000)] = np.nan
        return out


def grid(half, cell):
    """Cell centres (x east, z south) of a square grid round the pilot."""
    n = int(round(2 * half / cell))
    c = -half + cell / 2 + np.arange(n) * cell
    return c, c.copy(), n


# The orthophoto has its capture year printed on it here and there (light
# grey digits about 20 m long at zoom 17): found by matching this pattern
# (the bright strokes of "2025") in the fine detail, and painted over.
STAMP = [
    '..#....#....#............',
    '.####.+###..+###...####+.',
    '###.#+##+##.#####..##+...',
    '#...#.##..#....##+####...',
    '...##.##..#....#..#####..',
    '..+#+.##..#...##..#..##..',
    '..+#..##..#..+##..#..##..',
    '+###..##.+#.###..+#####..',
    '#####+####..#####+.###+..',
    '+#+.#+...+..++.+...+#....',
]


def remove_stamps(rgb):
    """Paint over the year stamps in an orthophoto mosaic (uint8 RGB)."""
    T = np.array([[1.0 if ch == '#' else 0.5 if ch == '+' else 0.0 for ch in row] for row in STAMP])
    T -= T.mean()
    L = rgb.astype(np.float32).mean(2)
    H = L - ndimage.median_filter(L, 11)
    num = ndimage.correlate(H, T, mode='constant')
    # Normalised: by the detail's own strength under the pattern.
    win = np.ones(T.shape)
    m1 = ndimage.correlate(H, win, mode='constant') / win.size
    m2 = ndimage.correlate(H * H, win, mode='constant') / win.size
    sd = np.sqrt(np.maximum(m2 - m1 * m1, 1e-6) * win.size)
    score = num / (sd * np.sqrt((T * T).sum()))
    peaks = (score > 0.6) & (score == ndimage.maximum_filter(score, size=(9, 21)))
    out = rgb.copy()
    smooth = np.stack([ndimage.median_filter(rgb[..., k], 15) for k in range(3)], 2)
    hy, hx = T.shape[0] // 2 + 3, T.shape[1] // 2 + 4
    ys, xs = np.nonzero(peaks)
    for y, x in zip(ys, xs):
        y0, y1, x0, x1 = max(0, y - hy), y + hy + 1, max(0, x - hx), x + hx + 1
        out[y0:y1, x0:x1] = smooth[y0:y1, x0:x1]
    return out, len(ys)


def ortho_map(lat0, lon0, local_to_ll, half, px, cache, z=14):
    """The orthophoto over a square round the pilot, `px` pixels, north up."""
    s = 2 * half / px
    c = -half + s / 2 + np.arange(px) * s
    X, Z = np.meshgrid(c, c)
    lon, lat = local_to_ll.transform(X.ravel(), (-Z).ravel())
    n = 2 ** z
    gx = (np.asarray(lon) + 180) / 360 * n * 256
    gy = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n * 256
    tx0, tx1 = int(gx.min() // 256), int(gx.max() // 256)
    ty0, ty1 = int(gy.min() // 256), int(gy.max() // 256)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8)
    os.makedirs(os.path.join(cache, f'ortho{z}'), exist_ok=True)
    print(f'orthophoto: {(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles...')
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            path = bl.fetch(ORTHO.format(z=z, x=tx, y=ty), os.path.join(cache, f'ortho{z}', f'{tx}_{ty}.jpg'),
                            lambda d: d[:2] == b'\xff\xd8')
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = \
                np.asarray(Image.open(path).convert('RGB'))
    if z >= 16:
        mosaic, n = remove_stamps(mosaic)
        print(f'  {n} year stamps painted over')
    rows, cols = gy - ty0 * 256 - 0.5, gx - tx0 * 256 - 0.5
    out = np.stack([ndimage.map_coordinates(mosaic[..., k].astype(np.float32), [rows, cols], order=1, mode='nearest')
                    for k in range(3)], 1)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8).reshape(px, px, 3))


def bake_bev(args, site):
    cache = args.cache
    os.makedirs(cache, exist_ok=True)
    lat0, lon0 = site['pilot_ll']
    aeqd = f'+proj=aeqd +lat_0={lat0} +lon_0={lon0} +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs'
    to_laea = Transformer.from_crs(aeqd, 3035, always_xy=True)
    local_to_ll = Transformer.from_crs(aeqd, 4326, always_xy=True)
    ll_to_local = Transformer.from_crs(4326, aeqd, always_xy=True)
    e0, n0 = Transformer.from_crs(4326, 3035, always_xy=True).transform(lon0, lat0)
    sq_e, sq_n = int(e0 // 50000 * 50000), int(n0 // 50000 * 50000)
    dtm_f = BevRaster('DTM', sq_e, sq_n, cache)
    dsm_f = BevRaster('DSM', sq_e, sq_n, cache)

    def sample(raster, xs, zs, metres):
        X, Z = np.meshgrid(xs, zs)
        es, ns = to_laea.transform(X.ravel(), (-Z).ravel())
        lvl = raster.level_for(metres)
        return raster.sample(lvl, np.asarray(es), np.asarray(ns)).reshape(X.shape).astype(np.float32)

    # The site at 1 m.
    half = site['half']
    xs, zs, n = grid(half, 1)
    print('BEV heights (1 m)...')
    dtm = sample(dtm_f, xs, zs, 1)
    dsm = sample(dsm_f, xs, zs, 1)
    pc = pr = n // 2
    h0 = float(np.nanmedian(dtm[pr - 3:pr + 3, pc - 3:pc + 3]))
    ground = dtm - h0
    ndsm = np.maximum(0, dsm - dtm)

    # OpenStreetMap, over the site.
    lon_a, lat_a = local_to_ll.transform(-half - 50, -half - 50)
    lon_b, lat_b = local_to_ll.transform(half + 50, half + 50)
    print('OpenStreetMap...')
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lon_a:.5f},{lat_a:.5f},{lon_b:.5f},{lat_b:.5f}'
    osm = bl.fetch(url, os.path.join(cache, 'osm.xml'), lambda d: b'<osm' in d[:400])

    def to_local(lon, lat):
        x, y = ll_to_local.transform(lon, lat)
        return (x, -y)

    areas, lines = bl.load_osm(osm, to_local)
    print(f'{len(areas)} OSM areas, {len(lines)} lines')

    # Buildings from OSM with their LIDAR heights; then the vegetation is
    # whatever stands above the ground off them (the BEV has no separate
    # vegetation model).
    buildings = bl.buildings_from(areas, ndsm, ndsm, xs, zs)
    from PIL import ImageDraw
    img = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(img)
    for b in buildings:
        d.polygon([(x - xs[0] + 0.5, z - zs[0] + 0.5) for x, z in b['pts']], fill=1)
    on_building = ndimage.binary_dilation(np.asarray(img, bool), iterations=2)
    vom = np.where(on_building | (ndsm < 0.5), 0, ndsm).astype(np.float32)
    # Lone 1-2 m speckles (fences, cars, wires) aren't plants.
    vom = np.where(ndimage.grey_opening(vom, size=(2, 2)) > 0.3, vom, 0)
    # Nor are standing crops: wide stretches mostly covered in 0.8-4.5 m
    # "vegetation" with hardly anything taller (maize, flown in late summer).
    # Hedges and tree lines are narrower, or have trees in them.
    low = ndimage.uniform_filter(((vom > 0.8) & (vom < 4.5)).astype(np.float32), 21)
    tall = ndimage.uniform_filter((vom >= 4.5).astype(np.float32), 21)
    crop = ndimage.binary_dilation((low > 0.45) & (tall < 0.03), iterations=6)
    print(f'  {crop.sum() / 1e4:.1f} ha of crops left out')
    vom = np.where(crop & (vom < 5), 0, vom).astype(np.float32)

    cell = 4
    tg = ndimage.zoom(ndimage.gaussian_filter(ground, cell / 2), 1 / cell, order=1)
    terrain = np.round(tg * 100).astype('<i2')

    trees = bl.find_trees(vom, xs, zs, args.max_trees)
    no_plant = bl.no_plant_mask(areas, lines, buildings, float(xs[0] - 0.5), float(zs[0] - 0.5), n)
    bushes = bl.find_bushes(vom, xs, zs, no_plant, args.max_bushes)
    print(f'{len(trees)} trees, {len(bushes)} bush points, {len(buildings)} buildings')
    # The ground's colours: the orthophoto (OpenStreetMap doesn't have this
    # valley's patchwork of fields), about 1 m a pixel.
    near_img = ortho_map(lat0, lon0, local_to_ll, half, args.ground_px, cache, z=17)
    near_img.save(os.path.join(cache, 'ground-preview.jpg'))
    near_buf = io.BytesIO()
    near_img.save(near_buf, 'JPEG', quality=85, optimize=True)

    # Conifer or broadleaf: spruce and pine are much darker from above than
    # the broadleaves (beech, ash, alder) in the orthophoto.
    shade = np.asarray(near_img.convert('L')).astype(np.float32)
    sc = args.ground_px / n
    kinds = []
    for x, z, h, r in trees:
        i, j, k = int((z - zs[0] + 0.5) * sc), int((x - xs[0] + 0.5) * sc), max(1, int(r * 0.5 * sc))
        lum = float(shade[max(0, i - k):i + k + 1, max(0, j - k):j + k + 1].mean())
        kinds.append('c' if lum < site.get('conifer_below', 60) and h > 4 else 'b')
    print(f'  {kinds.count("c")} conifers')

    # The mountains round about: every `far_cell` m, in decimetres.
    fh, fc = site['far_half'], site['far_cell']
    fxs, fzs, fn = grid(fh, fc)
    print(f'BEV heights ({fc} m, {2 * fh / 1000:.0f} km square)...')
    far = sample(dtm_f, fxs, fzs, fc / 2) - h0
    far_dm = np.round(far * 10).astype('<i2')
    # And their colours, from the orthophoto.
    far_img = ortho_map(lat0, lon0, local_to_ll, fh, 2048, cache)
    far_img.save(os.path.join(cache, 'far-preview.jpg'))
    buf = io.BytesIO()
    far_img.save(buf, 'JPEG', quality=80, optimize=True)

    out = {
        'id': args.site,
        'name': site['name'],
        'credits': 'Heights: ALS DTM and DSM © BEV (Bundesamt für Eich- und Vermessungswesen), CC BY 4.0. '
                   'Orthophoto: basemap.at, CC BY 4.0. Map data © OpenStreetMap contributors (ODbL).',
        'origin': {'height': round(h0, 2), 'lat': lat0, 'lon': lon0, 'trueNorth': 0,
                   # Geoid height above the ellipsoid here (EGM2008, m): Google's tiles are on the ellipsoid.
                   'geoid': site.get('geoid', 49)},
        'size': n,
        'terrain': {'cell': cell, 'n': int(terrain.shape[0]), 'x0': float(xs[0] - 0.5 + cell / 2), 'z0': float(zs[0] - 0.5 + cell / 2),
                    'cm': bl.b64(terrain)},
        'far': {'cell': fc, 'n': fn, 'x0': float(fxs[0]), 'z0': float(fzs[0]), 'dm': bl.b64(far_dm)},
        'trees': [v for t in trees for v in (bl.r1(t[0]), bl.r1(t[1]), bl.r1(t[2]), bl.r1(t[3]))],
        # Each tree's kind, from the orthophoto: c conifer, b broadleaf.
        'treeKinds': ''.join(kinds),
        'bushes': [v for b in bushes for v in (bl.r1(b[0]), bl.r1(b[1]), bl.r1(b[2]))],
        'buildings': buildings,
        'ground': {'x0': float(xs[0] - 0.5), 'z0': float(zs[0] - 0.5), 'size': n, 'jpg': base64.b64encode(near_buf.getvalue()).decode()},
        'farGround': {'x0': -fh, 'z0': -fh, 'size': 2 * fh, 'jpg': base64.b64encode(buf.getvalue()).decode()},
    }
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f'{args.site}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)')
