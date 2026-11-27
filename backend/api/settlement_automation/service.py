"""Settlement Automation Method (owner brief 2026-11-26).

Settings -> Settlement chooses the method. The NORMAL METHOD is the Settlement page as it always was (HR approves /
rejects each advance). The AUTOMATION METHOD runs month by month:

  1. Employee Requests Received  every waiting Salary Advance / Term Loan raised in a month joins the month's open batch
  2. HR Review                   HR reviews (notes per request) and clicks Forward to MD
  3. MD Review & Approval        the MD approves (possibly a smaller amount) or rejects each request, with remarks and an
                                 instruction for the batch, reviews everything and clicks Confirm & Proceed
  4. HR Final Settlement         HR checks the MD's decisions and may only go WITHIN them (lower an amount, move the first
                                 deduction month, reject - never approve what the MD rejected or pay more than the MD
                                 approved; every change needs a remark), then Finalize: only now are the advances decided,
                                 exactly as the Normal Method's approve / reject does it (deduction schedule, decision
                                 history, the employee's WhatsApp / push notice)
  5. Send to Auditor             the finalized report (PDF + Excel, built by the page with the Settlement report's own
                                 format) is e-mailed to the auditor addresses of Settings
  6. Auditor Review              HR confirms by hand that the auditor is done (Proceed to Next Step)
  7. Send Bank File to Accounts  the bank file (the Payroll bank-file format, approved amounts) is e-mailed to Accounts
  8. Settlement Workflow Completed

A month has Batch 1, Batch 2, ...: a request raised after HR forwarded a batch waits in the month's next batch (owner's
choice). While the Automation Method is on, the Normal Method's approve / reject / reopen of an advance is refused (409
`automation_method`), the nightly auto-reject leaves advances alone, and a request already forwarded can no longer be
withdrawn by the employee or deleted by HR (409 `in_workflow`). Switching back to the Normal Method is refused while a
batch is between Forward and Completed.

Every action is HR's (or the MD's) own click: nothing advances by itself.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.utils import timezone

from ..clock import FACTORY_TZ, ist_today
from ..models import Advance, SettlementBatch as B, SettlementBatchItem as I, SettlementSettings

REMARK_MIN = 3
MAX_EMAILS = 10
MAX_FILE_BYTES = 15 * 1024 * 1024

# Stages a batch is "in progress" in: the Normal Method can't be switched on while one is.
IN_PROGRESS = (
    B.STAGE_MD_REVIEW,
    B.STAGE_HR_FINAL,
    B.STAGE_AUDITOR_SEND,
    B.STAGE_AUDITOR_REVIEW,
    B.STAGE_AUDITOR_CHANGES,
    B.STAGE_ACCOUNTS_SEND,
)
# Stages after Forward: the request is in the MD's / HR's hands and may no longer be withdrawn or deleted.
FORWARDED = (*IN_PROGRESS, B.STAGE_COMPLETED)

STAGE_INDEX = {
    B.STAGE_HR_REVIEW: 1,
    B.STAGE_MD_REVIEW: 2,
    B.STAGE_HR_FINAL: 3,
    B.STAGE_AUDITOR_SEND: 4,
    B.STAGE_AUDITOR_REVIEW: 5,
    B.STAGE_AUDITOR_CHANGES: 6,
    B.STAGE_ACCOUNTS_SEND: 7,
    B.STAGE_COMPLETED: 9,
}

TRACKER = (
    ("received", "Employee Requests Received"),
    ("hr_review", "HR Review"),
    ("md_review", "MD Review & Approval"),
    ("hr_final", "HR Final Settlement"),
    ("auditor_send", "Send to Auditor"),
    ("auditor_review", "Auditor Review"),
    ("auditor_changes", "HR Review of Auditor Changes"),
    ("accounts_send", "Send Bank File to Accounts"),
    ("completed", "Settlement Workflow Completed"),
)

NEXT_ACTION = {
    B.STAGE_HR_REVIEW: "HR: review the requests and Forward to MD.",
    B.STAGE_MD_REVIEW: "MD: approve, reduce or reject each request, then Confirm & Proceed.",
    B.STAGE_HR_FINAL: "HR: check the MD's decisions, adjust within them, and Finalize the settlement.",
    B.STAGE_AUDITOR_SEND: "HR: Send to Auditor (a secure review link with the finalized report, PDF and Excel).",
    B.STAGE_AUDITOR_REVIEW: (
        "Auditor: review and confirm in the Auditor Review Portal (link e-mailed). HR may confirm by hand if the auditor "
        "confirmed another way."
    ),
    B.STAGE_AUDITOR_CHANGES: "HR: review the auditor's changes and finalize the revised settlement.",
    B.STAGE_ACCOUNTS_SEND: "HR: Send the bank file to Accounts.",
    B.STAGE_COMPLETED: "",
}


# Salary Advance and Term Loan run their own workflows (owner 2026-11-27: "managed and followed up independently").
TYPES = {"general": "Salary Advance", "term": "Term Loan"}


def clean_type(raw) -> str:
    """The advance type a request asks about ("general" | "term"; also "salary-advance" / "term-loan"); refuses others."""
    value = str(raw or "").strip().lower()
    value = {"salary-advance": "general", "salary_advance": "general", "term-loan": "term", "term_loan": "term"}.get(
        value, value
    )
    if value not in TYPES:
        raise WorkflowError("Choose Salary Advance or Term Loan.", "type", field="type")
    return value


class WorkflowError(Exception):
    """A refused step: `message` for the person, `code` for the page, `status` for the response."""

    def __init__(self, message: str, code: str = "invalid", status: int = 400, **extra):
        super().__init__(message)
        self.message, self.code, self.status, self.extra = message, code, status, extra


# ─────────────────────────── settings ───────────────────────────


def settings_row() -> SettlementSettings:
    row = SettlementSettings.objects.order_by("id").first()
    if row is None:
        row = SettlementSettings.objects.create()
    return row


def method() -> str:
    row = SettlementSettings.objects.order_by("id").values_list("method", flat=True).first()
    return row or SettlementSettings.METHOD_NORMAL


def is_automation() -> bool:
    return method() == SettlementSettings.METHOD_AUTOMATION


def in_progress_batches():
    return B.objects.filter(stage__in=IN_PROGRESS).order_by("year", "month", "number")


def clean_emails(raw, field: str) -> list[str]:
    """A list of e-mail addresses from a body (a list, or one string split on commas / semicolons / spaces); refuses a
    malformed one."""
    import re

    if raw in (None, ""):
        return []
    items = raw if isinstance(raw, list) else re.split(r"[,;\s]+", str(raw))
    out: list[str] = []
    for item in items:
        email = str(item or "").strip().lower()
        if not email:
            continue
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
            raise WorkflowError(f"'{item}' is not an e-mail address.", "email", field=field)
        if email not in out:
            out.append(email)
    if len(out) > MAX_EMAILS:
        raise WorkflowError(f"At most {MAX_EMAILS} addresses.", "email", field=field)
    return out


# ─────────────────────────── month / batches ───────────────────────────


def month_bounds(month: int, year: int) -> tuple[datetime, datetime]:
    """The month in factory time, as aware datetimes [start, end)."""
    start = datetime(year, month, 1, tzinfo=FACTORY_TZ)
    end = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=FACTORY_TZ)
    return start, end


def raised_in(month: int, year: int):
    start, end = month_bounds(month, year)
    return Advance.objects.filter(created_at__gte=start, created_at__lt=end)


def sync_month(month: int, year: int, advance_type: str | None = None) -> None:
    """Every waiting advance raised in the month that is in no batch joins the month's open (HR Review) batch OF ITS TYPE,
    created when there is none; an open batch drops the requests that are no longer waiting (decided under the Normal
    Method, withdrawn) and an open batch left empty is removed. Without a type: both types."""
    if advance_type is None:
        for t in TYPES:
            sync_month(month, year, t)
        return
    with transaction.atomic():
        loose = list(
            raised_in(month, year)
            .filter(status=Advance.STATUS_PENDING, settlement_item__isnull=True, advance_type=advance_type)
            .order_by("created_at", "id")
            .values_list("id", flat=True)
        )
        open_batch = (
            B.objects.select_for_update()
            .filter(month=month, year=year, advance_type=advance_type, stage=B.STAGE_HR_REVIEW)
            .order_by("number")
            .first()
        )
        if open_batch is not None:
            open_batch.items.exclude(advance__status=Advance.STATUS_PENDING).delete()
        if loose:
            if open_batch is None:
                number = (
                    B.objects.filter(month=month, year=year, advance_type=advance_type)
                    .order_by("-number")
                    .values_list("number", flat=True)
                    .first()
                    or 0
                ) + 1
                try:
                    with transaction.atomic():
                        open_batch = B.objects.create(month=month, year=year, advance_type=advance_type, number=number)
                except IntegrityError:  # someone else made it at the same moment
                    open_batch = B.objects.select_for_update().get(
                        month=month, year=year, advance_type=advance_type, number=number
                    )
            I.objects.bulk_create([I(batch=open_batch, advance_id=pk) for pk in loose], ignore_conflicts=True)
        if open_batch is not None and not open_batch.items.exists():
            open_batch.delete()


def batches_of(month: int, year: int, advance_type: str | None = None):
    qs = B.objects.filter(month=month, year=year)
    if advance_type is not None:
        qs = qs.filter(advance_type=advance_type)
    return qs.prefetch_related(
        "items__advance__employee__department",
        "items__advance__employee__designation",
        "items__advance__employee__branch",
        "items__advance__repayments",
        "files",
    ).order_by("number")


def _now():
    return timezone.now()


def _log(batch: B, action: str, by: str, note: str = "", **extra) -> None:
    batch.history = [
        *(batch.history or []),
        {"at": _now().isoformat(), "by": by, "action": action, "note": note, **extra},
    ]


def _require_stage(batch: B, *stages: str) -> None:
    if batch.stage not in stages:
        raise WorkflowError(
            f"{TYPES.get(batch.advance_type, 'Advance')} batch {batch.number} of {calendar.month_name[batch.month]} "
            f"{batch.year} is at "
            f"'{batch.get_stage_display()}', so this step is not open.",
            "stage",
            status=409,
            stage=batch.stage,
        )


def _remark(raw) -> str:
    return " ".join(str(raw or "").split())[:1000]


def _money(raw, label: str) -> Decimal:
    try:
        value = Decimal(str(raw).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        raise WorkflowError(f"Enter the {label} in rupees.", "amount") from None
    if not value.is_finite() or value <= 0:
        raise WorkflowError(f"The {label} must be more than ₹0.", "amount")
    if value != value.quantize(Decimal("0.01")):
        raise WorkflowError(f"Use at most 2 decimal places for the {label}.", "amount")
    return value


def requested_of(adv: Advance) -> Decimal:
    return Decimal(adv.requested_amount if adv.requested_amount is not None else adv.amount)


# ─────────────────────────── HR Review ───────────────────────────


def set_hr_note(item: I, note) -> I:
    _require_stage(item.batch, B.STAGE_HR_REVIEW)
    item.hr_note = _remark(note)
    item.save(update_fields=["hr_note", "updated_at"])
    return item


def set_hr_review(item: I, data) -> I:
    """HR's review of one request before the MD (owner 2026-11-27): a remark (`hrNote`), and a proposal - keep it
    (action ""), reduce it (an amount below what was asked; a remark is required) or reject it (a remark is required).
    The proposal is carried to the MD as their pre-filled decision; nothing is final until the settlement is."""
    _require_stage(item.batch, B.STAGE_HR_REVIEW)
    if "hrNote" in data or "remark" in data:
        item.hr_note = _remark(data.get("hrNote", data.get("remark")))
    if "action" in data:
        action = str(data.get("action") or "").strip()
        if action not in ("", "keep", "approve", "reduce", "reject"):
            raise WorkflowError("Choose keep, reduce or reject.", "action")
        action = "" if action in ("keep", "approve") else action
        requested = requested_of(item.advance)
        if action == "reduce":
            amount = _money(data.get("amount"), "reduced amount")
            if amount >= requested:
                raise WorkflowError(
                    f"A reduced amount must be less than the ₹{requested:,.2f} asked for.", "amount", field="amount"
                )
            if len(item.hr_note) < REMARK_MIN:
                raise WorkflowError("Write a remark for the reduced amount (at least 3 characters).", "remark")
            item.hr_amount = amount
        elif action == "reject":
            if len(item.hr_note) < REMARK_MIN:
                raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
            item.hr_amount = None
        else:
            item.hr_amount = None
        item.hr_action = action
    item.save(update_fields=["hr_note", "hr_action", "hr_amount", "updated_at"])
    return item


def _items_of(batch: B, item_ids) -> list:
    ids = {int(x) for x in (item_ids or []) if str(x).strip().isdigit()}
    if not ids:
        raise WorkflowError("Choose at least one request.", "empty")
    items = list(batch.items.select_related("advance").filter(pk__in=ids))
    if len(items) != len(ids):
        raise WorkflowError(
            "Some of the chosen requests are not in this batch any more. Reload the list.", "changed", 409
        )
    return items


def hr_review_bulk(batch: B, item_ids, action, remark) -> tuple[B, list]:
    """HR Review, several requests at once: approve (keep, clearing a proposal) or reject (one remark for all)."""
    _require_stage(batch, B.STAGE_HR_REVIEW)
    action = str(action or "").strip()
    if action not in ("approve", "reject"):
        raise WorkflowError("Choose approve or reject.", "action")
    remark = _remark(remark)
    if action == "reject" and len(remark) < REMARK_MIN:
        raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
    with transaction.atomic():
        for item in _items_of(batch, item_ids):
            item.hr_action = "reject" if action == "reject" else ""
            item.hr_amount = None
            if remark:
                item.hr_note = remark
            item.save(update_fields=["hr_note", "hr_action", "hr_amount", "updated_at"])
    return batch, []


def forward(batch: B, advance_ids, note, by: str) -> B:
    """HR Review -> MD Review. `advance_ids` = the requests HR reviewed: when the batch now holds a different set (a new
    request arrived, one was withdrawn) the forward is refused so HR looks again."""
    sync_month(batch.month, batch.year)
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_HR_REVIEW)
        held = set(batch.items.values_list("advance_id", flat=True))
        if not held:
            raise WorkflowError("There are no requests in this batch to forward.", "empty")
        seen = {int(x) for x in (advance_ids or []) if str(x).isdigit()}
        if advance_ids is not None and seen != held:
            raise WorkflowError(
                "The requests in this batch changed since the page was loaded. Look at the list again, then forward.",
                "changed",
                status=409,
            )
        # HR's proposals are the MD's pre-filled decisions (owner 2026-11-27); a request HR kept waits for the MD
        for item in batch.items.select_related("advance"):
            if item.hr_action == "reduce" and item.hr_amount is not None:
                item.md_decision, item.md_amount, item.md_remark = I.DECISION_APPROVED, item.hr_amount, item.hr_note
            elif item.hr_action == "reject":
                item.md_decision, item.md_amount, item.md_remark = I.DECISION_REJECTED, None, item.hr_note
            else:
                continue
            item.md_decided_at = None  # pre-filled from HR, not yet the MD's own click
            item.save(update_fields=["md_decision", "md_amount", "md_remark", "md_decided_at", "updated_at"])
        batch.stage = B.STAGE_MD_REVIEW
        batch.forwarded_at, batch.forwarded_by, batch.hr_note = _now(), by, _remark(note)
        proposals = batch.items.exclude(hr_action="").count()
        _log(batch, "forwarded", by, batch.hr_note, count=len(held), proposals=proposals)
        batch.save()
    return batch


# ─────────────────────────── MD Review ───────────────────────────


def md_decide(item: I, decision, amount, remark, by: str) -> I:
    """The MD's decision on one request (changeable until Confirm & Proceed): approved (the asked amount or less;
    a smaller amount needs a remark) or rejected (a remark is required). An empty decision clears it."""
    _require_stage(item.batch, B.STAGE_MD_REVIEW)
    decision = str(decision or "").strip()
    remark = _remark(remark)
    adv = item.advance
    requested = requested_of(adv)
    if decision == "":
        item.md_decision, item.md_amount, item.md_remark, item.md_decided_at = "", None, remark, None
    elif decision == I.DECISION_APPROVED:
        value = requested if amount in (None, "") else _money(amount, "approved amount")
        if value > requested:
            raise WorkflowError(f"The approved amount cannot be more than the ₹{requested:,.2f} asked for.", "amount")
        if value < requested and len(remark) < REMARK_MIN:
            raise WorkflowError("Write a remark for the reduced amount (at least 3 characters).", "remark")
        item.md_decision, item.md_amount, item.md_remark, item.md_decided_at = decision, value, remark, _now()
    elif decision == I.DECISION_REJECTED:
        if len(remark) < REMARK_MIN:
            raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
        item.md_decision, item.md_amount, item.md_remark, item.md_decided_at = decision, None, remark, _now()
    else:
        raise WorkflowError("Choose approve or reject.", "decision")
    item.save(update_fields=["md_decision", "md_amount", "md_remark", "md_decided_at", "updated_at"])
    return item


def md_bulk(batch: B, item_ids, decision, remark, by: str) -> tuple[B, list]:
    """The MD on several requests at once: approve (the amount HR proposed, else the full amount asked) or reject (one
    remark for all). Returns the batch and the requests left out (with why)."""
    _require_stage(batch, B.STAGE_MD_REVIEW)
    decision = str(decision or "").strip()
    remark = _remark(remark)
    if decision not in (I.DECISION_APPROVED, I.DECISION_REJECTED):
        raise WorkflowError("Choose approve or reject.", "decision")
    if decision == I.DECISION_REJECTED and len(remark) < REMARK_MIN:
        raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
    skipped: list = []
    with transaction.atomic():
        for item in _items_of(batch, item_ids):
            requested = requested_of(item.advance)
            if decision == I.DECISION_APPROVED:
                amount = item.hr_amount if item.hr_action == "reduce" and item.hr_amount is not None else requested
                note = remark or (item.hr_note if amount < requested else item.md_remark)
                if amount < requested and len(note or "") < REMARK_MIN:
                    skipped.append({"id": item.id, "reason": "A reduced amount needs a remark."})
                    continue
                item.md_decision, item.md_amount, item.md_remark = decision, amount, note or ""
            else:
                item.md_decision, item.md_amount, item.md_remark = decision, None, remark
            item.md_decided_at = _now()
            item.save(update_fields=["md_decision", "md_amount", "md_remark", "md_decided_at", "updated_at"])
    return batch, skipped


def md_confirm(batch: B, note, by: str, direct: bool = False) -> B:
    """MD Review -> HR Final Settlement (Forward to HR), or - `direct` (owner 2026-11-27: "Direct to Auditor") - the
    MD's decisions become the final settlement at once (HR Final Settlement is skipped) and the batch goes to Send to
    Auditor, which the caller then sends. Every request must be decided either way."""
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_MD_REVIEW)
        items = list(batch.items.select_related("advance"))
        open_items = [i for i in items if i.md_decision not in (I.DECISION_APPROVED, I.DECISION_REJECTED)]
        if open_items:
            raise WorkflowError(
                f"{len(open_items)} request(s) still need your decision before you can confirm.",
                "undecided",
                undecided=[i.id for i in open_items],
            )
        for i in items:
            i.final_decision = i.md_decision
            i.final_amount = i.md_amount
            i.final_start_month = i.advance.repayment_start_month
            i.final_start_year = i.advance.repayment_start_year
            i.final_months = i.advance.repayment_months if i.advance.advance_type == "term" else None
            i.final_remark = ""
            i.final_changed_at = None
            i.save()
        batch.md_confirmed_at, batch.md_confirmed_by, batch.md_note = _now(), by, _remark(note)
        approved = sum(1 for i in items if i.md_decision == I.DECISION_APPROVED)
        _log(batch, "md_confirmed", by, batch.md_note, approved=approved, rejected=len(items) - approved, direct=direct)
        if direct:
            batch.stage = B.STAGE_AUDITOR_SEND
            batch.finalized_at, batch.finalized_by, batch.finalized_via = _now(), by, "md"
            batch.final_note = batch.md_note
            _log(
                batch,
                "finalized",
                by,
                "Finalized directly by the MD",
                approved=approved,
                rejected=len(items) - approved,
                total=float(sum((Decimal(i.md_amount) for i in items if i.md_amount is not None), Decimal("0"))),
                via="md",
            )
        else:
            batch.stage = B.STAGE_HR_FINAL
        batch.save()
    return batch


# ─────────────────────────── HR Final Settlement ───────────────────────────


def _int(raw):
    try:
        return int(str(raw).strip()) if raw not in (None, "") and not isinstance(raw, bool) else None
    except ValueError:
        return None


def set_final(item: I, data, by: str) -> I:
    """HR's final settlement of one request, WITHIN the MD's decision (owner's choice): never approve what the MD
    rejected, never more than the MD approved; any change from the MD needs a remark."""
    _require_stage(item.batch, B.STAGE_HR_FINAL)
    decision = str(data.get("decision") or item.final_decision or "").strip()
    remark = _remark(data.get("remark"))
    if decision not in (I.DECISION_APPROVED, I.DECISION_REJECTED):
        raise WorkflowError("Choose approve or reject.", "decision")
    if decision == I.DECISION_APPROVED and item.md_decision != I.DECISION_APPROVED:
        raise WorkflowError("The MD rejected this request: it can only stay rejected.", "md_rejected", status=409)
    amount = None
    month = year = None
    if decision == I.DECISION_APPROVED:
        raw = data.get("amount")
        amount = Decimal(item.md_amount) if raw in (None, "") else _money(raw, "final amount")
        if amount > Decimal(item.md_amount):
            raise WorkflowError(
                f"The final amount cannot be more than the ₹{item.md_amount:,.2f} the MD approved.", "amount"
            )
        month = _int(data.get("startMonth")) if "startMonth" in data else item.final_start_month
        year = _int(data.get("startYear")) if "startYear" in data else item.final_start_year
        if month is not None and not 1 <= month <= 12:
            raise WorkflowError("The first deduction month must be 1 to 12.", "startMonth")
        if year is not None and not 2000 <= year <= 2100:
            raise WorkflowError("The first deduction year must be a 4-digit year.", "startYear")
        months = item.final_months
        if item.advance.advance_type == "term" and "months" in data:
            # a Term Loan's repayment months (owner 2026-11-27): 1 to Settings' most (default 6, at most 12)
            from ..advance_rules import rules

            most = rules().tl_max_months
            months = _int(data.get("months"))
            if months is None or not 1 <= months <= most:
                raise WorkflowError(f"A Term Loan is repaid in 1 to {most} months.", "months", field="months")
    changed = decision != item.md_decision or (
        decision == I.DECISION_APPROVED and amount != Decimal(item.md_amount or 0)
    )
    if changed and len(remark) < REMARK_MIN:
        raise WorkflowError("Write a remark for changing the MD's decision (at least 3 characters).", "remark")
    item.final_decision, item.final_amount = decision, amount
    if decision == I.DECISION_APPROVED:
        item.final_start_month, item.final_start_year = month, year
        if item.advance.advance_type == "term":
            item.final_months = months
    item.final_remark = remark
    item.final_changed_at = _now()
    item.save()
    return item


def effective(item: I) -> tuple[str, Decimal | None, str]:
    """The settlement of one request as it will be paid: HR's final decision with the auditor's change on top (a
    reduced amount, or a rejection), and the remark the employee is told (the auditor's when they changed it)."""
    if item.auditor_action == "reject":
        return I.DECISION_REJECTED, None, item.auditor_remark
    if (
        item.final_decision == I.DECISION_APPROVED
        and item.auditor_action == "reduce"
        and item.auditor_amount is not None
    ):
        return I.DECISION_APPROVED, Decimal(item.auditor_amount), item.auditor_remark
    amount = Decimal(item.final_amount) if item.final_amount is not None else None
    return item.final_decision, amount, item.final_remark or item.md_remark


def has_auditor_changes(items) -> bool:
    return any(i.auditor_action in ("reduce", "reject") for i in items)


def _apply_item(item: I, request, actor: str, after_commit: list) -> None:
    """Decide the advance by the final settlement - the Normal Method's own approve / reject steps
    (settlement_views): amount and first month, the deduction schedule, the decision history; the employee's notice and
    the Activity Logs row once the whole batch is saved."""
    from .. import advance_earnings, hr_access, settlement_views as sv, whatsapp_approvals
    from ..models import AdvanceDecision

    adv = Advance.objects.select_for_update().select_related("employee").get(pk=item.advance_id)
    if adv.status != Advance.STATUS_PENDING:
        raise WorkflowError(
            f"{adv.employee.first_name} {adv.employee.last_name}'s request was already decided outside the workflow.",
            "already_decided",
            status=409,
        )
    requested = requested_of(adv)
    if adv.requested_amount is None:
        adv.requested_amount = requested
    now = _now()
    decision_now, amount_now, remark = effective(item)
    approve = decision_now == I.DECISION_APPROVED
    if approve:
        data = {"amount": str(amount_now)}
        if item.final_start_month:
            data["repaymentStartMonth"] = item.final_start_month
        if item.final_start_year:
            data["repaymentStartYear"] = item.final_start_year
        if adv.advance_type == "term" and item.final_months:
            adv.repayment_months = item.final_months  # the EMI follows the final amount and months
            data["repaymentMonths"] = item.final_months
        problem = sv._apply_amount_and_start(adv, data, Advance.STATUS_PENDING)
        if problem:
            raise WorkflowError(problem, "invalid")
        adv.status = Advance.STATUS_APPROVED
        adv.approved_at = now
    else:
        adv.status = Advance.STATUS_REJECTED
    adv.approved_by = actor
    adv.decision_remark = remark
    adv.decided_at = now
    adv.save()
    if approve:
        sv._auto_create_repayments(adv)
        adv.refresh_from_db()
    sv._record_decision(
        adv,
        AdvanceDecision.ACTION_APPROVED if approve else AdvanceDecision.ACTION_REJECTED,
        requested,
        remark,
        request,
    )
    item.applied = True
    item.save(update_fields=["applied", "updated_at"])
    kind = hr_access.kind_for("advance", adv)
    decision = "approved" if approve else "rejected"
    comment = sv._decision_comment(adv) if approve else (adv.decision_remark or None)

    def notify(adv=adv, kind=kind, decision=decision, comment=comment):
        advance_earnings.refresh(adv)
        if request is not None and getattr(request, "jwt_user", None):
            hr_access.log_decision(request, kind, adv, decision, f"advance of ₹{adv.amount:,.2f} (Loan & Advance)")
        whatsapp_approvals.notify_decision("advance", adv, decision, approver=actor, role="hr", comment=comment)

    after_commit.append(notify)


def final_bulk(batch: B, item_ids, decision, remark, by: str) -> tuple[B, list]:
    """HR Final Settlement, several requests at once, within the MD's decision: approve (at the MD's amount - only
    requests the MD approved) or reject (one remark for all)."""
    _require_stage(batch, B.STAGE_HR_FINAL)
    decision = str(decision or "").strip()
    remark = _remark(remark)
    if decision not in (I.DECISION_APPROVED, I.DECISION_REJECTED):
        raise WorkflowError("Choose approve or reject.", "decision")
    if decision == I.DECISION_REJECTED and len(remark) < REMARK_MIN:
        raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
    skipped: list = []
    with transaction.atomic():
        for item in _items_of(batch, item_ids):
            if decision == I.DECISION_APPROVED:
                if item.md_decision != I.DECISION_APPROVED:
                    skipped.append({"id": item.id, "reason": "The MD rejected it."})
                    continue
                item.final_decision, item.final_amount = decision, item.md_amount
                item.final_remark = remark if remark else ""
            else:
                item.final_decision, item.final_amount, item.final_remark = decision, None, remark
            item.final_changed_at = _now()
            item.save()
    return batch, skipped


def _rights(request, items) -> None:
    """HR's approval rights of every type in the batch (Salary advances / Term loans)."""
    from .. import hr_access

    for kind in sorted({hr_access.kind_for("advance", i.advance) for i in items}):
        refused = hr_access.approval_refusal(request, kind)
        if refused is not None:
            raise WorkflowError(
                refused.data.get("error", "You may not approve these requests."), "approval_not_permitted", 403
            )


def _apply_settlement(batch: B, request, actor: str, after: list) -> None:
    """Write the settlement to the advances (inside the caller's transaction): every request not applied yet is decided
    by its effective settlement (HR's final decision with the auditor's change). Called once the audit is through."""
    for i in batch.items.select_related("advance", "advance__employee"):
        if not i.applied:
            _apply_item(i, request, actor, after)


def finalize(batch: B, note, request, actor: str) -> B:
    """HR Final Settlement -> Send to Auditor: HR's decisions are locked as the final settlement. Since 2026-11-27 they
    are written to the advances (deduction schedule, the employee's notice) only once the audit is through - the auditor
    approves it, HR accepts the auditor's changes, or HR confirms the auditor's review by hand - so an auditor's cut never
    has to undo an approval the employee was already told about."""
    after: list = []
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_HR_FINAL)
        items = list(batch.items.select_related("advance", "advance__employee"))
        if not items:
            raise WorkflowError("There are no requests in this batch.", "empty")
        _rights(request, items)
        for i in items:
            if i.final_decision not in (I.DECISION_APPROVED, I.DECISION_REJECTED):
                raise WorkflowError("Every request needs a final decision.", "undecided")
        approved = [i for i in items if i.final_decision == I.DECISION_APPROVED]
        batch.stage = B.STAGE_AUDITOR_SEND
        batch.finalized_at, batch.finalized_by, batch.final_note = _now(), actor, _remark(note)
        _log(
            batch,
            "finalized",
            actor,
            batch.final_note,
            approved=len(approved),
            rejected=len(items) - len(approved),
            total=float(sum((Decimal(i.final_amount) for i in approved), Decimal("0"))),
        )
        batch.save()
        for fn in after:
            transaction.on_commit(fn)
    return batch


# ─────────────────────────── auditor / accounts ───────────────────────────


def _period(batch: B) -> str:
    return f"{calendar.month_name[batch.month]} {batch.year}"


def _totals(batch: B) -> dict:
    """The settlement as it will be paid (the auditor's changes included)."""
    items = list(batch.items.all())
    eff = [effective(i) for i in items]
    approved = [e for e in eff if e[0] == I.DECISION_APPROVED]
    total = sum((e[1] for e in approved if e[1] is not None), Decimal("0"))
    return {"approved": len(approved), "rejected": len(items) - len(approved), "total": total, "count": len(items)}


def _send(
    email_type: str,
    batch: B,
    to: list[str],
    cc: list[str],
    files: list[tuple[str, bytes, str]],
    request,
    *,
    extra_params: dict | None = None,
    report_html: str = "",
    report_text: str = "",
):
    from .. import email_service
    from ..models import PayrollSettings
    from ..user_settings import _overlay_for_branch

    t = _totals(batch)
    params = {
        "type": TYPES.get(batch.advance_type, "Advance"),
        "period": _period(batch),
        "batch": str(batch.number),
        "request_count": str(t["count"]),
        "approved_count": str(t["approved"]),
        "rejected_count": str(t["rejected"]),
        "total_approved": f"₹{t['total']:,.2f}",
        "finalized_by": batch.finalized_by or "",
        **(extra_params or {}),
    }
    hr_user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId") if request is not None else None
    ps = _overlay_for_branch(None) or PayrollSettings.get()
    return email_service.send_email(
        email_type,
        to_email=to[0],
        extra_to=to[1:],
        cc=cc,
        params=params,
        ps=ps,
        recipient_name="Auditor" if email_type == "settlement_auditor" else "Accounts",
        attachments=files,
        related_module="settlement",
        ref_id=batch.pk,
        sent_by_id=hr_user_id,
        report_html=report_html,
        report_text=report_text,
    )


def _keep_files(batch: B, files, kinds, to, log, by: str) -> None:
    from ..models import SettlementBatchFile as F

    for (name, content, mime), kind in zip(files, kinds):
        F.objects.create(
            batch=batch,
            kind=kind,
            filename=name,
            content_type=mime,
            content=content,
            size=len(content),
            sent_to=to,
            email_log_id=getattr(log, "pk", None),
            email_status=getattr(log, "status", "") or "",
            created_by=by,
        )


def _email_refusal(log) -> WorkflowError:
    from .. import email_service

    if log is None:
        return WorkflowError("Not sent: e-mail is switched off or not set up (Gmail Control).", "email_off", 400)
    message = log.error_message or "The e-mail could not be sent."
    if log.status == email_service.EMAIL_BLOCKED:
        return WorkflowError(f"Not sent: {message}", "email_blocked", getattr(log, "http_status", None) or 400)
    return WorkflowError(f"Not sent: {message}", "email_failed", getattr(log, "http_status", None) or 502)


# ─────────────────────────── the auditor's secure review link ───────────────────────────

LINK_DAYS_MIN, LINK_DAYS_MAX = 1, 30


def _hash(token: str) -> str:
    import hashlib

    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_origin(request) -> str:
    """Where the HRMS pages are served (the review link points at the frontend's /auditor-review/<token>):
    settings.FRONTEND_URL when set (cloud: frontend and API on two domains), else the HR browser's own Origin (the dev
    server's proxy rewrites the Host), else the request's host (on-premise, one host)."""
    from django.conf import settings as django_settings

    if getattr(django_settings, "FRONTEND_URL", ""):
        return django_settings.FRONTEND_URL.rstrip("/")
    origin = (request.headers.get("Origin") or "").strip().rstrip("/") if request is not None else ""
    if origin.startswith(("http://", "https://")):
        return origin
    return request.build_absolute_uri("/").rstrip("/") if request is not None else ""


def _new_link(batch: B, to: list[str], by: str):
    """A fresh review link for the batch (older ones are revoked): (row, the raw token - only ever e-mailed)."""
    import secrets
    from datetime import timedelta

    from ..models import SettlementAuditorLink as L

    days = max(LINK_DAYS_MIN, min(LINK_DAYS_MAX, int(settings_row().auditor_link_days or 7)))
    L.objects.filter(batch=batch, revoked_at__isnull=True, submitted_at__isnull=True).update(revoked_at=_now())
    token = secrets.token_urlsafe(32)
    row = L.objects.create(
        batch=batch, token_hash=_hash(token), sent_to=to, created_by=by, expires_at=_now() + timedelta(days=days)
    )
    return row, token


def _review_email_blocks(batch: B, url: str, expires) -> tuple[str, str]:
    """The professional part of the auditor's e-mail, placed under the settlement summary (the e-mail type's own details
    table, inside Gmail Control's branded layout): the Review & Confirm Settlement button, how long the link works, and
    the address to copy when a button does not open; plus the same in plain text."""
    import html as html_lib

    when = expires.astimezone(FACTORY_TZ).strftime("%d %b %Y, %I:%M %p")
    link = html_lib.escape(url, quote=True)
    block = (
        '<div style="text-align:center;margin:22px 0 16px">'
        f'<a href="{link}" style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;'
        'font-weight:bold;font-size:15px;padding:13px 30px;border-radius:8px">Review &amp; Confirm Settlement</a>'
        "</div>"
        '<p style="margin:0 0 6px;font-size:12px;color:#64748b;text-align:center">'
        f"This secure link is for you alone and works until {html_lib.escape(when)} (India time).</p>"
        '<p style="margin:0 0 18px;font-size:11px;color:#94a3b8;text-align:center;word-break:break-all">'
        f'If the button does not open, copy this address into your browser:<br><a href="{link}" '
        f'style="color:#1e3a8a">{link}</a></p>'
    )
    text = f"Review & Confirm Settlement: {url}\nThis secure link is for you alone and works until {when} (India time)."
    return block, text


def send_to_auditor(batch: B, pdf: tuple, xlsx: tuple, request, by: str) -> B:
    """Send to Auditor (or again while the auditor is reviewing): a professional e-mail with the settlement summary and a
    secure, expiring "Review & Confirm Settlement" link to the Auditor Review Portal (no HRMS login), the finalized
    report attached as PDF and Excel, to Settings' auditor addresses. A new send revokes the older links. Only a SENT
    e-mail moves the workflow on (and keeps the new link)."""
    from .. import email_service
    from ..models import SettlementBatchFile as F

    _require_stage(batch, B.STAGE_AUDITOR_SEND, B.STAGE_AUDITOR_REVIEW)
    row = settings_row()
    to, cc = list(row.auditor_emails or []), list(row.auditor_cc or [])
    if not to:
        raise WorkflowError("No auditor e-mail address is set. Add one in Settings -> Loan & Advance.", "no_recipient")
    files = [pdf, xlsx]
    with transaction.atomic():
        link, token = _new_link(batch, to + cc, by)
        url = f"{public_origin(request)}/auditor-review/{token}"
        html_block, text_block = _review_email_blocks(batch, url, link.expires_at)
        log = _send(
            "settlement_auditor",
            batch,
            to,
            cc,
            files,
            request,
            extra_params={"review_link": url},
            report_html=html_block,
            report_text=text_block,
        )
        if log is None or log.status != email_service.EMAIL_SENT:
            transaction.set_rollback(True)  # no link kept for an e-mail that did not go
            failed = _email_refusal(log)
        else:
            failed = None
    _keep_files(batch, files, [F.KIND_REPORT_PDF, F.KIND_REPORT_XLSX], to + cc, log, by)
    if failed is not None:
        raise failed
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        again = batch.stage == B.STAGE_AUDITOR_REVIEW
        batch.stage = B.STAGE_AUDITOR_REVIEW
        batch.auditor_sent_at, batch.auditor_sent_by, batch.auditor_recipients = _now(), by, to + cc
        _log(batch, "auditor_resent" if again else "auditor_sent", by, "", to=to, cc=cc)
        batch.save()
    return batch


def _close_links(batch: B) -> None:
    from ..models import SettlementAuditorLink as L

    L.objects.filter(batch=batch, revoked_at__isnull=True, submitted_at__isnull=True).update(revoked_at=_now())


def auditor_done(batch: B, note, request, by: str) -> B:
    """HR confirms by hand that the auditor's review is done (the auditor confirmed another way): the final settlement is
    written to the advances as HR finalized it, the review link stops working -> Send Bank File to Accounts."""
    after: list = []
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_AUDITOR_REVIEW)
        _rights(request, list(batch.items.select_related("advance")))
        _apply_settlement(batch, request, by, after)
        _close_links(batch)
        batch.stage = B.STAGE_ACCOUNTS_SEND
        batch.auditor_confirmed_at, batch.auditor_confirmed_by, batch.auditor_note = _now(), by, _remark(note)
        batch.auditor_outcome = batch.auditor_outcome or "confirmed_by_hr"
        _log(batch, "auditor_confirmed", by, batch.auditor_note)
        batch.save()
        for fn in after:
            transaction.on_commit(fn)
    return batch


