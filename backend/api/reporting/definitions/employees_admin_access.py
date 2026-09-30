"""User-access reports: HR accounts, the role x module matrix, HR login sessions and login attempts.

All admin-only (``super_admin_only``). Never read or exported: ``HRUser.password_hash``, ``master_features``,
``LoginSession.jti`` / ``user_agent``. Accounts flagged ``is_hidden`` are left out for everyone except the
master admin - the same rule as Account Management - and so are their sessions and login attempts."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import timedelta

from django.db.models import Count, Q
from django.db.models.functions import Lower

from api.auth import is_master_admin
from api.auth_views import HR_LOCKOUT_THRESHOLD, HR_LOCKOUT_WINDOW_MINUTES
from api.models import HrLoginAttempt, HRUser, LoginSession, Role
from api.permission_registry import MODULE_TREE, all_module_keys, resolve_permission

from ..filters import boolean, branches, date_range, number, select, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, DURATION, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import employees_admin_util as U
from .employees_admin_util import ist_date, ist_range_q

# ── shared ──────────────────────────────────────────────────────────────────


def _requester(ctx):
    """The signed-in HR user, loaded with only the columns the master-admin check needs (never the hash)."""
    if "requester" not in ctx._cache:
        hr_id = (getattr(ctx.request, "jwt_user", None) or {}).get("hrUserId")
        user = None
        if hr_id:
            user = HRUser.objects.only("id", "username", "is_active", "is_super_admin").filter(id=hr_id).first()
        ctx._cache["requester"] = user
    return ctx._cache["requester"]


def _sees_hidden(ctx) -> bool:
    return is_master_admin(_requester(ctx))


def _visible_users(ctx):
    qs = HRUser.objects.all()
    return qs if _sees_hidden(ctx) else qs.filter(is_hidden=False)


def _role_name(user) -> str:
    if user.role_id:
        return user.role.name
    return "Super Admin" if user.is_super_admin else "No role (no access)"


def _scope_text(user) -> str:
    if user.is_super_admin:
        return "Super Admin"
    return "Company-wide" if user.branch_id is None else "Branch-limited"


# ── HR Users & Access ───────────────────────────────────────────────────────

_USER_STATES = (("active", "Active"), ("inactive", "Inactive"), ("all", "All"))


def _run_hr_users(ctx):
    state = ctx.param("state", "active")
    dormant_days = ctx.param("dormantDays", 30)
    dormant_only = ctx.param("dormantOnly", False)
    role_text = ctx.param("role")
    now = U.utc_now()
    live_since = now - timedelta(hours=U.HR_TOKEN_HOURS)

    qs = _visible_users(ctx).filter(ctx.emp_q())
    if state == "active":
        qs = qs.filter(is_active=True)
    elif state == "inactive":
        qs = qs.filter(is_active=False)
    if role_text:
        qs = qs.filter(role__name__icontains=role_text)
    users = (
        qs.select_related("role", "department", "branch")
        .defer("password_hash", "master_features")
        .annotate(
            live=Count(
                "login_sessions",
                # a disabled account's token is rejected by the middleware, so it has no live session
                filter=Q(
                    login_sessions__revoked_at__isnull=True, login_sessions__created_at__gt=live_since, is_active=True
                ),
            )
        )
        .order_by("username")
    )

    rows = []
    active = supers = company_wide = dormant = 0
    for u in users:
        days = (now - u.last_login).days if u.last_login else None
        is_dormant = u.is_active and (days is None or days >= dormant_days)
        if dormant_only and not is_dormant:
            continue
        flags = []
        if not u.is_super_admin and not u.role_id:
            flags.append("No role (no access)")
        if not u.is_super_admin and u.role_id and u.branch_id is None:
            flags.append("Company-wide access")
            company_wide += 1
        if u.is_active and u.last_login is None:
            flags.append("Never logged in")
        elif is_dormant:
            flags.append(f"Dormant ({dormant_days}+ days)")
        if u.is_hidden:
            flags.append("Hidden account")
        active += 1 if u.is_active else 0
        supers += 1 if u.is_super_admin else 0
        dormant += 1 if is_dormant else 0
        rows.append(
            {
                "username": u.username,
                "fullName": u.full_name or None,
                "email": u.email or None,
                "role": _role_name(u),
                "accessScope": _scope_text(u),
                "branch": u.branch.name if u.branch_id else None,
                "department": u.department.name if u.department_id else None,
                "isActive": "Active" if u.is_active else "Disabled",
                "lastLogin": fmt_dt(u.last_login),
                "daysSinceLogin": days,
                "liveSessions": u.live,
                "createdAt": ist_date(u.created_at),
                "flags": "; ".join(flags) or None,
            }
        )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Accounts", "value": len(rows), "format": "integer"},
            {"label": "Active", "value": active, "format": "integer"},
            {"label": "Disabled", "value": len(rows) - active, "format": "integer"},
            {"label": "Super admins", "value": supers, "format": "integer"},
            {"label": "Company-wide (non-admin)", "value": company_wide, "format": "integer"},
            {"label": "Dormant / never logged in", "value": dormant, "format": "integer"},
        ],
        notes=[
            "Passwords and account secrets are never included. Access scope: Super Admin = sees everything; "
            "Company-wide = a role with no branch (sees every branch); Branch-limited = restricted to one branch.",
            f"Dormant = an active account whose last login is {dormant_days} or more days ago (or that never logged "
            f"in). Live sessions = signed in within the last {U.HR_TOKEN_HOURS} hours and not signed out; a disabled "
            "account has none (its sign-ins are rejected).",
        ],
    )


register(
    ReportSpec(
        id="hr-users",
        title="HR Users & Access",
        description="HR portal accounts with role, branch scope, status, last login and dormant flags.",
        category="admin",
        icon="ShieldCheck",
        tags=("users", "accounts", "access", "dormant", "last login"),
        family="hr-access",
        variant="HR users",
        super_admin_only=True,
        filters=(
            select("state", "Account status", _USER_STATES, default="active"),
            branches(),
            text("role", "Role", "Role name contains"),
            number("dormantDays", "Dormant after (days)", default=30, min=1, max=3650),
            boolean("dormantOnly", "Only dormant / never logged in"),
        ),
        columns=(
            ColumnSpec("username", "Username", TEXT, 1.5),
            ColumnSpec("fullName", "Full Name", TEXT, 1.8),
            ColumnSpec("email", "Email", TEXT, 1.7),
            ColumnSpec("role", "Role", TEXT, 1.6),
            ColumnSpec("accessScope", "Access Scope", BADGE, 1.4),
            ColumnSpec("branch", "Branch", TEXT, 1.2),
            ColumnSpec("department", "Department", TEXT, 1.3),
            ColumnSpec("isActive", "Status", BADGE, 0.9),
            ColumnSpec("lastLogin", "Last Login (IST)", DATETIME, 1.4),
            ColumnSpec("daysSinceLogin", "Days Since Login", INTEGER, 0.9),
            ColumnSpec("liveSessions", "Live Sessions", INTEGER, 1.0, total="sum"),
            ColumnSpec("createdAt", "Created", DATE, 1.3),
            ColumnSpec("flags", "Flags", TEXT, 2.1),
        ),
        run=_run_hr_users,
    )
)


# ── Role Access Matrix ──────────────────────────────────────────────────────

_LEVEL_LABEL = {"edit": "Edit", "view": "View"}


def _level(permissions, key: str) -> str:
    """Effective level exactly as the middleware resolves it: anything that is not 'view' / 'edit' is hidden
    (this also covers the legacy dict-shaped permissions some seeded roles carry)."""
    perms = permissions if isinstance(permissions, dict) else {}
    value = resolve_permission(perms, key)
    return value if value in ("view", "edit") else "hidden"


def _run_role_matrix(ctx):
    role_text = ctx.param("role")
    hide_none = ctx.param("hideNoAccess", False)
    roles_qs = Role.objects.order_by("name", "id")
    if role_text:
        roles_qs = roles_qs.filter(name__icontains=role_text)
    roles = list(roles_qs)
    users_per_role = {
        r["role_id"]: r["n"]
        for r in _visible_users(ctx).filter(is_active=True).order_by().values("role_id").annotate(n=Count("id"))
    }

    columns = [
        ColumnSpec("module", "Module", TEXT, 3.0),
        ColumnSpec("moduleKey", "Key", TEXT, 2.2),
        ColumnSpec("group", "Group", TEXT, 1.6),
        *(ColumnSpec(f"role_{r.id}", r.name, BADGE, 1.0) for r in roles),
    ]
    rows = []
    for node in MODULE_TREE:
        for item, parent in [(node, None), *((c, node) for c in node.get("children", []))]:
            levels = {f"role_{r.id}": _level(r.permissions, item["key"]) for r in roles}
            if hide_none and all(v == "hidden" for v in levels.values()):
                continue
            row = {
                "module": item["label"] if parent is None else f"{parent['label']} > {item['label']}",
                "moduleKey": item["key"],
                "group": (parent or node)["label"],
            }
            row.update({k: _LEVEL_LABEL.get(v, "Hidden") for k, v in levels.items()})
            rows.append(row)

    known = set(all_module_keys())
    unknown: list[str] = []
    invalid: list[str] = []
    for r in roles:
        perms = r.permissions if isinstance(r.permissions, dict) else {}
        bad = sorted(k for k in perms if k not in known)
        if bad:
            unknown.append(f"{r.name}: {', '.join(bad)}")
        wrong = sorted(k for k, v in perms.items() if k in known and v not in ("hidden", "view", "edit"))
        if wrong:
            invalid.append(f"{r.name}: {', '.join(wrong)}")
    notes = [
        "Each cell is the role's effective access to that module: a submodule inherits its parent's level unless "
        "it has its own setting, and a module with no setting is Hidden.",
        "Super admin accounts bypass roles entirely and are not shown. Activity Logs, Roles and HR Users are "
        "admin-only whatever a role grants.",
        "Active users per role: "
        + (", ".join(f"{r.name} {users_per_role.get(r.id, 0)}" for r in roles) or "no roles defined")
        + ".",
    ]
    if unknown:
        notes.append(
            "Settings for keys that are not modules (ignored by the application): " + "; ".join(unknown[:8]) + "."
        )
    if invalid:
        notes.append(
            "Settings whose value is not hidden / view / edit (the application treats them as Hidden): "
            + "; ".join(invalid[:8])
            + "."
        )
    return ReportResult(
        rows=rows,
        columns=columns,
        summary=[
            {"label": "Roles", "value": len(roles), "format": "integer"},
            {"label": "Modules", "value": len(rows), "format": "integer"},
            {
                "label": "Active users with a role",
                "value": sum(users_per_role.get(r.id, 0) for r in roles),
                "format": "integer",
            },
        ],
        notes=notes,
    )


register(
    ReportSpec(
        id="role-access-matrix",
        title="Role Access Matrix",
        description="Effective hidden / view / edit access of every role for every module and submodule.",
        category="admin",
        icon="KeyRound",
        tags=("roles", "permissions", "rbac", "access matrix"),
        family="hr-access",
        variant="Role matrix",
        super_admin_only=True,
        filters=(
            text("role", "Role", "Role name contains"),
            boolean("hideNoAccess", "Hide modules no listed role can open"),
        ),
        columns=(),
        run=_run_role_matrix,
    )
)


# ── HR Login Sessions ───────────────────────────────────────────────────────

_SESSION_STATES = (
    ("all", "All"),
    ("live", "Live"),
    ("revoked", "Signed out / revoked"),
    ("expired", "Expired"),
    ("disabled", "Account disabled"),
)


def _run_sessions(ctx):
    state = ctx.param("state", "all")
    uname = ctx.param("username")
    now = U.utc_now()
    live_since = now - timedelta(hours=U.HR_TOKEN_HOURS)

    q = ctx.emp_q("hr_user__") & ist_range_q("created_at", ctx.date_from, ctx.date_to)
    if not _sees_hidden(ctx):
        q &= Q(hr_user__is_hidden=False)
    if uname:
        q &= Q(hr_user__username__icontains=uname)
    # The middleware rejects every request of a disabled HR account, so its still-unexpired token is dead: such a
    # session is "Account disabled", never "Live" (re-enabling the account would make the token usable again).
    unexpired = Q(revoked_at__isnull=True, created_at__gt=live_since)
    is_live = unexpired & Q(hr_user__is_active=True)
    is_disabled = unexpired & Q(hr_user__is_active=False)
    is_revoked = Q(revoked_at__isnull=False)
    summary_base = LoginSession.objects.filter(q)
    if state == "live":
        q &= is_live
    elif state == "revoked":
        q &= is_revoked
    elif state == "expired":
        q &= Q(revoked_at__isnull=True, created_at__lte=live_since)
    elif state == "disabled":
        q &= is_disabled
    sessions = (
        LoginSession.objects.filter(q)
        .select_related("hr_user", "hr_user__role")
        .defer("jti", "user_agent", "hr_user__password_hash", "hr_user__master_features")
        .order_by("-created_at", "-id")[: ctx.row_limit]
    )
    rows = []
    for s in sessions:
        if s.revoked_at is not None:
            st = "Revoked"
        elif s.created_at <= live_since:
            st = "Expired"
        elif not s.hr_user.is_active:
            st = "Account disabled"
        else:
            st = "Live"
        rows.append(
            {
                "username": s.hr_user.username,
                "fullName": s.hr_user.full_name or None,
                "role": _role_name(s.hr_user),
                "deviceLabel": s.device_label or None,
                "ipAddress": s.ip_address or None,
                "signedInAt": fmt_dt(s.created_at),
                "lastSeenAt": fmt_dt(s.last_seen_at),
                "signedOutAt": fmt_dt(s.revoked_at),
                "state": st,
                "duration": max(0, int((s.last_seen_at - s.created_at).total_seconds() // 60)),
            }
        )
    agg = summary_base.order_by().aggregate(
        total=Count("id"),
        users=Count("hr_user_id", distinct=True),
        live=Count("id", filter=is_live),
        revoked=Count("id", filter=is_revoked),
    )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Sessions", "value": agg["total"], "format": "integer"},
            {"label": "Distinct users", "value": agg["users"], "format": "integer"},
            {"label": "Live now", "value": agg["live"], "format": "integer"},
            {"label": "Revoked / signed out", "value": agg["revoked"], "format": "integer"},
        ],
        notes=[
            f"A session has no expiry of its own: it is Live while not signed out, started less than "
            f"{U.HR_TOKEN_HOURS} hours ago and its account is enabled; otherwise Expired (or Revoked when signed out / "
            "revoked). A session of a disabled account is shown as 'Account disabled' because that account's sign-in "
            "is rejected on every request. Summary cards ignore the State filter.",
            "Duration = first sign-in to last request seen; last-seen is recorded at most once a minute, so it is approximate.",
            "Device names and IP addresses are shown as on the Login Devices page; session tokens are never included.",
        ],
    )


register(
    ReportSpec(
        id="login-sessions",
        title="HR Login Sessions",
        description="Every HR portal sign-in with device, IP, duration and live / revoked / expired state.",
        category="admin",
        icon="LogIn",
        tags=("sessions", "login devices", "sign in", "security"),
        family="login-security",
        variant="Sessions",
        super_admin_only=True,
        filters=(
            date_range("last7", label="Signed in between", max_days=92),
            select("state", "State", _SESSION_STATES, default="all"),
            text("username", "Username", "Contains"),
            branches("User's branch"),
        ),
        columns=(
            ColumnSpec("username", "Username", TEXT, 1.5),
            ColumnSpec("fullName", "Name", TEXT, 1.8),
            ColumnSpec("role", "Role", TEXT, 1.4),
            ColumnSpec("deviceLabel", "Device", TEXT, 1.6),
            ColumnSpec("ipAddress", "IP Address", TEXT, 1.2),
            ColumnSpec("signedInAt", "Signed In (IST)", DATETIME, 1.4),
            ColumnSpec("lastSeenAt", "Last Seen (IST)", DATETIME, 1.4),
            ColumnSpec("signedOutAt", "Signed Out (IST)", DATETIME, 1.4),
            ColumnSpec("state", "State", BADGE, 0.9),
            ColumnSpec("duration", "Duration", DURATION, 0.9),
        ),
        run=_run_sessions,
    )
)


# ── HR Login Attempts & Lockouts ────────────────────────────────────────────

_OUTCOMES = (("all", "All"), ("failed", "Failed"), ("success", "Successful"))


def _lockout_marks(visible, shown, window: timedelta) -> set[int]:
    """Ids of the ``shown`` attempts that completed a lock-out run (the app's rule: ``HR_LOCKOUT_THRESHOLD``
    failures in a row - a success resets the run - inside ``HR_LOCKOUT_WINDOW_MINUTES``).

    Whether a row triggered a lock-out depends on the attempts just BEFORE it, whatever the Outcome / IP filters
    say, so the walk reads every attempt of the listed usernames (from one window before the oldest listed row) -
    not just the listed rows and not a fixed number of the newest rows of the whole table."""
    if not shown:
        return set()
    who = {a.who for a in shown}
    oldest = min(a.created_at for a in shown)
    newest = max(a.created_at for a in shown)
    history = visible.filter(who__in=who, created_at__gte=oldest - window, created_at__lte=newest).order_by(
        "created_at", "id"
    )
    by_user: dict[str, list] = defaultdict(list)
    for a in history:
        by_user[a.who].append(a)
    locked: set[int] = set()
    for attempts in by_user.values():
        recent: deque = deque(maxlen=HR_LOCKOUT_THRESHOLD)
        for a in attempts:
            recent.append(a)
            if (
                len(recent) == HR_LOCKOUT_THRESHOLD
                and all(not r.success for r in recent)
                and a.created_at - recent[0].created_at <= window
            ):
                locked.add(a.id)
    return locked & {a.id for a in shown}  # history rows that are not listed are not this report's rows


def _run_attempts(ctx):
    outcome = ctx.param("outcome", "all")
    uname = ctx.param("username")
    ip = ctx.param("ip")
    window = timedelta(minutes=HR_LOCKOUT_WINDOW_MINUTES)

    # ``who`` = the username as the lock-out rule reads it (case-insensitive; the login view already strips it).
    visible = HrLoginAttempt.objects.annotate(who=Lower("username"))
    if not _sees_hidden(ctx):
        hidden = {n.strip().lower() for n in HRUser.objects.filter(is_hidden=True).values_list("username", flat=True)}
        if hidden:
            visible = visible.exclude(who__in=hidden)
    if uname:
        visible = visible.filter(username__icontains=uname)

    # Every filter is applied IN THE DATABASE, before the newest-first cut, so a flood of other attempts (a
    # credential-stuffing run) can never push the rows the manager asked for out of the list or the cards.
    listed = visible.filter(ist_range_q("created_at", ctx.date_from, ctx.date_to))
    if ip:
        listed = listed.filter(ip_address__icontains=ip)
    if outcome == "failed":
        listed = listed.filter(success=False)
    elif outcome == "success":
        listed = listed.filter(success=True)

    shown = list(listed.order_by("-created_at", "-id")[: ctx.row_limit])
    locked = _lockout_marks(visible, shown, window)
    failing = Q(success=False)
    agg = listed.order_by().aggregate(
        total=Count("id"),
        failures=Count("id", filter=failing),
        failing_users=Count("who", distinct=True, filter=failing),
        failing_ips=Count(
            "ip_address", distinct=True, filter=failing & Q(ip_address__isnull=False) & ~Q(ip_address="")
        ),
    )

    rows = [
        {
            "attemptedAt": fmt_dt(a.created_at),
            "username": a.username,
            "success": "Success" if a.success else "Failed",
            "ipAddress": a.ip_address or None,
            "lockedOut": "Lockout triggered" if a.id in locked else None,
        }
        for a in shown
    ]
    notes = [
        f"Lock-out rule: {HR_LOCKOUT_THRESHOLD} failed attempts in a row within {HR_LOCKOUT_WINDOW_MINUTES} minutes "
        "lock that username (case-insensitive); the row that completes the run is marked 'Lockout triggered'.",
        "Usernames are exactly what was typed and may not belong to any account (or may be a mistyped password). "
        "Attempts made while an account is locked are not stored here - see the Audit Log (action 'Login blocked').",
    ]
    if agg["total"] > len(shown):
        notes.append(
            "More attempts match than can be listed (newest first): the Lockouts figure counts the listed rows only "
            "- narrow the date range to see the rest."
        )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Attempts", "value": agg["total"], "format": "integer"},
            {"label": "Failures", "value": agg["failures"], "format": "integer"},
            {"label": "Failing usernames", "value": agg["failing_users"], "format": "integer"},
            {"label": "Failing IP addresses", "value": agg["failing_ips"], "format": "integer"},
            {"label": "Lockouts", "value": len(locked), "format": "integer"},
        ],
        notes=notes,
    )


register(
    ReportSpec(
        id="login-attempts",
        title="HR Login Attempts & Lockouts",
        description="Successful and failed HR portal login attempts with lockout detection.",
        category="admin",
        icon="TriangleAlert",
        tags=("login attempts", "failed login", "lockout", "brute force", "security"),
        family="login-security",
        variant="Attempts",
        super_admin_only=True,
        filters=(
            date_range("last7", label="Attempted between", max_days=31),
            select("outcome", "Outcome", _OUTCOMES, default="all"),
            text("username", "Username", "Contains"),
            text("ip", "IP address", "Contains"),
        ),
        columns=(
            ColumnSpec("attemptedAt", "Attempted (IST)", DATETIME, 1.5),
            ColumnSpec("username", "Username Typed", TEXT, 2.0),
            ColumnSpec("success", "Outcome", BADGE, 0.9),
            ColumnSpec("ipAddress", "IP Address", TEXT, 1.4),
            ColumnSpec("lockedOut", "Lockout", BADGE, 1.4),
        ),
        run=_run_attempts,
    )
)
