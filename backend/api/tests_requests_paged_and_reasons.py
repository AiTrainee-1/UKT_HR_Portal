"""
Owner brief 2026-11-21:
  * the Requests page lists a page at a time (GET /api/hr-requests?page=&pageSize=), the server searching, filtering,
    sorting and counting every matching request;
  * every request carries the date(s) it is for (`requested`) beside its reason and when it was submitted;
  * approving never needs a remark, rejecting always needs the reason - in every approval pipeline
    (approval_workflow.decide) and in the decision endpoints outside it.

Run via: python manage.py test api.tests_requests_paged_and_reasons
"""

from datetime import date, timedelta

from django.utils import timezone

from . import approval_workflow as approval
from .models import EmployeeRequest, LeaveRequest, OnDutyPunchVerification, OutpassRequest
from .tests_hr_requests import ALL_KINDS, HubFixture, _employee

URL = "/api/hr-requests"


class PagedListTests(HubFixture):
    def test_one_page_at_a_time_with_the_total_and_every_request_on_some_page(self):
        made = self.one_of_each()
        self.one_of_each(self.ravi)
        first = self.body(page=1, pageSize=5)
        self.assertEqual((first["page"], first["pageSize"], first["total"], first["pages"]), (1, 5, 24, 5))
        self.assertEqual(len(first["items"]), 5)
        seen = [i["key"] for p in range(1, 6) for i in self.body(page=p, pageSize=5)["items"]]
        self.assertEqual(len(seen), 24)
        self.assertEqual(len(set(seen)), 24, "no request on two pages")
        self.assertIn(f"leave-{made['leave'].id}", seen)
        # a page past the end is the last one; a paged list is never "truncated"
        last = self.body(page=99, pageSize=5)
        self.assertEqual((last["page"], len(last["items"])), (5, 4))
        self.assertFalse(any(k["truncated"] for k in last["kinds"]))

    def test_newest_first_by_default_and_the_other_orders(self):
        a = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-01", end_date="2026-10-01", type="casual"
        )
        b = LeaveRequest.objects.create(
            employee=self.ravi, start_date="2026-10-02", end_date="2026-10-02", type="casual"
        )
        now = timezone.now()
        LeaveRequest.objects.filter(pk=a.pk).update(created_at=now - timedelta(days=2))
        LeaveRequest.objects.filter(pk=b.pk).update(created_at=now - timedelta(days=1), status="approved")
        keys = lambda **p: [i["key"] for i in self.body(page=1, pageSize=10, kind="leave", **p)["items"]]  # noqa: E731
        self.assertEqual(keys(), [f"leave-{b.id}", f"leave-{a.id}"])
        self.assertEqual(keys(sort="oldest"), [f"leave-{a.id}", f"leave-{b.id}"])
        # waiting first (the pending one), then the decided one
        self.assertEqual(keys(sort="waiting"), [f"leave-{a.id}", f"leave-{b.id}"])
        # RQ1 Hub before RQ2 Hub
        self.assertEqual(keys(sort="employee"), [f"leave-{a.id}", f"leave-{b.id}"])

    def test_the_search_needs_every_word_in_the_employee_or_the_request(self):
        self.one_of_each()
        self.one_of_each(self.ravi)
        hits = self.body(page=1, pageSize=50, q="rq2 tirupur")["items"]
        # the On-Duty request and its punch (the punch is searched by its trip's destination)
        self.assertEqual(sorted(i["kind"] for i in hits), ["on_duty", "on_duty_punch"])
        self.assertEqual(hits[0]["employee"]["code"], "RQ2")
        # a word of the kind's name matches every request of that kind
        self.assertEqual(self.body(page=1, pageSize=50, q="outpass")["total"], 2)
        self.assertEqual(self.body(page=1, pageSize=50, q="nobody-has-this")["total"], 0)

    def test_waiting_for_hr_is_worked_out_from_the_pipeline(self):
        made = self.one_of_each()
        hr = self.body(page=1, pageSize=50, status="waiting_hr")
        hod = self.body(page=1, pageSize=50, status="waiting_hod")
        self.assertTrue(all(i["queue"] == "hr" for i in hr["items"]))
        self.assertTrue(all(i["queue"] == "hod" for i in hod["items"]))
        self.assertIn(f"missing_punch-{made['missing_punch'].id}", [i["key"] for i in hod["items"]])
        everyone = self.body(page=1, pageSize=50, status="waiting")["total"]
        self.assertLessEqual(hr["total"] + hod["total"], everyone)

    def test_a_request_type_narrows_only_other_requests(self):
        self.one_of_each()
        EmployeeRequest.objects.create(employee=self.asha, request_type="general", subject="Canteen", description="x")
        body = self.body(page=1, pageSize=50, kind="request", requestType="general")
        self.assertEqual([i["extra"]["requestType"] for i in body["items"]], ["general"])

    def test_a_linked_request_comes_back_whatever_the_filters(self):
        made = self.one_of_each()
        key = f"outpass-{made['outpass'].id}"
        body = self.body(page=1, pageSize=5, kind="leave", status="rejected", focus=key)
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["focusItem"]["key"], key)
        # another branch's request is not handed to a branch-scoped caller
        self.assertIsNone(self.body(page=1, pageSize=5, focus="leave-999999")["focusItem"])

    def test_an_export_takes_every_matching_request_in_one_call(self):
        self.one_of_each()
        body = self.body(page=1, pageSize=5000, export=1)
        self.assertEqual((len(body["items"]), body["pageSize"]), (12, 5000))
        # without export a page is at most 100 rows
        self.assertEqual(self.body(page=1, pageSize=5000)["pageSize"], 100)

    def test_bad_paging_is_refused_and_the_old_whole_list_still_works(self):
        self.assertEqual(self.get(page="x").status_code, 400)
        self.assertEqual(self.get(page=1, sort="nope").status_code, 400)
        self.assertEqual(self.get(page=1, focus="leave").status_code, 400)
        self.assertEqual(self.get(status="waiting_hr").status_code, 400)  # only the paged list knows it
        self.one_of_each()
        old = self.body()
        self.assertEqual(len(old["items"]), 12)
        self.assertNotIn("total", old)


