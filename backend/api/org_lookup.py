"""Branch / department / designation lookups for the employee flows that name them in TEXT (the bulk Excel upload and
update, and the JSON API when a client sends a name instead of an id).

Two rules live here, so every flow behaves the same:

* A name is matched ignoring case and stray spaces ("  sr.  tailor " is "Sr. Tailor").
* A department or designation that does not exist yet is CREATED, not dropped: typing "Quality Checker" for an employee
  must leave that employee with the designation "Quality Checker", and the designation in the list from then on.
  A designation belongs to a department (the Add/Edit Employee form offers only the employee's own department's
  designations, and a branch login sees a designation through its department), so it is looked up and created in the
  employee's department.

The three tables are read ONCE per request and kept in memory (a 3,000-row upload used to run two or three lookups per
row), and what the request creates is remembered so the next row naming it reuses it instead of creating it again.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from django.db import transaction

from .models import Branch, Department, Designation

# A cell that holds more than this is not a title (an address pasted into the wrong column, say): creating a record
# named after it would only put junk in the list.
MAX_NAME_LENGTH = 100

# What people type in a cell to say "none": never a real department or designation.
_PLACEHOLDERS = {"-", "--", "---", "–", "—", ".", "0", "n/a", "na", "nil", "none", "null"}


def clean_name(value: Any) -> str:
    """The text of a cell/field with surrounding and repeated whitespace removed."""
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()


def is_blank_name(value: Any) -> bool:
    """True for nothing at all and for the usual "no value" scribbles ("-", "N/A", "nil"...)."""
    text = clean_name(value)
    return text == "" or text.lower() in _PLACEHOLDERS


@dataclass
class Resolved:
    """The outcome of looking a name up: the record (None when it could not be had), whether this call created it, and
    a plain-language reason when it could not be."""

    obj: Any = None
    created: bool = False
    problem: str | None = None


@dataclass
class Created:
    """What a request created, for the summary shown to the person who uploaded."""

    title: str
    department: str | None = None
    rows: list[int] = field(default_factory=list)


class OrgLookup:
    def __init__(self) -> None:
        self._branches: dict[str, Branch] | None = None
        self._departments: dict[str, list[Department]] = {}
        self._designations: dict[str, list[Designation]] = {}
        self.new_departments: dict[int, Created] = {}
        self.new_designations: dict[int, Created] = {}

    # --- loading ---

    def _load(self) -> None:
        if self._branches is not None:
            return
        self._branches = {}
        for b in Branch.objects.order_by("id"):
            self._branches.setdefault(clean_name(b.name).lower(), b)
        for d in Department.objects.order_by("id"):
            self._departments.setdefault(clean_name(d.name).lower(), []).append(d)
        for g in Designation.objects.order_by("id"):
            self._designations.setdefault(clean_name(g.title).lower(), []).append(g)

    # --- branch ---

    def branch(self, name: Any) -> Branch | None:
        self._load()
        return self._branches.get(clean_name(name).lower())

    # --- department ---

    def department(self, name: Any, branch_id: int | None, row: int | None = None) -> Resolved:
        """The department called `name` for an employee of `branch_id`, created in that branch when there is none.

        Department names are unique per branch, not globally ("CUTTING" is a different row in each unit), so the
        employee's own branch comes first. A department of no branch, or (to keep older single-branch imports
        working) of another one, is the fallback; only when nothing carries the name is one created."""
        text = clean_name(name)
        if is_blank_name(text):
            return Resolved()
        if len(text) > MAX_NAME_LENGTH:
            return Resolved(problem=f"Department '{text[:30]}...' is too long (over {MAX_NAME_LENGTH} characters)")
        self._load()
        candidates = self._departments.get(text.lower(), [])
        found = (
            next((d for d in candidates if branch_id and d.branch_id == branch_id), None)
            or next((d for d in candidates if d.branch_id is None), None)
            or (candidates[0] if candidates else None)
        )
        if found is not None:
            self._note_use(self.new_departments, found.id, row)
            return Resolved(found)
        # Created IN the employee's branch: a department with no branch would be hidden from every branch login,
        # and so would the designations under it and the employees in it.
        with transaction.atomic():
            dept, _ = Department.objects.get_or_create(name=text, branch_id=branch_id)
        self._departments.setdefault(text.lower(), []).append(dept)
        self.new_departments[dept.id] = Created(dept.name, None, [row] if row else [])
        return Resolved(dept, created=True)

    # --- designation ---

    def designation(self, title: Any, department: Department | None, row: int | None = None) -> Resolved:
        """The designation `title` in `department`, created there when the department has none by that title.

        An employee with no department can't have one to hang it on: any designation of that title is reused, and one
        with no department is created (visible to an unscoped login only, like every department-less designation)."""
        text = clean_name(title)
        if is_blank_name(text):
            return Resolved()
        if len(text) > MAX_NAME_LENGTH:
            return Resolved(problem=f"Designation '{text[:30]}...' is too long (over {MAX_NAME_LENGTH} characters)")
        self._load()
        dept_id = department.id if department is not None else None
        candidates = self._designations.get(text.lower(), [])
        found = next((g for g in candidates if g.department_id == dept_id), None)
        if found is None and dept_id is None and candidates:
            found = candidates[0]
        if found is not None:
            self._note_use(self.new_designations, found.id, row)
            return Resolved(found)
        with transaction.atomic():
            made = Designation.objects.create(title=text, department_id=dept_id)
        self._designations.setdefault(text.lower(), []).append(made)
        self.new_designations[made.id] = Created(
            made.title, department.name if department is not None else None, [row] if row else []
        )
        return Resolved(made, created=True)

    # --- bookkeeping ---

    @staticmethod
    def _note_use(created: dict[int, Created], pk: int, row: int | None) -> None:
        """A row that reuses something this same request created counts toward its "used by N rows"."""
        if pk in created and row and row not in created[pk].rows:
            created[pk].rows.append(row)

    def summary(self) -> dict:
        """What was created, in the shape the upload response carries."""

        def listing(items: dict[int, Created]) -> list[dict]:
            return [
                {"title": c.title, "department": c.department, "rows": len(c.rows)}
                for c in sorted(items.values(), key=lambda c: (c.department or "", c.title.lower()))
            ]

        return {
            "newDepartments": [{"name": c.title, "rows": len(c.rows)} for c in self.new_departments.values()],
            "newDesignations": listing(self.new_designations),
        }


class ImportContext:
    """Everything one bulk upload keeps between its rows, so that a row costs a few queries instead of fifteen:
    the branch/department/designation lookup, every employee code that is taken, the next Unit Code for each branch,
    the production shift each branch uses, and the row being worked on (for the notes shown next to it).

    Must be used inside a transaction: the Unit Code counter of a branch is locked on first use and stays locked until
    the upload ends, so two uploads can never be handed the same number."""

    def __init__(self) -> None:
        self.org = OrgLookup()
        self.shift_cache: dict = {}
        self.row: int | None = None
        self.notes: list[str] = []
        self._codes: set[str] | None = None
        self._branches: dict[int, Branch | None] = {}

    # --- employee codes ---

    def code_taken(self, code: str) -> bool:
        if self._codes is None:
            from .models import Employee

            self._codes = set(Employee.objects.values_list("employee_code", flat=True))
        return code in self._codes

    def remember_code(self, code: str) -> None:
        if self._codes is not None:
            self._codes.add(code)

    # --- unit codes ---

    def unit_code(self, branch_id: int | None) -> str | None:
        """The next "<branch code>-<n>" for a branch (same numbers as employee_views._assign_unit_code, minus its
        lock-and-save round trips for every single employee): None when there is no branch or it has no code yet."""
        if branch_id is None:
            return None
        if branch_id not in self._branches:
            self._branches[branch_id] = Branch.objects.select_for_update().filter(pk=branch_id).first()
        branch = self._branches[branch_id]
        if branch is None or not branch.code:
            return None
        branch.next_employee_seq += 1
        branch.save(update_fields=["next_employee_seq"])
        return f"{branch.code}-{branch.next_employee_seq}"

    # --- the row in hand ---

    def begin_row(self, row: int) -> None:
        self.row = row
        self.notes = []
