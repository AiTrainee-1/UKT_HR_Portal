"""Employee Details reports (category ``employees``) of the 2026-11-19 Report Center layout.

    employee-overall-details   one line per employee: personal, contact, employment, HOD, shift, bank, statutory, salary
    employee-fixed-salary      fixed salary / rate per shift, the 50% + 50% split, PF / ESI / TDS, bank, last increment
    employee-monthly-shift     a month, per employee per day: the shift assigned that day, what the day was, shifts earned
    employee-time-card         a period of up to a month: in / out, every punch, hours, status and shifts per day, with
                               staff rules (calendar day) or production rules (shift day) by the employee's own type
    employee-punch-details     every punch with its source, device, location and the day (or shift day) it counts for

Sensitive data (README rule 9): the address and ID proof (Aadhaar) are never printed. Bank and statutory numbers follow
the employee profile's own switch (``employees.profile.bank``); the bank account number is masked to its last 4 digits
unless the role may EDIT payroll (the people who send the bank file). Salary figures need the profile's salary switch and
Salary or Payroll access.

Production join dates stored as spreadsheet serials ('01-01-45640') are read as the dates they stand for
(``join_date_of(decode_serial=True)`` / ``rc_shift.JoinAwareData``).
"""

from __future__ import annotations

import datetime as dt
from collections import Counter, defaultdict
from decimal import Decimal

from api import pf_esi, salary_split
from api.models import BiometricDevice, OnDutyPunchVerification, SalaryIncrement
from api.geo_attendance_views import source_label
from api.production_cycles import CYCLE_LABELS

from .. import filters as F
from ..access import permission_level
from ..common import EMP_COLS, with_subtotals
from ..formatting import full_name, r2
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    HOURS,
    INTEGER,
    MINUTES,
    NUMBER,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .attendance_analysis_common import emp_sort_key, subtotals_within_limit
from .attendance_core_data import (
    STALE_LEAVE,
    STALE_PUNCHES,
    build_day,
    compensation_flags,
    device_of,
    emp_days_guard,
    hhmm,
    hours,
    label_for,
    weekday_text,
)
from .attendance_core_timecard import build_time_card_pdf
from .employees_master_base import (
    age_on,
    blood_group_of,
    branch_name,
    clean,
    code_key,
    department_name,
    gender_label,
    hod_name_map,
    is_active,
    join_date_of,
    mask_tail,
    months_between,
    service_end_dates,
    status_label,
    tenure_text,
)
from .hr_reports import _shift_names
from . import rc_salary_common as salary_common
from .rc_shift import SERIAL_NOTE, JoinAwareData, off_grid, serial_join_count, type_text

CATEGORY = "employees"
NOT_ASSIGNED = "Not assigned"
ZONE_TEXT = {
    "on_time": "On time",
    "late": "Late",
    "excused": "Late (permission)",
    "quarter": "Quarter shift",
    "second_half": "Second half",
}


# ── access helpers ─────────────────────────────────────────────────────────────────────────────────────────


def _visible(request, key: str) -> bool:
    return permission_level(request, key) in ("view", "edit")


def can_see_bank(request) -> bool:
    """Bank and statutory details: the employee profile's own switch (it follows Employees until a role sets it)."""
    return _visible(request, "employees.profile.bank")


def can_see_salary(request) -> bool:
    """Salary figures: the profile's salary switch AND Salary or Payroll access (the employee module alone is not)."""
    return _visible(request, "employees.profile.salary") and (
        _visible(request, "salary") or _visible(request, "payroll")
    )


def full_account_allowed(request) -> bool:
    """The whole bank account number only for roles that may edit payroll (they prepare the bank transfer file)."""
    return permission_level(request, "payroll") == "edit"


def account_text(value, full: bool) -> str | None:
    text = "".join((value or "").split())
    if not text:
        return None
    return text if full else mask_tail(text)


def statutory_text(emp) -> str:
    category = pf_esi.category_of(emp)
    if category == pf_esi.CATEGORY_TDS:
        return f"TDS {r2(emp.tds_percent):g}%" if emp.tds_percent is not None else "TDS"
    if category == pf_esi.CATEGORY_CO_EMP:
        return "Co Emp (PF / ESI)"
    return "Not covered"


def pay_basis(emp) -> str:
    if emp.employment_type == "production":
        return "Per shift"
    return "Weekly" if (emp.salary_type or "").strip().lower() == "weekly" else "Monthly"


# ═════════════════════════════════════════════════════════════════════════════
#  employee-overall-details
# ═════════════════════════════════════════════════════════════════════════════

