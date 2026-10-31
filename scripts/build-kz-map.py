#!/usr/bin/env python3
"""Генерирует public/kz-map-data.js — упрощённые границы областей Казахстана для карты в My Market → Аналитика.

Источник границ: geoBoundaries (https://www.geoboundaries.org, лицензия CC BY 4.0), KAZ ADM1.
Запуск: python3 scripts/build-kz-map.py путь/к/geoBoundaries-KAZ-ADM1_simplified.geojson
"""
import json, math, sys

LAT0, LON0, LAT_TOP = 48.0, 46.0, 55.6
K = 40.0  # пикселей на градус широты
COSK = math.cos(math.radians(LAT0))

def proj(lon, lat):
    return ((lon - LON0) * COSK * K, (LAT_TOP - lat) * K)

def dp(points, eps):
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]; bx, by = points[b]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy) or 1e-9
        idx, dmax = -1, 0.0
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / den
            if d > dmax:
                idx, dmax = i, d
        if dmax > eps and idx != -1:
            keep[idx] = True
            stack.append((a, idx)); stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]

NAMES = {
    'KZ-PAV': 'Павлодарская область', 'KZ-ZHA': 'Жамбылская область', 'KZ-KUS': 'Костанайская область',
    'KZ-MAN': 'Мангистауская область', 'KZ-KAR': 'Карагандинская область', 'KZ-KZY': 'Кызылординская область',
    'KZ-VOS': 'Восточно-Казахстанская область', 'KZ-AKT': 'Актюбинская область', 'KZ-ATY': 'Атырауская область',
    'KZ-YUZ': 'Туркестанская область', 'KZ-AKM': 'Акмолинская область', 'KZ-ALM': 'Алматинская область',
    'KZ-SEV': 'Северо-Казахстанская область', 'KZ-ALA': 'Алматы', 'KZ-ZAP': 'Западно-Казахстанская область',
    'KZ-AST': 'Астана',
}

src = json.load(open(sys.argv[1]))
regions = []
for f in src['features']:
    iso = f['properties']['shapeISO']
    g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    d = []
    for poly in polys:
        for ring in poly:
            pts = [proj(lon, lat) for lon, lat in ring]
            # кольцо замкнуто (первая точка = последней) — режем по самой далёкой точке и упрощаем обе половины
            far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
            pts = dp(pts[:far + 1], 0.35)[:-1] + dp(pts[far:], 0.35)
            if len(pts) < 4:
                continue
            d.append('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in pts) + 'Z')
    regions.append({'id': iso, 'name': NAMES.get(iso, iso), 'd': ''.join(d)})

width = (87.6 - LON0) * COSK * K
height = (LAT_TOP - 40.4) * K
cities = {  # lat, lon, область
    'Алматы': (43.238, 76.945, 'KZ-ALA'), 'Астана': (51.169, 71.449, 'KZ-AST'), 'Шымкент': (42.315, 69.587, 'KZ-YUZ'),
    'Караганда': (49.806, 73.085, 'KZ-KAR'), 'Актобе': (50.283, 57.167, 'KZ-AKT'), 'Тараз': (42.900, 71.378, 'KZ-ZHA'),
    'Павлодар': (52.287, 76.967, 'KZ-PAV'), 'Усть-Каменогорск': (49.948, 82.628, 'KZ-VOS'), 'Семей': (50.411, 80.227, 'KZ-VOS'),
    'Атырау': (47.107, 51.917, 'KZ-ATY'), 'Костанай': (53.214, 63.625, 'KZ-KUS'), 'Кызылорда': (44.852, 65.509, 'KZ-KZY'),
    'Уральск': (51.233, 51.367, 'KZ-ZAP'), 'Петропавловск': (54.867, 69.150, 'KZ-SEV'), 'Актау': (43.650, 51.150, 'KZ-MAN'),
    'Туркестан': (43.297, 68.252, 'KZ-YUZ'), 'Кокшетау': (53.285, 69.378, 'KZ-AKM'), 'Талдыкорган': (45.016, 78.373, 'KZ-ALM'),
    'Экибастуз': (51.723, 75.323, 'KZ-PAV'), 'Жезказган': (47.780, 67.770, 'KZ-KAR'),
}
out = {'width': round(width, 1), 'height': round(height, 1), 'regions': regions, 'cities': {}}
for name, (lat, lon, reg) in cities.items():
    x, y = proj(lon, lat)
    out['cities'][name] = {'x': round(x, 1), 'y': round(y, 1), 'lat': lat, 'lon': lon, 'region': reg}

js = ('/* Сгенерировано scripts/build-kz-map.py. Границы: geoBoundaries (CC BY 4.0). */\n'
      'window.KZ_MAP = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
open('public/kz-map-data.js', 'w').write(js)
print('ok', len(js), 'bytes', out['width'], out['height'])
