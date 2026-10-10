"""MD portal, Requests: what is waiting for a decision, for whom, for how long, and how fast requests get decided.

Which requests are counted
--------------------------
The HR "Requests" page lists three kinds (leave, permission and employee-requested outpasses). This module covers every
request that goes through an approval pipeline (``approval_workflow.py``), because the MD's question ("where do things
get stuck?") does not stop at the three the HR page shows. ``kind=page`` narrows any figure to those three.

  leave, permission, casual leave, outpass (employee-requested), missing punch, on-duty, resignation  raised by the employee
  attendance correction, advance                                                                    raised by HR

General "other requests" tickets (documents, letters, queries) are not approvals and are left out.

One definition of "waiting", "submitted" and "decided" (the same for every kind)
-------------------------------------------------------------------------------
* **Waiting** = still undecided *now*, whatever day it was submitted. It is a snapshot (a request that has waited three
  weeks is the worst case, so the period filter must not hide it). The statuses are the approval engine's own (`pending`,
  `pending_hod`, `pending_hr`, `dept_approved`), not a guess.
* **Who it waits on** comes from the same engine the HR pages use: the pipeline in force today and the approvals already
  recorded on the request (``approval_trail``), through ``approval_workflow.holding_roles``. HR, the Department Head, or
  either of them. The MD decides as HR does (a super-admin acts with the HR role), so what waits on HR or on "either" is
  what the MD can decide today; what waits only on a Department Head is not his to decide.
* **Submitted** = created in the period (Indian-time days). Volume, mix and "who asks a lot" use this.
* **Decided** = approved or rejected, counted on the day the decision was made. Approval and rejection rates and the time
  to decide use this. The decision time is the last entry of the request's approval trail, or the model's own review
  stamp for older requests. A request decided before the trail existed may have neither: it is counted as decided
  nowhere and said so in ``notes`` (never guessed).
* **Time to decide** = decision time minus submission time, in calendar hours (nights and Sundays included), median and
  90th percentile (``PERCENTILE_CONT``).
* **Age** of a waiting request = now minus submission time, in the bands under 1 day / 1 to 3 days / 3 to 7 days / 7 days
  or more (lower edge included).

Everything is aggregated in the database: each analysis builds one UNION ALL of the kinds (one branch per approval
table, scope applied inside every branch) and groups it once, so the number of queries does not depend on the number of
requests. Nothing here writes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Callable

from django.db import connection
from django.db.models import (
    BooleanField,
    Case,
    CharField,
    DateTimeField,
    DecimalField,
    F,
    Func,
    Q,
    QuerySet,
    TextField,
    Value,
    When,
)
from django.db.models.functions import Cast, Coalesce
from django.utils import timezone

from ... import approval_workflow as approval
from ...clock import FACTORY_TZ, ist_now, ist_today
from ...models import (
    Advance,
    AttendanceOverrideRequest,
    CasualLeaveRequest,
    EmployeePermission,
    LeaveRequest,
    MissingPunchRequest,
    OnDutySession,
    OutpassRequest,
    ResignationRequest,
)
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import MdParamError, Period, Scope, cached, change, envelope, pct, period_for_preset, prov

PAGE = "requests"

# ─── named thresholds (echoed in the provenance; the tests pin them) ─────────────────────────────────────────────────

#: A waiting request is "old" from this many days (the band edge too), and "stale" from STALE_DAYS.
AGED_DAYS = 3
STALE_DAYS = 7
#: Edges of the age bands for waiting requests, in hours: under 1 day, 1 to 3, 3 to 7, 7 or more.
AGE_EDGES_HOURS = (24, AGED_DAYS * 24, STALE_DAYS * 24)
#: "Decided quickly" = under this many hours (the share of decisions that meet it is shown as a service level).
SLA_HOURS = 24
#: Fewer decided requests than this in a group: its rates and times are shown but marked "small sample".
MIN_GROUP_DECIDED = 5
#: Fewer decided requests than this overall (either period) and no comparison is called a trend.
MIN_DECIDED = 10
#: The median must rise by this ratio, and by at least SLOWDOWN_MIN_HOURS, to be called a slowdown.
SLOWDOWN_RATIO = 1.25
SLOWDOWN_MIN_HOURS = 2.0
#: Below this share of requests decided within SLA_HOURS the service is flagged.
LOW_SLA_PCT = 50.0
#: A kind or department is flagged for rejecting at least this share of the requests decided (min MIN_DECIDED).
HIGH_REJECTION_PCT = 40.0
#: "Asks a lot": this many employee-raised requests in the period; "turned down repeatedly": this many rejections.
REPEAT_MIN_REQUESTS = 5
REPEAT_MIN_REJECTIONS = 2
#: No limit is configured in the system, so an advance at or above this is called large (rupees).
LARGE_ADVANCE_AMOUNT = 25_000.0
#: A department is named a bottleneck when this many requests have waited AGED_DAYS+ with its Department Head.
BOTTLENECK_MIN_AGED = 3
#: Periods longer than this are drawn by week instead of by day.
WEEKLY_ROLLUP_AFTER_DAYS = 62
LIST_MAX = 25
LIST_DEFAULT = 10

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}

HOLDER_HR, HOLDER_HOD, HOLDER_EITHER = "hr", "hod", "either"
HOLDER_LABEL = {HOLDER_HR: "HR", HOLDER_HOD: "Department Head", HOLDER_EITHER: "HR or Department Head"}
HOLDERS = (HOLDER_HR, HOLDER_HOD, HOLDER_EITHER)

AGE_BANDS = (
    ("under_1d", "Under 1 day"),
    ("1_3d", "1 to 3 days"),
    ("3_7d", "3 to 7 days"),
    ("over_7d", "7 days or more"),
)
#: How long decided requests took, in seconds: (key, label, lower edge, upper edge); the lower edge is included.
DECISION_BANDS = (
    ("under_1h", "Under 1 hour", 0, 3600),
    ("1_4h", "1 to 4 hours", 3600, 4 * 3600),
    ("4_24h", "4 to 24 hours", 4 * 3600, 24 * 3600),
    ("1_3d", "1 to 3 days", 24 * 3600, 72 * 3600),
    ("over_3d", "3 days or more", 72 * 3600, None),
)
SLA_SECONDS = SLA_HOURS * 3600
BY_CHOICES = ("kind", "department", "unit", "type")

IST_NAME = FACTORY_TZ.key  # "Asia/Kolkata": a constant, written into the SQL below


def now_utc() -> datetime:
    """The instant ages are measured to (aware, UTC). Tests freeze it by patching this."""
    return timezone.now()


# ─── small text helpers ──────────────────────────────────────────────────────────────────────────────────────────────


def _num(value: float | int | None, places: int = 0) -> str:
    """12,34,567 (Indian grouping), because text built here is read by the MD as it is."""
    if value is None:
        return "n/a"
    number = round(float(value), places)
    whole, _, frac = f"{abs(number):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{'-' if number < 0 else ''}{whole}{'.' + frac if frac else ''}"


def _p(value: float | None, places: int = 0) -> str:
    return "n/a" if value is None else f"{_num(value, places)}%"


def _inr(value: float | None) -> str:
    return "n/a" if value is None else f"₹{_num(value)}"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _dur(hours: float | None) -> str:
    """A length of time in the words the MD would use: "20 minutes", "5.5 hours", "3 days"."""
    if hours is None:
        return "n/a"
    if hours < 1:
        minutes = max(1, round(hours * 60)) if hours > 0 else 0
        return f"{minutes} {_plural(minutes, 'minute')}"
    if hours < 48:
        value = round(hours, 1)
        text = f"{value:g}"
        return f"{text} {'hour' if value == 1 else 'hours'}"
    days = round(hours / 24, 1)
    text = f"{days:g}"
    return f"{text} {'day' if days == 1 else 'days'}"


def _int_arg(value, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high] when given, a readable error when it
    is not a number."""
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def _float_arg(value, name: str, default: float, low: float, high: float) -> float:
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a number between {low:g} and {high:g}.") from None
    return max(low, min(high, number))


def _hours(seconds: Any) -> float | None:
    return None if seconds is None else round(float(seconds) / 3600.0, 2)


def _stamp(value: datetime | None) -> str | None:
    """An aware timestamp as the factory's wall clock, naive ISO ("2026-10-05T10:42:10")."""
    if value is None:
        return None
    return value.astimezone(FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def _age_hours(now: datetime, created: datetime | None) -> float | None:
    if created is None:
        return None
    return round(max(0.0, (now - created).total_seconds()) / 3600.0, 1)


def _bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """[first day 00:00 IST, day after the last day 00:00 IST): the instants an aware timestamp is filtered on."""
    return (
        datetime.combine(start, time.min, tzinfo=FACTORY_TZ),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=FACTORY_TZ),
    )


def _person(first: Any, last: Any) -> str:
    return f"{first or ''} {last or ''}".strip()


# ─── the approval kinds ──────────────────────────────────────────────────────────────────────────────────────────────


class _TrailText(Func):
    """One field of the LAST entry of ``approval_trail`` (a jsonb array of decisions) as text: the decision that put the
    request where it is. NULL when the request has no trail (made before the pipeline existed)."""

    template = "((%(expressions)s) -> -1 ->> '%(key)s')"
    output_field = TextField()


def _trail(key: str) -> _TrailText:
    return _TrailText(F("approval_trail"), key=key)


def _trail_time() -> Cast:
    return Cast(_trail("at"), DateTimeField())


_NO_TIME = Value(None, output_field=DateTimeField())
_NO_TEXT = Value(None, output_field=TextField())
_MONEY = DecimalField(max_digits=14, decimal_places=2)


