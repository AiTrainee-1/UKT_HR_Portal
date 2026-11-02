"""A Department Head may open the recorded route of a team member's On-Duty day (owner decision 2026-11-02).

GET /api/tracking/journeys/<id> used to serve only the employee themselves and HR, so a head could not open the route
from Approvals. Pinned here:
  * the head's rule is EXACTLY the Approvals one (hod_scope.head_sees_requests_of): an active DepartmentManager, the
    can_approve_on_duty switch on, the employee in managed_employee_ids (the one-HOD-per-employee rule with HR's
    carve-outs), never the head themselves - so a head can open a route exactly when that person's On-Duty requests
    show on their Approvals screens;
  * everyone else (another department's or branch's head, a carved-out or re-assigned employee, a deactivated head, a
    head whose On-Duty switch is off, an ordinary colleague) gets the same 404 as a journey that does not exist;
  * the employee's own access and HR's (branch scope, module permission, audit log) are unchanged, a head's view is
    audit-logged, and the HR-only trail / points / export routes stay HR-only;
  * the On-Duty rows of GET /api/manager/requests?category=on_duty and GET /api/manager/pending-requests carry
    `journeyId` (null when nothing was recorded), and every journeyId a head is shown opens for that head.

Run: DATABASE_URL= DB_TEST_NAME=uktex_test_hodjourney python manage.py test api.tests_hod_journey_access
"""

from datetime import timedelta

from django.test import TestCase

from . import approval_workflow as approval
from .approval_workflow import HOD, HR
from .hod_scope import head_sees_requests_of
from .models import (
    AuditLog,
    Branch,
    Department,
    DepartmentManager,
    DutyTrack,
    Employee,
    HRUser,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    ManagerEmployeeExclusion,
    OnDutySession,
    Role,
)
from .tests_geo_tracking_support import T0, employee_headers, hr_headers

FLAG = "can_approve_on_duty"


def _entry(role, decision, by):
    return {"role": role, "decision": decision, "by": by, "at": "2026-10-28T10:00:00+05:30", "comment": None}


