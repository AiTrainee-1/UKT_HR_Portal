"""MD portal: the Dashboard. "How is the company today, what changed, and what needs me?"

The Dashboard calculates nothing of its own. It COMPOSES what the other pages already compute: every module exports
``headline()`` (the cards) and ``insights()`` (the exceptions), and the trend charts reuse the modules' own trend
functions. So a figure on the Dashboard is the figure the page behind it shows for the same period, by construction,
and the assistant that quotes the Dashboard cannot disagree with the pages either.

What this module adds is judgement about *presentation*:

* which eight cards the MD sees first (``KPI_PRIORITY``), and how the strip stays full when a module is down;
* one exceptions list from seven pages: de-duplicated, most serious first, taking turns between pages so that one noisy
  page cannot fill it (``merge_insights``);
* a deterministic briefing: a few plain sentences with the numbers, written by fixed rules (``build_briefing``): no AI,
  no quota, instant, and always in agreement with the cards;
* today's attendance by unit, from the punch log (``units_today``).

Failure isolation. The Dashboard is the first screen after sign-in, so a module that fails (a bad row, a slow query,
an import error in code that is still being written) must cost the MD that module's cards and nothing else. Every call
into a module runs in its own savepoint with a statement timeout (``_guarded``): the module becomes an error entry in
``sources`` plus a note, and every other module still answers. A degraded answer is never kept in the short cache, so
"Retry" really recomputes.

Everything here is read-only; the REST views and the assistant tools run inside ``common.read_only_db()``.
"""

from __future__ import annotations

import copy
import importlib
import logging
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, NamedTuple

from django.db import connection, transaction
from django.db.models import Count, Q

from ...clock import ist_now, ist_today
from ...models import AttendanceDayRecord
from ..assistant.tools_base import integer_param, string_param, tool
from ..common import Period, Scope, TtlCache, add_months, cache_seconds, change, envelope, prov
from ..pages import PAGE_BY_ID

logger = logging.getLogger(__name__)

# ─── rules (named, and quoted in the provenance so the MD can see how the page decides) ──────────────────────────────

MAX_KPIS = 8
MAX_INSIGHTS = 8
GOOD_NEWS_LIMIT = 2  # good-news lines in the exceptions list: enough to be kind, not enough to bury a problem
STATEMENT_TIMEOUT_MS = 8000  # one database statement of one module; the same limit the assistant's free-form query has
TOTAL_BUDGET_SECONDS = 20  # all the module calls of one answer: once it is spent the rest are skipped, not waited for
MEMO_SECONDS = 30  # the composed answers are kept this long (never when something failed, never in tests)
WEAKEST_MIN_EXPECTED = 10  # a unit or department needs this many people scheduled to be called "weakest" (matches
# attendance.UNIT_TODAY_MIN_HEADCOUNT: a team of three at 66% is not news)
LATE_MIN_COVERAGE = (
    0.9  # late arrivals are shown only when day records exist for this share of the people who punched in
)
DEFAULT_SETTLED_HOUR = 11  # before this hour people are still arriving; attendance.UNIT_TODAY_AFTER_HOUR is the source

SEVERITIES = ("critical", "warning", "info", "good")
SEVERITY_RANK = {name: rank for rank, name in enumerate(SEVERITIES)}
BRIEFING_QUESTION = "Give me a briefing on how the company is doing today"

#: The cards, most important first. The first eight that exist are shown, so when a module is down (or has nothing yet)
#: a reserve slides in at the end and the strip stays full. Pairs read together on a phone (two columns): people,
#: absence, leaving, money, overtime, hiring, visitors.
KPI_PRIORITY = (
    "employees.headcount",
    "attendance-today",
    "absenteeism-30d",
    "employees.attrition-12m",
    "payroll-gross",
    "payroll-overtime",
    "recruitment.open_positions",
    "visitors-today",
    # reserves
    "late-30d",
    "payroll-cost-per-head",
    "recruitment.joined_this_month",
    "recruitment.pending_resignations",
    "outpasses-today",
    "tea-break.overrun-pct",
    "tea-break.minutes-lost",
    "activity.sensitive",
    "employees.joiners-leavers",
)

#: The provenance entries (by the module's own id) that explain a card. A card not listed here shows all of its module's.
KPI_PROVENANCE: dict[str, tuple[str, ...]] = {
    "attendance-today": ("live-today",),
    "absenteeism-30d": ("absenteeism-pct",),
    "late-30d": ("late-pct",),
    "employees.headcount": ("headcount",),
    "employees.attrition-12m": ("attrition",),
    "payroll-gross": ("gross-pay", "payroll-status"),
    "payroll-overtime": ("overtime",),
    "payroll-cost-per-head": ("cost-per-head",),
    "recruitment.open_positions": ("open-positions", "vacancies"),
    "recruitment.pending_resignations": ("resignations-pending",),
    "tea-break.overrun-pct": ("tea-overrun",),
    "tea-break.minutes-lost": ("tea-minutes-lost",),
}

# Ids the briefing reads from the cards (a missing one just leaves its clause out).
K_ATTENDANCE_TODAY = "attendance-today"
K_ATTRITION = "employees.attrition-12m"
K_OPEN_POSITIONS = "recruitment.open_positions"
K_PENDING_RESIGNATIONS = "recruitment.pending_resignations"


@dataclass(frozen=True)
class Source:
    """One analytics module the Dashboard reads, and the MD page its figures live on."""

    module: str  # api/md_portal/analytics/<module>.py
    page: str  # the page id (pages.py)

    @property
    def title(self) -> str:
        return PAGE_BY_ID[self.page]["title"]


