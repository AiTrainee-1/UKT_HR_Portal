"""Production attendance reports of the Attendance group (the owner's 2026-11-19 layout, items 2, 5, 6, 7 and 16).

production-attendance-report   the month grid: one row per production worker, one cell per SHIFT DAY with the shifts that
                               day earned (1.00 / 1.25 / 0.75 ...) or A / H / L, and the totals (days worked, absent,
                               late, nights, extra and total shifts). Landscape A3 / A4 PDF and a coloured Excel file.
production-time-card-punches   a time card per worker: every shift day with its group (Day / Night / Sunday / special),
                               every punch (P1 .. Pn), in, out, hours, shifts earned and late / early minutes.
production-shift-ot-punches    each worked shift day split into the regular shift (up to the full-day value, 1.00) and
                               the extra shifts above it, with the time the extra part started, its hours and punches.
production-all-punches         one row per stored production punch with the SHIFT DAY it counts for.
production-attendance-log      the production day log: one row per worker per shift day.

How a production day is read here (the engine's own rules, nothing of its own):

* By SHIFT DAY (``production_judge`` over ``api.production_shift_rules``): from the date the shift-table rules start, a
  night worker's closing punch made the next morning belongs to the day the shift began; the early-arrival guard
  (a morning punch from 06:00 before an 08:30 start is that day's arrival), the close-by time, double taps and the
  worker's SPECIAL shift all apply, with the employee id passed exactly as the engine passes it. Earlier days, and days
  HR entered by hand, keep the calendar date the device stamped.
* The verdict of a day (status, shifts earned, late, early) is the stored ``AttendanceDayRecord``: what production
  payroll reads. Nothing is recomputed and nothing is written. A stored value that is off the 0.25 grid (kept from
  before quarter rounding, 2026-11-18) is shown as stored and flagged Out of date.
* The group, the hours, the late / early minutes and the regular / extra split are read from the punches with the
  engine's helpers (select_group, judge_day, value_at, paid_seconds); they explain the stored figure, never replace it.
"""

from __future__ import annotations

import datetime as dt
import io
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from xml.sax.saxutils import escape

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

from api import production_shift_rules as psr
from api.geo_attendance_views import source_label
from api.models import AttendanceDayRecord, AttendanceLog, BiometricDevice

from .. import filters as F
from ..branding import company
from ..export_pdf import BRAND, GRID, INK, MUTED, ensure_fonts, pdf_text
from ..export_xlsx import HEADER_ROW, build_xlsx
from ..formatting import display_date, full_name
from ..registry import register
from ..runner import KIND_SUBTOTAL, KIND_TOTAL
from ..types import BADGE, DATE, HOURS, INTEGER, MINUTES, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import WEEKDAYS, device_of, emp_days_guard
from .attendance_core_pdf import filter_box, kpi_strip, letterhead, numbered_canvas, style_factory, title_bar
from .employees_master_base import UNASSIGNED, code_key, department_name
from .production_judge import (
    ProductionJudge,
    employees_needing_history,
    history_floor,
    lookback_days,
    manual_days,
    read_config,
    shift_day_punches,
)

CATEGORY = "attendance"
MODULES = ("attendance",)  # attendance verdicts and punches only: no pay is printed
MAX_DAYS = 31  # a month: the widest range every report here offers

GRID_ID = "production-attendance-report"
TIMECARD_ID = "production-time-card-punches"
OT_ID = "production-shift-ot-punches"
PUNCHES_ID = "production-all-punches"
LOG_ID = "production-attendance-log"

DAY_S = psr.DAY_S
QUARTER = psr.QUARTER
FULL_DAY = Decimal("1.00")  # the full-day value when no shift table judges the day (the legacy calculation)
MAX_SLOTS = 10  # P1 .. P10 on the time card; a day with more punches says how many more in P10

LEGACY_GROUP = "Legacy rules"
MANUAL_GROUP = "Manual entry"

STATUS_LABELS = {
    "present": "Present",
    "half_shift": "Half Day",
    "absent": "Absent",
    "on_leave": "Leave",
    "holiday": "Holiday",
}
NOT_PROCESSED = "Not processed"

FLAG_OUT_OF_DATE = "Out of date: stored before quarter rounding"
FLAG_STALE = "Out of date: punches changed after the day was stored"
FLAG_NIGHT = "Closed next morning (+1)"


# ── loading ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RawPunch:
    """One stored AttendanceLog row (as light as a tuple: a month of a roster's punches is tens of thousands)."""

    log_id: int
    on: dt.date  # the date the device stamped
    at: dt.time
    source: str
    stored_type: str


def _secs(t: dt.time) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def _emp_order(emp) -> tuple:
    """Department (A-Z, no department last), then employee code in natural order."""
    name = department_name(emp)
    return (name == UNASSIGNED, name.lower(), code_key(emp.employee_code))