def accept_auditor_changes(batch: B, note, request, by: str) -> B:
    """HR Review of Auditor Changes -> Send Bank File to Accounts: HR accepts the auditor's changes; the revised
    settlement (the auditor's reduced amounts and rejections on top of HR's final decisions) is written to the advances."""
    after: list = []
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_AUDITOR_CHANGES)
        _rights(request, list(batch.items.select_related("advance")))
        _apply_settlement(batch, request, by, after)
        batch.stage = B.STAGE_ACCOUNTS_SEND
        batch.changes_accepted_at, batch.changes_accepted_by, batch.changes_note = _now(), by, _remark(note)
        t = _totals(batch)
        _log(
            batch,
            "auditor_changes_accepted",
            by,
            batch.changes_note,
            approved=t["approved"],
            rejected=t["rejected"],
            total=float(t["total"]),
        )
        batch.save()
        for fn in after:
            transaction.on_commit(fn)
    return batch


def _deliver_accounts(batch: B, bank: tuple, request, by: str, via: str):
    """E-mail the bank file to Settings' Accounts addresses; keeps the file. Returns the e-mail log (raises when not sent)."""
    from .. import email_service
    from ..models import SettlementBatchFile as F

    if not _totals(batch)["approved"]:
        raise WorkflowError(
            "No request was approved in this batch, so there is no bank file to send.", "nothing_to_pay"
        )
    row = settings_row()
    to, cc = list(row.accounts_emails or []), list(row.accounts_cc or [])
    if not to:
        raise WorkflowError("No Accounts e-mail address is set. Add one in Settings -> Loan & Advance.", "no_recipient")
    log = _send("settlement_accounts", batch, to, cc, [bank], request)
    _keep_files(batch, [bank], [F.KIND_BANK_FILE], to + cc, log, by)
    if log is None or log.status != email_service.EMAIL_SENT:
        raise _email_refusal(log)
    return to, cc


