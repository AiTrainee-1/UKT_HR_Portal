"""The MD analytics contract (md_portal/common.py): periods, scope resolution, the response envelope, caching and the
read-only endpoint decorator."""

from datetime import date

from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIRequestFactory

from .jwt_utils import sign_token
from .md_portal import common as C
from .models import Branch, Department, Employee, HRUser

MONDAY = date(2026, 10, 5)  # a Monday


class PeriodTests(SimpleTestCase):
    def period(self, **params):
        return C.resolve_period(params, today=MONDAY)

    def test_the_presets(self):
        cases = {
            "today": ("2026-10-05", "2026-10-05"),
            "yesterday": ("2026-10-04", "2026-10-04"),
            "last_7_days": ("2026-09-29", "2026-10-05"),
            "last_30_days": ("2026-09-06", "2026-10-05"),
            "last_90_days": ("2026-07-08", "2026-10-05"),
            "this_week": ("2026-10-05", "2026-10-05"),  # a week starts on Monday and today is Monday
            "last_week": ("2026-09-28", "2026-10-04"),
            "this_month": ("2026-10-01", "2026-10-05"),
            "last_month": ("2026-09-01", "2026-09-30"),
            "last_12_months": ("2025-11-01", "2026-10-05"),
            "this_year": ("2026-01-01", "2026-10-05"),
        }
        for preset, (start, end) in cases.items():
            p = self.period(period=preset)
            self.assertEqual((p.start.isoformat(), p.end.isoformat()), (start, end), preset)
            self.assertEqual(p.preset, preset)
            self.assertTrue(p.label)

    def test_the_default_is_the_last_30_days(self):
        self.assertEqual(self.period().preset, "last_30_days")
        self.assertEqual(C.resolve_period({}, default="this_month", today=MONDAY).preset, "this_month")

    def test_a_whole_month(self):
        p = self.period(month="2026-02")
        self.assertEqual((p.start.isoformat(), p.end.isoformat(), p.label), ("2026-02-01", "2026-02-28", "Feb 2026"))
        self.assertEqual(self.period(month="2026-12").end.isoformat(), "2026-12-31")

    def test_a_custom_range_and_its_label(self):
        p = self.period(**{"from": "2026-09-01", "to": "2026-09-15"})
        self.assertEqual((p.preset, p.days, p.label), ("custom", 15, "01 Sep – 15 Sep 2026"))
        self.assertEqual(self.period(**{"from": "2026-09-01", "to": "2026-09-01"}).label, "01 Sep 2026")
        across = self.period(**{"from": "2025-12-20", "to": "2026-01-05"})
        self.assertEqual(across.label, "20 Dec 2025 – 05 Jan 2026")

    def test_unusable_requests_say_why(self):
        bad = [
            ({"period": "fortnight"}, "Unknown period"),
            ({"from": "2026-09-01"}, "both"),
            ({"from": "2026-09-10", "to": "2026-09-01"}, "before"),
            ({"from": "yesterday", "to": "today"}, "not a date"),
            ({"month": "2026-13"}, "not a month"),
            ({"month": "September"}, "not a month"),
            ({"from": "2020-01-01", "to": "2026-01-01"}, "most one request covers"),
        ]
        for params, text in bad:
            with self.assertRaises(C.MdParamError, msg=str(params)) as ctx:
                self.period(**params)
            self.assertIn(text, str(ctx.exception))

    def test_the_previous_period_is_the_same_length_just_before(self):
        p = self.period(**{"from": "2026-09-10", "to": "2026-09-19"})
        prev = p.previous()
        self.assertEqual((prev.start.isoformat(), prev.end.isoformat(), prev.days), ("2026-08-31", "2026-09-09", 10))
        one = self.period(period="today").previous()
        self.assertEqual((one.start.isoformat(), one.end.isoformat()), ("2026-10-04", "2026-10-04"))

    def test_the_months_a_period_touches(self):
        p = self.period(**{"from": "2026-08-20", "to": "2026-10-02"})
        self.assertEqual(p.months(), [(2026, 8), (2026, 9), (2026, 10)])

    def test_month_arithmetic(self):
        self.assertEqual(C.add_months(2026, 1, -1), (2025, 12))
        self.assertEqual(C.add_months(2026, 11, 3), (2027, 2))
        self.assertEqual(C.last_n_months(3, MONDAY), [(2026, 8), (2026, 9), (2026, 10)])
        self.assertEqual(len(C.last_n_months(12, MONDAY)), 12)
        self.assertEqual(C.last_n_months(12, MONDAY)[0], (2025, 11))
        self.assertEqual(C.month_bounds(2024, 2)[1].day, 29)
        self.assertEqual(C.month_label(2026, 9), "Sep 2026")

    def test_to_json_is_what_the_screen_gets(self):
        j = self.period(period="last_7_days").to_json()
        self.assertEqual(set(j), {"start", "end", "preset", "label", "days"})
        self.assertEqual(j["days"], 7)


