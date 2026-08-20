"""
Screening document retention -purges resume files for candidates who were
neither selected nor rejected within 10 days of upload.

"rejected" candidates already have their resume_file cleared immediately at
rejection time (see resume_screening_views.py's candidate_detail() PATCH
handler), and "selected" candidates must never be touched -so this only
ever targets candidates still sitting in uploaded/screened/shortlisted/
not_shortlisted more than 10 days after upload.

Only the file is removed (mirrors the existing rejected-candidate
behavior) -the row and its extracted fields (name/email/score/etc.) are
kept, so screening history/analytics survive even after the resume binary
is gone.
"""

import logging
from datetime import timedelta

from django.utils import timezone

logger = logging.getLogger(__name__)

RETENTION_DAYS = 10

# Candidates in these statuses are never purged: "selected" must be kept
# permanently, "rejected" is already cleared at rejection time (see
# resume_screening_views.py) so re-processing it here would be a no-op.
_EXEMPT_STATUSES = ("selected", "rejected")


def purge_expired_screening_documents() -> dict:
    """Deletes resume_file for any non-selected, non-rejected candidate
    whose upload is older than RETENTION_DAYS. Returns a summary dict."""
    from .models import ScreeningCandidate

    cutoff = timezone.now() - timedelta(days=RETENTION_DAYS)
    qs = (
        ScreeningCandidate.objects
        .exclude(status__in=_EXEMPT_STATUSES)
        .filter(created_at__lt=cutoff)
        .exclude(resume_file="")
    )

    purged = 0
    for candidate in qs.iterator():
        candidate.resume_file.delete(save=False)
        purged += 1

    if purged:
        logger.info("Screening document retention: purged %d expired resume(s)", purged)

    return {"purged": purged, "cutoff": cutoff.isoformat()}
