"""HTTP endpoints of Report Center -> Customise (the report builder). All JSON, all HR-only.

    GET    /api/reports/custom/datasets                 the data sources, their filters and the fields this user may use
    GET    /api/reports/custom/preview?dataset=..&fields=a,b&sort=a:asc&<filters>    the first 200 rows (run payload)
    GET    /api/reports/custom/saved                    the saved reports this role can open (the team library)
    POST   /api/reports/custom/saved                    save a new one                              -> item (201)
    GET    /api/reports/custom/saved/<id>               one saved report
    PUT    /api/reports/custom/saved/<id>               change it
    DELETE /api/reports/custom/saved/<id>               delete it (its creator or a super admin)
    POST   /api/reports/custom/saved/<id>/duplicate     a copy named "<name> (copy)"                -> item (201)

A saved report runs and exports through the ordinary endpoints as ``custom-<id>`` (reporting/views.py), which audit
exports like any report. Permission: Reports -> Customise (permission_tree.py maps the reports/custom/ prefix to it, so
the middleware already lets a view-only role through for GET only); view = list / open / preview, edit = create, change,
duplicate and delete. Branch isolation is applied when the rows are read (ReportContext.emp_q).
"""

from __future__ import annotations

import logging

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.audit_utils import log_action
from api.auth import require_hr
from api.branch_scope import get_branch_scope
from api.clock import ist_today

from ..access import _hr_user, hr_display_name, is_super_admin
from ..filters import ReportParamError
from ..formatting import fmt_dt
from ..runner import run_report
from .build import (
    CUSTOM_PREFIX,
    CustomError,
    check_fields,
    dataset_json,
    dataset_open,
    field_open,
    normalise_filters,
    parse_fields,
    parse_sort,
    preview_spec,
)
from .datasets import DATASETS, get_dataset
from .specs import can_edit_customise, can_view_customise

logger = logging.getLogger(__name__)

MAX_NAME = 120
MAX_DESCRIPTION = 2000


def _error(message: str, status: int, code: str, field: str | None = None) -> Response:
    body = {"error": code, "message": message}
    if field:
        body["field"] = field
    return Response(body, status=status)


def _refused(e: CustomError) -> Response:
    return _error(e.message, e.status, e.code, e.field)


def _no_view() -> Response:
    return _error("Your role does not have access to custom reports.", 403, "permission_denied")


def _no_edit() -> Response:
    return _error("Your role can open custom reports but not create or change them.", 403, "permission_denied")


def _dataset_or_error(request, dataset_id) -> tuple:
    ds = get_dataset(dataset_id if isinstance(dataset_id, str) else None)
    if ds is None:
        return None, _error("Choose a data source.", 400, "unknown_dataset", "dataset")
    if not dataset_open(request, ds):
        return None, _error(
            "Your role does not have access to the data of this data source.", 403, "dataset_forbidden", "dataset"
        )
    return ds, None


# ── data sources and preview ────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def custom_datasets(request):
    if not can_view_customise(request):
        return _no_view()
    today = ist_today()
    branch_scoped = get_branch_scope(request) is not None
    return Response(
        {
            "datasets": [
                dataset_json(request, ds, today, branch_scoped) for ds in DATASETS.values() if dataset_open(request, ds)
            ],
            "canEdit": can_edit_customise(request),
        }
    )


@api_view(["GET"])
@require_hr
def custom_preview(request):
    if not can_view_customise(request):
        return _no_view()
    q = request.query_params
    ds, err = _dataset_or_error(request, q.get("dataset"))
    if err is not None:
        return err
    try:
        keys = parse_fields(q.get("fields") or "")
        fields = check_fields(request, ds, keys)
        sort = parse_sort(q.get("sort") or "", keys)
        out = run_report(request, preview_spec(ds, fields, sort), q, purpose="screen")
    except CustomError as e:
        return _refused(e)
    except ReportParamError as e:
        return _error(e.message, 400, "invalid_filter", e.field)
    except Exception:
        logger.exception("custom report preview (%s) failed", ds.id)
        return _error("The preview could not be generated. Please try again or contact support.", 500, "report_failed")
    return Response(out.payload())


# ── saved reports ───────────────────────────────────────────────────────────