OVERALL_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("unitCode", "Unit Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("gender", "Gender", TEXT, 0.8),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.2),
    ColumnSpec("age", "Age", INTEGER, 0.6),
    ColumnSpec("fatherName", "Father's Name", TEXT, 1.5),
    ColumnSpec("motherName", "Mother's Name", TEXT, 1.5),
    ColumnSpec("bloodGroup", "Blood Group", TEXT, 0.7),
    ColumnSpec("phone", "Phone", TEXT, 1.2),
    ColumnSpec("email", "Email", TEXT, 1.8),
    ColumnSpec("emergencyContact", "Emergency Contact", TEXT, 1.4),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("designation", "Designation", TEXT, 1.4),
    ColumnSpec("branch", "Unit / Branch", TEXT, 1.2),
    ColumnSpec("employmentType", "Type", BADGE, 1.0),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("joinDate", "Join Date", DATE, 1.2),
    ColumnSpec("service", "Service", TEXT, 0.8),
    ColumnSpec("probationEnd", "Probation Ends", DATE, 1.2),
    ColumnSpec("confirmationDate", "Confirmed On", DATE, 1.2),
    ColumnSpec("hod", "HOD", TEXT, 1.4),
    ColumnSpec("shift", "Shift Today", TEXT, 1.4),
    ColumnSpec("payCycle", "Pay Cycle", TEXT, 1.0),
    ColumnSpec("bankName", "Bank", TEXT, 1.3),
    ColumnSpec("bankIfsc", "IFSC", TEXT, 1.1),
    ColumnSpec("bankAccount", "Bank Account", TEXT, 1.5),
    ColumnSpec("pfNumber", "PF Number", TEXT, 1.3),
    ColumnSpec("esiNumber", "ESI Number", TEXT, 1.3),
    ColumnSpec("uanNumber", "UAN", TEXT, 1.2),
    ColumnSpec("statutory", "PF / ESI / TDS", TEXT, 1.3),
    ColumnSpec("payBasis", "Pay Basis", TEXT, 0.9),
    ColumnSpec("monthlySalary", "Fixed Salary", CURRENCY, 1.2),
    ColumnSpec("ratePerShift", "Rate per Shift", CURRENCY, 1.1),
)
BANK_KEYS = ("bankName", "bankIfsc", "bankAccount", "pfNumber", "esiNumber", "uanNumber", "statutory")
SALARY_KEYS = ("payBasis", "monthlySalary", "ratePerShift")


def _overall_run(ctx) -> ReportResult:
    today = ctx.today
    show_bank, show_salary = can_see_bank(ctx.request), can_see_salary(ctx.request)
    full_account = show_bank and full_account_allowed(ctx.request)
    emps = sorted(ctx.employees(), key=lambda e: code_key(e.employee_code))[: ctx.row_limit]
    hods = hod_name_map(emps)
    shifts = _shift_names((e.id for e in emps), today)
    served_to = service_end_dates(emps, today)

    rows = []
    states: Counter = Counter()
    for e in emps:
        joined, state = join_date_of(e, decode_serial=True)
        states[state] += 1
        shift = shifts.get(e.id)
        prod = e.employment_type == "production"
        rows.append(
            {
                "employeeCode": e.employee_code,
                "unitCode": clean(e.unit_code),
                "employeeName": full_name(e),
                "gender": gender_label(e.gender),
                "dateOfBirth": e.date_of_birth,
                "age": age_on(e.date_of_birth, today),
                "fatherName": clean(e.father_name),
                "motherName": clean(e.mother_name),
                "bloodGroup": blood_group_of(e.blood_group) or clean(e.blood_group),
                "phone": clean(e.phone),
                "email": clean(e.email),
                "emergencyContact": clean(e.emergency_contact),
                "department": department_name(e),
                "designation": e.designation.title if e.designation_id else None,
                "branch": branch_name(e),
                "employmentType": type_text(e),
                "status": status_label(e.status),
                "joinDate": joined,
                "service": tenure_text(months_between(joined, served_to[e.id])) if joined else None,
                "probationEnd": e.probation_end_date,
                "confirmationDate": e.confirmation_date,
                "hod": hods.get(e.id) or NOT_ASSIGNED,
                "shift": (shift[0] + (" (starts later)" if shift[1] else "")) if shift else NOT_ASSIGNED,
                "payCycle": CYCLE_LABELS.get(e.production_pay_cycle, e.production_pay_cycle) if prod else None,
                "bankName": clean(e.bank_name),
                "bankIfsc": clean(e.bank_ifsc),
                "bankAccount": account_text(e.bank_account, full_account),
                "pfNumber": clean(e.pf_number),
                "esiNumber": clean(e.esi_number),
                "uanNumber": clean(e.uan_number),
                "statutory": statutory_text(e),
                "payBasis": pay_basis(e),
                "monthlySalary": r2(e.salary_amount) if not prod and e.salary_amount else None,
                "ratePerShift": r2(e.salary_per_shift) if prod and e.salary_per_shift else None,
            }
        )

    hidden = set()
    if not show_bank:
        hidden |= set(BANK_KEYS)
    if not show_salary:
        hidden |= set(SALARY_KEYS)
    columns = [c for c in OVERALL_COLUMNS if c.key not in hidden]
    summary = [
        {"label": "Employees", "value": len(emps), "format": "integer"},
        {"label": "Active", "value": sum(is_active(e) for e in emps), "format": "integer"},
        {"label": "Staff", "value": sum(e.employment_type == "staff" for e in emps), "format": "integer"},
        {"label": "Production", "value": sum(e.employment_type == "production" for e in emps), "format": "integer"},
        {"label": "No HOD assigned", "value": sum(e.id not in hods for e in emps), "format": "integer"},
        {"label": "No shift assigned", "value": sum(e.id not in shifts for e in emps), "format": "integer"},
    ]
    notes = [
        "Address and ID proof (Aadhaar) are never printed in reports. Age and service are as on "
        f"{today.strftime('%d-%b-%Y')}; the service of an employee who has left runs to the exit date.",
        "HOD is the one department head the employee's requests are approved by; Shift Today is the shift in force "
        "today (the one scheduled to start later when none is in force yet).",
    ]
    if show_bank:
        notes.append(
            "The full bank account number is shown because your role may edit payroll."
            if full_account
            else "Bank account numbers are masked to their last 4 digits (the full number needs Payroll edit access)."
        )
    else:
        notes.append("Bank and statutory details are hidden: your role cannot see them on the employee profile.")
    if not show_salary:
        notes.append("Salary columns are hidden: they need the profile's salary details and Salary or Payroll access.")
    else:
        notes.append("Fixed salary is the staff monthly (or weekly) salary; production employees are paid per shift.")
    if states["serial"]:
        notes.append(SERIAL_NOTE.format(n=states["serial"]))
    if states["unreadable"] or states["missing"]:
        notes.append(
            f"{states['unreadable'] + states['missing']} employee(s) have no joining date on file, or one that cannot "
            "be read; their join date and service are blank."
        )
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-overall-details",
        title="Employee Overall Details",
        description="Every employee in one line: personal, contact, employment, unit, HOD, shift, bank (masked), "
        "statutory numbers and salary.",
        category=CATEGORY,
        modules=("employees",),
        icon="IdCard",
        tags=("employee", "details", "master", "personal", "contact", "bank", "pf", "esi", "uan", "hod", "shift"),
        filters=(*F.scope(status="active"),),
        columns=OVERALL_COLUMNS,
        run=_overall_run,
        pdf_max_rows=2_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  employee-fixed-salary
