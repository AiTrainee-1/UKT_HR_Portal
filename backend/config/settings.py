import os
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-change-me")
BIOMETRIC_API_KEY = os.environ.get("BIOMETRIC_API_KEY", "")
# The frontend's own public origin -needed because the backend can no longer
# assume it shares a hostname with the frontend (see growth_views.py's
# _public_base_url, which used to build public QR-verification links from
# the backend's own request host; that only worked because on-premise Nginx
# served both under one domain. On Railway+Vercel they're different origins,
# so the backend has no way to derive this on its own -it must be told.
# Left empty for on-premise/local dev, where request-host-based building is
# still correct and this var isn't needed.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "").rstrip("/")
DEBUG = os.environ.get("DEBUG", "true").lower() in ("1", "true", "yes")
ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

if DEBUG:
    # Local development only: also accept this machine's own LAN addresses,
    # so a phone or tablet on the same Wi-Fi can reach the dev server by IP
    # (http://192.168.x.x:8000) to test the employee mobile app against it.
    # Auto-detected rather than listed in .env because the address is issued
    # by DHCP -pinning it there means a silent DisallowedHost every time the
    # router hands out a different one. Adds no new deployment target: this
    # branch never runs in production, where DEBUG is false.
    import socket

    _lan_hosts = {"0.0.0.0", "[::1]"}
    try:
        _hostname = socket.gethostname()
        _lan_hosts.add(_hostname)
        _lan_hosts.update(info[4][0] for info in socket.getaddrinfo(_hostname, None))
    except OSError:
        pass  # no network / DNS -localhost entries above still work
    ALLOWED_HOSTS = sorted({*ALLOWED_HOSTS, *_lan_hosts})

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "api",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "api.maintenance_middleware.MaintenanceModeMiddleware",
    "api.middleware.DatabaseHealthMiddleware",
    "api.permission_middleware.HrPermissionMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# ── Database ──────────────────────────────────────────────────────────────
# Cloud platforms (Railway, Render, Heroku, Fly) inject the connection as a
# single DATABASE_URL rather than discrete fields, so that takes precedence
# when present. Local/on-premise development is untouched: with no
# DATABASE_URL set it falls back to the individual DB_* vars from .env
# exactly as before.
#
# Parsed with urllib instead of pulling in dj-database-url -the only shape
# this app needs is a postgres:// URL, and keeping the dependency list short
# matters for cloud build times.


