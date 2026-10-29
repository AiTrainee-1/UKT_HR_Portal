"""The journey pipeline: raw GPS fixes + connectivity events -> travel, stops and gaps -> a summary.

Everything up to ``compute_journey`` is PURE (plain data in, plain data out, no database, no clock), so it is tested with
synthetic tracks. ``rebuild(track)`` at the bottom is the only part that touches the database: it reads the track's raw
points and events, runs the pipeline and replaces the track's derived segments and summary in ONE transaction. It is
deterministic and idempotent (the same raw rows always give the same result) and cheap enough to run on the whole track
every time (a track has at most a few thousand points).

The five steps (parameters come from GeoTrackingSettings, see Params):

1 CLEAN     sort by time then seq; drop exact duplicates; drop a fix less accurate than max_accuracy_m; drop a TELEPORT
            (an implied speed above max_speed_kmh from the last kept fix). Mock-location fixes are KEPT and flagged. A
            run of mutually consistent fixes that all look like teleports from the anchor is a real relocation (the
            anchor was the bad one) and is accepted instead of being rejected for ever.
2 STOPS     a stop is a run of cleaned fixes that all stay within R of the run's median centre for at least stop_seconds,
            R = max(stop_radius_m, stop_accuracy_factor x the run's median accuracy). A fix is judged against its OWN
            accuracy as well (it is inside when it is within max(R, 1.5 x its accuracy, at most 150 m)), so one poor fix
            neither breaks nor shortens a stop; one or two stray fixes (GPS jitter) do not break it either. Two fixes
            that are at least stop_seconds apart and within reach of each other are a stop even when no fix lies between
            them (a phone that only reports every minute or so). Two more ways to a stop: a run of fixes the phone itself
            called 'still' (within twice that radius, never less than 75 m) and the two fixes either side of a gap that
            are within 75 m of each other (the phone was somewhere it could not hear GPS: the gap is part of the stop,
            flagged 'estimated'). Stops that overlap are one stop.
            Then a stop that is really SEVERAL SEQUENTIAL DWELL PLACES (a first break, a walk of a few dozen metres, a
            second break) is split, by evidence and not by a radius: its fixes are cut into tight blocks (every fix within
            max(25 m, 1.5 x its own accuracy) of the block's accuracy-weighted median centre), consecutive blocks are one
            place unless they are separable (centres farther apart than 25 m, than 2.5 x the two blocks' scatter added and
            than 0.9 x their median accuracies added), and every place that lasts stop_seconds is a stop of its own. A
            place that does not (a pause of 2:50 before the real stop) goes back to travel, a fix at the seam goes to the
            place whose centre it is nearer to. Two tight breaks 65 m apart are two stops, 12 m apart one, a phone that
            flip-flops between two positions or a person drifting indoors is one. Stops that are less than
            merge_stop_gap_seconds apart are one stop only when they are not separable: the same notion of "the same
            place", not "within 2R".
            Then the EDGES are settled. First extended: the fixes just outside a stop that are within reach of its
            stable centre belong to it (a run grows against a median that is still moving while it holds few fixes, so
            a person walking round a compound could lose the first minutes of the stay to travel). Then trimmed: the
            leniency that lets a run start (its first fixes may be twice as far) can also let it start while the
            phone is still on its way in, or end while it is already leaving. A fix at the start or end of a stop goes
            back to travel when it is moving (the phone says vehicle/bicycle/running, or the step to its neighbour is
            faster than walking and larger than the GPS noise), lies outside the stop's inner radius and is farther
            from the centre than its neighbour (an approach or a departure, not scatter). The stop starts at the
            first and ends at the last fix of the stable core; its centre and `radius_m` (the farthest fix from the
            centre: "the phone's positions stayed within X m") are computed on that core, and a core shorter than
            stop_seconds is no stop. Distance alone never trims a fix away: it takes movement.
3 GAPS      between two consecutive fixes that are not inside the same stop, more than gap_seconds with no fix is a gap
            (its cause comes from the overlapping events, else 'unknown'). On a finished track the time before the first
            fix and after the last fix is a gap too when it is longer than gap_seconds (flagged estimated).
4 TRAVEL    everything else. distance_m = the sum of the haversine distances of consecutive cleaned fixes inside the
            travel segment; the straight line across a gap is NOT distance travelled (it is reported separately in
            flags.gapStraightLineM). The polyline is Ramer-Douglas-Peucker simplified (at most 400 vertices).
5 SUMMARY   distance, travel/stop/gap seconds, stop count, longest stop, top speed, first fix. The segments are one
            contiguous partition of [first fix (or the leading gap), summary_through], so travel_s + stop_s + gap_s is
            exactly the covered duty time. All instants are whole UTC seconds, so the partition adds up exactly.

``fix_from_row`` / ``event_from_row`` adapt database rows; the module-level constants are deliberate and documented where
they are used.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone as dt_timezone

from ..geo_utils import haversine_distance_m

# ── constants (deliberately not settings: they define what the algorithm means) ──────────────────────────────────────

#: the two fixes either side of a gap closer than this mean the phone stayed where it was (a stop, not a gap)
SPARSE_STILL_M = 75.0
#: SEQUENTIAL DWELL PLACES inside one stop (see _split_places). A place is a block of fixes that are all within
#: max(SPLIT_TIGHT_M, 1.5 x their own accuracy) of the block's median centre; two places are two places when their centres
#: are farther apart than SPLIT_MIN_SEPARATION_M, than SPLIT_SCATTER_FACTOR x (their typical scatters added) and than
#: SPLIT_ACCURACY_FACTOR x (their median accuracies added): evidence, not one big radius
SPLIT_TIGHT_M = 25.0
SPLIT_MIN_SEPARATION_M = 25.0
SPLIT_SCATTER_FACTOR = 2.5
SPLIT_ACCURACY_FACTOR = 0.9
#: how many consecutive stray fixes (GPS jitter) a stop tolerates before it ends
SPIKE_TOLERANCE = 2
#: a run's median centre is not trustworthy until it holds this many fixes: until then a fix may be up to twice as far
RUN_WARMUP_FIXES = 5
#: a fix is inside a run when it is within max(the run's radius, OWN_ACCURACY_REACH x its OWN accuracy), that own reach being
#: capped at OWN_REACH_CAP_M: a poor fix is a poor measurement, not a departure
OWN_ACCURACY_REACH = 1.5
OWN_REACH_CAP_M = 150.0
#: edge trimming (see _trim_edges): an edge fix is only ever trimmed when it lies beyond this fraction of the stop's detection
#: radius (and beyond TRIM_ACCURACY_FACTOR x its own accuracy) from the core's centre, and is farther out than its inner
#: neighbour by more than the margin (an approach or a departure, not scatter around the centre)
TRIM_RADIUS_FRACTION = 0.6
TRIM_ACCURACY_FACTOR = 1.5
TRIM_APPROACH_MARGIN_M = 3.0
#: and it must be MOVING: the phone calls it one of these activities, or the step to its inner neighbour is at least this
#: long, longer than MOVE_NOISE_FACTOR x the combined GPS error, and faster than a walking pace
FAST_ACTIVITIES = frozenset({"vehicle", "bicycle", "running"})
MOVE_MIN_STEP_M = 10.0
MOVE_NOISE_FACTOR = 1.5
MOVE_SPEED_MPS = 1.2
#: a safety valve on the trimming loop (a stop sheds a handful of fixes at an edge, never hundreds)
TRIM_MAX_ROUNDS = 400
#: consecutive mutually consistent "teleports" that make the NEW place the real one (when the old cluster is tiny) ...
RESYNC_MIN = 3
#: ... and that make it the real one whatever the old cluster's size
RESYNC_FORCE = 6
#: the pipeline's cap on a travel segment's polyline and on the whole-journey path
MAX_POLYLINE_VERTICES = 400
MAX_PATH_POINTS = 1500
#: how close (seconds) a point event (app killed, device shutdown, ...) must be to a gap to explain it
EVENT_SLACK_S = 120
#: a pair of fixes closer in time than this is not used for the top-speed figure (GPS noise over a short step)
MIN_SPEED_DT_S = 3

EARTH_R = 6371000.0


# ── data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Fix:
    """One GPS fix. ``t`` is whole UTC epoch seconds."""

    t: int
    lat: float
    lng: float
    acc: float | None = None
    speed: float | None = None
    activity: str = "unknown"
    mock: bool = False
    suspect: bool = False
    seq: int = 0


@dataclass(frozen=True, slots=True)
class Ev:
    """A connectivity / integrity event. ``end`` is None while an interval event is still open."""

    kind: str
    start: int
    end: int | None = None
    lat: float | None = None
    lng: float | None = None
    id: int | None = None


@dataclass(frozen=True)
class Params:
    stop_seconds: int = 180
    stop_radius_m: float = 50.0
    stop_accuracy_factor: float = 2.0
    merge_stop_gap_seconds: int = 120
    gap_seconds: int = 300
    max_accuracy_m: float = 100.0
    max_speed_kmh: float = 200.0

    @classmethod
    def from_settings(cls, s) -> "Params":
        return cls(
            stop_seconds=int(s.stop_seconds),
            stop_radius_m=float(s.stop_radius_m),
            stop_accuracy_factor=float(s.stop_accuracy_factor),
            merge_stop_gap_seconds=int(s.merge_stop_gap_seconds),
            gap_seconds=int(s.gap_seconds),
            max_accuracy_m=float(s.max_accuracy_m),
            max_speed_kmh=float(s.max_speed_kmh),
        )


@dataclass
class Stop:
    start: int  # index of the first fix in the cleaned list (after the edges were trimmed: the first fix of the core)
    end: int  # index of the last fix
    #: found by a rule that INFERS the stay (a run the phone called 'still', a bridged gap): always flagged estimated
    inferred: bool = False
    lat: float = 0.0
    lng: float = 0.0
    r: float = 0.0  # the detection radius
    spread: float = 0.0  # the largest distance of one of its fixes from the centre
    acc: float | None = None  # the median accuracy of its fixes
    estimated: bool = False  # inferred, or it spans a hole in the data (set when the stop is final)
    #: a stop that was one of several dwell places of a parent stop may not take back fixes of its neighbours' places
    lo_limit: int | None = None
    hi_limit: int | None = None
    #: where the rules found the stop, before its edges were extended / trimmed (merging judges "close in time" on this)
    raw_start: int = 0
    raw_end: int = 0


@dataclass
class Seg:
    kind: str  # travel | stop | gap
    start: int
    end: int
    distance_m: float = 0.0
    start_ll: tuple[float, float] | None = None
    end_ll: tuple[float, float] | None = None
    center: tuple[float, float] | None = None
    radius_m: float | None = None
    point_count: int = 0
    avg_speed_kmh: float = 0.0
    max_speed_kmh: float = 0.0
    polyline: list = field(default_factory=list)
    cause: str = ""
    estimated: bool = False
    event_id: int | None = None
    meta: dict = field(default_factory=dict)

    @property
    def duration_s(self) -> int:
        return max(0, self.end - self.start)


@dataclass
class CleanResult:
    fixes: list[Fix]
    dropped_accuracy: int = 0
    dropped_duplicate: int = 0
    dropped_teleport: int = 0
    jumps: set[int] = field(default_factory=set)  # i means: the step from fix i to fix i+1 is a relocation, not travel


@dataclass
class Journey:
    segments: list[Seg]
    summary: dict
    path: list[list]  # [[lat, lng, epoch_ms], ...] simplified, at most MAX_PATH_POINTS
    fixes: list[Fix]


# ── geometry ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def fast_dist_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Equirectangular distance: accurate to well under 1% below a few kilometres, ~10x cheaper than haversine. Used for
    the many "is this fix still within the stop radius" checks; the reported distances use the haversine."""
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2.0))
    y = math.radians(lat2 - lat1)
    return EARTH_R * math.hypot(x, y)


