"""
Report Center - HR Reports: hr-production-salary-statement, the printed Production Salary Statement.

Owner 2026-11-06: the Production Payroll pages (Weekly, BiWeekly, Monthly) get the Staff Payroll improvements, among them
the Export menu's printed statement. The report must show exactly what Production Payroll > Salary (GET
/api/payroll/production/salary-statement) shows, because both call the same builder; it follows the staff statement's
printed format: unit by unit (a band per unit, its departments with sub totals, its total, serial numbers from 1 in every
unit, a Unit column), ESI and NET rounded up to the next rupee, active employees only, the totals blocks, signatures and
the PF, ESI & TDS details in the files. Payrolls are made by the REAL engine (``_generate_production_payroll``) from manual
attendance day records for the Weekly periods 2-8 and 9-15 February 2026, with "today" frozen after them.

Run via: DATABASE_URL= DB_TEST_NAME=test_uktex_x py -3 manage.py test api.tests_reporting_hr_production_statement
"""

import io
import re
from datetime import date, time
from decimal import ROUND_CEILING, Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Branch,
    Department,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    Payroll,
    PayrollSettings,
    Role,
    SalarySlip,
    ShiftTemplate,
)
from .payroll_views import _generate_production_payroll
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.definitions import hr_reports_production_statement as P
from .reporting.export_xlsx import HEADER_ROW

RID = "hr-production-salary-statement"
W1 = (date(2026, 2, 2), date(2026, 2, 8))
W2 = (date(2026, 2, 9), date(2026, 2, 15))
FORTNIGHT = (date(2026, 2, 2), date(2026, 2, 15))
W1_QS = {"cycle": "weekly", "dateFrom": "2026-02-02", "dateTo": "2026-02-08"}

LABELS = [
    "SNO", "ID NO", "Name", "Designation", "Rate / Shift", "Days Paid", "Days Worked", "Absent", "Shifts",
    "Gross Earned", "PF", "ESI", "TDS", "Advance", "Others", "Total Deduction", "NET", "Remarks", "Unit",
]  # fmt: skip
KEYS = [
    "sno", "code", "name", "designation", "rate", "days", "worked", "absent", "shifts", "eSalary", "pf", "esi", "tds",
    "advance", "others", "totalDeduction", "net", "remarks", "unit",
]  # fmt: skip
SUMMED = ["eSalary", "pf", "esi", "tds", "advance", "others", "totalDeduction", "net"]
# taken straight from Production Payroll > Salary's statement row (ESI, NET and Total Deduction are rounded)
SAME_KEYS = ["code", "name", "designation", "rate", "days", "worked", "absent", "shifts", "eSalary", "pf", "tds"]
SAME_KEYS += ["advance", "others", "remarks"]

CYCLES = {
    "weekly": {"weekStart": "monday"},
    "biweekly": {"weekStart": "monday", "anchorDate": "2026-02-02"},
    "monthly": {"weekStart": "monday", "anchorDate": "2026-02-02"},
}
LATE_PLAN = [  # 6 shifts, two late arrivals (1 free, 1 billable = 0.5 shift = 250)
    ("present", "1.00", time(8, 30), time(17, 30)),
    ("present", "1.00", time(9, 15), time(17, 30)),
    ("present", "1.00", time(9, 20), time(17, 30)),
    ("half_shift", "0.50", time(8, 30), time(12, 30)),
    ("present", "1.50", time(8, 30), time(20, 0)),
    ("present", "1.00", time(8, 30), None),
    ("absent", "0", None, None),
]

_FROZEN_TODAY = patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31))


def setUpModule():
    _FROZEN_TODAY.start()


def tearDownModule():
    _FROZEN_TODAY.stop()


def ceil_rupee(value) -> float:
    return float(Decimal(str(value)).to_integral_value(rounding=ROUND_CEILING))


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def data_rows(body) -> list[dict]:
    return [r for r in body["rows"] if not r.get("_kind")]


def by_code(body) -> dict:
    return {r["code"]: r for r in data_rows(body)}


def bands(body) -> list[str]:
    return [r["name"] for r in body["rows"] if r.get("_kind") == "total" and r["net"] is None]


