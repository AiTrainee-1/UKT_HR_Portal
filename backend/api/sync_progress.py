"""
In-process progress tracker for the biometric sync pipeline UI.

Purely observational -nothing here participates in connecting to devices or
pulling attendance (that logic lives untouched in biometric_sync.py). The
sync view calls the functions below immediately before/after processing each
device so the frontend can poll /attendance/sync-biometric-progress and
render a live Start → Device → Device → Completed pipeline.

Since the sync now runs on a background thread (see
attendance_views.sync_biometric_api), this module is also where the *result*
of a finished sync lives: the HTTP request that started it returns straight
away, so there is no response body left to carry the outcome. The frontend
reads it from the final progress poll instead.

Single-process in-memory state is sufficient here: this app runs a single
Django service and only one sync is ever in flight at a time -which
`try_begin()` now enforces rather than assumes.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "devices": [],          # [{ id, label, status }] status: pending|syncing|completed|failed
    "startedAt": None,
    "finishedAt": None,
    # Populated by finish(); the summary dict run_biometric_sync() returns
    # (created counts, unmatched device IDs, per-device errors). None while a
    # sync is running, so the frontend can tell "still working" from "done".
    "result": None,
}


def try_claim() -> bool:
    """Atomically claim the single sync slot. False if one is already running.

    Claiming happens in the HTTP request itself, BEFORE the worker thread is
    spawned -deliberately, not incidentally. Checking `is_running()` and then
    letting the thread call start() leaves a window where two rapid clicks
    both see "idle" and both start a sync. Devices handle one session at a
    time, so the second pull fails confusingly against a device that's
    perfectly healthy. Doing the check and the claim under one lock closes
    that window.

    The device list is filled in later by start(), once the sync thread has
    resolved which devices it's actually going to talk to.
    """
    with _lock:
        if _state["stage"] == "running":
            return False
        _state["stage"] = "running"
        _state["devices"] = []
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None
        _state["result"] = None
        return True


def start(devices: list[dict]) -> None:
    """Populate the device list for the run now in progress.

    Does not reset startedAt/result -the slot may already have been claimed
    by try_claim() in the request thread. Callers that run standalone (the
    `sync_biometric` management command, Auto Sync rules) call this without
    claiming first, which is fine: they don't contend with the UI button.
    """
    with _lock:
        _state["stage"] = "running"
        _state["devices"] = [
            {"id": d["id"], "label": d["label"], "status": "pending"} for d in devices
        ]
        if _state["startedAt"] is None:
            _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def mark(label: str, status: str) -> None:
    with _lock:
        for d in _state["devices"]:
            if d["label"] == label:
                d["status"] = status
                break


def finish(result: dict | None = None) -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()
        if result is not None:
            _state["result"] = result


def is_running() -> bool:
    with _lock:
        return _state["stage"] == "running"


def snapshot() -> dict:
    with _lock:
        return {
            "stage": _state["stage"],
            "devices": [dict(d) for d in _state["devices"]],
            "startedAt": _state["startedAt"],
            "finishedAt": _state["finishedAt"],
            "result": dict(_state["result"]) if _state["result"] else None,
        }
