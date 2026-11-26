"""
The HR portal's one date filter (owner brief 2026-11-24: Today / Yesterday / This Month / Custom on Requests, Geo
Attendance and Gate Pass / Visitors): the optional `from` / `to` (YYYY-MM-DD, India days, both included) added to the
lists those pages read. Every list filters by the day each record is FOR, its counts follow the days, and without the two
params every list answers exactly as before.

Run via: DB_TEST_NAME=test_uktex_datef python manage.py test api.tests_date_range_filters --noinput
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APIRequestFactory

from .clock import FACTORY_TZ, ist_today
from .date_span import DaySpan, DaySpanError, parse_day_span
from .models import (
    DutyTrack,
    EmployeePermission,
    LeaveRequest,
    LiveLocationPing,
    OnDutyPunchVerification,
    OnDutySession,
    OutpassRecord,
    OutpassRequest,
)
from .tests_geo_tracking_support import T0, GeoBase
from .tests_hr_requests import HubFixture, _bearer
from .tests_visitor_admin import Fixture as VisitorFixture


def ist(y: int, m: int, d: int, hh: int = 10, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=FACTORY_TZ)


def params(**kw) -> dict:
    return APIRequestFactory().get("/", kw).GET


# ═══ the parser ══════════════════════════════════════════════════════════════════════════════════════════════════


class DaySpanTests(SimpleTestCase):
    def test_no_params_means_no_filter(self):
        self.assertIsNone(parse_day_span(params()))
        self.assertIsNone(parse_day_span(params(**{"from": "", "to": " "})))

    def test_days_are_india_days_both_included(self):
        span = parse_day_span(params(**{"from": "2026-11-03", "to": "2026-11-09"}))
        self.assertEqual((span.start, span.end), (date(2026, 11, 3), date(2026, 11, 9)))
        lo, hi = span.bounds()
        self.assertEqual(lo, ist(2026, 11, 3, 0))
        self.assertEqual(hi, ist(2026, 11, 10, 0))  # the start of the day after the last one
        self.assertTrue(span.has(date(2026, 11, 9)))
        self.assertFalse(span.has(date(2026, 11, 10)))
        self.assertEqual(span.as_json(), {"from": "2026-11-03", "to": "2026-11-09"})

    def test_either_end_may_be_open(self):
        span = parse_day_span(params(**{"from": "2026-11-03"}))
        self.assertEqual(span.bounds()[1], None)
        self.assertTrue(span.has(date(2030, 1, 1)))
        self.assertEqual(parse_day_span(params(to="2026-11-03")).bounds()[0], None)

    def test_a_bad_day_or_a_backwards_span_is_refused(self):
        for bad in ({"from": "2026-13-01"}, {"to": "yesterday"}, {"from": "2026-11-09", "to": "2026-11-03"}):
            with self.assertRaises(DaySpanError, msg=bad):
                parse_day_span(params(**bad))

    def test_today_is_known(self):
        self.assertTrue(DaySpan(ist_today(), ist_today()).has_today)
        self.assertFalse(DaySpan(date(2020, 1, 1), date(2020, 1, 31)).has_today)


# ═══ GET /api/hr-requests ════════════════════════════════════════════════════════════════════════════════════════

MADE_ON = ist(2026, 11, 3)  # the day the "made on" kinds are dated to below


class RequestsHubDateTests(HubFixture):
    def setUp(self):
        super().setUp()
        self.made = self.one_of_each()
        # On-Duty, outpass, general request, resignation and advance are for the day they were made
        for key in ("on_duty", "outpass", "request", "resignation", "advance"):
            obj = self.made[key]
            type(obj).objects.filter(pk=obj.pk).update(created_at=MADE_ON)

    def kinds(self, **p) -> list[str]:
        return sorted(i["kind"] for i in self.body(page=1, pageSize=50, **p)["items"])

    def test_a_request_is_listed_by_the_days_it_is_for(self):
        # leave 12-14 Oct, permission 12 Oct, casual leave 13 Oct, missing punch 9 Oct, On-Duty punch 9 Oct,
        # attendance correction 8 Oct, compensation claim 4 Oct, Birthday Compensation placed on 7 Oct
        self.assertEqual(self.kinds(**{"from": "2026-10-12", "to": "2026-10-12"}), ["leave", "permission"])
        # a leave counts on any of its days
        self.assertEqual(self.kinds(**{"from": "2026-10-14", "to": "2026-10-20"}), ["leave"])
        self.assertEqual(
            self.kinds(**{"from": "2026-10-01", "to": "2026-10-31"}),
            sorted(
                [
                    "leave",
                    "permission",
                    "casual_leave",
                    "missing_punch",
                    "on_duty_punch",
                    "attendance_correction",
                    "holiday_work",
                    "birthday_compensation",
                ]
            ),
        )
        # the kinds that are for the day they were made (a resignation's last working day, 30 Nov, does not count)
        self.assertEqual(
            self.kinds(**{"from": "2026-11-03", "to": "2026-11-03"}),
            sorted(["on_duty", "outpass", "request", "resignation", "advance"]),
        )
        self.assertEqual(self.kinds(**{"from": "2026-11-30", "to": "2026-11-30"}), [])

    def test_the_made_on_day_is_an_india_day(self):
        outpass = self.made["outpass"]
        OutpassRequest.objects.filter(pk=outpass.pk).update(created_at=ist(2026, 11, 2, 23, 50))
        self.assertNotIn("outpass", self.kinds(**{"from": "2026-11-03", "to": "2026-11-03"}))
        OutpassRequest.objects.filter(pk=outpass.pk).update(created_at=ist(2026, 11, 3, 0, 5))  # 2 Nov in UTC
        self.assertIn("outpass", self.kinds(**{"from": "2026-11-03", "to": "2026-11-03"}))

    def test_one_open_end_and_the_old_whole_list_take_it_too(self):
        self.assertEqual(self.kinds(**{"from": "2026-10-13"}), self.kinds(**{"from": "2026-10-13", "to": "2026-12-31"}))
        old = self.body(**{"from": "2026-10-12", "to": "2026-10-12"})  # no page: the old whole-list shape
        self.assertEqual(sorted(i["kind"] for i in old["items"]), ["leave", "permission"])
        self.assertNotIn("total", old)

    def test_the_figures_and_the_tab_counts_follow_the_days(self):
        EmployeePermission.objects.filter(pk=self.made["permission"].pk).update(status="approved")
        LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-12", end_date="2026-10-12", type="casual", status="rejected"
        )
        body = self.body(page=1, pageSize=50, **{"from": "2026-10-12", "to": "2026-10-12"})
        stats = body["stats"]
        self.assertEqual(stats["range"], {"from": "2026-10-12", "to": "2026-10-12"})
        # waiting for those days: the leave only (the permission is decided now)
        self.assertEqual(stats["waiting"], 1)
        self.assertEqual(stats["approvedThisMonth"], 1)  # the requests for the days that ended approved / rejected
        self.assertEqual(stats["rejectedThisMonth"], 1)
        # the other eleven waiting requests are for other days: counted apart, the earliest is the 4 Oct claim
        self.assertEqual((stats["allWaiting"], stats["outsideWaiting"]), (12, 11))
        self.assertEqual(stats["outsideEarliest"], "2026-10-04")
        self.assertEqual(stats["oldestWaiting"]["kind"], "leave")
        waiting = {k["key"]: k["waiting"] for k in body["kinds"]}
        self.assertEqual(waiting["leave"], 1)
        self.assertEqual(waiting["casual_leave"], 0)
        self.assertEqual(sum(waiting.values()), stats["waiting"])

    def test_without_the_days_everything_is_as_before(self):
        body = self.body(page=1, pageSize=50)
        self.assertEqual(body["total"], 13)
        for key in ("range", "allWaiting", "outsideWaiting", "outsideEarliest"):
            self.assertNotIn(key, body["stats"])
        self.assertEqual(body["stats"]["waiting"], 13)
        self.assertEqual(sum(k["waiting"] for k in body["kinds"]), 13)

    def test_a_linked_request_still_comes_back_from_another_day(self):
        key = f"leave-{self.made['leave'].id}"
        body = self.body(page=1, pageSize=5, focus=key, **{"from": "2026-11-03", "to": "2026-11-03"})
        self.assertNotIn(key, [i["key"] for i in body["items"]])
        self.assertEqual(body["focusItem"]["key"], key)

    def test_bad_days_are_refused(self):
        self.assertEqual(self.get(**{"from": "2026-02-30"}).status_code, 400)
        self.assertEqual(self.get(page=1, **{"from": "2026-11-09", "to": "2026-11-03"}).status_code, 400)


# ═══ Geo Attendance: On-Duty requests, punches, the On-Duty Map and the day map ═══════════════════════════════════


class OnDutyListDateTests(GeoBase):
    def setUp(self):
        super().setUp()
        self.nov3 = self.make_session(self.asha, created=ist(2026, 11, 3))
        self.nov3_early = self.make_session(self.meena, created=ist(2026, 11, 3, 0, 10))  # 2 Nov in UTC
        self.oct28 = self.make_session(self.ravi, created=ist(2026, 10, 28))
        self.done = self.make_session(self.asha, status=OnDutySession.STATUS_COMPLETED, created=ist(2026, 11, 5))

    def ids(self, url: str, **p) -> list[int]:
        res = self.as_hr(self.hr_super, "get", url, **p)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return sorted(row["id"] for row in res.json())

    def test_requests_by_the_day_they_were_made(self):
        url = "/api/on-duty-sessions"
        self.assertEqual(
            self.ids(url, status="pending", **{"from": "2026-11-03", "to": "2026-11-03"}),
            sorted([self.nov3.id, self.nov3_early.id]),
        )
        self.assertEqual(
            self.ids(url, status="all", **{"from": "2026-11-01", "to": "2026-11-30"}),
            sorted([self.nov3.id, self.nov3_early.id, self.done.id]),
        )
        self.assertEqual(self.ids(url, status="pending", **{"from": "2026-10-28", "to": "2026-10-28"}), [self.oct28.id])
        # without the days: every pending request, as before
        self.assertEqual(self.ids(url), sorted([self.nov3.id, self.nov3_early.id, self.oct28.id]))
        self.assertEqual(self.as_hr(self.hr_super, "get", url, **{"from": "nope"}).status_code, 400)

    def test_punches_by_their_punch_date(self):
        def punch(session, day):
            return OnDutyPunchVerification.objects.create(
                session=session,
                employee=session.employee,
                punch_date=day,
                punch_time=datetime(2026, 1, 1, 9, 30).time(),
                punch_type="IN",
                punch_number=1,
                latitude=11.1,
                longitude=77.3,
                photo="on_duty_punch_verifications/x.jpg",
            )

        a = punch(self.nov3, date(2026, 11, 3))
        b = punch(self.oct28, date(2026, 10, 28))
        url = "/api/on-duty-punch-verifications"
        self.assertEqual(self.ids(url, **{"from": "2026-11-01", "to": "2026-11-30"}), [a.id])
        self.assertEqual(self.ids(url, **{"to": "2026-10-31"}), [b.id])
        self.assertEqual(self.ids(url), sorted([a.id, b.id]))
        self.assertEqual(self.as_hr(self.hr_super, "get", url, to="31-10-2026").status_code, 400)


class OnDutyMapDateTests(GeoBase):
    URL = "/api/on-duty-map"

    def setUp(self):
        super().setUp()
        self.asha_27 = self.make_session(self.asha, created=ist(2026, 10, 27))
        self.asha_28 = self.make_session(self.asha, created=ist(2026, 10, 28))
        self.ravi_28 = self.make_session(self.ravi, created=ist(2026, 10, 28))
        # still active from long ago: on the map only when the days include today
        self.meena_old = self.make_session(self.meena, status=OnDutySession.STATUS_ACTIVE, created=ist(2026, 9, 1))

    def body(self, **p) -> dict:
        res = self.as_hr(self.hr_super, "get", self.URL, **p)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res.json()

    def test_several_days_one_entry_per_employee_with_their_latest_request(self):
        body = self.body(**{"from": "2026-10-27", "to": "2026-10-28"})
        self.assertEqual((body["from"], body["to"], body["date"]), ("2026-10-27", "2026-10-28", "2026-10-28"))
        by_emp = {e["employeeId"]: e for e in body["employees"]}
        self.assertEqual(set(by_emp), {self.asha.id, self.ravi.id})
        self.assertEqual(by_emp[self.asha.id]["session"]["id"], self.asha_28.id)
        self.assertEqual((by_emp[self.asha.id]["days"], by_emp[self.ravi.id]["days"]), (2, 1))

    def test_a_session_still_active_shows_when_the_days_include_today(self):
        today = ist_today().isoformat()
        ids = {e["employeeId"] for e in self.body(**{"from": "2026-10-27", "to": today})["employees"]}
        self.assertIn(self.meena.id, ids)

    def test_the_old_single_day_answer_is_unchanged(self):
        body = self.body(date="2026-10-28")
        self.assertEqual(body["date"], "2026-10-28")
        self.assertNotIn("from", body)
        self.assertTrue(all("days" not in e for e in body["employees"]))
        self.assertEqual(self.as_hr(self.hr_super, "get", self.URL, **{"from": "x"}).status_code, 400)

    def test_one_employees_route_over_the_days(self):
        def ping(at):
            p = LiveLocationPing.objects.create(employee=self.asha, latitude=11.1, longitude=77.3)
            LiveLocationPing.objects.filter(pk=p.pk).update(recorded_at=at)

        now = timezone.now()
        ping(now - timedelta(days=1))
        ping(now)
        today = ist_today()
        url = f"/api/live-location/team/{self.asha.id}/route"
        both = self.as_hr(
            self.hr_super, "get", url, **{"from": (today - timedelta(days=2)).isoformat(), "to": today.isoformat()}
        ).json()
        self.assertEqual(len(both["points"]), 2)
        self.assertEqual((both["to"], both["date"]), (today.isoformat(), today.isoformat()))
        one = self.as_hr(self.hr_super, "get", url, date=today.isoformat()).json()
        self.assertEqual(len(one["points"]), 1)
        self.assertNotIn("from", one)


class DayMapDateTests(GeoBase):
    URL = "/api/tracking/journeys/day-map"

    def setUp(self):
        super().setUp()
        self.on_28 = self.make_track(self.asha, T0, ended_at=T0 + timedelta(hours=2))  # 28 Oct 10:00 IST
        self.on_27 = self.make_track(self.meena, T0 - timedelta(days=1), ended_at=T0 - timedelta(days=1, hours=-1))
        # 26 Oct 23:00 IST to 27 Oct 01:00 IST: recording on both days
        self.night = self.make_track(
            self.ravi, ist(2026, 10, 26, 23), ended_at=ist(2026, 10, 27, 1), end_reason=DutyTrack.END_MANUAL
        )
        self.on_20 = self.make_track(self.asha, T0 - timedelta(days=8), ended_at=T0 - timedelta(days=8, hours=-1))

    def ids(self, **p) -> tuple[set, dict]:
        res = self.as_hr(self.hr_super, "get", self.URL, **p)
        self.assertEqual(res.status_code, 200, res.content[:300])
        body = res.json()
        return {j["id"] for j in body["journeys"]}, body

    def test_every_journey_recording_on_any_of_the_days(self):
        ids, body = self.ids(**{"from": "2026-10-27", "to": "2026-10-28"})
        self.assertEqual(ids, {self.on_28.id, self.on_27.id, self.night.id})
        self.assertEqual(
            (body["from"], body["to"], body["date"], body["truncated"]),
            ("2026-10-27", "2026-10-28", "2026-10-28", False),
        )
        ids, _ = self.ids(**{"from": "2026-10-26", "to": "2026-10-26"})
        self.assertEqual(ids, {self.night.id})

    def test_the_latest_journeys_when_there_are_too_many(self):
        from .geo_tracking import hr_views

        old = hr_views.SPAN_MAP_MAX_JOURNEYS
        hr_views.SPAN_MAP_MAX_JOURNEYS = 2
        try:
            ids, body = self.ids(**{"from": "2026-10-01", "to": "2026-10-31"})
        finally:
            hr_views.SPAN_MAP_MAX_JOURNEYS = old
        self.assertTrue(body["truncated"])
        self.assertEqual(ids, {self.on_28.id, self.on_27.id})

    def test_the_old_one_day_answer_is_unchanged(self):
        ids, body = self.ids(date="2026-10-28")
        self.assertEqual(ids, {self.on_28.id})
        self.assertNotIn("from", body)
        self.assertNotIn("truncated", body)
        self.assertEqual(
            self.as_hr(self.hr_super, "get", self.URL, **{"from": "2026-10-28", "to": "2026-10-01"}).status_code, 400
        )


# ═══ Gate Pass: the passes and the QR-form exits ═════════════════════════════════════════════════════════════════


class GatePassDateTests(HubFixture):
    def setUp(self):
        super().setUp()

        def outpass(created, exited=None):
            req = OutpassRequest.objects.create(
                employee=self.asha, destination="Bank", reason="x", source="manual", approval_trail=[]
            )
            OutpassRequest.objects.filter(pk=req.pk).update(created_at=created, exited_at=exited)
            return req

        self.asked_3_out_4 = outpass(ist(2026, 11, 3, 18), ist(2026, 11, 4, 9))
        self.asked_3 = outpass(ist(2026, 11, 3, 11))
        self.october = outpass(ist(2026, 10, 20))

        def record(at):
            rec = OutpassRecord.objects.create(
                employee_name="X", employee_code="E1", destination="Bank", branch=self.ho
            )
            OutpassRecord.objects.filter(pk=rec.pk).update(submitted_at=at)
            return rec

        self.rec_3 = record(ist(2026, 11, 3, 9))
        self.rec_3_early = record(ist(2026, 11, 3, 0, 15))  # 2 Nov in UTC
        self.rec_oct = record(ist(2026, 10, 30))

    def ids(self, url: str, **p) -> list[int]:
        res = self.client.get(url, p, **_bearer(self.admin))
        self.assertEqual(res.status_code, 200, res.content[:300])
        body = res.json()
        rows = body["items"] if isinstance(body, dict) else body
        return sorted(r["id"] for r in rows)

    def test_a_pass_is_for_its_out_day_or_the_day_it_was_asked(self):
        url = "/api/outpass-requests"
        self.assertEqual(self.ids(url, **{"from": "2026-11-04", "to": "2026-11-04"}), [self.asked_3_out_4.id])
        self.assertEqual(self.ids(url, **{"from": "2026-11-03", "to": "2026-11-03"}), [self.asked_3.id])
        self.assertEqual(
            self.ids(url, **{"from": "2026-11-01", "to": "2026-11-30"}),
            sorted([self.asked_3_out_4.id, self.asked_3.id]),
        )
        # without the days: every pass, as before
        self.assertEqual(self.ids(url), sorted([self.asked_3_out_4.id, self.asked_3.id, self.october.id]))
        self.assertEqual(self.client.get(url, {"from": "x"}, **_bearer(self.admin)).status_code, 400)

    def test_qr_form_exits_by_the_india_day_they_were_logged(self):
        url = "/api/outpass/records"
        self.assertEqual(
            self.ids(url, **{"from": "2026-11-03", "to": "2026-11-03"}), sorted([self.rec_3.id, self.rec_3_early.id])
        )
        res = self.client.get(url, {"from": "2026-10-01", "to": "2026-10-31"}, **_bearer(self.admin)).json()
        self.assertEqual((res["total"], [r["id"] for r in res["items"]]), (1, [self.rec_oct.id]))
        self.assertEqual(self.client.get(url, {"to": "2026-1-1"}, **_bearer(self.admin)).status_code, 400)


# ═══ Visitors: the figures follow the dates ══════════════════════════════════════════════════════════════════════


class VisitorFiguresDateTests(VisitorFixture):
    URL = "/api/visitor/summary"

    def test_the_figures_of_the_dates_leave_the_status_out(self):
        today = self.get(f"{self.URL}?from=2026-11-18&to=2026-11-18")
        # unit 1 on 18 Nov: a, c, e, g; c checked out; Ramesh (a + Oct's b) and Anand (d + e) came twice or more
        self.assertEqual(today["rangeTotals"], {"visits": 4, "checkedOut": 1, "repeat": 2})
        inside = self.get(f"{self.URL}?from=2026-11-18&to=2026-11-18&status=inside")
        self.assertEqual(inside["rangeTotals"], today["rangeTotals"])
        self.assertEqual(inside["inRange"]["visits"], 3)  # inRange still follows the status
        october = self.get(f"{self.URL}?from=2026-10-01&to=2026-10-31")
        self.assertEqual(october["rangeTotals"], {"visits": 1, "checkedOut": 1, "repeat": 1})

    def test_the_old_figures_are_still_there(self):
        body = self.get(self.URL)
        for key in ("today", "thisWeek", "thisMonth", "insideNow", "checkedOutToday", "repeatThisMonth", "inRange"):
            self.assertIn(key, body)
