"""MD portal, Recruitment: the figures on /md/recruitment, recomputable by hand from one small "company".

THE COMPANY (today is Monday 2026-10-05; the period most tests use is September 2026, whose previous period is
2026-08-02..2026-08-31):

  Units         Unit 1, Unit 2.   Departments: Stitching (Unit 1) S1, Cutting (Unit 1) C1, Accounts (Unit 1) AC1,
                Stitching (Unit 2) S2.  Required staff: S1 6, C1 3, S2 1, AC1 40.

  Employees     active: A1 S1 joined 2025-01-10 | A2 S1 2026-09-01 | A3 S1 PRODUCTION 2026-09-30 | A4 C1 2026-10-01 |
                A5 C1 2026-08-31 | A6 S2 "15/09/2026" | A7 AC1 join date "not a date" | A8 AC1 no join date |
                41 base staff in AC1 joined 2024-01-01.
                left:   L1 S1 (resigned, last day 09-10) | L2 S1 PRODUCTION joined 08-10, deactivated, last edit 09-20 |
                        L3 C1 (approved 09-30 23:30 IST, no last day) | L4 S2 (approved 10-01 00:30 IST, no last day) |
                        L5 C1 (approved, last day 10-20: still serving notice) | L6 S1 joined 06-01, last day 08-15 |
                        J1 S1 PRODUCTION joined 09-03, deactivated, last edit 09-25.
  Resignations  pending P1 (A1, raised 09-25, last day 10-25) | dept-approved P2 (A6, 09-30, last day 11-20) |
                pending P3 (A7, 10-02, no last day) | rejected R1 (A2, 09-12) | one request per leaver L1..L6.
  Jobs          open: Sewing Supervisor (S1, posted 08-01: 65 days) | Cutting Master (C1, 09-20: 15) | Accountant
                (AC1, 07-15: 82) | Driver (no department, 09-01: 34); closed: Old role.
  Applicants    job board: ap1..ap8 (see build_company).   Resumes: c1..c9.
"""

import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from .md_portal import common as C
from .md_portal.analytics import recruitment as R
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, read_only_db
from .clock import FACTORY_TZ
from .models import (
    Applicant,
    Branch,
    Department,
    DepartmentHeadcount,
    Employee,
    EmployeeDocument,
    HiringRuleSet,
    HRUser,
    Job,
    ResignationRequest,
    Role,
    ScreeningCandidate,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 5)


def ist(y, m, d, h=10, mi=0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=FACTORY_TZ)


@contextmanager
def frozen(today: date = TODAY):
    """Pin 'today' for code that reads the clock itself (the REST views and the tools): the period resolver's and the
    analytics' own. Direct calls pass ``today=`` instead."""
    real = R._clock
    with (
        mock.patch.object(C, "ist_today", return_value=today),
        mock.patch.object(R, "_clock", side_effect=lambda t=None: real(today if t is None else t)),
    ):
        yield


def period_of(**params) -> C.Period:
    return C.resolve_period(params, today=TODAY)


def scope_of(**params) -> C.Scope:
    return C.resolve_scope(params)


SEPT = {"month": "2026-09"}


# ─── fixture builders ───────────────────────────────────────────────────────────────────────────────────────────


def mk_emp(code, dept, *, kind="staff", status="active", joined=None, first=None, last="Test", branch=None, **extra):
    return Employee.objects.create(
        employee_code=code,
        first_name=first or code,
        last_name=last,
        department=dept,
        branch=branch or (dept.branch if dept else None),
        employment_type=kind,
        status=status,
        join_date=joined,
        **extra,
    )


def last_edit(emp, when):
    """Employee.updated_at is auto_now: a deactivation with no resignation is dated by it, so tests set it."""
    Employee.objects.filter(pk=emp.pk).update(updated_at=when)


def mk_resignation(emp, *, created, status="pending", reason="", lwd=None, approved_at=None, rejected_by=None, **kw):
    r = ResignationRequest.objects.create(
        employee=emp,
        reason=reason,
        last_working_date=lwd,
        status=status,
        approved_at=approved_at,
        approved_by="HR" if status == "approved" else None,
        rejected_by=rejected_by,
        **kw,
    )
    ResignationRequest.objects.filter(pk=r.pk).update(created_at=created)
    return r


def mk_job(title, dept, created, status="open"):
    job = Job.objects.create(title=title, department=dept, status=status)
    Job.objects.filter(pk=job.pk).update(created_at=created)
    return job


def mk_applicant(job, status, created, n=[0]):
    n[0] += 1
    a = Applicant.objects.create(job=job, name=f"Applicant {n[0]}", email=f"a{n[0]}@x.com", phone="9", status=status)
    Applicant.objects.filter(pk=a.pk).update(created_at=created)
    return a


def mk_candidate(rule_set, status, created, *, source="bulk", interview=None, invited=None, n=[0]):
    n[0] += 1
    c = ScreeningCandidate.objects.create(
        rule_set=rule_set,
        department=rule_set.department,
        resume_file=f"resumes/{n[0]}.pdf",
        original_filename=f"{n[0]}.pdf",
        candidate_name=f"Candidate {n[0]}",
        source=source,
        status=status,
        interview_datetime=interview,
        interview_invited_at=invited,
    )
    ScreeningCandidate.objects.filter(pk=c.pk).update(created_at=created)
    return c


class World:
    """Handles on the fixture, so a test can say ``w.A2`` instead of looking a row up."""


def build_company() -> World:
    w = World()
    w.U1 = Branch.objects.create(name="Unit 1", code="U1")
    w.U2 = Branch.objects.create(name="Unit 2", code="U2")
    w.S1 = Department.objects.create(name="Stitching", branch=w.U1)
    w.C1 = Department.objects.create(name="Cutting", branch=w.U1)
    w.AC1 = Department.objects.create(name="Accounts", branch=w.U1)
    w.S2 = Department.objects.create(name="Stitching", branch=w.U2)
    for dept, required in ((w.S1, 6), (w.C1, 3), (w.S2, 1), (w.AC1, 40)):
        DepartmentHeadcount.objects.create(department=dept, required_count=required)

    # active people
    w.A1 = mk_emp("A1", w.S1, joined="2025-01-10", first="Anil")
    w.A2 = mk_emp("A2", w.S1, joined="2026-09-01", first="Asha")
    w.A3 = mk_emp("A3", w.S1, kind="production", joined="2026-09-30", first="Arun")
    w.A4 = mk_emp("A4", w.C1, joined="2026-10-01", first="Alok")
    w.A5 = mk_emp("A5", w.C1, joined="2026-08-31", first="Amit")
    w.A6 = mk_emp("A6", w.S2, joined="15/09/2026", first="Anita")
    w.A7 = mk_emp("A7", w.AC1, joined="not a date", first="Ajay")
    w.A8 = mk_emp("A8", w.AC1, joined=None, first="Akash")
    Employee.objects.bulk_create(
        [
            Employee(
                employee_code=f"B{i:02d}",
                first_name="Base",
                last_name=str(i),
                department=w.AC1,
                branch=w.U1,
                employment_type="staff",
                status="active",
                join_date="2024-01-01",
            )
            for i in range(41)
        ]
    )

    # people who left
    w.L1 = mk_emp("L1", w.S1, status="inactive", joined="2025-03-01", first="Lata")
    w.L2 = mk_emp("L2", w.S1, kind="production", status="inactive", joined="2026-08-10", first="Lokesh")
    w.L3 = mk_emp("L3", w.C1, status="inactive", joined="2025-06-01", first="Laxmi")
    w.L4 = mk_emp("L4", w.S2, status="inactive", joined="2024-01-01", first="Lalit")
    w.L5 = mk_emp("L5", w.C1, status="inactive", joined="2025-02-01", first="Leena")
    w.L6 = mk_emp("L6", w.S1, status="inactive", joined="2026-06-01", first="Lavan")
    w.J1 = mk_emp("J1", w.S1, kind="production", status="inactive", joined="2026-09-03", first="Jeeva")
    last_edit(w.L2, ist(2026, 9, 20, 15))
    last_edit(w.J1, ist(2026, 9, 25, 12))

    mk_resignation(
        w.L1,
        created=ist(2026, 9, 2),
        status="approved",
        reason="Better opportunity with higher salary",
        lwd=date(2026, 9, 10),
        approved_at=ist(2026, 9, 5),
    )
    mk_resignation(
        w.L3,
        created=ist(2026, 9, 20),
        status="approved",
        reason="Health issues",
        approved_at=ist(2026, 9, 30, 23, 30),
    )
    mk_resignation(w.L4, created=ist(2026, 9, 25), status="approved", approved_at=ist(2026, 10, 1, 0, 30))
    mk_resignation(
        w.L5,
        created=ist(2026, 9, 28),
        status="approved",
        reason="Relocating to Chennai",
        lwd=date(2026, 10, 20),
        approved_at=ist(2026, 10, 1, 10),
    )
    mk_resignation(
        w.L6,
        created=ist(2026, 7, 30),
        status="approved",
        reason="Want to start my own business",
        lwd=date(2026, 8, 15),
        approved_at=ist(2026, 8, 5),
    )
    # still waiting, and one rejected
    w.P1 = mk_resignation(
        w.A1,
        created=ist(2026, 9, 25),
        reason="Got a better offer from another company",
        lwd=date(2026, 10, 25),
    )
    w.P2 = mk_resignation(
        w.A6, created=ist(2026, 9, 30), status="dept_approved", reason="family reasons", lwd=date(2026, 11, 20)
    )
    w.P3 = mk_resignation(w.A7, created=ist(2026, 10, 2))
    w.R1 = mk_resignation(
        w.A2, created=ist(2026, 9, 12), status="rejected", reason="Personal reasons", rejected_by="hr"
    )

    # job board
    w.Ja = mk_job("Sewing Supervisor", w.S1, ist(2026, 8, 1))
    w.Jb = mk_job("Cutting Master", w.C1, ist(2026, 9, 20))
    w.Jc = mk_job("Accountant", w.AC1, ist(2026, 7, 15))
    w.Jd = mk_job("Old role", w.S1, ist(2026, 1, 1), status="closed")
    w.Je = mk_job("Driver", None, ist(2026, 9, 1))
    mk_applicant(w.Ja, "applied", ist(2026, 9, 3))  # ap1
    mk_applicant(w.Ja, "attended", ist(2026, 9, 10))  # ap2
    mk_applicant(w.Ja, "selected", ist(2026, 9, 12))  # ap3
    mk_applicant(w.Ja, "rejected", ist(2026, 9, 14))  # ap4
    mk_applicant(w.Ja, "weird", ist(2026, 9, 15))  # ap5: a status nobody defined
    mk_applicant(w.Ja, "applied", ist(2026, 8, 10))  # ap6: the previous period
    mk_applicant(
        w.Jb, "applied", ist(2026, 10, 1, 0, 30)
    )  # ap7: 00:30 IST on 1 Oct, still 30 Sep in UTC: NOT September
    mk_applicant(w.Jb, "attended", ist(2026, 9, 1, 0, 30))  # ap8: 00:30 IST on 1 Sep, still 31 Aug in UTC: September

    # resume screening
    w.rs_s1 = HiringRuleSet.objects.create(name="Stitching rules", department=w.S1)
    w.rs_c1 = HiringRuleSet.objects.create(name="Cutting rules", department=w.C1)
    mk_candidate(w.rs_s1, "shortlisted", ist(2026, 9, 5))  # c1
    mk_candidate(w.rs_s1, "not_shortlisted", ist(2026, 9, 5))  # c2
    mk_candidate(
        w.rs_s1, "selected", ist(2026, 9, 6), source="single", interview=ist(2026, 9, 20, 11), invited=ist(2026, 9, 10)
    )  # c3: interviewed
    mk_candidate(
        w.rs_s1, "rejected", ist(2026, 9, 6), interview=ist(2026, 9, 25, 11), invited=ist(2026, 9, 12)
    )  # c4: rejected after the interview
    mk_candidate(w.rs_c1, "screened", ist(2026, 9, 10), source="single")  # c5
    mk_candidate(w.rs_c1, "uploaded", ist(2026, 9, 10), source="single")  # c6
    mk_candidate(
        w.rs_c1, "selected", ist(2026, 9, 12), interview=ist(2026, 10, 7, 10), invited=ist(2026, 10, 1)
    )  # c7: interview in two days
    mk_candidate(w.rs_s1, "shortlisted", ist(2026, 8, 20))  # c8: previous period
    mk_candidate(w.rs_s1, "uploaded", ist(2026, 5, 1), source="single")  # c9: months old

    # onboarding documents
    for category in (
        EmployeeDocument.CATEGORY_PAN,
        EmployeeDocument.CATEGORY_AADHAAR,
        EmployeeDocument.CATEGORY_BANK_PASSBOOK,
    ):
        EmployeeDocument.objects.create(employee=w.A2, category=category, file="d.pdf", original_filename="d.pdf")
    for category in (
        EmployeeDocument.CATEGORY_PAN,
        EmployeeDocument.CATEGORY_AADHAAR,
        EmployeeDocument.CATEGORY_EDUCATION,
        EmployeeDocument.CATEGORY_VOTER_BIRTH,
        EmployeeDocument.CATEGORY_BANK_PASSBOOK,
        EmployeeDocument.CATEGORY_STAFF_LETTER,
    ):
        EmployeeDocument.objects.create(employee=w.A6, category=category, file="d.pdf", original_filename="d.pdf")
    return w


