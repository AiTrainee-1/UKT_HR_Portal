"""
Endpoint Sharing: the MANAGEMENT API (Settings -> Endpoint Sharing). The public call is shared_endpoint_views.py.

Every route is for the SUPER ADMINISTRATOR alone and company-wide: the account is looked up in the database on every
request (active + is_super_admin, like require_super_admin), and a super administrator that is tied to one branch is
refused too (403) because what is shared leaves the whole company's data. An HR role with every permission, a branch
login, an employee token and no token are all refused (403 / 403 / 403 / 401). The permission middleware does not map these
paths (there is deliberately NO permission module for this feature): the decorator below is the real gate.

  GET    /api/shared-endpoints/catalog                the datasets (fields with sensitivity, filters), the hard-excluded list
  GET    /api/shared-endpoints                        list {"endpoints": [...], "limits": {...}}
  POST   /api/shared-endpoints                        create (201 -> the endpoint)
  GET    /api/shared-endpoints/<id>                   one endpoint
  PUT    /api/shared-endpoints/<id>                   replace its settings (all-or-nothing)
  DELETE /api/shared-endpoints/<id>                   delete it, its keys and origins (the access log is kept)
  GET    /api/shared-endpoints/<id>/keys              {"keys": [...]} (never a key or a hash)
  POST   /api/shared-endpoints/<id>/keys              create a key (201): the ONLY time the plaintext is returned
  DELETE /api/shared-endpoints/<id>/keys/<kid>        revoke a key (immediate; repeating it is a no-op)
  POST   /api/shared-endpoints/<id>/preview           the first rows exactly as the public call shapes them (no key, no log)
  GET    /api/shared-endpoints/<id>/activity          its access log {"items": [...], "page", "pageSize", "total", "hasMore"}
  GET    /api/shared-endpoints/activity               the same across endpoints (optional ?endpointId=)
  GET    /api/shared-endpoints/<id>/guide             the generated integration guide (data only: the page renders it)

Endpoint body (GET / POST answer / PUT answer):
  {"id": 3, "slug": "hr-employees", "name": "...", "description": "...", "dataset": "employees", "datasetLabel": "Employees",
   "fields": ["employeeCode", ...], "lockedFilters": {"status": "active"}, "origins": ["https://app.example.com"],
   "allowNoOrigin": true, "pageSizeDefault": 50, "pageSizeMax": 200, "rateLimitPerMinute": 60, "enabled": true,
   "url": "/api/shared/hr-employees", "createdBy": "Asha", "createdAt": "...", "updatedAt": "...", "version": "9f2c41d07a3b5e68",
   "liveKeys": 1, "calls24h": 12, "lastCallAt": "..." | null, "sensitiveFields": ["phone"]}
PUT / POST take name, description, fields, lockedFilters, origins, allowNoOrigin, pageSizeDefault, pageSizeMax,
rateLimitPerMinute, enabled (+ slug and dataset on POST; on PUT they may be sent back but not changed), and
`acknowledgeSensitive` (true is required when the save newly selects a personal or financial field: 400
code "sensitive_confirmation_required" with the field names otherwise) and `expectedVersion` (the stale guard: the
`version` the page loaded; a different stored one is a 400 code "stale_settings" and nothing is saved). An omitted key of a
PUT keeps its stored value. Any problem is a 400 {"error": "<one sentence>"} and nothing is saved; a save that changes
nothing writes nothing (no audit row).

Audit rows (module `shared_endpoints`; actions create / update / delete / key_create / key_revoke) carry old and new
values (fields added and removed, origins, limits), the sensitive fields a save added, and NEVER a key or a hash.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from datetime import date, datetime, time, timedelta
from functools import wraps

from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.request import Request
from rest_framework.response import Response

from . import shared_datasets as sd
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .clock import FACTORY_TZ, ist_today
from .models import HRUser, SharedEndpoint, SharedEndpointAccessLog, SharedEndpointKey, SharedEndpointOrigin
from .shared_endpoint_views import SLUG_RE, generate_key, paging_limits

AUDIT_MODULE = "shared_endpoints"

MAX_ENDPOINTS = 100
MAX_LIVE_KEYS = 10
MAX_ORIGINS = 20
MAX_NAME = 100
MAX_DESCRIPTION = 500
MAX_LABEL = 100
MAX_KEY_LIFETIME_DAYS = 3650
DEFAULT_PAGE_SIZE_MAX = 200
DEFAULT_PAGE_SIZE = 50
ACTIVITY_PAGE_MAX = 200

ADMIN_ONLY = "Administrator access required"
COMPANY_WIDE = "Endpoint sharing is managed company-wide: sign in with the head-office super administrator account."

STALE_VERSION = (
    "This endpoint was changed by somebody else after the page was loaded: reload the page and make your change again."
)

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TEXT_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ORIGIN_RE = re.compile(r"(https?)://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?", re.ASCII)
_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", re.ASCII)
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
_DEFAULT_PORTS = {"http": "80", "https": "443"}


class ManageError(Exception):
    """A problem with the submitted body: the message is the one plain sentence the 400 carries."""

    def __init__(self, message: str, code: str | None = None, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def _bad(exc: ManageError) -> Response:
    payload = {"error": str(exc), **exc.extra}
    if exc.code:
        payload["code"] = exc.code
    return Response(payload, status=400)


# ── the gate ────────────────────────────────────────────────────────────────


def require_company_super_admin(view):
    """Super administrator only, company-wide. Looked up in the database on every call (never a token claim)."""

    @wraps(view)
    @require_hr
    def wrapper(request: Request, *args, **kwargs):
        hr_user_id = request.jwt_user.get("hrUserId")
        user = (
            HRUser.objects.filter(id=hr_user_id, is_active=True, is_super_admin=True).first()
            if isinstance(hr_user_id, int) and not isinstance(hr_user_id, bool)
            else None
        )
        if user is None:
            return Response({"error": ADMIN_ONLY}, status=403)
        if user.branch_id is not None:
            return Response({"error": COMPANY_WIDE, "code": "company_wide_settings"}, status=403)
        request.shared_admin = user
        if request.method == "OPTIONS":
            return Response(status=204)  # nothing is described (DRF's own OPTIONS answer lists the view's docstring)
        return view(request, *args, **kwargs)

    return wrapper


def management_view(*methods: str):
    """`api_view` + the super-administrator gate for every management route. OPTIONS is routed through the gate too, so a
    stranger without a token gets 401 (and a non-super-administrator 403) rather than DRF's metadata answer, which names the
    view and prints its docstring; the super administrator gets a bodyless 204 whose Allow header lists the methods."""

    def decorator(view):
        return api_view([*methods, "OPTIONS"])(require_company_super_admin(view))

    return decorator


# ── reading and validating a body ───────────────────────────────────────────

TOO_DEEP = "The body is nested too deeply to read: send a plain JSON object."


def _read_body(request: Request):
    """(the JSON object, None) or (None, the 400 / 415 answer)."""
    try:
        data = request.data
    except UnsupportedMediaType:
        return None, Response({"error": "The body must be sent as JSON."}, status=415)
    except ParseError:
        return None, Response({"error": "The body is not valid JSON."}, status=400)
    except RecursionError:
        return None, Response({"error": TOO_DEEP}, status=400)
    if not isinstance(data, dict):
        return None, Response({"error": "The body must be a JSON object."}, status=400)
    return data, None


def _storable(text: str) -> bool:
    """Can the text be stored and sent back as JSON? (PostgreSQL refuses NUL; a lone surrogate is not valid UTF-8.)"""
    return "\x00" not in text and not any("\ud800" <= ch <= "\udfff" for ch in text)


def _text(data, key: str, label: str, limit: int, *, required: bool = False, multiline: bool = False) -> str | None:
    if key not in data:
        if required:
            raise ManageError(f"{label} is required.")
        return None
    raw = data[key]
    if raw is None and not required:
        raw = ""
    if not isinstance(raw, str):
        raise ManageError(f"{label} must be text.")
    value = raw.strip() if multiline else " ".join(raw.split())
    if not _storable(value) or (_CONTROL if multiline else _TEXT_CONTROL).search(value):
        raise ManageError(f"{label} contains characters that cannot be used.")
    if required and not value:
        raise ManageError(f"{label} is required.")
    if len(value) > limit:
        raise ManageError(f"{label} must be at most {limit} characters.")
    return value


def _int(data, key: str, label: str, low: int, high: int) -> int | None:
    if key not in data:
        return None
    raw = data[key]
    if isinstance(raw, bool) or not isinstance(raw, int) or not low <= raw <= high:
        raise ManageError(f"{label} must be a whole number from {low} to {high}.")
    return raw


def _bool(data, key: str, label: str) -> bool | None:
    if key not in data:
        return None
    if not isinstance(data[key], bool):
        raise ManageError(f"{label} must be true or false.")
    return data[key]


def normalize_origin(raw) -> str:
    """A browser origin as stored: lower-case `scheme://host[:port]`. Raises ManageError with a plain sentence.

    Accepted: http / https; host = DNS name, IPv4 or [IPv6] (a real address, written compressed and lower-case like a
    browser does); optional port 1..65535 without leading zeros (the scheme's default port is dropped: browsers never
    send it). Refused: `*` and `null`, wildcards, paths (even a trailing slash), queries,
    fragments, credentials, spaces, non-ASCII hosts (write the punycode form), and plain http for anything but
    localhost / 127.0.0.1 / [::1]."""
    if not isinstance(raw, str):
        raise ManageError("An origin must be text such as https://app.example.com.")
    text = raw.strip()
    if text == "*":
        raise ManageError("An origin cannot be '*': list each allowed origin, for example https://app.example.com.")
    if text.lower() == "null":
        raise ManageError("An origin cannot be 'null': list each allowed origin, for example https://app.example.com.")
    if not text:
        raise ManageError("An origin cannot be empty.")
    if len(text) > 255 or _TEXT_CONTROL.search(text) or any(ch.isspace() for ch in text) or not text.isascii():
        raise ManageError(
            f"'{_shown(text)}' is not a valid origin: use plain ASCII without spaces (for example https://app.example.com)."
        )
    if "*" in text:
        raise ManageError("An origin cannot contain a wildcard: list each allowed origin.")
    if not re.match(r"https?://", text, re.IGNORECASE):
        raise ManageError(f"'{_shown(text)}' must start with https:// (or http:// for localhost).")
    rest = text.split("://", 1)[1]
    if "@" in rest.split("/", 1)[0]:
        raise ManageError("An origin cannot contain a user name or password.")
    if any(ch in rest for ch in "/?#"):
        raise ManageError(
            "An origin is only the scheme, host and port (https://app.example.com): remove the path, query or fragment."
        )
    m = _ORIGIN_RE.fullmatch(text.lower())
    if m is None:
        raise ManageError(
            f"'{_shown(text)}' is not a valid origin such as https://app.example.com or http://localhost:5173."
        )
    scheme, host, port = m.group(1), m.group(2), m.group(3)
    if host.startswith("["):
        try:  # the pattern only checks the characters: `[:::]` and `[1:2:3]` are not addresses
            host = f"[{ipaddress.IPv6Address(host[1:-1]).compressed}]"  # as a browser writes it in an Origin header
        except ValueError:
            raise ManageError(
                f"'{_shown(text)}' does not have a valid IPv6 host: write it like http://[::1]:3000 or https://[2001:db8::1]."
            ) from None
    else:
        labels = host.split(".")
        if len(host) > 253 or any(_LABEL_RE.fullmatch(label) is None for label in labels):
            raise ManageError(f"'{_shown(text)}' does not have a valid host name.")
        if all(label.isdigit() for label in labels) and (len(labels) != 4 or any(int(label) > 255 for label in labels)):
            raise ManageError(f"'{_shown(text)}' does not have a valid host name.")
    if port is not None:
        if len(port) > 1 and port.startswith("0"):
            raise ManageError("The port of an origin is written without leading zeros, for example 8443.")
        if not 1 <= int(port) <= 65535:
            raise ManageError("The port of an origin must be from 1 to 65535.")
    if scheme == "http" and host not in _LOCAL_HOSTS:
        raise ManageError(
            "Plain http is only allowed for localhost, 127.0.0.1 and [::1]: use https for any other origin."
        )
    if port is not None and port == _DEFAULT_PORTS[scheme]:
        port = None
    return f"{scheme}://{host}" + (f":{int(port)}" if port is not None else "")


def _shown(text: str) -> str:
    return "".join(ch if ch.isprintable() and ch.isascii() else "?" for ch in text[:60])


def _origins(data) -> list[str] | None:
    if "origins" not in data:
        return None
    raw = data["origins"]
    if not isinstance(raw, list):
        raise ManageError("Allowed origins must be a list.")
    if len(raw) > 4 * MAX_ORIGINS:
        raise ManageError(f"At most {MAX_ORIGINS} origins can be allowed for one endpoint.")
    out: list[str] = []
    for item in raw:
        origin = normalize_origin(item)
        if origin not in out:  # duplicates collapse
            out.append(origin)
    if len(out) > MAX_ORIGINS:
        raise ManageError(f"At most {MAX_ORIGINS} origins can be allowed for one endpoint.")
    return sorted(out)


def _fields(data, dataset: sd.Dataset) -> list[str] | None:
    if "fields" not in data:
        return None
    raw = data["fields"]
    if not isinstance(raw, list) or not raw:
        raise ManageError("Select at least one field to share.")
    known = sd.field_map(dataset)
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str) or item not in known:
            raise ManageError(f"'{_shown(str(item))}' is not a field of the {dataset.label} data set.")
        if item in out:
            raise ManageError(f"The field '{item}' is selected twice.")
        out.append(item)
    return out


def check_locked_filters(dataset: sd.Dataset, raw) -> dict[str, str]:
    """Validate the locked filters of an endpoint against the dataset's declared filters. Returns {key: text value}."""
    if not isinstance(raw, dict):
        raise ManageError('Locked filters must be an object such as {"status": "active"}.')
    declared = sd.filter_map(dataset)
    out: dict[str, str] = {}
    typed: dict[str, object] = {}
    for key, value in raw.items():
        flt = declared.get(key) if isinstance(key, str) else None
        if flt is None:
            raise ManageError(f"'{_shown(str(key))}' is not a filter of the {dataset.label} data set.")
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise ManageError(f"The locked value of '{key}' must be text or a number.")
        try:
            typed[key] = sd.parse_filter_value(flt, value)
        except sd.FilterError as exc:
            raise ManageError(f"Locked filter: {exc.message}") from None
        out[key] = str(value)
    if dataset.date_range is not None:
        lo, hi, max_days = dataset.date_range
        if lo in typed and hi in typed:
            if typed[hi] < typed[lo] or (typed[hi] - typed[lo]).days + 1 > max_days:
                raise ManageError(f"The locked dates must be in order and at most {max_days} days apart.")
    return out