class _World(TestCase):
    """Branch North: Sewing (head Suresh; Asha, Bala, Chitra) and Cutting (head Kavya; Dev).
    Branch South: its own Sewing department (head Ravi; Esha). Every one of them has an On-Duty day with a route."""

    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.north = Branch.objects.create(name="North", code="HJ-N")
        self.south = Branch.objects.create(name="South", code="HJ-S")
        self.sewing = Department.objects.create(name="Sewing", branch=self.north)
        self.cutting = Department.objects.create(name="Cutting", branch=self.north)
        self.sewing_south = Department.objects.create(name="Sewing", branch=self.south)

        self.suresh = self.emp("HJ1", "Suresh", self.sewing, self.north)
        self.m = self.head(self.suresh, self.sewing)
        self.asha = self.emp("HJ2", "Asha", self.sewing, self.north)
        self.bala = self.emp("HJ3", "Bala", self.sewing, self.north)
        self.chitra = self.emp("HJ4", "Chitra", self.sewing, self.north)

        self.kavya = self.emp("HJ5", "Kavya", self.cutting, self.north)
        self.m_cutting = self.head(self.kavya, self.cutting)
        self.dev = self.emp("HJ6", "Dev", self.cutting, self.north)

        self.ravi = self.emp("HJ7", "Ravi", self.sewing_south, self.south)
        self.m_south = self.head(self.ravi, self.sewing_south)
        self.esha = self.emp("HJ8", "Esha", self.sewing_south, self.south)

        # Asha's day is waiting for the head; the others are history (approved / rejected), which Approvals lists too.
        self.asha_track = self.track(self.asha, OnDutySession.STATUS_PENDING_HOD)
        self.bala_track = self.track(
            self.bala, OnDutySession.STATUS_COMPLETED, [_entry(HR, "approved", "Meena")], ended=True
        )
        self.chitra_track = self.track(
            self.chitra, OnDutySession.STATUS_REJECTED, [_entry(HOD, "rejected", "Suresh Test")], ended=True
        )
        self.dev_track = self.track(self.dev, OnDutySession.STATUS_PENDING_HOD)
        self.esha_track = self.track(self.esha, OnDutySession.STATUS_PENDING_HOD)
        self.suresh_track = self.track(self.suresh, OnDutySession.STATUS_PENDING_HR)

        self.hr_super = HRUser.objects.create(username="hj_admin", password_hash="x", is_super_admin=True)
        self.hr_north = self.hr_user("north", {"geo_attendance": "view"}, self.north)
        self.hr_south = self.hr_user("south", {"geo_attendance": "view"}, self.south)
        self.hr_nogeo = self.hr_user("nogeo", {"leave": "edit"})

    # ── builders ──────────────────────────────────────────────────────────────

    @staticmethod
    def emp(code, first, dept, branch):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="Test",
            status="active",
            employment_type="staff",
            department=dept,
            branch=branch,
        )

    @staticmethod
    def head(emp, dept):
        m = DepartmentManager.objects.create(employee=emp)
        ManagerDepartmentAssignment.objects.create(manager=m, department=dept)
        return m

    @staticmethod
    def hr_user(name, permissions, branch=None):
        role = Role.objects.create(name=f"hj_{name}", permissions=permissions)
        return HRUser.objects.create(username=f"hj_{name}", password_hash="x", role=role, branch=branch)

    @staticmethod
    def session(emp, status=OnDutySession.STATUS_PENDING_HOD, trail=None):
        return OnDutySession.objects.create(
            employee=emp,
            destination="Client site",
            branch=emp.branch,
            status=status,
            approval_trail=[] if trail is None else trail,
        )

    def track(self, emp, status, trail=None, *, ended=False):
        s = self.session(emp, status, trail)
        fields = {"status": DutyTrack.STATUS_ACTIVE, "state_since": T0}
        if ended:
            fields.update(
                status=DutyTrack.STATUS_ENDED,
                ended_at=T0 + timedelta(hours=2),
                end_reason=DutyTrack.END_MANUAL,
                state=DutyTrack.STATE_ENDED,
            )
        return DutyTrack.objects.create(session=s, employee=emp, branch=emp.branch, started_at=T0, **fields)

    # ── calls ─────────────────────────────────────────────────────────────────

    def detail(self, viewer, track):
        pk = track if isinstance(track, int) else track.pk
        headers = hr_headers(viewer) if isinstance(viewer, HRUser) else employee_headers(viewer)
        return self.client.get(f"/api/tracking/journeys/{pk}", **headers)

    def status(self, viewer, track):
        return self.detail(viewer, track).status_code

    def approvals(self, viewer, status="pending"):
        r = self.client.get(
            "/api/manager/requests", {"category": "on_duty", "status": status}, **employee_headers(viewer)
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["items"]


class HeadInScopeTests(_World):
    def test_the_head_opens_a_team_members_route(self):
        r = self.detail(self.suresh, self.asha_track)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["track"]["id"], body["track"]["employeeId"], body["track"]["employeeName"]),
            (self.asha_track.pk, self.asha.id, "Asha Test"),
        )
        # the same contract the employee and HR get: nothing added, nothing taken away
        self.assertEqual(
            set(body),
            {"track", "summary", "segments", "events", "path", "pathSource", "device", "timeline", "punches"},
        )
        own = self.detail(self.asha, self.asha_track).json()
        for part in ("segments", "events", "path", "punches", "timeline"):
            self.assertEqual(body[part], own[part], part)

    def test_history_days_open_too(self):
        # Approvals lists approved and rejected On-Duty days as history, so their routes open as well.
        self.assertEqual(self.status(self.suresh, self.bala_track), 200)
        self.assertEqual(self.status(self.suresh, self.chitra_track), 200)

    def test_each_head_opens_only_their_own_people(self):
        self.assertEqual(self.status(self.kavya, self.dev_track), 200)
        self.assertEqual(self.status(self.ravi, self.esha_track), 200)

    def test_an_individual_assignment_lets_the_other_head_in(self):
        ManagerEmployeeAssignment.objects.create(manager=self.m_cutting, employee=self.bala)
        self.assertEqual(self.status(self.kavya, self.bala_track), 200)
        self.assertEqual(self.status(self.suresh, self.bala_track), 404)

    def test_a_head_view_is_audit_logged(self):
        self.detail(self.suresh, self.asha_track)
        log = AuditLog.objects.get(module="geo_tracking")
        self.assertEqual((log.action, log.record_id, log.user_type), ("view", self.asha_track.pk, "employee"))
        self.assertIn("Department Head viewed the journey of Asha Test (HJ2)", log.record_description)


