"""HTTP side of the Settlement Automation Method (service.py has the rules).

HRMS (module `settlement`; GET = view, the rest = edit; Finalize also needs the approval rights of Salary advances /
Term loans). Company-wide accounts only act: a branch-scoped login sees its branch's requests and cannot move a batch.

    GET   /api/settlement-automation/method                         {method} (what the Settlement page shows)
    GET   /api/settlement-automation/month?month=&year=             the month: batches with requests, tracker, numbers
    PATCH /api/settlement-automation/items/<id>                     {hrNote}                       (HR Review)
    POST  /api/settlement-automation/batches/<id>/forward           {advanceIds, note}             -> MD Review
    PATCH /api/settlement-automation/items/<id>/final               {decision, amount, startMonth, startYear, remark}
    POST  /api/settlement-automation/batches/<id>/finalize          {note}                         -> Send to Auditor
    POST  /api/settlement-automation/batches/<id>/send-auditor      multipart pdf + xlsx           -> Auditor Review
    POST  /api/settlement-automation/batches/<id>/auditor-done      {note}                         -> Send to Accounts
    POST  /api/settlement-automation/items/<id>/rework              Rework: reopen a request HR decided (2026-11-27)
    POST  /api/settlement-automation/items/<id>/resolve             {how: accept|keep}  HR's answer to the MD / auditor
    POST  /api/settlement-automation/batches/<id>/resolve-bulk      {itemIds, how}
    POST  /api/settlement-automation/batches/<id>/resubmit-md       {note}   HR Rework (MD Changes) -> MD Review again
    POST  /api/settlement-automation/batches/<id>/resubmit-auditor  {note}   HR Rework (Auditor Changes) -> Send to Auditor
    POST  /api/settlement-automation/batches/<id>/send-accounts     multipart bank                 -> Completed
    POST  /api/settlement-automation/batches/<id>/complete          {note}   (nothing approved: no bank file)
    GET   /api/settlement-automation/files/<id>                     download a file the workflow sent

Settings -> Settlement (module `settings.settlement`):
    GET/PUT /api/settlement-settings   {method, auditorEmails, auditorCc, accountsEmails, accountsCc}

MD portal (@require_md, api/md_portal/routes/settlement.py):
    GET   /api/md/settlement/month?month=&year=      the month's batches (read-only except a batch at MD Review)
    GET   /api/md/settlement/waiting                 the batches waiting for the MD (sidebar badge, landing month)
    PATCH /api/md/settlement/items/<id>              {decision: approved|rejected|"", amount?, remark?}
    POST  /api/md/settlement/batches/<id>/confirm    {note}                           -> HR Final Settlement
    POST  /api/md/settlement/batches/<id>/return     {note}   changes / corrections -> HR Rework (MD Changes)
"""

from __future__ import annotations

from django.http import HttpResponse
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import get_hr_display_name, require_hr
from ..branch_scope import get_branch_scope
from ..clock import ist_today
from ..models import SettlementBatch, SettlementBatchFile, SettlementBatchItem, SettlementSettings
from . import service
from .service import WorkflowError

SETTINGS_KEY = "settings.settlement"


def _refusal(exc: WorkflowError) -> Response:
    return Response({"error": exc.message, "code": exc.code, **exc.extra}, status=exc.status)


def _month_params(request: Request) -> tuple[int, int] | Response:
    today = ist_today()
    try:
        month = int(request.query_params.get("month") or today.month)
        year = int(request.query_params.get("year") or today.year)
    except ValueError:
        return Response({"error": "Invalid month or year", "code": "invalid"}, status=400)
    if not 1 <= month <= 12 or not 2000 <= year <= 2100:
        return Response({"error": "Invalid month or year", "code": "invalid"}, status=400)
    return month, year


def _company_wide(request: Request) -> Response | None:
    if get_branch_scope(request) is not None:
        return Response(
            {
                "error": "The settlement workflow is company-wide: a branch login can look but not move it.",
                "code": "branch_scope",
            },
            status=403,
        )
    return None


def _automation_on() -> Response | None:
    if not service.is_automation():
        return Response(
            {
                "error": "Settlement runs the Normal Method. Switch on the Automation Method in Settings -> Settlement.",
                "code": "normal_method",
            },
            status=409,
        )
    return None


