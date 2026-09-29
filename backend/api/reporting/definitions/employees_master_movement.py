"""Manpower movement: new joinings, exits, resignation requests and joiners-vs-leavers.

Owner: group ``employees_master``. Two facts shape everything here:

* ``Employee.join_date`` is a TEXT column, so it is parsed in Python (never prefix-matched in SQL).
* There is no exit-date column: an exit is dated from the approved resignation, or - for a plain deactivation -
  approximated by the record's last-modified date and labelled as such (see ``exit_infos``).
"""

from __future__ import annotations

from collections import defaultdict

from .. import filters as F
from ..formatting import MONTH_ABBR, fmt_dt, r2
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    DATETIME,
    INTEGER,
    PERCENT,
    TEXT,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .employees_master_base import (
    BASIS_APPROX,
    UNASSIGNED,
    age_on,
    branch_name,
    clean,
    code_key,
    department_name,
    document_map,
    employees_qs,
    exit_infos,
    gender_label,
    is_active,
    ist_bounds,
    ist_date,
    join_date_of,
    months_between,
    pick_columns,
    status_label,
    type_label,
)

CATEGORY = "employees"
LONG_RANGE_DAYS = 3700  # ten years: these are registers, not single-month reports


def _person_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def can_see_salary(request) -> bool:
    """Salary figures need Salary or Payroll access on top of the report's own module."""
    from ..access import permission_level

    return any(permission_level(request, m) in ("view", "edit") for m in ("salary", "payroll"))


# ═════════════════════════════════════════════════════════════════════════════
# new-joinings
# ═════════════════════════════════════════════════════════════════════════════

JOINING_COLUMNS = (
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("gender", "Gender", TEXT, 0.8),
    ColumnSpec("ageAtJoining", "Age at Joining", INTEGER, 0.8),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("branch", "Branch", TEXT, 1.2),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("salaryAmount", "Salary (Monthly / Weekly)", CURRENCY, 1.3),
    ColumnSpec("salaryPerShift", "Per Shift", CURRENCY, 1.0),
    ColumnSpec("phone", "Phone", TEXT, 1.2),
    ColumnSpec("email", "Email", TEXT, 1.8),
    ColumnSpec("docsMissing", "Documents Missing", INTEGER, 1.0),
    ColumnSpec("status", "Status", BADGE, 0.8),
)
_SALARY_KEYS = ("salaryAmount", "salaryPerShift")


