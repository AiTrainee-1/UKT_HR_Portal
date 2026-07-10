import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-change-me")
BIOMETRIC_API_KEY = os.environ.get("BIOMETRIC_API_KEY", "")
DEBUG = os.environ.get("DEBUG", "true").lower() in ("1", "true", "yes")
ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

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
    "api.middleware.DatabaseHealthMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "UKTex_DB"),
        "USER": os.environ.get("DB_USER", "postgres"),
        "PASSWORD": os.environ.get("DB_PASSWORD", ""),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": os.environ.get("DB_PORT", "5432"),
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
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


def _load_hr_accounts() -> dict:
    """
    Exactly 4 accounts may access the HR Portal: HR, MD, and two Directors.
    Passwords are set as plaintext in .env (for easy editing) but are hashed
    here once at process startup — the plaintext is never stored or compared
    directly anywhere past this point, only the in-memory bcrypt hash is used
    (see views.py::hr_login, bcrypt.checkpw against accounts[...]["passwordHash"]).
    """
    import bcrypt

    accounts: dict[str, dict[str, str]] = {}

    def add(user_env: str, password_env: str, label: str) -> None:
        username = os.environ.get(user_env, "").strip()
        password = os.environ.get(password_env, "").strip()
        if username and password:
            pwd_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
            accounts[username.lower()] = {"username": username, "passwordHash": pwd_hash, "label": label}

    add("HR_USERNAME", "HR_PASSWORD", "HR Admin")
    add("MD_USERNAME", "MD_PASSWORD", "Managing Director")
    add("DIRECTOR1_USERNAME", "DIRECTOR1_PASSWORD", "Director")
    add("DIRECTOR2_USERNAME", "DIRECTOR2_PASSWORD", "Director")
    return accounts


HR_ACCOUNTS = _load_hr_accounts()

# Security headers — safe defaults regardless of DEBUG/HTTPS setup.
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_REFERRER_POLICY = "same-origin"
