"""
One HOD per employee -the single rule every approval screen follows.

An employee can be put under a Department Head (HOD) two ways:
  * individually        -a ManagerEmployeeAssignment row, and
  * through a department -a ManagerDepartmentAssignment row covers EVERYONE in that department,
                           including people who join it later.

Nothing in the data stops the two from overlapping (an employee assigned individually to one HOD
whose department is later given to another, two HODs given the same department, older data), and
every place that asks "which requests can this HOD act on?" used to OR the two paths together, so
an overlapped employee showed up for several HODs at once. This module is the ONE definition of
who an employee's HOD is, and those places all call it:

  1. An individual assignment beats department coverage (the specific choice wins over the general
     one). Among several individual assignments the earliest wins.
  2. Otherwise the employee reports to the HOD holding their department. Among several holders the
     earliest assignment wins.
  3. Only ACTIVE HODs count: a deactivated HOD can't approve anything, so an assignment under one
     does not hide an employee from the active HOD behind it.

The assignment screens use `department_conflicts` to warn (and let HR choose Reassign or Keep) before
this ever has to break a tie; the tie-break rules above only decide what is already in the data.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import (
    DepartmentManager,
    Employee,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)


def effective_owner_map(employee_ids) -> dict[int, int]:
    """{employee_id: manager_id}: the ONE active HOD each of these employees reports to. An employee
    with no active HOD is simply absent from the result."""
    ids = list({int(i) for i in employee_ids})
    owner: dict[int, int] = {}
    if not ids:
        return owner

    # 1) Individual assignments win. Walked newest-first so that, if older data holds several for one
    #    employee, the earliest one is written last and is the one that stays.
    for emp_id, mgr_id in (
        ManagerEmployeeAssignment.objects.filter(employee_id__in=ids, manager__is_active=True)
        .order_by("-created_at", "-id")
        .values_list("employee_id", "manager_id")
    ):
        owner[emp_id] = mgr_id

    # 2) Everyone else falls to the HOD who holds their department (earliest holder wins).
    rest = [i for i in ids if i not in owner]
    if rest:
        dept_of = dict(
            Employee.objects.filter(id__in=rest, department_id__isnull=False).values_list("id", "department_id")
        )
        holder: dict[int, int] = {}
        if dept_of:
            for dept_id, mgr_id in (
                ManagerDepartmentAssignment.objects.filter(
                    department_id__in=set(dept_of.values()), manager__is_active=True
                )
                .order_by("-created_at", "-id")
                .values_list("department_id", "manager_id")
            ):
                holder[dept_id] = mgr_id
        for emp_id, dept_id in dept_of.items():
            if dept_id in holder:
                owner[emp_id] = holder[dept_id]
    return owner


def effective_manager_id(emp) -> int | None:
    """The id of the one active HOD this employee reports to, or None."""
    return effective_owner_map([emp.id]).get(emp.id)


def effective_manager(emp) -> DepartmentManager | None:
    mgr_id = effective_manager_id(emp)
    if mgr_id is None:
        return None
    return DepartmentManager.objects.select_related("employee").filter(pk=mgr_id).first()


def raw_covered_employee_ids(m: DepartmentManager) -> set[int]:
    """Everyone this HOD is listed against -individually or via a department -BEFORE the one-HOD
    rule is applied. Only useful next to effective_owner_map (see managed_employee_ids)."""
    ids = set(m.employee_assignments.values_list("employee_id", flat=True))
    dept_ids = list(m.department_assignments.values_list("department_id", flat=True))
    if dept_ids:
        ids |= set(Employee.objects.filter(department_id__in=dept_ids).values_list("id", flat=True))
    return ids


def coverage(m: DepartmentManager) -> tuple[list[int], dict[int, int]]:
    """(managed, overridden) for `m` in one pass.

    managed:    the employees whose HOD really is `m` -what its approval screens show and what its
                headcount counts.
    overridden: {employee_id: owner_manager_id} for employees listed against `m` (individually or
                through one of its departments) who actually report to a DIFFERENT active HOD."""
    raw = raw_covered_employee_ids(m)
    owner = effective_owner_map(raw)
    managed = sorted(e for e in raw if owner.get(e, m.id) == m.id)
    overridden = {e: owner[e] for e in raw if e in owner and owner[e] != m.id}
    return managed, overridden


def managed_employee_ids(m: DepartmentManager) -> list[int]:
    return coverage(m)[0]


def overridden_employees(m: DepartmentManager) -> dict[int, int]:
    return coverage(m)[1]


def managers_to_notify(emp, permission_flag: str) -> list[DepartmentManager]:
    """The active HOD to notify about a request from `emp`: their ONE HOD, and only if that HOD is
    allowed to act on this kind of request (`permission_flag` is a DepartmentManager can_approve_*
    field). An empty list means HR decides."""
    m = effective_manager(emp)
    if m is None or not m.is_active or not getattr(m, permission_flag, False):
        return []
    return [m]


def manager_may_act_on(manager_employee_id: int, emp) -> bool:
    """Whether the HOD whose own employee record is `manager_employee_id` is `emp`'s HOD."""
    m = effective_manager(emp)
    return m is not None and m.employee_id == manager_employee_id


# ── Assignment-time conflict detection ──────────────────────────────────────


@dataclass
class DepartmentConflict:
    employee: Employee
    manager: DepartmentManager  # the HOD the employee reports to today
    via: str  # "direct" (individually assigned) | "department" (covered by that HOD's department)


def department_conflicts(m: DepartmentManager, dept) -> tuple[list[DepartmentConflict], list[DepartmentManager]]:
    """What assigning `dept` to `m` collides with, for the assignment screen's warning.

    Returns (conflicts, holders): `conflicts` lists every ACTIVE employee of the department who
    already reports to a different active HOD (and how), and `holders` the other active HODs who
    hold this whole department. Each employee appears once, under the HOD they really report to.
    HODs themselves are skipped: a head never approves their own requests, so who covers them is
    not a conflict worth asking about."""
    employees = list(Employee.objects.filter(department=dept, status="active").exclude(pk=m.employee_id))
    owner = effective_owner_map([e.id for e in employees])
    others = {
        mgr.id: mgr
        for mgr in DepartmentManager.objects.select_related("employee").filter(pk__in=set(owner.values()) - {m.id})
    }
    direct_pairs = set(
        ManagerEmployeeAssignment.objects.filter(employee_id__in=list(owner), manager_id__in=list(others)).values_list(
            "employee_id", "manager_id"
        )
    )
    conflicts: list[DepartmentConflict] = []
    for e in employees:
        mgr_id = owner.get(e.id)
        mgr = others.get(mgr_id) if mgr_id else None
        if mgr is None or mgr.employee_id == e.id:
            continue
        conflicts.append(DepartmentConflict(e, mgr, "direct" if (e.id, mgr.id) in direct_pairs else "department"))
    holders = list(
        DepartmentManager.objects.select_related("employee")
        .filter(department_assignments__department=dept, is_active=True)
        .exclude(pk=m.pk)
        .distinct()
    )
    return conflicts, holders
