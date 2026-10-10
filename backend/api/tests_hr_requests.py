"""
Requests hub: GET /api/hr-requests, the one list behind the HR portal's Requests page.

It must show every kind of request the HRMS has, say where each one stands in its approval pipeline, respect the caller's
branch and module access, and never decide anything itself.

Run via: python manage.py test api.tests_hr_requests -v 2
"""

from datetime import date, time, timedelta

from django.test import TestCase
from django.utils import timezone

from . import approval_workflow as approval
from .jwt_utils import sign_token
from .models import (
    Advance,
    ApprovalWorkflowConfig,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeePermission,
    EmployeeRequest,
    HRUser,
    LeaveRequest,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
    OutpassRequest,
    ResignationRequest,
    Role,
)

ALL_KINDS = [
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "on_duty",
    "on_duty_punch",
    "outpass",
    "request",
    "attendance_correction",
    "resignation",
    "advance",
]


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _employee(code, branch=None, department=None, kind="staff"):
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Hub",
        employment_type=kind,
        status="active",
        branch=branch,
        department=department,
    )


class HubFixture(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.admin = HRUser.objects.create(username="rq_admin", password_hash="x", is_super_admin=True)
        self.ho = Branch.objects.create(name="RQ Head Office", code="RQHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="RQ Unit 2", code="RQU2")
        self.cutting = Department.objects.create(name="RQ Cutting", branch=self.ho)
        self.asha = _employee("RQ1", self.ho, self.cutting)
        self.ravi = _employee("RQ2", self.u2, None, kind="production")

    def get(self, user=None, **params):
        return self.client.get("/api/hr-requests", params, **_bearer(user or self.admin))

    def body(self, user=None, **params):
        response = self.get(user, **params)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def one_of_each(self, emp=None):
        """One waiting request of every kind for `emp`; returns {kind: object}."""
        emp = emp or self.asha
        made = {}
        made["leave"] = LeaveRequest.objects.create(
            employee=emp, start_date="2026-10-12", end_date="2026-10-14", type="casual", reason="family function"
        )
        made["permission"] = EmployeePermission.objects.create(
            employee=emp, date=date(2026, 10, 12), permission_time=time(9, 30), reason="doctor", type="morning_late_in"
        )
        made["casual_leave"] = CasualLeaveRequest.objects.create(employee=emp, date=date(2026, 10, 13), reason="rest")
        made["missing_punch"] = MissingPunchRequest.objects.create(
            employee=emp,
            date=date(2026, 10, 9),
            punch_time=time(9, 5),
            punch_type="IN",
            punch_slot="morning_in",
            reason="forgot",
            status="pending_hod",
            approval_trail=[],
        )
        made["on_duty"] = OnDutySession.objects.create(
            employee=emp, destination="Tirupur Court", branch=emp.branch, status="pending_hod", approval_trail=[]
        )
        made["on_duty_punch"] = OnDutyPunchVerification.objects.create(
            session=made["on_duty"],
            employee=emp,
            punch_date=date(2026, 10, 9),
            punch_time=time(10, 0),
            punch_type="IN",
            punch_number=1,
            latitude=11.1,
            longitude=77.3,
            photo="on_duty_punch_verifications/x.jpg",
        )
        made["outpass"] = OutpassRequest.objects.create(
            employee=emp, destination="Bank", reason="loan paperwork", source="manual", approval_trail=[]
        )
        made["request"] = EmployeeRequest.objects.create(
            employee=emp, request_type="salary_enquiry", subject="Salary slip query", description="September slip"
        )
        made["attendance_correction"] = AttendanceOverrideRequest.objects.create(
            employee=emp,
            date=date(2026, 10, 8),
            reason="device down",
            requested_values={"status": "present"},
            previous_values={"status": "absent"},
            approval_trail=[],
        )
        made["resignation"] = ResignationRequest.objects.create(
            employee=emp, reason="relocating", last_working_date=date(2026, 11, 30), approval_trail=[]
        )
        made["advance"] = Advance.objects.create(
            employee=emp, advance_type="general", amount=5000, outstanding=5000, purpose="medical"
        )
        return made


class EveryKindTests(HubFixture):
    def test_every_request_format_is_in_the_list_with_its_kind(self):
        made = self.one_of_each()
        body = self.body()
        self.assertEqual([k["key"] for k in body["kinds"]], ALL_KINDS)
        self.assertEqual({i["kind"] for i in body["items"]}, set(ALL_KINDS))
        for kind, obj in made.items():
            row = next(i for i in body["items"] if i["kind"] == kind)
            self.assertEqual(row["id"], obj.id, kind)
            self.assertEqual(row["employee"]["code"], "RQ1", kind)
            self.assertEqual(row["employee"]["branchId"], self.ho.id, kind)
            self.assertEqual(row["employee"]["department"], "RQ Cutting", kind)
            self.assertEqual(row["status"], "pending", kind)
            self.assertIsNone(row["decided"], kind)
            self.assertTrue(row["label"] and row["summary"] and row["submittedAt"], kind)
            self.assertIn("steps", row["approval"], kind)

    def test_each_kind_says_how_it_is_decided(self):
        self.one_of_each()
        modes = {k["key"]: k["mode"] for k in self.body()["kinds"]}
        self.assertEqual(modes["leave"], "quick")
        self.assertEqual(modes["on_duty"], "quick")
        self.assertEqual(modes["request"], "notes")
        for kind in ("on_duty_punch", "attendance_correction", "resignation", "advance"):
            self.assertEqual(modes[kind], "link", kind)

    def test_a_leave_row_reads_like_the_leave_page(self):
        LeaveRequest.objects.create(
            employee=self.asha,
            start_date="2026-10-12",
            end_date="2026-10-12",
            type="casual",
            is_half_day=True,
            half_day_slot="afternoon",
            total_days=0.5,
            reason="dentist",
        )
        row = self.body(kind="leave")["items"][0]
        self.assertEqual(row["label"], "Half Day Leave (Afternoon)")
        self.assertIn("0.5 day", row["summary"])
        self.assertEqual(row["reason"], "dentist")

    def test_permission_rows_carry_what_the_outcome_chip_needs(self):
        self.one_of_each()
        row = self.body(kind="permission")["items"][0]
        self.assertEqual(row["extra"]["typeKey"], "morning_late_in")
        self.assertEqual(row["extra"]["statusLabel"], "Pending")
        self.assertEqual(row["extra"]["permissionTime"], "09:30")

    def test_other_requests_keep_their_open_statuses(self):
        for status in ("pending", "in_review", "more_info", "approved"):
            EmployeeRequest.objects.create(
                employee=self.asha, request_type="general", subject=status, description="x", status=status
            )
        rows = self.body(kind="request")["items"]
        by_subject = {r["summary"]: r for r in rows}
        for open_status in ("pending", "in_review", "more_info"):
            self.assertEqual(by_subject[open_status]["status"], "pending")
        self.assertEqual(by_subject["more_info"]["statusLabel"], "More info needed")
        self.assertEqual(by_subject["approved"]["status"], "approved")

    def test_a_gate_outpass_is_not_a_request_for_hr(self):
        OutpassRequest.objects.create(
            employee=self.asha, destination="Site", reason="on duty", source="on_duty", status="approved"
        )
        self.assertEqual(self.body(kind="outpass")["items"], [])


class PipelineTests(HubFixture):
    def test_waiting_counts_say_who_each_request_is_with(self):
        self.one_of_each()
        body = self.body()
        kinds = {k["key"]: k for k in body["kinds"]}
        # leave runs "HOD or HR": HR can decide it now. Missing punch runs HOD then HR: it is with the HOD.
        self.assertEqual(
            (kinds["leave"]["waiting"], kinds["leave"]["waitingHr"], kinds["leave"]["waitingHod"]), (1, 1, 0)
        )
        self.assertEqual(
            (
                kinds["missing_punch"]["waiting"],
                kinds["missing_punch"]["waitingHr"],
                kinds["missing_punch"]["waitingHod"],
            ),
            (1, 0, 1),
        )
        # the Department Head alone decides an attendance correction
        self.assertEqual(kinds["attendance_correction"]["waitingHod"], 1)
        queues = {i["kind"]: i["queue"] for i in body["items"]}
        self.assertEqual(queues["leave"], "hr")
        self.assertEqual(queues["missing_punch"], "hod")
        self.assertEqual(queues["resignation"], "hod")
        self.assertEqual(queues["advance"], "hr")
        self.assertEqual(queues["request"], "hr")
        stats = body["stats"]
        self.assertEqual(stats["waiting"], 11)
        self.assertEqual(stats["waitingHr"] + stats["waitingHod"] + stats["waitingOther"], 11)
        self.assertGreaterEqual(stats["waitingHod"], 3)

    def test_a_changed_pipeline_moves_the_request_to_the_other_queue(self):
        LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-12", end_date="2026-10-12")
        self.assertEqual(self.body(kind="leave")["items"][0]["queue"], "hr")
        ApprovalWorkflowConfig.objects.create(key="leave", enabled=True, steps=[{"roles": ["hod"], "mandatory": True}])
        approval.clear_cache()
        row = self.body(kind="leave")["items"][0]
        self.assertEqual(row["queue"], "hod")
        self.assertFalse(row["approval"]["canAct"]["hr"])

    def test_oldest_waiting_names_the_request(self):
        old = LeaveRequest.objects.create(employee=self.asha, start_date="2026-09-01", end_date="2026-09-01")
        LeaveRequest.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=20))
        LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-01", end_date="2026-10-01")
        oldest = self.body()["stats"]["oldestWaiting"]
        self.assertEqual((oldest["kind"], oldest["id"]), ("leave", old.id))
        self.assertEqual(oldest["employeeName"], "RQ1 Hub")

    def test_nothing_waiting_means_no_oldest(self):
        self.assertIsNone(self.body()["stats"]["oldestWaiting"])


