"""
A visitor's name and Aadhaar, per branch (19 Nov 2026, migration 0165).

A Visitor row is one person for every branch (matched by phone), but the name and the Aadhaar number are what the
person gave at each visit: VisitorVisit.visitor_name / VisitorVisit.aadhaar_number. Every screen, file and report shows
a visit's own copy, so a branch never sees what another branch was told:

  * one visit           -> that visit's own name / Aadhaar (identity, name_expr, aadhaar_expr, name_q);
  * one person, at some branches (People, the desk's returning-visitor look-up, the QR form's check-phone, the
    Report Center's repeat-visitor list) -> the latest visit's copy among the visits the viewer may see
    (latest_visit, latest_name_subquery);
  * a new visit of someone this branch already knows, with a field left blank -> copied from their latest visit at the
    SAME branch only (register paths, the QR form's "Already visited").

The rule for a visit's copy: visitor_name is set on every visit written since 19 Nov 2026 (it is required), so a visit
with visitor_name set uses its own name AND its own Aadhaar (null = none given). A visit with visitor_name null was
written by an older release (the migration filled every visit before it): it falls back to the Visitor row, name and
Aadhaar together. The Visitor row's own name / Aadhaar are never changed after it is made and never shown otherwise.
"""

from __future__ import annotations

from django.db.models import Case, F, OuterRef, Q, Subquery, TextField, When
from django.db.models.functions import Coalesce

from .models import VisitorVisit


def identity(visit: VisitorVisit) -> tuple[str, str | None]:
    """(name, Aadhaar) as given at `visit`, the Visitor row's only for a visit written before 19 Nov 2026 with no copy
    of its own (reads visit.visitor then: select_related it in lists)."""
    if visit.visitor_name is not None:
        return visit.visitor_name, visit.aadhaar_number
    return visit.visitor.name, visit.visitor.aadhaar_number


def visit_name(visit: VisitorVisit) -> str:
    return identity(visit)[0]


def name_expr() -> Coalesce:
    """identity()'s name in SQL, on VisitorVisit rows."""
    return Coalesce(F("visitor_name"), F("visitor__name"), output_field=TextField())


def aadhaar_expr() -> Case:
    """identity()'s Aadhaar in SQL, on VisitorVisit rows (the visit's own, or the Visitor row's for a visit with no name
    of its own). Callers that print it read only Right(Trim(...), 4): the whole number never leaves the database."""
    return Case(
        When(visitor_name__isnull=True, then=F("visitor__aadhaar_number")),
        default=F("aadhaar_number"),
        output_field=TextField(),
    )


def name_q(term: str) -> Q:
    """On VisitorVisit rows: the visit's own name contains `term` (the Visitor row's only for a visit with no name of its
    own)."""
    return Q(visitor_name__icontains=term) | Q(visitor_name__isnull=True, visitor__name__icontains=term)


def latest_visit(visitor_id: int, branch_id: int | None = None) -> VisitorVisit | None:
    """The person's newest visit (at `branch_id` only when given), with its Visitor row, or None."""
    qs = VisitorVisit.objects.filter(visitor_id=visitor_id)
    if branch_id is not None:
        qs = qs.filter(branch_id=branch_id)
    return qs.select_related("visitor").order_by("-visited_at", "-id").first()


def latest_name_subquery(visits) -> Subquery:
    """For a Visitor queryset: the name given at the person's newest visit among `visits` (a VisitorVisit queryset the
    viewer may see, e.g. their branch's), the Visitor row's name when that visit has none of its own. Annotate with
    Coalesce(latest_name_subquery(...), F("name")) so a person whose newest visit predates the change keeps a name."""
    newest = visits.filter(visitor_id=OuterRef("pk")).order_by("-visited_at", "-id")
    return Subquery(newest.values("visitor_name")[:1], output_field=TextField())


def latest_aadhaar_subquery(visits, expression) -> Subquery:
    """For a Visitor queryset: `expression` (built on aadhaar_expr, e.g. its last four digits) of the person's newest
    visit among `visits`."""
    newest = visits.filter(visitor_id=OuterRef("pk")).order_by("-visited_at", "-id")
    return Subquery(newest.annotate(_aadhaar_out=expression).values("_aadhaar_out")[:1], output_field=TextField())
