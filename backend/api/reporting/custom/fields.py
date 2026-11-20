"""The building blocks of a Customise data source: typed fields grouped into sections, and the dataset itself.

A ``Dataset`` is one kind of row (an employee, an employee-day, a punch, a request, a payroll) with the Report Center
filters it understands and every field it can fill. The builder picks fields in order; ``Dataset.load(ctx, keys)`` then
returns rows keyed by those field keys and the runner keeps exactly the chosen columns (runner.normalise_rows drops
anything else), so a field that was not chosen is never sent.

Field keys are stable strings, "<group>.<name>" ("emp.code", "att.present_days", "pay.net"): saved reports keep them, so a
key is never renamed or reused for something else. ``needs`` names the loader group that fills a field, so a dataset only
does the work (and the queries) of the groups the chosen fields need.

Access: a field's ``modules`` are permission modules (permission_registry.MODULE_TREE keys); the user needs view on AT
LEAST ONE of them (the same rule as ReportSpec.modules). A field with no modules of its own is covered by the dataset's
``modules``, which the user always needs to use the dataset at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property
from typing import Any, Callable

from ..types import COLUMN_TYPES, NUMERIC_TYPES, ColumnSpec, FilterSpec


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: str
    section: str
    needs: str
    description: str | None = None
    modules: tuple[str, ...] = ()
    width: float = 1.0
    # "sum" | "avg" | "count" | None: the totals row (only for numbers that add up)
    total: str | None = None
    align: str | None = None

    def __post_init__(self):
        if self.type not in COLUMN_TYPES:
            raise ValueError(f"field {self.key!r}: unknown type {self.type!r}")
        if self.total and self.type not in NUMERIC_TYPES and self.total != "count":
            raise ValueError(f"field {self.key!r}: only numbers add up")

    def column(self) -> ColumnSpec:
        return ColumnSpec(self.key, self.label, self.type, self.width, total=self.total, align=self.align)

    def to_json(self) -> dict:
        out = {"key": self.key, "label": self.label, "type": self.type, "section": self.section}
        if self.description:
            out["description"] = self.description
        return out


@dataclass
class LoadResult:
    rows: list[dict]
    notes: list[str] = field(default_factory=list)
    # True when the loader stopped at the row ceiling it was given (the runner then reports "truncated")
    capped: bool = False


@dataclass(frozen=True)
class Dataset:
    id: str
    label: str
    description: str
    grain: str  # employee | day | punch | request | payroll
    filters: tuple[FilterSpec, ...]
    sections: tuple[tuple[str, str], ...]  # (section id, label), in display order
    fields: tuple[Field, ...]
    default_fields: tuple[str, ...]
    # (ctx, chosen field keys, row ceiling) -> LoadResult; rows in the dataset's natural order
    load: Callable[[Any, list[str], int], LoadResult]
    # Permission modules that own the data (any one of them opens the dataset)
    modules: tuple[str, ...]
    # Notes printed under every report built on it (the rules the figures follow)
    notes: tuple[str, ...] = ()

    def __post_init__(self):
        keys = [f.key for f in self.fields]
        if len(keys) != len(set(keys)):
            raise ValueError(f"dataset {self.id!r}: duplicate field keys")
        section_ids = {s for s, _label in self.sections}
        for f in self.fields:
            if f.section not in section_ids:
                raise ValueError(f"dataset {self.id!r}: field {f.key!r} is in an unknown section {f.section!r}")
        missing = [k for k in self.default_fields if k not in keys]
        if missing:
            raise ValueError(f"dataset {self.id!r}: unknown default fields {missing}")

    def field(self, key: str) -> Field | None:
        return self._by_key.get(key)

    @cached_property
    def _by_key(self) -> dict[str, Field]:
        return {f.key: f for f in self.fields}


def needs_of(dataset: Dataset, keys) -> set[str]:
    """The loader groups the chosen fields need."""
    return {f.needs for k in keys if (f := dataset.field(k)) is not None}
