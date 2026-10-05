"""MD portal: Activity Logs. "What are people doing in the system, and is anything sensitive or unusual happening?"

The data (all read directly, never through a ``compute_*`` helper):

* ``AuditLog``        what people DID: creates, changes, deletes, uploads, exports, backups. Reading a screen is not
                      logged. ``user_id`` is NULL for HR users, so people are grouped by ``user_name`` (the display name:
                      full name, else username, exactly as ``auth_views.hr_login`` writes it).
* ``LoginSession``    one row per successful HR-portal sign-in (device label, IP, revoked/last seen).
* ``HrLoginAttempt``  one row per sign-in attempt, successful or not (per typed username).
* ``HRUser`` / ``Role``  who exists and what access they hold (never ``password_hash`` or ``master_features``).

Decisions that make the numbers mean something to an MD (each one is repeated in the provenance the screen shows):

* **Sign-in events are not "actions".** ``login`` / ``logout`` / ``login_failed`` / ``login_blocked`` entries are
  excluded from the action figures and reported under Sign-ins; failed and blocked attempts are logged under the user
  "system", so counting them as actions would also invent a phantom user.
* **A bulk upload is one action, not 250.** ``employee_bulk_views`` writes one audit row per employee, all inside the
  same minute. Counting rows would make the day HR uploads a sheet look like an attack and would bury everything else in
  the feed, so rows of a "burst" rule (see ``Rule.burst``) are counted once per person and minute.
* **Sensitive = a rule table, not a guess.** ``RULES`` maps what the application really writes (action + module +
  wording of ``record_description``) to a category and a severity. The same table drives the database query (a CASE
  expression) and the Python ``classify`` used by the tests, and a parity test keeps the two identical.
* **Factory time.** Days and hours are Asia/Kolkata (``FACTORY_TZ``), never UTC: an entry at 23:30 UTC belongs to the
  next morning in Tirupur. Normal working hours are 7 am to 9 pm Monday to Saturday; Sunday is the weekly off.
* **Honesty about coverage.** Several things are NOT written to the audit trail today (salary-record edits, advances,
  increments, promotions, payroll approval, leave and missing-punch approvals; a single-employee edit does not say what
  changed). The provenance says so, so the MD never reads their absence as "nothing happened".
* **Privacy.** ``old_values`` / ``new_values`` (which can hold salaries) are never selected. Assistant tools return the
  actor and a generic description of what happened, never the free text of an entry (it can contain employee names).

Scope (unit / department / staff-production) does not apply: an audit entry belongs to an HR user, not an employee, so
every function takes only a ``Period``.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from functools import reduce
from operator import or_
from typing import Any, Callable, Iterable, NamedTuple

from django.db.models import Case, CharField, Count, DateTimeField, Max, Min, Q, Value, When
from django.db.models.functions import ExtractHour, Lower, TruncDate, TruncMinute
from django.utils import timezone

from ...auth_views import HR_LOCKOUT_THRESHOLD, HR_LOCKOUT_WINDOW_MINUTES
from ...clock import FACTORY_TZ, ist_today
from ...models import AuditLog, HRUser, HrLoginAttempt, LoginSession
from ...permission_registry import resolve_permission
from ...reporting.definitions.employees_admin_util import HR_TOKEN_HOURS
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, cached, change, envelope, pct, prov

# ─── constants ────────────────────────────────────────────────────────────────────────────────────────────────

#: Audit entries that are sign-in events. They are reported under Sign-ins and never counted as actions.
SIGN_IN_ACTIONS = ("login", "logout", "login_failed", "login_blocked")
#: The "user" the audit trail records for a request nobody was signed in for (a failed sign-in, for example).
SYSTEM_USER = "system"

#: Normal working hours of the people who use the HR portal: 07:00 up to (not including) 21:00, Monday to Saturday.
WORK_START_HOUR = 7
WORK_END_HOUR = 21
#: The weekly off (ISO weekday: Monday is 1). Everything done on it counts as "weekend" activity.
WEEKLY_OFF_ISO_WEEKDAY = 7
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

#: An enabled account that has not signed in for this many days is "dormant".
DORMANT_DAYS = 30
#: Periods longer than this are drawn week by week (Monday to Sunday) instead of day by day.
WEEKLY_ROLLUP_AFTER_DAYS = 62
RANKED_LIMIT_DEFAULT = 10
RANKED_LIMIT_MAX = 25
PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 100
#: A long audit description (a report export lists its filters) is cut here for display.
TEXT_LIMIT = 220
#: Of the usernames that are not accounts, how many the failed-attempts list shows (the most-tried).
FAILED_NAMES_SHOWN = 50
UNKNOWN_DEVICE = "Unknown device"

#: An account that can EDIT any of these modules can change pay, access or settings: it is "privileged".
PRIVILEGED_MODULES = ("payroll", "production_payroll", "salary", "settlement", "user_management", "settings")

#: What the audit trail does not record today (checked against every ``log_action`` caller). Repeated in provenance.
NOT_RECORDED = (
    "The audit trail records changes, deletions, uploads, exports and backups made in the HR portal. It does not record "
    "looking at screens, and it does not record salary-record edits, advances, increments, promotions, payroll "
    "approvals, leave or missing-punch approvals; a single-employee edit is recorded without saying what changed. "
    "Their absence here does not mean they did not happen."
)

# ─── the sensitivity rule table ───────────────────────────────────────────────────────────────────────────────

CATEGORIES: dict[str, str] = {
    "access": "Accounts & access",
    "deletion": "Deletions",
    "payroll": "Payroll & pay",
    "bulk": "Bulk changes",
    "export": "Exports & downloads",
    "settings": "Settings & workflow",
    "backup": "Backup & restore",
}
#: Most severe first. ``critical`` is rare on purpose: it changes who runs the company's data or destroys it wholesale.
SEVERITIES = ("critical", "high", "medium")
SEVERITY_LABELS = {"critical": "Critical", "high": "High", "medium": "Medium"}


@dataclass(frozen=True)
class Rule:
    """One line of the sensitivity table: an audit entry matches when ALL the stated conditions hold. A condition left
    empty is not tested. ``starts`` / ``has`` / ``has_any`` compare the entry's description ignoring case.

    ``burst`` marks entries a single request writes once per employee (bulk upload): they are counted once per person
    and minute, so one upload is one action however many employees it touched."""

    id: str
    category: str
    severity: str
    title: str
    actions: tuple[str, ...] = ()
    modules: tuple[str, ...] = ()
    starts: tuple[str, ...] = ()  # the description starts with ANY of these
    has: tuple[str, ...] = ()  # the description contains ALL of these
    has_any: tuple[str, ...] = ()  # the description contains AT LEAST ONE of these
    burst: bool = False

    def matches(self, action: str | None, module: str | None, description: str | None) -> bool:
        text = (description or "").lower()
        if self.actions and action not in self.actions:
            return False
        if self.modules and module not in self.modules:
            return False
        if self.starts and not any(text.startswith(s.lower()) for s in self.starts):
            return False
        if any(s.lower() not in text for s in self.has):
            return False
        return not self.has_any or any(s.lower() in text for s in self.has_any)

    def q(self) -> Q:
        """The same test as ``matches``, for the database. ``i``-lookups are the case-insensitive ones."""
        q = Q()
        if self.actions:
            q &= Q(action__in=self.actions)
        if self.modules:
            q &= Q(module__in=self.modules)
        if self.starts:
            q &= reduce(or_, (Q(record_description__istartswith=s) for s in self.starts))
        for s in self.has:
            q &= Q(record_description__icontains=s)
        if self.has_any:
            q &= reduce(or_, (Q(record_description__icontains=s) for s in self.has_any))
        return q


_NOT_IN_FILE = "not in the bulk-update file"
_PAY_MODULES = ("salary", "salary_slip", "increment", "promotion", "settlement")
_PAYROLL_MODULES = ("payroll", "production_payroll")

#: In priority order: the FIRST rule an entry matches decides its category and severity. The vocabulary is what
#: ``log_action`` / ``build_log_entry`` really write today (grep them), plus the pay modules the application may start
#: auditing (salary, increment, promotion, settlement) so they are flagged the day they appear.
# fmt: off
RULES: tuple[Rule, ...] = (
    # accounts and access: who may do what
    Rule("md-assigned", "access", "critical", "Managing Director access assigned",
         actions=("update",), modules=("user_management",), starts=("Assigned MD",)),
    Rule("md-removed", "access", "critical", "Managing Director access removed",
         actions=("update",), modules=("user_management",), starts=("Removed MD access",)),
    Rule("account-deleted", "access", "high", "Account or role deleted",
         actions=("delete",), modules=("user_management",)),
    Rule("account-master", "access", "high", "Account hidden or given a special feature",
         modules=("user_management",), starts=("Master:",)),
    Rule("role-changed", "access", "high", "Role or permissions changed",
         modules=("user_management",), starts=("Created role", "Updated role")),
    Rule("account-created", "access", "high", "Account created",
         modules=("user_management",), starts=("Created HR user",)),
    Rule("account-changed", "access", "high", "Account changed (role, unit, status or password)",
         modules=("user_management",), starts=("Updated HR user",)),
    Rule("app-password", "access", "medium", "Employee app password set, reset or cleared",
         modules=("mobile_app_login",), has=("mobile app password",)),
    # backup and restore: the whole database leaving or being replaced
    Rule("restore-started", "backup", "critical", "Database restore started", actions=("restore",)),
    Rule("restore-uploaded", "backup", "high", "Restore file uploaded",
         actions=("upload",), modules=("settings",), starts=("Restore backup",)),
    Rule("backup-config", "backup", "high", "Backup schedule or off-site copy changed",
         modules=("settings",), starts=("Backup schedule", "Backup Google Drive")),
    Rule("backup-created", "backup", "medium", "Full backup created", actions=("backup",)),
    # settings and workflow: how the system behaves
    Rule("workflow-changed", "settings", "high", "Approval workflow changed or reset", modules=("approval_workflow",)),
    Rule("settings-universal", "settings", "high", "Company-wide settings changed",
         modules=("settings",), starts=("Universal settings",)),
    Rule("settings-personal", "settings", "medium", "Personal settings overrides changed",
         modules=("settings",), starts=("Personal settings",)),
    Rule("app-version", "settings", "medium", "Mobile app version published or changed",
         actions=("create", "update"), modules=("mobile_app_version",)),
    # payroll and pay: what people are paid
    Rule("pay-record-changed", "payroll", "high", "Salary, increment, promotion or settlement record changed",
         actions=("create", "update", "approve", "lock", "reject", "delete"), modules=_PAY_MODULES),
    Rule("payroll-finalised", "payroll", "high", "Payroll approved or locked",
         actions=("approve", "lock"), modules=_PAYROLL_MODULES),
    Rule("payroll-generated", "payroll", "high", "Payroll generated or changed", modules=_PAYROLL_MODULES),
    Rule("bonus-generated", "payroll", "medium", "Bonus register generated", actions=("create",), modules=("bonus",)),
    Rule("overtime-decided", "payroll", "medium", "Overtime announced or rejected",
         actions=("announce", "reject"), modules=("compensation",)),
    Rule("bulk-pay-change", "payroll", "high", "Salary or bank details changed by bulk upload",
         modules=("employees",), starts=("Bulk-updated employee",),
         has_any=("salary", "bank", "pf number", "esi number"), burst=True),
    # deletions: data that no longer exists
    Rule("bulk-delete", "deletion", "critical", "Employees deleted by a bulk upload",
         modules=("employees",), starts=("Deleted employee",), has=(_NOT_IN_FILE,), burst=True),
    Rule("employee-deleted", "deletion", "high", "Employee deleted", actions=("delete",), modules=("employees",)),
    Rule("record-deleted", "deletion", "medium", "Record deleted", actions=("delete",)),
    # bulk changes: many records at once
    Rule("bulk-inactive", "bulk", "high", "Employees made inactive by a bulk upload",
         modules=("employees",), has=(_NOT_IN_FILE,), burst=True),
    Rule("bulk-import", "bulk", "medium", "Employees added by bulk upload",
         modules=("employees",), starts=("Bulk-imported employee",), burst=True),
    Rule("bulk-update", "bulk", "medium", "Employee records changed by bulk upload",
         modules=("employees",), starts=("Bulk-updated employee",), burst=True),
    Rule("bulk-tracking", "bulk", "medium", "Live-location tracking switched for many employees",
         modules=("employees",), starts=("Bulk enabled", "Bulk disabled")),
    Rule("punch-import", "bulk", "medium", "Punch records imported from a file",
         modules=("attendance",), starts=("Punch View import",)),
    # exports: data leaving the system
    Rule("report-export", "export", "medium", "Report exported", actions=("export",), modules=("reports",)),
    Rule("data-export", "export", "medium", "Data exported", actions=("export",)),
)
# fmt: on

RULES_BY_ID: dict[str, Rule] = {r.id: r for r in RULES}
BURST_RULE_IDS: tuple[str, ...] = tuple(r.id for r in RULES if r.burst)


def _validate_rules() -> None:
    """A mistake in the table is a start-up error, not a silently wrong dashboard."""
    if len(RULES_BY_ID) != len(RULES):
        raise ValueError("duplicate rule id in the activity rule table")
    for r in RULES:
        if r.category not in CATEGORIES or r.severity not in SEVERITIES:
            raise ValueError(f"rule {r.id}: unknown category or severity")
        if not (r.actions or r.modules or r.starts or r.has or r.has_any):
            raise ValueError(f"rule {r.id} has no condition, so it would match every entry")
        if r.burst and r.modules != ("employees",):
            raise ValueError(f"rule {r.id}: only employee bulk uploads are bursts")


_validate_rules()


def classify(action: str | None, module: str | None, description: str | None) -> Rule | None:
    """The rule an audit entry falls under, or None for routine activity. First match in ``RULES`` wins."""
    for rule in RULES:
        if rule.matches(action, module, description):
            return rule
    return None


def _rule_case() -> Case:
    """``classify`` as a CASE expression: the rule id for every row (empty for routine ones), computed by the database."""
    return Case(*[When(r.q(), then=Value(r.id)) for r in RULES], default=Value(""), output_field=CharField())


def rule_table() -> list[dict]:
    """The rule table as the screen documents it: what counts as sensitive, grouped the way the MD filters it."""
    order = list(CATEGORIES)
    return [
        {
            "id": r.id,
            "category": r.category,
            "categoryLabel": CATEGORIES[r.category],
            "severity": r.severity,
            "title": r.title,
        }
        for r in sorted(RULES, key=lambda r: (order.index(r.category), SEVERITIES.index(r.severity)))
    ]


# ─── areas (what part of the system an entry belongs to) ─────────────────────────────────────────────────────

#: The audit trail's ``module`` -> the area the MD reads. A module not listed here keeps its own (humanised) name, so
#: a new kind of entry is never dropped from the totals.
AREAS: dict[str, tuple[str, str]] = {
    "auth": (
        "auth",
        "Sign-in",
    ),  # sign-in entries are left out of the action figures; listed so the mapping is complete
    "employees": ("employees", "Employees"),
    "attendance": ("attendance", "Attendance"),
    "shifts": ("attendance", "Attendance"),
    "missing_punch": ("attendance", "Attendance"),
    "geo_attendance": ("attendance", "Attendance"),
    "payroll": ("payroll", "Payroll & pay"),
    "production_payroll": ("payroll", "Payroll & pay"),
    "salary": ("payroll", "Payroll & pay"),
    "salary_slip": ("payroll", "Payroll & pay"),
    "settlement": ("payroll", "Payroll & pay"),
    "increment": ("payroll", "Payroll & pay"),
    "promotion": ("payroll", "Payroll & pay"),
    "bonus": ("payroll", "Payroll & pay"),
    "compensation": ("compensation", "Overtime & compensation"),
    "leave": ("leave", "Leave & requests"),
    "casual_leave": ("leave", "Leave & requests"),
    "requests": ("leave", "Leave & requests"),
    "recruitment": ("recruitment", "Recruitment"),
    "user_management": ("access", "Accounts & access"),
    "approval_workflow": ("workflow", "Approval workflow"),
    "settings": ("settings", "Settings"),
    "reports": ("reports", "Reports & exports"),
    "mobile_app_login": ("mobile", "Mobile app"),
    "mobile_app_version": ("mobile", "Mobile app"),
}


def area_of(module: str | None) -> tuple[str, str]:
    """(key, label) of the area an audit ``module`` belongs to."""
    name = (module or "").strip()
    if name in AREAS:
        return AREAS[name]
    return f"other:{name}", name.replace("_", " ").capitalize() or "Other"


def area_mapping() -> list[dict]:
    """The mapping table as documentation: each area with the audit modules that feed it."""
    grouped: dict[str, dict] = {}
    for module, (key, label) in AREAS.items():
        grouped.setdefault(key, {"area": key, "label": label, "modules": []})["modules"].append(module)
    return list(grouped.values())


# ─── small helpers (factory time, always) ────────────────────────────────────────────────────────────────────


def _day_start(day: date) -> datetime:
    """Midnight at the factory on ``day`` as an aware datetime (the database stores UTC)."""
    return datetime.combine(day, time.min, tzinfo=FACTORY_TZ)


def _range(field_name: str, start: date, end: date) -> Q:
    """``field_name`` within the factory days ``start`` .. ``end``, both inclusive (never ``__date``: that is UTC)."""
    return Q(**{f"{field_name}__gte": _day_start(start), f"{field_name}__lt": _day_start(end + timedelta(days=1))})


def _local(value: datetime) -> datetime:
    """An aware timestamp as the factory's wall clock (naive)."""
    return timezone.localtime(value, FACTORY_TZ).replace(tzinfo=None)