#: In the order that breaks ties (the first module's items come first among equals).
SOURCES: tuple[Source, ...] = (
    Source("attendance", "attendance"),
    Source("employees", "employees"),
    Source("payroll", "payroll"),
    Source("recruitment", "recruitment"),
    Source("visitors", "visitors"),
    Source("tea_break", "tea-break"),
    Source("activity", "activity"),
)
SOURCE_BY_MODULE = {s.module: s for s in SOURCES}
ATTENTION_PAGES = tuple(s.page for s in SOURCES)


def _analytics(module: str) -> Any:
    """The analytics module, imported when first needed: one that fails to import fails ITS section, not the Dashboard."""
    return importlib.import_module(f"{__package__}.{module}")


# ─── running a module without letting it take the dashboard down ────────────────────────────────────────────────────


class Outcome(NamedTuple):
    value: Any
    error: str | None
    ms: int


def _guarded(label: str, fn: Callable[[], Any]) -> Outcome:
    """Run ``fn`` so that any failure is contained. A savepoint, because a database error aborts the surrounding
    transaction and every later query of the other modules would fail with it; a statement timeout, so "slow" becomes
    "failed" instead of "the Dashboard never opens". The timeout lives as long as the read-only transaction does."""
    started = time.monotonic()
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
            value = fn()
        return Outcome(value, None, int((time.monotonic() - started) * 1000))
    except Exception:  # noqa: BLE001 - whatever one module does wrong, the Dashboard still opens
        logger.exception("MD dashboard: %s failed", label)
        return Outcome(None, f"{label} could not be loaded just now.", int((time.monotonic() - started) * 1000))


class Health:
    """Per module: did it answer, how long it took, how much it contributed. Becomes ``sources`` in the response. Every
    call into a module goes through ``run`` so that it is contained, timed and accounted for in one place."""

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.rows: dict[str, dict] = {
            s.module: {"title": s.title, "page": s.page, "ok": True, "tookMs": 0, "kpis": 0, "insights": 0}
            for s in SOURCES
        }

    def run(self, module: str, fn: Callable[[], Any]) -> Outcome:
        """``fn`` for ``module``. When the answer's time budget is already spent the call is skipped (a clear error
        entry) instead of waited for: a few slow modules must not add up to a Dashboard that never opens."""
        row = self.rows[module]
        if time.monotonic() - self.started > TOTAL_BUDGET_SECONDS:
            outcome = Outcome(None, f"{row['title']} was skipped: the Dashboard ran out of time.", 0)
        else:
            outcome = _guarded(row["title"], fn)
        row["tookMs"] += outcome.ms
        if outcome.error and row["ok"]:
            row["ok"] = False
            row["error"] = outcome.error
        return outcome

    def count(self, module: str, *, kpis: int = 0, insights: int = 0) -> None:
        self.rows[module]["kpis"] += kpis
        self.rows[module]["insights"] += insights

    def failed(self) -> list[dict]:
        return [row for row in self.rows.values() if not row["ok"]]

    def notes(self) -> list[str]:
        return [f"{row['title']} could not be loaded, so what it adds is missing here." for row in self.failed()]


# ─── formatting (the same text the cards show: lib/md/format.ts) ────────────────────────────────────────────────────


def _indian(value: float | int, places: int = 0) -> str:
    """1234567.5 -> "12,34,567.5" (Indian grouping, as the screens write numbers)."""
    sign = "-" if value < 0 else ""
    whole, _, fraction = f"{abs(value):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{sign}{whole}.{fraction}" if places else f"{sign}{whole}"


def _trim(value: float, places: int) -> str:
    return f"{round(value, places):g}"


def inr_compact(value: float | int | None) -> str | None:
    """₹45,200 · ₹12.4 L · ₹1.25 Cr (under a lakh it stays exact)."""
    if value is None:
        return None
    sign = "-" if value < 0 else ""
    size = abs(value)
    if size >= 1e7:
        return f"{sign}₹{_trim(size / 1e7, 2)} Cr"
    if size >= 1e5:
        return f"{sign}₹{_trim(size / 1e5, 1)} L"
    return f"{sign}₹{_indian(round(size))}"


def _minutes(value: float) -> str:
    m = round(value)
    return f"{m}m" if m < 60 else f"{m // 60}h {m % 60:02d}m"


def kpi_display(kpi: dict) -> str | None:
    """A card's figure as text, by its declared format ("pct" -> "91.8%", "inr_compact" -> "₹12.4 L"); None = no data."""
    value = kpi.get("value")
    if value is None:
        return None
    fmt = kpi.get("format")
    if fmt == "text":
        return str(value)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if fmt == "pct":
        return f"{_trim(number, 1)}%"
    if fmt == "inr_compact":
        return inr_compact(number)
    if fmt == "inr":
        return f"{'-' if number < 0 else ''}₹{_indian(abs(round(number)))}"
    if fmt == "minutes":
        return _minutes(number)
    return _indian(number, 0 if number.is_integer() else 1)


def _pct(value: float) -> str:
    return f"{_trim(value, 1)}%"


def _n(value: float | int) -> str:
    return _indian(int(value))


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _sentence(text: str) -> str:
    """The text as a sentence: one full stop at the end, whatever it came with."""
    text = text.strip()
    return text if text.endswith((".", "!", "?")) else f"{text}."


# ─── cards ──────────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Collected:
    """What one module contributed to one kind of call (cards or exceptions)."""

    source: Source
    items: list[dict] = field(default_factory=list)
    provenance: list[dict] = field(default_factory=list)


