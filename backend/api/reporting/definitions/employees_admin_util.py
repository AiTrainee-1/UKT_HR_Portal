"""Small helpers shared by the employees_admin report definitions (documents, HOD, recruitment, audit,
user access). Nothing here registers a report."""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta

from django.db.models import Q
from django.utils import timezone

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ

# The HR portal JWT is signed for 12 hours (auth_views.hr_login). A LoginSession row has no expiry column,
# so "still live" means: not revoked AND signed in less than this long ago.
HR_TOKEN_HOURS = 12


def utc_now() -> datetime:
    """Aware 'now'. A module-level function so tests can pin the clock."""
    return timezone.now()


def ist_start(day: date) -> datetime:
    """Midnight IST of ``day`` as an aware datetime (Django stores UTC; the factory works in IST)."""
    return datetime.combine(day, time.min, tzinfo=FACTORY_TZ)


def ist_range_q(field: str, d_from: date | None, d_to: date | None) -> Q:
    """``field`` between two IST calendar days, both inclusive.

    ``created_at__date`` compares UTC dates and misfiles anything logged between 00:00 and 05:30 IST."""
    q = Q()
    if d_from:
        q &= Q(**{f"{field}__gte": ist_start(d_from)})
    if d_to:
        q &= Q(**{f"{field}__lt": ist_start(d_to + timedelta(days=1))})
    return q


def ist_date(value) -> str | None:
    """Aware datetime -> IST calendar date 'YYYY-MM-DD'."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(FACTORY_TZ)
        return value.date().isoformat()
    return str(value)[:10]


def natural_key(text) -> tuple:
    """'E10' sorts after 'E9' (employee codes are digit-bearing text; plain string order puts '100' before '20')."""
    parts = re.split(r"(\d+)", str(text or ""))
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p.lower()) for p in parts if p)


def label(value, fallback: str | None = None) -> str | None:
    """'not_shortlisted' -> 'Not shortlisted'. Free-text status columns hold any string, so never assume a set."""
    if value is None or str(value).strip() == "":
        return fallback
    text = str(value).strip().replace("_", " ")
    return text[:1].upper() + text[1:]


def pct(part, whole) -> float | None:
    """0-100 rounded to one decimal, or None when there is nothing to divide by (never 0 for 'unknown')."""
    if not whole:
        return None
    return round(100.0 * part / whole, 1)


def join_list(value) -> str | None:
    """A JSON list column (skills) -> 'a, b'. Tolerates a plain string or junk."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        text = ", ".join(str(v).strip() for v in value if str(v).strip())
    else:
        text = str(value).strip()
    return text or None


def org_q(ctx, *, dept_field: str, branch_field: str) -> Q:
    """Branch isolation + the Branch / Department filters for rows that reach the organisation through a
    department (Job, Applicant, ScreeningCandidate, HiringRuleSet ...). Rows with no department belong to no
    branch, so a branch-scoped user (or any branch filter) never sees them - they are unscoped-admin only."""
    p = ctx.params
    q = Q()
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        q &= Q(**{branch_field: scope})
    if p.get("branch_ids"):
        q &= Q(**{f"{branch_field}__in": p["branch_ids"]})
    if p.get("department_ids"):
        q &= Q(**{f"{dept_field}__in": p["department_ids"]})
    return q


def employee_qs(ctx):
    """In-scope employees with their org rows. photo_url is often a ~43 KB base64 blob and password_hash is a
    secret: neither is ever loaded by a report."""
    from api.models import Employee

    return (
        Employee.objects.filter(ctx.emp_q())
        .select_related("department", "designation", "branch")
        .defer("photo_url", "password_hash")
    )


def branch_label(emp) -> str:
    return emp.branch.name if emp.branch_id else "No branch"


def status_label(status) -> str:
    """Employee.status is unvalidated text: anything that is not exactly 'active' is not active."""
    return "Active" if status == "active" else "Inactive"


def type_label(employment_type) -> str | None:
    return label(employment_type)


def stored_files(names) -> set[str]:
    """Which of these stored file names still exist in the file storage?

    A FileField value is only a path: a file can be gone while the column still holds it (the retention job
    deletes the stored file without clearing the value, a legacy on-disk file may have vanished with a
    redeploy). New uploads live in Postgres (``FileBlob``) and older ones on disk (``HybridFileStorage``), so
    ask the database ONCE for the whole batch and stat the disk only for what it does not hold - never one query
    per row. When the disk cannot be read the file is assumed present: a report must not claim a removal it
    cannot prove."""
    from django.core.files.storage import FileSystemStorage

    from api.models import FileBlob

    wanted = {n for n in names if n}
    found: set[str] = set()
    ordered = sorted(wanted)
    for i in range(0, len(ordered), 5000):
        found.update(FileBlob.objects.filter(name__in=ordered[i : i + 5000]).values_list("name", flat=True))
    disk = FileSystemStorage()
    for name in wanted - found:
        try:
            if disk.exists(name):
                found.add(name)
        except Exception:  # noqa: BLE001 - unreadable storage: do not claim the file is gone
            found.add(name)
    return found