def _batch(pk: int) -> SettlementBatch | None:
    return SettlementBatch.objects.filter(pk=pk).first()


def _batch_reply(batch: SettlementBatch) -> Response:
    batch = service.batches_of(batch.month, batch.year).get(pk=batch.pk)
    return Response(service.batch_json(batch, viewer="hr"))


def _scoped_month(data: dict, request: Request) -> dict:
    """A branch-scoped login sees only its branch's requests."""
    branch_id = get_branch_scope(request)
    if branch_id is None:
        return data
    for b in data["batches"]:
        b["items"] = [i for i in b["items"] if i["advance"].get("employeeBranchId") == branch_id]
        b["counts"], b["amounts"] = _figures(b["items"])  # the numbers of what this login sees
    data["received"] = sum(len(b["items"]) for b in data["batches"])
    data["branchScoped"] = True
    return data


def _figures(items: list[dict]) -> tuple[dict, dict]:
    """A batch's counts and amounts from its (branch-filtered) item JSON, the same way service.batch_json counts them."""

    def outcome(i):
        return i["final"]["decision"] or i["md"]["decision"]

    approved = [i for i in items if outcome(i) == "approved"]
    rejected = [i for i in items if outcome(i) == "rejected"]
    flags = [(i["advance"].get("leaveCheck") or {}).get("flag") for i in items]
    counts = {
        "total": len(items),
        "mdDecided": sum(1 for i in items if i["md"]["decision"]),
        "approved": len(approved),
        "rejected": len(rejected),
        "undecided": len(items) - len(approved) - len(rejected),
        "warning": flags.count("warning"),
        "critical": flags.count("critical"),
    }
    final = float(sum(i["final"]["amount"] or 0 for i in items if i["final"]["decision"] == "approved"))
    finalized = any(i["final"]["decision"] for i in items)
    amounts = {
        "requested": float(sum(i["requestedAmount"] for i in items)),
        # the "as asked" total after the Salary Advance rounding (as service.batch_json)
        "rounded": float(sum(i.get("baseAmount", i["requestedAmount"]) for i in items)),
        "mdApproved": float(sum(i["md"]["amount"] or 0 for i in items)),
        "finalApproved": final,
        # what will be paid: the effective settlement once finalized (the auditor's changes included)
        "payable": float(
            sum(
                (i.get("effective") or {}).get("amount") or 0
                for i in items
                if (i.get("effective") or {}).get("decision") == "approved"
            )
        )
        if finalized
        else final,
    }
    return counts, amounts


@api_view(["GET"])
@require_hr
def method_view(request: Request) -> Response:
    return Response({"method": service.method()})


@api_view(["GET"])
@require_hr
def month_view(request: Request) -> Response:
    parsed = _month_params(request)
    if isinstance(parsed, Response):
        return parsed
    month, year = parsed
    try:
        advance_type = service.clean_type(request.query_params.get("type") or "general")
    except WorkflowError as exc:
        return _refusal(exc)
    if service.is_automation():
        service.sync_month(month, year, advance_type)
    data = service.month_json(month, year, viewer="hr", advance_type=advance_type)
    data["branchScoped"] = False
    row = service.settings_row()
    data["recipients"] = {
        "auditor": list(row.auditor_emails or []),
        "auditorCc": list(row.auditor_cc or []),
        "accounts": list(row.accounts_emails or []),
        "accountsCc": list(row.accounts_cc or []),
    }
    return Response(_scoped_month(data, request))


@api_view(["GET"])
@require_hr
def overview_view(request: Request) -> Response:
    """GET /api/settlement-automation/overview?month=&year= - the Loan & Advance main page: both types side by side."""
    parsed = _month_params(request)
    if isinstance(parsed, Response):
        return parsed
    month, year = parsed
    if service.is_automation():
        service.sync_month(month, year)
    data = service.overview_json(month, year)
    if get_branch_scope(request) is not None:
        # a branch login: each type's numbers from its branch's requests only (as on the type pages)
        for entry in data["types"]:
            scoped = _scoped_month(
                service.month_json(month, year, viewer="hr", advance_type=entry["advanceType"]), request
            )
            entry["received"] = scoped["received"]
            current = entry.get("currentBatch")
            if current is not None:
                mine = next((b for b in scoped["batches"] if b["id"] == current["id"]), None)
                if mine is not None:
                    current["counts"], current["amounts"] = mine["counts"], mine["amounts"]
        data["branchScoped"] = True
    return Response(data)