# ── the endpoint as data ────────────────────────────────────────────────────


def _iso(value) -> str | None:
    return value.astimezone(FACTORY_TZ).isoformat(timespec="seconds") if value is not None else None


def _settings(ep: SharedEndpoint, origins: list[str]) -> dict:
    """What a PUT can change (also the fingerprint and the audit's before / after)."""
    return {
        "name": ep.name,
        "description": ep.description,
        "fields": list(ep.fields),
        "lockedFilters": dict(ep.locked_filters or {}),
        "origins": sorted(origins),
        "allowNoOrigin": ep.allow_no_origin,
        "pageSizeDefault": ep.page_size_default,
        "pageSizeMax": ep.page_size_max,
        "rateLimitPerMinute": ep.rate_limit_per_minute,
        "enabled": ep.enabled,
    }


def _version(settings: dict) -> str:
    return hashlib.sha256(json.dumps(settings, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def _live_key_q(prefix: str = "") -> Q:
    now = timezone.now()
    return Q(**{f"{prefix}revoked_at__isnull": True}) & (
        Q(**{f"{prefix}expires_at__isnull": True}) | Q(**{f"{prefix}expires_at__gt": now})
    )


def _endpoint_json(ep: SharedEndpoint, origins: list[str], live_keys: int, calls24h: int, last_call) -> dict:
    dataset = sd.get_dataset(ep.dataset)
    settings = _settings(ep, origins)
    return {
        "id": ep.id,
        "slug": ep.slug,
        **settings,
        "dataset": ep.dataset,
        "datasetLabel": dataset.label if dataset else ep.dataset,
        "url": f"/api/shared/{ep.slug}",
        "createdBy": ep.created_by,
        "createdAt": _iso(ep.created_at),
        "updatedAt": _iso(ep.updated_at),
        "version": _version(settings),
        "liveKeys": live_keys,
        "calls24h": calls24h,
        "lastCallAt": _iso(last_call),
        "sensitiveFields": sd.sensitive_fields(dataset, ep.fields) if dataset else [],
    }


def _stats(ids: list[int]) -> tuple[dict, dict, dict]:
    """(live keys, calls in the last 24 h, last call) per endpoint id: three grouped queries."""
    live = dict(
        SharedEndpointKey.objects.filter(endpoint_id__in=ids)
        .filter(_live_key_q())
        .values_list("endpoint_id")
        .annotate(n=Count("id"))
    )
    since = timezone.now() - timedelta(hours=24)
    calls = dict(
        SharedEndpointAccessLog.objects.filter(endpoint_id__in=ids, at__gte=since)
        .values_list("endpoint_id")
        .annotate(n=Count("id"))
    )
    last = dict(
        SharedEndpointAccessLog.objects.filter(endpoint_id__in=ids).values_list("endpoint_id").annotate(last=Max("at"))
    )
    return live, calls, last


def _one_json(ep: SharedEndpoint) -> dict:
    origins = list(ep.origins.values_list("origin", flat=True))
    live, calls, last = _stats([ep.id])
    return _endpoint_json(ep, origins, live.get(ep.id, 0), calls.get(ep.id, 0), last.get(ep.id))


def _key_json(key: SharedEndpointKey) -> dict:
    now = timezone.now()
    if key.revoked_at is not None:
        state = "revoked"
    elif key.expires_at is not None and key.expires_at <= now:
        state = "expired"
    else:
        state = "active"
    return {
        "id": key.id,
        "label": key.label,
        "prefix": key.prefix,
        "createdBy": key.created_by,
        "createdAt": _iso(key.created_at),
        "expiresAt": _iso(key.expires_at),
        "revokedAt": _iso(key.revoked_at),
        "lastUsedAt": _iso(key.last_used_at),
        "lastUsedIp": key.last_used_ip or None,
        "status": state,
    }


def _limits_json() -> dict:
    return {
        "maxEndpoints": MAX_ENDPOINTS,
        "maxLiveKeysPerEndpoint": MAX_LIVE_KEYS,
        "maxOriginsPerEndpoint": MAX_ORIGINS,
        "maxRateLimitPerMinute": 6000,
        "logRetentionDays": 90,
    }


def _actor(request: Request) -> str:
    return get_hr_display_name(request)[:150]


# ── catalog / list / create ─────────────────────────────────────────────────


@management_view("GET")
def catalog(request: Request) -> Response:
    body = sd.catalog_json()
    body["limits"] = _limits_json()
    return Response(body)


@management_view("GET", "POST")
def endpoints(request: Request) -> Response:
    if request.method == "GET":
        return _list(request)
    return _create(request)


def _list(request: Request) -> Response:
    rows = list(SharedEndpoint.objects.order_by("id"))
    ids = [r.id for r in rows]
    origins: dict[int, list[str]] = {i: [] for i in ids}
    for endpoint_id, origin in SharedEndpointOrigin.objects.filter(endpoint_id__in=ids).values_list(
        "endpoint_id", "origin"
    ):
        origins[endpoint_id].append(origin)
    live, calls, last = _stats(ids)
    return Response(
        {
            "endpoints": [
                _endpoint_json(r, origins[r.id], live.get(r.id, 0), calls.get(r.id, 0), last.get(r.id)) for r in rows
            ],
            "limits": _limits_json(),
        }
    )


def _parse_settings(data: dict, dataset: sd.Dataset, current: dict | None) -> dict:
    """The proposed settings: the body's keys over `current` (None = a new endpoint: the defaults)."""
    name = _text(data, "name", "The name", MAX_NAME, required=current is None)
    description = _text(data, "description", "The description", MAX_DESCRIPTION, multiline=True)
    fields = _fields(data, dataset)
    if current is None and fields is None:
        raise ManageError("Select at least one field to share.")
    locked = check_locked_filters(dataset, data["lockedFilters"]) if "lockedFilters" in data else None
    origins = _origins(data)
    allow_no_origin = _bool(data, "allowNoOrigin", "The server-to-server switch")
    enabled = _bool(data, "enabled", "The enabled switch")
    rate = _int(data, "rateLimitPerMinute", "The rate limit", 1, 6000)
    size_max = _int(data, "pageSizeMax", "The largest page size", 1, dataset.max_page_size)
    size_default = _int(data, "pageSizeDefault", "The default page size", 1, dataset.max_page_size)

    base = current or {
        "name": "",
        "description": "",
        "fields": [],
        "lockedFilters": {},
        "origins": [],
        "allowNoOrigin": True,
        "pageSizeDefault": min(DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE_MAX, dataset.max_page_size),
        "pageSizeMax": min(DEFAULT_PAGE_SIZE_MAX, dataset.max_page_size),
        "rateLimitPerMinute": 60,
        "enabled": True,
    }
    given = {
        "name": name,
        "description": description,
        "fields": fields,
        "lockedFilters": locked,
        "origins": origins,
        "allowNoOrigin": allow_no_origin,
        "pageSizeDefault": size_default,
        "pageSizeMax": size_max,
        "rateLimitPerMinute": rate,
        "enabled": enabled,
    }
    proposed = {k: (given[k] if given[k] is not None else base[k]) for k in base}
    if current is None and size_max is not None and size_default is None:
        proposed["pageSizeDefault"] = min(proposed["pageSizeDefault"], size_max)
    if proposed["pageSizeDefault"] > proposed["pageSizeMax"]:
        raise ManageError("The default page size cannot be larger than the largest page size.")
    return proposed


def _sensitive_gate(dataset: sd.Dataset, before_fields: list[str], proposed_fields: list[str], data: dict) -> list[str]:
    """The personal / financial fields this save newly selects. Raises unless `acknowledgeSensitive` is true."""
    added = sd.sensitive_fields(dataset, [f for f in proposed_fields if f not in before_fields])
    if added and data.get("acknowledgeSensitive") is not True:
        raise ManageError(
            "This selects personal or financial fields ("
            + ", ".join(added)
            + "): confirm that you want to share them by sending acknowledgeSensitive: true.",
            code="sensitive_confirmation_required",
            fields=added,
        )
    return added


def _create(request: Request) -> Response:
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        slug = data.get("slug")
        if not isinstance(slug, str) or SLUG_RE.fullmatch(slug) is None:
            raise ManageError("The address must be 3 to 60 characters: lower-case letters, digits and hyphens.")
        dataset = sd.get_dataset(data.get("dataset"))
        if dataset is None:
            raise ManageError("Choose one of the available data sets.")
        proposed = _parse_settings(data, dataset, None)
        added = _sensitive_gate(dataset, [], proposed["fields"], data)
        with transaction.atomic():
            # lock every endpoint row so two creates at the same moment cannot both pass the 100-endpoint limit
            ids = list(SharedEndpoint.objects.select_for_update().values_list("id", flat=True))
            if len(ids) >= MAX_ENDPOINTS:
                raise ManageError(f"At most {MAX_ENDPOINTS} endpoints can exist: delete one you no longer use.")
            if SharedEndpoint.objects.filter(slug=slug).exists():
                raise ManageError("That address is already used by another endpoint: choose a different one.")
            now = timezone.now()
            ep = SharedEndpoint.objects.create(
                slug=slug,
                name=proposed["name"],
                description=proposed["description"],
                dataset=dataset.key,
                fields=proposed["fields"],
                locked_filters=proposed["lockedFilters"],
                allow_no_origin=proposed["allowNoOrigin"],
                page_size_default=proposed["pageSizeDefault"],
                page_size_max=proposed["pageSizeMax"],
                rate_limit_per_minute=proposed["rateLimitPerMinute"],
                enabled=proposed["enabled"],
                created_by=_actor(request),
                created_at=now,
                updated_at=now,
            )
            SharedEndpointOrigin.objects.bulk_create(
                [SharedEndpointOrigin(endpoint=ep, origin=o) for o in proposed["origins"]]
            )
    except ManageError as exc:
        return _bad(exc)
    except IntegrityError:
        return _bad(ManageError("That address is already used by another endpoint: choose a different one."))
    new_values = {"slug": ep.slug, "dataset": ep.dataset, **proposed}
    if added:
        new_values["sensitiveFieldsAdded"] = added
    log_action(
        request,
        "create",
        AUDIT_MODULE,
        record_id=ep.id,
        description=f"Created shared endpoint '{ep.slug}' ({dataset.label}, {len(ep.fields)} field(s))"
        + (f"; shares personal/financial fields: {', '.join(added)}" if added else ""),
        new_values=new_values,
    )
    return Response(_one_json(ep), status=201)


# ── one endpoint ────────────────────────────────────────────────────────────


def _not_found() -> Response:
    return Response({"error": "That endpoint does not exist."}, status=404)


@management_view("GET", "PUT", "DELETE")
def endpoint_detail(request: Request, pk: int) -> Response:
    if request.method == "GET":
        ep = SharedEndpoint.objects.filter(pk=pk).first()
        return Response(_one_json(ep)) if ep else _not_found()
    if request.method == "DELETE":
        return _delete(request, pk)
    return _update(request, pk)


def _update(request: Request, pk: int) -> Response:
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        with transaction.atomic():
            ep = SharedEndpoint.objects.select_for_update().filter(pk=pk).first()
            if ep is None:
                return _not_found()
            dataset = sd.get_dataset(ep.dataset)
            if dataset is None:
                raise ManageError(
                    "This endpoint uses a data set that no longer exists: delete it and create a new one."
                )
            if "slug" in data and data["slug"] != ep.slug:
                raise ManageError("The address cannot be changed after the endpoint is created: create a new endpoint.")
            if "dataset" in data and data["dataset"] != ep.dataset:
                raise ManageError("The data set cannot be changed: create a new endpoint for another data set.")
            before_origins = sorted(ep.origins.values_list("origin", flat=True))
            before = _settings(ep, before_origins)
            expected = data.get("expectedVersion")
            if expected is not None and expected != _version(before):
                raise ManageError(STALE_VERSION, code="stale_settings")
            proposed = _parse_settings(data, dataset, before)
            added = _sensitive_gate(dataset, before["fields"], proposed["fields"], data)
            if proposed == before:
                return Response(_one_json(ep))
            ep.name = proposed["name"]
            ep.description = proposed["description"]
            ep.fields = proposed["fields"]
            ep.locked_filters = proposed["lockedFilters"]
            ep.allow_no_origin = proposed["allowNoOrigin"]
            ep.page_size_default = proposed["pageSizeDefault"]
            ep.page_size_max = proposed["pageSizeMax"]
            ep.rate_limit_per_minute = proposed["rateLimitPerMinute"]
            ep.enabled = proposed["enabled"]
            ep.updated_at = timezone.now()
            ep.save()
            gone = [o for o in before_origins if o not in proposed["origins"]]
            fresh = [o for o in proposed["origins"] if o not in before_origins]
            if gone:
                SharedEndpointOrigin.objects.filter(endpoint=ep, origin__in=gone).delete()
            if fresh:
                SharedEndpointOrigin.objects.bulk_create([SharedEndpointOrigin(endpoint=ep, origin=o) for o in fresh])
    except ManageError as exc:
        return _bad(exc)
    old_values: dict = {}
    new_values: dict = {}
    for key in before:
        if before[key] != proposed[key]:
            old_values[key] = before[key]
            new_values[key] = proposed[key]
    if "fields" in new_values:
        new_values["fieldsAdded"] = [f for f in proposed["fields"] if f not in before["fields"]]
        new_values["fieldsRemoved"] = [f for f in before["fields"] if f not in proposed["fields"]]
    if added:
        new_values["sensitiveFieldsAdded"] = added
    log_action(
        request,
        "update",
        AUDIT_MODULE,
        record_id=ep.id,
        description=f"Changed shared endpoint '{ep.slug}': "
        + ", ".join(k for k in before if k in old_values)
        + (f"; now shares personal/financial fields: {', '.join(added)}" if added else ""),
        old_values=old_values,
        new_values=new_values,
    )
    return Response(_one_json(ep))


def _delete(request: Request, pk: int) -> Response:
    with transaction.atomic():
        ep = SharedEndpoint.objects.select_for_update().filter(pk=pk).first()
        if ep is None:
            return _not_found()
        snapshot = {"slug": ep.slug, "dataset": ep.dataset, "fields": list(ep.fields), "name": ep.name}
        ep_id, slug = ep.id, ep.slug
        ep.delete()  # its origins and keys go with it; the access log stays (endpoint becomes null)
    log_action(
        request,
        "delete",
        AUDIT_MODULE,
        record_id=ep_id,
        description=f"Deleted shared endpoint '{slug}'",
        old_values=snapshot,
    )
    return Response({"deleted": True, "id": ep_id})


# ── keys ────────────────────────────────────────────────────────────────────


def _parse_expiry(raw) -> datetime | None:
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise ManageError("The expiry must be a date or date and time, for example 2027-03-31.")
    text = raw.strip()
    try:
        if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text, re.ASCII):
            when = datetime.combine(date.fromisoformat(text), time(23, 59, 59), tzinfo=FACTORY_TZ)
        else:
            when = datetime.fromisoformat(text)
            if when.tzinfo is None:
                when = when.replace(tzinfo=FACTORY_TZ)
    except ValueError:
        raise ManageError("The expiry must be a date or date and time, for example 2027-03-31.") from None
    now = timezone.now()
    if when <= now:
        raise ManageError("The expiry must be in the future.")
    if when > now + timedelta(days=MAX_KEY_LIFETIME_DAYS):
        raise ManageError("The expiry cannot be more than 10 years away.")
    return when


@management_view("GET", "POST")
def endpoint_keys(request: Request, pk: int) -> Response:
    if request.method == "GET":
        if not SharedEndpoint.objects.filter(pk=pk).exists():
            return _not_found()
        keys = SharedEndpointKey.objects.filter(endpoint_id=pk).order_by("-id")
        return Response({"keys": [_key_json(k) for k in keys], "maxLiveKeys": MAX_LIVE_KEYS})
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        label = _text(data, "label", "The key label", MAX_LABEL, required=True)
        expires_at = _parse_expiry(data.get("expiresAt"))
        with transaction.atomic():
            ep = SharedEndpoint.objects.select_for_update().filter(pk=pk).first()  # serialises concurrent creates
            if ep is None:
                return _not_found()
            if SharedEndpointKey.objects.filter(endpoint=ep).filter(_live_key_q()).count() >= MAX_LIVE_KEYS:
                raise ManageError(
                    f"An endpoint can have at most {MAX_LIVE_KEYS} live keys: revoke one you no longer use."
                )
            plaintext, prefix, digest = generate_key()
            key = SharedEndpointKey.objects.create(
                endpoint=ep,
                label=label,
                prefix=prefix,
                key_hash=digest,
                created_by=_actor(request),
                expires_at=expires_at,
            )
    except ManageError as exc:
        return _bad(exc)
    log_action(
        request,
        "key_create",
        AUDIT_MODULE,
        record_id=ep.id,
        description=f"Created API key '{label}' ({prefix}...) for shared endpoint '{ep.slug}'",
        new_values={"endpoint": ep.slug, "label": label, "prefix": prefix, "expiresAt": _iso(expires_at)},
    )
    response = Response({**_key_json(key), "key": plaintext}, status=201)
    response["Cache-Control"] = "no-store"
    return response


@management_view("DELETE")
def endpoint_key_detail(request: Request, pk: int, kid: int) -> Response:
    with transaction.atomic():
        key = (
            SharedEndpointKey.objects.select_for_update()
            .select_related("endpoint")
            .filter(pk=kid, endpoint_id=pk)
            .first()
        )
        if key is None:
            return Response({"error": "That key does not exist."}, status=404)
        already = key.revoked_at is not None
        if not already:
            key.revoked_at = timezone.now()
            key.save(update_fields=["revoked_at"])
    if not already:
        log_action(
            request,
            "key_revoke",
            AUDIT_MODULE,
            record_id=key.endpoint_id,
            description=f"Revoked API key '{key.label}' ({key.prefix}...) of shared endpoint '{key.endpoint.slug}'",
            old_values={"endpoint": key.endpoint.slug, "label": key.label, "prefix": key.prefix},
        )
    return Response(_key_json(key))


# ── preview ─────────────────────────────────────────────────────────────────


@management_view("POST")
def endpoint_preview(request: Request, pk: int) -> Response:
    """The first rows exactly as the public call would shape them (selected fields only, locked filters applied). No key,
    no access-log row, no CORS. The REQUIRED filters nobody gave are filled with a recent window so the page has something
    to show; `meta.filters` says what was used."""
    ep = SharedEndpoint.objects.filter(pk=pk).first()
    if ep is None:
        return _not_found()
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    dataset = sd.get_dataset(ep.dataset)
    if dataset is None:
        return _bad(ManageError("This endpoint uses a data set that no longer exists."))
    try:
        limit = _int(data, "limit", "The limit", 1, 5) or 5
        raw = data.get("filters")
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ManageError('Filters must be an object such as {"dateFrom": "2026-10-01"}.')
        supplied: dict[str, str] = {}
        for key, value in raw.items():
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise ManageError(f"The value of filter '{_shown(str(key))}' must be text or a number.")
            supplied[str(key)] = str(value)
        locked = ep.locked_filters or {}
        supplied = sd.preview_defaults(dataset, supplied, locked)
        values = sd.parse_filters(dataset, supplied, locked)
    except ManageError as exc:
        return _bad(exc)
    except sd.FilterError as exc:
        return Response({"error": exc.message, "parameter": exc.param}, status=400)
    fields = sd.effective_fields(dataset, ep.fields)
    queryset = sd.build_queryset(dataset, values, fields)
    total = queryset.count()
    rows = sd.shape_rows(dataset, fields, queryset[:limit])
    cap, _default = paging_limits(ep, dataset)
    return Response(
        {
            "data": rows,
            "meta": {
                "endpoint": ep.slug,
                "dataset": dataset.key,
                "fields": fields,
                "page": 1,
                "pageSize": limit,
                "total": total,
                "hasMore": limit < total,
                "generatedAt": _iso(timezone.now()),
                "preview": True,
                "filters": {
                    k: str(v) if not isinstance(v, tuple) else f"{v[0]:04d}-{v[1]:02d}" for k, v in values.items()
                },
                "maxPageSize": cap,
            },
        }
    )


# ── activity ────────────────────────────────────────────────────────────────

_PAGE_NUMBER = re.compile(r"[0-9]{1,7}", re.ASCII)


def _activity_page(request: Request, base):
    params = request.query_params
    page_raw, size_raw, status_raw = params.get("page", "1"), params.get("pageSize", "50"), params.get("status")
    if _PAGE_NUMBER.fullmatch(page_raw) is None or int(page_raw) < 1:
        return None, Response({"error": "page must be a whole number of at least 1."}, status=400)
    if _PAGE_NUMBER.fullmatch(size_raw) is None or int(size_raw) < 1:
        return None, Response({"error": "pageSize must be a whole number of at least 1."}, status=400)
    page, size = int(page_raw), min(int(size_raw), ACTIVITY_PAGE_MAX)
    if status_raw not in (None, ""):
        if status_raw == "ok":
            base = base.filter(status__lt=400)
        elif status_raw == "error":
            base = base.filter(status__gte=400)
        elif re.fullmatch(r"[1-5][0-9]{2}", status_raw, re.ASCII):
            base = base.filter(status=int(status_raw))
        else:
            return None, Response({"error": "status must be ok, error or an HTTP status such as 401."}, status=400)
    total = base.count()
    offset = (page - 1) * size
    rows = list(base.select_related("key", "endpoint").order_by("-at", "-id")[offset : offset + size])
    items = [
        {
            "id": r.id,
            "at": _iso(r.at),
            "endpointId": r.endpoint_id,
            "endpointSlug": r.endpoint_slug or (r.endpoint.slug if r.endpoint else None),
            "keyLabel": r.key.label if r.key else None,
            "keyPrefix": r.key.prefix if r.key else None,
            "status": r.status,
            "rows": r.rows,
            "origin": r.origin or None,
            "ip": r.ip or None,
            "durationMs": r.duration_ms,
            "error": r.error or None,
        }
        for r in rows
    ]
    return {
        "items": items,
        "page": page,
        "pageSize": size,
        "total": total,
        "hasMore": offset + len(items) < total,
    }, None


@management_view("GET")
def endpoint_activity(request: Request, pk: int) -> Response:
    if not SharedEndpoint.objects.filter(pk=pk).exists():
        return _not_found()
    body, refusal = _activity_page(request, SharedEndpointAccessLog.objects.filter(endpoint_id=pk))
    return refusal or Response(body)


@management_view("GET")
def activity(request: Request) -> Response:
    base = SharedEndpointAccessLog.objects.all()
    raw = request.query_params.get("endpointId")
    if raw not in (None, ""):
        if not re.fullmatch(r"[0-9]{1,9}", raw, re.ASCII):
            return Response({"error": "endpointId must be a whole number."}, status=400)
        base = base.filter(endpoint_id=int(raw))
    body, refusal = _activity_page(request, base)
    return refusal or Response(body)


# ── guide ───────────────────────────────────────────────────────────────────

ERROR_TABLE = (
    (400, "invalid_parameter", "A parameter is unknown, missing, repeated or has a bad value. The body names it in `parameter`."),
    (401, "invalid_key", "The API key is missing, wrong, revoked, expired, or belongs to another endpoint."),
    (403, "origin_not_allowed", "A browser call came from an origin that is not on this endpoint's allowed list."),
    (403, "origin_required", "The call had no Origin header and this endpoint only accepts calls from allowed browser origins."),
    (404, "not_found", "The address is wrong, or the endpoint is switched off."),
    (405, "method_not_allowed", "Only GET (and the browser's OPTIONS preflight) are supported."),
    (429, "rate_limited", "The key used its calls for this minute: wait the number of seconds in the Retry-After header."),
    (500, "server_error", "Something failed on the server: try again later and tell the administrator if it continues."),
)  # fmt: skip


def _sample_value(flt: sd.Filter, dataset: sd.Dataset) -> str:
    today = ist_today()
    if flt.type in ("enum", "boolean"):
        return flt.default or flt.values[0]
    if flt.type == "integer":
        return "1"
    if flt.type == "month":
        return f"{today.year:04d}-{today.month:02d}"
    if flt.type == "year":
        return str(today.year)
    if flt.type == "date":
        if dataset.date_range and flt.key == dataset.date_range[0]:
            return (today - timedelta(days=6)).isoformat()
        return today.isoformat()
    return "UK0123"


def _guide(request: Request, ep: SharedEndpoint) -> dict:
    dataset = sd.get_dataset(ep.dataset)
    fields = sd.effective_fields(dataset, ep.fields)
    known = sd.field_map(dataset)
    locked = ep.locked_filters or {}
    base_url = request.build_absolute_uri("/").rstrip("/")
    url = f"{base_url}/api/shared/{ep.slug}"
    cap, default = paging_limits(ep, dataset)

    parameters = []
    example_query = []
    for flt in dataset.filters:
        if flt.key in locked:
            continue
        sample = _sample_value(flt, dataset)
        parameters.append(
            {
                "name": flt.key,
                "type": flt.type,
                "required": flt.required,
                "default": flt.default,
                "values": list(flt.values),
                "description": flt.description,
                "example": sample,
            }
        )
        if flt.required:
            example_query.append(f"{flt.key}={sample}")
    parameters.append(
        {
            "name": "page",
            "type": "integer",
            "required": False,
            "default": "1",
            "values": [],
            "description": "Page number, starting at 1.",
            "example": "1",
        }
    )
    parameters.append(
        {
            "name": "pageSize",
            "type": "integer",
            "required": False,
            "default": str(default),
            "values": [],
            "description": f"Rows per page, 1 to {cap}. A larger number is lowered to {cap}.",
            "example": str(default),
        }
    )
    full_url = url + ("?" + "&".join(example_query) if example_query else "")
    sample_row = {key: known[key].sample for key in fields}
    sample = {
        "data": [sample_row],
        "meta": {
            "endpoint": ep.slug,
            "dataset": dataset.key,
            "fields": fields,
            "page": 1,
            "pageSize": default,
            "total": 1,
            "hasMore": False,
            "generatedAt": "2026-10-17T09:30:00+05:30",
        },
    }
    key_placeholder = "YOUR_API_KEY"
    examples = {
        "curl": f'curl -H "Authorization: Bearer {key_placeholder}" \\\n     "{full_url}"',
        "javascript": (
            f'const response = await fetch("{full_url}", {{\n'
            f'  headers: {{ Authorization: "Bearer {key_placeholder}" }},\n'
            "});\n"
            "if (!response.ok) {\n"
            "  const problem = await response.json();\n"
            "  throw new Error(`${response.status} ${problem.error}: ${problem.message}`);\n"
            "}\n"
            "const { data, meta } = await response.json();\n"
            "console.log(meta.total, data);"
        ),
        "python": (
            "import requests\n\n"
            f'response = requests.get(\n    "{url}",\n'
            f'    headers={{"Authorization": "Bearer {key_placeholder}"}},\n'
            f"    params={{{', '.join(repr(q.split('=')[0]) + ': ' + repr(q.split('=')[1]) for q in example_query)}}},\n"
            "    timeout=30,\n)\n"
            "response.raise_for_status()\n"
            "body = response.json()\n"
            'print(body["meta"]["total"], body["data"])'
        ),
        "php": (
            "<?php\n"
            f'$ch = curl_init("{full_url}");\n'
            "curl_setopt_array($ch, [\n"
            "    CURLOPT_RETURNTRANSFER => true,\n"
            "    CURLOPT_TIMEOUT => 30,\n"
            f'    CURLOPT_HTTPHEADER => ["Authorization: Bearer {key_placeholder}"],\n'
            "]);\n"
            "$json = curl_exec($ch);\n"
            "$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);\n"
            "curl_close($ch);\n"
            'if ($status !== 200) { throw new Exception("HTTP $status: $json"); }\n'
            "$body = json_decode($json, true);\n"
            'echo $body["meta"]["total"];'
        ),
        "csharp": (
            "using var client = new HttpClient();\n"
            f'client.DefaultRequestHeaders.Add("Authorization", "Bearer {key_placeholder}");\n'
            f'var json = await client.GetStringAsync("{full_url}");\n'
            "using var doc = System.Text.Json.JsonDocument.Parse(json);\n"
            'Console.WriteLine(doc.RootElement.GetProperty("meta").GetProperty("total"));'
        ),
        "node": (
            "// Node 18+ (global fetch). Keep the key in an environment variable, never in the source.\n"
            f'const response = await fetch("{full_url}", {{\n'
            "  headers: { Authorization: `Bearer ${process.env.UKTEX_API_KEY}` },\n"
            "});\n"
            "if (!response.ok) throw new Error(`HTTP ${response.status}`);\n"
            "const { data, meta } = await response.json();\n"
            "console.log(meta.total, data.length);"
        ),
    }
    return {
        "baseUrl": base_url,
        "url": url,
        "method": "GET",
        "headers": [
            {
                "name": "Authorization",
                "value": f"Bearer {key_placeholder}",
                "required": True,
                "description": "The API key of this endpoint. (Or send it as X-API-Key.)",
            },
            {
                "name": "X-API-Key",
                "value": key_placeholder,
                "required": False,
                "description": "The same key, as an alternative to Authorization. Never put the key in the URL.",
            },
            {
                "name": "Accept",
                "value": "application/json",
                "required": False,
                "description": "The answer is always JSON.",
            },
        ],
        "parameters": parameters,
        "lockedFilters": [{"name": k, "value": v} for k, v in locked.items()],
        "pagination": {"defaultPageSize": default, "maxPageSize": cap, "rateLimitPerMinute": ep.rate_limit_per_minute},
        "response": {
            "fields": [
                {
                    "name": key,
                    "type": known[key].type,
                    "label": known[key].label,
                    "description": known[key].description,
                    "sensitivity": known[key].sensitivity,
                    "sample": known[key].sample,
                }
                for key in fields
            ],
            "sample": sample,
        },
        "errors": [{"status": s, "code": c, "meaning": m} for s, c, m in ERROR_TABLE],
        "examples": examples,
        "access": {
            "origins": sorted(ep.origins.values_list("origin", flat=True)),
            "allowNoOrigin": ep.allow_no_origin,
            "notes": [
                "Origins protect browsers only: a script outside a browser can send any Origin header. The API key is what protects the data.",
                "Never put the key in a web page's source: anyone can read it. Call from your own server and pass the data on.",
            ],
        },
    }


@management_view("GET")
def endpoint_guide(request: Request, pk: int) -> Response:
    ep = SharedEndpoint.objects.filter(pk=pk).first()
    if ep is None:
        return _not_found()
    if sd.get_dataset(ep.dataset) is None:
        return _bad(ManageError("This endpoint uses a data set that no longer exists."))
    return Response(_guide(request, ep))
