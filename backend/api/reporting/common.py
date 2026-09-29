"""Building blocks most report definitions share."""

from __future__ import annotations

from typing import Callable, Iterable

from .formatting import full_name
from .runner import KIND_SUBTOTAL
from .types import TEXT, ColumnSpec

# The four columns that identify an employee on almost every report.
EMP_COLS: tuple[ColumnSpec, ...] = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
)

EMP_COLS_SHORT: tuple[ColumnSpec, ...] = EMP_COLS[:3]


def emp_cells(emp) -> dict:
    """Row cells for EMP_COLS. ``emp`` should come from a queryset that select_related's
    department and designation (otherwise this is an N+1)."""
    return {
        "employeeCode": emp.employee_code,
        "employeeName": full_name(emp),
        "department": emp.department.name if emp.department_id else "Unassigned",
        "designation": emp.designation.title if emp.designation_id else None,
    }


def with_subtotals(
    rows: Iterable[dict],
    group_by: Callable[[dict], str],
    sum_keys: Iterable[str],
    label_key: str = "employeeName",
    label: Callable[[str], str] = lambda g: f"{g} total",
) -> list[dict]:
    """Insert a ``_kind: subtotal`` row after each run of rows sharing ``group_by(row)``.

    Rows must already be ordered by the group. Totals row excludes subtotal rows, so the grand
    total is not double-counted."""
    out: list[dict] = []
    keys = list(sum_keys)
    current = None
    acc: dict[str, float] = {}

    def flush():
        if current is not None:
            row = {label_key: label(current), "_kind": KIND_SUBTOTAL}
            row.update({k: (round(v, 2) if isinstance(v, float) else v) for k, v in acc.items()})
            out.append(row)

    for r in rows:
        g = group_by(r)
        if g != current:
            flush()
            current, acc = g, {k: 0 for k in keys}
        out.append(r)
        for k in keys:
            v = r.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                acc[k] += v
    flush()
    return out
