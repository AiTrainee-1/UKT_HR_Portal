"""
Payroll insights -what the payroll engine already decided, explained. READ-ONLY.

The redesigned Staff Payroll and Production Payroll pages need more than the payroll rows: a details page for one
payroll, every issue payroll detected, the rules each employee is paid under and a printable Salary Statement. All of
it is derived from what payroll ALREADY STORED -the `Payroll` row, its `SalarySlip` (`breakdown_details`, the engine's
own day-by-day record), the employee's profile and the live settings. Nothing in here recomputes a payroll, calls an
engine function that persists, or writes anything: a GET that used these helpers can be repeated any number of times
without changing a single row.

This module holds the plain helpers (no HTTP): number / date formatting, the Settings deep links, the issue catalogue and
the detection of issues from a stored breakdown, the money lines and the normalised day list of a payroll, the profile
shapes, and the bulk loaders that keep a whole month of payroll to a fixed number of queries. The rules (what governs a
payroll / an employee) live in payroll_insights_rules.py; the endpoints in payroll_insights_views.py and
payroll_statement_views.py. The response shapes are the TypeScript types in
frontend/src/lib/api-client/custom-hooks/payroll-insights.ts (camelCase JSON), which are authoritative.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db.models import Q, Sum

from .models import (
    Advance,
    AdvanceRepayment,
    BranchSettingsOverride,
    CasualLeaveRequest,
    EmployeeShiftAssignment,
    Holiday,
    Payroll,
    PayrollSettings,
    SalarySlip,
)
from .production_cycles import CYCLE_LABELS
from .salary_split import COMPONENTS, FIRST_PORTION, JSON_KEYS, LABELS, breakup_of
from .user_settings import _SettingsOverlay

# ─────────────────────────────────────────────────────────────────────────────
#  Small formatting helpers
# ─────────────────────────────────────────────────────────────────────────────

MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]
MONTH_ABBR = [name[:3] for name in MONTH_NAMES]
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

_CENT = Decimal("0.01")

KIND_STAFF = "staff"
KIND_PRODUCTION = "production"
KIND_LEGACY = "legacy_session"


def dec(value, default: str = "0") -> Decimal:
    """Any stored number (Decimal, float from the breakdown JSON, text) as a Decimal; `default` when it is not one."""
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(default)


def money(value) -> float:
    """Rupees (or days) as a JSON number rounded to 2 places, half up -the engine's own rounding."""
    return float(dec(value).quantize(_CENT, rounding=ROUND_HALF_UP))


def plain(value) -> str:
    """12.0 -> '12', 0.5 -> '0.5', Decimal('0.250') -> '0.25': a number as people write it."""
    d = dec(value)
    if d == d.to_integral_value():
        return str(int(d))
    return format(d.normalize(), "f")


def inr(value, force_places: bool = False) -> str:
    """Rupees with Indian digit grouping: ₹1,50,000 (paise only when there are some, or when forced)."""
    d = dec(value).quantize(_CENT, rounding=ROUND_HALF_UP)
    sign = "-" if d < 0 else ""
    d = abs(d)
    whole = int(d)
    paise = int((d - whole) * 100)
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups: list[str] = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join([*groups, tail])
    text = f"₹{digits}"
    if paise or force_places:
        text += f".{paise:02d}"
    return sign + text


def plural(n, one: str, many: str | None = None) -> str:
    """'1 day', '0 days', '2 days'; a fraction below one reads in the singular ('0.5 day')."""
    d = dec(n)
    word = one if 0 < abs(d) <= 1 else (many or f"{one}s")
    return f"{plain(d)} {word}"


def shifts_text(n) -> str:
    """'1 shift', '0.5 shift', '1.5 shifts'."""
    return plural(n, "shift")


def parse_iso_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def iso_dt(value) -> str | None:
    """An aware datetime as ISO text with its offset (what the pages show as 'flagged / generated at')."""
    return value.isoformat() if value else None


def ddmmyyyy(value: date) -> str:
    """The printed statement's date format: 01-09-2026."""
    return f"{value.day:02d}-{value.month:02d}-{value.year}"


def period_label(start: date, end: date) -> str:
    """'2 Feb - 8 Feb 2026' / '29 Dec 2026 - 4 Jan 2027' (the same words as the frontend's periodLabel)."""
    left = f"{start.day} {MONTH_ABBR[start.month - 1]}"
    if start.year != end.year:
        left += f" {start.year}"
    return f"{left} - {end.day} {MONTH_ABBR[end.month - 1]} {end.year}"