def _iso(value: datetime | None) -> str | None:
    return _local(value).isoformat(timespec="seconds") if value else None


def _utc_now() -> datetime:
    """Aware now. A function so a test can pin the clock."""
    return timezone.now()


def _hour_text(hour: int) -> str:
    return f"{hour % 12 or 12} {'am' if hour < 12 else 'pm'}"


def working_hours() -> dict:
    return {
        "startHour": WORK_START_HOUR,
        "endHour": WORK_END_HOUR,
        "weeklyOff": WEEKDAY_NAMES[WEEKLY_OFF_ISO_WEEKDAY - 1],
        "label": f"{_hour_text(WORK_START_HOUR)} to {_hour_text(WORK_END_HOUR)}, Monday to Saturday",
    }


def _after_kind(day: date, hour: int) -> str | None:
    """ "weekend" for anything on the weekly off, "night" for a working day outside working hours, else None."""
    if day.isoweekday() == WEEKLY_OFF_ISO_WEEKDAY:
        return "weekend"
    if hour < WORK_START_HOUR or hour >= WORK_END_HOUR:
        return "night"
    return None


def _clamp(value: int | None, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    return max(low, min(high, int(value)))


def _clip(text: str | None, limit: int = TEXT_LIMIT) -> str | None:
    if not text:
        return None
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _check_category(category: str | None) -> str | None:
    if category in (None, ""):
        return None
    key = str(category).strip().lower()
    if key not in CATEGORIES:
        raise MdParamError(f"'{category}' is not a category. Choose one of: {', '.join(CATEGORIES)}.")
    return key


def _day_text(day: date) -> str:
    return f"{day.day:02d} {day.strftime('%b')}"


def _when(period: Period) -> str:
    """The period as it reads inside a sentence: 'last 7 days', but a date range keeps its capital letters."""
    return period.label if period.preset in (None, "custom", "month") else period.label.lower()


def _listed(items: list[str]) -> str:
    """'a, b, c and 2 more' for the first three of a list."""
    shown, rest = items[:3], len(items) - 3
    return ", ".join(shown) + (f" and {rest} more" if rest > 0 else "")


# ─── accounts ─────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Account:
    id: int
    username: str
    label: str  # what the audit trail calls this person: full name, else username
    role: str | None
    enabled: bool
    privileged: bool
    created_at: datetime
    last_seen: datetime | None  # latest sign-in (before the date asked for, when one was given)


def _is_privileged(user: HRUser) -> bool:
    """A super admin, the MD, or a role that can EDIT pay, accounts or settings."""
    if user.is_super_admin or user.is_md:
        return True
    perms = user.role.permissions if user.role_id and isinstance(user.role.permissions, dict) else {}
    return any(resolve_permission(perms, key) == "edit" for key in PRIVILEGED_MODULES)


def _role_name(user: HRUser) -> str | None:
    if user.role_id:
        return user.role.name
    if user.is_super_admin:
        return "Super admin"
    return "Managing Director" if user.is_md else None


def _accounts(as_of: datetime | None = None) -> list[Account]:
    """Every HR account (hidden ones too: the audit trail is complete). Reads only the columns needed, never the
    password hash or master features. With ``as_of`` the last sign-in is the latest one BEFORE that moment."""
    qs = HRUser.objects.select_related("role").only(
        "id",
        "username",
        "full_name",
        "is_active",
        "is_super_admin",
        "is_md",
        "last_login",
        "created_at",
        "role",
        "role__name",
        "role__permissions",
    )
    if as_of is not None:
        qs = qs.annotate(last_session=Max("login_sessions__created_at", filter=Q(login_sessions__created_at__lt=as_of)))
    out: list[Account] = []
    for u in qs.order_by("id"):
        seen = [t for t in (getattr(u, "last_session", None), u.last_login) if t and (as_of is None or t < as_of)]
        out.append(
            Account(
                id=u.id,
                username=u.username,
                label=u.full_name or u.username,
                role=_role_name(u),
                enabled=u.is_active,
                privileged=_is_privileged(u),
                created_at=u.created_at,
                last_seen=max(seen) if seen else None,
            )
        )
    return out


def _by_label(accounts: Iterable[Account]) -> dict[str, list[Account]]:
    out: dict[str, list[Account]] = defaultdict(list)
    for a in accounts:
        out[a.label].append(a)
    return out


def _role_of(label: str, by_label: dict[str, list[Account]]) -> str | None:
    """The role of the person behind an audit name; None when there is no such account or several share the name."""
    matches = by_label.get(label, [])
    return matches[0].role if len(matches) == 1 else None


# ─── the audit trail, grouped by the database ─────────────────────────────────────────────────────────────────


def _audit(start: date, end: date):
    """Audit entries that are ACTIONS (sign-in events excluded) on the factory days start..end."""
    return AuditLog.objects.filter(_range("created_at", start, end)).exclude(action__in=SIGN_IN_ACTIONS)


class Group(NamedTuple):
    """Audit entries that share a person, an area, a rule, a factory hour (and, for a bulk upload, the minute)."""

    user: str
    module: str
    rule: str  # rule id, "" for routine activity
    day: date
    hour: int
    rows: int  # audit rows in the group
    last: datetime  # newest entry in it (aware)


def _events(g: Group) -> int:
    """How many ACTIONS a group stands for: its rows, except a bulk-upload burst which is one."""
    rule = RULES_BY_ID.get(g.rule)
    return 1 if rule and rule.burst else g.rows


@cached()
def _groups(start: date, end: date) -> tuple[Group, ...]:
    """The whole audit trail of start..end, grouped in the database (one query, a few thousand groups at most) so every
    figure is computed from the same rows. The rule (and so burst-ness) is decided by the same table as ``classify``."""
    qs = (
        _audit(start, end)
        .annotate(rule=_rule_case())
        .annotate(
            day=TruncDate("created_at", tzinfo=FACTORY_TZ),
            hour=ExtractHour("created_at", tzinfo=FACTORY_TZ),
            batch=Case(
                When(Q(rule__in=BURST_RULE_IDS), then=TruncMinute("created_at", tzinfo=FACTORY_TZ)),
                default=None,
                output_field=DateTimeField(),
            ),
        )
        .values("user_name", "module", "rule", "day", "hour", "batch")
        .annotate(rows=Count("id"), last=Max("created_at"))
        .order_by()
    )
    return tuple(
        Group(r["user_name"] or "Unknown", r["module"], r["rule"], r["day"], r["hour"], r["rows"], r["last"])
        for r in qs
    )


@dataclass
class Tally:
    """Totals over some groups."""

    rows: int = 0
    events: int = 0
    sensitive: int = 0
    severity: Counter = field(default_factory=Counter)
    category: Counter = field(default_factory=Counter)
    after_hours: int = 0
    weekend: int = 0
    night: int = 0
    users: set = field(default_factory=set)


def _tally(groups: Iterable[Group]) -> Tally:
    t = Tally()
    for g in groups:
        rule = RULES_BY_ID.get(g.rule)
        n = _events(g)
        t.rows += g.rows
        t.events += n
        if g.user != SYSTEM_USER:
            t.users.add(g.user)
        if rule:
            t.sensitive += n
            t.severity[rule.severity] += n
            t.category[rule.category] += n
        kind = _after_kind(g.day, g.hour)
        if kind:
            t.after_hours += n
            if kind == "weekend":
                t.weekend += n
            else:
                t.night += n
    return t


def _split(groups: Iterable[Group], period: Period) -> tuple[list[Group], list[Group]]:
    """(this period's groups, the previous period's) out of a fetch that spans both."""
    now: list[Group] = []
    before: list[Group] = []
    for g in groups:
        (now if g.day >= period.start else before).append(g)
    return now, before


# ─── sign-ins, grouped by the database ────────────────────────────────────────────────────────────────────────


class SessionDay(NamedTuple):
    user_id: int
    label: str
    day: date
    n: int


class AttemptDay(NamedTuple):
    day: date
    failed: int
    ok: int


@cached()
def _sessions_by_day(start: date, end: date) -> tuple[SessionDay, ...]:
    """Successful HR-portal sign-ins (login sessions) per person per factory day."""
    rows = (
        LoginSession.objects.filter(_range("created_at", start, end))
        .annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("hr_user_id", "hr_user__full_name", "hr_user__username", "day")
        .annotate(n=Count("id"))
        .order_by()
    )
    return tuple(
        SessionDay(r["hr_user_id"], r["hr_user__full_name"] or r["hr_user__username"], r["day"], r["n"]) for r in rows
    )


@cached()
def _attempts_by_day(start: date, end: date) -> tuple[AttemptDay, ...]:
    """Sign-in attempts per factory day, split into failed and successful."""
    rows = (
        HrLoginAttempt.objects.filter(_range("created_at", start, end))
        .annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day")
        .annotate(failed=Count("id", filter=Q(success=False)), ok=Count("id", filter=Q(success=True)))
        .order_by()
    )
    return tuple(AttemptDay(r["day"], r["failed"], r["ok"]) for r in rows)


class LockOut(NamedTuple):
    username: str  # lower-cased, as the lock-out rule reads it
    at: datetime  # when the failed attempt that completed the run happened (aware)


@cached()
def _lockouts(start: date, end: date) -> tuple[LockOut, ...]:
    """Lock-outs between start and end. The app's own rule (``auth_views``): HR_LOCKOUT_THRESHOLD failed attempts in a
    row, a success resetting the run, inside HR_LOCKOUT_WINDOW_MINUTES; the attempt that completes the run locks the
    username. Only usernames with enough failures to qualify are read (one small query, then one for their attempts)."""
    window = timedelta(minutes=HR_LOCKOUT_WINDOW_MINUTES)
    low, high = _day_start(start), _day_start(end + timedelta(days=1))
    # a run can begin up to one window before the period and still complete inside it, so the failures are counted from
    # one window earlier too
    candidates = [
        r["who"]
        for r in HrLoginAttempt.objects.filter(created_at__gte=low - window, created_at__lt=high, success=False)
        .annotate(who=Lower("username"))
        .values("who")
        .annotate(n=Count("id"))
        .filter(n__gte=HR_LOCKOUT_THRESHOLD)
        .order_by()
    ]
    if not candidates:
        return ()
    attempts = (
        HrLoginAttempt.objects.annotate(who=Lower("username"))
        .filter(who__in=candidates, created_at__gte=low - window, created_at__lt=high)
        .order_by("who", "created_at", "id")
        .values_list("who", "success", "created_at")
    )
    streaks: dict[str, list[datetime]] = defaultdict(list)  # the current run of failures per username
    found: list[LockOut] = []
    for who, success, at in attempts:
        streak = streaks[who]
        if success:
            streak.clear()
            continue
        streak.append(at)
        while at - streak[0] > window:  # failures older than the window no longer count towards the run
            streak.pop(0)
        if len(streak) >= HR_LOCKOUT_THRESHOLD:
            if at >= low:  # a run that completed before the period belongs to the earlier one
                found.append(LockOut(who, at))
            streak.clear()
    return tuple(found)


# ─── the shape of a figure compared with the previous period ──────────────────────────────────────────────────


def _kpi(value: int, previous: int, **extra: Any) -> dict:
    return {"value": value, "previous": previous, "change": change(value, previous), **extra}


# ─── provenance (the same wording on the screen and in the assistant) ─────────────────────────────────────────


def _prov_actions(rows: int | None = None) -> dict:
    return prov(
        "actions",
        "Actions",
        dataset="Audit trail (the HR portal's Activity Logs)",
        definition=(
            "Things people did in the HR portal that the system records: creating, changing or deleting records, "
            "generating payroll, uploads, exports, backups and settings changes. Signing in is counted separately."
        ),
        formula="Audit-trail entries in the period; a bulk upload writes one entry per employee and counts once",
        rows=rows,
        filters=["Sign-in entries (signed in, signed out, failed, blocked) left out", "Days are factory (IST) days"],
        caveats=[NOT_RECORDED],
    )


def _prov_people(rows: int | None = None) -> dict:
    return prov(
        "active-users",
        "Active people",
        dataset="Audit trail and HR-portal sign-ins",
        definition="People who did at least one action or signed in during the period.",
        formula="distinct names among audit-trail actions and sign-ins",
        rows=rows,
        filters=["Counted by the name shown in the audit trail (full name, else username)"],
        caveats=[
            "Two accounts with the same name count as one person.",
            "Someone who only looked at screens shows up through their sign-in, not through an action.",
        ],
    )


def _prov_sensitive(rows: int | None = None) -> dict:
    by_category = "; ".join(
        f"{label} ({sum(1 for r in RULES if r.category == key)})" for key, label in CATEGORIES.items()
    )
    return prov(
        "sensitive",
        "Sensitive actions",
        dataset="Audit trail, matched against a fixed rule table",
        definition=(
            "Actions that change who has access, what people are paid, what is deleted or leaves the system, or how "
            "the system behaves: account, role and Managing Director changes, payroll runs, deletions, bulk uploads, "
            "exports, settings and workflow changes, backups and restores. Each is Critical, High or Medium."
        ),
        formula="audit entries that match a rule (see 'What counts as sensitive'); a bulk upload counts once per kind",
        rows=rows,
        filters=[f"Rules per category: {by_category}"],
        caveats=[NOT_RECORDED],
    )


def _prov_after_hours(rows: int | None = None) -> dict:
    return prov(
        "after-hours",
        "After-hours actions",
        dataset="Audit trail",
        definition=(
            f"Actions taken outside normal working hours ({working_hours()['label']}), and anything done on Sunday, "
            "the weekly off."
        ),
        formula="actions at night (Monday to Saturday) + actions on Sunday",
        rows=rows,
        filters=["Factory (IST) time"],
        caveats=[
            "Public holidays are not treated as days off.",
            "Working hours are a fixed rule, not read from shifts.",
        ],
    )


def _prov_sign_ins(rows: int | None = None) -> dict:
    return prov(
        "sign-ins",
        "Sign-ins",
        dataset="HR-portal login sessions",
        definition="Successful sign-ins to the HR portal: each creates one login session.",
        formula="login sessions created in the period",
        rows=rows,
        filters=["Factory (IST) days"],
        caveats=[
            "Employee sign-ins to the mobile app and the employee web app are not recorded one by one, so they are "
            "not included.",
            "Accounts hidden from Account Management are included: the trail is complete.",
        ],
    )


def _prov_failed(rows: int | None = None) -> dict:
    return prov(
        "failed-sign-ins",
        "Failed sign-ins",
        dataset="HR-portal sign-in attempts",
        definition=(
            "Attempts to sign in to the HR portal with a wrong password or a username that is not an account. A "
            f"lock-out is {HR_LOCKOUT_THRESHOLD} failed attempts in a row within {HR_LOCKOUT_WINDOW_MINUTES} minutes "
            f"for one username: the portal then refuses that username for {HR_LOCKOUT_WINDOW_MINUTES} minutes."
        ),
        formula="sign-in attempts that failed in the period",
        rows=rows,
        filters=["Factory (IST) days"],
        caveats=[
            "Attempts made while a username is locked are not stored as attempts; they are counted as 'blocked' from "
            "the audit trail.",
            "Usernames that are not accounts are not shown (what was typed can be a password entered in the wrong box): "
            "they appear as 'Unknown name 1', 'Unknown name 2' and so on.",
        ],
    )


# ─── summary ──────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def activity_summary(period: Period) -> dict:
    """The headline figures of the page, each against the previous period of the same length."""
    previous = period.previous()
    cur_groups, old_groups = _split(_groups(previous.start, period.end), period)
    cur, old = _tally(cur_groups), _tally(old_groups)

    days = _sessions_by_day(previous.start, period.end)
    sign_cur = [s for s in days if s.day >= period.start]
    sign_old = [s for s in days if s.day < period.start]
    sign_ins_now, sign_ins_before = sum(s.n for s in sign_cur), sum(s.n for s in sign_old)
    people_cur = (cur.users | {s.label for s in sign_cur}) - {SYSTEM_USER}
    people_old = (old.users | {s.label for s in sign_old}) - {SYSTEM_USER}

    attempts = _attempts_by_day(previous.start, period.end)
    failed_now = sum(a.failed for a in attempts if a.day >= period.start)
    failed_before = sum(a.failed for a in attempts if a.day < period.start)
    blocked = AuditLog.objects.filter(_range("created_at", period.start, period.end), action="login_blocked").count()

    return envelope(
        {
            "previousPeriod": previous.to_json(),
            "actions": _kpi(cur.events, old.events),
            "activeUsers": _kpi(
                len(people_cur), len(people_old), enabledAccounts=HRUser.objects.filter(is_active=True).count()
            ),
            "sensitive": _kpi(
                cur.sensitive,
                old.sensitive,
                critical=cur.severity["critical"],
                high=cur.severity["high"],
                medium=cur.severity["medium"],
            ),
            "afterHours": _kpi(
                cur.after_hours,
                old.after_hours,
                weekend=cur.weekend,
                night=cur.night,
                sharePct=pct(cur.after_hours, cur.events),
            ),
            "signIns": _kpi(sign_ins_now, sign_ins_before, people=len({s.label for s in sign_cur})),
            "failedSignIns": _kpi(
                failed_now, failed_before, lockouts=len(_lockouts(period.start, period.end)), blockedAttempts=blocked
            ),
            "workingHours": working_hours(),
        },
        period=period,
        provenance=[
            _prov_actions(cur.rows),
            _prov_people(),
            _prov_sensitive(cur.sensitive),
            _prov_after_hours(cur.after_hours),
            _prov_sign_ins(sign_ins_now),
            _prov_failed(failed_now),
        ],
        notes=(
            [f"Nothing was recorded in the audit trail or the sign-in log for {_when(period)}."]
            if cur.events == 0 and sign_ins_now == 0
            else []
        ),
    )


# ─── trend ────────────────────────────────────────────────────────────────────────────────────────────────────


def _buckets(period: Period) -> tuple[str, list[tuple[date, date]], Callable[[date], date]]:
    """("day" | "week", the buckets as (first day, last day), day -> the first day of its bucket). Long periods roll up
    to Monday-to-Sunday weeks, clipped to the period at both ends."""
    if period.days <= WEEKLY_ROLLUP_AFTER_DAYS:
        days = [period.start + timedelta(days=i) for i in range(period.days)]
        return "day", [(d, d) for d in days], lambda d: d
    spans: list[tuple[date, date]] = []
    monday = period.start - timedelta(days=period.start.weekday())
    while monday <= period.end:
        spans.append((max(monday, period.start), min(monday + timedelta(days=6), period.end)))
        monday += timedelta(days=7)
    return "week", spans, lambda d: max(d - timedelta(days=d.weekday()), period.start)


@cached()
def activity_trend(period: Period) -> dict:
    """Actions per day (per week for long periods) with the sensitive ones, after-hours ones, sign-ins and failed
    sign-ins alongside, so one chart and the KPI sparklines come from one source."""
    granularity, spans, key = _buckets(period)
    rows: dict[date, dict] = {
        start: {
            "date": start.isoformat(),
            "end": end.isoformat(),
            "actions": 0,
            "sensitive": 0,
            "afterHours": 0,
            "signIns": 0,
            "failedSignIns": 0,
        }
        for start, end in spans
    }
    people: dict[date, set] = {start: set() for start, _ in spans}
    events = sensitive = 0
    for g in _groups(period.start, period.end):
        n, row = _events(g), rows[key(g.day)]
        row["actions"] += n
        events += n
        if g.rule:
            row["sensitive"] += n
            sensitive += n
        if _after_kind(g.day, g.hour):
            row["afterHours"] += n
        if g.user != SYSTEM_USER:
            people[key(g.day)].add(g.user)
    for s in _sessions_by_day(period.start, period.end):
        rows[key(s.day)]["signIns"] += s.n
        people[key(s.day)].add(s.label)
    for a in _attempts_by_day(period.start, period.end):
        rows[key(a.day)]["failedSignIns"] += a.failed
    points = []
    for start, _end in spans:
        rows[start]["activeUsers"] = len(people[start])
        points.append(rows[start])
    busiest = None
    if events:
        peak = max(points, key=lambda p: (p["actions"], p["date"]))
        busiest = {"date": peak["date"], "end": peak["end"], "actions": peak["actions"]}
    return envelope(
        {
            "granularity": granularity,
            "points": points,
            "total": {"actions": events, "sensitive": sensitive},
            "busiest": busiest,
            "averagePerDay": round(events / period.days, 1) if events else None,
        },
        period=period,
        provenance=[
            prov(
                "trend",
                "Activity over time",
                dataset="Audit trail and HR-portal sign-ins",
                definition=(
                    "Actions per day, with how many of them were sensitive or after hours, and sign-ins and failed "
                    f"sign-ins. Periods longer than {WEEKLY_ROLLUP_AFTER_DAYS} days are shown week by week (Monday "
                    "to Sunday)."
                ),
                formula="audit entries (a bulk upload counts once) and login sessions grouped by factory day",
                rows=events,
                filters=["Factory (IST) days", "Sign-in entries are not actions"],
                caveats=[NOT_RECORDED],
            ),
            _prov_sensitive(sensitive),
        ],
        notes=[] if events or any(p["signIns"] for p in points) else [f"Nothing was recorded for {_when(period)}."],
    )


# ─── areas ────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def activity_by_area(period: Period) -> dict:
    """Actions by area of the system, ranked, each compared with the previous period."""
    previous = period.previous()
    cur_groups, old_groups = _split(_groups(previous.start, period.end), period)
    areas: dict[str, dict] = {}

    def slot(module: str) -> dict:
        key, label = area_of(module)
        return areas.setdefault(
            key, {"area": key, "label": label, "actions": 0, "sensitive": 0, "previous": 0, "people": set()}
        )

    for g in cur_groups:
        n, a = _events(g), slot(g.module)
        a["actions"] += n
        if g.rule:
            a["sensitive"] += n
        if g.user != SYSTEM_USER:
            a["people"].add(g.user)
    for g in old_groups:
        slot(g.module)["previous"] += _events(g)

    total = sum(a["actions"] for a in areas.values())
    rows = [
        {
            "area": a["area"],
            "label": a["label"],
            "actions": a["actions"],
            "sharePct": pct(a["actions"], total),
            "sensitive": a["sensitive"],
            "previous": a["previous"],
            "change": change(a["actions"], a["previous"]),
            "people": len(a["people"]),
        }
        for a in areas.values()
        if a["actions"] or a["previous"]
    ]
    rows.sort(key=lambda r: (-r["actions"], -r["previous"], r["label"]))
    mapping = "; ".join(f"{m['label']} = {', '.join(m['modules'])}" for m in area_mapping())
    return envelope(
        {"areas": rows, "total": total, "previousTotal": sum(a["previous"] for a in areas.values())},
        period=period,
        provenance=[
            prov(
                "areas",
                "Actions by area",
                dataset="Audit trail",
                definition=(
                    "Each audit entry is filed under the part of the system it was made in, from the module the "
                    f"system records with it. Related modules are grouped: {mapping}. A module not listed keeps "
                    "its own name."
                ),
                formula="audit entries per area (a bulk upload counts once); share = area ÷ all actions",
                rows=total,
                filters=["Sign-in entries left out"],
                caveats=[NOT_RECORDED],
            )
        ],
    )


# ─── people ───────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def activity_users(period: Period, limit: int = RANKED_LIMIT_DEFAULT) -> dict:
    """Actions by person: the most active first, with their share, sensitive and after-hours actions and last activity."""
    limit = _clamp(limit, 1, RANKED_LIMIT_MAX, RANKED_LIMIT_DEFAULT)
    previous = period.previous()
    cur_groups, old_groups = _split(_groups(previous.start, period.end), period)
    by_label = _by_label(_accounts())

    people: dict[str, dict] = {}
    for g in cur_groups:
        p = people.setdefault(
            g.user, {"actions": 0, "sensitive": 0, "afterHours": 0, "last": None, "areas": Counter(), "previous": 0}
        )
        n = _events(g)
        p["actions"] += n
        p["areas"][area_of(g.module)[1]] += n
        if g.rule:
            p["sensitive"] += n
        if _after_kind(g.day, g.hour):
            p["afterHours"] += n
        if p["last"] is None or g.last > p["last"]:
            p["last"] = g.last
    for g in old_groups:
        if g.user in people:
            people[g.user]["previous"] += _events(g)
    signins: Counter = Counter()
    for s in _sessions_by_day(period.start, period.end):
        signins[s.label] += s.n

    total = sum(p["actions"] for p in people.values())
    ranked = sorted(people.items(), key=lambda kv: (-kv[1]["actions"], kv[0].lower()))
    rows = [
        {
            "userName": name,
            "role": _role_of(name, by_label),
            "actions": p["actions"],
            "sharePct": pct(p["actions"], total),
            "sensitive": p["sensitive"],
            "afterHours": p["afterHours"],
            "signIns": signins.get(name, 0),
            "lastActive": _iso(p["last"]),
            "topArea": max(p["areas"].items(), key=lambda kv: (kv[1], kv[0]))[0],
            "previous": p["previous"],
            "change": change(p["actions"], p["previous"]),
        }
        for name, p in ranked[:limit]
    ]
    rest = ranked[limit:]
    shared = sorted(name for name, _ in ranked[:limit] if len(by_label.get(name, [])) > 1)
    return envelope(
        {
            "users": rows,
            "totalPeople": sum(1 for name in people if name != SYSTEM_USER),
            "total": total,
            "others": {"people": len(rest), "actions": sum(p["actions"] for _, p in rest)} if rest else None,
        },
        period=period,
        provenance=[
            prov(
                "users",
                "Actions by person",
                dataset="Audit trail; roles from the HR accounts",
                definition=(
                    "How much each person did in the HR portal, how much of it was sensitive or after hours, and when "
                    "they last did something. Role is the account's role today."
                ),
                formula="audit entries per name (a bulk upload counts once); share = person ÷ all actions",
                rows=total,
                filters=[
                    "Sign-in entries left out",
                    "Grouped by the name in the audit trail (full name, else username)",
                ],
                caveats=[NOT_RECORDED, "A person who only viewed screens does not appear here."],
            ),
            _prov_after_hours(),
        ],
        notes=(
            ["More than one account shares a name in this list, so their activity is shown together."] if shared else []
        ),
    )


# ─── heatmap ──────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def activity_heatmap(period: Period) -> dict:
    """Actions by weekday and hour of the factory day (7 × 24), plus the busiest cell and the after-hours share."""
    groups = _groups(period.start, period.end)
    grid = [[0] * 24 for _ in range(7)]
    for g in groups:
        grid[g.day.isoweekday() - 1][g.hour] += _events(g)
    tally = _tally(groups)
    total = sum(map(sum, grid))
    peak = None
    if total:
        count, weekday, hour = max((grid[d][h], -d, -h) for d in range(7) for h in range(24))
        peak = {"weekday": WEEKDAYS[-weekday], "hour": -hour, "count": count}
    return envelope(
        {
            "rows": list(WEEKDAYS),
            "hours": list(range(24)),
            "values": grid,
            "total": total,
            "peak": peak,
            "byWeekday": [sum(row) for row in grid],
            "byHour": [sum(grid[d][h] for d in range(7)) for h in range(24)],
            "afterHours": {
                "events": tally.after_hours,
                "sharePct": pct(tally.after_hours, tally.events),
                "weekend": tally.weekend,
                "night": tally.night,
            },
            "workingHours": working_hours(),
        },
        period=period,
        provenance=[
            prov(
                "heatmap",
                "When people act",
                dataset="Audit trail",
                definition="Actions by day of the week and hour of the day in factory (IST) time.",
                formula="audit entries (a bulk upload counts once) counted per weekday and hour",
                rows=total,
                filters=["Sign-in entries left out"],
                caveats=[
                    "Totals over the whole period: a period with five Mondays and four Tuesdays shows more Mondays.",
                    NOT_RECORDED,
                ],
            ),
            _prov_after_hours(tally.after_hours),
        ],
    )


# ─── after hours ──────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def activity_after_hours(period: Period, limit: int = RANKED_LIMIT_DEFAULT) -> dict:
    """Who works outside normal hours, how much of it, and the latest cases."""
    limit = _clamp(limit, 1, RANKED_LIMIT_MAX, RANKED_LIMIT_DEFAULT)
    previous = period.previous()
    cur_groups, old_groups = _split(_groups(previous.start, period.end), period)
    cur, old = _tally(cur_groups), _tally(old_groups)
    by_label = _by_label(_accounts())

    people: dict[str, dict] = {}
    cases: list[tuple[datetime, dict]] = []
    for g in cur_groups:
        n = _events(g)
        person = people.setdefault(g.user, {"total": 0, "after": 0, "weekend": 0, "night": 0, "sensitive": 0})
        person["total"] += n
        kind = _after_kind(g.day, g.hour)
        if not kind:
            continue
        rule = RULES_BY_ID.get(g.rule)
        person["after"] += n
        person[kind] += n
        if rule:
            person["sensitive"] += n
        cases.append(
            (
                g.last,
                {
                    "at": _iso(g.last),
                    "userName": g.user,
                    "area": area_of(g.module)[1],
                    "count": n,
                    "kind": kind,
                    "what": rule.title if rule else None,
                    "category": rule.category if rule else None,
                    "severity": rule.severity if rule else None,
                },
            )
        )
    ranked = sorted(((k, v) for k, v in people.items() if v["after"]), key=lambda kv: (-kv[1]["after"], kv[0].lower()))
    cases.sort(key=lambda item: item[0], reverse=True)
    return envelope(
        {
            "events": cur.after_hours,
            "previous": old.after_hours,
            "change": change(cur.after_hours, old.after_hours),
            "sharePct": pct(cur.after_hours, cur.events),
            "weekend": cur.weekend,
            "night": cur.night,
            "people": len(ranked),
            "byUser": [
                {
                    "userName": name,
                    "role": _role_of(name, by_label),
                    "afterHours": p["after"],
                    "weekend": p["weekend"],
                    "night": p["night"],
                    "sensitive": p["sensitive"],
                    "sharePct": pct(p["after"], p["total"]),
                }
                for name, p in ranked[:limit]
            ],
            "recent": [item for _, item in cases[:limit]],
            "workingHours": working_hours(),
        },
        period=period,
        provenance=[_prov_after_hours(cur.after_hours), _prov_actions(cur.rows)],
    )


# ─── the sensitive feed and the full feed ─────────────────────────────────────────────────────────────────────


def _search_q(text: str) -> Q:
    """Text search over person, wording, area and action, and over the plain-English name of the rule and category (so
    'deleted' finds 'Employee deleted' even when the entry's own wording differs). Needs the ``rule`` annotation."""
    needle = text.strip()[:100]
    q = (
        Q(user_name__icontains=needle)
        | Q(record_description__icontains=needle)
        | Q(module__icontains=needle)
        | Q(action__icontains=needle)
    )
    ids = [r.id for r in RULES if needle.lower() in r.title.lower() or needle.lower() in CATEGORIES[r.category].lower()]
    return q | Q(rule__in=ids) if ids else q


def _event_page(
    period: Period,
    *,
    sensitive_only: bool,
    category: str | None,
    q: str | None,
    user: str | None,
    page: int,
    page_size: int,
    known_total: int | None = None,
) -> tuple[int, list[dict]]:
    """(how many events match, the events of one page, newest first). An event is one audit row, except a bulk-upload
    burst which is one event for all its rows. Each side is fetched newest-first and cut at what the page needs, so the
    work does not grow with the size of the trail: the newest N of the union are among the newest N of each side.

    ``known_total`` is the count when the caller already has it (no search and no person: the figures of the period),
    which saves two counting queries over the whole period; with a search or a person the database counts."""
    base = _audit(period.start, period.end).annotate(rule=_rule_case())
    if user and user.strip():
        base = base.filter(user_name__iexact=user.strip())
    if q and q.strip():
        base = base.filter(_search_q(q))
    if (
        sensitive_only
    ):  # one pass of the rule expression per side: the ids that can match, split into singles and bursts
        chosen = [r for r in RULES if category in (None, r.category)]
        singles = base.filter(rule__in=[r.id for r in chosen if not r.burst])
        bursts_base = base.filter(rule__in=[r.id for r in chosen if r.burst])
    else:
        singles = base.exclude(rule__in=BURST_RULE_IDS)
        bursts_base = base.filter(rule__in=BURST_RULE_IDS)
    bursts = (
        bursts_base.annotate(minute=TruncMinute("created_at", tzinfo=FACTORY_TZ))
        .values("user_name", "module", "rule", "minute")
        .annotate(rows=Count("id"), last=Max("created_at"), last_id=Max("id"))
    )
    wanted = page * page_size
    total = known_total if known_total is not None else singles.count() + bursts.order_by().count()
    single_rows = singles.order_by("-created_at", "-id").values(
        "id", "created_at", "user_name", "action", "module", "record_description", "rule"
    )[:wanted]
    burst_rows = bursts.order_by("-last", "-last_id")[:wanted]

    events: list[dict] = [
        {
            "sort": (r["created_at"], r["id"]),
            "id": str(r["id"]),
            "at": r["created_at"],
            "userName": r["user_name"] or "Unknown",
            "action": r["action"],
            "module": r["module"],
            "text": _clip(r["record_description"]),
            "count": 1,
            "rule": RULES_BY_ID.get(r["rule"]),
        }
        for r in single_rows
    ]
    events += [
        {
            "sort": (r["last"], r["last_id"]),
            "id": f"b{r['last_id']}",
            "at": r["last"],
            "userName": r["user_name"] or "Unknown",
            "action": "bulk",
            "module": r["module"],
            "text": f"{r['rows']:,} employee {_plural(r['rows'], 'record')} in one upload",
            "count": r["rows"],
            "rule": RULES_BY_ID[r["rule"]],
        }
        for r in burst_rows
    ]
    events.sort(key=lambda e: e["sort"], reverse=True)
    return total, events[(page - 1) * page_size : page * page_size]


def _event_json(e: dict, by_label: dict[str, list[Account]], *, compact: bool) -> dict:
    """One feed entry as the screen and the assistant get it. ``compact`` (the assistant) leaves out the free text of the
    entry, which can contain employee names; the rule's plain-English title says what happened."""
    rule: Rule | None = e["rule"]
    local = _local(e["at"])
    out = {
        "id": e["id"],
        "at": local.isoformat(timespec="seconds"),
        "userName": e["userName"],
        "role": _role_of(e["userName"], by_label),
        "area": area_of(e["module"])[1],
        "count": e["count"],
        "afterHours": _after_kind(local.date(), local.hour),
        "category": rule.category if rule else None,
        "categoryLabel": CATEGORIES[rule.category] if rule else None,
        "severity": rule.severity if rule else None,
        "title": rule.title if rule else None,
    }
    if not compact:
        out["action"] = e["action"]
        out["description"] = e["text"]
    return out


def _page_args(page: int | None, page_size: int | None) -> tuple[int, int]:
    return _clamp(page, 1, 10_000, 1), _clamp(page_size, 1, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT)


def _category_counts(period: Period) -> tuple[list[dict], dict]:
    """Sensitive events per category and severity for the whole period (the filter chips), from the same groups as the
    KPIs, so a chip's number and the KPI can never disagree."""
    cells: Counter = Counter()
    for g in _groups(period.start, period.end):
        rule = RULES_BY_ID.get(g.rule)
        if rule:
            cells[(rule.category, rule.severity)] += _events(g)
    cats = [
        {
            "id": key,
            "label": label,
            "count": sum(cells[(key, s)] for s in SEVERITIES),
            **{s: cells[(key, s)] for s in SEVERITIES},
        }
        for key, label in CATEGORIES.items()
    ]
    return cats, {s: sum(cells[(k, s)] for k in CATEGORIES) for s in SEVERITIES}


def activity_sensitive(
    period: Period,
    page: int | None = 1,
    page_size: int | None = PAGE_SIZE_DEFAULT,
    q: str | None = None,
    category: str | None = None,
    user: str | None = None,
    compact: bool = False,
) -> dict:
    """Sensitive actions, newest first, with the filter counts and (for the screen) the rule table that decided them."""
    category = _check_category(category)
    page, page_size = _page_args(page, page_size)
    categories, by_severity = _category_counts(period)
    searching = bool((q or "").strip() or (user or "").strip())
    known = None
    if not searching:  # the chips' figures are the count: the same groups as the headline tile
        known = next(c["count"] for c in categories if c["id"] == category) if category else sum(by_severity.values())
    total, events = _event_page(
        period,
        sensitive_only=True,
        category=category,
        q=q,
        user=user,
        page=page,
        page_size=page_size,
        known_total=known,
    )
    by_label = _by_label(_accounts())
    body: dict[str, Any] = {
        "total": total,
        "page": page,
        "pageSize": page_size,
        "pages": max(1, math.ceil(total / page_size)),
        "items": [_event_json(e, by_label, compact=compact) for e in events],
        "categories": categories,
        "bySeverity": by_severity,
        "filters": {"category": category, "q": (q or "").strip() or None, "user": (user or "").strip() or None},
    }
    if not compact:
        body["rules"] = rule_table()
    return envelope(
        body,
        period=period,
        provenance=[
            _prov_sensitive(sum(by_severity.values())),
            prov(
                "sensitive-rules",
                "What counts as sensitive",
                dataset="A fixed rule table in the system",
                definition=(
                    "An audit entry is matched, in order, against rules built from what the system really records "
                    "(the kind of action, the area, and the wording of the entry). The first rule that matches "
                    "gives its category and severity. Anything that matches no rule is routine."
                ),
                formula=f"{len(RULES)} rules in {len(CATEGORIES)} categories; severity Critical, High or Medium",
                rows=total,
                filters=[f"{CATEGORIES[category]} only"] if category else [],
                caveats=[NOT_RECORDED],
            ),
        ],
    )


def activity_feed(
    period: Period,
    page: int | None = 1,
    page_size: int | None = PAGE_SIZE_DEFAULT,
    q: str | None = None,
    user: str | None = None,
    compact: bool = False,
) -> dict:
    """Everything people did (sign-ins excluded), newest first; sensitive entries carry their category and severity."""
    page, page_size = _page_args(page, page_size)
    total, events = _event_page(
        period, sensitive_only=False, category=None, q=q, user=user, page=page, page_size=page_size
    )
    by_label = _by_label(_accounts())
    return envelope(
        {
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": max(1, math.ceil(total / page_size)),
            "items": [_event_json(e, by_label, compact=compact) for e in events],
            "filters": {"q": (q or "").strip() or None, "user": (user or "").strip() or None},
        },
        period=period,
        provenance=[
            prov(
                "feed",
                "Recent activity",
                dataset="Audit trail",
                definition="Every action in the period, newest first, with who did it and when (factory time).",
                formula="audit entries; a bulk upload is one line that says how many employees it touched",
                rows=total,
                filters=["Sign-in entries left out"],
                caveats=[NOT_RECORDED],
            )
        ],
    )


# ─── sign-ins ─────────────────────────────────────────────────────────────────────────────────────────────────


def _span_end(created: datetime, revoked: datetime | None) -> datetime:
    """When a session stopped being usable: signed out, or the token's lifetime (HR_TOKEN_HOURS), whichever came first."""
    expires = created + timedelta(hours=HR_TOKEN_HOURS)
    return max(created, min(revoked, expires) if revoked else expires)


def _overlap(spans: list[tuple[datetime, datetime, bool]]) -> tuple[int, int]:
    """(sign-ins that began while an earlier session of the same account was still usable, the most sessions usable at
    once at any of this period's sign-ins). ``spans`` are (start, end, in_period) oldest first."""
    live: list[datetime] = []
    overlapping = peak = 0
    for start, end, in_period in spans:
        live = [e for e in live if e > start]
        if live and in_period:
            overlapping += 1
        live.append(end)
        if in_period:
            peak = max(peak, len(live))
    return overlapping, peak


def _failed_accounts(period: Period, accounts: list[Account]) -> tuple[list[dict], int, int]:
    """(failed attempts per typed username, most first; how many usernames were not accounts; how many usernames failed).

    What was typed is shown only when it is an account's username. Anything else is "Unknown name 1", "Unknown name 2"
    ...: the username box is also where a password gets typed by mistake, and a list of failed attempts must never
    become a list of passwords (for the MD's screen or for the assistant). Accounts are always listed; of the names
    that are not accounts only the ``FAILED_NAMES_SHOWN`` most-tried are, so a spray of thousands of guessed names
    cannot make the answer (or this loop) grow."""
    known = {a.username.lower(): a for a in accounts}
    locked = Counter(lo.username for lo in _lockouts(period.start, period.end))
    grouped = (
        HrLoginAttempt.objects.filter(_range("created_at", period.start, period.end), success=False)
        .annotate(who=Lower("username"))
        .values("who")
        .annotate(failures=Count("id"), last=Max("created_at"))
        .order_by("-failures", "who")
    )
    of_accounts = list(grouped.filter(who__in=list(known)))
    strangers = grouped.exclude(who__in=list(known))
    stranger_rows = list(strangers[:FAILED_NAMES_SHOWN])
    stranger_names = strangers.count()
    out = []
    unknown = 0
    for r in sorted([*of_accounts, *stranger_rows], key=lambda r: (-r["failures"], r["who"])):
        account = known.get(r["who"])
        if account is None:
            unknown += 1
        out.append(
            {
                "userName": account.label if account else f"Unknown name {unknown}",
                "failures": r["failures"],
                "lastAt": _iso(r["last"]),
                "knownAccount": account is not None,
                "privileged": bool(account and account.privileged),
                "lockedOut": locked.get(r["who"], 0),
            }
        )
    return out, stranger_names, len(of_accounts) + stranger_names


def _new_devices(period: Period, accounts: list[Account]) -> list[dict]:
    """Devices an account signed in with for the first time during the period, when it had signed in before (an
    account's very first sign-in is not a "new" device). A device is the browser-and-system label recorded at sign-in."""
    by_id = {a.id: a for a in accounts}
    low, high = _day_start(period.start), _day_start(period.end + timedelta(days=1))
    first: dict[tuple[int, str], datetime] = {}
    for r in (
        LoginSession.objects.filter(created_at__lt=high)
        .values("hr_user_id", "device_label")
        .annotate(first=Min("created_at"))
        .order_by()
    ):
        key = (r["hr_user_id"], r["device_label"] or UNKNOWN_DEVICE)
        first[key] = min(first[key], r["first"]) if key in first else r["first"]
    earliest: dict[int, datetime] = {}
    for (uid, _device), at in first.items():
        earliest[uid] = min(earliest[uid], at) if uid in earliest else at
    found = sorted(
        ((at, uid, device) for (uid, device), at in first.items() if at >= low and at > earliest[uid] and uid in by_id),
        reverse=True,
    )
    return [
        {
            "userName": by_id[uid].label,
            "role": by_id[uid].role,
            "privileged": by_id[uid].privileged,
            "device": device,
            "at": _iso(at),
        }
        for at, uid, device in found
    ]


@cached()
def activity_sign_ins(period: Period, limit: int = RANKED_LIMIT_DEFAULT) -> dict:
    """Sign-ins and the security signals around them: per day and per person, new devices, sessions open at the same
    time, failed attempts and lock-outs, and accounts nobody has signed in to for a long time."""
    limit = _clamp(limit, 1, RANKED_LIMIT_MAX, RANKED_LIMIT_DEFAULT)
    previous = period.previous()
    low, high = _day_start(period.start), _day_start(period.end + timedelta(days=1))
    accounts = _accounts(as_of=high)
    by_id = {a.id: a for a in accounts}

    # sessions of this period, plus the ones that could still have been open when it began (for the overlap check)
    spans: dict[int, list[tuple[datetime, datetime, bool]]] = defaultdict(list)
    counts: Counter = Counter()
    devices: dict[int, set] = defaultdict(set)
    for uid, created, revoked, device in (
        LoginSession.objects.filter(created_at__gte=low - timedelta(hours=HR_TOKEN_HOURS), created_at__lt=high)
        .order_by("created_at", "id")
        .values_list("hr_user_id", "created_at", "revoked_at", "device_label")
    ):
        in_period = created >= low
        spans[uid].append((created, _span_end(created, revoked), in_period))
        if in_period:
            counts[uid] += 1
            devices[uid].add(device or UNKNOWN_DEVICE)
    overlaps = {uid: _overlap(s) for uid, s in spans.items()}
    new_devices = _new_devices(period, accounts)
    new_for = Counter(d["userName"] for d in new_devices)

    # the sign-in chart: per day (per week when the period is long), with failed attempts alongside
    granularity, bucket_spans, key = _buckets(period)
    daily = {s: {"date": s.isoformat(), "end": e.isoformat(), "signIns": 0, "failed": 0} for s, e in bucket_spans}
    for s in _sessions_by_day(period.start, period.end):
        daily[key(s.day)]["signIns"] += s.n
    attempts = _attempts_by_day(previous.start, period.end)
    for a in attempts:
        if a.day >= period.start:
            daily[key(a.day)]["failed"] += a.failed
    sign_ins_now = sum(counts.values())
    sign_ins_before = sum(s.n for s in _sessions_by_day(previous.start, previous.end))
    failed_now = sum(a.failed for a in attempts if a.day >= period.start)
    failed_before = sum(a.failed for a in attempts if a.day < period.start)
    failed_rows, unknown_names, _ = _failed_accounts(period, accounts)
    blocked = AuditLog.objects.filter(_range("created_at", period.start, period.end), action="login_blocked").count()

    # who is signed in right now (a snapshot, whatever period is shown): not signed out, token not yet expired
    now = _utc_now()
    live = Counter(
        LoginSession.objects.filter(
            revoked_at__isnull=True,
            created_at__gt=now - timedelta(hours=HR_TOKEN_HOURS),
            created_at__lte=now,
            hr_user__is_active=True,
        )
        .order_by()
        .values_list("hr_user_id", flat=True)
    )

    people = []
    for a in accounts:
        if a.created_at >= high or not (a.enabled or counts.get(a.id)):
            continue
        overlapping, peak = overlaps.get(a.id, (0, 0))
        reference = _local(a.last_seen or a.created_at).date()
        people.append(
            {
                "userName": a.label,
                "role": a.role,
                "privileged": a.privileged,
                "enabled": a.enabled,
                "signIns": counts.get(a.id, 0),
                "devices": sorted(devices.get(a.id, ())),
                "lastSignIn": _iso(a.last_seen),
                "daysSince": (period.end - _local(a.last_seen).date()).days if a.last_seen else None,
                "dormant": a.enabled and (period.end - reference).days >= DORMANT_DAYS,
                "newDevices": new_for.get(a.label, 0),
                "peakAtOnce": peak,
                "overlapping": overlapping,
            }
        )
    ranked = sorted(people, key=lambda p: (-p["signIns"], p["userName"].lower()))
    dormant = sorted((p for p in people if p["dormant"]), key=lambda p: (-(p["daysSince"] or 10**6), p["userName"]))
    several = sorted(((by_id[uid].label, n) for uid, n in live.items() if n > 1), key=lambda kv: (-kv[1], kv[0]))
    overlapping_total = sum(o for o, _ in overlaps.values())
    overlapping_accounts = sorted(
        ({"userName": by_id[uid].label, "overlapping": o, "peak": p} for uid, (o, p) in overlaps.items() if o),
        key=lambda r: (-r["overlapping"], r["userName"].lower()),
    )
    return envelope(
        {
            "signIns": _kpi(sign_ins_now, sign_ins_before, people=sum(1 for c in counts.values() if c)),
            "granularity": granularity,
            "daily": list(daily.values()),
            "accounts": ranked[:limit],
            "totalAccounts": len(people),
            "newDevices": new_devices[:limit],
            "newDevicesTotal": len(new_devices),
            "concurrent": {
                "liveNow": {"sessions": sum(live.values()), "accounts": len(live)},
                "severalNow": [{"userName": n, "sessions": c} for n, c in several[:5]],
                "overlappingSignIns": overlapping_total,
                "accounts": overlapping_accounts[:5],
            },
            "failed": {
                **_kpi(
                    failed_now,
                    failed_before,
                    lockouts=len(_lockouts(period.start, period.end)),
                    blockedAttempts=blocked,
                    unknownUsernames=unknown_names,
                ),
                "accounts": failed_rows[:limit],
            },
            "dormant": {"days": DORMANT_DAYS, "count": len(dormant), "accounts": dormant[:5]},
        },
        period=period,
        provenance=[
            _prov_sign_ins(sign_ins_now),
            _prov_failed(failed_now),
            prov(
                "new-devices",
                "New devices",
                dataset="HR-portal login sessions",
                definition=(
                    "A sign-in with a browser-and-system combination (for example 'Chrome on Windows') that this "
                    "account had never used before. An account's first-ever sign-in does not count."
                ),
                formula="first sign-in per account and device label, when it falls in the period and is not the first",
                rows=len(new_devices),
                caveats=[
                    "Two different computers with the same browser and system look like the same device.",
                    "'Privileged' = a super admin, the Managing Director, or a role that can edit payroll, salary, "
                    "settlement, user management or settings.",
                ],
            ),
            prov(
                "concurrent",
                "Sessions open at the same time",
                dataset="HR-portal login sessions",
                definition=(
                    "A sign-in that began while the same account still had another session open. A session counts as "
                    f"open until it is signed out or {HR_TOKEN_HOURS} hours after it began, when its token expires."
                ),
                formula="sign-ins in the period with an earlier session of the same account still open",
                rows=overlapping_total,
                caveats=["Signing in on a computer and a phone is normal; many at once can mean a shared password."],
            ),
            prov(
                "dormant",
                "Accounts nobody signs in to",
                dataset="HR accounts and login sessions",
                definition=(
                    f"Enabled accounts whose last sign-in was {DORMANT_DAYS} or more days before the end of the "
                    "period (or that have never signed in and are that old)."
                ),
                formula=f"enabled accounts with the last sign-in {DORMANT_DAYS}+ days before the period ends",
                rows=len(dormant),
            ),
        ],
    )


# ─── what stands out (insights for the dashboard and the page's "Needs your attention") ──────────────────────

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "good": 3}


