"""Settings -> Auto-Reject Requests (owner 2026-11-24): every request nobody decided within N days (45 by default) of being
submitted is rejected automatically, every night at 01:30 India time; resignations never are. See engine.py (which requests
are due), service.py (rejecting one the way its own module does, without WhatsApp), views.py, scheduler.py."""