def _act(request: Request, pk: int, fn, audit: str):
    if (refused := _automation_on()) or (refused := _company_wide(request)):
        return refused
    batch = _batch(pk)
    if batch is None:
        return Response({"error": "Batch not found", "code": "not_found"}, status=404)
    by = get_hr_display_name(request)
    try:
        batch = fn(batch, by)
    except WorkflowError as exc:
        return _refusal(exc)
    log_action(
        request,
        audit,
        "settlement",
        record_id=batch.pk,
        description=f"{service.TYPES.get(batch.advance_type, 'Advance')} {service._period(batch)} batch "
        f"{batch.number}: {audit.replace('_', ' ')}",
    )
    return _batch_reply(batch)


@api_view(["PATCH"])
@require_hr
def item_view(request: Request, pk: int) -> Response:
    if (refused := _automation_on()) or (refused := _company_wide(request)):
        return refused
    item = SettlementBatchItem.objects.select_related("batch", "advance").filter(pk=pk).first()
    if item is None:
        return Response({"error": "Request not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    try:
        # {hrNote} alone (a remark) or with HR's proposal {action: ""|reduce|reject, amount} (2026-11-27)
        service.set_hr_review(item, data)
    except WorkflowError as exc:
        return _refusal(exc)
    return _batch_reply(item.batch)


def _bulk(request: Request, pk: int, fn, audit: str):
    """A bulk step: the batch reply plus `skipped` [{id, reason}] for requests left out."""
    if (refused := _automation_on()) or (refused := _company_wide(request)):
        return refused
    batch = _batch(pk)
    if batch is None:
        return Response({"error": "Batch not found", "code": "not_found"}, status=404)
    data = request.data if hasattr(request.data, "get") else {}
    try:
        batch, skipped = fn(batch, data, get_hr_display_name(request))
    except WorkflowError as exc:
        return _refusal(exc)
    log_action(
        request,
        audit,
        "settlement",
        record_id=batch.pk,
        description=f"{service.TYPES.get(batch.advance_type, 'Advance')} {service._period(batch)} batch {batch.number}: "
        f"{audit.replace('_', ' ')} ({len(data.get('itemIds') or [])} requests)",
    )
    reply = service.batch_json(service.batches_of(batch.month, batch.year).get(pk=batch.pk), viewer="hr")
    reply["skipped"] = skipped
    return Response(reply)


@api_view(["POST"])
@require_hr
def hr_review_bulk_view(request: Request, pk: int) -> Response:
    """POST .../batches/<id>/hr-review-bulk {itemIds, action: approve|reject, remark}"""
    return _bulk(
        request,
        pk,
        lambda b, d, by: service.hr_review_bulk(b, d.get("itemIds"), d.get("action"), d.get("remark")),
        "hr_review_bulk",
    )


@api_view(["POST"])
@require_hr
def final_bulk_view(request: Request, pk: int) -> Response:
    """POST .../batches/<id>/final-bulk {itemIds, decision: approved|rejected, remark}"""
    return _bulk(
        request,
        pk,
        lambda b, d, by: service.final_bulk(b, d.get("itemIds"), d.get("decision"), d.get("remark"), by),
        "final_bulk",
    )


@api_view(["PATCH"])
@require_hr
def item_final_view(request: Request, pk: int) -> Response:
    if (refused := _automation_on()) or (refused := _company_wide(request)):
        return refused
    item = SettlementBatchItem.objects.select_related("batch", "advance").filter(pk=pk).first()
    if item is None:
        return Response({"error": "Request not found", "code": "not_found"}, status=404)
    try:
        service.set_final(item, request.data, get_hr_display_name(request))
    except WorkflowError as exc:
        return _refusal(exc)
    return _batch_reply(item.batch)


@api_view(["POST"])
@require_hr
def forward_view(request: Request, pk: int) -> Response:
    ids = request.data.get("advanceIds")
    return _act(request, pk, lambda b, by: service.forward(b, ids, request.data.get("note"), by), "forwarded_to_md")


@api_view(["POST"])
@require_hr
def finalize_view(request: Request, pk: int) -> Response:
    return _act(
        request, pk, lambda b, by: service.finalize(b, request.data.get("note"), request, by), "finalized_settlement"
    )


def _upload(request: Request, field: str, allowed: tuple[str, ...], mime: str) -> tuple[str, bytes, str]:
    f = request.FILES.get(field)
    if f is None:
        raise WorkflowError(f"The {field} file is missing.", "file", field=field)
    name = str(f.name or field)
    if not name.lower().endswith(allowed):
        raise WorkflowError(f"The {field} file must be {' or '.join(allowed)}.", "file", field=field)
    if f.size > service.MAX_FILE_BYTES:
        raise WorkflowError(f"The {field} file is too large.", "file", field=field)
    return name, f.read(), mime


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser, JSONParser])
@require_hr
def send_auditor_view(request: Request, pk: int) -> Response:
    def run(b, by):
        pdf = _upload(request, "pdf", (".pdf",), "application/pdf")
        xlsx = _upload(request, "xlsx", (".xlsx",), XLSX)
        return service.send_to_auditor(b, pdf, xlsx, request, by)

    return _act(request, pk, run, "sent_to_auditor")


