"""
In-process progress tracker for bulk WhatsApp sends.

Same pattern as salary_slip_bulk_progress.py / payroll_progress.py -the
actual work (uploading media, sending template messages per employee)
happens synchronously inside the request that's being polled; this module
just lets that work report counters into shared in-memory state so a
concurrent polling request can render a live progress bar. Single-process
in-memory state is sufficient here for the same reason as the other two
trackers: one on-premise Django process, one bulk operation in flight at a
time.

Unlike the salary-slip tracker, this one also accumulates a `failures` list
(employee name/code + the specific WhatsAppMessageLog.error_message) so the
completed UI can show HR exactly who didn't get a message and why -no phone
on file vs. a Meta API error -per the "useful error details" requirement.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "documentType": None,   # "salary_slip" | "id_card" | ...
    "total": 0,
    "completed": 0,
    "succeeded": 0,
    "failed": 0,
    "currentEmployee": None,
    "failures": [],          # [{employeeName, employeeCode, error}]
    "startedAt": None,
    "finishedAt": None,
}


def start(total: int, document_type: str) -> None:
    with _lock:
        _state["stage"] = "running"
        _state["documentType"] = document_type
        _state["total"] = total
        _state["completed"] = 0
        _state["succeeded"] = 0
        _state["failed"] = 0
        _state["currentEmployee"] = None
        _state["failures"] = []
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def step(employee_name: str, employee_code: str, ok: bool, error: str = "") -> None:
    with _lock:
        _state["currentEmployee"] = employee_name
        _state["completed"] += 1
        if ok:
            _state["succeeded"] += 1
        else:
            _state["failed"] += 1
            _state["failures"].append({"employeeName": employee_name, "employeeCode": employee_code, "error": error})


def finish() -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["currentEmployee"] = None
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()


def snapshot() -> dict:
    with _lock:
        return dict(_state)