def full_name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def minutes_of(clock: str | None) -> int | None:
    """'09:10' -> 550; None when it is not a clock time."""
    match = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", str(clock or "").strip())
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def clock_of(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def natural_key(text: str | None):
    """Sort key putting '189' before '2234' and 'UKT-9' before 'UKT-10' (the printed statement lists codes numerically)."""
    return [
        (0, int(part), "") if part.isdigit() else (1, 0, part.lower())
        for part in re.split(r"(\d+)", text or "")
        if part
    ]


# ─────────────────────────────────────────────────────────────────────────────
#  Settings deep links
# ─────────────────────────────────────────────────────────────────────────────
#
# Every rule an issue or a rule item points at is a real setting block of the Settings page: `?tab=` is the tab id of
# frontend/src/pages/hr/settings/tabs.ts and `#id` the anchor of a SettingBlock in that tab's *.meta.ts. A test reads those
# files and fails when a link here points at an id that no longer exists.


@dataclass(frozen=True)
class SettingRef:
    label: str
    tab: str
    anchor: str

    @property
    def path(self) -> str:
        return f"/hr/settings?tab={self.tab}#{self.anchor}"


SETTINGS: dict[str, SettingRef] = {
    # Attendance tab
    "attendance_mode": SettingRef("Attendance mode", "attendance", "attendance-mode"),
    "late_window": SettingRef("Late window", "attendance", "late-window"),
    "permission_window": SettingRef("Permission window", "attendance", "permission-window"),
    "extra_minutes": SettingRef("Extra minutes", "attendance", "extra-minutes"),
    "quarter_deduction": SettingRef("Quarter-shift deduction", "attendance", "quarter-deduction"),
    "second_half_start": SettingRef("Second half start time", "attendance", "second-half-start"),
    "morning_late_in": SettingRef("Morning Late-In check", "attendance", "morning-late-in"),
    "evening_early_out": SettingRef("Evening Early-Out check", "attendance", "evening-early-out"),
    # Late Detection tab
    "late_free_allowance": SettingRef("Free late marks a month", "late_detection", "free-allowance"),
    "late_slabs": SettingRef("Late deduction slabs", "late_detection", "deduction-slabs"),
    "permission_cap": SettingRef("Permission monthly cap", "late_detection", "permission-cap"),
    # Payroll tab
    "staff_pf_esi_switch": SettingRef("Staff PF and ESI switch", "payroll", "staff-pf-esi-switch"),
    "staff_pf_rate": SettingRef("Staff PF rate", "payroll", "staff-pf-rate"),
    "staff_esi_rate": SettingRef("Staff ESI rate", "payroll", "staff-esi-rate"),
    "staff_esi_ceiling": SettingRef("Staff ESI ceiling", "payroll", "staff-esi-ceiling"),
    "pay_day": SettingRef("Salary pay day", "payroll", "pay-day"),
    "compensation_features": SettingRef("OT & Compensation features", "payroll", "compensation-features"),
    "ot_detection": SettingRef("Find overtime automatically", "payroll", "ot-detection"),
    "ot_threshold": SettingRef("OT threshold", "payroll", "ot-threshold"),
    "prod_pf_esi_switch": SettingRef("Production flat-rate PF and ESI switch", "payroll", "prod-pf-esi-switch"),
    "prod_pf_rate": SettingRef("Production PF rate", "payroll", "prod-pf-rate"),
    "prod_esi_rate": SettingRef("Production ESI rate", "payroll", "prod-esi-rate"),
    "prod_esi_ceiling": SettingRef("Production ESI ceiling", "payroll", "prod-esi-ceiling"),
    "pf_ef_switch": SettingRef("Production PF / EF salary bands switch", "payroll", "pf-ef-switch"),
    "pf_ef_rules": SettingRef("Production PF / EF salary bands", "payroll", "pf-ef-rules"),
    # Production Payroll tab (the settings that are not per cycle)
    "prod_late_switch": SettingRef("Production late deductions", "production_payroll", "prod-late-switch"),
    "prod_attendance_mode": SettingRef("Production late attendance mode", "production_payroll", "prod-attendance-mode"),
    "prod_shifts_earned": SettingRef("How a production day earns pay", "production_payroll", "prod-shifts-earned"),
}

# The four settings every pay cycle has its own copy of: the anchor is `<cycle>-<suffix>`.
CYCLE_SETTING_SUFFIX = {
    "week_start": ("Week start", "week-start"),
    "first_period": ("First period start", "first-period"),
    "late_allowance": ("Free late days", "late-allowance"),
    "late_slabs": ("Late deduction slabs", "late-slabs"),
}


def cycle_ref(cycle: str | None, key: str) -> SettingRef | None:
    """The Settings block of one pay cycle (`weekly-late-slabs`); None when the payroll has no cycle."""
    if cycle not in CYCLE_LABELS:
        return None
    label, suffix = CYCLE_SETTING_SUFFIX[key]
    return SettingRef(f"{CYCLE_LABELS[cycle]} {label.lower()}", "production_payroll", f"{cycle}-{suffix}")


def all_setting_refs() -> list[SettingRef]:
    """Every Settings link this package can emit (the test checks each against the frontend's setting ids)."""
    refs = list(SETTINGS.values())
    for cycle in CYCLE_LABELS:
        for key in CYCLE_SETTING_SUFFIX:
            ref = cycle_ref(cycle, key)
            if ref is not None:
                refs.append(ref)
    return refs


def rule_of(ref: SettingRef | None, label: str | None = None) -> dict | None:
    """The `rule` of an issue: the label and where HR changes it (null path when it is not a Settings page setting)."""
    if ref is None:
        return None if label is None else {"label": label, "settingsPath": None}
    return {"label": label or ref.label, "settingsPath": ref.path}


# ─────────────────────────────────────────────────────────────────────────────
#  Issue catalogue
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IssueMeta:
    label: str
    category: str  # attendance | pay | profile | rule | generation
    severity: str  # critical | warning | info


STAFF_ISSUES: dict[str, IssueMeta] = {
    # An absence is the routine reason for a loss-of-pay day, not a fault in the payroll: "critical" is kept for what stops
    # a person being paid properly (no attendance in a production period, skipped at generation).
    "absent": IssueMeta("Absent", "attendance", "warning"),
    "unpaid_leave": IssueMeta("Unpaid leave", "attendance", "warning"),
    "late_in": IssueMeta("Late arrival", "attendance", "warning"),
    "early_out": IssueMeta("Early leaving", "attendance", "warning"),
    "half_day": IssueMeta("Half day", "attendance", "warning"),
    "quarter_day": IssueMeta("Quarter-day cut", "attendance", "warning"),
    "missing_punch": IssueMeta("Missing punch", "attendance", "warning"),
    "no_shift": IssueMeta("No shift assigned", "rule", "warning"),
    "late_penalty": IssueMeta("Late deduction", "pay", "warning"),
    "excess_permission": IssueMeta("Excess permission", "pay", "warning"),
    "advance_recovery": IssueMeta("Advance recovery", "pay", "info"),
    "ot_pay": IssueMeta("Overtime pay", "pay", "info"),
    "adjustment": IssueMeta("Manual adjustment", "pay", "info"),
    "bank_missing": IssueMeta("Bank details missing", "profile", "warning"),
    "pf_number_missing": IssueMeta("PF number missing", "profile", "info"),
    "esi_number_missing": IssueMeta("ESI number missing", "profile", "info"),
}

PRODUCTION_ISSUES: dict[str, IssueMeta] = {
    "absent": IssueMeta("Absent", "attendance", "warning"),
    "late_in": IssueMeta("Late arrival", "attendance", "warning"),
    "missing_punch": IssueMeta("Missing punch", "attendance", "warning"),
    "half_day": IssueMeta("Half day", "attendance", "info"),
    "no_attendance": IssueMeta("No attendance", "attendance", "critical"),
    "late_penalty": IssueMeta("Late deduction", "pay", "warning"),
    "advance_recovery": IssueMeta("Advance recovery", "pay", "info"),
    "adjustment": IssueMeta("Manual adjustment", "pay", "info"),
    "bank_missing": IssueMeta("Bank details missing", "profile", "warning"),
    "pf_number_missing": IssueMeta("PF number missing", "profile", "info"),
    "esi_number_missing": IssueMeta("ESI number missing", "profile", "info"),
}

SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}


def issue_catalogue(kind: str) -> dict[str, IssueMeta]:
    return PRODUCTION_ISSUES if kind == KIND_PRODUCTION else STAFF_ISSUES


# ─────────────────────────────────────────────────────────────────────────────
#  Settings, resolved once
# ─────────────────────────────────────────────────────────────────────────────