# ═════════════════════════════════════════════════════════════════════════════

_FIRST = salary_split.FIRST_PORTION
_SECOND = salary_split.SECOND_PORTION
SPLIT_KEYS = {c: "split" + "".join(p.title() for p in c.split("_")) for c in salary_split.COMPONENTS}
SPLIT_COLUMNS = []
for _c in _FIRST:
    SPLIT_COLUMNS.append(ColumnSpec(SPLIT_KEYS[_c], salary_split.LABELS[_c], CURRENCY, 1.0, total="sum"))
SPLIT_COLUMNS.append(ColumnSpec("firstPortion", "First 50%", CURRENCY, 1.1, total="sum"))
for _c in _SECOND:
    SPLIT_COLUMNS.append(ColumnSpec(SPLIT_KEYS[_c], salary_split.LABELS[_c], CURRENCY, 1.0, total="sum"))
SPLIT_COLUMNS.append(ColumnSpec("secondPortion", "Second 50%", CURRENCY, 1.1, total="sum"))

FIXED_COLUMNS = (
    *EMP_COLS,
    ColumnSpec("employmentType", "Type", BADGE, 1.0),
    ColumnSpec("branch", "Unit / Branch", TEXT, 1.1),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("payBasis", "Pay Basis", TEXT, 0.9),
    ColumnSpec("monthlySalary", "Fixed Salary", CURRENCY, 1.2, total="sum"),
    ColumnSpec("ratePerShift", "Rate per Shift", CURRENCY, 1.1),
    *SPLIT_COLUMNS,
    ColumnSpec("splitState", "Split", BADGE, 1.0),
    ColumnSpec("pfEsi", "PF / ESI / TDS", TEXT, 1.6),
    ColumnSpec("bankName", "Bank", TEXT, 1.2),
    ColumnSpec("bankIfsc", "IFSC", TEXT, 1.1),
    ColumnSpec("bankAccount", "Bank Account", TEXT, 1.4),
    ColumnSpec("initialSalary", "Initial Salary", CURRENCY, 1.1),
    ColumnSpec("lastIncrementDate", "Last Increment", DATE, 1.1),
    ColumnSpec("lastIncrementPct", "Increment %", NUMBER, 0.8),
)
FIXED_BANK_KEYS = ("bankName", "bankIfsc", "bankAccount")
SPLIT_RECORDED, SPLIT_AUTOMATIC = "Recorded", "Automatic"


def _pf_esi_text(cov: dict | None) -> str | None:
    if cov is None:
        return None
    status = cov["status"]
    if status == pf_esi.STATUS_TDS:
        return f"TDS {cov['tdsPercent']:g}%" if cov.get("tdsPercent") is not None else "TDS"
    if status == pf_esi.STATUS_NOT_CO_EMP:
        return "Not covered"
    if status == pf_esi.STATUS_NOT_EVALUATED:
        return "Co Emp: no slip yet"
    parts = []
    if cov.get("pf"):
        parts.append(f"PF {cov['pfRatePercent']:g}%")
    if cov.get("esi"):
        parts.append(f"ESI {cov['esiRatePercent']:g}%")
    return " + ".join(parts) if parts else "Co Emp: no rule matches"


