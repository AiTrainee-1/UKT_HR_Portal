"""
GET /api/manager/requests(+/summary): the Department Head's Pending / Approved / Rejected history per category for the
mobile Approvals tab (mobile_approvals_views.py).

Pinned here:
  * who may call it (an active Department Head only) and that a head never sees more than /manager/pending-requests
    already shows them: another department, another branch, a carved-out or re-assigned employee, and the head's own
    requests never appear, in any status or count;
  * the meaning of the three statuses (Pending = this head can decide it now, the same list as /manager/pending-requests;
    Approved = finally approved or approved by the Department Head and waiting for HR; Rejected = finally rejected),
    and who decided (you / HR / another head, legacy rows);
  * per-person switches, search, paging, bad input.

Run: DATABASE_URL= DB_TEST_NAME=uktex_test_approvals python manage.py test api.tests_mobile_approvals
"""

from datetime import date, datetime, time
from decimal import Decimal

from django.test import TestCase

from . import approval_workflow as approval
from .approval_workflow import HOD, HR
from .hod_scope import manager_may_act_on
from .jwt_utils import sign_token
from .models import (
    ApprovalWorkflowConfig,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    Department,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HolidayWorkClaim,
    HRUser,
    LeaveRequest,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    ManagerEmployeeExclusion,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
    OutpassRequest,
    ResignationRequest,
)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _emp(code, first, dept=None, branch=None):
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name="Test",
        status="active",
        employment_type="staff",
        department=dept,
        branch=branch,
    )


def _entry(role, decision, by, comment=None):
    return {"role": role, "decision": decision, "by": by, "at": "2026-10-01T10:00:00+05:30", "comment": comment}


def _leave(emp, status="pending", trail=None, day="2026-10-06", **kw):
    return LeaveRequest.objects.create(
        employee=emp,
        type="casual",
        start_date=day,
        end_date=day,
        status=status,
        approval_trail=[] if trail is None else trail,
        **kw,
    )


class _World(TestCase):
    """Branch North: Sewing (head Suresh, staff Asha + Bala + Chitra) and Cutting (Dev, no head).
    Branch South: its own Sewing department with Esha, under head Ravi."""

    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.north = Branch.objects.create(name="North", code="N")
        self.south = Branch.objects.create(name="South", code="S")
        self.sewing = Department.objects.create(name="Sewing", branch=self.north)
        self.cutting = Department.objects.create(name="Cutting", branch=self.north)
        self.sewing_south = Department.objects.create(name="Sewing", branch=self.south)

        self.boss = _emp("H1", "Suresh", self.sewing, self.north)
        self.m = DepartmentManager.objects.create(employee=self.boss)
        ManagerDepartmentAssignment.objects.create(manager=self.m, department=self.sewing)

        self.asha = _emp("E1", "Asha", self.sewing, self.north)
        self.bala = _emp("E2", "Bala", self.sewing, self.north)
        self.chitra = _emp("E3", "Chitra", self.sewing, self.north)
        self.dev = _emp("E4", "Dev", self.cutting, self.north)

        self.ravi = _emp("H2", "Ravi", self.sewing_south, self.south)
        self.m_south = DepartmentManager.objects.create(employee=self.ravi)
        ManagerDepartmentAssignment.objects.create(manager=self.m_south, department=self.sewing_south)
        self.esha = _emp("E5", "Esha", self.sewing_south, self.south)

        self.me_name = "Suresh Test"
        self.hod = _bearer({"role": "employee", "employeeId": self.boss.id})

    def get(self, path, auth=None, **params):
        return self.client.get(path, params, **(auth or self.hod))

    def lst(self, category="leave", status="pending", auth=None, **params):
        return self.get("/api/manager/requests", auth, category=category, status=status, **params)

    def ids(self, category="leave", status="pending", **params):
        res = self.lst(category, status, **params)
        self.assertEqual(res.status_code, 200, res.content)
        return sorted(item["id"] for item in res.json()["items"])

    def summary(self, auth=None):
        res = self.get("/api/manager/requests/summary", auth)
        self.assertEqual(res.status_code, 200, res.content)
        return {c["key"]: c for c in res.json()["categories"]}


