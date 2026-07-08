"""
In-process progress tracker for the biometric sync pipeline UI.

Purely observational — nothing here participates in connecting to devices or
pulling attendance (that logic lives untouched in biometric_sync.py). The
sync view calls the three functions below immediately before/after processing
each device so the frontend can poll /attendance/sync-progress and render a
live Start → Device → Device → Completed pipeline.

Single-process in-memory state is sufficient here: this app runs one Django
process on-premise and only one sync is ever in flight at a time.
"""

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state: dict = {
    "stage": "idle",       # idle | running | completed
    "devices": [],          # [{ id, label, status }] status: pending|syncing|completed|failed
    "startedAt": None,
    "finishedAt": None,
}


def start(devices: list[dict]) -> None:
    with _lock:
        _state["stage"] = "running"
        _state["devices"] = [
            {"id": d["id"], "label": d["label"], "status": "pending"} for d in devices
        ]
        _state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _state["finishedAt"] = None


def mark(label: str, status: str) -> None:
    with _lock:
        for d in _state["devices"]:
            if d["label"] == label:
                d["status"] = status
                break


def finish() -> None:
    with _lock:
        _state["stage"] = "completed"
        _state["finishedAt"] = datetime.now(timezone.utc).isoformat()


def snapshot() -> dict:
    with _lock:
        return {
            "stage": _state["stage"],
            "devices": [dict(d) for d in _state["devices"]],
            "startedAt": _state["startedAt"],
            "finishedAt": _state["finishedAt"],
        }
