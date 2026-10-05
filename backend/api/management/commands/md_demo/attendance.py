"""The attendance of the demo company, day by day, for every employee.

``simulate`` plays every employee through every day of the history (``Plan.history_start`` .. today): who stays home, who
arrives late, who works overtime, who forgets to punch. For each day it produces the punches AND the verdict the attendance
engine would make of them (see ``verdicts``). ``create_attendance`` then writes the three tables the application keeps:
the raw punches (``AttendanceLog``), the daily verdict (``AttendanceDayRecord``) and the legacy "present" mark
(``Attendance``), plus overtime records and missing-punch requests.

The planted stories live in the probabilities below, each named after what it does (see ``Simulator.absence_odds``):

* a weekday effect (Monday and the day after a holiday), the Washing department of Unit 3 with about twice the company's
  absence, a bad fortnight in Unit 2 (a transport strike), a handful of chronic absentees and habitual late-comers, one
  employee absent five working days running with no leave on record, and a slight improvement over the last three weeks;
* overtime concentrated in Packing (every unit) and Merchandising (head office);
* a few missing punches, Saturday-off staff whose Saturdays are stored as absent rows (as the engine stores them), and a
  two-day device outage in Unit 3 that left no records at all;
* "today" is provisional: only the punches made before the simulated clock exist, so a worker who has not left yet is
  a half day until the evening punch arrives, exactly as in the live system.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, time, timedelta
from decimal import Decimal

from api.models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    CompensationLeaveCredit,
    MissingPunchRequest,
    OvertimeRecord,
    ProductionShiftConfig,
    ProductionShiftSegment,
)

from .common import World, at, chance, clipped_normal, daterange, office_hours, pick, s2t, t2s
from .leave import LeavePlan, clean_weeks
from .org import hr_name
from .people import Person
from .verdicts import ONE, Day, empty_day, production_verdict, staff_verdict

# ─── the odds ─────────────────────────────────────────────────────────────────────────────────────────────────

STAFF_ABSENCE = 0.032  # long-run share of scheduled days a typical staff member is absent
PRODUCTION_ABSENCE = 0.075  # ... and a typical production worker
DAILY_NOISE = 0.5  # share of the natural day-to-day randomness kept in the number of absentees (see draw_absentees)
CONTINUE_ABSENCE = 0.30  # the chance an absent worker is absent again the next scheduled day (illness comes in runs)
WEEKDAY_ABSENCE = {0: 1.7, 1: 1.0, 2: 0.9, 3: 0.9, 4: 1.0, 5: 1.3, 6: 1.0}  # Monday is the bad day
AFTER_HOLIDAY = 1.9  # the working day after a holiday
PROBLEM_DEPARTMENT = ("U3", "Washing")
PROBLEM_FACTOR = 2.2  # Washing absence is about double the company's
BAD_UNIT = "U2"
BAD_FORTNIGHT = (52, 39)  # days before today the fortnight starts and ends
BAD_FACTOR = 2.6
CHRONIC_FACTOR = 4.0
IMPROVING_DAYS = 21  # the last three weeks improve, to 78% of the usual absence and lateness by today
IMPROVEMENT_FLOOR = 0.78
LATE_BASE = {"staff": 0.055, "production": 0.040}
HABITUAL_LATE = 8.0
WEEKDAY_LATE = {0: 1.5, 5: 1.2}
MISSING_PUNCH = 0.008
LEFT_AFTER_LUNCH = 0.007  # staff who go home at lunch
LEFT_EARLY = 0.012  # production workers who leave mid-afternoon
SLOW_LUNCH_RETURN = 0.03
TWO_PUNCH_DAY = 0.12  # production days with only an arrival and a departure punch
#: Staff overtime (a last punch 60+ minutes past the shift end), by department.
STAFF_OVERTIME = {
    "Merchandising": 0.20,
    "Accounts & Finance": 0.08,
    "Purchase & Stores": 0.06,
    "IT & Systems": 0.04,
    "Maintenance": 0.05,
    "Stores": 0.05,
}
STAFF_OVERTIME_DEFAULT = 0.02
#: Production workers who stay to 8 pm (the extra half shift), by department; extended-shift people stay far more often.
PRODUCTION_OVERTIME = {"Packing": 0.52, "Stitching": 0.20, "Checking": 0.12, "Ironing": 0.12, "Cutting": 0.10}
PRODUCTION_OVERTIME_DEFAULT = 0.05
PRODUCTION_REGULAR_END = time(17, 30)
SUNDAY_WORKER = 0.60
SUNDAY_OTHER = 0.03
OUTAGE_UNIT = "U3"

DEFAULT_SEGMENTS = (
    ("Morning 1", time(8, 30), time(10, 30), "0.25", 1),
    ("Morning 2", time(10, 30), time(12, 45), "0.25", 2),
    ("Afternoon 1", time(13, 30), time(15, 30), "0.25", 3),
    ("Afternoon 2", time(15, 30), time(17, 30), "0.25", 4),
    ("Evening", time(17, 30), time(20, 0), "0.50", 5),
)
SLOTS_FOUR = ("morning_in", "lunch_out", "lunch_in", "evening_out")
SLOTS_TWO = ("morning_in", "evening_out")
MISSING_REASONS = [
    "Forgot to punch while leaving",
    "Fingerprint was not recognised",
    "Device was busy at the gate",
    "Rushed out for an emergency",
]


@dataclass
class MissingPlan:
    person: Person
    day: date
    punch: time
    index: int
    of: int
    fate: str  # approved | pending | rejected | none


class Simulator:
    def __init__(self, world: World) -> None:
        self.world = world
        self.plan = world.plan
        self.today = world.plan.today
        self.settings = world.settings
        self.rng = world.streams("attendance")
        self.leave: LeavePlan = world.extra["leave"]
        self.config = ProductionShiftConfig.objects.filter(pk=1).first() or ProductionShiftConfig()
        segments = list(ProductionShiftSegment.objects.filter(is_active=True).order_by("order", "id"))
        if not segments:  # the migration's own defaults, kept in memory only
            segments = [
                ProductionShiftSegment(label=n, start_time=s, end_time=e, shift_value=Decimal(v), order=o)
                for n, s, e, v, o in DEFAULT_SEGMENTS
            ]
        self.segments = segments
        today = self.today
        self.bad_start = today - timedelta(days=BAD_FORTNIGHT[0])
        self.bad_end = today - timedelta(days=BAD_FORTNIGHT[1])
        self.missing: list[MissingPlan] = []
        weeks = clean_weeks(world)
        self.five_day = weeks[0] if weeks else None
        planted = {
            monday + timedelta(days=i) for monday in weeks[:2] for i in range(5)
        }  # the two story weeks stay visible
        self.gap_days = self._outage_days(planted)
        world.stories["badFortnight"] = {
            "unit": BAD_UNIT,
            "from": self.bad_start.isoformat(),
            "to": self.bad_end.isoformat(),
        }
        world.stories["problemDepartment"] = {"unit": PROBLEM_DEPARTMENT[0], "department": PROBLEM_DEPARTMENT[1]}
        world.stories["deviceOutage"] = {"unit": OUTAGE_UNIT, "days": [d.isoformat() for d in sorted(self.gap_days)]}
        self.shifts = world.shifts
        self.holidays = world.holidays

    # ─── the odds, as functions ───────────────────────────────────────────────────────────────────────────────

    def _outage_days(self, avoid: set[date]) -> set[date]:
        """Two consecutive working days, about four weeks back, on which the Unit 3 biometric devices recorded nothing."""
        day = self.today - timedelta(days=27)
        while day > self.plan.history_start:
            nxt = day + timedelta(days=1)
            if all(d.weekday() != 6 and d not in self.world.holidays and d not in avoid for d in (day, nxt)):
                return {day, nxt}
            day -= timedelta(days=1)
        return set()

    def improving(self, day: date) -> float:
        """1.0 until three weeks ago, then falling linearly to ``IMPROVEMENT_FLOOR`` today."""
        ago = (self.today - day).days
        return 1.0 if ago >= IMPROVING_DAYS else IMPROVEMENT_FLOOR + (1.0 - IMPROVEMENT_FLOOR) * ago / IMPROVING_DAYS

    def in_bad_fortnight(self, p: Person, day: date) -> bool:
        return p.unit == BAD_UNIT and self.bad_start <= day <= self.bad_end

    def absence_odds(self, p: Person, day: date) -> float:
        """The chance this person stays home, today, given they were present yesterday."""
        target = PRODUCTION_ABSENCE if p.kind == "production" else STAFF_ABSENCE
        start = target * (1 - CONTINUE_ABSENCE) / (1 - target)
        odds = start * WEEKDAY_ABSENCE[day.weekday()] * self.improving(day)
        if (day - timedelta(days=1)) in self.holidays:
            odds *= AFTER_HOLIDAY
        if (p.unit, p.dept) == PROBLEM_DEPARTMENT:
            odds *= PROBLEM_FACTOR
        if self.in_bad_fortnight(p, day):
            odds *= BAD_FACTOR
        if "chronic" in p.flags:
            odds *= CHRONIC_FACTOR
        if "early_leaver" in p.flags:
            odds *= 1.8
        return min(odds, 0.6)

    def late_odds(self, p: Person, day: date) -> float:
        odds = LATE_BASE[p.kind] * WEEKDAY_LATE.get(day.weekday(), 1.0) * self.improving(day)
        if "late" in p.flags:
            odds *= HABITUAL_LATE
        if self.in_bad_fortnight(p, day):
            odds *= 1.5
        if (day - timedelta(days=1)) in self.holidays:
            odds *= 1.3
        return min(odds, 0.7)

    def forced(self, p: Person, day: date) -> bool | None:
        """True / False when the day's attendance is decided for the person already, None when it is left to chance."""
        if "five_day" in p.flags and self.five_day is not None:
            monday = self.five_day
            if monday <= day <= monday + timedelta(days=4):
                return True
            if monday - timedelta(days=3) <= day <= monday + timedelta(days=8):
                return False  # the days around it are worked, so the absence is exactly five days
        if day in self.leave.permission_days.get(p.idx, {}):
            return False  # someone who asked permission to come late comes
        return None

    def draw_absentees(self, candidates: list[Person], day: date, was_absent: dict[int, bool]) -> set[int]:
        """Who stays home today, among those with an ordinary working day.

        Each person has their own odds (the weekday, their department, the unit's bad fortnight, being a chronic absentee ...).
        The NUMBER of absentees is the expected number plus a share (``DAILY_NOISE``) of the natural day-to-day randomness,
        and the people are drawn in proportion to their odds. A pure coin toss per person would bury the planted effects
        (a Monday spike, a three-week improvement) under a week-to-week noise of 1-2 points; this keeps them legible while
        the individual stories (who is absent, for how long) stay random."""
        rng = self.rng
        absent: set[int] = set()
        pool: list[Person] = []
        for p in candidates:
            decided = self.forced(p, day)
            if decided is True:
                absent.add(p.idx)
            elif decided is None:
                pool.append(p)
        odds = [
            (0.45 if "chronic" in p.flags else CONTINUE_ABSENCE) if was_absent[p.idx] else self.absence_odds(p, day)
            for p in pool
        ]
        if not pool:
            return absent
        mean = sum(odds)
        spread = math.sqrt(sum(q * (1 - q) for q in odds))
        count = max(0, min(len(pool), round(mean + rng.gauss(0, DAILY_NOISE * spread))))
        # weighted sampling without replacement: the largest log(u)/q are drawn
        ranked = sorted(range(len(pool)), key=lambda i: -(math.log(1.0 - rng.random()) / max(odds[i], 1e-9)))
        absent.update(pool[i].idx for i in ranked[:count])
        return absent

    # ─── punches ──────────────────────────────────────────────────────────────────────────────────────────────

    def _jitter(self, clock: time, minutes: float) -> time:
        return s2t(t2s(clock) + round(minutes * 60) + self.rng.randint(0, 59))

    def staff_times(self, p: Person, day: date) -> list[time]:
        """The punches of a staff day: 4 (arrival, lunch out, lunch in, departure), fewer on the odd day."""
        rng = self.rng
        settings = self.settings
        shift = self.shifts[(p.unit, p.shift_key)]
        start, end, grace, fhe = shift.start_time, shift.end_time, shift.grace_period_minutes, shift.first_half_end
        late_w, perm_w, extra = (
            settings.arrival_late_window_minutes,
            settings.arrival_permission_window_minutes,
            settings.arrival_extra_minutes,
        )

        permissions = self.leave.permission_days.get(p.idx, {}).get(day, [])
        if "morning_late_in" in permissions and chance(rng, 0.85):
            kind = "excused"
        elif chance(rng, self.late_odds(p, day)):
            kind = pick(rng, ["late", "quarter", "second_half"], [90, 7, 3] if "late" not in p.flags else [96, 3, 1])
        else:
            kind = "ontime"
        if kind == "ontime":
            minutes = clipped_normal(rng, -6, 8, -40, grace - 0.3)
        elif kind == "late":
            minutes = grace + 1 + min(rng.expovariate(1 / 14), late_w - 2)
        elif kind == "excused":
            minutes = grace + late_w + 1 + rng.uniform(0, perm_w - 2)
        elif kind == "quarter":
            minutes = grace + late_w + 1 + rng.uniform(0, perm_w + extra - 2)
        else:  # second_half: the first half is missed altogether
            minutes = grace + late_w + perm_w + extra + 1 + rng.uniform(0, 100)
        arrival = self._jitter(start, minutes)

        overtime = chance(
            rng,
            STAFF_OVERTIME.get(p.dept, STAFF_OVERTIME_DEFAULT)
            * (2.5 if day.day >= 25 and p.dept == "Accounts & Finance" else 1),
        )
        leave = self._jitter(end, rng.uniform(61, 150) if overtime else clipped_normal(rng, 4, 8, -16, 25))
        if kind == "second_half":
            return self._ascending([arrival, leave])
        lunch_out = self._jitter(fhe, clipped_normal(rng, 0, 4, -20, 20))
        if chance(rng, LEFT_AFTER_LUNCH):
            return self._ascending([arrival, lunch_out])
        lunch_in = s2t(t2s(lunch_out) + round(clipped_normal(rng, 52, 5, 33, 80) * 60) + rng.randint(0, 59))
        return self._ascending([arrival, lunch_out, lunch_in, leave])

    def production_times(self, p: Person, day: date) -> list[time]:
        """The punches of a production day: arrival, lunch out, lunch in, departure (two punches on a short-staffed day)."""
        rng = self.rng
        cfg = self.config
        grace = cfg.grace_minutes or 10
        if chance(rng, self.late_odds(p, day)):
            minutes = grace + 1 + min(rng.expovariate(1 / 15), 60)
        else:
            minutes = clipped_normal(
                rng, -4, 5, -35, grace - 1.01
            )  # the engine compares to the second: 59 s of jitter must still fit
        arrival = self._jitter(cfg.punch1_time, minutes)
        base = PRODUCTION_OVERTIME.get(p.dept, PRODUCTION_OVERTIME_DEFAULT)
        stays = min(0.92, base * 1.7) if p.shift_key == "extended" else base * 0.25
        if "sunday_worker" in p.flags and day.weekday() == 6:
            stays = 0.5
        if chance(rng, stays):
            leave = self._jitter(cfg.punch4_time, clipped_normal(rng, 3, 6, -9, 25))
        elif chance(rng, LEFT_EARLY):
            leave = s2t(rng.randint(15 * 3600, 17 * 3600 + 900))
        else:
            leave = self._jitter(PRODUCTION_REGULAR_END, clipped_normal(rng, 4, 6, -6, 25))
        if chance(rng, TWO_PUNCH_DAY):
            return self._ascending([arrival, leave])
        lunch_out = self._jitter(cfg.punch2_time, clipped_normal(rng, 0, 4, -9, 14))
        slow = chance(rng, SLOW_LUNCH_RETURN)
        lunch_in = self._jitter(cfg.punch3_time, rng.uniform(11, 28) if slow else clipped_normal(rng, 1, 4, -8, 9))
        return self._ascending([arrival, lunch_out, lunch_in, leave])

    @staticmethod
    def _ascending(times: list[time]) -> list[time]:
        """Strictly increasing clock times (no two punches in the same second), all before midnight."""
        out: list[time] = []
        for t in times:
            seconds = t2s(t)
            if out and seconds <= t2s(out[-1]):
                seconds = t2s(out[-1]) + 61
            out.append(s2t(min(seconds, 86399)))
        return out

    # ─── one day ──────────────────────────────────────────────────────────────────────────────────────────────

    def verdict(self, p: Person, day: date, times: list[time]) -> Day:
        if p.kind == "production":
            return production_verdict(self.config, self.segments, times)
        perms = self.leave.permission_days.get(p.idx, {}).get(day, [])
        return staff_verdict(self.settings, self.shifts[(p.unit, p.shift_key)], times, perms)

    def attend(self, p: Person, day: date) -> Day:
        """A day the person comes to work: the punches (some may go missing) and what the engine makes of them."""
        times = self.production_times(p, day) if p.kind == "production" else self.staff_times(p, day)
        added: time | None = None
        if len(times) >= 2 and day < self.today and chance(self.rng, MISSING_PUNCH):
            lost = self.rng.randrange(len(times))
            fate = pick(self.rng, ["approved", "pending", "rejected", "none"], [50, 22, 6, 22])
            if fate == "pending" and day < self.today - timedelta(days=6):
                fate = "approved"
            self.missing.append(MissingPlan(p, day, times[lost], lost, len(times), fate))
            if fate == "approved":
                added = times[lost]  # HR put the punch back: the day is complete, one punch carries a different source
            else:
                times = times[:lost] + times[lost + 1 :]
        if day == self.today:
            times = [t for t in times if t <= self.plan.now]
        if not times:
            return empty_day("absent", "production" if p.kind == "production" else "strict")
        result = self.verdict(p, day, times)
        result.added_punch = added
        return result

    def fixed_day(self, p: Person, day: date) -> Day | None:
        """The day when nothing is left to chance (leave, holiday, weekly off, a decided Casual Leave, a production Sunday),
        or None for an ordinary working day (the absence draw decides it)."""
        leave = self.leave
        weekday = day.weekday()
        holiday = day in self.holidays
        if p.kind == "staff":
            if day in leave.leave_days.get(p.idx, ()):
                return empty_day("on_leave", "strict")
            decision = leave.casual_days.get(p.idx, {}).get(day)
            if decision == "approved":
                return Day(
                    "present",
                    ONE,
                    source="manual",
                    override_by=self._cl_reviewer(p, day),
                    override_note="Casual Leave (paid) -approved",
                )
            if decision == "rejected":
                return Day(
                    "on_leave",
                    source="manual",
                    override_by=self._cl_reviewer(p, day),
                    override_note="Casual Leave rejected -marked as leave",
                )
            if holiday or weekday == 6:
                return empty_day("holiday", "strict")
            if weekday == 5 and p.saturday_off:
                return empty_day("absent", "strict")  # the engine knows no Saturday-off: it stores an absent row
            return None
        if holiday:
            return empty_day("holiday", "production")
        if weekday == 6:  # production run on Sundays: a few come in, the rest are stored absent by the engine
            if chance(self.rng, SUNDAY_WORKER if "sunday_worker" in p.flags else SUNDAY_OTHER):
                return self.attend(p, day)
            return empty_day("absent", "production")
        return None

    def _cl_reviewer(self, p: Person, day: date) -> str:
        for item in self.leave.casuals:
            if item.person is p and item.day == day:
                return item.reviewed_by or hr_name(self.world, "hr_demo")
        return hr_name(self.world, "hr_demo")

    def run(self) -> None:
        world = self.world
        people = sorted(world.people, key=lambda x: x.idx)
        was_absent = {p.idx: False for p in people}
        days: dict[int, dict[date, Day]] = {p.idx: {} for p in people}
        attended: dict[date, list[int]] = {}
        for day in daterange(self.plan.history_start, self.today):
            candidates: list[Person] = []
            for p in people:
                if not p.employed_on(day):
                    continue
                fixed = self.fixed_day(p, day)
                if fixed is None:
                    candidates.append(p)
                else:
                    days[p.idx][day] = fixed
            absent = self.draw_absentees(candidates, day, was_absent)
            for p in candidates:
                if p.idx in absent:
                    days[p.idx][day] = empty_day("absent", "production" if p.kind == "production" else "strict")
                    was_absent[p.idx] = True
                else:
                    days[p.idx][day] = self.attend(p, day)
                    was_absent[p.idx] = False
            for p in people:
                result = days[p.idx].get(day)
                if result is None:
                    continue
                if p.unit == OUTAGE_UNIT and day in self.gap_days:
                    result.persist = False
                if result.punches:
                    attended.setdefault(day, []).append(p.idx)
        world.days = days
        world.attended = attended


