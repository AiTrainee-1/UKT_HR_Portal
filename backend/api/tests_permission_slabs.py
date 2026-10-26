"""Permission Deduction Slabs (staff only, company-wide, behind a switch that is OFF by default).

What is pinned here:

* OFF reproduces the pre-slabs numbers exactly: the one shared formula (attendance_final.late_pool_summary) is compared
  with a verbatim copy of the old formula over a grid of inputs, then the old scenario matrix is run through the REAL
  payroll engine against a hand-computed table;
* ON: excess permissions leave the late pool and are priced by their own free allowance + slabs (excess 0 / 1 / 3 / 7
  against free allowance 0 / 2, boundaries exactly at fromPermissions), and a late day that carries an excess permission
  on the same edge is ONE incident, counted once in the late pool;
* the settings API (validation matrix, 403 company_wide_rule for branch logins, permission groups, defaults for every
  login) and the rolling-deploy schema (every new column has a database default);
* every caller agrees: the payslip (breakdown + totals + net), the monthly shift summary, the employee shift-stats
  preview, the reports and the payroll insights show the same numbers.

Calendar: February 2026 (24 Mon-Sat working days, Sundays 1 / 8 / 15 / 22): a salary of 24,000 has a daily rate of exactly
1,000, so a 0.25 shift costs 250. Payrolls are built with the REAL engine from manual AttendanceDayRecord rows (authoritative),
the way tests_payroll_insights.py does.

Run via: python manage.py test api.tests_permission_slabs -v 2
"""

import json
from datetime import date, time
from decimal import Decimal
from itertools import product
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TestCase

from .attendance_final import late_pool_summary
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Branch,
    BranchSettingsOverride,
    AttendanceLog,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    MonthlyShiftSummary,
    PayrollSettings,
    Role,
    SalarySlip,
    ShiftTemplate,
)
from .payroll_views import (
    PERMISSION_SLABS_NEEDED,
    _build_working_days,
    _generate_production_payroll,
    _generate_staff_payroll,
    clean_permission_slabs,
    late_pool_pricing,
    late_shift_deduction,
    permission_shift_deduction,
)
from .shift_engine import compute_monthly_shift_summary

_FROZEN_TODAY = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN_TODAY.start()


def tearDownModule():
    _FROZEN_TODAY.stop()


MONTH, YEAR = 2, 2026
WORKING = _build_working_days(MONTH, YEAR, False, set())  # 24 Mon-Sat days: 2 Feb ... 28 Feb
SUNDAY = date(2026, 2, 8)
MORNING = EmployeePermission.TYPE_MORNING_LATE_IN
EVENING = EmployeePermission.TYPE_EVENING_EARLY_OUT
MIDDLE = EmployeePermission.TYPE_MIDDLE_PERMISSION
SETTINGS = "/api/payroll-settings"