@dataclass(frozen=True)
class Kind:
    key: str
    label: str
    model: type
    workflow: str  # the approval_workflow pipeline that decides it
    waiting: tuple[str, ...]
    approved: tuple[str, ...]
    rejected: tuple[str, ...]
    #: Employee-raised kinds count towards "asks a lot"; HR-raised ones (corrections, advances) do not.
    raised_by: str = "employee"
    on_page: bool = False  # listed on the HR Requests page
    extra: tuple[tuple[str, Any], ...] = ()  # a fixed filter (employee-requested outpasses only)
    has_trail: bool = True
    #: Review-stamp columns of requests decided before the trail existed, in order of preference.
    decided_columns: tuple[str, ...] = ()
    #: Who decided, for requests with no trail: columns in order of preference, and the legacy role column.
    approver_columns: tuple[str, ...] = ()
    role_column: str | None = None
    #: Statuses that mean "the Department Head has approved" on a request with no trail (the engine's legacy rule).
    legacy_hod_done: tuple[str, ...] = ()
    amount_field: str | None = None
    decided_extra: Callable[[], Any] | None = None

    @property
    def decided_statuses(self) -> tuple[str, ...]:
        return (*self.approved, *self.rejected)

    def decided_time(self):
        """The instant the request was decided (NULL while it waits, and for a decision whose time was never kept)."""
        parts: list[Any] = []
        if self.has_trail:
            parts.append(_trail_time())
        parts.extend(F(c) for c in self.decided_columns)
        if self.decided_extra:
            parts.append(self.decided_extra())
        expr = parts[0] if len(parts) == 1 else Coalesce(*parts, output_field=DateTimeField())
        return Case(When(status__in=self.decided_statuses, then=expr), default=_NO_TIME, output_field=DateTimeField())

    def outcome(self):
        return Case(
            When(status__in=self.waiting, then=Value("waiting")),
            When(status__in=self.approved, then=Value("approved")),
            When(status__in=self.rejected, then=Value("rejected")),
            default=Value("other"),
            output_field=CharField(),
        )

    def _role_flag(self, role: str):
        if not self.has_trail:
            return Value(False, output_field=BooleanField())
        return Case(
            When(approval_trail__contains=[{"role": role, "decision": "approved"}], then=Value(True)),
            default=Value(False),
            output_field=BooleanField(),
        )

    def approver(self):
        parts: list[Any] = [_trail("by")] if self.has_trail else []
        parts.extend(F(c) for c in self.approver_columns)
        return parts[0] if len(parts) == 1 else Coalesce(*parts, output_field=TextField())

    def approver_role(self):
        parts: list[Any] = [_trail("role")] if self.has_trail else []
        if self.role_column:
            parts.append(
                Case(
                    When(**{self.role_column: "dept_head"}, then=Value("hod")),
                    When(**{self.role_column: "hr"}, then=Value("hr")),
                    default=_NO_TEXT,
                    output_field=TextField(),
                )
            )
        if not parts:
            return _NO_TEXT
        return parts[0] if len(parts) == 1 else Coalesce(*parts, output_field=TextField())

    def branch(self, scope: Scope, mode: str, lo: datetime | None, hi: datetime | None) -> QuerySet:
        """This kind's requests for the people in scope, as the one column list every kind shares (see COLUMNS)."""
        qs = self.model.objects.filter(scope.employee_q("employee__"), **dict(self.extra))
        if mode == "waiting":
            qs = qs.filter(status__in=self.waiting)
        elif mode == "submitted":
            qs = qs.filter(created_at__gte=lo, created_at__lt=hi)
        elif mode == "decided":
            qs = qs.filter(status__in=self.decided_statuses).alias(r_when=self.decided_time())
            qs = qs.filter(r_when__gte=lo, r_when__lt=hi)
        else:  # pragma: no cover - a programming error
            raise ValueError(mode)
        amount = (
            Cast(F(self.amount_field), _MONEY) if self.amount_field else Cast(Value(None), _MONEY)  # keeps the UNION typed
        )
        return qs.order_by().values(
            f_kind=Value(self.key, output_field=CharField()),
            f_id=F("id"),
            f_employee=F("employee_id"),
            f_created=F("created_at"),
            f_decided=self.decided_time(),
            f_outcome=self.outcome(),
            f_status=F("status"),
            f_hod=self._role_flag(approval.HOD),
            f_hr=self._role_flag(approval.HR),
            f_notrail=(
                Case(When(approval_trail__isnull=True, then=Value(True)), default=Value(False), output_field=BooleanField())
                if self.has_trail
                else Value(True, output_field=BooleanField())
            ),
            f_amount=amount,
            f_dept=F("employee__department__name"),
            f_unit=F("employee__branch__name"),
            f_type=F("employee__employment_type"),
            f_first=F("employee__first_name"),
            f_last=F("employee__last_name"),
            f_code=F("employee__employee_code"),
            f_approver=self.approver(),
            f_arole=self.approver_role(),
        )


def _resignation_time():
    """A resignation decided before the trail existed: HR's approval stamp, or the Department Head's when he rejected it."""
    return Case(
        When(status="approved", then=F("approved_at")),
        When(Q(status="rejected", rejected_by="dept_head"), then=F("dept_head_approved_at")),
        default=_NO_TIME,
        output_field=DateTimeField(),
    )


def _advance_time():
    """Advances have no trail: the approval stamp, and for a rejected one the last time the row was saved."""
    return Case(
        When(status__in=("approved", "closed"), then=F("approved_at")),
        default=F("updated_at"),
        output_field=DateTimeField(),
    )


KINDS: tuple[Kind, ...] = (
    Kind(
        "leave",
        "Leave",
        LeaveRequest,
        "leave",
        ("pending",),
        ("approved",),
        ("rejected",),
        on_page=True,
        approver_columns=("approved_by",),
        role_column="approver_role",
    ),
    Kind(
        "permission",
        "Permission",
        EmployeePermission,
        "permission",
        ("pending",),
        ("approved",),
        ("rejected",),
        on_page=True,
        approver_columns=("approved_by",),
        role_column="approver_role",
    ),
    Kind(
        "casual_leave",
        "Casual leave",
        CasualLeaveRequest,
        "casual_leave",
        ("pending",),
        ("approved",),
        ("rejected",),
        decided_columns=("reviewed_at",),
        approver_columns=("reviewed_by",),
        role_column="reviewer_role",
    ),
    Kind(
        "outpass",
        "Outpass",
        OutpassRequest,
        "outpass",
        ("pending",),
        ("approved",),
        ("rejected",),
        on_page=True,
        extra=(("source", "manual"),),  # an on-duty pass is born approved: not a request anybody decided
        decided_columns=("approved_at",),
        approver_columns=("approved_by",),
        role_column="approver_role",
    ),
    Kind(
        "missing_punch",
        "Missing punch",
        MissingPunchRequest,
        "missing_punch",
        ("pending_hod", "pending_hr"),
        ("approved",),
        ("rejected",),
        decided_columns=("hr_reviewed_at", "hod_reviewed_at"),
        approver_columns=("hr_reviewed_by", "hod_reviewed_by"),
        legacy_hod_done=("pending_hr",),
    ),
    Kind(
        "on_duty",
        "On-duty",
        OnDutySession,
        "on_duty",
        ("pending_hod", "pending_hr"),
        ("active", "completed"),  # approved sessions go on to be active, then completed
        ("rejected",),
        decided_columns=("hr_reviewed_at", "hod_reviewed_at"),
        approver_columns=("hr_reviewed_by", "hod_reviewed_by"),
        legacy_hod_done=("pending_hr",),
    ),
    Kind(
        "resignation",
        "Resignation",
        ResignationRequest,
        "resignation",
        ("pending", "dept_approved"),
        ("approved",),
        ("rejected",),
        approver_columns=("approved_by",),
        legacy_hod_done=("dept_approved",),
        decided_extra=_resignation_time,
    ),
    Kind(
        "attendance_correction",
        "Attendance correction",
        AttendanceOverrideRequest,
        "attendance_correction",
        ("pending",),
        ("approved",),
        ("rejected",),
        raised_by="hr",
        decided_columns=("reviewed_at",),
        approver_columns=("reviewed_by",),
    ),
    Kind(
        "advance",
        "Advance",
        Advance,
        "advance",
        ("pending",),
        ("approved", "closed"),  # a closed advance was approved and has been repaid in full
        ("rejected",),
        raised_by="hr",
        has_trail=False,
        approver_columns=("approved_by",),
        amount_field="amount",
        decided_extra=_advance_time,
    ),
)
KIND_BY_KEY = {k.key: k for k in KINDS}
KIND_KEYS = tuple(KIND_BY_KEY)
PAGE_KEYS = tuple(k.key for k in KINDS if k.on_page)
EMPLOYEE_RAISED_KEYS = tuple(k.key for k in KINDS if k.raised_by == "employee")


def kind_keys(kind: str | None) -> tuple[str, ...]:
    """The kinds a request asks for: ``all`` (default), ``page`` (the three on the HR Requests page), one kind, or a
    comma-separated list, always in the registry's order."""
    text = (kind or "all").strip().lower().replace("-", "_").replace(" ", "")
    if text in ("", "all"):
        return KIND_KEYS
    if text == "page":
        return PAGE_KEYS
    wanted = [part for part in text.split(",") if part]
    unknown = [w for w in wanted if w not in KIND_BY_KEY]
    if unknown or not wanted:
        raise MdParamError(
            f"'kind' must be all, page, or one or more of: {', '.join(KIND_KEYS)}"
            + (f" (not '{unknown[0]}')." if unknown else ".")
        )
    return tuple(k for k in KIND_KEYS if k in wanted)


def kind_text(keys: tuple[str, ...]) -> str:
    if keys == KIND_KEYS:
        return "All requests"
    if keys == PAGE_KEYS:
        return "Leave, permission and outpass (as on the Requests page)"
    return ", ".join(KIND_BY_KEY[k].label for k in keys)


def _kinds_meta(keys: tuple[str, ...]) -> list[dict]:
    return [
        {"key": k, "label": KIND_BY_KEY[k].label, "onRequestsPage": KIND_BY_KEY[k].on_page} for k in keys
    ]


# ─── the one relation every analysis reads ───────────────────────────────────────────────────────────────────────────

#: The columns of every kind's branch, in this order. UNION ALL is positional, so each branch is re-selected by name.
COLUMNS = (
    "f_kind",
    "f_id",
    "f_employee",
    "f_created",
    "f_decided",
    "f_outcome",
    "f_status",
    "f_hod",
    "f_hr",
    "f_notrail",
    "f_amount",
    "f_dept",
    "f_unit",
    "f_type",
    "f_first",
    "f_last",
    "f_code",
    "f_approver",
    "f_arole",
)
_SELECT_COLUMNS = ", ".join(f'"{c}"' for c in COLUMNS)

#: Seconds from submission to decision (never negative, whatever the clocks said).
SECS = "GREATEST(EXTRACT(EPOCH FROM (f.f_decided - f.f_created)), 0)::double precision"

#: How a request is grouped: SQL over the relation (alias ``f``).
DIMS = {
    "kind": "f.f_kind",
    "department": "COALESCE(f.f_dept, '')",
    "unit": "COALESCE(f.f_unit, '')",
    "type": "COALESCE(f.f_type, '')",
}


def _source(keys: tuple[str, ...], scope: Scope, mode: str, lo: datetime | None = None, hi: datetime | None = None):
    """``(sql, params)`` of the UNION ALL of the chosen kinds: ``waiting`` (undecided now, any date), ``submitted``
    (created in [lo, hi)) or ``decided`` (decided in [lo, hi))."""
    parts: list[str] = []
    params: list[Any] = []
    for key in keys:
        sql, branch_params = KIND_BY_KEY[key].branch(scope, mode, lo, hi).query.sql_with_params()
        parts.append(f"SELECT {_SELECT_COLUMNS} FROM ({sql}) AS t_{key}")
        params.extend(branch_params)
    return " UNION ALL ".join(parts), params


def _run(select: str, source: tuple[str, list], *, select_params=(), tail: str = "", tail_params=()) -> list[dict]:
    """Run ``select ... FROM (<union>) f <tail>``. Placeholders must appear in the order select list, source, tail."""
    sql, src_params = source
    statement = f"{select} FROM ({sql}) AS f {tail}"
    with connection.cursor() as cursor:
        cursor.execute(statement, [*select_params, *src_params, *tail_params])
        names = [c[0] for c in cursor.description]
        return [dict(zip(names, row)) for row in cursor.fetchall()]