def simulate(world: World) -> None:
    world.say("Attendance (simulating)")
    sim = Simulator(world)
    sim.run()
    world.extra["missing_plans"] = sim.missing
    total = sum(len(d) for d in world.days.values())
    world.say(f"  {total:,} employee-days from {world.plan.history_start} to {world.plan.today}")


# ─── writing ──────────────────────────────────────────────────────────────────────────────────────────────────


def create_attendance(world: World) -> None:
    world.say("Attendance (writing)")
    today = world.plan.today
    now = at(today, world.plan.now)
    records: list[AttendanceDayRecord] = []
    logs: list[AttendanceLog] = []
    marks: list[Attendance] = []
    for p in sorted(world.people, key=lambda x: x.idx):
        source = f"biometric:adms:DEMO-{p.unit}"
        for day, d in world.days[p.idx].items():
            if not d.persist:
                continue
            if day == today:
                updated = now
            elif d.source == "manual":
                updated = at(day + timedelta(days=1), time(10, 0))
            else:
                updated = at(day, time(23, 30))
            records.append(
                AttendanceDayRecord(
                    employee=p.emp,
                    date=day,
                    status=d.status,
                    is_late=d.is_late,
                    is_half_shift=d.is_half_shift,
                    early_leave=d.early_leave,
                    late_afternoon=d.late_afternoon,
                    morning_permission_applied=d.morning_permission_applied,
                    evening_permission_applied=d.evening_permission_applied,
                    middle_permission_today=d.middle_permission_today,
                    permission_afternoon=d.permission_afternoon,
                    arrival_zone=d.arrival_zone,
                    late_reason=d.late_reason,
                    shifts_earned=d.shifts,
                    first_punch=d.first_punch,
                    last_punch=d.last_punch,
                    total_punches=len(d.punches),
                    computed_mode=d.mode if d.mode == "production" else world.settings.attendance_mode,
                    source=d.source,
                    primary_source="Biometric" if d.punches else None,
                    override_by=d.override_by,
                    override_note=d.override_note,
                    updated_at=updated,
                )
            )
            for i, t in enumerate(d.punches):
                logs.append(
                    AttendanceLog(
                        employee=p.emp,
                        date=day,
                        punch_time=t,
                        punch_type="IN" if i % 2 == 0 else "OUT",
                        source="missing_punch:approved" if t == d.added_punch else source,
                        created_at=at(day, t) + timedelta(seconds=7),
                    )
                )
            if d.punches:
                marks.append(
                    Attendance(employee=p.emp, date=day.isoformat(), present=True, created_at=at(day, d.punches[0]))
                )
    world.insert(AttendanceDayRecord, records, batch_size=3000)
    world.insert(AttendanceLog, logs, batch_size=5000)
    world.insert(Attendance, marks, batch_size=5000)
    _create_overtime(world)
    _create_missing_punch_requests(world)
    world.say(f"  {len(records):,} day records, {len(logs):,} punches, {len(marks):,} present marks")


