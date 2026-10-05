"""The assistant's safe query language (md_portal/assistant/query_dsl.py)."""

from datetime import date, datetime, timedelta, timezone as dt_timezone
from decimal import Decimal

from django.test import TestCase

from .clock import ist_today
from .md_portal.assistant import query_dsl as Q
from .md_portal.common import MdParamError, read_only_db, resolve_period, resolve_scope
from .models import AttendanceDayRecord, AuditLog, Branch, Department, Employee, SalarySlip, Visitor, VisitorVisit


class Fixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Dsl Unit One", code="DU1")
        cls.u2 = Branch.objects.create(name="Dsl Unit Two", code="DU2")
        cls.stitch = Department.objects.create(name="Dsl Stitching", branch=cls.u1)
        cls.cut = Department.objects.create(name="Dsl Cutting", branch=cls.u2)
        make = lambda code, dept, branch, **kw: Employee.objects.create(  # noqa: E731
            employee_code=code, first_name=code, last_name="T", department=dept, branch=branch, **kw
        )
        cls.a = make("DA", cls.stitch, cls.u1, employment_type="staff", join_date="2024-03-10")
        cls.b = make("DB", cls.stitch, cls.u1, employment_type="production", join_date="2024-07-01")
        cls.c = make("DC", cls.cut, cls.u2, employment_type="production", join_date="2025-01-15")
        cls.gone = make("DD", cls.cut, cls.u2, status="inactive", join_date="2023-05-05")

    def run_query(self, spec, **params):
        with read_only_db():
            return Q.run_query_tool({**spec, **params})


class Employees(Fixture):
    def test_a_plain_count_of_active_people(self):
        r = self.run_query({"dataset": "employees", "filters": [{"field": "status", "op": "eq", "value": "active"}]})
        self.assertEqual(r["rows"], [{"count": 3}])
        self.assertEqual(r["matchedRecords"], 3)
        self.assertIn("status = active", r["query"])

    def test_grouped_and_ranked_biggest_first(self):
        r = self.run_query(
            {
                "dataset": "employees",
                "group_by": ["department"],
                "filters": [{"field": "status", "op": "eq", "value": "active"}],
            }
        )
        self.assertEqual(
            r["rows"], [{"department": "Dsl Stitching", "count": 2}, {"department": "Dsl Cutting", "count": 1}]
        )

    def test_grouping_by_join_year_and_ordering_it(self):
        r = self.run_query(
            {"dataset": "employees", "group_by": ["join_year"], "order_by": {"by": "join_year", "dir": "asc"}}
        )
        self.assertEqual(
            r["rows"],
            [{"join_year": "2023", "count": 1}, {"join_year": "2024", "count": 2}, {"join_year": "2025", "count": 1}],
        )

    def test_the_unit_filter_narrows_the_scope(self):
        r = self.run_query({"dataset": "employees"}, branch="Dsl Unit One")
        self.assertEqual(r["rows"], [{"count": 2}])

    def test_a_close_unit_name_is_matched_and_the_match_is_reported(self):
        r = self.run_query({"dataset": "employees"}, branch="dsl unit onee")
        self.assertEqual(r["rows"], [{"count": 2}])
        self.assertTrue(any("Matched unit" in n for n in r["notes"]))

    def test_staff_vs_production_scope(self):
        r = self.run_query({"dataset": "employees"}, type="production")
        self.assertEqual(r["rows"], [{"count": 2}])  # DB and DC; the leaver DD is "staff" by default

    def test_values_in_a_list_and_text_search(self):
        r = self.run_query(
            {
                "dataset": "employees",
                "filters": [{"field": "department", "op": "in", "values": ["Dsl Cutting", "nothing"]}],
            }
        )
        self.assertEqual(r["rows"], [{"count": 2}])
        r = self.run_query(
            {"dataset": "employees", "filters": [{"field": "designation", "op": "contains", "value": "x"}]}
        )
        self.assertEqual(r["rows"], [{"count": 0}])

    def test_counting_distinct_things(self):
        r = self.run_query({"dataset": "employees", "metrics": [{"fn": "count_distinct", "field": "department"}]})
        self.assertEqual(r["rows"], [{"distinct_department": 2}])


