"""Static map pictures for the On-Duty journey report (journey_pdf.py).

A report needs a real picture of the map with the route drawn on it, not a list of coordinates. There is no map server of our own,
so this fetches the public OpenStreetMap tiles the HR portal's own map already shows, stitches the ones a picture needs into one
image with Pillow, and draws the route, the start / end markers and the numbered stops on it. Nothing here touches the database.

Being a good neighbour to the tile server: one descriptive User-Agent, a few tiles at a time, every tile kept in memory for the next
report, and a hard time budget per report. When the tiles cannot be had (the server has no internet, the tile server is down or
the budget is spent) the picture is still made: the route and the markers on a plain grid, with a line saying so, so a report is
never refused for want of a map.
"""

from __future__ import annotations

import io
import math
import os
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from PIL import Image, ImageDraw, ImageFont

TILE_URL = os.environ.get("GEO_REPORT_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
ATTRIBUTION = os.environ.get("GEO_REPORT_TILE_ATTRIBUTION", "Map data: OpenStreetMap contributors")
USER_AGENT = "UKTextiles-HRMS/1.0 (On-Duty journey report; internal use)"
TILE_SIZE = 256
MAX_ZOOM = 17
TILE_TIMEOUT_S = 4
WORKERS = 6
# the tiles kept for the next report (about 20 KB each): the oldest go first
CACHE_LIMIT = 800

_cache: dict[tuple[int, int, int], bytes] = {}
_cache_lock = threading.Lock()

ROUTE_COLOR = (37, 99, 235)  # blue
ROUTE_CASING = (255, 255, 255)
START_COLOR = (22, 163, 74)  # green: the start and the end are one colour
STOP_SHORT_COLOR = (245, 158, 11)  # amber: under 15 minutes
STOP_LONG_COLOR = (126, 34, 206)  # purple: 15 minutes or more
GAP_COLOR = (100, 116, 139)


@dataclass
class Marker:
    lat: float
    lng: float
    label: str = ""
    color: tuple[int, int, int] = STOP_SHORT_COLOR
    radius: int = 13
    # a start / end marker: drawn first (a stop at the same place sits on top of it, inside its ring) with a name tag beside it
    tag: str = ""
    tag_below: bool = False


@dataclass
class MapBudget:
    """The time one report may spend fetching tiles, and whether the tile server has proved unreachable."""

    deadline: float = field(default_factory=lambda: time.monotonic() + 25.0)
    failures: int = 0
    fetched: int = 0

    @property
    def spent(self) -> bool:
        return time.monotonic() >= self.deadline or (self.failures >= 4 and self.fetched == 0)


def _font(size: int, bold: bool = False):
    names = ("arialbd.ttf", "DejaVuSans-Bold.ttf") if bold else ("arial.ttf", "DejaVuSans.ttf")
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def world_xy(lat: float, lng: float, zoom: int) -> tuple[float, float]:
    """Pixel position of a coordinate in the whole-world picture at `zoom` (Web Mercator)."""
    lat = max(-85.0511, min(85.0511, lat))
    n = TILE_SIZE * (2**zoom)
    x = (lng + 180.0) / 360.0 * n
    rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * n
    return x, y


def fit_zoom(coords: list[tuple[float, float]], width: int, height: int, pad: int, max_zoom: int = MAX_ZOOM) -> int:
    """The largest zoom at which every coordinate fits the picture with `pad` pixels to spare."""
    for zoom in range(max_zoom, 2, -1):
        xs, ys = zip(*(world_xy(lat, lng, zoom) for lat, lng in coords))
        if max(xs) - min(xs) <= width - 2 * pad and max(ys) - min(ys) <= height - 2 * pad:
            return zoom
    return 3


def _fetch(z: int, x: int, y: int, budget: MapBudget) -> bytes | None:
    key = (z, x, y)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    if budget.spent:
        return None
    url = TILE_URL.format(z=z, x=x, y=y)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=TILE_TIMEOUT_S) as response:  # noqa: S310 - a fixed https tile address
            data = response.read()
    except Exception:
        budget.failures += 1
        return None
    budget.fetched += 1
    with _cache_lock:
        if len(_cache) >= CACHE_LIMIT:
            for old in list(_cache)[: CACHE_LIMIT // 4]:
                _cache.pop(old, None)
        _cache[key] = data
    return data


def _thin(points: list[tuple[float, float]], limit: int = 1800) -> list[tuple[float, float]]:
    if len(points) <= limit:
        return points
    step = (len(points) - 1) / (limit - 1)
    return [points[round(i * step)] for i in range(limit)]


def render(
    route: list[tuple[float, float]],
    markers: list[Marker],
    width: int,
    height: int,
    budget: MapBudget,
    *,
    zoom: int | None = None,
    pad: int = 50,
    line_width: int = 6,
) -> tuple[bytes, bool]:
    """(JPEG bytes, whether real map tiles are behind it) of a picture `width` x `height` px with the route and markers on it.
    `zoom` pins the zoom (a stop's close-up); otherwise it is the largest at which the route and every marker fit."""
    coords = list(route) + [(m.lat, m.lng) for m in markers]
    if not coords:
        coords = [(11.1085, 77.3411)]
    lats = [c[0] for c in coords]
    lngs = [c[1] for c in coords]
    center = ((min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2)
    z = zoom if zoom is not None else fit_zoom(coords, width, height, pad)
    cx, cy = world_xy(center[0], center[1], z)
    left, top = cx - width / 2, cy - height / 2

    image = Image.new("RGB", (width, height), (226, 232, 240))
    wanted = [
        (tx, ty)
        for tx in range(int(left // TILE_SIZE), int((left + width) // TILE_SIZE) + 1)
        for ty in range(int(top // TILE_SIZE), int((top + height) // TILE_SIZE) + 1)
        if 0 <= tx < 2**z and 0 <= ty < 2**z
    ]
    got = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(lambda t: (t, _fetch(z, t[0], t[1], budget)), wanted))
    for (tx, ty), data in results:
        if not data:
            continue
        try:
            tile = Image.open(io.BytesIO(data)).convert("RGB")
        except Exception:
            continue
        image.paste(tile, (round(tx * TILE_SIZE - left), round(ty * TILE_SIZE - top)))
        got += 1
    has_tiles = got > 0

    draw = ImageDraw.Draw(image, "RGBA")
    if not has_tiles:
        # no map behind it: a plain grid so the route still reads as a shape
        for gx in range(0, width, 64):
            draw.line([(gx, 0), (gx, height)], fill=(203, 213, 225, 255), width=1)
        for gy in range(0, height, 64):
            draw.line([(0, gy), (width, gy)], fill=(203, 213, 225, 255), width=1)

    def to_px(lat: float, lng: float) -> tuple[float, float]:
        x, y = world_xy(lat, lng, z)
        return x - left, y - top

    line = [to_px(lat, lng) for lat, lng in _thin(route)]
    if len(line) >= 2:
        draw.line(line, fill=ROUTE_CASING + (230,), width=line_width + 4, joint="curve")
        draw.line(line, fill=ROUTE_COLOR + (255,), width=line_width, joint="curve")
        for px in (line[0], line[-1]):
            r = (line_width + 4) / 2
            draw.ellipse([px[0] - r, px[1] - r, px[0] + r, px[1] + r], fill=ROUTE_CASING + (230,))
    font = _font(15, bold=True)
    tag_font = _font(14, bold=True)
    ordered = sorted(markers, key=lambda m: 0 if m.tag else 1)
    for m in ordered:
        x, y = to_px(m.lat, m.lng)
        r = m.radius
        draw.ellipse([x - r - 2, y - r - 2, x + r + 2, y + r + 2], fill=(255, 255, 255, 255))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=m.color + (255,))
        if m.label:
            draw.text((x, y), m.label, fill=(255, 255, 255, 255), font=font, anchor="mm")
    for m in ordered:
        if not m.tag:
            continue
        x, y = to_px(m.lat, m.lng)
        box = draw.textbbox((0, 0), m.tag, font=tag_font)
        tw, th = box[2] - box[0], box[3] - box[1]
        tag_top = y + m.radius + 8 if m.tag_below else y - m.radius - th - 18
        left_x = x - tw / 2 - 7
        draw.rounded_rectangle([left_x, tag_top, left_x + tw + 14, tag_top + th + 10], radius=5, fill=m.color + (255,))
        draw.text((x, tag_top + 5 + th / 2), m.tag, fill=(255, 255, 255, 255), font=tag_font, anchor="mm")

    note = ATTRIBUTION if has_tiles else "Map tiles could not be loaded: the route is drawn on a plain grid."
    small = _font(12)
    box = draw.textbbox((0, 0), note, font=small)
    tw, th = box[2] - box[0], box[3] - box[1]
    draw.rectangle([width - tw - 14, height - th - 12, width, height], fill=(255, 255, 255, 215))
    draw.text((width - tw - 8, height - th - 8), note, fill=(51, 65, 85, 255), font=small)

    out = io.BytesIO()
    image.save(out, format="JPEG", quality=88, optimize=True)
    return out.getvalue(), has_tiles