def _create_overtime(world: World) -> None:
    """Staff overtime as HR sees it: detected from the punches, then announced as pay or as a relaxation day (or rejected).
    The pay days of each month feed the salary slips (one day's pay per announced day)."""
    plan = world.plan
    rng = world.streams("overtime")
    threshold = world.settings.ot_threshold_minutes or 60
    hr = hr_name(world, "hr_demo")
    rows: list[OvertimeRecord] = []
    pay_days: dict[tuple[int, int, int], int] = {}
    for p in sorted(world.people, key=lambda x: x.idx):
        if p.kind != "staff":
            continue
        shift = world.shifts[(p.unit, p.shift_key)]
        for day, d in world.days[p.idx].items():
            if d.ot_minutes < threshold or not d.persist or d.last_punch is None:
                continue
            current_month = (day.year, day.month) == (plan.today.year, plan.today.month)
            if current_month:
                status = "announced" if chance(rng, 0.2) else "detected"
            else:
                status = pick(rng, ["announced", "rejected", "detected"], [86, 8, 6])
            kind = None
            decided = None
            if status == "announced":
                kind = "pay" if chance(rng, 0.72) else "relaxation"
                decided = at(min(plan.today, day + timedelta(days=rng.randint(1, 20))), time(11, 30))
            elif status == "rejected":
                decided = at(min(plan.today, day + timedelta(days=rng.randint(1, 10))), time(11, 30))
            rows.append(
                OvertimeRecord(
                    employee=p.emp,
                    date=day,
                    shift_end_time=shift.end_time,
                    last_punch_out=d.last_punch,
                    ot_minutes=d.ot_minutes,
                    status=status,
                    compensation_type=kind,
                    announced_by=hr if decided else None,
                    announced_at=decided,
                    created_at=min(at(day + timedelta(days=1), time(9, 0)), at(plan.today, plan.now)),
                )
            )
            if kind == "pay":
                key = (p.idx, day.year, day.month)
                pay_days[key] = pay_days.get(key, 0) + 1
    world.insert(OvertimeRecord, rows)
    credits = [
        CompensationLeaveCredit(
            employee=row.employee,
            source_overtime_record=row,
            status="used" if chance(rng, 0.3) else "available",
            used_date=None,
            created_at=row.announced_at,
        )
        for row in rows
        if row.compensation_type == "relaxation"
    ]
    for credit in credits:
        if credit.status == "used":
            credit.used_date = min(plan.today, credit.created_at.date() + timedelta(days=rng.randint(7, 30)))
    world.insert(CompensationLeaveCredit, credits)
    world.extra["ot_pay_days"] = pay_days
    world.summary["overtimeRecords"] = len(rows)


