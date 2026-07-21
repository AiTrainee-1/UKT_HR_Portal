"""
In-process progress tracker for the Salary Slip bulk-download / bulk-email UI.

Purely observational, same pattern as payroll_progress.py — the actual work
(building the combined PDF, sending emails) happens synchronously inside the
request that's being polled; this module just lets that work report counters
into shared in-memory state so a concurrent polling request can render a live
progress bar. Single-process in-memory state is sufficient here: this app
runs one Django process on-premise, and download/email operations are always
triggered by one HR user at a time from the Salary Slip page.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "kind": None,           # "pdf" | "email"
    "total": 0,
    "completed": 0,
    "succeeded": 0,
    "failed": 0,
    "currentEmployee": None,
    "startedAt": None,
    "finishedAt": None,
}


def start(total: int, kind: str) -> None:
    with _lock:
        _state["stage"] = "running"
        _state["kind"] = kind
        _state["total"] = total
        _state["completed"] = 0
        _state["succeeded"] = 0
        _state["failed"] = 0
        _state["currentEmployee"] = None
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def step(employee_name: str, ok: bool) -> None:
    with _lock:
        _state["currentEmployee"] = employee_name
        _state["completed"] += 1
        if ok:
            _state["succeeded"] += 1
        else:
            _state["failed"] += 1


def finish() -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["currentEmployee"] = None
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()


def snapshot() -> dict:
    with _lock:
        return dict(_state)