class DecidedTests(HubFixture):
    def decide(self, obj, status, **fields):
        for key, value in fields.items():
            setattr(obj, key, value)
        obj.status = status
        obj.save()
        return obj

    def test_a_decided_request_says_who_decided_it_and_when(self):
        leave = LeaveRequest.objects.create(
            employee=self.asha,
            start_date="2026-10-12",
            end_date="2026-10-12",
            status="approved",
            approved_by="Meena",
            approver_role="hr",
            hr_comment="fine",
            approval_trail=[{"role": "hr", "decision": "approved", "by": "Meena", "at": "2026-10-10T09:00:00+00:00"}],
        )
        row = next(i for i in self.body(kind="leave")["items"] if i["id"] == leave.id)
        self.assertEqual(row["status"], "approved")
        self.assertEqual(row["decided"]["by"], "Meena")
        self.assertEqual(row["decided"]["role"], "hr")
        self.assertEqual(row["decided"]["at"], "2026-10-10T09:00:00+00:00")
        self.assertEqual(row["decided"]["comment"], "fine")
        self.assertIsNone(row["queue"])

    def test_columns_fill_in_when_a_kind_has_no_trail(self):
        EmployeeRequest.objects.create(
            employee=self.asha,
            request_type="general",
            subject="Letter",
            description="x",
            status="approved",
            handled_by="Meena",
            handled_at=timezone.now(),
            hr_notes="issued",
        )
        row = self.body(kind="request")["items"][0]
        self.assertEqual(
            (row["decided"]["by"], row["decided"]["role"], row["decided"]["comment"]), ("Meena", "hr", "issued")
        )
        self.assertTrue(row["decided"]["at"])

    def test_on_duty_states_after_approval_count_as_approved(self):
        for status in ("active", "completed", "rejected", "pending_hr"):
            OnDutySession.objects.create(employee=self.asha, destination=status, branch=self.ho, status=status)
        rows = {r["summary"]: r["status"] for r in self.body(kind="on_duty")["items"]}
        self.assertEqual(
            rows, {"active": "approved", "completed": "approved", "rejected": "rejected", "pending_hr": "pending"}
        )

    def test_status_filters(self):
        waiting = LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-01", end_date="2026-10-01")
        approved = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-02", end_date="2026-10-02", status="approved"
        )
        rejected = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-03", end_date="2026-10-03", status="rejected"
        )

        def ids(status):
            return {i["id"] for i in self.body(kind="leave", status=status)["items"]}

        self.assertEqual(ids("any"), {waiting.id, approved.id, rejected.id})
        self.assertEqual(ids("waiting"), {waiting.id})
        self.assertEqual(ids("decided"), {approved.id, rejected.id})
        self.assertEqual(ids("approved"), {approved.id})
        self.assertEqual(ids("rejected"), {rejected.id})

    def test_this_months_decisions_are_counted(self):
        now = timezone.now().isoformat()
        for status, count in (("approved", 2), ("rejected", 1)):
            for n in range(count):
                LeaveRequest.objects.create(
                    employee=self.asha,
                    start_date=f"2026-10-0{n + 1}",
                    end_date=f"2026-10-0{n + 1}",
                    status=status,
                    approval_trail=[{"role": "hr", "decision": status, "by": "Meena", "at": now}],
                )
        # decided last year: not this month's
        old = LeaveRequest.objects.create(
            employee=self.asha,
            start_date="2025-01-01",
            end_date="2025-01-01",
            status="approved",
            approval_trail=[{"role": "hr", "decision": "approved", "by": "Meena", "at": "2025-01-05T09:00:00+00:00"}],
        )
        LeaveRequest.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=300))
        stats = self.body()["stats"]
        self.assertEqual((stats["approvedThisMonth"], stats["rejectedThisMonth"]), (2, 1))


