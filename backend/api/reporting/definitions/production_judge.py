"""How the Report Center reads a PRODUCTION day under the shift-table rules (``api.production_shift_rules``).

From the date the rules take over (``ProductionShiftConfig.rules_effective_from``) a production day is judged by the
group that applies (Day / Night / Sunday ...), its start time, its main out time and the rules' own grace, not by the
legacy punch-1 / punch-4 times and the 10-minute grace. Every report that shows a production day's late, early or
punches calls this module so the screen, the Excel file and the engine give the same answer. Everything here READS:
nothing is saved (a report never writes), and a missing configuration row is never created.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Any, Iterable, Mapping, Sequence

from api import production_shift_rules as psr
from api.models import AttendanceDayRecord, ProductionShiftConfig


def read_config() -> ProductionShiftConfig:
    """The singleton row WITHOUT creating it (``ProductionShiftConfig.get()`` inserts one when it is missing): an unsaved
    default has no effective date, which means the legacy calculation."""
    return ProductionShiftConfig.objects.filter(pk=1).first() or ProductionShiftConfig()


class ProductionJudge:
    """The saved shift-table rules for one report run: loaded at most once, and only when a day of the range is in force."""

    def __init__(self, config: ProductionShiftConfig | None = None):
        self.config = config if config is not None else read_config()

    def ruleset_for(self, d: dt.date):
        """The RuleSet when the new rules judge day ``d``, else None (the legacy calculation)."""
        return psr.rules_for_day(self.config, d)

    def in_force(self, d: dt.date) -> bool:
        return self.ruleset_for(d) is not None

    def judgement(self, rec):
        """Late / early-leave of a stored production day measured against the group that applies, or None when the day is
        not judged by the new rules (earlier than the effective date, switched off, no group for that weekday)."""
        if rec is None or rec.first_punch is None:
            return None
        ruleset = self.ruleset_for(rec.date)
        if ruleset is None:
            return None
        j = psr.judge_day(ruleset, rec.date, rec.first_punch, rec.last_punch)
        return j if j.group is not None else None

    def legacy_note(self, d: dt.date) -> str:
        """Why a day was not judged by the shift table (shown in the 'Rule applied' column)."""
        cfg = self.config
        eff = getattr(cfg, "rules_effective_from", None)
        if not getattr(cfg, "rules_enabled", True):
            return "Previous calculation: the shift-table rules are switched off"
        if eff is None:
            return "Previous calculation: the shift-table rules have no start date yet"
        if d < eff:
            return f"Previous calculation: the shift-table rules start on {eff.strftime('%d-%b-%Y')}"
        return "Previous calculation: no shift group applies on this weekday"


def lookback_days(ruleset) -> int:
    """How many days before a day the punches are read for night-session resolution by default; 0 without rules (nothing
    to resolve). A worker on a longer unbroken run of nights needs one more read (``needs_history`` / ``history_floor``)."""
    return psr.NIGHT_LOOKBACK_DAYS if ruleset is not None else 0


def history_floor(first_day: dt.date) -> dt.date:
    """The earliest day a night chain ending at ``first_day`` can reach (the engine's own cap)."""
    return first_day - dt.timedelta(days=psr.MAX_CHAIN_DAYS)


def manual_days(employee_ids: Iterable[int], date_from: dt.date, date_to: dt.date) -> dict[int, dict[dt.date, tuple]]:
    """{employee id: {date: (shifts earned, is late, left early)}} of the days HR entered by hand. The engine keeps such a
    day exactly as entered (never re-judged) and it never takes part in a night session."""
    out: dict[int, dict[dt.date, tuple]] = defaultdict(dict)
    ids = list(employee_ids)
    if not ids:
        return out
    for emp_id, d, shifts, late, early in AttendanceDayRecord.objects.filter(
        employee_id__in=ids, source="manual", date__gte=date_from, date__lte=date_to
    ).values_list("employee_id", "date", "shifts_earned", "is_late", "early_leave"):
        out[emp_id][d] = (shifts, bool(late), bool(early))
    return out


def employees_needing_history(
    by_ref_by_emp: Mapping[int, Mapping[dt.date, Sequence]],
    first_day: dt.date,
    floor: dt.date,
    ruleset,
    manual_by_emp: Mapping[int, Iterable[dt.date]],
) -> list[int]:
    """Employee ids whose night chain at ``first_day`` has not met a sync point inside the punches read from ``floor``
    on, so the punches back to ``history_floor(first_day)`` must be read too (ONE more query for all of them, exactly
    as the engine does it). ``by_ref_by_emp`` is {employee id: {date: [(seconds, ref)]}}."""
    return [
        emp_id
        for emp_id, by_ref in by_ref_by_emp.items()
        if psr.needs_history(by_ref, first_day, floor, **psr.session_kwargs(ruleset, manual_by_emp.get(emp_id)))
    ]


def resolve_shift_day(
    ruleset,
    d: dt.date,
    by_date: Mapping[dt.date, Sequence[tuple[int, Any]]],
    manual: Iterable[dt.date] = (),
) -> list[tuple[int, Any]]:
    """The punches of shift day ``d`` once night sessions are resolved: [(seconds since d's midnight, ref)], oldest first.

    ``by_date`` is {calendar date: [(seconds since that date's midnight, ref)]}. The engine's own rule: a night session
    only links two days the shift table judges, never a manual (``manual``) day, and only when the closing punch is
    early enough (production_shift_rules.session_kwargs)."""
    return psr.resolve_day(by_date, d, **psr.session_kwargs(ruleset, manual))


def shift_day_punches(
    ruleset,
    d: dt.date,
    by_ref: Mapping[dt.date, Sequence[tuple[int, Any]]],
    manual: Iterable[dt.date] = (),
    blocks_cache: dict | None = None,
) -> list[tuple[int, Any]]:
    """EVERY stored punch of shift day ``d`` (double taps included) as (seconds since d's midnight, ref), oldest first.

    ``by_ref`` is {calendar date: [(seconds since that date's midnight, ref)]} where each ref is unique and its first
    element is the date the punch was stamped on, e.g. ``(date, log id)``. The night-session resolution decides which
    punches belong to the day (a night worker's closing punch made next morning is +86400); each is then expanded to the
    double taps that followed it, so a count of 'stored punches' stays what it says. ``blocks_cache`` may be shared
    between the days of one employee."""
    cache = blocks_cache if blocks_cache is not None else {}
    out: list[tuple[int, Any]] = []
    for secs, ref in resolve_shift_day(ruleset, d, by_ref, manual):
        k = ref[0]
        offset = (k - d).days * 86400
        if k not in cache:
            cache[k] = tap_blocks(by_ref.get(k, ()))
        members = cache[k].get(ref)
        if members:
            out.extend((m_secs + offset, m_ref) for m_secs, m_ref in members)
        else:
            out.append((secs, ref))
    out.sort(key=lambda x: x[0])
    return out


def tap_blocks(secs_refs: Sequence[tuple[int, Any]]) -> dict[Any, list[tuple[int, Any]]]:
    """{leader ref: [the punch and the double taps that follow it]} for one date's raw punches (oldest first), using the
    engine's own double-tap gap, so a resolved punch can be traced back to every stored punch it stands for."""
    blocks: dict[Any, list[tuple[int, Any]]] = {}
    leader_secs: int | None = None
    leader_ref: Any = None
    for secs, ref in sorted(secs_refs, key=lambda x: x[0]):
        if leader_secs is None or secs - leader_secs >= psr.TAP_GAP_S:
            leader_secs, leader_ref = secs, ref
            blocks[leader_ref] = []
        blocks[leader_ref].append((secs, ref))
    return blocks
