"""Split departments and designations into Staff and Production (owner, 2026-11-16).

0149 gave every department and designation a ``category`` ("staff" by default). This sets it from the people in them:

* A department whose employees (any status, inactive ones too) are all production becomes a Production department.
  One whose employees are all staff - or that has nobody in it - stays Staff (HR can switch an empty one later).
* A department that holds BOTH kinds is split: the original row stays Staff with its staff, and a Production
  department of the same name, description and branch is created (or reused, when a run already made it) and every
  production employee of the original moves into it.
* A designation takes its department's category. One with no department stays Staff unless everybody holding it is a
  production employee (then it is Production). An employee who still holds a designation of the other kind (a
  production worker with a staff title) is given a designation of the same title and level in their own category,
  under their own department - created once and shared by everyone in the same position.

What the split does to everything else that points at a split department (``REL`` notes below say why):

* Heads of department (ManagerDepartmentAssignment): each HOD of the original also heads the production copy, so the
  production employees keep the same approver.
* Department holidays (Holiday) and department compensation days (CompensationDayAnnouncement with no employee list):
  a copy is made for the production copy, so its people keep the day off / the exemption they had.
* A production shift template tied to the department (ShiftTemplate.shift_type == production) moves to the copy.
* Promotion history of production employees points at the copy (same name, so nothing a person reads changes; the
  Staff / Production filters then place the row correctly).
* Left on the original (Staff) department: designations (they are staff titles; production holders are handled by the
  designation step above), HR users, recruitment (jobs, candidates, hiring rule sets, the headcount target) and the
  department chat channel (the production copy gets its own channel the first time somebody opens it).

Idempotent: a second run finds no department holding both kinds and no employee with a designation of the other
kind, and changes nothing. It runs inside the migration's transaction, so it is all or nothing.

Reverse is a no-op: the split cannot be undone safely once HR has started using the new departments (people may have
been moved, designations created), and 0149's reverse drops the column anyway; the copies would then be plain extra
departments with the same name.
"""

from django.db import migrations

STAFF = "staff"
PRODUCTION = "production"


def category_of_type(employment_type):
    """The org category an employee belongs to: production employees are Production, everyone else is Staff."""
    return PRODUCTION if employment_type == PRODUCTION else STAFF