class AccessTests(_World):
    def test_hr_token_is_refused(self):
        hr = HRUser.objects.create(username="ap_hr", password_hash="x", is_super_admin=True)
        auth = _bearer({"role": "hr", "hrUserId": hr.id})
        self.assertEqual(self.lst(auth=auth).status_code, 403)
        self.assertEqual(self.get("/api/manager/requests/summary", auth).status_code, 403)

    def test_an_employee_who_is_not_a_head_is_refused(self):
        auth = _bearer({"role": "employee", "employeeId": self.asha.id})
        self.assertEqual(self.lst(auth=auth).status_code, 403)
        self.assertEqual(self.get("/api/manager/requests/summary", auth).status_code, 403)

    def test_a_deactivated_head_is_refused(self):
        self.m.is_active = False
        self.m.save()
        self.assertEqual(self.lst().status_code, 403)
        self.assertEqual(self.get("/api/manager/requests/summary").status_code, 403)

    def test_no_token_is_refused(self):
        self.assertIn(self.client.get("/api/manager/requests", {"category": "leave"}).status_code, (401, 403))

    def test_bad_category_and_status_are_400(self):
        self.assertEqual(self.lst(category="payroll").status_code, 400)
        self.assertEqual(self.lst(status="cancelled").status_code, 400)
        # Salary advances are HR-only: not a category for a head.
        self.assertEqual(self.lst(category="advance").status_code, 400)
        self.assertEqual(self.lst(category="onDuty").status_code, 200)