@api_view(["POST"])
@require_hr
def auditor_done_view(request: Request, pk: int) -> Response:
    return _act(
        request, pk, lambda b, by: service.auditor_done(b, request.data.get("note"), request, by), "auditor_review_done"
    )


@api_view(["POST"])
@require_hr
def resubmit_md_view(request: Request, pk: int) -> Response:
    """POST .../batches/<id>/resubmit-md {note}: HR answered every request the MD changed -> the MD reviews it again."""
    return _act(request, pk, lambda b, by: service.resubmit_md(b, request.data.get("note"), by), "resubmitted_to_md")


@api_view(["POST"])
@require_hr
def resubmit_auditor_view(request: Request, pk: int) -> Response:
    """POST .../batches/<id>/resubmit-auditor {note}: HR answered every request the auditor changed -> Send to Auditor
    (the revised settlement and a new review link go out next)."""
    return _act(
        request,
        pk,
        lambda b, by: service.resubmit_auditor(b, request.data.get("note"), request, by),
        "resubmitted_to_auditor",
    )


def _item_step(request: Request, pk: int, fn) -> Response:
    if (refused := _automation_on()) or (refused := _company_wide(request)):
        return refused
    item = SettlementBatchItem.objects.select_related("batch", "advance").filter(pk=pk).first()
    if item is None:
        return Response({"error": "Request not found", "code": "not_found"}, status=404)
    try:
        fn(item, get_hr_display_name(request))
    except WorkflowError as exc:
        return _refusal(exc)
    return _batch_reply(item.batch)


@api_view(["POST"])
@require_hr
def item_rework_view(request: Request, pk: int) -> Response:
    """POST .../items/<id>/rework: reopen a request HR decided (it waits again, at the top of the list)."""
    return _item_step(request, pk, lambda item, by: service.rework_item(item, by))


@api_view(["POST"])
@require_hr
def item_resolve_view(request: Request, pk: int) -> Response:
    """POST .../items/<id>/resolve {how: accept|keep}: HR's answer to the MD's / auditor's change on one request."""
    data = request.data if hasattr(request.data, "get") else {}
    return _item_step(request, pk, lambda item, by: service.resolve_item(item, data.get("how"), by))


@api_view(["POST"])
@require_hr
def resolve_bulk_view(request: Request, pk: int) -> Response:
    """POST .../batches/<id>/resolve-bulk {itemIds, how: accept|keep}"""
    return _bulk(
        request,
        pk,
        lambda b, d, by: service.resolve_bulk(b, d.get("itemIds"), d.get("how"), by),
        "rework_answered",
    )


# ─────────────────────────── the Auditor Review Portal (public: the e-mailed link is the key) ───────────────────────────
# No HRMS login (owner 2026-11-27): the token in the address is a secret e-mailed only to the auditor addresses of
# Settings, stored as a SHA-256, expiring (Settings -> Loan & Advance, 1-30 days), revoked by a newer send or by HR's
# manual confirmation, read-only once answered. Every answer refers to this one settlement only.