class RequestedDatesTests(HubFixture):
    def test_every_kind_says_what_date_it_is_for_and_what_its_reason_is_called(self):
        self.one_of_each()
        items = {i["kind"]: i for i in self.body(page=1, pageSize=50)["items"]}
        self.assertEqual(set(items), set(ALL_KINDS))
        self.assertEqual(
            items["leave"]["requested"],
            {
                "from": "2026-10-12",
                "to": "2026-10-14",
                "note": "1 day",
                "label": "Requested dates",
                "precision": "day",
            },
        )
        self.assertEqual(items["permission"]["requested"]["from"], "2026-10-12")
        self.assertEqual(items["casual_leave"]["requested"]["note"], "full day")
        self.assertEqual(items["missing_punch"]["requested"]["note"], "morning check-in at 09:05")
        self.assertEqual(items["on_duty_punch"]["requested"]["from"], "2026-10-09")
        self.assertEqual(items["attendance_correction"]["requested"]["from"], "2026-10-08")
        self.assertEqual(items["holiday_work"]["requested"]["label"], "Work date")
        self.assertEqual(items["holiday_work"]["requested"]["note"], "0.5 shift")
        self.assertEqual(items["resignation"]["requested"]["label"], "Last working day")
        self.assertIsNone(items["request"]["requested"])  # a general request is not for a date
        self.assertEqual(items["request"]["reasonLabel"], "Description")
        self.assertEqual(items["advance"]["reasonLabel"], "Purpose")
        self.assertEqual(items["leave"]["reasonLabel"], "Reason")
        for item in items.values():
            self.assertTrue(item["submittedAt"], item["kind"])