def _fixed_run(ctx) -> ReportResult:
    show_bank = can_see_bank(ctx.request)
    full_account = show_bank and full_account_allowed(ctx.request)
    # staff salary needs Salary or Payroll, production rates Salary or Production Payroll (the Salary category's rule)
    kinds, kind_notes = salary_common.visible_kinds(ctx, salary_common.SALARY_MODULES)
    emps = sorted(salary_common.employees_by_kind(ctx, kinds), key=lambda e: code_key(e.employee_code))[: ctx.row_limit]
    coverage = {r["id"]: r for r in pf_esi.coverage_rows(emps)}
    incs: dict[int, list] = defaultdict(list)
    for i in (
        SalaryIncrement.objects.filter(ctx.emp_q("employee__"))
        .order_by("employee_id", "effective_date", "id")
        .values("employee_id", "previous_salary", "percent", "effective_date")
    ):
        incs[i["employee_id"]].append(i)

    rows = []
    states: Counter = Counter()
    split_counts: Counter = Counter()
    for e in emps:
        prod = e.employment_type == "production"
        joined, state = join_date_of(e, decode_serial=True)
        states[state] += 1
        parts, recorded = salary_split.effective_split(e)
        history = incs.get(e.id, [])
        last = history[-1] if history else None
        initial = e.initial_salary or (history[0]["previous_salary"] if history else None)
        row = {
            "employeeCode": e.employee_code,
            "employeeName": full_name(e),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "employmentType": type_text(e),
            "branch": branch_name(e),
            "joinDate": joined,
            "payBasis": pay_basis(e),
            "monthlySalary": r2(e.salary_amount) if e.salary_amount else None,
            "ratePerShift": r2(e.salary_per_shift) if prod and e.salary_per_shift else None,
            "splitState": (SPLIT_RECORDED if recorded else SPLIT_AUTOMATIC) if parts else None,
            "pfEsi": _pf_esi_text(coverage.get(e.id)),
            "bankName": clean(e.bank_name),
            "bankIfsc": clean(e.bank_ifsc),
            "bankAccount": account_text(e.bank_account, full_account),
            "initialSalary": r2(initial) if initial else None,
            "lastIncrementDate": last["effective_date"] if last else None,
            "lastIncrementPct": r2(last["percent"]) if last and last["percent"] is not None else None,
        }
        if parts:
            split_counts[row["splitState"]] += 1
            for c in salary_split.COMPONENTS:
                row[SPLIT_KEYS[c]] = r2(parts[c])
            row["firstPortion"] = r2(sum(parts[c] for c in _FIRST))
            row["secondPortion"] = r2(sum(parts[c] for c in _SECOND))
        rows.append(row)

    columns = [c for c in FIXED_COLUMNS if show_bank or c.key not in FIXED_BANK_KEYS]
    staff = [e for e in emps if e.employment_type != "production" and e.salary_amount]
    prod_rates = [e.salary_per_shift for e in emps if e.employment_type == "production" and e.salary_per_shift]
    summary = [
        {"label": "Employees", "value": len(emps), "format": "integer"},
        {
            "label": "Fixed salary (staff)",
            "value": r2(sum((e.salary_amount for e in staff), Decimal(0))),
            "format": "currency",
        },
        {
            "label": "Average rate per shift",
            "value": r2(sum(prod_rates, Decimal(0)) / len(prod_rates)) if prod_rates else None,
            "format": "currency",
        },
        {"label": "Split recorded", "value": split_counts[SPLIT_RECORDED], "format": "integer"},
        {
            "label": "Co Emp (PF / ESI)",
            "value": sum(pf_esi.category_of(e) == pf_esi.CATEGORY_CO_EMP for e in emps),
            "format": "integer",
        },
        {"label": "No bank account", "value": sum(not clean(e.bank_account) for e in emps), "format": "integer"},
    ]
    notes = [
        "Fixed salary is the salary on the employee record (monthly, or weekly where the record says so); production "
        "employees are paid per shift. Payroll pays from these figures and attendance.",
        "The split is the mandatory 50% + 50% breakdown (Basic + DA + Retaining Allowance | Other + Petrol + HRA + "
        "Special Allowance + CA). Recorded = saved on the employee; Automatic = none saved yet, so the even split of the "
        "salary is shown (what PF / ESI judge with). A production worker's split applies to each period's earnings.",
        "PF / ESI / TDS: Co Emp employees get PF and ESI by the Settings rules (staff on the current split, production on "
        "the monthly equivalent of their latest slip), TDS employees have tax deducted instead, everyone else neither.",
        "Last increment = the latest revision recorded on the Increment page; an edit made on the employee directly "
        "leaves no history, and production rate changes are not recorded.",
    ]
    if show_bank:
        notes.append(
            "The full bank account number is shown because your role may edit payroll."
            if full_account
            else "Bank account numbers are masked to their last 4 digits (the full number needs Payroll edit access)."
        )
    else:
        notes.append("Bank details are hidden: your role cannot see them on the employee profile.")
    if states["serial"]:
        notes.append(SERIAL_NOTE.format(n=states["serial"]))
    notes.extend(kind_notes)
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-fixed-salary",
        title="Employee Fixed Salary Details",
        description="Fixed salary or rate per shift, the 50% + 50% split components, PF / ESI / TDS, bank (masked) "
        "and the last increment of every employee.",
        category=CATEGORY,
        modules=("salary", "payroll", "production_payroll"),
        icon="Wallet",
        tags=("salary", "fixed", "split", "basic", "da", "hra", "pf", "esi", "tds", "bank", "increment", "rate"),
        filters=(*F.scope(status="active"),),
        columns=FIXED_COLUMNS,
        run=_fixed_run,
        pdf_max_rows=2_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  employee-monthly-shift
# ═════════════════════════════════════════════════════════════════════════════

MONTHLY_COLUMNS = (
    *EMP_COLS[:3],
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.5),
    ColumnSpec("assignedShift", "Assigned Shift", TEXT, 1.5),
    ColumnSpec("timings", "Timings", TEXT, 1.1),
    ColumnSpec("dayRule", "Group / Arrival", TEXT, 1.2),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("firstIn", "First In", TIME, 0.7),
    ColumnSpec("lastOut", "Last Out", TIME, 0.7),
    ColumnSpec("shiftsEarned", "Shifts Earned", NUMBER, 0.8, total="sum"),
    ColumnSpec("flags", "Flags", TEXT, 2.4),
)
NOT_PROCESSED = "Not processed"
MANUAL_ENTRY = "HR entry"
PREVIOUS_CALC = "Previous calculation"


def shift_timings(shift) -> str | None:
    if shift is None or shift.start_time is None or shift.end_time is None:
        return None
    return f"{hhmm(shift.start_time)}-{hhmm(shift.end_time)}"