def _mark_accounts_sent(batch: B, to, cc, by: str, via: str) -> B:
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        again = batch.stage == B.STAGE_COMPLETED
        batch.stage = B.STAGE_COMPLETED
        batch.accounts_sent_at, batch.accounts_sent_by, batch.accounts_recipients = _now(), by, to + cc
        batch.accounts_sent_via = via
        if not again:
            batch.completed_at = _now()
        _log(batch, "accounts_resent" if again else "accounts_sent", by, "", to=to, cc=cc, via=via)
        if not again:
            _log(batch, "completed", by)
        batch.save()
    return batch


def send_to_accounts(batch: B, bank: tuple, request, by: str) -> B:
    """HR sends the bank file to Accounts (or again once completed) -> Settlement Workflow Completed."""
    _require_stage(batch, B.STAGE_ACCOUNTS_SEND, B.STAGE_COMPLETED)
    to, cc = _deliver_accounts(batch, bank, request, by, "hr")
    return _mark_accounts_sent(batch, to, cc, by, "hr")


# ─────────────────────────── the Auditor Review Portal (public, by link) ───────────────────────────

AUDITOR_NAME = "Auditor"


def link_for(token: str, *, touch: bool = False):
    """The review link behind a token, refusing an unknown / revoked / expired one (404 / 410)."""
    from django.db.models import F as Fx

    from ..models import SettlementAuditorLink as L

    token = str(token or "").strip()
    link = (
        L.objects.select_related("batch").filter(token_hash=_hash(token)).first() if 20 <= len(token) <= 200 else None
    )
    if link is None:
        raise WorkflowError("This review link is not valid.", "link_invalid", 404)
    if link.revoked_at is not None:
        raise WorkflowError(
            "This review link was replaced by a newer one or closed by HR. Please use the latest e-mail.",
            "link_revoked",
            410,
        )
    if link.expires_at <= _now() and link.submitted_at is None:
        raise WorkflowError("This review link has expired. Please ask HR to send it again.", "link_expired", 410)
    if touch:
        L.objects.filter(pk=link.pk).update(
            open_count=Fx("open_count") + 1,
            last_opened_at=_now(),
            first_opened_at=link.first_opened_at or _now(),
        )
    return link