# A permission slab table used by the worked examples: 1 billable permission = 0.25 shift, 3 = 0.5, 6 = a whole shift.
SLABS = [
    {"fromPermissions": 1, "deductionShifts": 0.25},
    {"fromPermissions": 3, "deductionShifts": 0.5},
    {"fromPermissions": 6, "deductionShifts": 1.0},
]
FLAT_HALF = [{"fromPermissions": 1, "deductionShifts": 0.5}]


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _headers(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _admin() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="slab_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return _headers(user)


def _login(name: str, permissions: dict, branch=None) -> dict:
    role = Role.objects.create(name=f"role_{name}", permissions=permissions)
    user = HRUser.objects.create(username=f"user_{name}", password_hash="x", role=role, branch=branch)
    return _headers(user)


def _employee_token(emp) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _settings(**fields) -> PayrollSettings:
    ps = PayrollSettings.get()
    for key, value in fields.items():
        setattr(ps, key, value)
    ps.save()
    return ps


def _on(free=0, slabs=None, **fields) -> PayrollSettings:
    """Permission Deduction Slabs switched ON with a free allowance and a slab table (everything else as shipped)."""
    return _settings(
        permission_pricing_enabled=True,
        permission_free_allowance=free,
        permission_deduction_slabs=SLABS if slabs is None else slabs,
        **fields,
    )


def _staff(code, salary="24000.00", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        salary_type="monthly",
        salary_amount=Decimal(salary),
        **kw,
    )


def _month_days(month: int) -> list:
    return _build_working_days(month, YEAR, False, set())


def _scenario(
    emp,
    *,
    late=0,
    early=0,
    same_in=0,
    same_out=0,
    perms=0,
    perm_kind=MIDDLE,
    month=MONTH,
    extra_records=(),
):
    """One month of manual attendance for `emp` (every working day present), flagged as the pool counts it:

    late          that many plain Morning Late-In days (no permission);
    early         that many plain Evening Early-Out days;
    same_in       days that are late AND carry an approved EXCESS Morning Late-In permission on the same edge (the
                  permission row is created too, so it counts toward the approved total);
    same_out      the same for the Evening Early-Out edge;
    perms         approved permissions of `perm_kind` on days that are NOT flagged (the default Middle One-Hour never
                  shifts a boundary), so they are pure approved-permission count;
    extra_records ((date, kwargs), ...) additional day records (a Sunday ...).
    Flags are placed on distinct working days in this order: late, early, same_in, same_out, then the unflagged ones.
    """
    days = iter(_month_days(month))
    flagged = {}
    for _ in range(late):
        flagged[next(days)] = {"is_late": True}
    for _ in range(early):
        flagged[next(days)] = {"early_leave": True}
    for _ in range(same_in):
        flagged[next(days)] = {"is_late": True, "morning_permission_excess": True}
    for _ in range(same_out):
        flagged[next(days)] = {"early_leave": True, "evening_permission_excess": True}
    permission_days = [d for d, flags in flagged.items() if flags.get("morning_permission_excess")]
    permission_days_out = [d for d, flags in flagged.items() if flags.get("evening_permission_excess")]
    for d in permission_days:
        EmployeePermission.objects.create(employee=emp, date=d, type=MORNING, status="approved")
    for d in permission_days_out:
        EmployeePermission.objects.create(employee=emp, date=d, type=EVENING, status="approved")
    for _ in range(perms):
        EmployeePermission.objects.create(employee=emp, date=next(days), type=perm_kind, status="approved")
    for d in _month_days(month):
        AttendanceDayRecord.objects.create(
            employee=emp,
            date=d,
            status="present",
            shifts_earned=Decimal("1.00"),
            is_half_shift=False,
            source="manual",
            **flagged.get(d, {}),
        )
    for d, kw in extra_records:
        AttendanceDayRecord.objects.create(
            employee=emp,
            date=d,
            status=kw.pop("status", "present"),
            shifts_earned=Decimal("1.00"),
            source="manual",
            **kw,
        )
    return emp


def _present_month(emp, month: int) -> None:
    """Every working day of `month` present and clean (no flags)."""
    for d in _month_days(month):
        AttendanceDayRecord.objects.create(
            employee=emp, date=d, status="present", shifts_earned=Decimal("1.00"), source="manual"
        )


def _slip(emp, month=MONTH) -> SalarySlip:
    return _generate_staff_payroll(emp, month, YEAR)["slip"]


def _ded(slip) -> dict:
    return slip.breakdown_details["deductions"]


def _records(*, late=0, early=0, same_in=0, same_out=0):
    """Pool inputs without a database: `late` / `early` plain flagged days, `same_in` / `same_out` flagged days with an
    excess permission on the same edge, then a few clean days."""
    out, day = [], 0

    def make(**flags):
        nonlocal day
        day += 1
        fields = {
            "date": date(2026, 2, 1 + day),
            "status": "present",
            "is_late": False,
            "early_leave": False,
            "morning_permission_excess": False,
            "evening_permission_excess": False,
        }
        return SimpleNamespace(**{**fields, **flags})

    for _ in range(late):
        out.append(make(is_late=True))
    for _ in range(early):
        out.append(make(early_leave=True))
    for _ in range(same_in):
        out.append(make(is_late=True, morning_permission_excess=True))
    for _ in range(same_out):
        out.append(make(early_leave=True, evening_permission_excess=True))
    out.extend(make() for _ in range(3))
    return out


def _stand_in(cap=3, free=3, **permission):
    """Settings as the pool reads them, no database (the model's own defaults for everything else)."""
    ps = PayrollSettings()
    ps.permission_monthly_cap = cap
    ps.late_free_allowance = free
    for key, value in permission.items():
        setattr(ps, key, value)
    return ps


def _old_pool(records, approved, settings, counted_dates=None) -> dict:
    """A verbatim copy of attendance_final.late_pool_summary as it was BEFORE Permission Deduction Slabs: the oracle the
    OFF behaviour is compared with."""
    late_in = early_out = 0
    for r in records:
        if counted_dates is not None and r.date not in counted_dates:
            continue
        if r.status not in ("present", "half_shift"):
            continue
        if r.is_late and not r.morning_permission_excess:
            late_in += 1
        if r.early_leave and not r.evening_permission_excess:
            early_out += 1
    cap = max(0, int(getattr(settings, "permission_monthly_cap", 3) or 0))
    excess = max(0, int(approved or 0) - cap)
    total = late_in + early_out + excess
    free = max(0, int(getattr(settings, "late_free_allowance", 3) or 0))
    return {
        "late_in": late_in,
        "early_out": early_out,
        "excess_permissions": excess,
        "total": total,
        "free_used": min(total, free),
        "billable": max(0, total - free),
    }


OLD_KEYS = ("late_in", "early_out", "excess_permissions", "total", "free_used", "billable")


# ─────────────────────────────────────────────────────────────────────────────
#  The shared pool formula, no database
# ─────────────────────────────────────────────────────────────────────────────


class PoolOffTests(SimpleTestCase):
    """Switch OFF (the shipped default) is the formula as it always was."""

    def test_off_equals_the_old_formula_over_a_grid_of_inputs(self):
        checked = 0
        for late, early, same_in, same_out, approved, cap, free in product(
            (0, 1, 4), (0, 2), (0, 1, 3), (0, 2), (0, 1, 3, 4, 7, 9), (0, 3, 5), (0, 3)
        ):
            records = _records(late=late, early=early, same_in=same_in, same_out=same_out)
            # whatever sits in the permission settings while the switch is OFF never matters
            ps = _stand_in(
                cap=cap, free=free, permission_free_allowance=2, permission_deduction_slabs=SLABS
            )  # pricing stays False
            got = late_pool_summary(records, approved, ps)
            want = _old_pool(records, approved, ps)
            self.assertEqual({k: got[k] for k in OLD_KEYS}, want, (late, early, same_in, same_out, approved, cap, free))
            self.assertEqual(
                (got["permission_pricing"], got["permission_absorbed"], got["permission_pool"]), (False, 0, 0)
            )
            self.assertEqual((got["permission_free_used"], got["permission_billable"]), (0, 0))
            checked += 1
        self.assertEqual(checked, 3 * 2 * 3 * 2 * 6 * 3 * 2)

    def test_off_equals_the_old_formula_with_a_working_day_filter(self):
        records = _records(late=3, early=1, same_in=2)
        keep = {r.date for r in records[:4]}
        ps = _stand_in()
        got = late_pool_summary(records, 5, ps, counted_dates=keep)
        self.assertEqual({k: got[k] for k in OLD_KEYS}, _old_pool(records, 5, ps, keep))

    def test_hand_computed_rows_off(self):
        """(late, early, same-edge in, approved, cap 3, free 3) -> (late_in, early_out, excess, total, free used, billable)."""
        table = [
            ((0, 0, 0, 0), (0, 0, 0, 0, 0, 0)),
            ((2, 0, 0, 0), (2, 0, 0, 2, 2, 0)),
            ((6, 0, 0, 0), (6, 0, 0, 6, 3, 3)),
            ((5, 2, 0, 0), (5, 2, 0, 7, 3, 4)),
            ((0, 0, 0, 7), (0, 0, 4, 4, 3, 1)),
            ((4, 0, 0, 6), (4, 0, 3, 7, 3, 4)),
            # three late days that each carry an excess permission on the same edge are the permission, not extra marks
            ((0, 0, 3, 7), (0, 0, 4, 4, 3, 1)),
            ((9, 0, 0, 1), (9, 0, 0, 9, 3, 6)),
        ]
        for (late, early, same_in, approved), want in table:
            got = late_pool_summary(_records(late=late, early=early, same_in=same_in), approved, _stand_in())
            self.assertEqual(tuple(got[k] for k in OLD_KEYS), want, (late, early, same_in, approved))

    def test_off_prices_only_the_late_pool(self):
        pool = late_pool_summary(_records(late=6), 7, _stand_in(permission_free_allowance=2))  # total 6 + 4 = 10
        pricing = late_pool_pricing(pool, PayrollSettings(), Decimal("1000"))
        self.assertEqual((pool["total"], pool["billable"]), (10, 7))
        self.assertEqual(pricing["late_shifts"], Decimal("0.5"))  # default slabs: 6 billable = 0.5 shift
        self.assertEqual((pricing["permission_shifts"], pricing["permission_penalty"]), (Decimal("0"), Decimal("0")))
        self.assertEqual((pricing["late_penalty"], pricing["penalty"]), (Decimal("500.00"), Decimal("500.00")))


class PoolOnTests(SimpleTestCase):
    """Switch ON: the excess permissions leave the pool and are priced by their own free allowance and slabs."""

    def pool(self, approved, free=0, slabs=None, cap=3, **kw):
        ps = _stand_in(
            cap=cap,
            permission_pricing_enabled=True,
            permission_free_allowance=free,
            permission_deduction_slabs=SLABS if slabs is None else slabs,
        )
        pool = late_pool_summary(_records(**kw), approved, ps)
        return pool, late_pool_pricing(pool, ps, Decimal("1000"))

    def test_the_worked_table_excess_against_free_allowance(self):
        """excess permissions 0 / 1 / 3 / 7 (approved = cap 3 + excess) against free allowance 0 / 2, slabs 1 -> 0.25,
        3 -> 0.5, 6 -> 1."""
        table = {
            # (excess, free): (billable permissions, shifts, penalty at a daily rate of 1,000)
            (0, 0): (0, "0", "0"),
            (0, 2): (0, "0", "0"),
            (1, 0): (1, "0.25", "250.00"),
            (1, 2): (0, "0", "0"),
            (3, 0): (3, "0.5", "500.00"),
            (3, 2): (1, "0.25", "250.00"),
            (7, 0): (7, "1", "1000.00"),  # 7 reaches the last row (6): it holds beyond itself
            (7, 2): (5, "0.5", "500.00"),
        }
        for (excess, free), (billable, shifts, penalty) in table.items():
            pool, pricing = self.pool(3 + excess, free=free)
            self.assertEqual(pool["excess_permissions"], excess, (excess, free))
            self.assertEqual(pool["permission_pool"], excess, (excess, free))
            self.assertEqual(pool["permission_billable"], billable, (excess, free))
            self.assertEqual(pool["permission_free_used"], min(excess, free), (excess, free))
            self.assertEqual(pricing["permission_shifts"], Decimal(shifts), (excess, free))
            self.assertEqual(pricing["permission_penalty"], Decimal(penalty), (excess, free))
            self.assertEqual(pool["total"], 0)  # the excess permissions are NOT in the late pool
            self.assertEqual(pricing["late_penalty"], Decimal("0"))

    def test_the_boundaries_are_exactly_at_from_permissions(self):
        ps = _stand_in(permission_pricing_enabled=True, permission_deduction_slabs=SLABS)
        for billable, shifts in ((0, "0"), (1, "0.25"), (2, "0.25"), (3, "0.5"), (5, "0.5"), (6, "1"), (31, "1")):
            self.assertEqual(permission_shift_deduction(billable, ps), Decimal(shifts), billable)

    def test_an_empty_table_deducts_nothing_and_the_slab_hook_never_changes_stored_settings(self):
        ps = _stand_in(permission_pricing_enabled=True, permission_deduction_slabs=[])
        self.assertEqual(permission_shift_deduction(9, ps), Decimal("0"))
        ps.permission_deduction_slabs = [dict(r) for r in SLABS]
        permission_shift_deduction(9, ps)
        self.assertEqual(ps.permission_deduction_slabs, SLABS)  # fromPermissions was mapped for the call only
        self.assertTrue(all("fromLates" not in row for row in ps.permission_deduction_slabs))

    def test_the_late_slabs_and_the_permission_slabs_are_independent(self):
        ps = _stand_in(permission_pricing_enabled=True, permission_deduction_slabs=FLAT_HALF)
        self.assertEqual(late_shift_deduction(3, ps), Decimal("0.25"))  # the late table (default: 3 billable = 0.25)
        self.assertEqual(permission_shift_deduction(3, ps), Decimal("0.5"))  # its own table

    def test_a_late_day_with_an_excess_permission_on_the_same_edge_is_one_incident_in_the_late_pool(self):
        # 4 approved permissions (cap 3 => 1 excess); one flagged day carries it on the same edge
        pool, pricing = self.pool(4, same_in=1)
        self.assertEqual((pool["late_in"], pool["total"]), (1, 1))  # the late day is the incident, counted once
        self.assertEqual((pool["excess_permissions"], pool["permission_absorbed"], pool["permission_pool"]), (1, 1, 0))
        self.assertEqual(pricing["permission_shifts"], Decimal("0"))  # never deducted twice

    def test_a_flagged_day_on_the_other_edge_or_without_the_permission_absorbs_nothing(self):
        # the excess permission is an Evening one: a plain late-in day beside it is a different incident
        pool, _ = self.pool(4, late=1)
        self.assertEqual((pool["late_in"], pool["permission_absorbed"], pool["permission_pool"]), (1, 0, 1))

    def test_two_permissions_on_one_flagged_day_absorb_only_one(self):
        # 5 approved => 2 excess; one flagged day carries (at least) one of them: the other is priced on its own
        pool, _ = self.pool(5, same_in=1)
        self.assertEqual((pool["permission_absorbed"], pool["permission_pool"]), (1, 1))

    def test_absorption_never_exceeds_the_excess_count(self):
        # stale day records (3 flagged-excess days) against an approved count that now has only 1 excess
        pool, _ = self.pool(4, same_in=3)
        self.assertEqual(pool["permission_absorbed"], 1)
        self.assertEqual((pool["late_in"], pool["permission_pool"]), (1, 0))
        # ...and the same incidents are never counted twice: ON total + priced == OFF total
        off = late_pool_summary(_records(same_in=3), 4, _stand_in())
        self.assertEqual(pool["total"] + pool["permission_pool"], off["total"])

    def test_the_same_incidents_are_split_in_two_never_multiplied(self):
        """For every input: ON late pool + ON priced permissions == the OFF pool total."""
        for late, early, same_in, same_out, approved, cap in product(
            (0, 2), (0, 1), (0, 1, 3), (0, 2), (0, 3, 4, 7, 9), (0, 3)
        ):
            records = _records(late=late, early=early, same_in=same_in, same_out=same_out)
            off = late_pool_summary(records, approved, _stand_in(cap=cap))
            on = late_pool_summary(
                records,
                approved,
                _stand_in(cap=cap, permission_pricing_enabled=True, permission_deduction_slabs=SLABS),
            )
            ctx = (late, early, same_in, same_out, approved, cap)
            self.assertEqual(on["total"] + on["permission_pool"], off["total"], ctx)
            self.assertEqual(on["permission_absorbed"] + on["permission_pool"], on["excess_permissions"], ctx)
            self.assertLessEqual(on["permission_absorbed"], on["same_edge"], ctx)
            self.assertEqual(on["excess_permissions"], off["excess_permissions"], ctx)  # the plain fact, in both modes

    def test_the_working_day_filter_decides_what_a_flagged_day_can_absorb(self):
        records = _records(same_in=1)
        flagged = records[0].date
        ps = _stand_in(permission_pricing_enabled=True, permission_deduction_slabs=SLABS)
        inside = late_pool_summary(records, 4, ps, counted_dates={r.date for r in records})
        outside = late_pool_summary(records, 4, ps, counted_dates={r.date for r in records if r.date != flagged})
        self.assertEqual((inside["late_in"], inside["permission_pool"]), (1, 0))
        # the flagged day is not a counted day (a Sunday ...): it absorbs nothing, the permission stays priced
        self.assertEqual((outside["late_in"], outside["permission_absorbed"], outside["permission_pool"]), (0, 0, 1))
        # the excess count itself is the whole month either way (as it always was)
        self.assertEqual(inside["excess_permissions"], outside["excess_permissions"])

    def test_a_day_that_is_not_present_absorbs_nothing(self):
        records = _records(same_in=1)
        records[0].status = "absent"
        ps = _stand_in(permission_pricing_enabled=True, permission_deduction_slabs=SLABS)
        pool = late_pool_summary(records, 4, ps)
        self.assertEqual((pool["late_in"], pool["permission_absorbed"], pool["permission_pool"]), (0, 0, 1))

    def test_a_cap_of_zero_makes_every_approved_permission_excess(self):
        pool, pricing = self.pool(2, cap=0, free=1)
        self.assertEqual((pool["excess_permissions"], pool["permission_billable"]), (2, 1))
        self.assertEqual(pricing["permission_shifts"], Decimal("0.25"))

    def test_the_free_allowance_bounds_what_is_free(self):
        pool, _ = self.pool(3 + 2, free=5)
        self.assertEqual((pool["permission_free_used"], pool["permission_billable"]), (2, 0))


# ─────────────────────────────────────────────────────────────────────────────
#  The slab table cleaner
# ─────────────────────────────────────────────────────────────────────────────


class CleanSlabsTests(SimpleTestCase):
    def ok(self, rows):
        cleaned, problem = clean_permission_slabs(rows)
        self.assertIsNone(problem, rows)
        return cleaned

    def bad(self, rows):
        cleaned, problem = clean_permission_slabs(rows)
        self.assertIsNone(cleaned, rows)
        self.assertTrue(problem, rows)
        return problem

    def test_sorted_ascending_and_duplicates_removed_the_later_row_wins(self):
        cleaned = self.ok(
            [
                {"fromPermissions": 6, "deductionShifts": 1},
                {"fromPermissions": 1, "deductionShifts": 0.25},
                {"fromPermissions": 3, "deductionShifts": 0.4},
                {"fromPermissions": 3, "deductionShifts": 0.5},
            ]
        )
        self.assertEqual(
            cleaned,
            [
                {"fromPermissions": 1, "deductionShifts": 0.25},
                {"fromPermissions": 3, "deductionShifts": 0.5},
                {"fromPermissions": 6, "deductionShifts": 1.0},
            ],
        )

    def test_the_edges_are_accepted(self):
        rows = [
            {"fromPermissions": 1, "deductionShifts": 0},
            {"fromPermissions": 999, "deductionShifts": 31},
            {"fromPermissions": 2, "deductionShifts": "0.05"},
            {"fromPermissions": "3", "deductionShifts": 12.34},
            {"fromPermissions": 4.0, "deductionShifts": 1},
        ]
        self.assertEqual([r["fromPermissions"] for r in self.ok(rows)], [1, 2, 3, 4, 999])
        self.assertEqual(self.ok([])[:], [])
        self.assertEqual(len(self.ok([{"fromPermissions": n, "deductionShifts": 1} for n in range(1, 51)])), 50)

    def test_everything_else_is_refused_not_skipped(self):
        for rows in (
            None,
            "x",
            {"fromPermissions": 1, "deductionShifts": 1},
            [1],
            [None],
            ["row"],
            [{}],
            [{"fromPermissions": 1}],
            [{"deductionShifts": 1}],
            [{"fromPermissions": 0, "deductionShifts": 1}],
            [{"fromPermissions": -1, "deductionShifts": 1}],
            [{"fromPermissions": 1000, "deductionShifts": 1}],
            [{"fromPermissions": 1.5, "deductionShifts": 1}],
            [{"fromPermissions": "1.5", "deductionShifts": 1}],
            [{"fromPermissions": "x", "deductionShifts": 1}],
            [{"fromPermissions": True, "deductionShifts": 1}],
            [{"fromPermissions": None, "deductionShifts": 1}],
            [{"fromPermissions": [1], "deductionShifts": 1}],
            [{"fromPermissions": 1, "deductionShifts": -0.01}],
            [{"fromPermissions": 1, "deductionShifts": 31.01}],
            [{"fromPermissions": 1, "deductionShifts": 1.005}],
            [{"fromPermissions": 1, "deductionShifts": "x"}],
            [{"fromPermissions": 1, "deductionShifts": True}],
            [{"fromPermissions": 1, "deductionShifts": None}],
            [{"fromPermissions": 1, "deductionShifts": ""}],
            [{"fromPermissions": 1, "deductionShifts": "NaN"}],
            [{"fromPermissions": 1, "deductionShifts": float("inf")}],
            [{"fromPermissions": 1, "deductionShifts": [1]}],
            [{"fromPermissions": n, "deductionShifts": 1} for n in range(1, 52)],  # 51 rows
        ):
            self.bad(rows)


# ─────────────────────────────────────────────────────────────────────────────
#  The settings API
# ─────────────────────────────────────────────────────────────────────────────


class SettingsApiTests(TestCase):
    def setUp(self):
        self.admin = _admin()
        PayrollSettings.get()

    def put(self, body, headers=None):
        return self.client.put(SETTINGS, json.dumps(body), content_type="application/json", **(headers or self.admin))

    def row(self) -> PayrollSettings:
        return PayrollSettings.objects.get(pk=1)

    def refused(self, body, part=None):
        before = (self.row().permission_pricing_enabled, self.row().permission_free_allowance)
        r = self.put({"companyName": "Should Not Stick", **body})
        self.assertEqual(r.status_code, 400, (body, r.content))
        if part:
            self.assertIn(part, r.json()["error"], body)
        row = self.row()
        self.assertNotEqual(row.company_name, "Should Not Stick", body)  # nothing of the request was saved
        self.assertEqual((row.permission_pricing_enabled, row.permission_free_allowance), before, body)

    # ── defaults and the response ──
    def test_the_defaults_are_off_zero_and_empty_for_every_login(self):
        branch = Branch.objects.create(name="Defaults Unit")
        for headers in (self.admin, _login("late_ed", {"settings.late_detection": "edit"}, branch)):
            body = self.client.get(SETTINGS, **headers).json()
            self.assertIs(body["permissionPricingEnabled"], False)
            self.assertEqual(body["permissionFreeAllowance"], 0)
            self.assertEqual(body["permissionDeductionSlabs"], [])
            self.assertEqual(
                (body["prodBonusPercent"], body["prodBonusWageCeiling"], body["prodBonusEligibilityCeiling"]),
                (8.33, 7000.0, 21000.0),
            )

    def test_the_new_keys_round_trip(self):
        r = self.put(
            {
                "permissionPricingEnabled": True,
                "permissionFreeAllowance": 2,
                "permissionDeductionSlabs": [
                    {"fromPermissions": 3, "deductionShifts": 0.5},
                    {"fromPermissions": 1, "deductionShifts": 0.25},
                ],
            }
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIs(body["permissionPricingEnabled"], True)
        self.assertEqual(body["permissionFreeAllowance"], 2)
        self.assertEqual(
            body["permissionDeductionSlabs"],
            [{"fromPermissions": 1, "deductionShifts": 0.25}, {"fromPermissions": 3, "deductionShifts": 0.5}],
        )
        row = self.row()
        self.assertEqual((row.permission_pricing_enabled, row.permission_free_allowance), (True, 2))
        self.assertEqual(row.permission_deduction_slabs, body["permissionDeductionSlabs"])
        self.assertEqual(
            self.client.get(SETTINGS, **self.admin).json()["permissionDeductionSlabs"], row.permission_deduction_slabs
        )

    # ── the switch ──
    def test_the_switch_needs_at_least_one_slab(self):
        r = self.put({"permissionPricingEnabled": True})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "Add at least one permission slab before turning this on.")
        self.assertEqual(r.json()["error"], PERMISSION_SLABS_NEEDED)
        self.assertFalse(self.row().permission_pricing_enabled)
        # ...also with an explicitly empty table in the same request
        self.refused({"permissionPricingEnabled": True, "permissionDeductionSlabs": []}, "at least one permission slab")
        # a table first, then the switch: fine
        self.assertEqual(self.put({"permissionDeductionSlabs": SLABS}).status_code, 200)
        self.assertEqual(self.put({"permissionPricingEnabled": True}).status_code, 200)
        self.assertTrue(self.row().permission_pricing_enabled)
        # the switch is ON, so the table cannot be emptied
        self.refused({"permissionDeductionSlabs": []}, "at least one permission slab")
        self.assertEqual(len(self.row().permission_deduction_slabs), 3)
        # OFF with an empty table is fine, and so is saving unrelated settings while ON
        self.assertEqual(self.put({"permissionPricingEnabled": False, "permissionDeductionSlabs": []}).status_code, 200)
        self.assertEqual(self.put({"payDay": 6}).status_code, 200)

    def test_the_switch_must_be_a_real_boolean(self):
        self.put({"permissionDeductionSlabs": SLABS})
        for value in ("yes", "true", "false", 1, 0, None, [], {}):
            self.refused({"permissionPricingEnabled": value}, "true (on) or false (off)")
        self.assertEqual(self.put({"permissionPricingEnabled": True}).status_code, 200)
        self.assertEqual(self.put({"permissionPricingEnabled": False}).status_code, 200)

    # ── the free allowance ──
    def test_the_free_allowance_is_zero_to_999_whole(self):
        for value in (0, 1, 999, "5", 7.0):
            r = self.put({"permissionFreeAllowance": value})
            self.assertEqual(r.status_code, 200, (value, r.content))
        for value in (-1, 1000, 2.5, "x", True, None, [], {}, "1e3", "5.5"):
            self.refused({"permissionFreeAllowance": value})

    # ── the slab table ──
    def test_a_bad_table_is_a_400_and_never_a_500(self):
        for rows in (
            "x",
            None,
            {"fromPermissions": 1},
            [1],
            [{"fromPermissions": 0, "deductionShifts": 1}],
            [{"fromPermissions": 1000, "deductionShifts": 1}],
            [{"fromPermissions": 1.5, "deductionShifts": 1}],
            [{"fromPermissions": 1, "deductionShifts": -1}],
            [{"fromPermissions": 1, "deductionShifts": 32}],
            [{"fromPermissions": 1, "deductionShifts": 0.123}],
            [{"fromPermissions": 1, "deductionShifts": "x"}],
            [{"fromPermissions": 1}],
            [{"fromPermissions": n, "deductionShifts": 1} for n in range(1, 52)],
        ):
            self.refused({"permissionDeductionSlabs": rows})

    def test_the_table_is_stored_sorted_with_duplicates_removed_and_at_most_50_rows(self):
        rows = [{"fromPermissions": n, "deductionShifts": 0.5} for n in range(49, 0, -1)]
        rows.append({"fromPermissions": 7, "deductionShifts": 2})  # a duplicate threshold: the later row wins
        self.assertEqual(len(rows), 50)  # the limit is on the rows sent
        self.assertEqual(self.put({"permissionDeductionSlabs": rows}).status_code, 200)
        stored = self.row().permission_deduction_slabs
        self.assertEqual([r["fromPermissions"] for r in stored], list(range(1, 50)))
        self.assertEqual(next(r for r in stored if r["fromPermissions"] == 7)["deductionShifts"], 2.0)

    def test_the_prod_bonus_keys_use_the_staff_bonus_ranges(self):
        for key, attr in (
            ("prodBonusPercent", "prod_bonus_percent"),
            ("prodBonusWageCeiling", "prod_bonus_wage_ceiling"),
            ("prodBonusEligibilityCeiling", "prod_bonus_eligibility_ceiling"),
        ):
            staff_key = key.replace("prodBonus", "bonus")
            staff_key = staff_key[0].lower() + staff_key[1:]
            for value in (0, 8.33, 12.5, 20, 100) if "Percent" in key else (0, 7000, 99999999.99):
                self.assertEqual(self.put({key: value}).status_code, 200, (key, value))
                self.assertEqual(getattr(self.row(), attr), Decimal(str(value)).quantize(Decimal("0.01")))
            bad = (-1, 100.01, 1000, "x", True, None, "NaN") if "Percent" in key else (-1, 1e11, "x", True, None, "NaN")
            for value in bad:
                r = self.put({"companyName": "Should Not Stick", key: value})
                self.assertEqual(r.status_code, 400, (key, value, r.content))
                # the very same refusal the staff key gives for the same value
                r2 = self.put({"companyName": "Should Not Stick", staff_key: value})
                self.assertEqual(r2.status_code, 400, (staff_key, value))
            self.assertNotEqual(self.row().company_name, "Should Not Stick")

    # ── company-wide ──
    def test_a_branch_login_gets_403_company_wide_rule_for_every_permission_key(self):
        branch = Branch.objects.create(name="Guard Unit")
        headers = _login("guard", {"settings.late_detection": "edit", "settings.production_payroll": "edit"}, branch)
        for body in (
            {"permissionPricingEnabled": True},
            {"permissionPricingEnabled": False},
            {"permissionFreeAllowance": 3},
            {"permissionDeductionSlabs": SLABS},
            {"permissionDeductionSlabs": []},
            {"permissionPricingEnabled": True, "permissionFreeAllowance": 1, "permissionDeductionSlabs": SLABS},
        ):
            r = self.put(body, headers)
            self.assertEqual(r.status_code, 403, body)
            self.assertEqual(r.json()["error"], "company_wide_rule", body)
            self.assertEqual(set(r.json()["fields"]), set(body), body)
        row = self.row()
        self.assertEqual((row.permission_pricing_enabled, row.permission_free_allowance), (False, 0))
        self.assertEqual(row.permission_deduction_slabs, [])
        self.assertFalse(
            BranchSettingsOverride.objects.filter(branch=branch).exists()
            and BranchSettingsOverride.objects.get(branch=branch).overrides
        )

    def test_a_stray_branch_value_is_never_shown_or_applied(self):
        branch = Branch.objects.create(name="Stray Unit")
        BranchSettingsOverride.objects.create(
            branch=branch,
            overrides={
                "permission_pricing_enabled": True,
                "permission_free_allowance": 9,
                "permission_deduction_slabs": SLABS,
            },
        )
        headers = _login("stray", {"settings.late_detection": "edit"}, branch)
        body = self.client.get(SETTINGS, **headers).json()
        self.assertEqual(
            (body["permissionPricingEnabled"], body["permissionFreeAllowance"], body["permissionDeductionSlabs"]),
            (False, 0, []),
        )

    def test_a_branch_login_can_still_edit_the_production_bonus(self):
        branch = Branch.objects.create(name="Bonus Unit")
        headers = _login("bonus_branch", {"settings.production_payroll": "edit"}, branch)
        r = self.put({"prodBonusPercent": 11.5}, headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["prodBonusPercent"], 11.5)
        self.assertEqual(self.row().prod_bonus_percent, Decimal("8.33"))  # the company row is untouched
        self.assertEqual(BranchSettingsOverride.objects.get(branch=branch).overrides, {"prod_bonus_percent": "11.5"})

    # ── permission groups ──
    def test_the_permission_keys_need_the_late_detection_group_and_the_bonus_keys_the_production_one(self):
        only_payroll = _login("only_payroll", {"settings.payroll": "edit"})
        for body in (
            {"permissionPricingEnabled": False},
            {"permissionFreeAllowance": 1},
            {"permissionDeductionSlabs": SLABS},
            {"prodBonusPercent": 9},
            {"prodBonusWageCeiling": 8000},
            {"prodBonusEligibilityCeiling": 22000},
        ):
            r = self.put(body, only_payroll)
            self.assertEqual(r.status_code, 403, body)
            self.assertEqual(r.json()["error"], "permission_denied", body)
        late_only = _login("late_only", {"settings.late_detection": "edit"})
        self.assertEqual(self.put({"permissionFreeAllowance": 4}, late_only).status_code, 200)
        self.assertEqual(self.put({"prodBonusPercent": 9}, late_only).status_code, 403)
        prod_only = _login("prod_only", {"settings.production_payroll": "edit"})
        self.assertEqual(self.put({"prodBonusPercent": 9}, prod_only).status_code, 200)
        self.assertEqual(self.put({"permissionFreeAllowance": 5}, prod_only).status_code, 403)
        self.assertEqual(self.row().permission_free_allowance, 4)

    def test_the_retired_staff_bonus_keys_keep_working(self):
        # staff bonus stays on the Payroll group and is independent of the production one
        self.assertEqual(self.put({"bonusPercent": 10}).status_code, 200)
        row = self.row()
        self.assertEqual((row.bonus_percent, row.prod_bonus_percent), (Decimal("10.00"), Decimal("8.33")))


# ─────────────────────────────────────────────────────────────────────────────
#  Rolling deploy: the schema
# ─────────────────────────────────────────────────────────────────────────────


class RollingDeploySchemaTests(TestCase):
    """An older backend instance (still running during a rolling deploy, or after a rollback) does not know these columns:
    it must keep inserting payroll_settings rows, so the database itself has to supply a default for each."""

    COLUMNS = (
        "permission_pricing_enabled",
        "permission_free_allowance",
        "permission_deduction_slabs",
        "prod_bonus_percent",
        "prod_bonus_wage_ceiling",
        "prod_bonus_eligibility_ceiling",
    )

    def test_every_new_column_has_a_database_default(self):
        with connection.cursor() as cur:
            cur.execute(
                "select column_name, column_default from information_schema.columns "
                "where table_schema = current_schema() and table_name = 'payroll_settings'"
            )
            defaults = dict(cur.fetchall())
        for name in self.COLUMNS:
            self.assertIn(name, defaults, name)
            self.assertIsNotNone(defaults[name], f"payroll_settings.{name} needs a database default")

    def test_nothing_was_renamed_or_dropped(self):
        with connection.cursor() as cur:
            cur.execute(
                "select column_name from information_schema.columns "
                "where table_schema = current_schema() and table_name = 'payroll_settings'"
            )
            columns = {c for (c,) in cur.fetchall()}
        for name in (
            "bonus_percent",
            "bonus_wage_ceiling",
            "bonus_eligibility_ceiling",
            "bonus_fy_start_month",
            "late_free_allowance",
            "late_deduction_slabs",
            "permission_monthly_cap",
            "prod_late_free_allowance",
            "prod_late_deduction_slabs",
            "default_salary_per_shift",
        ):
            self.assertIn(name, columns, name)


# ─────────────────────────────────────────────────────────────────────────────
#  The payslip
# ─────────────────────────────────────────────────────────────────────────────


class PayslipOffTests(TestCase):
    """Switch OFF: the old scenario matrix through the REAL payroll engine, against a hand-computed table."""

    def test_the_old_scenario_matrix(self):
        # (late, early, same-edge in, other approved permissions) -> (late_in, early_out, excess, total, free used,
        #  billable, shifts, late penalty). Cap 3, free allowance 3, the shipped slabs (3 billable = 0.25, 6 = 0.5, 9 = 0.75).
        table = [
            ((0, 0, 0, 0), (0, 0, 0, 0, 0, 0, 0.0, 0.0)),
            ((2, 0, 0, 0), (2, 0, 0, 2, 2, 0, 0.0, 0.0)),
            ((6, 0, 0, 0), (6, 0, 0, 6, 3, 3, 0.25, 250.0)),
            ((5, 2, 0, 0), (5, 2, 0, 7, 3, 4, 0.25, 250.0)),
            ((0, 0, 0, 7), (0, 0, 4, 4, 3, 1, 0.0, 0.0)),
            ((4, 0, 0, 6), (4, 0, 3, 7, 3, 4, 0.25, 250.0)),
            ((0, 0, 3, 4), (0, 0, 4, 4, 3, 1, 0.0, 0.0)),
            ((9, 0, 0, 1), (9, 0, 0, 9, 3, 6, 0.5, 500.0)),
        ]
        # whatever is stored in the permission settings while OFF changes nothing
        _settings(permission_free_allowance=5, permission_deduction_slabs=FLAT_HALF)
        for i, ((late, early, same_in, perms), want) in enumerate(table):
            emp = _scenario(_staff(f"OFF{i}"), late=late, early=early, same_in=same_in, perms=perms)
            slip = _slip(emp)
            ded = _ded(slip)
            late_summary = ded["lateSummary"]
            got = (
                late_summary["lateInCount"],
                late_summary["earlyOutCount"],
                late_summary["excessPermissionCount"],
                late_summary["totalLateCount"],
                late_summary["freeAllowanceUsed"],
                late_summary["billableLateCount"],
                late_summary["shiftDeductions"],
                ded["lateShiftPenalty"],
            )
            self.assertEqual(got, want, (late, early, same_in, perms))
            # no permission pricing at all: the new block says so, costs nothing and the totals are the old ones
            self.assertEqual(ded["permissionPenalty"], 0.0)
            self.assertEqual(
                ded["permissionSummary"],
                {
                    "enabled": False,
                    "approved": same_in + perms,
                    "cap": 3,
                    "excess": want[2],
                    "absorbedByLate": 0,
                    "priced": 0,
                    "freeAllowance": 5,
                    "freeUsed": 0,
                    "billable": 0,
                    "shifts": 0.0,
                    "penalty": 0.0,
                },
            )
            self.assertEqual(ded["total"], want[7])
            self.assertEqual((slip.other_deductions, slip.total_deductions), (Decimal(want[7]), Decimal(want[7])))
            self.assertEqual(slip.net_salary, Decimal("24000.00") - Decimal(want[7]))

    def test_off_total_deductions_include_pf_and_the_old_late_penalty_only(self):
        emp = _scenario(_staff("OFF_PF"), late=6)
        slip = _slip(emp)
        self.assertEqual(slip.other_deductions, Decimal("250.00"))
        self.assertEqual(_ded(slip)["total"], 250.0)


class PayslipOnTests(TestCase):
    def test_excess_permissions_leave_the_pool_and_get_their_own_line(self):
        """2 plain lates + 7 approved permissions (excess 4); free allowance 2, one slab 1 -> 0.5 shift."""
        _on(free=2, slabs=FLAT_HALF)
        emp = _scenario(_staff("ON1"), late=2, perms=7)
        slip = _slip(emp)
        ded = _ded(slip)
        self.assertEqual(
            ded["lateSummary"],
            {
                "lateInCount": 2,
                "earlyOutCount": 0,
                "excessPermissionCount": 4,
                "totalLateCount": 2,  # the excess permissions are NOT in the late pool any more
                "freeAllowanceUsed": 2,
                "billableLateCount": 0,
                "shiftDeductions": 0.0,
                "lateInDays": 2,
                "earlyOutDays": 0,
                "freeAllowance": 3,
                "permissionMonthlyCap": 3,
            },
        )
        self.assertEqual(ded["lateShiftPenalty"], 0.0)
        self.assertEqual(ded["permissionPenalty"], 500.0)  # 4 excess - 2 free = 2 billable >= 1: 0.5 shift x 1,000
        self.assertEqual(
            ded["permissionSummary"],
            {
                "enabled": True,
                "approved": 7,
                "cap": 3,
                "excess": 4,
                "absorbedByLate": 0,
                "priced": 4,
                "freeAllowance": 2,
                "freeUsed": 2,
                "billable": 2,
                "shifts": 0.5,
                "penalty": 500.0,
            },
        )
        # included in the totals exactly like the late penalty
        self.assertEqual(ded["total"], 500.0)
        self.assertEqual(slip.other_deductions, Decimal("500.00"))
        self.assertEqual(slip.total_deductions, Decimal("500.00"))
        self.assertEqual(slip.net_salary, Decimal("23500.00"))
        payroll = slip.employee.payrolls.get(month=MONTH, year=YEAR)
        self.assertEqual((payroll.deductions, payroll.final_salary), (Decimal("500.00"), Decimal("23500.00")))
        self.assertIn("Permission slabs: 4 priced excess permission(s)", payroll.notes)

    def test_the_same_scenario_off_prices_the_permissions_as_late_marks(self):
        # the very same data with the switch OFF: 2 + 4 = 6 pool marks, 3 free, 3 billable = 0.25 shift
        _settings(permission_pricing_enabled=False, permission_deduction_slabs=FLAT_HALF)
        emp = _scenario(_staff("ON1_OFF"), late=2, perms=7)
        slip = _slip(emp)
        self.assertEqual((_ded(slip)["lateShiftPenalty"], _ded(slip)["permissionPenalty"]), (250.0, 0.0))
        self.assertEqual(slip.total_deductions, Decimal("250.00"))

    def test_both_deductions_are_added_and_kept_apart(self):
        """6 plain lates (3 billable = 0.25 shift) + 5 approved permissions (excess 2, free 0, billable 2): 0.5 shift."""
        _on(free=0, slabs=FLAT_HALF)
        emp = _scenario(_staff("ON2"), late=6, perms=5)
        slip = _slip(emp)
        ded = _ded(slip)
        self.assertEqual((ded["lateShiftPenalty"], ded["permissionPenalty"]), (250.0, 500.0))
        self.assertEqual(ded["lateSummary"]["totalLateCount"], 6)
        self.assertEqual(ded["total"], 750.0)
        self.assertEqual((slip.other_deductions, slip.total_deductions), (Decimal("750.00"), Decimal("750.00")))
        self.assertEqual(slip.net_salary, Decimal("23250.00"))

    def test_a_late_day_with_an_excess_permission_on_the_same_edge_is_charged_once(self):
        """4 permissions (3 on unflagged days + the 4th is a Morning one on a late day): that day is ONE incident."""
        _on(free=0, slabs=FLAT_HALF)
        emp = _scenario(_staff("ON3"), same_in=1, perms=3)
        slip = _slip(emp)
        ded = _ded(slip)
        self.assertEqual(ded["lateSummary"]["lateInCount"], 1)  # the late day is counted once, in the late pool
        self.assertEqual(ded["lateSummary"]["totalLateCount"], 1)
        self.assertEqual(ded["permissionSummary"]["excess"], 1)
        self.assertEqual((ded["permissionSummary"]["absorbedByLate"], ded["permissionSummary"]["priced"]), (1, 0))
        self.assertEqual((ded["lateShiftPenalty"], ded["permissionPenalty"]), (0.0, 0.0))  # 1 mark: 3 free, none priced
        # ...and never twice: with no free marks left the late pool prices it, the permission slabs do not
        _settings(late_free_allowance=0, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.25}])
        again = _ded(_slip(emp))
        self.assertEqual((again["lateShiftPenalty"], again["permissionPenalty"]), (250.0, 0.0))

    def test_an_excess_permission_on_an_unflagged_day_is_priced_on_its_own(self):
        _on(free=0, slabs=FLAT_HALF)
        emp = _scenario(_staff("ON4"), perms=4, perm_kind=MORNING)  # the 4th is excess, but nobody was late
        ded = _ded(_slip(emp))
        self.assertEqual((ded["lateSummary"]["totalLateCount"], ded["permissionSummary"]["priced"]), (0, 1))
        self.assertEqual(ded["permissionPenalty"], 500.0)

    def test_a_flagged_sunday_absorbs_nothing(self):
        """Working-day filter: the 4th (excess) permission is on a Sunday with a late punch. Sunday is not a payroll
        working day, so it is neither a late-pool day nor an absorber: the permission is priced on its own."""
        _on(free=0, slabs=FLAT_HALF)
        emp = _staff("ON5")
        for d in (2, 3, 4):
            EmployeePermission.objects.create(employee=emp, date=date(2026, 2, d), type=MORNING, status="approved")
        EmployeePermission.objects.create(employee=emp, date=SUNDAY, type=MORNING, status="approved")
        _scenario(
            emp,
            extra_records=((SUNDAY, {"is_late": True, "morning_permission_excess": True}),),
        )
        ded = _ded(_slip(emp))
        self.assertEqual(ded["lateSummary"]["totalLateCount"], 0)
        self.assertEqual((ded["permissionSummary"]["absorbedByLate"], ded["permissionSummary"]["priced"]), (0, 1))
        self.assertEqual(ded["permissionPenalty"], 500.0)

    def test_permissions_are_counted_per_employee_and_per_month(self):
        _on(free=0, slabs=FLAT_HALF)
        a, b = _staff("ONA"), _staff("ONB")
        for emp, month in ((a, 2), (b, 3)):  # five approved permissions each: A in February, B in March
            for n in range(5):
                EmployeePermission.objects.create(
                    employee=emp, date=date(2026, month, 2 + n), type=MIDDLE, status="approved"
                )
        for emp, month in product((a, b), (2, 3)):
            _present_month(emp, month)
        feb_a, feb_b = _ded(_slip(a)), _ded(_slip(b))
        mar_a, mar_b = _ded(_slip(a, 3)), _ded(_slip(b, 3))
        self.assertEqual((feb_a["permissionSummary"]["approved"], feb_a["permissionSummary"]["priced"]), (5, 2))
        self.assertEqual((feb_b["permissionSummary"]["approved"], feb_b["permissionSummary"]["priced"]), (0, 0))
        self.assertEqual((mar_a["permissionSummary"]["approved"], mar_a["permissionSummary"]["priced"]), (0, 0))
        self.assertEqual((mar_b["permissionSummary"]["approved"], mar_b["permissionSummary"]["priced"]), (5, 2))
        self.assertEqual(
            (
                feb_a["permissionPenalty"],
                feb_b["permissionPenalty"],
                mar_a["permissionPenalty"],
                mar_b["permissionPenalty"],
            ),
            (500.0, 0.0, 0.0, 461.54),  # March has 26 working days: 0.5 shift x 24,000 / 26
        )

    def test_pending_and_rejected_permissions_never_count(self):
        _on(free=0, slabs=FLAT_HALF)
        emp = _scenario(_staff("ON6"), perms=3)
        for status in ("pending", "rejected"):
            EmployeePermission.objects.create(employee=emp, date=date(2026, 2, 27), type=MIDDLE, status=status)
        ded = _ded(_slip(emp))
        self.assertEqual((ded["permissionSummary"]["approved"], ded["permissionSummary"]["excess"]), (3, 0))
        self.assertEqual(ded["permissionPenalty"], 0.0)

    def test_production_permissions_stay_unpriced_and_production_payroll_is_untouched(self):
        production = Employee.objects.create(
            employee_code="PRODSLAB",
            first_name="Prod",
            last_name="Worker",
            employment_type="production",
            status="active",
            salary_per_shift=Decimal("500.00"),
        )
        start, end = date(2026, 2, 2), date(2026, 2, 8)
        for d in (date(2026, 2, n) for n in range(2, 9)):
            AttendanceDayRecord.objects.create(
                employee=production, date=d, status="present", shifts_earned=Decimal("1.00"), source="manual"
            )
        for n in range(2, 8):  # six approved permissions: nothing prices them for production
            EmployeePermission.objects.create(
                employee=production, date=date(2026, 2, n), type=MIDDLE, status="approved"
            )
        _settings(permission_pricing_enabled=False)
        before = _generate_production_payroll(production, start, end)["slip"]
        _on(free=0, slabs=FLAT_HALF)
        after = _generate_production_payroll(production, start, end)["slip"]
        for field in ("gross_salary", "total_deductions", "net_salary", "other_deductions"):
            self.assertEqual(getattr(before, field), getattr(after, field), field)
        self.assertNotIn("permissionPenalty", after.breakdown_details["deductions"])
        self.assertNotIn("permissionSummary", after.breakdown_details["deductions"])
        self.assertEqual(after.net_salary, Decimal("3500.00"))  # 7 shifts x 500, no deduction at all

    def test_old_slips_and_new_slips_carry_additive_keys_only(self):
        _on(free=0, slabs=FLAT_HALF)
        slip = _slip(_scenario(_staff("ON7"), perms=4))
        ded = _ded(slip)
        for key in ("pf", "esi", "tds", "advances", "lateShiftPenalty", "lateSummary", "total"):
            self.assertIn(key, ded)  # nothing was removed or renamed
        self.assertEqual(
            set(ded)
            - {
                "pf",
                "pfRate",
                "esi",
                "esiRate",
                "tds",
                "tdsPercent",
                "statutory",
                "advances",
                "advanceDetails",
                "lateShiftPenalty",
                "lateSummary",
                "total",
            },
            {"permissionPenalty", "permissionSummary"},
        )
        self.assertEqual(
            set(ded["lateSummary"]),
            {
                "lateInCount",
                "earlyOutCount",
                "excessPermissionCount",
                "totalLateCount",
                "freeAllowanceUsed",
                "billableLateCount",
                "shiftDeductions",
                "lateInDays",
                "earlyOutDays",
                "freeAllowance",
                "permissionMonthlyCap",
            },
        )  # not a single key was added to the late summary