class FilterTests(HubFixture):
    def test_period_filters_on_the_day_it_was_submitted(self):
        old = LeaveRequest.objects.create(employee=self.asha, start_date="2026-06-01", end_date="2026-06-01")
        LeaveRequest.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=40))
        new = LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-01", end_date="2026-10-01")
        today = date.today().isoformat()
        since = (date.today() - timedelta(days=7)).isoformat()
        self.assertEqual({i["id"] for i in self.body(kind="leave", since=since)["items"]}, {new.id})
        self.assertEqual({i["id"] for i in self.body(kind="leave", until=since)["items"]}, {old.id})
        # the last day of a range is included
        self.assertEqual({i["id"] for i in self.body(kind="leave", since=today, until=today)["items"]}, {new.id})

    def test_branch_department_and_type_filters(self):
        mine = LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-01", end_date="2026-10-01")
        theirs = LeaveRequest.objects.create(employee=self.ravi, start_date="2026-10-01", end_date="2026-10-01")

        def ids(**params):
            return {i["id"] for i in self.body(kind="leave", **params)["items"]}

        self.assertEqual(ids(), {mine.id, theirs.id})
        self.assertEqual(ids(branchId=self.u2.id), {theirs.id})
        self.assertEqual(ids(departmentId=self.cutting.id), {mine.id})
        self.assertEqual(ids(employeeType="production"), {theirs.id})
        self.assertEqual(ids(employeeType="staff"), {mine.id})

    def test_kind_filter_and_the_per_kind_limit(self):
        for n in range(3):
            LeaveRequest.objects.create(
                employee=self.asha, start_date=f"2026-10-0{n + 1}", end_date=f"2026-10-0{n + 1}"
            )
        CasualLeaveRequest.objects.create(employee=self.asha, date=date(2026, 10, 5))
        body = self.body(kind="leave,casual_leave", limit=2)
        self.assertEqual({i["kind"] for i in body["items"]}, {"leave", "casual_leave"})
        leave = next(k for k in body["kinds"] if k["key"] == "leave")
        self.assertEqual((leave["matched"], leave["truncated"], leave["waiting"]), (3, True, 3))
        self.assertEqual(len([i for i in body["items"] if i["kind"] == "leave"]), 2)
        # a kind that was not asked for still reports its waiting count (the sub-tab badges), but sends no rows
        other = self.body(kind="leave")
        self.assertEqual(next(k for k in other["kinds"] if k["key"] == "casual_leave")["waiting"], 1)
        self.assertEqual({i["kind"] for i in other["items"]}, {"leave"})

    def test_the_filter_options_are_the_branches_and_departments_in_scope(self):
        options = self.body()["options"]
        self.assertEqual({b["name"] for b in options["branches"]} >= {"RQ Head Office", "RQ Unit 2"}, True)
        self.assertIn({"id": self.cutting.id, "name": "RQ Cutting", "branchId": self.ho.id}, options["departments"])
        role = Role.objects.create(name="rq_scoped", permissions={"requests": "edit"})
        scoped = HRUser.objects.create(username="rq_scoped", password_hash="x", role=role, branch=self.u2)
        own = self.body(scoped)["options"]
        self.assertEqual([b["id"] for b in own["branches"]], [self.u2.id])
        self.assertEqual(own["departments"], [])

    def test_bad_parameters_are_refused(self):
        for params in ({"status": "nope"}, {"kind": "nope"}, {"since": "yesterday"}, {"branchId": "x"}):
            self.assertEqual(self.get(**params).status_code, 400, params)


