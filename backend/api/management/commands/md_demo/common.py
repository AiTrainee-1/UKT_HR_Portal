"""Shared plumbing of the MD demo-data seeder.

Everything the domain modules have in common lives here:

* the SAFETY rule (the active database name must end in ``_e2e``) and the switch that keeps the application's
  background schedulers from touching a half-written demo database;
* the options (``Plan``), deterministic random streams (``Streams``) and the ``World`` the domain modules fill in turn;
* ``World.insert``: one bulk-insert path for every table. ``auto_now_add`` normally stamps "now" on every inserted row,
  which would erase the history the demo is made of, so the path switches the stamping off for the duration of the
  insert and gives every row the moment it really happened. Only in-memory field flags change, never a model file;
* the ``Manifest``: the primary keys of everything created, saved as a small JSON file next to the command so
  ``--purge`` removes exactly those rows and nothing else.
"""

from __future__ import annotations

import importlib
import json
import random
import time as _time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterable, Iterator, Sequence

from django.core.management.base import CommandError
from django.db import connection, models

from api.clock import FACTORY_TZ

if TYPE_CHECKING:  # the domain modules' value types, only needed for annotations
    from api.models import (
        Branch,
        Department,
        Designation,
        GateDevice,
        HRUser,
        LeaveType,
        PayrollSettings,
        Role,
        ShiftTemplate,
    )

    from .attendance import Day
    from .people import Person

# ─── the safety rule and the tags that make demo rows findable ─────────────────────────────────────────────────

#: A database may only be seeded when its name ends like this: the rule ``backend/e2e_setup.py`` applies before it DROPS one.
SAFE_DATABASE_SUFFIX = "_e2e"
#: Employee codes of everything the seeder creates: DM-0001, DM-0002, ...
CODE_PREFIX = "DM-"
MD_USERNAME = "md_demo"
#: Every demo account is ``<role>_demo``.
USERNAME_SUFFIX = "_demo"
#: The password of every demo account (override with --password). A demo database is throwaway; this is not a secret.
DEMO_PASSWORD = "MdDemo#2026"
#: Addresses the demo uses for its office network and its "outside" visitors. 203.0.113.0/24 and 198.51.100.0/24 are the
#: reserved documentation ranges (never a real host), so these rows can never be mistaken for real traffic.
OFFICE_NET = "10.77.0."
OUTSIDE_NETS = ("203.0.113.", "198.51.100.")
DEMO_IP_PREFIXES = ("10.77.", *OUTSIDE_NETS)
#: Marker in a demo visitor's Aadhaar field: the field is free text, and a visible fake is kinder than a real-looking number.
VISITOR_TAG = "DEMO-"
RUN_CODE_PREFIX = "DM-PR-"

#: Text that ends a demo row's free-text field wherever the table has one (descriptions, a branch's address) and starts every
#: demo gate QR token: another way to find demo rows when the manifest is gone.
DEMO_TAG = "(demo data)"
QR_TOKEN_PREFIX = "dm"  # hex tokens never contain an "m": a token that starts with it was made by the seeder

MANIFEST_VERSION = 1


def active_database_name() -> str:
    """The database every query of this process goes to (a function so a test can stand in for a ``_e2e`` name)."""
    return str(connection.settings_dict["NAME"])


def require_throwaway_database() -> str:
    """Return the active database name, or refuse (CommandError) when it is not a throwaway ``*_e2e`` database."""
    name = active_database_name()
    if not name.endswith(SAFE_DATABASE_SUFFIX):
        raise CommandError(
            f"Refusing to seed '{name}': the demo data is only ever loaded into a throwaway database whose name ends in "
            f"'{SAFE_DATABASE_SUFFIX}' (the rule backend/e2e_setup.py applies before it drops one). Create one with "
            f"`DB_NAME=uktex_demo_e2e python e2e_setup.py` from backend/ and run this command with the same DB_NAME."
        )
    return name


# ─── the application's schedulers must not run while a demo is being written ──────────────────────────────────