class RefusedTests(_World):
    """Every refusal is the 404 of a journey that does not exist, so a refusal reveals nothing."""

    def assert_hidden(self, viewer, track):
        r = self.detail(viewer, track)
        self.assertEqual(r.status_code, 404, f"{viewer} -> {track}")
        self.assertEqual(r.json(), self.detail(viewer, 999_999).json())

    def test_the_head_of_another_department_of_the_same_branch(self):
        self.assert_hidden(self.kavya, self.asha_track)
        self.assert_hidden(self.suresh, self.dev_track)

    def test_the_head_of_another_branch(self):
        self.assert_hidden(self.ravi, self.asha_track)
        self.assert_hidden(self.suresh, self.esha_track)

    def test_a_carved_out_employee(self):
        ManagerEmployeeExclusion.objects.create(manager=self.m, employee=self.asha)
        self.assert_hidden(self.suresh, self.asha_track)
        self.assertEqual(self.status(self.suresh, self.bala_track), 200)  # only Asha was carved out

    def test_a_deactivated_head(self):
        self.m.is_active = False
        self.m.save()
        self.assert_hidden(self.suresh, self.asha_track)

    def test_a_head_whose_on_duty_switch_is_off(self):
        # Approvals hides On-Duty from this head (and answers 403 on the category), so the routes stay closed too.
        self.m.can_approve_on_duty = False
        self.m.save()
        self.assert_hidden(self.suresh, self.asha_track)

    def test_an_ordinary_employee(self):
        self.assert_hidden(self.bala, self.asha_track)
        self.assert_hidden(self.asha, self.dev_track)

    def test_a_head_never_reaches_a_route_through_their_own_coverage_of_themselves(self):
        self.assertFalse(head_sees_requests_of(self.suresh.id, self.suresh.id, FLAG))
        # the head's own day opens because it is theirs, exactly like any employee's
        self.assertEqual(self.status(self.suresh, self.suresh_track), 200)
        self.assertFalse(AuditLog.objects.filter(module="geo_tracking").exists())

    def test_the_hr_only_routes_stay_hr_only_for_a_head(self):
        for suffix in ("trail", "points", "export"):
            r = self.client.get(
                f"/api/tracking/journeys/{self.asha_track.pk}/{suffix}", **employee_headers(self.suresh)
            )
            self.assertEqual(r.status_code, 403, suffix)

    def test_a_refused_head_writes_no_audit_entry(self):
        self.detail(self.ravi, self.asha_track)
        self.assertFalse(AuditLog.objects.filter(module="geo_tracking").exists())


class UnchangedAccessTests(_World):
    def test_the_employee_reads_their_own_without_an_audit_entry(self):
        self.assertEqual(self.status(self.asha, self.asha_track), 200)
        self.assertFalse(AuditLog.objects.filter(module="geo_tracking").exists())

    def test_hr_branch_scope_and_module_permission(self):
        self.assertEqual(self.status(self.hr_super, self.asha_track), 200)
        self.assertEqual(self.status(self.hr_super, self.esha_track), 200)
        self.assertEqual(self.status(self.hr_north, self.asha_track), 200)
        self.assertEqual(self.status(self.hr_north, self.esha_track), 404)
        self.assertEqual(self.status(self.hr_south, self.asha_track), 404)
        self.assertEqual(self.status(self.hr_nogeo, self.asha_track), 403)

    def test_an_hr_view_is_still_audit_logged_as_before(self):
        self.detail(self.hr_super, self.asha_track)
        log = AuditLog.objects.get(module="geo_tracking")
        self.assertTrue(log.record_description.startswith("Viewed the journey of Asha Test (HJ2)"))


class ApprovalRowsTests(_World):
    def test_the_on_duty_rows_carry_the_journey_id(self):
        no_route = self.session(self.bala)  # a request with nothing recorded (yet)
        pending = {i["id"]: i for i in self.approvals(self.suresh, "pending")}
        self.assertEqual(pending[self.asha_track.session_id]["journeyId"], self.asha_track.pk)
        self.assertIn("journeyId", pending[no_route.id])
        self.assertIsNone(pending[no_route.id]["journeyId"])
        approved = {i["id"]: i for i in self.approvals(self.suresh, "approved")}
        self.assertEqual(approved[self.bala_track.session_id]["journeyId"], self.bala_track.pk)
        rejected = {i["id"]: i for i in self.approvals(self.suresh, "rejected")}
        self.assertEqual(rejected[self.chitra_track.session_id]["journeyId"], self.chitra_track.pk)

    def test_pending_requests_rows_carry_it_too(self):
        no_route = self.session(self.bala)
        r = self.client.get("/api/manager/pending-requests", **employee_headers(self.suresh))
        self.assertEqual(r.status_code, 200, r.content)
        rows = {i["id"]: i for i in r.json()["onDutySessions"]}
        self.assertEqual(rows[self.asha_track.session_id]["journeyId"], self.asha_track.pk)
        self.assertIsNone(rows[no_route.id]["journeyId"])
        everything = self.client.get(
            "/api/manager/pending-requests", {"status": "all"}, **employee_headers(self.suresh)
        ).json()["onDutySessions"]
        self.assertEqual(
            {i["journeyId"] for i in everything},
            {self.asha_track.pk, self.bala_track.pk, self.chitra_track.pk, None},
        )

    def test_every_journey_a_head_is_shown_opens_and_no_other_does(self):
        """The Approvals population and the route rule are the same rule: for every head and every route, the route
        opens exactly when its day is listed on that head's Approvals (in any status)."""
        ManagerEmployeeAssignment.objects.create(manager=self.m_cutting, employee=self.chitra)  # a moved person
        tracks = list(DutyTrack.objects.all())
        for viewer in (self.suresh, self.kavya, self.ravi):
            listed = {
                i["journeyId"]
                for status in ("pending", "approved", "rejected")
                for i in self.approvals(viewer, status)
                if i["journeyId"]
            }
            opens = {t.pk for t in tracks if t.employee_id != viewer.id and self.status(viewer, t) == 200}
            self.assertEqual(opens, listed, viewer.first_name)
            self.assertTrue(listed, viewer.first_name)
