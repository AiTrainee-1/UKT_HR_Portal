"""Gunicorn settings for the cloud (Railway) deployment.

Gunicorn reads this file by itself when it starts in this folder (`gunicorn config.wsgi:application --bind ...`), so the
start command does not change. Options given on the command line still win over these.

Why each value (app health audit, 2026-11-05):
- workers = 1: the scheduled jobs (WhatsApp alerts, OT detection, backups, Auto Sync, ...) start inside every worker
  process, so a second worker would run every job twice (two alerts to each employee, two backups). Do not raise it.
- timeout = 120: gunicorn's default (30 s) killed the worker whenever one request took longer -- a payroll run for the
  whole company, a big export -- leaving the run half done and the site down while the worker restarted. 120 s lets
  such a request finish. Outbound calls (WhatsApp, email, devices) and database statements now have their own,
  shorter limits, so nothing waits that long by accident.
- threads: 1 (the classic "sync" worker: one request at a time) unless GUNICORN_THREADS says otherwise. Several threads
  let one slow request stop blocking everyone else, but the approval and payroll paths must first be made safe for
  requests running at the same moment (row locks): leave it at 1 until then.
- preload_app = False: with preload the app (and the schedulers) would start in the master process instead.
"""

import os

workers = 1
threads = max(1, int(os.environ.get("GUNICORN_THREADS", "1") or 1))
worker_class = "gthread" if threads > 1 else "sync"
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "120") or 120)
graceful_timeout = 30
keepalive = 5
preload_app = False
