"""Head of Department (HOD) reports: directory, employee -> HOD mapping and assignment conflicts.

Every "who is this employee's HOD" question goes through ``hod_scope.effective_owner_map`` - the single
definition of the one-HOD-per-employee rule (an individual assignment beats department coverage, the earliest
assignment wins among equals, only ACTIVE HODs count). The reports never OR the two assignment tables
together themselves. ``effective_owner_map`` costs three queries for any number of employees, so each report
calls it once for everybody it needs."""

from __future__ import annotations

from collections import defaultdict

from django.db.models import Q

from api.branch_scope import get_branch_scope
from api.hod_scope import effective_owner_map
from api.models import (
    DepartmentManager,
    Employee,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)

from ..common import EMP_COLS, emp_cells
from ..filters import branches, boolean, departments, employee_status, scope, select
from ..formatting import full_name
from ..registry import register
from ..types import BADGE, DATE, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_admin_util import branch_label, employee_qs, ist_date, natural_key, pct, status_label, type_label

RIGHTS = (
    ("can_approve_leaves", "Leave"),
    ("can_approve_permissions", "Permission"),
    ("can_approve_resignations", "Resignation"),
    ("can_approve_attendance", "Attendance"),
    ("can_approve_casual_leave", "Casual Leave"),
    ("can_approve_on_duty", "On-Duty"),
    ("can_approve_missing_punch", "Missing Punch"),
)


def _hod_name(mgr) -> str:
    return full_name(mgr.employee)


# ── HOD Directory & Approval Rights ─────────────────────────────────────────

def _run_directory(ctx):
    state = ctx.param("state", "active")
    problems_only = ctx.param("problemsOnly", False)
    q = ctx.emp_q("employee__")
    if state == "active":
        q &= Q(is_active=True)
    elif state == "inactive":
        q &= Q(is_active=False)
    mgrs = list(
        DepartmentManager.objects.filter(q)
        .select_related("employee", "employee__department", "employee__designation", "employee__branch")
        .defer("employee__photo_url", "employee__password_hash")
        .order_by("employee__employee_code", "id")
    )
    mgr_ids = [m.id for m in mgrs]

    direct: dict[int, set[int]] = defaultdict(set)
    for mgr_id, emp_id in ManagerEmployeeAssignment.objects.filter(manager_id__in=mgr_ids).values_list(
        "manager_id", "employee_id"
    ):
        direct[mgr_id].add(emp_id)
    dept_assigned: dict[int, list[int]] = defaultdict(list)
    for mgr_id, dept_id in ManagerDepartmentAssignment.objects.filter(manager_id__in=mgr_ids).values_list(
        "manager_id", "department_id"
    ):
        dept_assigned[mgr_id].append(dept_id)

    all_dept_ids = {d for ids in dept_assigned.values() for d in ids}
    all_direct_ids = {e for ids in direct.values() for e in ids}
    dept_members: dict[int, list[int]] = defaultdict(list)
    status_of: dict[int, str] = {}
    if all_dept_ids or all_direct_ids:
        for emp_id, dept_id, status in Employee.objects.filter(
            Q(department_id__in=all_dept_ids) | Q(id__in=all_direct_ids)
        ).values_list("id", "department_id", "status"):
            status_of[emp_id] = status
            if dept_id in all_dept_ids:
                dept_members[dept_id].append(emp_id)

    # Everyone each HOD is LISTED against (before the one-HOD rule), then the rule applied once for all.
    raw: dict[int, set[int]] = {}
    for m in mgrs:
        ids = set(direct[m.id])
        for d in dept_assigned[m.id]:
            ids.update(dept_members[d])
        raw[m.id] = ids
    owner = effective_owner_map({e for ids in raw.values() for e in ids})

    dept_names: dict[int, tuple[str, int | None, str | None]] = {}
    if all_dept_ids:
        from api.models import Department

        for d in Department.objects.filter(id__in=all_dept_ids).select_related("branch"):
            dept_names[d.id] = (d.name, d.branch_id, d.branch.name if d.branch_id else None)

    rows = []
    active_hods = inactive_hods = hod_emp_inactive = covered = 0
    for m in mgrs:
        emp = m.employee
        team = [
            e for e in raw[m.id] if owner.get(e) == m.id and e != m.employee_id and status_of.get(e) == "active"
        ]
        overlap = [
            e for e in raw[m.id]
            if owner.get(e) not in (None, m.id) and e != m.employee_id and status_of.get(e) == "active"
        ]
        rights = [lab for flag, lab in RIGHTS if getattr(m, flag)]
        issues = []
        if not m.is_active:
            issues.append("HOD account inactive")
        if emp.status != "active":
            issues.append("HOD employee inactive")
        if not direct[m.id] and not dept_assigned[m.id]:
            issues.append("No departments or employees assigned")
        if not rights:
            issues.append("All approval rights off")
        if problems_only and not issues:
            continue
        covered_names = []
        for d in dept_assigned[m.id]:
            name, branch_id, branch_name = dept_names.get(d, ("(deleted)", None, None))
            covered_names.append(name if branch_id == emp.branch_id else f"{name} ({branch_name or 'No branch'})")
        active_hods += 1 if m.is_active else 0
        inactive_hods += 0 if m.is_active else 1
        hod_emp_inactive += 1 if emp.status != "active" else 0
        covered += len(team)
        rows.append({
            **emp_cells(emp),
            "branch": branch_label(emp),
            "hodActive": "Active" if m.is_active else "Inactive",
            "employeeStatus": status_label(emp.status),
            "departmentsCovered": ", ".join(sorted(covered_names)) or None,
            "directAssignments": len(direct[m.id]),
            "teamSize": len(team),
            "overlapCount": len(overlap),
            "approves": ", ".join(rights) or None,
            "rightsCount": len(rights),
            "createdAt": ist_date(m.created_at),
            "issues": "; ".join(issues) or None,
        })
    rows.sort(key=lambda r: natural_key(r["employeeCode"]))

    # Org-level figure: active employees (branch-scoped) who have no HOD at all and are not a HOD themselves.
    unowned = _active_without_hod(ctx)
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "HODs listed", "value": len(rows), "format": "integer"},
            {"label": "Active HODs", "value": active_hods, "format": "integer"},
            {"label": "Inactive HODs", "value": inactive_hods, "format": "integer"},
            {"label": "Employees covered", "value": covered, "format": "integer"},
            {"label": "Active employees with no HOD", "value": unowned, "format": "integer"},
            {"label": "HODs whose employee is inactive", "value": hod_emp_inactive, "format": "integer"},
        ],
        notes=[
            "Team size counts ACTIVE employees whose one HOD (individual assignment beats department, earliest "
            "wins, only active HODs) is this person, excluding the HOD themselves.",
            "Overlap = employees also listed under this HOD but who report to a different active HOD.",
            "'Active employees with no HOD' ignores the filters other than branch and excludes HODs themselves.",
            "The rule does not look at the HOD's own employee status: approvals still route to a HOD whose "
            "employee record is inactive (flagged under Issues).",
        ],
    )


