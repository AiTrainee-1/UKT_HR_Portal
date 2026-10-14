"""
Payroll insights: the read-only endpoints behind the redesigned Staff Payroll and Production Payroll pages.

    GET /api/payroll/<id>/details            GET /api/payroll/production/<id>/details
    GET /api/payroll/issues                  GET /api/payroll/production/issues
    GET /api/payroll/rules                   GET /api/payroll/production/rules
    GET /api/payroll/salary-statement        GET /api/payroll/production/salary-statement

Payrolls are built with the REAL engine (`_generate_staff_payroll`, `_generate_production_payroll`) from manual
AttendanceDayRecord rows (authoritative, see attendance_final.compute_day_record), the way tests_payroll_engine.py does, so
what these endpoints explain is exactly what the engine stores. Calendar: February 2026 (24 Mon-Sat working days; a salary of
24,000 has a daily rate of exactly 1,000) and, for the Salary Statement example, April 2026 (26 working days, like the printed
statement). The Weekly production period is Mon 2 - Sun 8 February 2026.

Also pinned here: every endpoint is READ-ONLY (no write query, no changed row, no settings row created), a statement of 12
employees costs the same number of queries as one of 2, each role reaches only its own kind, branch scoping, every Settings
link points at a setting that exists on the Settings page, and every response matches the TypeScript contract
(frontend/src/lib/api-client/custom-hooks/payroll-insights.ts).

Run via: python manage.py test api.tests_payroll_insights -v 2
"""

import json
import re
import time as clock
from datetime import date, time
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlparse

from django.db import connection
from django.test import Client, SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Branch,
    BranchSettingsOverride,
    CasualLeaveRequest,
    Department,
    Designation,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    OvertimeRecord,
    Payroll,
    PayrollSettings,
    Role,
    SalarySlip,
    ShiftTemplate,
)
from .payroll_insights import all_setting_refs, inr, natural_key, period_label, plain, plural
from .payroll_insights_rules import describe_slabs
from .payroll_views import _build_working_days, _generate_production_payroll, _generate_staff_payroll

# The attendance engine only computes days that have elapsed: with "today" fixed after every period used here, the figures
# below do not depend on the date the suite happens to run on.
_FROZEN_TODAY = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN_TODAY.start()


def tearDownModule():
    _FROZEN_TODAY.stop()


MONTH, YEAR = 2, 2026
WORKING = _build_working_days(MONTH, YEAR, False, set())  # 24 Mon-Sat days
START, END = date(2026, 2, 2), date(2026, 2, 8)  # a Weekly period (Mon-Sun)
APRIL = 4
APRIL_WORKING = _build_working_days(APRIL, YEAR, False, set())  # 26 working days, like the printed statement
CYCLES = {
    "weekly": {"weekStart": "monday"},
    "biweekly": {"weekStart": "monday", "anchorDate": "2026-02-02"},
    "monthly": {"weekStart": "monday", "anchorDate": "2026-02-02"},
}

STAFF_QS = f"month={MONTH}&year={YEAR}"
PROD_QS = f"cycle=weekly&periodStart={START.isoformat()}&periodEnd={END.isoformat()}"


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _headers(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _admin() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="ins_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return _headers(user)


def _login(name: str, permissions: dict, branch=None) -> dict:
    role = Role.objects.create(name=f"role_{name}", permissions=permissions)
    user = HRUser.objects.create(username=f"user_{name}", password_hash="x", role=role, branch=branch)
    return _headers(user)


def _configure(**fields) -> PayrollSettings:
    ps = PayrollSettings.get()
    for key, value in fields.items():
        setattr(ps, key, value)
    ps.save()
    return ps


def _staff(code, first="Test", salary="24000.00", **kw) -> Employee:
    fields = {"status": "active", "salary_type": "monthly", "salary_amount": Decimal(salary), **kw}
    return Employee.objects.create(
        employee_code=code, first_name=first, last_name="Staff", employment_type="staff", **fields
    )


def _production(code, first="Test", per_shift="500.00", **kw) -> Employee:
    fields = {"status": "active", "salary_per_shift": Decimal(per_shift), **kw}
    return Employee.objects.create(
        employee_code=code, first_name=first, last_name="Prod", employment_type="production", **fields
    )


def _day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"),
        source="manual",
        **kw,
    )


def _present(emp, days, **kw):
    for d in days:
        _day(emp, d, **kw)


def _get(test, url, headers=None, expect=200):
    response = test.client.get(url, **(headers or _admin()))
    test.assertEqual(response.status_code, expect, f"{url}: {response.content[:300]!r}")
    return response.json() if expect == 200 else response


def _keys(issues):
    """(date, code) of every issue, in the order the endpoint returned them."""
    return [(i["date"], i["code"]) for i in issues]


def _walk(value):
    """Every dict and list element of a JSON value, depth first."""
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _settings_paths(value):
    return {node["settingsPath"] for node in _walk(value) if isinstance(node, dict) and node.get("settingsPath")}


# ─────────────────────────────────────────────────────────────────────────────
#  The TypeScript contract, read as text
# ─────────────────────────────────────────────────────────────────────────────

_TS_FILES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "api-client" / "custom-hooks"


def _read_frontend(path: Path) -> str:
    """A frontend source file as text. Others edit these files while the suite runs (on Windows a file being rewritten
    cannot be opened for a moment), so a read that fails is retried a few times before it is allowed to fail the test."""
    for attempt in range(6):
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            if attempt == 5:
                raise
            clock.sleep(0.25)
    raise AssertionError("unreachable")


_TOKEN = re.compile(r'\s*("(?:[^"\\]|\\.)*"|[A-Za-z_]\w*|\d+|[{}\[\]()<>|&:;,?=])')


class _TsParser:
    """Reads one TypeScript type expression (the small subset the contract uses: object literals, unions, intersections,
    arrays, string literals, primitives, Record<K, V> and references to other declared types)."""

    def __init__(self, text: str):
        self.tokens = []
        position = 0
        text = text.rstrip()
        while position < len(text):
            match = _TOKEN.match(text, position)
            if match is None:
                raise AssertionError(f"Cannot read the contract near {text[position : position + 40]!r}")
            self.tokens.append(match.group(1))
            position = match.end()
        self.i = 0

    def peek(self, offset=0):
        return self.tokens[self.i + offset] if self.i + offset < len(self.tokens) else None

    def take(self, expected=None):
        token = self.tokens[self.i]
        if expected is not None and token != expected:
            raise AssertionError(f"Contract: expected {expected!r} but found {token!r}")
        self.i += 1
        return token

    def parse_type(self):
        if self.peek() == "|":
            self.take()
        alternatives = [self.parse_intersection()]
        while self.peek() == "|":
            self.take()
            alternatives.append(self.parse_intersection())
        return alternatives[0] if len(alternatives) == 1 else ("union", alternatives)

    def parse_intersection(self):
        parts = [self.parse_postfix()]
        while self.peek() == "&":
            self.take()
            parts.append(self.parse_postfix())
        return parts[0] if len(parts) == 1 else ("inter", parts)

    def parse_postfix(self):
        node = self.parse_primary()
        while self.peek() == "[" and self.peek(1) == "]":
            self.take()
            self.take()
            node = ("array", node)
        return node

    def parse_primary(self):
        token = self.take()
        if token == "{":
            return self.parse_object()
        if token == "(":
            node = self.parse_type()
            self.take(")")
            return node
        if token.startswith('"'):
            return ("lit", json.loads(token))
        if token in ("string", "number", "boolean", "null"):
            return ("prim", token)
        if self.peek() == "<":
            self.take()
            args = [self.parse_type()]
            while self.peek() == ",":
                self.take()
                args.append(self.parse_type())
            self.take(">")
            if token != "Record":
                raise AssertionError(f"Contract: generic {token} is not supported by the test reader")
            return ("record", args[0], args[1])
        return ("ref", token)

    def parse_object(self):
        members = {}
        while self.peek() != "}":
            key = self.take().strip('"')
            optional = self.peek() == "?"
            if optional:
                self.take()
            self.take(":")
            members[key] = (optional, self.parse_type())
            if self.peek() in (";", ","):
                self.take()
        self.take("}")
        return ("obj", members)


class _TsContract:
    """The `export type X = ...` declarations of payroll-insights.ts (and PayCycle from production-cycles.ts), with a
    checker that tells how a JSON value differs from a declared type: missing required keys, keys the type does not
    declare, wrong primitive types and values outside a literal union."""

    def __init__(self):
        self.types = {}
        self._read(_read_frontend(_TS_FILES / "payroll-insights.ts"))
        # only the one type the contract borrows from another file (its other declarations are outside this subset)
        self._read(_read_frontend(_TS_FILES / "production-cycles.ts"), only={"PayCycle"})

    def _read(self, source: str, only=None):
        text = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
        text = re.sub(r"//[^\n]*", "", text)
        for match in re.finditer(r"(?m)^export type (\w+) =", text):
            if only is not None and match.group(1) not in only:
                continue
            end = text.find("\nexport ", match.end())
            body = text[match.end() : end if end != -1 else len(text)].strip().rstrip(";")
            self.types[match.group(1)] = _TsParser(body).parse_type()

    def _members(self, node):
        if node[0] == "ref":
            return self._members(self.types[node[1]])
        if node[0] == "obj":
            return dict(node[1])
        if node[0] == "inter":
            merged = {}
            for part in node[1]:
                merged.update(self._members(part))
            return merged
        return None

    def errors(self, value, node, path="$"):
        kind = node[0]
        if kind == "prim":
            ok = {
                "string": isinstance(value, str),
                "number": isinstance(value, (int, float)) and not isinstance(value, bool),
                "boolean": isinstance(value, bool),
                "null": value is None,
            }[node[1]]
            return [] if ok else [f"{path}: {value!r} is not a {node[1]}"]
        if kind == "lit":
            return [] if value == node[1] else [f"{path}: {value!r} is not {node[1]!r}"]
        if kind == "ref":
            if node[1] not in self.types:
                return [f"{path}: the contract has no type {node[1]}"]
            return self.errors(value, self.types[node[1]], path)
        if kind == "array":
            if not isinstance(value, list):
                return [f"{path}: {type(value).__name__} is not a list"]
            return [e for n, item in enumerate(value[:40]) for e in self.errors(item, node[1], f"{path}[{n}]")]
        if kind == "union":
            attempts = [self.errors(value, alt, path) for alt in node[1]]
            if any(not attempt for attempt in attempts):
                return []
            return [f"{path}: {value!r} fits none of the alternatives ({attempts[0][0] if attempts[0] else ''})"]
        if kind == "record":
            if not isinstance(value, dict):
                return [f"{path}: not an object"]
            problems = []
            key_node = node[1]
            allowed = None
            if key_node[0] in ("ref", "union", "lit"):
                allowed = self._literals(key_node)
            if allowed is not None:
                missing = [k for k in allowed if k not in value]
                extra = [k for k in value if k not in allowed]
                problems += [f"{path}: missing key {k!r}" for k in missing]
                problems += [f"{path}: unexpected key {k!r}" for k in extra]
            for key, item in value.items():
                problems += self.errors(item, node[2], f"{path}.{key}")
            return problems
        members = self._members(node)
        if members is None:
            return [f"{path}: cannot check {kind}"]
        if not isinstance(value, dict):
            return [f"{path}: {type(value).__name__} is not an object"]
        problems = []
        for key, (optional, member) in members.items():
            if key not in value:
                if not optional:
                    problems.append(f"{path}: missing required key {key!r}")
                continue
            problems += self.errors(value[key], member, f"{path}.{key}")
        problems += [f"{path}: the contract does not declare {key!r}" for key in value if key not in members]
        return problems

    def _literals(self, node):
        if node[0] == "lit":
            return [node[1]]
        if node[0] == "ref":
            return self._literals(self.types[node[1]])
        if node[0] == "union":
            out = []
            for alt in node[1]:
                got = self._literals(alt)
                if got is None:
                    return None
                out += got
            return out
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  Worlds (built once per test class)
# ─────────────────────────────────────────────────────────────────────────────


def staff_world() -> SimpleNamespace:
    """February 2026, simple attendance mode, 1 free late mark, a 0.5-shift slab from the first billable mark, permission cap 1.

    S100 Meena (Accounts, shift General 09:00-18:00 + 10 min grace, bank and PF / ESI numbers on file) has every kind of
    day: on time, Late-In, Early-Out, Half day (evening half), quarter-shift arrival, a day with no departure punch,
    Absent and an approved leave request (unpaid), plus two approved permissions (one beyond the cap of 1). Her pay:
    21.25 effective days x 1,000 = 21,250, minus a 500 late deduction (3 marks, 1 free, 2 billable = 0.5 shift) = 20,750.
    S200 Anand has no department, no shift and no bank details, and is present every day."""
    _configure(
        attendance_mode="simple",
        staff_payroll_rules_enabled=False,
        late_free_allowance=1,
        late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}],
        permission_monthly_cap=1,
        compensation_feature_enabled=True,
        morning_late_in_enabled=True,
        evening_early_out_enabled=True,
    )
    dept = Department.objects.create(name="Accounts")
    title = Designation.objects.create(title="Accounts Executive")
    shift = ShiftTemplate.objects.create(
        name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10
    )
    meena = _staff(
        "S100",
        first="Meena",
        department=dept,
        designation=title,
        bank_account="123456789012",
        bank_ifsc="HDFC0001234",
        bank_name="HDFC Bank",
        pf_number="PF/100",
        esi_number="ESI/100",
        photo_url="https://files.example/meena-photo.png",
        address="12 Secret Street",
        id_proof="ABCDE1234F",
        password_hash="bcrypt-secret-hash",
        join_date="2024-06-03",
    )
    EmployeeShiftAssignment.objects.create(employee=meena, shift=shift, effective_from=date(2026, 1, 1))
    d = WORKING
    _day(meena, d[0], first_punch=time(9, 0), last_punch=time(18, 0), arrival_zone="on_time")
    _day(
        meena,
        d[1],
        is_late=True,
        arrival_zone="late",
        first_punch=time(9, 42),
        last_punch=time(18, 0),
        late_reason="Morning Late-In: first punch 09:42 is after the deadline 09:10 (shift start 09:00 + 10 min grace)",
    )
    _day(
        meena,
        d[2],
        early_leave=True,
        arrival_zone="on_time",
        first_punch=time(9, 0),
        last_punch=time(16, 30),
        late_reason="Evening Early-Out: last punch 16:30 is before the deadline 17:50 (shift end 18:00 - 10 min grace)",
    )
    _day(
        meena,
        d[3],
        "half_shift",
        "0.50",
        arrival_zone="second_half",
        first_punch=time(14, 40),
        last_punch=time(18, 0),
        late_reason="Second-half arrival: first punch 14:40 is after the latest first-half arrival (11:30)",
    )
    _day(
        meena,
        d[4],
        "present",
        "0.75",
        arrival_zone="quarter",
        first_punch=time(11, 20),
        last_punch=time(18, 0),
        late_reason="Quarter-shift arrival: first punch 11:20 is after the Late window ended (10:10)",
    )
    _day(meena, d[5], first_punch=time(9, 0), arrival_zone="on_time")  # no departure punch
    _day(meena, d[6], "absent", "0")
    _day(meena, d[7], "on_leave", "0")
    for day in d[8:]:
        _day(meena, day, first_punch=time(9, 0), last_punch=time(18, 0), arrival_zone="on_time")
    EmployeePermission.objects.create(employee=meena, date=date(2026, 2, 3), status="approved")
    EmployeePermission.objects.create(employee=meena, date=date(2026, 2, 12), status="approved")

    anand = _staff("S200", first="Anand")
    _present(anand, d)

    result = SimpleNamespace(meena=meena, anand=anand, dept=dept, shift=shift)
    result.meena_payroll = _generate_staff_payroll(meena, MONTH, YEAR)["payroll"]
    result.anand_payroll = _generate_staff_payroll(anand, MONTH, YEAR)["payroll"]
    return result