class Attendance(Fixture):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        today = ist_today()
        for days_ago, status, emp in (
            (1, "present", cls.a),
            (2, "absent", cls.a),
            (3, "present", cls.b),
            (40, "absent", cls.b),
        ):
            AttendanceDayRecord.objects.create(
                employee=emp,
                date=today - timedelta(days=days_ago),
                status=status,
                shifts_earned=Decimal("1.00") if status == "present" else 0,
            )

    def test_the_period_defaults_to_the_last_30_days_and_says_so(self):
        r = self.run_query({"dataset": "attendance_days"})
        self.assertEqual(r["rows"], [{"count": 3}])  # the 40-day-old row is outside
        self.assertEqual(r["period"]["preset"], "last_30_days")
        self.assertTrue(any("no period was given" in d for d in r["defaulted"]))

    def test_an_explicit_period_is_not_reported_as_defaulted(self):
        r = self.run_query({"dataset": "attendance_days"}, period="last_90_days")
        self.assertEqual(r["rows"], [{"count": 4}])
        self.assertNotIn("defaulted", r)

    def test_a_time_series_reads_oldest_first(self):
        r = self.run_query({"dataset": "attendance_days", "group_by": ["date:month"]}, period="last_90_days")
        months = [row["date_month"] for row in r["rows"]]
        self.assertEqual(months, sorted(months))
        self.assertEqual(sum(row["count"] for row in r["rows"]), 4)

    def test_status_counts_and_a_sum(self):
        r = self.run_query(
            {
                "dataset": "attendance_days",
                "group_by": ["status"],
                "metrics": [{"fn": "count"}, {"fn": "sum", "field": "shifts_earned"}],
            },
            period="last_30_days",
        )
        by = {row["status"]: row for row in r["rows"]}
        self.assertEqual(by["present"], {"status": "present", "count": 2, "sum_shifts_earned": 2.0})
        self.assertEqual(by["absent"]["count"], 1)

    def test_scope_reaches_through_the_employee(self):
        r = self.run_query({"dataset": "attendance_days"}, period="last_90_days", department="Dsl Stitching")
        self.assertEqual(r["rows"], [{"count": 4}])
        r = self.run_query({"dataset": "attendance_days"}, period="last_90_days", type="staff")
        self.assertEqual(r["rows"], [{"count": 2}])


class OtherDatasets(Fixture):
    def test_salary_slips_sum_by_department(self):
        for n, (emp, net) in enumerate(((self.a, "20000.50"), (self.b, "10000"), (self.c, "5000"))):
            SalarySlip.objects.create(
                employee=emp,
                month=9,
                year=2026,
                slip_number=f"DSL{n}",
                net_salary=Decimal(net),
                gross_salary=Decimal(net),
            )
        r = self.run_query(
            {
                "dataset": "salary_slips",
                "group_by": ["department"],
                "metrics": [{"fn": "sum", "field": "net_salary"}, {"fn": "avg", "field": "net_salary"}],
                "filters": [
                    {"field": "year", "op": "eq", "value": "2026"},
                    {"field": "month", "op": "eq", "value": "9"},
                ],
            }
        )
        self.assertEqual(
            r["rows"][0], {"department": "Dsl Stitching", "sum_net_salary": 30000.5, "avg_net_salary": 15000.25}
        )
        self.assertEqual(r["rows"][1]["sum_net_salary"], 5000.0)

    def test_visits_know_only_the_unit_and_say_that_other_filters_do_not_apply(self):
        visitor = Visitor.objects.create(name="Guest", phone="1")
        VisitorVisit.objects.create(
            visitor=visitor, branch=self.u1, purpose="Vendor", visited_at=datetime.now(dt_timezone.utc)
        )
        r = self.run_query(
            {"dataset": "visits", "group_by": ["purpose"]}, department="Dsl Stitching", branch="Dsl Unit One"
        )
        self.assertEqual(r["rows"], [{"purpose": "Vendor", "count": 1}])
        self.assertTrue(any("do not apply" in n for n in r["notes"]))

    def test_audit_log_by_user_and_hour_of_day(self):
        AuditLog.objects.create(user_name="priya", action="update", module="payroll")
        AuditLog.objects.create(user_name="priya", action="delete", module="employees")
        AuditLog.objects.create(user_name="anand", action="login", module="auth")
        r = self.run_query({"dataset": "audit_logs", "group_by": ["user_name"]})
        self.assertEqual(r["rows"], [{"user_name": "priya", "count": 2}, {"user_name": "anand", "count": 1}])
        r = self.run_query({"dataset": "audit_logs", "group_by": ["created_at:hour"], "limit": 5})
        self.assertEqual(sum(row["count"] for row in r["rows"]), 3)

    def test_a_dataset_without_a_unit_ignores_scope_and_says_so(self):
        r = self.run_query({"dataset": "payroll_runs"}, branch="Dsl Unit One")
        self.assertTrue(any("do not apply" in n for n in r["notes"]))


