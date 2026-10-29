"""The optional reverse geocoder: fills the address of stops ("where did he wait for 40 minutes?").

OFF by default (GeoTrackingSettings.reverse_geocode_provider = 'off'): no coordinate ever leaves the server. When HR
switches it to 'nominatim' the scheduler's worker asks OpenStreetMap's Nominatim, politely:

  * never inside a request: only ``run_geocode_worker``, which the scheduler thread calls;
  * at most one request per second (Nominatim's usage policy), at most ``BATCH`` stops per run;
  * a User-Agent that names the application;
  * results are cached by a ~11 m grid cell, so the same place is looked up once, not once per stop or per rebuild;
  * a failed lookup is skipped (tried again on a later run); it never raises.
"""

from __future__ import annotations

import logging
import time as time_module
from collections.abc import Callable

from ..models import DutyTrackSegment, GeoTrackingSettings

logger = logging.getLogger(__name__)

BATCH = 10
MIN_INTERVAL_S = 1.0
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "UKTextiles-HRMS/1.0 (on-duty geo-tracking; contact: HR)"
TIMEOUT_S = 8

_cache: dict[tuple[float, float], str] = {}
_CACHE_MAX = 5000


def _cell(lat: float, lng: float) -> tuple[float, float]:
    return (round(lat, 4), round(lng, 4))


def fetch_nominatim(lat: float, lng: float) -> str:
    """One reverse lookup; returns the display name or ''. Network errors are logged and give ''."""
    import requests

    try:
        r = requests.get(
            NOMINATIM_URL,
            params={"format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "zoom": 18, "addressdetails": 0},
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
            timeout=TIMEOUT_S,
        )
        if r.status_code != 200:
            logger.warning("Nominatim answered %s", r.status_code)
            return ""
        return (r.json().get("display_name") or "")[:500]
    except Exception as exc:  # never break the scheduler job
        logger.warning("Nominatim lookup failed: %s", exc)
        return ""


def run_geocode_worker(
    limit: int = BATCH,
    *,
    fetch: Callable[[float, float], str] | None = None,
    sleep: Callable[[float], None] = time_module.sleep,
) -> dict:
    """Fill the address of up to ``limit`` stop segments that have none. Returns {"provider", "looked_up", "filled",
    "cached"}. ``fetch`` and ``sleep`` are injectable for tests."""
    provider = GeoTrackingSettings.get().reverse_geocode_provider
    result = {"provider": provider, "looked_up": 0, "filled": 0, "cached": 0}
    if provider != GeoTrackingSettings.REVERSE_GEOCODE_NOMINATIM:
        return result
    fetch = fetch or fetch_nominatim
    stops = list(
        DutyTrackSegment.objects.filter(kind=DutyTrackSegment.KIND_STOP, address="", center_lat__isnull=False).order_by(
            "-started_at"
        )[:limit]
    )
    last_request = 0.0
    for seg in stops:
        lat, lng = float(seg.center_lat), float(seg.center_lng)
        key = _cell(lat, lng)
        address = _cache.get(key, "")
        if address:
            result["cached"] += 1
        else:
            wait = MIN_INTERVAL_S - (time_module.monotonic() - last_request)
            if last_request and wait > 0:
                sleep(wait)
            last_request = time_module.monotonic()
            address = fetch(lat, lng)
            result["looked_up"] += 1
            if address:
                if len(_cache) >= _CACHE_MAX:
                    _cache.clear()
                _cache[key] = address
        if address:
            DutyTrackSegment.objects.filter(pk=seg.pk, address="").update(address=address)
            result["filled"] += 1
    return result