def production_world() -> SimpleNamespace:
    """The Weekly period 2-8 February 2026 with late detection on (shared rules: 1 free late day, a 0.5-shift slab from the
    first billable one).

    P100 Raja (Weaving, Prod A 08:30-17:30 + 10 min grace, rate 500, bank and PF numbers on file): 1, 1 (late 09:15), 1
    (late 09:20), 0.5, 1.5, 1 (no last punch) shifts and Sunday absent = 6 shifts = 3,000, minus a 250 late deduction
    (2 lates, 1 free, 1 billable = 0.5 shift x 500) = 2,750. P200 Lakshmi was absent all week and has no bank details."""
    _configure(
        prod_attendance_mode="simple",
        prod_late_detection_enabled=True,
        prod_late_free_allowance=1,
        prod_late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}],
        prod_payroll_rules_enabled=False,
        prod_pf_ef_enabled=False,
        prod_cycles=CYCLES,
    )
    dept = Department.objects.create(name="Weaving")
    shift = ShiftTemplate.objects.create(
        name="Prod A", shift_type="production", start_time=time(8, 30), end_time=time(17, 30), grace_period_minutes=10
    )
    raja = _production(
        "P100",
        first="Raja",
        department=dept,
        production_pay_cycle="weekly",
        bank_account="998877665544",
        bank_ifsc="SBIN0001234",
        bank_name="SBI",
        pf_number="PF/P100",
    )
    EmployeeShiftAssignment.objects.create(employee=raja, shift=shift, effective_from=date(2026, 1, 1))
    plan = [
        ("present", "1.00", time(8, 30), time(17, 30)),
        ("present", "1.00", time(9, 15), time(17, 30)),
        ("present", "1.00", time(9, 20), time(17, 30)),
        ("half_shift", "0.50", time(8, 30), time(12, 30)),
        ("present", "1.50", time(8, 30), time(20, 0)),
        ("present", "1.00", time(8, 30), None),
        ("absent", "0", None, None),
    ]
    for offset, (status, shifts, first, last) in enumerate(plan):
        _day(raja, date(2026, 2, 2 + offset), status, shifts, first_punch=first, last_punch=last)
    lakshmi = _production("P200", first="Lakshmi", production_pay_cycle="weekly")
    for offset in range(7):
        _day(lakshmi, date(2026, 2, 2 + offset), "absent", "0")
    result = SimpleNamespace(raja=raja, lakshmi=lakshmi, dept=dept, shift=shift)
    result.raja_payroll = _generate_production_payroll(raja, START, END, pay_cycle="weekly")["payroll"]
    result.lakshmi_payroll = _generate_production_payroll(lakshmi, START, END, pay_cycle="weekly")["payroll"]
    return result


def statement_world() -> SimpleNamespace:
    """April 2026: 26 working days, like the printed statement (which is September 2026, also 26).

    Accounts: 2316 MEENATCHI T (salary 29,500, split Basic 14,750 + Petrol 2,000 + Other 12,750): 22 days present + 2 approved
    Casual Leave = 24 paid days, 2 absent, HR then set her deductions to 1,000 -> E salary 27,230.77, NET 26,230.77 (the
    printed row, but for the paise); a pending CL request that must not count. 2896 LOKESH KANNAN (17,500, no split):
    20 full days + 1 half day + 1 CL = 21.5 paid days, an advance of 6,000 with 2,000 recovered this month. 30071 SRIRAM D
    (50,000, no longer active): 3 days.
    Admin: 189, 226 and 2234 (joined on 15 April), all present every day."""
    _configure(
        attendance_mode="simple",
        staff_payroll_rules_enabled=False,
        late_deduction_slabs=[],
        permission_monthly_cap=3,
        compensation_feature_enabled=True,
        company_name="U.K TEXTILES",
    )
    accounts = Department.objects.create(name="Accounts")
    admin = Department.objects.create(name="Admin")
    title = Designation.objects.create(title="Accounts Executive")
    w = APRIL_WORKING

    def staff(code, first, dept, salary, **kw):
        return _staff(code, first=first, salary=salary, department=dept, designation=title, **kw)

    meena = staff(
        "2316",
        "MEENATCHI",
        accounts,
        "29500",
        salary_basic=Decimal("14750"),
        salary_da=Decimal("0"),
        salary_retaining_allowance=Decimal("0"),
        salary_other_allowance=Decimal("12750"),
        salary_petrol_allowance=Decimal("2000"),
        salary_hra=Decimal("0"),
        salary_special_allowance=Decimal("0"),
        salary_ca=Decimal("0"),
    )
    _present(meena, w[:22])
    for day in w[22:24]:
        _day(meena, day)  # an approved Casual Leave day is stored as a Present day
        CasualLeaveRequest.objects.create(employee=meena, date=day, status="approved")
    CasualLeaveRequest.objects.create(employee=meena, date=w[5], status="pending")
    for day in w[24:]:
        _day(meena, day, "absent", "0")

    lokesh = staff("2896", "LOKESH", accounts, "17500")
    _present(lokesh, w[:20])
    _day(lokesh, w[20], "half_shift", "0.50")
    _day(lokesh, w[21])
    CasualLeaveRequest.objects.create(employee=lokesh, date=w[21], status="approved")
    for day in w[22:]:
        _day(lokesh, day, "absent", "0")
    advance = Advance.objects.create(
        employee=lokesh,
        advance_type="general",
        amount=Decimal("6000"),
        status="approved",
        total_repaid=Decimal("0"),
        outstanding=Decimal("6000"),
    )
    AdvanceRepayment.objects.create(advance=advance, month=APRIL, year=YEAR, amount=Decimal("2000"))

    sriram = staff("30071", "SRIRAM", accounts, "50000", status="inactive")
    _present(sriram, w[:3])
    for day in w[3:]:
        _day(sriram, day, "absent", "0")

    admin_rows = [
        staff("189", "MURUGAN", admin, "50000"),
        staff("226", "KRISHNAN", admin, "14000"),
        staff("2234", "MURUGESAN", admin, "118000", join_date="2026-04-15"),
    ]
    for emp in admin_rows:
        _present(emp, w)

    payrolls = {}
    for emp in (meena, lokesh, sriram, *admin_rows):
        payrolls[emp.employee_code] = _generate_staff_payroll(emp, APRIL, YEAR)["payroll"]
    # HR sets Meena's deductions to 1,000 (the "Others" of the printed row).
    Client().patch(
        f"/api/payroll/{payrolls['2316'].id}", {"deductions": 1000}, content_type="application/json", **_admin()
    )
    for code, payroll in payrolls.items():
        payroll.refresh_from_db()
    return SimpleNamespace(payrolls=payrolls, accounts=accounts, admin=admin, advance=advance)


APRIL_QS = f"month={APRIL}&year={YEAR}"


# ─────────────────────────────────────────────────────────────────────────────
#  Pure helpers
# ─────────────────────────────────────────────────────────────────────────────


