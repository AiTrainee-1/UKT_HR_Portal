"""Database hygiene for scheduled jobs.

APScheduler runs jobs on its own pool threads, which Django's request signals never touch. Django replaces a broken or
expired connection only from those signals (or close_old_connections), so after Postgres restarts or drops an idle
connection, a job thread kept failing on the dead connection on every run until the whole process was restarted -- the
WhatsApp attendance alerts would silently stop, logging an error each minute (app health audit, 2026-11-05).
"""

import functools

from django.db import close_old_connections


def fresh_db_connection(job):
    """Run `job` with a usable connection, and release it afterwards (also when the job fails)."""

    @functools.wraps(job)
    def wrapper(*args, **kwargs):
        close_old_connections()
        try:
            return job(*args, **kwargs)
        finally:
            close_old_connections()

    return wrapper
