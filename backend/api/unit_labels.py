"""The short label of a unit (branch) and the order units are listed in, shared by the Report Log's unit blocks and the
unit-wise Salary Statement exports, so a unit has one name everywhere: HO, U-1, UKT-2 ..."""

from __future__ import annotations

import re

# Employees with no branch are listed last, under this label (the Report Log's own word for them).
OTHER_UNIT = "Other"
NO_UNIT_KEY = "none"


def unit_label(branch) -> str | None:
    """
    Short "unit block" label (HO, U-1, U-2 ...): the head office is always "HO", a branch coded like "Unit1" / "Unit 2"
    becomes "U-1" / "U-2", any other branch shows its own code (or its name when it has none). None when the employee has
    no branch.
    """
    if branch is None:
        return None
    if branch.is_head_office:
        return "HO"
    code = (branch.code or "").strip()
    match = re.fullmatch(r"unit[\s_-]*(\d+)", code, flags=re.IGNORECASE)
    if match:
        return f"U-{int(match.group(1))}"
    return code or (branch.name or "").strip() or None


def _natural(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text or "")]


def unit_sort_key(key: str, label: str, branch_name: str | None) -> tuple:
    """The head office first, then the units in natural label order (U-2 before U-10), employees with no unit last."""
    rank = 2 if key == NO_UNIT_KEY else 0 if label == "HO" else 1
    return (rank, _natural(label), _natural(branch_name or ""))