class HelperTests(SimpleTestCase):
    def test_rupees_use_indian_digit_grouping(self):
        self.assertEqual(inr(0), "₹0")
        self.assertEqual(inr(999), "₹999")
        self.assertEqual(inr(1000), "₹1,000")
        self.assertEqual(inr(150000), "₹1,50,000")
        self.assertEqual(inr(1234567.89), "₹12,34,567.89")
        self.assertEqual(inr(30000, force_places=True), "₹30,000.00")
        self.assertEqual(inr(-500), "-₹500")

    def test_numbers_read_the_way_people_write_them(self):
        self.assertEqual(plain(12.0), "12")
        self.assertEqual(plain(0.5), "0.5")
        self.assertEqual(plain(Decimal("0.250")), "0.25")
        self.assertEqual(plain(Decimal("100.50")), "100.5")
        self.assertEqual(plain(None), "0")

    def test_plural_counts_zero_and_many_but_not_one_or_a_fraction(self):
        self.assertEqual(plural(1, "day"), "1 day")
        self.assertEqual(plural(0, "day"), "0 days")
        self.assertEqual(plural(2, "day"), "2 days")
        self.assertEqual(plural(0.5, "shift"), "0.5 shift")
        self.assertEqual(plural(1.5, "shift"), "1.5 shifts")

    def test_a_period_reads_like_the_frontend_writes_it(self):
        self.assertEqual(period_label(date(2026, 2, 2), date(2026, 2, 8)), "2 Feb - 8 Feb 2026")
        self.assertEqual(period_label(date(2026, 12, 29), date(2027, 1, 4)), "29 Dec 2026 - 4 Jan 2027")

    def test_employee_codes_sort_numerically_like_the_printed_statement(self):
        codes = ["2234", "226", "189", "UKT-10", "UKT-9", "30071", "2316"]
        self.assertEqual(sorted(codes, key=natural_key), ["189", "226", "2234", "2316", "30071", "UKT-9", "UKT-10"])

    def test_slab_tables_are_described_in_words(self):
        self.assertEqual(describe_slabs([], "late mark"), "No slabs: a late mark costs nothing")
        self.assertEqual(
            describe_slabs([{"fromLates": 3, "deductionShifts": 0.25}], "late mark"),
            "From 3 billable late marks: 0.25 shift",
        )
        self.assertEqual(
            describe_slabs(
                [{"fromLates": 6, "deductionShifts": 1}, {"fromLates": 3, "deductionShifts": 0.5}, "junk", {"x": 1}],
                "late",
            ),
            "From 3 billable lates: 0.5 shift; from 6: 1 shift",
        )
        shipped = [{"fromLates": n, "deductionShifts": round(n / 3 * 0.25, 2)} for n in range(3, 31, 3)]
        self.assertEqual(
            describe_slabs(shipped, "late mark"),
            "From 3 billable late marks: 0.25 shift; from 6: 0.5 shift; from 9: 0.75 shift; ...; from 30: 2.5 shifts "
            "(10 slabs)",
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Staff issues
# ─────────────────────────────────────────────────────────────────────────────


class StaffIssueTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = staff_world()

    def issues(self, extra=""):
        return _get(self, f"/api/payroll/issues?{STAFF_QS}{extra}")

    def meena(self):
        return self.issues(f"&employeeId={self.w.meena.id}")["issues"]

    def test_each_issue_fires_on_its_own_day_and_nowhere_else(self):
        self.assertEqual(
            _keys(self.meena()),
            [
                ("2026-02-03", "late_in"),
                ("2026-02-04", "early_out"),
                ("2026-02-05", "half_day"),
                ("2026-02-06", "quarter_day"),
                ("2026-02-07", "missing_punch"),
                ("2026-02-09", "absent"),
                ("2026-02-10", "unpaid_leave"),
                (None, "excess_permission"),
                (None, "late_penalty"),
            ],
        )

    def test_a_clean_employee_with_no_shift_and_no_bank_details_is_flagged_for_exactly_those(self):
        issues = self.issues(f"&employeeId={self.w.anand.id}")["issues"]
        self.assertEqual(_keys(issues), [(None, "bank_missing"), (None, "no_shift")])
        no_shift = issues[1]
        self.assertEqual(
            (no_shift["category"], no_shift["severity"], no_shift["title"]), ("rule", "warning", "No shift assigned")
        )
        self.assertEqual(
            no_shift["detail"],
            "Anand Staff has no shift assigned for February 2026, so Late-In, Early-Out and the arrival timeline could "
            "not be applied to any day this month. Assign a shift in Manage Shifts and regenerate to have them checked",
        )
        self.assertEqual(no_shift["rule"], {"label": "Shift assignment (Manage Shifts)", "settingsPath": None})
        bank = issues[0]
        self.assertEqual(
            bank["detail"],
            "No bank account number and IFSC code on the profile: the ₹24,000 net salary cannot be transferred to a bank account",
        )
        self.assertEqual(bank["facts"], {"hasAccount": False, "hasIfsc": False, "bankName": None})

    def test_the_details_are_specific_and_use_the_real_numbers(self):
        by_code = {i["code"]: i for i in self.meena()}
        self.assertEqual(
            by_code["late_in"]["detail"],
            "Morning Late-In: first punch 09:42 is after the deadline 09:10 (shift start 09:00 + 10 min grace)",
        )
        self.assertEqual(by_code["late_in"]["facts"], {"firstIn": "09:42", "arrivalZone": "late", "shift": "General"})
        self.assertEqual(by_code["late_in"]["impact"], {"label": "Counts as 1 late mark"})
        self.assertEqual(
            by_code["early_out"]["detail"],
            "Evening Early-Out: last punch 16:30 is before the deadline 17:50 (shift end 18:00 - 10 min grace)",
        )
        self.assertEqual(by_code["early_out"]["facts"], {"lastOut": "16:30", "shift": "General"})
        self.assertEqual(
            by_code["half_day"]["detail"],
            "Only the evening half was worked: first punch 14:40 was after the first-half limit (11:30). Paid 0.5 of a day",
        )
        self.assertEqual(by_code["half_day"]["impact"], {"days": 0.5, "amount": 500.0})
        self.assertEqual(
            by_code["quarter_day"]["detail"],
            "First punch 11:20 came after the Late window ended at 10:10 but still inside the first half: 0.25 shift "
            "taken off the day (paid 0.75 of a day)",
        )
        self.assertEqual(by_code["quarter_day"]["impact"], {"days": 0.25, "amount": 250.0})
        self.assertEqual(
            by_code["missing_punch"]["detail"],
            "Only one punch recorded (09:00): there is no departure punch for this day",
        )
        self.assertEqual(
            by_code["absent"]["detail"], "No attendance recorded on this working day, counted as loss of pay"
        )
        self.assertEqual(by_code["absent"]["impact"], {"days": 1.0, "amount": 1000.0})
        self.assertIn("only Casual Leave is paid", by_code["unpaid_leave"]["detail"])
        self.assertEqual(by_code["unpaid_leave"]["impact"], {"days": 1.0, "amount": 1000.0})

    def test_the_late_deduction_issue_shows_how_the_amount_was_reached(self):
        late = next(i for i in self.meena() if i["code"] == "late_penalty")
        self.assertEqual(
            late["detail"],
            "3 late occurrences (1 late-in, 1 early-out, 1 excess permission), 1 free, 2 billable: "
            "0.5 shift x ₹1,000 daily rate = ₹500",
        )
        self.assertEqual(late["impact"], {"shifts": 0.5, "amount": 500.0})
        self.assertEqual(
            late["rule"],
            {"label": "Late deduction slabs", "settingsPath": "/hr/settings?tab=late_detection#deduction-slabs"},
        )
        self.assertEqual(
            late["facts"],
            {
                "lateIn": 1,
                "earlyOut": 1,
                "excessPermissions": 1,
                "total": 3,
                "free": 1,
                "billable": 2,
                "shiftDeductions": 0.5,
                "dailyRate": 1000.0,
            },
        )
        # what the payroll actually took off agrees
        self.assertEqual(Payroll.objects.get(pk=self.w.meena_payroll.pk).deductions, Decimal("500.00"))

    def test_excess_permissions_say_how_many_went_beyond_the_cap(self):
        issue = next(i for i in self.meena() if i["code"] == "excess_permission")
        self.assertEqual(
            issue["detail"],
            "1 approved permission this month went beyond the monthly cap of 1: each one excuses nothing and counts as "
            "a mark in the late pool instead",
        )
        self.assertEqual(issue["rule"]["settingsPath"], "/hr/settings?tab=late_detection#permission-cap")
        self.assertEqual((issue["category"], issue["severity"]), ("pay", "warning"))

    def test_severity_and_category_follow_the_catalogue(self):
        by_code = {i["code"]: i for i in self.meena()}
        expected = {
            # an absence is the routine reason for a loss-of-pay day, not a payroll fault
            "absent": ("attendance", "warning"),
            "unpaid_leave": ("attendance", "warning"),
            "late_in": ("attendance", "warning"),
            "early_out": ("attendance", "warning"),
            "half_day": ("attendance", "warning"),
            "quarter_day": ("attendance", "warning"),
            "missing_punch": ("attendance", "warning"),
            "late_penalty": ("pay", "warning"),
            "excess_permission": ("pay", "warning"),
        }
        self.assertEqual({c: (i["category"], i["severity"]) for c, i in by_code.items()}, expected)

    def test_every_issue_carries_the_employee_and_when_payroll_flagged_it(self):
        updated = Payroll.objects.get(pk=self.w.meena_payroll.pk).updated_at.isoformat()
        for issue in self.meena():
            self.assertEqual(issue["employeeCode"], "S100")
            self.assertEqual(issue["employeeName"], "Meena Staff")
            self.assertEqual((issue["department"], issue["designation"]), ("Accounts", "Accounts Executive"))
            self.assertEqual(issue["payrollId"], self.w.meena_payroll.id)
            self.assertEqual(issue["detectedAt"], updated)
        self.assertEqual(
            {i["id"] for i in self.meena()},
            {
                f"{self.w.meena_payroll.id}:{code}:{day or 'period'}"
                for day, code in [
                    ("2026-02-03", "late_in"),
                    ("2026-02-04", "early_out"),
                    ("2026-02-05", "half_day"),
                    ("2026-02-06", "quarter_day"),
                    ("2026-02-07", "missing_punch"),
                    ("2026-02-09", "absent"),
                    ("2026-02-10", "unpaid_leave"),
                    (None, "excess_permission"),
                    (None, "late_penalty"),
                ]
            },
        )

    def test_issues_are_sorted_by_day_then_severity_then_name_with_period_issues_last(self):
        issues = self.issues()["issues"]
        self.assertEqual(
            [(i["date"], i["employeeCode"], i["code"]) for i in issues],
            [
                ("2026-02-03", "S100", "late_in"),
                ("2026-02-04", "S100", "early_out"),
                ("2026-02-05", "S100", "half_day"),
                ("2026-02-06", "S100", "quarter_day"),
                ("2026-02-07", "S100", "missing_punch"),
                ("2026-02-09", "S100", "absent"),
                ("2026-02-10", "S100", "unpaid_leave"),
                (None, "S200", "bank_missing"),
                (None, "S200", "no_shift"),
                (None, "S100", "excess_permission"),
                (None, "S100", "late_penalty"),
            ],
        )

    def test_the_summary_counts_by_severity_code_and_department(self):
        body = self.issues()
        summary = body["summary"]
        self.assertEqual((summary["employees"], summary["employeesWithIssues"], summary["total"]), (2, 2, 11))
        self.assertEqual(summary["bySeverity"], {"critical": 0, "warning": 11, "info": 0})
        by_code = {c["code"]: c for c in summary["byCode"]}
        self.assertEqual(
            by_code["absent"],
            {"code": "absent", "label": "Absent", "severity": "warning", "category": "attendance", "count": 1},
        )
        self.assertEqual(sum(c["count"] for c in summary["byCode"]), 11)
        # the list is ordered the way the dashboard draws it: severity first, then the biggest group, then the name
        self.assertEqual(
            [(c["severity"], -c["count"], c["label"]) for c in summary["byCode"]],
            sorted((c["severity"], -c["count"], c["label"]) for c in summary["byCode"]),
        )
        self.assertEqual(
            summary["byDepartment"],
            [{"department": "Accounts", "count": 9}, {"department": "No department", "count": 2}],
        )
        newest = max(Payroll.objects.values_list("updated_at", flat=True))
        self.assertEqual(body["detectedAt"], newest.isoformat())
        self.assertEqual(body["scope"]["label"], "February 2026")
        self.assertEqual(
            (body["scope"]["start"], body["scope"]["end"], body["scope"]["days"]), ("2026-02-01", "2026-02-28", 28)
        )
        self.assertEqual((body["scope"]["cycle"], body["scope"]["cycleLabel"]), (None, None))

    def test_filters_narrow_the_scope(self):
        self.assertEqual(len(self.issues(f"&departmentId={self.w.dept.id}")["issues"]), 9)
        self.assertEqual(self.issues(f"&departmentId={self.w.dept.id}")["summary"]["employees"], 1)
        none = self.issues(f"&branchId={Branch.objects.create(name='Elsewhere').id}")
        self.assertEqual((none["issues"], none["summary"]["employees"], none["detectedAt"]), ([], 0, None))
        self.assertEqual(self.issues("&status=paid")["issues"], [])
        self.assertEqual(self.issues("&status=pending")["summary"]["employees"], 2)

    def test_a_month_with_no_payroll_is_an_empty_answer_not_an_error(self):
        body = _get(self, "/api/payroll/issues?month=3&year=2026")
        self.assertEqual((body["issues"], body["summary"]["total"], body["scope"]["label"]), ([], 0, "March 2026"))

    def test_bad_requests_are_400(self):
        for qs in (
            "",
            "month=2",
            "month=13&year=2026",
            "month=x&year=2026",
            f"{STAFF_QS}&status=bogus",
            f"{STAFF_QS}&departmentId=abc",
        ):
            _get(self, f"/api/payroll/issues?{qs}", expect=400)

    def test_an_adjustment_made_after_generation_is_an_issue_with_its_note(self):
        r = self.client.patch(
            f"/api/payroll/{self.w.meena_payroll.id}",
            {"bonus": 1500, "deductions": 700, "notes": "Festival bonus, one more advance cut"},
            content_type="application/json",
            **_admin(),
        )
        self.assertEqual(r.status_code, 200)
        found = [i for i in self.meena() if i["code"] == "adjustment"]
        self.assertEqual(len(found), 1)
        adjustment = found[0]
        self.assertEqual(
            adjustment["detail"],
            "HR adjusted this payroll after it was generated: a bonus of ₹1,500 and deductions changed from ₹500 to "
            "₹700. The net salary is now ₹22,050. Note: Festival bonus, one more advance cut",
        )
        self.assertEqual((adjustment["date"], adjustment["category"], adjustment["severity"]), (None, "pay", "info"))
        self.assertEqual(adjustment["impact"], {"amount": 1300.0, "label": "Change to net salary"})
        self.assertEqual(
            adjustment["facts"],
            {
                "bonus": 1500.0,
                "generatedDeductions": 500.0,
                "deductions": 700.0,
                "note": "Festival bonus, one more advance cut",
            },
        )

    def test_marking_a_payroll_paid_is_not_an_adjustment(self):
        self.client.patch(
            f"/api/payroll/{self.w.meena_payroll.id}", {"status": "paid"}, content_type="application/json", **_admin()
        )
        self.assertNotIn("adjustment", [i["code"] for i in self.meena()])

    def test_a_bonus_alone_is_an_adjustment_without_a_deduction_change(self):
        self.client.patch(
            f"/api/payroll/{self.w.meena_payroll.id}", {"bonus": 500}, content_type="application/json", **_admin()
        )
        adjustment = next(i for i in self.meena() if i["code"] == "adjustment")
        self.assertEqual(
            adjustment["detail"],
            "HR adjusted this payroll after it was generated: a bonus of ₹500. The net salary is now ₹21,250.",
        )
        self.assertEqual(adjustment["facts"]["note"], None)


class PayAndProfileIssueTests(TestCase):
    """Advance recovery, overtime pay and what the profile lacks (PF / ESI on, so numbers are deducted)."""

    @classmethod
    def setUpTestData(cls):
        _configure(
            attendance_mode="simple",
            staff_payroll_rules_enabled=True,
            pf_rate=Decimal("12"),
            esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"),
            late_deduction_slabs=[],
            compensation_feature_enabled=True,
        )
        bank = {"bank_account": "555566667777", "bank_ifsc": "ICIC0001111", "bank_name": "ICICI"}
        cls.bare = _staff("ST1", first="Rani", salary="20400.00")  # nothing on file
        cls.half_bank = _staff(
            "ST3", first="Raju", salary="20400.00", bank_account="123456789", pf_number="P", esi_number="E"
        )
        cls.above = _staff("ST4", first="Rohit", salary="30000.00", **bank)  # above the ESI ceiling: no ESI
        cls.full = _staff("ST2", first="Ravi", salary="20400.00", pf_number="PF/2", esi_number="ESI/2", **bank)
        cls.busy = _staff("AD1", first="Ajay", salary="24000.00", pf_number="PF/9", esi_number="ESI/9", **bank)
        shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10
        )
        for emp in (cls.bare, cls.half_bank, cls.above, cls.full, cls.busy):
            EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=date(2026, 1, 1))
            _present(emp, WORKING)
        advance = Advance.objects.create(
            employee=cls.busy,
            advance_type="general",
            amount=Decimal("5000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("5000"),
        )
        repayment = AdvanceRepayment.objects.create(advance=advance, month=MONTH, year=YEAR, amount=Decimal("2000"))
        cls.advance_id, cls.repayment_id = advance.id, repayment.id
        for day in (date(2026, 2, 2), date(2026, 2, 3)):
            OvertimeRecord.objects.create(
                employee=cls.busy,
                date=day,
                last_punch_out=time(20, 0),
                ot_minutes=120,
                status=OvertimeRecord.STATUS_ANNOUNCED,
                compensation_type=OvertimeRecord.TYPE_PAY,
            )
        cls.payrolls = {
            e.employee_code: _generate_staff_payroll(e, MONTH, YEAR)["payroll"]
            for e in (cls.bare, cls.half_bank, cls.above, cls.full, cls.busy)
        }

    def issues_of(self, emp):
        return _get(self, f"/api/payroll/issues?{STAFF_QS}&employeeId={emp.id}")["issues"]

    def test_deducted_pf_and_esi_without_numbers_and_a_missing_bank_are_flagged(self):
        issues = self.issues_of(self.bare)
        self.assertEqual(
            _keys(issues), [(None, "bank_missing"), (None, "esi_number_missing"), (None, "pf_number_missing")]
        )
        by_code = {i["code"]: i for i in issues}
        self.assertEqual(
            by_code["pf_number_missing"]["detail"], "₹1,224 PF was deducted but the profile has no PF number"
        )
        self.assertEqual(
            by_code["esi_number_missing"]["detail"], "₹153 ESI was deducted but the profile has no ESI number"
        )
        self.assertEqual(
            by_code["bank_missing"]["detail"],
            "No bank account number and IFSC code on the profile: the ₹19,023 net salary cannot be transferred to a bank account",
        )
        self.assertEqual(
            [(i["category"], i["severity"]) for i in issues],
            [("profile", "warning"), ("profile", "info"), ("profile", "info")],
        )

    def test_a_missing_ifsc_alone_is_named(self):
        issue = self.issues_of(self.half_bank)[0]
        self.assertEqual(issue["code"], "bank_missing")
        self.assertTrue(issue["detail"].startswith("No IFSC code on the profile: "))
        self.assertEqual((issue["facts"]["hasAccount"], issue["facts"]["hasIfsc"]), (True, False))

    def test_no_esi_number_issue_when_no_esi_was_deducted(self):
        self.assertEqual(Payroll.objects.get(pk=self.payrolls["ST4"].pk).deductions, Decimal("1800.00"))  # PF only
        self.assertEqual(_keys(self.issues_of(self.above)), [(None, "pf_number_missing")])

    def test_a_complete_profile_raises_nothing(self):
        self.assertEqual(self.issues_of(self.full), [])

    def test_the_details_of_that_payroll_list_the_advance_and_the_overtime_and_foot(self):
        d = _get(self, f"/api/payroll/{self.payrolls['AD1'].id}/details")
        self.assertEqual(
            [(line["key"], line["amount"], line["kind"]) for line in d["earnings"] if line["kind"] != "info"],
            [("gross", 24000.0, "earning"), ("ot_pay", 2000.0, "earning"), ("total_earnings", 26000.0, "subtotal")],
        )
        ot = next(line for line in d["earnings"] if line["key"] == "ot_pay")
        self.assertEqual(ot["note"], "2 announced overtime days x one day's pay (₹1,000)")
        self.assertEqual(
            [(line["key"], line["amount"]) for line in d["deductions"] if line["kind"] != "subtotal"],
            [("pf", 1440.0), ("esi", 0.0), ("advances", 2000.0)],
        )
        by_key = {line["key"]: line for line in d["deductions"]}
        self.assertEqual(by_key["pf"]["note"], "12% of Basic ₹12,000")
        self.assertEqual(
            by_key["esi"]["note"], "Not deducted: the monthly salary ₹24,000 is above the ESI ceiling ₹21,000"
        )
        self.assertEqual(by_key["advances"]["note"], "1 repayment due this month")
        self.assertEqual(
            d["advances"],
            [{"advanceId": self.advance_id, "repaymentId": self.repayment_id, "amount": 2000.0, "notes": None}],
        )
        earned = sum(line["amount"] for line in d["earnings"] if line["kind"] == "earning")
        taken = sum(line["amount"] for line in d["deductions"] if line["kind"] == "deduction")
        self.assertEqual((earned - taken, d["money"]["net"]), (22560.0, 22560.0))
        keys = set(_rule_items(d))
        self.assertTrue({line["ruleKey"] for line in [*d["earnings"], *d["deductions"]] if line["ruleKey"]} <= keys)

    def test_advance_recovery_and_overtime_pay_are_information(self):
        issues = self.issues_of(self.busy)
        self.assertEqual(_keys(issues), [(None, "advance_recovery"), (None, "ot_pay")])
        advance, ot = issues
        self.assertEqual(advance["detail"], "₹2,000 was recovered from this payroll for advances across 1 repayment")
        self.assertEqual(advance["impact"], {"amount": 2000.0})
        self.assertEqual(
            ot["detail"],
            "2 announced overtime days paid at one day's pay each (₹1,000): ₹2,000 was added to the net salary",
        )
        self.assertEqual(ot["impact"], {"amount": 2000.0, "label": "Added to pay"})
        self.assertEqual(ot["rule"]["settingsPath"], "/hr/settings?tab=payroll#compensation-features")
        self.assertEqual((advance["severity"], ot["severity"], advance["category"]), ("info", "info", "pay"))


# ─────────────────────────────────────────────────────────────────────────────
#  Production issues
# ─────────────────────────────────────────────────────────────────────────────


class ProductionIssueTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = production_world()

    def issues(self, extra=""):
        return _get(self, f"/api/payroll/production/issues?{PROD_QS}{extra}")

    def raja(self):
        return self.issues(f"&employeeId={self.w.raja.id}")["issues"]

    def test_each_issue_fires_on_its_own_day_and_nowhere_else(self):
        self.assertEqual(
            _keys(self.raja()),
            [
                ("2026-02-03", "late_in"),
                ("2026-02-04", "late_in"),
                ("2026-02-05", "half_day"),
                ("2026-02-07", "missing_punch"),
                ("2026-02-08", "absent"),
                (None, "late_penalty"),
            ],
        )

    def test_the_details_use_the_production_shift_and_the_real_numbers(self):
        issues = self.raja()
        late_a, late_b, half, missing, absent, penalty = issues
        self.assertEqual(late_a["detail"], "First punch 09:15 after Prod A start 08:30 + 10 min grace (08:40)")
        self.assertEqual(late_b["detail"], "First punch 09:20 after Prod A start 08:30 + 10 min grace (08:40)")
        self.assertEqual(late_a["impact"], {"label": "Counts as 1 late day"})
        self.assertEqual((half["title"], half["severity"]), ("Half day", "info"))
        self.assertEqual(half["detail"], "Earned 0.5 shift (08:30-12:30) of a full 1 shift")
        self.assertEqual(half["impact"], {"shifts": 0.5, "label": "0.5 shift short of a full shift"})
        self.assertEqual(missing["detail"], "Only one punch recorded (08:30): there is no last punch for this day")
        self.assertEqual(absent["detail"], "No punches were recorded on this day, so no shift was earned")
        self.assertEqual((absent["severity"], absent["impact"]), ("warning", {"label": "No shift earned"}))
        self.assertEqual(penalty["detail"], "2 late days, 1 free, 1 billable: 0.5 shift x ₹500 per shift = ₹250")
        self.assertEqual(penalty["impact"], {"shifts": 0.5, "amount": 250.0})
        self.assertEqual(
            penalty["rule"],
            {
                "label": "Weekly late deduction slabs",
                "settingsPath": "/hr/settings?tab=production_payroll#weekly-late-slabs",
            },
        )
        self.assertEqual(Payroll.objects.get(pk=self.w.raja_payroll.pk).deductions, Decimal("250.00"))

    def test_a_week_with_no_shifts_at_all_is_critical(self):
        issues = self.issues(f"&employeeId={self.w.lakshmi.id}")["issues"]
        self.assertEqual(
            _keys(issues),
            # the week's absences, then the whole-period issues, the critical one before the warning
            [(f"2026-02-0{n}", "absent") for n in range(2, 9)] + [(None, "no_attendance"), (None, "bank_missing")],
        )
        none = issues[-2]
        self.assertEqual(
            (none["severity"], none["category"], none["title"]), ("critical", "attendance", "No attendance")
        )
        self.assertEqual(none["detail"], "No shift was earned between 02-02-2026 and 08-02-2026: this period pays ₹0")

    def test_a_late_day_with_detection_off_costs_nothing_and_says_so(self):
        _configure(prod_late_detection_enabled=False)
        emp = _production(
            "P300", first="Mani", production_pay_cycle="weekly", bank_account="1", bank_ifsc="X", pf_number="1"
        )
        _day(emp, START, "present", "1.00", first_punch=time(10, 0), last_punch=time(18, 0), is_late=True)
        _generate_production_payroll(emp, START, END, pay_cycle="weekly")
        issue = next(i for i in self.issues(f"&employeeId={emp.id}")["issues"] if i["code"] == "late_in")
        self.assertEqual(
            issue["detail"],
            "First punch 10:00 was marked late by the attendance rules. No pay is deducted because production late "
            "detection is switched off",
        )
        self.assertIsNone(issue["impact"])

    def test_scope_filters_and_validation(self):
        body = self.issues()
        self.assertEqual(body["scope"]["label"], "2 Feb - 8 Feb 2026")
        self.assertEqual(
            (body["scope"]["cycle"], body["scope"]["cycleLabel"], body["scope"]["month"]), ("weekly", "Weekly", 2)
        )
        self.assertEqual(body["summary"]["employees"], 2)
        self.assertEqual(self.issues(f"&departmentId={self.w.dept.id}")["summary"]["employees"], 1)
        self.assertEqual(
            _get(self, f"/api/payroll/production/issues?cycle=biweekly&periodStart={START}&periodEnd={END}")["issues"],
            [],
        )
        for qs in (
            "",
            f"cycle=weekly&periodStart={START}",
            f"cycle=daily&periodStart={START}&periodEnd={END}",
            f"cycle=weekly&periodStart={END}&periodEnd={START}",
            f"cycle=weekly&periodStart=x&periodEnd={END}",
        ):
            _get(self, f"/api/payroll/production/issues?{qs}", expect=400)

    def test_the_staff_endpoint_never_returns_production_payroll(self):
        staff = _get(self, f"/api/payroll/issues?{STAFF_QS}")
        self.assertEqual(staff["summary"]["employees"], 0)

    def test_a_period_generated_under_older_settings_is_still_a_period_that_exists(self):
        _configure(prod_cycles={"weekly": {"weekStart": "wednesday"}})  # 2-8 Feb is no longer a Weekly period
        self.assertEqual(self.issues()["summary"]["employees"], 2)


# ─────────────────────────────────────────────────────────────────────────────
#  Details
# ─────────────────────────────────────────────────────────────────────────────

DETAILS_KEYS = {
    "payrollId",
    "kind",
    "slipId",
    "slipNumber",
    "status",
    "generatedAt",
    "firstGeneratedAt",
    "period",
    "employee",
    "money",
    "summary",
    "earnings",
    "deductions",
    "rules",
    "issues",
    "issueCounts",
    "days",
    "advances",
    "notes",
    "history",
    "neighbours",
    "context",
}


def _rule_items(details) -> dict:
    return {item["key"]: item for group in details["rules"] for item in group["items"]}


class StaffDetailsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = staff_world()

    def details(self, payroll=None, headers=None, expect=200):
        return _get(self, f"/api/payroll/{(payroll or self.w.meena_payroll).id}/details", headers, expect)

    def test_every_section_is_there_and_the_numbers_are_the_payrolls_own(self):
        d = self.details()
        payroll = Payroll.objects.get(pk=self.w.meena_payroll.pk)
        slip = SalarySlip.objects.get(employee=self.w.meena, month=MONTH, year=YEAR)
        self.assertEqual(set(d), DETAILS_KEYS)
        self.assertEqual((d["payrollId"], d["kind"], d["status"]), (payroll.id, "staff", "pending"))
        self.assertEqual(d["generatedAt"], payroll.updated_at.isoformat())
        self.assertEqual(d["firstGeneratedAt"], payroll.created_at.isoformat())
        self.assertEqual(
            d["money"],
            {
                "gross": float(payroll.gross_salary),
                "deductions": float(payroll.deductions),
                "bonus": float(payroll.bonus),
                "otAmount": float(payroll.ot_amount),
                "net": float(payroll.final_salary),
                "monthlySalary": 24000.0,
                "dailyRate": 1000.0,
            },
        )
        self.assertEqual((d["money"]["gross"], d["money"]["net"]), (21250.0, 20750.0))
        self.assertEqual(d["summary"], slip.breakdown_details["summary"])
        self.assertEqual(len(d["days"]), 24)
        self.assertEqual(
            d["period"],
            {
                "label": "February 2026",
                "start": "2026-02-01",
                "end": "2026-02-28",
                "month": 2,
                "year": 2026,
                "days": 28,
                "cycle": None,
                "cycleLabel": None,
            },
        )
        self.assertEqual(
            d["context"],
            {"kind": "staff", "month": 2, "year": 2026, "cycle": None, "periodStart": None, "periodEnd": None},
        )
        self.assertEqual(d["issueCounts"]["total"], len(d["issues"]))
        self.assertIsNone(d["notes"])

    def test_the_salary_slip_is_identified_for_the_pdf_email_and_whatsapp_actions(self):
        d = self.details()
        slip = SalarySlip.objects.get(employee=self.w.meena, month=MONTH, year=YEAR)
        self.assertEqual((d["slipId"], d["slipNumber"]), (slip.id, "SS/S100/2026/02"))

    def test_earnings_and_deductions_say_how_each_line_was_worked_out(self):
        d = self.details()
        self.assertEqual(
            [(line["key"], line["amount"], line["kind"]) for line in d["earnings"]],
            [
                ("daily_rate", 1000.0, "info"),
                ("gross", 21250.0, "earning"),
                ("basic", 10625.0, "info"),
                ("hra", 4250.0, "info"),
                ("allowances", 6375.0, "info"),
                ("total_earnings", 21250.0, "subtotal"),
            ],
        )
        notes = {line["key"]: line["note"] for line in d["earnings"]}
        self.assertEqual(notes["gross"], "₹24,000 / 24 working days x 21.25 days paid")
        self.assertEqual(notes["daily_rate"], "₹24,000 / 24 working days")
        self.assertEqual(d["earnings"][1]["ruleKey"], "monthly_salary")
        self.assertEqual(
            [(line["key"], line["amount"], line["kind"]) for line in d["deductions"]],
            [("late_penalty", 500.0, "deduction"), ("total_deductions", 500.0, "subtotal")],
        )
        self.assertEqual(d["deductions"][0]["note"], "0.5 shift x ₹1,000 daily rate (2 billable late marks)")
        self.assertEqual(d["deductions"][0]["ruleKey"], "late_slabs")
        # the lines add up to the net the payroll stored, and every ruleKey names a rule that is in `rules`
        earned = sum(line["amount"] for line in d["earnings"] if line["kind"] == "earning")
        taken = sum(line["amount"] for line in d["deductions"] if line["kind"] == "deduction")
        self.assertEqual(earned - taken, d["money"]["net"])
        keys = set(_rule_items(d))
        for line in [*d["earnings"], *d["deductions"]]:
            if line["ruleKey"]:
                self.assertIn(line["ruleKey"], keys)

    def test_the_days_carry_the_issue_codes_of_each_day_as_flags(self):
        days = {day["date"]: day for day in self.details()["days"]}
        self.assertEqual(days["2026-02-02"]["flags"], [])
        self.assertEqual(days["2026-02-03"]["flags"], ["late_in"])
        self.assertEqual(days["2026-02-04"]["flags"], ["early_out"])
        self.assertEqual(days["2026-02-05"]["flags"], ["half_day"])
        self.assertEqual((days["2026-02-05"]["shifts"], days["2026-02-06"]["shifts"]), (0.5, 0.75))
        self.assertEqual(days["2026-02-09"]["flags"], ["absent"])
        self.assertEqual((days["2026-02-09"]["status"], days["2026-02-09"]["shifts"]), ("absent", 0.0))
        self.assertEqual(days["2026-02-10"]["status"], "unpaid_leave")
        self.assertEqual(
            (days["2026-02-03"]["day"], days["2026-02-03"]["firstIn"], days["2026-02-03"]["lastOut"]),
            ("Tuesday", "09:42", "18:00"),
        )
        self.assertIn("Morning Late-In", days["2026-02-03"]["note"])
        self.assertEqual([d["date"] for d in self.details()["days"]], sorted(days))

    def test_the_rules_say_what_the_payroll_was_generated_with_and_nothing_has_changed_yet(self):
        d = self.details()
        self.assertEqual(
            [g["group"] for g in d["rules"]],
            [
                "Attendance & late detection",
                "Half day & permissions",
                "Statutory (PF / ESI)",
                "Pay basis",
                "Overtime / Compensation switch",
            ],
        )
        items = _rule_items(d)
        allowance = items["late_free_allowance"]
        self.assertEqual(
            (allowance["value"], allowance["applied"], allowance["changed"]),
            ("1 free mark a month", "1 free mark a month", False),
        )
        self.assertEqual(allowance["source"], "settings")
        self.assertEqual(items["attendance_mode"]["applied"], "Simple (first and last punch)")
        self.assertEqual(items["shift"]["applied"], "General, starts 09:00, 10 min grace")
        self.assertEqual(items["first_half_limit"]["applied"], "11:30")
        self.assertEqual(items["late_slabs"]["applied"], "2 billable late marks cost 0.5 shift")
        self.assertEqual(items["working_days"]["applied"], "24 working days")
        self.assertEqual(items["monthly_salary"]["source"], "employee")
        self.assertEqual(items["morning_late_in"]["applied"], None)  # the breakdown does not record the switch
        self.assertEqual([k for k, item in items.items() if item["changed"]], [])

    def test_a_rule_changed_since_generation_is_flagged_with_both_values(self):
        _configure(
            late_free_allowance=3,
            late_deduction_slabs=[{"fromLates": 3, "deductionShifts": 0.25}],
            permission_monthly_cap=4,
            arrival_late_window_minutes=30,
        )
        items = _rule_items(self.details())
        allowance = items["late_free_allowance"]
        self.assertEqual(
            (allowance["value"], allowance["applied"], allowance["changed"]),
            ("3 free marks a month", "1 free mark a month", True),
        )
        slabs = items["late_slabs"]
        self.assertTrue(slabs["changed"])
        self.assertEqual(slabs["applied"], "2 billable late marks cost 0.5 shift")
        self.assertEqual(slabs["value"], "From 3 billable late marks: 0.25 shift")
        self.assertIn("would take 0 shifts for those 2 late marks", slabs["detail"])
        cap = items["permission_cap"]
        self.assertEqual(
            (cap["value"], cap["applied"], cap["changed"]),
            ("Cap of 4 approved permissions a month", "Cap of 1 approved permission a month", True),
        )
        window = items["late_window"]
        self.assertEqual((window["value"], window["applied"], window["changed"]), ("30 min", "60 min", True))
        limit = items["first_half_limit"]
        self.assertTrue(limit["changed"])
        self.assertTrue(limit["value"].startswith("11:00 "))
        self.assertEqual(limit["applied"], "11:30")
        self.assertFalse(items["attendance_mode"]["changed"])
        self.assertFalse(items["extra_minutes"]["changed"])

    def test_changes_to_the_shift_the_salary_and_the_calendar_are_flagged_too(self):
        ShiftTemplate.objects.filter(pk=self.w.shift.pk).update(start_time=time(8, 30))
        Employee.objects.filter(pk=self.w.meena.pk).update(salary_amount=Decimal("30000.00"))
        Holiday.objects.create(name="Founders Day", date=date(2026, 2, 10))
        _holiday_dates_for_month.cache_clear()
        items = _rule_items(self.details())
        self.assertEqual(
            (items["shift"]["value"], items["shift"]["applied"], items["shift"]["changed"]),
            ("General, starts 08:30, 10 min grace", "General, starts 09:00, 10 min grace", True),
        )
        self.assertEqual(
            (items["monthly_salary"]["value"], items["monthly_salary"]["applied"], items["monthly_salary"]["changed"]),
            ("₹30,000", "₹24,000", True),
        )
        self.assertEqual(
            (items["working_days"]["value"], items["working_days"]["applied"], items["working_days"]["changed"]),
            ("23 working days", "24 working days", True),
        )
        self.assertTrue(items["daily_rate"]["changed"])
        _holiday_dates_for_month.cache_clear()

    def test_the_employee_block_masks_the_account_number_and_hides_everything_private(self):
        response = self.client.get(f"/api/payroll/{self.w.meena_payroll.id}/details", **_admin())
        d = response.json()
        self.assertEqual(
            d["employee"],
            {
                "id": self.w.meena.id,
                "code": "S100",
                "name": "Meena Staff",
                "department": "Accounts",
                "designation": "Accounts Executive",
                "branch": None,
                "employmentType": "staff",
                "status": "active",
                "joinDate": "2024-06-03",
                "salaryAmount": 24000.0,
                "salaryPerShift": None,
                "payCycle": None,
                "bank": {"hasAccount": True, "bankName": "HDFC Bank", "hasIfsc": True, "accountLast4": "9012"},
                "pfNumber": "PF/100",
                "esiNumber": "ESI/100",
                "split": None,
            },
        )
        text = response.content.decode("utf-8")
        for secret in ("123456789012", "meena-photo", "12 Secret Street", "ABCDE1234F", "bcrypt-secret-hash"):
            self.assertNotIn(secret, text)

    def test_a_recorded_salary_split_is_returned_in_its_two_portions(self):
        Employee.objects.filter(pk=self.w.meena.pk).update(
            salary_basic=Decimal("12000"),
            salary_da=Decimal("0"),
            salary_retaining_allowance=Decimal("0"),
            salary_other_allowance=Decimal("10000"),
            salary_petrol_allowance=Decimal("2000"),
            salary_hra=Decimal("0"),
            salary_special_allowance=Decimal("0"),
            salary_ca=Decimal("0"),
        )
        split = self.details()["employee"]["split"]
        self.assertEqual((split["first"], split["second"]), (12000.0, 12000.0))
        self.assertEqual(
            {c["key"]: c["amount"] for c in split["components"]},
            {
                "basic": 12000.0,
                "da": 0.0,
                "retainingAllowance": 0.0,
                "otherAllowance": 10000.0,
                "petrolAllowance": 2000.0,
                "hra": 0.0,
                "specialAllowance": 0.0,
                "ca": 0.0,
            },
        )

    def test_a_payroll_with_no_salary_slip_still_answers(self):
        payroll = Payroll.objects.create(
            employee=self.w.anand,
            salary_mode="monthly",
            month=3,
            year=2026,
            total_working_days=26,
            present_days=Decimal("20"),
            absent_days=Decimal("6"),
            base_salary=Decimal("30000"),
            gross_salary=Decimal("23000"),
            deductions=Decimal("0"),
            final_salary=Decimal("23000"),
        )
        d = self.details(payroll)
        self.assertEqual(set(d), DETAILS_KEYS)
        self.assertEqual((d["slipId"], d["slipNumber"], d["days"], d["advances"]), (None, None, [], []))
        self.assertEqual(d["summary"], {"totalWorkingDays": 26, "presentDays": 20.0, "absentDays": 6.0})
        self.assertEqual(_keys(d["issues"]), [(None, "bank_missing")])  # only what the profile can still say
        self.assertEqual(
            [(line["key"], line["amount"]) for line in d["earnings"]], [("gross", 23000.0), ("total_earnings", 23000.0)]
        )
        self.assertEqual(d["earnings"][0]["note"], "The salary earned for the days paid")
        self.assertEqual([(line["key"], line["amount"]) for line in d["deductions"]], [("total_deductions", 0.0)])
        self.assertIn("No day-by-day breakdown is stored for this payroll", d["notes"])
        self.assertEqual(d["money"]["monthlySalary"], 30000.0)
        self.assertIsNone(d["money"]["dailyRate"])
        # the rules are still the current ones, with nothing to compare them with
        items = _rule_items(d)
        self.assertEqual(items["late_free_allowance"]["value"], "1 free mark a month")
        self.assertTrue(all(item["applied"] is None and item["changed"] is False for item in items.values()))
        self.assertEqual(d["period"]["label"], "March 2026")

    def test_payroll_that_hr_adjusted_shows_the_adjustment_in_the_lines_and_the_notes(self):
        self.client.patch(
            f"/api/payroll/{self.w.meena_payroll.id}",
            {"bonus": 1500, "deductions": 700, "notes": "Festival bonus, one more advance cut"},
            content_type="application/json",
            **_admin(),
        )
        d = self.details()
        self.assertEqual((d["money"]["bonus"], d["money"]["deductions"], d["money"]["net"]), (1500.0, 700.0, 22050.0))
        self.assertEqual(d["notes"], "Festival bonus, one more advance cut")
        earnings = {line["key"]: line for line in d["earnings"]}
        self.assertEqual(
            (earnings["bonus"]["amount"], earnings["bonus"]["note"]),
            (1500.0, "Added by HR after the payroll was generated"),
        )
        self.assertEqual(earnings["total_earnings"]["amount"], 22750.0)
        deductions = {line["key"]: line for line in d["deductions"]}
        self.assertEqual(deductions["hr_deduction"]["amount"], 200.0)
        self.assertEqual(deductions["total_deductions"]["amount"], 700.0)
        self.assertNotIn("net_difference", earnings)
        self.assertIn("adjustment", d["issueCounts"]["byCode"])

    def test_a_saved_net_that_is_not_earnings_minus_deductions_is_reconciled_with_an_info_line(self):
        Payroll.objects.filter(pk=self.w.meena_payroll.pk).update(final_salary=Decimal("20000.00"))
        d = self.details()
        line = next(line for line in d["earnings"] if line["key"] == "net_difference")
        self.assertEqual((line["amount"], line["kind"]), (-750.0, "info"))
        self.assertEqual(d["money"]["net"], 20000.0)

    def test_neighbours_follow_the_employees_first_name_within_the_month(self):
        self.assertEqual(
            self.details()["neighbours"],
            {"previousId": self.w.anand_payroll.id, "nextId": None, "position": 2, "total": 2},
        )
        self.assertEqual(
            self.details(self.w.anand_payroll)["neighbours"],
            {"previousId": None, "nextId": self.w.meena_payroll.id, "position": 1, "total": 2},
        )

    def test_history_is_the_last_six_other_payrolls_newest_first_with_their_issue_counts(self):
        months = [(1, 2026), (12, 2025), (11, 2025), (10, 2025), (9, 2025), (8, 2025), (7, 2025)]
        for number, (month, year) in enumerate(months):
            Payroll.objects.create(
                employee=self.w.meena,
                salary_mode="monthly",
                month=month,
                year=year,
                base_salary=Decimal("24000"),
                gross_salary=Decimal("24000"),
                deductions=Decimal("0"),
                final_salary=Decimal(24000 - number),
                status="paid" if number == 0 else "pending",
            )
        history = self.details()["history"]
        self.assertEqual(len(history), 6)
        self.assertEqual(
            [h["label"] for h in history],
            ["January 2026", "December 2025", "November 2025", "October 2025", "September 2025", "August 2025"],
        )
        self.assertEqual(
            (history[0]["net"], history[0]["status"], history[1]["status"], history[0]["issues"]),
            (24000.0, "paid", "pending", 0),
        )
        self.assertNotIn(self.w.meena_payroll.id, [h["payrollId"] for h in history])

    def test_a_worker_with_no_shift_is_judged_against_the_fixed_first_half_cutoff(self):
        with_shift = _rule_items(self.details())
        self.assertNotIn("first_half_fixed_end", with_shift)  # a shift's own limit replaced it
        without = _rule_items(self.details(self.w.anand_payroll))
        cutoff = without["first_half_fixed_end"]
        self.assertEqual(
            (cutoff["value"], cutoff["applied"], cutoff["changed"], cutoff["settingsPath"]),
            ("13:30", "13:30", False, None),
        )
        self.assertEqual(
            (without["shift"]["value"], without["first_half_limit"]["applied"]), ("No shift assigned", None)
        )
        _configure(half_day_first_half_end_time=time(13, 0))
        changed = _rule_items(self.details(self.w.anand_payroll))["first_half_fixed_end"]
        self.assertEqual((changed["value"], changed["applied"], changed["changed"]), ("13:00", "13:30", True))

    def test_the_issue_counts_match_the_issue_list(self):
        d = self.details()
        counts = d["issueCounts"]
        self.assertEqual(counts["total"], 9)
        self.assertEqual(counts["bySeverity"], {"critical": 0, "warning": 9, "info": 0})
        self.assertEqual(counts["byCode"]["late_in"], 1)
        self.assertEqual(sum(counts["byCode"].values()), len(d["issues"]))

    def test_an_unknown_payroll_is_a_404(self):
        _get(self, "/api/payroll/99999999/details", expect=404)

    def test_a_production_payroll_id_is_a_404_on_the_staff_endpoint(self):
        production = production_world()
        _get(self, f"/api/payroll/{production.raja_payroll.id}/details", expect=404)


class ProductionDetailsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = production_world()

    def details(self, payroll=None, expect=200):
        return _get(self, f"/api/payroll/production/{(payroll or self.w.raja_payroll).id}/details", expect=expect)

    def test_every_section_is_there_and_the_numbers_are_the_payrolls_own(self):
        d = self.details()
        payroll = Payroll.objects.get(pk=self.w.raja_payroll.pk)
        slip = SalarySlip.objects.get(employee=self.w.raja, period_start=START, period_end=END)
        self.assertEqual(set(d), DETAILS_KEYS)
        self.assertEqual(
            (d["kind"], d["slipId"], d["slipNumber"]), ("production", slip.id, "SS/P100/2026-02-02_2026-02-08")
        )
        self.assertEqual(
            d["money"],
            {
                "gross": 3000.0,
                "deductions": 250.0,
                "bonus": 0.0,
                "otAmount": 0.0,
                "net": 2750.0,
                "monthlySalary": None,
                "dailyRate": None,
            },
        )
        self.assertEqual(d["money"]["net"], float(payroll.final_salary))
        self.assertEqual(d["summary"], {"totalDays": 7, "daysWorked": 6, "daysAbsent": 1, "totalShifts": 6.0})
        self.assertEqual(
            d["period"],
            {
                "label": "2 Feb - 8 Feb 2026",
                "start": "2026-02-02",
                "end": "2026-02-08",
                "month": 2,
                "year": 2026,
                "days": 7,
                "cycle": "weekly",
                "cycleLabel": "Weekly",
            },
        )
        self.assertEqual(
            d["context"],
            {
                "kind": "production",
                "month": 2,
                "year": 2026,
                "cycle": "weekly",
                "periodStart": "2026-02-02",
                "periodEnd": "2026-02-08",
            },
        )
        self.assertEqual((d["employee"]["payCycle"], d["employee"]["salaryPerShift"]), ("weekly", 500.0))
        self.assertEqual(len(d["days"]), 7)

    def test_the_lines_say_how_the_pay_and_the_late_deduction_were_worked_out(self):
        d = self.details()
        self.assertEqual(
            [(line["key"], line["amount"], line["kind"]) for line in d["earnings"]],
            [("gross", 3000.0, "earning"), ("total_earnings", 3000.0, "subtotal")],
        )
        self.assertEqual(d["earnings"][0]["note"], "6 shifts x ₹500 per shift")
        self.assertEqual(
            [(line["key"], line["amount"], line["note"]) for line in d["deductions"][:1]],
            [("late_penalty", 250.0, "0.5 shift x ₹500 per shift (1 billable late day)")],
        )
        self.assertEqual(
            d["deductions"][-1],
            {
                "key": "total_deductions",
                "label": "Total deductions",
                "note": None,
                "amount": 250.0,
                "kind": "subtotal",
                "ruleKey": None,
            },
        )

    def test_the_days_are_the_same_shape_as_staff_with_flags(self):
        days = {day["date"]: day for day in self.details()["days"]}
        self.assertEqual(days["2026-02-03"]["flags"], ["late_in"])
        self.assertEqual(
            (days["2026-02-05"]["status"], days["2026-02-05"]["shifts"], days["2026-02-05"]["flags"]),
            ("half_shift", 0.5, ["half_day"]),
        )
        self.assertEqual((days["2026-02-06"]["shifts"], days["2026-02-06"]["lastOut"]), (1.5, "20:00"))
        self.assertEqual(days["2026-02-08"]["flags"], ["absent"])
        self.assertEqual((days["2026-02-08"]["day"], days["2026-02-08"]["firstIn"]), ("Sunday", None))

    def test_the_rules_are_the_cycles_and_nothing_has_changed_yet(self):
        d = self.details()
        self.assertEqual(
            [g["group"] for g in d["rules"]],
            ["Pay cycle", "Attendance mode & late detection", "Statutory (PF / ESI)", "Pay basis"],
        )
        items = _rule_items(d)
        self.assertEqual(
            (items["pay_cycle"]["value"], items["pay_cycle"]["applied"]), ("Weekly (7 days)", "Weekly (7 days)")
        )
        self.assertEqual((items["week_start"]["value"], items["week_start"]["applied"]), ("Monday", "Monday"))
        self.assertEqual((items["monthly_factor"]["value"], items["monthly_factor"]["applied"]), ("x4", "x4"))
        self.assertEqual((items["late_switch"]["value"], items["late_switch"]["applied"]), ("On", "On"))
        self.assertEqual(items["free_allowance"]["applied"], "1 free late day a period")
        self.assertEqual(items["late_slabs"]["applied"], "1 billable late cost 0.5 shift")
        self.assertEqual((items["salary_per_shift"]["value"], items["salary_per_shift"]["applied"]), ("₹500", "₹500"))
        self.assertEqual(items["production_shift"]["value"], "Prod A, 08:30-17:30, 10 min grace")
        self.assertEqual(items["week_start"]["settingsPath"], "/hr/settings?tab=production_payroll#weekly-week-start")
        self.assertEqual([k for k, item in items.items() if item.get("changed")], [])

    def test_settings_changed_since_generation_are_flagged(self):
        _configure(
            prod_late_free_allowance=2,
            prod_late_deduction_slabs=[{"fromLates": 5, "deductionShifts": 1}],
            prod_cycles={"weekly": {"weekStart": "wednesday"}},
            prod_late_detection_enabled=False,
        )
        items = _rule_items(self.details())
        self.assertEqual(
            (items["week_start"]["value"], items["week_start"]["applied"], items["week_start"]["changed"]),
            ("Wednesday", "Monday", True),
        )
        self.assertEqual(
            (items["free_allowance"]["value"], items["free_allowance"]["applied"], items["free_allowance"]["changed"]),
            ("2 free late days a period", "1 free late day a period", True),
        )
        self.assertTrue(items["late_slabs"]["changed"])
        self.assertEqual(
            (items["late_switch"]["value"], items["late_switch"]["applied"], items["late_switch"]["changed"]),
            ("Off", "On", True),
        )
        self.assertFalse(items["monthly_factor"]["changed"])

    def test_an_employee_who_moved_to_another_cycle_since_is_flagged(self):
        Employee.objects.filter(pk=self.w.raja.pk).update(production_pay_cycle="biweekly")
        item = _rule_items(self.details())["pay_cycle"]
        self.assertEqual(
            (item["value"], item["applied"], item["changed"]), ("BiWeekly (14 days)", "Weekly (7 days)", True)
        )

    def test_a_staff_payroll_id_is_a_404_on_the_production_endpoint(self):
        staff = staff_world()
        _get(self, f"/api/payroll/production/{staff.meena_payroll.id}/details", expect=404)

    def test_every_line_names_a_rule_that_is_in_the_rules(self):
        d = self.details()
        keys = set(_rule_items(d))
        named = [line["ruleKey"] for line in [*d["earnings"], *d["deductions"]] if line["ruleKey"]]
        self.assertEqual(named, ["salary_per_shift", "late_slabs"])
        self.assertTrue(set(named) <= keys)

    def test_an_older_row_with_no_stamped_cycle_is_shown_with_the_employees_cycle(self):
        Payroll.objects.filter(pk=self.w.raja_payroll.pk).update(pay_cycle=None)
        slip = SalarySlip.objects.get(employee=self.w.raja, period_start=START)
        slip.breakdown_details = {**slip.breakdown_details, "payCycle": None}
        slip.save()
        d = self.details()
        self.assertEqual(
            (d["period"]["cycle"], d["period"]["cycleLabel"], d["context"]["cycle"]), ("weekly", "Weekly", "weekly")
        )
        pay_cycle = _rule_items(d)["pay_cycle"]
        # what it was generated with was not recorded: that is never reported as a change
        self.assertEqual(
            (pay_cycle["value"], pay_cycle["applied"], pay_cycle["changed"]), ("Weekly (7 days)", None, False)
        )
        # and the Weekly lists still find it through its employee
        self.assertEqual(_get(self, f"/api/payroll/production/issues?{PROD_QS}")["summary"]["employees"], 2)

    def test_an_older_session_based_row_answers_as_a_legacy_row_without_day_detail(self):
        legacy = Payroll.objects.create(
            employee=self.w.raja,
            salary_mode="session",
            month=1,
            year=2026,
            base_salary=Decimal("4000"),
            gross_salary=Decimal("4000"),
            deductions=Decimal("100"),
            final_salary=Decimal("3900"),
        )
        d = self.details(legacy)
        self.assertEqual(
            (d["kind"], d["days"], d["issues"], d["rules"], d["earnings"]), ("legacy_session", [], [], [], [])
        )
        self.assertEqual((d["money"]["net"], d["period"]["label"]), (3900.0, "January 2026"))
        self.assertIn("older session-based production engine", d["notes"])
        self.assertEqual(d["context"]["kind"], "production")
        _get(self, f"/api/payroll/{legacy.id}/details", expect=404)  # not reachable from the staff endpoint

    def test_history_lists_the_workers_other_periods(self):
        _generate_production_payroll(self.w.raja, date(2026, 2, 9), date(2026, 2, 15), pay_cycle="weekly")
        history = self.details()["history"]
        self.assertEqual([h["label"] for h in history], ["9 Feb - 15 Feb 2026"])
        self.assertEqual(
            self.details()["neighbours"],
            {"previousId": self.w.lakshmi_payroll.id, "nextId": None, "position": 2, "total": 2},
        )


class ProductionBandTests(TestCase):
    """Salary-band PF / EF: the band applied is explained, and a band list edited since is detected."""

    @classmethod
    def setUpTestData(cls):
        _configure(
            prod_attendance_mode="simple",
            prod_late_detection_enabled=False,
            prod_payroll_rules_enabled=False,
            prod_pf_ef_enabled=True,
            prod_pf_ef_rules=[
                {"label": "Low", "minSalary": 0, "maxSalary": 10000, "pfRate": 0, "efRate": 0},
                {"label": "Mid", "minSalary": 10001, "maxSalary": 30000, "pfRate": 12, "efRate": 1},
                {"label": "Top", "minSalary": 30001, "maxSalary": 0, "pfRate": 12, "efRate": 0},
            ],
            prod_cycles=CYCLES,
        )
        cls.emp = _production(
            "PB1",
            first="Bala",
            production_pay_cycle="weekly",
            pf_number="PF/B",
            esi_number="ESI/B",
            bank_account="1234567890",
            bank_ifsc="X",
        )
        for offset in range(5):
            _day(cls.emp, date(2026, 2, 2 + offset), shifts="1.00", first_punch=time(8, 30), last_punch=time(17, 30))
        for offset in (5, 6):
            _day(
                cls.emp,
                date(2026, 2, 2 + offset),
                "half_shift",
                "0.50",
                first_punch=time(8, 30),
                last_punch=time(12, 30),
            )
        cls.payroll = _generate_production_payroll(cls.emp, START, END, pay_cycle="weekly")[
            "payroll"
        ]  # 6 shifts = 3,000 -> 12,000 a month

    def details(self):
        return _get(self, f"/api/payroll/production/{self.payroll.id}/details")

    def test_the_band_pf_and_ef_are_explained(self):
        d = self.details()
        self.assertEqual((float(self.payroll.gross_salary), float(self.payroll.deductions)), (3000.0, 390.0))
        lines = {line["key"]: line for line in d["deductions"]}
        self.assertEqual(lines["pf"]["note"], "12% of the period pay ₹3,000 (salary band Mid)")
        self.assertEqual(lines["esi"]["note"], "1% of the period pay ₹3,000 (salary band Mid)")
        self.assertEqual(
            (lines["pf"]["amount"], lines["esi"]["amount"], lines["esi"]["label"]), (360.0, 30.0, "ESI / EF")
        )
        band = _rule_items(d)["pf_ef_rule"]
        self.assertEqual((band["applied"], band["changed"]), ("Mid", False))
        self.assertEqual(
            band["value"],
            "Low: ₹0 to ₹10,000: PF 0%, EF 0%; Mid: ₹10,001 to ₹30,000: PF 12%, EF 1%; Top: ₹30,001 and above: PF 12%, EF 0%",
        )

    def test_a_band_list_edited_since_is_detected(self):
        _configure(
            prod_pf_ef_rules=[
                {"label": "Low", "minSalary": 0, "maxSalary": 10000, "pfRate": 0, "efRate": 0},
                {"label": "Mid", "minSalary": 10001, "maxSalary": 11000, "pfRate": 12, "efRate": 1},
                {"label": "Top", "minSalary": 11001, "maxSalary": 0, "pfRate": 12, "efRate": 0},
            ]
        )
        items = _rule_items(self.details())
        self.assertEqual((items["pf_ef_rule"]["applied"], items["pf_ef_rule"]["changed"]), ("Mid", True))
        self.assertIn("this pay would use Top", items["pf_ef_rule"]["detail"])
        self.assertFalse(items["pf_rate"]["changed"])  # PF is 12% in both bands
        self.assertTrue(items["esi_rate"]["changed"])  # EF went from 1% to 0%


class BranchSettingsTests(TestCase):
    """PF / ESI follow the EMPLOYEE's branch (settings_for_employee): a branch's own rate is what 'changed' is judged against."""

    @classmethod
    def setUpTestData(cls):
        _configure(
            attendance_mode="simple",
            staff_payroll_rules_enabled=False,
            pf_rate=Decimal("0"),
            late_deduction_slabs=[],
            compensation_feature_enabled=True,
        )
        cls.north = Branch.objects.create(name="North")
        BranchSettingsOverride.objects.create(
            branch=cls.north, overrides={"staff_payroll_rules_enabled": True, "pf_rate": "10"}
        )
        cls.nila = _staff("N1", first="Nila", salary="20000.00", branch=cls.north)
        cls.head = _staff("H1", first="Hari", salary="20000.00")
        for emp in (cls.nila, cls.head):
            _present(emp, WORKING)
        cls.nila_payroll = _generate_staff_payroll(cls.nila, MONTH, YEAR)["payroll"]
        cls.head_payroll = _generate_staff_payroll(cls.head, MONTH, YEAR)["payroll"]

    def test_the_branchs_own_pf_rate_is_the_one_in_force_and_unchanged(self):
        self.assertEqual(float(self.nila_payroll.deductions) > 0, True)  # the branch's 10% PF was deducted
        d = _get(self, f"/api/payroll/{self.nila_payroll.id}/details")
        items = _rule_items(d)
        self.assertEqual(
            (items["pf_rate"]["value"], items["pf_rate"]["applied"], items["pf_rate"]["changed"]),
            ("10% of Basic", "10% of Basic", False),
        )
        self.assertEqual(items["pf_esi_switch"]["value"], "On")
        head = _rule_items(_get(self, f"/api/payroll/{self.head_payroll.id}/details"))
        self.assertEqual(head["pf_esi_switch"]["value"], "Off")
        self.assertFalse(head["pf_rate"]["changed"])

    def test_the_rules_table_chips_show_each_employees_own_branch_settings(self):
        rows = {e["employeeCode"]: e for e in _get(self, f"/api/payroll/rules?{STAFF_QS}")["employees"]}
        self.assertIn("PF 10%", [c["label"] for c in rows["N1"]["chips"]])
        self.assertIn("No PF", [c["label"] for c in rows["H1"]["chips"]])

    def test_the_branch_login_sees_its_own_settings_in_the_rules_tab(self):
        headers = _login("north_viewer", {"payroll": "view"}, branch=self.north)
        body = _get(self, f"/api/payroll/rules?{STAFF_QS}", headers)
        statutory = next(g for g in body["settings"] if g["group"] == "Statutory (PF / ESI)")
        items = {i["key"]: i for i in statutory["items"]}
        self.assertEqual((items["pf_esi_switch"]["value"], items["pf_rate"]["value"]), ("On", "10% of Basic"))
        self.assertEqual([e["employeeCode"] for e in body["employees"]], ["N1"])  # only its own branch's people


# ─────────────────────────────────────────────────────────────────────────────
#  Rules
# ─────────────────────────────────────────────────────────────────────────────


class StaffRulesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = staff_world()

    def rules(self, extra=""):
        return _get(self, f"/api/payroll/rules?{STAFF_QS}{extra}")

    def test_the_settings_are_grouped_and_each_links_to_its_settings_block(self):
        body = self.rules()
        self.assertEqual(body["scope"]["label"], "February 2026")
        self.assertEqual(
            [g["group"] for g in body["settings"]],
            [
                "Attendance & late detection",
                "Half day & permissions",
                "Statutory (PF / ESI)",
                "Pay basis",
                "Overtime / Compensation switch",
            ],
        )
        items = {i["key"]: i for g in body["settings"] for i in g["items"]}
        self.assertEqual(items["attendance_mode"]["value"], "Simple (first and last punch)")
        self.assertEqual(items["attendance_mode"]["settingsPath"], "/hr/settings?tab=attendance#attendance-mode")
        self.assertEqual(items["late_free_allowance"]["value"], "1 free mark a month")
        self.assertEqual(items["late_slabs"]["value"], "From 1 billable late mark: 0.5 shift")
        self.assertEqual(items["late_slabs"]["settingsPath"], "/hr/settings?tab=late_detection#deduction-slabs")
        self.assertEqual(items["permission_cap"]["value"], "Cap of 1 approved permission a month")
        self.assertEqual(items["pf_rate"]["settingsPath"], "/hr/settings?tab=payroll#staff-pf-rate")
        self.assertEqual(
            items["compensation_features"]["settingsPath"], "/hr/settings?tab=payroll#compensation-features"
        )
        self.assertTrue(all(item["source"] == "settings" for item in items.values()))
        self.assertTrue(all("applied" not in item and "changed" not in item for item in items.values()))
        without_link = {key for key, item in items.items() if item["settingsPath"] is None}
        self.assertEqual(without_link, {"first_half_limit", "pay_basis"})

    def test_a_changed_setting_shows_at_once(self):
        _configure(late_free_allowance=5)
        items = {i["key"]: i for g in self.rules()["settings"] for i in g["items"]}
        self.assertEqual(items["late_free_allowance"]["value"], "5 free marks a month")

    def test_every_employee_of_the_month_has_an_entry_with_chips_flags_and_their_own_rules(self):
        employees = self.rules()["employees"]
        self.assertEqual([e["employeeCode"] for e in employees], ["S200", "S100"])  # by first name: Anand, Meena
        anand, meena = employees
        self.assertEqual(
            (meena["employeeName"], meena["department"], meena["designation"], meena["payrollId"], meena["flags"]),
            ("Meena Staff", "Accounts", "Accounts Executive", self.w.meena_payroll.id, []),
        )
        self.assertEqual(
            [(c["key"], c["label"], c["tone"]) for c in meena["chips"]],
            [("shift", "General 09:00-18:00", "info"), ("pf", "No PF", "neutral"), ("esi", "No ESI", "neutral")],
        )
        self.assertEqual(
            [(c["key"], c["label"], c["tone"]) for c in anand["chips"]],
            [
                ("shift", "No shift", "warning"),
                ("pf", "No PF", "neutral"),
                ("esi", "No ESI", "neutral"),
                ("bank", "No bank details", "warning"),
            ],
        )
        self.assertEqual(anand["flags"], ["no_shift", "no_bank"])
        self.assertEqual(
            [(g["group"], [i["key"] for i in g["items"]]) for g in meena["groups"]],
            [
                ("Attendance & late detection", ["shift", "saturday_off"]),
                ("Half day & permissions", ["first_half_limit"]),
                ("Statutory (PF / ESI)", ["pf_rate", "esi_rate"]),
                ("Pay basis", ["monthly_salary", "working_days", "daily_rate"]),
            ],
        )
        shift = meena["groups"][0]["items"][0]
        self.assertEqual((shift["value"], shift["source"]), ("General, starts 09:00, 10 min grace", "shift"))
        self.assertEqual(anand["groups"][0]["items"][0]["value"], "No shift assigned")

    def test_pf_and_esi_chips_follow_the_settings_and_the_salary(self):
        _configure(
            staff_payroll_rules_enabled=True,
            pf_rate=Decimal("12"),
            esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"),
        )
        chips = {e["employeeCode"]: {c["key"]: c["label"] for c in e["chips"]} for e in self.rules()["employees"]}
        self.assertEqual(
            (chips["S100"]["pf"], chips["S100"]["esi"]), ("PF 12%", "ESI above ceiling")
        )  # 24,000 > 21,000
        _configure(esi_applicable_below=Decimal("30000"))
        chips = {e["employeeCode"]: {c["key"]: c["label"] for c in e["chips"]} for e in self.rules()["employees"]}
        self.assertEqual(chips["S100"]["esi"], "ESI 0.75%")

    def test_saturday_off_and_holidays_change_the_working_days(self):
        EmployeeShiftAssignment.objects.filter(employee=self.w.meena).update(saturday_off=True)
        Holiday.objects.create(name="Founders Day", date=date(2026, 2, 10))
        _holiday_dates_for_month.cache_clear()
        meena = next(e for e in self.rules()["employees"] if e["employeeCode"] == "S100")
        items = {i["key"]: i for g in meena["groups"] for i in g["items"]}
        self.assertEqual(items["saturday_off"]["value"], "Saturday is a day off")
        self.assertEqual(items["working_days"]["value"], "19 working days")  # 24 - 4 Saturdays - 1 holiday
        self.assertIn("Saturday off", [c["label"] for c in meena["chips"]])
        _holiday_dates_for_month.cache_clear()

    def test_filters_and_validation(self):
        self.assertEqual(
            [e["employeeCode"] for e in self.rules(f"&departmentId={self.w.dept.id}")["employees"]], ["S100"]
        )
        self.assertEqual(self.rules(f"&employeeId={self.w.anand.id}")["employees"][0]["employeeCode"], "S200")
        _get(self, "/api/payroll/rules?month=2", expect=400)


class ProductionRulesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = production_world()

    def rules(self, extra=""):
        return _get(self, f"/api/payroll/production/rules?{PROD_QS}{extra}")

    def test_the_settings_of_the_requested_cycle_are_grouped_and_linked(self):
        body = self.rules()
        self.assertEqual(body["scope"]["label"], "2 Feb - 8 Feb 2026")
        self.assertEqual(
            [g["group"] for g in body["settings"]],
            ["Pay cycle", "Attendance mode & late detection", "Statutory (PF / ESI)", "Pay basis"],
        )
        items = {i["key"]: i for g in body["settings"] for i in g["items"]}
        self.assertEqual(
            (items["pay_cycle"]["value"], items["week_start"]["value"], items["monthly_factor"]["value"]),
            ("Weekly (7 days)", "Monday", "x4"),
        )
        self.assertEqual(items["first_period"]["value"], "Not needed for Weekly")
        self.assertEqual(items["late_slabs"]["settingsPath"], "/hr/settings?tab=production_payroll#weekly-late-slabs")
        self.assertEqual(items["late_switch"]["settingsPath"], "/hr/settings?tab=production_payroll#prod-late-switch")
        self.assertEqual(items["pf_rate"]["settingsPath"], "/hr/settings?tab=payroll#prod-pf-rate")
        self.assertEqual(
            items["free_allowance"]["detail"], "The shared production value applies: this cycle has none of its own"
        )

    def test_the_cycles_own_late_rules_are_named_as_its_own(self):
        _configure(
            prod_cycles={
                **CYCLES,
                "weekly": {
                    "weekStart": "monday",
                    "lateFreeAllowance": 2,
                    "lateSlabs": [{"fromLates": 2, "deductionShifts": 1}],
                },
            }
        )
        items = {i["key"]: i for g in self.rules()["settings"] for i in g["items"]}
        self.assertEqual(items["free_allowance"]["value"], "2 free late days a period")
        self.assertEqual(items["free_allowance"]["detail"], "The Weekly cycle has its own value")
        self.assertEqual(items["late_slabs"]["value"], "From 2 billable lates: 1 shift")

    def test_the_biweekly_page_asks_for_its_own_cycle_settings(self):
        body = _get(self, f"/api/payroll/production/rules?cycle=biweekly&periodStart={START}&periodEnd=2026-02-15")
        items = {i["key"]: i for g in body["settings"] for i in g["items"]}
        self.assertEqual(
            (items["pay_cycle"]["value"], items["monthly_factor"]["value"], items["first_period"]["value"]),
            ("BiWeekly (14 days)", "x2", "02-02-2026"),
        )
        self.assertEqual(items["period_length"]["value"], "14 days (2 weeks)")
        self.assertEqual(body["employees"], [])

    def test_the_period_length_is_listed(self):
        items = {i["key"]: i for g in self.rules()["settings"] for i in g["items"]}
        self.assertEqual(items["period_length"]["value"], "7 days (1 week)")

    def test_each_worker_has_the_cycle_the_rate_and_the_production_shift(self):
        employees = {e["employeeCode"]: e for e in self.rules()["employees"]}
        raja, lakshmi = employees["P100"], employees["P200"]
        self.assertEqual(
            [(c["key"], c["label"], c["tone"]) for c in raja["chips"]],
            [
                ("cycle", "Weekly", "accent"),
                ("rate", "₹500 / shift", "info"),
                ("shift", "Prod A 08:30-17:30", "info"),
                ("statutory", "No PF / ESI", "neutral"),
            ],
        )
        self.assertEqual(raja["flags"], [])
        self.assertEqual((raja["department"], raja["payrollId"]), ("Weaving", self.w.raja_payroll.id))
        self.assertEqual(lakshmi["flags"], ["no_shift", "no_bank"])
        self.assertEqual(
            [(c["key"], c["tone"]) for c in lakshmi["chips"] if c["key"] in ("shift", "bank")],
            [("shift", "warning"), ("bank", "warning")],
        )
        items = {i["key"]: i for g in raja["groups"] for i in g["items"]}
        self.assertEqual(items["production_shift"]["value"], "Prod A, 08:30-17:30, 10 min grace")
        self.assertEqual(items["salary_per_shift"]["value"], "₹500")
        self.assertEqual(items["pay_cycle"]["value"], "Weekly (7 days)")

    def test_a_worker_with_no_rate_or_cycle_is_flagged(self):
        Employee.objects.filter(pk=self.w.lakshmi.pk).update(salary_per_shift=None, production_pay_cycle=None)
        lakshmi = next(e for e in self.rules()["employees"] if e["employeeCode"] == "P200")
        # no cycle assigned any more: their payroll still carries the weekly cycle it was generated on
        self.assertEqual(lakshmi["flags"], ["no_shift", "no_rate", "no_cycle", "no_bank"])
        self.assertEqual(
            [(c["key"], c["label"]) for c in lakshmi["chips"][:2]], [("cycle", "No pay cycle"), ("rate", "No rate")]
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Salary Statement
# ─────────────────────────────────────────────────────────────────────────────

STAFF_COLUMN_KEYS = [
    "sno", "code", "name", "designation", "basic", "total", "present", "cl", "lop", "hd", "totalDays", "petrol",
    "othersAllow", "eSalary", "tAdvance", "advance", "esi", "pf", "tds", "others", "lopAmount", "totalDeduction",
    "net", "remarks",
]  # fmt: skip


class StaffStatementTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = statement_world()

    def statement(self, extra="", headers=None):
        return _get(self, f"/api/payroll/salary-statement?{APRIL_QS}{extra}", headers)

    def rows(self, body=None):
        body = body or self.statement()
        return {r["values"]["code"]: r["values"] for g in body["groups"] for r in g["rows"]}

    def test_the_columns_are_the_printed_statements_in_its_order(self):
        columns = self.statement()["columns"]
        self.assertEqual([c["key"] for c in columns], STAFF_COLUMN_KEYS)
        self.assertEqual(
            [c["label"] for c in columns],
            [
                "SNO", "ID NO", "Name", "Designation", "Basic salary", "Total", "Present", "CL", "LOP", "HD", "Total Days",
                "PTRL", "Others Allow", "E salary", "T.Advance", "Advance", "ESI", "PF", "TDS", "Others", "Lop& PSAmt",
                "Total Deduction", "NET", "Remarks",
            ],
        )  # fmt: skip
        by_key = {c["key"]: c for c in columns}
        for key in ("sno", "code", "name", "designation", "remarks"):
            self.assertFalse(by_key[key]["total"], key)
        for key in set(STAFF_COLUMN_KEYS) - {"sno", "code", "name", "designation", "remarks"}:
            self.assertTrue(by_key[key]["total"], key)
        self.assertEqual({by_key[k]["format"] for k in ("present", "cl", "lop", "hd", "totalDays")}, {"days"})
        self.assertEqual(
            {by_key[k]["format"] for k in ("basic", "total", "petrol", "eSalary", "net", "tds")}, {"money"}
        )
        self.assertEqual((by_key["sno"]["format"], by_key["code"]["format"]), ("int", "text"))
        self.assertEqual(
            (by_key["sno"]["align"], by_key["name"]["align"], by_key["net"]["align"]), ("center", "left", "right")
        )
        self.assertEqual(
            (by_key["name"]["weight"], by_key["designation"]["weight"], by_key["remarks"]["weight"]), (3, 2.2, 2)
        )
        self.assertEqual({by_key[k]["group"] for k in ("sno", "code", "name", "designation")}, {"identity"})
        self.assertEqual({by_key[k]["group"] for k in ("present", "cl", "lop", "hd", "totalDays")}, {"attendance"})
        self.assertEqual({by_key[k]["group"] for k in ("esi", "pf", "tds", "others", "totalDeduction")}, {"deductions"})
        self.assertEqual(by_key["net"]["group"], "result")
        self.assertEqual(by_key["tds"]["sub"], "not tracked")

    def test_the_printed_example_row_adds_up(self):
        # Total 29,500 over 26 working days: 22 present + 2 Casual Leave = 24 days paid, 2 LOP, HR set deductions to 1,000
        row = self.rows()["2316"]
        expected = {
            "code": "2316",
            "name": "MEENATCHI Staff",
            "designation": "Accounts Executive",
            "basic": 14750.0,
            "total": 29500.0,
            "present": 22.0,
            "cl": 2.0,
            "lop": 2.0,
            "hd": 0.0,
            "totalDays": 24.0,
            "petrol": 2000.0,
            "othersAllow": 12750.0,
            "eSalary": 27230.77,  # 29,500 x 24 / 26 (the printed row shows it without the paise)
            "tAdvance": 0.0,
            "advance": 0.0,
            "esi": 0.0,
            "pf": 0.0,
            "tds": 0.0,
            "others": 1000.0,
            "lopAmount": 2269.23,
            "totalDeduction": 1000.0,
            "net": 26230.77,
            "remarks": "",
        }
        for key, value in expected.items():
            self.assertEqual(row[key], value, key)
        self.assertEqual(set(row), set(STAFF_COLUMN_KEYS))

    def test_every_row_obeys_the_statements_arithmetic(self):
        for code, v in self.rows().items():
            near = dict(delta=0.011, msg=code)
            self.assertAlmostEqual(v["basic"] + v["petrol"] + v["othersAllow"], v["total"], **near)
            self.assertAlmostEqual(v["present"] + v["cl"], v["totalDays"], **near)
            self.assertAlmostEqual(v["total"] * v["totalDays"] / 26, v["eSalary"], **near)
            self.assertAlmostEqual(26 - v["totalDays"], v["lop"], **near)
            self.assertAlmostEqual(v["total"] - v["eSalary"], v["lopAmount"], **near)
            self.assertAlmostEqual(
                v["esi"] + v["pf"] + v["tds"] + v["advance"] + v["others"], v["totalDeduction"], **near
            )
            self.assertAlmostEqual(v["eSalary"] - v["totalDeduction"], v["net"], **near)
            self.assertEqual(v["tds"], 0.0)

    def test_a_half_day_an_advance_and_no_recorded_split(self):
        row = self.rows()["2896"]
        # 20 full days + 1 half day + 1 Casual Leave = 21.5 paid of 26: LOP 4.5, HD (half-shift days) 1
        self.assertEqual(
            (row["present"], row["cl"], row["lop"], row["hd"], row["totalDays"]), (20.5, 1.0, 4.5, 1.0, 21.5)
        )
        # no split recorded: Basic is 50% of the salary, no Petrol, the other 50% is Others Allow
        self.assertEqual(
            (row["basic"], row["petrol"], row["othersAllow"], row["total"]), (8750.0, 0.0, 8750.0, 17500.0)
        )
        # 6,000 advance with 2,000 recovered this month: 4,000 is still owed, so the balance before this month was 6,000
        self.assertEqual((row["tAdvance"], row["advance"], row["others"]), (6000.0, 2000.0, 0.0))
        self.assertEqual((row["eSalary"], row["totalDeduction"], row["net"]), (14471.15, 2000.0, 12471.15))
        self.assertEqual(float(Payroll.objects.get(pk=self.w.payrolls["2896"].pk).final_salary), 12471.15)

    def test_t_advance_is_the_balance_before_the_months_recovery_even_after_later_repayments(self):
        advance = self.w.advance
        # May's 1,000 was recovered after April's payroll: still owed now is 3,000, but before April it was still 6,000
        Advance.objects.filter(pk=advance.pk).update(outstanding=Decimal("3000"), total_repaid=Decimal("3000"))
        AdvanceRepayment.objects.create(advance=advance, month=5, year=YEAR, amount=Decimal("1000"), is_processed=True)
        row = self.rows()["2896"]
        self.assertEqual((row["tAdvance"], row["advance"]), (6000.0, 2000.0))
        # the advance is closed by a later repayment: it is no longer outstanding, but it was owed before April
        Advance.objects.filter(pk=advance.pk).update(
            status="closed", outstanding=Decimal("0"), total_repaid=Decimal("6000")
        )
        AdvanceRepayment.objects.create(advance=advance, month=6, year=YEAR, amount=Decimal("3000"), is_processed=True)
        self.assertEqual(self.rows()["2896"]["tAdvance"], 6000.0)
        # an advance recovered BEFORE April was already paid back, and a rejected or pending one was never owed
        AdvanceRepayment.objects.create(advance=advance, month=3, year=YEAR, amount=Decimal("999"), is_processed=True)
        Advance.objects.create(
            employee_id=self.w.payrolls["2316"].employee_id, advance_type="general", amount=Decimal("5000"),
            status="rejected", total_repaid=Decimal("0"), outstanding=Decimal("5000"),
        )  # fmt: skip
        rows = self.rows()
        self.assertEqual(rows["2896"]["tAdvance"], 6000.0)
        self.assertEqual(rows["2316"]["tAdvance"], 0.0)

    def test_only_approved_casual_leave_counts_as_cl(self):
        # Meena has a PENDING request on a day she worked: it is not CL
        self.assertEqual(self.rows()["2316"]["cl"], 2.0)
        self.assertEqual(self.rows()["189"]["cl"], 0.0)

    def test_departments_are_bands_rows_follow_code_order_and_sno_runs_across_them(self):
        body = self.statement()
        self.assertEqual(
            [(g["label"], [r["values"]["code"] for r in g["rows"]]) for g in body["groups"]],
            [("Accounts", ["2316", "2896", "30071"]), ("Admin", ["189", "226", "2234"])],
        )
        self.assertEqual([r["sno"] for g in body["groups"] for r in g["rows"]], [1, 2, 3, 4, 5, 6])
        self.assertEqual([r["values"]["sno"] for g in body["groups"] for r in g["rows"]], [1, 2, 3, 4, 5, 6])
        first = body["groups"][0]["rows"][0]
        self.assertEqual(
            (first["payrollId"], first["employeeId"], first["status"]),
            (self.w.payrolls["2316"].id, self.w.payrolls["2316"].employee_id, "pending"),
        )
        self.assertEqual({g["key"] for g in body["groups"]}, {str(self.w.accounts.id), str(self.w.admin.id)})

    def test_subtotals_and_the_grand_total_are_the_sums_of_the_columns_that_add_up(self):
        body = self.statement()
        adding = [c["key"] for c in body["columns"] if c["total"]]
        for group in body["groups"]:
            sub = group["subtotal"]
            self.assertEqual((sub["payrollId"], sub["employeeId"], sub["sno"], sub["status"]), (None, None, None, None))
            self.assertEqual(sub["values"]["name"], "Sub total")
            for key in adding:
                self.assertAlmostEqual(
                    sub["values"][key], sum(r["values"][key] for r in group["rows"]), delta=0.011, msg=key
                )
            for key in ("sno", "code", "designation", "remarks"):
                self.assertIsNone(sub["values"][key])
        total = body["total"]
        self.assertEqual(total["values"]["name"], "Grand total")
        for key in adding:
            self.assertAlmostEqual(
                total["values"][key], sum(g["subtotal"]["values"][key] for g in body["groups"]), delta=0.011, msg=key
            )
        accounts, admin = (g["subtotal"]["values"] for g in body["groups"])
        self.assertEqual(
            (accounts["total"], accounts["eSalary"], accounts["totalDeduction"], accounts["net"]),
            (97000.0, 47471.15, 3000.0, 44471.15),
        )
        self.assertEqual((admin["total"], admin["eSalary"], admin["net"]), (182000.0, 182000.0, 182000.0))
        grand = total["values"]
        self.assertEqual(
            (grand["total"], grand["eSalary"], grand["net"], grand["lopAmount"]),
            (279000.0, 229471.15, 226471.15, 49528.85),
        )
        self.assertEqual((grand["basic"] + grand["petrol"] + grand["othersAllow"], grand["tds"]), (grand["total"], 0.0))

    def test_remarks_say_left_and_joined_and_nothing_else(self):
        rows = self.rows()
        self.assertEqual(rows["30071"]["remarks"], "LEFT")
        self.assertEqual(rows["2234"]["remarks"], "JOINED 15-04")
        self.assertEqual([c for c, v in rows.items() if v["remarks"] == ""], ["2316", "2896", "189", "226"])

    def test_company_period_title_and_counts(self):
        body = self.statement()
        self.assertEqual(body["kind"], "staff")
        self.assertEqual(body["company"], {"name": "U.K TEXTILES", "branchLabel": None})
        self.assertEqual(body["title"], "Salary Statement From 01-04-2026 To 30-04-2026")
        self.assertEqual(
            body["period"],
            {
                "label": "April 2026",
                "start": "2026-04-01",
                "end": "2026-04-30",
                "month": 4,
                "year": 2026,
                "days": 30,
                "cycle": None,
                "cycleLabel": None,
                "fromLabel": "01-04-2026",
                "toLabel": "30-04-2026",
            },
        )
        self.assertEqual(body["counts"], {"employees": 6, "departments": 2, "paid": 0, "pending": 6})
        self.assertTrue(body["generatedAt"])

    def test_the_notes_say_how_the_columns_are_worked_out_and_that_tds_is_not_tracked(self):
        notes = " ".join(self.statement()["notes"])
        self.assertIn("Basic + PTRL + Others Allow = Total", notes)
        self.assertIn("TDS is not tracked by the HRMS and is always 0", notes)
        self.assertIn("NET = E salary - Total Deduction", notes)
        self.assertIn("Lop& PSAmt = Total - E salary", notes)

    def test_status_department_and_employee_filters(self):
        Payroll.objects.filter(pk=self.w.payrolls["2316"].pk).update(status="paid")
        paid = self.statement("&status=paid")
        self.assertEqual(list(self.rows(paid)), ["2316"])
        self.assertEqual(paid["counts"], {"employees": 1, "departments": 1, "paid": 1, "pending": 0})
        self.assertEqual(self.statement()["counts"]["paid"], 1)
        admin_only = self.statement(f"&departmentId={self.w.admin.id}")
        self.assertEqual([g["label"] for g in admin_only["groups"]], ["Admin"])
        self.assertEqual(admin_only["total"]["values"]["total"], 182000.0)
        one = self.statement(f"&employeeId={self.w.payrolls['226'].employee_id}")
        self.assertEqual(list(self.rows(one)), ["226"])
        self.assertEqual(self.statement("&status=pending")["counts"]["employees"], 5)

    def test_a_payroll_without_a_slip_still_has_a_row_and_the_statement_says_so(self):
        SalarySlip.objects.filter(employee_id=self.w.payrolls["189"].employee_id).delete()
        body = self.statement()
        row = self.rows(body)["189"]
        self.assertEqual(
            (row["total"], row["eSalary"], row["net"], row["totalDays"]), (50000.0, 50000.0, 50000.0, 26.0)
        )
        self.assertTrue(any("1 payroll(s) have no stored day-by-day breakdown" in n for n in body["notes"]))

    def test_a_saved_net_that_differs_from_e_salary_minus_deductions_is_noted(self):
        Payroll.objects.filter(pk=self.w.payrolls["189"].pk).update(final_salary=Decimal("49000.00"))
        body = self.statement()
        self.assertEqual(self.rows(body)["189"]["net"], 49000.0)  # NET is always the saved payroll figure
        self.assertTrue(any("For 1 payroll(s) NET is the saved payroll figure" in n for n in body["notes"]))

    def test_departments_with_the_same_name_in_two_branches_are_told_apart(self):
        other = Branch.objects.create(name="Unit 2")
        twin = Department.objects.create(name="Admin", branch=other)
        emp = _staff("2900", first="TWIN", department=twin, branch=other)
        _present(emp, APRIL_WORKING)
        _generate_staff_payroll(emp, APRIL, YEAR)
        labels = [g["label"] for g in self.statement()["groups"]]
        self.assertEqual(labels, ["Accounts", "Admin (No branch)", "Admin (Unit 2)"])

    def test_employees_with_no_department_come_last(self):
        emp = _staff("0001", first="NODEPT")
        _present(emp, APRIL_WORKING)
        _generate_staff_payroll(emp, APRIL, YEAR)
        body = self.statement()
        self.assertEqual([g["label"] for g in body["groups"]], ["Accounts", "Admin", "No department"])
        self.assertEqual(body["groups"][-1]["key"], "none")
        self.assertEqual([r["sno"] for g in body["groups"] for r in g["rows"]], [1, 2, 3, 4, 5, 6, 7])

    def test_a_month_with_no_payroll_is_an_empty_statement(self):
        body = _get(self, "/api/payroll/salary-statement?month=5&year=2026")
        self.assertEqual((body["groups"], body["counts"]["employees"], body["total"]["values"]["net"]), ([], 0, 0.0))

    def test_bad_requests_are_400(self):
        for qs in ("", "month=4", "month=0&year=2026", f"{APRIL_QS}&status=x"):
            _get(self, f"/api/payroll/salary-statement?{qs}", expect=400)


class ProductionStatementTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = production_world()

    def statement(self, extra=""):
        return _get(self, f"/api/payroll/production/salary-statement?{PROD_QS}{extra}")

    def rows(self, body=None):
        body = body or self.statement()
        return {r["values"]["code"]: r["values"] for g in body["groups"] for r in g["rows"]}

    def test_the_columns_are_the_production_ones(self):
        columns = self.statement()["columns"]
        self.assertEqual(
            [(c["key"], c["label"]) for c in columns],
            [
                ("sno", "SNO"), ("code", "ID NO"), ("name", "Name"), ("designation", "Designation"),
                ("rate", "Rate / shift"), ("worked", "Days worked"), ("absent", "Absent"), ("late", "Late"),
                ("shifts", "Shifts"), ("eSalary", "E salary"), ("tAdvance", "T.Advance"), ("advance", "Advance"),
                ("esi", "ESI / EF"), ("pf", "PF"), ("others", "Others"), ("totalDeduction", "Total Deduction"),
                ("net", "NET"), ("remarks", "Remarks"),
            ],
        )  # fmt: skip
        by_key = {c["key"]: c for c in columns}
        self.assertFalse(by_key["rate"]["total"])  # a rate is not summed
        self.assertEqual((by_key["late"]["format"], by_key["late"]["total"]), ("int", True))
        self.assertEqual(
            (by_key["worked"]["format"], by_key["shifts"]["format"], by_key["rate"]["format"]),
            ("days", "days", "money"),
        )

    def test_the_rows_carry_the_periods_shifts_and_deductions(self):
        rows = self.rows()
        raja, lakshmi = rows["P100"], rows["P200"]
        self.assertEqual(
            raja,
            {
                "sno": 1,
                "code": "P100",
                "name": "Raja Prod",
                "designation": "",
                "rate": 500.0,
                "worked": 6.0,
                "absent": 1.0,
                "late": 2,
                "shifts": 6.0,
                "eSalary": 3000.0,
                "tAdvance": 0.0,
                "advance": 0.0,
                "esi": 0.0,
                "pf": 0.0,
                "others": 250.0,
                "totalDeduction": 250.0,
                "net": 2750.0,
                "remarks": "",
            },
        )
        self.assertEqual(
            (lakshmi["worked"], lakshmi["absent"], lakshmi["shifts"], lakshmi["eSalary"], lakshmi["net"]),
            (0.0, 7.0, 0.0, 0.0, 0.0),
        )
        self.assertAlmostEqual(raja["eSalary"] - raja["totalDeduction"], raja["net"])

    def test_bands_subtotals_the_grand_total_and_the_header(self):
        body = self.statement()
        self.assertEqual(
            [(g["label"], [r["values"]["code"] for r in g["rows"]]) for g in body["groups"]],
            [("Weaving", ["P100"]), ("No department", ["P200"])],
        )
        total = body["total"]["values"]
        self.assertEqual(
            (
                total["rate"],
                total["worked"],
                total["absent"],
                total["late"],
                total["shifts"],
                total["eSalary"],
                total["others"],
                total["net"],
            ),
            (None, 6.0, 8.0, 2, 6.0, 3000.0, 250.0, 2750.0),
        )
        self.assertEqual(body["title"], "Production Salary Statement From 02-02-2026 To 08-02-2026")
        self.assertEqual((body["kind"], body["company"]["branchLabel"]), ("production", None))
        self.assertEqual(body["period"]["label"], "2 Feb - 8 Feb 2026")
        self.assertEqual(
            (body["period"]["fromLabel"], body["period"]["toLabel"], body["period"]["cycle"]),
            ("02-02-2026", "08-02-2026", "weekly"),
        )
        self.assertEqual(body["counts"], {"employees": 2, "departments": 2, "paid": 0, "pending": 2})
        self.assertTrue(any("ESI / EF" in n for n in body["notes"]))

    def test_filters(self):
        Payroll.objects.filter(pk=self.w.raja_payroll.pk).update(status="paid")
        self.assertEqual(list(self.rows(self.statement("&status=paid"))), ["P100"])
        self.assertEqual(list(self.rows(self.statement(f"&departmentId={self.w.dept.id}"))), ["P100"])

    def test_the_remarks_mark_a_worker_who_joined_in_the_period(self):
        Employee.objects.filter(pk=self.w.raja.pk).update(join_date="2026-02-04")
        self.assertEqual(self.rows()["P100"]["remarks"], "JOINED 04-02")
        Employee.objects.filter(pk=self.w.raja.pk).update(status="inactive")
        self.assertEqual(self.rows()["P100"]["remarks"], "JOINED 04-02, LEFT")


# ─────────────────────────────────────────────────────────────────────────────
#  Access, kinds and branches
# ─────────────────────────────────────────────────────────────────────────────


class AccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = staff_world()
        cls.prod = production_world()

    def staff_urls(self):
        return [
            f"/api/payroll/issues?{STAFF_QS}",
            f"/api/payroll/rules?{STAFF_QS}",
            f"/api/payroll/salary-statement?{STAFF_QS}",
            f"/api/payroll/{self.staff.meena_payroll.id}/details",
        ]

    def production_urls(self):
        return [
            f"/api/payroll/production/issues?{PROD_QS}",
            f"/api/payroll/production/rules?{PROD_QS}",
            f"/api/payroll/production/salary-statement?{PROD_QS}",
            f"/api/payroll/production/{self.prod.raja_payroll.id}/details",
        ]

    def refused(self, urls, headers):
        for url in urls:
            body = _get(self, url, headers, expect=403).json()
            self.assertEqual(body["error"], "permission_denied", url)

    def test_a_production_only_role_reaches_only_the_production_endpoints(self):
        headers = _login("production_only", {"production_payroll": "view"})
        self.refused(self.staff_urls(), headers)
        for url in self.production_urls():
            _get(self, url, headers)

    def test_a_staff_payroll_only_role_reaches_only_the_staff_endpoints(self):
        headers = _login("staff_only", {"payroll": "view"})
        self.refused(self.production_urls(), headers)
        for url in self.staff_urls():
            _get(self, url, headers)

    def test_a_view_only_role_can_read_everything_it_has_access_to(self):
        headers = _login("both_view", {"payroll": "view", "production_payroll": "view"})
        for url in [*self.staff_urls(), *self.production_urls()]:
            _get(self, url, headers)

    def test_a_role_without_the_module_or_with_it_hidden_is_refused(self):
        self.refused([*self.staff_urls(), *self.production_urls()], _login("nothing", {"attendance": "edit"}))
        self.refused(self.staff_urls(), _login("hidden", {"payroll": "hidden"}))

    def test_anonymous_and_employee_tokens_are_refused(self):
        for url in [*self.staff_urls(), *self.production_urls()]:
            self.assertEqual(self.client.get(url).status_code, 401, url)
            employee = {
                "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.staff.meena.id})}"
            }
            self.assertEqual(self.client.get(url, **employee).status_code, 403, url)

    def test_each_kind_is_a_404_on_the_other_kinds_details_endpoint_even_for_an_administrator(self):
        _get(self, f"/api/payroll/{self.prod.raja_payroll.id}/details", expect=404)
        _get(self, f"/api/payroll/production/{self.staff.meena_payroll.id}/details", expect=404)

    def test_a_branch_scoped_login_sees_only_its_own_branch_everywhere(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        n, s = _staff("BR_N", first="Nia", branch=north), _staff("BR_S", first="Sam", branch=south)
        for emp in (n, s):
            _present(emp, WORKING)
        n_pay, s_pay = (_generate_staff_payroll(e, MONTH, YEAR)["payroll"] for e in (n, s))
        pn = _production("BR_PN", first="Pia", production_pay_cycle="weekly", branch=north)
        ps_ = _production("BR_PS", first="Pat", production_pay_cycle="weekly", branch=south)
        for emp in (pn, ps_):
            _day(emp, START, shifts="1.00")
        pn_pay, ps_pay = (_generate_production_payroll(e, START, END, pay_cycle="weekly")["payroll"] for e in (pn, ps_))
        headers = _login("north_scoped", {"payroll": "view", "production_payroll": "view"}, branch=north)

        issues = _get(self, f"/api/payroll/issues?{STAFF_QS}", headers)
        self.assertEqual({i["employeeCode"] for i in issues["issues"]}, {"BR_N"})
        self.assertEqual(issues["summary"]["employees"], 1)
        self.assertEqual(
            [e["employeeCode"] for e in _get(self, f"/api/payroll/rules?{STAFF_QS}", headers)["employees"]], ["BR_N"]
        )
        statement = _get(self, f"/api/payroll/salary-statement?{STAFF_QS}", headers)
        self.assertEqual([r["values"]["code"] for g in statement["groups"] for r in g["rows"]], ["BR_N"])
        self.assertEqual(statement["company"]["branchLabel"], "North")
        self.assertEqual(_get(self, f"/api/payroll/{n_pay.id}/details", headers)["neighbours"]["total"], 1)
        _get(self, f"/api/payroll/{s_pay.id}/details", headers, expect=404)
        # the same for production
        prod_issues = _get(self, f"/api/payroll/production/issues?{PROD_QS}", headers)
        self.assertEqual(prod_issues["summary"]["employees"], 1)
        self.assertEqual(
            [e["employeeCode"] for e in _get(self, f"/api/payroll/production/rules?{PROD_QS}", headers)["employees"]],
            ["BR_PN"],
        )
        _get(self, f"/api/payroll/production/{pn_pay.id}/details", headers)
        _get(self, f"/api/payroll/production/{ps_pay.id}/details", headers, expect=404)
        # asking for another branch narrows to nothing, never widens
        self.assertEqual(
            _get(self, f"/api/payroll/issues?{STAFF_QS}&branchId={south.id}", headers)["summary"]["employees"], 0
        )
        # an unscoped login can pick a branch, and the statement is then that branch's
        picked = _get(self, f"/api/payroll/salary-statement?{STAFF_QS}&branchId={south.id}")
        self.assertEqual([r["values"]["code"] for g in picked["groups"] for r in g["rows"]], ["BR_S"])
        self.assertEqual(picked["company"]["branchLabel"], "South")


# ─────────────────────────────────────────────────────────────────────────────
#  Read-only, and a fixed number of queries
# ─────────────────────────────────────────────────────────────────────────────


def _all_urls(staff, prod) -> list[str]:
    return [
        f"/api/payroll/{staff.meena_payroll.id}/details",
        f"/api/payroll/{staff.anand_payroll.id}/details",
        f"/api/payroll/production/{prod.raja_payroll.id}/details",
        f"/api/payroll/issues?{STAFF_QS}",
        f"/api/payroll/rules?{STAFF_QS}",
        f"/api/payroll/salary-statement?{STAFF_QS}",
        f"/api/payroll/production/issues?{PROD_QS}",
        f"/api/payroll/production/rules?{PROD_QS}",
        f"/api/payroll/production/salary-statement?{PROD_QS}",
        f"/api/payroll/issues?{STAFF_QS}&departmentId={staff.dept.id}&status=pending",
    ]


def _is_write(sql: str) -> bool:
    return re.match(r"\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b", sql, re.I) is not None


class ReadOnlyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = staff_world()
        cls.prod = production_world()
        Payroll.objects.create(  # a payroll with no slip, and an older session row
            employee=cls.staff.anand, salary_mode="monthly", month=3, year=2026, base_salary=Decimal("1"),
            gross_salary=Decimal("1"), final_salary=Decimal("1"),
        )  # fmt: skip

    def snapshot(self):
        return {
            "payroll": list(Payroll.objects.order_by("id").values()),
            "slips": [
                (s.id, s.breakdown_details, s.net_salary, s.total_deductions) for s in SalarySlip.objects.order_by("id")
            ],
            "employees": list(Employee.objects.order_by("id").values("id", "updated_at", "status", "salary_amount")),
            "day_records": list(
                AttendanceDayRecord.objects.order_by("id").values("id", "updated_at", "status", "shifts_earned")
            ),
            "advances": list(Advance.objects.order_by("id").values()),
            "settings": list(PayrollSettings.objects.values()),
        }

    def test_calling_every_endpoint_writes_nothing_and_changes_nothing(self):
        headers = _admin()  # the test's own login row is created before anything is measured
        before = self.snapshot()
        with CaptureQueriesContext(connection) as queries:
            for url in _all_urls(self.staff, self.prod):
                _get(self, url, headers)
        self.assertEqual([q["sql"][:120] for q in queries.captured_queries if _is_write(q["sql"])], [])
        self.assertEqual(self.snapshot(), before)

    def test_a_missing_settings_row_is_read_as_defaults_and_never_created(self):
        headers = _admin()
        PayrollSettings.objects.all().delete()
        with CaptureQueriesContext(connection) as queries:
            for url in _all_urls(self.staff, self.prod):
                _get(self, url, headers)
        self.assertEqual(PayrollSettings.objects.count(), 0)
        self.assertEqual([q["sql"][:120] for q in queries.captured_queries if _is_write(q["sql"])], [])

    def test_only_get_is_routed(self):
        for url in _all_urls(self.staff, self.prod):
            self.assertEqual(
                self.client.post(url, {}, content_type="application/json", **_admin()).status_code, 405, url
            )
            self.assertEqual(
                self.client.patch(url, {}, content_type="application/json", **_admin()).status_code, 405, url
            )
            self.assertEqual(self.client.delete(url, **_admin()).status_code, 405, url)


class QueryBoundTests(TestCase):
    """A statement / issues / rules page costs the same number of queries for 2 employees as for 12."""

    def build(self, n, depts, shift, branch, title):
        staff = _staff(
            f"Q{n:03d}", first=f"Emp{n:03d}", salary="24000.00", department=depts[n % len(depts)], designation=title,
            branch=branch if n % 2 else None, bank_account="123456789", bank_ifsc="X",
        )  # fmt: skip
        EmployeeShiftAssignment.objects.create(employee=staff, shift=shift, effective_from=date(2026, 1, 1))
        _present(staff, WORKING[:20], first_punch=time(9, 0), last_punch=time(18, 0))
        _day(
            staff,
            WORKING[20],
            is_late=True,
            first_punch=time(9, 40),
            last_punch=time(18, 0),
            late_reason="Morning Late-In: first punch 09:40",
        )
        _day(staff, WORKING[21], "absent", "0")
        _day(staff, WORKING[22])
        CasualLeaveRequest.objects.create(employee=staff, date=WORKING[22], status="approved")
        _day(staff, WORKING[23], "half_shift", "0.50")
        advance = Advance.objects.create(
            employee=staff, advance_type="general", amount=Decimal("3000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("3000"),
        )  # fmt: skip
        AdvanceRepayment.objects.create(advance=advance, month=MONTH, year=YEAR, amount=Decimal("500"))
        _generate_staff_payroll(staff, MONTH, YEAR)
        worker = _production(
            f"QP{n:03d}", first=f"Prod{n:03d}", production_pay_cycle="weekly", department=depts[n % len(depts)],
            branch=branch if n % 2 else None, bank_account="987654321", bank_ifsc="Y",
        )  # fmt: skip
        EmployeeShiftAssignment.objects.create(employee=worker, shift=shift, effective_from=date(2026, 1, 1))
        for offset in range(5):
            _day(worker, date(2026, 2, 2 + offset), shifts="1.00", first_punch=time(9, 30), last_punch=time(17, 30))
        _generate_production_payroll(worker, START, END, pay_cycle="weekly")

    def counts(self):
        urls = [
            f"/api/payroll/issues?{STAFF_QS}",
            f"/api/payroll/rules?{STAFF_QS}",
            f"/api/payroll/salary-statement?{STAFF_QS}",
            f"/api/payroll/production/issues?{PROD_QS}",
            f"/api/payroll/production/rules?{PROD_QS}",
            f"/api/payroll/production/salary-statement?{PROD_QS}",
        ]
        headers = _admin()
        out = {}
        for url in urls:
            with CaptureQueriesContext(connection) as queries:
                _get(self, url, headers)
            out[url.split("?")[0]] = len(queries)
        return out

    def test_the_query_count_does_not_grow_with_the_number_of_employees(self):
        _configure(
            attendance_mode="simple", staff_payroll_rules_enabled=True, pf_rate=Decimal("12"), esi_rate=Decimal("0.75"),
            late_free_allowance=0, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}],
            prod_late_detection_enabled=True, prod_late_free_allowance=0,
            prod_late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.5}], prod_cycles=CYCLES,
        )  # fmt: skip
        depts = [Department.objects.create(name=name) for name in ("Cutting", "Sewing", "Packing")]
        title = Designation.objects.create(title="Operator")
        shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10
        )
        branch = Branch.objects.create(name="Unit 3")
        BranchSettingsOverride.objects.create(branch=branch, overrides={"pf_rate": "9"})
        for n in range(2):
            self.build(n, depts, shift, branch, title)
        small = self.counts()
        for n in range(2, 12):
            self.build(n, depts, shift, branch, title)
        large = self.counts()
        self.assertEqual(small, large)
        self.assertEqual(Payroll.objects.filter(salary_mode="monthly").count(), 12)
        self.assertEqual(Payroll.objects.filter(salary_mode="shift").count(), 12)
        self.assertTrue(all(count < 40 for count in large.values()), large)