def _normalise_kpi(raw: Any, src: Source) -> dict | None:
    """A copy of a module's card with the Dashboard's keys (the module's own dict is cached and shared: never edit it)."""
    if not isinstance(raw, dict) or not raw.get("id") or not raw.get("label"):
        return None
    delta = raw.get("delta")
    spark = raw.get("spark")
    return {
        "id": str(raw["id"]),
        "module": src.module,
        "label": str(raw["label"]),
        "value": raw.get("value"),
        "format": raw.get("format") or "number",
        "sub": raw.get("sub"),
        "delta": dict(delta) if isinstance(delta, dict) else None,
        "spark": list(spark) if spark else None,
        "page": raw.get("page") if raw.get("page") in PAGE_BY_ID else src.page,
    }


def pick_kpis(found: list[Collected], limit: int = MAX_KPIS) -> list[dict]:
    """The cards to show: ``KPI_PRIORITY`` order, then whatever else exists, at most ``limit``. A card id offered twice
    keeps the first (modules are walked in ``SOURCES`` order)."""
    by_id: dict[str, dict] = {}
    for collected in found:
        for kpi in collected.items:
            by_id.setdefault(kpi["id"], kpi)
    chosen: list[str] = []
    for wanted in (*KPI_PRIORITY, *by_id):
        if wanted in by_id and wanted not in chosen:
            chosen.append(wanted)
        if len(chosen) == limit:
            break
    return [by_id[k] for k in chosen]


def _headline_of(src: Source, today: date | None) -> Collected:
    raw = _analytics(src.module).headline(today=today)
    kpis = [k for k in (_normalise_kpi(x, src) for x in raw.get("kpis") or []) if k]
    entries = [dict(p) for p in raw.get("provenance") or [] if isinstance(p, dict) and p.get("id")]
    return Collected(src, kpis, entries)


def collect_headlines(today: date | None, health: Health) -> list[Collected]:
    found = []
    for src in SOURCES:
        outcome = health.run(src.module, lambda s=src: _headline_of(s, today))
        collected = outcome.value or Collected(src)
        health.count(src.module, kpis=len(collected.items))
        found.append(collected)
    return found


# ─── exceptions ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _normalise_insight(raw: Any, src: Source, index: int) -> dict | None:
    if not isinstance(raw, dict) or not str(raw.get("title") or "").strip():
        return None
    severity = raw.get("severity") if raw.get("severity") in SEVERITY_RANK else "info"
    return {
        "id": str(raw.get("id") or f"{src.module}.item-{index}"),
        "module": src.module,
        "severity": severity,
        "title": str(raw["title"]).strip(),
        "detail": raw.get("detail"),
        "metric": raw.get("metric"),
        "page": raw.get("page") if raw.get("page") in PAGE_BY_ID else src.page,
        "ask": raw.get("ask"),
    }


def _insights_of(src: Source, today: date | None) -> Collected:
    raw = _analytics(src.module).insights(today=today)
    items = [i for i in (_normalise_insight(x, src, n) for n, x in enumerate(raw or [])) if i]
    return Collected(src, items)


def collect_insights(today: date | None, health: Health) -> list[Collected]:
    found = []
    for src in SOURCES:
        outcome = health.run(src.module, lambda s=src: _insights_of(s, today))
        collected = outcome.value or Collected(src)
        health.count(src.module, insights=len(collected.items))
        found.append(collected)
    return found


def merge_insights(
    found: list[Collected], limit: int = MAX_INSIGHTS, good_limit: int = GOOD_NEWS_LIMIT
) -> tuple[list[dict], int]:
    """One list from seven: repeats removed (same id, or the same title), most serious first, and within one level the
    pages take turns, so a page with five warnings cannot push every other page's warning off the list. Returns the
    first ``limit`` items (at most ``good_limit`` of them good news) and how many there were in all."""
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    queues: dict[str, list[list[dict]]] = {severity: [] for severity in SEVERITIES}
    for collected in found:
        by_severity: dict[str, list[dict]] = {}
        for item in collected.items:
            title_key = item["title"].casefold()
            if item["id"] in seen_ids or title_key in seen_titles:
                continue
            seen_ids.add(item["id"])
            seen_titles.add(title_key)
            by_severity.setdefault(item["severity"], []).append(item)
        for severity, queue in by_severity.items():
            queues[severity].append(queue)
    ordered: list[dict] = []
    for severity in SEVERITIES:
        depth = max((len(q) for q in queues[severity]), default=0)
        for turn in range(depth):
            ordered.extend(q[turn] for q in queues[severity] if turn < len(q))
    picked: list[dict] = []
    good = 0
    for item in ordered:
        if item["severity"] == "good":
            if good >= good_limit:
                continue
            good += 1
        picked.append(item)
        if len(picked) == limit:
            break
    return picked, len(ordered)


# ─── today by unit ──────────────────────────────────────────────────────────────────────────────────────────────────


def _late_records(scope: Scope, today: date) -> tuple[dict[int | None, int], int]:
    """Today's computed day records, per unit: how many are flagged late, and how many records there are at all. HR's
    day records are computed lazily (usually after the day), so this is often empty while the day is running."""
    rows = (
        AttendanceDayRecord.objects.filter(scope.employee_q("employee__"), date=today, employee__status="active")
        .order_by()
        .values("employee__branch_id")
        .annotate(records=Count("id"), late=Count("id", filter=Q(is_late=True)))
    )
    late: dict[int | None, int] = {}
    records = 0
    for row in rows:
        late[row["employee__branch_id"]] = row["late"]
        records += row["records"]
    return late, records