def production_group(data, rec) -> str | None:
    """The shift-table group that judged a stored production day (Day / Night / Sunday / a special shift)."""
    if rec is None:
        return None
    if rec.source == "manual":
        return MANUAL_ENTRY
    judged = data.prod_judge().judgement(rec)
    if judged is not None and judged.group is not None:
        return judged.group.label
    return PREVIOUS_CALC if rec.first_punch is not None else None


def day_flags(rec, emp) -> list[str]:
    """What shaped a stored day, in words: the flags the Attendance screens show plus the arrival timeline."""
    if rec is None:
        return []
    out: list[str] = []
    if rec.is_late:
        out.append("Late")
    if (rec.arrival_zone or "") == "quarter":
        out.append("Quarter shift (-0.25)")
    if rec.early_leave:
        out.append("Early out")
    if rec.penalty_early_out:
        out.append(f"Penalty early out (-{Decimal(rec.penalty_deduction or 0).normalize():f})")
    if rec.is_half_day_leave:
        out.append("Half-day leave")
    if rec.morning_permission_applied or rec.evening_permission_applied or rec.middle_permission_today:
        out.append("Permission")
    out.extend(compensation_flags(rec))
    if rec.source == "manual":
        out.append("HR override")
    if emp.employment_type == "production" and off_grid(rec.shifts_earned or 0):
        out.append("Out of date (stored before quarter rounding)")
    return out


def _monthly_run(ctx) -> ReportResult:
    d_from, d_to = ctx.month_range
    today = ctx.today
    days = [d_from + dt.timedelta(days=i) for i in range((d_to - d_from).days + 1)]
    emps = sorted(ctx.employees(), key=emp_sort_key)
    emp_days_guard(len(emps), len(days))
    data = JoinAwareData(ctx, emps, d_from, d_to, service=True)

    rows: list[dict] = []
    names: dict[str, str] = {}
    counts: Counter = Counter()
    for e in emps:
        if len(rows) >= ctx.row_limit:
            break
        prod = e.employment_type == "production"
        names[e.employee_code] = full_name(e)
        for d in days:
            if not data.in_service(e, d):
                continue
            rec = data.record(e.id, d)
            shift = data.shift(e, d)
            kind = data.kind(e, d, rec)
            status = label_for(kind, rec) if rec is not None else (NOT_PROCESSED if d <= today else None)
            counts["no_shift"] += shift is None
            counts["unprocessed"] += status == NOT_PROCESSED
            counts["present"] += kind in ("present", "half")
            flags = day_flags(rec, e)
            counts["stale"] += any(f.startswith("Out of date") for f in flags)
            rows.append(
                {
                    "employeeCode": e.employee_code,
                    "employeeName": names[e.employee_code],
                    "department": department_name(e),
                    "employmentType": type_text(e),
                    "date": d.isoformat(),
                    "day": weekday_text(d),
                    "assignedShift": shift.name if shift is not None else "No shift",
                    "timings": shift_timings(shift),
                    "dayRule": production_group(data, rec)
                    if prod
                    else ZONE_TEXT.get((rec.arrival_zone or "") if rec is not None else ""),
                    "status": status,
                    "firstIn": hhmm(rec.first_punch) if rec is not None else None,
                    "lastOut": hhmm(rec.last_punch) if rec is not None else None,
                    "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                    "flags": "; ".join(flags) or None,
                }
            )
    rows, sub_note = subtotals_within_limit(
        ctx,
        rows,
        lambda r: r["employeeCode"],
        ["shiftsEarned"],
        what="Employee",
        label_key="employeeName",
        label=lambda code: f"{names.get(code, code)} ({code}) total",
    )
    data_rows = [r for r in rows if not r.get("_kind")]
    summary = [
        {"label": "Employees", "value": len({r["employeeCode"] for r in data_rows}), "format": "integer"},
        {"label": "Employee-days", "value": len(data_rows), "format": "integer"},
        {"label": "Days worked", "value": counts["present"], "format": "integer"},
        {
            "label": "Shifts earned",
            "value": round(sum(r["shiftsEarned"] or 0 for r in data_rows), 2),
            "format": "number",
        },
        {"label": "Days with no shift", "value": counts["no_shift"], "format": "integer"},
        {"label": "Days not processed", "value": counts["unprocessed"], "format": "integer"},
    ]
    notes = [
        "Assigned Shift is the shift template in force on that date by the attendance engine's rule (of the assignments "
        "covering a day the latest start wins; custom timings on the assignment replace the template's).",
        "Group / Arrival: for production, the shift-table group that judged the SHIFT DAY (Day / Night / Sunday or a "
        "special shift; a night shift's closing punch next morning belongs to the day it began); for staff, where the "
        "first punch fell on the arrival timeline (On time / Late / Quarter shift / Second half).",
        "Status, first / last punch and shifts earned are the stored day verdict, the figure payroll pays. Days before "
        "joining and after the last working day are not listed.",
    ]
    if counts["stale"]:
        notes.append(
            f"{counts['stale']} production day(s) are flagged Out of date: their value was stored before shifts were "
            "rounded to quarters; payroll works them out again before it pays (reports never recompute a day)."
        )
    if counts["unprocessed"]:
        notes.append(f"{counts['unprocessed']} day(s) up to today have no attendance record yet (Not processed).")
    if sub_note:
        notes.append(sub_note)
    serial = serial_join_count(e for e in emps if e.employment_type == "production")
    if serial:
        notes.append(SERIAL_NOTE.format(n=serial))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-monthly-shift",
        title="Employee Monthly Shift Details",
        description="For a month, each employee's day by day: the shift assigned that day, the group or arrival, "
        "status, first and last punch and shifts earned.",
        category=CATEGORY,
        modules=("attendance", "shifts"),
        icon="CalendarRange",
        tags=("employee", "monthly", "shift", "assigned", "day wise", "shifts earned", "production", "staff"),
        filters=(F.period(), *F.scope(status="active")),
        columns=MONTHLY_COLUMNS,
        run=_monthly_run,
        # a month of every active employee on its defaults (dev data: 256 x 31 = 7,936 rows, an 11.5 s / 1.5 MB PDF);
        # the same ceiling as the screen's, so whatever the screen shows can be had as a PDF
        pdf_max_rows=10_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  employee-time-card