class Company(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.w = build_company()

    def get(self, path, **params):
        with frozen():
            return super().get(path, **params)


# ─── the pure pieces ────────────────────────────────────────────────────────────────────────────────────────────


class ReasonGroups(SimpleTestCase):
    def test_each_group_and_the_fallbacks(self):
        cases = {
            "Better opportunity with higher salary": "pay",
            "Got a better offer from another company": "pay",
            "I am pregnant and need rest": "health",
            "Health issues": "health",
            "Personal reasons": "family",
            "Marriage next month": "family",
            "Need to look after my parents": "family",
            "Relocating to Chennai": "relocation",
            "Too far from my home, long commute": "relocation",
            "Want to start my own business": "business",
            "Going for higher studies": "growth",
            "No growth or promotion": "growth",
            "Too much work pressure from the manager": "work",
            "": "not_stated",
            "   ": "not_stated",
            "Because of reasons": "other",
        }
        for text, expected in cases.items():
            self.assertEqual(R.reason_group(text)[0], expected, text)
        self.assertEqual(R.reason_group(None), R.REASON_NOT_STATED)

    def test_the_first_matching_group_wins_in_a_stated_order(self):
        # health and family outrank pay: "treatment for my mother" is not a pay reason even if salary is mentioned
        self.assertEqual(R.reason_group("Mother needs treatment, also salary is low")[0], "health")
        # "business" must not be read as the bus (relocation)
        self.assertEqual(R.reason_group("my own business")[0], "business")
        self.assertEqual(R.reason_group("The bus is late every day")[0], "relocation")

    def test_a_word_inside_another_word_is_not_a_keyword(self):
        self.assertEqual(R.reason_group("The payroll team was rude")[0], "pay")  # pay* stems are deliberate
        self.assertEqual(R.reason_group("I dislike the shiftless culture")[0], "work")
        self.assertEqual(
            R.reason_group("illustrious career")[0], "growth"
        )  # "ill" alone is a word, "illustrious" is not

    def test_the_status_vocabularies_match_the_report_centers(self):
        from .reporting.definitions import employees_admin_recruit as report

        self.assertEqual(tuple(s for s, _ in report.APPLICANT_STATUSES), R.APPLICANT_STATUSES)
        self.assertEqual(tuple(s for s, _ in report.CANDIDATE_STATUSES), R.CANDIDATE_STATUSES)

    def test_the_funnel_stage_builder_marks_what_a_pipeline_cannot_answer(self):
        stages = R._funnel_stages(
            {"applied": 10, "screened": 8, "shortlisted": 4, "interviewed": 4, "offered": 2},
            {"applied": 5, "screened": 5, "shortlisted": 2, "interviewed": 1},
            7,
            view="all",
        )
        self.assertEqual([s["count"] for s in stages], [15, 13, 6, 5, 2, 7])
        self.assertEqual(stages[1]["ofPrevious"], 86.7)  # 13 / 15
        self.assertEqual((stages[1]["dropOff"], stages[1]["dropOffPct"]), (2, 13.3))
        # "offered" is compared with the job-board interviews only (4), not with all 5
        self.assertEqual((stages[4]["previousCount"], stages[4]["ofPrevious"]), (4, 50.0))
        self.assertIn("job board", stages[4]["previousLabel"])
        self.assertIsNone(stages[5]["ofPrevious"])  # joined is not a share of anything
        screening = R._funnel_stages(
            None, {"applied": 5, "screened": 5, "shortlisted": 2, "interviewed": 1}, None, view="screening"
        )
        self.assertIsNone(screening[4]["count"])  # not tracked: None, not 0
        self.assertIsNone(screening[4]["dropOff"])

    def test_a_yearly_attrition_is_scaled_from_the_exact_rate(self):
        # 1 leaver on an average of 3 people over 30 days: 33.3% for the period; x 365 / 30 from the exact 33.33...
        # is 405.6, from the rounded 33.3 it would be 405.2
        move = {"leavers": [object()], "average": 3.0, "days": 30}
        self.assertEqual(R._attrition(move), (33.3, 405.6))
        self.assertEqual(R._attrition({**move, "days": 27}), (33.3, None))  # a short period is not scaled up
        self.assertEqual(R._attrition({**move, "average": None}), (None, None))
        self.assertEqual(R._attrition({**move, "average": 0}), (None, None))

    def test_no_whole_means_no_percentage(self):
        stages = R._funnel_stages({}, {}, 0, view="all")
        self.assertEqual([s["count"] for s in stages], [0, 0, 0, 0, 0, 0])
        self.assertTrue(all(s["ofPrevious"] is None for s in stages))


# ─── an empty database ──────────────────────────────────────────────────────────────────────────────────────────


class EmptyDatabase(MdApiTestCase):
    def test_every_function_answers_without_dividing_by_zero(self):
        scope, period = scope_of(), period_of(period="last_90_days")
        s = R.summary(scope, period, today=TODAY)["current"]
        for key in (
            "vacancies",
            "avgOpenDays",
            "oldestOpenDays",
            "avgTimeToFillDays",
            "attritionPct",
            "oldestPendingDays",
        ):
            self.assertIsNone(s[key], key)  # "no data" is null, never 0
        for key in ("openPositions", "applicantsInPipeline", "joiners", "leavers", "resignationsPending", "onNotice"):
            self.assertEqual(s[key], 0, key)
        self.assertEqual(R.summary(scope, period, today=TODAY)["changes"]["joiners"], {"abs": 0.0, "pct": None})

        f = R.funnel(scope, period, today=TODAY)
        self.assertEqual([x["count"] for x in f["stages"]], [0] * 6)
        self.assertEqual(f["byDepartment"], [])
        p = R.positions(scope, today=TODAY)
        self.assertEqual(
            (p["positions"], p["summary"]["avgOpenDays"], p["headcountGap"]["vacancies"]), ([], None, None)
        )
        r = R.resignations(scope, period, today=TODAY)
        self.assertEqual((r["pending"], r["reasons"], r["summary"]["avgDaysToDecision"]), ([], [], None))
        j = R.joiners(scope, period, today=TODAY)
        self.assertEqual((j["list"], j["earlyAttrition"]["pct"]), ([], None))
        t = R.trend(scope, today=TODAY)
        self.assertEqual(len(t["months"]), 12)
        self.assertTrue(all(m["vacancies"] is None for m in t["months"]))
        self.assertEqual(R.sources(scope, period)["total"], 0)
        self.assertEqual(R.attention(scope, period, today=TODAY)["items"], [])
        self.assertEqual(R.insights(today=TODAY), [])
        kpis = R.headline(today=TODAY)["kpis"]
        self.assertEqual([k["value"] for k in kpis], [0, 0, 0])

    def test_the_empty_state_says_why_vacancies_are_missing(self):
        notes = R.summary(scope_of(), period_of(period="last_90_days"), today=TODAY)["notes"]
        self.assertTrue(any("Required Roles" in n for n in notes))

    def test_every_endpoint_that_needs_the_plan_says_so_in_the_same_words_so_the_page_shows_it_once(self):
        scope, period = scope_of(), period_of(period="last_90_days")
        said = {
            "summary": R.summary(scope, period, today=TODAY)["notes"],
            "positions": R.positions(scope, today=TODAY)["notes"],
            "trend": R.trend(scope, today=TODAY)["notes"],
        }
        for name, notes in said.items():
            self.assertIn(R.NO_PLAN_NOTE, notes, name)

    def test_every_endpoint_is_a_200_with_provenance(self):
        for name in ("summary", "attention", "funnel", "positions", "resignations", "joiners", "trend", "sources"):
            r = self.get(f"/api/md/recruitment/{name}")
            self.assertEqual(r.status_code, 200, (name, r.content))
            self.assertIn("provenance", r.json(), name)


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────


class Summary(Company):
    def summary(self, scope=None, period=None):
        return R.summary(scope or scope_of(), period or period_of(**SEPT), today=TODAY)

    def test_where_hiring_stands_today(self):
        cur = self.summary()["current"]
        self.assertEqual(cur["openPositions"], 4)  # the closed posting is not counted
        self.assertEqual(
            (cur["vacancies"], cur["departmentsWithGap"]), (5, 2)
        )  # S1 4 + C1 1; AC1's surplus offsets nothing
        self.assertEqual((cur["stalePositions"], cur["oldestOpenDays"], cur["avgOpenDays"]), (2, 82, 49.0))
        self.assertIsNone(cur["avgTimeToFillDays"])
        self.assertEqual((cur["applicantsInPipeline"], cur["pipelineJobBoard"], cur["pipelineScreening"]), (11, 5, 6))
        self.assertEqual((cur["interviewsNext7Days"], cur["interviewsToday"]), (1, 0))
        self.assertEqual((cur["resignationsPending"], cur["oldestPendingDays"], cur["onNotice"]), (3, 10, 1))
        self.assertEqual(cur["leaversNext30"], 2)  # L5 serving notice + P1's requested last day

    def test_what_happened_in_the_period(self):
        cur = self.summary()["current"]
        self.assertEqual((cur["candidatesReceived"], cur["candidatesSelected"], cur["interviewsHeld"]), (13, 1, 2))
        self.assertEqual((cur["joiners"], cur["joinersStaff"], cur["joinersProduction"]), (4, 2, 2))
        self.assertEqual((cur["leavers"], cur["leaversResigned"], cur["leaversDeactivated"]), (4, 2, 2))
        self.assertEqual((cur["earlyLeavers"], cur["net"], cur["resignationsRaised"]), (2, 0, 7))

    def test_attrition_uses_the_average_of_the_rebuilt_opening_and_closing_headcount(self):
        cur = self.summary()["current"]
        # 50 people on 31 Aug and 50 on 30 Sep (L3 leaves ON 30 Sep so is not there at the end of it; L4 and L5 still are)
        self.assertEqual(cur["averageHeadcount"], 50.0)
        self.assertEqual(cur["attritionPct"], 8.0)  # 4 leavers / 50
        self.assertEqual(cur["attritionAnnualisedPct"], 97.3)  # 8.0 x 365 / 30

    def test_the_period_is_compared_with_the_one_before_it(self):
        s = self.summary()
        self.assertEqual(s["previousPeriod"]["start"], "2026-08-02")
        self.assertEqual(s["previousPeriod"]["end"], "2026-08-31")
        self.assertEqual(
            s["previous"],
            {
                "candidatesReceived": 2,  # ap6 and c8
                "candidatesSelected": 0,
                "interviewsHeld": 0,
                "joiners": 2,  # A5 (31 Aug, the last day counts) and L2
                "leavers": 1,  # L6
                "net": 1,
                "resignationsRaised": 0,
                "attritionPct": 2.0,  # 1 / ((49 + 50) / 2)
            },
        )
        ch = s["changes"]
        self.assertEqual(ch["joiners"], {"abs": 2.0, "pct": 100.0})
        self.assertEqual(ch["leavers"], {"abs": 3.0, "pct": 300.0})
        self.assertEqual(ch["net"], {"abs": -1.0, "pct": -100.0})
        self.assertEqual(ch["candidatesSelected"], {"abs": 1.0, "pct": None})  # from 0: no percentage
        self.assertEqual(ch["attritionPct"], {"abs": 6.0, "pct": 300.0})

    def test_a_period_wholly_in_the_future_has_nothing_to_report_and_nothing_to_divide_by(self):
        p = C.resolve_period({"from": "2026-11-01", "to": "2026-11-30"}, today=TODAY)
        cur = R.summary(scope_of(), p, today=TODAY)["current"]
        self.assertEqual((cur["joiners"], cur["leavers"], cur["candidatesReceived"]), (0, 0, 0))
        self.assertIsNone(cur["attritionPct"])
        self.assertIsNone(cur["averageHeadcount"])
        self.assertEqual(R.resignations(scope_of(), p, today=TODAY)["summary"]["raised"], 0)

    def test_a_period_that_crosses_a_month_and_a_year_boundary(self):
        # 20 Dec 2025 - 10 Jan 2026 and its previous 22 days: nothing happened, and nothing divides by zero
        p = C.resolve_period({"from": "2025-12-20", "to": "2026-01-10"}, today=TODAY)
        s = R.summary(scope_of(), p, today=TODAY)
        self.assertEqual(
            (s["current"]["joiners"], s["current"]["leavers"], s["current"]["candidatesReceived"]), (0, 0, 0)
        )
        self.assertEqual(s["previousPeriod"]["start"], "2025-11-28")
        self.assertEqual(s["current"]["attritionPct"], 0.0)  # 0 leavers over 49 people is 0%, not "no data"
        self.assertEqual(s["current"]["averageHeadcount"], 48.0)  # A1, A7, A8, 41 base + L1, L3, L4, L5

    def test_inclusive_ends(self):
        # A2 joined on 1 Sep and A3 on 30 Sep: a one-day period on each edge sees exactly that person
        first = R.summary(
            scope_of(), C.resolve_period({"from": "2026-09-01", "to": "2026-09-01"}, today=TODAY), today=TODAY
        )
        last = R.summary(
            scope_of(), C.resolve_period({"from": "2026-09-30", "to": "2026-09-30"}, today=TODAY), today=TODAY
        )
        self.assertEqual((first["current"]["joiners"], last["current"]["joiners"]), (1, 1))
        self.assertEqual(last["current"]["leavers"], 1)  # L3's approval at 23:30 IST on 30 Sep
        # L4's approval at 00:30 IST on 1 Oct is October (in UTC it is still 30 Sep)
        october = R.summary(
            scope_of(), C.resolve_period({"from": "2026-10-01", "to": "2026-10-01"}, today=TODAY), today=TODAY
        )
        self.assertEqual(october["current"]["leavers"], 1)
        self.assertEqual(october["current"]["joiners"], 1)  # A4

    def test_a_period_reaching_into_the_future_is_cut_at_today(self):
        p = C.resolve_period({"from": "2026-10-01", "to": "2026-10-31"}, today=TODAY)
        cur = R.summary(scope_of(), p, today=TODAY)["current"]
        self.assertEqual((cur["joiners"], cur["leavers"]), (1, 1))  # L5's 20 Oct last day has not happened yet
        self.assertEqual(
            cur["averageHeadcount"], (50 + 49) / 2
        )  # 30 Sep: 50. Today: the 49 active (L4 is gone, L5 inactive)

    def test_a_unit_narrows_people_and_jobs_alike(self):
        cur = self.summary(scope_of(branch="Unit 1"))["current"]
        self.assertEqual(cur["openPositions"], 3)  # the Driver posting has no department, so it belongs to no unit
        self.assertEqual(cur["avgOpenDays"], 54.0)  # (65 + 15 + 82) / 3
        self.assertEqual(cur["joiners"], 3)  # A6 is Unit 2
        self.assertEqual(cur["resignationsPending"], 2)  # P2 is A6's
        self.assertEqual(cur["vacancies"], 5)

    def test_a_department_name_covers_every_unit_that_has_it(self):
        cur = self.summary(scope_of(department="Stitching"))["current"]
        self.assertEqual(cur["openPositions"], 1)
        self.assertEqual((cur["joiners"], cur["leavers"], cur["net"]), (4, 3, 1))  # L4 left on 1 Oct
        self.assertEqual(cur["vacancies"], 4)  # S1 4, S2 0

    def test_staff_or_production_narrows_people_but_not_candidates(self):
        s = self.summary(scope_of(type="production"))
        cur = s["current"]
        self.assertEqual((cur["joiners"], cur["leavers"]), (2, 2))  # A3 and J1 / L2 and J1
        self.assertEqual(cur["openPositions"], 4)  # jobs do not record staff or production
        self.assertIsNone(cur["vacancies"])  # the plan is a staff plan
        self.assertTrue(any("do not record staff or production" in n for n in s["notes"]))
        staff = self.summary(scope_of(type="staff"))["current"]
        self.assertEqual(staff["joiners"], 2)

    def test_the_notes_warn_about_data_that_cannot_be_trusted(self):
        notes = self.summary()["notes"]
        self.assertTrue(any("2 of the 4 leavers" in n and "approximate" in n for n in notes))
        self.assertTrue(any("2 employees have no readable join date" in n for n in notes))

    def test_every_figure_is_explained(self):
        ids = {p["id"] for p in self.summary()["provenance"]}
        self.assertTrue(
            {"open-positions", "vacancies", "position-age", "time-to-fill", "pipeline", "interviews", "joiners"} <= ids
        )
        ttf = next(p for p in self.summary()["provenance"] if p["id"] == "time-to-fill")
        self.assertIn("cannot be measured", ttf["definition"])
        stale = next(p for p in self.summary()["provenance"] if p["id"] == "position-age")
        self.assertIn(f"{R.STALE_POSITION_DAYS} days", stale["filters"][0])

    def test_plain_json_only(self):
        json.dumps(self.summary())


# ─── funnel ─────────────────────────────────────────────────────────────────────────────────────────────────────


class Funnel(Company):
    def funnel(self, scope=None, period=None):
        return R.funnel(scope or scope_of(), period or period_of(**SEPT), today=TODAY)

    def test_the_combined_funnel(self):
        stages = {s["id"]: s for s in self.funnel()["stages"]}
        counts = {k: v["count"] for k, v in stages.items()}
        # job board: 6 applied (ap1-5 + ap8), 4 reviewed, 3 called/attended, 1 selected
        # resumes:   7 uploaded (c1-7), 6 screened (not "uploaded"), 4 shortlisted or later, 2 interviews already held
        self.assertEqual(
            counts, {"applied": 13, "screened": 10, "shortlisted": 7, "interviewed": 5, "offered": 1, "joined": 4}
        )
        self.assertEqual(stages["screened"]["ofPrevious"], 76.9)  # 10 / 13
        self.assertEqual((stages["screened"]["dropOff"], stages["screened"]["dropOffPct"]), (3, 23.1))
        self.assertEqual(stages["shortlisted"]["ofPrevious"], 70.0)  # 7 / 10
        self.assertEqual(stages["interviewed"]["ofPrevious"], 71.4)  # 5 / 7
        # selection is a job-board status only, so it is compared with the 3 job-board interviews
        self.assertEqual((stages["offered"]["previousCount"], stages["offered"]["ofPrevious"]), (3, 33.3))
        self.assertEqual((stages["offered"]["dropOff"], stages["offered"]["dropOffPct"]), (2, 66.7))
        self.assertIsNone(stages["joined"]["ofPrevious"])
        self.assertIn("not a share of those offered", stages["joined"]["note"])

    def test_each_pipeline_alone(self):
        views = self.funnel()["views"]
        board = [s["count"] for s in views["jobBoard"]]
        screening = [s["count"] for s in views["screening"]]
        self.assertEqual(board, [6, 4, 3, 3, 1, None])
        self.assertEqual(screening, [7, 6, 4, 2, None, None])
        self.assertEqual([s["ofPrevious"] for s in views["jobBoard"]][1:5], [66.7, 75.0, 100.0, 33.3])
        self.assertEqual([s["ofPrevious"] for s in views["screening"]][1:4], [85.7, 66.7, 50.0])
        self.assertIn("no final selection", views["screening"][4]["note"])

    def test_by_department(self):
        rows = {r["departmentId"]: r for r in self.funnel()["byDepartment"]}
        s1 = rows[self.w.S1.id]
        # Stitching (Unit 1): ap1-5 and c1-4 -> applied 5 + 4, screened 3 + 4, shortlisted 2 + 3, interviewed 2 + 2, offered 1
        self.assertEqual(
            (s1["applied"], s1["screened"], s1["shortlisted"], s1["interviewed"], s1["offered"]), (9, 7, 5, 4, 1)
        )
        self.assertEqual(s1["joined"], 3)  # A2, A3, J1
        self.assertEqual(s1["department"], "Stitching (Unit 1)")  # two units have a Stitching
        c1 = rows[self.w.C1.id]
        self.assertEqual(
            (c1["applied"], c1["screened"], c1["shortlisted"], c1["interviewed"]), (4, 3, 2, 1)
        )  # ap8 + c5-7
        self.assertEqual([r["departmentId"] for r in self.funnel()["byDepartment"]][:2], [self.w.S1.id, self.w.C1.id])

    def test_the_period_uses_factory_days(self):
        # ap8 (00:30 IST on 1 Sep) is in September; ap7 (00:30 IST on 1 Oct, 19:00 UTC on 30 Sep) is not
        sept = self.funnel()["stages"][0]["count"]
        before = R.funnel(
            scope_of(), C.resolve_period({"from": "2026-09-30", "to": "2026-09-30"}, today=TODAY), today=TODAY
        )
        self.assertEqual(before["stages"][0]["count"], 0)
        self.assertEqual(sept, 13)

    def test_previous_month(self):
        aug = R.funnel(scope_of(), period_of(month="2026-08"), today=TODAY)
        self.assertEqual(
            [s["count"] for s in aug["stages"]], [2, 1, 1, 0, 0, 2]
        )  # ap6 (applied) + c8 (shortlisted); A5 and L2 joined

    def test_a_department_narrows_both_pipelines(self):
        f = self.funnel(scope_of(department="Cutting"))
        self.assertEqual([s["count"] for s in f["stages"]][:5], [4, 3, 2, 1, 0])
        self.assertEqual(f["joiners"]["total"], 0)

    def test_joiners_are_all_new_employees_and_say_they_are_not_linked(self):
        j = self.funnel()["joiners"]
        self.assertEqual((j["total"], j["staff"], j["production"], j["linked"]), (4, 2, 2, False))

    def test_the_mapping_is_documented_for_the_assistant(self):
        entry = next(p for p in self.funnel()["provenance"] if p["id"] == "funnel")
        text = " ".join([entry["definition"], *entry["filters"], *entry["caveats"]])
        for needle in ("Attended or Selected", "Shortlisted, Selected or Rejected", "no status history", "not a share"):
            self.assertIn(needle, text)

    def test_the_funnel_agrees_with_the_report_centers_recruitment_funnel(self):
        r = self.client.get(
            "/api/reports/run/recruitment-funnel",
            {"dateFrom": "2026-09-01", "dateTo": "2026-09-30"},
            **md_headers(self.md),
        )
        self.assertEqual(r.status_code, 200, r.content)
        summary = {s["label"]: s["value"] for s in r.json()["summary"]}
        views = self.funnel()["views"]
        self.assertEqual(summary["Screened candidates"], views["screening"][0]["count"])  # 7
        self.assertEqual(summary["Job-board applicants"], views["jobBoard"][0]["count"])  # 6
        rows = r.json()["rows"]
        self.assertEqual(sum(row["applicantsSelected"] for row in rows), views["jobBoard"][4]["count"])
        self.assertEqual(sum(row["shortlisted"] + row["selected"] for row in rows), 3)  # c1, c3, c7; c4 is "rejected"


class FunnelSources(Company):
    def test_where_candidates_come_from(self):
        s = R.sources(scope_of(), period_of(**SEPT))
        board, resumes = s["channels"]
        self.assertEqual(
            (board["id"], board["candidates"], board["progressed"], board["progressedPct"]), ("job_board", 6, 3, 50.0)
        )
        self.assertEqual(
            (resumes["id"], resumes["candidates"], resumes["progressed"], resumes["progressedPct"]),
            ("resume_upload", 7, 4, 57.1),
        )
        self.assertEqual(resumes["detail"], "3 single · 4 bulk uploads")  # c3, c5, c6 single; c1, c2, c4, c7 bulk
        self.assertEqual(s["total"], 13)
        caveats = " ".join(s["provenance"][0]["caveats"])
        self.assertIn("referral", caveats)  # honest about what is not recorded


# ─── positions ──────────────────────────────────────────────────────────────────────────────────────────────────


class Positions(Company):
    def positions(self, scope=None, **kw):
        return R.positions(scope or scope_of(), today=TODAY, **kw)

    def test_open_positions_oldest_first_with_their_age_and_stage_mix(self):
        p = self.positions()
        self.assertEqual(
            [(x["title"], x["daysOpen"], x["stale"]) for x in p["positions"]],
            [
                ("Accountant", 82, True),
                ("Sewing Supervisor", 65, True),
                ("Driver", 34, False),
                ("Cutting Master", 15, False),
            ],
        )
        sewing = p["positions"][1]
        self.assertEqual(sewing["stageMix"], {"applied": 2, "attended": 1, "selected": 1, "rejected": 1, "other": 1})
        self.assertEqual(sewing["applicants"], 6)
        self.assertEqual(
            (sewing["department"], sewing["unit"], sewing["postedOn"]), ("Stitching (Unit 1)", "Unit 1", "2026-08-01")
        )
        self.assertEqual(p["positions"][3]["stageMix"]["attended"], 1)  # ap8; ap7 is "applied"
        self.assertIsNone(p["positions"][2]["department"])  # the Driver posting has none
        self.assertEqual(
            p["summary"],
            {**p["summary"], "open": 4, "stale": 2, "avgOpenDays": 49.0, "oldestOpenDays": 82, "staleAfterDays": 45},
        )
        self.assertEqual(p["summary"]["withApplicants"], 2)

    def test_stale_means_open_for_more_than_the_threshold(self):
        mk_job("Exactly at the line", self.w.C1, ist(2026, 8, 21))  # 45 days
        mk_job("One day over", self.w.C1, ist(2026, 8, 20))  # 46 days
        flags = {x["title"]: x["stale"] for x in self.positions()["positions"]}
        self.assertEqual((flags["Exactly at the line"], flags["One day over"]), (False, True))

    def test_the_headcount_gap_by_department(self):
        gap = self.positions()["headcountGap"]
        self.assertEqual(
            (gap["required"], gap["current"], gap["vacancies"], gap["surplus"], gap["departmentsWithGap"]),
            (50, 48, 5, 3, 2),
        )
        rows = {r["departmentId"]: r for r in gap["departments"]}
        self.assertEqual(
            (
                rows[self.w.S1.id]["required"],
                rows[self.w.S1.id]["current"],
                rows[self.w.S1.id]["vacancy"],
                rows[self.w.S1.id]["fillPct"],
            ),
            (6, 2, 4, 33.3),  # A3 is production: the plan counts staff
        )
        self.assertEqual((rows[self.w.C1.id]["vacancy"], rows[self.w.C1.id]["fillPct"]), (1, 66.7))
        self.assertEqual(
            (rows[self.w.AC1.id]["vacancy"], rows[self.w.AC1.id]["surplus"], rows[self.w.AC1.id]["fillPct"]),
            (0, 3, 107.5),
        )
        self.assertEqual(
            (rows[self.w.S1.id]["openJobs"], rows[self.w.C1.id]["shortlisted"]), (1, 1)
        )  # Ja; c7 (selected)
        self.assertEqual(
            [r["departmentId"] for r in gap["departments"]][:2], [self.w.S1.id, self.w.C1.id]
        )  # biggest gap first

    def test_a_department_without_a_plan_adds_nothing(self):
        extra = Department.objects.create(name="Packing", branch=self.w.U1)
        mk_emp("PK1", extra, joined="2025-01-01")
        gap = self.positions()["headcountGap"]
        self.assertNotIn(extra.id, [r["departmentId"] for r in gap["departments"]])
        self.assertEqual(gap["vacancies"], 5)
        DepartmentHeadcount.objects.create(department=extra, required_count=0)  # 0 is "not planned" too
        self.assertNotIn(extra.id, [r["departmentId"] for r in self.positions()["headcountGap"]["departments"]])

    def test_production_has_no_plan(self):
        p = self.positions(scope_of(type="production"))
        self.assertFalse(p["headcountGap"]["applicable"])
        self.assertIsNone(p["headcountGap"]["vacancies"])
        self.assertTrue(any("covers staff only" in n for n in p["notes"]))
        self.assertEqual(p["summary"]["open"], 4)

    def test_the_list_is_capped_and_says_so(self):
        p = self.positions(limit=2)
        self.assertEqual((len(p["positions"]), p["positionsShown"], p["summary"]["open"]), (2, 2, 4))

    def test_agrees_with_the_report_centers_job_openings_and_manpower_report(self):
        with mock.patch("api.reporting.filters.ist_today", return_value=TODAY):
            jobs = self.client.get("/api/reports/run/job-openings", {"status": "open"}, **md_headers(self.md))
            plan = self.client.get("/api/reports/run/manpower-requirement", **md_headers(self.md))
        self.assertEqual(jobs.status_code, 200, jobs.content)
        summary = {s["label"]: s["value"] for s in jobs.json()["summary"]}
        mine = self.positions()["summary"]
        self.assertEqual((summary["Open positions"], summary["Average days open"]), (mine["open"], mine["avgOpenDays"]))
        by_title = {r["title"]: r["daysOpen"] for r in jobs.json()["rows"]}
        self.assertEqual(by_title, {p["title"]: p["daysOpen"] for p in self.positions()["positions"]})
        self.assertEqual(plan.status_code, 200, plan.content)
        totals = {s["label"]: s["value"] for s in plan.json()["summary"]}
        gap = self.positions()["headcountGap"]
        self.assertEqual(totals["Vacancies"], gap["vacancies"])
        self.assertEqual(totals["Departments with gaps"], gap["departmentsWithGap"])
        theirs = {
            (r["branch"], r["department"]): (r["requiredCount"], r["currentCount"], r["vacancy"])
            for r in plan.json()["rows"]
        }
        for row in gap["departments"]:
            d = Department.objects.select_related("branch").get(pk=row["departmentId"])
            self.assertEqual(theirs[(d.branch.name, d.name)], (row["required"], row["current"], row["vacancy"]), d.name)


# ─── resignations ───────────────────────────────────────────────────────────────────────────────────────────────


class Resignations(Company):
    def res(self, scope=None, period=None, **kw):
        return R.resignations(scope or scope_of(), period or period_of(**SEPT), today=TODAY, **kw)

    def test_waiting_for_a_decision_and_for_whom(self):
        r = self.res()
        self.assertEqual(
            [(p["employeeName"], p["daysWaiting"], p["waitingForText"], p["status"]) for p in r["pending"]],
            [
                ("Anil Test", 10, "Department head", "pending"),  # P1, raised 25 Sep
                ("Anita Test", 5, "HR", "dept_approved"),  # P2: the department head has approved
                ("Ajay Test", 3, "Department head", "pending"),  # P3
            ],
        )
        p1 = r["pending"][0]
        self.assertEqual(
            (p1["department"], p1["designation"], p1["requestedOn"]), ("Stitching (Unit 1)", None, "2026-09-25")
        )
        self.assertEqual((p1["lastWorkingDate"], p1["noticeDays"], p1["daysToLastDay"]), ("2026-10-25", 30, 20))
        self.assertEqual(p1["employeeId"], self.w.A1.id)  # the assistant's privacy layer tokenises a person by this
        self.assertNotIn("reasonGroup", p1)  # a named person's reason is never sent
        self.assertNotIn("reason", p1)
        self.assertIsNone(r["pending"][2]["lastWorkingDate"])
        self.assertEqual(
            r["summary"]["waitingOn"], [{"label": "Department head", "count": 2}, {"label": "HR", "count": 1}]
        )
        self.assertEqual((r["summary"]["pending"], r["summary"]["oldestPendingDays"]), (3, 10))

    def test_the_pipeline_in_approval_workflow_control_decides_who_it_waits_for(self):
        from .models import ApprovalWorkflowConfig

        ApprovalWorkflowConfig.objects.create(
            key="resignation", enabled=True, steps=[{"roles": ["hr"], "mandatory": True}]
        )
        r = self.res()
        self.assertEqual({p["waitingForText"] for p in r["pending"]}, {"HR"})

    def test_people_serving_notice(self):
        r = self.res()
        self.assertEqual(
            [(n["employeeName"], n["lastWorkingDate"], n["daysLeft"], n["approvedOn"]) for n in r["onNotice"]],
            [("Leena Test", "2026-10-20", 15, "2026-10-01")],
        )
        self.assertEqual(r["summary"]["onNotice"], 1)

    def test_leavers_expected_in_the_next_30_and_60_days(self):
        o = self.res()["outlook"]
        # L5 (approved, 20 Oct) is certain; P1 (25 Oct) and P2 (20 Nov) are expected if approved; P3 has no date
        self.assertEqual((o["next30"]["approved"], o["next30"]["pending"], o["next30"]["total"]), (1, 1, 2))
        self.assertEqual((o["next60"]["approved"], o["next60"]["pending"], o["next60"]["total"]), (1, 2, 3))
        self.assertEqual(o["withoutDate"], 1)
        self.assertEqual(
            [(d["department"], d["count"]) for d in o["byDepartment"]],
            [("Cutting", 1), ("Stitching (Unit 1)", 1), ("Stitching (Unit 2)", 1)],
        )

    def test_the_outlook_window_includes_its_last_day(self):
        mk_resignation(self.w.A5, created=ist(2026, 10, 3), lwd=TODAY + timedelta(days=30))
        mk_resignation(self.w.A4, created=ist(2026, 10, 3), lwd=TODAY + timedelta(days=31))
        o = self.res()["outlook"]
        self.assertEqual(o["next30"]["pending"], 2)  # P1 and the one on day 30; day 31 is out
        self.assertEqual(o["next60"]["pending"], 4)

    def test_reasons_are_grouped_and_only_counted(self):
        r = self.res()
        self.assertEqual(
            [(g["id"], g["count"], g["pct"]) for g in r["reasons"]],
            [
                ("family", 2, 28.6),  # R1 "Personal reasons", P2 "family reasons"
                ("pay", 2, 28.6),  # L1, P1
                ("health", 1, 14.3),
                ("not_stated", 1, 14.3),  # L4 wrote nothing
                ("relocation", 1, 14.3),
            ],
        )
        self.assertNotIn("Chennai", json.dumps(r))  # the text never leaves the server
        self.assertNotIn("higher salary", json.dumps(r))
        self.assertNotIn("Health or medical", json.dumps([r["pending"], r["onNotice"]]))  # nor beside a name

    def test_the_survey_answer_stands_in_for_a_blank_reason(self):
        ResignationRequest.objects.filter(pk=self.w.P3.pk).update(survey_q1_answer="Moving to Coimbatore")
        reasons = {g["id"]: g["count"] for g in self.res(period=period_of(month="2026-10"))["reasons"]}
        self.assertEqual(reasons, {"relocation": 1})  # P3 is the only request raised in October

    def test_raised_approved_rejected_and_the_time_to_decide(self):
        s = self.res()["summary"]
        self.assertEqual((s["raised"], s["approved"], s["rejected"], s["stillPending"]), (7, 4, 1, 2))
        # approved: L1 3 days, L3 10, L4 6, L5 3 (the IST day of the approval, not the UTC one); R1's HR rejection has no time
        self.assertEqual(s["avgDaysToDecision"], 5.5)

    def test_by_department_tells_two_stitching_departments_apart(self):
        rows = {r["department"]: r for r in self.res()["byDepartment"]}
        self.assertEqual(set(rows), {"Stitching (Unit 1)", "Stitching (Unit 2)", "Cutting"})
        self.assertEqual(
            (
                rows["Stitching (Unit 1)"]["raised"],
                rows["Stitching (Unit 1)"]["approved"],
                rows["Stitching (Unit 1)"]["rejected"],
                rows["Stitching (Unit 1)"]["pending"],
            ),
            (3, 1, 1, 1),
        )
        self.assertEqual((rows["Cutting"]["raised"], rows["Cutting"]["approved"]), (2, 2))
        self.assertEqual((rows["Stitching (Unit 2)"]["raised"], rows["Stitching (Unit 2)"]["pending"]), (2, 1))

    def test_a_unit_and_a_department_narrow_it(self):
        u1 = self.res(scope_of(branch="Unit 1"))
        self.assertEqual([p["employeeName"] for p in u1["pending"]], ["Anil Test", "Ajay Test"])
        cutting = self.res(scope_of(department="Cutting"))
        self.assertEqual(
            (cutting["summary"]["pending"], cutting["summary"]["onNotice"], cutting["summary"]["raised"]), (0, 1, 2)
        )

    def test_the_list_is_capped_but_the_count_is_not(self):
        r = self.res(limit=1)
        self.assertEqual((len(r["pending"]), r["pendingShown"], r["summary"]["pending"]), (1, 1, 3))

    def test_agrees_with_the_report_centers_resignation_register(self):
        r = self.client.get(
            "/api/reports/run/resignation-register",
            {"dateFrom": "2026-09-01", "dateTo": "2026-09-30"},
            **md_headers(self.md),
        )
        self.assertEqual(r.status_code, 200, r.content)
        summary = {s["label"]: s["value"] for s in r.json()["summary"]}
        mine = self.res()["summary"]
        self.assertEqual(summary["Total requests"], mine["raised"])
        self.assertEqual(summary["Approved"], mine["approved"])
        self.assertEqual(summary["Avg days to decision"], mine["avgDaysToDecision"])


# ─── joiners and early attrition ────────────────────────────────────────────────────────────────────────────────


class Joiners(Company):
    def joiners(self, scope=None, period=None, **kw):
        return R.joiners(scope or scope_of(), period or period_of(**SEPT), today=TODAY, **kw)

    def test_who_joined_newest_first(self):
        j = self.joiners()
        self.assertEqual(
            [(x["employeeName"], x["joinDate"], x["type"], x["department"]) for x in j["list"]],
            [
                ("Arun Test", "2026-09-30", "production", "Stitching (Unit 1)"),
                ("Anita Test", "2026-09-15", "staff", "Stitching (Unit 2)"),  # "15/09/2026" is read as a date
                ("Jeeva Test", "2026-09-03", "production", "Stitching (Unit 1)"),
                ("Asha Test", "2026-09-01", "staff", "Stitching (Unit 1)"),
            ],
        )
        s = j["summary"]
        self.assertEqual((s["joiners"], s["staff"], s["production"]), (4, 2, 2))
        self.assertEqual((s["stillActive"], s["leftSinceJoining"], s["withoutJoinDate"]), (3, 1, 2))

    def test_onboarding_documents_still_missing(self):
        j = self.joiners()
        missing = {x["employeeName"]: x["docsMissing"] for x in j["list"]}
        # Asha has 3 of the 6 staff documents, Arun (production) has none of the 6, Anita has all; Jeeva has left
        self.assertEqual(missing, {"Arun Test": 6, "Anita Test": 0, "Jeeva Test": None, "Asha Test": 3})
        self.assertEqual(j["summary"]["docsPending"], 2)

    def test_by_department_and_unit(self):
        j = self.joiners()
        self.assertEqual(
            j["byDepartment"],
            [{"department": "Stitching (Unit 1)", "joiners": 3}, {"department": "Stitching (Unit 2)", "joiners": 1}],
        )
        self.assertEqual(j["byUnit"], [{"unit": "Unit 1", "joiners": 3}, {"unit": "Unit 2", "joiners": 1}])

    def test_early_attrition_within_90_days(self):
        e = self.joiners()["earlyAttrition"]
        self.assertEqual((e["windowDays"], e["leavers"], e["totalLeavers"], e["pct"]), (90, 2, 4, 50.0))
        self.assertEqual(
            [(x["employeeName"], x["daysServed"], x["approximate"]) for x in e["list"]],
            [("Jeeva Test", 22, True), ("Lokesh Test", 41, True)],  # newest exit first
        )
        self.assertEqual(e["byDepartment"], [{"department": "Stitching (Unit 1)", "leavers": 2}])

    def test_exactly_90_days_is_early_and_91_is_not(self):
        for code, days in (("EA90", 90), ("EA91", 91)):
            e = mk_emp(
                code, self.w.C1, status="inactive", joined=(date(2026, 9, 20) - timedelta(days=days)).isoformat()
            )
            mk_resignation(
                e, created=ist(2026, 9, 1), status="approved", lwd=date(2026, 9, 20), approved_at=ist(2026, 9, 2)
            )
        early = {x["employeeName"] for x in self.joiners()["earlyAttrition"]["list"]}
        self.assertIn("EA90 Test", early)
        self.assertNotIn("EA91 Test", early)

    def test_a_leaver_dated_before_joining_is_bad_data_not_early_attrition(self):
        e = mk_emp("BAD", self.w.C1, status="inactive", joined="2026-09-25")
        mk_resignation(
            e, created=ist(2026, 9, 1), status="approved", lwd=date(2026, 9, 10), approved_at=ist(2026, 9, 2)
        )
        self.assertNotIn("BAD Test", {x["employeeName"] for x in self.joiners()["earlyAttrition"]["list"]})

    def test_the_lists_are_capped(self):
        j = self.joiners(limit=2)
        self.assertEqual((len(j["list"]), j["listShown"], j["summary"]["joiners"]), (2, 2, 4))

    def test_agrees_with_the_report_centers_joinings_and_exits(self):
        args = {"dateFrom": "2026-09-01", "dateTo": "2026-09-30"}
        joined = self.client.get("/api/reports/run/new-joinings", args, **md_headers(self.md))
        exits = self.client.get("/api/reports/run/exits-register", args, **md_headers(self.md))
        self.assertEqual((joined.status_code, exits.status_code), (200, 200), (joined.content, exits.content))
        j = {s["label"]: s["value"] for s in joined.json()["summary"]}
        x = {s["label"]: s["value"] for s in exits.json()["summary"]}
        mine = R.summary(scope_of(), period_of(**SEPT), today=TODAY)["current"]
        self.assertEqual(j["Joined in period"], mine["joiners"])
        self.assertEqual((j["Staff"], j["Production"]), (mine["joinersStaff"], mine["joinersProduction"]))
        self.assertEqual(x["Total exits"], mine["leavers"])
        self.assertEqual(
            (x["Resignations"], x["Manual deactivations"]), (mine["leaversResigned"], mine["leaversDeactivated"])
        )


# ─── the trend ──────────────────────────────────────────────────────────────────────────────────────────────────


class Trend(Company):
    def months(self, scope=None):
        t = R.trend(scope or scope_of(), today=TODAY)
        return t, {m["month"]: m for m in t["months"]}

    def test_twelve_months_oldest_first_and_the_current_one_is_partial(self):
        t, by = self.months()
        self.assertEqual((t["months"][0]["month"], t["months"][-1]["month"]), ("2025-11", "2026-10"))
        self.assertEqual((by["2026-10"]["partial"], by["2026-09"]["partial"]), (True, False))

    def test_joiners_against_leavers(self):
        t, by = self.months()
        self.assertEqual((by["2026-06"]["joiners"], by["2026-06"]["leavers"]), (1, 0))  # L6 joined
        self.assertEqual((by["2026-08"]["joiners"], by["2026-08"]["leavers"], by["2026-08"]["net"]), (2, 1, 1))
        self.assertEqual((by["2026-09"]["joiners"], by["2026-09"]["leavers"], by["2026-09"]["net"]), (4, 4, 0))
        self.assertEqual((by["2026-10"]["joiners"], by["2026-10"]["leavers"]), (1, 1))  # month to date: A4 / L4
        self.assertEqual((by["2025-12"]["joiners"], by["2025-12"]["leavers"]), (0, 0))
        self.assertEqual(
            t["totals"], {"joiners": 8, "leavers": 6, "net": 2}
        )  # Jun 1 + Aug 2 + Sep 4 + Oct 1 / Aug 1 + Sep 4 + Oct 1

    def test_headcount_at_each_month_end(self):
        _, by = self.months()
        self.assertEqual((by["2026-08"]["headcount"], by["2026-09"]["headcount"]), (50, 50))
        self.assertEqual(by["2026-10"]["headcount"], 49)  # today: the active employees
        self.assertEqual(
            (by["2026-08"]["staffHeadcount"], by["2026-09"]["staffHeadcount"], by["2026-10"]["staffHeadcount"]),
            (49, 49, 48),
        )

    def test_vacancies_are_each_departments_shortfall_never_offset_by_anothers_surplus(self):
        t, by = self.months()
        self.assertEqual(t["required"], 50)
        self.assertEqual((by["2026-08"]["vacancies"], by["2026-09"]["vacancies"]), (4, 5))
        # the latest point is the same figure as the Open positions card
        gap = R.positions(scope_of(), today=TODAY)["headcountGap"]
        self.assertEqual(by["2026-10"]["vacancies"], gap["vacancies"])

    def test_production_has_no_staff_series(self):
        _, by = self.months(scope_of(type="production"))
        self.assertIsNone(by["2026-09"]["staffHeadcount"])
        self.assertIsNone(by["2026-09"]["vacancies"])
        self.assertEqual((by["2026-09"]["joiners"], by["2026-09"]["leavers"]), (2, 2))

    def test_a_year_boundary(self):
        t = R.trend(scope_of(), today=date(2026, 1, 15))
        self.assertEqual([m["month"] for m in t["months"]][:2], ["2025-02", "2025-03"])
        self.assertEqual(t["months"][-1]["month"], "2026-01")


# ─── what needs attention ───────────────────────────────────────────────────────────────────────────────────────


class Attention(Company):
    def items(self, scope=None, period=None):
        return {
            i["id"]: i
            for i in R.attention(scope or scope_of(), period or period_of(period="last_90_days"), today=TODAY)["items"]
        }

    def test_the_exceptions_for_the_company(self):
        items = self.items()
        self.assertEqual(
            list(items),
            [
                "recruitment.stale-positions",
                "recruitment.resignations-waiting",
                "recruitment.leavers-soon",
                "recruitment.hiring-ahead",
            ],
        )
        stale = items["recruitment.stale-positions"]
        self.assertEqual(stale["severity"], "warning")  # 2 positions, the oldest 82 days: below the critical bar
        self.assertEqual(stale["title"], "2 open positions have been open for more than 45 days")
        self.assertEqual(stale["detail"], "Longest open: Accountant (Accounts), 82 days.")
        self.assertEqual(stale["metric"], "2 positions")
        self.assertEqual((stale["page"], stale["ask"] is not None), ("recruitment", True))
        waiting = items["recruitment.resignations-waiting"]
        self.assertEqual((waiting["severity"], waiting["title"]), ("warning", "3 resignations waiting for a decision"))
        self.assertIn("Department head (2), HR (1)", waiting["detail"])
        soon = items["recruitment.leavers-soon"]
        self.assertEqual(soon["title"], "2 people are due to leave in the next 30 days")
        self.assertEqual(soon["severity"], "warning")  # Stitching (Unit 1) is 4 short of its plan
        self.assertIn("1 serving notice and 1 pending", soon["detail"])
        self.assertIn("Stitching (Unit 1)", soon["detail"])
        good = items["recruitment.hiring-ahead"]
        self.assertEqual(good["severity"], "good")
        self.assertEqual(good["title"], "Hiring is ahead of exits: 7 joined and 6 left (last 90 days)")
        self.assertEqual(good["detail"], "A net gain of 1 person.")  # not "1 people"

    def test_severity_rules(self):
        # three stale positions, or one open 90+ days, is critical
        mk_job("Very old", self.w.C1, ist(2026, 5, 1))
        self.assertEqual(self.items()["recruitment.stale-positions"]["severity"], "critical")
        # a resignation waiting 14+ days is critical, 7+ is a warning, less is information
        ResignationRequest.objects.filter(pk=self.w.P1.pk).update(created_at=ist(2026, 9, 20))
        self.assertEqual(self.items()["recruitment.resignations-waiting"]["severity"], "critical")
        # most severe first: the two critical items lead, the warning and the good news follow
        self.assertEqual(
            [i["severity"] for i in R.attention(scope_of(), period_of(period="last_90_days"), today=TODAY)["items"]],
            ["critical", "critical", "warning", "good"],
        )
        ResignationRequest.objects.filter(pk=self.w.P1.pk).update(created_at=ist(2026, 10, 1))
        self.assertEqual(
            self.items()["recruitment.resignations-waiting"]["severity"], "info"
        )  # the oldest is now P2: 5 days

    def test_nothing_to_flag_means_an_empty_list(self):
        ResignationRequest.objects.filter(status__in=("pending", "dept_approved")).update(status="rejected")
        Job.objects.update(status="closed")
        ResignationRequest.objects.filter(status="approved").update(last_working_date=date(2026, 1, 1))
        items = self.items(period=period_of(period="today"))
        self.assertEqual(items, {})

    def test_a_department_that_loses_more_than_it_hires(self):
        # Cutting: 4 more people leave than join in the period -> flagged, with the department named
        for i in range(4):
            e = mk_emp(f"CL{i}", self.w.C1, status="inactive", joined="2024-01-01")
            mk_resignation(
                e, created=ist(2026, 9, 1), status="approved", lwd=date(2026, 9, 10 + i), approved_at=ist(2026, 9, 2)
            )
        loss = self.items(period=period_of(**SEPT))["recruitment.dept-net-loss"]
        # Cutting: left L3 + 4 = 5, joined 0 in September (A4 is 1 Oct, A5 is 31 Aug)
        self.assertEqual(loss["title"], "Cutting lost 5 people and hired 0 (sep 2026)")
        self.assertEqual((loss["severity"], loss["metric"]), ("warning", "-5 net"))

    def test_a_department_losing_ten_more_than_it_hires_is_critical(self):
        for i in range(10):
            e = mk_emp(f"XL{i}", self.w.C1, status="inactive", joined="2024-01-01")
            mk_resignation(
                e, created=ist(2026, 9, 1), status="approved", lwd=date(2026, 9, 11), approved_at=ist(2026, 9, 2)
            )
        self.assertEqual(self.items(period=period_of(**SEPT))["recruitment.dept-net-loss"]["severity"], "critical")

    def test_below_the_loss_bar_is_not_flagged(self):
        for i in range(2):  # Cutting: L3 + 2 = 3 left, 0 joined = 3: exactly the bar
            e = mk_emp(f"CL{i}", self.w.C1, status="inactive", joined="2024-01-01")
            mk_resignation(
                e, created=ist(2026, 9, 1), status="approved", lwd=date(2026, 9, 11), approved_at=ist(2026, 9, 2)
            )
        self.assertIn("recruitment.dept-net-loss", self.items(period=period_of(**SEPT)))
        e = Employee.objects.get(employee_code="CL0")
        Employee.objects.filter(pk=e.pk).update(status="active")  # one person fewer has left: net 2
        self.assertNotIn("recruitment.dept-net-loss", self.items(period=period_of(**SEPT)))

    def test_attention_follows_the_scope(self):
        items = self.items(scope_of(department="Cutting"))
        self.assertNotIn("recruitment.resignations-waiting", items)  # nobody pending in Cutting
        self.assertNotIn("recruitment.stale-positions", items)  # the Cutting posting is 15 days old


class AttentionFunnel(Company):
    """The funnel rule needs volume: at least 20 candidates must reach a step before it is judged."""

    def test_a_step_below_the_floor_is_flagged_and_a_small_cohort_is_not(self):
        scope, period = scope_of(), period_of(**SEPT)
        self.assertNotIn(
            "recruitment.funnel-dropoff", {i["id"] for i in R.attention(scope, period, today=TODAY)["items"]}
        )
        for _ in range(40):  # 40 resumes screened but not shortlisted
            mk_candidate(self.w.rs_c1, "screened", ist(2026, 9, 14))
        items = {i["id"]: i for i in R.attention(scope, period, today=TODAY)["items"]}
        item = items["recruitment.funnel-dropoff"]
        # applied 53, screened 10 + 40 = 50, shortlisted 7: 14.0% of 50 -> the lowest step below the 25% floor
        self.assertEqual(item["title"], "Only 14% of screened candidates are shortlisted (sep 2026)")
        self.assertEqual((item["severity"], item["metric"]), ("warning", "7 of 50"))
        self.assertEqual(item["detail"], "43 of 50 were not shortlisted.")


class AttentionFunnelFloor(MdApiTestCase):
    """A funnel step is judged only when at least 20 candidates reached it, however bad its conversion looks."""

    def setUp(self):
        super().setUp()
        branch = Branch.objects.create(name="Unit 1", code="U1")
        self.dept = Department.objects.create(name="Cutting", branch=branch)
        self.rule_set = HiringRuleSet.objects.create(name="Rules", department=self.dept)

    def flagged(self):
        items = R.attention(scope_of(), period_of(**SEPT), today=TODAY)["items"]
        return [i for i in items if i["id"] == "recruitment.funnel-dropoff"]

    def test_nineteen_candidates_are_too_few_to_judge_and_twenty_are_enough(self):
        mk_candidate(self.rule_set, "shortlisted", ist(2026, 9, 5))
        for _ in range(18):
            mk_candidate(self.rule_set, "screened", ist(2026, 9, 5))  # 19 screened, 1 shortlisted: 5.3%
        self.assertEqual(self.flagged(), [])
        mk_candidate(self.rule_set, "screened", ist(2026, 9, 5))  # the 20th
        (item,) = self.flagged()
        self.assertEqual(item["title"], "Only 5% of screened candidates are shortlisted (sep 2026)")

    def test_exactly_the_floor_is_not_below_it(self):
        for _ in range(5):
            mk_candidate(self.rule_set, "shortlisted", ist(2026, 9, 5))
        for _ in range(15):
            mk_candidate(self.rule_set, "screened", ist(2026, 9, 5))  # 20 screened, 5 shortlisted: exactly 25.0%
        self.assertEqual(self.flagged(), [])
        mk_candidate(self.rule_set, "screened", ist(2026, 9, 5))  # 5 of 21 = 23.8%
        self.assertEqual(len(self.flagged()), 1)

    def test_unreviewed_applicants_are_flagged_as_a_backlog(self):
        job = mk_job("Fitter", self.dept, ist(2026, 8, 1))
        for _ in range(24):
            mk_applicant(job, "applied", ist(2026, 9, 5))  # nobody has looked at them
        for _ in range(4):
            mk_applicant(job, "attended", ist(2026, 9, 5))
        (item,) = self.flagged()
        self.assertEqual(item["title"], "Only 14% of applicants have been screened (sep 2026)")
        self.assertEqual(item["detail"], "24 of 28 are still waiting for a first review.")


class Interviews(MdApiTestCase):
    """Interviews come from the invitations HR sends in Resume Screening. 'Today' is noon for these direct calls."""

    def setUp(self):
        super().setUp()
        branch = Branch.objects.create(name="Unit 1", code="U1")
        dept = Department.objects.create(name="Cutting", branch=branch)
        self.rule_set = HiringRuleSet.objects.create(name="Rules", department=dept)

    def cur(self, **period):
        return R.summary(scope_of(), period_of(**period), today=TODAY)["current"]

    def test_held_means_the_time_has_passed_scheduled_today_means_the_date_is_today(self):
        mk_candidate(self.rule_set, "selected", ist(2026, 10, 1), interview=ist(2026, 10, 5, 9))  # 09:00, before noon
        mk_candidate(
            self.rule_set, "selected", ist(2026, 10, 1), interview=ist(2026, 10, 5, 15)
        )  # 15:00, still to come
        cur = self.cur(period="today")
        self.assertEqual(cur["interviewsHeld"], 1)
        self.assertEqual((cur["interviewsToday"], cur["interviewsNext7Days"]), (2, 2))

    def test_the_next_seven_days_is_today_to_the_sixth_day_ahead(self):
        mk_candidate(self.rule_set, "selected", ist(2026, 10, 1), interview=ist(2026, 10, 11, 23, 59))  # day 7: in
        mk_candidate(self.rule_set, "selected", ist(2026, 10, 1), interview=ist(2026, 10, 12, 0, 1))  # day 8: out
        mk_candidate(self.rule_set, "selected", ist(2026, 10, 1), interview=ist(2026, 10, 4, 23, 59))  # yesterday: out
        self.assertEqual(self.cur(period="today")["interviewsNext7Days"], 1)

    def test_an_interview_counts_in_the_factory_day_it_happened(self):
        # 00:30 IST on 1 Oct is 19:00 UTC on 30 Sep: it belongs to October
        mk_candidate(self.rule_set, "selected", ist(2026, 9, 1), interview=ist(2026, 10, 1, 0, 30))
        self.assertEqual(self.cur(**{"from": "2026-09-30", "to": "2026-09-30"})["interviewsHeld"], 0)
        self.assertEqual(self.cur(**{"from": "2026-10-01", "to": "2026-10-01"})["interviewsHeld"], 1)

    def test_a_scheduled_interview_is_not_a_held_one_in_the_funnel(self):
        mk_candidate(self.rule_set, "selected", ist(2026, 9, 10), interview=ist(2026, 10, 7, 10))
        stages = R.funnel(scope_of(), period_of(**SEPT), today=TODAY)["views"]["screening"]
        self.assertEqual((stages[2]["count"], stages[3]["count"]), (1, 0))  # shortlisted or later, not yet interviewed


class PeopleWithoutADepartment(MdApiTestCase):
    def setUp(self):
        super().setUp()
        self.unit = Branch.objects.create(name="Unit 1", code="U1")
        self.floating = mk_emp("N1", None, joined="2026-09-10", branch=self.unit, first="Nila")

    def test_a_joiner_with_no_department_is_listed_as_unassigned(self):
        j = R.joiners(scope_of(), period_of(**SEPT), today=TODAY)
        self.assertEqual(j["list"][0]["department"], "Unassigned")
        self.assertEqual(j["byDepartment"], [{"department": "Unassigned", "joiners": 1}])

    def test_a_resignation_with_no_department_is_listed_as_unassigned(self):
        mk_resignation(self.floating, created=ist(2026, 9, 20), reason="family")
        r = R.resignations(scope_of(), period_of(**SEPT), today=TODAY)
        self.assertEqual(r["pending"][0]["department"], "Unassigned")
        self.assertEqual([d["department"] for d in r["byDepartment"]], ["Unassigned"])

    def test_narrowing_to_a_department_leaves_them_out(self):
        dept = Department.objects.create(name="Cutting", branch=self.unit)
        mk_emp("N2", dept, joined="2026-09-11")
        j = R.joiners(scope_of(department="Cutting"), period_of(**SEPT), today=TODAY)
        self.assertEqual(j["summary"]["joiners"], 1)


# ─── the Dashboard's contract: insights and headline ──────────────────────────────────────────────────────────


class DashboardContract(Company):
    def test_insights_are_at_most_five_most_severe_first_and_company_wide(self):
        items = R.insights(today=TODAY)
        self.assertLessEqual(len(items), 5)
        rank = {"critical": 0, "warning": 1, "info": 2, "good": 3}
        self.assertEqual([i["severity"] for i in items], sorted((i["severity"] for i in items), key=rank.get))
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})
            self.assertEqual(item["page"], "recruitment")
            self.assertTrue(item["id"].startswith("recruitment."))
        json.dumps(items)

    def test_the_headline_strip(self):
        h = R.headline(today=TODAY)
        k = {x["id"]: x for x in h["kpis"]}
        self.assertEqual(len(h["kpis"]), 3)
        open_positions = k["recruitment.open_positions"]
        self.assertEqual(
            (open_positions["value"], open_positions["format"], open_positions["page"]), (4, "number", "recruitment")
        )
        self.assertEqual(open_positions["sub"], "5 vacancies against plan · 2 over 45 days")
        joined = k["recruitment.joined_this_month"]
        # 1-5 Oct: A4 joined, L4 left. The same five days of September: A2 (1 Sep) and J1 (3 Sep) joined
        self.assertEqual((joined["value"], joined["sub"]), (1, "1 left · net +0"))
        self.assertEqual(joined["delta"], {"abs": -1, "pct": -50.0, "good": "up"})
        self.assertEqual(joined["spark"], [0, 1, 0, 2, 4, 1])  # May..Oct joiners
        pending = k["recruitment.pending_resignations"]
        self.assertEqual((pending["value"], pending["sub"]), (3, "Oldest waiting 10 days"))
        self.assertEqual(pending["spark"], [0, 0, 1, 0, 7, 1])  # requests raised May..Oct
        self.assertTrue(h["provenance"])
        json.dumps(h)

    def test_the_headline_compares_the_same_number_of_days_of_last_month(self):
        # on 31 Oct the comparison is the whole of September (30 days), not 31
        h = R.headline(today=date(2026, 10, 31))
        joined = next(x for x in h["kpis"] if x["id"] == "recruitment.joined_this_month")
        self.assertEqual(joined["value"], 1)  # A4
        self.assertEqual(joined["delta"]["abs"], -3.0)  # September had 4

    def test_both_run_inside_the_read_only_guard(self):
        with read_only_db():
            R.insights(today=TODAY)
            R.headline(today=TODAY)

    def test_no_staffing_plan_is_said_not_shown_as_zero(self):
        DepartmentHeadcount.objects.all().delete()
        sub = next(x for x in R.headline(today=TODAY)["kpis"] if x["id"] == "recruitment.open_positions")["sub"]
        self.assertTrue(sub.startswith("No staffing plan set"))