def _joinings_run(ctx) -> ReportResult:
    from api.employee_documents_views import _required_categories

    d_from, d_to = ctx.date_from, ctx.date_to
    show_salary = can_see_salary(ctx.request)
    emps = list(employees_qs(ctx))

    joined_in = []
    missing = unreadable = 0
    for e in emps:
        joined, state = join_date_of(e)
        missing += state == "missing"
        unreadable += state == "unreadable"
        if joined and d_from <= joined <= d_to:
            joined_in.append((joined, e))
    joined_in.sort(key=lambda t: (t[0], code_key(t[1].employee_code)))

    docs = document_map(e.id for _j, e in joined_in) if joined_in else {}
    rows = []
    pending_docs = 0
    for joined, e in joined_in:
        present = docs.get(e.id, set())
        gap = len([c for c in _required_categories(e.employment_type) if c not in present])
        pending_docs += gap > 0
        rows.append({
            "joinDate": joined,
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "gender": gender_label(e.gender),
            "ageAtJoining": age_on(e.date_of_birth, joined),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "branch": branch_name(e),
            "employmentType": type_label(e.employment_type),
            "salaryAmount": r2(e.salary_amount),  # None stays None: unknown is not zero
            "salaryPerShift": r2(e.salary_per_shift),
            "phone": clean(e.phone),
            "email": clean(e.email),
            "docsMissing": gap,
            "status": status_label(e.status),
        })  # fmt: skip

    people = [e for _j, e in joined_in]
    active = sum(is_active(e) for e in people)
    summary = [
        {"label": "Joined in period", "value": len(people), "format": "integer"},
        {"label": "Staff", "value": sum((e.employment_type or "") == "staff" for e in people), "format": "integer"},
        {"label": "Production", "value": sum((e.employment_type or "") == "production" for e in people), "format": "integer"},
        {"label": "Still active", "value": active, "format": "integer"},
        {"label": "Left since joining", "value": len(people) - active, "format": "integer"},
        {"label": "With documents pending", "value": pending_docs, "format": "integer"},
    ]  # fmt: skip
    notes = [
        "Documents Missing counts the required documents (PAN, Aadhaar, educational certificate, voter ID / birth "
        "certificate, bank passbook and the staff letter or production documents) not yet uploaded.",
        "Age at Joining is worked out from the date of birth on file and the join date.",
    ]
    if unreadable:
        notes.append(f"{unreadable} employee(s) in scope have a join date that could not be read and are not listed.")
    if missing:
        notes.append(f"{missing} employee(s) in scope have no join date on file and cannot be placed in a period.")
    columns = list(JOINING_COLUMNS)
    if not show_salary:
        columns = [c for c in columns if c.key not in _SALARY_KEYS]
        notes.append("Salary columns are hidden: your role has no Salary or Payroll access.")
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(ReportSpec(
    id="new-joinings",
    title="New Joinings",
    description="Employees who joined in a period, with their current status and document readiness.",
    category=CATEGORY,
    modules=("employees", "recruitment.new_joinees"),
    icon="UserPlus",
    tags=("joiners", "new joinees", "recruitment", "joined", "new employees"),
    filters=(
        F.date_range(default="thisMonth", label="Joined between", max_days=LONG_RANGE_DAYS),
        *F.scope(employee=False, status="all"),
    ),
    columns=JOINING_COLUMNS,
    run=_joinings_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# exits-register
# ═════════════════════════════════════════════════════════════════════════════

EXIT_COLUMNS = (
    ColumnSpec("exitDate", "Exit Date", DATE, 1.1),
    ColumnSpec("exitBasis", "Exit Basis", BADGE, 1.6),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("branch", "Branch", TEXT, 1.2),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("tenureMonths", "Service (Months)", INTEGER, 0.9),
    ColumnSpec("reason", "Reason", TEXT, 2.2),
    ColumnSpec("approvedBy", "Approved By", TEXT, 1.3),
    ColumnSpec("approvedOn", "Approved On", DATE, 1.1),
    ColumnSpec("status", "Status", BADGE, 0.8),
)
EXIT_TYPE_OPTIONS = (("resignation", "Resignation"), ("manual", "Manual deactivation"))


def _exit_rows(ctx):
    """[(employee, ExitInfo)] for every inactive employee in scope, unfiltered by date."""
    inactive = list(employees_qs(ctx).exclude(status="active"))
    infos = exit_infos(inactive)
    return [(e, infos[e.id]) for e in inactive if infos[e.id].when is not None]


def _exits_run(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    exit_type = ctx.params.get("exitType")
    picked = []
    for e, info in _exit_rows(ctx):
        if not (d_from <= info.when <= d_to):
            continue
        is_resignation = info.basis != BASIS_APPROX
        if exit_type == "resignation" and not is_resignation:
            continue
        if exit_type == "manual" and is_resignation:
            continue
        picked.append((e, info))
    picked.sort(key=lambda t: (t[1].when, code_key(t[0].employee_code)))

    rows = []
    months_list = []
    future = 0
    for e, info in picked:
        joined, _state = join_date_of(e)
        months = months_between(joined, info.when) if joined else None
        if months is not None and months < 0:
            months = None  # exit before the (recorded) join date: the join date is wrong, so no service figure
        if months is not None:
            months_list.append(months)
        r = info.resignation
        future += info.when > ctx.today
        rows.append({
            "exitDate": info.when,
            "exitBasis": info.basis,
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "branch": branch_name(e),
            "employmentType": type_label(e.employment_type),
            "joinDate": joined,
            "tenureMonths": months,
            "reason": clean(r.reason) if r else None,
            "approvedBy": clean(r.approved_by) if r else None,
            "approvedOn": ist_date(r.approved_at) if r else None,
            "status": status_label(e.status),
        })  # fmt: skip

    resignations = sum(1 for _e, i in picked if i.basis != BASIS_APPROX)
    summary = [
        {"label": "Total exits", "value": len(picked), "format": "integer"},
        {"label": "Resignations", "value": resignations, "format": "integer"},
        {"label": "Manual deactivations", "value": len(picked) - resignations, "format": "integer"},
        {"label": "Staff", "value": sum((e.employment_type or "") == "staff" for e, _i in picked), "format": "integer"},
        {"label": "Production", "value": sum((e.employment_type or "") == "production" for e, _i in picked), "format": "integer"},
        {"label": "Average service (months)", "value": round(sum(months_list) / len(months_list), 1) if months_list else None, "format": "number"},
    ]  # fmt: skip
    notes = [
        "The system stores no exit date. 'Resignation' exits are dated by the approved resignation's last working date "
        "(or its approval date when none was entered).",
        "'Deactivated (approx.)' means the employee was switched to inactive without a resignation; the date shown is "
        "when the record was last modified, which moves whenever it is edited again - treat it as indicative only.",
        "Employees who were deleted from the system do not appear here.",
    ]
    if future:
        notes.append(
            f"{future} exit(s) have a last working date after today: the employee is already inactive in the system."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="exits-register",
    title="Exits Register",
    description="Every employee who is no longer active, with the best available exit date and how they left.",
    category=CATEGORY,
    modules=("employees", "recruitment.resignations"),
    icon="UserMinus",
    tags=("exits", "leavers", "resigned", "inactive", "attrition", "left", "relieving"),
    filters=(
        F.date_range(default="thisMonth", label="Exited between", max_days=LONG_RANGE_DAYS),
        *F.scope(),
        F.select("exitType", "Exit type", EXIT_TYPE_OPTIONS, placeholder="All exits"),
    ),
    columns=EXIT_COLUMNS,
    run=_exits_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# resignation-register
# ═════════════════════════════════════════════════════════════════════════════

RESIGNATION_COLUMNS = (
    ColumnSpec("requestedOn", "Requested On", DATETIME, 1.4),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("lastWorkingDate", "Last Working Date", DATE, 1.1),
    ColumnSpec("noticeDays", "Notice (Days)", INTEGER, 0.8),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("stage", "Stage", TEXT, 1.3),
    ColumnSpec("deptHead", "Dept Head", TEXT, 1.5),
    ColumnSpec("deptHeadStatus", "HOD Decision", BADGE, 0.9),
    ColumnSpec("deptHeadAt", "HOD Decided On", DATETIME, 1.4),
    ColumnSpec("deptHeadComment", "HOD Comment", TEXT, 2.0),
    ColumnSpec("approvedBy", "HR Approved By", TEXT, 1.3),
    ColumnSpec("approvedAt", "HR Approved On", DATETIME, 1.4),
    ColumnSpec("hrComment", "HR Comment", TEXT, 2.0),
    ColumnSpec("pendingDays", "Pending (Days)", INTEGER, 0.8),
    ColumnSpec("reason", "Reason", TEXT, 2.2),
    ColumnSpec("surveyReason", "Exit Survey: Main Reason", TEXT, 2.0),
    ColumnSpec("surveyRecommend", "Exit Survey: Would Recommend", TEXT, 2.0),
    ColumnSpec("surveyRetain", "Exit Survey: What Could Retain", TEXT, 2.0),
)
RESIGNATION_SUMMARY_KEYS = (
    "requestedOn", "employeeCode", "employeeName", "department", "designation", "lastWorkingDate", "noticeDays",
    "status", "stage", "deptHead", "approvedBy", "approvedAt", "pendingDays", "reason",
)  # fmt: skip
STATUS_OPTIONS = (
    ("pending", "Pending (awaiting HOD)"), ("dept_approved", "HOD approved (awaiting HR)"),
    ("approved", "Approved"), ("rejected", "Rejected"),
)  # fmt: skip
STATUS_TEXT = {"pending": "Pending", "dept_approved": "HOD approved", "approved": "Approved", "rejected": "Rejected"}
DETAIL_OPTIONS = (("summary", "Summary"), ("full", "Full detail (comments and exit survey)"))


def _stage_of(r) -> str:
    if r.status == "pending":
        return "Awaiting HOD"
    if r.status == "dept_approved":
        return "Awaiting HR"
    if r.status == "approved":
        return "Approved"
    if r.status == "rejected":
        return {"dept_head": "Rejected by HOD", "hr": "Rejected by HR"}.get((r.rejected_by or "").strip(), "Rejected")
    return status_label(r.status)


def _resignations_run(ctx) -> ReportResult:
    from api.models import ResignationRequest

    today = ctx.today
    start, end = ist_bounds(ctx.date_from, ctx.date_to)
    statuses = ctx.params.get("status") or []
    layout = ctx.param("layout", "summary")
    qs = (
        ResignationRequest.objects.select_related("employee__department", "employee__designation", "dept_head")
        .defer(
            "employee__photo_url", "employee__password_hash", "dept_head__photo_url", "dept_head__password_hash",
        )
        .filter(ctx.emp_q("employee__"), created_at__gte=start, created_at__lt=end)
        .order_by("created_at", "id")
    )  # fmt: skip
    if statuses:
        qs = qs.filter(status__in=statuses)

    rows = []
    counts: dict[str, int] = defaultdict(int)
    decision_days = []
    for r in qs:
        e = r.employee
        requested = ist_date(r.created_at)
        stage = _stage_of(r)
        counts[stage] += 1
        decided = None
        if r.status == "approved":
            decided = r.approved_at
        elif r.status == "rejected" and r.rejected_by == "dept_head":
            decided = r.dept_head_approved_at  # the HOD's rejection time; an HR rejection is not time-stamped at all
        if decided is not None:
            decision_days.append((ist_date(decided) - requested).days)
        rows.append({
            "requestedOn": fmt_dt(r.created_at),
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "lastWorkingDate": r.last_working_date,
            "noticeDays": (r.last_working_date - requested).days if r.last_working_date else None,
            "status": STATUS_TEXT.get(r.status, status_label(r.status)),
            "stage": stage,
            "deptHead": _person_name(r.dept_head) if r.dept_head_id else None,
            "deptHeadStatus": status_label(r.dept_head_status) if r.dept_head_status else None,
            "deptHeadAt": fmt_dt(r.dept_head_approved_at),
            "deptHeadComment": clean(r.dept_head_comment),
            "approvedBy": clean(r.approved_by),
            "approvedAt": fmt_dt(r.approved_at),
            "hrComment": clean(r.hr_comment),
            "pendingDays": (today - requested).days if r.status in ("pending", "dept_approved") else None,
            "reason": clean(r.reason),
            "surveyReason": clean(r.survey_q1_answer),
            "surveyRecommend": clean(r.survey_q2_answer),
            "surveyRetain": clean(r.survey_q3_answer),
        })  # fmt: skip

    summary = [
        {"label": "Total requests", "value": len(rows), "format": "integer"},
        {"label": "Awaiting HOD", "value": counts["Awaiting HOD"], "format": "integer"},
        {"label": "Awaiting HR", "value": counts["Awaiting HR"], "format": "integer"},
        {"label": "Approved", "value": counts["Approved"], "format": "integer"},
        {"label": "Rejected by HOD", "value": counts["Rejected by HOD"], "format": "integer"},
        {"label": "Rejected by HR", "value": counts["Rejected by HR"], "format": "integer"},
        {"label": "Avg days to decision", "value": round(sum(decision_days) / len(decision_days), 1) if decision_days else None, "format": "number"},
    ]  # fmt: skip
    notes = [
        "The date range applies to the day the request was raised (IST). Notice days = last working date minus that day.",
        "Days to decision covers approved requests and HOD rejections only; an HR rejection carries no time stamp.",
        "Requests that HR later deleted from the system cannot be listed.",
    ]
    columns = (
        list(RESIGNATION_COLUMNS) if layout == "full" else pick_columns(RESIGNATION_COLUMNS, RESIGNATION_SUMMARY_KEYS)
    )
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(ReportSpec(
    id="resignation-register",
    title="Resignation Register",
    description="Every resignation request with its HOD and HR stages, timings, comments and exit-survey answers.",
    category=CATEGORY,
    modules=("recruitment.resignations",),
    icon="FileText",
    tags=("resignation", "notice", "hod approval", "exit survey", "relieving"),
    filters=(
        F.date_range(default="thisMonth", label="Requested between", max_days=LONG_RANGE_DAYS),
        F.select("status", "Status", STATUS_OPTIONS, multi=True, placeholder="All statuses"),
        *F.scope(status=None),
        F.select("layout", "Detail", DETAIL_OPTIONS, default="summary"),
    ),
    columns=RESIGNATION_COLUMNS,
    run=_resignations_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# manpower-movement
# ═════════════════════════════════════════════════════════════════════════════

MOVEMENT_TAIL = (
    ColumnSpec("joinedStaff", "Joined: Staff", INTEGER, 1.0, total="sum"),
    ColumnSpec("joinedProduction", "Joined: Production", INTEGER, 1.2, total="sum"),
    ColumnSpec("joinedTotal", "Joined: Total", INTEGER, 1.0, total="sum"),
    ColumnSpec("leftStaff", "Left: Staff", INTEGER, 1.0, total="sum"),
    ColumnSpec("leftProduction", "Left: Production", INTEGER, 1.2, total="sum"),
    ColumnSpec("leftTotal", "Left: Total", INTEGER, 1.0, total="sum"),
    ColumnSpec("net", "Net Movement", INTEGER, 1.0, total="sum"),
    ColumnSpec("exitRatePct", "Exit Rate %", PERCENT, 0.9),
)
MOVEMENT_GROUPS = (("month", "Month"), ("department", "Department"))
_INT_KEYS = ("joinedStaff", "joinedProduction", "joinedTotal", "leftStaff", "leftProduction", "leftTotal", "net")


def _movement_run(ctx) -> ReportResult:
    year = ctx.year
    by_month = ctx.param("groupBy", "month") == "month"
    emps = list(employees_qs(ctx))

    def blank_cell() -> dict:
        return {k: 0 for k in _INT_KEYS}

    def key_of(e, when):
        return when.month if by_month else e.department_id

    cells: dict = defaultdict(blank_cell)
    labels: dict = {}  # department id -> name (department view only)
    active_now: dict = defaultdict(int)  # department id (or 0 for the month view) -> active employees today

    def add(cell: dict, e, prefix: str) -> None:
        cell[f"{prefix}Total"] += 1
        et = (e.employment_type or "").strip()
        if et in ("staff", "production"):
            cell[f"{prefix}{'Staff' if et == 'staff' else 'Production'}"] += 1

    for e in emps:
        if not by_month:
            labels[e.department_id] = department_name(e)
        if is_active(e):
            active_now[0 if by_month else e.department_id] += 1
            if not by_month:
                cells[e.department_id]  # a department with current staff but no movement still gets its zero row
        joined, _state = join_date_of(e)
        if joined and joined.year == year:
            add(cells[key_of(e, joined)], e, "joined")

    inactive = [e for e in emps if not is_active(e)]
    infos = exit_infos(inactive)
    approx_exits = 0
    for e in inactive:
        info = infos[e.id]
        if info.when is None or info.when.year != year:
            continue
        add(cells[key_of(e, info.when)], e, "left")
        approx_exits += info.basis == BASIS_APPROX

    left_year = sum(c["leftTotal"] for c in cells.values())
    active_total = sum(active_now.values())

    if by_month:
        keys = list(range(1, 13))
    else:
        keys = sorted(cells, key=lambda k: (k is None, labels.get(k, UNASSIGNED).lower(), k or 0))
    rows = []
    for key in keys:
        c = dict(cells[key]) if key in cells else blank_cell()
        c["net"] = c["joinedTotal"] - c["leftTotal"]
        # Month view: every month shares one denominator, so the monthly rates add up to the year's rate.
        denominator = (active_total + left_year) if by_month else (active_now.get(key, 0) + c["leftTotal"])
        rows.append({
            "group": f"{MONTH_ABBR[key - 1]} {year}" if by_month else labels.get(key, UNASSIGNED),
            **c,
            "exitRatePct": round(c["leftTotal"] * 100 / denominator, 2) if denominator else None,
        })  # fmt: skip

    joined_total = sum(r["joinedTotal"] for r in rows)
    overall = round(left_year * 100 / (active_total + left_year), 2) if (active_total + left_year) else None
    totals = None
    if rows:
        totals = {k: sum(r[k] for r in rows) for k in _INT_KEYS}
        totals["exitRatePct"] = overall
    summary = [
        {"label": "Joined", "value": joined_total, "format": "integer"},
        {"label": "Left", "value": left_year, "format": "integer"},
        {"label": "Net movement", "value": joined_total - left_year, "format": "integer"},
        {"label": "Exit rate", "value": overall, "format": "percent"},
        {"label": "Active today", "value": active_total, "format": "integer"},
    ]
    notes = [
        "Exit rate = leavers / (employees active today + leavers in the year) x 100. It is an approximation, not an "
        "attrition figure: the system keeps no opening or closing headcount history.",
        "Joiners are counted from the join date and include people who have since left. Leavers are dated from the "
        "approved resignation, or from the last-modified date for a plain deactivation.",
    ]
    if approx_exits:
        notes.append(
            f"{approx_exits} leaver(s) have only an approximate exit month (deactivated without a resignation)."
        )
    if not by_month:
        notes.append("In the department view the rate uses that department's own active strength.")
    head = ColumnSpec("group", "Month" if by_month else "Department", TEXT, 2.0)
    return ReportResult(rows=rows, columns=[head, *MOVEMENT_TAIL], totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="manpower-movement",
    title="Joiners vs Leavers",
    description="Joiners, leavers, net movement and exit rate by month or department for a year.",
    category=CATEGORY,
    modules=("employees", "recruitment.new_joinees", "recruitment.resignations"),
    icon="ArrowLeftRight",
    tags=("attrition", "joiners", "leavers", "movement", "turnover", "exit rate"),
    filters=(
        F.year(),
        F.select("groupBy", "Group by", MOVEMENT_GROUPS, default="month"),
        *F.scope(designation=False, employee=False),
    ),
    columns=(ColumnSpec("group", "Month", TEXT, 2.0), *MOVEMENT_TAIL),
    run=_movement_run,
))  # fmt: skip