# ═════════════════════════════════════════════════════════════════════════════

TIME_CARD_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 1.9),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("date", "Date", DATE, 1.0),
    ColumnSpec("day", "Day", TEXT, 0.5),
    ColumnSpec("shift", "Shift / Group", TEXT, 1.3),
    ColumnSpec("in1", "In 1", TIME, 0.6),
    ColumnSpec("out1", "Out 1", TIME, 0.6),
    ColumnSpec("in2", "In 2", TIME, 0.6),
    ColumnSpec("out2", "Out 2", TIME, 0.6),
    ColumnSpec("punches", "All Punches", TEXT, 2.0),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.6),
    ColumnSpec("workedHours", "Worked Hrs", HOURS, 0.8, total="sum"),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.7, total="sum"),
    ColumnSpec("earlyOutMinutes", "Early Out (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("otMinutes", "OT (min)", MINUTES, 0.7, total="sum"),
    ColumnSpec("permissionMinutes", "Permission (min)", MINUTES, 0.8, total="sum"),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("shiftsEarned", "Shifts", NUMBER, 0.7, total="sum"),
    ColumnSpec("remarks", "Remarks", TEXT, 2.6),
)
TC_SUM_KEYS = ("workedHours", "lateMinutes", "earlyOutMinutes", "otMinutes", "permissionMinutes", "shiftsEarned")
TIME_CARD_MAX_DAYS = 31


def _punch_text(day) -> str | None:
    """Every punch of the day in order, a next-morning one marked (+1): the shift day's punches for production."""
    parts = []
    for p in day.punches:
        text = hhmm(p.at)
        if p.on > day.date:
            text += f" (+{(p.on - day.date).days})"
        parts.append(text)
    return ", ".join(parts) or None


def _tc_remarks(day, data, today) -> str | None:
    rec, d, emp = day.rec, day.date, day.emp
    out: list[str] = []
    if day.unprocessed:
        out.append("Not processed yet")
    if day.label == "Holiday" and d in data.holidays:
        out.append(f"Holiday: {data.holidays[d]}")
    if day.leave is not None:
        ref = day.leave.leave_type_ref
        out.append(f"Approved leave ({(ref.code or ref.name) if ref is not None else (day.leave.type or 'leave')})")
    if day.perm_types:
        out.append("Permission: " + ", ".join(day.perm_types))
    if rec is not None and rec.source == "manual":
        note = (rec.override_note or "").strip()
        out.append(f"Entered by {rec.override_by or 'HR'}" + (f": {note}" if note else ""))
    for flag in day_flags(rec, emp):
        if flag in ("HR override", "Permission"):
            continue
        if (flag == "Late" and day.late_min) or (flag == "Early out" and day.early_min):
            continue  # the minutes column says it
        out.append(flag)
    for flag in day.flags:
        if flag in (STALE_PUNCHES, STALE_LEAVE) or flag.startswith("Provisional") or flag == "Exit after midnight":
            out.append(flag)
    if emp.employment_type != "production" and rec is not None and day.shift is None:
        out.append("No shift assigned")
    if d != today and day.basis in ("single", "odd"):
        out.append("Single punch" if day.basis == "single" else f"Odd punches ({len(day.punches)})")
        out[-1] += " - worked hours not computed"
    if len(day.punches) > 4:
        out.append("Punches: " + ", ".join(hhmm(p.at) for p in day.punches))
    return "; ".join(dict.fromkeys(out)) or None