def _create_missing_punch_requests(world: World) -> None:
    plans: list[MissingPlan] = world.extra["missing_plans"]
    rng = world.streams("missing-punch")
    rows: list[MissingPunchRequest] = []
    heads = world.extra["heads"]
    for m in plans:
        if m.fate == "none" or not world.days[m.person.idx].get(m.day, Day("absent")).persist:
            continue
        p = m.person
        slots = SLOTS_FOUR if m.of >= 3 else SLOTS_TWO
        slot = slots[m.index] if m.index < len(slots) else slots[-1]
        created = at(m.day + timedelta(days=1), time(9, rng.randint(0, 59)))
        head = heads.get((p.unit, p.dept))
        hod_name = head.full_name if head is not None and head is not p else hr_name(world, "hr_demo")
        hr = hr_name(world, "unit2hr_demo" if p.unit == "U2" else "hr_demo")
        status = {
            "approved": "approved",
            "pending": "pending_hr" if chance(rng, 0.5) else "pending_hod",
            "rejected": "rejected",
        }[m.fate]
        hod_at = office_hours(created + timedelta(hours=rng.randint(2, 20)))
        hr_at = office_hours(hod_at + timedelta(hours=rng.randint(2, 20)))
        trail = []
        if status != "pending_hod":
            trail.append(
                {
                    "role": "hod",
                    "decision": "rejected" if m.fate == "rejected" else "approved",
                    "by": hod_name,
                    "at": hod_at.isoformat(),
                    "comment": None,
                }
            )
        if status == "approved":
            trail.append({"role": "hr", "decision": "approved", "by": hr, "at": hr_at.isoformat(), "comment": None})
        rows.append(
            MissingPunchRequest(
                employee=p.emp,
                date=m.day,
                punch_time=m.punch,
                punch_type="IN" if m.index % 2 == 0 else "OUT",
                punch_slot=slot,
                reason=rng.choice(MISSING_REASONS),
                status=status,
                hod_reviewed_by=hod_name if status != "pending_hod" else None,
                hod_reviewed_at=hod_at if status != "pending_hod" else None,
                approval_trail=trail,
                hr_reviewed_by=hr if status == "approved" else None,
                hr_reviewed_at=hr_at if status == "approved" else None,
                created_at=created,
            )
        )
    world.insert(MissingPunchRequest, rows)
    world.summary["missingPunchRequests"] = len(rows)