# ─── who a waiting request waits on (the approval engine's own rules) ────────────────────────────────────────────────


def _approved_roles(kind: Kind, status: str, hod: bool, hr: bool, notrail: bool) -> set[str]:
    if not kind.has_trail:
        return set()
    if notrail:  # made before the trail existed: the status says whether the Department Head has approved
        return {approval.HOD} if status in kind.legacy_hod_done else set()
    return ({approval.HOD} if hod else set()) | ({approval.HR} if hr else set())


def _holder(kind_key: str, status: str, hod: bool, hr: bool, notrail: bool) -> tuple[str, bool]:
    """(who it waits on, whether the MD can decide it now) under the pipeline in force today."""
    kind = KIND_BY_KEY[kind_key]
    config = approval.get_config(kind.workflow)
    approved = _approved_roles(kind, status, hod, hr, notrail)
    roles = approval.holding_roles(config.steps, approved)
    holder = HOLDER_EITHER if len(roles) > 1 else (HOLDER_HR if roles[0] == approval.HR else HOLDER_HOD)
    defn = approval.definition(kind.workflow)
    md_can = approval.check_can_act(config.steps, approved, approval.HR, "approved", defn.early_reject_roles)[0]
    return holder, md_can


def _bucket_counts(row: dict) -> list[int]:
    return [int(row["b0"] or 0), int(row["b1"] or 0), int(row["b2"] or 0), int(row["b3"] or 0)]


@cached(20)
def _waiting_table(scope: Scope, kind: str = "all") -> dict:
    """Every request waiting now, grouped by kind, department and who it waits on, with its age bands. ONE query; every
    other waiting figure is a sum over these rows, so they can never disagree. Carries the ``now`` it was made at."""
    keys = kind_keys(kind)
    now = now_utc()
    e1, e3, e7 = (now - timedelta(hours=h) for h in AGE_EDGES_HOURS)
    select = """SELECT f.f_kind AS kind, COALESCE(f.f_dept, '') AS dept, f.f_status AS status, f.f_hod AS hod,
        f.f_hr AS hr, f.f_notrail AS notrail, COUNT(*) AS n, MIN(f.f_created) AS oldest,
        COUNT(*) FILTER (WHERE f.f_created > %s) AS b0,
        COUNT(*) FILTER (WHERE f.f_created <= %s AND f.f_created > %s) AS b1,
        COUNT(*) FILTER (WHERE f.f_created <= %s AND f.f_created > %s) AS b2,
        COUNT(*) FILTER (WHERE f.f_created <= %s) AS b3,
        COALESCE(SUM(f.f_amount), 0) AS amount"""
    raw = _run(
        select,
        _source(keys, scope, "waiting"),
        select_params=[e1, e1, e3, e3, e7, e7],
        tail="GROUP BY f.f_kind, COALESCE(f.f_dept, ''), f.f_status, f.f_hod, f.f_hr, f.f_notrail",
    )
    merged: dict[tuple, dict] = {}
    for r in raw:
        holder, md_can = _holder(r["kind"], r["status"], bool(r["hod"]), bool(r["hr"]), bool(r["notrail"]))
        slot = merged.setdefault(
            (r["kind"], r["dept"], holder, md_can),
            {
                "kind": r["kind"],
                "dept": r["dept"],
                "holder": holder,
                "mdCan": md_can,
                "n": 0,
                "oldest": None,
                "b": [0, 0, 0, 0],
                "amount": 0.0,
            },
        )
        slot["n"] += int(r["n"])
        slot["oldest"] = r["oldest"] if slot["oldest"] is None else min(slot["oldest"], r["oldest"])
        slot["b"] = [a + b for a, b in zip(slot["b"], _bucket_counts(r))]
        slot["amount"] += float(r["amount"] or 0)
    return {"now": now, "keys": keys, "rows": list(merged.values())}


def _sum_rows(rows: list[dict]) -> dict:
    b = [0, 0, 0, 0]
    oldest = None
    for r in rows:
        b = [x + y for x, y in zip(b, r["b"])]
        if r["oldest"] is not None and (oldest is None or r["oldest"] < oldest):
            oldest = r["oldest"]
    return {
        "n": sum(r["n"] for r in rows),
        "b": b,
        "aged": b[2] + b[3],
        "stale": b[3],
        "oldest": oldest,
        "amount": sum(r["amount"] for r in rows),
    }


def _bucket_list(b: list[int]) -> list[dict]:
    return [{"key": key, "label": label, "count": b[i]} for i, (key, label) in enumerate(AGE_BANDS)]


def _waiting_block(table: dict) -> dict:
    """The waiting figures of the summary, from the table."""
    rows, now = table["rows"], table["now"]
    total = _sum_rows(rows)
    by_holder = {h: _sum_rows([r for r in rows if r["holder"] == h]) for h in HOLDERS}
    aged_by_kind = {k: _sum_rows([r for r in rows if r["kind"] == k]) for k in table["keys"]}
    return {
        "total": total["n"],
        "oldestHours": _age_hours(now, total["oldest"]),
        "oldestDays": None if total["oldest"] is None else round(_age_hours(now, total["oldest"]) / 24, 1),
        "agedDays": AGED_DAYS,
        "threeDaysPlus": total["aged"],
        "sevenDaysPlus": total["stale"],
        "withHr": by_holder[HOLDER_HR]["n"],
        "withDepartmentHead": by_holder[HOLDER_HOD]["n"],
        "withEither": by_holder[HOLDER_EITHER]["n"],
        "mdCanDecide": sum(r["n"] for r in rows if r["mdCan"]),
        "advanceAmount": round(sum(r["amount"] for r in rows if r["kind"] == "advance"), 2),
        "buckets": _bucket_list(total["b"]),
        "oldestKind": _oldest_kind(rows),
        "agedByKind": {k: v["aged"] for k, v in aged_by_kind.items() if v["aged"]},
    }


def _oldest_kind(rows: list[dict]) -> str | None:
    dated = [r for r in rows if r["oldest"] is not None]
    return min(dated, key=lambda r: r["oldest"])["kind"] if dated else None


# ─── the decided and submitted figures ───────────────────────────────────────────────────────────────────────────────

_DECIDED_SELECT = f"""COUNT(*) AS n,
        COUNT(*) FILTER (WHERE f.f_outcome = 'approved') AS approved,
        COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') AS rejected,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {SECS}) AS median,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY {SECS}) AS p90,
        COUNT(*) FILTER (WHERE {SECS} < {SLA_SECONDS}) AS within_day,
        {
    ", ".join(
        f"COUNT(*) FILTER (WHERE {SECS} >= {lo}" + (f" AND {SECS} < {hi}" if hi is not None else "") + f") AS d{i}"
        for i, (_, _, lo, hi) in enumerate(DECISION_BANDS)
    )
}"""


def _decided_stats(scope: Scope, keys: tuple[str, ...], lo: datetime, hi: datetime, group: str | None):
    """Requests decided in [lo, hi): how many, approved, rejected, median and 90th percentile seconds, how many within
    SLA_HOURS and the decision-time bands. ``group`` is a DIMS expression (rows keyed by its value) or None (one dict)."""
    source = _source(keys, scope, "decided", lo, hi)
    if group is None:
        rows = _run(f"SELECT {_DECIDED_SELECT}", source)
        return rows[0]
    rows = _run(f"SELECT {group} AS g, {_DECIDED_SELECT}", source, tail=f"GROUP BY {group}")
    return {r["g"]: r for r in rows}


def _submitted_stats(scope: Scope, keys: tuple[str, ...], lo: datetime, hi: datetime, group: str | None):
    """Requests created in [lo, hi): how many, by what became of them, how many people, and how many were decided
    without any decision time on record."""
    select = """COUNT(*) AS n,
        COUNT(*) FILTER (WHERE f.f_outcome = 'waiting') AS waiting,
        COUNT(*) FILTER (WHERE f.f_outcome = 'approved') AS approved,
        COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') AS rejected,
        COUNT(DISTINCT f.f_employee) AS people,
        COUNT(*) FILTER (WHERE f.f_outcome IN ('approved', 'rejected') AND f.f_decided IS NULL) AS no_time"""
    source = _source(keys, scope, "submitted", lo, hi)
    if group is None:
        return _run(f"SELECT {select}", source)[0]
    rows = _run(f"SELECT {group} AS g, {select}", source, tail=f"GROUP BY {group}")
    return {r["g"]: r for r in rows}


def _waiting_by(scope: Scope, keys: tuple[str, ...], group: str, now: datetime) -> dict:
    """Waiting requests per group: how many, how many have waited AGED_DAYS or more, the oldest."""
    aged_edge = now - timedelta(hours=AGE_EDGES_HOURS[1])
    rows = _run(
        f"SELECT {group} AS g, COUNT(*) AS n, COUNT(*) FILTER (WHERE f.f_created <= %s) AS aged, "
        "MIN(f.f_created) AS oldest",
        _source(keys, scope, "waiting"),
        select_params=[aged_edge],
        tail=f"GROUP BY {group}",
    )
    return {r["g"]: r for r in rows}


def _band_list(raw: dict) -> list[dict]:
    total = int(raw["n"] or 0)
    return [
        {"key": key, "label": label, "count": int(raw[f"d{i}"] or 0), "pct": pct(int(raw[f"d{i}"] or 0), total)}
        for i, (key, label, _, _) in enumerate(DECISION_BANDS)
    ]


def _fig(raw: dict | None) -> dict:
    """The decided figures of one group as the response shows them."""
    raw = raw or {}
    n = int(raw.get("n") or 0)
    approved, rejected = int(raw.get("approved") or 0), int(raw.get("rejected") or 0)
    return {
        "decided": n,
        "approved": approved,
        "rejected": rejected,
        "approvalPct": pct(approved, n),
        "rejectionPct": pct(rejected, n),
        "medianHours": _hours(raw.get("median")),
        "p90Hours": _hours(raw.get("p90")),
        "withinDayPct": pct(int(raw.get("within_day") or 0), n),
    }


def _metric(cur, prev) -> dict:
    return {"value": cur, "previous": prev, "change": change(cur, prev)}