# ─── the assistant's tools ──────────────────────────────────────────────────────────────────────────────────────


class Tools(Company):
    def tool(self, name):
        return registry.collect_tools()[name]

    def test_the_six_tools_are_registered_with_llm_grade_descriptions(self):
        names = {s.name for s in R.TOOLS}
        self.assertEqual(
            names,
            {
                "recruitment_summary",
                "recruitment_funnel",
                "open_positions",
                "resignations_overview",
                "hiring_vs_attrition",
                "new_joiners_and_early_exits",
            },
        )
        registry.clear_cache()
        tools = registry.collect_tools()
        for spec in R.TOOLS:
            self.assertIn(spec.name, tools)
            self.assertEqual(spec.page, "recruitment")
            self.assertGreaterEqual(len(spec.description), 120, spec.name)
            self.assertIn("Use for", spec.description, spec.name)

    def test_a_tool_returns_the_same_numbers_as_the_page(self):
        with frozen():
            with read_only_db():
                result = self.tool("recruitment_summary").run({"month": "2026-09"})
        self.assertEqual(result["current"]["joiners"], 4)
        self.assertEqual(result["current"]["attritionPct"], 8.0)
        self.assertIsNone(result["current"]["avgTimeToFillDays"])
        self.assertTrue(result["provenance"])

    def test_tools_take_a_scope(self):
        with frozen():
            with read_only_db():
                result = self.tool("recruitment_summary").run({"month": "2026-09", "branch": "Unit 2"})
        self.assertEqual(result["current"]["joiners"], 1)  # A6

    def test_every_tool_runs_read_only_returns_plain_json_and_stays_small(self):
        with frozen():
            for spec in R.TOOLS:
                with self.subTest(tool=spec.name), read_only_db():
                    out = spec.run(dict(spec.example))
                    text = json.dumps(out)
                    self.assertLess(len(text), 60_000)
                    self.assertTrue(out["provenance"])

    def test_the_list_tools_are_capped_by_their_limit_parameter(self):
        with frozen(), read_only_db():
            out = self.tool("open_positions").run({"limit": 2})
            self.assertEqual(len(out["positions"]), 2)
            out = self.tool("open_positions").run({"limit": 999})  # clamped to 25 by the tool, not an error
            self.assertEqual(len(out["positions"]), 4)
            out = self.tool("resignations_overview").run({"limit": 1})
            self.assertEqual(len(out["pending"]), 1)

    def test_names_are_in_the_fields_the_privacy_layer_pseudonymises(self):
        from .md_portal.assistant.tools_base import STANDARD_PERSON_FIELDS

        with frozen(), read_only_db():
            out = self.tool("resignations_overview").run({})
        self.assertIn("employeeName", STANDARD_PERSON_FIELDS)
        person_keys = {k for row in out["pending"] + out["onNotice"] for k in row if "name" in k.lower()}
        self.assertTrue(person_keys <= {"employeeName"}, person_keys)

    def test_a_bad_parameter_is_an_error_the_model_can_correct(self):
        with self.assertRaises(MdParamError):
            self.tool("recruitment_summary").run({"period": "fortnight"})
        with self.assertRaises(MdParamError):
            self.tool("open_positions").run({"department": "Quantum Physics"})


