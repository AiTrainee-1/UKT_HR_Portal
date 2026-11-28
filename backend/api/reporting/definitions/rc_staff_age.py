"""Staff Age Analysis (category ``employees``, owner 2026-11-28): the staff list department by department, each person's
age placed in its age band (0-25, 26-30, 31-35, 36-40, 41-45, 46-50, 51-55, 56-75; 76 and above only when someone is),
with the count of every band per department, per unit and overall.

The owner's printed "STAFF LIST" was the model: S.No, name, ID, gender, date of birth, age, the band columns with the
count above each one, departments as headed groups. Here every department opens with its own row of band counts
(a subtotal row before its people), the grand total closes the table, and two further tables give the band counts
unit by unit (with the overall total: owner "when all units are selected, the counts of each unit and the overall
totals") and department by department. Age is in completed years on the day the report is run; an employee without a
date of birth is listed but in no band (counted in the cards and a note).
"""

from __future__ import annotations

import dataclasses
from collections import defaultdict

from .. import filters as F
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import DATE, INTEGER, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSection, ReportSpec
from .employees_master_base import (
    NO_BRANCH,
    UNASSIGNED,
    age_on,
    branch_name,
    code_key,
    department_name,
    gender_label,
)
from ..formatting import full_name

CATEGORY = "employees"

# (key, label, lowest age, highest age); the last band only appears when someone is in it
BANDS = (
    ("b0", "0–25", 0, 25),
    ("b26", "26–30", 26, 30),
    ("b31", "31–35", 31, 35),
    ("b36", "36–40", 36, 40),
    ("b41", "41–45", 41, 45),
    ("b46", "46–50", 46, 50),
    ("b51", "51–55", 51, 55),
    ("b56", "56–75", 56, 75),
)
OLDER = ("b76", "76 & above", 76, 200)


def band_of(age: int | None, bands=(*BANDS, OLDER)) -> str | None:
    if age is None:
        return None
    return next((key for key, _label, lo, hi in bands if lo <= age <= hi), None)


def _band_columns(bands) -> list[ColumnSpec]:
    return [ColumnSpec(key, label, INTEGER, 0.62, align="center") for key, label, _lo, _hi in bands]


def _avg(ages: list[int]) -> float | None:
    return round(sum(ages) / len(ages), 1) if ages else None


def _counts(people: list[dict], bands) -> dict:
    out = {key: 0 for key, *_ in bands}
    for p in people:
        if p["band"] in out:
            out[p["band"]] += 1
    return out


def _group_order(name: str, empty: str) -> tuple:
    # alphabetical, the "Unassigned" / "No branch" group last
    return (name == empty, name.lower())