SCHEDULER_MODULES = (
    "auto_sync",
    "backup_scheduler",
    "on_duty_day_end_scheduler",
    "screening_cleanup_scheduler",
    "whatsapp_alert_scheduler",
)


def _stop_scheduler(module: Any) -> None:
    scheduler = getattr(module, "_scheduler", None)
    if scheduler is not None and getattr(scheduler, "running", False):
        scheduler.shutdown(wait=False)


@contextmanager
def schedulers_silenced() -> Iterator[None]:
    """apps.py starts every background scheduler for any entry point except ``test`` (a management command included):
    the WhatsApp alert job fires every minute and the day-end job acts on attendance, which must not happen on a
    database that is half way through being written. Stop the ones already started and make the rest a no-op until the
    block ends (the startup thread may not have got there yet)."""
    patched: list[tuple[Any, Any]] = []
    for name in SCHEDULER_MODULES:
        try:
            module = importlib.import_module(f"api.{name}")
        except Exception:  # noqa: BLE001 - a scheduler that cannot even be imported cannot be running
            continue
        original = getattr(module, "start_scheduler_if_needed", None)
        if original is None:
            continue
        module.start_scheduler_if_needed = lambda: None
        patched.append((module, original))
        _stop_scheduler(module)
    try:
        yield
    finally:
        for module, original in patched:
            _stop_scheduler(module)
            module.start_scheduler_if_needed = original


# ─── options, determinism ─────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Plan:
    """What the run was asked for. Everything the seeder invents is a function of these values (plus the seed)."""

    seed: int
    employees: int
    days: int
    today: date
    now: time  # the simulated factory clock of "today": only punches before it exist yet
    password: str = DEMO_PASSWORD
    payroll_months: int = 6
    manifest_dir: Path | None = None

    @property
    def window_start(self) -> date:
        """First day of the activity window (tea, gate, audit): ``--days`` days ending today."""
        return self.today - timedelta(days=self.days - 1)

    @property
    def closed_months(self) -> list[tuple[int, int]]:
        """The ``payroll_months`` calendar months before the current one, oldest first."""
        out, year, month = [], self.today.year, self.today.month
        for _ in range(self.payroll_months):
            month -= 1
            if month == 0:
                year, month = year - 1, 12
            out.append((year, month))
        return out[::-1]

    @property
    def history_start(self) -> date:
        """First day attendance is simulated for: the activity window, or the first payroll month when that is older
        (a slip is the sum of that month's days, so the days must exist for the slip to be consistent with them)."""
        year, month = self.closed_months[0]
        return min(self.window_start, date(year, month, 1))

    def describe(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "employees": self.employees,
            "days": self.days,
            "today": self.today.isoformat(),
            "now": self.now.strftime("%H:%M"),
            "payrollMonths": self.payroll_months,
        }


class Streams:
    """Named, independent random streams: ``streams("attendance")`` always starts the same for one seed, so a change in
    one domain never shifts the numbers another domain draws (str seeds go through sha512: stable across runs)."""

    def __init__(self, seed: int) -> None:
        self.seed = seed

    def __call__(self, name: str) -> random.Random:
        return random.Random(f"{self.seed}:{name}")


# ─── small helpers ────────────────────────────────────────────────────────────────────────────────────────────

_PAISE = Decimal("0.01")


def money(value: Any) -> Decimal:
    """A Decimal rounded half-up to 2 places, the way the payroll engine rounds (``_d2``)."""
    return Decimal(str(value)).quantize(_PAISE, rounding=ROUND_HALF_UP)


def daterange(first: date, last: date) -> Iterator[date]:
    """Every date from ``first`` to ``last``, both included."""
    day = first
    while day <= last:
        yield day
        day += timedelta(days=1)


def at(day: date, clock: time) -> datetime:
    """A factory wall-clock moment as the aware datetime the database stores (UTC underneath)."""
    return datetime.combine(day, clock, tzinfo=FACTORY_TZ)


def t2s(value: time) -> int:
    return value.hour * 3600 + value.minute * 60 + value.second