class ShiftDay:
    """One production worker on one SHIFT DAY: the stored verdict and the punches the engine counts for it."""

    __slots__ = (
        "emp",
        "d",
        "rec",
        "ruleset",
        "manual",
        "shown",
        "kept",
        "group",
        "group_label",
        "special",
        "future",
        "_data",
    )

    def __init__(self, data: ProductionData, emp, d: dt.date):
        self._data = data
        self.emp, self.d = emp, d
        self.future = d > data.today
        self.rec = None if self.future else data.records.get((emp.id, d))
        self.ruleset = data.judge.ruleset_for(d)
        manual_e = data.manual.get(emp.id, {})
        self.manual = (self.rec is not None and self.rec.source == "manual") or d in manual_e
        self.shown: list[tuple[int, RawPunch]] = data.shift_day(emp, d, self.ruleset, manual_e)
        gap = self.ruleset.tap_gap_s if self.ruleset is not None else psr.TAP_GAP_S
        self.kept: list[int] = psr.collapse_taps([s for s, _p in self.shown], gap)
        self.group = None
        self.special = False
        if self.manual:
            self.group_label = MANUAL_GROUP
        elif self.ruleset is None:
            self.group_label = LEGACY_GROUP if (self.shown or self.worked) else None
        elif self.kept:
            # the group the engine picks from the shift day's first punch (a special shift for a worker on one that day)
            self.group = psr.select_group(self.ruleset, d, self.kept[0] % DAY_S, emp.id)
            if self.group is None:
                # no group for this weekday: the engine falls back to the legacy calculation
                self.group_label = LEGACY_GROUP
            else:
                self.special = any(g is self.group for g in self.ruleset.special)
                self.group_label = self.group.label + (" (special)" if self.special else "")
        else:
            self.group_label = None

    # -- the stored verdict ---------------------------------------------------
    @property
    def shifts(self) -> Decimal | None:
        return Decimal(self.rec.shifts_earned or 0) if self.rec is not None else None

    @property
    def worked(self) -> bool:
        return self.rec is not None and self.rec.status in ("present", "half_shift") and (self.shifts or 0) > 0

    @property
    def full_value(self) -> Decimal:
        return Decimal(self.ruleset.full_day_value) if self.ruleset is not None else FULL_DAY

    @property
    def unprocessed(self) -> bool:
        return self.rec is None and not self.future

    @property
    def status(self) -> str | None:
        if self.rec is None:
            return NOT_PROCESSED if not self.future else None
        return STATUS_LABELS.get(self.rec.status, self.rec.status)

    @property
    def off_grid(self) -> bool:
        """A day the shift table judges whose stored value is not a quarter: stored before quarter rounding."""
        if self.rec is None or self.manual or self.ruleset is None:
            return False
        return (self.shifts % QUARTER) != 0

    @property
    def stale(self) -> bool:
        """Punches stamped on this date after the verdict was stored (the engine counts the day's own stored punches)."""
        if self.rec is None or self.manual:
            return False
        return len(self._data.raw.get(self.emp.id, {}).get(self.d, ())) != (self.rec.total_punches or 0)

    # -- read from the punches -------------------------------------------------
    @property
    def next_morning(self) -> bool:
        return any(p.on > self.d for _s, p in self.shown)

    @property
    def double_taps(self) -> int:
        return len(self.shown) - len(self.kept)

    @property
    def is_night(self) -> bool:
        """Judged by a night group: its standard leaving time is the next morning (without one, its kind says)."""
        g = self.group
        if g is None:
            return False
        return g.main_out_s >= DAY_S if g.main_out_s is not None else g.kind == "night"

    @property
    def worked_minutes(self) -> int | None:
        """In -> Out of each pair (1st-2nd, 3rd-4th ...), double taps dropped; a last punch with no pair is not counted."""
        k = self.kept
        if len(k) < 2:
            return None
        return sum(k[2 * i + 1] - k[2 * i] for i in range(len(k) // 2)) // 60

    @property
    def hours(self) -> float | None:
        m = self.worked_minutes
        return None if m is None else round(m / 60.0, 2)

    @property
    def first_in(self) -> str | None:
        if self.kept:
            return clock(self.kept[0])
        if self.manual and self.rec is not None and self.rec.first_punch:
            return self.rec.first_punch.strftime("%H:%M")
        return None

    @property
    def last_out(self) -> str | None:
        if len(self.kept) >= 2:
            return clock(self.kept[-1])
        if self.manual and self.rec is not None and self.rec.last_punch:
            return self.rec.last_punch.strftime("%H:%M")
        return None

    def _judged(self):
        if self.ruleset is None or self.group is None or not self.kept:
            return None
        last = self.kept[-1] if len(self.kept) > 1 else None
        return psr.judge_day(self.ruleset, self.d, self.kept[0], last, self.emp.id)

    @property
    def late_minutes(self) -> int | None:
        """How late the first punch was, on a day the engine STORED as late (the flag is the engine's; minutes are not
        stored): past the group's start on a shift-table day, past the legacy arrival time before the rules start."""
        if self.rec is None or not self.rec.is_late or self.manual:
            return None
        judged = self._judged()
        if judged is not None:
            return judged.late_minutes if judged.is_late and judged.late_minutes > 0 else None
        if self.ruleset is not None or not self.kept:
            return None
        m = (self.kept[0] - self.kept[0] % 60 - psr.time_to_s(self._data.config.punch1_time)) // 60
        return m if m > 0 else None

    @property
    def early_minutes(self) -> int | None:
        if self.rec is None or not self.rec.early_leave or self.manual:
            return None
        judged = self._judged()
        if judged is not None:
            return judged.early_minutes if judged.early_leave and judged.early_minutes > 0 else None
        if self.ruleset is not None or len(self.kept) < 2:
            return None
        m = (psr.time_to_s(self._data.config.punch4_time) - self.kept[-1]) // 60
        return m if m > 0 else None

    def flags(self) -> list[str]:
        out: list[str] = []
        rec = self.rec
        if rec is not None:
            if rec.is_late:
                out.append("Late")
            if rec.early_leave:
                out.append("Early out")
            if self.manual:
                out.append("Entered by HR")
        if self.next_morning:
            out.append(FLAG_NIGHT)
        if not self.manual and self.d < self._data.today and self.kept:
            if len(self.kept) == 1:
                out.append("Single punch")
            elif len(self.kept) % 2:
                out.append("Odd punches")
        if self.double_taps:
            out.append(f"Double tap ({self.double_taps})")
        if self.off_grid:
            out.append(FLAG_OUT_OF_DATE)
        if self.stale:
            out.append(FLAG_STALE)
        if self.d == self._data.today and rec is not None:
            out.append("Today: day in progress")
        return out

    def punches_text(self, seconds: bool = False) -> str | None:
        return ", ".join(clock(s, seconds) for s, _p in self.shown) or None


class ProductionData:
    """Everything the reports of this module read, loaded once for the scoped production workers x the range.

    A constant number of queries whatever the size of the roster or the range: the workers, the config row and the
    shift table, the stored day records, the punches of the range with the night look-back, the dates
    HR entered by hand and, only for a worker on a long unbroken run of nights, one more read of older punches.
    ``resolve_from`` widens the days whose punches are resolved to before the range (the punch list resolves the day
    before it, so a punch made on the first date that closes the previous night shows the day it counts for)."""

    def __init__(self, ctx, *, resolve_from: dt.date | None = None):
        self.today: dt.date = ctx.today
        self.date_from, self.date_to = ctx.date_from, ctx.date_to
        self.days: list[dt.date] = ctx.days_in_range
        self.employees = sorted(ctx.employees().filter(employment_type="production"), key=_emp_order)
        emp_days_guard(len(self.employees), len(self.days))
        self.judge = ProductionJudge(read_config())
        self.config = self.judge.config
        self.ruleset_end = self.judge.ruleset_for(self.date_to)
        self.raw: dict[int, dict[dt.date, list[RawPunch]]] = {}
        self.manual: dict[int, dict] = {}
        self.records: dict[tuple[int, dt.date], AttendanceDayRecord] = {}
        self._refs: dict[int, dict] = {}
        self._blocks: dict[int, dict] = defaultdict(dict)
        ids = [e.id for e in self.employees]
        if not ids:
            return
        self.records = {
            (r.employee_id, r.date): r
            for r in AttendanceDayRecord.objects.filter(
                employee_id__in=ids, date__gte=self.date_from, date__lte=self.date_to
            )
        }
        first = min(resolve_from or self.date_from, self.date_from)
        in_force = self.ruleset_end is not None
        log_from = first - dt.timedelta(days=lookback_days(self.ruleset_end))
        log_to = self.date_to + dt.timedelta(days=1)
        raw: dict[int, dict[dt.date, list[RawPunch]]] = defaultdict(lambda: defaultdict(list))
        self._read(raw, ids, log_from, log_to)
        if in_force:
            # HR's hand-entered days stay outside every night session; the chain can reach back MAX_CHAIN_DAYS
            self.manual = manual_days(ids, history_floor(first), log_to)
            if raw:
                refs = {eid: self._refs_of(by_date) for eid, by_date in raw.items()}
                needy = employees_needing_history(refs, first, log_from, self.ruleset_end, self.manual)
                if needy:  # a long unbroken run of nights: ONE more read for all of them, as the engine does
                    self._read(raw, needy, history_floor(first), log_from - dt.timedelta(days=1))
        self.raw = {eid: dict(by_date) for eid, by_date in raw.items()}

    @staticmethod
    def _read(raw, ids, lo: dt.date, hi: dt.date) -> None:
        for eid, d, t, log_id, source, stored in (
            AttendanceLog.objects.filter(employee_id__in=list(ids), date__gte=lo, date__lte=hi)
            .order_by("employee_id", "date", "punch_time", "id")
            .values_list("employee_id", "date", "punch_time", "id", "source", "punch_type")
        ):
            raw[eid][d].append(RawPunch(log_id, d, t, source or "", stored or ""))

    @staticmethod
    def _refs_of(by_date) -> dict:
        """{date: [(seconds since that date's midnight, (date, index))]}: what production_judge resolves."""
        return {k: [(_secs(p.at), (k, i)) for i, p in enumerate(v)] for k, v in by_date.items()}

    def shift_day(self, emp, d: dt.date, ruleset, manual_e) -> list[tuple[int, RawPunch]]:
        """Every stored punch of shift day ``d`` (double taps included), (seconds since d's midnight, punch), oldest
        first. With the shift table in force a night's closing punch is +86400 on the day the shift began and is not
        listed again on the next date; before it (and on a day HR entered by hand) the calendar date the device stamped."""
        if d > self.today:
            return []
        by_date = self.raw.get(emp.id, {})
        if ruleset is None or d in manual_e:
            return [(_secs(p.at), p) for p in by_date.get(d, ())]
        refs = self._refs.get(emp.id)
        if refs is None:
            refs = self._refs[emp.id] = self._refs_of(by_date)
        return [
            (secs, by_date[k][i])
            for secs, (k, i) in shift_day_punches(ruleset, d, refs, manual_e, self._blocks[emp.id], employee_id=emp.id)
        ]

    def day(self, emp, d: dt.date) -> ShiftDay:
        return ShiftDay(self, emp, d)

    # -- notes shared by every report -------------------------------------------
    def rule_notes(self) -> list[str]:
        cfg = self.config
        eff = getattr(cfg, "rules_effective_from", None)
        ruleset = self.ruleset_end
        if ruleset is None:
            return [
                "The production shift-table rules do not judge any day of this range ("
                + self.judge.legacy_note(self.date_to).removeprefix("Previous calculation: ")
                + "): days use the previous calculation and punches are listed by the calendar date the device stamped."
            ]
        parts = [
            f"Production days are read by SHIFT DAY with the shift-table rules (Settings > Production shifts) from "
            f"{eff.strftime('%d-%b-%Y')}: a night worker's closing punch made the next morning belongs to the day the "
            "shift began and is marked (+1)"
        ]
        if ruleset.early_arrival_enabled:
            minutes = ruleset.early_arrival_minutes
            day = next((g for g in ruleset.groups if g.main_out_s is not None and g.main_out_s < DAY_S), None)
            example = (
                f" ({psr.hhmm(max(0, day.start_s - minutes * 60))} for the {psr.hhmm(day.start_s)} {day.label})"
                if day is not None
                else ""
            )
            parts.append(
                f"a morning punch up to {minutes} minutes before the start of the shift it begins{example} is that "
                "day's arrival, not the exit of the night before"
            )
        if ruleset.tap_gap_s:
            parts.append(f"a second tap within {ruleset.tap_gap_s // 60} minutes is a double tap and is not paired")
        parts.append("a worker on a special shift is judged by it on its dates")
        out = ["; ".join(parts) + "; shifts are counted in quarters (0.25)."]
        if self.date_from < eff:
            out.append(
                f"Days before {eff.strftime('%d-%b-%Y')} use the previous calculation and are listed by the calendar "
                "date the device stamped (group 'Legacy rules')."
            )
        return out


STORED_NOTE = (
    "Status, shifts earned, late and early are the attendance engine's stored verdict for each shift day (the record "
    "production payroll reads): nothing is recomputed or saved by this report. A day HR entered by hand keeps the "
    "value HR entered ('Manual entry')."
)


def clock(secs: int, seconds: bool = False) -> str:
    """'08:02' for a punch on the shift day itself, '05:30 (+1)' for the next morning's closing punch."""
    day, rest = divmod(secs, DAY_S)
    text = f"{rest // 3600:02d}:{rest % 3600 // 60:02d}"
    if seconds:
        text += f":{rest % 60:02d}"
    return f"{text} (+{day})" if day else text


def _out_of_date_note(n: int) -> str | None:
    if not n:
        return None
    return (
        f"{n} shift day(s) hold a stored value off the 0.25 grid: they were stored before production shifts were "
        "counted in quarters (18-Nov-2026) and are flagged Out of date (marked * in the grid). The stored value is "
        "shown; the engine works such a day out again in quarters when it is next refreshed, so open it in Attendance "
        "to bring it up to date."
    )


def _unprocessed_note(n: int) -> str | None:
    if not n:
        return None
    return (
        f"{n} past shift day(s) have no stored attendance record yet and show a dash (Not processed). The background "
        "attendance refresh fills them; a report never computes attendance."
    )


def _scope_filters(status: str = "active") -> tuple:
    """Production only (the employee type is fixed), so no employee-type filter."""
    return (
        F.branches(),
        F.departments(),
        F.designations(),
        F.employees(),
        F.employee_status(status),
    )


def _range(default: str) -> F.FilterSpec:
    return F.date_range(default=default, label="Shift days", max_days=MAX_DAYS)


def _emp_cells(emp) -> dict:
    return {
        "employeeCode": emp.employee_code,
        "employeeName": full_name(emp),
        "department": department_name(emp),
    }


EMP_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.4),
)