class SettingsResolver:
    """The company settings and each branch's overlay, loaded in at most two queries however many employees there are.

    user_settings.settings_for_employee() asks the database for the settings row AND the branch's overrides on every
    call, and PayrollSettings.get() creates the row when it is missing. A page that explains a whole month of payroll
    needs the same answers for hundreds of employees and must not write, so this does what they do (the employee's
    branch decides, a branch with no overrides reads the company row) from rows fetched once; a missing settings row
    reads as the model's defaults and is never created.
    """

    def __init__(self, branch_ids=()):
        self.base = PayrollSettings.objects.filter(pk=1).first() or PayrollSettings()
        wanted = {b for b in branch_ids if b is not None}
        self._overrides: dict[int, dict] = {}
        if wanted:
            self._overrides = {
                row.branch_id: row.overrides or {}
                for row in BranchSettingsOverride.objects.filter(branch_id__in=wanted)
            }
        self._overlays: dict[int, _SettingsOverlay] = {}

    def for_branch(self, branch_id: int | None):
        """What the settings page of a login on this branch (or no branch) shows."""
        if branch_id is None:
            return self.base
        if branch_id not in self._overlays:
            self._overlays[branch_id] = _SettingsOverlay(self.base, dict(self._overrides.get(branch_id, {})), branch_id)
        return self._overlays[branch_id]

    def for_employee(self, emp):
        """What payroll reads for this employee (settings_for_employee): their own branch's, else the company's."""
        return self.for_branch(getattr(emp, "branch_id", None))


# ─────────────────────────────────────────────────────────────────────────────
#  Bulk loaders (a fixed number of queries per call)
# ─────────────────────────────────────────────────────────────────────────────


def kind_of(payroll: Payroll) -> str:
    """staff (monthly) | production (period-based shift pay) | legacy_session (older session / week-number rows)."""
    if payroll.salary_mode == Payroll.SALARY_MODE_MONTHLY:
        return KIND_STAFF
    if payroll.salary_mode == Payroll.SALARY_MODE_SHIFT and payroll.period_start is not None:
        return KIND_PRODUCTION
    return KIND_LEGACY


def slip_key(payroll: Payroll) -> tuple:
    """How a payroll finds its salary slip: the month for staff, the exact period for production (as payroll_breakdown)."""
    if payroll.period_start is not None:
        return (payroll.employee_id, payroll.period_start, payroll.period_end)
    return (payroll.employee_id, payroll.month, payroll.year, payroll.week_number)


def _slip_key_of(slip: SalarySlip) -> tuple:
    if slip.period_start is not None:
        return (slip.employee_id, slip.period_start, slip.period_end)
    return (slip.employee_id, slip.month, slip.year, slip.week_number)


def slips_for(payrolls) -> dict[tuple, SalarySlip]:
    """{slip_key(payroll): its SalarySlip} for these payrolls, in one query (two when staff and period rows are mixed)."""
    payrolls = list(payrolls)
    out: dict[tuple, SalarySlip] = {}
    monthly = [p for p in payrolls if p.period_start is None]
    periodic = [p for p in payrolls if p.period_start is not None]
    if monthly:
        months = {(p.month, p.year, p.week_number) for p in monthly}
        cond = Q()
        for month, year, week in months:
            cond |= Q(month=month, year=year, week_number=week)
        wanted = {slip_key(p) for p in monthly}
        for slip in SalarySlip.objects.filter(
            employee_id__in={p.employee_id for p in monthly}, period_start__isnull=True
        ).filter(cond):
            if _slip_key_of(slip) in wanted:
                out[_slip_key_of(slip)] = slip
    if periodic:
        cond = Q()
        for start, end in {(p.period_start, p.period_end) for p in periodic}:
            cond |= Q(period_start=start, period_end=end)
        wanted = {slip_key(p) for p in periodic}
        for slip in SalarySlip.objects.filter(employee_id__in={p.employee_id for p in periodic}).filter(cond):
            if _slip_key_of(slip) in wanted:
                out[_slip_key_of(slip)] = slip
    return out


def assignments_on(employee_ids, ref_date: date) -> dict[int, EmployeeShiftAssignment]:
    """{employee_id: the shift assignment in force on ref_date}: the same pick as payroll_views._get_active_assignment
    (effective on that day, the latest start wins), for many employees in one query."""
    out: dict[int, EmployeeShiftAssignment] = {}
    rows = (
        EmployeeShiftAssignment.objects.select_related("shift")
        .filter(employee_id__in=list(employee_ids), effective_from__lte=ref_date)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=ref_date))
        .order_by("-effective_from", "-id")
    )
    for row in rows:
        out.setdefault(row.employee_id, row)
    return out


def holiday_dates_of(year: int, month: int) -> set[date]:
    """The month's company holidays, as payroll reads them (company-wide)."""
    return set(Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True))


def casual_leave_dates(employee_ids, year: int, month: int) -> dict[int, set[date]]:
    """{employee_id: dates of APPROVED Casual Leave in the month}. An approved CL day is stored as an ordinary Present
    day, so this is the only way to tell it apart (attendance_final.day_calendar_facts, for many employees at once)."""
    out: dict[int, set[date]] = {}
    rows = CasualLeaveRequest.objects.filter(
        employee_id__in=list(employee_ids),
        date__year=year,
        date__month=month,
        status=CasualLeaveRequest.STATUS_APPROVED,
    ).values_list("employee_id", "date")
    for employee_id, day in rows:
        out.setdefault(employee_id, set()).add(day)
    return out


def outstanding_advances(employee_ids) -> dict[int, Decimal]:
    """{employee_id: what is still owed on their running (approved, not yet closed) advances}, in one query."""
    rows = (
        Advance.objects.filter(employee_id__in=list(employee_ids), status=Advance.STATUS_APPROVED)
        .values("employee_id")
        .annotate(owed=Sum("outstanding"))
    )
    return {row["employee_id"]: dec(row["owed"] or 0) for row in rows}


def advance_balances_before(employee_ids, year: int, month: int) -> dict[int, Decimal]:
    """{employee_id: what they owed on advances BEFORE the recovery of `month` / `year`}, in two queries.

    That is what is still outstanding now plus everything recovered through payroll from that month on (an advance's
    repayments are keyed by the month they are deducted in, and a production period by the month it ends in). For the
    month being paid it is exactly 'outstanding advances + this month's advance deduction'; for an earlier month it
    also puts back what was recovered since, so an old statement still shows the balance of its own time. An advance
    closed by those repayments counts too, a rejected or still pending one never does."""
    ids = list(employee_ids)
    balance = outstanding_advances(ids)
    since = (
        AdvanceRepayment.objects.filter(
            advance__employee_id__in=ids,
            advance__status__in=(Advance.STATUS_APPROVED, Advance.STATUS_CLOSED),
            is_processed=True,
        )
        .filter(Q(year__gt=year) | Q(year=year, month__gte=month))
        .values("advance__employee_id")
        .annotate(recovered=Sum("amount"))
    )
    for row in since:
        employee_id = row["advance__employee_id"]
        balance[employee_id] = balance.get(employee_id, Decimal("0")) + dec(row["recovered"] or 0)
    return balance


# ─────────────────────────────────────────────────────────────────────────────
#  Employee profile and period shapes
# ─────────────────────────────────────────────────────────────────────────────


def bank_info(emp) -> dict:
    """Payment readiness without the account number: only its last four digits ever leave the server."""
    account = (emp.bank_account or "").strip()
    return {
        "hasAccount": bool(account),
        "bankName": (emp.bank_name or "").strip() or None,
        "hasIfsc": bool((emp.bank_ifsc or "").strip()),
        "accountLast4": account[-4:] if len(account) >= 5 else None,
    }