def split_org_categories(apps, log=None):
    """Do the split. Returns the counts it reports (also used by the tests)."""
    Department = apps.get_model("api", "Department")
    Designation = apps.get_model("api", "Designation")
    Employee = apps.get_model("api", "Employee")
    ManagerDepartmentAssignment = apps.get_model("api", "ManagerDepartmentAssignment")
    Holiday = apps.get_model("api", "Holiday")
    CompensationDayAnnouncement = apps.get_model("api", "CompensationDayAnnouncement")
    ShiftTemplate = apps.get_model("api", "ShiftTemplate")
    Promotion = apps.get_model("api", "Promotion")

    stats = {
        "departments_to_production": 0,
        "departments_split": 0,
        "employees_moved": 0,
        "hod_links_copied": 0,
        "holidays_copied": 0,
        "compensation_days_copied": 0,
        "shift_templates_moved": 0,
        "promotions_repointed": 0,
        "designations_to_production": 0,
        "designations_created": 0,
        "employees_redesignated": 0,
    }

    # ── Departments ──────────────────────────────────────────────────────────
    # Who is in each department, by kind (every status: an inactive production worker in a staff department would
    # otherwise block the department from ever being one or the other).
    kinds: dict[int, set[str]] = {}
    for dept_id, emp_type in (
        Employee.objects.filter(department_id__isnull=False).order_by().values_list("department_id", "employment_type")
    ):
        kinds.setdefault(dept_id, set()).add(category_of_type(emp_type))

    for dept in Department.objects.order_by("id"):
        present = kinds.get(dept.id, set())
        if not present:
            continue  # empty: keeps its category (staff by default)
        if len(present) == 1:
            only = next(iter(present))
            if dept.category != only:
                dept.category = only
                dept.save(update_fields=["category"])
                if only == PRODUCTION:
                    stats["departments_to_production"] += 1
            continue

        # Both kinds: the original keeps its category (staff, as 0149 left every department) and the other kind moves.
        home = dept.category if dept.category in (STAFF, PRODUCTION) else STAFF
        if dept.category != home:
            dept.category = home
            dept.save(update_fields=["category"])
        other = PRODUCTION if home == STAFF else STAFF
        copy = Department.objects.filter(name=dept.name, branch_id=dept.branch_id, category=other).order_by("id").first()
        if copy is None:
            copy = Department.objects.create(
                name=dept.name, description=dept.description, branch_id=dept.branch_id, category=other
            )
        movers = Employee.objects.filter(department_id=dept.id)
        movers = movers.filter(employment_type=PRODUCTION) if other == PRODUCTION else movers.exclude(employment_type=PRODUCTION)
        mover_ids = list(movers.values_list("id", flat=True))
        stats["employees_moved"] += Employee.objects.filter(id__in=mover_ids).update(department_id=copy.id)
        stats["departments_split"] += 1
        if log:
            log(f"  split {dept.name!r} (branch {dept.branch_id}): {len(mover_ids)} {other} employee(s) -> new id {copy.id}")

        # REL HOD: the same heads also head the copy, so approvals keep reaching them.
        for a in ManagerDepartmentAssignment.objects.filter(department_id=dept.id):
            _, made = ManagerDepartmentAssignment.objects.get_or_create(manager_id=a.manager_id, department_id=copy.id)
            stats["hod_links_copied"] += int(made)

        # REL Holiday: a department holiday applies to the people in the department; the copy's people keep it.
        for h in Holiday.objects.filter(department_id=dept.id):
            exists = Holiday.objects.filter(
                department_id=copy.id, date=h.date, name=h.name, branch_id=h.branch_id, holiday_type=h.holiday_type
            ).exists()
            if not exists:
                Holiday.objects.create(
                    name=h.name,
                    date=h.date,
                    holiday_type=h.holiday_type,
                    branch_id=h.branch_id,
                    department_id=copy.id,
                    is_recurring=h.is_recurring,
                    description=h.description,
                )
                stats["holidays_copied"] += 1

        # REL Compensation day: with no employee list it covers the department's people (attendance_final.py); an
        # announcement that lists employees covers exactly them, whatever their department, so it needs no copy.
        for c in CompensationDayAnnouncement.objects.filter(department_id=dept.id):
            if c.employees.exists():
                continue
            exists = CompensationDayAnnouncement.objects.filter(
                department_id=copy.id, date=c.date, kind=c.kind, branch_id=c.branch_id
            ).exists()
            if not exists:
                CompensationDayAnnouncement.objects.create(
                    date=c.date,
                    leave_until_time=c.leave_until_time,
                    branch_id=c.branch_id,
                    department_id=copy.id,
                    reason=c.reason,
                    announced_by=c.announced_by,
                    kind=c.kind,
                    allowed_time=c.allowed_time,
                )
                stats["compensation_days_copied"] += 1

        # REL Shift template: one meant for the other kind follows its people.
        stats["shift_templates_moved"] += ShiftTemplate.objects.filter(department_id=dept.id, shift_type=other).update(
            department_id=copy.id
        )

        # REL Promotion history of the people who moved points at the department they are now in.
        if mover_ids:
            stats["promotions_repointed"] += Promotion.objects.filter(
                employee_id__in=mover_ids, previous_department_id=dept.id
            ).update(previous_department_id=copy.id)
            stats["promotions_repointed"] += Promotion.objects.filter(
                employee_id__in=mover_ids, new_department_id=dept.id
            ).update(new_department_id=copy.id)

    # ── Designations ─────────────────────────────────────────────────────────
    dept_category = dict(Department.objects.values_list("id", "category"))
    holders: dict[int, set[str]] = {}
    for desig_id, emp_type in (
        Employee.objects.filter(designation_id__isnull=False).order_by().values_list("designation_id", "employment_type")
    ):
        holders.setdefault(desig_id, set()).add(category_of_type(emp_type))

    for g in Designation.objects.order_by("id"):
        if g.department_id is not None:
            want = dept_category.get(g.department_id, STAFF)
        else:
            # No department: Staff, unless only production employees hold it (copying it for them would only leave
            # an empty staff twin behind). One nobody holds keeps what it has.
            held = holders.get(g.id, set())
            if held == {PRODUCTION}:
                want = PRODUCTION
            elif held:
                want = STAFF
            else:
                want = g.category if g.category in (STAFF, PRODUCTION) else STAFF
        if g.category != want:
            g.category = want
            g.save(update_fields=["category"])
            if want == PRODUCTION:
                stats["designations_to_production"] += 1

    # Anyone left holding a designation of the other kind gets the same title in their own kind, under their own
    # department (which, after the department step, is of their kind when they have one).
    made: dict[tuple, int] = {}
    desig_rows = {g.id: g for g in Designation.objects.all()}
    wrong = (
        Employee.objects.filter(designation_id__isnull=False)
        .order_by("id")
        .values_list("id", "employment_type", "designation_id", "department_id")
    )
    for emp_id, emp_type, desig_id, emp_dept_id in wrong:
        g = desig_rows.get(desig_id)
        mine = category_of_type(emp_type)
        if g is None or g.category == mine:
            continue
        dept_id = emp_dept_id if emp_dept_id is not None and dept_category.get(emp_dept_id) == mine else None
        key = (g.title.strip().lower(), dept_id, mine)
        target_id = made.get(key)
        if target_id is None:
            existing = (
                Designation.objects.filter(title__iexact=g.title.strip(), department_id=dept_id, category=mine)
                .order_by("id")
                .first()
            )
            if existing is None:
                existing = Designation.objects.create(
                    title=g.title.strip(), department_id=dept_id, level=g.level, category=mine
                )
                stats["designations_created"] += 1
            target_id = made[key] = existing.id
        Employee.objects.filter(id=emp_id).update(designation_id=target_id)
        stats["employees_redesignated"] += 1

    return stats


def forwards(apps, schema_editor):
    Department = apps.get_model("api", "Department")
    Designation = apps.get_model("api", "Designation")

    def counts():
        return (
            {c: Department.objects.filter(category=c).count() for c in (STAFF, PRODUCTION)},
            {c: Designation.objects.filter(category=c).count() for c in (STAFF, PRODUCTION)},
        )

    if not Department.objects.exists() and not Designation.objects.exists():
        return  # a fresh database (the test runner's): nothing to split
    before = counts()
    stats = split_org_categories(apps, log=print)
    after = counts()
    # Shown in the deploy log: what moved, so the result can be checked against the Departments page.
    print(f"\n  departments {before[0]} -> {after[0]}; designations {before[1]} -> {after[1]}")
    print("  " + (", ".join(f"{k}={v}" for k, v in stats.items() if v) or "nothing to change"))


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0149_production_completion_schema"),
    ]

    operations = [
        # Reverse: nothing to undo here (see the module docstring); 0149's reverse removes the columns.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
