"""Run a job off the request thread.

Production runs gunicorn with ONE sync worker (a request blocks every other request), so anything heavy the tracking
endpoints trigger (a journey rebuild of a long track, the final rebuild when a track ends) goes to a short-lived daemon
thread, one at a time per key. Under the test runner the same call runs INLINE instead: tests never start threads (a
thread would use its own database connection, which cannot see a TestCase's uncommitted rows and would block dropping
the test database), and they see the job's effect immediately.
"""

from __future__ import annotations

import logging
import sys
import threading

from django.conf import settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_running: set = set()


def inline_mode() -> bool:
    """True under the test runner (or when GEO_TRACKING_INLINE_JOBS is set in the Django settings)."""
    flag = getattr(settings, "GEO_TRACKING_INLINE_JOBS", None)
    if flag is not None:
        return bool(flag)
    return len(sys.argv) > 1 and sys.argv[1] == "test"


def run_job(key, fn, *args) -> bool:
    """Run ``fn(*args)`` in a daemon thread unless a job with the same ``key`` is already running (then it is skipped and
    False is returned: the running job reads the newest rows anyway). Inline under the test runner."""
    if inline_mode():
        fn(*args)
        return True
    with _lock:
        if key in _running:
            return False
        _running.add(key)

    def runner() -> None:
        try:
            fn(*args)
        except Exception:
            logger.exception("Geo-tracking background job %s failed", key)
        finally:
            with _lock:
                _running.discard(key)
            from django.db import connections

            connections.close_all()

    threading.Thread(target=runner, name=f"geo-tracking-{key}", daemon=True).start()
    return True


def rebuild_job(track_id: int) -> None:
    """The journey rebuild as a job (what end_track and a late upload queue)."""
    from . import journey

    journey.rebuild(track_id)