def _can_review(link, batch: B) -> bool:
    return link.submitted_at is None and batch.stage == B.STAGE_AUDITOR_REVIEW and link.expires_at > _now()


def _require_review(link) -> B:
    batch = B.objects.get(pk=link.batch_id)
    if link.submitted_at is not None:
        raise WorkflowError("Your review of this settlement was already submitted.", "submitted", 409)
    if batch.stage != B.STAGE_AUDITOR_REVIEW:
        raise WorkflowError("This settlement is no longer waiting for the auditor's review.", "stage", 409)
    return batch


def auditor_change(link, item_id: int, data) -> B:
    """The auditor's change on one request: a remark, a reduced amount (below HR's approved amount; a remark is
    required) or a rejection (a remark is required); an empty action clears the change (the remark stays)."""
    batch = _require_review(link)
    item = I.objects.select_related("advance").filter(pk=item_id, batch=batch).first()
    if item is None:
        raise WorkflowError("Request not found in this settlement.", "not_found", 404)
    action = str(data.get("action") or "").strip()
    remark = _remark(data.get("remark"))
    if action not in ("", "reduce", "reject"):
        raise WorkflowError("Choose keep, reduce or reject.", "action")
    if action and item.final_decision != I.DECISION_APPROVED:
        raise WorkflowError("HR rejected this request: there is nothing to reduce or reject.", "not_approved", 409)
    if action == "reduce":
        amount = _money(data.get("amount"), "reduced amount")
        if amount >= Decimal(item.final_amount):
            raise WorkflowError(
                f"A reduced amount must be less than the approved ₹{item.final_amount:,.2f}.", "amount", field="amount"
            )
        if len(remark) < REMARK_MIN:
            raise WorkflowError("Write a remark for the reduced amount (at least 3 characters).", "remark")
        item.auditor_amount = amount
    elif action == "reject":
        if len(remark) < REMARK_MIN:
            raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
        item.auditor_amount = None
    else:
        item.auditor_amount = None
    item.auditor_action, item.auditor_remark, item.auditor_at = action, remark, _now()
    item.save(update_fields=["auditor_action", "auditor_amount", "auditor_remark", "auditor_at", "updated_at"])
    return batch


