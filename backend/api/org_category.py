"""Staff and Production departments and designations (owner, 2026-11-16).

A department is either a Staff department or a Production department (``Department.category``), and only employees of
that kind belong in it: a production employee's department is a Production one, everybody else's a Staff one. A
designation is of its department's kind; one with no department keeps a kind of its own. The same name may exist once
per branch and kind (a Unit1 CUTTING for staff and one for production).

Every flow that sets a department or designation follows the rules here: the Departments / Designations pages and
their endpoints, Add / Edit Employee, the assignment endpoints and the bulk Excel upload (org_lookup.py).
"""

from django.http import QueryDict

from .models import Department, Designation, Employee

STAFF = Department.CATEGORY_STAFF
PRODUCTION = Department.CATEGORY_PRODUCTION
CATEGORIES = (STAFF, PRODUCTION)
LABELS = {STAFF: "Staff", PRODUCTION: "Production"}

# What a client may send for a kind ("Production Employees" is how the pages name the second one).
_ALIASES = {
    "staff": STAFF,
    "production": PRODUCTION,
    "production employee": PRODUCTION,
    "production employees": PRODUCTION,
}


def category_of_type(employment_type) -> str:
    """The kind of department / designation an employee of this employment type belongs in."""
    production = str(employment_type or "").strip().lower() == Employee.EMPLOYMENT_TYPE_PRODUCTION
    return PRODUCTION if production else STAFF


def parse(value) -> str | None:
    """'staff' / 'production' from what a client sent (any case, stray spaces), else None."""
    return _ALIASES.get(" ".join(str(value if value is not None else "").split()).lower())


def label(category) -> str:
    return LABELS.get(category, LABELS[STAFF])


def query_category(params: QueryDict) -> tuple[str | None, str | None]:
    """The ``?category=`` list filter: (the kind, or None for both; an error message when the value is not a kind)."""
    raw = params.get("category")
    if raw is None or str(raw).strip().lower() in ("", "all"):
        return None, None
    found = parse(raw)
    if found is None:
        return None, "category must be 'staff' or 'production'"
    return found, None


def body_category(data, *, default: str | None) -> tuple[str | None, str | None]:
    """A ``category`` sent in a request body: (the kind, error). Missing gives ``default`` (an older client)."""
    if "category" not in data or data.get("category") in (None, ""):
        return default, None
    found = parse(data.get("category"))
    if found is None:
        return None, "category must be 'staff' or 'production'"
    return found, None


def department_mismatch(department: Department | None, employment_type) -> str | None:
    """Why `department` cannot be the department of an employee of this employment type (None when it can)."""
    if department is None:
        return None
    want = category_of_type(employment_type)
    if department.category == want:
        return None
    return (
        f'"{department.name}" is a {label(department.category)} department. '
        f"A {label(want).lower()} employee must be in a {label(want)} department."
    )


def designation_mismatch(designation: Designation | None, employment_type) -> str | None:
    """Why `designation` cannot be held by an employee of this employment type (None when it can)."""
    if designation is None:
        return None
    want = category_of_type(employment_type)
    if designation.category == want:
        return None
    return (
        f'"{designation.title}" is a {label(designation.category)} designation. '
        f"A {label(want).lower()} employee must have a {label(want)} designation."
    )


def employee_mismatch(employment_type, department, designation) -> str | None:
    """The first reason this department / designation pair cannot go with this employment type, or None."""
    return department_mismatch(department, employment_type) or designation_mismatch(designation, employment_type)


def department_change_problem(dept: Department, new_category: str) -> str | None:
    """Why `dept` cannot become a `new_category` department (None when it can).

    Only while nobody is in it (any status: an inactive employee would be left in a department of the other kind) and
    none of its designations is held by anybody. Its designations nobody holds switch along with it."""
    if new_category == dept.category:
        return None
    people = Employee.objects.filter(department_id=dept.id).count()
    if people:
        return (
            f'"{dept.name}" has {people} employee{"s" if people != 1 else ""} (active or not). Move '
            f"{'them' if people != 1 else 'that employee'} to another department first; only an empty department can change "
            f"between Staff and Production."
        )
    held = Employee.objects.filter(designation__department_id=dept.id).count()
    if held:
        return (
            f"{held} employee{'s' if held != 1 else ''} in other departments hold{'' if held != 1 else 's'} a "
            f'designation of "{dept.name}". Change their designation first; only a department whose designations '
            f"nobody holds can change between Staff and Production."
        )
    return None


def designation_change_problem(designation: Designation, new_category: str) -> str | None:
    """Why `designation` cannot become a `new_category` designation (None when it can): nobody may hold it."""
    if new_category == designation.category:
        return None
    held = Employee.objects.filter(designation_id=designation.id).count()
    if not held:
        return None
    return (
        f'{held} employee{"s" if held != 1 else ""} hold{"" if held != 1 else "s"} "{designation.title}" as '
        f"{label(designation.category)} employees. A designation can only move between Staff and Production while "
        f"nobody holds it."
    )
