"""Employee registers: master register, contact directory, strength statement, workforce profile, org structure.

Owner: group ``employees_master``. Sensitive data policy for this module: salary, bank details, PF/ESI/UAN,
Aadhaar / id proof, home address, password hashes and photos are NEVER printed here (the statutory numbers
live in the gated 'statutory-compliance' report).
"""

from __future__ import annotations

from collections import Counter, defaultdict

from django.db.models import Count

from .. import filters as F
from ..common import with_subtotals
from ..registry import register
from ..types import (
    BADGE,
    DATE,
    INTEGER,
    PERCENT,
    TEXT,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .employees_master_base import (
    BLOOD_GROUPS,
    NO_BRANCH,
    UNASSIGNED,
    age_on,
    blank,
    blood_group_of,
    branch_name,
    branch_scope_id,
    clean,
    code_key,
    department_name,
    employees_qs,
    gender_bucket,
    gender_label,
    hod_name_map,
    is_active,
    join_date_of,
    months_between,
    name_key,
    pick_columns,
    status_label,
    tenure_text,
    type_label,
)

CATEGORY = "employees"
MODULES = ("employees",)

GENDER_OPTIONS = (("male", "Male"), ("female", "Female"), ("other", "Other"), ("unspecified", "Not set"))
LAYOUT_OPTIONS = (("standard", "Standard"), ("full", "Full detail"))


def _person_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


# ═════════════════════════════════════════════════════════════════════════════
# employee-master
# ═════════════════════════════════════════════════════════════════════════════

MASTER_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("unitCode", "Unit Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("gender", "Gender", TEXT, 0.8),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.1),
    ColumnSpec("age", "Age", INTEGER, 0.5),
    ColumnSpec("fatherName", "Father's Name", TEXT, 1.6),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("branch", "Branch", TEXT, 1.2),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("tenure", "Tenure", TEXT, 0.8),
    ColumnSpec("status", "Status", BADGE, 0.8),
    ColumnSpec("phone", "Phone", TEXT, 1.2),
    ColumnSpec("email", "Email", TEXT, 1.8),
    ColumnSpec("emergencyContact", "Emergency Contact", TEXT, 1.6),
    ColumnSpec("bloodGroup", "Blood Group", TEXT, 0.7),
    ColumnSpec("hod", "HOD", TEXT, 1.4),
)
MASTER_STANDARD = (
    "employeeCode", "employeeName", "gender", "age", "department", "designation", "branch",
    "employmentType", "joinDate", "tenure", "status", "phone",
)  # fmt: skip


def _master_run(ctx) -> ReportResult:
    today = ctx.today
    layout = ctx.param("layout", "standard")
    gender_filter = ctx.params.get("gender")
    emps = list(employees_qs(ctx))
    if gender_filter:
        emps = [e for e in emps if gender_bucket(e.gender) == gender_filter]
    emps.sort(key=lambda e: code_key(e.employee_code))
    hods = hod_name_map(emps) if layout == "full" else {}

    rows = []
    unreadable = missing_dob = 0
    for e in emps:
        joined, state = join_date_of(e)
        unreadable += state == "unreadable"
        missing_dob += e.date_of_birth is None
        months = months_between(joined, today) if joined else None
        rows.append(
            {
                "employeeCode": e.employee_code,
                "unitCode": clean(e.unit_code),
                "employeeName": _person_name(e),
                "gender": gender_label(e.gender),
                "dateOfBirth": e.date_of_birth,
                "age": age_on(e.date_of_birth, today),
                "fatherName": clean(e.father_name),
                "department": department_name(e),
                "designation": e.designation.title if e.designation_id else None,
                "branch": branch_name(e),
                "employmentType": type_label(e.employment_type),
                "joinDate": joined,
                "tenure": tenure_text(months),
                "status": status_label(e.status),
                "phone": clean(e.phone),
                "email": clean(e.email),
                "emergencyContact": clean(e.emergency_contact),
                "bloodGroup": clean(e.blood_group),
                "hod": hods.get(e.id),
            }
        )

    active = sum(is_active(e) for e in emps)
    buckets = Counter(gender_bucket(e.gender) for e in emps)
    summary = [
        {"label": "Total employees", "value": len(emps), "format": "integer"},
        {"label": "Active", "value": active, "format": "integer"},
        {"label": "Inactive / left", "value": len(emps) - active, "format": "integer"},
        {"label": "Staff", "value": sum((e.employment_type or "") == "staff" for e in emps), "format": "integer"},
        {"label": "Production", "value": sum((e.employment_type or "") == "production" for e in emps), "format": "integer"},
        {"label": "Male", "value": buckets["male"], "format": "integer"},
        {"label": "Female", "value": buckets["female"], "format": "integer"},
        {"label": "Other / not set", "value": buckets["other"] + buckets["unspecified"], "format": "integer"},
    ]  # fmt: skip
    notes = [
        "Salary, bank details, PF/ESI/UAN numbers, address and ID proof are not part of this register "
        "(see Statutory & KYC Compliance for the statutory numbers).",
        "Age and tenure are as on " + today.strftime("%d-%b-%Y") + ".",
    ]
    if layout == "full":
        notes.append(
            "HOD is the department head this employee's approvals route to (one active HOD per employee); "
            "blank when none is assigned or for the HOD themselves."
        )
    if unreadable:
        notes.append(
            f"{unreadable} employee(s) have a join date that could not be read; their join date and tenure are blank."
        )
    if missing_dob:
        notes.append(f"{missing_dob} employee(s) have no date of birth on file; their age is blank.")
    columns = list(MASTER_COLUMNS) if layout == "full" else pick_columns(MASTER_COLUMNS, MASTER_STANDARD)
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(ReportSpec(
    id="employee-master",
    title="Employee Master Register",
    description="Every employee with organisation, personal and contact details - the master list of your workforce.",
    category=CATEGORY,
    modules=MODULES,
    icon="Users",
    tags=("employees", "master", "register", "staff list", "workforce"),
    filters=(
        *F.scope(status="active"),
        F.select("gender", "Gender", GENDER_OPTIONS, placeholder="All genders"),
        F.select(
            "layout", "Columns", LAYOUT_OPTIONS, default="standard",
            help="Standard fits one printed page; Full detail adds unit code, date of birth, contacts and HOD.",
        ),
    ),
    columns=MASTER_COLUMNS,
    run=_master_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# employee-contact-list
# ═════════════════════════════════════════════════════════════════════════════

CONTACT_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("phone", "Phone", TEXT, 1.3),
    ColumnSpec("email", "Email", TEXT, 2.0),
    ColumnSpec("emergencyContact", "Emergency Contact", TEXT, 2.0),
    ColumnSpec("bloodGroup", "Blood Group", TEXT, 0.8),
    ColumnSpec("fatherName", "Father's Name", TEXT, 1.6),
)
BLOOD_OPTIONS = (*((b, b) for b in BLOOD_GROUPS), ("unknown", "Not recorded"))
SORT_OPTIONS = (
    ("code", "Employee code"), ("name", "Name"), ("department", "Department"), ("bloodGroup", "Blood group"),
)  # fmt: skip


def _blood_rank(group: str | None) -> int:
    return BLOOD_GROUPS.index(group) if group in BLOOD_GROUPS else len(BLOOD_GROUPS)


def _contact_run(ctx) -> ReportResult:
    sort_by = ctx.param("sortBy", "code")
    blood_filter = ctx.params.get("bloodGroup")
    emps = list(employees_qs(ctx))
    if blood_filter:
        want = None if blood_filter == "unknown" else blood_filter
        emps = [e for e in emps if blood_group_of(e.blood_group) == want]
    if sort_by == "name":
        emps.sort(key=name_key)
    elif sort_by == "department":
        emps.sort(key=lambda e: (department_name(e).lower(), code_key(e.employee_code)))
    elif sort_by == "bloodGroup":
        emps.sort(key=lambda e: (_blood_rank(blood_group_of(e.blood_group)), code_key(e.employee_code)))
    else:
        emps.sort(key=lambda e: code_key(e.employee_code))

    rows = [{
        "employeeCode": e.employee_code,
        "employeeName": _person_name(e),
        "department": department_name(e),
        "designation": e.designation.title if e.designation_id else None,
        "employmentType": type_label(e.employment_type),
        "phone": clean(e.phone),
        "email": clean(e.email),
        "emergencyContact": clean(e.emergency_contact),
        "bloodGroup": blood_group_of(e.blood_group) or clean(e.blood_group),
        "fatherName": clean(e.father_name),
    } for e in emps]  # fmt: skip
    groups = Counter(blood_group_of(e.blood_group) or "unknown" for e in emps)
    blood_line = ", ".join(f"{g} {groups[g]}" for g in (*BLOOD_GROUPS, "unknown") if groups.get(g))
    summary = [
        {"label": "Employees listed", "value": len(emps), "format": "integer"},
        {"label": "Missing phone", "value": sum(blank(e.phone) for e in emps), "format": "integer"},
        {"label": "Missing emergency contact", "value": sum(blank(e.emergency_contact) for e in emps), "format": "integer"},
        {"label": "Blood group not recorded", "value": groups.get("unknown", 0), "format": "integer"},
    ]  # fmt: skip
    notes = ["Home address, salary and bank details are not part of this directory."]
    if blood_line:
        notes.append("Blood groups: " + blood_line.replace("unknown", "not recorded") + ".")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="employee-contact-list",
    title="Contact & Emergency Directory",
    description="Phone, emergency contact and blood group of every employee - for the gate, safety officer and HR.",
    category=CATEGORY,
    modules=MODULES,
    icon="Phone",
    tags=("phone", "contact", "emergency", "blood group", "directory"),
    filters=(
        *F.scope(status="active"),
        F.select("bloodGroup", "Blood group", BLOOD_OPTIONS, placeholder="All blood groups"),
        F.select("sortBy", "Sort by", SORT_OPTIONS, default="code"),
    ),
    columns=CONTACT_COLUMNS,
    run=_contact_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# strength-statement
# ═════════════════════════════════════════════════════════════════════════════

_STRENGTH_TAIL = (
    ColumnSpec("staff", "Staff", INTEGER, 0.8, total="sum"),
    ColumnSpec("production", "Production", INTEGER, 1.0, total="sum"),
    ColumnSpec("male", "Male", INTEGER, 0.8, total="sum"),
    ColumnSpec("female", "Female", INTEGER, 0.8, total="sum"),
    ColumnSpec("otherOrUnset", "Other / Not set", INTEGER, 1.0, total="sum"),
    ColumnSpec("total", "Total", INTEGER, 0.9, total="sum"),
    ColumnSpec("sharePct", "Share %", PERCENT, 0.8),
)
STRENGTH_HEAD = {
    "department": (ColumnSpec("group", "Department", TEXT, 2.4), ColumnSpec("branch", "Branch", TEXT, 1.6)),
    "designation": (
        ColumnSpec("group", "Designation", TEXT, 2.4),
        ColumnSpec("department", "Department", TEXT, 1.8),
        ColumnSpec("level", "Level", TEXT, 1.0),
    ),
    "branch": (ColumnSpec("group", "Branch", TEXT, 2.4), ColumnSpec("code", "Branch Code", TEXT, 1.2)),
}
GROUP_OPTIONS = (("department", "Department"), ("designation", "Designation"), ("branch", "Branch"))


def _strength_run(ctx) -> ReportResult:
    from api.models import Branch, Department, Designation

    group_by = ctx.param("groupBy", "department")
    emps = list(ctx.employees())
    scope = branch_scope_id(ctx)
    p = ctx.params

    # Static facts about every group (label, branch/department/level/code) -- loaded once, never per row.
    groups: dict = {}

    def touch(key, label, **extra):
        if key not in groups:
            groups[key] = {
                "label": label,
                **extra,
                "staff": 0,
                "production": 0,
                "male": 0,
                "female": 0,
                "other": 0,
                "total": 0,
            }
        return groups[key]

    if group_by == "department":
        depts = {
            d.id: d
            for d in Department.objects.select_related("branch").filter(
                id__in={e.department_id for e in emps if e.department_id}
            )
        }

        def info(e):
            d = depts.get(e.department_id)
            branch = (d.branch.name if d.branch_id else NO_BRANCH) if d else None
            return (e.department_id, d.name if d else UNASSIGNED, {"branch": branch})
    elif group_by == "designation":
        desigs = {
            d.id: d
            for d in Designation.objects.select_related("department").filter(
                id__in={e.designation_id for e in emps if e.designation_id}
            )
        }

        def info(e):
            d = desigs.get(e.designation_id)
            return (
                e.designation_id, d.title if d else "No designation",
                {"department": (d.department.name if d and d.department_id else UNASSIGNED), "level": (d.level if d else None)},
            )  # fmt: skip
    else:

        def info(e):
            return (
                e.branch_id,
                e.branch.name if e.branch_id else NO_BRANCH,
                {"code": (e.branch.code if e.branch_id else None)},
            )

    for e in emps:
        key, label, extra = info(e)
        g = touch(key, label, **extra)
        et = (e.employment_type or "").strip()
        if et == "staff":
            g["staff"] += 1
        elif et == "production":
            g["production"] += 1
        bucket = gender_bucket(e.gender)
        g["male" if bucket == "male" else "female" if bucket == "female" else "other"] += 1
        g["total"] += 1

    if ctx.params.get("includeEmpty"):
        if group_by == "department":
            qs = Department.objects.select_related("branch")
            if scope is not None:
                qs = qs.filter(branch_id=scope)
            if p.get("branch_ids"):
                qs = qs.filter(branch_id__in=p["branch_ids"])
            if p.get("department_ids"):
                qs = qs.filter(id__in=p["department_ids"])
            for d in qs:
                touch(d.id, d.name, branch=(d.branch.name if d.branch_id else NO_BRANCH))
        elif group_by == "designation":
            qs = Designation.objects.select_related("department")
            if scope is not None:
                qs = qs.filter(department__branch_id=scope)
            if p.get("branch_ids"):
                qs = qs.filter(department__branch_id__in=p["branch_ids"])
            if p.get("department_ids"):
                qs = qs.filter(department_id__in=p["department_ids"])
            if p.get("designation_ids"):
                qs = qs.filter(id__in=p["designation_ids"])
            for d in qs:
                touch(d.id, d.title, department=(d.department.name if d.department_id else UNASSIGNED), level=d.level)
        else:
            qs = Branch.objects.all()
            if scope is not None:
                qs = qs.filter(id=scope)
            if p.get("branch_ids"):
                qs = qs.filter(id__in=p["branch_ids"])
            for b in qs:
                touch(b.id, b.name, code=b.code)

    unassigned_labels = {UNASSIGNED, NO_BRANCH, "No designation"}
    ordered = sorted(
        groups.items(),
        key=lambda kv: (kv[1]["label"] in unassigned_labels and kv[0] is None, kv[1]["label"].lower(), kv[0] or 0),
    )
    grand = sum(g["total"] for _, g in ordered)
    head = STRENGTH_HEAD[group_by]
    rows = []
    for _key, g in ordered:
        row = {c.key: g.get(c.key) for c in head}
        row["group"] = g["label"]
        row.update({
            "staff": g["staff"], "production": g["production"], "male": g["male"], "female": g["female"],
            "otherOrUnset": g["other"], "total": g["total"],
            "sharePct": round(g["total"] * 100 / grand, 2) if grand else None,
        })  # fmt: skip
        rows.append(row)

    staff = sum(g["staff"] for _, g in ordered)
    production = sum(g["production"] for _, g in ordered)
    summary = [
        {"label": "Total strength", "value": grand, "format": "integer"},
        {"label": "Staff", "value": staff, "format": "integer"},
        {"label": "Production", "value": production, "format": "integer"},
        {"label": "Male", "value": sum(g["male"] for _, g in ordered), "format": "integer"},
        {"label": "Female", "value": sum(g["female"] for _, g in ordered), "format": "integer"},
        {"label": {"department": "Departments", "designation": "Designations", "branch": "Branches"}[group_by], "value": len(rows), "format": "integer"},
    ]  # fmt: skip
    notes = [
        "Strength is as on the report date - the system keeps no headcount history, so past dates cannot be reproduced.",
        "Groups are counted by department / designation / branch record, so same-named departments of different "
        "branches appear as separate rows.",
    ]
    if staff + production != grand:
        notes.append(
            f"{grand - staff - production} employee(s) have an employment type other than staff or production: "
            "they are in the Total but in neither the Staff nor the Production column."
        )
    return ReportResult(rows=rows, columns=[*head, *_STRENGTH_TAIL], summary=summary, notes=notes)


register(ReportSpec(
    id="strength-statement",
    title="Strength Statement (Headcount)",
    description="Manpower strength by department, designation or branch with staff / production and gender split.",
    category=CATEGORY,
    modules=MODULES,
    icon="BarChart3",
    tags=("headcount", "strength", "manpower", "department wise", "gender"),
    filters=(
        F.select("groupBy", "Group by", GROUP_OPTIONS, default="department"),
        *F.scope(employee=False, status="active"),
        F.boolean("includeEmpty", "Include groups with no employees"),
    ),
    columns=(*STRENGTH_HEAD["department"], *_STRENGTH_TAIL),
    run=_strength_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# workforce-profile
# ═════════════════════════════════════════════════════════════════════════════

PROFILE_DIMENSIONS = (
    ("ageBand", "Age band"), ("tenureBand", "Length of service"), ("gender", "Gender"),
    ("bloodGroup", "Blood group"), ("salaryType", "Salary type"),
)  # fmt: skip
AGE_BANDS = ("Under 18", "18-25", "26-35", "36-45", "46-55", "56+", "Unknown")
TENURE_BANDS = ("Under 6 months", "6-12 months", "1-3 years", "3-5 years", "5+ years", "Unknown")
GENDER_BANDS = ("Male", "Female", "Other", "Not set")
SALARY_TYPE_BANDS = ("Monthly", "Weekly")


def _age_band(age):
    if age is None:
        return "Unknown"
    for limit, label in ((18, "Under 18"), (26, "18-25"), (36, "26-35"), (46, "36-45"), (56, "46-55")):
        if age < limit:
            return label
    return "56+"


def _tenure_band(months):
    if months is None or months < 0:
        return "Unknown"
    for limit, label in ((6, "Under 6 months"), (12, "6-12 months"), (36, "1-3 years"), (60, "3-5 years")):
        if months < limit:
            return label
    return "5+ years"


def _profile_run(ctx) -> ReportResult:
    today = ctx.today
    dimension = ctx.param("dimension", "ageBand")
    emps = list(employees_qs(ctx))

    ages, service_years = [], []
    unknown_dob = unknown_join = 0
    for e in emps:
        a = age_on(e.date_of_birth, today)
        if a is None:
            unknown_dob += 1
        else:
            ages.append(a)
        joined, _state = join_date_of(e)
        m = months_between(joined, today) if joined else None
        if m is None or m < 0:
            unknown_join += 1
        else:
            service_years.append(m / 12)

    def bucket_of(e):
        if dimension == "ageBand":
            return _age_band(age_on(e.date_of_birth, today))
        if dimension == "tenureBand":
            joined, _s = join_date_of(e)
            return _tenure_band(months_between(joined, today) if joined else None)
        if dimension == "gender":
            return {"male": "Male", "female": "Female", "other": "Other", "unspecified": "Not set"}[
                gender_bucket(e.gender)
            ]
        if dimension == "bloodGroup":
            return blood_group_of(e.blood_group) or "Unknown"
        st = (e.salary_type or "").strip().lower()
        return st.title() if st else "Unknown"

    order = {
        "ageBand": AGE_BANDS, "tenureBand": TENURE_BANDS, "gender": GENDER_BANDS,
        "bloodGroup": (*BLOOD_GROUPS, "Unknown"), "salaryType": (*SALARY_TYPE_BANDS, "Unknown"),
    }[dimension]  # fmt: skip
    table: dict[str, dict] = {b: defaultdict(int) for b in order}
    for e in emps:
        b = bucket_of(e)
        cell = table.setdefault(b, defaultdict(int))
        et = (e.employment_type or "").strip()
        if et in ("staff", "production"):
            cell[et] += 1
        g = gender_bucket(e.gender)
        cell["male" if g == "male" else "female" if g == "female" else "other"] += 1
        cell["total"] += 1

    total = len(emps)
    labels = list(order) + sorted(b for b in table if b not in order)
    rows = [{
        "bucket": b,
        "staff": table[b]["staff"], "production": table[b]["production"],
        "male": table[b]["male"], "female": table[b]["female"], "otherOrUnset": table[b]["other"],
        "total": table[b]["total"],
        "sharePct": round(table[b]["total"] * 100 / total, 2) if total else None,
    } for b in labels]  # fmt: skip
    summary = [
        {"label": "Employees", "value": total, "format": "integer"},
        {"label": "Average age (years)", "value": round(sum(ages) / len(ages), 1) if ages else None, "format": "number"},
        {"label": "Average service (years)", "value": round(sum(service_years) / len(service_years), 1) if service_years else None, "format": "number"},
        {"label": "Date of birth unknown", "value": unknown_dob, "format": "integer"},
        {"label": "Join date unknown", "value": unknown_join, "format": "integer"},
    ]  # fmt: skip
    notes = [
        "Age and length of service are as on "
        + today.strftime("%d-%b-%Y")
        + ". 'Unknown' means the date of birth / join date "
        "is missing or could not be read.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="workforce-profile",
    title="Workforce Profile",
    description="How the workforce splits by age band, length of service, gender, blood group or salary type.",
    category=CATEGORY,
    modules=MODULES,
    icon="PieChart",
    tags=("demographics", "age", "tenure", "gender", "profile", "distribution"),
    landscape=False,
    filters=(
        F.select("dimension", "Analyse by", PROFILE_DIMENSIONS, default="ageBand"),
        *F.scope(designation=False, employee=False, employment=False, status="active"),
    ),
    columns=(
        ColumnSpec("bucket", "Group", TEXT, 2.0),
        ColumnSpec("staff", "Staff", INTEGER, 0.9, total="sum"),
        ColumnSpec("production", "Production", INTEGER, 1.1, total="sum"),
        ColumnSpec("male", "Male", INTEGER, 0.9, total="sum"),
        ColumnSpec("female", "Female", INTEGER, 0.9, total="sum"),
        ColumnSpec("otherOrUnset", "Other / Not set", INTEGER, 1.1, total="sum"),
        ColumnSpec("total", "Total", INTEGER, 0.9, total="sum"),
        ColumnSpec("sharePct", "Share %", PERCENT, 0.9),
    ),
    run=_profile_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# org-structure
# ═════════════════════════════════════════════════════════════════════════════

ORG_COLUMNS = (
    ColumnSpec("branch", "Branch", TEXT, 1.6),
    ColumnSpec("branchCode", "Code", TEXT, 0.8),
    ColumnSpec("department", "Department", TEXT, 2.0),
    ColumnSpec("designations", "Designations", INTEGER, 1.0, total="sum"),
    ColumnSpec("staff", "Active Staff", INTEGER, 1.0, total="sum"),
    ColumnSpec("production", "Active Production", INTEGER, 1.2, total="sum"),
    ColumnSpec("hods", "HOD(s)", TEXT, 2.2),
    ColumnSpec("required", "Required (Plan)", INTEGER, 1.1, total="sum"),
    ColumnSpec("vacancy", "Vacancy", INTEGER, 0.9, total="sum"),
)


def _org_run(ctx) -> ReportResult:
    from api.models import (
        Branch,
        Department,
        DepartmentHeadcount,
        Designation,
        Employee,
        ManagerDepartmentAssignment,
    )

    p = ctx.params
    scope = branch_scope_id(ctx)

    qs = Department.objects.select_related("branch")
    if scope is not None:
        qs = qs.filter(branch_id=scope)
    if p.get("branch_ids"):
        qs = qs.filter(branch_id__in=p["branch_ids"])
    if p.get("department_ids"):
        qs = qs.filter(id__in=p["department_ids"])
    depts = {d.id: d for d in qs}

    # Active strength: per department, and (for people with no department) per branch. Branch isolation and the
    # declared filters come from ctx.emp_q(), so a branch user only ever counts their own branch's people.
    counts: dict[tuple, int] = defaultdict(int)
    people = Employee.objects.filter(ctx.emp_q(), status="active").values_list(
        "department_id", "branch_id", "employment_type"
    )
    for dept_id, branch_id, et in people:
        counts[(dept_id, None if dept_id else branch_id, (et or "").strip())] += 1
    # A department the employees sit in but that the branch filter did not list (legacy data with a mismatched or
    # empty branch) still has to appear, or the totals would not add up to the headcount.
    stray = {k[0] for k in counts if k[0] is not None and k[0] not in depts}
    if stray:
        for d in Department.objects.select_related("branch").filter(id__in=stray):
            depts[d.id] = d

    dept_ids = list(depts)
    designations = dict(
        Designation.objects.filter(department_id__in=dept_ids)
        .order_by()
        .values_list("department_id")
        .annotate(n=Count("id"))
    )
    required = dict(
        DepartmentHeadcount.objects.filter(department_id__in=dept_ids).values_list("department_id", "required_count")
    )
    hods: dict[int, list[str]] = defaultdict(list)
    assignments = (
        ManagerDepartmentAssignment.objects.filter(department_id__in=dept_ids, manager__is_active=True)
        .select_related("manager__employee")
        .defer("manager__employee__photo_url", "manager__employee__password_hash")
        .order_by("created_at", "id")
    )
    for a in assignments:
        hods[a.department_id].append(_person_name(a.manager.employee))
    branches = {b.id: b for b in Branch.objects.only("id", "name", "code", "is_active")}

    def branch_label(branch):
        if branch is None:
            return NO_BRANCH, None
        return (branch.name if branch.is_active else f"{branch.name} (inactive)"), branch.code

    rows = []
    for d in depts.values():
        label, code = branch_label(branches.get(d.branch_id) if d.branch_id else None)
        staff = counts.get((d.id, None, "staff"), 0)
        plan = required.get(d.id) or None  # a missing row and 0 both mean "not planned"
        rows.append({
            "branch": label, "branchCode": code, "department": d.name,
            "designations": designations.get(d.id, 0),
            "staff": staff, "production": counts.get((d.id, None, "production"), 0),
            "hods": ", ".join(hods.get(d.id, [])) or None,
            "required": plan, "vacancy": max(0, plan - staff) if plan else None,
        })  # fmt: skip
    # Active employees with no department, per branch, so the strength still reconciles with the headcount.
    loose: dict[int | None, dict[str, int]] = {}
    for (dept_id, branch_id, et), n in counts.items():
        if dept_id is None and et in ("staff", "production"):
            loose.setdefault(branch_id, {"staff": 0, "production": 0})[et] += n
    for branch_id, c in loose.items():
        label, code = branch_label(branches.get(branch_id) if branch_id else None)
        rows.append({
            "branch": label, "branchCode": code, "department": "Unassigned (no department)",
            "designations": None, "staff": c["staff"], "production": c["production"],
            "hods": None, "required": None, "vacancy": None,
        })  # fmt: skip
    rows.sort(
        key=lambda r: (
            r["branch"] == NO_BRANCH,
            r["branch"].lower(),
            r["department"].startswith("Unassigned"),
            r["department"].lower(),
        )
    )
    data_rows = list(rows)
    rows = with_subtotals(
        rows, lambda r: r["branch"], ("designations", "staff", "production", "required", "vacancy"),
        label_key="department", label=lambda g: f"{g} total",
    )  # fmt: skip

    summary = [
        {"label": "Branches", "value": len({r["branch"] for r in data_rows}), "format": "integer"},
        {"label": "Departments", "value": len(depts), "format": "integer"},
        {"label": "Active employees", "value": sum((r["staff"] or 0) + (r["production"] or 0) for r in data_rows), "format": "integer"},
        {"label": "Planned positions", "value": sum(r["required"] or 0 for r in data_rows), "format": "integer"},
        {"label": "Open vacancies", "value": sum(r["vacancy"] or 0 for r in data_rows), "format": "integer"},
    ]  # fmt: skip
    notes = [
        "Strength counts active employees only. Vacancy = planned staff positions minus active staff "
        "(production is not part of the manpower plan); blank where no plan is set.",
        "HOD(s) are the department heads holding the whole department; individually assigned employees are not listed here.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="org-structure",
    title="Branch & Department Directory",
    description="Branches and departments with designations, active strength, department heads and manpower plan.",
    category=CATEGORY,
    modules=("employees", "employees.branches", "employees.departments"),
    icon="Network",
    tags=("branch", "department", "organisation", "structure", "hod", "vacancy"),
    filters=(F.branches(), F.departments()),
    columns=ORG_COLUMNS,
    run=_org_run,
))  # fmt: skip