def auditor_bulk(link, item_ids, action, remark) -> B:
    """The auditor on several requests at once: approve (keep HR's settlement, clearing a change) or reject (one reason
    for all; only requests HR approved)."""
    batch = _require_review(link)
    action = str(action or "").strip()
    remark = _remark(remark)
    if action not in ("approve", "reject"):
        raise WorkflowError("Choose approve or reject.", "action")
    if action == "reject" and len(remark) < REMARK_MIN:
        raise WorkflowError("Write the reason for rejecting (at least 3 characters).", "remark")
    with transaction.atomic():
        for item in _items_of(batch, item_ids):
            if action == "reject":
                if item.final_decision != I.DECISION_APPROVED:
                    continue  # HR already rejected it
                item.auditor_action, item.auditor_amount, item.auditor_remark = "reject", None, remark
            else:
                item.auditor_action, item.auditor_amount = "", None
                if remark:
                    item.auditor_remark = remark
            item.auditor_at = _now()
            item.save(update_fields=["auditor_action", "auditor_amount", "auditor_remark", "auditor_at", "updated_at"])
    return batch


DECISIONS = {"approved_send_accounts", "approved_forward_hr", "changes_forward_hr"}


def auditor_submit(link, decision: str, note, bank: tuple | None, request) -> tuple[B, str | None]:
    """The auditor's answer. Without changes: "approved_send_accounts" (the settlement is applied and the bank file -
    built by the portal from the approved settlement - goes straight to Accounts) or "approved_forward_hr" (applied; HR
    sends it). With changes (a reduced amount or a rejection): "changes_forward_hr" - back to HR, who reviews and
    finalizes the revised settlement. Returns (batch, a warning when Accounts could not be e-mailed)."""
    from ..models import SettlementAuditorLink as L

    if decision not in DECISIONS:
        raise WorkflowError("Choose how to submit the review.", "decision")
    note = _remark(note)
    warning = None
    after: list = []
    with transaction.atomic():
        link = L.objects.select_for_update().get(pk=link.pk)
        batch = _require_review(link)
        batch = B.objects.select_for_update().get(pk=batch.pk)
        items = list(batch.items.select_related("advance", "advance__employee"))
        changed = has_auditor_changes(items)
        if decision == "changes_forward_hr" and not changed:
            raise WorkflowError("You made no change: approve the settlement instead.", "no_changes")
        if decision != "changes_forward_hr" and changed:
            raise WorkflowError(
                "You changed amounts or rejected requests: forward the settlement to HR for review.", "has_changes"
            )
        if decision == "approved_send_accounts":
            if not _totals(batch)["approved"]:
                raise WorkflowError("Nothing is approved, so there is no bank file for Accounts.", "nothing_to_pay")
            if not settings_row().accounts_emails:
                raise WorkflowError("No Accounts e-mail address is set in the HRMS.", "no_recipient")
            if bank is None:
                raise WorkflowError("The bank file is missing.", "file", field="bank")
        now = _now()
        link.submitted_at, link.decision = now, decision
        link.save(update_fields=["submitted_at", "decision"])
        batch.auditor_submitted_at, batch.auditor_submitted_note = now, note
        batch.auditor_outcome = "changes" if changed else "approved"
        if changed:
            batch.stage = B.STAGE_AUDITOR_CHANGES
            _log(batch, "auditor_changes", AUDITOR_NAME, note, changes=sum(1 for i in items if i.auditor_action))
        else:
            _apply_settlement(batch, None, AUDITOR_NAME, after)
            batch.stage = B.STAGE_ACCOUNTS_SEND
            _log(batch, "auditor_approved", AUDITOR_NAME, note, via=decision)
        batch.save()
        for fn in after:
            transaction.on_commit(fn)
    if decision == "approved_send_accounts":
        try:
            to, cc = _deliver_accounts(batch, bank, request, AUDITOR_NAME, "auditor")
            batch = _mark_accounts_sent(batch, to, cc, AUDITOR_NAME, "auditor")
        except WorkflowError as exc:
            # approved and applied; only the e-mail failed - HR sends the bank file from the HRMS
            warning = (
                f"Your approval was saved, but the e-mail to Accounts did not go ({exc.message}). HR will send it."
            )
            with transaction.atomic():
                b = B.objects.select_for_update().get(pk=batch.pk)
                _log(b, "accounts_failed_from_auditor", AUDITOR_NAME, exc.message)
                b.save(update_fields=["history", "updated_at"])
    return B.objects.get(pk=batch.pk), warning