class Refusals(Fixture):
    def refused(self, spec, fragment, **params):
        with self.assertRaises(MdParamError) as raised:
            self.run_query(spec, **params)
        self.assertIn(fragment, str(raised.exception))

    def test_unknown_things_are_refused_with_what_is_allowed(self):
        self.refused({"dataset": "passwords"}, "Datasets:")
        self.refused({"dataset": "employees", "group_by": ["salary"]}, "has no field 'salary'")
        self.refused(
            {"dataset": "employees", "filters": [{"field": "status", "op": "regex", "value": "a"}]},
            "Unknown filter operator",
        )
        self.refused({"dataset": "employees", "metrics": [{"fn": "median", "field": "status"}]}, "Unknown metric")

    def test_arithmetic_on_a_non_number_is_refused_and_the_numbers_are_listed(self):
        self.refused(
            {"dataset": "attendance_days", "metrics": [{"fn": "sum", "field": "status"}]}, "Measures: shifts_earned"
        )

    def test_a_date_part_only_applies_to_dates(self):
        self.refused({"dataset": "employees", "group_by": ["status:month"]}, "not a date")
        self.refused({"dataset": "attendance_days", "group_by": ["date:fortnight"]}, "can be grouped by")
        self.refused({"dataset": "attendance_days", "group_by": ["date:hour"]}, "no time of day")

    def test_limits_are_enforced(self):
        self.refused({"dataset": "employees", "group_by": ["department", "unit", "status"]}, "at most 2")
        self.refused(
            {"dataset": "employees", "filters": [{"field": "status", "op": "eq", "value": "a"}] * 9}, "at most 8"
        )
        self.refused({"dataset": "employees", "metrics": [{"fn": "count"}, {"fn": "count"}]}, "twice")
        self.refused(
            {"dataset": "employees", "order_by": {"by": "salary"}, "group_by": ["department"]}, "must be one of"
        )

    def test_bad_values_are_refused(self):
        self.refused(
            {"dataset": "attendance_days", "filters": [{"field": "date", "op": "eq", "value": "tomorrow"}]},
            "not a valid date",
        )
        self.refused({"dataset": "employees", "filters": [{"field": "status", "op": "eq"}]}, "needs a value")
        self.refused(
            {"dataset": "attendance_days", "filters": [{"field": "date", "op": "between", "values": ["2026-01-01"]}]},
            "exactly two",
        )
        self.refused(
            {"dataset": "employees", "filters": [{"field": "join_year", "op": "eq", "value": "2024"}]}, "for grouping"
        )

    def test_the_row_limit_is_capped_at_50(self):
        for i in range(60):
            Employee.objects.create(
                employee_code=f"BULK{i}",
                first_name="B",
                last_name="U",
                department=self.stitch,
                branch=self.u1,
                designation=None,
                join_date=f"20{i:02d}-01-01",
            )
        r = self.run_query({"dataset": "employees", "group_by": ["join_year"], "limit": 500})
        self.assertLessEqual(len(r["rows"]), 50)
        self.assertTrue(any("Showing the first" in n for n in r["notes"]))


class Catalog(TestCase):
    def test_every_dataset_is_described_for_the_model(self):
        text = Q.catalog_text()
        for name in Q.DATASETS:
            self.assertIn(f"- {name}:", text)

    def test_the_declaration_names_every_dataset_and_requires_one(self):
        decl = Q.query_declaration()
        self.assertEqual(decl["parameters"]["required"], ["dataset"])
        self.assertEqual(set(decl["parameters"]["properties"]["dataset"]["enum"]), set(Q.DATASETS))

    def test_the_period_helpers_agree_with_the_rest_of_the_portal(self):
        self.assertEqual(resolve_period({"period": "last_7_days"}).days, 7)
        self.assertTrue(resolve_scope({}).is_everyone())
        self.assertEqual(date.fromisoformat("2026-10-05").isoformat(), "2026-10-05")