def split_info(emp) -> dict | None:
    """The recorded salary split (first / second portion and the eight components); None when none is recorded."""
    parts = breakup_of(emp)
    if parts is None:
        return None
    first = sum((parts[c] for c in FIRST_PORTION), Decimal("0"))
    total = sum(parts.values(), Decimal("0"))
    return {
        "first": money(first),
        "second": money(total - first),
        "components": [{"key": JSON_KEYS[c], "label": LABELS[c], "amount": money(parts[c])} for c in COMPONENTS],
    }


def join_date_of(emp) -> date | None:
    """Employee.join_date is free text: the ISO date, or a dd-mm-yyyy / dd/mm/yyyy one, else None."""
    raw = str(emp.join_date or "").strip()
    parsed = parse_iso_date(raw)
    if parsed:
        return parsed
    match = re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", raw)
    if match:
        try:
            return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
        except ValueError:
            return None
    return None


def employee_json(emp) -> dict:
    """The employee block of a details page. Never the photo, password hash, ID proof, address or full account number."""
    joined = join_date_of(emp)
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": full_name(emp),
        "department": emp.department.name if emp.department_id else None,
        "designation": emp.designation.title if emp.designation_id else None,
        "branch": emp.branch.name if emp.branch_id else None,
        "employmentType": emp.employment_type,
        "status": emp.status,
        "joinDate": joined.isoformat() if joined else None,
        "salaryAmount": money(emp.salary_amount) if emp.salary_amount is not None else None,
        "salaryPerShift": money(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
        "payCycle": emp.production_pay_cycle or None,
        "bank": bank_info(emp),
        "pfNumber": (emp.pf_number or "").strip() or None,
        "esiNumber": (emp.esi_number or "").strip() or None,
        "split": split_info(emp),
    }


def staff_period(month: int, year: int) -> dict:
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    return {
        "label": f"{MONTH_NAMES[month - 1]} {year}",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "month": month,
        "year": year,
        "days": (end - start).days + 1,
        "cycle": None,
        "cycleLabel": None,
    }


def production_period(start: date, end: date, cycle: str | None) -> dict:
    """A production period belongs to the month it ENDS in (how payroll attributes its advances)."""
    return {
        "label": period_label(start, end),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "month": end.month,
        "year": end.year,
        "days": (end - start).days + 1,
        "cycle": cycle if cycle in CYCLE_LABELS else None,
        "cycleLabel": CYCLE_LABELS.get(cycle),
    }


def period_of_payroll(payroll: Payroll, cycle: str | None = None) -> dict:
    """The PayrollPeriodInfo of one stored payroll (a legacy row with no period reads as its month or week). `cycle` is
    the pay cycle to name when the row was generated before cycles were stamped on payroll."""
    kind = kind_of(payroll)
    if kind == KIND_STAFF:
        return staff_period(payroll.month, payroll.year)
    if kind == KIND_PRODUCTION:
        return production_period(payroll.period_start, payroll.period_end, payroll.pay_cycle or cycle)
    info = staff_period(payroll.month, payroll.year)
    if payroll.week_number:
        info["label"] = f"Week {payroll.week_number} of {info['label']}"
    return info


def breakdown_of(slip: SalarySlip | None) -> dict | None:
    """The slip's stored day-by-day breakdown, or None when the payroll has no slip or an empty / unreadable one."""
    data = getattr(slip, "breakdown_details", None) if slip is not None else None
    return data if isinstance(data, dict) and data else None


# Payroll.notes is overwritten by the engine on every generation; a note HR typed replaces the whole text.
_AUTO_NOTE_PREFIXES = ("Staff monthly:", "Production period (")


def hr_note_of(payroll: Payroll) -> str | None:
    """The note HR typed on the payroll, or None while it still holds the engine's own summary line."""
    text = (payroll.notes or "").strip()
    if not text or text.startswith(_AUTO_NOTE_PREFIXES):
        return None
    return text


# ─────────────────────────────────────────────────────────────────────────────
#  Reading a stored breakdown
# ─────────────────────────────────────────────────────────────────────────────


def first_half_limit(bd: dict) -> str | None:
    """The latest first punch that still counts as the morning half (shift start + grace + the three arrival windows),
    from the shift and windows STORED on the payroll; None for a payroll with no shift or an older breakdown."""
    shift = bd.get("shift") or {}
    timeline = bd.get("arrivalTimeline") or {}
    start = minutes_of(shift.get("startTime"))
    grace = shift.get("gracePeriodMinutes")
    if start is None or grace is None or not timeline:
        return None
    total = start + int(grace)
    for key in ("lateWindowMinutes", "permissionWindowMinutes", "extraMinutes"):
        total += int(timeline.get(key) or 0)
    return clock_of(total)


def late_window_end(bd: dict) -> str | None:
    """When the Late window ended on this payroll's shift (start + grace + the Late window), or None."""
    shift = bd.get("shift") or {}
    timeline = bd.get("arrivalTimeline") or {}
    start = minutes_of(shift.get("startTime"))
    grace = shift.get("gracePeriodMinutes")
    if start is None or grace is None or "lateWindowMinutes" not in timeline:
        return None
    return clock_of(start + int(grace) + int(timeline.get("lateWindowMinutes") or 0))


def on_time_until(bd: dict) -> str | None:
    shift = bd.get("shift") or {}
    start = minutes_of(shift.get("startTime"))
    grace = shift.get("gracePeriodMinutes")
    if start is None or grace is None:
        return None
    return clock_of(start + int(grace))


def _reason_parts(reason) -> list[str]:
    return [part.strip() for part in str(reason or "").split("; ") if part.strip()]


# ─────────────────────────────────────────────────────────────────────────────
#  Issue detection
# ─────────────────────────────────────────────────────────────────────────────


class _Emitter:
    """Collects the issues of ONE payroll in the PayrollIssue shape (the fields every issue shares are filled once)."""

    def __init__(self, payroll: Payroll, kind: str):
        emp = payroll.employee
        self.payroll = payroll
        self.catalogue = issue_catalogue(kind)
        self.base = {
            "payrollId": payroll.id,
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": full_name(emp),
            "department": emp.department.name if emp.department_id else None,
            "designation": emp.designation.title if emp.designation_id else None,
        }
        self.detected_at = iso_dt(payroll.updated_at)
        self.items: list[dict] = []

    def add(
        self,
        code: str,
        detail: str,
        *,
        day: str | None = None,
        title: str | None = None,
        impact=None,
        rule=None,
        facts=None,
    ):
        meta = self.catalogue[code]
        self.items.append(
            {
                "id": f"{self.payroll.id}:{code}:{day or 'period'}",
                **self.base,
                "code": code,
                "category": meta.category,
                "severity": meta.severity,
                "title": title or meta.label,
                "detail": detail,
                "date": day,
                "detectedAt": self.detected_at,
                "impact": impact or None,
                "rule": rule,
                "facts": {k: v for k, v in (facts or {}).items()},
            }
        )


