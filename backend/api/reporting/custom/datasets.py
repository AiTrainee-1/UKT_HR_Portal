"""The Customise data sources, in the order the builder offers them."""

from __future__ import annotations

from .ds_days import ATTENDANCE_DAYS
from .ds_employees import EMPLOYEES
from .ds_payroll import PAYROLL
from .ds_punches import PUNCHES
from .ds_requests import REQUESTS
from .fields import Dataset

DATASETS: dict[str, Dataset] = {d.id: d for d in (EMPLOYEES, ATTENDANCE_DAYS, PUNCHES, REQUESTS, PAYROLL)}


def get_dataset(dataset_id: str | None) -> Dataset | None:
    return DATASETS.get((dataset_id or "").strip())