def portal_json(link, batch: B) -> dict:
    """What the Auditor Review Portal shows: the company, the settlement (the HR-finalized requests with the figures of
    the Settlement report, the MD's and HR's decisions, the auditor's own changes), the totals, the Accounts addresses
    (for "Approve & Send to Accounts"), and whether the review can still be changed."""
    from ..reporting.branding import company
    from ..models import PayrollSettings
    from ..settlement_views import advance_json

    batch = B.objects.prefetch_related(
        "items__advance__employee__department",
        "items__advance__employee__designation",
        "items__advance__employee__branch",
        "items__advance__repayments",
    ).get(pk=batch.pk)
    co = company()
    ps = PayrollSettings.objects.filter(pk=1).first()
    row = settings_row()
    items = list(batch.items.all())
    out_items = []
    for i in items:
        adv = i.advance
        dec, amount, remark = effective(i)
        data = advance_json(adv, include_bank=True)
        keep = {
            k: data.get(k)
            for k in (
                "id",
                "employeeId",
                "employeeCode",
                "employeeName",
                "employeeDepartment",
                "employeeDesignation",
                "employeeBranch",
                "employeeType",
                "advanceType",
                "typeLabel",
                "purpose",
                "requestedAmount",
                "repaymentMonths",
                "emiAmount",
                "createdAt",
                "earnings",
                "leaveCheck",
                "appliedBy",
                # a Term Loan's own figures (2026-11-27): the limit when asked for, the monthly salary, the schedule start
                "termLimit",
                "salaryAtRequest",
                "repaymentStartMonth",
                "repaymentStartYear",
            )
        }
        if dec == I.DECISION_APPROVED:  # the bank file needs them; only for what is paid
            keep.update({k: data.get(k) for k in ("bankAccount", "bankIfsc", "bankName")})
        out_items.append(
            {
                "id": i.id,
                "advance": keep,
                "requestedAmount": float(requested_of(adv)),
                "md": {
                    "decision": i.md_decision or None,
                    "amount": float(i.md_amount) if i.md_amount is not None else None,
                    "remark": i.md_remark,
                },
                "final": {
                    "decision": i.final_decision or None,
                    "amount": float(i.final_amount) if i.final_amount is not None else None,
                    "startMonth": i.final_start_month,
                    "startYear": i.final_start_year,
                    "months": i.final_months,
                    "remark": i.final_remark,
                },
                "auditor": {
                    "action": i.auditor_action or None,
                    "amount": float(i.auditor_amount) if i.auditor_amount is not None else None,
                    "remark": i.auditor_remark,
                    "at": i.auditor_at.isoformat() if i.auditor_at else None,
                },
                "effective": {
                    "decision": dec,
                    "amount": float(amount) if amount is not None else None,
                    "remark": remark,
                },
            }
        )
    t = _totals(batch)
    hr_total = sum(
        (
            Decimal(i.final_amount)
            for i in items
            if i.final_decision == I.DECISION_APPROVED and i.final_amount is not None
        ),
        Decimal("0"),
    )
    return {
        "company": {
            "name": co.name,
            "tagline": co.tagline,
            "address": co.address,
            "contact": co.contact,
            "logo": (ps.company_logo if ps and ps.company_logo else None),
        },
        "settlement": {
            "advanceType": batch.advance_type,
            "typeLabel": TYPES.get(batch.advance_type, "Advance"),
            "month": batch.month,
            "year": batch.year,
            "period": _period(batch),
            "number": batch.number,
            "title": f"{TYPES.get(batch.advance_type, 'Advance')} · Batch {batch.number}",
            "stage": batch.stage,
            "stageLabel": batch.get_stage_display(),
            "finalizedAt": batch.finalized_at.isoformat() if batch.finalized_at else None,
            "finalizedBy": batch.finalized_by or None,
            "finalNote": batch.final_note,
            "mdConfirmedBy": batch.md_confirmed_by or None,
            "mdNote": batch.md_note,
        },
        "items": out_items,
        "totals": {
            "requests": t["count"],
            "approved": t["approved"],
            "rejected": t["rejected"],
            "approvedAmount": float(t["total"]),
            "hrApprovedAmount": float(hr_total),
            "changes": sum(1 for i in items if i.auditor_action in ("reduce", "reject")),
            "remarks": sum(1 for i in items if (i.auditor_remark or "").strip()),
        },
        "accounts": {"to": list(row.accounts_emails or []), "cc": list(row.accounts_cc or [])},
        "link": {
            "expiresAt": link.expires_at.isoformat(),
            "submittedAt": link.submitted_at.isoformat() if link.submitted_at else None,
            "decision": link.decision or None,
        },
        "canReview": _can_review(link, batch),
        "hasChanges": has_auditor_changes(items),
    }