class ScopeTests(_World):
    def test_only_the_heads_real_reports_appear_in_every_status(self):
        mine = [
            _leave(self.asha),
            _leave(self.bala, "approved", [_entry(HOD, "approved", self.me_name)]),
            _leave(self.chitra, "rejected", [_entry(HR, "rejected", "Meena")]),
        ]
        # Another department of the same branch, another branch's department of the same name, the head's own.
        for emp in (self.dev, self.esha, self.boss):
            _leave(emp)
            _leave(emp, "approved", [_entry(HR, "approved", "Meena")])
            _leave(emp, "rejected", [_entry(HR, "rejected", "Meena")])

        self.assertEqual(self.ids("leave", "pending"), [mine[0].id])
        self.assertEqual(self.ids("leave", "approved"), [mine[1].id])
        self.assertEqual(self.ids("leave", "rejected"), [mine[2].id])
        self.assertEqual(
            {k: self.summary()["leave"][k] for k in ("pending", "approved", "rejected")},
            {"pending": 1, "approved": 1, "rejected": 1},
        )

    def test_the_other_branch_head_sees_only_their_own_branch(self):
        _leave(self.asha)
        theirs = _leave(self.esha)
        south = _bearer({"role": "employee", "employeeId": self.ravi.id})
        res = self.lst(auth=south)
        self.assertEqual([i["id"] for i in res.json()["items"]], [theirs.id])
        self.assertEqual(res.json()["counts"]["pending"], 1)

    def test_a_carved_out_employee_disappears(self):
        _leave(self.asha, "approved", [_entry(HOD, "approved", self.me_name)])
        ManagerEmployeeExclusion.objects.create(manager=self.m, employee=self.asha)
        self.assertEqual(self.ids("leave", "approved"), [])
        self.assertEqual(self.summary()["leave"]["approved"], 0)

    def test_an_employee_individually_assigned_to_another_head_disappears(self):
        other = DepartmentManager.objects.create(employee=_emp("H3", "Kavya", self.cutting, self.north))
        ManagerEmployeeAssignment.objects.create(manager=other, employee=self.bala)
        _leave(self.bala)
        _leave(self.bala, "rejected", [_entry(HOD, "rejected", "Kavya Test")])
        self.assertEqual(self.ids("leave", "pending"), [])
        self.assertEqual(self.ids("leave", "rejected"), [])

    def test_pending_is_exactly_what_pending_requests_lists_for_every_kind(self):
        for emp in (self.asha, self.dev, self.esha):
            LeaveRequest.objects.create(employee=emp, type="casual", start_date="2026-10-06", end_date="2026-10-06")
            EmployeePermission.objects.create(
                employee=emp, date=date(2026, 10, 10), permission_time=time(9, 30), reason="x", type="morning_late_in"
            )
            ResignationRequest.objects.create(employee=emp, reason="x", approval_trail=[])
            AttendanceOverrideRequest.objects.create(
                employee=emp, date=date(2026, 10, 1), reason="x", approval_trail=[]
            )
            CasualLeaveRequest.objects.create(employee=emp, date=date(2026, 10, 20), reason="x", approval_trail=[])
            HolidayWorkClaim.objects.create(
                employee=emp, work_date=date(2026, 10, 4), shifts=Decimal("0.50"), approval_trail=[]
            )
            MissingPunchRequest.objects.create(
                employee=emp,
                date=date(2026, 10, 1),
                punch_time=time(9, 0),
                punch_type="IN",
                reason="x",
                status="pending_hod",
                approval_trail=[],
            )
            OutpassRequest.objects.create(employee=emp, destination="Bank", reason="x", approval_trail=[])
            OnDutySession.objects.create(employee=emp, destination="ABC", status="pending_hod", approval_trail=[])

        listed = self.get("/api/manager/pending-requests").json()
        expected = {
            "leave": listed["leaveRequests"],
            "permission": listed["permissions"],
            "resignation": listed["resignations"],
            "attendance": listed["attendanceRequests"],
            "casual_leave": listed["casualLeaves"],
            "holiday_work": listed["holidayWorkClaims"],
            "missing_punch": listed["missingPunchRequests"],
            "outpass": listed["outpassRequests"],
            "on_duty": listed["onDutySessions"],
        }
        summary = self.summary()
        self.assertEqual(set(summary), set(expected))
        for key, rows in expected.items():
            self.assertEqual(len(rows), 1, key)
            self.assertEqual(self.ids(key, "pending"), [r["id"] for r in rows], key)
            self.assertEqual(summary[key]["pending"], 1, key)
            item = self.lst(key).json()["items"][0]
            self.assertEqual(item["employeeCode"] if "employeeCode" in item else item["employee"]["employeeCode"], "E1")
            self.assertTrue(
                item["approval"]["canAct"]["hod"], key
            )  # the same `approval` block the decision sheet reads
        me = self.get("/api/manager/me").json()
        # Every kind /manager/me counts is a category now, On-Duty included: the totals agree.
        self.assertEqual(sum(c["pending"] for c in summary.values()), me["pendingApprovalsCount"])
        self.assertEqual(summary["on_duty"]["pending"], me["pendingOnDutyCount"])

    def test_the_same_row_shape_as_pending_requests(self):
        _leave(self.asha)
        old = self.get("/api/manager/pending-requests").json()["leaveRequests"][0]
        new = self.lst().json()["items"][0]
        for key, value in old.items():
            self.assertEqual(new[key], value, key)
        self.assertEqual(new["historyStatus"], "pending")
        self.assertEqual(new["category"], "leave")


