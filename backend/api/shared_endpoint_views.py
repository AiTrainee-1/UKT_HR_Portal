"""
Endpoint Sharing: the PUBLIC call (the management API is shared_endpoint_admin_views.py).

    GET     /api/shared/<slug>      read-only JSON of the dataset the endpoint shares (selected fields only)
    OPTIONS /api/shared/<slug>      the browser's CORS preflight

No HR login: authentication is a per-endpoint API KEY. The route is deliberately exempt from the HR token machinery the
same way the other public routes are (/api/support-contact, /api/mobile-app/latest-version: no auth decorator, no entry
in permission_registry.URL_MODULE_MAP), plus two explicit locks in this change: permission_middleware.EXEMPT_PREFIXES
names "shared/" (an HR token sent here by mistake is never looked at), and settings.CORS_URLS_REGEX excludes
/api/shared/ from django-cors-headers, because this route does its own CORS (per-endpoint allow-list, never "*", never
credentials). Every other route's behaviour is identical.

Order of checks (each failure is {"error": "<code>", "message": "<one sentence>"} and, for a known endpoint, a row in the
access log):
  0  method: GET or OPTIONS, else 405
  1  the endpoint exists and is enabled         404 not_found (unknown and disabled look the same)
  2  Origin present -> must be allow-listed     403 origin_not_allowed;  absent -> allow_no_origin    403 origin_required
  3  key: "Authorization: Bearer <key>" or "X-API-Key: <key>" (never the query string, it would land in logs)
                                                401 invalid_key (the SAME answer for unknown / revoked / expired /
                                                other endpoint's key / malformed)
  4  rate limit per key                          429 rate_limited + Retry-After
  5  filters validated against the dataset (+ the endpoint's locked filters); unknown parameter = 400 invalid_parameter
  6  page / pageSize                             pageSize is capped at the endpoint's maximum
  7  data

Security properties
  * the key is stored only as SHA-256; lookup is by the 8-character prefix inside THIS endpoint, then hmac.compare_digest;
    a dummy comparison runs when nothing matches, so the work done does not depend on the key's validity; the key is never
    logged, audited or echoed (error bodies are fixed sentences);
  * after a failed key the caller's IP is counted (per endpoint, per minute): beyond a limit the answer becomes 429 so a
    key-guessing loop is slowed (a valid key is never affected: the count is only consulted when the key already failed);
  * every response carries Cache-Control: no-store, X-Content-Type-Options: nosniff and Vary: Origin;
  * an allowed origin gets Access-Control-Allow-Origin: <that origin> on EVERY response to it (errors included), never "*"
    and never Access-Control-Allow-Credentials; a disallowed origin gets no CORS headers at all. Origins are not
    authentication: any non-browser client can send any Origin, the key is what protects the data;
  * the caller's address (failed-key limiter, last_used_ip, access log) is the LAST hop of X-Forwarded-For, the one the
    platform's proxy appended: the first hop is client-controlled, so rotating it evades nothing. It is normalised to a
    canonical address of at most 45 characters (an IPv6 scope id is dropped, anything that is not an address becomes "");
  * the whole view runs inside one handler: any unexpected exception is logged server-side and answered with a generic
    500 JSON (no message, no traceback); a failing access-log write never changes the response, is retried once without the
    address (a call must never go unlogged: the database rate limit counts these rows) and, if it keeps failing, is
    reported as one log line without a traceback;
  * the query string is capped (MAX_QUERY_STRING characters, and Django's own 1000-names parse limit): 400, never a 500;
  * the log is written for known endpoints only (an unknown slug has nothing to attach a row to, and a stranger must not be
    able to fill the table by guessing addresses); failure rows are capped per endpoint per minute for the same reason.
    Retention: rows older than 90 days are purged, at most once an hour, when a new row is written.

Rate limiting and the cache
  The counter lives in Django's cache (settings define no CACHES, so it is the default LocMemCache: PER PROCESS, not
  shared between gunicorn workers). So the limit is ALSO enforced from the access log: before serving, the rows this key
  wrote in the last 60 seconds (everything except 429s) are counted in the database, which every worker shares. With N
  workers the cache alone could let N x limit through; the database count caps the sliding minute at the limit plus the
  calls that are in flight at the same moment. (Production runs one worker; both layers are kept so adding workers is safe.)
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import math
import re
import secrets
import string
import time as _time
from datetime import timedelta

from django.core.cache import cache
from django.core.exceptions import SuspiciousOperation
from django.db import transaction
from django.db.models import Count, Min, Q
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.utils.cache import patch_vary_headers

from . import shared_datasets as sd
from .clock import FACTORY_TZ
from .models import SharedEndpoint, SharedEndpointAccessLog, SharedEndpointKey, SharedEndpointOrigin

logger = logging.getLogger("api.shared_endpoints")

SLUG_RE = re.compile(r"[a-z0-9-]{3,60}", re.ASCII)
KEY_RE = re.compile(r"uks_([a-z0-9]{8})_([A-Za-z0-9_-]{43})", re.ASCII)
_PREFIX_ALPHABET = string.ascii_lowercase + string.digits
#: a hash that no key has: compared against when nothing matched, so the work is the same either way
_DUMMY_HASH = hashlib.sha256(b"shared-endpoint-no-such-key").hexdigest()

RETENTION_DAYS = 90
RATE_WINDOW_SECONDS = 60
#: failed-key attempts one IP may make per endpoint per minute before the answer turns into 429
FAILED_KEY_LIMIT = 60
#: failure rows written to the log per endpoint per minute (a flood adds no more rows)
FAILURE_LOG_BUDGET = 120
MAX_QUERY_PARAMS = 20
#: the longest raw query string a call may carry (a legitimate one is a few hundred characters)
MAX_QUERY_STRING = 8192

ALLOW_HEADERS = "Authorization, X-API-Key, Content-Type"
ALLOW_METHODS = "GET, OPTIONS"
CORS_MAX_AGE = "600"

_MESSAGES = {
    "not_found": "This endpoint does not exist.",
    "origin_not_allowed": "This origin is not allowed to call this endpoint.",
    "origin_required": "Calls must come from an allowed origin; this endpoint does not accept calls without an Origin header.",
    "invalid_key": "The API key is missing or not valid for this endpoint.",
    "rate_limited": "Too many requests: wait and try again.",
    "method_not_allowed": "Only GET and OPTIONS are supported.",
    "server_error": "The server could not complete the request.",
}


# ── keys ────────────────────────────────────────────────────────────────────


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """(the full key, its 8-character prefix, its SHA-256). `uks_<8 chars>_<43 url-safe chars>`: the prefix is drawn from
    a plain alphabet (so the key always splits cleanly) and the secret part is 256 bits from the OS."""
    prefix = "".join(secrets.choice(_PREFIX_ALPHABET) for _ in range(8))
    key = f"uks_{prefix}_{secrets.token_urlsafe(32)}"
    return key, prefix, hash_key(key)


def _presented_key(request: HttpRequest) -> str | None:
    """The key as the caller sent it: a Bearer token, else X-API-Key. Never the query string."""
    auth = request.headers.get("Authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    value = request.headers.get("X-API-Key")
    return value.strip() if value is not None else None


def _find_key(endpoint: SharedEndpoint, presented: str | None) -> tuple[SharedEndpointKey | None, str]:
    """(the key row if `presented` is this endpoint's key, a reason code for the log). The caller answers identically for
    every reason. Constant-time on the hash; a dummy comparison when there is no candidate."""
    parsed = KEY_RE.fullmatch(presented) if presented and len(presented) <= 64 else None
    digest = hash_key(presented) if presented else _DUMMY_HASH
    candidates = (
        list(SharedEndpointKey.objects.filter(endpoint_id=endpoint.id, prefix=parsed.group(1))) if parsed else []
    )
    found = None
    for candidate in candidates:
        if hmac.compare_digest(candidate.key_hash, digest):
            found = candidate
    if not candidates:
        hmac.compare_digest(_DUMMY_HASH, digest)
    if found is None:
        return None, "invalid_key"
    if found.revoked_at is not None:
        return found, "key_revoked"
    if found.expires_at is not None and found.expires_at <= timezone.now():
        return found, "key_expired"
    return found, ""


# ── small helpers ───────────────────────────────────────────────────────────


def _error(status: int, code: str, message: str | None = None, **extra) -> JsonResponse:
    return JsonResponse({"error": code, "message": message or _MESSAGES[code], **extra}, status=status)


#: SharedEndpointAccessLog.ip and SharedEndpointKey.last_used_ip are varchar(45): the longest IPv6 text, without a scope id
MAX_IP_LENGTH = 45


def _normalise_ip(raw: str) -> str:
    """`raw` as one canonical address of at most 45 characters, or "" when it is not an IP address. An IPv6 scope id
    (`fe80::1%eth0`, which Python accepts and keeps) is dropped, an IPv4-mapped IPv6 address becomes plain IPv4, and
    anything else (brackets, a port, words, a 300-character string) is not an address."""
    if not raw or len(raw) > 100:
        return ""
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return ""
    if isinstance(address, ipaddress.IPv6Address):
        address = address.ipv4_mapped or ipaddress.IPv6Address(address.packed)  # a rebuilt address has no scope id
    return address.compressed[:MAX_IP_LENGTH]


def _client_ip(request: HttpRequest) -> str:
    """The address the request came from, as far as it can be told. Behind the platform's proxy the LAST hop of
    X-Forwarded-For is the one that proxy appended (the client's real address); the first hop is whatever the caller wrote,
    so it must never decide a limiter or a log line (the same rule as connector_auth._caller). Without that header it is the
    connection's own address. Always a valid address of at most 45 characters, or "" (which never fails a database write)."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    raw = forwarded.rsplit(",", 1)[-1].strip() if forwarded else request.META.get("REMOTE_ADDR", "")
    return _normalise_ip(raw)


def _printable(value: str, limit: int = 255) -> str:
    """Header text as it may be stored in the log: printable ASCII only, cut short."""
    return "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in value[:limit])


def _cache_count(name: str, seconds: int) -> int | None:
    """Add one to a per-window counter in the cache and return it (None if the cache failed: callers then rely on the
    database)."""
    try:
        if cache.add(name, 1, timeout=seconds + 5):
            return 1
        return int(cache.incr(name))
    except Exception:
        return None


def _retry_after(now_ts: float, window: int = RATE_WINDOW_SECONDS) -> int:
    return max(1, window - int(now_ts % window))


class _Call:
    """What one request learned, for the response headers and the access-log row."""

    def __init__(self, request: HttpRequest):
        self.started = _time.perf_counter()
        self.method = request.method
        self.endpoint: SharedEndpoint | None = None
        self.key: SharedEndpointKey | None = None
        self.origin = _printable(request.headers.get("Origin") or "")
        self.cors_origin: str | None = None  # set only for an allow-listed Origin
        self.error = ""
        self.rows = 0
        self.ip = _client_ip(request)
        self.retry_after: int | None = None


# ── rate limits ─────────────────────────────────────────────────────────────


def _key_rate_limited(key: SharedEndpointKey, limit: int) -> int | None:
    """Seconds to wait if this key has used up its minute, else None (cache counter, then the shared access log)."""
    now = timezone.now()
    count = _cache_count(f"shared-ep:rl:{key.id}:{int(now.timestamp() // RATE_WINDOW_SECONDS)}", RATE_WINDOW_SECONDS)
    if count is not None and count > limit:
        return _retry_after(now.timestamp())
    window_start = now - timedelta(seconds=RATE_WINDOW_SECONDS)
    used = (
        SharedEndpointAccessLog.objects.filter(key_id=key.id, at__gte=window_start)
        .exclude(status=429)
        .aggregate(n=Count("id"), oldest=Min("at"))
    )
    if used["n"] >= limit:
        oldest = used["oldest"] or now
        return max(1, math.ceil(RATE_WINDOW_SECONDS - (now - oldest).total_seconds()))
    return None


def _too_many_failures(endpoint_id: int, ip: str) -> int | None:
    now_ts = timezone.now().timestamp()
    count = _cache_count(f"shared-ep:bad:{endpoint_id}:{ip}:{int(now_ts // 60)}", 60)
    if count is not None and count > FAILED_KEY_LIMIT:
        return _retry_after(now_ts, 60)
    return None


# ── CORS ────────────────────────────────────────────────────────────────────


def _origin_allowed(endpoint: SharedEndpoint, origin: str) -> bool:
    """Exact (lower-cased) match against this endpoint's allow-list. Anything that is not printable ASCII of sane length
    cannot be in the list, so it is refused without a query."""
    if not origin or len(origin) > 255 or _printable(origin) != origin:
        return False
    return SharedEndpointOrigin.objects.filter(endpoint_id=endpoint.id, origin=origin.lower()).exists()


def _apply_cors(response: HttpResponse, origin: str, preflight: bool) -> None:
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Headers"] = ALLOW_HEADERS
    response["Access-Control-Allow-Methods"] = ALLOW_METHODS
    response["Access-Control-Max-Age"] = CORS_MAX_AGE
    if not preflight:
        response["Access-Control-Expose-Headers"] = "Retry-After"
    # (never Access-Control-Allow-Credentials: the key travels in a header, no cookie is ever involved)


# ── the view ────────────────────────────────────────────────────────────────


def shared_endpoint(request: HttpRequest, slug: str) -> HttpResponse:
    """The public call (see the module docstring). Never raises: the whole handler is guarded."""
    call = _Call(request)
    try:
        response = _handle(request, slug, call)
    except Exception:
        logger.exception("shared endpoint call failed (slug=%s)", _printable(slug, 60))
        call.error = "server_error"
        response = _error(500, "server_error")
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    patch_vary_headers(response, ("Origin",))
    try:
        if call.cors_origin is not None:
            _apply_cors(response, call.cors_origin, preflight=request.method == "OPTIONS")
        if call.retry_after is not None:
            response["Retry-After"] = str(call.retry_after)
        call.rows = call.rows if response.status_code == 200 else 0
        _record(response, call)
    except Exception:
        logger.exception("shared endpoint bookkeeping failed")
    return response


def _fail(call: _Call, status: int, code: str, message: str | None = None, **extra) -> JsonResponse:
    call.error = code
    return _error(status, code, message, **extra)


def _handle(request: HttpRequest, slug: str, call: _Call) -> HttpResponse:
    if request.method not in ("GET", "OPTIONS"):
        response = _error(405, "method_not_allowed")
        response["Allow"] = ALLOW_METHODS
        return response

    # 1  the endpoint (a malformed slug cannot exist: no query for it)
    endpoint = (
        SharedEndpoint.objects.filter(slug=slug, enabled=True).first() if SLUG_RE.fullmatch(slug) is not None else None
    )
    if endpoint is None:
        return _error(404, "not_found")
    call.endpoint = endpoint

    # 2  origin
    origin = request.headers.get("Origin")
    if origin is not None:
        if not _origin_allowed(endpoint, origin):
            return _fail(call, 403, "origin_not_allowed")
        call.cors_origin = origin.lower()
    elif request.method == "GET" and not endpoint.allow_no_origin:
        return _fail(call, 403, "origin_required")

    if request.method == "OPTIONS":  # the preflight: answered without a key, nothing is read
        response = HttpResponse(status=204)
        response["Allow"] = ALLOW_METHODS
        return response

    # 3  key
    key, reason = _find_key(endpoint, _presented_key(request))
    if key is None or reason:
        call.error = reason or "invalid_key"
        call.key = key
        wait = _too_many_failures(endpoint.id, call.ip)
        if wait is not None:
            call.retry_after = wait
            return _fail(call, 429, "rate_limited")
        return _error(401, "invalid_key")
    call.key = key

    # 4  rate limit
    wait = _key_rate_limited(key, endpoint.rate_limit_per_minute)
    if wait is not None:
        call.retry_after = wait
        return _fail(call, 429, "rate_limited")

    # 5  + 6  parameters
    dataset = sd.get_dataset(endpoint.dataset)
    if dataset is None:
        raise RuntimeError("endpoint names a dataset that is not in the catalog")
    fields = sd.effective_fields(dataset, endpoint.fields)
    try:
        supplied = _query_params(request)
        values = sd.parse_filters(
            dataset, {k: v for k, v in supplied.items() if k not in ("page", "pageSize")}, endpoint.locked_filters or {}
        )
        page, page_size = _paging(supplied, endpoint, dataset)
    except sd.FilterError as exc:
        return _fail(call, 400, "invalid_parameter", exc.message, parameter=exc.param)

    # 7  data
    queryset = sd.build_queryset(dataset, values, fields)
    total = queryset.count()
    offset = (page - 1) * page_size
    rows = sd.shape_rows(dataset, fields, queryset[offset : offset + page_size]) if total > offset else []
    call.rows = len(rows)
    payload = {
        "data": rows,
        "meta": {
            "endpoint": endpoint.slug,
            "dataset": dataset.key,
            "fields": fields,
            "page": page,
            "pageSize": page_size,
            "total": total,
            "hasMore": offset + len(rows) < total,
            "generatedAt": timezone.now().astimezone(FACTORY_TZ).isoformat(timespec="seconds"),
        },
    }
    return JsonResponse(payload)


def _query_params(request: HttpRequest) -> dict[str, str]:
    """The query string as {name: value}: a name given twice, more than MAX_QUERY_PARAMS names, a query string longer than
    MAX_QUERY_STRING or more names than Django will even parse (DATA_UPLOAD_MAX_NUMBER_FIELDS, 1000) is a 400."""
    if len(request.META.get("QUERY_STRING", "")) > MAX_QUERY_STRING:
        raise sd.FilterError("query", "The query string is too long.")
    try:
        groups = list(request.GET.lists())  # the first access parses the query string
    except SuspiciousOperation:  # TooManyFieldsSent
        raise sd.FilterError("query", "Too many parameters.") from None
    out: dict[str, str] = {}
    for name, values in groups:
        if len(values) > 1:
            raise sd.FilterError(name, f"Parameter '{sd._printable(name)}' was given more than once.")
        out[name] = values[0]
    if len(out) > MAX_QUERY_PARAMS:
        raise sd.FilterError("query", "Too many parameters.")
    return out


_NUMBER_RE = re.compile(r"[0-9]{1,7}", re.ASCII)


def paging_limits(endpoint: SharedEndpoint, dataset: sd.Dataset) -> tuple[int, int]:
    """(the largest pageSize, the default pageSize) this endpoint really serves."""
    cap = max(1, min(endpoint.page_size_max, dataset.max_page_size))
    return cap, max(1, min(endpoint.page_size_default, cap))


def _paging(supplied: dict[str, str], endpoint: SharedEndpoint, dataset: sd.Dataset) -> tuple[int, int]:
    cap, default = paging_limits(endpoint, dataset)
    page = 1
    if "page" in supplied:
        raw = supplied["page"]
        if _NUMBER_RE.fullmatch(raw) is None or not 1 <= int(raw) <= sd.MAX_PAGE:
            raise sd.FilterError("page", "Parameter 'page' must be a whole number of at least 1.")
        page = int(raw)
    size = default
    if "pageSize" in supplied:
        raw = supplied["pageSize"]
        if _NUMBER_RE.fullmatch(raw) is None or int(raw) < 1:
            raise sd.FilterError("pageSize", "Parameter 'pageSize' must be a whole number of at least 1.")
        size = min(int(raw), cap)
    if (page - 1) * size > sd.MAX_OFFSET:
        raise sd.FilterError("page", f"Parameter 'page' is too large: at most {sd.MAX_OFFSET} rows can be skipped.")
    return page, size


# ── the access log ──────────────────────────────────────────────────────────


def _record(response: HttpResponse, call: _Call) -> None:
    """One access-log row for a known endpoint (best effort: a failure here is logged and changes nothing)."""
    endpoint = call.endpoint
    status = response.status_code
    if endpoint is None:
        return
    if call.method == "OPTIONS" and status < 400:
        return  # a granted preflight is not a call
    if status >= 400:
        spent = _cache_count(f"shared-ep:flog:{endpoint.id}:{int(timezone.now().timestamp() // 60)}", 60)
        if spent is not None and spent > FAILURE_LOG_BUDGET:
            return
    # A call must never go unlogged (the database rate limit counts these rows): if the write fails for any reason, for
    # example an address that does not fit its column, it is retried ONCE without the address. Only when that fails too is
    # the failure logged, as one line without a traceback (it would repeat for every call while the database is down).
    try:
        try:
            _write_log_row(endpoint, call, status, call.ip)
        except Exception as first:
            logger.debug(
                "shared endpoint access log write failed (%s): retrying without the address", type(first).__name__
            )
            _write_log_row(endpoint, call, status, "")
    except Exception as exc:
        logger.error("shared endpoint access log could not be written (%s)", type(exc).__name__)
        return
    try:
        purge_old_logs()
    except Exception as exc:
        logger.error("shared endpoint access log purge failed (%s)", type(exc).__name__)


def _write_log_row(endpoint: SharedEndpoint, call: _Call, status: int, ip: str) -> None:
    """The access-log row (and, for a served call, the key's last-used stamp) in one transaction."""
    with transaction.atomic():
        SharedEndpointAccessLog.objects.create(
            endpoint=endpoint,
            endpoint_slug=endpoint.slug,
            key=call.key,
            status=status,
            rows=call.rows,
            origin=call.origin,
            ip=ip[:MAX_IP_LENGTH],
            duration_ms=int((_time.perf_counter() - call.started) * 1000),
            error=call.error,
        )
        if status == 200 and call.key is not None:
            now = timezone.now()
            SharedEndpointKey.objects.filter(pk=call.key.pk).filter(
                Q(last_used_at__isnull=True) | Q(last_used_at__lt=now - timedelta(seconds=60))
            ).update(last_used_at=now, last_used_ip=ip[:MAX_IP_LENGTH])


def purge_old_logs(now=None, force: bool = False) -> int:
    """Delete access-log rows older than RETENTION_DAYS, in batches. Runs at most once an hour per process (the guard is
    a cache add) unless `force`. Returns the number of rows removed."""
    try:
        if not force and not cache.add("shared-ep:purge", 1, timeout=3600):
            return 0
    except Exception:
        return 0
    cutoff = (now or timezone.now()) - timedelta(days=RETENTION_DAYS)
    removed = 0
    for _ in range(20):
        ids = list(SharedEndpointAccessLog.objects.filter(at__lt=cutoff).values_list("id", flat=True)[:5000])
        if not ids:
            break
        removed += SharedEndpointAccessLog.objects.filter(id__in=ids).delete()[0]
    return removed