# ─────────────────────────────────────────────────────────────────────────────
#  Settings links and the TypeScript contract
# ─────────────────────────────────────────────────────────────────────────────

_SETTINGS_DIR = Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages" / "hr" / "settings"
_META_FILES = {
    "attendance": "AttendanceTab.meta.ts",
    "late_detection": "LateDetectionTab.meta.ts",
    "payroll": "PayrollTab.meta.ts",
    "production_payroll": "ProductionPayrollTab.meta.ts",
}


def _frontend_setting_ids() -> tuple[set, dict]:
    """(the Settings tab ids, {tab: its setting anchor ids}) read as text from the frontend's tabs.ts and *.meta.ts."""
    tabs = set(re.findall(r'(?m)^\s*id:\s*"([\w-]+)",', _read_frontend(_SETTINGS_DIR / "tabs.ts")))
    anchors = {}
    for tab, name in _META_FILES.items():
        text = _read_frontend(_SETTINGS_DIR / name)
        ids = set(re.findall(r'(?m)^\s*id:\s*"([\w-]+)"', text))
        # the per-cycle blocks are declared once, as `${cycle}-late-slabs`
        for suffix in re.findall(r"(?m)^\s*id:\s*`\$\{cycle\}-([\w-]+)`", text):
            ids |= {f"{cycle}-{suffix}" for cycle in ("weekly", "biweekly", "monthly")}
        anchors[tab] = ids
    return tabs, anchors