def units_today(scope: Scope, today: date) -> dict:
    """Who is in so far today, by unit: the Attendance page's own live count (``live_today``), plus late arrivals when
    the day records are computed far enough to say. Always provisional: the day is still running."""
    live = _analytics("attendance").live_today(scope, today)
    late_by_unit, records = _late_records(scope, today)
    late_known = records > 0 and records >= LATE_MIN_COVERAGE * live["present"]
    rows = []
    for unit in live["byUnit"]:
        late = min(late_by_unit.get(unit.get("id"), 0), unit["present"]) if late_known else None
        rows.append(
            {
                "id": unit.get("id"),
                "name": unit["name"],
                "expected": unit["expected"],
                "present": unit["present"],
                "late": late,
                "leave": unit["leave"],
                "absent": unit["absent"],
                "attendancePct": unit["attendancePct"],
            }
        )
    rows.sort(key=lambda r: (r["attendancePct"] is None, r["attendancePct"] or 0, r["name"]))
    weak = [
        d
        for d in live["byDepartment"]
        if d["expected"] >= WEAKEST_MIN_EXPECTED and d["absent"] > 0 and d["attendancePct"] is not None
    ]
    weakest = min(weak, key=lambda d: (d["attendancePct"], d["name"]), default=None)
    return {
        "date": live["date"],
        "asOf": live["asOf"],
        "provisional": True,
        "isWorkingDay": live["isWorkingDay"],
        "lateKnown": late_known,
        "total": {
            "expected": live["expected"],
            "present": live["present"],
            "late": sum(r["late"] for r in rows) if late_known else None,
            "leave": live["leave"],
            "absent": live["absent"],
            "attendancePct": live["attendancePct"],
        },
        "rows": rows,
        "weakestDepartment": None
        if weakest is None
        else {k: weakest[k] for k in ("name", "expected", "present", "absent", "attendancePct")},
    }


# ─── the briefing ───────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class BriefingInputs:
    """Everything the briefing is written from. Each part may be missing (a module was down, a company with no data):
    the sentence that needs it is then left out, never invented."""

    settled: bool  # the morning rush is over (or the date was pinned)
    kpis: dict[str, dict] = field(default_factory=dict)  # every card by id, not only the eight shown
    insights: list[dict] = field(default_factory=list)  # merged and sorted, before the display cut
    units: dict | None = None
    attendance_average: float | None = None  # the last 30 days' attendance %
    payroll: dict | None = None  # {"label", "gross", "state", "previousLabel", "changePct"}
    hiring: dict | None = None  # this month: {"joiners", "leavers", "net"}
    sources_ok: int = len(SOURCES)


def _line(id_: str, text: str, page: str | None, tone: str = "neutral") -> dict:
    return {"id": id_, "text": text, "page": page, "tone": tone}


def _kpi_value(i: BriefingInputs, kpi_id: str) -> Any:
    return (i.kpis.get(kpi_id) or {}).get("value")


def _attendance_line(i: BriefingInputs) -> dict | None:
    today = _kpi_value(i, K_ATTENDANCE_TODAY)
    average = i.attendance_average
    units = i.units
    tail = f"; attendance has averaged {_pct(average)} over the last 30 days" if average is not None else ""
    if units and units.get("isWorkingDay") is False:
        return _line("attendance", f"Today is a weekly off or a holiday, so nobody is scheduled{tail}.", "attendance")
    if today is None:
        if average is None:
            return None
        return _line("attendance", f"Attendance has averaged {_pct(average)} over the last 30 days.", "attendance")
    if not i.settled:
        total = (units or {}).get("total")
        if total:
            counts = f"{_n(total['present'])} of {_n(total['expected'])} scheduled people have punched in so far"
        else:
            counts = f"attendance is {_pct(today)} so far"
        return _line("attendance", f"It is still early: {counts}{tail}.", "attendance")
    if average is None:
        return _line("attendance", f"Attendance is {_pct(today)} so far today.", "attendance")
    gap = round(today - average, 1)
    base = f"Attendance is {_pct(today)} so far today"
    if abs(gap) < 1:
        return _line("attendance", f"{base}, in line with the 30-day average of {_pct(average)}.", "attendance")
    size = f"{_trim(abs(gap), 1)} {_plural(1 if abs(gap) == 1 else 2, 'point', 'points')}"
    if gap > 0:
        return _line("attendance", f"{base}, {size} above the 30-day average of {_pct(average)}.", "attendance", "good")
    tone = "watch" if gap <= -2 else "neutral"
    return _line("attendance", f"{base}, {size} below the 30-day average of {_pct(average)}.", "attendance", tone)


def _weakest_line(i: BriefingInputs) -> dict | None:
    units = i.units
    if not units or not i.settled or not units.get("isWorkingDay"):
        return None
    rows = units.get("rows") or []
    candidates = [
        r for r in rows if r["expected"] >= WEAKEST_MIN_EXPECTED and r["absent"] > 0 and r["attendancePct"] is not None
    ]
    unit = min(candidates, key=lambda r: (r["attendancePct"], r["name"]), default=None) if len(rows) >= 2 else None
    dept = units.get("weakestDepartment")
    if unit is None and dept is None:
        return None
    parts = []
    if unit:
        parts.append(
            f"{unit['name']} is the weakest unit so far today, at {_pct(unit['attendancePct'])} "
            f"({_n(unit['present'])} of {_n(unit['expected'])} in)"
        )
    if dept:
        if unit:
            parts.append(f"{dept['name']} the weakest department, at {_pct(dept['attendancePct'])}")
        else:
            parts.append(
                f"{dept['name']} is the weakest department so far today, at {_pct(dept['attendancePct'])} "
                f"({_n(dept['present'])} of {_n(dept['expected'])} in)"
            )
    lowest = min(x["attendancePct"] for x in (unit, dept) if x)
    return _line("weakest", f"{', and '.join(parts)}.", "attendance", "watch" if lowest < 85 else "neutral")