def _f(v: Decimal | None) -> float | None:
    return None if v is None else float(v)


# ═════════════════════════════════════════════════════════════════════════════
#  2. production-attendance-report: the month grid
# ═════════════════════════════════════════════════════════════════════════════

DAY_KEY = re.compile(r"^d(\d{4})(\d{2})(\d{2})$")


def day_key(d: dt.date) -> str:
    return f"d{d.strftime('%Y%m%d')}"


def cell_text(sd: ShiftDay) -> str | None:
    """The grid cell of one shift day: the stored shifts earned ('1.25'; '*' = out of date), A / H / L, or None
    (a dash: not processed yet, or a future day)."""
    rec = sd.rec
    if rec is None:
        return None
    s = rec.status
    if s == "absent":
        return "A"
    if s == "holiday":
        return "H"
    if s == "on_leave":
        return "L"
    return f"{sd.shifts:.2f}" + ("*" if sd.off_grid else "")


GRID_TAIL = (
    ColumnSpec("worked", "Worked", INTEGER, 0.6, total="sum"),
    ColumnSpec("below", "Under 1.00", INTEGER, 0.7, total="sum"),
    ColumnSpec("absent", "Absent", INTEGER, 0.6, total="sum"),
    ColumnSpec("nights", "Nights", INTEGER, 0.6, total="sum"),
    ColumnSpec("late", "Late", INTEGER, 0.5, total="sum"),
    ColumnSpec("extra", "Extra shifts", NUMBER, 0.7, total="sum"),
    ColumnSpec("total", "Total shifts", NUMBER, 0.8, total="sum"),
)


def kept_rows(rows: list[dict], ctx) -> list[dict]:
    """The data rows the runner keeps (``ctx.row_limit`` is its limit plus one): summary cards and counts in the notes
    are built from these, so they always describe the table that is shown or exported."""
    return [r for r in rows if not r.get("_kind")][: ctx.row_limit - 1]


def _grid_run(ctx) -> ReportResult:
    data = ProductionData(ctx)
    days = data.days
    keys = [day_key(d) for d in days]
    columns = [
        ColumnSpec("sno", "S.No", INTEGER, 0.5),
        *EMP_COLUMNS,
        *(ColumnSpec(day_key(d), f"{d.day} {WEEKDAYS[d.weekday()][:2]}", TEXT, 0.5, align="center") for d in days),
        *GRID_TAIL,
    ]
    rows: list[dict] = []
    for i, emp in enumerate(data.employees, start=1):
        if len(rows) >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
            break
        row = {"sno": i, **_emp_cells(emp)}
        worked = below = absent = nights = late = 0
        total = extra = Decimal(0)
        # private tallies (the runner drops keys that are not columns): per day (worked, shifts), and the notes' counts
        per_day: dict[str, tuple[bool, Decimal]] = {}
        tally = Counter()
        for d, key in zip(days, keys):
            sd = data.day(emp, d)
            row[key] = cell_text(sd)
            tally["unprocessed"] += sd.unprocessed
            rec = sd.rec
            if rec is None:
                continue
            shifts = sd.shifts
            total += shifts
            per_day[key] = (sd.worked, shifts)
            tally["off"] += sd.off_grid
            tally["manual"] += sd.manual
            late += bool(rec.is_late)
            absent += rec.status == "absent"
            if sd.worked:
                worked += 1
                full = sd.full_value
                below += shifts < full
                extra += max(Decimal(0), shifts - full)
                nights += sd.is_night
            elif rec.status in ("present", "half_shift"):
                tally["zero"] += 1
        row.update(
            {
                "worked": worked,
                "below": below,
                "absent": absent,
                "nights": nights,
                "late": late,
                "extra": float(extra),
                "total": float(total),
                "_days": per_day,
                "_tally": tally,
                "_total": total,
                "_extra": extra,
            }
        )
        rows.append(row)

    kept = kept_rows(rows, ctx)
    tally = sum((r["_tally"] for r in kept), Counter())
    if kept:
        workers = {k: sum(1 for r in kept if r["_days"].get(k, (False,))[0]) for k in keys}
        shifts_by_day = {k: sum((r["_days"][k][1] for r in kept if k in r["_days"]), Decimal(0)) for k in keys}
        at = len(kept)  # the day totals go right after the rows the runner keeps
        rows[at:at] = [
            {"employeeName": "Workers present", "_kind": KIND_TOTAL, **workers},
            {
                "employeeName": "Shifts earned",
                "_kind": KIND_TOTAL,
                **{k: float(v) for k, v in shifts_by_day.items() if any(k in r["_days"] for r in kept)},
            },
        ]

    summary = [
        {"label": "Production employees", "value": len(kept), "format": "integer"},
        {"label": "Days worked", "value": sum(r["worked"] for r in kept), "format": "integer"},
        {"label": "Total shifts", "value": float(sum((r["_total"] for r in kept), Decimal(0))), "format": "number"},
        {
            "label": "Extra shifts (over 1.00)",
            "value": float(sum((r["_extra"] for r in kept), Decimal(0))),
            "format": "number",
        },
        {"label": "Absent days", "value": sum(r["absent"] for r in kept), "format": "integer"},
        {"label": "Days not processed", "value": tally["unprocessed"], "format": "integer"},
    ]
    notes = [
        "Each cell is one SHIFT DAY: the shifts it earned as stored (1.00 a full shift, 1.25 / 1.50 ... with extra "
        "shifts, 0.75 / 0.50 ... below a full shift), A absent, H holiday, L leave, '-' no stored record yet (or a day "
        "still to come). A night shift's credit sits on the day the shift began.",
        "Worked = days that earned shifts; Under 1.00 = worked days below the full-day value (1.00); Nights = worked "
        "days judged by a night group; Extra shifts = everything above 1.00 on a day; Total shifts = the sum of the "
        "stored values (what production payroll multiplies by the rate per shift). 'Workers present' and 'Shifts "
        "earned' under the grid are the day totals.",
        STORED_NOTE,
        *data.rule_notes(),
    ]
    for note in (_out_of_date_note(tally["off"]), _unprocessed_note(tally["unprocessed"])):
        if note:
            notes.append(note)
    if tally["zero"]:
        notes.append(
            f"{tally['zero']} shift day(s) show 0.00: the worker punched but the day earned no shift (a single punch, "
            "or an out punch missing). They are not counted as worked."
        )
    if tally["manual"]:
        notes.append(f"{tally['manual']} shift day(s) were entered by HR by hand and show the value HR entered.")
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