class AccessTests(HubFixture):
    def hr(self, name, permissions, branch=None):
        role = Role.objects.create(name=f"rq_{name}", permissions=permissions)
        return HRUser.objects.create(username=f"rq_{name}", password_hash="x", role=role, branch=branch)

    def test_a_branch_hr_only_sees_their_own_branch(self):
        mine = LeaveRequest.objects.create(employee=self.asha, start_date="2026-10-01", end_date="2026-10-01")
        LeaveRequest.objects.create(employee=self.ravi, start_date="2026-10-01", end_date="2026-10-01")
        OnDutySession.objects.create(employee=self.ravi, destination="far", branch=self.u2, status="pending_hod")
        user = self.hr("branch", {"requests": "edit", "leave": "edit", "geo_attendance": "edit"}, branch=self.ho)
        body = self.body(user)
        self.assertEqual({i["id"] for i in body["items"] if i["kind"] == "leave"}, {mine.id})
        self.assertEqual([i for i in body["items"] if i["kind"] == "on_duty"], [])
        # the figures above the list are branch-scoped too
        self.assertEqual(body["stats"]["waiting"], 1)

    def test_a_kind_whose_module_the_role_cannot_open_is_left_out(self):
        self.one_of_each()
        user = self.hr("limited", {"requests": "edit", "leave": "view"})
        body = self.body(user)
        self.assertEqual([k["key"] for k in body["kinds"]], ["leave", "permission", "outpass", "request"])
        self.assertEqual({i["kind"] for i in body["items"]}, {"leave", "permission", "outpass", "request"})
        access = {k["key"]: k["access"] for k in body["kinds"]}
        self.assertEqual(access["leave"], "view")
        self.assertEqual(access["permission"], "edit")

    def test_a_role_without_the_requests_module_cannot_open_the_list(self):
        user = self.hr("nope", {"leave": "edit"})
        self.assertEqual(self.get(user).status_code, 403)
        hidden = self.hr("hidden", {"requests": "hidden", "leave": "edit"})
        self.assertEqual(self.get(hidden).status_code, 403)

    def test_a_view_role_can_read(self):
        self.one_of_each()
        user = self.hr("viewer", {"requests": "view", "leave": "view", "casual_leave": "view"})
        body = self.body(user)
        self.assertEqual({k["access"] for k in body["kinds"]}, {"view"})

    def test_the_managing_director_only_views_every_kind(self):
        self.one_of_each()
        md = HRUser.objects.create(username="rq_md", password_hash="x", is_md=True)
        body = self.body(md)
        self.assertEqual({k["access"] for k in body["kinds"]}, {"view"})
        self.assertEqual({i["kind"] for i in body["items"]}, set(ALL_KINDS))

    def test_an_employee_token_is_refused(self):
        token = sign_token({"role": "employee", "employeeId": self.asha.id})
        response = self.client.get("/api/hr-requests", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(response.status_code, 403)

    def test_no_token_is_refused(self):
        self.assertEqual(self.client.get("/api/hr-requests").status_code, 401)

    def test_it_only_reads(self):
        self.one_of_each()
        response = self.client.post("/api/hr-requests", {}, content_type="application/json", **_bearer(self.admin))
        self.assertEqual(response.status_code, 405)