class EnginePunchesTests(TestCase):
    """The flags the REAL attendance engine writes from real punches are the ones the pool absorbs: shift 09:00-18:00 with 15
    minutes grace, June 2026 (26 working days: a salary of 26,000 has a daily rate of 1,000)."""

    def build(self):
        shift = ShiftTemplate.objects.create(
            name="Slab Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        emp = _staff("ENG1", salary="26000.00")
        EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=date(2020, 1, 1))
        return emp

    def punch(self, emp, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type="IN", source="test")

    def test_the_fourth_morning_permission_on_a_late_day_is_one_incident(self):
        _on(free=0, slabs=FLAT_HALF)
        _settings(late_free_allowance=0, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.25}])
        emp = self.build()
        for day in (1, 2, 3, 4):  # three in the cap protect their days; the 4th is excess and protects nothing
            EmployeePermission.objects.create(employee=emp, date=date(2026, 6, day), type=MORNING, status="approved")
            self.punch(emp, date(2026, 6, day), time(10, 10), time(18, 0))
        slip = _slip(emp, 6)
        ded = _ded(slip)
        self.assertEqual((ded["permissionSummary"]["excess"], ded["permissionSummary"]["absorbedByLate"]), (1, 1))
        self.assertEqual(ded["permissionSummary"]["priced"], 0)
        self.assertEqual(ded["lateSummary"]["lateInCount"], 1)  # the 4th day: counted once, in the late pool
        self.assertEqual(
            (ded["lateShiftPenalty"], ded["permissionPenalty"]), (250.0, 0.0)
        )  # 1 billable mark, nothing more
        off = _settings(permission_pricing_enabled=False)
        off_ded = _ded(_slip(emp, 6))
        self.assertEqual(off_ded["lateSummary"]["totalLateCount"], ded["lateSummary"]["totalLateCount"])
        self.assertEqual(off_ded["lateShiftPenalty"], 250.0)
        self.assertEqual(off_ded["permissionPenalty"], 0.0)
        self.assertIs(off.permission_pricing_enabled, False)

    def test_an_excess_permission_on_a_clean_day_is_priced_while_the_late_day_stays_in_the_pool(self):
        _on(free=0, slabs=FLAT_HALF)
        _settings(late_free_allowance=0, late_deduction_slabs=[{"fromLates": 1, "deductionShifts": 0.25}])
        emp = self.build()
        for day in (1, 2, 3, 4):
            EmployeePermission.objects.create(employee=emp, date=date(2026, 6, day), type=MORNING, status="approved")
            self.punch(emp, date(2026, 6, day), time(10, 10), time(18, 0))
        # a 5th approved permission (Middle One-Hour) on a day nobody was late: excess, on no late edge
        EmployeePermission.objects.create(employee=emp, date=date(2026, 6, 9), type=MIDDLE, status="approved")
        self.punch(emp, date(2026, 6, 9), time(9, 0), time(18, 0))
        ded = _ded(_slip(emp, 6))
        self.assertEqual(ded["permissionSummary"]["excess"], 2)
        self.assertEqual((ded["permissionSummary"]["absorbedByLate"], ded["permissionSummary"]["priced"]), (1, 1))
        self.assertEqual(ded["permissionPenalty"], 500.0)  # 1 billable permission: 0.5 shift x 1,000
        self.assertEqual(ded["lateShiftPenalty"], 250.0)  # the 4th morning day is one late mark, priced once