def _impact(days=None, shifts=None, amount=None, label=None) -> dict | None:
    out: dict = {}
    if days is not None:
        out["days"] = money(days)
    if shifts is not None:
        out["shifts"] = money(shifts)
    if amount is not None:
        out["amount"] = money(amount)
    if label:
        out["label"] = label
    return out or None


def _staff_day_issues(em: _Emitter, bd: dict) -> None:
    daily = dec((bd.get("earnings") or {}).get("dailyRate"))
    shift = bd.get("shift") or {}
    timeline = bd.get("arrivalTimeline") or {}
    quarter = dec(timeline.get("quarterDeduction"), "0.25")
    for d in bd.get("days") or []:
        day = d.get("date")
        status = d.get("status")
        first, last = d.get("firstIn"), d.get("lastOut")
        zone = d.get("arrivalZone") or None
        parts = _reason_parts(d.get("lateReason"))

        if status == "absent":
            em.add(
                "absent",
                "No attendance recorded on this working day, counted as loss of pay",
                day=day,
                impact=_impact(days=1, amount=daily),
                rule=rule_of(SETTINGS["second_half_start"], "A day with no punch in either half is Absent"),
                facts={"dailyRate": money(daily)},
            )
        elif status == "unpaid_leave":
            em.add(
                "unpaid_leave",
                "A leave request was approved for this day, but only Casual Leave is paid: the day is counted as loss of pay",
                day=day,
                impact=_impact(days=1, amount=daily),
                rule=rule_of(None, "Only Casual Leave is a paid leave"),
                facts={"dailyRate": money(daily)},
            )
        if status != "present":
            continue

        shifts = dec(d.get("shiftsCompleted"), "1")
        is_half = bool(d.get("isHalfShift"))

        if d.get("isLate"):
            picked = [p for p in parts if p.lower().startswith("morning late-in")]
            if picked:
                detail = "; ".join(picked)
            elif first:
                deadline = on_time_until(bd)
                detail = (
                    f"First punch {first} is after the deadline {deadline} (shift start {shift.get('startTime')} + "
                    f"{shift.get('gracePeriodMinutes')} min grace)"
                    if deadline
                    else f"First punch {first} after the shift deadline"
                )
            else:
                detail = "Marked late by the attendance rules"
            em.add(
                "late_in",
                detail,
                day=day,
                impact=_impact(label="Counts as 1 late mark"),
                rule=rule_of(SETTINGS["morning_late_in"], "Morning Late-In check (late pool)"),
                facts={"firstIn": first, "arrivalZone": zone, "shift": shift.get("name")},
            )

        if d.get("isEarlyOut"):
            picked = [p for p in parts if p.lower().startswith("evening early-out")]
            detail = (
                "; ".join(picked)
                if picked
                else (
                    f"Last punch {last} is before the shift end deadline"
                    if last
                    else "Marked early out by the attendance rules"
                )
            )
            em.add(
                "early_out",
                detail,
                day=day,
                impact=_impact(label="Counts as 1 early-out mark"),
                rule=rule_of(SETTINGS["evening_early_out"], "Evening Early-Out check (late pool)"),
                facts={"lastOut": last, "shift": shift.get("name")},
            )

        if is_half:
            lost = max(Decimal("0"), Decimal("1") - shifts) if shifts > 0 else Decimal("0.5")
            em.add(
                "half_day",
                _half_day_text(d, bd, lost),
                day=day,
                impact=_impact(days=lost, amount=lost * daily),
                rule=rule_of(SETTINGS["second_half_start"], "Half-day detection"),
                facts={"firstIn": first, "lastOut": last, "arrivalZone": zone, "shiftsPaid": money(shifts)},
            )
        elif zone == "quarter" and shifts < 1:
            cut = Decimal("1") - shifts if shifts > 0 else quarter
            ended = late_window_end(bd)
            when = f" after the Late window ended at {ended}" if ended else " after the Late window"
            em.add(
                "quarter_day",
                f"First punch {first or '-'} came{when} but still inside the first half: {plain(cut)} shift taken "
                f"off the day (paid {plain(Decimal('1') - cut)} of a day)",
                day=day,
                impact=_impact(days=cut, amount=cut * daily),
                rule=rule_of(SETTINGS["quarter_deduction"]),
                facts={"firstIn": first, "arrivalZone": zone, "shiftsPaid": money(shifts)},
            )

        if first and (not last or last == first):
            em.add(
                "missing_punch",
                (
                    f"Only one punch recorded ({first}): there is no departure punch for this day"
                    if not last
                    else f"First and last punch are the same time ({first}), so no departure was recorded"
                ),
                day=day,
                facts={"firstIn": first, "lastOut": last},
            )


def _half_day_text(d: dict, bd: dict, lost: Decimal) -> str:
    """Which half a Half Day was worked, and why: the evening half after the first-half limit, else the morning half."""
    first, last = d.get("firstIn"), d.get("lastOut")
    zone = d.get("arrivalZone") or ""
    limit = first_half_limit(bd)
    second_start = bd.get("halfDaySecondHalfStartTime") or "the second-half start time"
    if zone == "second_half":
        half = "evening"
    elif zone:
        half = "morning"
    else:
        # A manual or older record carries no arrival zone: judge the first punch against the retired fixed cut-off.
        cutoff = minutes_of(bd.get("halfDayFirstHalfEndTime"))
        punched = minutes_of(first)
        half = None if punched is None or cutoff is None else ("morning" if punched < cutoff else "evening")
    if half == "evening":
        why = f"first punch {first} was after the first-half limit" + (f" ({limit})" if limit else "")
        text = f"Only the evening half was worked: {why}"
    elif half == "morning":
        seen = f"last punch {last}" if last else "no later punch"
        text = (
            f"Only the morning half was worked: first punch {first or '-'}, {seen}, nothing at or after {second_start}"
        )
    else:
        text = "Only one half of the day was worked"
    return f"{text}. Paid {plain(Decimal('1') - lost)} of a day"


