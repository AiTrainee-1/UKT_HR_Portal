"""
In-process progress tracker for the bulk resume screening UI.

Structural mirror of payroll_progress.py — purely observational, nothing here
participates in the actual screening (that logic lives in resume_screening_ml.py
and resume_screening_views.py). The bulk-upload view calls start()/step()/finish()
as it works through each resume so the frontend can poll
/recruitment/resume-screening/upload-bulk-progress and render a live progress
indicator, the same pattern as the biometric sync and payroll generation pipelines.

Single-process in-memory state is sufficient here: this app runs one Django
process on-premise and only one bulk screening run is ever in flight at a time.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "total": 0,
    "completed": 0,
    "screened": 0,
    "failed": 0,
    "currentFile": None,
    "startedAt": None,
    "finishedAt": None,
}


def start(total: int) -> None:
    with _lock:
        _state["stage"] = "running"
        _state["total"] = total
        _state["completed"] = 0
        _state["screened"] = 0
        _state["failed"] = 0
        _state["currentFile"] = None
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def step(filename: str, ok: bool) -> None:
    with _lock:
        _state["currentFile"] = filename
        _state["completed"] += 1
        if ok:
            _state["screened"] += 1
        else:
            _state["failed"] += 1


def finish() -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["currentFile"] = None
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()


def snapshot() -> dict:
    with _lock:
        return dict(_state)