def _database_from_url(url: str) -> dict | None:
    """Turn postgres://user:pass@host:port/dbname into Django's DATABASES dict.

    Returns None for anything that isn't a Postgres URL so the caller can
    fall back to the discrete vars rather than starting with a broken config.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        return None
    try:
        port = parsed.port
    except ValueError:  # non-numeric port in the URL
        return None
    # urlparse leaves credentials percent-encoded, and generated passwords
    # routinely contain characters that get escaped (@ : / ?), so unquoting
    # is required -not cosmetic.
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parsed.path.lstrip("/")),
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname or "",
        "PORT": str(port or ""),
    }


_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
_db_from_url = _database_from_url(_DATABASE_URL) if _DATABASE_URL else None

DATABASES = {
    "default": _db_from_url
    or {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "UKTex_DB"),
        "USER": os.environ.get("DB_USER", "postgres"),
        "PASSWORD": os.environ.get("DB_PASSWORD", ""),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": os.environ.get("DB_PORT", "5432"),
    }
}

# Managed Postgres generally requires TLS, while a local install usually has
# none configured -so this is only applied when explicitly asked for, via
# DB_SSLMODE or an ?sslmode= parameter on DATABASE_URL. Set
# DB_SSLMODE=require on Railway. (backup_service.py passes the same value to
# pg_dump/psql through PGSSLMODE, so backups and the ORM agree.)
_sslmode = os.environ.get("DB_SSLMODE", "").strip()
if not _sslmode and _DATABASE_URL:
    _sslmode = (parse_qs(urlparse(_DATABASE_URL).query).get("sslmode") or [""])[0].strip()
if _sslmode:
    DATABASES["default"].setdefault("OPTIONS", {})["sslmode"] = _sslmode

# Reuses one DB connection across requests within a worker for up to 60s
# instead of opening a fresh TCP+TLS handshake on every single request -the
# default (0) is fine talking to "localhost", but is pure added latency
# against a networked Postgres (Railway private network or otherwise).
# 60s, not "forever" (None), so a connection Postgres has quietly dropped
# gets recycled instead of every following request failing against a dead
# socket. CONN_HEALTH_CHECKS pings the connection before reuse and
# transparently reconnects if it's gone stale within that window.
DATABASES["default"]["CONN_MAX_AGE"] = int(os.environ.get("DB_CONN_MAX_AGE", "60"))
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True

# ── Process clock ────────────────────────────────────────────────────────
# This codebase records attendance with naive `datetime.now()` / `date.today()`
# in ~52 places, which read the OPERATING SYSTEM clock. On the old on-premise
# Windows box that clock was IST, so it was correct by accident. Railway's
# containers run on UTC, so every geo punch, On-Duty punch, day-end job and
# payroll period silently shifted 5h30m earlier -a 10:24 punch stored as 04:54.
#
# Setting TZ for the process fixes all of them at once, and keeps the naive
# local-time convention the whole codebase is written against. Editing 52 call
# sites would leave the next `datetime.now()` anyone adds broken again.
#
# Django's own TIME_ZONE stays UTC below: with USE_TZ=True, aware datetimes are
# still stored and compared in UTC. Only the naive "what time is it here"
# calls change, which is exactly the set that was wrong.
# setdefault() was the bug: it only applies when TZ is UNSET, so any host
# that already exports TZ (a base image, a platform default, a Windows dev
# box) silently kept its own zone and every naive call stayed wrong. Set it
# outright -SERVER_TIMEZONE is still the intended override.
os.environ["TZ"] = os.environ.get("SERVER_TIMEZONE", "Asia/Kolkata")
if hasattr(time, "tzset"):          # Unix only; Windows has no tzset
    time.tzset()
# NOTE: on Windows there is no tzset(), so the line above cannot take effect
# and naive date.today()/datetime.now() keep returning the OS zone. That is
# why api/clock.py exists: ist_now()/ist_today()/ist_time() name the zone
# explicitly and are correct on every host regardless of TZ. Date-sensitive
# code should use those, not the process clock.

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Uploaded resume files (Resume Screening). Served only through the
# authenticated candidate-resume download view, never Django's raw static
# media serving -MEDIA_URL is just the on-disk path prefix here.
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# All FileField uploads (geo-punch selfies, resumes, employee documents) go
# through HybridFileStorage: NEW files are written to Postgres (the
# FileBlob table), so they survive a Railway redeploy instead of vanishing
# with the container's local disk; files that already existed on disk before
# this shipped keep being read from MEDIA_ROOT above, unchanged. See
# api/db_file_storage.py for why a fallback, not a straight cutover.
#
# "staticfiles" is left on Django's default (local disk, collected at
# deploy time by collectstatic) -only user uploads move to the database.
STORAGES = {
    "default": {
        "BACKEND": "api.db_file_storage.HybridFileStorage",
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True

CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:23805,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]
CORS_ALLOW_CREDENTIALS = True

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        # Per-IP safety net on top of the per-username lockout in views.py —
        # slows down credential-stuffing even if it's spread across usernames.
        "login": "10/min",
    },
}

JWT_SECRET = os.environ.get("JWT_SECRET", "fallback-secret")

# The only credential left in .env -bootstraps the one super-admin HRUser row
# on first startup (see api/apps.py::_bootstrap_admin_account). Every other
# HR-portal account (MD, Directors, HR staff, etc.) is created and managed
# from Account Management in the portal itself, stored in the HRUser table.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "").strip()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "").strip()

# Meta WhatsApp Cloud API credentials -.env only, same rule as ADMIN_* above:
# never stored in the database, never editable from the UI. See
# api/whatsapp_service.py for how these are consumed.
WHATSAPP_ACCESS_TOKEN = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
WHATSAPP_PHONE_NUMBER_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
WHATSAPP_BUSINESS_ACCOUNT_ID = os.environ.get("WHATSAPP_BUSINESS_ACCOUNT_ID", "").strip()
WHATSAPP_API_VERSION = os.environ.get("WHATSAPP_API_VERSION", "v21.0").strip()
WHATSAPP_DEFAULT_COUNTRY_CODE = os.environ.get("WHATSAPP_DEFAULT_COUNTRY_CODE", "91").strip()

# Security headers -safe defaults regardless of DEBUG/HTTPS setup.
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_REFERRER_POLICY = "same-origin"
