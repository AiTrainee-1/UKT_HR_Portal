"""
Org-wide appearance settings for the HR portal.

Only the *selection* lives here -which theme id is active, plus any per-token
colour overrides. The themes themselves (their palettes, labels, previews) are
defined in the frontend at src/lib/themes.ts, because they're pure CSS custom
property values with no server-side meaning. Keeping them there avoids having
to ship a migration every time a shade is tweaked.

Reading is allowed for any signed-in user so the theme applies immediately on
load; changing it is gated on the settings.themes permission module.
"""
from __future__ import annotations

import re

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_auth, require_hr
from .user_settings import settings_for
from .models import PayrollSettings

# CSS custom property name: "--primary", "--sidebar-accent-foreground", ...
TOKEN_RE = re.compile(r"^--[a-z0-9-]{1,48}$")
# Values are HSL triples the stylesheet wraps in hsl(): "201 100% 29%".
# Deliberately strict -these get injected straight into inline styles, so
# anything that isn't a plain triple is rejected rather than sanitised.
VALUE_RE = re.compile(r"^\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%$")

MAX_OVERRIDES = 40


def _payload(settings: PayrollSettings) -> dict:
    return {
        "themeName": settings.theme_name or "default",
        "themeCustom": settings.theme_custom or {},
    }


@api_view(["GET"])
@require_auth
def theme_settings(request: Request) -> Response:
    return Response(_payload(settings_for(request)))


@api_view(["PUT"])
@require_hr
def update_theme_settings(request: Request) -> Response:
    settings = settings_for(request)

    name = request.data.get("themeName")
    if name is not None:
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", name):
            return Response({"error": "Invalid theme name."}, status=400)
        settings.theme_name = name

    custom = request.data.get("themeCustom")
    if custom is not None:
        if not isinstance(custom, dict):
            return Response({"error": "themeCustom must be an object."}, status=400)
        if len(custom) > MAX_OVERRIDES:
            return Response({"error": f"At most {MAX_OVERRIDES} overrides."}, status=400)
        cleaned: dict[str, str] = {}
        for token, value in custom.items():
            if not isinstance(token, str) or not TOKEN_RE.match(token):
                return Response({"error": f"Invalid CSS variable name: {token}"}, status=400)
            if not isinstance(value, str) or not VALUE_RE.match(value.strip()):
                return Response(
                    {"error": f"Invalid value for {token} — expected an HSL triple like '201 100% 29%'."},
                    status=400,
                )
            cleaned[token] = value.strip()
        settings.theme_custom = cleaned

    settings.save(update_fields=["theme_name", "theme_custom", "updated_at"])
    log_action(
        request, "update", "settings",
        description=f"Changed portal theme to '{settings.theme_name}'"
                    + (f" with {len(settings.theme_custom)} custom colour(s)" if settings.theme_custom else ""),
    )
    return Response(_payload(settings))