def _insight_critical(groups: list[Group]) -> dict | None:
    """Critical system changes (MD access, database restore, employees deleted in bulk) in the window."""
    found = sorted(
        (g for g in groups if (r := RULES_BY_ID.get(g.rule)) and r.severity == "critical"),
        key=lambda g: g.last,
        reverse=True,
    )
    if not found:
        return None
    n = sum(_events(g) for g in found)
    lines = [f"{RULES_BY_ID[g.rule].title} by {g.user} on {_day_text(g.day)}" for g in found]
    return {
        "id": "activity.critical-events",
        "severity": "critical",
        "title": f"{n} critical system {_plural(n, 'change')} in the last 7 days",
        "detail": _listed(lines) + ".",
        "metric": str(n),
        "ask": "What critical system changes were made in the last 7 days, by whom and when?",
    }


def _insight_spike(cur: Tally, base: Tally) -> dict | None:
    """Sensitive actions well above the weekly level of the four weeks before (or a first burst when there was none)."""
    weekly = base.sensitive / 4
    if cur.sensitive < 5 or not (cur.sensitive >= 2 * weekly if weekly else cur.sensitive >= 10):
        return None
    top, top_n = cur.category.most_common(1)[0]
    compared = (
        f"{cur.sensitive / weekly:.1f}× the usual {weekly:.1f} a week" if weekly else "none in the four weeks before"
    )
    return {
        "id": "activity.sensitive-spike",
        "severity": "warning",
        "title": f"{cur.sensitive} sensitive actions in the last 7 days, {compared}",
        "detail": f"Mostly {CATEGORIES[top].lower()} ({top_n}).",
        "metric": str(cur.sensitive),
        "ask": f"Why were there {cur.sensitive} sensitive actions in the last 7 days? Break them down by category and person.",
    }


