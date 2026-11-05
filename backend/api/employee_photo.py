"""Links to employee photos that an <img> can load without a login token.

A photo is stored inline in employees.photo_url as a base64 data: URL (tens of KB, sometimes MBs). Copied into every
row of a list it made one GET of /api/hr-requests 86 MB (one employee's 2 MB photo once per request they had made),
built in memory by a server that serves everyone else with the same worker. Lists and summaries send photo_link()
instead: an absolute link to GET /api/employees/<id>/photo?v=<digest>&s=<signature>.

- v, the digest, is the first 16 hex characters of the md5 of the stored text. A new photo gives a new link, so a
  browser may keep a link's picture for good (Cache-Control immutable), and the old link stops working (404).
- s, the signature, is an HMAC of the employee id and the digest under SECRET_KEY. Only the server can make a link, so
  the endpoint serves it with no token (an <img> sends none, and the HR portal and the employee apps load it from
  another domain) without opening every photo to anyone who counts ids. Whoever holds a link can see that photo, as
  whoever held the data URL it replaces could.
- The digest is what Postgres md5(photo_url) gives (base64 text is ASCII, so the same bytes are hashed): a query can
  compute it without reading the photo out of the database (photo_stand_ins, photo_links).

Only list and summary responses carry links. The single-employee record keeps the data URL: Edit Employee sends back
the photoUrl it loaded, and a link stored as the photo would lose the picture (employee_views also ignores an
employee's own photo link sent back on save). The ID card (idcard_render decodes the data URL), the public QR
verification page and the employee's own profile keep it too.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Iterable

from django.conf import settings
from django.core.exceptions import DisallowedHost
from django.db.models import Case, F, Q, TextField, Value, When
from django.db.models.functions import MD5, Left

from .request_context import current_request

DIGEST_LENGTH = 16
SIGNATURE_LENGTH = 32
EMBEDDED = "data:"
# A link names one exact picture (its digest), so its bytes never change: the browser need not ask again.
LINK_CACHE_CONTROL = "private, max-age=31536000, immutable"

_OWN_LINK = re.compile(r"^(?:https?://[^/?#]+)?/api/employees/(\d+)/photo(?:[?#].*)?$", re.IGNORECASE)


def is_embedded(value) -> bool:
    """value is a photo stored inline (a data: URL), the only kind the photo endpoint serves."""
    return isinstance(value, str) and value.startswith(EMBEDDED)


def photo_digest(value: str) -> str:
    """The version tag of a stored photo: md5 of its text, 16 hex characters. Not a security measure (the signature
    is); it only has to change when the photo does and to match the database's md5()."""
    return hashlib.md5(value.encode("utf-8"), usedforsecurity=False).hexdigest()[:DIGEST_LENGTH]


def photo_signature(emp_id, digest: str) -> str:
    message = f"employee-photo:{emp_id}:{digest}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()[:SIGNATURE_LENGTH]


def signature_matches(emp_id, digest, signature) -> bool:
    """The server made a link for this employee and digest (a constant-time comparison)."""
    if not (isinstance(digest, str) and isinstance(signature, str) and signature.isascii()):
        return False
    return hmac.compare_digest(photo_signature(emp_id, digest), signature)


def _api_origin() -> str:
    """scheme://host of the API as the caller reached it (behind Railway's proxy too: settings trusts
    X-Forwarded-Proto / X-Forwarded-Host), else BACKEND_PUBLIC_URL, else "" (a relative link)."""
    request = current_request()
    if request is not None:
        try:
            return request.build_absolute_uri("/").rstrip("/")
        except (DisallowedHost, KeyError):
            pass
    return (getattr(settings, "BACKEND_PUBLIC_URL", "") or "").rstrip("/")


def photo_link(emp_id, value, digest: str | None = None):
    """What a list sends as an employee's photoUrl. Nothing (None / "") and an external link come back as they are;
    an embedded photo becomes its signed link. `digest`: the photo's digest when the query computed it and `value` is
    only the "data:" stand-in (photo_stand_ins)."""
    if not is_embedded(value):
        return value
    digest = digest or photo_digest(value)
    return f"{_api_origin()}/api/employees/{emp_id}/photo?v={digest}&s={photo_signature(emp_id, digest)}"


def is_own_photo_link(emp_id, value) -> bool:
    """value is a link to this employee's own photo (signed or not, absolute or relative): a list row sent back on a
    save, which must leave the stored photo alone rather than replace it with a link to itself."""
    if not isinstance(value, str):
        return False
    match = _OWN_LINK.match(value.strip())
    return bool(match) and int(match.group(1)) == int(emp_id)


def photo_stand_ins() -> dict:
    """Annotations that stand in for the photo column of an Employee queryset, so the photo is never read out:
    photo_ref is an external link as it is and an embedded photo as just "data:"; photo_digest is the embedded photo's
    digest, computed by the database (None otherwise). Use with .defer("photo_url")."""
    embedded = Q(photo_url__startswith=EMBEDDED)
    return {
        "photo_ref": Case(When(embedded, then=Value(EMBEDDED)), default=F("photo_url"), output_field=TextField()),
        "photo_digest": Case(
            When(embedded, then=Left(MD5("photo_url"), DIGEST_LENGTH)),
            default=Value(None),
            output_field=TextField(),
        ),
    }


def photo_links(emp_ids: Iterable) -> dict:
    """{employee id: photoUrl for a list} for these employees, in one query that reads no photo out of the database.
    For a list of requests / logs whose rows were loaded with .defer("employee__photo_url")."""
    from .models import Employee

    ids = {i for i in emp_ids if i is not None}
    if not ids:
        return {}
    rows = (
        Employee.objects.filter(pk__in=ids).annotate(**photo_stand_ins()).values_list("pk", "photo_ref", "photo_digest")
    )
    return {pk: photo_link(pk, ref, digest) for pk, ref, digest in rows}


def employee_photo_link(emp, links: dict | None = None):
    """The photoUrl a list or summary shows for `emp`: from `links` (photo_links of the page) when it is there,
    otherwise from the employee's own photo column."""
    if emp is None:
        return None
    if links is not None and emp.pk in links:
        return links[emp.pk]
    return photo_link(emp.pk, emp.photo_url)