def _med(sorted_values: list[float]) -> float:
    m = len(sorted_values)
    if m % 2:
        return sorted_values[m // 2]
    return (sorted_values[m // 2 - 1] + sorted_values[m // 2]) / 2.0


def _speed_kmh(a: Fix, b: Fix) -> float:
    d = haversine_distance_m(a.lat, a.lng, b.lat, b.lng)
    dt = b.t - a.t
    if dt <= 0:
        return 0.0 if d < 1.0 else math.inf
    return d / dt * 3.6


def _rdp_indices(pts: list[tuple[float, float]], eps_m: float) -> list[int]:
    """Ramer-Douglas-Peucker on (lat, lng) pairs, iterative (no recursion limit), returns the indices to keep."""
    n = len(pts)
    if n <= 2:
        return list(range(n))
    lat0, lng0 = pts[0]
    kx = math.radians(1.0) * EARTH_R * math.cos(math.radians(lat0))
    ky = math.radians(1.0) * EARTH_R
    xs = [(p[1] - lng0) * kx for p in pts]
    ys = [(p[0] - lat0) * ky for p in pts]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay, bx, by = xs[a], ys[a], xs[b], ys[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = xs[i], ys[i]
            if seg2 == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                u = ((px - ax) * dx + (py - ay) * dy) / seg2
                u = 0.0 if u < 0.0 else 1.0 if u > 1.0 else u
                d = math.hypot(px - (ax + u * dx), py - (ay + u * dy))
            if d > best:
                best, best_i = d, i
        if best > eps_m:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [i for i in range(n) if keep[i]]


def simplify_indices(pts: list[tuple[float, float]], max_vertices: int, eps_start: float = 3.0) -> list[int]:
    """RDP with a tolerance that grows until at most ``max_vertices`` remain (first and last always stay)."""
    if len(pts) <= max_vertices:
        # still worth simplifying (collinear fixes carry no information), but never below 2
        return _rdp_indices(pts, eps_start) if len(pts) > 2 else list(range(len(pts)))
    eps = eps_start
    idx = _rdp_indices(pts, eps)
    guard = 0
    while len(idx) > max_vertices and guard < 40:
        eps *= 1.7
        idx = _rdp_indices(pts, eps)
        guard += 1
    if len(idx) > max_vertices:  # pathological: thin it evenly, keeping both ends
        step = (len(idx) - 1) / (max_vertices - 1)
        idx = sorted({idx[int(round(k * step))] for k in range(max_vertices)} | {idx[0], idx[-1]})
    return idx


# ── 1 CLEAN ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def clean(fixes: list[Fix], p: Params) -> CleanResult:
    """Sort, de-duplicate, drop inaccurate fixes and teleports. Mock fixes are kept (flagged on the Fix)."""
    result = CleanResult(fixes=[])
    ordered = sorted(fixes, key=lambda f: (f.t, f.seq))
    candidates: list[Fix] = []
    prev = None
    for f in ordered:
        if prev is not None and f.t == prev.t and f.lat == prev.lat and f.lng == prev.lng:
            result.dropped_duplicate += 1
            continue
        prev = f
        if f.acc is not None and f.acc > p.max_accuracy_m:
            result.dropped_accuracy += 1
            continue
        candidates.append(f)

    kept: list[Fix] = []
    pending: list[Fix] = []  # consecutive teleport candidates that agree with each other
    cluster_start = 0  # index in `kept` where the current cluster (since the last relocation) begins
    for f in candidates:
        if not kept:
            kept.append(f)
            continue
        if _speed_kmh(kept[-1], f) <= p.max_speed_kmh:
            kept.append(f)
            pending = []
            continue
        # a teleport candidate
        if pending and _speed_kmh(pending[-1], f) > p.max_speed_kmh:
            pending = [f]
        else:
            pending.append(f)
        small_old = len(kept) - cluster_start <= 2
        if len(pending) >= RESYNC_FORCE or (len(pending) >= RESYNC_MIN and small_old):
            result.dropped_teleport -= len(pending) - 1  # the earlier candidates were counted; they are kept now
            if small_old:
                # the old cluster was the outlier: forget it
                result.dropped_teleport += len(kept) - cluster_start
                del kept[cluster_start:]
            else:
                result.jumps.add(len(kept) - 1)
            cluster_start = len(kept)
            kept.extend(pending)
            pending = []
            continue
        result.dropped_teleport += 1
    # a pending cluster that never reached the resync threshold stays dropped (already counted)

    # jump indices were recorded against `kept` as it stood; deletions only ever happen from the tail, after which new
    # fixes are appended, so a recorded index (< cluster_start at that time) is still valid unless it was deleted
    result.fixes = kept
    result.jumps = {i for i in result.jumps if i < len(kept) - 1}
    return result


# ── 2 STOPS ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def _radius(accs: list[float], p: Params, scale: float = 1.0, min_radius: float = 0.0) -> float:
    base = p.stop_radius_m
    if accs:
        base = max(base, p.stop_accuracy_factor * _med(accs))
    return max(min_radius, scale * base)


def _reach(f: Fix, base: float) -> float:
    """How far from a run's centre this fix may be and still belong to it: the run's own reach, or 1.5 x the fix's OWN
    accuracy when that is more (never above 150 m). A fix that says "I am only good to 80 m" is judged against 80 m."""
    if f.acc:
        return max(base, min(OWN_REACH_CAP_M, OWN_ACCURACY_REACH * f.acc))
    return base


def _grow_run(
    fx: list[Fix], i: int, p: Params, *, scale: float = 1.0, min_radius: float = 0.0, only_still: bool = False
) -> int:
    """The last index of the run that starts at fx[i]: every fix stays within reach of the (median) centre (the run's radius,
    or its own accuracy-aware reach), tolerating up to SPIKE_TOLERANCE consecutive stray fixes that are followed by one
    back inside. Medians are kept incrementally in sorted lists, so growing a run costs O(k log k) however long it gets."""
    n = len(fx)
    first = fx[i]
    lats = [first.lat]
    lngs = [first.lng]
    accs = [first.acc] if first.acc is not None else []
    end = i
    spikes = 0
    j = i + 1
    while j < n:
        f = fx[j]
        if only_still and f.activity != "still":
            break
        c_lat, c_lng = _med(lats), _med(lngs)
        radius = _radius(accs, p, scale, min_radius)
        # the warm-up leniency never bridges a hole in the data: a jump over a gap is judged against the plain radius
        warming = len(lats) < RUN_WARMUP_FIXES and f.t - fx[j - 1].t <= p.gap_seconds
        reach = radius * 2.0 if warming else radius
        if fast_dist_m(c_lat, c_lng, f.lat, f.lng) <= _reach(f, reach):
            bisect.insort(lats, f.lat)
            bisect.insort(lngs, f.lng)
            if f.acc is not None:
                bisect.insort(accs, f.acc)
            end = j
            spikes = 0
            j += 1
            continue
        if spikes < SPIKE_TOLERANCE and j + 1 < n:
            nxt = fx[j + 1]
            if (not only_still or nxt.activity == "still") and fast_dist_m(c_lat, c_lng, nxt.lat, nxt.lng) <= _reach(
                nxt, reach
            ):
                spikes += 1
                j += 1
                continue
        break
    return end


def _stats(fx: list[Fix], a: int, b: int, p: Params) -> tuple[float, float, float, float, float | None]:
    """(centre lat, centre lng, detection radius, spread, median accuracy or None) of fixes a..b."""
    window = fx[a : b + 1]
    lats = sorted(f.lat for f in window)
    lngs = sorted(f.lng for f in window)
    accs = sorted(f.acc for f in window if f.acc is not None)
    c_lat, c_lng = _med(lats), _med(lngs)
    r = _radius(accs, p)
    spread = max(fast_dist_m(c_lat, c_lng, f.lat, f.lng) for f in window)
    return c_lat, c_lng, r, spread, (_med(accs) if accs else None)


def _has_inner_gap(fx: list[Fix], a: int, b: int, p: Params) -> bool:
    return any(fx[k + 1].t - fx[k].t > p.gap_seconds for k in range(a, b))


def _in_transit(e: Fix, inner: Fix, c_lat: float, c_lng: float, r: float, inner_d: float) -> bool:
    """Is ``e``, the outermost fix of a stop (``inner`` is its neighbour towards the stop's middle, ``inner_d`` that
    neighbour's distance from the centre), a fix of the phone still arriving or already leaving rather than of the stay?
    Every one of these must hold, so scatter around a stationary phone is never mistaken for movement:
      - it lies outside the stop's inner radius (0.6 R, and 1.5 x its own accuracy): a fix near the centre is the stay;
      - it is farther out than its neighbour (an approach or a departure; scatter has no direction);
      - it is moving: the phone calls it vehicle / bicycle / running, or the step to its neighbour is longer than the
        combined GPS noise, longer than 10 m and faster than a walking pace (so a person standing for minutes 65 m off
        the later fixes, with no step between them, is not "moving")."""
    d_e = fast_dist_m(c_lat, c_lng, e.lat, e.lng)
    if d_e <= max(TRIM_RADIUS_FRACTION * r, TRIM_ACCURACY_FACTOR * (e.acc or 0.0)):
        return False
    if d_e <= inner_d + TRIM_APPROACH_MARGIN_M:
        return False
    if e.activity in FAST_ACTIVITIES:
        return True
    step = fast_dist_m(e.lat, e.lng, inner.lat, inner.lng)
    dt = max(1, abs(inner.t - e.t))
    noise = MOVE_NOISE_FACTOR * math.hypot(e.acc or 0.0, inner.acc or 0.0)
    return step >= max(MOVE_MIN_STEP_M, noise) and step / dt >= MOVE_SPEED_MPS


def _extend_edges(
    fx: list[Fix],
    s: Stop,
    p: Params,
    lo: int,
    hi: int,
    before: tuple[float, float] | None = None,
    after: tuple[float, float] | None = None,
) -> None:
    """Take back the fixes just outside ``s`` that are within reach of its (stable) centre. A run grows against a median
    that is still moving while it holds only a few fixes, so a person walking round a compound used to lose the first
    minute or two of the stay to travel just because the run happened to start at the wrong place on the loop. Fixes
    are taken while they are contiguous in time (a hole in the data is never bridged here), up to SPIKE_TOLERANCE stray
    fixes are skipped when one back inside follows, and the stop stays between ``lo`` and ``hi`` (its neighbours').
    A fix that is nearer to the centre of the neighbouring stop (``before`` / ``after``) than to this stop's belongs to
    that stop: the walk between two places is shared at its midpoint, not swallowed by the place with the wider reach.
    Arrival / departure fixes this takes back are given up again by _trim_edges."""
    c_lat, c_lng, r, _spread, _acc = _stats(fx, s.start, s.end, p)

    def inside(f: Fix, neighbour: tuple[float, float] | None) -> bool | None:
        """True: take it. False: a stray. None: it is the neighbour's, stop extending."""
        own = fast_dist_m(c_lat, c_lng, f.lat, f.lng)
        if neighbour is not None and fast_dist_m(neighbour[0], neighbour[1], f.lat, f.lng) < own:
            return None
        return own <= _reach(f, r)

    a, strays, k = s.start, 0, s.start - 1
    while k >= lo and fx[k + 1].t - fx[k].t <= p.gap_seconds:
        took = inside(fx[k], before)
        if took is None:
            break
        if took:
            a, strays = k, 0
        else:
            strays += 1
            if strays > SPIKE_TOLERANCE:
                break
        k -= 1
    b, strays, k = s.end, 0, s.end + 1
    while k <= hi and fx[k].t - fx[k - 1].t <= p.gap_seconds:
        took = inside(fx[k], after)
        if took is None:
            break
        if took:
            b, strays = k, 0
        else:
            strays += 1
            if strays > SPIKE_TOLERANCE:
                break
        k += 1
    s.start, s.end = a, b


def _trim_edges(fx: list[Fix], s: Stop, p: Params) -> bool:
    """Give the arrival / departure fixes at the start and end of ``s`` back to travel (see _in_transit), moving
    ``s.start`` / ``s.end`` inwards one fix at a time while the stop's centre is recomputed on what is left. At least two
    fixes always stay. Returns False when the stable core is shorter than stop_seconds (and spans no hole in the data):
    that was a pause, not a stop."""
    a, b = s.start, s.end
    for _ in range(TRIM_MAX_ROUNDS):
        if b - a < 2:
            break
        c_lat, c_lng, r, _spread, _acc = _stats(fx, a, b, p)
        trim_a = _in_transit(fx[a], fx[a + 1], c_lat, c_lng, r, fast_dist_m(c_lat, c_lng, fx[a + 1].lat, fx[a + 1].lng))
        trim_b = _in_transit(fx[b], fx[b - 1], c_lat, c_lng, r, fast_dist_m(c_lat, c_lng, fx[b - 1].lat, fx[b - 1].lng))
        if not (trim_a or trim_b):
            break
        if trim_a:
            a += 1
        if trim_b and b - a >= 2:
            b -= 1
    s.start, s.end = a, b
    return fx[b].t - fx[a].t >= p.stop_seconds or _has_inner_gap(fx, a, b, p)


@dataclass
class _Place:
    """One dwell place: the fixes start..end, their (accuracy-weighted) median centre, their typical scatter around it (the
    75th percentile of the distance of a fix from the centre, a poor fix counting for less) and their median accuracy.
    What two places are compared on (see _separable). A stop that is a mixture of two positions (a phone flip-flopping)
    has a scatter as large as the distance between them, so it never reads as two places."""

    start: int
    end: int
    lat: float = 0.0
    lng: float = 0.0
    scatter: float = 0.0
    acc: float = 0.0


def _weight(f: Fix) -> float:
    """How much a fix counts towards where a place is: 1 / accuracy squared (accuracy between 5 and 100 m)."""
    return 1.0 / max(f.acc or 10.0, 5.0) ** 2


def _weighted_quantile(pairs: list[tuple[float, float]], q: float) -> float:
    """The smallest value whose accuracy-weighted share of the (value, weight) pairs reaches ``q``."""
    pairs = sorted(pairs)
    target = q * sum(w for _, w in pairs)
    cum = 0.0
    for v, w in pairs:
        cum += w
        if cum >= target * (1.0 - 1e-9):
            return v
    return pairs[-1][0]


class _WeightedMedian:
    """A running median in which a poor fix counts for less (weight 1 / accuracy squared, accuracy between 5 and 100 m): a
    few poor fixes of a phone indoors cannot drag the centre of a place away from the many good ones."""

    __slots__ = ("vals", "wts", "total")

    def __init__(self) -> None:
        self.vals: list[float] = []
        self.wts: list[float] = []
        self.total = 0.0

    def add(self, v: float, f: Fix) -> None:
        w = _weight(f)
        k = bisect.bisect(self.vals, v)
        self.vals.insert(k, v)
        self.wts.insert(k, w)
        self.total += w

    def value(self) -> float:
        half, cum = self.total / 2.0, 0.0
        for k, w in enumerate(self.wts):
            cum += w
            if cum > half * (1.0 + 1e-9):
                return self.vals[k]
            if cum >= half * (1.0 - 1e-9):  # exactly half: between this value and the next, like a plain median
                return (self.vals[k] + self.vals[k + 1]) / 2.0 if k + 1 < len(self.vals) else self.vals[k]
        return self.vals[-1]


def _place(fx: list[Fix], a: int, b: int) -> _Place:
    window = fx[a : b + 1]
    wlat, wlng = _WeightedMedian(), _WeightedMedian()
    for f in window:
        wlat.add(f.lat, f)
        wlng.add(f.lng, f)
    c_lat, c_lng = wlat.value(), wlng.value()
    accs = sorted(f.acc for f in window if f.acc)
    scatter = _weighted_quantile([(fast_dist_m(c_lat, c_lng, f.lat, f.lng), _weight(f)) for f in window], 0.75)
    return _Place(a, b, c_lat, c_lng, scatter, _med(accs) if accs else 0.0)


def _separable(p1: _Place, p2: _Place) -> bool:
    """Are two dwell places clearly two places and not one place seen through GPS noise? Their centres must be farther apart
    than 25 m, than 2.5 x the two places' typical scatter added, and than 0.9 x their median accuracies added. A tight
    stay 65 m from another is two places; the same distance between two drifting indoor stays (scatter and accuracy of the
    order of the distance itself) is one."""
    d = fast_dist_m(p1.lat, p1.lng, p2.lat, p2.lng)
    return d > max(
        SPLIT_MIN_SEPARATION_M,
        SPLIT_SCATTER_FACTOR * (p1.scatter + p2.scatter),
        SPLIT_ACCURACY_FACTOR * (p1.acc + p2.acc),
    )


def _tight_block(fx: list[Fix], i: int, hi: int) -> int:
    """The last index of the TIGHT block that starts at fx[i] (never beyond ``hi``): every fix within max(25 m, 1.5 x its
    own accuracy) of the block's running median centre, up to SPIKE_TOLERANCE stray fixes skipped when one back inside
    follows. The centre is a median weighted by accuracy. No warm-up leniency: this is the evidence for one place, not the
    lenient run that found the stop."""
    lats, lngs = _WeightedMedian(), _WeightedMedian()
    lats.add(fx[i].lat, fx[i])
    lngs.add(fx[i].lng, fx[i])
    end, spikes, j = i, 0, i + 1
    while j <= hi:
        f = fx[j]
        c_lat, c_lng = lats.value(), lngs.value()
        if fast_dist_m(c_lat, c_lng, f.lat, f.lng) <= _reach(f, SPLIT_TIGHT_M):
            lats.add(f.lat, f)
            lngs.add(f.lng, f)
            end, spikes, j = j, 0, j + 1
            continue
        if spikes < SPIKE_TOLERANCE and j + 1 <= hi:
            nxt = fx[j + 1]
            if fast_dist_m(c_lat, c_lng, nxt.lat, nxt.lng) <= _reach(nxt, SPLIT_TIGHT_M):
                spikes, j = spikes + 1, j + 1
                continue
        break
    return end


def _places_of(fx: list[Fix], a: int, b: int) -> list[_Place]:
    """The sequential dwell places among fixes a..b: tight blocks (at least two fixes), each merged into the previous place
    when the two are not separable (the same place seen again after a few stray fixes)."""
    places: list[_Place] = []
    i = a
    while i < b:
        end = _tight_block(fx, i, b)
        if end == i:
            i += 1
            continue
        if places and not _separable(places[-1], _place(fx, i, end)):
            places[-1] = _place(fx, places[-1].start, end)
        else:
            places.append(_place(fx, i, end))
        i = end + 1
    return places


def _settle_seam(fx: list[Fix], first: Stop, second: Stop, p: Params) -> None:
    """Two stops that touch (no fix between them) and are clearly two places may disagree with the run that found them about
    the fixes at the seam: a poor fix at the start of the second place is within reach of the first place's growing run and
    was taken by it. A fix at the seam goes to the place whose centre it is nearer to, as long as it is within that place's
    reach, the stop it leaves keeps two fixes and, if it lasted stop_seconds, still does."""
    if first.end + 1 != second.start:
        return
    left, right = _place(fx, first.start, first.end), _place(fx, second.start, second.end)
    if not _separable(left, right):
        return

    def lasts(a: int, b: int) -> bool:
        return fx[b].t - fx[a].t >= p.stop_seconds

    for _ in range(TRIM_MAX_ROUNDS):
        moved = False
        f = fx[left.end]
        d_left, d_right = (fast_dist_m(c.lat, c.lng, f.lat, f.lng) for c in (left, right))
        if (
            left.end - left.start >= 2
            and (lasts(left.start, left.end - 1) or not lasts(left.start, left.end))
            and d_right < d_left
            and d_right <= _reach(f, SPLIT_TIGHT_M)
        ):
            left.end -= 1
            right.start -= 1
            moved = True
        f = fx[right.start]
        d_left, d_right = (fast_dist_m(c.lat, c.lng, f.lat, f.lng) for c in (left, right))
        if (
            right.end - right.start >= 2
            and (lasts(right.start + 1, right.end) or not lasts(right.start, right.end))
            and d_left < d_right
            and d_left <= _reach(f, SPLIT_TIGHT_M)
        ):
            right.start += 1
            left.end += 1
            moved = True
        if not moved:
            break
    first.end, second.start = left.end, right.start


def _split_places(fx: list[Fix], s: Stop, p: Params) -> list[Stop]:
    """A stop that is really SEVERAL sequential dwell places (a first break, a walk of a few dozen metres, a second break)
    becomes one stop per place that lasts stop_seconds; a place that does not (a pause of 2:50 before the real stop) goes
    back to travel. The evidence is the fixes themselves, not a distance: see _places_of and _separable. A stop with one
    place, or whose places are all too short, is returned as it is."""
    a, b = s.start, s.end
    if b - a < 3 or fx[b].t - fx[a].t < p.stop_seconds:
        return [s]
    places = _places_of(fx, a, b)
    if len(places) < 2:
        return [s]
    if not any(fx[pl.end].t - fx[pl.start].t >= p.stop_seconds for pl in places):
        return [s]
    out: list[Stop] = []
    for k, pl in enumerate(places):
        if fx[pl.end].t - fx[pl.start].t < p.stop_seconds:
            continue
        out.append(
            Stop(
                pl.start,
                pl.end,
                False,  # a tight block is the base rule's own evidence, not an inference
                lo_limit=places[k - 1].end + 1 if k > 0 else None,
                hi_limit=places[k + 1].start - 1 if k + 1 < len(places) else None,
            )
        )
    return out


def detect_stops(fx: list[Fix], p: Params) -> list[Stop]:
    """The stops of a cleaned fix list, merged, edge-trimmed, in time order."""
    n = len(fx)
    if n < 2:
        return []
    raw: list[Stop] = []

    # (a) the base rule. Two fixes within reach of each other and at least stop_seconds apart are already a stop: no fix
    # needs to lie between them (a phone that reports once a minute, or a heartbeat every few minutes, stored two)
    i = 0
    while i < n - 1:
        end = _grow_run(fx, i, p)
        if end > i and fx[end].t - fx[i].t >= p.stop_seconds:
            raw.append(Stop(i, end))
            i = end + 1
        else:
            i += 1

    # (b) a run the phone itself calls 'still', looser radius (sparse / indoor fixes drift further than R)
    covered = [False] * n
    for s in raw:
        for k in range(s.start, s.end + 1):
            covered[k] = True
    i = 0
    while i < n - 1:
        if covered[i] or fx[i].activity != "still":
            i += 1
            continue
        end = _grow_run(fx, i, p, scale=2.0, min_radius=SPARSE_STILL_M, only_still=True)
        if end > i and fx[end].t - fx[i].t >= p.stop_seconds:
            raw.append(Stop(i, end, True))
            i = end + 1
        else:
            i += 1

    # (c) a gap whose two ends are within 75 m is part of a stop, together with the fixes either side of it that are
    # still at that same place (a person who stood there for two minutes, lost the signal for twenty and stood another two
    # was there for twenty-four, not two + a mystery + two)
    for a in range(n - 1):
        if (
            fx[a + 1].t - fx[a].t > p.gap_seconds
            and fast_dist_m(fx[a].lat, fx[a].lng, fx[a + 1].lat, fx[a + 1].lng) <= SPARSE_STILL_M
        ):
            left, right = a, a + 1
            while (
                left > 0
                and fx[left].t - fx[left - 1].t <= p.gap_seconds
                and fast_dist_m(fx[left - 1].lat, fx[left - 1].lng, fx[a].lat, fx[a].lng) <= SPARSE_STILL_M
            ):
                left -= 1
            while (
                right < n - 1
                and fx[right + 1].t - fx[right].t <= p.gap_seconds
                and fast_dist_m(fx[right + 1].lat, fx[right + 1].lng, fx[a + 1].lat, fx[a + 1].lng) <= SPARSE_STILL_M
            ):
                right += 1
            raw.append(Stop(left, right, True))

    if not raw:
        return []

    # overlapping / touching index ranges are one stop
    raw.sort(key=lambda s: (s.start, s.end))
    merged: list[Stop] = []
    for s in raw:
        if merged and s.start <= merged[-1].end:
            cur = merged[-1]
            cur.end = max(cur.end, s.end)
            cur.inferred = cur.inferred or s.inferred
        else:
            merged.append(Stop(s.start, s.end, s.inferred))

    # a stop that is really several sequential dwell places (a first break, a short walk, a second break) is one stop per
    # place: the fixes show it (tight blocks, clearly apart), no radius decides it
    parts: list[Stop] = []
    for s in merged:
        parts.extend(_split_places(fx, s, p))
    for first, second in zip(parts, parts[1:]):
        _settle_seam(fx, first, second, p)

    # the stable core of each stop: first take back the fixes next to it that are within reach of its centre (a run that
    # grew against a still-moving median), then give the arrival / departure fixes back to travel, and compute the centre
    # and the spread on what is left
    for s in parts:
        s.lat, s.lng, s.r, s.spread, s.acc = _stats(fx, s.start, s.end, p)
        s.raw_start, s.raw_end = s.start, s.end
    settled: list[Stop] = []
    for idx, s in enumerate(parts):
        lo = settled[-1].end + 1 if settled else 0
        hi = parts[idx + 1].start - 1 if idx + 1 < len(parts) else n - 1
        if s.lo_limit is not None:
            lo = max(lo, s.lo_limit)
        if s.hi_limit is not None:
            hi = min(hi, s.hi_limit)
        before = (settled[-1].lat, settled[-1].lng) if settled else None
        after = (parts[idx + 1].lat, parts[idx + 1].lng) if idx + 1 < len(parts) else None
        _extend_edges(fx, s, p, lo, hi, before, after)
        if not _trim_edges(fx, s, p):
            continue
        s.lat, s.lng, s.r, s.spread, s.acc = _stats(fx, s.start, s.end, p)
        settled.append(s)

    # stops at the same place, close in time, are one stop. "The same place" is the same notion as above: two stops whose
    # cores are NOT separable (not clearly farther apart than the GPS noise of the two) are one place. Close in time is
    # judged on the stops as the rules found them (before the arrival / departure fixes were given back to travel)
    out: list[Stop] = []
    for s in settled:
        if out:
            prev = out[-1]
            close_in_time = fx[s.raw_start].t - fx[prev.raw_end].t < p.merge_stop_gap_seconds
            if close_in_time and not _separable(_place(fx, prev.start, prev.end), _place(fx, s.start, s.end)):
                prev.end, prev.raw_end = s.end, s.raw_end
                prev.inferred = prev.inferred or s.inferred
                prev.lat, prev.lng, prev.r, prev.spread, prev.acc = _stats(fx, prev.start, prev.end, p)
                continue
        out.append(s)
    for s in out:
        s.estimated = s.inferred or _has_inner_gap(fx, s.start, s.end, p)
    return out


# ── 3 GAPS: causes ───────────────────────────────────────────────────────────────────────────────────────────────────


def _overlaps(e: Ev, g0: int, g1: int) -> bool:
    return e.start <= g1 and (e.end is None or e.end >= g0)


def _near(e: Ev, g0: int, g1: int) -> bool:
    return g0 - EVENT_SLACK_S <= e.start <= g1 + EVENT_SLACK_S


def classify_gap(g0: int, g1: int, events: list[Ev]) -> tuple[str, int | None]:
    """(cause, the explaining event's id) for the gap g0..g1. First matching rule wins, in this order: the phone was shut
    down, location was off, a permission changed, the app was killed, the network/airplane mode, power saving or a
    background restriction, the server's own signal-lost marker; else 'unknown'."""

    def pick(pred):
        for e in events:
            if pred(e):
                return e
        return None

    rules = (
        ("device_shutdown", lambda e: e.kind in ("DEVICE_SHUTDOWN", "DEVICE_BOOT") and _near(e, g0, g1)),
        ("gps_off", lambda e: e.kind == "GPS_OFF" and _overlaps(e, g0, g1)),
        ("permission", lambda e: e.kind == "PERMISSION_CHANGED" and _near(e, g0, g1)),
        ("app_killed", lambda e: e.kind in ("APP_KILLED", "APP_RESTARTED") and _near(e, g0, g1)),
        ("network_lost", lambda e: e.kind in ("NETWORK_LOST", "AIRPLANE_ON") and _overlaps(e, g0, g1)),
        (
            "power_save",
            lambda e: (
                (e.kind == "POWER_SAVE_ON" and _overlaps(e, g0, g1))
                or (e.kind == "BACKGROUND_RESTRICTED" and _near(e, g0, g1))
            ),
        ),
        ("signal_lost", lambda e: e.kind == "SIGNAL_LOST" and _overlaps(e, g0, g1)),
    )
    for cause, pred in rules:
        found = pick(pred)
        if found is not None:
            return cause, found.id
    return "unknown", None


# ── 4 TRAVEL / segment assembly ──────────────────────────────────────────────────────────────────────────────────────


def _travel_seg(fx: list[Fix], a: int, b: int) -> Seg:
    pts = fx[a : b + 1]
    dist = 0.0
    top = 0.0
    for k in range(len(pts) - 1):
        d = haversine_distance_m(pts[k].lat, pts[k].lng, pts[k + 1].lat, pts[k + 1].lng)
        dist += d
        dt = pts[k + 1].t - pts[k].t
        if dt >= MIN_SPEED_DT_S:
            top = max(top, d / dt * 3.6)
    duration = pts[-1].t - pts[0].t
    ll = [(f.lat, f.lng) for f in pts]
    keep = simplify_indices(ll, MAX_POLYLINE_VERTICES)
    mocks = sum(1 for f in pts if f.mock)
    meta = {"mockPoints": mocks} if mocks else {}
    return Seg(
        kind="travel",
        start=pts[0].t,
        end=pts[-1].t,
        distance_m=dist,
        start_ll=ll[0],
        end_ll=ll[-1],
        point_count=len(pts),
        avg_speed_kmh=(dist / duration * 3.6) if duration > 0 else 0.0,
        max_speed_kmh=top,
        polyline=[[round(ll[i][0], 6), round(ll[i][1], 6)] for i in keep],
        meta=meta,
    )


def _stop_seg(fx: list[Fix], s: Stop) -> Seg:
    pts = fx[s.start : s.end + 1]
    mocks = sum(1 for f in pts if f.mock)
    # detectionRadiusM / coreRadiusM: R, the radius the stay was DETECTED with (max of stop_radius_m and 2 x the median
    # accuracy). Not to be read as the stop's size: `radius_m` is that (the farthest fix from the centre).
    meta: dict = {
        "detectionRadiusM": round(s.r, 1),
        "coreRadiusM": round(s.r, 1),
        "fixCount": len(pts),
        "centreAccuracyM": round(s.acc, 1) if s.acc is not None else None,
    }
    if mocks:
        meta["mockPoints"] = mocks
    return Seg(
        kind="stop",
        start=pts[0].t,
        end=pts[-1].t,
        start_ll=(pts[0].lat, pts[0].lng),
        end_ll=(pts[-1].lat, pts[-1].lng),
        center=(s.lat, s.lng),
        radius_m=round(s.spread, 1),
        point_count=len(pts),
        estimated=s.estimated,
        meta=meta,
    )


def _gap_seg(
    g0: int,
    g1: int,
    a_ll: tuple[float, float] | None,
    b_ll: tuple[float, float] | None,
    events: list[Ev],
    *,
    estimated: bool = False,
    edge: str = "",
) -> Seg:
    cause, event_id = classify_gap(g0, g1, events)
    meta: dict = {}
    if a_ll and b_ll:
        meta["straightLineM"] = round(haversine_distance_m(a_ll[0], a_ll[1], b_ll[0], b_ll[1]), 1)
    if edge:
        meta["edge"] = edge
    return Seg(
        kind="gap",
        start=g0,
        end=g1,
        start_ll=a_ll,
        end_ll=b_ll,
        cause=cause,
        estimated=estimated,
        event_id=event_id,
        meta=meta,
    )


def _transit(fx: list[Fix], a: int, b: int, jumps: set[int], events: list[Ev], p: Params) -> list[Seg]:
    """Travel and gap segments for the fixes a..b (inclusive), which lie between (or outside) stops."""
    out: list[Seg] = []
    run_start = None
    for k in range(a, b):
        dt = fx[k + 1].t - fx[k].t
        is_gap = dt > p.gap_seconds or k in jumps
        if is_gap:
            if run_start is not None:
                out.append(_travel_seg(fx, run_start, k))
                run_start = None
            out.append(
                _gap_seg(
                    fx[k].t,
                    fx[k + 1].t,
                    (fx[k].lat, fx[k].lng),
                    (fx[k + 1].lat, fx[k + 1].lng),
                    events,
                    edge="jump" if k in jumps else "",
                )
            )
        elif run_start is None:
            run_start = k
    if run_start is not None:
        out.append(_travel_seg(fx, run_start, b))
    return out


def build_segments(
    fx: list[Fix],
    stops: list[Stop],
    jumps: set[int],
    events: list[Ev],
    p: Params,
    started_at: int | None,
    ended_at: int | None,
) -> list[Seg]:
    segs: list[Seg] = []
    if not fx:
        if started_at is not None and ended_at is not None and ended_at - started_at > p.gap_seconds:
            seg = _gap_seg(started_at, ended_at, None, None, events, estimated=True, edge="no_data")
            segs.append(seg)
        return segs

    if started_at is not None and fx[0].t - started_at > p.gap_seconds:
        segs.append(_gap_seg(started_at, fx[0].t, None, (fx[0].lat, fx[0].lng), events, estimated=True, edge="leading"))

    pos = 0
    for s in stops:
        if pos < s.start:
            segs.extend(_transit(fx, pos, s.start, jumps, events, p))
        segs.append(_stop_seg_with_gaps(fx, s, p))
        pos = s.end
    if pos < len(fx) - 1:
        segs.extend(_transit(fx, pos, len(fx) - 1, jumps, events, p))

    if ended_at is not None and ended_at - fx[-1].t > p.gap_seconds:
        segs.append(
            _gap_seg(fx[-1].t, ended_at, (fx[-1].lat, fx[-1].lng), None, events, estimated=True, edge="trailing")
        )
    return segs


def _stop_seg_with_gaps(fx: list[Fix], s: Stop, p: Params) -> Seg:
    seg = _stop_seg(fx, s)
    inner = sum(fx[k + 1].t - fx[k].t for k in range(s.start, s.end) if fx[k + 1].t - fx[k].t > p.gap_seconds)
    if inner:
        seg.meta["gapInsideS"] = inner
        seg.estimated = True
    return seg


# ── 5 SUMMARY + the whole pipeline ───────────────────────────────────────────────────────────────────────────────────


def _path(fx: list[Fix]) -> list[list]:
    if not fx:
        return []
    ll = [(f.lat, f.lng) for f in fx]
    keep = simplify_indices(ll, MAX_PATH_POINTS)
    return [[round(fx[i].lat, 6), round(fx[i].lng, 6), fx[i].t * 1000] for i in keep]


def compute_journey(
    fixes: list[Fix],
    events: list[Ev],
    p: Params,
    *,
    started_at: int | None = None,
    ended_at: int | None = None,
) -> Journey:
    """The whole pipeline. ``started_at`` / ``ended_at`` (epoch seconds) are the track's own; ``ended_at`` None means it
    is still recording (no trailing gap is invented for an active track)."""
    cleaned = clean(fixes, p)
    fx = cleaned.fixes
    stops = detect_stops(fx, p)
    segs = build_segments(
        fx, stops, cleaned.jumps, sorted(events, key=lambda e: (e.start, e.kind)), p, started_at, ended_at
    )
    travel = [s for s in segs if s.kind == "travel"]
    stop_segs = [s for s in segs if s.kind == "stop"]
    gap_segs = [s for s in segs if s.kind == "gap"]
    through = segs[-1].end if segs else (fx[-1].t if fx else None)
    range_start = segs[0].start if segs else (fx[0].t if fx else None)
    straight = sum(g.meta.get("straightLineM", 0.0) for g in gap_segs)
    flags = {
        "rawPoints": len(fixes),
        "usedPoints": len(fx),
        "droppedAccuracy": cleaned.dropped_accuracy,
        "droppedTeleport": cleaned.dropped_teleport,
        "droppedDuplicate": cleaned.dropped_duplicate,
        "mockPoints": sum(1 for f in fx if f.mock),
        "timeSuspectPoints": sum(1 for f in fx if f.suspect),
        "estimatedStops": sum(1 for s in stop_segs if s.estimated),
        "gapStraightLineM": round(straight, 1),
        "jumps": len(cleaned.jumps),
        "noData": not fx,
        "allInaccurate": bool(fixes) and not fx and cleaned.dropped_accuracy > 0 and cleaned.dropped_teleport == 0,
        "leadingIdleS": max(0, fx[0].t - started_at) if (fx and started_at is not None) else 0,
        "trailingIdleS": max(0, ended_at - fx[-1].t) if (fx and ended_at is not None) else 0,
    }
    summary = {
        "distance_m": sum(s.distance_m for s in travel),
        "travel_s": sum(s.duration_s for s in travel),
        "stop_s": sum(s.duration_s for s in stop_segs),
        "gap_s": sum(s.duration_s for s in gap_segs),
        "stop_count": len(stop_segs),
        "longest_stop_s": max((s.duration_s for s in stop_segs), default=0),
        "max_speed_kmh": max((s.max_speed_kmh for s in travel), default=0.0),
        "first_point_at": fx[0].t if fx else None,
        "range_start": range_start,
        "summary_through": through,
        "flags": flags,
    }
    return Journey(segments=segs, summary=summary, path=_path(fx), fixes=fx)


# ── adapters + persistence ───────────────────────────────────────────────────────────────────────────────────────────


def to_epoch(dt: datetime) -> int:
    return int(round(dt.timestamp()))


def from_epoch(t: int | float) -> datetime:
    return datetime.fromtimestamp(t, tz=dt_timezone.utc)


def fix_from_row(row) -> Fix:
    """Adapt a DutyTrackPoint (or a values() dict with the same keys)."""
    get = row.get if isinstance(row, dict) else lambda k: getattr(row, k)
    return Fix(
        t=to_epoch(get("recorded_at")),
        lat=float(get("latitude")),
        lng=float(get("longitude")),
        acc=get("accuracy_m"),
        speed=get("speed_mps"),
        activity=get("activity") or "unknown",
        mock=bool(get("is_mock")),
        suspect=bool(get("time_suspect")),
        seq=int(get("seq") or 0),
    )


def event_from_row(row) -> Ev:
    get = row.get if isinstance(row, dict) else lambda k: getattr(row, k)
    lat, lng = get("latitude"), get("longitude")
    ended = get("ended_at")
    return Ev(
        kind=get("kind"),
        start=to_epoch(get("started_at")),
        end=to_epoch(ended) if ended else None,
        lat=float(lat) if lat is not None else None,
        lng=float(lng) if lng is not None else None,
        id=get("id"),
    )


def _carry_addresses(old_stops: list[tuple[float, float, str]], seg: Seg) -> str:
    """The address an earlier rebuild already looked up for a stop at (nearly) the same place."""
    if seg.kind != "stop" or not seg.center:
        return ""
    for lat, lng, address in old_stops:
        if address and fast_dist_m(lat, lng, seg.center[0], seg.center[1]) <= 60.0:
            return address
    return ""


def rebuild(track, *, now: datetime | None = None) -> dict:
    """Recompute the derived segments and the summary of one track from its raw points and events, in one transaction.

    ``track`` is a DutyTrack or its id. Safe to call at any time and any number of times: the result depends only on the
    raw rows (and the settings), the segments are replaced as a whole, and the track row is locked while that happens so
    two rebuilds (or a rebuild and end_track) cannot interleave. Returns the summary dict that was stored, or
    {"skipped": "purged"} for a track whose raw rows the retention rule has deleted (its segments are kept as they are)."""
    from django.db import transaction
    from django.utils import timezone

    from ..models import DutyTrack, DutyTrackEvent, DutyTrackPoint, DutyTrackSegment, GeoTrackingSettings

    now = now or timezone.now()
    track_id = track if isinstance(track, int) else track.pk
    params = Params.from_settings(GeoTrackingSettings.get())

    with transaction.atomic():
        locked = DutyTrack.objects.select_for_update().get(pk=track_id)
        if (locked.flags or {}).get("purgedAt"):
            # the retention rule deleted the raw rows: the stored segments are all that is left, never wipe them
            return {"skipped": "purged"}
        point_rows = list(
            DutyTrackPoint.objects.filter(track=locked)
            .order_by("recorded_at", "seq")
            .values(
                "recorded_at",
                "latitude",
                "longitude",
                "accuracy_m",
                "speed_mps",
                "activity",
                "is_mock",
                "time_suspect",
                "seq",
            )
        )
        event_rows = list(
            DutyTrackEvent.objects.filter(track=locked).values(
                "id", "kind", "started_at", "ended_at", "latitude", "longitude"
            )
        )
        fixes = [fix_from_row(r) for r in point_rows]
        events = [event_from_row(r) for r in event_rows]
        started = to_epoch(locked.started_at)
        ended = to_epoch(locked.ended_at) if locked.ended_at else None
        journey = compute_journey(fixes, events, params, started_at=started, ended_at=ended)

        old_stops = [
            (float(s.center_lat), float(s.center_lng), s.address)
            for s in DutyTrackSegment.objects.filter(track=locked, kind="stop").exclude(address="")
            if s.center_lat is not None and s.center_lng is not None
        ]
        DutyTrackSegment.objects.filter(track=locked).delete()
        rows = []
        for n, seg in enumerate(journey.segments, start=1):
            rows.append(
                DutyTrackSegment(
                    track=locked,
                    seq_no=n,
                    kind=seg.kind,
                    started_at=from_epoch(seg.start),
                    ended_at=from_epoch(seg.end),
                    duration_s=seg.duration_s,
                    distance_m=round(seg.distance_m, 1),
                    start_lat=_dec(seg.start_ll, 0),
                    start_lng=_dec(seg.start_ll, 1),
                    end_lat=_dec(seg.end_ll, 0),
                    end_lng=_dec(seg.end_ll, 1),
                    center_lat=_dec(seg.center, 0),
                    center_lng=_dec(seg.center, 1),
                    radius_m=seg.radius_m,
                    point_count=seg.point_count,
                    avg_speed_kmh=round(seg.avg_speed_kmh, 1),
                    max_speed_kmh=round(seg.max_speed_kmh, 1),
                    polyline=seg.polyline,
                    address=_carry_addresses(old_stops, seg),
                    cause=seg.cause,
                    estimated=seg.estimated,
                    event_id=seg.event_id,
                    meta=seg.meta,
                )
            )
        DutyTrackSegment.objects.bulk_create(rows)

        s = journey.summary
        DutyTrack.objects.filter(pk=locked.pk).update(
            distance_m=round(s["distance_m"], 1),
            travel_s=s["travel_s"],
            stop_s=s["stop_s"],
            gap_s=s["gap_s"],
            stop_count=s["stop_count"],
            longest_stop_s=s["longest_stop_s"],
            max_speed_kmh=round(s["max_speed_kmh"], 1),
            first_point_at=from_epoch(s["first_point_at"]) if s["first_point_at"] is not None else None,
            summary_through=from_epoch(s["summary_through"]) if s["summary_through"] is not None else None,
            rebuilt_at=now,
            flags=s["flags"],
        )
    return {**s, "segments": len(journey.segments)}


def _dec(ll, i):
    return None if ll is None else round(ll[i], 6)