def s2t(seconds: int) -> time:
    seconds = max(0, min(int(seconds), 86399))
    return time(seconds // 3600, seconds % 3600 // 60, seconds % 60)


def shift_time(value: time, minutes: float) -> time:
    """``value`` moved by ``minutes`` (to the second), clamped to the same day."""
    return s2t(t2s(value) + round(minutes * 60))


def now_aware() -> datetime:
    """Right now as an aware datetime (the factory's zone; the database stores it as UTC)."""
    return datetime.now(FACTORY_TZ)


def office_hours(moment: datetime) -> datetime:
    """``moment`` moved into the HR office day (08:30-18:30, Monday to Saturday): a decision made at 1 am by a person is
    really made the next morning. Minutes and seconds are kept, so decisions do not all land on the hour."""
    local = moment.astimezone(FACTORY_TZ)
    day = local.date()
    if local.hour < 8 or (local.hour == 8 and local.minute < 30):
        local = datetime.combine(day, time(9, local.minute, local.second), tzinfo=FACTORY_TZ)
    elif local.hour > 18 or (local.hour == 18 and local.minute >= 30):
        local = datetime.combine(day + timedelta(days=1), time(9, local.minute, local.second), tzinfo=FACTORY_TZ)
    if local.weekday() == 6:
        local += timedelta(days=1)
    return local


def month_days(year: int, month: int) -> list[date]:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return list(daterange(date(year, month, 1), nxt - timedelta(days=1)))


def allocate(total: int, weights: Sequence[float], minimums: Sequence[int] | None = None) -> list[int]:
    """Split ``total`` over ``weights`` by the largest-remainder method: whole numbers that add up to ``total``.
    ``minimums`` are honoured while ``total`` allows (a department the stories need is never left empty)."""
    count = len(weights)
    floor = list(minimums or [0] * count)
    while sum(floor) > total and any(floor):  # not enough people to go round: take from the biggest minimum
        floor[floor.index(max(floor))] -= 1
    remaining = total - sum(floor)
    weight_sum = float(sum(weights)) or 1.0
    quotas = [remaining * w / weight_sum for w in weights]
    base = [int(q) for q in quotas]
    left = remaining - sum(base)
    order = sorted(range(count), key=lambda i: (-(quotas[i] - base[i]), i))
    for i in order[:left]:
        base[i] += 1
    return [f + b for f, b in zip(floor, base)]


def pick(rng: random.Random, items: Sequence[Any], weights: Sequence[float] | None = None) -> Any:
    return rng.choices(items, weights=weights, k=1)[0]


def chance(rng: random.Random, probability: float) -> bool:
    return rng.random() < probability


def clipped_normal(rng: random.Random, mean: float, sd: float, low: float, high: float) -> float:
    return max(low, min(high, rng.gauss(mean, sd)))


# ─── bulk insert that keeps real timestamps, and the record of what was created ───────────────────────────────


def _stamped_fields(model: type[models.Model]) -> list[models.DateTimeField]:
    return [
        f for f in model._meta.concrete_fields if isinstance(f, models.DateTimeField) and (f.auto_now or f.auto_now_add)
    ]


@contextmanager
def raw_timestamps(model: type[models.Model]) -> Iterator[None]:
    """``bulk_create`` runs every ``auto_now`` / ``auto_now_add`` field through ``pre_save``, which overwrites whatever
    was set with "now". Switch that off (on the field objects, in memory) for one insert so history keeps its dates."""
    saved = [(f, f.auto_now, f.auto_now_add) for f in _stamped_fields(model)]
    for f, _, _ in saved:
        f.auto_now = False
        f.auto_now_add = False
    try:
        yield
    finally:
        for f, auto_now, auto_now_add in saved:
            f.auto_now = auto_now
            f.auto_now_add = auto_now_add


def compress(ids: Iterable[int]) -> list[list[int]]:
    """Sorted unique ids as ``[first, last]`` runs: a bulk insert gets consecutive keys, so this stays tiny."""
    runs: list[list[int]] = []
    for value in sorted(set(ids)):
        if runs and value == runs[-1][1] + 1:
            runs[-1][1] = value
        else:
            runs.append([value, value])
    return runs


def expand(runs: Iterable[Sequence[int]]) -> Iterator[int]:
    for first, last in runs:
        yield from range(first, last + 1)


class Tracker:
    """Primary keys of every row the run created, by model (``api.Branch``)."""

    def __init__(self) -> None:
        self.ids: dict[str, list[int]] = {}

    def add(self, model: type[models.Model], objs: Iterable[models.Model]) -> None:
        self.ids.setdefault(model._meta.label, []).extend(o.pk for o in objs if o.pk is not None)

    def counts(self) -> dict[str, int]:
        return {label: len(ids) for label, ids in sorted(self.ids.items())}

    def to_json(self) -> dict[str, list[list[int]]]:
        return {label: compress(ids) for label, ids in sorted(self.ids.items())}


def manifest_path(manifest_dir: Path, database: str) -> Path:
    return manifest_dir / f"manifest-{database}.json"


@dataclass
class World:
    """What the run has built so far. Each domain module reads what earlier ones put here and adds its own."""

    plan: Plan
    streams: Streams
    out: Callable[[str], None]
    tracker: Tracker = field(default_factory=Tracker)
    started: float = field(default_factory=_time.monotonic)
    # organisation
    branches: dict[str, "Branch"] = field(default_factory=dict)  # by unit key: HO, U1, U2, U3
    departments: dict[tuple[str, str], "Department"] = field(default_factory=dict)  # (unit key, name)
    designations: dict[tuple[str, str, str], "Designation"] = field(default_factory=dict)  # (unit, dept, title)
    shifts: dict[tuple[str, str], "ShiftTemplate"] = field(default_factory=dict)  # (unit key, shift key)
    leave_types: dict[str, "LeaveType"] = field(default_factory=dict)  # by code
    settings: "PayrollSettings | None" = None
    roles: dict[str, "Role"] = field(default_factory=dict)
    hr_users: dict[str, "HRUser"] = field(default_factory=dict)  # by username
    md_user: "HRUser | None" = None
    gates: dict[str, list["GateDevice"]] = field(default_factory=dict)  # by unit key
    holidays: dict[date, str] = field(default_factory=dict)
    # people and what happened to them
    people: list["Person"] = field(default_factory=list)
    days: dict[int, dict[date, "Day"]] = field(default_factory=dict)  # person idx -> date -> verdict
    attended: dict[date, list[int]] = field(default_factory=dict)  # date -> person idx with a punch that day
    # run-wide facts
    created_singletons: dict[str, bool] = field(default_factory=dict)
    adjustments: dict[str, Any] = field(default_factory=dict)
    stories: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(
        default_factory=dict
    )  # hand-overs between domain modules (the leave plan, payroll runs)

    def say(self, message: str) -> None:
        self.out(message)

    def insert(
        self,
        model: type[models.Model],
        objs: Iterable[models.Model],
        *,
        when: datetime | None = None,
        batch_size: int = 2000,
    ) -> list[models.Model]:
        """Bulk-insert ``objs`` with the timestamps they carry; a stamped field left empty gets ``when`` (default now).
        The created keys are recorded for ``--purge``."""
        rows = list(objs)
        if not rows:
            return rows
        stamp = when or now_aware()
        fields = _stamped_fields(model)
        for row in rows:
            for f in fields:
                if getattr(row, f.attname) is None:
                    setattr(row, f.attname, stamp)
        with raw_timestamps(model):
            model.objects.bulk_create(rows, batch_size=batch_size)
        self.tracker.add(model, rows)
        return rows

    def elapsed(self) -> float:
        return _time.monotonic() - self.started


def person_name(first: str | None, last: str | None) -> str:
    return f"{first or ''} {last or ''}".strip()


def write_manifest(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, sort_keys=True, default=str), encoding="utf-8")


def read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("version") == MANIFEST_VERSION else None