def _staff_period_issues(em: _Emitter, payroll: Payroll, bd: dict) -> None:
    shift = bd.get("shift") or {}
    earnings = bd.get("earnings") or {}
    ded = bd.get("deductions") or {}
    daily = dec(earnings.get("dailyRate"))
    name = em.base["employeeName"]

    if "shift" in bd and shift.get("id") is None:
        em.add(
            "no_shift",
            f"{name} has no shift assigned for {MONTH_NAMES[payroll.month - 1]} {payroll.year}, so Late-In, Early-Out and "
            "the arrival timeline could not be applied to any day this month. Assign a shift in Manage Shifts and "
            "regenerate to have them checked",
            rule=rule_of(None, "Shift assignment (Manage Shifts)"),
            facts={"shift": shift.get("name")},
        )

    summary = ded.get("lateSummary") or {}
    penalty = dec(ded.get("lateShiftPenalty"))
    if penalty > 0:
        if summary:
            total = int(summary.get("totalLateCount") or 0)
            billable = int(summary.get("billableLateCount") or 0)
            late_in = int(summary.get("lateInCount") or 0)
            early = int(summary.get("earlyOutCount") or 0)
            excess = int(summary.get("excessPermissionCount") or 0)
            free = summary.get("freeAllowance")
            free = int(free) if free is not None else max(0, total - billable)
            cut = dec(summary.get("shiftDeductions"))
            detail = (
                f"{plural(total, 'late occurrence')} ({late_in} late-in, {early} early-out, "
                f"{plural(excess, 'excess permission')}), {free} free, {billable} billable: "
                f"{shifts_text(cut)} x {inr(daily)} daily rate = {inr(penalty)}"
            )
            facts = {
                "lateIn": late_in,
                "earlyOut": early,
                "excessPermissions": excess,
                "total": total,
                "free": free,
                "billable": billable,
                "shiftDeductions": money(cut),
                "dailyRate": money(daily),
            }
            impact = _impact(shifts=cut, amount=penalty)
        else:
            detail = f"{inr(penalty)} was deducted for late arrivals, early departures and excess permissions"
            facts, impact = {}, _impact(amount=penalty)
        em.add("late_penalty", detail, impact=impact, rule=rule_of(SETTINGS["late_slabs"]), facts=facts)

    excess = int(summary.get("excessPermissionCount") or 0)
    if excess > 0:
        cap = summary.get("permissionMonthlyCap")
        of_cap = f" of {cap}" if cap is not None else ""
        em.add(
            "excess_permission",
            f"{plural(excess, 'approved permission')} this month went beyond the monthly cap{of_cap}: each one excuses "
            "nothing and counts as a mark in the late pool instead",
            impact=_impact(label=f"{plural(excess, 'extra late mark')}"),
            rule=rule_of(SETTINGS["permission_cap"]),
            facts={"excessPermissions": excess, "permissionMonthlyCap": cap},
        )

    ot = dec(earnings.get("otAmount"))
    if ot > 0:
        ot_days = int(earnings.get("otDays") or 0)
        em.add(
            "ot_pay",
            f"{plural(ot_days, 'announced overtime day')} paid at one day's pay each ({inr(daily)}): {inr(ot)} was added to the net salary",
            impact=_impact(amount=ot, label="Added to pay"),
            rule=rule_of(SETTINGS["compensation_features"]),
            facts={"otDays": ot_days, "dailyRate": money(daily)},
        )


def _production_day_issues(em: _Emitter, bd: dict) -> None:
    detection_on = (bd.get("deductions") or {}).get("lateSummary") is not None
    for d in bd.get("days") or []:
        day = d.get("date")
        status = d.get("status")
        first, last = d.get("firstPunch"), d.get("lastPunch")
        shifts = dec(d.get("shiftsEarned"))
        worked = status in ("present", "half_shift")

        if status == "absent":
            em.add(
                "absent",
                "No punches were recorded on this day, so no shift was earned",
                day=day,
                impact=_impact(label="No shift earned"),
                facts={"shiftsEarned": 0},
            )
        if d.get("isLate"):
            reason = d.get("lateReason")
            if reason:
                detail = reason
            elif detection_on:
                detail = f"First punch {first} is after the production shift start + grace" if first else "Marked late"
            else:
                detail = (
                    f"First punch {first or '-'} was marked late by the attendance rules. No pay is deducted because "
                    "production late detection is switched off"
                )
            em.add(
                "late_in",
                detail,
                day=day,
                impact=_impact(label="Counts as 1 late day") if detection_on else None,
                facts={"firstPunch": first, "lateDetectionOn": detection_on},
            )
        if worked and first and (not last or last == first):
            em.add(
                "missing_punch",
                (
                    f"Only one punch recorded ({first}): there is no last punch for this day"
                    if not last
                    else f"First and last punch are the same time ({first}), so no departure was recorded"
                ),
                day=day,
                facts={"firstPunch": first, "lastPunch": last},
            )
        if worked and 0 < shifts < 1:
            punches = f" ({first}-{last})" if first and last else ""
            em.add(
                "half_day",
                f"Earned {shifts_text(shifts)}{punches} of a full 1 shift",
                day=day,
                title="Half day" if shifts == Decimal("0.5") else "Part-day shift",
                impact=_impact(
                    shifts=Decimal("1") - shifts, label=f"{shifts_text(Decimal('1') - shifts)} short of a full shift"
                ),
                facts={"shiftsEarned": money(shifts), "firstPunch": first, "lastPunch": last},
            )


def _production_period_issues(em: _Emitter, payroll: Payroll, bd: dict) -> None:
    summary = bd.get("summary") or {}
    ded = bd.get("deductions") or {}
    rate = dec(bd.get("salaryPerShift"))
    start, end = payroll.period_start, payroll.period_end

    if "totalShifts" in summary and dec(summary["totalShifts"]) <= 0:
        em.add(
            "no_attendance",
            f"No shift was earned between {ddmmyyyy(start)} and {ddmmyyyy(end)}: this period pays {inr(0)}",
            impact=_impact(shifts=0, amount=0),
            facts={"daysAbsent": summary.get("daysAbsent")},
        )

    late = ded.get("lateSummary") or {}
    penalty = dec(ded.get("lateShiftPenalty"))
    if penalty > 0:
        total = int(late.get("totalLateCount") or 0)
        billable = int(late.get("billableLateCount") or 0)
        cut = dec(late.get("shiftDeductions"))
        free = max(0, total - billable)
        cycle = payroll.pay_cycle
        em.add(
            "late_penalty",
            f"{plural(total, 'late day')}, {free} free, {billable} billable: {shifts_text(cut)} x {inr(rate)} per shift "
            f"= {inr(penalty)}",
            impact=_impact(shifts=cut, amount=penalty),
            rule=rule_of(cycle_ref(cycle, "late_slabs") or SETTINGS["prod_late_switch"]),
            facts={
                "lateDays": total,
                "free": free,
                "billable": billable,
                "shiftDeductions": money(cut),
                "ratePerShift": money(rate),
            },
        )