class RejectionNeedsItsReasonTests(HubFixture):
    def send(self, method, url, body):
        from .tests_hr_requests import _bearer

        return getattr(self.client, method)(url, body, content_type="application/json", **_bearer(self.admin))

    def test_a_pipeline_rejection_without_a_reason_is_refused_and_nothing_changes(self):
        leave = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-12", end_date="2026-10-12", type="sick"
        )
        for comment in (None, "", "  ", "no"):
            body = {"status": "rejected"} if comment is None else {"status": "rejected", "hrComment": comment}
            r = self.send("patch", f"/api/leave-requests/{leave.id}/status", body)
            self.assertEqual((r.status_code, r.json()["code"]), (400, approval.REJECT_REMARK_CODE), comment)
            self.assertEqual(r.json()["error"], approval.REJECT_REMARK_MESSAGE)
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")
        r = self.send(
            "patch", f"/api/leave-requests/{leave.id}/status", {"status": "rejected", "hrComment": "Dates clash"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        leave.refresh_from_db()
        self.assertEqual((leave.status, leave.hr_comment), ("rejected", "Dates clash"))

    def test_an_approval_needs_no_remark(self):
        out = OutpassRequest.objects.create(employee=self.asha, destination="Bank", source="manual", approval_trail=[])
        r = self.send("put", f"/api/outpass-requests/{out.id}/hr-status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_engine_itself_refuses_it_for_every_caller(self):
        out = OutpassRequest.objects.create(employee=self.asha, destination="Bank", source="manual", approval_trail=[])
        with self.assertRaises(approval.ApprovalError) as caught:
            approval.decide("outpass", out, approval.HR, "rejected", actor="HR", comment=" ")
        self.assertEqual(caught.exception.code, approval.REJECT_REMARK_CODE)
        self.assertEqual(out.approval_trail, [])

    def test_turning_an_approved_leave_into_a_rejected_one_needs_the_reason_too(self):
        leave = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-12", end_date="2026-10-12", type="sick"
        )
        self.assertEqual(
            self.send("patch", f"/api/leave-requests/{leave.id}/status", {"status": "approved"}).status_code, 200
        )
        r = self.send("patch", f"/api/leave-requests/{leave.id}/status", {"status": "rejected"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, approval.REJECT_REMARK_CODE))
        leave.refresh_from_db()
        self.assertEqual(leave.status, "approved")

    def test_a_general_request_rejected_needs_the_notes_other_statuses_do_not(self):
        er = EmployeeRequest.objects.create(
            employee=self.asha, request_type="general", subject="Canteen", description="x"
        )
        url = f"/api/employee-requests/{er.id}/action"
        self.assertEqual(self.send("put", url, {"status": "in_review"}).status_code, 200)
        r = self.send("put", url, {"status": "rejected"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, approval.REJECT_REMARK_CODE))
        er.refresh_from_db()
        self.assertEqual(er.status, "in_review")
        self.assertEqual(self.send("put", url, {"status": "rejected", "hrNotes": "Not our policy"}).status_code, 200)

    def test_an_on_duty_punch_rejected_needs_the_reason(self):
        made = self.one_of_each()
        punch = made["on_duty_punch"]
        url = f"/api/on-duty-punch-verifications/{punch.id}/status"
        r = self.send("patch", url, {"status": "rejected"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, approval.REJECT_REMARK_CODE))
        punch.refresh_from_db()
        self.assertEqual(punch.status, OnDutyPunchVerification.STATUS_PENDING)
        self.assertEqual(self.send("patch", url, {"status": "rejected", "comment": "Wrong place"}).status_code, 200)

    def test_the_department_heads_rejection_needs_it_too(self):
        from .models import DepartmentManager, ManagerEmployeeAssignment
        from .jwt_utils import sign_token

        boss = _employee("RQB", self.ho, self.cutting)
        manager = DepartmentManager.objects.create(employee=boss)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.asha)
        leave = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-12", end_date="2026-10-12", type="sick"
        )
        auth = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': boss.id})}"}
        url = f"/api/manager/leave-requests/{leave.id}/status"
        r = self.client.patch(url, {"status": "rejected"}, content_type="application/json", **auth)
        self.assertEqual((r.status_code, r.json().get("code")), (400, approval.REJECT_REMARK_CODE), r.content)
        r = self.client.patch(
            url, {"status": "rejected", "comment": "Busy week"}, content_type="application/json", **auth
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(
            f"/api/manager/leave-requests/{LeaveRequest.objects.create(employee=self.asha, start_date=date(2026, 10, 20), end_date=date(2026, 10, 20), type='sick').id}/status",
            {"status": "approved"},
            content_type="application/json",
            **auth,
        )
        self.assertEqual(r.status_code, 200, r.content)  # approving: no remark

    def test_clean_remark_rules(self):
        self.assertEqual(approval.clean_remark("  a   b \n c "), "a b c")
        self.assertEqual(len(approval.clean_remark("x" * 5000)), approval.REJECT_REMARK_MAX)
        self.assertIsNone(approval.reject_remark_refusal("approved", None))
        self.assertIsNone(approval.reject_remark_refusal("rejected", "Fine reason"))
        self.assertEqual(approval.reject_remark_refusal("rejected", "ab").status_code, 400)