def _active_without_hod(ctx) -> int:
    q = Q(status="active")
    scope_branch = get_branch_scope(ctx.request)
    if scope_branch is not None:
        q &= Q(branch_id=scope_branch)
    if ctx.params.get("branch_ids"):
        q &= Q(branch_id__in=ctx.params["branch_ids"])
    ids = set(Employee.objects.filter(q).values_list("id", flat=True))
    if not ids:
        return 0
    hod_employees = set(DepartmentManager.objects.filter(employee_id__in=ids).values_list("employee_id", flat=True))
    owner = effective_owner_map(ids)
    return len([i for i in ids if i not in owner and i not in hod_employees])


register(ReportSpec(
    id="hod-directory",
    title="HOD Directory & Approval Rights",
    description="Every department head with the departments they cover, real team size and approval rights.",
    category="employees",
    icon="Users",
    tags=("hod", "department head", "approver", "approval rights"),
    family="hod",
    variant="Directory",
    modules=("user_management",),
    filters=(
        branches(),
        departments("HOD's department"),
        select("state", "HOD status", (("active", "Active"), ("inactive", "Inactive"), ("all", "All")), default="active"),
        boolean("problemsOnly", "Only HODs with issues"),
    ),
    columns=(
        *EMP_COLS,
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("hodActive", "HOD Status", BADGE, 0.9),
        ColumnSpec("employeeStatus", "Employee", BADGE, 0.9),
        ColumnSpec("departmentsCovered", "Departments Covered", TEXT, 2.0),
        ColumnSpec("directAssignments", "Direct", INTEGER, 0.7, total="sum"),
        ColumnSpec("teamSize", "Team Size", INTEGER, 0.8, total="sum"),
        ColumnSpec("overlapCount", "Overlap", INTEGER, 0.8, total="sum"),
        ColumnSpec("approves", "Approves", TEXT, 2.2),
        ColumnSpec("rightsCount", "Rights", INTEGER, 0.7),
        ColumnSpec("createdAt", "Since", DATE, 1.0),
        ColumnSpec("issues", "Issues", TEXT, 2.0),
    ),
    run=_run_directory,
))