def _payroll_line(i: BriefingInputs) -> dict | None:
    p = i.payroll
    if not p or p.get("gross") is None:
        return None
    text = f"Payroll for {p['label']} came to {inr_compact(p['gross'])}"
    pct_change, before = p.get("changePct"), p.get("previousLabel")
    if pct_change is not None and before:
        if pct_change == 0:
            text += f", the same as {before}"
        else:
            text += f", {_trim(abs(pct_change), 1)}% {'more' if pct_change > 0 else 'less'} than {before}"
    if p.get("state") == "in_progress":
        text += " (the month is still running, so this is provisional)"
    return _line("payroll", f"{text}.", "payroll")


def _hiring_line(i: BriefingInputs) -> dict | None:
    clauses = []
    net = None
    if i.hiring:
        joiners, leavers, net = i.hiring["joiners"], i.hiring["leavers"], i.hiring["net"]
        change_text = "no net change" if net == 0 else f"net {net:+d}"
        clauses.append(
            f"this month {_n(joiners)} {_plural(joiners, 'person', 'people')} joined and {_n(leavers)} left "
            f"({change_text})"
        )
    attrition = _kpi_value(i, K_ATTRITION)
    if attrition is not None:
        clauses.append(f"attrition over the last 12 months is {_pct(attrition)}")
    open_positions = _kpi_value(i, K_OPEN_POSITIONS)
    text = "; ".join(clauses)
    if not text:
        return None
    if open_positions is not None:
        text += (
            ", with no positions open"
            if not open_positions
            else f", with {_n(open_positions)} {_plural(open_positions, 'position', 'positions')} open"
        )
    text = text[0].upper() + text[1:] + "."
    return _line("hiring", text, "employees", "watch" if net is not None and net < 0 else "neutral")


def _decisions_line(i: BriefingInputs) -> dict | None:
    kpi = i.kpis.get(K_PENDING_RESIGNATIONS) or {}
    waiting = kpi.get("value")
    if not waiting:
        return None
    verb = "is" if waiting == 1 else "are"
    text = f"{_n(waiting)} {_plural(waiting, 'resignation', 'resignations')} {verb} waiting for a decision"
    sub = str(kpi.get("sub") or "")
    if sub.startswith("Oldest waiting"):
        text += f" ({sub[0].lower() + sub[1:]})"
    return _line("decisions", f"{text}.", "recruitment", "watch")


def _exception_line(i: BriefingInputs) -> dict:
    urgent = [x for x in i.insights if x["severity"] in ("critical", "warning")]
    if urgent:
        top = urgent[0]
        text = f"The most important item: {_sentence(top['title'])}"
        others = len(urgent) - 1
        if others:
            text += (
                f" {others} other {_plural(others, 'item', 'items')} also {_plural(others, 'needs', 'need')} a look."
            )
        return _line("exception", text, top["page"], "watch")
    if i.insights:
        top = i.insights[0]
        lead = (
            "Nothing urgent, and some good news"
            if top["severity"] == "good"
            else "Nothing urgent. For your information"
        )
        tone = "good" if top["severity"] == "good" else "neutral"
        return _line("exception", f"{lead}: {_sentence(top['title'])}", top["page"], tone)
    if i.sources_ok == 0:
        return _line("exception", "The exception checks could not run just now.", None)
    return _line(
        "exception",
        "Nothing across attendance, people, payroll, hiring, visitors, tea breaks or system activity needs your "
        "attention right now.",
        None,
        "good",
    )


def build_briefing(i: BriefingInputs) -> dict:
    """Four to six plain sentences with the numbers, each carrying the page it came from: attendance today against its
    30-day average, the weakest unit or department, last month's payroll and its change, hiring and attrition, any
    resignations waiting, and the one exception that matters most. Fixed rules, no AI: it is instant and cannot say
    anything the cards do not."""
    writers = (_attendance_line, _weakest_line, _payroll_line, _hiring_line, _decisions_line, _exception_line)
    sentences = [line for line in (write(i) for write in writers) if line]
    return {
        "sentences": sentences,
        "text": " ".join(s["text"] for s in sentences),
        "ask": BRIEFING_QUESTION,
    }


# ─── the facts the briefing needs beyond the cards ──────────────────────────────────────────────────────────────────


def _attendance_average(today: date) -> float | None:
    """The last 30 days' attendance %: the average the Attendance page's trend chart shows for that period."""
    period = Period(today - timedelta(days=29), today, "last_30_days", "Last 30 days")
    average = _analytics("attendance").attendance_trend(Scope(), period).get("average") or {}
    return average.get("attendancePct")