def timecard_json(link, item_id: int) -> dict:
    """One employee's attendance time card for the settlement's month (only an employee of this settlement): every day
    with its status, punches, shifts and marks, the month's counts, the 1st-20th figures and the leave check."""
    from ..attendance_final import compute_month_records, month_summary_from_records
    from ..growth_views import _record_dict
    from ..models import Holiday, PayrollSettings
    from ..shift_engine import _get_shift_for_date
    from .. import advance_earnings

    batch = B.objects.get(pk=link.batch_id)
    item = (
        I.objects.select_related("advance__employee__department", "advance__employee__designation")
        .filter(pk=item_id, batch=batch)
        .first()
    )
    if item is None:
        raise WorkflowError("Employee not found in this settlement.", "not_found", 404)
    emp = item.advance.employee
    month, year = batch.month, batch.year
    records = compute_month_records(emp, year, month, PayrollSettings.get())
    holidays = {h.date: h.name for h in Holiday.objects.filter(date__year=year, date__month=month)}
    days = []
    for r in records:
        d = _record_dict(r)
        d["holidayName"] = holidays.get(r.date)
        d["isSunday"] = r.date.weekday() == 6
        days.append(d)
    shift = _get_shift_for_date(emp, date(year, month, 15))
    return {
        "employee": {
            "code": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}".strip(),
            "department": emp.department.name if emp.department_id else None,
            "designation": emp.designation.title if emp.designation_id else None,
            "type": emp.employment_type,
            "joinDate": str(emp.join_date) if emp.join_date else None,
        },
        "shift": {
            "name": shift.name,
            "startTime": shift.start_time.strftime("%H:%M") if shift.start_time else None,
            "endTime": shift.end_time.strftime("%H:%M") if shift.end_time else None,
        }
        if shift
        else None,
        "month": month,
        "year": year,
        "days": days,
        "summary": month_summary_from_records(records),
        "earnings": advance_earnings.earnings_json(item.advance),
        "leaveCheck": advance_earnings.leave_check_json(item.advance),
    }


def complete_without_bank_file(batch: B, note, by: str) -> B:
    """A batch whose every request was rejected has nothing to pay: HR closes it from Send Bank File to Accounts."""
    with transaction.atomic():
        batch = B.objects.select_for_update().get(pk=batch.pk)
        _require_stage(batch, B.STAGE_ACCOUNTS_SEND)
        if _totals(batch)["approved"]:
            raise WorkflowError("This batch has approved requests: send the bank file to Accounts.", "has_payments")
        batch.stage = B.STAGE_COMPLETED
        batch.completed_at = _now()
        _log(batch, "completed_no_payments", by, _remark(note))
        batch.save()
    return batch


# ─────────────────────────── JSON ───────────────────────────


def tracker_json(batch: B | None, received: int) -> list[dict]:
    """The stages with done / current / pending / skipped, when and by whom, what happened (`detail`) and what to do at
    the current one. "HR Review of Auditor Changes" is skipped when the auditor approved without changes (or HR confirmed
    the review by hand); the Accounts step says whether HR or the auditor sent the bank file."""
    current = STAGE_INDEX.get(batch.stage, 1) if batch is not None else (1 if received else 0)
    stamps: dict = {}
    details: dict = {}
    skipped: set = set()
    if batch is not None:
        outcome = batch.auditor_outcome or ""
        auditor_at = batch.auditor_submitted_at or batch.auditor_confirmed_at
        auditor_by = AUDITOR_NAME if batch.auditor_submitted_at else batch.auditor_confirmed_by
        stamps = {
            "hr_review": (batch.forwarded_at, batch.forwarded_by),
            "md_review": (batch.md_confirmed_at, batch.md_confirmed_by),
            "hr_final": (batch.finalized_at, batch.finalized_by),
            "auditor_send": (batch.auditor_sent_at, batch.auditor_sent_by),
            "auditor_review": (auditor_at, auditor_by),
            "auditor_changes": (batch.changes_accepted_at, batch.changes_accepted_by),
            "accounts_send": (batch.accounts_sent_at, batch.accounts_sent_by),
            "completed": (batch.completed_at, ""),
        }
        details = {
            "auditor_review": {
                "approved": "Approved by the auditor",
                "changes": "The auditor changed the settlement",
                "confirmed_by_hr": "Confirmed by HR (by hand)",
            }.get(outcome),
            "accounts_send": {"auditor": "Sent by the auditor", "hr": "Sent by HR"}.get(batch.accounts_sent_via or ""),
        }
        if current > STAGE_INDEX[B.STAGE_AUDITOR_CHANGES] and outcome != "changes":
            skipped.add("auditor_changes")
        if batch.finalized_via == "md":
            skipped.add("hr_final")
    out = []
    for index, (key, label) in enumerate(TRACKER):
        if index == 0:
            state = "done" if received else "current"
        elif key in skipped:
            state = "skipped"
        elif index < current:
            state = "done"
        elif index == current:
            state = "done" if key == "completed" else "current"
        else:
            state = "pending"
        at, by = stamps.get(key, (None, ""))
        out.append(
            {
                "key": key,
                "label": label,
                "state": state,
                "at": at.isoformat() if at and state == "done" else None,
                "by": (by or None) if state == "done" else None,
                "detail": details.get(key)
                if state == "done"
                else (
                    ("Finalized directly by the MD" if key == "hr_final" else "No auditor changes")
                    if state == "skipped"
                    else None
                ),
                "action": NEXT_ACTION.get(batch.stage, "") if (batch is not None and state == "current") else None,
            }
        )
    if batch is None and received == 0:
        out[0]["action"] = "No Salary Advance or Term Loan request has been raised this month yet."
    return out


def item_json(item: I, *, include_bank: bool) -> dict:
    from ..settlement_views import advance_json

    adv = item.advance
    md_amount = float(item.md_amount) if item.md_amount is not None else None
    final_amount = float(item.final_amount) if item.final_amount is not None else None
    return {
        "id": item.id,
        "advance": advance_json(adv, include_bank=include_bank),
        "requestedAmount": float(requested_of(adv)),
        "hrNote": item.hr_note,
        # HR's review proposal (2026-11-27): "" | reduce | reject, the amount; the remark is hrNote
        "hr": {
            "action": item.hr_action or None,
            "amount": float(item.hr_amount) if item.hr_amount is not None else None,
            "remark": item.hr_note,
        },
        "md": {
            "decision": item.md_decision or None,
            "amount": md_amount,
            "remark": item.md_remark,
            "decidedAt": item.md_decided_at.isoformat() if item.md_decided_at else None,
            # pre-filled from HR's proposal and not yet confirmed by the MD's own click
            "fromHr": bool(item.md_decision) and item.md_decided_at is None,
        },
        "final": {
            "decision": item.final_decision or None,
            "amount": final_amount,
            "startMonth": item.final_start_month,
            "startYear": item.final_start_year,
            "months": item.final_months,
            "remark": item.final_remark,
            "changedFromMd": bool(item.final_decision)
            and (item.final_decision != item.md_decision or final_amount != md_amount),
        },
        # the auditor's change in the review portal (2026-11-27) and the settlement as it will be paid
        "auditor": {
            "action": item.auditor_action or None,
            "amount": float(item.auditor_amount) if item.auditor_amount is not None else None,
            "remark": item.auditor_remark,
            "at": item.auditor_at.isoformat() if item.auditor_at else None,
        },
        "effective": dict(
            zip(
                ("decision", "amount", "remark"),
                ((lambda e: (e[0] or None, float(e[1]) if e[1] is not None else None, e[2]))(effective(item))),
            )
        ),
        "applied": item.applied,
    }


def file_json(f) -> dict:
    return {
        "id": f.id,
        "kind": f.kind,
        "kindLabel": f.get_kind_display(),
        "filename": f.filename,
        "size": f.size,
        "sentTo": f.sent_to,
        "emailStatus": f.email_status or None,
        "createdBy": f.created_by or None,
        "createdAt": f.created_at.isoformat() if f.created_at else None,
    }