# ── Employee -> HOD Mapping ─────────────────────────────────────────────────

_COVERAGE = (("all", "All employees"), ("covered", "Has a HOD"), ("uncovered", "No HOD"))


def _run_mapping(ctx):
    wanted = ctx.param("coverage", "all")
    emps = list(employee_qs(ctx))
    owner = effective_owner_map([e.id for e in emps])

    mgrs = {
        m.id: m
        for m in DepartmentManager.objects.filter(id__in=set(owner.values()))
        .select_related("employee")
        .defer("employee__photo_url", "employee__password_hash")
    }
    direct_pairs = set(
        ManagerEmployeeAssignment.objects.filter(manager_id__in=list(mgrs)).values_list("employee_id", "manager_id")
    )
    hod_employee_ids = set(DepartmentManager.objects.filter(is_active=True).values_list("employee_id", flat=True))
    # Why an employee is uncovered: only INACTIVE HODs are listed against them / their department, or nobody is.
    inactive_direct = set(
        ManagerEmployeeAssignment.objects.filter(manager__is_active=False).values_list("employee_id", flat=True)
    )
    inactive_dept = set(
        ManagerDepartmentAssignment.objects.filter(manager__is_active=False).values_list("department_id", flat=True)
    )

    rows = []
    covered = uncovered = uncovered_non_hod = 0
    uncovered_by_dept: dict[str, int] = defaultdict(int)
    for emp in emps:
        mgr = mgrs.get(owner.get(emp.id))
        is_hod = emp.id in hod_employee_ids
        via = reason = None
        hod_code = hod_name = None
        if mgr is not None:
            covered += 1
            hod_code, hod_name = mgr.employee.employee_code, _hod_name(mgr)
            via = "Direct" if (emp.id, mgr.id) in direct_pairs else "Department"
            if mgr.employee.status != "active":
                reason = "HOD's employee record is inactive"
        else:
            uncovered += 1
            if not is_hod:
                uncovered_non_hod += 1
                uncovered_by_dept[emp.department.name if emp.department_id else "No department"] += 1
            if emp.id in inactive_direct or (emp.department_id and emp.department_id in inactive_dept):
                reason = "Assigned HOD is inactive"
            elif emp.department_id is None:
                reason = "No department set and no direct HOD"
            else:
                reason = "Department has no active HOD"
            if is_hod:
                reason = "Department head - not covered by another HOD"
        if wanted == "covered" and mgr is None:
            continue
        if wanted == "uncovered" and mgr is not None:
            continue
        rows.append({
            **emp_cells(emp),
            "employmentType": type_label(emp.employment_type),
            "branch": branch_label(emp),
            "hodCode": hod_code,
            "hodName": hod_name,
            "via": via,
            "isHod": "HOD" if is_hod else None,
            "reason": reason,
        })
    rows.sort(key=lambda r: natural_key(r["employeeCode"]))

    notes = [
        "The HOD shown is the ONE HOD who approves this employee's requests: an individual assignment beats "
        "department coverage, the earliest assignment wins among equals, and only active HODs count.",
        "Department heads themselves are often intentionally uncovered (their requests go to HR).",
    ]
    if uncovered_by_dept:
        top = sorted(uncovered_by_dept.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
        notes.append("Uncovered (excluding HODs) by department: " + ", ".join(f"{n} {c}" for n, c in top) + ".")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employees checked", "value": len(emps), "format": "integer"},
            {"label": "With a HOD", "value": covered, "format": "integer"},
            {"label": "Without a HOD", "value": uncovered, "format": "integer"},
            {"label": "Covered", "value": pct(covered, len(emps)), "format": "percent"},
            {"label": "Without a HOD (excl. HODs)", "value": uncovered_non_hod, "format": "integer"},
        ],
        notes=notes,
    )