def _insight_after_hours(groups: list[Group]) -> dict | None:
    """The one person with the most after-hours actions, when it is 5 or more."""
    after: dict[str, Counter] = defaultdict(Counter)
    for g in groups:
        kind = _after_kind(g.day, g.hour)
        if kind and g.user != SYSTEM_USER:
            n = _events(g)
            after[g.user]["total"] += n
            after[g.user][kind] += n
            if g.rule:
                after[g.user]["sensitive"] += n
    if not after:
        return None
    name, c = max(after.items(), key=lambda kv: (kv[1]["total"], kv[0]))
    if c["total"] < 5:
        return None
    others = len(after) - 1
    detail = f"Normal hours are {working_hours()['label']}. {c['weekend']} on Sunday, {c['night']} at night"
    detail += f"; {c['sensitive']} of them sensitive." if c["sensitive"] else "."
    if others:
        detail += f" {others} other {_plural(others, 'person', 'people')} also worked after hours."
    return {
        "id": "activity.after-hours-user",
        "severity": "warning" if c["total"] >= 10 or c["sensitive"] else "info",
        "title": f"{name} did {c['total']} actions outside working hours in the last 7 days",
        "detail": detail,
        "metric": str(c["total"]),
        "ask": "Who worked outside working hours in the last 7 days, and what did they do?",
    }