# ─── permission and parameters ──────────────────────────────────────────────────────────────────────────────────

ROUTES = ("summary", "attention", "funnel", "positions", "resignations", "joiners", "trend", "sources")


class Access(Company):
    def test_only_the_md_gets_in(self):
        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        clerk = HRUser.objects.create(
            username="clerk", password_hash="x", role=Role.objects.create(name="All", permissions={"reports": "edit"})
        )
        plain = HRUser.objects.create(username="plain", password_hash="x")
        for name in ROUTES:
            path = f"/api/md/recruitment/{name}"
            self.assertEqual(self.client.get(path).status_code, 401, name)
            for who in (admin, clerk, plain):
                self.assertEqual(self.client.get(path, **md_headers(who)).status_code, 403, (name, who.username))
            self.assertEqual(self.client.get(path, **md_headers(self.md)).status_code, 200, name)
            self.assertEqual(self.client.post(path, **md_headers(self.md)).status_code, 405, name)

    def test_the_urls_are_exactly_the_documented_routes(self):
        from .md_portal.routes import recruitment as routes

        self.assertEqual(sorted(str(p.pattern) for p in routes.urlpatterns), sorted(ROUTES))

    def test_bad_parameters_are_a_400_that_says_why(self):
        cases = {
            "period=fortnight": "Unknown period",
            "from=2026-09-01": "both",
            "department=Quantum": "No department called",
            "branch=Nowhere": "No unit called",
            "type=contract": "staff or production",
            "month=September": "not a month",
        }
        for query, text in cases.items():
            r = self.client.get(f"/api/md/recruitment/summary?{query}", **md_headers(self.md))
            self.assertEqual(r.status_code, 400, query)
            self.assertIn(text, r.json()["error"], query)
        r = self.client.get("/api/md/recruitment/positions?limit=lots", **md_headers(self.md))
        self.assertEqual(r.status_code, 400)
        self.assertIn("'limit'", r.json()["error"])

    def test_an_absurd_date_is_a_400_not_a_crash(self):
        r = self.client.get(
            "/api/md/recruitment/summary", {"from": "0001-01-01", "to": "0001-02-01"}, **md_headers(self.md)
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("begin after 1990", r.json()["error"])
        with self.assertRaises(MdParamError):
            R.funnel(scope_of(), C.resolve_period({"from": "1900-01-01", "to": "1900-02-01"}, today=TODAY), today=TODAY)

    def test_a_limit_is_clamped_not_refused(self):
        too_many = self.get("/api/md/recruitment/positions", limit=5000).json()
        self.assertEqual(too_many["positionsShown"], 4)
        none = self.get("/api/md/recruitment/positions", limit=0).json()
        self.assertEqual(none["positionsShown"], 1)  # at least one row
        res = self.get("/api/md/recruitment/resignations", limit=99, **SEPT).json()
        self.assertEqual(res["pendingShown"], 3)

    def test_the_default_period_is_a_quarter(self):
        body = self.get("/api/md/recruitment/summary").json()
        self.assertEqual((body["period"]["preset"], body["period"]["days"]), ("last_90_days", 90))
        self.assertEqual(body["period"]["end"], "2026-10-05")

    def test_a_typo_in_a_department_is_matched_and_the_assumption_reported(self):
        body = self.get("/api/md/recruitment/summary", department="stiching", **SEPT).json()
        self.assertTrue(any("Matched department 'stiching' to 'Stitching'" in n for n in body["notes"]))
        self.assertEqual(body["current"]["openPositions"], 1)

    def test_a_response_carries_the_envelope(self):
        body = self.get("/api/md/recruitment/funnel", **SEPT).json()
        self.assertEqual(
            set(body) & {"generatedAt", "period", "scope", "provenance", "notes", "tookMs"},
            {"generatedAt", "period", "scope", "provenance", "notes", "tookMs"},
        )
        self.assertEqual(body["scope"]["description"], "All units · all departments · staff and production")

    def test_every_explanation_the_page_asks_for_exists(self):
        """The cards open "How is this calculated?" by id (pages/md/recruitment/*.tsx): an id the server does not send
        would open an empty popover."""
        wanted = {
            "summary": {
                "open-positions",
                "vacancies",
                "position-age",
                "time-to-fill",
                "pipeline",
                "interviews",
                "joiners",
                "leavers",
                "resignations-pending",
                "attrition",
            },
            "attention": {"attention-rules"},
            "funnel": {"funnel", "joiners"},
            "sources": {"sources"},
            "positions": {"open-positions", "position-age", "time-to-fill", "vacancies"},
            "resignations": {"resignations-pending", "notice", "outlook", "resignations-raised", "reasons"},
            "joiners": {"joiners", "onboarding-docs", "early-attrition", "leavers"},
            "trend": {"joiners", "leavers", "headcount-gap"},
        }
        for name, ids in wanted.items():
            body = self.get(f"/api/md/recruitment/{name}", **SEPT).json()
            sent = {p["id"] for p in body["provenance"]}
            self.assertLessEqual(ids, sent, f"{name} is missing {ids - sent}")
            for entry in body["provenance"]:
                self.assertTrue(entry["definition"], (name, entry["id"]))
                self.assertEqual(
                    set(entry), {"id", "title", "dataset", "definition", "formula", "rows", "filters", "caveats"}
                )

    def test_the_whole_module_never_writes(self):
        before = {
            m.__name__: m.objects.count() for m in (Employee, Job, Applicant, ResignationRequest, ScreeningCandidate)
        }
        for name in ROUTES:
            self.assertEqual(self.get(f"/api/md/recruitment/{name}", **SEPT).status_code, 200, name)
        after = {
            m.__name__: m.objects.count() for m in (Employee, Job, Applicant, ResignationRequest, ScreeningCandidate)
        }
        self.assertEqual(before, after)


# ─── it stays fast: the number of queries does not grow with the data ──────────────────────────────────────────


class Queries(Company):
    def count(self, fn):
        with CaptureQueriesContext(connection) as ctx:
            fn()
        return len(ctx)

    def grow(self, n):
        """n more of everything the heaviest endpoints walk: jobs, applicants, resumes, joiners, resignations."""
        w = self.w
        for i in range(n):
            dept = (w.S1, w.C1, w.AC1, w.S2)[i % 4]
            job = mk_job(f"Extra {i}", dept, ist(2026, 8, 1 + i % 20))
            mk_applicant(job, ("applied", "attended", "selected", "rejected")[i % 4], ist(2026, 9, 1 + i % 28))
            mk_candidate(
                w.rs_s1 if i % 2 else w.rs_c1, ("screened", "shortlisted", "selected")[i % 3], ist(2026, 9, 1 + i % 28)
            )
            e = mk_emp(f"G{i}", dept, kind=("staff", "production")[i % 2], joined=f"2026-09-{1 + i % 28:02d}")
            mk_resignation(
                e,
                created=ist(2026, 9, 1 + i % 28),
                status=("pending", "dept_approved")[i % 2],
                reason="family",
                lwd=date(2026, 10, 20),
            )
            gone = mk_emp(f"H{i}", dept, status="inactive", joined="2025-01-01")
            mk_resignation(
                gone,
                created=ist(2026, 9, 1 + i % 28),
                status="approved",
                lwd=date(2026, 9, 1 + i % 28),
                approved_at=ist(2026, 9, 2),
            )

    def test_the_query_count_is_constant_whatever_the_number_of_rows(self):
        scope, period = scope_of(), period_of(**SEPT)
        calls = {
            "summary": lambda: R.summary(scope, period, today=TODAY),
            "funnel": lambda: R.funnel(scope, period, today=TODAY),
            "positions": lambda: R.positions(scope, today=TODAY),
            "resignations": lambda: R.resignations(scope, period, today=TODAY),
            "joiners": lambda: R.joiners(scope, period, today=TODAY),
            "trend": lambda: R.trend(scope, today=TODAY),
            "attention": lambda: R.attention(scope, period, today=TODAY),
            "sources": lambda: R.sources(scope, period),
            "insights": lambda: R.insights(today=TODAY),
            "headline": lambda: R.headline(today=TODAY),
        }
        small = {name: self.count(fn) for name, fn in calls.items()}
        self.grow(60)
        large = {name: self.count(fn) for name, fn in calls.items()}
        self.assertEqual(small, large, "a query per row has crept in")
        for name, n in large.items():
            self.assertLess(n, 40, f"{name} runs {n} queries")

    def test_the_larger_company_still_gives_exact_numbers(self):
        self.grow(60)
        cur = R.summary(scope_of(), period_of(**SEPT), today=TODAY)["current"]
        # +60 joiners (G0..G59, all in September) and +60 leavers (H0..H59, last days all in September)
        self.assertEqual((cur["joiners"], cur["leavers"]), (4 + 60, 4 + 60))
        self.assertEqual(cur["openPositions"], 4 + 60)
        self.assertEqual(cur["resignationsPending"], 3 + 60)