register(ReportSpec(
    id="hod-mapping",
    title="Employee to HOD Mapping",
    description="For each employee, the one HOD who approves their requests and how (direct or department).",
    category="employees",
    icon="ArrowRightLeft",
    tags=("hod", "department head", "reporting", "approver", "uncovered"),
    family="hod",
    variant="Employee mapping",
    modules=("user_management",),
    filters=(
        *scope(status="active"),
        select("coverage", "Coverage", _COVERAGE, default="all"),
    ),
    columns=(
        *EMP_COLS,
        ColumnSpec("employmentType", "Type", BADGE, 0.9),
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("hodCode", "HOD Code", TEXT, 1.0),
        ColumnSpec("hodName", "HOD", TEXT, 2.0),
        ColumnSpec("via", "Via", BADGE, 1.0),
        ColumnSpec("isHod", "Is HOD", BADGE, 0.8),
        ColumnSpec("reason", "Note", TEXT, 2.6),
    ),
    run=_run_mapping,
))


# ── HOD Assignment Conflicts ────────────────────────────────────────────────

def _run_conflicts(ctx):
    emps = list(employee_qs(ctx))
    mgrs = {
        m.id: m
        for m in DepartmentManager.objects.filter(is_active=True)
        .select_related("employee")
        .defer("employee__photo_url", "employee__password_hash")
    }
    direct: dict[int, set[int]] = defaultdict(set)
    for emp_id, mgr_id in (
        ManagerEmployeeAssignment.objects.filter(manager__is_active=True)
        .filter(ctx.emp_q("employee__"))
        .values_list("employee_id", "manager_id")
    ):
        direct[emp_id].add(mgr_id)
    holders: dict[int, list[int]] = defaultdict(list)
    for mgr_id, dept_id in ManagerDepartmentAssignment.objects.filter(manager__is_active=True).values_list(
        "manager_id", "department_id"
    ):
        holders[dept_id].append(mgr_id)
    hod_employee_ids = {m.employee_id for m in mgrs.values()}

    listed: dict[int, dict[int, str]] = {}
    for emp in emps:
        if emp.id in hod_employee_ids:
            continue  # a head's own coverage is not something to warn about (same rule as the assignment screens)
        via: dict[int, str] = {}
        for mgr_id in holders.get(emp.department_id, ()):
            via[mgr_id] = "department"
        for mgr_id in direct.get(emp.id, ()):
            via[mgr_id] = "direct"  # an individual listing under the same HOD is the stronger one
        if len(via) >= 2:
            listed[emp.id] = via
    owner = effective_owner_map(listed)

    rows = []
    involved: set[int] = set()
    for emp in emps:
        via = listed.get(emp.id)
        if not via:
            continue
        winner = owner.get(emp.id)
        involved.update(via)
        others = sorted(
            f"{_hod_name(mgrs[m])} ({kind})" for m, kind in via.items() if m != winner and m in mgrs
        )
        rows.append({
            **emp_cells(emp),
            "branch": branch_label(emp),
            "effectiveHod": _hod_name(mgrs[winner]) if winner in mgrs else None,
            "effectiveVia": ("Direct" if via.get(winner) == "direct" else "Department") if winner in via else None,
            "alsoListedUnder": ", ".join(others) or None,
            "otherListings": len(others),
        })
    rows.sort(key=lambda r: natural_key(r["employeeCode"]))
    notes = [
        "An employee is in conflict when more than one ACTIVE HOD is listed against them (individually or through "
        "a department). The HOD shown as effective is the one who really approves their requests; the others see "
        "nothing for this employee.",
        "Department heads themselves are skipped. Inactive HODs never count.",
    ]
    if not rows:
        notes.insert(0, "No conflicts found: every employee in scope is listed under at most one active HOD.")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employees in conflict", "value": len(rows), "format": "integer"},
            {"label": "HODs involved", "value": len(involved), "format": "integer"},
        ],
        notes=notes,
    )


register(ReportSpec(
    id="hod-conflicts",
    title="HOD Assignment Conflicts",
    description="Employees listed under more than one HOD, and which HOD wins under the one-HOD rule.",
    category="employees",
    icon="TriangleAlert",
    tags=("hod", "conflict", "duplicate assignment", "overlap"),
    family="hod",
    variant="Conflicts",
    modules=("user_management",),
    filters=(branches(), departments(), employee_status("active")),
    columns=(
        *EMP_COLS,
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("effectiveHod", "Effective HOD", TEXT, 2.0),
        ColumnSpec("effectiveVia", "Via", BADGE, 1.0),
        ColumnSpec("alsoListedUnder", "Also Listed Under", TEXT, 3.0),
        ColumnSpec("otherListings", "Other HODs", INTEGER, 0.8, total="sum"),
    ),
    run=_run_conflicts,
))