class NumbersTests(SimpleTestCase):
    def test_percentages_and_missing_data(self):
        self.assertEqual(C.pct(1, 3), 33.3)
        self.assertEqual(C.pct(1, 3, digits=0), 33.0)
        self.assertIsNone(C.pct(5, 0))  # no whole: not "0%"
        self.assertIsNone(C.pct(None, 10))

    def test_change_against_a_previous_figure(self):
        self.assertEqual(C.change(110, 100), {"abs": 10.0, "pct": 10.0})
        self.assertEqual(C.change(80, 100), {"abs": -20.0, "pct": -20.0})
        self.assertEqual(C.change(5, 0), {"abs": 5.0, "pct": None})
        self.assertIsNone(C.change(None, 5))
        self.assertIsNone(C.change(5, None))

    def test_money_is_two_places_and_never_none(self):
        self.assertEqual(C.money(None), 0.0)
        self.assertEqual(C.money("12.345"), 12.35)


class EnvelopeTests(SimpleTestCase):
    def test_the_envelope_carries_period_scope_provenance_and_notes(self):
        period = C.resolve_period({"period": "today"}, today=MONDAY)
        scope = C.Scope(notes=["Matched department 'stiching' to 'Stitching'."])
        out = C.envelope(
            {"value": 1},
            period=period,
            scope=scope,
            provenance=[C.prov("x", "X", dataset="D", definition="what", formula="a / b", rows=4)],
            notes=["extra"],
        )
        self.assertEqual(out["value"], 1)
        self.assertEqual(out["period"]["preset"], "today")
        self.assertEqual(out["scope"]["description"], "All units · all departments · staff and production")
        self.assertEqual(out["provenance"][0]["formula"], "a / b")
        self.assertEqual(out["notes"], ["Matched department 'stiching' to 'Stitching'.", "extra"])
        self.assertIn("generatedAt", out)

    def test_provenance_defaults(self):
        p = C.prov("id", "Title", dataset="Data", definition="Def")
        self.assertEqual((p["formula"], p["rows"], p["filters"], p["caveats"]), (None, None, [], []))

    def test_the_cache_serves_a_value_until_it_expires(self):
        cache = C.TtlCache()
        calls = []
        self.assertEqual(cache.get_or_compute("k", 60, lambda: calls.append(1) or "v"), "v")
        self.assertEqual(cache.get_or_compute("k", 60, lambda: calls.append(1) or "w"), "v")
        self.assertEqual(len(calls), 1)
        self.assertEqual(cache.get_or_compute("k", 0, lambda: "fresh"), "fresh")  # ttl 0 never caches

    def test_the_decorator_never_caches_in_tests(self):
        calls = []

        @C.cached(ttl=60)
        def fn(period):
            calls.append(1)
            return len(calls)

        p = C.resolve_period({"period": "today"}, today=MONDAY)
        self.assertEqual((fn(p), fn(p)), (1, 2))


class ScopeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit1", code="TU1")
        cls.ho = Branch.objects.create(name="Unit2", code="TU2")
        cls.stitch1 = Department.objects.create(name="Stitching", branch=cls.u1)
        cls.stitch2 = Department.objects.create(name="Stitching", branch=cls.ho)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        mk = lambda code, dept, branch, **kw: Employee.objects.create(  # noqa: E731
            employee_code=code, first_name=code, last_name="T", department=dept, branch=branch, **kw
        )
        cls.a = mk("A", cls.stitch1, cls.u1, employment_type="staff")
        cls.b = mk("B", cls.stitch2, cls.ho, employment_type="production")
        cls.c = mk("C", cls.cutting, cls.u1, employment_type="production")
        cls.gone = mk("D", cls.cutting, cls.u1, status="inactive")

    def codes(self, scope, **kw):
        return sorted(scope.employees(**kw).values_list("employee_code", flat=True))

    def test_nothing_asked_means_everyone_active(self):
        scope = C.resolve_scope({})
        self.assertTrue(scope.is_everyone())
        self.assertEqual(self.codes(scope), ["A", "B", "C"])
        self.assertEqual(self.codes(scope, active=None), ["A", "B", "C", "D"])
        self.assertEqual(self.codes(scope, active=False), ["D"])
        self.assertEqual(scope.describe(), "All units · all departments · staff and production")

    def test_a_unit_by_name_or_id(self):
        self.assertEqual(self.codes(C.resolve_scope({"branch": "unit1"})), ["A", "C"])
        self.assertEqual(self.codes(C.resolve_scope({"branch": str(self.ho.id)})), ["B"])
        self.assertEqual(self.codes(C.resolve_scope({"branch": "all"})), ["A", "B", "C"])

    def test_a_department_name_covers_every_unit_that_has_one(self):
        scope = C.resolve_scope({"department": "Stitching"})
        self.assertEqual(sorted(scope.department_ids), sorted([self.stitch1.id, self.stitch2.id]))
        self.assertEqual(self.codes(scope), ["A", "B"])
        narrowed = C.resolve_scope({"department": "Stitching", "branch": "Unit1"})
        self.assertEqual(self.codes(narrowed), ["A"])

    def test_a_typo_is_matched_and_the_assumption_is_reported(self):
        scope = C.resolve_scope({"department": "stiching"})
        self.assertEqual(scope.labels["department"], "Stitching")
        self.assertEqual(scope.notes, ["Matched department 'stiching' to 'Stitching'."])
        self.assertEqual(C.resolve_scope({"department": "STITCHING"}).notes, [])  # exact ignoring case: no note

    def test_the_type(self):
        self.assertEqual(self.codes(C.resolve_scope({"type": "production"})), ["B", "C"])
        self.assertEqual(self.codes(C.resolve_scope({"employmentType": "Staff"})), ["A"])
        self.assertEqual(
            C.resolve_scope({"type": "production"}).describe(), "All units · all departments · production only"
        )

    def test_what_cannot_be_matched_says_what_exists(self):
        with self.assertRaises(C.MdParamError) as ctx:
            C.resolve_scope({"department": "Quantum Physics"})
        self.assertIn("No department called 'Quantum Physics'", str(ctx.exception))
        self.assertIn("Stitching", str(ctx.exception))
        with self.assertRaises(C.MdParamError):
            C.resolve_scope({"branch": "Nowhere"})
        with self.assertRaises(C.MdParamError):
            C.resolve_scope({"branch": "9999"})
        with self.assertRaises(C.MdParamError):
            C.resolve_scope({"type": "contract"})

    def test_the_q_works_through_a_relation_too(self):
        from .models import AttendanceDayRecord

        AttendanceDayRecord.objects.create(employee=self.a, date=MONDAY, status="present")
        AttendanceDayRecord.objects.create(employee=self.b, date=MONDAY, status="present")
        scope = C.resolve_scope({"branch": "Unit1"})
        n = AttendanceDayRecord.objects.filter(scope.employee_q("employee__")).count()
        self.assertEqual(n, 1)
        self.assertEqual(AttendanceDayRecord.objects.filter(C.Scope().employee_q("employee__")).count(), 2)