def headings(body) -> list[tuple[str, str]]:
    return [(r["unit"], r["name"]) for r in body["rows"] if r.get("_kind") == "subtotal" and r["net"] is None]


def day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=(status == "half_shift"),
        source="manual",
        **kw,
    )


def week_days(start: date, count: int = 7):
    return [date.fromordinal(start.toordinal() + i) for i in range(count)]


def _rule(rule_id, low, high, rate, basis="first_portion"):
    return {"id": rule_id, "label": rule_id, "basis": basis, "minAmount": low, "maxAmount": high, "ratePercent": rate}


class _World(TestCase):
    """Weekly 2-8 Feb 2026, rate 500 a shift.

    HO - Head Office: Weaving (P101 Raja, Co Emp: PF 12% / ESI 0.75% of the first half of the pay; P102 Mani, whose
    department is Unit 1's 'Weaving': one heading with Raja; an advance of 1,000 recovered this period), Packing (P103 Kala
    on the TDS list at 10%; P104 Velu with two late arrivals: 250 late deduction). U-1 - Unit 1: Cutting (P201 Selvi).
    No unit: P301 Arul (no department). Not listed: P401 (left after his payroll), P501 (BiWeekly), P601 (on the Weekly
    cycle, no payroll: counted in the notes). Raja also has a payroll for the next week, 9-15 Feb."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        for key, value in {
            "prod_attendance_mode": "simple",
            "prod_late_detection_enabled": True,
            "prod_late_free_allowance": 1,
            "prod_late_deduction_slabs": [{"fromLates": 1, "deductionShifts": 0.5}],
            "prod_cycles": CYCLES,
            "prod_pf_rules": [_rule("pf", 0, 50000, 12)],
            "prod_esi_rules": [_rule("esi", 0, 50000, 0.75)],
            "company_name": "U.K TEXTILES",
        }.items():
            setattr(ps, key, value)
        ps.save()

        # the head office a migration seeds (code HO)
        cls.ho, _ = Branch.objects.update_or_create(code="HO", defaults={"name": "Head Office", "is_head_office": True})
        cls.u1 = Branch.objects.create(name="Unit 1", code="Unit1")
        cls.weaving = Department.objects.create(name="Weaving", branch=cls.ho)
        cls.packing = Department.objects.create(name="Packing", branch=cls.ho)
        cls.weaving_u1 = Department.objects.create(name="Weaving", branch=cls.u1)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        cls.weaver = Designation.objects.create(title="Weaver")

        def worker(code, first, dept, branch, cycle="weekly", **kw):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="Prod", employment_type="production", status="active",
                salary_per_shift=Decimal("500"), department=dept, branch=branch, designation=cls.weaver,
                production_pay_cycle=cycle, **kw,
            )  # fmt: skip

        def present(emp, start, n=6):
            days = week_days(start)
            for d in days[:n]:
                day(emp, d)
            for d in days[n:]:
                day(emp, d, "absent", "0")

        cls.raja = worker("P101", "Raja", cls.weaving, cls.ho, co_emp_enabled=True)
        present(cls.raja, W1[0])
        present(cls.raja, W2[0])
        cls.mani = worker("P102", "Mani", cls.weaving_u1, cls.ho)
        present(cls.mani, W1[0])
        advance = Advance.objects.create(
            employee=cls.mani, advance_type="general", amount=Decimal("3000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("3000"),
        )  # fmt: skip
        AdvanceRepayment.objects.create(advance=advance, month=2, year=2026, amount=Decimal("1000"))
        cls.kala = worker("P103", "Kala", cls.packing, cls.ho, tds_enabled=True, tds_percent=Decimal("10"))
        present(cls.kala, W1[0], 5)
        cls.velu = worker("P104", "Velu", cls.packing, cls.ho)
        shift = ShiftTemplate.objects.create(
            name="Prod A", shift_type="production", start_time=time(8, 30), end_time=time(17, 30),
            grace_period_minutes=10,
        )  # fmt: skip
        EmployeeShiftAssignment.objects.create(employee=cls.velu, shift=shift, effective_from=date(2026, 1, 1))
        for d, (status, shifts, first, last) in zip(week_days(W1[0]), LATE_PLAN):
            day(cls.velu, d, status, shifts, first_punch=first, last_punch=last)
        cls.selvi = worker("P201", "Selvi", cls.cutting, cls.u1)
        present(cls.selvi, W1[0])
        cls.arul = worker("P301", "Arul", None, None)
        present(cls.arul, W1[0], 3)
        cls.gone = worker("P401", "Gone", cls.weaving, cls.ho)
        present(cls.gone, W1[0])
        cls.bi = worker("P501", "Bina", cls.weaving, cls.ho, cycle="biweekly")
        present(cls.bi, FORTNIGHT[0])
        present(cls.bi, W2[0])
        worker("P601", "Nopay", cls.weaving, cls.ho)

        for emp in (cls.raja, cls.mani, cls.kala, cls.velu, cls.selvi, cls.arul, cls.gone):
            _generate_production_payroll(emp, *W1, pay_cycle="weekly")
        _generate_production_payroll(cls.raja, *W2, pay_cycle="weekly")
        _generate_production_payroll(cls.bi, *FORTNIGHT, pay_cycle="biweekly")
        Employee.objects.filter(pk=cls.gone.pk).update(status="inactive")

        cls.admin = HRUser.objects.create(username="ps_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.production_user = user("ps_production", {"production_payroll": "view"})
        cls.payroll_user = user("ps_payroll", {"payroll": "view"})
        cls.plain_user = user("ps_plain", {})
        cls.branch_user = user("ps_branch", {"production_payroll": "view"}, branch=cls.u1)

    # ── helpers ────────────────────────────────────────────────────────────
    def get(self, user=None, expect=200, **params):
        params = {**W1_QS, **params}
        params = {k: v for k, v in params.items() if v is not None}
        r = self.client.get(f"/api/reports/run/{RID}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, fmt, user=None, expect=200, **params):
        params = {**W1_QS, "fmt": fmt, **params}
        r = self.client.get(f"/api/reports/export/{RID}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    def statement(self, user=None, period=W1):
        r = self.client.get(
            f"/api/payroll/production/salary-statement?cycle=weekly&periodStart={period[0]}&periodEnd={period[1]}",
            **hdr(user or self.admin),
        )
        self.assertEqual(r.status_code, 200, r.content[:400])
        return {row["values"]["code"]: row["values"] for g in r.json()["groups"] for row in g["rows"]}


# ═════════════════════════════════════════════════════════════════════════════
# Registration and access
# ═════════════════════════════════════════════════════════════════════════════


class CatalogTests(_World):
    def test_registered_in_hr_reports_with_the_production_columns(self):
        spec = registry.get_spec(RID)
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual((spec.title, spec.category, spec.modules), ("Production Salary Statement", "hr", P.MODULES))
        self.assertTrue(set(spec.modules) <= set(all_module_keys()))
        self.assertEqual([c.label for c in spec.columns], LABELS)
        self.assertEqual([c.key for c in spec.columns], KEYS)
        self.assertEqual([c.key for c in spec.columns if c.total == "sum"], SUMMED)
        types = {c.key: c.type for c in spec.columns}
        for key in ("days", "worked", "absent", "shifts"):
            self.assertEqual(types[key], "number", key)
        self.assertEqual(types["rate"], "currency")

    def test_the_catalog_offers_a_cycle_and_a_pay_period(self):
        r = self.client.get("/api/reports/catalog", **hdr(self.admin))
        spec = next(s for s in r.json()["reports"] if s["id"] == RID)
        filters = {f["key"]: f for f in spec["filters"]}
        self.assertEqual(
            list(filters), ["cycle", "dateRange", "branch", "department", "designation", "employee", "paymentStatus"]
        )
        self.assertEqual(
            (
                filters["cycle"]["required"],
                filters["cycle"]["default"],
                [o["label"] for o in filters["cycle"]["options"]],
            ),
            (True, "weekly", ["Weekly", "BiWeekly", "Monthly"]),
        )
        self.assertFalse(filters["dateRange"]["required"])
        self.assertEqual(filters["dateRange"]["default"], {"dateFrom": "", "dateTo": ""})
        self.assertIn("Any day of the pay period", filters["dateRange"]["help"])

    def test_only_the_production_payroll_module_opens_it(self):
        self.get(self.production_user)
        self.get(self.payroll_user, expect=403)
        self.get(self.plain_user, expect=403)
        self.export("pdf", self.payroll_user, expect=403)

    def test_it_needs_an_hr_login(self):
        self.assertIn(self.client.get(f"/api/reports/run/{RID}", W1_QS).status_code, (401, 403))


# ═════════════════════════════════════════════════════════════════════════════
# Content: the same figures as Production Payroll > Salary, in the printed format
# ═════════════════════════════════════════════════════════════════════════════


class ContentTests(_World):
    def test_every_figure_is_the_salary_tabs_with_esi_and_net_rounded_up(self):
        body = self.get()
        statement = self.statement()
        rows = by_code(body)
        self.assertEqual(sorted(rows), ["P101", "P102", "P103", "P104", "P201", "P301"])
        for code, row in rows.items():
            v = statement[code]
            for key in SAME_KEYS:
                self.assertEqual(row[key], v[key] if v[key] != "" else row[key], (code, key))
            self.assertEqual(row["esi"], ceil_rupee(v["esi"]), code)
            self.assertEqual(row["net"], ceil_rupee(v["net"]), code)
            self.assertAlmostEqual(row["totalDeduction"], v["totalDeduction"] - v["esi"] + ceil_rupee(v["esi"]), 2)

    def test_the_known_workers(self):
        rows = by_code(self.get())
        raja, mani, kala, velu = rows["P101"], rows["P102"], rows["P103"], rows["P104"]
        self.assertEqual(
            (raja["rate"], raja["days"], raja["worked"], raja["absent"], raja["shifts"]), (500, 7, 6, 1, 6)
        )
        self.assertEqual(raja["eSalary"], 3000)
        self.assertEqual((raja["pf"], raja["esi"]), (180, 12))  # ESI 11.25 rounded up
        self.assertEqual((raja["totalDeduction"], raja["net"]), (192, 2809))  # 180 + 12; 2808.75 rounded up
        self.assertEqual((mani["advance"], mani["net"]), (1000, 2000))
        self.assertEqual((kala["eSalary"], kala["tds"], kala["net"]), (2500, 250, 2250))
        self.assertEqual((velu["others"], velu["eSalary"], velu["net"]), (250, 3000, 2750))
        self.assertEqual(velu["remarks"], "")

    def test_unit_by_unit_head_office_first_no_unit_last_serials_from_1(self):
        body = self.get()
        self.assertEqual(
            bands(body),
            ["HO – Head Office   4 employees", "U-1 – Unit 1   1 employee", "Other – no unit set   1 employee"],
        )
        # Mani's department is Unit 1's "Weaving": one Weaving heading in the head office, with Raja
        self.assertEqual(
            headings(body),
            [("HO", "Packing"), ("HO", "Weaving"), ("U-1", "Cutting"), ("Other", "No department")],
        )
        self.assertEqual(
            [(r["unit"], r["sno"], r["code"]) for r in data_rows(body)],
            [("HO", 1, "P103"), ("HO", 2, "P104"), ("HO", 3, "P101"), ("HO", 4, "P102"), ("U-1", 1, "P201"),
             ("Other", 1, "P301")],
        )  # fmt: skip

    def test_sub_totals_unit_totals_and_the_total_add_up_the_printed_figures(self):
        body = self.get()
        rows = data_rows(body)
        for key in SUMMED:
            self.assertAlmostEqual(body["totals"][key], sum(r[key] for r in rows), 2, key)
        self.assertIsNone(body["totals"].get("rate"))  # a rate and the day counts are never added up
        self.assertIsNone(body["totals"].get("days"))
        packing = next(r for r in body["rows"] if r["name"] == "Packing Sub total")
        self.assertEqual(packing["net"], 2250 + 2750)
        unit = next(r for r in body["rows"] if r["name"] == "HO – Head Office total")
        self.assertEqual(unit["net"], 2250 + 2750 + 2809 + 2000)

    def test_only_active_workers_of_the_cycle_and_the_notes_count_who_has_no_payroll(self):
        body = self.get()
        self.assertNotIn("P401", by_code(body))  # left after the payroll
        self.assertNotIn("P501", by_code(body))  # BiWeekly
        notes = " ".join(body["notes"])
        self.assertIn("Production Salary Statement From 02-02-2026 To 08-02-2026 (Weekly pay period)", notes)
        self.assertIn("1 active production employee(s) on the Weekly cycle", notes)
        self.assertIn("ESI and NET are rounded up", notes)

    def test_the_filters_echo_names_the_period_printed(self):
        body = self.get()
        self.assertEqual(
            [(f["label"], f["value"]) for f in body["filters"]],
            [("Pay cycle", "Weekly"), ("Pay period", "02-Feb-2026 to 08-Feb-2026")],
        )

    def test_payment_status_filter(self):
        Payroll.objects.filter(employee=self.raja, period_start=W1[0]).update(status="paid")
        self.assertEqual(list(by_code(self.get(paymentStatus="paid"))), ["P101"])
        self.assertNotIn("P101", by_code(self.get(paymentStatus="pending")))

    def test_scope_filters(self):
        self.assertEqual(sorted(by_code(self.get(departmentIds=str(self.packing.id)))), ["P103", "P104"])
        self.assertEqual(sorted(by_code(self.get(branchIds=str(self.u1.id)))), ["P201"])

    def test_a_part_period_prints_its_own_days_and_says_so(self):
        slip = SalarySlip.objects.get(employee=self.selvi, period_start=W1[0])
        bd = slip.breakdown_details
        bd["summary"] = {**bd["summary"], "totalDays": 4, "periodDays": 7}
        SalarySlip.objects.filter(pk=slip.pk).update(breakdown_details=bd)
        selvi = by_code(self.get())["P201"]
        self.assertEqual(selvi["days"], 4)
        self.assertEqual(selvi["remarks"], "PART PERIOD 4 OF 7 DAYS")
        self.assertEqual(self.statement()["P201"]["days"], 4)  # the Salary tab says the same
        # catch-up days before the period (production_coverage.py) make more days than the period has
        bd["summary"] = {**bd["summary"], "totalDays": 9, "periodDays": 7}
        SalarySlip.objects.filter(pk=slip.pk).update(breakdown_details=bd)
        selvi = by_code(self.get())["P201"]
        self.assertEqual((selvi["days"], selvi["remarks"]), (9, "9 DAYS INCL. CATCH-UP"))


class PeriodTests(_World):
    def test_any_day_of_the_period_is_enough(self):
        body = self.get(dateFrom="2026-02-05", dateTo="2026-02-05")
        self.assertEqual(len(data_rows(body)), 6)
        self.assertIn(("Pay period", "02-Feb-2026 to 08-Feb-2026"), [(f["label"], f["value"]) for f in body["filters"]])
        self.assertEqual(len(data_rows(self.get(dateFrom="2026-02-05", dateTo=None))), 6)

    def test_no_dates_print_the_latest_generated_period(self):
        body = self.get(dateFrom=None, dateTo=None)
        self.assertEqual(list(by_code(body)), ["P101"])  # only Raja has 9-15 Feb
        self.assertIn(("Pay period", "09-Feb-2026 to 15-Feb-2026"), [(f["label"], f["value"]) for f in body["filters"]])
        self.assertEqual(by_code(body)["P101"]["shifts"], 6)

    def test_dates_touching_two_periods_are_refused_with_the_periods_named(self):
        r = self.get(expect=400, dateFrom="2026-02-07", dateTo="2026-02-10")
        self.assertEqual(r["field"], "dateFrom")
        self.assertIn("These dates touch 2 Weekly pay periods (2 Feb - 8 Feb 2026, 9 Feb - 15 Feb 2026)", r["message"])

    def test_dates_with_no_payroll_print_an_empty_statement_that_says_so(self):
        body = self.get(dateFrom="2026-03-02", dateTo="2026-03-08")
        self.assertEqual(data_rows(body), [])
        self.assertIn("No Weekly production payroll has been generated for this period", " ".join(body["notes"]))

    def test_a_cycle_with_nothing_generated_says_so(self):
        body = self.get(cycle="monthly", dateFrom=None, dateTo=None)
        self.assertEqual(data_rows(body), [])
        self.assertIn("No Monthly production payroll has been generated yet", " ".join(body["notes"]))

    def test_biweekly_prints_its_own_period(self):
        body = self.get(cycle="biweekly", dateFrom="2026-02-10", dateTo="2026-02-10")
        self.assertEqual(list(by_code(body)), ["P501"])
        self.assertIn(("Pay period", "02-Feb-2026 to 15-Feb-2026"), [(f["label"], f["value"]) for f in body["filters"]])

    def test_a_bad_cycle_is_a_400(self):
        self.get(expect=400, cycle="daily")


class BranchTests(_World):
    def test_a_unit_login_sees_its_own_unit_only(self):
        body = self.get(self.branch_user)
        self.assertEqual(list(by_code(body)), ["P201"])
        self.assertEqual(bands(body), ["U-1 – Unit 1   1 employee"])
        self.assertEqual(body["totals"]["net"], by_code(body)["P201"]["net"])
        # a parameter never widens the scope: asking for the head office gives nothing
        for params in ({"branchIds": str(self.ho.id)}, {"departmentIds": str(self.weaving.id)}):
            self.assertEqual(self.get(self.branch_user, **params)["rows"], [], params)


class CostTests(_World):
    def test_running_never_writes(self):
        with CaptureQueriesContext(connection) as ctx:
            self.get()
        writes = [q["sql"] for q in ctx.captured_queries if re.match(r"\s*(INSERT|UPDATE|DELETE)", q["sql"], re.I)]
        self.assertEqual(writes, [])

    def test_photo_and_password_are_never_selected(self):
        with CaptureQueriesContext(connection) as ctx:
            self.get()
        table = f'FROM "{Payroll._meta.db_table}"'
        payroll_selects = [q["sql"] for q in ctx.captured_queries if table in q["sql"]]
        self.assertTrue(payroll_selects)
        for sql in payroll_selects:
            self.assertNotIn("photo_url", sql)
            self.assertNotIn("password_hash", sql)


# ═════════════════════════════════════════════════════════════════════════════
# The files: the staff statement's printed format with the production columns
# ═════════════════════════════════════════════════════════════════════════════


class ExportTests(_World):
    def test_excel_lists_the_screens_lines_and_closes_with_the_cards_and_signatures(self):
        screen = self.get()
        r = self.export("xlsx")
        self.assertRegex(r["Content-Disposition"], r'filename="production_salary_statement_\d{8}_\d{4}\.xlsx"')
        wb = load_workbook(io.BytesIO(r.content))
        self.assertEqual(wb.sheetnames, ["Production Salary Statement", "PF ESI TDS"])
        ws = wb.active
        self.assertEqual([c.value for c in ws[HEADER_ROW]], LABELS)
        cells = [[c.value for c in row] for row in ws.iter_rows(min_row=HEADER_ROW + 1)]
        firsts = [row[0] for row in cells]
        names = [row[KEYS.index("name")] for row in cells]
        # each unit opens with its band, the rows carry the screen's figures
        self.assertIn("HO – Head Office   4 employees", firsts)
        self.assertIn("U-1 – Unit 1   1 employee", firsts)
        lines = {row[KEYS.index("code")]: row for row in cells if isinstance(row[0], int)}
        for code, want in by_code(screen).items():
            for k, key in enumerate(KEYS):
                if key in ("sno", "unit", "remarks"):
                    continue
                got = lines[code][k]
                if isinstance(want[key], float):
                    self.assertAlmostEqual(got, want[key], 2, (code, key))
        # one blank row between Packing's Sub total and Weaving
        packing = names.index("Packing Sub total")
        self.assertTrue(all(v is None for v in cells[packing + 1]))
        self.assertEqual(names[packing + 2], "Weaving")
        # each unit's totals block and Final Summary, the all-units recap, the Final Summary and the signatures
        text = " ".join(str(v) for row in cells for v in row if v is not None)
        for words in ("HO – Head Office Total", "Total Employees", "Gross Earned", "HO – Head Office: Final Summary",
                      "All units Total", "Final Summary", "Detection Amount", "Net Pay", "Prepared By", "Checked By",
                      "HRM", "Auditor", "MD"):  # fmt: skip
            self.assertIn(words, text)
        total = next(row for row in cells if row[0] == "TOTAL")
        self.assertEqual(total[KEYS.index("name")], "6 employees in 3 units")
        self.assertAlmostEqual(total[KEYS.index("net")], screen["totals"]["net"], 2)
        header = " ".join(str(c.value) for row in ws.iter_rows(max_row=HEADER_ROW - 1) for c in row if c.value)
        self.assertIn("PRODUCTION SALARY STATEMENT", header)
        self.assertIn("Pay period: 02-Feb-2026 to 08-Feb-2026", header)
        self.assertIn("Amounts in ₹", header)
        self.assertNotIn("Gross Earned is the pay", text)  # no notes in the file

    def test_the_pf_esi_tds_sheet(self):
        ws = load_workbook(io.BytesIO(self.export("xlsx").content))["PF ESI TDS"]
        values = [[c.value for c in row] for row in ws.iter_rows()]
        header = values.index(next(v for v in values if v[0] == "SNO"))
        cols = values[header]
        rows = {r[1]: dict(zip(cols, r)) for r in values[header + 1 :] if isinstance(r[0], int)}
        self.assertEqual(sorted(rows), ["P101", "P103"])
        raja = rows["P101"]
        self.assertEqual((raja["Covered by"], raja["PF"], raja["ESI"]), ("Co Emp", 180, 12))
        self.assertEqual(raja["PF / ESI wages"], 1500)  # the first half of the 3,000 period pay
        self.assertIn("PF 12% of the first-portion share of the period pay", raja["How it was worked out"])
        self.assertEqual((rows["P103"]["Covered by"], rows["P103"]["TDS"]), ("TDS list", 250))

    def test_the_pdf_is_the_printed_statement_unit_by_unit(self):
        import pdfplumber

        r = self.export("pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        with pdfplumber.open(io.BytesIO(r.content)) as pdf:
            pages = [re.sub(r"\s+", " ", (p.extract_text() or "").replace("\xa0", " ")) for p in pdf.pages]
            self.assertEqual(round(pdf.pages[0].width), 1191)  # A3 landscape
        text = " ".join(pages)
        self.assertIn("PRODUCTION SALARY STATEMENT", pages[0])
        self.assertIn("Pay period: 02-Feb-2026 to 08-Feb-2026", pages[0])
        self.assertIn("HO – Head Office 4 employees", pages[0])
        # each unit on a page of its own, then the all-units page, then the PF / ESI / TDS details
        self.assertTrue(any(p.startswith("U-1 – Unit 1") or "U-1 – Unit 1 1 employee" in p for p in pages[1:]))
        self.assertNotIn("U-1 – Unit 1 1 employee", pages[0])
        self.assertIn("TOTAL 6 employees in 3 units", text)
        for words in ("Gross Earned", "Detection Amount", "Net Pay", "Prepared By", "Auditor"):
            self.assertIn(words, text)
        self.assertIn("PF, ESI & TDS DETAILS", pages[-1])
        self.assertNotIn("PF, ESI & TDS DETAILS", pages[0])

    def test_the_export_is_audited_with_the_period(self):
        from .models import AuditLog

        self.export("xlsx", dateFrom="2026-02-04", dateTo="2026-02-04")
        log = AuditLog.objects.order_by("-id").first()
        self.assertIn("Production Salary Statement", log.record_description)
        self.assertIn("02-Feb-2026 to 08-Feb-2026", log.record_description)


class StatementColumnTests(_World):
    def test_the_salary_tabs_statement_has_days_paid(self):
        r = self.client.get(
            "/api/payroll/production/salary-statement?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
            **hdr(self.admin),
        )
        labels = [c["label"] for c in r.json()["columns"]]
        self.assertEqual(labels[4:6], ["Rate / shift", "Days paid"])
        self.assertEqual(self.statement()["P101"]["days"], 7.0)
