"""MD portal -> Settlement (owner 2026-11-26): the Settlement Automation Method's MD step. Every view carries
@require_md (tests_md_identity walks the URL table). The rules are api/settlement_automation/service.py.

    GET   /api/md/settlement/month?month=&year=      the month's batches (decisions only while a batch is at MD Review)
    GET   /api/md/settlement/waiting                 the batches waiting for the MD
    PATCH /api/md/settlement/items/<id>              {decision: approved|rejected|"", amount?, remark?}
    POST  /api/md/settlement/batches/<id>/confirm    {note}   Confirm & Proceed -> back to HR (HR Final Settlement)
    POST  /api/md/settlement/batches/<id>/return     {note}   Return to HR for rework (changes / corrections, 2026-11-27)
"""

from django.urls import path
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from ...audit_utils import log_action
from ...auth import require_md
from ...clock import ist_today
from ...models import SettlementBatch, SettlementBatchItem
from ...settlement_automation import service
from ...settlement_automation.service import WorkflowError


def _md_name(request: Request) -> str:
    md = getattr(request, "md_user", None)
    name = (getattr(md, "full_name", "") or getattr(md, "username", "") or "MD") if md else "MD"
    return f"{name} (MD)"


def _refusal(exc: WorkflowError) -> Response:
    return Response({"error": exc.message, "code": exc.code, **exc.extra}, status=exc.status)


def _batch_reply(batch: SettlementBatch) -> Response:
    batch = service.batches_of(batch.month, batch.year).get(pk=batch.pk)
    return Response(service.batch_json(batch, viewer="md"))


@api_view(["GET"])
@require_md
def month(request: Request) -> Response:
    today = ist_today()
    try:
        m = int(request.query_params.get("month") or today.month)
        y = int(request.query_params.get("year") or today.year)
    except ValueError:
        return Response({"error": "Invalid month or year", "code": "invalid"}, status=400)
    if not 1 <= m <= 12 or not 2000 <= y <= 2100:
        return Response({"error": "Invalid month or year", "code": "invalid"}, status=400)
    try:
        advance_type = service.clean_type(request.query_params.get("type") or "general")
    except WorkflowError as exc:
        return _refusal(exc)
    data = service.month_json(m, y, viewer="md", advance_type=advance_type)
    # the MD sees only what HR forwarded: a batch still at HR Review is not theirs yet
    data["batches"] = [b for b in data["batches"] if b["stage"] != SettlementBatch.STAGE_HR_REVIEW]
    data["waitingForHr"] = SettlementBatch.objects.filter(
        month=m, year=y, advance_type=advance_type, stage=SettlementBatch.STAGE_HR_REVIEW
    ).exists()
    # how many requests of each type wait for the MD in this month (the type dropdown's counts)
    data["waitingByType"] = {
        t: sum(
            b.items.count()
            for b in SettlementBatch.objects.filter(
                month=m, year=y, advance_type=t, stage=SettlementBatch.STAGE_MD_REVIEW
            )
        )
        for t in service.TYPES
    }
    return Response(data)


@api_view(["GET"])
@require_md
def waiting(request: Request) -> Response:
    rows = SettlementBatch.objects.filter(stage=SettlementBatch.STAGE_MD_REVIEW).order_by("year", "month", "number")
    return Response(
        {
            "method": service.method(),
            "count": sum(b.items.count() for b in rows),
            # per type (owner 2026-11-27: Salary Advance and Term Loan are followed up independently)
            "byType": {t: sum(b.items.count() for b in rows if b.advance_type == t) for t in service.TYPES},
            "batches": [
                {
                    "id": b.id,
                    "advanceType": b.advance_type,
                    "typeLabel": service.TYPES.get(b.advance_type, "Advance"),
                    "month": b.month,
                    "year": b.year,
                    "number": b.number,
                    "requests": b.items.count(),
                    "forwardedAt": b.forwarded_at.isoformat() if b.forwarded_at else None,
                    "forwardedBy": b.forwarded_by or None,
                }
                for b in rows
            ],
        }
    )