def _payroll_facts() -> dict | None:
    """The latest closed month's gross pay, the month before it, and the month's state (from the Payroll page's own
    trend). The Payroll page picks the month: the latest that has ended and has salary slips."""
    result = _analytics("payroll").payroll_trend(Scope(), None, 2)
    with_data = {r["month"]: r for r in result.get("months") or [] if r.get("hasData")}
    current = with_data.get(result.get("month"))
    if not result.get("hasData") or current is None:
        return None
    year, month = (int(part) for part in current["month"].split("-"))
    # the month right before it, as the card's change compares (a gap in the history is not "last month")
    before = with_data.get("%04d-%02d" % add_months(year, month, -1))
    moved = change(current["grossPay"], before["grossPay"]) if before else None
    return {
        "label": current["label"],
        "gross": current["grossPay"],
        "state": current.get("state"),
        "previousLabel": before["label"] if before else None,
        "changePct": moved["pct"] if moved else None,
    }


def _hiring_facts(today: date) -> dict | None:
    """Joiners and leavers this month: the Employees page's own movement figures for "This month"."""
    period = Period(today.replace(day=1), today, "this_month", "This month")
    totals = _analytics("employees").movement(Scope(), period, today=today).get("totals")
    if not totals:
        return None
    return {k: totals[k] for k in ("joiners", "leavers", "net")}


def _settled_hour() -> int:
    try:
        return int(getattr(_analytics("attendance"), "UNIT_TODAY_AFTER_HOUR", DEFAULT_SETTLED_HOUR))
    except Exception:  # noqa: BLE001 - a clock rule must never break the Dashboard
        return DEFAULT_SETTLED_HOUR


# ─── the overview ───────────────────────────────────────────────────────────────────────────────────────────────────

_MEMO = TtlCache(maxsize=16)


def _remembered(key: tuple, build: Callable[[], dict], healthy: Callable[[dict], bool]) -> dict:
    """``build()``, kept for a few seconds so a refresh, the assistant and the page do not repeat fourteen module calls.
    An answer with a failed module is returned once and not kept: the MD's "Retry" must recompute."""
    ttl = min(MEMO_SECONDS, cache_seconds())
    if ttl <= 0:
        return build()
    value = _MEMO.get_or_compute(key, ttl, build)
    if not healthy(value):
        _MEMO.clear()
    return value


def _provenance_entries(found: list[Collected], kpis: list[dict]) -> tuple[list[dict], dict[str, list[str]]]:
    """The module explanations behind the shown cards (ids namespaced by module so two modules cannot collide), and the
    ids each card should show."""
    by_module = {c.source.module: {p["id"]: p for p in c.provenance} for c in found}
    entries: dict[str, dict] = {}
    per_card: dict[str, list[str]] = {}
    for kpi in kpis:
        known = by_module.get(kpi["module"], {})
        wanted = [pid for pid in KPI_PROVENANCE.get(kpi["id"], ()) if pid in known] or list(known)
        ids = []
        for pid in wanted:
            namespaced = f"{kpi['module']}:{pid}"
            entries.setdefault(namespaced, {**known[pid], "id": namespaced})
            ids.append(namespaced)
        per_card[kpi["id"]] = ids
    return list(entries.values()), per_card


def _own_provenance(total_insights: int, units: dict | None) -> dict[str, dict]:
    """The Dashboard's own explanations, by id: the cards, the exceptions, the briefing and the unit count."""
    entries = [
        prov(
            "dashboard-kpis",
            "Headline figures",
            dataset="Each page's own headline figures",
            definition=(
                "Every card is the figure the page named on it shows for the same period, taken as it is: the "
                "Dashboard calculates none of them itself. Open a card to see the page and how its figure is made."
            ),
            filters=["Whole company"],
            caveats=[
                "Attendance today is provisional: the day is still running, so 'not in yet' is not 'absent'.",
                "Payroll figures are for the latest month that has ended and has salary slips.",
            ],
        ),
        prov(
            "dashboard-attention",
            "Needs your attention",
            dataset="Exceptions found by each page",
            definition=(
                "Each page checks its own data for what is unusual or needs a decision (attendance, employees, outpass "
                "and visitors, tea break, payroll, recruitment, system activity). The Dashboard merges them, removes "
                "repeats and puts the most serious first: critical, needs attention, for your information, good news. "
                f"It shows the first {MAX_INSIGHTS}, taking turns between pages so that one page cannot fill the "
                f"list, with at most {GOOD_NEWS_LIMIT} good-news lines."
            ),
            rows=total_insights,
            filters=["Whole company"],
        ),
        prov(
            "dashboard-briefing",
            "Today's briefing",
            dataset="The figures and exceptions on this page",
            definition=(
                "Written by fixed rules from the same figures as the cards, the exceptions list and today's count by "
                "unit: attendance today against its 30-day average, the weakest unit or department, last month's "
                "payroll and its change, hiring and attrition, resignations waiting and the most important exception. "
                "No AI is involved, so it is instant and always agrees with the numbers. Ask the assistant for a "
                "fuller briefing."
            ),
            caveats=[
                f"Before {_settled_hour():02d}:00 the comparison between units is left out: people are still arriving."
            ],
        ),
        prov(
            "dashboard-units",
            "Today by unit",
            dataset="Punch log, employees, approved leave, holidays and the day records computed so far",
            definition=(
                "For each unit: the people scheduled to work today, how many have punched in, how many are on approved "
                "leave and how many are not in yet. Late arrivals are counted from HR's day records for today, and "
                f"only when those exist for at least {round(LATE_MIN_COVERAGE * 100)}% of the people who punched in."
            ),
            formula="in so far ÷ scheduled today",
            rows=(units or {}).get("total", {}).get("expected"),
            caveats=["Provisional: the day is still running, so 'not in yet' is not 'absent'."],
        ),
    ]
    return {e["id"]: e for e in entries}