def _common_issues(em: _Emitter, payroll: Payroll, slip: SalarySlip | None, bd: dict | None) -> None:
    """Issues staff and production share: advances, HR adjustments and what the profile lacks."""
    emp = payroll.employee
    ded = (bd or {}).get("deductions") or {}
    advances = dec(ded["advances"]) if "advances" in ded else dec(slip.advance_deduction if slip is not None else 0)
    if advances > 0:
        lines = ded.get("advanceDetails") or []
        count = f" across {plural(len(lines), 'repayment')}" if lines else ""
        em.add(
            "advance_recovery",
            f"{inr(advances)} was recovered from this payroll for advances{count}",
            impact=_impact(amount=advances),
            facts={"repayments": len(lines)},
        )

    bonus = dec(payroll.bonus)
    generated = dec(slip.total_deductions) if slip is not None else None
    deductions = dec(payroll.deductions)
    changed = generated is not None and deductions != generated
    if bonus != 0 or changed:
        said = []
        if bonus != 0:
            said.append(f"a bonus of {inr(bonus)}" if bonus > 0 else f"{inr(-bonus)} taken off as a negative bonus")
        if changed:
            said.append(f"deductions changed from {inr(generated)} to {inr(deductions)}")
        detail = f"HR adjusted this payroll after it was generated: {' and '.join(said)}. The net salary is now {inr(payroll.final_salary)}."
        note = hr_note_of(payroll)
        if note:
            detail += f" Note: {note}"
        net_effect = bonus - (deductions - generated if changed else Decimal("0"))
        em.add(
            "adjustment",
            detail,
            impact=_impact(amount=net_effect, label="Change to net salary"),
            facts={
                "bonus": money(bonus),
                "generatedDeductions": money(generated) if generated is not None else None,
                "deductions": money(deductions),
                "note": note,
            },
        )

    account = (emp.bank_account or "").strip()
    ifsc = (emp.bank_ifsc or "").strip()
    if not account or not ifsc:
        lacking = (
            "bank account number and IFSC code"
            if not account and not ifsc
            else ("bank account number" if not account else "IFSC code")
        )
        em.add(
            "bank_missing",
            f"No {lacking} on the profile: the {inr(payroll.final_salary)} net salary cannot be transferred to a bank account",
            facts={
                "hasAccount": bool(account),
                "hasIfsc": bool(ifsc),
                "bankName": (emp.bank_name or "").strip() or None,
            },
        )

    if slip is not None:
        pf, esi = dec(slip.pf_deduction), dec(slip.esi_deduction)
        if pf > 0 and not (emp.pf_number or "").strip():
            em.add(
                "pf_number_missing",
                f"{inr(pf)} PF was deducted but the profile has no PF number",
                facts={"pfDeducted": money(pf)},
            )
        if esi > 0 and not (emp.esi_number or "").strip():
            em.add(
                "esi_number_missing",
                f"{inr(esi)} ESI was deducted but the profile has no ESI number",
                facts={"esiDeducted": money(esi)},
            )


def detect_issues(payroll: Payroll, slip: SalarySlip | None) -> list[dict]:
    """Every issue of one payroll, built only from what was stored (breakdown, payroll row, profile). Needs
    payroll.employee loaded with its department and designation. Unsorted: see sort_issues."""
    kind = kind_of(payroll)
    if kind == KIND_LEGACY:
        return []
    bd = breakdown_of(slip)
    em = _Emitter(payroll, kind)
    if bd is not None:
        if kind == KIND_STAFF and bd.get("type", "staff") == "staff":
            _staff_day_issues(em, bd)
            _staff_period_issues(em, payroll, bd)
        elif kind == KIND_PRODUCTION and bd.get("type") == "production":
            _production_day_issues(em, bd)
            _production_period_issues(em, payroll, bd)
    _common_issues(em, payroll, slip, bd)
    return em.items


def sort_issues(issues: list[dict]) -> list[dict]:
    """Oldest day first, then the worst severity, then the employee's name; issues about the whole period come last."""
    return sorted(
        issues,
        key=lambda i: (
            i["date"] is None,
            i["date"] or "",
            SEVERITY_RANK.get(i["severity"], 9),
            i["employeeName"].lower(),
            i["code"],
        ),
    )


def issue_counts(issues: list[dict]) -> dict:
    """The small summary a details page shows: total, by severity and by code."""
    by_severity = {"critical": 0, "warning": 0, "info": 0}
    by_code: dict[str, int] = {}
    for issue in issues:
        by_severity[issue["severity"]] = by_severity.get(issue["severity"], 0) + 1
        by_code[issue["code"]] = by_code.get(issue["code"], 0) + 1
    return {"total": len(issues), "bySeverity": by_severity, "byCode": by_code}


