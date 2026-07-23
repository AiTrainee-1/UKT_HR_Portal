"""
Plain-stdlib distance calculation for geofenced attendance — no geopy
dependency, consistent with this codebase's minimal-dependency style.
"""
import math


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lng points, in meters."""
    R = 6371000.0  # Earth radius, meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))
