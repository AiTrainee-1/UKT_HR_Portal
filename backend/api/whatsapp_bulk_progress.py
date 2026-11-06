"""
Progress of a bulk WhatsApp send (Salary Slip -> Bulk WhatsApp), read from the queue itself.

Since the 2026-11-06 send queue a bulk send no longer sends anything inside the request: it queues one
document row per employee, all carrying the same batch id in their payload
(whatsapp_service.queue_document), and the paced dispatcher sends them one at a time. So the progress
is simply the state of that batch's rows, which also makes it right across processes and restarts:

    queued / sending                 still to go (stage "running")
    sent / delivered / read          succeeded
    failed / expired / skipped       did not go, each with its reason (the `failures` list)

The response keeps the shape the Payslips page already polls (stage, documentType, total, completed,
succeeded, failed, currentEmployee, failures, startedAt, finishedAt), plus queued / expired / skipped /
batchId. Anything still queued at the end of the day expires and is never sent later (owner rule).
"""

import uuid

from django.utils import timezone

_IDLE = {
    "stage": "idle",
    "documentType": None,
    "total": 0,
    "completed": 0,
    "succeeded": 0,
    "failed": 0,
    "queued": 0,
    "expired": 0,
    "skipped": 0,
    "currentEmployee": None,
    "failures": [],
    "startedAt": None,
    "finishedAt": None,
    "batchId": None,
}

_SUCCEEDED = ("sent", "delivered", "read")
_WAITING = ("queued", "sending", "pending")
_DID_NOT_GO = ("failed", "expired", "skipped")

# The newest batch this process started: spares the poll a look-up. After a restart the newest batch of today is found in
# the log instead.
_latest: dict[str, str] = {}


def new_batch(document_type: str) -> str:
    """A fresh batch id for one bulk send of `document_type`."""
    batch_id = uuid.uuid4().hex[:16]
    _latest[document_type] = batch_id
    return batch_id


def latest_batch(document_type: str = "salary_slip") -> str | None:
    """The newest bulk batch of this document type: the one this process started, else the newest one queued today."""
    if document_type in _latest:
        return _latest[document_type]
    from .models import WhatsAppMessageLog
    from .whatsapp_dispatcher import day_start

    payload = (
        WhatsAppMessageLog.objects.filter(
            document_type=document_type, created_at__gte=day_start(), payload__has_key="batch"
        )
        .order_by("-created_at", "-id")
        .values_list("payload", flat=True)
        .first()
    )
    return (payload or {}).get("batch")


def snapshot(batch_id: str | None = None, document_type: str = "salary_slip") -> dict:
    """The progress of one batch (default: the newest of `document_type`)."""
    from .models import WhatsAppMessageLog

    batch_id = batch_id or latest_batch(document_type)
    if not batch_id:
        return dict(_IDLE, failures=[])
    rows = list(
        WhatsAppMessageLog.objects.filter(payload__batch=batch_id)
        .select_related("employee")
        .defer("employee__photo_url", "message_text")  # polled every 1.5 s: never the base64 photo
        .order_by("id")
    )
    if not rows:
        return dict(_IDLE, failures=[])
    counts = {status: 0 for status in (*_SUCCEEDED, *_WAITING, *_DID_NOT_GO)}
    failures, current = [], None
    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1
        name = f"{row.employee.first_name} {row.employee.last_name}".strip()
        if row.status in _DID_NOT_GO:
            failures.append(
                {
                    "employeeName": name,
                    "employeeCode": row.employee.employee_code,
                    "error": row.error_message or row.status,
                }
            )
        elif row.status == "sending":
            current = name
    succeeded = sum(counts[s] for s in _SUCCEEDED)
    failed = sum(counts[s] for s in _DID_NOT_GO)
    waiting = sum(counts[s] for s in _WAITING)
    done = waiting == 0
    return {
        "stage": "completed" if done else "running",
        "documentType": rows[0].document_type,
        "total": len(rows),
        "completed": succeeded + failed,
        "succeeded": succeeded,
        "failed": failed,
        "queued": counts["queued"],
        "expired": counts["expired"],
        "skipped": counts["skipped"],
        "currentEmployee": current,
        "failures": failures,
        "startedAt": min(r.created_at for r in rows).isoformat(),
        "finishedAt": max(r.updated_at for r in rows).isoformat() if done else None,
        "batchId": batch_id,
    }


def queued_message(queued: int, now=None) -> str:
    """What HR is told when a bulk send was queued: how it goes out and that today's leftovers are dropped."""
    from .whatsapp_dispatcher import capacity_today
    from .models import WhatsAppSettings

    if queued == 0:
        return "Nothing was queued."
    s = WhatsAppSettings.get()
    room = capacity_today(now or timezone.now())
    plural = "s" if queued != 1 else ""
    head = (
        f"{queued} message{plural} queued. They go out one at a time, at least {s.min_gap_seconds} seconds apart "
        f"(at most {s.max_per_hour} an hour and {s.max_per_day} a day, never during quiet hours)."
    )
    if room < queued:
        head += (
            f" At the current limits only about {room} can go out today. Anything not sent by the end of today is "
            "dropped (never sent tomorrow): send the rest again tomorrow."
        )
    else:
        head += " Anything not sent by the end of today is dropped, never sent tomorrow."
    return head
