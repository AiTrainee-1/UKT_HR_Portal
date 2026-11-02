"""Mobile pages round 2026-10-31 (requests slice): GET /api/on-duty-sessions/mine, the employee's own On-Duty history.

Run: DATABASE_URL= DB_TEST_NAME=uktex_test_requests python manage.py test api.tests_mobile_requests
"""

from datetime import date, datetime, time
from datetime import timezone as dt_timezone
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from .geo_attendance_views import _on_duty_session_dict
from .jwt_utils import sign_token
from .mobile_requests_views import employee_status, month_bounds, parse_month
from .models import Branch, DutyTrack, Employee, HRUser, OnDutyPunchVerification, OnDutySession

UTC = dt_timezone.utc
URL = "/api/on-duty-sessions/mine"
TODAY = date(2026, 10, 31)


def employee_headers(emp: Employee) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


class MyOnDutySessionsTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Req Head Office", code="REQ-HO")
        self.emp = self.employee("REQ1", "Asha")
        self.other = self.employee("REQ2", "Ravi")
        patcher = mock.patch("api.mobile_requests_views.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def employee(self, code: str, first: str) -> Employee:
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="T",
            status="active",
            employment_type="staff",
            join_date="2020-01-01",
            branch=self.branch,
        )

    def session(self, emp=None, *, status=OnDutySession.STATUS_PENDING_HOD, created=None, **extra) -> OnDutySession:
        s = OnDutySession.objects.create(
            employee=emp or self.emp, destination="ABC Traders, Coimbatore", branch=self.branch, status=status, **extra
        )
        if created is not None:
            OnDutySession.objects.filter(pk=s.pk).update(created_at=created)
            s.refresh_from_db()
        return s

    def punch(self, s: OnDutySession, number: int, hhmm: str, status="pending") -> OnDutyPunchVerification:
        h, m = (int(x) for x in hhmm.split(":"))
        return OnDutyPunchVerification.objects.create(
            session=s,
            employee=s.employee,
            punch_date=TODAY,
            punch_time=time(h, m),
            punch_type="IN" if number % 2 else "OUT",
            punch_number=number,
            latitude=11.0,
            longitude=77.0,
            photo="on_duty/x.jpg",
            status=status,
        )

    def get(self, emp=None, **params):
        return self.client.get(URL, params, **employee_headers(emp or self.emp))

    # ── who may call it ──────────────────────────────────────────────────────

    def test_needs_a_login(self):
        self.assertEqual(self.client.get(URL).status_code, 401)

    def test_an_hr_token_is_refused(self):
        hr = HRUser.objects.create(username="req_admin", password_hash="x", is_super_admin=True, full_name="Admin")
        r = self.client.get(URL, HTTP_AUTHORIZATION=f"Bearer {sign_token({'role': 'hr', 'hrUserId': hr.id})}")
        self.assertEqual(r.status_code, 403)

    def test_only_the_employees_own_requests(self):
        mine = self.session()
        self.session(self.other)
        body = self.get().json()
        self.assertEqual([i["id"] for i in body["items"]], [mine.id])
        self.assertEqual(body["total"], 1)
        self.assertEqual(self.get(self.other).json()["total"], 1)

    def test_bad_paging_is_a_400(self):
        self.assertEqual(self.get(page="x").status_code, 400)

    # ── what each row says ───────────────────────────────────────────────────

    def test_row_carries_places_day_approval_punches_and_journey(self):
        created = datetime(2026, 10, 30, 4, 0, tzinfo=UTC)  # 09:30 IST
        s = self.session(status=OnDutySession.STATUS_ACTIVE, created=created, hr_reviewed_by="HR Priya")
        self.punch(s, 1, "09:40", "rejected")
        self.punch(s, 1, "09:45", "approved")  # a re-recorded punch: the latest capture wins
        self.punch(s, 2, "13:05", "approved")
        track = DutyTrack.objects.create(
            session=s,
            employee=self.emp,
            branch=self.branch,
            started_at=created,
            status=DutyTrack.STATUS_ENDED,
            ended_at=created,
            distance_m=12345.6,
        )
        item = self.get().json()["items"][0]
        self.assertEqual(item["destination"], "ABC Traders, Coimbatore")
        self.assertEqual(item["branchName"], "Req Head Office")
        self.assertEqual(item["date"], "2026-10-30")
        self.assertEqual(item["status"], "active")
        self.assertEqual(item["approvalStatus"], "active")
        self.assertFalse(item["isProvisional"])
        self.assertEqual(item["hrReviewedBy"], "HR Priya")
        self.assertEqual(
            [(p["punchNumber"], p["punchTime"], p["status"]) for p in item["punches"]],
            [(1, "09:45", "approved"), (2, "13:05", "approved")],
        )
        self.assertEqual(item["punchCount"], 2)
        self.assertEqual(item["journey"]["id"], track.id)
        self.assertEqual(item["journey"]["distanceM"], 12346)
        self.assertIn("steps", item["approval"])

    def test_no_journey_is_null(self):
        self.session()
        self.assertIsNone(self.get().json()["items"][0]["journey"])

    def test_the_day_is_the_india_date(self):
        # 20:00 UTC on 30 Oct is 01:30 IST on 31 Oct
        self.session(created=datetime(2026, 10, 30, 20, 0, tzinfo=UTC))
        self.assertEqual(self.get().json()["items"][0]["date"], "2026-10-31")

    def test_status_matches_what_the_status_endpoint_shows_the_employee(self):
        ended = timezone.now()
        cases = [
            self.session(status=OnDutySession.STATUS_PENDING_HOD),
            self.session(status=OnDutySession.STATUS_PENDING_HR, employee_ended_at=ended),
            self.session(status=OnDutySession.STATUS_ACTIVE),
            self.session(status=OnDutySession.STATUS_COMPLETED),
            self.session(status=OnDutySession.STATUS_REJECTED),
        ]
        for s in cases:
            self.assertEqual(employee_status(s), _on_duty_session_dict(s, for_employee=True)["status"], s.status)
        by_id = {i["id"]: i for i in self.get().json()["items"]}
        self.assertEqual(by_id[cases[0].id]["status"], "active")
        self.assertEqual(by_id[cases[0].id]["approvalStatus"], "pending_hod")
        self.assertEqual(by_id[cases[1].id]["status"], "completed")
        self.assertEqual(by_id[cases[1].id]["approvalStatus"], "pending_hr")

    # ── the four counts ──────────────────────────────────────────────────────

    def test_counts_cover_every_request_not_only_the_page(self):
        oct_ = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)
        sep = datetime(2026, 9, 10, 6, 0, tzinfo=UTC)
        self.session(status=OnDutySession.STATUS_PENDING_HOD, created=oct_)
        self.session(status=OnDutySession.STATUS_PENDING_HR, created=sep)
        self.session(status=OnDutySession.STATUS_ACTIVE, created=oct_)
        self.session(status=OnDutySession.STATUS_COMPLETED, created=sep)
        self.session(status=OnDutySession.STATUS_REJECTED, created=oct_)
        self.session(self.other, status=OnDutySession.STATUS_REJECTED, created=oct_)
        body = self.get(pageSize=1).json()
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["counts"], {"waiting": 2, "approved": 2, "rejected": 1, "month": 3})

    def test_sent_this_month_is_read_in_india_time(self):
        # 19:00 UTC on 30 Sep = 00:30 IST on 1 Oct -> this month; 19:00 UTC on 31 Oct = 00:30 IST on 1 Nov -> not.
        self.session(created=datetime(2026, 9, 30, 19, 0, tzinfo=UTC))
        self.session(created=datetime(2026, 9, 30, 18, 0, tzinfo=UTC))  # 23:30 IST on 30 Sep
        self.session(created=datetime(2026, 10, 31, 19, 0, tzinfo=UTC))
        self.assertEqual(self.get().json()["counts"]["month"], 1)

    def test_month_bounds_wrap_the_year(self):
        start, end = month_bounds(date(2026, 12, 15))
        self.assertEqual((start.year, start.month, end.year, end.month), (2026, 12, 2027, 1))

    # ── ?month=YYYY-MM (the app's month switcher, 2026-11-02) ───────────────

    def test_month_filter_lists_and_counts_only_that_month(self):
        sep = datetime(2026, 9, 10, 6, 0, tzinfo=UTC)
        oct_ = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)
        waiting = self.session(status=OnDutySession.STATUS_PENDING_HR, created=sep)
        done = self.session(status=OnDutySession.STATUS_COMPLETED, created=sep)
        refused = self.session(status=OnDutySession.STATUS_REJECTED, created=sep)
        self.session(status=OnDutySession.STATUS_PENDING_HOD, created=oct_)
        self.session(self.other, status=OnDutySession.STATUS_ACTIVE, created=sep)
        body = self.get(month="2026-09").json()
        self.assertEqual([i["id"] for i in body["items"]], [refused.id, done.id, waiting.id])
        self.assertEqual(body["total"], 3)
        self.assertFalse(body["hasMore"])
        # every request of the month, whatever its status, is the month count
        self.assertEqual(body["counts"], {"waiting": 1, "approved": 1, "rejected": 1, "month": 3})
        self.assertEqual(body["month"], "2026-09")

    def test_month_filter_reads_the_day_in_india_time(self):
        late_sep = self.session(created=datetime(2026, 9, 30, 18, 0, tzinfo=UTC))  # 23:30 IST on 30 Sep
        early_oct = self.session(created=datetime(2026, 9, 30, 19, 0, tzinfo=UTC))  # 00:30 IST on 1 Oct
        self.assertEqual([i["id"] for i in self.get(month="2026-09").json()["items"]], [late_sep.id])
        self.assertEqual([i["id"] for i in self.get(month="2026-10").json()["items"]], [early_oct.id])

    def test_month_filter_wraps_the_year(self):
        dec = self.session(created=datetime(2025, 12, 31, 12, 0, tzinfo=UTC))
        jan = self.session(created=datetime(2026, 1, 1, 6, 0, tzinfo=UTC))
        self.assertEqual([i["id"] for i in self.get(month="2025-12").json()["items"]], [dec.id])
        self.assertEqual([i["id"] for i in self.get(month="2026-01").json()["items"]], [jan.id])

    def test_month_filter_pages_within_the_month(self):
        ids = [self.session(created=datetime(2026, 8, d, 6, 0, tzinfo=UTC)).id for d in (1, 2, 3)]
        self.session(created=datetime(2026, 9, 1, 6, 0, tzinfo=UTC))
        first = self.get(month="2026-08", pageSize=2).json()
        self.assertEqual([i["id"] for i in first["items"]], [ids[2], ids[1]])
        self.assertTrue(first["hasMore"])
        second = self.get(month="2026-08", pageSize=2, page=2).json()
        self.assertEqual([i["id"] for i in second["items"]], [ids[0]])
        self.assertFalse(second["hasMore"])
        self.assertEqual(second["total"], 3)

    def test_an_empty_month_is_an_empty_list(self):
        self.session(created=datetime(2026, 10, 5, 6, 0, tzinfo=UTC))
        body = self.get(month="2026-03").json()
        self.assertEqual(body["items"], [])
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["counts"], {"waiting": 0, "approved": 0, "rejected": 0, "month": 0})

    def test_without_the_month_param_the_reply_is_unchanged(self):
        self.session(created=datetime(2026, 9, 10, 6, 0, tzinfo=UTC))
        body = self.get().json()
        self.assertNotIn("month", body)
        self.assertEqual(body["total"], 1)
        self.assertEqual(self.get(month="").json()["total"], 1)

    def test_a_bad_month_is_a_400(self):
        for bad in ("2026-13", "2026-00", "2026-9", "09-2026", "abc", "2026-09-01"):
            self.assertEqual(self.get(month=bad).status_code, 400, bad)

    def test_parse_month(self):
        self.assertEqual(parse_month("2026-09"), date(2026, 9, 1))
        self.assertEqual(parse_month(" 2026-12 "), date(2026, 12, 1))
        for bad in ("2026-13", "1899-05", "2026/09", ""):
            with self.assertRaises(ValueError):
                parse_month(bad)

    def test_month_filter_query_count_does_not_grow_with_rows(self):
        for d in range(1, 6):
            s = self.session(created=datetime(2026, 9, d, 6, 0, tzinfo=UTC))
            self.punch(s, 1, "09:00")
        headers = employee_headers(self.emp)
        with self.assertNumQueries(4):
            self.client.get(URL, {"month": "2026-09"}, **headers)

    # ── paging ───────────────────────────────────────────────────────────────

    def test_newest_first_and_pages(self):
        ids = [self.session(created=datetime(2026, 10, d, 6, 0, tzinfo=UTC)).id for d in (1, 2, 3)]
        first = self.get(pageSize=2).json()
        self.assertEqual([i["id"] for i in first["items"]], [ids[2], ids[1]])
        self.assertTrue(first["hasMore"])
        second = self.get(pageSize=2, page=2).json()
        self.assertEqual([i["id"] for i in second["items"]], [ids[0]])
        self.assertFalse(second["hasMore"])
        self.assertEqual(second["total"], 3)

    def test_page_size_is_capped(self):
        self.session()
        self.assertEqual(self.get(pageSize=5000).json()["pageSize"], 100)

    def test_query_count_does_not_grow_with_rows(self):
        for d in range(1, 6):
            s = self.session(created=datetime(2026, 10, d, 6, 0, tzinfo=UTC))
            self.punch(s, 1, "09:00")
        headers = employee_headers(self.emp)
        with self.assertNumQueries(4):  # counts, rows (+branch, track), punches, approval config
            self.client.get(URL, **headers)