# ─────────────────────────────────────────────────────────────────────────────
#  Every caller shows the same numbers
# ─────────────────────────────────────────────────────────────────────────────


class ParityTests(TestCase):
    """One scenario (6 plain lates + 5 approved permissions, free 0, flat 0.5 shift): 0.25 + 0.5 shift = 750."""

    @classmethod
    def setUpTestData(cls):
        _on(free=0, slabs=FLAT_HALF)
        cls.emp = _scenario(_staff("PAR1"), late=6, perms=5)
        cls.slip = _slip(cls.emp)

    def test_the_slip_is_what_we_expect(self):
        self.assertEqual((_ded(self.slip)["lateShiftPenalty"], _ded(self.slip)["permissionPenalty"]), (250.0, 500.0))

    def test_the_monthly_shift_summary_has_payrolls_numbers(self):
        summary = MonthlyShiftSummary.objects.get(employee=self.emp, year=YEAR, month=MONTH)
        self.assertEqual(summary.shift_deductions, Decimal("0.75"))  # the TOTAL the employee loses (late + permission)
        self.assertEqual(summary.salary_deduction_amount, self.slip.other_deductions)
        self.assertEqual(summary.salary_deduction_amount, Decimal("750.00"))
        self.assertEqual(summary.permission_overage_count, 2)
        self.assertEqual((summary.total_late_count, summary.billable_late_count), (6, 3))

    def test_recomputing_the_summary_directly_gives_the_same_row(self):
        records = list(AttendanceDayRecord.objects.filter(employee=self.emp, date__year=YEAR, date__month=MONTH))
        row = compute_monthly_shift_summary(
            self.emp, YEAR, MONTH, Decimal("1000"), records=records, counted_dates=set(WORKING)
        )
        self.assertEqual((row.shift_deductions, row.salary_deduction_amount), (Decimal("0.75"), Decimal("750.00")))

    def test_the_employee_shift_stats_preview_matches_the_slip(self):
        r = self.client.get(
            f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(self.emp)
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        summary = body["summary"]
        late = _ded(self.slip)["lateSummary"]
        self.assertEqual(summary["billableLateCount"], late["billableLateCount"])
        self.assertEqual(summary["excessPermissionCount"], late["excessPermissionCount"])
        self.assertEqual(
            Decimal(summary["shiftDeductions"]), Decimal("0.75")
        )  # the total, as the installed apps expect
        self.assertEqual(Decimal(summary["salaryDeductionAmount"]), self.slip.other_deductions)
        # additive keys for the new clients
        self.assertIs(summary["permissionPricingEnabled"], True)
        self.assertEqual(summary["permissionPricedCount"], 2)
        self.assertEqual(summary["permissionBillableCount"], 2)
        self.assertEqual(summary["lateShiftDeductions"], 0.25)
        self.assertEqual(summary["permissionShiftDeductions"], 0.5)
        self.assertEqual(Decimal(summary["permissionDeductionAmount"]), Decimal("500.00"))
        policy = body["policy"]
        self.assertIs(policy["permissionPricingEnabled"], True)
        self.assertEqual(policy["permissionFreeAllowance"], 0)
        self.assertEqual(policy["permissionDeductionSlabs"], FLAT_HALF)
        for key in ("permissionMonthlyCap", "freeAllowance", "permissionDurationMinutes", "morningLateInEnabled"):
            self.assertIn(key, policy)  # nothing the installed apps read was removed

    def test_the_preview_switched_off_matches_the_old_numbers(self):
        _settings(permission_pricing_enabled=False)
        r = self.client.get(
            f"/api/attendance/employee-shift-stats?month={MONTH}&year={YEAR}", **_employee_token(self.emp)
        )
        summary = r.json()["summary"]
        # OFF: 6 + 2 excess = 8 marks, 3 free, 5 billable -> the shipped slabs: 3 billable = 0.25 shift
        self.assertEqual((summary["billableLateCount"], Decimal(summary["shiftDeductions"])), (5, Decimal("0.25")))
        self.assertEqual(Decimal(summary["salaryDeductionAmount"]), Decimal("250.00"))
        self.assertIs(summary["permissionPricingEnabled"], False)
        self.assertEqual(summary["permissionShiftDeductions"], 0.0)

    def test_the_late_reports_agree_with_the_slip(self):
        r = self.client.get("/api/reports/run/late-penalty-breakdown", {"period": "2026-02"}, **_admin())
        self.assertEqual(r.status_code, 200, r.content[:400])
        body = r.json()
        row = next(x for x in body["rows"] if x.get("employeeCode") == "PAR1")
        self.assertEqual(row["salaryDeduction"], float(self.slip.other_deductions))
        self.assertEqual((row["shiftDeductions"], row["permissionShifts"]), (0.25, 0.5))
        self.assertEqual((row["poolTotal"], row["permissionPriced"], row["permissionBillable"]), (6, 2, 2))
        keys = [c["key"] for c in body["columns"]]
        self.assertIn("permissionShifts", keys)
        self.assertTrue(any("Permission Deduction Slabs are ON" in n for n in body["notes"]))

        counts = self.client.get("/api/reports/run/late-summary-counts", {"period": "2026-02"}, **_admin()).json()
        row = next(x for x in counts["rows"] if x.get("employeeCode") == "PAR1")
        self.assertEqual(
            (row["poolTotal"], row["excessPermissions"], row["permissionPriced"], row["permissionBillable"]),
            (6, 2, 2, 2),
        )

    def test_the_late_reports_switched_off_have_exactly_the_old_columns(self):
        _settings(permission_pricing_enabled=False)
        body = self.client.get("/api/reports/run/late-penalty-breakdown", {"period": "2026-02"}, **_admin()).json()
        keys = [c["key"] for c in body["columns"]]
        self.assertNotIn("permissionShifts", keys)
        row = next(x for x in body["rows"] if x.get("employeeCode") == "PAR1")
        self.assertNotIn("permissionPriced", row)
        # 6 + 2 excess = 8 marks, 3 free, 5 billable = 0.25 shift (the shipped slabs), 250
        self.assertEqual((row["poolTotal"], row["billable"], row["salaryDeduction"]), (8, 5, 250.0))

    def test_the_permission_reports_agree_with_the_slip(self):
        impact = self.client.get("/api/reports/run/permission-excess-salary-impact", {"period": "2026-02"}, **_admin())
        self.assertEqual(impact.status_code, 200, impact.content[:400])
        body = impact.json()
        row = next(x for x in body["rows"] if x.get("employeeCode") == "PAR1")
        self.assertEqual((row["excessPermissions"], row["pricedPermissions"]), (2, 2))
        self.assertEqual((row["permissionDeduction"], row["excessCost"], row["latePenalty"]), (500.0, 500.0, 250.0))
        self.assertIn("permissionDeduction", [c["key"] for c in body["columns"]])
        counts = self.client.get(
            "/api/reports/run/permission-monthly-counts", {"dateFrom": "2026-02-01", "dateTo": "2026-02-28"}, **_admin()
        ).json()
        row = next(x for x in counts["rows"] if x.get("employeeCode") == "PAR1")
        self.assertEqual((row["totalApproved"], row["excess"]), (5, 2))  # the plain fact, in both modes
        self.assertTrue(any("priced on their own" in n for n in counts["notes"]))

    def test_the_payroll_reports_count_the_permission_deduction_as_a_late_type_deduction(self):
        from .reporting.definitions.payroll_core_common import LATE_SQL, derive

        self.assertEqual(SalarySlip.objects.annotate(x=LATE_SQL).get(pk=self.slip.pk).x, Decimal("750.00"))
        figures = derive(SalarySlip.objects.get(pk=self.slip.pk), date(2026, 12, 31))
        self.assertEqual((figures["late"], figures["other"], figures["residual"]), (750.0, 0.0, 750.0))

    def test_the_insights_say_the_same_thing(self):
        payroll = self.emp.payrolls.get(month=MONTH, year=YEAR)
        issues = self.client.get(f"/api/payroll/issues?month={MONTH}&year={YEAR}", **_admin()).json()["issues"]
        mine = [i for i in issues if i["employeeCode"] == "PAR1"]
        late = next(i for i in mine if i["code"] == "late_penalty")
        self.assertEqual(late["impact"]["amount"], 250.0)
        self.assertNotIn("excess permission", late["detail"])  # the excess permissions are not in this pool any more
        perm = next(i for i in mine if i["code"] == "excess_permission")
        self.assertEqual(perm["impact"]["amount"], 500.0)
        self.assertEqual(perm["facts"]["priced"], 2)
        self.assertEqual(perm["rule"]["settingsPath"], "/hr/settings?tab=late_detection#permission-deduction-slabs")
        details = self.client.get(f"/api/payroll/{payroll.id}/details", **_admin()).json()
        lines = {line["key"]: line for line in details["deductions"]}
        self.assertEqual((lines["late_penalty"]["amount"], lines["permission_penalty"]["amount"]), (250.0, 500.0))
        self.assertEqual(lines["permission_penalty"]["ruleKey"], "permission_slabs")
        self.assertEqual(lines["total_deductions"]["amount"], 750.0)
        rule_keys = {item["key"] for group in details["rules"] for item in group["items"]}
        self.assertLessEqual({"permission_pricing", "permission_free_allowance", "permission_slabs"}, rule_keys)
        applied = {item["key"]: item for group in details["rules"] for item in group["items"]}
        self.assertEqual(applied["permission_pricing"]["applied"], "On")
        self.assertFalse(applied["permission_pricing"]["changed"])
        # turning the switch off afterwards is "changed since this payroll was generated"
        _settings(permission_pricing_enabled=False)
        again = self.client.get(f"/api/payroll/{payroll.id}/details", **_admin()).json()
        flags = {item["key"]: item for group in again["rules"] for item in group["items"]}
        self.assertTrue(flags["permission_pricing"]["changed"])
        self.assertIn("permission_slabs", flags)  # still shown: the payroll WAS priced with it

    def test_the_rules_tab_lists_the_new_settings_with_their_links(self):
        body = self.client.get(f"/api/payroll/rules?month={MONTH}&year={YEAR}", **_admin()).json()
        items = {item["key"]: item for group in body["settings"] for item in group["items"]}
        self.assertEqual(items["permission_pricing"]["value"], "On")
        self.assertEqual(
            items["permission_pricing"]["settingsPath"], "/hr/settings?tab=late_detection#permission-pricing"
        )
        self.assertEqual(
            items["permission_free_allowance"]["settingsPath"],
            "/hr/settings?tab=late_detection#permission-free-allowance",
        )
        self.assertEqual(
            items["permission_slabs"]["settingsPath"], "/hr/settings?tab=late_detection#permission-deduction-slabs"
        )
        self.assertIn("1 billable excess permission", items["permission_slabs"]["value"])
        _settings(permission_pricing_enabled=False)
        off = self.client.get(f"/api/payroll/rules?month={MONTH}&year={YEAR}", **_admin()).json()
        off_items = {item["key"]: item for group in off["settings"] for item in group["items"]}
        self.assertEqual(off_items["permission_pricing"]["value"], "Off")
        self.assertNotIn("permission_slabs", off_items)  # nothing to explain while it is off


class InsightsCatalogueTests(SimpleTestCase):
    def test_the_new_settings_are_in_the_catalogue_on_the_late_detection_tab(self):
        from .payroll_insights import SETTINGS as REFS
        from .payroll_insights import all_setting_refs

        for key, anchor in (
            ("permission_pricing", "permission-pricing"),
            ("permission_free_allowance", "permission-free-allowance"),
            ("permission_slabs", "permission-deduction-slabs"),
        ):
            self.assertEqual((REFS[key].tab, REFS[key].anchor), ("late_detection", anchor), key)
            self.assertIn(REFS[key], all_setting_refs())