def _insight_failed(period: Period, accounts: list[Account]) -> dict | None:
    """A lock-out, one username failing 5+ times, or many failures spread over several usernames."""
    rows, unknown, names = _failed_accounts(period, accounts)
    total = sum(a.failed for a in _attempts_by_day(period.start, period.end))
    locked = _lockouts(period.start, period.end)
    worst = rows[0] if rows else None
    if not (locked or (worst and worst["failures"] >= HR_LOCKOUT_THRESHOLD) or (total >= 15 and names >= 3)):
        return None
    lead = ""
    if locked:
        names = sorted({r["userName"] for r in rows if r["lockedOut"] and r["knownAccount"]})
        strangers = len({lo.username for lo in locked}) - len(names)
        if names:
            title = f"{len(names)} {_plural(len(names), 'account')} locked out after repeated wrong passwords"
            lead = f"{_listed(names)}. "
        else:
            title = (
                f"{strangers} {_plural(strangers, 'name')} that {'is' if strangers == 1 else 'are'} not an account "
                "locked out after repeated tries"
            )
    elif worst and worst["failures"] >= HR_LOCKOUT_THRESHOLD:
        who = worst["userName"] if worst["knownAccount"] else "A name that is not an account"
        title = f"{who} failed to sign in {worst['failures']} times in the last 7 days"
    else:
        title = f"{total} failed sign-ins across {names} usernames in the last 7 days"
    tail = f"{total} failed attempts in all"
    if unknown:
        tail += f"; {unknown} {_plural(unknown, 'username')} did not belong to any account (possible guessing)"
    return {
        "id": "activity.failed-sign-ins",
        "severity": "critical" if total >= 50 else "warning",
        "title": title,
        "detail": f"{lead}{tail}.",
        "metric": str(total),
        "ask": "Who failed to sign in recently, and were any accounts locked out?",
    }