# ─── provenance ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _provenance(
    scope: Scope, period: Period | None, keys: tuple[str, ...], *, rows: dict[str, int | None] | None = None
) -> dict[str, dict]:
    rows = rows or {}
    where = [kind_text(keys), scope.describe()]
    when = [period.label] if period else []
    datasets = "Leave, permission, casual leave, outpass, missing punch, on-duty, resignation, attendance correction and advance requests"
    mix = (
        "Counted: " + ", ".join(KIND_BY_KEY[k].label.lower() for k in keys) + ". General 'other requests' tickets are not "
        "approvals and are left out. The HR Requests page lists leave, permission and employee-requested outpasses."
    )

    def entry(id_, title, definition, formula=None, *, filters=None, caveats=(), n=None):
        return prov(
            id_,
            title,
            dataset=datasets,
            definition=definition,
            formula=formula,
            rows=rows.get(n) if n else None,
            filters=filters if filters is not None else [*when, *where],
            caveats=caveats,
        )

    return {
        "requests-kinds": entry(
            "requests-kinds",
            "Which requests are counted",
            mix,
            filters=where,
            caveats=["An outpass created by an approved on-duty trip is not a request anyone decided: it is left out."],
        ),
        "requests-waiting": entry(
            "requests-waiting",
            "Requests waiting",
            "Requests nobody has decided yet, as of now and across all dates (a request that has waited three weeks is "
            "the worst case, so the period filter does not hide it). A request that one approver has passed on but "
            "that still needs another is still waiting.",
            "count of requests whose status is still pending (pending, pending_hod, pending_hr or dept_approved)",
            filters=where,
            n="waiting",
        ),
        "requests-aging": entry(
            "requests-aging",
            "How long they have waited",
            f"Age = now minus the time the request was submitted, in calendar time. Bands: under 1 day, 1 to 3 days, 3 to "
            f"7 days, 7 days or more (a request exactly {AGED_DAYS} days old is in '3 to 7 days'). 'Old' means "
            f"{AGED_DAYS} days or more.",
            "now − submitted",
            filters=where,
            n="waiting",
        ),
        "requests-holder": entry(
            "requests-holder",
            "Who they are waiting on",
            "Worked out with the approval engine the HR pages use: the pipeline in force today plus the approvals "
            "already recorded on the request. HR, the Department Head, or either. The MD decides as HR does, so a "
            "request waiting on HR or on 'either' is one the MD can decide now; one waiting only on a Department "
            "Head is not.",
            filters=where,
            caveats=[
                "If HR changes a pipeline in Approval Workflow Control, requests already waiting follow the new one "
                "from where they have got to."
            ],
            n="waiting",
        ),
        "requests-submitted": entry(
            "requests-submitted",
            "Requests submitted",
            "Requests created in the period, counted on the Indian-time day they were made.",
            "count of requests with created time in the period",
            n="submitted",
        ),
        "requests-decided": entry(
            "requests-decided",
            "Requests decided",
            "Requests approved or rejected in the period, counted on the day of the decision (not the day they were "
            "made). An approval that only passes a request to the next approver does not count: the request is still "
            "waiting.",
            "count of requests whose final decision time is in the period",
            caveats=[
                "The decision time is the last entry of the request's approval trail, or the review stamp older "
                "requests carry. A request decided before either existed has no decision time and is not counted here."
            ],
            n="decided",
        ),
        "requests-approval": entry(
            "requests-approval",
            "Approval and rejection rates",
            "Of the requests decided in the period, the share approved and the share rejected.",
            "approved ÷ decided; rejected ÷ decided",
            n="decided",
        ),
        "requests-turnaround": entry(
            "requests-turnaround",
            "Time to decide",
            "From the moment the request was submitted to the moment of its final decision, in calendar hours (nights and "
            "Sundays included). The median is the typical request; the 90th percentile is the time within which 9 in "
            f"10 were decided. 'Within a day' means under {SLA_HOURS} hours.",
            "decision time − submission time; median and 90th percentile (continuous)",
            caveats=["Requests still waiting are not in it, so a long queue does not show up as a long time to decide."],
            n="decided",
        ),
        "requests-previous": entry(
            "requests-previous",
            "Comparison with the previous period",
            "The same figure for the period of the same length that ends the day before this one starts. Waiting now has no "
            "comparison: it is a snapshot, and the past queue cannot be rebuilt reliably.",
        ),
        "requests-bottleneck": entry(
            "requests-bottleneck",
            "Where requests get stuck",
            "Departments are ranked by how many of their employees' requests have waited 3 days or more, and show how many "
            "are blocked only on the Department Head. Approvers are ranked by their median time to decide the requests "
            f"they decided in the period (with fewer than {MIN_GROUP_DECIDED} decisions the figure is marked small sample).",
            caveats=[
                "A department is the department the employee belongs to today. A department with the same name in "
                "several units is one department.",
                "Who decided is read from the approval trail; older requests may not record the approver.",
            ],
        ),
        "requests-unusual": entry(
            "requests-unusual",
            "Unusual requests",
            f"Employees with {REPEAT_MIN_REQUESTS} or more requests of their own in the period (HR-raised corrections and "
            f"advances are not counted), employees with {REPEAT_MIN_REJECTIONS} or more rejections, and advances of "
            f"{_inr(LARGE_ADVANCE_AMOUNT)} or more.",
            caveats=[
                "These are rules of thumb: the system has no limit on how many requests a person may make or how large "
                "an advance may be."
            ],
            n="submitted",
        ),
    }


def _pick(entries: dict[str, dict], *ids: str) -> list[dict]:
    return [entries[i] for i in ids]


def _notes(no_time: int, period: Period | None = None) -> list[str]:
    if no_time <= 0:
        return []
    return [
        f"{_num(no_time)} {_plural(no_time, 'request')} made in this period {_plural(no_time, 'was', 'were')} decided "
        "before decision times were kept, so they are left out of the decided figures and the times to decide."
    ]


# ─── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def _vs(cur: int, prev: int, phrase: str) -> str:
    if prev == 0:
        return f"none in {phrase}" if cur else ""
    delta = (cur - prev) / prev * 100
    if abs(delta) < 0.5:
        return f"the same as {phrase}"
    return f"{'up' if delta > 0 else 'down'} {_p(abs(delta))} on {phrase}"


def _previous_phrase(period: Period) -> str:
    if period.days == 1:
        return "the day before"
    if period.days == 7:
        return "the 7 days before"
    return f"the previous {period.days} days"


def _briefing(
    waiting: dict, cur: dict, prev: dict, submitted_cur: int, submitted_prev: int, period: Period, top_dept: str | None
) -> dict:
    """Two to four plain sentences, every figure taken from the same answer (no AI: fixed rules)."""
    sentences: list[dict] = []
    total = waiting["total"]
    if total == 0:
        sentences.append({"id": "waiting", "tone": "good", "text": "Nothing is waiting for a decision right now."})
    else:
        parts = []
        if waiting["withHr"]:
            parts.append(f"{_num(waiting['withHr'])} with HR")
        if waiting["withDepartmentHead"]:
            parts.append(f"{_num(waiting['withDepartmentHead'])} with Department Heads")
        if waiting["withEither"]:
            parts.append(f"{_num(waiting['withEither'])} that HR or the Department Head can decide")
        where = " and ".join([", ".join(parts[:-1]), parts[-1]] if len(parts) > 1 else parts)
        text = (
            f"{_num(total)} {_plural(total, 'request is', 'requests are')} waiting for a decision: {where}. "
            f"You can decide {_num(waiting['mdCanDecide'])} of them now."
        )
        sentences.append({"id": "waiting", "tone": "neutral", "text": text})
        aged = waiting["threeDaysPlus"]
        if aged:
            kind = KIND_BY_KEY.get(waiting["oldestKind"] or "")
            oldest = f", the oldest {_dur(waiting['oldestHours'])}" + (f" ({kind.label.lower()})" if kind else "")
            text = f"{_num(aged)} {_plural(aged, 'has', 'have')} waited {AGED_DAYS} days or more{oldest}."
            if top_dept:
                text += f" {top_dept} has the most."
            sentences.append({"id": "aged", "tone": "watch", "text": text})
        else:
            sentences.append(
                {"id": "aged", "tone": "good", "text": f"None has waited {AGED_DAYS} days; the oldest is "
                 f"{_dur(waiting['oldestHours'])}."}
            )
    decided = cur["decided"]
    versus = _vs(submitted_cur, submitted_prev, _previous_phrase(period))
    flow = f"{period.label}: {_num(submitted_cur)} {_plural(submitted_cur, 'request was', 'requests were')} submitted"
    flow += f" ({versus})" if versus else ""
    if decided:
        flow += f" and {_num(decided)} decided, {_p(cur['approvalPct'])} of them approved."
    else:
        flow += " and none was decided."
    sentences.append({"id": "flow", "tone": "neutral", "text": flow})
    if decided and cur["medianHours"] is not None:
        slow = cur["medianHours"] > SLA_HOURS
        text = (
            f"A typical request is decided in {_dur(cur['medianHours'])}; 9 in 10 are decided within "
            f"{_dur(cur['p90Hours'])}."
        )
        sentences.append({"id": "speed", "tone": "watch" if slow else "good", "text": text})
    return {
        "sentences": sentences,
        "ask": f"Brief me on requests ({period.label}): what is waiting and with whom, who is holding things up, and how "
        "fast requests are decided.",
    }


@cached()
def requests_summary(scope: Scope, period: Period, kind: str = "all") -> dict:
    """The headline answer: waiting now (by age and by who they wait on), submitted, decided, approval and rejection
    rates and the time to decide, each against the previous period, and the plain-English briefing."""
    keys = kind_keys(kind)
    previous = period.previous()
    table = _waiting_table(scope, kind)
    waiting = _waiting_block(table)
    lo, hi = _bounds(period.start, period.end)
    plo, phi = _bounds(previous.start, previous.end)
    sub_cur, sub_prev = _submitted_stats(scope, keys, lo, hi, None), _submitted_stats(scope, keys, plo, phi, None)
    cur_raw, prev_raw = _decided_stats(scope, keys, lo, hi, None), _decided_stats(scope, keys, plo, phi, None)
    cur, prev = _fig(cur_raw), _fig(prev_raw)

    metrics = {
        "submitted": _metric(int(sub_cur["n"]), int(sub_prev["n"])),
        "decided": _metric(cur["decided"], prev["decided"]),
        "approved": _metric(cur["approved"], prev["approved"]),
        "rejected": _metric(cur["rejected"], prev["rejected"]),
        "approvalPct": _metric(cur["approvalPct"], prev["approvalPct"]),
        "rejectionPct": _metric(cur["rejectionPct"], prev["rejectionPct"]),
        "medianHours": _metric(cur["medianHours"], prev["medianHours"]),
        "p90Hours": _metric(cur["p90Hours"], prev["p90Hours"]),
        "withinDayPct": _metric(cur["withinDayPct"], prev["withinDayPct"]),
    }
    dept_rows = [r for r in table["rows"] if r["dept"]]
    by_dept: dict[str, int] = {}
    for r in dept_rows:
        by_dept[r["dept"]] = by_dept.get(r["dept"], 0) + r["b"][2] + r["b"][3]
    top_dept = max(by_dept, key=lambda d: (by_dept[d], d)) if by_dept and max(by_dept.values()) else None
    briefing = _briefing(waiting, cur, prev, int(sub_cur["n"]), int(sub_prev["n"]), period, top_dept)

    entries = _provenance(
        scope,
        period,
        keys,
        rows={"waiting": waiting["total"], "submitted": int(sub_cur["n"]), "decided": cur["decided"]},
    )
    return envelope(
        {
            "kind": ",".join(keys) if keys not in (KIND_KEYS, PAGE_KEYS) else ("all" if keys == KIND_KEYS else "page"),
            "kindLabel": kind_text(keys),
            "kinds": _kinds_meta(keys),
            "waiting": waiting,
            "metrics": metrics,
            "previousPeriod": previous.to_json(),
            "slaHours": SLA_HOURS,
            "briefing": briefing,
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "requests-waiting",
            "requests-aging",
            "requests-holder",
            "requests-submitted",
            "requests-decided",
            "requests-approval",
            "requests-turnaround",
            "requests-previous",
            "requests-kinds",
        ),
        notes=_notes(int(sub_cur["no_time"]), period),
    )