class StatusMeaningTests(_World):
    def test_approved_by_this_head(self):
        r = _leave(self.asha, "approved", [_entry(HOD, "approved", self.me_name, "ok")])
        item = self.lst(status="approved").json()["items"][0]
        self.assertEqual(item["id"], r.id)
        out = item["outcome"]
        self.assertEqual(out["state"], "approved")
        self.assertEqual(out["yourDecision"], "approved")
        self.assertTrue(out["decidedByYou"])
        self.assertEqual(out["decidedByRole"], HOD)
        self.assertEqual(out["yourComment"], "ok")
        self.assertEqual(len(out["decisions"]), 1)

    def test_rejected_by_hr_is_rejected_and_says_hr(self):
        _leave(self.asha, "rejected", [_entry(HR, "rejected", "Meena", "no cover")])
        out = self.lst(status="rejected").json()["items"][0]["outcome"]
        self.assertEqual(out["state"], "rejected")
        self.assertIsNone(out["yourDecision"])
        self.assertFalse(out["decidedByYou"])
        self.assertEqual((out["decidedByRole"], out["decidedByName"]), (HR, "Meena"))

    def test_approved_by_the_head_then_rejected_by_hr(self):
        ResignationRequest.objects.create(
            employee=self.asha,
            reason="x",
            status="rejected",
            approval_trail=[_entry(HOD, "approved", self.me_name), _entry(HR, "rejected", "Meena")],
        )
        out = self.lst("resignation", "rejected").json()["items"][0]["outcome"]
        self.assertEqual(out["yourDecision"], "approved")
        self.assertEqual(out["decidedByRole"], HR)
        self.assertFalse(out["decidedByYou"])
        self.assertEqual([d["decision"] for d in out["decisions"]], ["approved", "rejected"])

    def test_approved_by_the_head_and_waiting_for_hr_counts_as_approved(self):
        mp = MissingPunchRequest.objects.create(
            employee=self.asha,
            date=date(2026, 10, 1),
            punch_time=time(9, 0),
            punch_type="IN",
            reason="x",
            status="pending_hr",
            approval_trail=[_entry(HOD, "approved", self.me_name)],
        )
        self.assertEqual(self.ids("missing_punch", "pending"), [])
        res = self.lst("missing_punch", "approved").json()
        self.assertEqual([i["id"] for i in res["items"]], [mp.id])
        self.assertEqual(res["items"][0]["outcome"]["state"], "in_progress")
        self.assertEqual(res["items"][0]["historyStatus"], "approved")
        self.assertEqual(res["counts"], {"pending": 0, "approved": 1, "rejected": 0})

    def test_a_legacy_missing_punch_waiting_for_hr_reads_as_head_approved(self):
        MissingPunchRequest.objects.create(
            employee=self.asha,
            date=date(2026, 10, 1),
            punch_time=time(9, 0),
            punch_type="IN",
            reason="x",
            status="pending_hr",
            hod_reviewed_by=self.me_name,
        )
        out = self.lst("missing_punch", "approved").json()["items"][0]["outcome"]
        self.assertEqual((out["state"], out["yourDecision"]), ("in_progress", "approved"))

    def test_a_request_waiting_for_hr_first_is_in_no_list_until_it_reaches_the_head(self):
        ApprovalWorkflowConfig.objects.create(
            key="leave", steps=[{"roles": ["hr"], "mandatory": True}, {"roles": ["hod"], "mandatory": True}]
        )
        approval.clear_cache()
        r = _leave(self.asha)
        self.assertEqual(self.summary()["leave"]["pending"], 0)
        for status in ("pending", "approved", "rejected"):
            self.assertEqual(self.ids("leave", status), [], status)
        r.approval_trail = [_entry(HR, "approved", "Meena")]
        r.save()
        self.assertEqual(self.ids("leave", "pending"), [r.id])

    def test_a_legacy_decision_keeps_the_name_on_the_row(self):
        _leave(self.asha, "approved", None, approved_by="Old Boss")
        LeaveRequest.objects.filter(employee=self.asha).update(approval_trail=None)
        out = self.lst(status="approved").json()["items"][0]["outcome"]
        self.assertEqual(out["decidedByName"], "Old Boss")
        self.assertFalse(out["decidedByYou"])
        self.assertEqual(out["decisions"], [])

    def test_a_legacy_decision_in_this_heads_name_is_theirs(self):
        _leave(self.asha, "rejected", None, approved_by=self.me_name)
        LeaveRequest.objects.filter(employee=self.asha).update(approval_trail=None)
        out = self.lst(status="rejected").json()["items"][0]["outcome"]
        self.assertTrue(out["decidedByYou"])
        self.assertEqual(out["yourDecision"], "rejected")

    def test_a_decision_through_the_existing_endpoint_moves_the_row(self):
        r = _leave(self.asha)
        res = self.client.patch(
            f"/api/manager/leave-requests/{r.id}/status",
            {"status": "rejected", "comment": "busy week"},
            content_type="application/json",
            **self.hod,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.ids("leave", "pending"), [])
        item = self.lst(status="rejected").json()["items"][0]
        self.assertEqual(item["id"], r.id)
        self.assertTrue(item["outcome"]["decidedByYou"])
        self.assertEqual(item["outcome"]["yourComment"], "busy week")