def summarize_issues(issues: list[dict], payrolls, kind: str) -> dict:
    """PayrollIssuesSummary: counts by severity, by code (with the code's label / severity / category) and by department."""
    catalogue = issue_catalogue(kind)
    by_severity = {"critical": 0, "warning": 0, "info": 0}
    by_code: dict[str, int] = {}
    by_department: dict[str, int] = {}
    with_issues: set[int] = set()
    for issue in issues:
        by_severity[issue["severity"]] += 1
        by_code[issue["code"]] = by_code.get(issue["code"], 0) + 1
        department = issue["department"] or "No department"
        by_department[department] = by_department.get(department, 0) + 1
        with_issues.add(issue["employeeId"])
    codes = [
        {
            "code": code,
            "label": catalogue[code].label,
            "severity": catalogue[code].severity,
            "category": catalogue[code].category,
            "count": count,
        }
        for code, count in by_code.items()
    ]
    codes.sort(key=lambda c: (SEVERITY_RANK[c["severity"]], -c["count"], c["label"]))
    return {
        "employees": len(list(payrolls)),
        "employeesWithIssues": len(with_issues),
        "total": len(issues),
        "bySeverity": by_severity,
        "byCode": codes,
        "byDepartment": [
            {"department": name, "count": count}
            for name, count in sorted(by_department.items(), key=lambda kv: (-kv[1], kv[0].lower()))
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Money lines and days of one payroll
# ─────────────────────────────────────────────────────────────────────────────


def _line(key, label, amount, kind, note=None, rule_key=None) -> dict:
    return {"key": key, "label": label, "note": note, "amount": money(amount), "kind": kind, "ruleKey": rule_key}


def money_lines(payroll: Payroll, slip: SalarySlip | None, bd: dict | None) -> tuple[list[dict], list[dict]]:
    """(earnings, deductions) of a payroll as lines the page draws directly, each with how it was worked out. A line
    exists only when it explains something (a PF line with a 0% rate is left out); both lists end with their total."""
    staff = kind_of(payroll) == KIND_STAFF
    bd = bd or {}
    e = bd.get("earnings") or {}
    d = bd.get("deductions") or {}
    s = bd.get("summary") or {}
    gross, bonus, ot = dec(payroll.gross_salary), dec(payroll.bonus), dec(payroll.ot_amount)
    earnings: list[dict] = []
    deductions: list[dict] = []

    # ── earnings ──
    if staff:
        monthly = dec(e.get("monthlySalary") if e else payroll.base_salary)
        working = int(s.get("totalWorkingDays") or payroll.total_working_days or 0)
        eff = s.get("effectivePaidDays")
        daily = dec(e.get("dailyRate"))
        if e:
            earnings.append(
                _line(
                    "daily_rate",
                    "Daily rate",
                    daily,
                    "info",
                    f"{inr(monthly)} / {working} working days",
                    "working_days",
                )
            )
        note = (
            f"{inr(monthly)} / {working} working days x {plain(eff)} {'day' if dec(eff) == 1 else 'days'} paid"
            if e and working and eff is not None
            else "The salary earned for the days paid"
        )
        earnings.append(_line("gross", "Salary earned", gross, "earning", note, "monthly_salary"))
        if e:
            earnings.append(
                _line(
                    "basic",
                    "of which Basic",
                    e.get("basic"),
                    "info",
                    "50% of the monthly salary, prorated by days paid",
                )
            )
            earnings.append(
                _line("hra", "of which HRA", e.get("hra"), "info", "20% of the monthly salary, prorated by days paid")
            )
            earnings.append(
                _line("allowances", "of which Allowances", e.get("allowances"), "info", "The rest of the salary earned")
            )
        if ot > 0:
            days_ = int(e.get("otDays") or 0)
            earnings.append(
                _line(
                    "ot_pay",
                    "Overtime pay",
                    ot,
                    "earning",
                    f"{plural(days_, 'announced overtime day')} x one day's pay ({inr(daily)})"
                    if days_ and daily
                    else None,
                    "compensation_features",
                )
            )
    else:
        shifts = s.get("totalShifts")
        rate = dec(bd.get("salaryPerShift"))
        note = (
            f"{plain(shifts)} shifts x {inr(rate)} per shift"
            if shifts is not None and rate
            else "Shifts earned x salary per shift"
        )
        earnings.append(_line("gross", "Pay for shifts worked", gross, "earning", note, "salary_per_shift"))
    if bonus != 0:
        earnings.append(_line("bonus", "HR bonus", bonus, "earning", "Added by HR after the payroll was generated"))
    total_earned = gross + ot + bonus
    saved_net = dec(payroll.final_salary)
    owed = total_earned - dec(payroll.deductions)
    if saved_net != owed:
        earnings.append(
            _line(
                "net_difference",
                "Difference in the saved net salary",
                saved_net - owed,
                "info",
                "The saved net salary is not earnings minus deductions (for example overtime pay that was left out when "
                "the payroll was last edited)",
            )
        )
    earnings.append(_line("total_earnings", "Total earnings", total_earned, "subtotal"))

    # ── deductions ──
    pf = dec(d["pf"] if "pf" in d else (slip.pf_deduction if slip is not None else 0))
    esi = dec(d["esi"] if "esi" in d else (slip.esi_deduction if slip is not None else 0))
    pf_rate, esi_rate = dec(d.get("pfRate")), dec(d.get("esiRate"))
    band = d.get("pfEfRule")
    off = "Not deducted: the PF / ESI switch was off when this payroll was generated, or no pay was earned"
    if pf > 0 or pf_rate > 0:
        if staff:
            note = f"{plain(pf_rate)}% of Basic {inr(e.get('basic'))}" if pf > 0 and e else off
        elif pf > 0 and band:
            note = f"{plain(band.get('pfRate'))}% of the period pay {inr(gross)} (salary band {band.get('label')})"
        elif pf > 0:
            note = f"{plain(pf_rate)}% of the period pay {inr(gross)}"
        else:
            note = off
        deductions.append(
            _line("pf", "Provident Fund (PF)", pf, "deduction", note, "pf_ef_rule" if band else "pf_rate")
        )
    if esi > 0 or esi_rate > 0:
        ceiling = dec(d.get("esiApplicableBelow"))
        what = "earned pay" if staff else "the period pay"
        if esi > 0 and band:
            note = f"{plain(band.get('efRate'))}% of {what} {inr(gross)} (salary band {band.get('label')})"
        elif esi > 0:
            note = f"{plain(esi_rate)}% of {what} {inr(gross)}"
        elif staff and ceiling and dec(e.get("monthlySalary")) > ceiling:
            note = f"Not deducted: the monthly salary {inr(e.get('monthlySalary'))} is above the ESI ceiling {inr(ceiling)}"
        else:
            note = off
        deductions.append(
            _line("esi", "ESI" if staff else "ESI / EF", esi, "deduction", note, "pf_ef_rule" if band else "esi_rate")
        )

    advances = dec(d["advances"]) if "advances" in d else dec(slip.advance_deduction if slip is not None else 0)
    if advances > 0:
        lines = d.get("advanceDetails") or []
        deductions.append(
            _line(
                "advances",
                "Advance recovery",
                advances,
                "deduction",
                f"{plural(len(lines), 'repayment')} due this month" if lines else None,
            )
        )

    penalty = d.get("lateShiftPenalty")
    penalty = dec(penalty if penalty is not None else (slip.other_deductions if slip is not None and staff else 0))
    if penalty > 0:
        late = d.get("lateSummary") or {}
        per = dec(e.get("dailyRate")) if staff else dec(bd.get("salaryPerShift"))
        unit = "daily rate" if staff else "per shift"
        noun = "billable late mark" if staff else "billable late day"
        note = (
            f"{shifts_text(late.get('shiftDeductions'))} x {inr(per)} {unit} ({plural(late.get('billableLateCount'), noun)})"
            if late
            else None
        )
        deductions.append(_line("late_penalty", "Late deduction", penalty, "deduction", note, "late_slabs"))

    generated = dec(slip.total_deductions) if slip is not None else None
    hr_change = dec(payroll.deductions) - generated if generated is not None else Decimal("0")
    if hr_change != 0:
        deductions.append(
            _line(
                "hr_deduction",
                "HR deduction adjustment",
                hr_change,
                "deduction",
                "Changed by HR after the payroll was generated",
            )
        )
    deductions.append(_line("total_deductions", "Total deductions", payroll.deductions, "subtotal"))
    return earnings, deductions


def normalized_days(bd: dict | None, issues: list[dict]) -> list[dict]:
    """The days of a payroll in one shape for staff and production: status, punches, shifts earned and the issue codes
    each day raised (flags)."""
    if not bd:
        return []
    flags: dict[str, list[str]] = {}
    for issue in issues:
        if issue["date"]:
            codes = flags.setdefault(issue["date"], [])
            if issue["code"] not in codes:
                codes.append(issue["code"])
    out = []
    production = bd.get("type") == "production"
    for d in bd.get("days") or []:
        day = d.get("date")
        parsed = parse_iso_date(day)
        if production:
            first, last, shifts, status = (
                d.get("firstPunch"),
                d.get("lastPunch"),
                d.get("shiftsEarned"),
                d.get("status"),
            )
        else:
            first, last, shifts, status = d.get("firstIn"), d.get("lastOut"), d.get("shiftsCompleted"), d.get("status")
        out.append(
            {
                "date": day,
                "day": d.get("day") or (WEEKDAY_NAMES[parsed.weekday()] if parsed else ""),
                "status": status or "",
                "firstIn": first,
                "lastOut": last,
                "shifts": money(shifts) if shifts is not None else None,
                "flags": flags.get(day, []),
                "note": d.get("lateReason") or None,
            }
        )
    return out