# ─── waiting: how long, with whom, which ones ────────────────────────────────────────────────────────────────────────


@cached()
def requests_waiting(scope: Scope, kind: str = "all", limit: int = LIST_DEFAULT) -> dict:
    """Everything waiting now: by kind and by who it waits on, each in the four age bands, plus the oldest requests."""
    keys = kind_keys(kind)
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    table = _waiting_table(scope, kind)
    rows, now = table["rows"], table["now"]
    total = _sum_rows(rows)

    by_kind = []
    for key in keys:
        part = [r for r in rows if r["kind"] == key]
        if not part:
            continue
        s = _sum_rows(part)
        by_kind.append(
            {
                "key": key,
                "label": KIND_BY_KEY[key].label,
                "total": s["n"],
                "buckets": _bucket_list(s["b"]),
                "threeDaysPlus": s["aged"],
                "oldestHours": _age_hours(now, s["oldest"]),
                "withHr": sum(r["n"] for r in part if r["holder"] == HOLDER_HR),
                "withDepartmentHead": sum(r["n"] for r in part if r["holder"] == HOLDER_HOD),
                "withEither": sum(r["n"] for r in part if r["holder"] == HOLDER_EITHER),
            }
        )
    by_kind.sort(key=lambda r: (-r["total"], r["label"]))

    by_holder = []
    for h in HOLDERS:
        part = [r for r in rows if r["holder"] == h]
        s = _sum_rows(part)
        by_holder.append(
            {
                "key": h,
                "label": HOLDER_LABEL[h],
                "total": s["n"],
                "buckets": _bucket_list(s["b"]),
                "threeDaysPlus": s["aged"],
                "oldestHours": _age_hours(now, s["oldest"]),
                "mdCanDecide": sum(r["n"] for r in part if r["mdCan"]),
            }
        )

    select = """SELECT f.f_kind AS kind, f.f_id AS id, f.f_employee AS employee, f.f_first AS first, f.f_last AS last,
        f.f_code AS code, COALESCE(f.f_dept, '') AS dept, f.f_created AS created, f.f_status AS status,
        f.f_hod AS hod, f.f_hr AS hr, f.f_notrail AS notrail, f.f_amount AS amount"""
    oldest_rows = _run(
        select,
        _source(keys, scope, "waiting"),
        tail="ORDER BY f.f_created, f.f_kind, f.f_id LIMIT %s",
        tail_params=[limit],
    )
    oldest = []
    for r in oldest_rows:
        holder, md_can = _holder(r["kind"], r["status"], bool(r["hod"]), bool(r["hr"]), bool(r["notrail"]))
        age = _age_hours(now, r["created"])
        oldest.append(
            {
                "kind": r["kind"],
                "kindLabel": KIND_BY_KEY[r["kind"]].label,
                "id": r["id"],
                "employeeId": r["employee"],
                "employeeName": _person(r["first"], r["last"]),
                "code": r["code"],
                "department": r["dept"] or None,
                "submittedAt": _stamp(r["created"]),
                "ageHours": age,
                "band": AGE_BANDS[_band_index(age)][0],
                "holder": holder,
                "holderLabel": HOLDER_LABEL[holder],
                "mdCanDecide": md_can,
                "amount": None if r["amount"] is None else float(r["amount"]),
            }
        )

    entries = _provenance(scope, None, keys, rows={"waiting": total["n"]})
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "kinds": _kinds_meta(keys),
            "asOf": _stamp(now),
            "total": total["n"],
            "oldestHours": _age_hours(now, total["oldest"]),
            "threeDaysPlus": total["aged"],
            "buckets": _bucket_list(total["b"]),
            "mdCanDecide": sum(r["n"] for r in rows if r["mdCan"]),
            "byKind": by_kind,
            "byHolder": by_holder,
            "oldest": oldest,
            "truncated": total["n"] > len(oldest),
        },
        scope=scope,
        provenance=_pick(entries, "requests-waiting", "requests-aging", "requests-holder", "requests-kinds"),
        notes=[] if total["n"] else ["Nothing is waiting for a decision right now."],
    )


def _band_index(age_hours: float | None) -> int:
    if age_hours is None or age_hours < AGE_EDGES_HOURS[0]:
        return 0
    if age_hours < AGE_EDGES_HOURS[1]:
        return 1
    if age_hours < AGE_EDGES_HOURS[2]:
        return 2
    return 3


# ─── how fast requests are decided ───────────────────────────────────────────────────────────────────────────────────


def _label(by: str, key: Any) -> str:
    if by == "kind":
        return KIND_BY_KEY[key].label
    if by == "type":
        return {"staff": "Staff", "production": "Production"}.get(key, "Not set")
    if key in (None, ""):
        return "No department" if by == "department" else "No unit"
    return str(key)


@cached()
def requests_turnaround(scope: Scope, period: Period, kind: str = "all") -> dict:
    """Time to decide: overall and by kind (median and 90th percentile, share decided within a day), each against the
    previous period, and how the decisions spread over the decision-time bands."""
    keys = kind_keys(kind)
    previous = period.previous()
    lo, hi = _bounds(period.start, period.end)
    plo, phi = _bounds(previous.start, previous.end)
    overall_raw, prev_raw = _decided_stats(scope, keys, lo, hi, None), _decided_stats(scope, keys, plo, phi, None)
    by_kind_raw = _decided_stats(scope, keys, lo, hi, DIMS["kind"])
    by_kind_prev = _decided_stats(scope, keys, plo, phi, DIMS["kind"])
    overall, prev = _fig(overall_raw), _fig(prev_raw)

    rows = []
    for key in keys:
        if key not in by_kind_raw and key not in by_kind_prev:
            continue
        cur, old = _fig(by_kind_raw.get(key)), _fig(by_kind_prev.get(key))
        rows.append(
            {
                "key": key,
                "label": KIND_BY_KEY[key].label,
                **cur,
                "lowSample": cur["decided"] < MIN_GROUP_DECIDED,
                "previous": {k: old[k] for k in ("decided", "medianHours", "p90Hours", "withinDayPct")},
                "change": {
                    "medianHours": change(cur["medianHours"], old["medianHours"]),
                    "p90Hours": change(cur["p90Hours"], old["p90Hours"]),
                },
            }
        )
    rows.sort(key=lambda r: (r["medianHours"] is None, -(r["medianHours"] or 0), r["label"]))
    entries = _provenance(scope, period, keys, rows={"decided": overall["decided"]})
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "slaHours": SLA_HOURS,
            "minSample": MIN_GROUP_DECIDED,
            "overall": {**overall, "previous": prev, "change": {
                "medianHours": change(overall["medianHours"], prev["medianHours"]),
                "p90Hours": change(overall["p90Hours"], prev["p90Hours"]),
                "withinDayPct": change(overall["withinDayPct"], prev["withinDayPct"]),
            }},
            "byKind": rows,
            "bands": _band_list(overall_raw),
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "requests-decided", "requests-turnaround", "requests-previous"),
        notes=[] if overall["decided"] else [f"No request was decided {period.label.lower()}."],
    )


# ─── comparisons: by kind, department, unit, type ────────────────────────────────────────────────────────────────────


def _int(raw: dict | None, key: str) -> int:
    return int((raw or {}).get(key) or 0)


@cached()
def requests_breakdown(
    scope: Scope, period: Period, kind: str = "all", by: str = "kind", limit: int = LIST_DEFAULT
) -> dict:
    """Volume, decisions, approval and rejection rates, time to decide and what is waiting, per kind, department, unit
    or staff-vs-production. A department with the same name in several units is one department."""
    if by not in BY_CHOICES:
        raise MdParamError(f"'by' must be one of: {', '.join(BY_CHOICES)}.")
    keys = kind_keys(kind)
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    previous = period.previous()
    lo, hi = _bounds(period.start, period.end)
    plo, phi = _bounds(previous.start, previous.end)
    group = DIMS[by]
    sub_cur, sub_prev = _submitted_stats(scope, keys, lo, hi, group), _submitted_stats(scope, keys, plo, phi, group)
    decided = _decided_stats(scope, keys, lo, hi, group)
    table_now = now_utc()
    waiting = _waiting_by(scope, keys, group, table_now)
    total_sub = _submitted_stats(scope, keys, lo, hi, None)
    total_dec = _decided_stats(scope, keys, lo, hi, None)

    rows = []
    for g in set(sub_cur) | set(sub_prev) | set(decided) | set(waiting):
        fig = _fig(decided.get(g))
        n_now, n_prev = _int(sub_cur.get(g), "n"), _int(sub_prev.get(g), "n")
        w = waiting.get(g) or {}
        row = {
            "key": str(g) if g not in (None, "") else "__none__",
            "label": _label(by, g),
            "submitted": n_now,
            "people": _int(sub_cur.get(g), "people"),
            **fig,
            "waiting": _int(w, "n"),
            "threeDaysPlus": _int(w, "aged"),
            "oldestHours": _age_hours(table_now, w.get("oldest")),
            "lowSample": fig["decided"] < MIN_GROUP_DECIDED,
            "previous": {"submitted": n_prev},
            "change": {"submitted": change(n_now, n_prev)},
        }
        if by == "kind":
            row["onRequestsPage"] = KIND_BY_KEY[g].on_page
        rows.append(row)
    rows = [r for r in rows if r["submitted"] or r["decided"] or r["waiting"] or r["previous"]["submitted"]]
    rows.sort(key=lambda r: (-r["submitted"], -r["decided"], -r["waiting"], r["label"].lower()))
    overall = _fig(total_dec)
    entries = _provenance(scope, period, keys, rows={"submitted": _int(total_sub, "n"), "decided": overall["decided"]})
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "by": by,
            "rows": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
            "overall": {"submitted": _int(total_sub, "n"), **overall},
            "minSample": MIN_GROUP_DECIDED,
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries,
            "requests-submitted",
            "requests-decided",
            "requests-approval",
            "requests-turnaround",
            "requests-waiting",
        ),
        notes=_notes(_int(total_sub, "no_time"), period),
    )


# ─── trend: volume in, decisions out, speed over time ────────────────────────────────────────────────────────────────


def _bucket_expr(column: str) -> str:
    return f"(((f.{column} AT TIME ZONE '{IST_NAME}')::date - %s::date) / %s)"