def _public(fn):
    def run(*args, **kwargs):
        try:
            response = fn(*args, **kwargs)
        except WorkflowError as exc:
            response = _refusal(exc)
        response["Cache-Control"] = "no-store"
        response["X-Robots-Tag"] = "noindex, nofollow"
        response["Referrer-Policy"] = "no-referrer"
        return response

    run.__name__ = fn.__name__
    run.__doc__ = fn.__doc__
    return run


@api_view(["GET"])
@_public
def auditor_portal_view(request: Request, token: str) -> Response:
    """GET /api/auditor-review/<token>: the settlement as the auditor reviews it (service.portal_json)."""
    link = service.link_for(token, touch=True)
    return Response(service.portal_json(link, link.batch))


@api_view(["GET"])
@_public
def auditor_timecard_view(request: Request, token: str, item_id: int) -> Response:
    """GET /api/auditor-review/<token>/timecard/<item id>: one employee's attendance time card for the month."""
    link = service.link_for(token)
    return Response(service.timecard_json(link, item_id))


@api_view(["POST"])
@_public
def auditor_bulk_view(request: Request, token: str) -> Response:
    """POST /api/auditor-review/<token>/bulk {itemIds, action: approve|reject, remark}."""
    link = service.link_for(token)
    data = request.data if hasattr(request.data, "get") else {}
    batch = service.auditor_bulk(link, data.get("itemIds"), data.get("action"), data.get("remark"))
    return Response(service.portal_json(link, batch))


@api_view(["GET"])
@_public
def auditor_leave_view(request: Request, token: str, item_id: int) -> Response:
    """GET /api/auditor-review/<token>/leave/<item id>: the Leave calendar of a request of this settlement."""
    from ..advance_earnings import leave_calendar_json
    from ..models import SettlementBatchItem

    link = service.link_for(token)
    item = (
        SettlementBatchItem.objects.select_related("advance__employee")
        .filter(pk=item_id, batch_id=link.batch_id)
        .first()
    )
    if item is None:
        raise WorkflowError("Request not found in this settlement.", "not_found", 404)
    return Response(leave_calendar_json(item.advance))


@api_view(["PATCH"])
@_public
def auditor_item_view(request: Request, token: str, item_id: int) -> Response:
    """PATCH /api/auditor-review/<token>/items/<item id> {action: ""|reduce|reject, amount?, remark?}."""
    link = service.link_for(token)
    data = request.data if hasattr(request.data, "get") else {}
    batch = service.auditor_change(link, item_id, data)
    return Response(service.portal_json(link, batch))


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser, JSONParser])
@_public
def auditor_submit_view(request: Request, token: str) -> Response:
    """POST /api/auditor-review/<token>/submit {decision, note} (+ multipart `bank` for approved_send_accounts)."""
    link = service.link_for(token)
    decision = str(request.data.get("decision") or "")
    bank = _upload(request, "bank", (".xlsx",), XLSX) if decision == "approved_send_accounts" else None
    batch, warning = service.auditor_submit(link, decision, request.data.get("note"), bank, request)
    link.refresh_from_db()
    body = service.portal_json(link, batch)
    body["warning"] = warning
    return Response(body)


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser, JSONParser])
@require_hr
def send_accounts_view(request: Request, pk: int) -> Response:
    def run(b, by):
        bank = _upload(request, "bank", (".xlsx",), XLSX)
        return service.send_to_accounts(b, bank, request, by)

    return _act(request, pk, run, "sent_to_accounts")


@api_view(["POST"])
@require_hr
def complete_view(request: Request, pk: int) -> Response:
    return _act(
        request, pk, lambda b, by: service.complete_without_bank_file(b, request.data.get("note"), by), "completed"
    )


@api_view(["GET"])
@require_hr
def file_view(request: Request, pk: int):
    f = SettlementBatchFile.objects.filter(pk=pk).first()
    if f is None:
        return Response({"error": "File not found", "code": "not_found"}, status=404)
    response = HttpResponse(bytes(f.content), content_type=f.content_type)
    response["Content-Disposition"] = f'attachment; filename="{f.filename}"'
    return response


# ─────────────────────────── Settings -> Settlement ───────────────────────────


def _may_edit_settings(request: Request) -> bool:
    from ..models import HRUser
    from ..permission_registry import effective_permissions, resolve_permission

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr), SETTINGS_KEY) == "edit"