def _insight_new_device(period: Period, accounts: list[Account]) -> dict | None:
    """A privileged account signing in from a browser-and-system it has never used."""
    fresh = [d for d in _new_devices(period, accounts) if d["privileged"]]
    if not fresh:
        return None
    first = fresh[0]
    title = (
        f"{first['userName']} ({first['role'] or 'privileged account'}) signed in from a new device"
        if len(fresh) == 1
        else f"{len(fresh)} privileged sign-ins from a new device"
    )
    return {
        "id": "activity.new-device",
        "severity": "warning",
        "title": title,
        "detail": _listed([f"{d['userName']} on {d['device']}" for d in fresh]) + ". Check it was them.",
        "metric": str(len(fresh)),
        "ask": "Which privileged accounts signed in from a new device recently?",
    }


def _insight_busy(now_groups: list[Group], base_groups: list[Group]) -> dict | None:
    """The account furthest above its own usual weekly volume: 30+ actions and 3× its four-week average (or 50+ when it
    had no earlier activity). Judged against the person's own history, not the team's: roles differ."""
    mine: Counter = Counter()
    for g in now_groups:
        mine[g.user] += _events(g)
    usual: Counter = Counter()
    for g in base_groups:
        usual[g.user] += _events(g)
    best: tuple[str, int, float] | None = None
    for name, n in mine.items():
        weekly = usual.get(name, 0) / 4
        busy = (n >= 30 and n >= 3 * weekly) if weekly else n >= 50
        if name != SYSTEM_USER and busy and (best is None or n > best[1]):
            best = (name, n, weekly)
    if best is None:
        return None
    name, n, weekly = best
    compared = f"{n / weekly:.1f}× their usual {weekly:.0f} a week" if weekly else "with no earlier activity to compare"
    return {
        "id": "activity.high-volume",
        "severity": "info",
        "title": f"{name} made {n} actions in the last 7 days, {compared}",
        "detail": "A bulk upload counts as one action, so these are many separate changes.",
        "metric": str(n),
        "ask": "Which accounts were much busier than usual in the last 7 days, and what did they do?",
    }


