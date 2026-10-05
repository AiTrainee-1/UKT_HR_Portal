"""What people did in the system: the audit trail, sign-in sessions and sign-in attempts.

Five HR accounts work through the window in office hours, each with its own habits (attendance imports in the early morning,
payroll generation and locking at the start of each month, report exports all day), and the Managing Director signs in a few
times a week. Every action string is the one the application's own views write (``log_action`` in the views), so the Activity
page reads like the real thing. Planted on top: sensitive actions (employee deletes, payroll locked, a role change, settings
and backups), two after-hours bursts, a sign-in from a new device in the small hours, and a password-guessing attempt on
"admin" that gets locked out.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from api.models import AuditLog, HrLoginAttempt, HRUser, LoginSession
from api.reporting import registry
from api.session_utils import parse_user_agent

from .common import MD_USERNAME, OFFICE_NET, World, at, chance, clipped_normal, pick, s2t
from .org import HR_USERS, MD_FULL_NAME

UA_WINDOWS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
UA_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0"
UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

#: username -> (office PC address, browser, sign-in hour, sign-out hour, actions per working day, share of working days present)
HABITS = {
    "hr_demo": ("21", UA_WINDOWS, 9.1, 18.0, 9, 0.93),
    "payroll_demo": ("34", UA_EDGE, 9.5, 18.2, 6, 0.90),
    "attendance_demo": ("42", UA_WINDOWS, 8.3, 17.4, 8, 0.95),
    "recruit_demo": ("57", UA_MAC, 9.8, 18.1, 4, 0.82),
    "unit2hr_demo": ("63", UA_WINDOWS, 9.0, 17.8, 6, 0.88),
    "gate_demo": ("71", UA_EDGE, 8.8, 17.5, 3, 0.85),
}
SENSITIVE_PAUSE = 6  # days between planted sensitive actions are never closer than this


@dataclass
class Actor:
    username: str
    label: str
    user: HRUser | None
    ip: str
    ua: str
    branch_id: int | None


def _filters(world: World, rng: random.Random, day: date) -> str:
    start = day.replace(day=1) - timedelta(days=rng.choice([0, 30, 60]))
    unit = rng.choice(["All units", "Unit 1 - Kangeyam Road", "Unit 2 - Avinashi Road", "Unit 3 - Palladam Road"])
    return f"Period: {start.strftime('%d-%m-%Y')} to {day.strftime('%d-%m-%Y')}; Unit: {unit}"


def _report_titles() -> list[str]:
    wanted = {"attendance", "employees", "payroll", "finance", "gate"}
    titles = sorted({s.title for s in registry.all_specs() if getattr(s, "category", None) in wanted})
    return titles or ["Absentee Analysis", "Late Coming Detail", "Half-Day Report", "Department-wise Daily Strength"]


class Trail:
    """Collects audit rows, sessions and sign-in attempts, then writes them in three bulk inserts."""

    def __init__(self, world: World) -> None:
        self.world = world
        self.rng = world.streams("activity")
        self.today = world.plan.today
        self.now = at(self.today, world.plan.now)
        self.audit: list[AuditLog] = []
        self.sessions: list[LoginSession] = []
        self.attempts: list[HrLoginAttempt] = []
        self.last_login: dict[str, datetime] = {}
        self.reports = _report_titles()
        self.people = [p for p in world.people]
        self.actors: dict[str, Actor] = {}
        for username, (full_name, _role, unit, _dept) in HR_USERS.items():
            octet, ua = HABITS[username][0], HABITS[username][1]
            user = world.hr_users[username]
            self.actors[username] = Actor(
                username, full_name, user, f"{OFFICE_NET}{octet}", ua, world.branches[unit].pk if unit else None
            )
        md = world.md_user
        self.actors[MD_USERNAME] = Actor(MD_USERNAME, MD_FULL_NAME, md, f"{OFFICE_NET}9", UA_IPHONE, None)
        self.actors["administrator"] = Actor("administrator", "Administrator", None, f"{OFFICE_NET}2", UA_WINDOWS, None)

    # ─── rows ─────────────────────────────────────────────────────────────────────────────────────────────────

    def log(
        self,
        actor: Actor,
        when: datetime,
        action: str,
        module: str,
        text: str,
        *,
        record_id: int | None = None,
        ip: str | None = None,
    ) -> None:
        if when > self.now:
            return
        self.audit.append(
            AuditLog(
                user_type="hr",
                user_id=None,
                branch_id=actor.branch_id,
                user_name=actor.label,
                action=action,
                module=module,
                record_id=record_id,
                record_description=text[:480],
                ip_address=ip or actor.ip,
                created_at=when,
            )
        )

    def attempt(self, username: str, ip: str, success: bool, when: datetime) -> None:
        if when <= self.now:
            self.attempts.append(HrLoginAttempt(username=username, ip_address=ip, success=success, created_at=when))

    def sign_in(
        self,
        actor: Actor,
        when: datetime,
        *,
        ip: str | None = None,
        ua: str | None = None,
        end: datetime | None = None,
        logout: bool = False,
    ) -> None:
        if when > self.now:
            return
        ip, ua = ip or actor.ip, ua or actor.ua
        self.attempt(actor.username, ip, True, when - timedelta(seconds=2))
        if actor.user is not None:
            last = min(end or when + timedelta(hours=8), self.now)
            self.sessions.append(
                LoginSession(
                    hr_user=actor.user,
                    jti=uuid.UUID(int=self.rng.getrandbits(128)).hex,
                    device_label=parse_user_agent(ua),
                    user_agent=ua,
                    ip_address=ip,
                    created_at=when,
                    last_seen_at=last,
                    revoked_at=last if logout else None,
                )
            )
            self.last_login[actor.username] = max(when, self.last_login.get(actor.username, when))
        self.log(actor, when, "login", "auth", f"{actor.label} ({actor.username}) logged in", ip=ip)

    def clock(self, day: date, hour: float, spread: float = 0.35) -> datetime:
        seconds = int(clipped_normal(self.rng, hour * 3600, spread * 3600, 6 * 3600, 23 * 3600 + 3000))
        return at(day, s2t(seconds))

    # ─── a person's name for a log line ───────────────────────────────────────────────────────────────────────

    def someone(self, *, unit: str | None = None):
        pool = [p for p in self.people if unit is None or p.unit == unit]
        return self.rng.choice(pool or self.people)

    def employee_text(self, verb: str, unit: str | None = None) -> tuple[str, int | None]:
        p = self.someone(unit=unit)
        return f"{verb} employee {p.code} -{p.name.first} {p.name.last}", p.emp.pk if p.emp else None


def _daily(world: World, trail: Trail, day: date) -> None:
    rng = trail.rng
    reports = trail.reports
    for username, (octet, ua, login_h, logout_h, mean, presence) in HABITS.items():
        weekday = day.weekday()
        if weekday == 6 or day in world.holidays and chance(rng, 0.8):
            continue
        if weekday == 5 and not chance(rng, 0.30):
            continue
        if not chance(rng, presence):
            continue
        actor = trail.actors[username]
        start = trail.clock(day, login_h, 0.30)
        end = trail.clock(day, logout_h, 0.30)
        if end <= start:
            end = start + timedelta(hours=7)
        trail.sign_in(actor, start, end=end, logout=chance(rng, 0.6))
        if chance(rng, 0.05):  # a mistyped password before signing in
            trail.attempt(username, actor.ip, False, start - timedelta(seconds=40))
            trail.log(actor, start - timedelta(seconds=38), "login_failed", "auth", f"Failed login for: {username}")
        unit = (
            None
            if actor.branch_id is None
            else next((u for u, b in world.branches.items() if b.pk == actor.branch_id), None)
        )
        n = max(1, round(rng.gauss(mean, mean * 0.35)))
        for _ in range(n):
            when = start + timedelta(seconds=rng.randint(120, max(240, int((end - start).total_seconds()))))
            text, rid = "", None
            if username in ("hr_demo", "unit2hr_demo"):
                kind = pick(rng, ["update", "export", "other"], [58, 34, 8])
                if kind == "update":
                    text, rid = trail.employee_text("Updated", unit)
                    trail.log(actor, when, "update", "employees", text, record_id=rid)
                elif kind == "export":
                    trail.log(
                        actor,
                        when,
                        "export",
                        "reports",
                        f"{rng.choice(reports)} - XLSX - {rng.randint(18, 240)} rows - {_filters(world, rng, day)}",
                    )
                else:
                    trail.log(
                        actor,
                        when,
                        "update",
                        "employees",
                        f"Bulk enabled live location tracking for {rng.randint(2, 14)} employee(s)",
                    )
            elif username == "payroll_demo":
                trail.log(
                    actor,
                    when,
                    "export",
                    "reports",
                    f"{rng.choice(reports)} - PDF - {rng.randint(40, 240)} rows - {_filters(world, rng, day)}",
                )
            elif username == "attendance_demo":
                kind = pick(rng, ["import", "unmatched", "export", "report"], [28, 14, 34, 24])
                if kind == "import":
                    trail.log(
                        actor,
                        when,
                        "update",
                        "attendance",
                        f"Punch View import: {rng.randint(20, 300)} updated, {rng.randint(0, 40)} created, {rng.randint(0, 3)} rejected",
                    )
                elif kind == "unmatched":
                    trail.log(
                        actor, when, "update", "attendance", f"Resolved unmatched device ID {rng.randint(1000, 9999)}"
                    )
                elif kind == "export":
                    trail.log(actor, when, "export", "attendance", f"Exported {rng.randint(120, 4800)} punches")
                else:
                    trail.log(
                        actor,
                        when,
                        "export",
                        "reports",
                        f"{rng.choice(reports)} - XLSX - {rng.randint(18, 240)} rows - {_filters(world, rng, day)}",
                    )
            elif username == "recruit_demo":
                trail.log(
                    actor,
                    when,
                    "export",
                    "reports",
                    f"{rng.choice(reports)} - XLSX - {rng.randint(10, 120)} rows - {_filters(world, rng, day)}",
                )
            else:  # gate_demo
                title = rng.choice(["Visitor Register", "Outpass Register", "Tea Break Summary", "Gate Scan Log"])
                trail.log(
                    actor,
                    when,
                    "export",
                    "reports",
                    f"{title} - XLSX - {rng.randint(8, 160)} rows - {_filters(world, rng, day)}",
                )
    # the Managing Director reads, a few mornings a week
    if day.weekday() < 6 and chance(rng, 0.45):
        md = trail.actors[MD_USERNAME]
        when = trail.clock(day, 10.2, 0.8)
        trail.sign_in(
            md,
            when,
            end=when + timedelta(minutes=rng.randint(12, 55)),
            logout=chance(rng, 0.5),
            ua=pick(rng, [UA_IPHONE, UA_MAC], [60, 40]),
        )


def _joiners(world: World, trail: Trail) -> None:
    """Every employee who joined inside the window was created by an HR account the day before or on the day."""
    plan = world.plan
    for p in world.people:
        if p.join < plan.window_start or p.join > plan.today or p.emp is None:
            continue
        username = "unit2hr_demo" if p.unit == "U2" else "recruit_demo" if chance(trail.rng, 0.4) else "hr_demo"
        actor = trail.actors[username]
        when = at(
            p.join - timedelta(days=trail.rng.randint(0, 1)), time(trail.rng.randint(10, 16), trail.rng.randint(0, 59))
        )
        trail.log(
            actor,
            when,
            "create",
            "employees",
            f"Created employee {p.code} -{p.name.first} {p.name.last}",
            record_id=p.emp.pk,
        )


def _payroll_cycle(world: World, trail: Trail) -> None:
    """Each closed month is generated, then approved and locked, in the first days of the following month."""
    payroll, boss = trail.actors["payroll_demo"], trail.actors["hr_demo"]
    runs = world.extra["runs"]
    n_staff = sum(1 for p in world.people if p.kind == "staff")
    n_prod = sum(1 for p in world.people if p.kind == "production")
    latest = world.plan.closed_months[-1]
    rng = trail.rng
    for (year, month), run in sorted(runs.items()):
        nxt = date(year + (month == 12), month % 12 + 1, 1)
        start = at(nxt + timedelta(days=rng.randint(0, 1)), time(rng.randint(10, 15), rng.randint(0, 59)))
        trail.sign_in(payroll, start - timedelta(minutes=3), end=start + timedelta(hours=3))
        trail.log(
            payroll,
            start,
            "create",
            "payroll",
            f"Generated staff payroll {month}/{year} -{n_staff} generated, {rng.randint(0, 2)} skipped",
        )
        for k, (a, b) in enumerate(
            ((date(year, month, 1), date(year, month, 14)), (date(year, month, 15), nxt - timedelta(days=1)))
        ):
            trail.log(
                payroll,
                start + timedelta(minutes=10 + 9 * k),
                "create",
                "payroll",
                f"Generated production payroll {a.isoformat()}–{b.isoformat()} -{n_prod} generated, {rng.randint(0, 4)} skipped",
            )
        decided = at(nxt + timedelta(days=2 + rng.randint(0, 1)), time(rng.randint(10, 12), rng.randint(0, 59)))
        trail.log(boss, decided, "approve", "payroll", f"Approved payroll run {run.run_code}", record_id=run.pk)
        if (year, month) != latest:
            trail.log(
                boss,
                decided + timedelta(hours=1, minutes=rng.randint(0, 40)),
                "lock",
                "payroll",
                f"Locked payroll run {run.run_code}",
                record_id=run.pk,
            )
    # the bonus register (the latest month's jump) and its export
    n = world.stories.get("bonusEmployees", 0)
    if n:
        first = date(latest[0], latest[1], 1) + timedelta(days=24)
        label = f"{(world.plan.today.year - 1) if world.plan.today.month >= world.settings.bonus_fy_start_month else world.plan.today.year - 2}"
        fy = f"{label}-{(int(label) + 1) % 100:02d}"
        trail.log(
            payroll,
            at(first, time(12, 5)),
            "create",
            "bonus",
            f"Generated bonus register for FY {fy} -{n} eligible employee(s)",
        )
        trail.log(
            payroll,
            at(first + timedelta(days=1), time(15, 40)),
            "export",
            "bonus",
            f"Exported bonus register for FY {fy} ({n} record(s))",
        )


def _sensitive(world: World, trail: Trail) -> None:
    """Deletes, a role change, settings and backups: the actions an MD wants to see at a glance."""
    plan = world.plan
    rng = trail.rng
    today = plan.today
    admin = trail.actors["administrator"]
    boss, u2 = trail.actors["hr_demo"], trail.actors["unit2hr_demo"]
    names = world.extra["names"]

    def recent(low: int, high: int) -> date:
        return today - timedelta(days=rng.randint(low, high))

    for who, low, high, late in ((boss, 14, 55, False), (u2, 5, 30, True)):
        ghost = names.person()
        day = recent(low, high)
        when = at(day, time(21, 40) if late else time(rng.randint(11, 16), rng.randint(0, 59)))
        trail.sign_in(who, when - timedelta(minutes=2), end=when + timedelta(minutes=20))
        trail.log(
            who,
            when,
            "delete",
            "employees",
            f"Deleted employee {ghost.first} {ghost.last}",
            record_id=rng.randint(900, 990),
        )
    role = rng.choice(list(world.roles.values()))
    day = recent(18, 45)
    trail.sign_in(admin, at(day, time(10, 5)), end=at(day, time(11, 0)))
    trail.log(
        admin, at(day, time(10, 22)), "update", "user_management", f"Updated role: {role.name}", record_id=role.pk
    )
    trail.log(
        admin,
        at(day, time(10, 31)),
        "update",
        "user_management",
        f"Updated HR user: {rng.choice(list(HR_USERS))}",
        record_id=world.hr_users["hr_demo"].pk,
    )
    day = recent(30, 70)
    trail.log(admin, at(day, time(15, 12)), "update", "settings", "Universal settings updated")
    trail.log(
        boss, at(recent(3, 25), time(11, 48)), "update", "settings", "Personal settings updated (3 field(s) overridden)"
    )
    for k in range(1, 4):  # nightly backups on a Sunday morning
        day = today - timedelta(days=(today.weekday() + 1) % 7 + 7 * (k - 1))
        trail.log(
            admin,
            at(day, time(2, 0, 11)),
            "backup",
            "settings",
            f"Full backup created: backup_{day.isoformat()}_0200.sql ({rng.randint(180, 420) * 1_000_000} bytes)",
        )


def _bursts(world: World, trail: Trail) -> None:
    """After-hours activity: a late-night report export, a small-hours sign-in from a new device, and a locked-out guesser."""
    rng = trail.rng
    today = trail.today
    boss, u2, att = trail.actors["hr_demo"], trail.actors["unit2hr_demo"], trail.actors["attendance_demo"]
    days = [d for d in (today - timedelta(days=k) for k in range(4, 40)) if d.weekday() < 5]
    day = days[len(days) // 2 + 3]
    when = at(day, time(22, 36))
    trail.sign_in(
        boss, when - timedelta(minutes=1), end=when + timedelta(minutes=40), logout=True, ip=f"{OFFICE_NET}88"
    )
    for k in range(14):
        trail.log(
            boss,
            when + timedelta(minutes=2 * k, seconds=rng.randint(0, 40)),
            "export",
            "reports",
            f"{rng.choice(trail.reports)} - XLSX - {rng.randint(200, 240)} rows - {_filters(world, rng, day)}",
            ip=f"{OFFICE_NET}88",
        )
    day = days[2]
    when = at(day, time(2, 11))
    trail.sign_in(u2, when, ip="203.0.113.41", ua=UA_ANDROID, end=when + timedelta(minutes=26))
    for k in range(9):
        text, rid = trail.employee_text("Updated", "U2")
        trail.log(
            u2, when + timedelta(minutes=2 + 2 * k), "update", "employees", text, record_id=rid, ip="203.0.113.41"
        )
    sunday = today - timedelta(days=today.weekday() + 1 + 7 * rng.randint(1, 4))
    when = at(sunday, time(11, 2))
    trail.sign_in(att, when, end=when + timedelta(minutes=35), logout=True)
    trail.log(
        att,
        when + timedelta(minutes=9),
        "update",
        "attendance",
        f"Punch View import: {rng.randint(90, 160)} updated, {rng.randint(8, 20)} created, 0 rejected",
    )
    # somebody guessing the "admin" password: five failures, then two refused attempts
    guess_day = days[len(days) // 3]
    start = at(guess_day, time(3, 14))
    for k in range(7):
        moment = start + timedelta(seconds=25 * k)
        ip = "203.0.113.77"
        trail.attempt("admin", ip, False, moment)
        trail.log(
            trail.actors["administrator"],
            moment,
            "login_failed" if k < 5 else "login_blocked",
            "auth",
            "Failed login for: admin" if k < 5 else "Locked-out login attempt for: admin",
            ip=ip,
        )


def _typos(world: World, trail: Trail) -> None:
    """A few more failed sign-ins spread over the window: a wrong password, then the right one."""
    rng = trail.rng
    plan = world.plan
    days = [
        d
        for d in (plan.window_start + timedelta(days=i) for i in range((plan.today - plan.window_start).days))
        if d.weekday() < 6
    ]
    for _ in range(max(3, len(days) // 12)):
        username = rng.choice(list(HR_USERS))
        actor = trail.actors[username]
        when = trail.clock(rng.choice(days), HABITS[username][2], 0.4)
        for k in range(rng.randint(1, 3)):
            trail.attempt(username, actor.ip, False, when + timedelta(seconds=15 * k))
            trail.log(actor, when + timedelta(seconds=15 * k), "login_failed", "auth", f"Failed login for: {username}")


def create_activity(world: World) -> None:
    world.say("Activity trail")
    plan = world.plan
    trail = Trail(world)
    for day in (plan.window_start + timedelta(days=i) for i in range((plan.today - plan.window_start).days + 1)):
        _daily(world, trail, day)
    _joiners(world, trail)
    if "runs" in world.extra:
        _payroll_cycle(world, trail)
    _sensitive(world, trail)
    _bursts(world, trail)
    _typos(world, trail)

    trail.audit.sort(key=lambda a: a.created_at)
    world.insert(AuditLog, trail.audit, batch_size=2000)
    world.insert(LoginSession, trail.sessions, batch_size=2000)
    world.insert(HrLoginAttempt, sorted(trail.attempts, key=lambda a: a.created_at), batch_size=2000)
    for username, moment in trail.last_login.items():
        user = trail.actors[username].user
        if user is not None:
            HRUser.objects.filter(pk=user.pk).update(last_login=moment)
    sensitive = sum(1 for a in trail.audit if a.action in ("delete", "lock") or (a.module == "user_management"))
    world.stories["activity"] = {
        "auditRows": len(trail.audit),
        "signIns": sum(1 for a in trail.audit if a.action == "login"),
        "failedSignIns": sum(1 for a in trail.attempts if not a.success),
        "sensitiveActions": sensitive,
        "afterHoursBursts": [
            "late-night report export (hr_demo)",
            "small-hours sign-in from a new device (unit2hr_demo)",
            "locked-out password guessing on 'admin'",
        ],
    }
    world.summary["auditRows"] = len(trail.audit)
    world.say(
        f"  {len(trail.audit):,} audit entries, {len(trail.sessions)} sessions, {len(trail.attempts)} sign-in attempts"
    )
