"""
Mobile-app sign-in sessions of employees: issuing, renewing and ending them.

Why: the employee app must keep someone signed in until THEY sign out (or the server ends it), through app restarts,
days offline and long weekends. A plain 7-day JWT logged everybody out once a week, and could not be ended early.

How:
  * Every sign-in (password, one-time code) creates an EmployeeLoginSession row and a token carrying its `jti`
    (`kind: "employee_session"`), valid for TOKEN_LIFETIME.
  * The app renews the token with POST /auth/refresh (same session, fresh expiry) whenever it is online and the token
    is older than a day or so, so an employee who opens the app now and then is never asked to sign in again.
  * POST /auth/logout revokes the row; require_auth (auth.py) refuses a revoked session at once (401 "Session revoked"),
    whatever the token's own expiry says. HR can end every session of an employee (end_all).
  * A token from before this module (no jti, 7 days) keeps working until it expires; /auth/refresh upgrades it into a
    session, so an app that is updated keeps its sign-in.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.utils import timezone

from .audit_utils import _get_ip
from .jwt_utils import sign_token, verify_token
from .models import Employee, EmployeeLoginSession
from .serializers import employee_full_name
from .session_utils import parse_user_agent

SESSION_KIND = "employee_session"
# Long on purpose: the app renews it whenever it is online, so this only matters for a phone that never comes online.
TOKEN_LIFETIME = timedelta(days=180)
# last_seen_at is written at most this often per session (a write on every request would be wasteful).
TOUCH_EVERY_SECONDS = 300


def account_status(employee: Employee | None) -> str:
    """"active" or "inactive": what the mobile app reads (as `accountStatus`) to block an inactive account (owner
    2026-11-25). Employee.status is free text; everything the rest of the HRMS treats as not active (`status != "active"`:
    "inactive", a resignation approved, "terminated" ...) is "inactive" here."""
    raw = (getattr(employee, "status", None) or "").strip().lower()
    return "active" if raw == "active" else "inactive"


def sign_in_json(employee: Employee, token: str) -> dict:
    """The reply to a successful employee sign-in (password or one-time code). `accountStatus` / `employeeStatus` are
    additive (owner 2026-11-25): the app shows its "account inactive" screen straight after signing in."""
    return {
        "token": token,
        "role": "employee",
        "employeeId": employee.id,
        "name": employee_full_name(employee),
        "accountStatus": account_status(employee),
        "employeeStatus": employee.status,
    }


def issue_token(request, employee: Employee) -> str:
    """A new signed-in session for `employee` (one row) and its token."""
    jti = uuid.uuid4().hex
    user_agent = request.META.get("HTTP_USER_AGENT", "") if request is not None else ""
    EmployeeLoginSession.objects.create(
        employee=employee,
        jti=jti,
        device_label=parse_user_agent(user_agent) if user_agent else "",
        user_agent=user_agent,
        ip_address=_get_ip(request) if request is not None else None,
    )
    return _sign(employee, jti)


def _sign(employee: Employee, jti: str) -> str:
    return sign_token(
        {
            "role": "employee",
            "employeeId": employee.id,
            "name": employee_full_name(employee),
            "jti": jti,
            "kind": SESSION_KIND,
        },
        expires_in=TOKEN_LIFETIME,
    )


def is_employee_session(claims: dict) -> bool:
    return claims.get("role") == "employee" and claims.get("kind") == SESSION_KIND and bool(claims.get("jti"))


def check(claims: dict) -> str | None:
    """None when the employee session named by `claims` is open; otherwise the reason it is not (for the 401)."""
    session = EmployeeLoginSession.objects.filter(jti=claims.get("jti")).only("id", "revoked_at", "last_seen_at").first()
    if session is None or session.revoked_at is not None:
        return "Session revoked"
    now = timezone.now()
    if (now - session.last_seen_at).total_seconds() > TOUCH_EVERY_SECONDS:
        EmployeeLoginSession.objects.filter(pk=session.pk).update(last_seen_at=now)
    return None


def refresh(request, claims: dict) -> tuple[str | None, str | None]:
    """(new token, None) for a still-valid employee token, or (None, error). Keeps the same session (jti); a legacy
    token without one is upgraded into a new session."""
    employee = Employee.objects.filter(pk=claims.get("employeeId")).first()
    if employee is None:
        return None, "Employee not found"
    if is_employee_session(claims):
        if check(claims):
            return None, "Session revoked"
        return _sign(employee, claims["jti"]), None
    return issue_token(request, employee), None


def revoke(claims: dict, reason: str) -> bool:
    """End the session of this token. True when a row was closed."""
    if not is_employee_session(claims):
        return False
    return bool(
        EmployeeLoginSession.objects.filter(jti=claims["jti"], revoked_at__isnull=True).update(
            revoked_at=timezone.now(), revoked_reason=reason
        )
    )


def end_all(employee: Employee, reason: str) -> int:
    """End every open session of an employee (HR action, account deactivated ...). Returns how many."""
    return EmployeeLoginSession.objects.filter(employee=employee, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_reason=reason
    )


# ── The Employee Web App's "remember this browser" cookie (owner 2026-11-25) ─────────────────────────────────────────
#
# A browser keeps the sign-in token in localStorage, and browsers lose that more often than people think: Safari wipes
# script storage of a site not opened for 7 days, links opened inside WhatsApp / Instagram get a throw-away in-app
# browser, "cleaner" apps clear site data. Each time the employee had to sign in (and ask for an OTP) again although
# their session was still open on the server. So a browser sign-in ALSO gets the session token in a cookie that page
# scripts cannot read (HttpOnly), sent only to /api/auth/ (POST /auth/session/restore signs the browser back in from it
# when the page has no token). It is the same session: logout, HR ending sessions and an inactive account apply as
# before. Phones never get it: only a request with an Origin header from an allowed web-app origin (CORS_ALLOWED_ORIGINS)
# does, which the mobile app never sends.

WEB_COOKIE = "ukt_emp_session"
WEB_COOKIE_PATH = "/api/auth/"


def _from_web_app(request) -> bool:
    origin = request.headers.get("Origin") if request is not None else None
    if not origin:
        return False
    from django.conf import settings

    return origin in getattr(settings, "CORS_ALLOWED_ORIGINS", [])


def _cookie_flags(request) -> dict:
    # Over HTTPS: SameSite=None + Secure, so it is sent whether the web app and the API are on the same site
    # (hrms.uktextiles.in -> api.uktextiles.in) or not. Plain http (local development): Lax, which localhost needs.
    secure = bool(request is not None and request.is_secure())
    return {"secure": secure, "samesite": "None" if secure else "Lax"}


def remember_browser(response, request, token: str):
    """Puts the session token in the web app's HttpOnly cookie (browser sign-ins only). Returns `response`."""
    if token and _from_web_app(request):
        response.set_cookie(
            WEB_COOKIE,
            token,
            max_age=int(TOKEN_LIFETIME.total_seconds()),
            path=WEB_COOKIE_PATH,
            httponly=True,
            **_cookie_flags(request),
        )
    return response


def forget_browser(response, request):
    """Deletes the cookie (sign-out, or a cookie that no longer opens a session). Returns `response`."""
    if request is not None and WEB_COOKIE in request.COOKIES:
        response.delete_cookie(WEB_COOKIE, path=WEB_COOKIE_PATH, samesite=_cookie_flags(request)["samesite"])
    return response


def restore(request) -> tuple[Employee | None, str | None, str | None]:
    """(employee, fresh token, None) when the browser's cookie names an open session; else (None, None, reason)."""
    raw = request.COOKIES.get(WEB_COOKIE) if request is not None else None
    if not raw:
        return None, None, "no_session"
    try:
        claims = verify_token(raw)
    except Exception:
        return None, None, "expired"
    if not is_employee_session(claims) or check(claims):
        return None, None, "ended"
    employee = Employee.objects.filter(pk=claims.get("employeeId")).first()
    if employee is None:
        return None, None, "ended"
    return employee, _sign(employee, claims["jti"]), None