@cached()
def requests_trend(scope: Scope, period: Period, kind: str = "all") -> dict:
    """Requests submitted (by kind, with the previous period beside it) and requests decided with the typical time to
    decide, by day (by week for periods over 62 days)."""
    keys = kind_keys(kind)
    previous = period.previous()
    step = 7 if period.days > WEEKLY_ROLLUP_AFTER_DAYS else 1
    count = -(-period.days // step)
    lo, hi = _bounds(period.start, period.end)
    plo, phi = _bounds(previous.start, previous.end)

    def submitted(start: date, a: datetime, b: datetime) -> list[dict]:
        return _run(
            f"SELECT {_bucket_expr('f_created')} AS b, f.f_kind AS k, COUNT(*) AS n",
            _source(keys, scope, "submitted", a, b),
            select_params=[start, step],
            tail="GROUP BY 1, 2",
        )

    cur_rows, prev_rows = submitted(period.start, lo, hi), submitted(previous.start, plo, phi)
    decided_rows = _run(
        f"""SELECT {_bucket_expr("f_decided")} AS b, COUNT(*) AS n,
            COUNT(*) FILTER (WHERE f.f_outcome = 'approved') AS approved,
            COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') AS rejected,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {SECS}) AS median,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY {SECS}) AS p90""",
        _source(keys, scope, "decided", lo, hi),
        select_params=[period.start, step],
        tail="GROUP BY 1",
    )
    by_kind: dict[int, dict[str, int]] = {}
    volume: dict[str, int] = {}
    for r in cur_rows:
        by_kind.setdefault(int(r["b"]), {})[r["k"]] = int(r["n"])
        volume[r["k"]] = volume.get(r["k"], 0) + int(r["n"])
    prev_total: dict[int, int] = {}
    for r in prev_rows:
        prev_total[int(r["b"])] = prev_total.get(int(r["b"]), 0) + int(r["n"])
    dec = {int(r["b"]): r for r in decided_rows}

    points = []
    for i in range(count):
        first = period.start + timedelta(days=i * step)
        last = min(period.end, first + timedelta(days=step - 1))
        kinds_here = by_kind.get(i, {})
        d = dec.get(i)
        points.append(
            {
                "date": first.isoformat(),
                "endDate": last.isoformat(),
                "submitted": sum(kinds_here.values()),
                "byKind": kinds_here,
                "previousSubmitted": prev_total.get(i, 0),
                "decided": _int(d, "n"),
                "approved": _int(d, "approved"),
                "rejected": _int(d, "rejected"),
                "medianHours": _hours(d["median"]) if d else None,
                "p90Hours": _hours(d["p90"]) if d else None,
            }
        )
    series = sorted(volume, key=lambda k: (-volume[k], KIND_BY_KEY[k].label))
    total_sub, prev_sub = sum(volume.values()), sum(prev_total.values())
    total_dec = sum(p["decided"] for p in points)
    entries = _provenance(scope, period, keys, rows={"submitted": total_sub, "decided": total_dec})
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "granularity": "week" if step == 7 else "day",
            "points": points,
            "kinds": [{"key": k, "label": KIND_BY_KEY[k].label, "submitted": volume[k]} for k in series],
            "totals": {
                "submitted": _metric(total_sub, prev_sub),
                "decided": {"value": total_dec},
            },
            "previousPeriod": previous.to_json(),
        },
        period=period,
        scope=scope,
        provenance=_pick(
            entries, "requests-submitted", "requests-decided", "requests-turnaround", "requests-previous"
        ),
        notes=[] if total_sub or total_dec else [f"No request was submitted or decided {period.label.lower()}."],
    )


# ─── bottlenecks: which department, which approver ───────────────────────────────────────────────────────────────────


@cached()
def requests_bottlenecks(scope: Scope, period: Period, kind: str = "all", limit: int = LIST_DEFAULT) -> dict:
    """Where requests get stuck: who they wait on, the departments with the most requests waiting (and how many are
    blocked only on the Department Head), and the approvers ranked by how long they take to decide."""
    keys = kind_keys(kind)
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    table = _waiting_table(scope, kind)
    rows, now = table["rows"], table["now"]
    lo, hi = _bounds(period.start, period.end)

    holders = []
    for h in HOLDERS:
        part = [r for r in rows if r["holder"] == h]
        s = _sum_rows(part)
        holders.append(
            {
                "key": h,
                "label": HOLDER_LABEL[h],
                "waiting": s["n"],
                "threeDaysPlus": s["aged"],
                "oldestHours": _age_hours(now, s["oldest"]),
                "mdCanDecide": sum(r["n"] for r in part if r["mdCan"]),
            }
        )

    decided = _decided_stats(scope, keys, lo, hi, DIMS["department"])
    names = {r["dept"] for r in rows} | set(decided)
    departments = []
    for name in names:
        part = [r for r in rows if r["dept"] == name]
        s = _sum_rows(part)
        hod_part = [r for r in part if r["holder"] == HOLDER_HOD]
        fig = _fig(decided.get(name))
        departments.append(
            {
                "key": name or "__none__",
                "label": _label("department", name),
                "waiting": s["n"],
                "threeDaysPlus": s["aged"],
                "oldestHours": _age_hours(now, s["oldest"]),
                "withDepartmentHead": sum(r["n"] for r in hod_part),
                "departmentHeadThreeDaysPlus": _sum_rows(hod_part)["aged"],
                "decided": fig["decided"],
                "medianHours": fig["medianHours"],
                "p90Hours": fig["p90Hours"],
                "lowSample": fig["decided"] < MIN_GROUP_DECIDED,
            }
        )
    departments = [d for d in departments if d["waiting"] or d["decided"]]
    departments.sort(key=lambda d: (-d["threeDaysPlus"], -d["waiting"], -(d["medianHours"] or 0), d["label"].lower()))

    approver_rows = _run(
        f"""SELECT f.f_approver AS approver, f.f_arole AS role, COUNT(*) AS n,
            COUNT(*) FILTER (WHERE f.f_outcome = 'approved') AS approved,
            COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') AS rejected,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {SECS}) AS median,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY {SECS}) AS p90""",
        _source(keys, scope, "decided", lo, hi),
        tail="GROUP BY f.f_approver, f.f_arole",
    )
    approvers, unrecorded = [], 0
    for r in approver_rows:
        if not (r["approver"] or "").strip():
            unrecorded += int(r["n"])
            continue
        role = r["role"]
        approvers.append(
            {
                "approverName": r["approver"].strip(),
                "role": role,
                "roleLabel": approval.ROLE_LONG.get(role) if role else None,
                "decided": int(r["n"]),
                "approved": int(r["approved"]),
                "rejected": int(r["rejected"]),
                "medianHours": _hours(r["median"]),
                "p90Hours": _hours(r["p90"]),
                "lowSample": int(r["n"]) < MIN_GROUP_DECIDED,
            }
        )
    approvers.sort(key=lambda a: (a["lowSample"], -(a["medianHours"] or 0), -a["decided"], a["approverName"].lower()))

    entries = _provenance(scope, period, keys, rows={"waiting": _sum_rows(rows)["n"]})
    notes = []
    if unrecorded:
        notes.append(
            f"{_num(unrecorded)} {_plural(unrecorded, 'decision')} in this period do not record who made them and are not in "
            "the approver ranking."
        )
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "asOf": _stamp(now),
            "holders": holders,
            "departments": departments[:limit],
            "departmentsTotal": len(departments),
            "approvers": approvers[:limit],
            "approversTotal": len(approvers),
            "minSample": MIN_GROUP_DECIDED,
            "agedDays": AGED_DAYS,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "requests-bottleneck", "requests-holder", "requests-aging", "requests-turnaround"),
        notes=notes,
    )


# ─── unusual: many requests from one person, repeated rejections, large advances ─────────────────────────────────────


def _people_rows(rows: list[dict]) -> list[dict]:
    return [
        {
            "employeeId": r["employee"],
            "employeeName": _person(r["first"], r["last"]),
            "code": r["code"],
            "department": r["dept"] or None,
            "requests": int(r["n"]),
            "approved": int(r["approved"]),
            "rejected": int(r["rejected"]),
            "waiting": int(r["waiting"]),
        }
        for r in rows
    ]


@cached()
def requests_unusual(
    scope: Scope,
    period: Period,
    kind: str = "all",
    limit: int = LIST_DEFAULT,
    min_requests: int = REPEAT_MIN_REQUESTS,
    min_rejections: int = REPEAT_MIN_REJECTIONS,
    min_amount: float = LARGE_ADVANCE_AMOUNT,
) -> dict:
    """Requests that look unusual: people with many requests of their own, people whose requests keep being rejected, and
    large advances. Short ranked lists, never every request."""
    keys = kind_keys(kind)
    limit = _int_arg(limit, "limit", LIST_DEFAULT, 1, LIST_MAX)
    min_requests = _int_arg(min_requests, "min_requests", REPEAT_MIN_REQUESTS, 2, 100)
    min_rejections = _int_arg(min_rejections, "min_rejections", REPEAT_MIN_REJECTIONS, 1, 100)
    min_amount = _float_arg(min_amount, "min_amount", LARGE_ADVANCE_AMOUNT, 1.0, 10_000_000.0)
    lo, hi = _bounds(period.start, period.end)
    people_cols = """f.f_employee AS employee, MAX(f.f_first) AS first, MAX(f.f_last) AS last, MAX(f.f_code) AS code,
        MAX(COALESCE(f.f_dept, '')) AS dept, COUNT(*) AS n,
        COUNT(*) FILTER (WHERE f.f_outcome = 'approved') AS approved,
        COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') AS rejected,
        COUNT(*) FILTER (WHERE f.f_outcome = 'waiting') AS waiting,
        COUNT(*) OVER () AS people_total"""

    # people with many requests of their own
    own_keys = tuple(k for k in keys if k in EMPLOYEE_RAISED_KEYS)
    repeat: list[dict] = []
    repeat_total = 0
    if own_keys:
        raw = _run(
            f"SELECT {people_cols}",
            _source(own_keys, scope, "submitted", lo, hi),
            tail="GROUP BY f.f_employee HAVING COUNT(*) >= %s ORDER BY n DESC, f.f_employee LIMIT %s",
            tail_params=[min_requests, limit],
        )
        repeat = _people_rows(raw)
        repeat_total = int(raw[0]["people_total"]) if raw else 0
        if repeat:
            mix = _run(
                "SELECT f.f_employee AS employee, f.f_kind AS kind, COUNT(*) AS n",
                _source(own_keys, scope, "submitted", lo, hi),
                tail="WHERE f.f_employee = ANY(%s) GROUP BY 1, 2",
                tail_params=[[r["employeeId"] for r in repeat]],
            )
            kinds_of: dict[int, list[dict]] = {}
            for m in mix:
                kinds_of.setdefault(m["employee"], []).append(
                    {"key": m["kind"], "label": KIND_BY_KEY[m["kind"]].label, "count": int(m["n"])}
                )
            for r in repeat:
                r["byKind"] = sorted(kinds_of.get(r["employeeId"], []), key=lambda x: (-x["count"], x["label"]))

    # people whose requests are rejected again and again (counted on the day of the decision)
    raw = _run(
        f"SELECT {people_cols}",
        _source(keys, scope, "decided", lo, hi),
        tail="GROUP BY f.f_employee HAVING COUNT(*) FILTER (WHERE f.f_outcome = 'rejected') >= %s "
        "ORDER BY rejected DESC, n DESC, f.f_employee LIMIT %s",
        tail_params=[min_rejections, limit],
    )
    rejected = _people_rows(raw)
    rejected_total = int(raw[0]["people_total"]) if raw else 0

    # large advances: those made in the period, and those still waiting whatever the date
    advance = {"threshold": min_amount, "rows": [], "total": 0, "amount": 0.0, "waiting": 0, "waitingAmount": 0.0}
    if "advance" in keys:
        raw = _run(
            """SELECT f.f_id AS id, f.f_employee AS employee, f.f_first AS first, f.f_last AS last, f.f_code AS code,
                COALESCE(f.f_dept, '') AS dept, f.f_amount AS amount, f.f_outcome AS outcome, f.f_created AS created,
                COUNT(*) OVER () AS total, SUM(f.f_amount) OVER () AS total_amount""",
            _source(("advance",), scope, "submitted", lo, hi),
            tail="WHERE f.f_amount >= %s ORDER BY f.f_amount DESC, f.f_id LIMIT %s",
            tail_params=[min_amount, limit],
        )
        now = now_utc()
        advance["rows"] = [
            {
                "id": r["id"],
                "employeeId": r["employee"],
                "employeeName": _person(r["first"], r["last"]),
                "code": r["code"],
                "department": r["dept"] or None,
                "amount": float(r["amount"]),
                "outcome": r["outcome"],
                "submittedAt": _stamp(r["created"]),
                "ageHours": _age_hours(now, r["created"]) if r["outcome"] == "waiting" else None,
            }
            for r in raw
        ]
        advance["total"] = int(raw[0]["total"]) if raw else 0
        advance["amount"] = round(float(raw[0]["total_amount"]), 2) if raw else 0.0
        waiting = _run(
            "SELECT COUNT(*) AS n, COALESCE(SUM(f.f_amount), 0) AS amount",
            _source(("advance",), scope, "waiting"),
            tail="WHERE f.f_amount >= %s",
            tail_params=[min_amount],
        )[0]
        advance["waiting"], advance["waitingAmount"] = int(waiting["n"]), round(float(waiting["amount"]), 2)

    entries = _provenance(scope, period, keys, rows={"submitted": sum(r["requests"] for r in repeat)})
    notes = []
    if not own_keys:
        notes.append("The kinds chosen are all raised by HR, so there is no 'many requests from one person' list.")
    return envelope(
        {
            "kind": kind or "all",
            "kindLabel": kind_text(keys),
            "thresholds": {
                "repeatRequests": min_requests,
                "repeatRejections": min_rejections,
                "largeAdvance": min_amount,
            },
            "repeatRequesters": {"rows": repeat, "total": repeat_total},
            "repeatRejections": {"rows": rejected, "total": rejected_total},
            "largeAdvances": advance,
        },
        period=period,
        scope=scope,
        provenance=_pick(entries, "requests-unusual"),
        notes=notes,
    )