class SwitchSearchPagingTests(_World):
    def test_a_switched_off_category_is_hidden_and_refused(self):
        self.m.can_approve_casual_leave = False
        self.m.can_approve_permissions = False
        self.m.save()
        keys = set(self.summary())
        self.assertNotIn("casual_leave", keys)
        self.assertNotIn("outpass", keys)  # Outpass follows the Permissions switch
        self.assertIn("leave", keys)
        self.assertIn("permission", keys)  # always listed, as on the Approvals tab
        res = self.lst("casual_leave")
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["code"], "category_disabled")
        self.assertEqual(self.lst("outpass").status_code, 403)

    def test_camel_case_category_names_are_accepted(self):
        CasualLeaveRequest.objects.create(employee=self.asha, date=date(2026, 10, 20), reason="x", approval_trail=[])
        res = self.lst("casualLeave")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["category"], "casual_leave")
        self.assertEqual(len(res.json()["items"]), 1)

    def test_search_by_name_or_code_within_the_scope(self):
        a = _leave(self.asha, "approved", [_entry(HR, "approved", "Meena")])
        b = _leave(self.bala, "approved", [_entry(HR, "approved", "Meena")])
        _leave(self.esha, "approved", [_entry(HR, "approved", "Meena")])  # another branch: never, even by name
        self.assertEqual(self.ids("leave", "approved", search="asha"), [a.id])
        self.assertEqual(self.ids("leave", "approved", search="E2"), [b.id])
        self.assertEqual(self.ids("leave", "approved", search="esha"), [])
        self.assertEqual(self.ids("leave", "approved", search="bala test"), [b.id])
        res = self.lst(status="approved", search="asha").json()
        self.assertEqual(res["total"], 1)
        self.assertEqual(res["counts"]["approved"], 2)  # the cards keep the whole category's numbers

    def test_search_works_on_pending_too(self):
        a = _leave(self.asha)
        _leave(self.bala)
        self.assertEqual(self.ids("leave", "pending", search="Asha"), [a.id])

    def test_paging(self):
        made = [_leave(self.asha, "rejected", [_entry(HOD, "rejected", self.me_name)]) for _ in range(5)]
        first = self.lst(status="rejected", page=1, page_size=2).json()
        self.assertEqual((first["total"], first["hasMore"], len(first["items"])), (5, True, 2))
        self.assertEqual([i["id"] for i in first["items"]], [made[4].id, made[3].id])  # newest first
        last = self.lst(status="rejected", page=3, page_size=2).json()
        self.assertEqual((last["hasMore"], [i["id"] for i in last["items"]]), (False, [made[0].id]))

    def test_pending_is_oldest_first(self):
        old = _leave(self.asha)
        new = _leave(self.bala)
        self.assertEqual([i["id"] for i in self.lst().json()["items"]], [old.id, new.id])


def _session(emp, status="pending_hod", trail=None, **kw):
    return OnDutySession.objects.create(
        employee=emp, destination="Client site", status=status, approval_trail=[] if trail is None else trail, **kw
    )