# ── the grid's coloured Excel and its landscape PDF ─────────────────────────────

FILL_FULL = "C6EFCE"  # 1.00
FILL_EXTRA = "9FE0B0"  # over 1.00
FILL_BELOW = "FFEB9C"  # under 1.00
FILL_ABSENT = "FFC7CE"
FILL_HOLIDAY = "E2E8F0"
FILL_LEAVE = "BDD7EE"
FILL_OUTDATED = "FED7AA"
SUNDAY_HEAD = "FFE4E6"
TOTAL_FILL = "F1F5F9"
GRID_LEGEND = [
    ("1.00", FILL_FULL, "A full shift"),
    ("1.50", FILL_EXTRA, "With extra shifts"),
    ("0.75", FILL_BELOW, "Below a full shift"),
    ("A", FILL_ABSENT, "Absent"),
    ("H", FILL_HOLIDAY, "Holiday"),
    ("L", FILL_LEAVE, "Leave"),
    ("2.72*", FILL_OUTDATED, "Out of date"),
    ("-", None, "No record yet"),
]


def grid_fill(value) -> str | None:
    """The fill of one grid cell (hex), None for an empty one."""
    if not isinstance(value, str) or not value.strip() or value == "-":
        return None
    if value.endswith("*"):
        return FILL_OUTDATED
    fixed = {"A": FILL_ABSENT, "H": FILL_HOLIDAY, "L": FILL_LEAVE}.get(value)
    if fixed:
        return fixed
    try:
        v = Decimal(value)
    except ArithmeticError:
        return None
    if v > FULL_DAY:
        return FILL_EXTRA
    return FILL_FULL if v == FULL_DAY else FILL_BELOW


def _is_sunday(key: str) -> bool:
    m = DAY_KEY.match(key)
    return bool(m) and dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).weekday() == 6


def build_grid_xlsx(ctx, out) -> bytes:
    raw = build_xlsx(out)
    if not out.rows:
        return raw
    wb = load_workbook(io.BytesIO(raw))
    ws = wb.active
    day_cols = [(i, c) for i, c in enumerate(out.columns, start=1) if DAY_KEY.match(c.key)]
    bold = Font(name="Calibri", size=9, bold=True)
    centre = Alignment(horizontal="center", vertical="center")
    for i, c in day_cols:
        ws.column_dimensions[get_column_letter(i)].width = 6.0
        if _is_sunday(c.key):
            head = ws.cell(row=HEADER_ROW, column=i)
            head.fill = PatternFill("solid", fgColor=SUNDAY_HEAD)
            head.font = Font(name="Calibri", size=10, bold=True, color="9F1239")
    for r, row in enumerate(out.rows, start=HEADER_ROW + 1):
        if row.get("_kind") == KIND_TOTAL:  # the day totals under the grid: numbers, not text
            for i, c in day_cols:
                cell = ws.cell(row=r, column=i)
                value = row.get(c.key)
                if isinstance(value, (int, float)):
                    cell.value = value
                cell.fill = PatternFill("solid", fgColor=TOTAL_FILL)
                cell.alignment = centre
            continue
        for i, c in day_cols:
            fill = grid_fill(row.get(c.key))
            if fill is None:
                continue
            cell = ws.cell(row=r, column=i)
            cell.fill = PatternFill("solid", fgColor=fill)
            cell.font = bold
            cell.alignment = centre
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _fit(text: str, width: float, font: str, size: float, pad: float = 2.0) -> str:
    """Text cut with an ellipsis so it fits ``width`` points."""
    if pdfmetrics.stringWidth(text, font, size) <= width - 2 * pad:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > width - 2 * pad:
        text = text[:-1]
    return text.rstrip() + "…"