def _build_overview(today_arg: date | None, scope: Scope) -> dict:
    now = ist_now()
    today = today_arg or now.date()
    settled = today_arg is not None or now.hour >= _settled_hour()
    health = Health()
    headlines = collect_headlines(today_arg, health)
    exceptions = collect_insights(today_arg, health)
    kpis_all = {k["id"]: k for c in reversed(headlines) for k in c.items}  # reversed: the first module wins a repeat
    shown = pick_kpis(headlines)
    merged, total = merge_insights(exceptions)
    everything, _ = merge_insights(exceptions, limit=10_000, good_limit=10_000)

    units_outcome = health.run("attendance", lambda: units_today(scope, today))
    units = units_outcome.value
    company_units = units if scope.is_everyone() else None  # the briefing speaks for the whole company

    def fact(module: str, fn: Callable[[], Any]) -> Any:
        return health.run(module, fn).value

    inputs = BriefingInputs(
        settled=settled,
        kpis=kpis_all,
        insights=everything,
        units=company_units,
        attendance_average=fact("attendance", lambda: _attendance_average(today)),
        payroll=fact("payroll", _payroll_facts),
        hiring=fact("employees", lambda: _hiring_facts(today)),
        sources_ok=sum(1 for row in health.rows.values() if row["ok"]),
    )
    briefing = build_briefing(inputs)

    entries, per_card = _provenance_entries(headlines, shown)
    cards = [{**k, "display": kpi_display(k), "provenanceIds": per_card.get(k["id"], [])} for k in shown]
    notes = health.notes()
    if not scope.is_everyone():
        notes.append(
            f"The cards, exceptions and briefing are for the whole company; today's count by unit is for {scope.describe()}."
        )
    return envelope(
        {
            "today": today.isoformat(),
            "settled": settled,
            "kpis": cards,
            "insights": merged,
            "insightsTotal": total,
            "briefing": briefing,
            "units": units if units_outcome.error is None else {"error": units_outcome.error},
            "sources": health.rows,
        },
        scope=scope,
        provenance=[*_own_provenance(total, units).values(), *entries],
        notes=notes,
    )


def overview(*, today: date | None = None, scope: Scope | None = None) -> dict:
    """The whole first screen in one answer: up to eight cards, the merged exceptions, the briefing, today by unit and
    which modules answered. ``today`` pins the date (tests); without it the factory's clock decides. ``scope`` narrows
    ONLY today's count by unit: the cards and exceptions come from the pages' company-wide ``headline()`` and
    ``insights()``, and the response says so."""
    scope = scope or Scope()
    key = ("overview", scope.key(), today.isoformat() if today else None)
    return _remembered(
        key, lambda: _build_overview(today, scope), lambda d: all(s["ok"] for s in d["sources"].values())
    )


def attention(*, today: date | None = None, limit: int = MAX_INSIGHTS, page: str | None = None) -> dict:
    """Just the merged exceptions (cheaper than the overview: no cards, no units). ``page`` keeps one page's items."""
    health = Health()
    found = collect_insights(today, health)
    if page:
        found = [c for c in found if c.source.page == page]
    items, total = merge_insights(found, limit=limit)
    return envelope(
        {"today": (today or ist_today()).isoformat(), "items": items, "total": total, "sources": health.rows},
        provenance=[_own_provenance(total, None)["dashboard-attention"]],
        notes=health.notes(),
    )


# ─── trends ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def _section(result: dict) -> dict:
    """A module's trend as the Dashboard passes it on: its data, notes and provenance (the envelope's clock and scope
    are the Dashboard's own)."""
    return {k: v for k, v in result.items() if k not in ("generatedAt", "scope", "tookMs")}


def _build_trends(today_arg: date | None, scope: Scope) -> dict:
    today = today_arg or ist_today()
    last_30 = Period(today - timedelta(days=29), today, "last_30_days", "Last 30 days")
    year, month = add_months(today.year, today.month, -11)
    last_12 = Period(date(year, month, 1), today, "last_12_months", "Last 12 months")
    plan = (
        ("attendance", "attendance", lambda: _analytics("attendance").attendance_trend(scope, last_30)),
        ("payroll", "payroll", lambda: _analytics("payroll").payroll_trend(scope, None, 12)),
        ("movement", "employees", lambda: _analytics("employees").movement(scope, last_12, today=today)),
    )
    health = Health()
    sections: dict[str, dict] = {}
    for key, module, run in plan:
        outcome = health.run(module, run)
        sections[key] = {"error": outcome.error} if outcome.error else _section(outcome.value)
    return envelope(
        {"today": today.isoformat(), **sections},
        scope=scope,
        provenance=[
            prov(
                "dashboard-trends",
                "Trends",
                dataset="The pages' own trend figures",
                definition=(
                    "Attendance is the Attendance page's trend for the last 30 days (complete days; today is still "
                    "running). Payroll is the Payroll page's 12-month trend of gross pay and people paid, up to the "
                    "latest month that has ended. Joiners and leavers are the Employees page's movement for the last "
                    "12 months. The Dashboard re-uses their calculations and adds none of its own."
                ),
                filters=[scope.describe()],
            )
        ],
        notes=health.notes(),
    )


def trends(*, today: date | None = None, scope: Scope | None = None) -> dict:
    """The three charts: attendance for 30 days, payroll for 12 months with people paid, joiners against leavers for
    12 months. Separate from the overview so the page can paint the cards first. A trend that fails is an
    ``{"error": ...}`` entry; the others still arrive."""
    scope = scope or Scope()
    key = ("trends", scope.key(), today.isoformat() if today else None)
    return _remembered(
        key,
        lambda: _build_trends(today, scope),
        lambda d: not any("error" in d[k] for k in ("attendance", "payroll", "movement")),
    )