class EndpointDecoratorTests(TestCase):
    def setUp(self):
        self.md = HRUser.objects.create(username="md", password_hash="x", is_md=True)
        self.other = HRUser.objects.create(username="other", password_hash="x", is_super_admin=True)
        self.factory = APIRequestFactory()

        @C.md_get
        def view(request):
            period = C.resolve_period(C.request_params(request), today=MONDAY)
            return C.envelope({"ok": True}, period=period)

        self.view = view

    def call(self, user, method="get", **params):
        token = sign_token({"role": "hr", "hrUserId": user.id}) if user else None
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        request = getattr(self.factory, method)("/api/md/x", params, **extra)
        return self.view(request)

    def test_the_md_gets_a_result_with_timing(self):
        r = self.call(self.md, period="last_7_days")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["period"]["days"], 7)
        self.assertIn("tookMs", r.data)

    def test_a_bad_parameter_is_a_400_with_the_reason(self):
        r = self.call(self.md, period="fortnight")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Unknown period", r.data["error"])

    def test_nobody_else_gets_in_and_only_get_is_allowed(self):
        self.assertEqual(self.call(self.other).status_code, 403)
        self.assertEqual(self.call(None).status_code, 401)
        self.assertEqual(self.call(self.md, method="post").status_code, 405)


class EnvelopeNotes(SimpleTestCase):
    def test_a_note_raised_twice_is_shown_once_in_the_order_first_met(self):
        scope = C.Scope(notes=["Matched unit 'unit1' to 'Unit1'."])
        out = C.envelope(
            {},
            scope=scope,
            notes=["Today is provisional.", "Matched unit 'unit1' to 'Unit1'.", "Today is provisional."],
        )
        self.assertEqual(out["notes"], ["Matched unit 'unit1' to 'Unit1'.", "Today is provisional."])


class ReadOnlyGuaranteeTests(TestCase):
    """The database itself refuses a write inside read_only_db(), so no MD view or assistant tool can change data."""

    def test_a_write_inside_the_guard_is_refused_by_the_database(self):
        with self.assertRaises(DatabaseError):
            with C.read_only_db():
                Branch.objects.create(name="Should Not Exist", code="NOPE")
        self.assertFalse(Branch.objects.filter(code="NOPE").exists())

    def test_reads_work_and_writes_work_again_afterwards(self):
        Branch.objects.create(name="Readable", code="RD1")
        with C.read_only_db():
            self.assertTrue(Branch.objects.filter(code="RD1").exists())
        Branch.objects.create(name="Writable Again", code="WR1")  # the setting did not outlive the block
        self.assertTrue(Branch.objects.filter(code="WR1").exists())

    def test_a_failed_block_leaves_the_connection_usable(self):
        with self.assertRaises(RuntimeError):
            with C.read_only_db():
                raise RuntimeError("boom")
        Branch.objects.create(name="After Boom", code="AB1")
        self.assertTrue(Branch.objects.filter(code="AB1").exists())

    def test_a_view_that_tries_to_write_fails_loudly_instead_of_changing_data(self):
        @C.md_get
        def writes(request):
            Branch.objects.create(name="Sneaky", code="SN1")
            return {}

        md = HRUser.objects.create(username="ro_md", password_hash="x", full_name="MD", is_md=True)
        token = sign_token({"role": "hr", "hrUserId": md.id})
        request = APIRequestFactory().get("/api/md/x", HTTP_AUTHORIZATION=f"Bearer {token}")
        with self.assertRaises(DatabaseError):
            writes(request)
        self.assertFalse(Branch.objects.filter(code="SN1").exists())