def build_grid_pdf(ctx, out) -> bytes:
    """The grid as a printed register: A3 landscape for more than 16 days (A4 landscape otherwise), the identity and
    total columns fixed, the day columns sharing the rest, each cell coloured by its value, the legend and the notes."""
    regular, bold, rupee_ok = ensure_fonts()
    co = company()
    cols = out.columns
    day_idx = [i for i, c in enumerate(cols) if DAY_KEY.match(c.key)]
    n_days = len(day_idx)
    page = landscape(A3) if n_days > 16 else landscape(A4)
    margin = 1.0 * cm
    avail = page[0] - 2 * margin
    size = 6.8
    style = style_factory(regular, size)

    fixed = {"sno": 0.8, "employeeCode": 1.6, "employeeName": 3.8, "department": 2.6, "extra": 1.1, "total": 1.2}
    widths = [0.0 if i in day_idx else fixed.get(c.key, 0.95) * cm for i, c in enumerate(cols)]
    base = sum(widths)
    day_w = min(1.1 * cm, max(0.55 * cm, (avail - base) / n_days)) if n_days else 0.0
    for i in day_idx:
        widths[i] = day_w
    used = sum(widths)
    if used < avail:  # a short range: the spare width goes to the name and department
        for i, c in enumerate(cols):
            if c.key in ("employeeName", "department"):
                widths[i] += (avail - used) / 2
    elif used > avail:
        widths = [w * avail / used for w in widths]

    s_head = style("h", fontName=bold, alignment=TA_CENTER, textColor=colors.white, fontSize=6.4, leading=7.6)
    s_head_sun = style(
        "hs", fontName=bold, alignment=TA_CENTER, textColor=colors.HexColor("#9F1239"), fontSize=6.4, leading=7.6
    )
    s_note = style("n", fontSize=7, leading=9, textColor=MUTED)

    story: list = []
    story += letterhead(co, avail, regular, bold, style)
    right = f"{display_date(ctx.date_from)} to {display_date(ctx.date_to)}" if ctx.date_from and ctx.date_to else ""
    story.append(title_bar(out.spec.title.upper(), right, avail, bold, style))
    story.append(filter_box(out.filters, avail, style))
    story.append(Spacer(1, 4))
    strip = kpi_strip(out.summary, avail, bold, style, rupee_ok)
    if strip is not None:
        story.append(strip)
        story.append(Spacer(1, 4))

    def head_cell(i: int, c):
        if i in day_idx:
            num, _, wd = c.label.partition(" ")
            return Paragraph(f"{escape(num)}<br/>{escape(wd)}", s_head_sun if _is_sunday(c.key) else s_head)
        return Paragraph(escape(c.label), s_head)

    data: list[list] = [[head_cell(i, c) for i, c in enumerate(cols)]]
    cmds: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("FONTNAME", (0, 1), (-1, -1), regular),
        ("FONTSIZE", (0, 1), (-1, -1), size),
        ("LEADING", (0, 1), (-1, -1), size * 1.2),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.25, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), 1.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1.5),
        ("TOPPADDING", (0, 0), (-1, -1), 1.8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
    ]
    for i in day_idx:
        if _is_sunday(cols[i].key):
            cmds.append(("BACKGROUND", (i, 0), (i, 0), colors.HexColor("#" + SUNDAY_HEAD)))
    text_cols = [i for i, c in enumerate(cols) if c.key in ("employeeCode", "employeeName", "department")]
    for i in text_cols:
        cmds.append(("ALIGN", (i, 1), (i, -1), "LEFT"))
    for i in range(len(cols)):
        if i not in text_cols:
            cmds.append(("ALIGN", (i, 1), (i, -1), "CENTER"))

    for row in out.rows:
        idx = len(data)
        kind = row.get("_kind")
        cells = []
        for i, c in enumerate(cols):
            v = row.get(c.key)
            if i in day_idx:
                if v is None or v == "":
                    text = "" if kind else "-"
                elif isinstance(v, float):
                    text = f"{v:.2f}".rstrip("0").rstrip(".") if kind else str(v)
                else:
                    text = str(v)
            elif i in text_cols:
                text = _fit("" if v is None else str(v), widths[i], bold if kind else regular, size)
            elif kind and v is None:
                text = ""
            else:
                text = pdf_text(c, v, rupee_ok)
            cells.append(text)
        data.append(cells)
        if kind in (KIND_TOTAL, KIND_SUBTOTAL):
            cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
            cmds.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#" + TOTAL_FILL)))
            continue
        for i in day_idx:
            fill = grid_fill(row.get(cols[i].key))
            if fill:
                cmds.append(("BACKGROUND", (i, idx), (i, idx), colors.HexColor("#" + fill)))
                cmds.append(("FONTNAME", (i, idx), (i, idx), bold))
    if out.totals:
        idx = len(data)
        cells = []
        for c in cols:
            v = out.totals.get(c.key)
            if c.key == "employeeName":
                cells.append("TOTAL")
            else:
                cells.append("" if v is None else pdf_text(c, v, rupee_ok))
        data.append(cells)
        cmds.append(("FONTNAME", (0, idx), (-1, idx), bold))
        cmds.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#DCE6F2")))
        cmds.append(("LINEABOVE", (0, idx), (-1, idx), 0.9, BRAND))

    if len(data) == 1:
        story.append(
            Paragraph("No records match the selected filters.", style("e", fontSize=10, leading=14, textColor=MUTED))
        )
    else:
        table = Table(data, colWidths=widths, repeatRows=1, splitByRow=1)
        table.setStyle(TableStyle(cmds))
        story.append(table)

    story.append(Spacer(1, 6))
    legend_cells: list = []
    legend_w: list[float] = []
    legend_cmds: list[tuple] = [
        ("FONTNAME", (0, 0), (-1, -1), regular),
        ("FONTSIZE", (0, 0), (-1, -1), 6.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]
    for n, (code, fill, label) in enumerate(GRID_LEGEND):
        legend_cells += [code, label]
        legend_w += [1.0 * cm, 2.9 * cm]
        if fill:
            legend_cmds.append(("BACKGROUND", (2 * n, 0), (2 * n, 0), colors.HexColor("#" + fill)))
        legend_cmds.append(("FONTNAME", (2 * n, 0), (2 * n, 0), bold))
        legend_cmds.append(("ALIGN", (2 * n, 0), (2 * n, 0), "CENTER"))
    legend = Table([legend_cells], colWidths=legend_w, hAlign="LEFT")
    legend.setStyle(TableStyle(legend_cmds))
    story.append(legend)
    if out.truncated:
        story.append(Spacer(1, 4))
        story.append(
            Paragraph(
                f"<b>Note:</b> only the first {out.row_count:,} rows are printed here. Narrow the filters to see the rest.",
                s_note,
            )
        )
    for note in out.notes:
        story.append(Spacer(1, 2))
        story.append(Paragraph(escape(note), s_note))

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=1.5 * cm,
        title=out.spec.title,
        author=co.name,
    )
    frame = Frame(
        margin,
        1.5 * cm,
        avail,
        page[1] - margin - 1.5 * cm,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="grid", frames=[frame])])
    stamp = f"Generated {display_date(out.generated_at[:10])} {out.generated_at[11:]} by {out.generated_by}"
    doc.build(story, canvasmaker=numbered_canvas(f"{co.name} - {out.spec.title}  |  {stamp}", regular, margin))
    return buf.getvalue()