def _run(ctx) -> ReportResult:
    today = ctx.today
    emps = sorted(ctx.employees(), key=lambda e: code_key(e.employee_code))[: ctx.row_limit]
    people = []
    for e in emps:
        age = age_on(e.date_of_birth, today)
        people.append(
            {
                "emp": e,
                "code": e.employee_code,
                "name": full_name(e),
                "gender": gender_label(e.gender),
                "dob": e.date_of_birth,
                "age": age,
                "band": band_of(age),
                "unit": branch_name(e),
                "department": department_name(e),
                "designation": e.designation.title if e.designation_id else None,
            }
        )

    bands = BANDS + ((OLDER,) if any(p["band"] == OLDER[0] for p in people) else ())
    units = sorted({p["unit"] for p in people}, key=lambda u: _group_order(u, NO_BRANCH))
    several_units = len(units) > 1

    columns = [
        ColumnSpec("sno", "S.No", INTEGER, 0.45, align="center"),
        ColumnSpec("employeeCode", "Emp Code", TEXT, 0.85),
        ColumnSpec("employeeName", "Name", TEXT, 2.0),
        ColumnSpec("gender", "Gender", TEXT, 0.75),
        ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.05),
        ColumnSpec("age", "Age", INTEGER, 0.5, align="center"),
    ]
    if several_units:
        columns.append(ColumnSpec("unit", "Unit", TEXT, 1.0))
    columns.append(ColumnSpec("designation", "Designation", TEXT, 1.3))
    columns += _band_columns(bands)

    # ── the main table: each department headed by its band counts, its people in code order ──
    by_department: dict[str, list[dict]] = defaultdict(list)
    for p in people:
        by_department[p["department"]].append(p)
    rows: list[dict] = []
    sno = 0
    for dept in sorted(by_department, key=lambda d: _group_order(d, UNASSIGNED)):
        members = by_department[dept]
        head = {
            "employeeName": f"{dept} · {len(members)} {'person' if len(members) == 1 else 'people'}",
            "_kind": KIND_SUBTOTAL,
            # a band nobody in the department is in stays blank (the printed staff list's way; no wall of zeros)
            **{key: (count or None) for key, count in _counts(members, bands).items()},
        }
        rows.append(head)
        for p in members:
            sno += 1
            row = {
                "sno": sno,
                "employeeCode": p["code"],
                "employeeName": p["name"],
                "gender": p["gender"],
                "dateOfBirth": p["dob"],
                "age": p["age"],
                "unit": p["unit"],
                "designation": p["designation"],
            }
            if p["band"]:
                row[p["band"]] = p["age"]  # the age written in its band, as the printed staff list does
            rows.append(row)

    ages = [p["age"] for p in people if p["age"] is not None]
    totals = {"employeeName": f"Total · {len(people)}", **_counts(people, bands)}

    # ── unit by unit, department by department: the counts of every band, the average age ──
    def profile(group_key: str, label_key: str, label: str, order_empty: str, title: str, sheet: str) -> ReportSection:
        groups: dict[str, list[dict]] = defaultdict(list)
        for p in people:
            groups[p[group_key]].append(p)
        sec_rows = []
        for name in sorted(groups, key=lambda g: _group_order(g, order_empty)):
            members = groups[name]
            member_ages = [m["age"] for m in members if m["age"] is not None]
            sec_rows.append(
                {
                    label_key: name,
                    "staff": len(members),
                    "male": sum(m["gender"] == "Male" for m in members),
                    "female": sum(m["gender"] == "Female" for m in members),
                    **_counts(members, bands),
                    "noDob": sum(m["age"] is None for m in members),
                    "avgAge": _avg(member_ages),
                }
            )
        sec_columns = (
            ColumnSpec(label_key, label, TEXT, 1.6),
            ColumnSpec("staff", "Staff", INTEGER, 0.6, align="center"),
            ColumnSpec("male", "Male", INTEGER, 0.55, align="center"),
            ColumnSpec("female", "Female", INTEGER, 0.6, align="center"),
            *_band_columns(bands),
            ColumnSpec("noDob", "No DOB", INTEGER, 0.6, align="center"),
            ColumnSpec("avgAge", "Average age", NUMBER, 0.8, align="center"),
        )
        sec_totals = {
            label_key: "Overall total",
            "staff": len(people),
            "male": sum(p["gender"] == "Male" for p in people),
            "female": sum(p["gender"] == "Female" for p in people),
            **_counts(people, bands),
            "noDob": sum(p["age"] is None for p in people),
            "avgAge": _avg(ages),
        }
        return ReportSection(title=title, columns=sec_columns, rows=sec_rows, totals=sec_totals, sheet=sheet)

    sections = []
    if several_units:
        sections.append(profile("unit", "unit", "Unit", NO_BRANCH, "Unit-wise age profile", "Units"))
    sections.append(
        profile("department", "department", "Department", UNASSIGNED, "Department-wise age profile", "Departments")
    )

    no_dob = sum(p["age"] is None for p in people)
    summary = [
        {"label": "Staff", "value": len(people), "format": "integer"},
        {"label": "Average age", "value": _avg(ages), "format": "number"},
        {"label": "Youngest", "value": min(ages) if ages else None, "format": "integer"},
        {"label": "Oldest", "value": max(ages) if ages else None, "format": "integer"},
        {"label": "Up to 30", "value": sum(a <= 30 for a in ages), "format": "integer"},
        {"label": "Above 50", "value": sum(a > 50 for a in ages), "format": "integer"},
    ]
    if several_units:
        summary.insert(1, {"label": "Units", "value": len(units), "format": "integer"})
    if no_dob:
        summary.append({"label": "No date of birth", "value": no_dob, "format": "integer"})

    notes = [
        f"Age is in completed years on {today.strftime('%d-%b-%Y')}. Each person's age is written in the column of "
        "their age band; every department's first row, the total row and the profile tables give the count in each "
        "band.",
    ]
    if no_dob:
        notes.append(
            f"{no_dob} {'person has' if no_dob == 1 else 'people have'} no date of birth on file: listed, but in no band "
            "and not in the average."
        )
    if several_units:
        notes.append("All selected units: the Unit-wise age profile gives each unit's counts and the overall total.")
    return ReportResult(rows=rows, columns=columns, totals=totals, summary=summary, notes=notes, sections=sections)


_STAFF_TYPE = dataclasses.replace(F.employment_type(), default="staff")

register(
    ReportSpec(
        id="staff-age-analysis",
        title="Staff Age Analysis",
        description="The staff list department by department, each age in its band (0–25 to 56–75), with the band "
        "counts per department, per unit and overall.",
        category=CATEGORY,
        modules=("employees",),
        icon="Cake",
        tags=(
            "age",
            "age group",
            "age band",
            "staff list",
            "date of birth",
            "dob",
            "demographics",
            "unit",
            "department",
        ),
        filters=(
            F.branches("Unit"),
            F.departments(),
            F.designations(),
            _STAFF_TYPE,
            F.employees(),
            F.employee_status("active"),
        ),
        columns=(
            ColumnSpec("sno", "S.No", INTEGER, 0.45, align="center"),
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.85),
            ColumnSpec("employeeName", "Name", TEXT, 2.0),
            ColumnSpec("gender", "Gender", TEXT, 0.75),
            ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.05),
            ColumnSpec("age", "Age", INTEGER, 0.5, align="center"),
            ColumnSpec("designation", "Designation", TEXT, 1.3),
            *_band_columns(BANDS),
        ),
        run=_run,
        pdf_max_rows=3_000,
    )
)