@api_view(["PATCH"])
@require_md
def item(request: Request, pk: int) -> Response:
    row = SettlementBatchItem.objects.select_related("batch", "advance").filter(pk=pk).first()
    if row is None:
        return Response({"error": "Request not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    try:
        service.md_decide(row, data.get("decision"), data.get("amount"), data.get("remark"), _md_name(request))
    except WorkflowError as exc:
        return _refusal(exc)
    return _batch_reply(row.batch)


@api_view(["POST"])
@require_md
def bulk(request: Request, pk: int) -> Response:
    """POST /api/md/settlement/batches/<id>/bulk {itemIds, decision: approved|rejected, remark}: the MD on several requests."""
    batch = SettlementBatch.objects.filter(pk=pk).first()
    if batch is None:
        return Response({"error": "Batch not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    try:
        batch, skipped = service.md_bulk(
            batch, data.get("itemIds"), data.get("decision"), data.get("remark"), _md_name(request)
        )
    except WorkflowError as exc:
        return _refusal(exc)
    reply = service.batch_json(service.batches_of(batch.month, batch.year).get(pk=batch.pk), viewer="md")
    reply["skipped"] = skipped
    return Response(reply)


@api_view(["GET"])
@require_md
def leave_calendar(request: Request, pk: int) -> Response:
    """GET /api/md/settlement/items/<id>/leave-calendar: the Leave calendar of a request forwarded to the MD."""
    from ...advance_earnings import leave_calendar_json

    row = SettlementBatchItem.objects.select_related("batch", "advance__employee").filter(pk=pk).first()
    if row is None or row.batch.stage == SettlementBatch.STAGE_HR_REVIEW:
        return Response({"error": "Request not found", "code": "not_found"}, status=404)
    return Response(leave_calendar_json(row.advance))


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser, JSONParser])
@require_md
def confirm(request: Request, pk: int) -> Response:
    """POST /api/md/settlement/batches/<id>/confirm {note, mode: "hr" | "direct"}: Forward to HR (HR finalizes), or - mode
    direct (owner 2026-11-27) - the MD finalizes it and it goes straight to the auditor (multipart `pdf` + `xlsx`, the
    finalized report built by the page like HR's Send to Auditor). When that e-mail fails the settlement stays finalized
    at Send to Auditor and the reply's `warning` says why (HR can send it)."""
    from ...settlement_automation.views import XLSX, _upload

    batch = SettlementBatch.objects.filter(pk=pk).first()
    if batch is None:
        return Response({"error": "Batch not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    direct = str(data.get("mode") or "hr") == "direct"
    warning = None
    try:
        files = None
        if direct:
            files = (_upload(request, "pdf", (".pdf",), "application/pdf"), _upload(request, "xlsx", (".xlsx",), XLSX))
        batch = service.md_confirm(batch, data.get("note"), _md_name(request), direct=direct)
    except WorkflowError as exc:
        return _refusal(exc)
    if direct:
        try:
            batch = service.send_to_auditor(batch, files[0], files[1], request, _md_name(request))
        except WorkflowError as exc:
            warning = (
                f"The settlement is finalized, but it could not be sent to the auditor ({exc.message}). "
                "HR can send it from the Loan & Advance page."
            )
    log_action(
        request,
        "md_confirmed",
        "settlement",
        record_id=batch.pk,
        description=f"{service.TYPES.get(batch.advance_type, 'Advance')} {service._period(batch)} batch "
        f"{batch.number}: "
        + ("MD finalized it and sent it to the auditor" if direct else "MD confirmed and sent back to HR"),
    )
    reply = service.batch_json(service.batches_of(batch.month, batch.year).get(pk=batch.pk), viewer="md")
    reply["warning"] = warning
    return Response(reply)


@api_view(["POST"])
@require_md
def return_to_hr(request: Request, pk: int) -> Response:
    """POST /api/md/settlement/batches/<id>/return {note}: the MD changed amounts, rejected requests or asks for
    corrections - the settlement goes back to HR for rework; HR resubmits it for the MD's approval (owner 2026-11-27)."""
    batch = SettlementBatch.objects.filter(pk=pk).first()
    if batch is None:
        return Response({"error": "Batch not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    try:
        batch = service.md_return(batch, data.get("note"), _md_name(request))
    except WorkflowError as exc:
        return _refusal(exc)
    log_action(
        request,
        "md_returned",
        "settlement",
        record_id=batch.pk,
        description=f"{service.TYPES.get(batch.advance_type, 'Advance')} {service._period(batch)} batch "
        f"{batch.number}: MD returned it to HR for rework",
    )
    return _batch_reply(batch)


urlpatterns = [
    path("month", month),
    path("waiting", waiting),
    path("items/<int:pk>", item),
    path("batches/<int:pk>/confirm", confirm),
    path("batches/<int:pk>/return", return_to_hr),
    path("batches/<int:pk>/bulk", bulk),
    path("items/<int:pk>/leave-calendar", leave_calendar),
]