def settings_json(request: Request) -> dict:
    from .. import advance_rules

    row = service.settings_row()
    rules = advance_rules.rules()
    busy = list(service.in_progress_batches())
    return {
        "method": row.method,
        "methods": [{"key": k, "label": label} for k, label in SettlementSettings.METHODS],
        "auditorEmails": list(row.auditor_emails or []),
        "auditorCc": list(row.auditor_cc or []),
        "accountsEmails": list(row.accounts_emails or []),
        "accountsCc": list(row.accounts_cc or []),
        # how many days the auditor's review link works (2026-11-27)
        "auditorLinkDays": row.auditor_link_days,
        "auditorLinkDaysLimits": {"min": service.LINK_DAYS_MIN, "max": service.LINK_DAYS_MAX, "default": 7},
        # the Salary Advance and Term Loan rules (owner 2026-11-27: set here, not in code; advance_rules.py)
        "salaryAdvanceRules": rules.sa_json(),
        "termLoanRules": rules.tl_json(),
        "ruleLimits": {k: {"min": lo, "max": hi} for k, (lo, hi) in advance_rules.LIMITS.items()},
        "ruleDefaults": {"salaryAdvance": advance_rules.DEFAULT.sa_json(), "termLoan": advance_rules.DEFAULT.tl_json()},
        "updatedBy": row.updated_by or None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        "canChange": _may_edit_settings(request) and get_branch_scope(request) is None,
        # batches between Forward and Completed: the Normal Method cannot be switched on while there are any
        "inProgress": [
            {
                "id": b.id,
                "month": b.month,
                "year": b.year,
                "number": b.number,
                "advanceType": b.advance_type,
                "typeLabel": service.TYPES.get(b.advance_type, "Advance"),
                "stage": b.stage,
                "stageLabel": b.get_stage_display(),
            }
            for b in busy
        ],
    }


@api_view(["GET", "PUT"])
@require_hr
def settings_view(request: Request) -> Response:
    if request.method == "GET":
        return Response(settings_json(request))
    if not _may_edit_settings(request):
        return Response({"error": "You may only view these settings.", "code": "permission_denied"}, status=403)
    if (refused := _company_wide(request)) is not None:
        return refused
    data = request.data if hasattr(request.data, "get") else {}
    row = service.settings_row()
    try:
        fields = {}
        for key, attr in (
            ("auditorEmails", "auditor_emails"),
            ("auditorCc", "auditor_cc"),
            ("accountsEmails", "accounts_emails"),
            ("accountsCc", "accounts_cc"),
        ):
            if key in data:
                fields[attr] = service.clean_emails(data.get(key), key)
        if "auditorLinkDays" in data:
            try:
                days = int(str(data.get("auditorLinkDays")).strip())
            except ValueError:
                days = 0
            if not service.LINK_DAYS_MIN <= days <= service.LINK_DAYS_MAX:
                raise WorkflowError(
                    f"The review link must work {service.LINK_DAYS_MIN} to {service.LINK_DAYS_MAX} days.",
                    "link_days",
                    field="auditorLinkDays",
                )
            fields["auditor_link_days"] = days
        from .. import advance_rules

        fields.update(advance_rules.clean(data, advance_rules.rules()))
        new_method = data.get("method", row.method)
        if new_method not in dict(SettlementSettings.METHODS):
            raise WorkflowError("Choose the Normal Method or the Automation Method.", "method", field="method")
        if new_method == SettlementSettings.METHOD_NORMAL and row.method != new_method:
            busy = list(service.in_progress_batches())
            if busy:
                raise WorkflowError(
                    "A settlement batch is still in progress ("
                    + ", ".join(f"{b.get_stage_display()}: batch {b.number} of {b.month}/{b.year}" for b in busy)
                    + "). Complete it before switching to the Normal Method.",
                    "workflow_in_progress",
                    status=409,
                )
    except WorkflowError as exc:
        return _refusal(exc)
    before = row.method
    for attr, value in fields.items():
        setattr(row, attr, value)
    row.method = new_method
    row.updated_by = get_hr_display_name(request)
    row.save()
    log_action(
        request,
        "update",
        "settings",
        record_id=row.pk,
        description=f"Settlement settings: method {before} -> {row.method}"
        if before != row.method
        else "Settlement settings: e-mail addresses",
    )
    return Response(settings_json(request))