def link_json(batch: B) -> dict | None:
    """The latest review link e-mailed to the auditor (never its token): to whom, when, until when, opened, answered."""
    link = batch.auditor_links.order_by("-created_at", "-id").first()
    if link is None:
        return None
    now = _now()
    return {
        "sentTo": link.sent_to,
        "createdAt": link.created_at.isoformat() if link.created_at else None,
        "createdBy": link.created_by or None,
        "expiresAt": link.expires_at.isoformat(),
        "expired": link.expires_at <= now,
        "revoked": link.revoked_at is not None,
        "firstOpenedAt": link.first_opened_at.isoformat() if link.first_opened_at else None,
        "lastOpenedAt": link.last_opened_at.isoformat() if link.last_opened_at else None,
        "openCount": link.open_count,
        "submittedAt": link.submitted_at.isoformat() if link.submitted_at else None,
        "decision": link.decision or None,
        "active": link.revoked_at is None and link.submitted_at is None and link.expires_at > now,
    }


def batch_json(batch: B, *, viewer: str) -> dict:
    """One batch for the HRMS (`viewer` "hr": bank details, HR actions) or the MD portal ("md")."""
    items = list(batch.items.all())
    md_done = sum(1 for i in items if i.md_decision)

    def outcome(i):  # the settlement as it stands: the auditor's change on HR's final decision, else the MD's decision
        return effective(i)[0] if i.final_decision else i.md_decision

    approved = [i for i in items if outcome(i) == I.DECISION_APPROVED]
    rejected = [i for i in items if outcome(i) == I.DECISION_REJECTED]
    requested = sum((requested_of(i.advance) for i in items), Decimal("0"))
    md_total = sum((Decimal(i.md_amount) for i in items if i.md_amount is not None), Decimal("0"))
    final_total = sum(
        (
            Decimal(i.final_amount)
            for i in items
            if i.final_decision == I.DECISION_APPROVED and i.final_amount is not None
        ),
        Decimal("0"),
    )
    flags = [(i.advance.leave_days_1_20) for i in items]
    from ..advance_earnings import leave_flag

    st = batch.stage
    hr = viewer == "hr"
    files = list(batch.files.all()) if hr else []
    return {
        "id": batch.id,
        "advanceType": batch.advance_type,
        "typeLabel": TYPES.get(batch.advance_type, "Advance"),
        "title": f"{TYPES.get(batch.advance_type, 'Advance')} · Batch {batch.number}",
        "month": batch.month,
        "year": batch.year,
        "number": batch.number,
        "label": f"Batch {batch.number}",
        "stage": st,
        "stageLabel": batch.get_stage_display(),
        "nextAction": NEXT_ACTION.get(st, ""),
        "tracker": tracker_json(batch, len(items)),
        "counts": {
            "total": len(items),
            "mdDecided": md_done,
            "approved": len(approved),
            "rejected": len(rejected),
            "undecided": len(items) - len(approved) - len(rejected),
            "warning": sum(1 for d in flags if leave_flag(d) == "warning"),
            "critical": sum(1 for d in flags if leave_flag(d) == "critical"),
        },
        "amounts": {
            "requested": float(requested),
            "mdApproved": float(md_total),
            "finalApproved": float(final_total),
            # what will be paid: HR's final settlement with the auditor's changes
            "payable": float(_totals(batch)["total"]) if batch.finalized_at else float(final_total),
        },
        "forwardedAt": batch.forwarded_at.isoformat() if batch.forwarded_at else None,
        "forwardedBy": batch.forwarded_by or None,
        "hrNote": batch.hr_note,
        "mdConfirmedAt": batch.md_confirmed_at.isoformat() if batch.md_confirmed_at else None,
        "mdConfirmedBy": batch.md_confirmed_by or None,
        "mdNote": batch.md_note,
        "finalizedAt": batch.finalized_at.isoformat() if batch.finalized_at else None,
        "finalizedBy": batch.finalized_by or None,
        "finalizedVia": batch.finalized_via or None,  # "hr" | "md" (Direct to Auditor)
        "finalNote": batch.final_note,
        "auditor": {
            "sentAt": batch.auditor_sent_at.isoformat() if batch.auditor_sent_at else None,
            "sentBy": batch.auditor_sent_by or None,
            "recipients": batch.auditor_recipients or [],
            "confirmedAt": batch.auditor_confirmed_at.isoformat() if batch.auditor_confirmed_at else None,
            "confirmedBy": batch.auditor_confirmed_by or None,
            "note": batch.auditor_note,
            # the Auditor Review Portal (2026-11-27): the auditor's answer, their changes and HR's review of them
            "outcome": batch.auditor_outcome or None,
            "submittedAt": batch.auditor_submitted_at.isoformat() if batch.auditor_submitted_at else None,
            "submittedNote": batch.auditor_submitted_note,
            "changes": sum(1 for i in items if i.auditor_action in ("reduce", "reject")),
            "remarks": sum(1 for i in items if (i.auditor_remark or "").strip()),
            "changesAcceptedAt": batch.changes_accepted_at.isoformat() if batch.changes_accepted_at else None,
            "changesAcceptedBy": batch.changes_accepted_by or None,
            "changesNote": batch.changes_note,
            "link": link_json(batch) if hr else None,
        },
        "accounts": {
            "sentAt": batch.accounts_sent_at.isoformat() if batch.accounts_sent_at else None,
            "sentBy": batch.accounts_sent_by or None,
            "recipients": batch.accounts_recipients or [],
            "sentVia": batch.accounts_sent_via or None,  # "hr" | "auditor"
        },
        "completedAt": batch.completed_at.isoformat() if batch.completed_at else None,
        "history": batch.history or [],
        "files": [file_json(f) for f in files],
        "items": [item_json(i, include_bank=hr) for i in items],
        "actions": {
            "canEditHrNotes": hr and st == B.STAGE_HR_REVIEW,
            "canForward": hr and st == B.STAGE_HR_REVIEW and bool(items),
            "canDecideMd": (not hr) and st == B.STAGE_MD_REVIEW,
            "canConfirmMd": (not hr) and st == B.STAGE_MD_REVIEW and md_done == len(items) and bool(items),
            "canEditFinal": hr and st == B.STAGE_HR_FINAL,
            "canFinalize": hr and st == B.STAGE_HR_FINAL,
            "canSendAuditor": hr and st == B.STAGE_AUDITOR_SEND,
            "canResendAuditor": hr and st == B.STAGE_AUDITOR_REVIEW,
            "canConfirmAuditor": hr and st == B.STAGE_AUDITOR_REVIEW,
            "canAcceptAuditorChanges": hr and st == B.STAGE_AUDITOR_CHANGES,
            "canSendAccounts": hr and st == B.STAGE_ACCOUNTS_SEND and bool(approved),
            "canCompleteWithoutBankFile": hr and st == B.STAGE_ACCOUNTS_SEND and not approved,
            "canResendAccounts": hr and st == B.STAGE_COMPLETED and bool(approved) and bool(batch.accounts_sent_at),
        },
    }


def month_json(month: int, year: int, *, viewer: str, advance_type: str) -> dict:
    """One type's month as the page draws it: its batches (oldest first) and the month's numbers."""
    batches = list(batches_of(month, year, advance_type))
    raised = raised_in(month, year).filter(advance_type=advance_type)
    in_batches = {i.advance_id for b in batches for i in b.items.all()}
    outside = raised.exclude(id__in=in_batches).count() if viewer == "hr" else 0
    received = sum(len(b.items.all()) for b in batches)
    current = next((b for b in batches if b.stage != B.STAGE_COMPLETED), batches[-1] if batches else None)
    today = ist_today()
    return {
        "method": method(),
        "advanceType": advance_type,
        "typeLabel": TYPES[advance_type],
        "month": month,
        "year": year,
        "isCurrentMonth": (month, year) == (today.month, today.year),
        "received": received,
        "outsideWorkflow": outside,
        "currentBatchId": current.id if current else None,
        "tracker": tracker_json(current, received) if current or not batches else tracker_json(None, received),
        "batches": [batch_json(b, viewer=viewer) for b in batches],
    }


def overview_json(month: int, year: int) -> dict:
    """The Loan & Advance main page: both types side by side for the month - the current batch of each (stage, what to do
    next, counts, amounts, tracker), how many batches, and how many of each type wait for the MD."""
    today = ist_today()
    types = []
    for advance_type, label in TYPES.items():
        batches = list(batches_of(month, year, advance_type))
        current = next((b for b in batches if b.stage != B.STAGE_COMPLETED), batches[-1] if batches else None)
        received = sum(len(b.items.all()) for b in batches)
        current_json = batch_json(current, viewer="hr") if current is not None else None
        if current_json is not None:
            current_json.pop("items", None)
            current_json.pop("files", None)
            current_json.pop("history", None)
        types.append(
            {
                "advanceType": advance_type,
                "label": label,
                "received": received,
                "batchCount": len(batches),
                "completed": sum(1 for b in batches if b.stage == B.STAGE_COMPLETED),
                "waitingForMd": sum(1 for b in batches if b.stage == B.STAGE_MD_REVIEW),
                "currentBatch": current_json,
                "tracker": tracker_json(current, received),
            }
        )
    return {
        "method": method(),
        "month": month,
        "year": year,
        "isCurrentMonth": (month, year) == (today.month, today.year),
        "types": types,
    }