def insights(*, today: date | None = None) -> list[dict]:
    """What stands out in the LAST 7 DAYS (the factory's days up to ``today``), at most five, most severe first:
    critical system changes, a spike in sensitive actions, one person working outside hours, repeated failed sign-ins,
    a privileged account on a new device, an account far busier than usual. When none of that happened, one calm
    "good" line; when nothing at all was recorded, an info line saying so (silence is itself worth knowing)."""
    today = today or ist_today()
    recent = Period(today - timedelta(days=6), today, None, "Last 7 days")
    groups = _groups(today - timedelta(days=34), today)  # the week itself plus the four before it
    now_groups = [g for g in groups if g.day >= recent.start]
    base_groups = [g for g in groups if g.day < recent.start]
    cur, base = _tally(now_groups), _tally(base_groups)
    accounts = _accounts()

    found = [
        _insight_critical(now_groups),
        _insight_spike(cur, base),
        _insight_after_hours(now_groups),
        _insight_failed(recent, accounts),
        _insight_new_device(recent, accounts),
        _insight_busy(now_groups, base_groups),
    ]
    items = [{"page": "activity", **i} for i in found if i]
    items.sort(key=lambda i: SEVERITY_ORDER[i["severity"]])  # stable: ties keep the order above
    if items:
        return items[:5]
    if not cur.events and not any(s.n for s in _sessions_by_day(recent.start, recent.end)):
        return [
            {
                "id": "activity.silent",
                "severity": "info",
                "title": "No system activity was recorded in the last 7 days",
                "detail": "No actions and no sign-ins. If people have been working, check the audit trail is written.",
                "metric": "0",
                "page": "activity",
                "ask": "Why was no activity recorded in the system in the last 7 days?",
            }
        ]
    people = len(cur.users)
    return [
        {
            "id": "activity.calm",
            "severity": "good",
            "title": "Nothing unusual in the system in the last 7 days",
            "detail": (
                f"{cur.events} {_plural(cur.events, 'action')} by {people} {_plural(people, 'person', 'people')}; "
                "no critical changes, no odd-hours pattern, no repeated failed sign-ins."
            ),
            "metric": str(cur.events),
            "page": "activity",
            "ask": "Summarise the system activity of the last 7 days.",
        }
    ]


