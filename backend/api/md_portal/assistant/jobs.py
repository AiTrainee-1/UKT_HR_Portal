"""Running an answer off the request.

A question takes 3-20 seconds (several Gemini round trips), but the server answers a request in at most ~30 seconds and
runs one worker, so the answer is produced by a background thread while the browser polls the message. The message row
is the job: ``pending`` -> ``running`` -> ``done`` / ``error``. A job whose thread died (a restart) is closed by
``engine.expire_if_stale`` the next time it is polled.

Tests (and anyone who sets ``MD_ASSISTANT_SYNC``) run the job inline instead: a thread would not see the test's
uncommitted data.
"""

from __future__ import annotations

import logging
import sys
import threading

from django.conf import settings
from django.db import close_old_connections, connection

from . import engine

log = logging.getLogger(__name__)

_RUNNING_TESTS = len(sys.argv) > 1 and sys.argv[1] == "test"


def run_inline() -> bool:
    return bool(getattr(settings, "MD_ASSISTANT_SYNC", False)) or _RUNNING_TESTS


def start(message_id: int) -> None:
    if run_inline():
        engine.answer_message(message_id)
        return
    thread = threading.Thread(target=_work, args=(message_id,), name=f"md-assistant-{message_id}", daemon=True)
    thread.start()


def _work(message_id: int) -> None:
    try:
        close_old_connections()
        engine.answer_message(message_id)
    except Exception:  # noqa: BLE001 - answer_message records its own failures; this is the last line of defence
        log.exception("assistant job %s crashed", message_id)
    finally:
        connection.close()