def _check_path(test, path, tabs, anchors):
    test.assertRegex(path, r"^/hr/settings\?tab=[\w-]+#[\w-]+$")
    parsed = urlparse(path)
    tab = parsed.query.removeprefix("tab=")
    test.assertIn(tab, tabs, path)
    test.assertIn(parsed.fragment, anchors.get(tab, set()), f"{path}: no setting with that id on the {tab} tab")


class SettingsLinkTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = staff_world()
        cls.prod = production_world()

    def setUp(self):
        if not _SETTINGS_DIR.exists():
            self.skipTest("the frontend sources are not next to the backend")

    def test_every_setting_link_this_package_can_emit_points_at_a_setting_that_exists(self):
        tabs, anchors = _frontend_setting_ids()
        self.assertIn("production_payroll", tabs)
        self.assertIn("weekly-late-slabs", anchors["production_payroll"])
        refs = all_setting_refs()
        self.assertGreater(len(refs), 30)
        for ref in refs:
            _check_path(self, ref.path, tabs, anchors)

    def test_every_link_in_a_real_response_does_too(self):
        tabs, anchors = _frontend_setting_ids()
        found = set()
        for url in _all_urls(self.staff, self.prod):
            found |= _settings_paths(_get(self, url))
        self.assertGreater(len(found), 20)
        for path in found:
            _check_path(self, path, tabs, anchors)