def activity_attention(*, today: date | None = None) -> dict:
    """The page's "Needs your attention": the same exceptions the dashboard shows, always for the last 7 days."""
    today = today or ist_today()
    window = Period(today - timedelta(days=6), today, None, "Last 7 days")
    return envelope(
        {"window": window.to_json(), "insights": insights(today=today)},
        provenance=[
            prov(
                "attention",
                "What stands out",
                dataset="Audit trail, sign-in log and login sessions",
                definition=(
                    "Checks run over the last 7 days, whatever period is chosen on this page: critical system "
                    "changes, a spike in sensitive actions against the usual four-week level, one person working "
                    "outside hours, repeated failed sign-ins or lock-outs, a privileged account on a new device, and "
                    "an account much busier than its own usual."
                ),
                formula=(
                    "5+ sensitive actions and 2× the weekly average; 5+ after-hours actions by one person; "
                    f"{HR_LOCKOUT_THRESHOLD}+ failed sign-ins on one username or any lock-out; "
                    "30+ actions and 3× the person's own usual week"
                ),
                caveats=[NOT_RECORDED],
            )
        ],
    )


# ─── headline (the dashboard's card strip) ────────────────────────────────────────────────────────────────────


def headline(*, today: date | None = None) -> dict:
    """Three KPIs for the dashboard: sensitive actions, after-hours actions and failed sign-ins over the last 7 days
    against the 7 before, with a 14-day sparkline each. (A rolling week rather than Monday-to-today: on a Monday
    "this week" would be one day and would say nothing.)"""
    today = today or ist_today()
    start = today - timedelta(days=13)
    groups = _groups(start, today)
    days = [start + timedelta(days=i) for i in range(14)]
    sensitive = dict.fromkeys(days, 0)
    after = dict.fromkeys(days, 0)
    failed = dict.fromkeys(days, 0)
    for g in groups:
        n = _events(g)
        if g.rule:
            sensitive[g.day] += n
        if _after_kind(g.day, g.hour):
            after[g.day] += n
    for a in _attempts_by_day(start, today):
        failed[a.day] += a.failed

    def card(card_id: str, label: str, series: dict[date, int], sub: str) -> dict:
        values = [series[d] for d in days]
        now, before = sum(values[7:]), sum(values[:7])
        return {
            "id": card_id,
            "label": label,
            "value": now,
            "format": "number",
            "sub": sub,
            "delta": {**(change(now, before) or {"abs": None, "pct": None}), "good": "down"},
            "spark": values,
            "page": "activity",
        }

    cur = _tally(g for g in groups if g.day >= today - timedelta(days=6))
    serious = cur.severity["critical"] + cur.severity["high"]
    return {
        "kpis": [
            card("activity.sensitive", "Sensitive actions", sensitive, f"Last 7 days · {serious} critical or high"),
            card("activity.after-hours", "After-hours actions", after, "Last 7 days · outside working hours"),
            card("activity.failed-sign-ins", "Failed sign-ins", failed, "Last 7 days · HR portal"),
        ],
        "provenance": [_prov_sensitive(), _prov_after_hours(), _prov_failed()],
    }


# ─── the assistant's tools ────────────────────────────────────────────────────────────────────────────────────

_LIMIT = {"limit": integer_param("How many rows (default 5, at most 25)", minimum=1, maximum=RANKED_LIMIT_MAX)}


def _sensitive_for_assistant(
    *, period: Period, limit: int = 10, category: str | None = None, user: str | None = None
) -> dict:
    """The sensitive feed as the assistant gets it: newest first, no free text (it can name employees)."""
    return activity_sensitive(period, page=1, page_size=limit, category=category, user=user, compact=True)


TOOLS = [
    tool(
        "activity_summary",
        "Overall system activity for a period with the previous period alongside: actions people took in the HR "
        "portal, how many people were active, sensitive actions (by severity), after-hours and Sunday actions, "
        "sign-ins, failed sign-ins and lock-outs. Use for 'how active is the system', 'is anything unusual', 'how many "
        "sign-ins'. Sign-ins are not counted as actions; a bulk upload counts as one action.",
        activity_summary,
        page="activity",
        period="last_30_days",
        scope=False,
    ),
    tool(
        "activity_by_area",
        "Actions by area of the system (employees, payroll, attendance, settings, accounts and so on) for a period, "
        "with share, sensitive count and change against the previous period. Use for 'where is the activity' or "
        "'which area changed most'.",
        activity_by_area,
        page="activity",
        period="last_30_days",
        scope=False,
    ),
    tool(
        "activity_by_user",
        "The most active people in the HR portal for a period: actions, share of all actions, sensitive actions, "
        "after-hours actions, sign-ins, role and last activity. Use for 'who is doing the most' or 'who works after "
        "hours'. Names are people.",
        activity_users,
        page="activity",
        period="last_30_days",
        scope=False,
        extra=_LIMIT,
        defaults={"limit": 5},
    ),
    tool(
        "activity_sensitive_actions",
        "Sensitive actions (newest first) for a period: role and account changes including Managing Director "
        "assignment, deletions, payroll runs, bulk uploads, exports, settings and approval-workflow changes, backups "
        "and restores. Each has who, when, category, severity and a plain-English title, plus counts per category and "
        "severity. Filter by category or person. Use for 'what sensitive changes happened'. The free text of entries "
        "is withheld.",
        _sensitive_for_assistant,
        page="activity",
        period="last_30_days",
        scope=False,
        extra={
            **_LIMIT,
            "category": string_param("Only this category.", enum=list(CATEGORIES)),
            "user": string_param("Only this person's actions: their name exactly as shown in the audit trail."),
        },
        defaults={"limit": 10},
    ),
    tool(
        "activity_sign_ins",
        "Sign-ins to the HR portal for a period: total against the previous period, sign-ins per person with devices "
        "and last sign-in, devices an account used for the first time, sessions open at the same time, failed attempts "
        "by username with lock-outs, and accounts that have not signed in for 30+ days. Use for security questions "
        "about access and failed logins.",
        activity_sign_ins,
        page="activity",
        period="last_30_days",
        scope=False,
        extra=_LIMIT,
        defaults={"limit": 5},
    ),
    tool(
        "activity_after_hours",
        "Actions taken outside normal working hours (before 7 am, from 9 pm, or on Sunday) for a period: total, share "
        "of all actions, Sunday versus night, who does it most and the latest cases. Use for 'is anyone working odd "
        "hours' or 'weekend activity'.",
        activity_after_hours,
        page="activity",
        period="last_30_days",
        scope=False,
        extra=_LIMIT,
        defaults={"limit": 5},
    ),
]
