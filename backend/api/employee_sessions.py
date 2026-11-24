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
from .jwt_utils import sign_token
from .models import Employee, EmployeeLoginSession
from .serializers import employee_full_name
from .session_utils import parse_user_agent

SESSION_KIND = "employee_session"
# Long on purpose: the app renews it whenever it is online, so this only matters for a phone that never comes online.
TOKEN_LIFETIME = timedelta(days=180)
# last_seen_at is written at most this often per session (a write on every request would be wasteful).
TOUCH_EVERY_SECONDS = 300


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