def _item(request, obj, user=None) -> dict:
    ds = get_dataset(obj.dataset)
    user = user if user is not None else _hr_user(request)
    edit = can_edit_customise(request)
    mine = user is not None and obj.created_by_id == user.id
    # the saved fields that still exist; those this viewer may not see are counted, not listed
    fields = [k for k in obj.fields or [] if isinstance(k, str) and ds is not None and ds.field(k) is not None]
    hidden = [k for k in fields if not field_open(request, ds.field(k))]
    return {
        "id": obj.pk,
        "reportId": f"{CUSTOM_PREFIX}{obj.pk}",
        "name": obj.name,
        "description": obj.description,
        "dataset": obj.dataset,
        "datasetLabel": ds.label if ds is not None else obj.dataset,
        "fields": [k for k in fields if k not in hidden],
        # saved fields this viewer may not see: kept on the report (a change by this viewer keeps them too)
        "hiddenFields": len(hidden),
        "filters": obj.filters or {},
        "sort": obj.sort or [],
        "createdBy": obj.created_by_name or None,
        "createdById": obj.created_by_id,
        "createdAt": fmt_dt(obj.created_at),
        "updatedBy": obj.updated_by_name or None,
        "updatedAt": fmt_dt(obj.updated_at),
        "canEdit": edit,
        "canDelete": edit and (mine or is_super_admin(request)),
    }


def _validated(request, body, current=None) -> dict:
    """The cleaned values of a create (current None) or a change (only the keys sent; the rest stay)."""
    if not isinstance(body, dict):
        raise CustomError("invalid_request", "Send the report as a JSON object.")
    out: dict = {}
    if current is None or "name" in body:
        name = body.get("name")
        name = " ".join(name.split()) if isinstance(name, str) else ""
        if not name:
            raise CustomError("invalid_name", "Give the report a name.", "name")
        if len(name) > MAX_NAME:
            raise CustomError("invalid_name", f"The name can have at most {MAX_NAME} characters.", "name")
        out["name"] = name
    if current is None or "description" in body:
        desc = body.get("description") or ""
        if not isinstance(desc, str):
            raise CustomError("invalid_description", "The description must be text.", "description")
        desc = desc.replace("\x00", "").strip()
        if len(desc) > MAX_DESCRIPTION:
            raise CustomError(
                "invalid_description", f"The description can have at most {MAX_DESCRIPTION} characters.", "description"
            )
        out["description"] = desc
    dataset_id = body.get("dataset") if (current is None or "dataset" in body) else current.dataset
    ds = get_dataset(dataset_id if isinstance(dataset_id, str) else None)
    if ds is None:
        raise CustomError("unknown_dataset", "Choose a data source.", "dataset")
    if not dataset_open(request, ds):
        raise CustomError(
            "dataset_forbidden", "Your role does not have access to the data of this data source.", "dataset", 403
        )
    changed_source = current is not None and ds.id != current.dataset
    out["dataset"] = ds.id
    if current is None or "fields" in body or changed_source:
        keys = parse_fields(body.get("fields"))
        check_fields(request, ds, keys)
        if current is not None and not changed_source:
            keys = _keep_hidden(request, ds, current.fields or [], keys)
        out["fields"] = keys
    keys = out.get("fields", current.fields if current is not None else [])
    if current is None or "filters" in body or changed_source:
        try:
            out["filters"] = normalise_filters(ds, body.get("filters"))
        except ReportParamError as e:
            raise CustomError("invalid_filter", e.message, e.field) from None
    if current is None or "sort" in body or "fields" in out:
        raw_sort = body.get("sort") if "sort" in body else (current.sort if current is not None else [])
        if "sort" not in body and current is not None:
            # a change of fields keeps the sort of the fields still there
            raw_sort = [s for s in (raw_sort or []) if isinstance(s, dict) and s.get("key") in keys]
        out["sort"] = parse_sort(raw_sort, keys)
    return out


def _keep_hidden(request, ds, before: list, keys: list[str]) -> list[str]:
    """A change by someone who cannot see some of the saved fields keeps those fields at their places (they were not on
    that person's screen, so leaving them out is not a removal)."""
    hidden = [(i, k) for i, k in enumerate(before) if (f := ds.field(k)) is not None and not field_open(request, f)]
    out = list(keys)
    for i, k in hidden:
        if k not in out:
            out.insert(min(i, len(out)), k)
    return out