def _time_card_run(ctx) -> ReportResult:
    d_from, d_to, today = ctx.date_from, ctx.date_to, ctx.today
    days = ctx.days_in_range
    emps = sorted(ctx.employees(), key=emp_sort_key)
    emp_days_guard(len(emps), len(days))
    data = JoinAwareData(ctx, emps, d_from, d_to, punches=True, leaves=True, permissions=True, service=True)

    rows: list[dict] = []
    cards: dict[str, dict] = {}
    counts: Counter = Counter()
    skipped_days = 0
    for e in emps:
        if len(rows) + len(cards) >= ctx.row_limit:
            break
        prod = e.employment_type == "production"
        shifts_seen: list[str] = []
        n = 0
        for d in days:
            day = build_day(data, e, d)
            if not day.in_service:
                skipped_days += 1
                continue
            rec = day.rec
            group = production_group(data, rec) if prod else (day.shift.name if day.shift is not None else None)
            if group and group not in shifts_seen and group not in (PREVIOUS_CALC, MANUAL_ENTRY):
                shifts_seen.append(group)
            p = day.punches
            at = [hhmm(x.at) for x in p[:4]] + [None] * max(0, 4 - len(p))
            if not p and day.first_in:  # a day HR entered by hand: the times it was given
                at = [day.first_in, day.last_out, None, None]
            rows.append(
                {
                    "employeeCode": e.employee_code,
                    "employeeName": full_name(e),
                    "department": department_name(e),
                    "employmentType": type_text(e),
                    "date": d.isoformat(),
                    "day": weekday_text(d),
                    "shift": group,
                    "in1": at[0],
                    "out1": at[1],
                    "in2": at[2],
                    "out2": at[3],
                    "punches": _punch_text(day),
                    "punchCount": len(p) or None,
                    "workedHours": hours(day.worked_min),
                    "lateMinutes": day.late_min,
                    "earlyOutMinutes": day.early_min,
                    "otMinutes": day.ot_min,
                    "permissionMinutes": day.perm_min,
                    "status": day.label or (NOT_PROCESSED if day.unprocessed else None),
                    "shiftsEarned": float(rec.shifts_earned) if rec is not None else None,
                    "remarks": _tc_remarks(day, data, today),
                }
            )
            n += 1
            counts[day.kind or "none"] += 1
            counts["late"] += bool(rec is not None and rec.is_late)
            counts["unprocessed"] += day.unprocessed
        if n:
            cards[e.employee_code] = {
                "name": full_name(e),
                "department": department_name(e),
                "designation": e.designation.title if e.designation_id else None,
                "type": type_text(e),
                "shifts": shifts_seen,
            }
    rows = with_subtotals(rows, group_by=lambda r: r["employeeCode"], sum_keys=TC_SUM_KEYS)
    ctx._cache["time_card"] = {"employees": cards, "from": d_from, "to": d_to}

    data_rows = [r for r in rows if r.get("_kind") != KIND_SUBTOTAL]
    summary = [
        {"label": "Employees", "value": len(cards), "format": "integer"},
        {"label": "Present days", "value": counts["present"], "format": "integer"},
        {"label": "Half days", "value": counts["half"], "format": "integer"},
        {"label": "Absent days", "value": counts["absent"], "format": "integer"},
        {"label": "Late days", "value": counts["late"], "format": "integer"},
        {
            "label": "Shifts earned",
            "value": round(sum(r["shiftsEarned"] or 0 for r in data_rows), 2),
            "format": "number",
        },
    ]
    notes = [
        "Each employee is read by their own rules: staff by calendar day (shift start / grace, the arrival timeline, "
        "half days, Penalty Early Out), production by SHIFT DAY with the shift table (Settings > Production shifts): a "
        "night shift's closing punch made the next morning is listed on the day the shift began, marked (+1), and the "
        "Shift / Group column names the group that judged the day.",
        "Status, late / early flags and shifts are the attendance engine's stored verdict (what payroll pays); worked "
        "hours, late, early-out and overtime minutes are worked out from the punches and the shift, never saved. In / "
        "Out are positional (1st punch In, 2nd Out ...); All Punches lists every punch, double taps included.",
        "Days before joining and after the last working day are not listed.",
    ]
    if counts["unprocessed"]:
        notes.append(f"{counts['unprocessed']} day(s) have no attendance record yet (Not processed).")
    if d_from <= today <= d_to:
        notes.append("Today's status is provisional until the shift ends.")
    serial = serial_join_count(e for e in emps if e.employment_type == "production")
    if serial:
        notes.append(SERIAL_NOTE.format(n=serial))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-time-card",
        title="Employee Time Card",
        description="One employee (or a few) day by day: in / out, every punch, hours, late, early, status and shifts, "
        "staff by calendar day and production by shift day.",
        category=CATEGORY,
        modules=("attendance",),
        icon="Clock",
        tags=("time card", "timecard", "employee", "punches", "in out", "hours", "shift day", "production", "staff"),
        filters=(F.date_range("thisMonth", label="Period", max_days=TIME_CARD_MAX_DAYS), *F.scope(status="active")),
        columns=TIME_CARD_COLUMNS,
        run=_time_card_run,
        pdf_builder=build_time_card_pdf,
        pdf_max_rows=6_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  employee-punch-details
# ═════════════════════════════════════════════════════════════════════════════

PUNCH_COLUMNS = (
    *EMP_COLS[:3],
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("punchDate", "Punch Date", DATE, 1.1),
    ColumnSpec("punchTime", "Time", TEXT, 0.8, align="center"),
    ColumnSpec("countsFor", "Counts For", DATE, 1.1),
    ColumnSpec("placement", "Placement", TEXT, 1.6),
    ColumnSpec("punchNo", "Punch No", INTEGER, 0.6),
    ColumnSpec("direction", "In / Out", BADGE, 0.6),
    ColumnSpec("source", "Source", TEXT, 1.0),
    ColumnSpec("device", "Device", TEXT, 1.3),
    ColumnSpec("location", "Location", TEXT, 2.4),
)
PUNCH_MAX_DAYS = 62
PLACE_SAME = "Same day"
PLACE_PREVIOUS = "Closes the previous day's shift"
PLACE_NEXT = "Next-day punch"
PLACE_NONE = "Not counted on any day"


def _device_names() -> tuple[dict[str, str], dict[str, str]]:
    by_name, by_serial = {}, {}
    for name, serial in BiometricDevice.objects.values_list("name", "serial_number"):
        if name:
            by_name[name.strip().lower()] = name
        if serial:
            by_serial[serial.strip()] = name or serial
    return by_name, by_serial


def _device_text(source: str, by_name: dict, by_serial: dict) -> str | None:
    label = device_of(source)
    if label is None:
        return None
    if label.startswith("ADMS "):
        serial = label[5:].strip()
        return f"{by_serial[serial]} ({serial})" if serial in by_serial else label
    return by_name.get(label.strip().lower(), label)