class ContractTests(TestCase):
    """Every response matches the TypeScript types the screens are written against: no missing or undeclared key, the right
    primitive types, and only the values a literal union allows."""

    @classmethod
    def setUpTestData(cls):
        cls.staff = staff_world()
        cls.prod = production_world()
        cls.noslip = Payroll.objects.create(
            employee=cls.staff.anand, salary_mode="monthly", month=3, year=2026, total_working_days=26,
            present_days=Decimal("20"), absent_days=Decimal("6"), base_salary=Decimal("30000"),
            gross_salary=Decimal("23000"), final_salary=Decimal("23000"),
        )  # fmt: skip
        cls.legacy = Payroll.objects.create(
            employee=cls.prod.raja, salary_mode="session", month=1, year=2026, base_salary=Decimal("4000"),
            gross_salary=Decimal("4000"), deductions=Decimal("100"), final_salary=Decimal("3900"),
        )  # fmt: skip

    def setUp(self):
        if not (_TS_FILES / "payroll-insights.ts").exists():
            self.skipTest("the frontend sources are not next to the backend")
        self.contract = _TsContract()

    def check(self, url, type_name):
        problems = self.contract.errors(_get(self, url), ("ref", type_name))
        self.assertEqual(problems, [], f"{url}: {problems[:8]}")

    def test_details(self):
        self.check(f"/api/payroll/{self.staff.meena_payroll.id}/details", "PayrollDetails")
        self.check(f"/api/payroll/{self.staff.anand_payroll.id}/details", "PayrollDetails")
        self.check(f"/api/payroll/{self.noslip.id}/details", "PayrollDetails")
        self.check(f"/api/payroll/production/{self.prod.raja_payroll.id}/details", "PayrollDetails")
        self.check(f"/api/payroll/production/{self.prod.lakshmi_payroll.id}/details", "PayrollDetails")
        self.check(f"/api/payroll/production/{self.legacy.id}/details", "PayrollDetails")

    def test_issues(self):
        self.check(f"/api/payroll/issues?{STAFF_QS}", "PayrollIssuesResponse")
        self.check(f"/api/payroll/production/issues?{PROD_QS}", "PayrollIssuesResponse")
        self.check("/api/payroll/issues?month=3&year=2026", "PayrollIssuesResponse")

    def test_rules(self):
        self.check(f"/api/payroll/rules?{STAFF_QS}", "PayrollRulesResponse")
        self.check(f"/api/payroll/production/rules?{PROD_QS}", "PayrollRulesResponse")

    def test_the_salary_statement(self):
        self.check(f"/api/payroll/salary-statement?{STAFF_QS}", "SalaryStatement")
        self.check(f"/api/payroll/production/salary-statement?{PROD_QS}", "SalaryStatement")

    def test_the_checker_catches_a_drifted_response(self):
        body = _get(self, f"/api/payroll/issues?{STAFF_QS}")
        body["issues"][0]["severity"] = "urgent"  # not in the union
        del body["summary"]["total"]
        body["surprise"] = 1
        problems = " ".join(self.contract.errors(body, ("ref", "PayrollIssuesResponse")))
        self.assertIn("'urgent'", problems)
        self.assertIn("missing required key 'total'", problems)
        self.assertIn("does not declare 'surprise'", problems)