class OnDutyTests(_World):
    def test_pending_approved_rejected_and_scope(self):
        waiting = _session(self.asha)
        running = _session(
            self.bala, "active", [_entry(HOD, "approved", self.me_name), _entry(HR, "approved", "Meena")]
        )
        finished = _session(self.chitra, "completed", [_entry(HR, "approved", "Meena")])
        refused = _session(self.asha, "rejected", [_entry(HR, "rejected", "Meena", "not planned")])
        for emp in (self.dev, self.esha, self.boss):  # another department / branch, the head's own
            _session(emp)
            _session(emp, "active", [_entry(HR, "approved", "Meena")])
            _session(emp, "rejected", [_entry(HR, "rejected", "Meena")])
        self.assertEqual(self.ids("on_duty", "pending"), [waiting.id])
        self.assertEqual(self.ids("on_duty", "approved"), sorted([running.id, finished.id]))
        self.assertEqual(self.ids("on_duty", "rejected"), [refused.id])
        self.assertEqual(
            {k: self.summary()["on_duty"][k] for k in ("pending", "approved", "rejected")},
            {"pending": 1, "approved": 2, "rejected": 1},
        )
        items = {i["id"]: i for i in self.lst("on_duty", "approved").json()["items"]}
        out = items[finished.id]["outcome"]
        self.assertEqual((out["state"], out["decidedByRole"], out["decidedByName"]), ("approved", HR, "Meena"))
        out = items[running.id]["outcome"]
        self.assertEqual((out["yourDecision"], out["decidedByRole"], out["decidedByYou"]), ("approved", HR, False))

    def test_head_approved_and_waiting_for_hr_is_approved_in_progress(self):
        s = _session(self.asha, "pending_hr", [_entry(HOD, "approved", self.me_name)])
        self.assertEqual(self.ids("on_duty", "pending"), [])
        item = self.lst("on_duty", "approved").json()["items"][0]
        self.assertEqual((item["id"], item["outcome"]["state"]), (s.id, "in_progress"))

    def test_the_switch_hides_and_refuses_on_duty(self):
        _session(self.asha)
        self.m.can_approve_on_duty = False
        self.m.save()
        self.assertNotIn("on_duty", self.summary())
        res = self.lst("on_duty")
        self.assertEqual((res.status_code, res.json()["code"]), (403, "category_disabled"))

    def test_rows_carry_the_day_and_the_punches(self):
        s = _session(self.asha)
        for n, (t, kind) in enumerate(((time(9, 5), "IN"), (time(13, 0), "OUT")), start=1):
            OnDutyPunchVerification.objects.create(
                session=s,
                employee=self.asha,
                punch_date=date(2026, 10, 30),
                punch_time=t,
                punch_type=kind,
                punch_number=n,
                latitude=11.0,
                longitude=77.0,
                photo="x.jpg",
            )
        item = self.lst("on_duty").json()["items"][0]
        self.assertEqual(item["destination"], "Client site")
        self.assertRegex(item["date"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(
            [(p["punchTime"], p["punchType"], p["hasPhoto"]) for p in item["punches"]],
            [
                ("09:05", "IN", True),
                ("13:00", "OUT", True),
            ],
        )
        self.assertEqual(item["pendingPunchCount"], 2)
        # The head may open those photos: the photo endpoint lets the employee's own Department Head in (the same rule
        # it applies; the test files have no real image on disk), and nobody else's head.
        self.assertTrue(manager_may_act_on(self.boss.id, self.asha))
        self.assertFalse(manager_may_act_on(self.ravi.id, self.asha))
        other = self.client.get(
            f"/api/on-duty-punch-verifications/{item['punches'][0]['id']}/photo",
            **_bearer({"role": "employee", "employeeId": self.ravi.id}),
        )
        self.assertEqual(other.status_code, 403)

    def test_a_decision_through_the_existing_endpoint_moves_the_row(self):
        s = _session(self.asha)
        res = self.client.patch(
            f"/api/manager/on-duty-sessions/{s.id}/status",
            {"status": "approved", "comment": "ok"},
            content_type="application/json",
            **self.hod,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.ids("on_duty", "pending"), [])
        item = self.lst("on_duty", "approved").json()["items"][0]
        self.assertEqual(item["id"], s.id)
        self.assertEqual(item["outcome"]["state"], "in_progress")  # out of the box HR still has the final word
        self.assertEqual(item["outcome"]["yourComment"], "ok")
        self.assertEqual(self.summary()["on_duty"]["pending"], 0)

    def test_a_legacy_rejection_names_who_rejected(self):
        hod_no = _session(
            self.asha, "rejected", hod_reviewed_by=self.me_name, hod_reviewed_at=datetime(2026, 9, 1, 10, 0)
        )
        hr_no = _session(self.bala, "rejected", hod_reviewed_by=self.me_name, hr_reviewed_by="Meena")
        OnDutySession.objects.filter(pk__in=[hod_no.pk, hr_no.pk]).update(approval_trail=None)
        items = {i["id"]: i["outcome"] for i in self.lst("on_duty", "rejected").json()["items"]}
        self.assertEqual((items[hod_no.id]["decidedByRole"], items[hod_no.id]["decidedByYou"]), (HOD, True))
        self.assertEqual(items[hod_no.id]["yourDecision"], "rejected")
        self.assertEqual((items[hr_no.id]["decidedByRole"], items[hr_no.id]["decidedByName"]), (HR, "Meena"))
        self.assertEqual(items[hr_no.id]["yourDecision"], "approved")
