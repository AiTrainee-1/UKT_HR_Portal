"""Saved Customise reports as ReportSpecs, so the Report Center's catalog, run and export endpoints serve them like any
other report (id ``custom-<pk>``, category ``customise``).

A saved report is the data source's ReportSpec built on the fly (build.build_spec): its columns are the saved fields the
viewer may see (a field whose data the role cannot view is dropped, with a note), its filters are the data source's with
the SAVED values as defaults (the catalog shows them, and a run that leaves a filter out uses it: build.SavedReportSpec;
a department / designation / unit / employee / employee type / select sent EMPTY means "all"), and its rows come from
the data source at run time. Every saved report is visible to everyone with view on Reports -> Customise (a team
library); the data in it is still scoped to the viewer's branch and modules.
"""

from __future__ import annotations

from ..access import OK, access_state, permission_level
from ..types import ReportSpec
from .build import CUSTOM_PREFIX, build_spec, field_open, saved_filters
from .datasets import get_dataset

__all__ = ["CUSTOM_PREFIX", "can_edit_customise", "can_view_customise", "saved_specs", "spec_for_saved", "spec_for"]


def can_view_customise(request) -> bool:
    """Whoever has view or edit on Reports -> Customise (super admin and the MD included)."""
    return permission_level(request, "reports.customise") in ("view", "edit")


def can_edit_customise(request) -> bool:
    """Edit on Reports -> Customise: create, change, duplicate (and delete one's own) saved reports. Never the MD."""
    return permission_level(request, "reports.customise") == "edit"


def spec_for(request, obj) -> ReportSpec | None:
    """The saved report ``obj`` (a SavedCustomReport) as a runnable spec for this viewer, or None when its data source
    no longer exists."""
    ds = get_dataset(obj.dataset)
    if ds is None:
        return None
    fields, dropped, unknown = [], [], 0
    for key in obj.fields or []:
        f = ds.field(key) if isinstance(key, str) else None
        if f is None:
            unknown += 1
        elif field_open(request, f):
            fields.append(f)
        else:
            dropped.append(f.label)
    keys = {f.key for f in fields}
    sort = [
        s for s in (obj.sort or []) if isinstance(s, dict) and s.get("key") in keys and s.get("dir") in ("asc", "desc")
    ]
    notes: list[str] = []
    if dropped:
        notes.append(
            f"Not shown, because your role does not have access to their data: {', '.join(dropped)}. The saved report "
            "keeps them for those who do."
        )
    if unknown:
        notes.append(f"{unknown} saved field(s) no longer exist in {ds.label} and are left out.")
    if not fields:
        notes.append("None of the saved fields can be shown to your role.")
    return build_spec(
        ds,
        fields,
        [{"key": s["key"], "dir": s["dir"]} for s in sort],
        report_id=f"{CUSTOM_PREFIX}{obj.pk}",
        title=obj.name,
        description=obj.description or f"Custom report on {ds.label}.",
        filters=saved_filters(ds, obj.filters if isinstance(obj.filters, dict) else {}),
        extra_notes=tuple(notes),
        saved=True,
    )


def saved_specs(request) -> list[ReportSpec]:
    """The saved Customise reports this user may open, as catalog entries (by name)."""
    if not can_view_customise(request):
        return []
    from api.models import SavedCustomReport

    out = []
    for obj in SavedCustomReport.objects.order_by("name", "id"):
        spec = spec_for(request, obj)
        if spec is not None and access_state(request, spec) == OK:
            out.append(spec)
    return out


def spec_for_saved(request, report_id: str) -> ReportSpec | None:
    """The saved report ``custom-<pk>`` as a runnable spec, or None (unknown / not allowed)."""
    raw = report_id[len(CUSTOM_PREFIX) :] if report_id.startswith(CUSTOM_PREFIX) else ""
    if not raw.isdigit() or len(raw) > 10 or not can_view_customise(request):
        return None
    from api.models import SavedCustomReport

    obj = SavedCustomReport.objects.filter(pk=int(raw)).first()
    return spec_for(request, obj) if obj is not None else None
