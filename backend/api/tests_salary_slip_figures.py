"""
Salary slip = Payroll Report (owner 2026-11-04: "both reports must display exactly the same salary components and deduction
details", no outdated lines such as Temporary Advance).

The slip PDF takes its earnings, deductions, NET and days from the Salary Statement's own row
(``salary_slip_figures.figures`` -> ``payroll_statement_views.statement_rows``):

  - the salary split (Basic salary / PTRL / Others Allow), less the Lop & PS amount, plus OT and Bonus = E salary
  - Advance (recovered this month), ESI, PF, TDS, Others = Total Deduction; NET = the payroll's saved net
  - a bonus HR adds on the payroll after it was generated is on the slip too (it used to be missing)
  - only what applies is printed: no DA / CA / EA / T.Advance / LOP 0 lines, no PF / ESI outside Co Emp
  - the Salary Statement has no T.Advance column any more

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_slipfig python manage.py test api.tests_salary_slip_figures
"""

import io
from decimal import Decimal

import pdfplumber

from . import tests_pf_esi as pe
from .company_documents_views import build_salary_slip_pdf
from .models import Advance, AdvanceRepayment, Payroll, SalarySlip
from .payroll_insights import KIND_STAFF, staff_period
from .payroll_statement_views import staff_columns, statement_rows
from .salary_slip_bulk_pdf import build_bulk_salary_slip_pdf
from .salary_slip_figures import figures
from .tests_payroll_engine import MONTH, YEAR, _present_all


def _text(content: bytes) -> str:
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return "\n".join((page.extract_text() or "") for page in pdf.pages)


class SlipEqualsReportTests(pe.Base):
    """C = Co Emp (salary 24,000: PF 12% and ESI 0.75% of the 12,000 first portion), N = neither, both present every
    working day; N also repays 1,500 of a 5,000 advance this month."""

    def setUp(self):
        super().setUp()
        self.c = pe._staff("C1", co_emp_enabled=True)
        self.n = pe._staff("N1")
        advance = Advance.objects.create(
            employee=self.n, advance_type="general", amount=Decimal("5000"), status="approved",
            total_repaid=Decimal("0"), outstanding=Decimal("5000"),
        )  # fmt: skip
        AdvanceRepayment.objects.create(advance=advance, month=MONTH, year=YEAR, amount=Decimal("1500"))
        for emp in (self.c, self.n):
            _present_all(emp)
            pe._generate(emp)

    def slip(self, emp) -> SalarySlip:
        return SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)

    def report_row(self, emp) -> dict:
        p = Payroll.objects.get(employee=emp, month=MONTH, year=YEAR)
        rows, _a, _b = statement_rows([p], KIND_STAFF, staff_period(MONTH, YEAR))
        return rows[p.id]

    def test_every_figure_is_the_reports(self):
        for emp in (self.c, self.n):
            f, row = figures(self.slip(emp)), self.report_row(emp)
            self.assertEqual(f.source, "statement")
            self.assertEqual(float(f.earnings_total), row["eSalary"], emp.employee_code)
            self.assertEqual(float(f.deductions_total), row["totalDeduction"], emp.employee_code)
            self.assertEqual(float(f.net), row["net"], emp.employee_code)
            self.assertAlmostEqual(float(sum(a for _l, a in f.earnings)), row["eSalary"], 2)
            self.assertAlmostEqual(float(sum(a for _l, a in f.deductions)), row["totalDeduction"], 2)
        c = dict(figures(self.slip(self.c)).deductions)
        row = self.report_row(self.c)
        self.assertEqual((float(c["PF"]), float(c["ESI"])), (row["pf"], row["esi"]))
        self.assertEqual(dict(figures(self.slip(self.c)).earnings)["Basic salary"], Decimal(str(row["basic"])))

    def test_only_what_applies_is_listed(self):
        n = figures(self.slip(self.n))
        self.assertEqual([label for label, _a in n.deductions], ["Advance"])  # no PF / ESI outside Co Emp
        self.assertEqual(n.deductions[0][1], Decimal("1500"))  # what this month recovered, not the 5,000 balance
        text = _text(build_salary_slip_pdf(self.slip(self.n)))
        for gone in ("T.Advance", "DA", "CA\n", "EA\n", "PTRL", "HRA", "OT Hours", "PF\n", "ESI\n"):
            self.assertNotIn(gone, text, gone)
        self.assertRegex(text, r"Advance\s+(₹|Rs\. )1,500\.00")

    def test_a_bonus_added_on_the_payroll_after_generation_is_on_the_slip(self):
        p = Payroll.objects.get(employee=self.c, month=MONTH, year=YEAR)
        r = self.send("patch", f"/api/payroll/{p.pk}", {"bonus": "1000"})
        self.assertEqual(r.status_code, 200, r.content[:300])
        p.refresh_from_db()
        slip = self.slip(self.c)
        self.assertEqual(slip.bonuses, Decimal("0"))  # the stored slip still has no bonus ...
        f = figures(slip)  # ... the printed slip follows the payroll, as the report does
        self.assertEqual(dict(f.earnings)["Bonus"], Decimal("1000.00"))
        self.assertEqual(f.net, p.final_salary)
        self.assertEqual(float(f.net), self.report_row(self.c)["net"])
        text = _text(build_salary_slip_pdf(slip))
        self.assertRegex(text, r"Bonus\s+(₹|Rs\. )1,000\.00")
        self.assertIn(f"{p.final_salary:,.2f}", text)

    def test_the_days_are_the_reports(self):
        f, row = figures(self.slip(self.c)), self.report_row(self.c)
        days = dict(f.days)
        self.assertEqual(days["Present"], f"{row['present']:g}")
        self.assertEqual(days["LOP"], f"{row['lop']:g}")
        self.assertTrue(days["Total Days (paid)"].startswith(f"{row['totalDays']:g} of "))

    def test_the_two_per_page_slip_prints_the_same_figures(self):
        text = _text(build_bulk_salary_slip_pdf([self.slip(self.c), self.slip(self.n)]))
        self.assertNotIn("T.Advance", text)
        for emp in (self.c, self.n):
            self.assertIn(f"{figures(self.slip(emp)).net:,.2f}", text)

    def test_the_statement_has_no_t_advance_column(self):
        self.assertNotIn("tAdvance", [c["key"] for c in staff_columns()])
        self.assertNotIn("tAdvance", self.report_row(self.n))

    def test_a_slip_without_a_payroll_prints_its_own_figures_without_zero_lines(self):
        preview = SalarySlip(
            employee=self.n, month=7, year=2026, slip_number="SAMPLE", basic=18000, hra=2000, allowances=1500,
            incentives=0, bonuses=0, ot_amount=0, gross_salary=21500, pf_deduction=0, esi_deduction=0,
            advance_deduction=0, other_deductions=0, total_deductions=0, net_salary=21500, present_days=26,
            completed_sessions=0,
        )  # fmt: skip
        f = figures(preview)
        self.assertEqual(f.source, "slip")
        self.assertEqual([label for label, _a in f.earnings], ["Basic salary", "HRA", "Other Allowances"])
        self.assertEqual((f.deductions, f.net), ([], Decimal("21500")))
        self.assertIn("No deductions this month", _text(build_salary_slip_pdf(preview)))