def _actor(request) -> tuple:
    user = _hr_user(request)
    return user, (hr_display_name(request) if user is not None else "HR")


@api_view(["GET", "POST"])
@require_hr
def custom_saved(request):
    from api.models import SavedCustomReport

    if not can_view_customise(request):
        return _no_view()
    if request.method == "GET":
        user = _hr_user(request)
        # the reports this role can open (the catalog lists the same ones): one on a data source the role cannot use,
        # or on one that no longer exists, would only lead to "not available"
        items = [
            _item(request, obj, user)
            for obj in SavedCustomReport.objects.order_by("name", "id")
            if (ds := get_dataset(obj.dataset)) is not None and dataset_open(request, ds)
        ]
        return Response({"items": items, "canEdit": can_edit_customise(request)})
    if not can_edit_customise(request):
        return _no_edit()
    try:
        values = _validated(request, request.data)
    except CustomError as e:
        return _refused(e)
    user, name = _actor(request)
    obj = SavedCustomReport.objects.create(
        **values, created_by=user, updated_by=user, created_by_name=name, updated_by_name=name
    )
    log_action(
        request,
        "create",
        "reports",
        record_id=obj.pk,
        description=f"Custom report '{obj.name}' saved ({obj.dataset}, {len(obj.fields)} fields)"[:480],
    )
    return Response(_item(request, obj, user), status=201)


@api_view(["GET", "PUT", "PATCH", "DELETE"])
@require_hr
def custom_saved_detail(request, pk: int):
    from api.models import SavedCustomReport

    if not can_view_customise(request):
        return _no_view()
    obj = SavedCustomReport.objects.filter(pk=pk).first()
    if obj is None:
        return _error("Report not found", 404, "not_found")
    if request.method == "GET":
        return Response(_item(request, obj))
    if not can_edit_customise(request):
        return _no_edit()
    user, name = _actor(request)
    if request.method == "DELETE":
        if not (is_super_admin(request) or (user is not None and obj.created_by_id == user.id)):
            return _error(
                "Only the person who made this report or a super admin can delete it.", 403, "permission_denied"
            )
        label = obj.name
        obj.delete()
        log_action(request, "delete", "reports", record_id=pk, description=f"Custom report '{label}' deleted"[:480])
        return Response(status=204)
    try:
        values = _validated(request, request.data, current=obj)
    except CustomError as e:
        return _refused(e)
    before = {
        "name": obj.name,
        "description": obj.description,
        "dataset": obj.dataset,
        "fields": list(obj.fields or []),
    }
    changed = [k for k, v in values.items() if getattr(obj, k) != v]
    with transaction.atomic():
        for k, v in values.items():
            setattr(obj, k, v)
        obj.updated_by, obj.updated_by_name = user, name
        obj.save()
    log_action(
        request,
        "update",
        "reports",
        record_id=obj.pk,
        description=f"Custom report '{obj.name}' changed: {', '.join(changed) or 'saved unchanged'}"[:480],
        old_values={k: before[k] for k in ("name", "description") if k in changed},
        new_values={k: values[k] for k in ("name", "description") if k in changed},
    )
    return Response(_item(request, obj, user))


@api_view(["POST"])
@require_hr
def custom_saved_duplicate(request, pk: int):
    from api.models import SavedCustomReport

    if not can_view_customise(request):
        return _no_view()
    if not can_edit_customise(request):
        return _no_edit()
    src = SavedCustomReport.objects.filter(pk=pk).first()
    if src is None:
        return _error("Report not found", 404, "not_found")
    _ds, err = _dataset_or_error(request, src.dataset)  # a copy nobody in this role could open is refused
    if err is not None:
        return err
    user, name = _actor(request)
    suffix = " (copy)"
    copy = SavedCustomReport.objects.create(
        name=src.name[: MAX_NAME - len(suffix)] + suffix,
        description=src.description,
        dataset=src.dataset,
        fields=list(src.fields or []),
        filters=dict(src.filters or {}),
        sort=list(src.sort or []),
        created_by=user,
        updated_by=user,
        created_by_name=name,
        updated_by_name=name,
    )
    log_action(
        request,
        "create",
        "reports",
        record_id=copy.pk,
        description=f"Custom report '{copy.name}' made as a copy of '{src.name}'"[:480],
    )
    return Response(_item(request, copy, user), status=201)
