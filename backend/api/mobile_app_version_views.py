"""
Mobile App updates -HR publishes each new build of the employee app (a version
number, a download link, release notes) and the app offers it to employees.

  HR portal (Mobile App Login -> New Version), module "mobile_app_login":
    GET    /api/mobile-app/versions          list, newest first
    POST   /api/mobile-app/versions          publish a version
    PUT    /api/mobile-app/versions/<id>     edit, withdraw or re-activate
    DELETE /api/mobile-app/versions/<id>     remove

  The employee app -no login, so the prompt can also reach someone who cannot
  sign in on an old build:
    GET    /api/mobile-app/latest-version?platform=android&current=3.0.0

The APK is never stored here, only the link to it (see MobileAppVersion).
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .models import MobileAppVersion

PLATFORMS = ("android",)
MAX_NOTES_LEN = 4000
MAX_URL_LEN = 2000

_VERSION_RE = re.compile(r"^\d{1,4}(\.\d{1,4}){1,3}$")


# ── versions ────────────────────────────────────────────────────────────────


def parse_version(value: object) -> tuple[int, ...] | None:
    """ "3.0.10" -> (3, 0, 10), or None if it is not a dotted number.

    Compared as numbers, never as text, so 3.0.10 is newer than 3.0.9, and
    trailing zeros do not matter: 3.0 and 3.0.0 are the same release.
    """
    if not isinstance(value, str):
        return None
    text = value.strip().lstrip("vV")
    if not _VERSION_RE.match(text):
        return None
    parts = [int(p) for p in text.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def clean_version(value: object) -> str | None:
    """The version as HR should see it stored ("v3.0" -> "3.0"), or None if invalid."""
    if parse_version(value) is None:
        return None
    return str(value).strip().lstrip("vV")


# ── download links ──────────────────────────────────────────────────────────

_DRIVE_FILE_PATH = re.compile(r"^/file/d/([\w-]+)")


def normalize_download_url(raw: object) -> str | None:
    """Validates the link and turns a Google Drive "share" link into a direct download.

    A Drive share link (drive.google.com/file/d/<id>/view) opens a preview page
    in the browser; the same file's uc?export=download link starts the download
    straight away, which is what an employee tapping "Download and Install"
    needs. Any other http(s) link is kept exactly as given. Returns None when
    the value is not an http(s) link.
    """
    if not isinstance(raw, str):
        return None
    url = raw.strip()
    if not url or len(url) > MAX_URL_LEN:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None

    host = parsed.netloc.lower().removeprefix("www.")
    if host in ("drive.google.com", "docs.google.com"):
        file_id = None
        match = _DRIVE_FILE_PATH.match(parsed.path)
        if match:
            file_id = match.group(1)
        else:
            file_id = (parse_qs(parsed.query).get("id") or [None])[0]
        if file_id and re.fullmatch(r"[\w-]+", file_id):
            return f"https://drive.google.com/uc?export=download&id={file_id}"
    return url


# ── which build is newest / does this phone need it ─────────────────────────


def active_versions(platform: str) -> list[tuple[tuple[int, ...], MobileAppVersion]]:
    """Active builds for a platform, newest first."""
    rows = []
    for row in MobileAppVersion.objects.filter(platform=platform, is_active=True):
        parsed = parse_version(row.version)
        if parsed is not None:
            rows.append((parsed, row))
    rows.sort(key=lambda pair: pair[0], reverse=True)
    return rows


def update_for(platform: str, current: object) -> dict:
    """What the app should be told: the newest active build, and whether this phone needs it.

    An update is mandatory when the newest build is, or when any build the phone
    is skipping over was: someone on 3.0.0 must not slip past a mandatory 3.1.0
    just because 3.2.0 (optional) came out afterwards.
    """
    versions = active_versions(platform)
    if not versions:
        return {"updateAvailable": False, "latest": None}

    latest_parsed, latest = versions[0]
    current_parsed = parse_version(current)
    available = current_parsed is not None and latest_parsed > current_parsed
    mandatory = available and any(
        row.is_mandatory
        for parsed, row in versions
        if parsed > current_parsed  # type: ignore[operator]
    )
    return {
        "updateAvailable": available,
        "latest": {
            "version": latest.version,
            "downloadUrl": latest.download_url,
            "releaseNotes": latest.release_notes,
            "mandatory": bool(mandatory),
            "publishedAt": latest.created_at.isoformat(),
        },
    }


def _version_json(row: MobileAppVersion, latest_id: int | None) -> dict:
    return {
        "id": row.id,
        "platform": row.platform,
        "version": row.version,
        "downloadUrl": row.download_url,
        "releaseNotes": row.release_notes,
        "isMandatory": row.is_mandatory,
        "isActive": row.is_active,
        "isLatest": row.id == latest_id,
        "createdBy": row.created_by,
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
    }


def _latest_id(platform: str) -> int | None:
    versions = active_versions(platform)
    return versions[0][1].id if versions else None


def _error(message: str, status: int = 400) -> Response:
    return Response({"error": message}, status=status)


def _validate(data, *, existing: MobileAppVersion | None = None) -> tuple[dict, Response | None]:
    """Validates the fields present in `data`; returns (cleaned fields, error)."""
    fields: dict = {}

    if "version" in data or existing is None:
        version = clean_version(data.get("version"))
        if version is None:
            return {}, _error("Enter the version as numbers separated by dots, like 3.0.0")
        fields["version"] = version

    if "downloadUrl" in data or existing is None:
        url = normalize_download_url(data.get("downloadUrl"))
        if url is None:
            return {}, _error("Enter the download link, starting with http:// or https://")
        fields["download_url"] = url

    if "releaseNotes" in data:
        notes = (data.get("releaseNotes") or "").strip()
        if len(notes) > MAX_NOTES_LEN:
            return {}, _error(f"Release notes can be at most {MAX_NOTES_LEN} characters")
        fields["release_notes"] = notes

    if "isMandatory" in data:
        fields["is_mandatory"] = bool(data.get("isMandatory"))
    if "isActive" in data:
        fields["is_active"] = bool(data.get("isActive"))

    platform = data.get("platform") or (existing.platform if existing else "android")
    if platform not in PLATFORMS:
        return {}, _error("platform must be android")
    fields["platform"] = platform

    return fields, None


# ── HR portal ────────────────────────────────────────────────────────────────


@api_view(["GET", "POST"])
@require_hr
def mobile_app_versions(request: Request) -> Response:
    if request.method == "GET":
        rows = list(MobileAppVersion.objects.all())
        rows.sort(key=lambda r: (parse_version(r.version) or (), r.created_at), reverse=True)
        latest_id = {p: _latest_id(p) for p in PLATFORMS}
        return Response([_version_json(r, latest_id.get(r.platform)) for r in rows])

    fields, error = _validate(request.data)
    if error:
        return error
    if MobileAppVersion.objects.filter(platform=fields["platform"], version=fields["version"]).exists():
        return _error(f"Version {fields['version']} has already been published", 409)

    row = MobileAppVersion.objects.create(created_by=get_hr_display_name(request), **fields)
    log_action(
        request,
        "create",
        "mobile_app_version",
        row.id,
        f"Published mobile app version {row.version}",
        new_values={"version": row.version, "mandatory": row.is_mandatory},
    )
    return Response(_version_json(row, _latest_id(row.platform)), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def mobile_app_version_detail(request: Request, pk: int) -> Response:
    row = MobileAppVersion.objects.filter(pk=pk).first()
    if not row:
        return _error("Version not found", 404)

    if request.method == "DELETE":
        version = row.version
        row.delete()
        log_action(request, "delete", "mobile_app_version", pk, f"Deleted mobile app version {version}")
        return Response(status=204)

    fields, error = _validate(request.data, existing=row)
    if error:
        return error
    new_version = fields.get("version", row.version)
    new_platform = fields.get("platform", row.platform)
    clash = MobileAppVersion.objects.filter(platform=new_platform, version=new_version).exclude(pk=row.pk)
    if clash.exists():
        return _error(f"Version {new_version} has already been published", 409)

    for name, value in fields.items():
        setattr(row, name, value)
    row.save()
    log_action(
        request,
        "update",
        "mobile_app_version",
        row.id,
        f"Updated mobile app version {row.version}",
        new_values={k: v for k, v in fields.items() if k != "download_url"},
    )
    return Response(_version_json(row, _latest_id(row.platform)))


# ── employee app (public) ────────────────────────────────────────────────────


@api_view(["GET"])
def mobile_app_latest_version(request: Request) -> Response:
    """Public on purpose: the prompt must reach people who cannot sign in on an old build.
    Only what the prompt shows is returned -a version, a link, release notes."""
    platform = request.query_params.get("platform") or "android"
    if platform not in PLATFORMS:
        return _error("platform must be android")
    response = Response(update_for(platform, request.query_params.get("current")))
    # A new release should be noticed the next time the app looks, not after a cache expires.
    response["Cache-Control"] = "no-store"
    return response