# ─── "needs your attention": exceptions for a period and for the Dashboard ───────────────────────────────────────────


def _item(id_: str, severity: str, title: str, detail: str, metric: str | None, ask: str) -> dict:
    return {
        "id": f"requests.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": PAGE,
        "ask": ask,
    }


def _top_label(counts: dict[str, int]) -> tuple[str, int] | None:
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0]), default=None)
    return best if best and best[1] else None


def _exceptions(scope: Scope, period: Period, kind: str = "all", *, limit: int) -> list[dict]:
    """The findings worth the MD's attention for this period and selection, most severe first, at most ``limit``. Built
    on the public analytics, so a flag always points at a figure that is on the page."""
    summary = requests_summary(scope, period, kind=kind)
    waiting = summary["waiting"]
    m = summary["metrics"]
    items: list[dict] = []
    previous = _previous_phrase(period)

    # 1. requests that have waited too long (a snapshot: the period does not hide them)
    aged = waiting["threeDaysPlus"]
    if aged:
        stale = waiting["sevenDaysPlus"]
        table = _waiting_table(scope, kind)
        aged_rows = [r for r in table["rows"] if r["b"][2] + r["b"][3]]
        hr_aged = sum(r["b"][2] + r["b"][3] for r in aged_rows if r["holder"] != HOLDER_HOD)
        hod_aged = sum(r["b"][2] + r["b"][3] for r in aged_rows if r["holder"] == HOLDER_HOD)
        top_kind = _top_label(waiting["agedByKind"])
        by_dept: dict[str, int] = {}
        for r in aged_rows:
            if r["dept"]:
                by_dept[r["dept"]] = by_dept.get(r["dept"], 0) + r["b"][2] + r["b"][3]
        top_dept = _top_label(by_dept)
        bits = [f"The oldest has waited {_dur(waiting['oldestHours'])}."]
        bits.append(
            f"{_num(hr_aged)} {_plural(hr_aged, 'is', 'are')} with HR or either approver (you can decide "
            f"{_plural(hr_aged, 'it', 'them')} now)"
            + (f" and {_num(hod_aged)} only with a Department Head." if hod_aged else ".")
        )
        if top_kind:
            bits.append(f"Mostly {KIND_BY_KEY[top_kind[0]].label.lower()} ({_num(top_kind[1])}).")
        if top_dept:
            bits.append(f"{top_dept[0]} has the most ({_num(top_dept[1])}).")
        items.append(
            _item(
                "aging",
                "critical" if stale else "warning",
                f"{_num(aged)} {_plural(aged, 'request has', 'requests have')} waited {AGED_DAYS} days or more",
                " ".join(bits),
                f"{_num(aged)} waiting",
                f"Which requests have been waiting {AGED_DAYS} days or more, who is each waiting on, and which "
                "department holds the most?",
            )
        )

    # 2. a department whose Department Head is the one holding requests up
    bottlenecks = requests_bottlenecks(scope, period, kind=kind, limit=LIST_MAX)
    blocked = [d for d in bottlenecks["departments"] if d["departmentHeadThreeDaysPlus"] >= BOTTLENECK_MIN_AGED]
    if blocked:
        worst = max(blocked, key=lambda d: (d["departmentHeadThreeDaysPlus"], d["waiting"]))
        n = worst["departmentHeadThreeDaysPlus"]
        items.append(
            _item(
                "bottleneck",
                "warning",
                f"{worst['label']}: {_num(n)} {_plural(n, 'request is', 'requests are')} stuck with the Department Head",
                f"{_num(n)} {_plural(n, 'has', 'have')} waited {AGED_DAYS} days or more and only the Department Head "
                f"can decide {_plural(n, 'it', 'them')}; {_num(worst['withDepartmentHead'])} wait on the Department "
                "Head in all.",
                f"{_num(n)} stuck",
                f"Why are requests from {worst['label']} stuck with the Department Head, and what are they?",
            )
        )

    # 3. large advances waiting for approval (money)
    unusual = requests_unusual(scope, period, kind=kind, limit=LIST_DEFAULT)
    adv = unusual["largeAdvances"]
    if adv["waiting"]:
        n = adv["waiting"]
        items.append(
            _item(
                "advance",
                "warning",
                f"{_num(n)} {_plural(n, 'advance')} of {_inr(adv['threshold'])} or more {_plural(n, 'is', 'are')} "
                f"waiting for approval",
                f"{_inr(adv['waitingAmount'])} in all. The system sets no limit on an advance, so these are for you to "
                "judge.",
                _inr(adv["waitingAmount"]),
                f"Which advances of {_inr(adv['threshold'])} or more are waiting for approval, and for whom?",
            )
        )

    # 4. decisions got slower, or are mostly late
    cur_n, prev_n = m["decided"]["value"], m["decided"]["previous"]
    cur_med, prev_med = m["medianHours"]["value"], m["medianHours"]["previous"]
    if cur_n >= MIN_DECIDED and prev_n >= MIN_DECIDED and cur_med is not None and prev_med is not None:
        rise = cur_med - prev_med
        if cur_med >= SLOWDOWN_RATIO * prev_med and rise >= SLOWDOWN_MIN_HOURS:
            items.append(
                _item(
                    "slower",
                    "critical" if cur_med >= 2 * prev_med else "warning",
                    f"Requests now take {_dur(cur_med)} to decide, up from {_dur(prev_med)}",
                    f"{period.label} against {previous}: the typical request waits {_dur(rise)} longer. "
                    f"9 in 10 are decided within {_dur(m['p90Hours']['value'])}.",
                    f"+{_dur(rise)}",
                    f"Why has the time to decide requests gone up from {_dur(prev_med)} to {_dur(cur_med)} "
                    f"({period.label}), and where?",
                )
            )
        elif prev_med >= SLOWDOWN_RATIO * cur_med and -rise >= SLOWDOWN_MIN_HOURS:
            items.append(
                _item(
                    "faster",
                    "good",
                    f"Requests are decided faster: {_dur(cur_med)}, down from {_dur(prev_med)}",
                    f"{period.label} against {previous}.",
                    f"-{_dur(-rise)}",
                    f"What made requests get decided faster ({period.label})?",
                )
            )
    within = m["withinDayPct"]["value"]
    if cur_n >= MIN_DECIDED and within is not None and within < LOW_SLA_PCT:
        items.append(
            _item(
                "slow-service",
                "warning",
                f"Only {_p(within)} of requests are decided within a day",
                f"{period.label}: {_num(cur_n)} decided; the typical request took {_dur(cur_med)} and 9 in 10 were "
                f"decided within {_dur(m['p90Hours']['value'])}.",
                _p(within),
                f"Why are so few requests decided within a day ({period.label}), and which kinds are slowest?",
            )
        )

    # 5. a kind or department that rejects a lot
    worst_rejecting = None
    for by in ("kind", "department"):
        for r in requests_breakdown(scope, period, kind=kind, by=by, limit=LIST_MAX)["rows"]:
            if (
                r["decided"] >= MIN_DECIDED
                and (r["rejectionPct"] or 0) >= HIGH_REJECTION_PCT
                and (worst_rejecting is None or r["rejectionPct"] > worst_rejecting[1]["rejectionPct"])
            ):
                worst_rejecting = (by, r)
    if worst_rejecting:
        by, r = worst_rejecting
        what = f"{r['label']} requests" if by == "kind" else f"Requests from {r['label']}"
        items.append(
            _item(
                "rejections",
                "info",
                f"{what} are rejected {_p(r['rejectionPct'])} of the time",
                f"{period.label}: {_num(r['rejected'])} of {_num(r['decided'])} decided were rejected.",
                _p(r["rejectionPct"]),
                f"Why are {r['label']} requests rejected so often ({period.label}), and for whom?",
            )
        )

    # 6. people who ask a lot, or are turned down again and again (no names here: they are on the page)
    repeat = unusual["repeatRequesters"]["total"]
    if repeat:
        items.append(
            _item(
                "repeat",
                "info",
                f"{_num(repeat)} {_plural(repeat, 'person')} made {REPEAT_MIN_REQUESTS} or more requests",
                f"{period.label}: the most any one person made is "
                f"{_num(unusual['repeatRequesters']['rows'][0]['requests'])}. The names are on the Requests page.",
                _num(repeat),
                f"Who made {REPEAT_MIN_REQUESTS} or more requests ({period.label}) and what for?",
            )
        )
    turned_down = unusual["repeatRejections"]["total"]
    if turned_down:
        items.append(
            _item(
                "repeat-rejected",
                "info",
                f"{_num(turned_down)} {_plural(turned_down, 'person has', 'people have')} had "
                f"{REPEAT_MIN_REJECTIONS} or more requests rejected",
                f"{period.label}. The names are on the Requests page.",
                _num(turned_down),
                f"Who has had {REPEAT_MIN_REJECTIONS} or more requests rejected ({period.label}) and why?",
            )
        )

    # 7. nothing wrong
    if cur_n and all(i["severity"] in ("info", "good") for i in items) and not aged:
        items.append(
            _item(
                "healthy",
                "good",
                f"Requests are being decided promptly: typically in {_dur(cur_med)}",
                f"{period.label}: {_num(cur_n)} decided, {_p(within)} within a day, nothing waiting {AGED_DAYS} days "
                "or more.",
                _dur(cur_med),
                f"Summarise how requests are being handled ({period.label}).",
            )
        )
    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])  # stable: equal severities keep their order of importance
    return items[:limit]


