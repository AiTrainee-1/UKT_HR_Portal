"""
In-process progress tracker for the payroll generation UI.

Purely observational -nothing here participates in computing payroll (that
logic lives untouched in payroll_views.py). The generate_payroll view calls
start()/step()/finish() as it works through each employee so the frontend can
poll /payroll/generate-progress and render a live progress indicator, the
same pattern as attendance/sync_progress.py for the biometric sync pipeline.

Single-process in-memory state is sufficient here: this app runs one Django
process on-premise and only one payroll run is ever in flight at a time.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "total": 0,
    "completed": 0,
    "generated": 0,
    "skipped": 0,
    "currentEmployee": None,
    "startedAt": None,
    "finishedAt": None,
}


# One payroll run (staff or production) at a time in this process. Two runs at once (two HR users pressing Generate,
# or a double click while the first is still working) used to work through the same employees side by side and could
# write a second monthly payroll row for the same person, which then broke every later regeneration of that month
# (app health audit, 2026-11-05).
_run_lock = threading.Lock()


def try_begin_run() -> bool:
    """Claim the payroll run slot; False when another run holds it."""
    return _run_lock.acquire(blocking=False)


def end_run() -> None:
    if _run_lock.locked():
        _run_lock.release()


def start(total: int) -> None:
    with _lock:
        _state["stage"] = "running"
        _state["total"] = total
        _state["completed"] = 0
        _state["generated"] = 0
        _state["skipped"] = 0
        _state["currentEmployee"] = None
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def step(employee_name: str, ok: bool) -> None:
    with _lock:
        _state["currentEmployee"] = employee_name
        _state["completed"] += 1
        if ok:
            _state["generated"] += 1
        else:
            _state["skipped"] += 1


def finish() -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["currentEmployee"] = None
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()


def snapshot() -> dict:
    with _lock:
        return dict(_state)
