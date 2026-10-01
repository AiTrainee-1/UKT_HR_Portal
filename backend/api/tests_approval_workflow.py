"""
Approval Workflow Control: the central pipeline engine (approval_workflow.py), its configuration API, and every workflow
that runs on it. The out-of-the-box pipelines must behave exactly as the HRMS always did (the older suites cover that);
this file covers the engine's rules, the configuration and what changes when HR edits a pipeline.

Run via: python manage.py test api.tests_approval_workflow -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from . import approval_workflow as approval
from .approval_workflow import HOD, HR, Step
from .jwt_utils import sign_token
from .models import (
    ApprovalWorkflowConfig,
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    AuditLog,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    Notification,
    OnDutySession,
    OutpassRecord,
    OutpassRequest,
    Role,
)


def S(*roles, mandatory=True) -> Step:
    return Step(tuple(roles), mandatory)


EITHER = (S(HOD, HR),)
HOD_THEN_HR = (S(HOD), S(HR))
HOD_OPTIONAL_THEN_HR = (S(HOD, mandatory=False), S(HR))
HR_THEN_HOD = (S(HR), S(HOD))
HR_OPTIONAL_THEN_HOD = (S(HR, mandatory=False), S(HOD))
HOD_ONLY = (S(HOD),)
HR_ONLY = (S(HR),)


# ═════════════════════════════ the rules ═════════════════════════════


class PipelineRuleTests(SimpleTestCase):
    def can(self, steps, approved, role, decision="approved", early=()):
        return approval.check_can_act(steps, set(approved), role, decision, early)

    def test_a_shared_step_lets_either_role_decide(self):
        for role in (HOD, HR):
            self.assertTrue(self.can(EITHER, [], role)[0], role)

    def test_a_mandatory_first_step_holds_the_request_until_its_role_has_decided(self):
        ok, message, status, code = self.can(HOD_THEN_HR, [], HR)
        self.assertFalse(ok)
        self.assertEqual((status, code), (400, "not_your_turn"))
        self.assertIn("awaiting Department Head approval", message)
        self.assertTrue(self.can(HOD_THEN_HR, [], HOD)[0])
        self.assertTrue(self.can(HOD_THEN_HR, [HOD], HR)[0])
        ok, message, *_ = self.can(HOD_THEN_HR, [HOD], HOD)
        self.assertFalse(ok)  # the Department Head has already had their turn
        self.assertIn("awaiting HR approval", message)

    def test_an_optional_first_step_can_be_skipped_by_the_next_role(self):
        self.assertTrue(self.can(HOD_OPTIONAL_THEN_HR, [], HR)[0])
        self.assertTrue(self.can(HOD_OPTIONAL_THEN_HR, [], HOD)[0])
        self.assertTrue(self.can(HR_OPTIONAL_THEN_HOD, [], HOD)[0])

    def test_hr_first_mirrors_hod_first(self):
        self.assertFalse(self.can(HR_THEN_HOD, [], HOD)[0])
        self.assertTrue(self.can(HR_THEN_HOD, [], HR)[0])
        self.assertTrue(self.can(HR_THEN_HOD, [HR], HOD)[0])

    def test_a_role_outside_the_pipeline_never_decides(self):
        ok, message, status, code = self.can(HOD_ONLY, [], HR)
        self.assertEqual((ok, status, code), (False, 403, "role_not_in_pipeline"))
        self.assertIn("does not take part", message)

    def test_only_the_named_early_rejectors_may_reject_out_of_turn_and_never_approve(self):
        self.assertFalse(self.can(HOD_THEN_HR, [], HR, "rejected")[0])
        self.assertTrue(self.can(HOD_THEN_HR, [], HR, "rejected", early=(HR,))[0])
        self.assertFalse(self.can(HOD_THEN_HR, [], HR, "approved", early=(HR,))[0])

    def test_position_and_satisfaction(self):
        self.assertEqual(approval.position(HOD_THEN_HR, set()), 0)
        self.assertEqual(approval.position(HOD_THEN_HR, {HOD}), 1)
        # an optional step is satisfied once a later step has been approved
        self.assertEqual(approval.satisfied_mask(HOD_OPTIONAL_THEN_HR, {HR}), [True, True])
        # a mandatory one is not
        self.assertEqual(approval.satisfied_mask(HOD_THEN_HR, {HR}), [False, True])
        self.assertEqual(approval.position(HOD_THEN_HR, {HR}), 0)

    def test_a_shrunk_pipeline_still_wants_a_final_confirmation_from_the_last_step(self):
        # HOD approved under a longer pipeline, HR then removed HR's step: nothing is finalised by the edit itself
        self.assertEqual(approval.position(HOD_ONLY, {HOD}), 0)
        self.assertTrue(self.can(HOD_ONLY, [HOD], HOD)[0])


class StepValidationTests(SimpleTestCase):
    def check(self, key, raw):
        return approval.validate_steps(approval.definition(key), raw)

    def test_accepts_every_shape_the_page_can_build(self):
        for raw, expected in (
            ([{"roles": ["hod", "hr"], "mandatory": True}], EITHER),
            ([{"roles": ["hod"]}, {"roles": ["hr"]}], HOD_THEN_HR),
            ([{"roles": ["hr"], "mandatory": False}, {"roles": ["hod"]}], (S(HR, mandatory=False), S(HOD))),
            ([{"role": "hod"}], HOD_ONLY),
        ):
            steps, error = self.check("leave", raw)
            self.assertIsNone(error, raw)
            self.assertEqual(steps, expected)

    def test_the_last_step_is_always_mandatory(self):
        steps, _ = self.check("leave", [{"roles": ["hod"]}, {"roles": ["hr"], "mandatory": False}])
        self.assertTrue(steps[-1].mandatory)

    def test_rejects_what_cannot_work(self):
        cases = (
            ([], "at least one step"),
            (None, "at least one step"),
            ([{"roles": ["hod"]}, {"roles": ["hr"]}, {"roles": ["hod"]}], "at most 2 steps"),
            ([{"roles": ["hod"]}, {"roles": ["hod"]}], "more than one step"),
            ([{"roles": ["hod", "hr"]}, {"roles": ["hr"]}], "only be used when it is the only step"),
            ([{"roles": ["manager"]}], "not an approver role"),
            ([{"roles": []}], "needs a responsible role"),
            (["hod"], "not valid"),
        )
        for raw, fragment in cases:
            steps, error = self.check("leave", raw)
            self.assertIsNone(steps, raw)
            self.assertIn(fragment, error, raw)

    def test_a_fixed_pipeline_cannot_be_edited(self):
        for key in ("advance", "request", "on_duty_punch", "attendance_correction"):
            steps, error = self.check(key, [{"roles": ["hod"]}])
            self.assertIsNone(steps, key)
            self.assertIn("is fixed", error)

    def test_a_role_that_does_not_belong_is_refused(self):
        # every editable workflow lets both roles in, so use a workflow definition with a narrower list
        narrow = approval.WorkflowDef(
            key="x",
            label="X",
            group="g",
            purpose="p",
            requested_by="Employee",
            default_steps=HR_ONLY,
            allowed_roles=(HR,),
        )
        steps, error = approval.validate_steps(narrow, [{"roles": ["hod"]}])
        self.assertIsNone(steps)
        self.assertIn("cannot be responsible", error)


class ConfigCacheMixin:
    """The pipelines are remembered per request; tests call the code directly (no request boundary), so start and end
    every test with an empty memory - a pipeline one test configured must never leak into the next test or suite."""

    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)


class CatalogTests(ConfigCacheMixin, TestCase):
    def test_every_definition_is_consistent(self):
        keys = [d.key for d in approval.DEFINITIONS]
        self.assertEqual(len(keys), len(set(keys)))
        for d in approval.DEFINITIONS:
            self.assertTrue(d.default_steps, d.key)
            self.assertLessEqual(len(d.default_steps), approval.MAX_STEPS, d.key)
            roles = [r for s in d.default_steps for r in s.roles]
            self.assertTrue(set(roles) <= set(d.allowed_roles), d.key)
            self.assertEqual(len(roles), len(set(roles)), d.key)
            self.assertTrue(d.default_steps[-1].mandatory, d.key)
            if d.editable:  # the built-in pipeline is always one HR could have entered
                steps, error = approval.validate_steps(
                    d, [{"roles": list(s.roles), "mandatory": s.mandatory} for s in d.default_steps]
                )
                self.assertIsNone(error, d.key)
            if d.hod_flag:
                self.assertTrue(hasattr(DepartmentManager, d.hod_flag), d.key)

    def test_the_built_in_pipelines_are_the_ones_the_hrms_always_had(self):
        expected = {
            "leave": EITHER,
            "permission": EITHER,
            "casual_leave": EITHER,
            "outpass": EITHER,
            "missing_punch": HOD_THEN_HR,
            "on_duty": HOD_OPTIONAL_THEN_HR,
            "resignation": HOD_THEN_HR,
            "attendance_correction": HOD_ONLY,
            "on_duty_punch": HR_ONLY,
            "advance": HR_ONLY,
            "request": HR_ONLY,
        }
        self.assertEqual({d.key: d.default_steps for d in approval.DEFINITIONS}, expected)
        self.assertEqual(ApprovalWorkflowConfig.objects.count(), 0)  # nothing is stored until HR edits something
        for key, steps in expected.items():
            cfg = approval.get_config(key)
            self.assertEqual((cfg.steps, cfg.enabled, cfg.customised), (steps, True, False), key)

    def test_every_staged_workflow_has_an_adapter_and_the_fixed_ones_do_not_need_one(self):
        for d in approval.DEFINITIONS:
            if d.key in ("on_duty_punch", "advance", "request"):
                self.assertIsNone(approval.adapter(d.key), d.key)
            else:
                self.assertIsNotNone(approval.adapter(d.key), d.key)

    def test_status_projection_keeps_the_names_older_clients_know(self):
        for key in ("leave", "permission", "casual_leave", "outpass", "attendance_correction"):
            self.assertEqual(approval.project_status(key, (HOD,)), "pending")
            self.assertEqual(approval.project_status(key, (HR,)), "pending")
        for key in ("missing_punch", "on_duty"):
            self.assertEqual(approval.project_status(key, (HOD,)), "pending_hod")
            self.assertEqual(approval.project_status(key, (HR,)), "pending_hr")
        self.assertEqual(approval.project_status("resignation", (HOD,)), "pending")  # awaiting the Department Head
        self.assertEqual(approval.project_status("resignation", (HR,)), "dept_approved")  # awaiting HR


class DecideTests(ConfigCacheMixin, TestCase):
    """approval.decide() on a bare request object: the trail, the skipped steps, what happens next."""

    def req(self, status="pending", trail=None):
        return SimpleNamespace(status=status, approval_trail=trail)

    def test_an_intermediate_approval_passes_the_request_on_and_a_final_one_finishes_it(self):
        approval.save_config("leave", steps=HOD_THEN_HR, actor="t")
        r = self.req(trail=[])
        first = approval.decide("leave", r, HOD, "approved", actor="Suresh")
        self.assertEqual((first.kind, first.waiting, first.status), ("advanced", (HR,), "pending"))
        second = approval.decide("leave", r, HR, "approved", actor="Meena")
        self.assertEqual((second.kind, second.status), ("approved", "approved"))
        self.assertEqual([(e["role"], e["by"]) for e in r.approval_trail], [(HOD, "Suresh"), (HR, "Meena")])

    def test_a_rejection_is_terminal_and_recorded(self):
        r = self.req(trail=[])
        out = approval.decide("leave", r, HR, "rejected", actor="Meena", comment="No cover")
        self.assertTrue(out.rejected)
        self.assertEqual(r.approval_trail[0]["decision"], "rejected")
        self.assertEqual(r.approval_trail[0]["comment"], "No cover")

    def test_skipping_an_optional_step_is_recorded_on_the_deciding_entry(self):
        approval.save_config("on_duty", steps=HOD_OPTIONAL_THEN_HR, actor="t")
        r = self.req(status="pending_hod", trail=[])
        out = approval.decide("on_duty", r, HR, "approved", actor="Meena")
        self.assertEqual((out.kind, out.skipped), ("approved", (HOD,)))
        self.assertEqual(r.approval_trail[0]["skipped"], [HOD])

    def test_refusals_carry_a_message_and_a_status(self):
        r = self.req(status="approved", trail=[])
        with self.assertRaises(approval.ApprovalError) as ctx:
            approval.decide("leave", r, HR, "approved", actor="x")
        self.assertIn("already approved", ctx.exception.message)
        approval.save_config("leave", steps=HOD_THEN_HR, actor="t")
        with self.assertRaises(approval.ApprovalError) as ctx:
            approval.decide("leave", self.req(trail=[]), HR, "approved", actor="x")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (400, "not_your_turn"))
        with self.assertRaises(approval.ApprovalError):
            approval.decide("leave", self.req(trail=[]), HOD, "maybe", actor="x")

    def test_a_request_from_before_the_trail_existed_is_read_from_its_older_stamps(self):
        legacy = SimpleNamespace(
            status="pending_hr",
            approval_trail=None,
            hod_reviewed_by="Suresh",
            hod_reviewed_at=None,
            hod_review_comment=None,
            hr_reviewed_by=None,
        )
        self.assertEqual(approval.approved_roles(approval.trail_of("missing_punch", legacy)), {HOD})
        # `pending_hr` alone always meant the Department Head had approved
        bare = SimpleNamespace(status="pending_hr", approval_trail=None, hod_reviewed_by=None, hr_reviewed_by=None)
        self.assertEqual(approval.approved_roles(approval.trail_of("missing_punch", bare)), {HOD})
        # but an EMPTY trail is a real one: a request made under the pipeline, nobody has approved yet
        fresh = SimpleNamespace(status="pending_hr", approval_trail=[], hod_reviewed_by=None, hr_reviewed_by=None)
        self.assertEqual(approval.approved_roles(approval.trail_of("missing_punch", fresh)), set())
        resig = SimpleNamespace(status="dept_approved", approval_trail=None, dept_head_status="approved")
        self.assertEqual(approval.approved_roles(approval.trail_of("resignation", resig)), {HOD})


# ═════════════════════════════ helpers for the endpoint tests ═════════════════════════════


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class Base(ConfigCacheMixin, TestCase):
    def setUp(self):
        super().setUp()
        hr = HRUser.objects.create(username="wf_hr", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr_user = hr
        self.hr = _bearer({"role": "hr", "hrUserId": hr.id, "name": "Meena"})
        self.emp = Employee.objects.create(
            employee_code="W1",
            first_name="Asha",
            last_name="Kumar",
            status="active",
            employment_type="staff",
            join_date="2020-01-01",
        )
        self.boss = Employee.objects.create(
            employee_code="W9", first_name="Suresh", last_name="Raj", status="active", employment_type="staff"
        )
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.emp)
        self.emp_auth = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.hod = _bearer({"role": "employee", "employeeId": self.boss.id})
        # An employee may only request dates in the current month (api/request_window.py), and these tests file
        # dates in September 2026: pin India's "today" for the window inside that month.
        pin = mock.patch("api.request_window.ist_today", return_value=date(2026, 9, 28))
        pin.start()
        self.addCleanup(pin.stop)

    def configure(self, key, steps=None, enabled=None):
        return approval.save_config(key, steps=steps, enabled=enabled, actor="test")

    def send(self, method, path, body=None, who=None):
        return getattr(self.client, method)(path, body or {}, content_type="application/json", **(who or self.hr))

    def as_employee(self, method, path, body=None):
        return self.send(method, path, body, self.emp_auth)

    def as_hod(self, method, path, body=None):
        return self.send(method, path, body, self.hod)


# ═════════════════════════════ configuration API ═════════════════════════════


class ConfigApiTests(Base):
    def test_lists_every_workflow_with_its_pipeline_and_what_it_is_for(self):
        r = self.send("get", "/api/approval-workflows")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([w["key"] for w in body["workflows"]], [d.key for d in approval.DEFINITIONS])
        self.assertEqual({x["key"] for x in body["roles"]}, {"hod", "hr"})
        leave = next(w for w in body["workflows"] if w["key"] == "leave")
        self.assertEqual(leave["path"], "Employee → HOD or HR")
        self.assertEqual((leave["enabled"], leave["customised"], leave["editable"]), (True, False, True))
        self.assertIn("leave", leave["purpose"].lower())
        punch = next(w for w in body["workflows"] if w["key"] == "missing_punch")
        self.assertEqual(punch["path"], "Employee → HOD → HR")
        self.assertEqual(punch["hodSwitch"], "Can approve missing punch")
        advance = next(w for w in body["workflows"] if w["key"] == "advance")
        self.assertEqual((advance["editable"], advance["allowedRoles"]), (False, ["hr"]))
        self.assertTrue(advance["fixedNote"])
        self.assertFalse(next(w for w in body["workflows"] if w["key"] == "on_duty_punch")["canDisable"])

    def test_the_waiting_counts_follow_who_can_decide_today(self):
        MissingPunchRequest.objects.create(
            employee=self.emp,
            date=date(2026, 9, 1),
            punch_time=time(9, 0),
            punch_type="IN",
            reason="x",
            status="pending_hod",
        )
        rows = {w["key"]: w for w in self.send("get", "/api/approval-workflows").json()["workflows"]}
        self.assertEqual(rows["missing_punch"]["waiting"], {"total": 1, "hod": 1, "hr": 0})  # HR must wait for the HOD
        self.configure("missing_punch", HOD_OPTIONAL_THEN_HR)
        rows = {w["key"]: w for w in self.send("get", "/api/approval-workflows").json()["workflows"]}
        self.assertEqual(rows["missing_punch"]["waiting"], {"total": 1, "hod": 1, "hr": 1})

    def test_changing_a_pipeline_saves_it_audits_it_and_reprojects_waiting_requests(self):
        req = MissingPunchRequest.objects.create(
            employee=self.emp,
            date=date(2026, 9, 1),
            punch_time=time(9, 0),
            punch_type="IN",
            reason="x",
            status="pending_hod",
        )
        r = self.send(
            "put", "/api/approval-workflows/missing_punch", {"steps": [{"roles": ["hr"]}, {"roles": ["hod"]}]}
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["path"], "Employee → HR → HOD")
        self.assertTrue(body["customised"])
        self.assertEqual(body["updatedBy"], "Meena")
        req.refresh_from_db()
        self.assertEqual(req.status, "pending_hr")  # the request now waits for HR first
        log = AuditLog.objects.filter(module="approval_workflow").latest("id")
        self.assertEqual(log.action, "update")
        self.assertEqual(log.old_values["steps"][0]["roles"], ["hod"])
        self.assertEqual(log.new_values["steps"][0]["roles"], ["hr"])
        self.assertIn("Employee → HR → HOD", log.record_description)

    def test_switching_a_workflow_off_and_on_and_putting_it_back_to_default(self):
        r = self.send("put", "/api/approval-workflows/leave", {"enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["enabled"])
        self.assertTrue(any("Switched OFF" in w for w in r.json()["warnings"]))
        self.assertFalse(approval.get_config("leave").enabled)
        r = self.send("put", "/api/approval-workflows/leave", {"enabled": True})
        self.assertTrue(r.json()["enabled"])
        self.assertEqual(ApprovalWorkflowConfig.objects.count(), 0)  # back to the built-in pipeline: no row is kept
        self.send("put", "/api/approval-workflows/leave", {"steps": [{"roles": ["hod"]}]})
        self.assertEqual(ApprovalWorkflowConfig.objects.count(), 1)
        r = self.send("delete", "/api/approval-workflows/leave")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["customised"])
        self.assertEqual(ApprovalWorkflowConfig.objects.count(), 0)
        self.assertEqual(AuditLog.objects.filter(module="approval_workflow", action="reset").count(), 1)

    def test_bad_input_is_refused_and_nothing_is_saved(self):
        cases = (
            ("leave", {}, 400),
            ("leave", {"enabled": "yes"}, 400),
            ("leave", {"steps": []}, 400),
            ("leave", {"steps": [{"roles": ["hod"]}, {"roles": ["hod"]}]}, 400),
            ("advance", {"steps": [{"roles": ["hod"]}]}, 400),  # fixed
            ("on_duty_punch", {"enabled": False}, 400),  # cannot be switched off
            ("nonsense", {"enabled": False}, 404),
        )
        for key, body, status in cases:
            self.assertEqual(self.send("put", f"/api/approval-workflows/{key}", body).status_code, status, (key, body))
        self.assertEqual(ApprovalWorkflowConfig.objects.count(), 0)
        self.assertEqual(self.send("delete", "/api/approval-workflows/nonsense").status_code, 404)

    def test_warnings_tell_hr_what_a_pipeline_would_mean(self):
        r = self.send("put", "/api/approval-workflows/leave", {"steps": [{"roles": ["hod"]}]}).json()
        joined = " ".join(r["warnings"])
        self.assertIn("HR is not part of this pipeline", joined)
        self.assertIn("mandatory", joined)
        # the per-person switch is worth knowing, not a problem with the pipeline: a hint, not a warning
        self.assertNotIn("Can approve leaves", joined)
        self.assertIn("Can approve leaves", " ".join(r["hints"]))
        # no Department Head in the pipeline, no hint about their switch
        r = self.send("put", "/api/approval-workflows/leave", {"steps": [{"roles": ["hr"]}]}).json()
        self.assertEqual(r["hints"], [])

    def test_the_summary_is_open_to_any_signed_in_user_and_only_them(self):
        self.configure("leave", HOD_THEN_HR)
        for who in (self.emp_auth, self.hod, self.hr):
            r = self.client.get("/api/approval-summary", **who)
            self.assertEqual(r.status_code, 200)
        body = self.client.get("/api/approval-summary", **self.emp_auth).json()
        self.assertEqual(body["leave"]["path"], "Employee → HOD → HR")
        self.assertEqual(body["leave"]["steps"][0], {"roles": ["hod"], "mandatory": True, "label": "HOD"})
        self.assertTrue(body["missing_punch"]["enabled"])
        self.assertEqual(self.client.get("/api/approval-summary").status_code, 401)
        # an employee cannot read or change the configuration itself
        self.assertEqual(self.client.get("/api/approval-workflows", **self.emp_auth).status_code, 403)
        self.assertEqual(
            self.send("put", "/api/approval-workflows/leave", {"enabled": False}, self.emp_auth).status_code, 403
        )

    def test_hr_roles_need_the_approval_workflow_permission(self):
        def hr_with(name, permissions):
            role = Role.objects.create(name=name, permissions=permissions)
            user = HRUser.objects.create(username=name, password_hash="x", role=role, is_super_admin=False)
            return _bearer({"role": "hr", "hrUserId": user.id})

        viewer = hr_with("wf_viewer", {"user_management.approval_workflow": "view"})
        editor = hr_with("wf_editor", {"user_management.approval_workflow": "edit"})
        parent = hr_with("wf_parent", {"user_management": "edit"})  # the whole User Management module, as before
        other = hr_with("wf_other", {"leave": "edit"})
        self.assertEqual(self.client.get("/api/approval-workflows", **viewer).status_code, 200)
        self.assertEqual(self.send("put", "/api/approval-workflows/leave", {"enabled": False}, viewer).status_code, 403)
        self.assertEqual(self.send("put", "/api/approval-workflows/leave", {"enabled": False}, editor).status_code, 200)
        self.assertEqual(self.send("put", "/api/approval-workflows/leave", {"enabled": True}, parent).status_code, 200)
        self.assertEqual(self.client.get("/api/approval-workflows", **other).status_code, 403)
        # HOD assignment is still governed by the parent module only
        self.assertEqual(self.client.get("/api/department-managers", **editor).status_code, 403)


# ═════════════════════════════ workflows on the engine ═════════════════════════════


class MissingPunchPipelineTests(Base):
    def submit(self):
        r = self.as_employee(
            "post",
            "/api/missing-punch-requests",
            {"date": "2026-09-01", "punchTime": "09:05", "punchSlot": "morning_in", "reason": "Machine down"},
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_decide(self, pk, status="approved"):
        return self.send("patch", f"/api/missing-punch-requests/{pk}/status", {"status": status})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/missing-punch-requests/{pk}/status", {"status": status})

    def test_default_pipeline_hod_then_hr_and_hr_cannot_jump_the_queue(self):
        data = self.submit()
        self.assertEqual((data["status"], data["approval"]["waitingFor"]), ("pending_hod", ["hod"]))
        self.assertEqual(data["approval"]["canAct"], {"hod": True, "hr": False})
        self.assertEqual(self.hr_decide(data["id"]).status_code, 400)
        self.assertEqual(self.hod_decide(data["id"]).status_code, 200)
        r = self.hr_decide(data["id"]).json()
        self.assertEqual(r["status"], "approved")
        self.assertEqual([s["state"] for s in r["approval"]["steps"]], ["approved", "approved"])
        self.assertTrue(AttendanceLog.objects.filter(employee=self.emp, source="missing_punch:approved").exists())

    def test_hr_first_then_hod_and_the_punch_is_only_added_at_the_end(self):
        self.configure("missing_punch", HR_THEN_HOD)
        data = self.submit()
        self.assertEqual(data["status"], "pending_hr")  # it starts with HR now
        self.assertEqual(self.hod_decide(data["id"]).status_code, 400)  # the HOD waits their turn
        step1 = self.hr_decide(data["id"]).json()
        self.assertEqual((step1["status"], step1["approval"]["waitingFor"]), ("pending_hod", ["hod"]))
        self.assertFalse(AttendanceLog.objects.filter(source="missing_punch:approved").exists())
        # the HOD is told the request has reached them
        self.assertTrue(Notification.objects.filter(employee=self.boss, type="missing_punch").exists())
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        self.assertTrue(AttendanceLog.objects.filter(employee=self.emp, source="missing_punch:approved").exists())

    def test_a_single_hod_step_lets_the_hod_finish_it_and_shuts_hr_out(self):
        self.configure("missing_punch", HOD_ONLY)
        data = self.submit()
        r = self.hr_decide(data["id"])
        self.assertEqual((r.status_code, r.json()["code"]), (403, "role_not_in_pipeline"))
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        self.assertTrue(AttendanceLog.objects.filter(employee=self.emp, source="missing_punch:approved").exists())

    def test_a_rejection_by_either_role_is_final(self):
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"], "rejected").json()["status"], "rejected")
        self.assertEqual(self.hod_decide(data["id"]).status_code, 400)  # already decided
        self.assertFalse(AttendanceLog.objects.filter(source="missing_punch:approved").exists())

    def test_off_refuses_new_requests_but_lets_waiting_ones_finish(self):
        data = self.submit()
        self.configure("missing_punch", enabled=False)
        r = self.as_employee(
            "post",
            "/api/missing-punch-requests",
            {"date": "2026-09-02", "punchTime": "09:05", "punchSlot": "morning_in", "reason": "again"},
        )
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        self.assertIn("switched off", r.json()["error"])
        self.assertEqual(MissingPunchRequest.objects.count(), 1)
        self.assertEqual(self.hod_decide(data["id"]).status_code, 200)  # the waiting one is still decidable
        self.assertEqual(self.hr_decide(data["id"]).json()["status"], "approved")


class LeavePipelineTests(Base):
    def setUp(self):
        super().setUp()
        self.lt, _ = LeaveType.objects.get_or_create(code="CL", defaults={"name": "Casual", "max_days_per_year": 12})
        self.balance = LeaveBalance.objects.create(
            employee=self.emp, leave_type=self.lt, year=2026, allocated=12, used=0, remaining=12
        )

    def submit(self, days=2):
        r = self.as_employee(
            "post",
            "/api/leave-requests",
            {
                "startDate": "2026-09-24",
                "endDate": "2026-09-25" if days == 2 else "2026-09-24",
                "leaveTypeId": self.lt.id,
                "reason": "Family",
            },
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_decide(self, pk, status="approved"):
        return self.send("patch", f"/api/leave-requests/{pk}/status", {"status": status, "hrComment": "ok"})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/leave-requests/{pk}/status", {"status": status})

    def used(self):
        self.balance.refresh_from_db()
        return self.balance.used

    def test_default_either_role_is_final_and_a_hod_approval_now_uses_the_balance_too(self):
        data = self.submit()
        self.assertEqual(data["approval"]["canAct"], {"hod": True, "hr": True})
        r = self.hod_decide(data["id"]).json()
        self.assertEqual((r["status"], r["approverRole"]), ("approved", "dept_head"))
        self.assertEqual(self.used(), Decimal("2"))  # the balance no longer depends on who approved
        self.assertEqual(self.hr_decide(data["id"], "rejected").status_code, 200)  # HR may still correct a decision

    def test_without_an_early_reject_rule_rejecting_follows_approving(self):
        self.configure("leave", HOD_THEN_HR)
        block = self.submit()["approval"]
        self.assertEqual(block["canAct"], {"hod": True, "hr": False})
        self.assertEqual(block["canReject"], block["canAct"])

    def test_two_steps_hod_then_hr_keep_the_request_pending_until_the_last_step(self):
        self.configure("leave", HOD_THEN_HR)
        data = self.submit()
        self.assertEqual(self.hr_decide(data["id"]).status_code, 400)
        step1 = self.hod_decide(data["id"]).json()
        self.assertEqual((step1["status"], step1["approval"]["waitingFor"]), ("pending", ["hr"]))
        self.assertEqual(self.used(), Decimal("0"))  # nothing is deducted for a half-way approval
        self.assertEqual(step1["approval"]["steps"][0]["by"], "Suresh Raj")
        final = self.hr_decide(data["id"]).json()
        self.assertEqual(final["status"], "approved")
        self.assertEqual(self.used(), Decimal("2"))
        self.assertEqual(final["approvedBy"], "Meena")

    def test_hr_first_then_hod(self):
        self.configure("leave", HR_THEN_HOD)
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"]).status_code, 400)
        self.assertEqual(self.hr_decide(data["id"]).json()["approval"]["waitingFor"], ["hod"])
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        self.assertEqual(self.used(), Decimal("2"))

    def test_hod_only_removes_hr_from_deciding_and_from_changing_decisions(self):
        self.configure("leave", HOD_ONLY)
        data = self.submit()
        self.assertEqual(self.hr_decide(data["id"]).status_code, 403)
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        r = self.hr_decide(data["id"], "rejected")  # HR is not in the pipeline: no correcting either
        self.assertEqual(r.status_code, 403)
        # a comment-only edit is still fine
        self.assertEqual(
            self.send("patch", f"/api/leave-requests/{data['id']}/status", {"hrComment": "note"}).status_code, 200
        )

    def test_hr_only_removes_the_hod(self):
        self.configure("leave", HR_ONLY)
        data = self.submit()
        r = self.hod_decide(data["id"])
        self.assertEqual((r.status_code, r.json()["code"]), (403, "role_not_in_pipeline"))
        # and it is not on the HOD's list any more
        lists = self.as_hod("get", "/api/manager/pending-requests").json()
        self.assertEqual(lists["leaveRequests"], [])
        self.assertEqual(self.as_hod("get", "/api/manager/me").json()["pendingLeavesCount"], 0)
        self.assertEqual(self.hr_decide(data["id"]).json()["status"], "approved")

    def test_the_hod_list_and_counts_follow_the_pipeline_both_ways(self):
        self.configure("leave", HOD_THEN_HR)
        data = self.submit()
        me = self.as_hod("get", "/api/manager/me").json()
        self.assertEqual(me["pendingLeavesCount"], 1)
        self.assertTrue(me["approvalWorkflows"]["leave"]["enabled"])
        self.hod_decide(data["id"])
        # now it waits for HR: it leaves the HOD's queue
        self.assertEqual(self.as_hod("get", "/api/manager/me").json()["pendingLeavesCount"], 0)
        self.assertEqual(self.as_hod("get", "/api/manager/pending-requests").json()["leaveRequests"], [])
        # the HOD has already had their turn on that one: swapping the order later does not send it back to them
        self.configure("leave", HR_THEN_HOD)
        self.assertEqual(self.as_hod("get", "/api/manager/me").json()["pendingLeavesCount"], 0)
        # a NEW request under HR-then-HOD waits for HR first, and reaches the HOD's list only once HR has approved it
        fresh = self.submit()
        self.assertEqual(self.as_hod("get", "/api/manager/me").json()["pendingLeavesCount"], 0)
        self.hr_decide(fresh["id"])
        self.assertEqual(self.as_hod("get", "/api/manager/me").json()["pendingLeavesCount"], 1)
        listed = self.as_hod("get", "/api/manager/pending-requests").json()["leaveRequests"]
        self.assertEqual([r["id"] for r in listed], [fresh["id"]])

    def test_a_pipeline_edit_moves_requests_that_are_already_waiting(self):
        data = self.submit()
        self.configure("leave", HR_ONLY)  # HR takes the whole approval over
        self.assertEqual(self.hod_decide(data["id"]).status_code, 403)
        self.assertEqual(self.hr_decide(data["id"]).status_code, 200)

    def test_the_hr_dashboard_counts_only_what_hr_can_act_on(self):
        self.submit()
        self.assertEqual(self.client.get("/api/dashboard/hr-summary", **self.hr).json().get("pendingLeaves"), 1)
        self.configure("leave", HOD_ONLY)
        self.assertEqual(self.client.get("/api/dashboard/hr-summary", **self.hr).json().get("pendingLeaves"), 0)

    def test_off_refuses_new_leave_for_everyone(self):
        data = self.submit()
        self.configure("leave", enabled=False)
        r = self.as_employee(
            "post", "/api/leave-requests", {"startDate": "2026-10-01", "endDate": "2026-10-01", "reason": "x"}
        )
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        self.assertEqual(LeaveRequest.objects.count(), 1)
        self.assertEqual(self.hr_decide(data["id"]).status_code, 200)  # the one waiting can still be decided


class OnDutyPipelineTests(Base):
    def submit(self):
        r = self.as_employee("post", "/api/on-duty-sessions/request", {"destination": "ABC Traders"})
        self.assertEqual(r.status_code, 201, r.content)
        return OnDutySession.objects.get(pk=r.json()["sessionId"])

    def hr_decide(self, pk, status="approved"):
        return self.send("patch", f"/api/on-duty-sessions/{pk}/status", {"status": status})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/on-duty-sessions/{pk}/status", {"status": status})

    def test_default_hr_may_decide_without_waiting_for_the_hod(self):
        s = self.submit()
        self.assertEqual(s.status, "pending_hod")
        r = self.hr_decide(s.id)
        self.assertEqual(r.status_code, 200, r.content)
        s.refresh_from_db()
        self.assertEqual(s.status, "active")
        self.assertEqual(s.approval_trail[0]["skipped"], [HOD])
        self.assertTrue(OutpassRequest.objects.filter(on_duty_session=s, approver_role="system").exists())

    def test_making_the_hod_mandatory_holds_hr_back(self):
        self.configure("on_duty", HOD_THEN_HR)
        s = self.submit()
        self.assertEqual(self.hr_decide(s.id).status_code, 400)
        self.assertEqual(self.hod_decide(s.id).status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.status, "pending_hr")
        self.assertEqual(self.hr_decide(s.id).status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.status, "active")

    def test_hr_first_then_hod_and_the_session_starts_only_at_the_end(self):
        self.configure("on_duty", HR_THEN_HOD)
        s = self.submit()
        self.assertEqual(s.status, "pending_hr")
        self.assertEqual(self.hr_decide(s.id).status_code, 200)
        s.refresh_from_db()
        self.assertEqual((s.status, s.started_at), ("pending_hod", None))
        self.assertFalse(
            OutpassRequest.objects.filter(on_duty_session=s).exists()
        )  # the pass comes with the final approval
        self.assertEqual(self.hod_decide(s.id).status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.status, "active")
        self.assertTrue(OutpassRequest.objects.filter(on_duty_session=s).exists())

    def test_the_employee_keeps_working_under_a_request_that_is_still_waiting(self):
        self.configure("on_duty", HR_THEN_HOD)
        self.submit()
        body = self.as_employee("get", "/api/on-duty-sessions/status").json()
        self.assertEqual(body["session"]["status"], "active")  # framed for the employee as before
        self.assertEqual(body["session"]["approvalStatus"], "pending_hr")
        self.assertEqual(body["session"]["approval"]["waitingFor"], ["hr"])

    def test_a_rejection_at_any_step_ends_it(self):
        self.configure("on_duty", HOD_THEN_HR)
        s = self.submit()
        self.assertEqual(self.hod_decide(s.id, "rejected").status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.status, "rejected")
        self.assertEqual(self.hr_decide(s.id).status_code, 400)

    def test_off_stops_new_sessions(self):
        self.configure("on_duty", enabled=False)
        r = self.as_employee("post", "/api/on-duty-sessions/request", {"destination": "X"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))


class ResignationPipelineTests(Base):
    def submit(self):
        r = self.as_employee("post", "/api/my/resignation", {"reason": "Moving away"})
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_action(self, pk, action="approve"):
        return self.send("patch", f"/api/recruitment/resignations/{pk}/action", {"action": action, "hrComment": "ok"})

    def hod_action(self, pk, action="approve"):
        return self.as_hod("patch", f"/api/manager/resignations/{pk}/action", {"action": action, "comment": "ok"})

    def test_default_hod_then_hr_and_only_the_final_approval_deactivates_the_employee(self):
        data = self.submit()
        self.assertEqual(data["status"], "pending")
        self.assertEqual(self.hr_action(data["id"]).status_code, 400)  # HR cannot approve before the HOD
        step1 = self.hod_action(data["id"]).json()
        self.assertEqual(step1["status"], "dept_approved")
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "active")
        self.assertEqual(self.hr_action(data["id"]).json()["status"], "approved")
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "inactive")

    def test_hr_may_always_reject_even_before_the_hod(self):
        data = self.submit()
        r = self.hr_action(data["id"], "reject").json()
        self.assertEqual((r["status"], r["rejectedBy"]), ("rejected", "hr"))

    def test_the_approval_block_tells_rejecting_from_approving(self):
        data = self.submit()

        def block():
            rows = self.send("get", "/api/recruitment/resignations").json()
            return next(r for r in rows if r["id"] == data["id"])["approval"]

        # waiting for the HOD: HR may not approve yet but may always reject; the HOD may do both
        self.assertEqual(block()["canAct"], {"hod": True, "hr": False})
        self.assertEqual(block()["canReject"], {"hod": True, "hr": True})
        self.assertEqual(self.hod_action(data["id"]).status_code, 200)
        self.assertEqual(block()["canAct"], {"hod": False, "hr": True})
        self.assertEqual(block()["canReject"], {"hod": False, "hr": True})
        self.assertEqual(self.hr_action(data["id"]).status_code, 200)
        self.assertEqual(block()["canAct"], {"hod": False, "hr": False})
        self.assertEqual(block()["canReject"], {"hod": False, "hr": False})

    def test_hr_first_then_hod_uses_the_labels_older_clients_know(self):
        self.configure("resignation", HR_THEN_HOD)
        data = self.submit()
        self.assertEqual(data["status"], "dept_approved")  # "awaiting HR" has always been this label
        self.assertEqual(self.hod_action(data["id"]).status_code, 400)
        step1 = self.hr_action(data["id"]).json()
        self.assertEqual((step1["status"], step1["approval"]["waitingFor"]), ("pending", ["hod"]))  # "awaiting the HOD"
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "active")
        self.assertEqual(self.hod_action(data["id"]).json()["status"], "approved")
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "inactive")

    def test_the_hod_list_shows_what_the_hod_can_decide_now(self):
        self.configure("resignation", HR_THEN_HOD)
        data = self.submit()
        self.assertEqual(self.as_hod("get", "/api/manager/resignations").json(), [])
        self.hr_action(data["id"])
        rows = self.as_hod("get", "/api/manager/resignations").json()
        self.assertEqual([r["id"] for r in rows], [data["id"]])

    def test_off_stops_new_resignations(self):
        self.configure("resignation", enabled=False)
        r = self.as_employee("post", "/api/my/resignation", {"reason": "x"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))


class PermissionPipelineTests(Base):
    def submit(self):
        r = self.as_employee(
            "post",
            "/api/permissions",
            {
                "employeeId": self.emp.id,
                "date": "2026-09-24",
                "permissionTime": "09:30",
                "type": "morning_late_in",
                "reason": "Bank",
            },
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_decide(self, pk, status="approved"):
        return self.send("put", f"/api/permissions/{pk}", {"status": status, "hrComment": "ok"})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/permissions/{pk}/status", {"status": status})

    def test_default_either_role_decides(self):
        data = self.submit()
        self.assertEqual(data["approval"]["canAct"], {"hod": True, "hr": True})
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")

    def test_hod_then_hr(self):
        self.configure("permission", HOD_THEN_HR)
        data = self.submit()
        self.assertEqual(self.hr_decide(data["id"]).status_code, 400)
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "pending")
        self.assertEqual(self.hr_decide(data["id"]).json()["status"], "approved")
        self.assertEqual(EmployeePermission.objects.get(pk=data["id"]).approver_role, "hr")

    def test_hr_can_still_classify_a_request_while_deciding_it(self):
        data = self.submit()
        r = self.send("put", f"/api/permissions/{data['id']}", {"status": "approved", "type": "evening_early_out"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["typeKey"], "evening_early_out")

    def test_a_refused_decision_does_not_half_save_a_type_change(self):
        self.configure("permission", HOD_THEN_HR)
        data = self.submit()
        r = self.send("put", f"/api/permissions/{data['id']}", {"status": "approved", "type": "evening_early_out"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(EmployeePermission.objects.get(pk=data["id"]).type_key, "morning_late_in")

    def test_off_stops_new_permissions(self):
        self.configure("permission", enabled=False)
        r = self.as_employee(
            "post", "/api/permissions", {"employeeId": self.emp.id, "date": "2026-09-25", "type": "morning_late_in"}
        )
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))


class CasualLeavePipelineTests(Base):
    def submit(self):
        r = self.as_employee("post", "/api/casual-leaves", {"date": "2026-09-24", "reason": "Function"})
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_decide(self, pk, status="approved"):
        return self.send("patch", f"/api/casual-leaves/{pk}", {"status": status})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/casual-leaves/{pk}/status", {"status": status})

    def test_default_final_writes_a_paid_present_day(self):
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 9, 24))
        self.assertEqual((rec.status, rec.shifts_earned, rec.source), ("present", Decimal("1.00"), "manual"))

    def test_a_half_way_approval_writes_no_attendance_until_the_last_step(self):
        self.configure("casual_leave", HOD_THEN_HR)
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "pending")
        self.assertFalse(
            AttendanceDayRecord.objects.filter(employee=self.emp, date=date(2026, 9, 24), source="manual").exists()
        )
        self.assertEqual(self.hr_decide(data["id"]).json()["status"], "approved")
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 9, 24)).status, "present")

    def test_a_rejection_marks_the_day_as_leave_as_before(self):
        data = self.submit()
        self.assertEqual(self.hr_decide(data["id"], "rejected").json()["status"], "rejected")
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 9, 24)).status, "on_leave")

    def test_off_stops_new_requests(self):
        self.configure("casual_leave", enabled=False)
        r = self.as_employee("post", "/api/casual-leaves", {"date": "2026-09-24"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))


class OutpassPipelineTests(Base):
    def submit(self):
        r = self.as_employee("post", "/api/outpass-requests", {"destination": "Bank", "reason": "Cheque deposit"})
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def hr_decide(self, pk, status="approved"):
        return self.send("put", f"/api/outpass-requests/{pk}/hr-status", {"status": status})

    def hod_decide(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/outpass-requests/{pk}/status", {"status": status})

    def test_default_either_role_and_the_pass_is_issued_once(self):
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "approved")
        self.assertEqual(OutpassRecord.objects.count(), 1)
        # HR can no longer re-approve it (that used to issue a second pass)
        self.assertEqual(self.hr_decide(data["id"]).status_code, 400)
        self.assertEqual(OutpassRecord.objects.count(), 1)

    def test_hod_then_hr_issues_the_pass_only_at_the_end(self):
        self.configure("outpass", HOD_THEN_HR)
        data = self.submit()
        self.assertEqual(self.hod_decide(data["id"]).json()["status"], "pending")
        self.assertEqual(OutpassRecord.objects.count(), 0)
        self.assertEqual(self.hr_decide(data["id"]).json()["status"], "approved")
        self.assertEqual(OutpassRecord.objects.count(), 1)

    def test_a_pass_raised_by_an_on_duty_approval_has_no_pipeline(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="ABC", status="pending_hr")
        self.send("patch", f"/api/on-duty-sessions/{session.id}/status", {"status": "approved"})
        listed = self.send("get", "/api/outpass-requests").json()
        row = next(r for r in listed if r["source"] == "on_duty")
        self.assertIsNone(row["approval"])

    def test_off_stops_new_requests(self):
        self.configure("outpass", enabled=False)
        r = self.as_employee("post", "/api/outpass-requests", {"destination": "x", "reason": "y"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))


class AttendanceCorrectionAndFixedWorkflowTests(Base):
    def test_a_correction_is_decided_by_the_hod_and_can_be_switched_off(self):
        AttendanceDayRecord.objects.create(employee=self.emp, date=date(2026, 9, 1), status="absent", shifts_earned=0)
        r = self.send(
            "post", "/api/attendance/override", {"employeeId": self.emp.id, "date": "2026-09-01", "status": "present"}
        )
        self.assertEqual(r.status_code, 202, r.content)
        req_id = r.json()["request"]["id"]
        self.assertEqual(r.json()["request"]["approval"]["waitingFor"], ["hod"])
        ok = self.as_hod("patch", f"/api/manager/attendance-requests/{req_id}/status", {"status": "approved"})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 9, 1)).status, "present")
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=req_id).approval_trail[0]["role"], HOD)
        self.configure("attendance_correction", enabled=False)
        refused = self.send(
            "post", "/api/attendance/override", {"employeeId": self.emp.id, "date": "2026-09-02", "status": "present"}
        )
        self.assertEqual((refused.status_code, refused.json()["code"]), (403, "workflow_disabled"))
        # reverting a day to the automatic result is not a request, so it still works
        reset = self.send(
            "post", "/api/attendance/override", {"employeeId": self.emp.id, "date": "2026-09-01", "reset": True}
        )
        self.assertEqual(reset.status_code, 200)

    def test_advance_and_other_requests_can_be_switched_off(self):
        self.configure("advance", enabled=False)
        r = self.send("post", "/api/advances", {"employeeId": self.emp.id, "amount": 1000, "advanceType": "salary"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        self.configure("request", enabled=False)
        r = self.as_employee("post", "/api/employee-requests", {"subject": "Letter", "requestType": "document"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        self.configure("advance", enabled=True)
        r = self.send("post", "/api/advances", {"employeeId": self.emp.id, "amount": 1000, "advanceType": "salary"})
        self.assertEqual(r.status_code, 201, r.content)


class HodOwnRequestsTests(Base):
    """A Department Head never decides their own request, so it is not in their lists or counts either."""

    def setUp(self):
        super().setUp()
        # the head's own request, with the head individually assigned to themselves as well (the department case)
        ManagerEmployeeAssignment.objects.get_or_create(manager=self.manager, employee=self.boss)
        self.own = LeaveRequest.objects.create(
            employee=self.boss, type="casual", start_date="2026-10-05", end_date="2026-10-05", approval_trail=[]
        )
        self.theirs = LeaveRequest.objects.create(
            employee=self.emp, type="casual", start_date="2026-10-06", end_date="2026-10-06", approval_trail=[]
        )

    def test_pending_list_and_counts_leave_out_the_heads_own_request(self):
        rows = self.as_hod("get", "/api/manager/pending-requests").json()["leaveRequests"]
        self.assertEqual([r["id"] for r in rows], [self.theirs.id])
        me = self.as_hod("get", "/api/manager/me").json()
        self.assertEqual(me["pendingLeavesCount"], 1)

    def test_the_decision_endpoint_still_refuses_it(self):
        r = self.as_hod("patch", f"/api/manager/leave-requests/{self.own.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 403)


class WorkflowOffMessageTests(SimpleTestCase):
    def test_a_label_that_already_says_requests_is_not_doubled(self):
        for key, text in (
            ("leave", "Leave requests are switched off right now. Please contact HR."),
            ("request", "Other requests are switched off right now. Please contact HR."),
            ("on_duty", "On-Duty (Geo Attendance) requests are switched off right now. Please contact HR."),
        ):
            with self.subTest(key=key):
                with mock.patch.object(approval, "get_config", return_value=SimpleNamespace(enabled=False)):
                    with self.assertRaises(approval.ApprovalError) as ctx:
                        approval.require_enabled(key)
                self.assertEqual(ctx.exception.message, text)
                self.assertEqual(ctx.exception.code, "workflow_disabled")


class ResyncAndCacheTests(Base):
    def test_status_labels_follow_a_pipeline_edit_and_nothing_is_decided_by_it(self):
        rows = [
            MissingPunchRequest.objects.create(
                employee=self.emp,
                date=date(2026, 9, d),
                punch_time=time(9, 0),
                punch_type="IN",
                reason="x",
                status="pending_hod",
                approval_trail=[],
            )
            for d in (1, 2)
        ]
        self.configure("missing_punch", HR_THEN_HOD)
        self.assertEqual({MissingPunchRequest.objects.get(pk=r.pk).status for r in rows}, {"pending_hr"})
        self.configure("missing_punch", HOD_THEN_HR)
        self.assertEqual({MissingPunchRequest.objects.get(pk=r.pk).status for r in rows}, {"pending_hod"})
        self.assertFalse(AttendanceLog.objects.exists())  # relabelling never approves anything

    def test_a_change_reaches_the_next_read_without_a_restart(self):
        self.assertEqual(approval.get_config("leave").steps, EITHER)
        ApprovalWorkflowConfig.objects.create(key="leave", steps=[{"roles": ["hr"], "mandatory": True}])
        self.assertEqual(approval.get_config("leave").steps, HR_ONLY)  # saving a row drops the remembered pipelines
        ApprovalWorkflowConfig.objects.all().delete()
        self.assertEqual(approval.get_config("leave").steps, EITHER)

    def test_a_garbled_stored_pipeline_falls_back_to_the_built_in_one(self):
        ApprovalWorkflowConfig.objects.create(key="leave", steps=[{"roles": ["boss"]}])
        self.assertEqual(approval.get_config("leave").steps, EITHER)
        ApprovalWorkflowConfig.objects.filter(key="leave").update(steps="nonsense")
        approval.clear_cache()
        self.assertEqual(approval.get_config("leave").steps, EITHER)

    def test_a_row_for_a_fixed_workflow_cannot_change_its_pipeline(self):
        ApprovalWorkflowConfig.objects.create(key="advance", steps=[{"roles": ["hod"], "mandatory": True}])
        self.assertEqual(approval.get_config("advance").steps, HR_ONLY)