@cached()
def requests_attention(scope: Scope, period: Period, kind: str = "all") -> dict:
    """ "Needs your attention" for the selected period and selection (same shape as the Dashboard's insights)."""
    keys = kind_keys(kind)
    items = _exceptions(scope, period, kind, limit=6)
    thresholds = prov(
        "requests-attention",
        "Needs your attention",
        dataset="Leave, permission, outpass, missing punch, on-duty, resignation, correction and advance requests",
        definition=(
            f"Requests waiting {AGED_DAYS} days or more are flagged (critical from {STALE_DAYS} days). A department is "
            f"named when {BOTTLENECK_MIN_AGED}+ of its requests have waited that long with the Department Head. A median "
            f"time to decide that rises {SLOWDOWN_RATIO}× and at least {SLOWDOWN_MIN_HOURS:g} hours against the previous "
            f"period is a slowdown; fewer than {_p(LOW_SLA_PCT)} decided within {SLA_HOURS} hours is flagged (both need "
            f"{MIN_DECIDED}+ decisions). A kind or department that rejects {_p(HIGH_REJECTION_PCT)} or more of "
            f"{MIN_DECIDED}+ decisions is flagged. People with {REPEAT_MIN_REQUESTS}+ requests or "
            f"{REPEAT_MIN_REJECTIONS}+ rejections, and advances of {_inr(LARGE_ADVANCE_AMOUNT)} or more, are listed."
        ),
        formula="simple threshold rules over the figures on this page",
        filters=[period.label, scope.describe(), kind_text(keys)],
        caveats=["These are rules of thumb: no service level or request limit is configured in the system."],
    )
    return envelope({"items": items}, period=period, scope=scope, provenance=[thresholds])


def _recent_period(today: date | None) -> Period:
    return period_for_preset("last_30_days", today or ist_today())


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most 5, most severe first (see md-portal.md section 3)."""
    return _exceptions(Scope(), _recent_period(today), "all", limit=5)


def headline(*, today: date | None = None) -> dict:
    """The Dashboard's request cards: what is waiting (with how many have waited 3+ days and the oldest) and the typical
    time to decide over the last 30 days against the 30 before, with a 14-day sparkline of the daily median."""
    period = _recent_period(today)
    scope = Scope()
    summary = requests_summary(scope, period, kind="all")
    waiting, m = summary["waiting"], summary["metrics"]
    trend = requests_trend(scope, Period(period.end - timedelta(days=13), period.end, None, "Last 14 days"), kind="all")
    spark = [None if p["medianHours"] is None else round(p["medianHours"] * 60) for p in trend["points"]]
    med, prev = m["medianHours"]["value"], m["medianHours"]["previous"]
    med_min, prev_min = (None if v is None else round(v * 60) for v in (med, prev))
    delta = change(med_min, prev_min)
    if waiting["total"]:
        sub = f"{_num(waiting['mdCanDecide'])} you can decide now"
        if waiting["threeDaysPlus"]:
            sub += f" · {_num(waiting['threeDaysPlus'])} waiting {AGED_DAYS}+ days · oldest {_dur(waiting['oldestHours'])}"
    else:
        sub = "Nothing is waiting"
    kpis = [
        {
            "id": "requests.waiting",
            "label": "Requests waiting",
            "value": waiting["total"],
            "format": "number",
            "sub": sub,
            "delta": None,
            "spark": None,
            "page": PAGE,
        },
        {
            "id": "requests.median-decision",
            "label": "Time to decide a request",
            "value": med_min,
            "format": "minutes",
            "sub": (
                f"typical request · {_num(m['decided']['value'])} decided, {_p(m['withinDayPct']['value'])} within a day"
                if med_min is not None
                else f"No request was decided in the {period.label.lower()}"
            ),
            "delta": {**delta, "good": "down"} if delta else None,
            "spark": spark,
            "page": PAGE,
        },
    ]
    entries = _provenance(scope, period, KIND_KEYS, rows={"waiting": waiting["total"], "decided": m["decided"]["value"]})
    return {"kpis": kpis, "provenance": _pick(entries, "requests-waiting", "requests-turnaround", "requests-previous")}


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────────────

_KIND = string_param(
    "Which requests (default all): all, page (leave, permission and outpass, as on the HR Requests page) or one kind",
    enum=["all", "page", *KIND_KEYS],
)
_LIMIT = integer_param(f"How many rows (default {LIST_DEFAULT}, at most {LIST_MAX})", minimum=1, maximum=LIST_MAX)

TOOLS = [
    tool(
        "requests_summary",
        "The requests picture in ONE lookup: how many requests are waiting for a decision now (by how long they have "
        "waited and by who they wait on: HR, the Department Head or either; how many the MD can decide himself), and for "
        "the period how many were submitted and decided, the approval and rejection rates and the typical (median) and "
        "90th-percentile time to decide in hours, each against the previous period, plus a plain-English briefing. Kinds: "
        "leave, permission, casual leave, outpass, missing punch, on-duty, resignation, attendance correction, advance. "
        "Use for 'how are requests going', 'what is waiting', 'how fast do we decide requests'. Percentages are 0-100.",
        requests_summary,
        page=PAGE,
        period="last_30_days",
        extra={"kind": _KIND},
        defaults={"kind": "all"},
    ),
    tool(
        "requests_waiting",
        "Requests waiting for a decision right now (a snapshot, all dates): totals by kind and by who they wait on, each in "
        "the age bands under 1 day / 1-3 days / 3-7 days / 7+ days, how many the MD can decide, and the oldest waiting "
        "requests with who is waiting on them (name, department, age in hours). Use for 'what is stuck', 'which requests "
        "have waited longest', 'who is holding things up' (HR or the Department Head).",
        requests_waiting,
        page=PAGE,
        period=None,
        extra={"kind": _KIND, "limit": _LIMIT},
        defaults={"kind": "all", "limit": LIST_DEFAULT},
    ),
    tool(
        "requests_turnaround",
        "How fast requests are decided: the typical (median) and 90th-percentile time from submission to decision in hours, "
        "and the share decided within a day, overall and by kind, each against the previous period, and how decisions "
        "spread over under 1 hour / 1-4 h / 4-24 h / 1-3 days / 3+ days. Requests still waiting are not in it. Use for "
        "'how long do requests take', 'which kind is slowest', 'are we getting faster'.",
        requests_turnaround,
        page=PAGE,
        period="last_30_days",
        extra={"kind": _KIND},
        defaults={"kind": "all"},
    ),
    tool(
        "requests_breakdown",
        "Requests compared across kinds, departments, units or staff-vs-production: submitted (with the previous period), "
        "decided, approved, rejected, approval and rejection %, median and 90th-percentile hours to decide, and how many "
        "are waiting (and 3+ days old). Rows with fewer than 5 decisions are flagged small sample. Use for 'which "
        "department gets rejected most', 'which kind do we approve least', 'who asks for the most leave'.",
        requests_breakdown,
        page=PAGE,
        period="last_30_days",
        extra={
            "kind": _KIND,
            "by": string_param("What to group by", enum=list(BY_CHOICES)),
            "limit": _LIMIT,
        },
        defaults={"kind": "all", "by": "kind", "limit": LIST_DEFAULT},
    ),
    tool(
        "requests_bottlenecks",
        "Where requests get stuck: who they wait on (HR, Department Head, either), the departments with the most requests "
        "waiting and the most that have waited 3+ days (and how many only the Department Head can decide), and the "
        "approvers ranked by how long they take to decide (median hours, decisions made). Use for 'who is the bottleneck', "
        "'which department head is slow', 'which approver takes longest'.",
        requests_bottlenecks,
        page=PAGE,
        period="last_30_days",
        extra={"kind": _KIND, "limit": _LIMIT},
        defaults={"kind": "all", "limit": LIST_DEFAULT},
        person_fields=("approverName",),
    ),
    tool(
        "requests_trend",
        "Requests over time: submitted per day (per week for periods over 62 days) split by kind with the previous period "
        "beside it, and decided per day with the typical and 90th-percentile hours to decide. Use for 'is the volume of "
        "requests rising', 'did requests get slower last week', 'when do requests peak'.",
        requests_trend,
        page=PAGE,
        period="last_30_days",
        extra={"kind": _KIND},
        defaults={"kind": "all"},
    ),
    tool(
        "requests_unusual",
        f"Requests that look unusual: people with {REPEAT_MIN_REQUESTS}+ requests of their own in the period (with the "
        f"kinds), people with {REPEAT_MIN_REJECTIONS}+ rejections, and advances of "
        f"{_inr(LARGE_ADVANCE_AMOUNT)}+ (amount, outcome, how many are still waiting). Thresholds can be changed. Use for "
        "'who keeps asking for leave', 'who keeps getting rejected', 'any big advances waiting'.",
        requests_unusual,
        page=PAGE,
        period="last_30_days",
        extra={
            "kind": _KIND,
            "limit": _LIMIT,
            "min_requests": integer_param("Requests by one person to count as many", minimum=2, maximum=100),
            "min_rejections": integer_param("Rejections of one person to count", minimum=1, maximum=100),
            "min_amount": {"type": "number", "description": "Advance amount in rupees to count as large"},
        },
        defaults={
            "kind": "all",
            "limit": LIST_DEFAULT,
            "min_requests": REPEAT_MIN_REQUESTS,
            "min_rejections": REPEAT_MIN_REJECTIONS,
            "min_amount": LARGE_ADVANCE_AMOUNT,
        },
    ),
    tool(
        "requests_attention",
        "What needs the MD's attention about requests: requests waited too long (with who holds them), a Department Head "
        "holding requests up, large advances waiting, slower decisions, kinds or departments rejecting a lot, people who "
        "ask a lot. Each has a severity and a number. Use for 'what should I look at on requests'.",
        requests_attention,
        page=PAGE,
        period="last_30_days",
        extra={"kind": _KIND},
        defaults={"kind": "all"},
    ),
]