# ─── briefing: the compact answer for the route and the assistant ───────────────────────────────────────────────────


def _compact_kpi(kpi: dict) -> dict:
    """A card for a reader that cannot see the screen: the figure as the card writes it, and in words whether the change
    is better or worse (a rise in absenteeism is worse; a rise in attendance is better)."""
    delta = kpi.get("delta") or {}
    moved = delta.get("abs")
    change_text = change_is = None
    if moved is not None:
        if kpi.get("format") == "pct":
            change_text = f"{moved:+g} points"
        elif delta.get("pct") is not None:
            change_text = f"{delta['pct']:+g}%"
        else:
            change_text = f"{moved:+g}"
        good = delta.get("good")
        change_is = (
            "neutral"
            if not moved or good not in ("up", "down")
            else ("better" if (moved > 0) == (good == "up") else "worse")
        )
    return {
        "id": kpi["id"],
        "label": kpi["label"],
        "value": kpi.get("value"),
        "display": kpi.get("display") or kpi_display(kpi),
        "sub": kpi.get("sub"),
        "change": change_text,
        "changeIs": change_is,
        "page": kpi["page"],
    }


def briefing(*, today: date | None = None, scope: Scope | None = None, limit: int = 5) -> dict:
    """The briefing, the top exceptions and the headline figures in ONE answer (what "brief me" needs)."""
    data = overview(today=today, scope=scope)
    return {
        "generatedAt": data["generatedAt"],
        "today": data["today"],
        "scope": data["scope"],
        "briefing": data["briefing"],
        "needsAttention": [dict(i) for i in data["insights"][: max(1, min(limit, MAX_INSIGHTS))]],
        "needsAttentionTotal": data["insightsTotal"],
        "kpis": [_compact_kpi(k) for k in data["kpis"]],
        "sources": data["sources"],
        "provenance": data["provenance"],
        "notes": data["notes"],
    }


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────────

_LIMIT = integer_param(
    f"How many exceptions to include (default 5, at most {MAX_INSIGHTS}).", minimum=1, maximum=MAX_INSIGHTS
)
_PAGE = string_param("Only the exceptions found on this page (omit for all).", enum=list(ATTENTION_PAGES))


def _tool_briefing(*, limit: int = 5) -> dict:
    return copy.deepcopy(briefing(limit=limit))


def _tool_overview(*, limit: int = 5) -> dict:
    data = overview()
    units = data["units"]
    return copy.deepcopy(
        {
            "generatedAt": data["generatedAt"],
            "today": data["today"],
            "kpis": [_compact_kpi(k) for k in data["kpis"]],
            "unitsToday": units
            if "error" in units
            else {
                k: v for k, v in units.items() if k in ("date", "asOf", "isWorkingDay", "lateKnown", "total", "rows")
            },
            "needsAttention": data["insights"][: max(1, min(limit, MAX_INSIGHTS))],
            "needsAttentionTotal": data["insightsTotal"],
            "sources": data["sources"],
            "provenance": data["provenance"],
            "notes": data["notes"],
        }
    )


def _tool_attention(*, limit: int = MAX_INSIGHTS, page: str | None = None) -> dict:
    return copy.deepcopy(attention(limit=limit, page=page))


TOOLS = [
    tool(
        "company_briefing",
        "The company briefing in ONE lookup: five or six plain sentences with the numbers (attendance today against the "
        "30-day average, the weakest unit or department today, payroll for the last closed month and its change, hiring "
        "and attrition, resignations waiting for a decision, and the single most important exception), plus the top "
        "exceptions from every page and the headline figures with their change. Use it FIRST for 'give me a briefing', "
        "'how is the company doing', 'what should I know today' or 'anything I should worry about', and quote the "
        "sentences: they are the Dashboard's own words and figures. Company-wide only. Today's attendance is "
        "provisional: the day is still running.",
        _tool_briefing,
        page="dashboard",
        scope=False,
        extra={"limit": _LIMIT},
        defaults={"limit": 5},
    ),
    tool(
        "company_overview",
        "Everything the Dashboard page shows, as data: the eight headline figures (each with its value as the card writes "
        "it, what it is compared with and whether the change is better or worse), today's attendance for each unit "
        "(scheduled, in so far, on leave, not in yet, attendance %), the merged exceptions from every page and which "
        "pages could not be read. Use it for questions about the dashboard or the headline numbers, or 'which unit is "
        "weakest today'. Company-wide. Today's figures are provisional; 'not in yet' is not 'absent'.",
        _tool_overview,
        page="dashboard",
        scope=False,
        extra={"limit": _LIMIT},
        defaults={"limit": 5},
    ),
    tool(
        "needs_attention",
        "What needs the Managing Director's attention across the whole company: the exceptions found by attendance, "
        "employees, outpass and visitors, tea break, payroll, recruitment and system activity, merged, repeats removed "
        "and the most serious first (critical, needs attention, for your information, good news). Each has a title with "
        "the number in it, a detail line and the page that shows the evidence. Use it for 'what needs my attention', "
        "'any problems today', 'what should I worry about'. Optionally keep one page's items.",
        _tool_attention,
        page="dashboard",
        scope=False,
        extra={"limit": _LIMIT, "page": _PAGE},
        defaults={"limit": MAX_INSIGHTS},
    ),
]