register(
    ReportSpec(
        id=GRID_ID,
        title="Production Attendance Report",
        description="Production workers by shift day: a cell per day with the shifts earned (1.00 / 1.25 / 0.75 ...) "
        "or A / H, and each worker's days worked, absent, nights, extra and total shifts.",
        category=CATEGORY,
        modules=MODULES,
        icon="Grid3x3",
        tags=(
            "production",
            "attendance",
            "muster",
            "grid",
            "shift day",
            "shifts earned",
            "night",
            "extra shift",
            "quarter",
            "monthly",
        ),
        filters=(_range("thisMonth"), *_scope_filters()),
        columns=(),
        run=_grid_run,
        landscape=True,
        pdf_builder=build_grid_pdf,
        xlsx_builder=build_grid_xlsx,
        screen_limit=2_000,
        pdf_max_rows=1_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  5. production-time-card-punches
# ═════════════════════════════════════════════════════════════════════════════

DAYS_OPTIONS = (("all", "Every day"), ("worked", "Days with punches or shifts"))


def _timecard_run(ctx) -> ReportResult:
    data = ProductionData(ctx)
    worked_only = ctx.params.get("days") == "worked"
    cards: list[tuple] = []
    widest = 0
    for emp in data.employees:
        days = []
        for d in data.days:
            sd = data.day(emp, d)
            if sd.future or (worked_only and not (sd.shown or sd.worked)):
                continue
            days.append(sd)
            widest = max(widest, len(sd.shown))
        if days:
            cards.append((emp, days))
    slots = min(MAX_SLOTS, max(4, widest))
    columns = [
        *EMP_COLUMNS,
        ColumnSpec("date", "Shift day", DATE, 1.0),
        ColumnSpec("day", "Day", TEXT, 0.5),
        ColumnSpec("group", "Group", TEXT, 1.1),
        *(ColumnSpec(f"p{n}", f"P{n}", TEXT, 0.75, align="center") for n in range(1, slots + 1)),
        ColumnSpec("firstIn", "In", TEXT, 0.75, align="center"),
        ColumnSpec("lastOut", "Out", TEXT, 0.85, align="center"),
        ColumnSpec("hours", "Hours", HOURS, 0.7, total="sum"),
        ColumnSpec("shiftsEarned", "Shifts", NUMBER, 0.7, total="sum"),
        ColumnSpec("status", "Status", BADGE, 0.9),
        ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.7, total="sum"),
        ColumnSpec("earlyMinutes", "Early (min)", MINUTES, 0.7, total="sum"),
        ColumnSpec("flags", "Flags", TEXT, 2.4),
    ]
    rows: list[dict] = []
    data_rows = 0
    for emp, days in cards:
        if data_rows >= ctx.row_limit:
            break
        cells = _emp_cells(emp)
        mine: list[ShiftDay] = []
        for sd in days:
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            row = {
                **cells,
                "date": sd.d.isoformat(),
                "day": WEEKDAYS[sd.d.weekday()],
                "group": sd.group_label,
                "firstIn": sd.first_in,
                "lastOut": sd.last_out,
                "hours": sd.hours,
                "shiftsEarned": _f(sd.shifts),
                "status": sd.status,
                "lateMinutes": sd.late_minutes,
                "earlyMinutes": sd.early_minutes,
                "flags": "; ".join(sd.flags()) or None,
                "_sd": sd,  # private (not a column): the summary reads the kept rows' days
            }
            for n, (secs, _p) in enumerate(sd.shown[:slots], start=1):
                row[f"p{n}"] = clock(secs)
            if len(sd.shown) > slots:
                row[f"p{slots}"] += f" (+{len(sd.shown) - slots} more)"
            rows.append(row)
            data_rows += 1
            mine.append(sd)
        if not mine:
            continue
        worked = sum(sd.worked for sd in mine)
        rows.append(
            {
                "employeeName": f"{full_name(emp)} ({emp.employee_code}) total",
                "group": f"{worked} day{'s' if worked != 1 else ''} worked",
                "hours": round(sum(sd.hours or 0 for sd in mine), 2),
                "shiftsEarned": float(sum((sd.shifts or 0 for sd in mine), Decimal(0))),
                "lateMinutes": sum(sd.late_minutes or 0 for sd in mine),
                "earlyMinutes": sum(sd.early_minutes or 0 for sd in mine),
                "_kind": KIND_SUBTOTAL,
            }
        )

    shown = [r["_sd"] for r in kept_rows(rows, ctx)]
    crowded = sum(len(sd.shown) > slots for sd in shown)
    summary = [
        {"label": "Production employees", "value": len({sd.emp.id for sd in shown}), "format": "integer"},
        {"label": "Shift days listed", "value": len(shown), "format": "integer"},
        {
            "label": "Total shifts",
            "value": float(sum((sd.shifts or 0 for sd in shown), Decimal(0))),
            "format": "number",
        },
        {"label": "Late days", "value": sum(bool(sd.rec and sd.rec.is_late) for sd in shown), "format": "integer"},
        {
            "label": "Early-out days",
            "value": sum(bool(sd.rec and sd.rec.early_leave) for sd in shown),
            "format": "integer",
        },
        {"label": "Days not processed", "value": sum(sd.unprocessed for sd in shown), "format": "integer"},
    ]
    notes = [
        "One time card per production worker: every shift day of the range in date order"
        + (" that has a punch or earned a shift" if worked_only else "")
        + ", then a total line. Days still to come are not listed.",
        f"P1 to P{slots} are every punch stored for the shift day in the order it was made (double taps included), "
        "whatever its source; '(+1)' is the next morning's punch that closed a night shift. In and Out are the first "
        "and the last punch the engine pairs (double taps dropped). Hours = the time from each In to the Out after it "
        "(1st-2nd, 3rd-4th ...), breaks included; a last punch with no pair is not counted.",
        "Group is the shift group that judges the day from its first punch (Day, Night, Sunday, or the worker's special "
        "shift). Late (min) is how far the first punch was past the group's start on a day the engine stored as late; "
        "Early (min) how far the last punch was before the group's standard leaving time on a day stored as early out.",
        STORED_NOTE,
        *data.rule_notes(),
    ]
    if crowded:
        notes.append(
            f"{crowded} shift day(s) have more than {slots} punches: P{slots} shows how many more there were; the "
            "Production All Punch Records report lists every one."
        )
    for note in (
        _out_of_date_note(sum(sd.off_grid for sd in shown)),
        _unprocessed_note(sum(sd.unprocessed for sd in shown)),
    ):
        if note:
            notes.append(note)
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id=TIMECARD_ID,
        title="Production Time Card with Punch Details",
        description="A time card per production worker by shift day: group, every punch (P1 to P10), in, out, hours, "
        "shifts earned and late / early minutes, with a total per worker.",
        category=CATEGORY,
        modules=MODULES,
        icon="Clock",
        tags=("production", "time card", "punch", "punches", "in out", "hours", "shift day", "night", "late", "early"),
        filters=(
            _range("thisMonth"),
            *_scope_filters(),
            F.select("days", "Days", DAYS_OPTIONS, default="all", placeholder="Every day"),
        ),
        columns=(),
        run=_timecard_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=4_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  6. production-shift-ot-punches
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class OtSplit:
    """Where a worked day passed the full-day value and what was worked after it."""

    from_secs: int  # seconds since the shift day's midnight at which the running value reached the full-day value
    paid_secs: int  # time worked after it, unpaid breaks excluded
    punches: list[int]  # the punches of the extra part (the out punch that passed it and every later pair)


def ot_split(sd: ShiftDay) -> OtSplit | None:
    """The day's pairs walked with the shift table's own arithmetic (production_shift_rules: an on-time first in counts
    as the start, an out within grace of a rule point snaps to it, the value grows with PAID time) to find the minute
    the running value reached the full-day value. None when the table does not judge the day, or the punches never get
    there (a stored value that is out of date). The stored shifts stay the figure: this only says which part of the
    day earned the extra."""
    ruleset, group, cm = sd.ruleset, sd.group, [s - s % 60 for s in sd.kept]
    if ruleset is None or group is None or sd.manual or len(cm) < 2:
        return None
    breaks = ruleset.breaks
    grace_s = ruleset.grace_minutes * 60
    full = Fraction(ruleset.full_day_value)

    def paid(a: int, b: int) -> int:
        return max(0, psr.paid_seconds(group.start_s, b, breaks) - psr.paid_seconds(group.start_s, a, breaks))

    acc = Fraction(0)
    split: OtSplit | None = None
    for i in range(len(cm) // 2):
        t_in, t_out = cm[2 * i], cm[2 * i + 1]
        counted_in = min(t_in, group.start_s) if i == 0 and t_in <= group.start_s + grace_s else t_in
        following = cm[2 * i + 2] if 2 * i + 2 < len(cm) else None
        counted_out = psr.snap_out(group, t_out, grace_s, following)
        v_in = psr.value_at(group, breaks, counted_in)
        v_out = psr.value_at(group, breaks, counted_out)
        if split is not None:
            split.paid_secs += paid(t_in, t_out)
            split.punches += [cm[2 * i], cm[2 * i + 1]]
        elif acc + v_out - v_in >= full:
            # the first minute inside this pair at which the running value reaches the full-day value
            lo, hi = counted_in // 60, counted_out // 60
            while lo < hi:
                mid = (lo + hi) // 2
                if acc + psr.value_at(group, breaks, mid * 60) - v_in >= full:
                    hi = mid
                else:
                    lo = mid + 1
            at = lo * 60
            split = OtSplit(at, paid(at, t_out) if t_out > at else 0, [cm[2 * i + 1]] if t_out > at else [])
        acc += v_out - v_in
    return split


def _ot_run(ctx) -> ReportResult:
    data = ProductionData(ctx)
    ot_only = bool(ctx.params.get("otOnly"))
    columns = [
        *EMP_COLUMNS,
        ColumnSpec("date", "Shift day", DATE, 1.0),
        ColumnSpec("day", "Day", TEXT, 0.5),
        ColumnSpec("group", "Group", TEXT, 1.1),
        ColumnSpec("firstIn", "In", TEXT, 0.7, align="center"),
        ColumnSpec("lastOut", "Out", TEXT, 0.8, align="center"),
        ColumnSpec("regularShift", "Regular shift", NUMBER, 0.8, total="sum"),
        ColumnSpec("extraShifts", "Extra shifts", NUMBER, 0.8, total="sum"),
        ColumnSpec("shiftsEarned", "Total shifts", NUMBER, 0.8, total="sum"),
        ColumnSpec("otFrom", "Extra from", TEXT, 0.8, align="center"),
        ColumnSpec("otHours", "OT hours", HOURS, 0.7, total="sum"),
        ColumnSpec("otPunches", "OT punches", TEXT, 1.8),
        ColumnSpec("punches", "All punches", TEXT, 2.6),
        ColumnSpec("flags", "Flags", TEXT, 1.8),
    ]
    rows: list[dict] = []
    data_rows = 0
    for emp in data.employees:
        if data_rows >= ctx.row_limit:
            break
        cells = _emp_cells(emp)
        mine: list[dict] = []
        for d in data.days:
            if data_rows >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            sd = data.day(emp, d)
            if not sd.worked:
                continue
            shifts, full = sd.shifts, sd.full_value
            extra = max(Decimal(0), shifts - full)
            if ot_only and extra <= 0:
                continue
            split = ot_split(sd) if extra > 0 else None
            flags = sd.flags()
            if extra > 0 and split is None:
                flags.append("Extra part not measured from the punches")
            row = {
                **cells,
                "date": d.isoformat(),
                "day": WEEKDAYS[d.weekday()],
                "group": sd.group_label,
                "firstIn": sd.first_in,
                "lastOut": sd.last_out,
                "regularShift": float(shifts - extra),
                "extraShifts": float(extra),
                "shiftsEarned": float(shifts),
                "otFrom": clock(split.from_secs) if split else None,
                "otHours": round(split.paid_secs / 3600.0, 2) if split else None,
                "otPunches": (", ".join(clock(s) for s in split.punches) or None) if split else None,
                "punches": sd.punches_text(),
                "flags": "; ".join(flags) or None,
                # private (not columns): what the totals and the summary add up
                "_emp": emp.id,
                "_regular": shifts - extra,
                "_extra": extra,
                "_ot_secs": split.paid_secs if split else 0,
                "_unmeasured": extra > 0 and split is None,
                "_off": sd.off_grid,
            }
            rows.append(row)
            mine.append(row)
            data_rows += 1
        if not mine:
            continue
        with_extra = sum(r["_extra"] > 0 for r in mine)
        rows.append(
            {
                "employeeName": f"{full_name(emp)} ({emp.employee_code}) total",
                "group": f"{len(mine)} day{'s' if len(mine) != 1 else ''}, {with_extra} with extra",
                "regularShift": float(sum((r["_regular"] for r in mine), Decimal(0))),
                "extraShifts": float(sum((r["_extra"] for r in mine), Decimal(0))),
                "shiftsEarned": float(sum((r["_regular"] + r["_extra"] for r in mine), Decimal(0))),
                "otHours": round(sum(r["_ot_secs"] for r in mine) / 3600.0, 2),
                "_kind": KIND_SUBTOTAL,
            }
        )

    kept = kept_rows(rows, ctx)
    unmeasured = sum(r["_unmeasured"] for r in kept)
    summary = [
        {"label": "Production employees", "value": len({r["_emp"] for r in kept}), "format": "integer"},
        {"label": "Worked days listed", "value": len(kept), "format": "integer"},
        {"label": "Days with extra shifts", "value": sum(r["_extra"] > 0 for r in kept), "format": "integer"},
        {"label": "Regular shifts", "value": float(sum((r["_regular"] for r in kept), Decimal(0))), "format": "number"},
        {"label": "Extra shifts", "value": float(sum((r["_extra"] for r in kept), Decimal(0))), "format": "number"},
        {"label": "OT hours", "value": round(sum(r["_ot_secs"] for r in kept) / 3600.0, 2), "format": "hours"},
    ]
    notes = [
        "One line per worked shift day"
        + (" that earned extra shifts" if ot_only else "")
        + ", then a total line per worker. Regular shift = the stored shifts up to the full-day value (1.00); Extra "
        "shifts = everything above it (the overtime part, paid at the same rate per shift); Total shifts = the stored "
        "value, Regular + Extra.",
        "Extra from is the minute the day's running shift value reached the full-day value, read from the punches "
        "with the shift table (on-time arrival counts from the start, an out within grace of a rule point counts as "
        "that point, breaks earn nothing); OT hours is the time worked after it with the unpaid breaks left out; OT "
        "punches are the out punch that passed it and every punch after (double taps dropped, '(+1)' = the next "
        "morning).",
        STORED_NOTE,
        *data.rule_notes(),
    ]
    if unmeasured:
        notes.append(
            f"{unmeasured} day(s) with extra shifts could not be split from the punches (a day HR entered by hand, a "
            "day before the shift-table rules, or a stored value the punches no longer reach): their Extra shifts "
            "come from the stored value alone."
        )
    note = _out_of_date_note(sum(r["_off"] for r in kept))
    if note:
        notes.append(note)
    return ReportResult(rows=rows, columns=columns, summary=summary, notes=notes)


register(
    ReportSpec(
        id=OT_ID,
        title="Production Shift with OT Punch Details",
        description="Each worked production shift day split into the regular shift (up to 1.00) and the extra shifts "
        "above it, with when the extra part started, its hours and the punches that made it.",
        category=CATEGORY,
        modules=MODULES,
        icon="Timer",
        tags=("production", "overtime", "ot", "extra shift", "regular shift", "punch", "shift day", "night"),
        filters=(
            _range("thisMonth"),
            *_scope_filters(),
            F.boolean("otOnly", "Only days with extra shifts", default=False),
        ),
        columns=(),
        run=_ot_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  7. production-all-punches
# ═════════════════════════════════════════════════════════════════════════════

SOURCE_OPTIONS = (
    ("biometric", "Biometric device"),
    ("geo", "Geo punch"),
    ("on_duty", "On-duty"),
    ("missing_punch", "Missing punch (approved)"),
    ("manual", "HR / manual entry"),
)
_SOURCE_TEST = {
    "biometric": lambda s: s.startswith("biometric"),
    "geo": lambda s: s == "geo:auto",
    "on_duty": lambda s: s == "on_duty:approved",
    "missing_punch": lambda s: s == "missing_punch:approved",
    "manual": lambda s: s.startswith("manual"),
}

PUNCH_COLUMNS = (
    *EMP_COLUMNS,
    ColumnSpec("punchDate", "Punch date", DATE, 1.0),
    ColumnSpec("punchTime", "Time", TEXT, 0.8, align="center"),
    ColumnSpec("shiftDay", "Shift day", DATE, 1.0),
    ColumnSpec("shiftWeekday", "Day", TEXT, 0.5),
    ColumnSpec("punchNo", "No.", INTEGER, 0.45),
    ColumnSpec("direction", "In / Out", BADGE, 0.7),
    ColumnSpec("device", "Device", TEXT, 1.2),
    ColumnSpec("source", "Source", TEXT, 0.9),
    ColumnSpec("storedType", "Stored type", TEXT, 0.7, align="center"),
    ColumnSpec("note", "Note", TEXT, 2.4),
)


def _device_names() -> dict[str, str]:
    """{serial number: the name HR gave the device}, for punches an ADMS push stamped with only the serial."""
    return {
        sn.strip(): name
        for sn, name in BiometricDevice.objects.exclude(serial_number="").values_list("serial_number", "name")
        if sn and sn.strip()
    }


def _device_label(source: str, names: dict[str, str]) -> str | None:
    if source.startswith("biometric:adms:"):
        sn = source[len("biometric:adms:") :].strip()
        if sn in names:
            return names[sn]
    return device_of(source)


def _punches_run(ctx) -> ReportResult:
    data = ProductionData(ctx, resolve_from=ctx.date_from - dt.timedelta(days=1))
    want = _SOURCE_TEST.get(ctx.params.get("source") or "")
    names = _device_names() if data.raw else {}
    rows: list[dict] = []
    first_shift_day = ctx.date_from - dt.timedelta(days=1)
    for emp in data.employees:
        if len(rows) >= ctx.row_limit:
            break
        by_date = data.raw.get(emp.id)
        if not by_date:
            continue
        cells = _emp_cells(emp)
        # every punch's shift day: resolve the day before the range too (its night may close on the first date)
        listed: list[tuple] = []  # (shift day, secs, punch, position, direction, note)
        d = first_shift_day
        while d <= ctx.date_to:
            sd = data.day(emp, d)
            kept_iter = iter(sd.kept)
            next_kept = next(kept_iter, None)
            kept_no = 0
            for pos, (secs, p) in enumerate(sd.shown, start=1):
                in_range = ctx.date_from <= p.on <= ctx.date_to or (d >= ctx.date_from and p.on > ctx.date_to)
                if secs == next_kept:
                    direction = "In" if kept_no % 2 == 0 else "Out"
                    kept_no += 1
                    next_kept = next(kept_iter, None)
                else:
                    direction = "Double tap"
                if not in_range:
                    continue
                note = None
                if p.on > d:
                    note = f"Closes the night shift of {d.strftime('%d-%b-%Y')}"
                elif sd.manual:
                    note = "Day entered by HR: kept on its own date"
                elif sd.ruleset is None:
                    note = "Before the shift-table rules: listed by calendar date"
                if direction == "Double tap":
                    note = (note + "; " if note else "") + "double tap, not paired"
                listed.append((d, secs, p, pos, direction, note))
            d += dt.timedelta(days=1)
        for shift_day, _secs_, p, pos, direction, note in listed:
            if want is not None and not want(p.source):
                continue
            if len(rows) >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            rows.append(
                {
                    **cells,
                    "punchDate": p.on.isoformat(),
                    "punchTime": p.at.strftime("%H:%M:%S"),
                    "shiftDay": shift_day.isoformat(),
                    "shiftWeekday": WEEKDAYS[shift_day.weekday()],
                    "punchNo": pos,
                    "direction": direction,
                    "device": _device_label(p.source, names),
                    "source": source_label(p.source),
                    "storedType": p.stored_type or None,
                    "note": note,
                    "_emp": emp.id,  # private (not a column): the summary reads the kept rows
                }
            )

    kept = kept_rows(rows, ctx)
    by_source = Counter(r["source"] for r in kept)
    summary = [
        {"label": "Punches", "value": len(kept), "format": "integer"},
        {"label": "Production employees", "value": len({r["_emp"] for r in kept}), "format": "integer"},
        {"label": "Shift days", "value": len({(r["_emp"], r["shiftDay"]) for r in kept}), "format": "integer"},
        {
            "label": "Closing punches next morning",
            "value": sum(r["punchDate"] > r["shiftDay"] for r in kept),
            "format": "integer",
        },
        {"label": "Double taps", "value": sum(r["direction"] == "Double tap" for r in kept), "format": "integer"},
        {"label": "Not biometric", "value": len(kept) - by_source.get("Biometric", 0), "format": "integer"},
    ]
    notes = [
        "One line per stored production punch, in time order per worker: every punch stamped on a date of the range, "
        "and the next morning's punch that closes a night begun on its last date. Shift day is the day the punch counts "
        "for: a night worker's closing punch made the next morning counts for the day the shift began.",
        "No. is the punch's place in its shift day; In / Out is positional (1st In, 2nd Out ...) over the punches the "
        "engine pairs, because devices send almost every punch as In (the stored flag is shown as Stored type). A "
        "double tap is a second tap within the double-tap minutes of the punch before it: stored and listed, never "
        "paired.",
        "Device is the biometric device the punch came from (the name given in Settings for a push that carries only "
        "the serial number); Source says how the punch was made: biometric, geo, on-duty, an approved missing punch "
        "or an HR entry.",
        *data.rule_notes(),
    ]
    if by_source:
        notes.append("By source: " + ", ".join(f"{k} {v:,}" for k, v in by_source.most_common()) + ".")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=PUNCHES_ID,
        title="Production All Punch Records",
        description="Every stored production punch: date, time, the shift day it counts for, position In / Out, "
        "device and source.",
        category=CATEGORY,
        modules=MODULES,
        icon="Fingerprint",
        tags=("production", "punch", "punches", "raw", "biometric", "device", "shift day", "night", "log"),
        filters=(
            _range("today"),
            *_scope_filters(),
            F.select("source", "Source", SOURCE_OPTIONS, placeholder="All sources"),
        ),
        columns=PUNCH_COLUMNS,
        run=_punches_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  16. production-attendance-log
# ═════════════════════════════════════════════════════════════════════════════

LOG_STATUS_OPTIONS = (
    ("worked", "Worked (earned shifts)"),
    ("absent", "Absent"),
    ("unprocessed", NOT_PROCESSED),
)
LOG_FLAG_OPTIONS = (
    ("late", "Late"),
    ("early", "Early out"),
    ("night", "Night closed next morning"),
    ("odd", "Single / odd punches"),
    ("extra", "Extra shifts (over 1.00)"),
    ("manual", "Entered by HR"),
    ("outdated", "Out of date"),
)

LOG_COLUMNS = (
    ColumnSpec("date", "Shift day", DATE, 1.0),
    ColumnSpec("day", "Day", TEXT, 0.5),
    *EMP_COLUMNS,
    ColumnSpec("designation", "Designation", TEXT, 1.2),
    ColumnSpec("group", "Group", TEXT, 1.1),
    ColumnSpec("firstIn", "In", TEXT, 0.7, align="center"),
    ColumnSpec("lastOut", "Out", TEXT, 0.8, align="center"),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.6),
    ColumnSpec("hours", "Hours", HOURS, 0.7, total="sum"),
    ColumnSpec("shiftsEarned", "Shifts", NUMBER, 0.7, total="sum"),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("lateMinutes", "Late (min)", MINUTES, 0.7, total="sum"),
    ColumnSpec("earlyMinutes", "Early (min)", MINUTES, 0.7, total="sum"),
    ColumnSpec("punches", "All punches", TEXT, 2.4),
    ColumnSpec("flags", "Flags", TEXT, 2.0),
    ColumnSpec("source", "Source", TEXT, 0.9),
)


def _log_status_match(sd: ShiftDay, key: str) -> bool:
    if key == "worked":
        return sd.worked
    if key == "absent":
        return sd.rec is not None and sd.rec.status == "absent"
    return sd.unprocessed


def _log_flag_match(sd: ShiftDay, key: str) -> bool:
    rec = sd.rec
    if key == "late":
        return bool(rec and rec.is_late)
    if key == "early":
        return bool(rec and rec.early_leave)
    if key == "night":
        return sd.next_morning
    if key == "odd":
        return bool(sd.kept) and len(sd.kept) % 2 == 1 and not sd.manual
    if key == "extra":
        return sd.worked and sd.shifts > sd.full_value
    if key == "manual":
        return sd.manual
    if key == "outdated":
        return sd.off_grid or sd.stale
    return True


def _log_run(ctx) -> ReportResult:
    data = ProductionData(ctx)
    want_status = ctx.params.get("status")
    want_flag = ctx.params.get("flag")
    rows: list[dict] = []
    for d in data.days:
        if d > data.today or len(rows) >= ctx.row_limit:
            break
        for emp in data.employees:
            sd = data.day(emp, d)
            if want_status and not _log_status_match(sd, want_status):
                continue
            if want_flag and not _log_flag_match(sd, want_flag):
                continue
            if len(rows) >= ctx.row_limit:  # the runner refuses an over-limit export: never build more than it keeps
                break
            rec = sd.rec
            rows.append(
                {
                    "date": d.isoformat(),
                    "day": WEEKDAYS[d.weekday()],
                    **_emp_cells(emp),
                    "designation": emp.designation.title if emp.designation_id else None,
                    "group": sd.group_label,
                    "firstIn": sd.first_in,
                    "lastOut": sd.last_out,
                    "punchCount": len(sd.shown) or None,
                    "hours": sd.hours,
                    "shiftsEarned": _f(sd.shifts),
                    "status": sd.status,
                    "lateMinutes": sd.late_minutes,
                    "earlyMinutes": sd.early_minutes,
                    "punches": sd.punches_text(),
                    "flags": "; ".join(sd.flags()) or None,
                    "source": ("Manual" if sd.manual else rec.primary_source) if rec is not None else None,
                    "_sd": sd,  # private (not a column): the summary reads the kept rows' days
                }
            )

    shown = [r["_sd"] for r in kept_rows(rows, ctx)]
    c = {
        "worked": sum(sd.worked for sd in shown),
        "absent": sum(bool(sd.rec and sd.rec.status == "absent") for sd in shown),
        "late": sum(bool(sd.rec and sd.rec.is_late) for sd in shown),
        "night": sum(sd.next_morning for sd in shown),
        "unprocessed": sum(sd.unprocessed for sd in shown),
        "outdated": sum(sd.off_grid for sd in shown),
    }
    summary = [
        {"label": "Shift days listed", "value": len(shown), "format": "integer"},
        {"label": "Worked", "value": c["worked"], "format": "integer"},
        {"label": "Absent", "value": c["absent"], "format": "integer"},
        {"label": "Late", "value": c["late"], "format": "integer"},
        {
            "label": "Total shifts",
            "value": float(sum((sd.shifts or 0 for sd in shown), Decimal(0))),
            "format": "number",
        },
        {"label": "Not processed", "value": c["unprocessed"], "format": "integer"},
    ]
    notes = [
        "One line per production worker per shift day, date by date (department, then employee code). In and Out are "
        "the first and the last punch the engine pairs (double taps dropped); '(+1)' marks the next morning's punch "
        "that closed a night shift. Hours = the time from each In to the Out after it, breaks included; a last punch "
        "with no pair is not counted. All punches lists every stored punch of the shift day, double taps included.",
        "Group is the shift group that judges the day from its first punch (Day, Night, Sunday, or the worker's "
        "special shift). Late (min) / Early (min) are measured from the group's start / standard leaving time, on "
        "days the engine stored as late / early out. Source is where the day's attendance came from (biometric, "
        "on-duty, geo punch, HR entry).",
        STORED_NOTE,
        *data.rule_notes(),
    ]
    if data.today in data.days:
        notes.append("Today's shift days are still in progress: a night shift that began today closes tomorrow.")
    if c["night"]:
        notes.append(f"{c['night']} shift day(s) were night shifts closed by a punch the next morning.")
    for note in (_out_of_date_note(c["outdated"]), _unprocessed_note(c["unprocessed"])):
        if note:
            notes.append(note)
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id=LOG_ID,
        title="Production Attendance Log Report",
        description="The production day log by shift day: in, out, hours, group, shifts earned, status and late / "
        "early flags for every worker.",
        category=CATEGORY,
        modules=MODULES,
        icon="ClipboardList",
        tags=("production", "attendance log", "daily", "in out", "hours", "shift day", "night", "late", "early"),
        filters=(
            _range("today"),
            *_scope_filters(),
            F.select("status", "Status", LOG_STATUS_OPTIONS, placeholder="All statuses"),
            F.select("flag", "Flag", LOG_FLAG_OPTIONS, placeholder="Any"),
        ),
        columns=LOG_COLUMNS,
        run=_log_run,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)