def _location_text(source: str, emp, verification) -> str | None:
    if source == "on_duty:approved":
        if verification is None:
            return "On-duty punch (no verification found)"
        text = f"{float(verification.latitude):.5f}, {float(verification.longitude):.5f}"
        if verification.accuracy_m is not None:
            text += f" (±{round(verification.accuracy_m)} m)"
        if verification.is_mocked:
            text += " - mock location reported"
        return text
    if source == "geo:auto":
        return f"Inside the {branch_name(emp)} geofence (location not stored)"
    if source == "missing_punch:approved":
        return "Approved missing-punch request"
    if source.startswith("manual"):
        return "Entered by HR"
    if source == "auto:md":
        return "Generated (MD auto attendance)"
    return None


def _punch_details_run(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    emps = sorted(ctx.employees(), key=emp_sort_key)
    first = d_from - dt.timedelta(days=1)  # a night shift that began the day before can own the range's first punches
    emp_days_guard(len(emps), (d_to - first).days + 1)
    data = JoinAwareData(ctx, emps, first, d_to, punches=True)
    by_name, by_serial = _device_names()
    verifications = {
        (v.employee_id, v.punch_date, v.punch_time.replace(microsecond=0)): v
        for v in OnDutyPunchVerification.objects.filter(
            ctx.emp_q("employee__"), status="approved", punch_date__gte=d_from, punch_date__lte=d_to
        ).only("employee_id", "punch_date", "punch_time", "latitude", "longitude", "accuracy_m", "is_mocked")
    }

    rows: list[dict] = []
    counts: Counter = Counter()
    people: set[int] = set()
    for e in emps:
        if len(rows) >= ctx.row_limit:
            break
        logs = data.logs.get(e.id, {})
        stamped = [(k, p) for k in sorted(logs) if d_from <= k <= d_to for p in logs[k]]
        if not stamped:
            continue
        # where every punch is counted: (stamped date, time, source) -> [(day, position in that day)]
        placed: dict[tuple, list] = defaultdict(list)
        d = first
        while d <= d_to:
            for i, p in enumerate(data.punches(e, d), start=1):
                placed[(p.on, p.at, p.source)].append((d, i))
            d += dt.timedelta(days=1)
        people.add(e.id)
        for k, p in stamped:
            if len(rows) >= ctx.row_limit:
                break
            hits = placed.get((k, p.punch_time, p.source))
            day, pos = hits.pop(0) if hits else (None, None)
            if day is None:
                place = PLACE_NONE
            elif day == k:
                place = PLACE_SAME
            elif day < k:
                place = PLACE_PREVIOUS
            else:
                place = PLACE_NEXT
            counts[place] += 1
            src = p.source or ""
            counts["geo"] += src in ("geo:auto", "on_duty:approved")
            rows.append(
                {
                    "employeeCode": e.employee_code,
                    "employeeName": full_name(e),
                    "department": department_name(e),
                    "employmentType": type_text(e),
                    "punchDate": k.isoformat(),
                    "punchTime": p.punch_time.strftime("%H:%M:%S"),
                    "countsFor": day.isoformat() if day else None,
                    "placement": place,
                    "punchNo": pos,
                    "direction": ("IN" if pos % 2 else "OUT") if pos else None,
                    "source": source_label(src),
                    "device": _device_text(src, by_name, by_serial),
                    "location": _location_text(
                        src, e, verifications.get((e.id, k, p.punch_time.replace(microsecond=0)))
                    ),
                }
            )
    summary = [
        {"label": "Punches", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len(people), "format": "integer"},
        {"label": "Counted on the same day", "value": counts[PLACE_SAME], "format": "integer"},
        {"label": "Closing the previous day", "value": counts[PLACE_PREVIOUS], "format": "integer"},
        {"label": "Not counted on any day", "value": counts[PLACE_NONE], "format": "integer"},
        {"label": "Geo / on-duty punches", "value": counts["geo"], "format": "integer"},
    ]
    notes = [
        "Every punch stamped in the period, whatever its source (biometric device, office geo punch, on-duty, approved "
        "missing punch, HR entry), with the day it counts for. Staff: the calendar day, except an exit after midnight "
        "that the engine gives to the day before. Production: the SHIFT DAY of the shift table, so a night shift's "
        "closing punch made the next morning counts for the day the shift began (Closes the previous day's shift).",
        "Punch No and In / Out are positional within the day the punch counts for (1st In, 2nd Out ...); double taps "
        "are listed and numbered like any punch.",
        "Location: on-duty punches carry the GPS point captured with the selfie (accuracy in metres); an office geo "
        "punch is only accepted inside the unit's geofence and its point is not stored; biometric punches show the "
        "device.",
        "A night shift that began on the last day of the period may close with a punch stamped the next morning, "
        "outside the period: widen the dates by a day to see it.",
    ]
    if counts[PLACE_NONE]:
        notes.append(
            f"{counts[PLACE_NONE]} punch(es) belong to no working day (e.g. before joining or after the last working "
            "day)."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-punch-details",
        title="Employee Punch Details",
        description="Every punch of the chosen employees with source, device, location and the day or shift day "
        "it counts for.",
        category=CATEGORY,
        modules=("attendance",),
        icon="Fingerprint",
        tags=("punch", "punches", "employee", "device", "geo", "on duty", "location", "shift day", "biometric"),
        filters=(F.date_range("last7", label="Punch dates", max_days=PUNCH_MAX_DAYS), *F.scope(status="active")),
        columns=PUNCH_COLUMNS,
        run=_punch_details_run,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)
