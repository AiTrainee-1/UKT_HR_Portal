"""Recruitment: open and filled positions, applicants moving through the funnel, resume-screening candidates, resignations
(pending, recent and rejected) and the headcount each department is meant to have.

The stories: positions of very different ages with two or three open far too long, applicants that thin out stage by stage,
resignations waiting for a decision (one of them stuck with the department head for almost two weeks), a department
after department short of its target headcount, and more people leaving than joining where the work is hardest.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal

from api.models import (
    Applicant,
    DepartmentHeadcount,
    HiringRuleSet,
    Job,
    ResignationRequest,
    ScreeningCandidate,
)

from .common import World, at, chance, office_hours, pick
from .names import CITIES, RESIGNATION_REASONS, NameFactory
from .org import hr_name
from .people import Person

SURVEY_RECOMMEND = [
    "Yes, it is a good place to work",
    "Yes, but the pay should improve",
    "Maybe, depends on the department",
    "Yes, the management supports workers",
]
SURVEY_RETAIN = [
    "A better salary would have kept me",
    "Nothing, it is a personal decision",
    "More flexible leave",
    "Closer transport from my village",
    "A promotion earlier",
]
EXPERIENCE = [
    "{n} years as {role} in Tirupur garment units",
    "{n} years of {role} experience, knit garments",
    "Fresher, completed ITI",
    "{n} years as {role}, export unit",
]

#: (title, (unit, department), salary range, days since it was posted, status)
JOBS = [
    ("Machine Operator - Stitching (Unit 1)", ("U1", "Stitching"), "Rs.650 - Rs.780 per shift", 4, "open"),
    ("Quality Checker (Unit 2)", ("U2", "Checking"), "Rs.560 - Rs.650 per shift", 9, "open"),
    ("Packing Helper (Unit 1)", ("U1", "Packing"), "Rs.520 - Rs.600 per shift", 13, "open"),
    ("Merchandiser", ("HO", "Merchandising"), "Rs.28,000 - Rs.36,000 per month", 19, "open"),
    ("Dyeing Operator (Unit 3)", ("U3", "Dyeing"), "Rs.640 - Rs.760 per shift", 28, "open"),
    ("HR Executive", ("HO", "Human Resources"), "Rs.28,000 - Rs.34,000 per month", 33, "closed"),
    ("Maintenance Electrician (Unit 2)", ("U2", "Maintenance"), "Rs.21,000 - Rs.28,000 per month", 41, "open"),
    ("Accounts Executive", ("HO", "Accounts & Finance"), "Rs.24,000 - Rs.30,000 per month", 55, "open"),
    ("Stitching Operator (Unit 2)", ("U2", "Stitching"), "Rs.650 - Rs.780 per shift", 66, "closed"),
    ("Washing Operator (Unit 3)", ("U3", "Washing"), "Rs.600 - Rs.720 per shift", 79, "open"),
    ("Cutting Master (Unit 2)", ("U2", "Cutting"), "Rs.32,000 - Rs.42,000 per month", 94, "open"),
    ("Store Keeper (Unit 1)", ("U1", "Stores"), "Rs.18,000 - Rs.24,000 per month", 118, "closed"),
    ("IT Executive", ("HO", "IT & Systems"), "Rs.28,000 - Rs.36,000 per month", 140, "closed"),
    ("Ironing Presser (Unit 1)", ("U1", "Ironing"), "Rs.560 - Rs.680 per shift", 171, "closed"),
]
ROLE_OF = {
    "Stitching": "machine operator",
    "Checking": "checker",
    "Packing": "packer",
    "Merchandising": "merchandiser",
    "Dyeing": "dyeing operator",
    "Human Resources": "HR executive",
    "Maintenance": "electrician",
    "Accounts & Finance": "accounts executive",
    "Washing": "washing operator",
    "Cutting": "cutting master",
    "Stores": "store keeper",
    "IT & Systems": "IT executive",
    "Ironing": "presser",
}
#: Departments short of their target headcount, and by how many people.
GAPS = {
    ("HO", "Merchandising"): 2,
    ("HO", "Accounts & Finance"): 1,
    ("U1", "Quality Control"): 2,
    ("U2", "Maintenance"): 1,
    ("U2", "Cutting"): 1,
    ("U2", "Stitching"): 2,
    ("U3", "Washing"): 1,
    ("U3", "Dyeing"): 1,
}
RULE_SETS = [
    ("U1", "Stitching", "Stitching operator"),
    ("U1", "Quality Control", "QC inspector"),
    ("U2", "Packing", "Packing supervisor"),
    ("HO", "Merchandising", "Merchandiser"),
    ("HO", "Accounts & Finance", "Accounts executive"),
]
SKILLS = {
    "Stitching": ["overlock", "flatlock", "single needle", "garment assembly", "line balancing"],
    "Quality Control": ["AQL inspection", "measurement", "defect analysis", "fabric inspection", "ISO 9001"],
    "Packing": ["folding", "carton packing", "barcode labelling", "inventory", "shipment documents"],
    "Merchandising": ["buyer communication", "costing", "T&A planning", "sampling", "Excel", "ERP"],
    "Accounts & Finance": ["Tally", "GST", "TDS", "bank reconciliation", "payroll accounting"],
}
CANDIDATE_STATUSES = [("uploaded", 4), ("not_shortlisted", 28), ("shortlisted", 20), ("selected", 8), ("rejected", 12)]


@dataclass
class _Funnel:
    applied: float
    attended: float
    selected: float
    rejected: float


def _funnel(age: int, status: str) -> _Funnel:
    """The mix of applicant stages for a job of this age. Old open jobs have interviewed people but found nobody."""
    if status == "closed":
        return _Funnel(0.10, 0.25, 0.10, 0.55)
    if age < 14:
        return _Funnel(0.84, 0.12, 0.0, 0.04)
    if age < 45:
        return _Funnel(0.50, 0.28, 0.06, 0.16)
    return _Funnel(0.28, 0.34, 0.0, 0.38)


def create_jobs(world: World) -> None:
    plan = world.plan
    rng = world.streams("jobs")
    names: NameFactory = world.extra["names"]
    today = plan.today
    now = at(today, plan.now)
    jobs: list[Job] = []
    ages: list[int] = []
    for title, (unit, dept), salary, age, status in JOBS:
        department = world.departments.get((unit, dept))
        jobs.append(
            Job(
                title=title,
                department=department,
                status=status,
                salary_range=salary,
                description=f"{title}. Join the {dept} team at UK Textiles, Tirupur. (demo data)",
                requirements="Relevant experience preferred; freshers with ITI / diploma may apply. Willing to work in shifts.",
                created_at=min(at(today - timedelta(days=age), time(10, 0)), now),
            )
        )
        ages.append(age)
    world.insert(Job, jobs)

    applicants: list[Applicant] = []
    for job, age, (_t, (unit, dept), _s, _a, status) in zip(jobs, ages, JOBS):
        funnel = _funnel(age, status)
        count = max(4, min(30, age // 4 + rng.randint(4, 9)))
        for n in range(count):
            person = names.person()
            stage = pick(
                rng,
                ["applied", "attended", "selected", "rejected"],
                [funnel.applied, funnel.attended, funnel.selected, funnel.rejected],
            )
            if status == "closed" and n == 0:
                stage = "selected"  # the position was filled
            applied_on = today - timedelta(days=rng.randint(0, max(1, age - 1)))
            interview = None
            if stage in ("attended", "selected"):
                interview = (applied_on + timedelta(days=rng.randint(2, 7))).isoformat()
            elif stage == "applied" and status == "open" and chance(rng, 0.22):
                interview = (today + timedelta(days=rng.randint(0, 6))).isoformat()  # an interview coming up
            years = rng.randint(1, 8)
            applicants.append(
                Applicant(
                    job=job,
                    name=person.full,
                    email=names.email(person, domain="mailbox.example"),
                    phone=names.phone(),
                    cover_letter="I am interested in this position and available to join immediately."
                    if chance(rng, 0.5)
                    else None,
                    experience=rng.choice(EXPERIENCE).format(n=years, role=ROLE_OF.get(dept, "executive")),
                    status=stage,
                    interview_date=interview,
                    notes="Referred by an employee" if chance(rng, 0.12) else None,
                    created_at=min(at(applied_on, time(rng.randint(9, 20), rng.randint(0, 59))), now),
                )
            )
    world.insert(Applicant, applicants)
    stale = [(title, age) for (title, _d, _s, age, status) in JOBS if status == "open" and age >= 60]
    world.stories["recruitment"] = {
        "openPositions": sum(1 for j in JOBS if j[4] == "open"),
        "staleOpenPositions": stale,
        "applicants": len(applicants),
    }
    world.summary["jobs"], world.summary["applicants"] = len(jobs), len(applicants)
    world.say(f"  {len(jobs)} jobs, {len(applicants)} applicants")


def create_screening(world: World) -> None:
    plan = world.plan
    rng = world.streams("screening")
    names: NameFactory = world.extra["names"]
    today = plan.today
    now = at(today, plan.now)
    rules = []
    for unit, dept, role in RULE_SETS:
        department = world.departments.get((unit, dept))
        if department is None:
            continue
        skills = SKILLS.get(dept, ["communication", "teamwork"])
        rules.append(
            HiringRuleSet(
                name=f"{role} - {dept} ({unit})",
                department=department,
                required_skills=skills[:3],
                soft_skills=["teamwork", "punctuality"],
                education_qualification="ITI / Diploma" if dept in ("Stitching", "Packing") else "Graduate",
                min_experience_years=Decimal("1.0"),
                preferred_city="Tirupur",
                other_requirements="Demo data",
                is_active=True,
                created_at=at(today - timedelta(days=200), time(10, 0)),
                updated_at=at(today - timedelta(days=200), time(10, 0)),
            )
        )
    world.insert(HiringRuleSet, rules)
    if not rules:
        return
    count = max(10, round(plan.employees * 0.28))
    candidates: list[ScreeningCandidate] = []
    statuses = [s for s, _ in CANDIDATE_STATUSES]
    weights = [w for _, w in CANDIDATE_STATUSES]
    for n in range(1, count + 1):
        rule = rng.choice(rules)
        dept = rule.department.name
        skills = SKILLS.get(dept, ["communication"])
        person = names.person()
        status = pick(rng, statuses, weights)
        score = {
            "uploaded": None,
            "not_shortlisted": rng.uniform(28, 62),
            "shortlisted": rng.uniform(70, 94),
            "selected": rng.uniform(78, 96),
            "rejected": rng.uniform(40, 80),
        }[status]
        uploaded = at(today - timedelta(days=rng.randint(1, 90)), time(rng.randint(9, 19), rng.randint(0, 59)))
        screened = None if status == "uploaded" else uploaded + timedelta(minutes=rng.randint(1, 40))
        invited = interview = None
        if status in ("shortlisted", "selected") and chance(rng, 0.8):
            invited = screened + timedelta(days=rng.randint(0, 2))
            interview = at((invited + timedelta(days=rng.randint(1, 6))).date(), time(rng.choice([10, 11, 14, 15]), 0))
        have = rng.sample(skills, rng.randint(1, len(skills)))
        candidates.append(
            ScreeningCandidate(
                rule_set=rule,
                department=rule.department,
                resume_file=f"resumes/demo/DM-RES-{n:04d}.pdf",
                original_filename=f"DM-RES-{n:04d}.pdf",
                source="bulk" if chance(rng, 0.6) else "single",
                candidate_name=person.full,
                email=names.email(person, domain="mailbox.example"),
                phone=names.phone(),
                city=rng.choice(CITIES),
                extracted_skills=have,
                extracted_soft_skills=["teamwork"] if chance(rng, 0.6) else [],
                extracted_experience_years=Decimal(str(round(rng.uniform(0, 9), 1))),
                extracted_education=rng.choice(
                    ["ITI", "Diploma in Textile Technology", "B.Com", "B.Sc", "Higher Secondary"]
                ),
                raw_text_excerpt="Resume text is not stored for demo candidates.",
                match_score=Decimal(str(round(score, 2))) if score is not None else None,
                score_breakdown={"skills": round(len(have) / max(1, len(skills)) * 100)} if score is not None else None,
                rank_in_batch=None,
                status=status,
                screened_at=screened,
                interview_invited_at=invited,
                interview_datetime=interview,
                rejection_emailed_at=(screened + timedelta(days=1))
                if status == "rejected" and chance(rng, 0.6)
                else None,
                notes=None,
                created_at=min(uploaded, now),
                updated_at=min(interview or screened or uploaded, now),
            )
        )
    world.insert(ScreeningCandidate, candidates)
    world.summary["screeningCandidates"] = len(candidates)
    world.say(f"  {len(rules)} hiring rule sets, {len(candidates)} screening candidates")


def create_resignations(world: World) -> None:
    """Approved resignations of the staff who left or are serving notice, and four still waiting for a decision."""
    plan = world.plan
    rng = world.streams("resignations")
    today = plan.today
    now = at(today, plan.now)
    heads = world.extra["heads"]
    hr = hr_name(world, "hr_demo")
    reasons = [r for r, _ in RESIGNATION_REASONS]
    reason_weights = [w for _, w in RESIGNATION_REASONS]
    rows: list[ResignationRequest] = []

    def hod_of(p: Person):
        head: Person | None = heads.get((p.unit, p.dept))
        return head if head is not None and head is not p and head.exit is None else None

    def trail(entries: list[tuple[str, str, datetime]]) -> list[dict]:
        return [
            {"role": role, "decision": "approved", "by": by, "at": when.isoformat(), "comment": None}
            for role, by, when in entries
        ]

    for p in sorted(world.people, key=lambda x: x.idx):
        if p.kind != "staff" or p.exit is None:
            continue
        reason = pick(rng, reasons, reason_weights)
        p.resignation_reason = reason
        filed = at(
            min(today, p.exit - timedelta(days=rng.randint(25, 45))), time(rng.randint(9, 17), rng.randint(0, 59))
        )
        head = hod_of(p)
        hod_at = office_hours(filed + timedelta(days=rng.randint(1, 3), hours=2))
        hr_at = office_hours(hod_at + timedelta(days=rng.randint(1, 4)))
        entries = ([("hod", head.full_name, hod_at)] if head else []) + [("hr", hr, hr_at)]
        rows.append(
            ResignationRequest(
                employee=p.emp,
                reason=reason,
                last_working_date=p.exit,
                survey_q1_answer=reason,
                survey_q2_answer=rng.choice(SURVEY_RECOMMEND),
                survey_q3_answer=rng.choice(SURVEY_RETAIN),
                status="approved",
                dept_head=head.emp if head else None,
                dept_head_status="approved" if head else None,
                dept_head_comment="Recommended" if head else None,
                dept_head_approved_at=hod_at if head else None,
                hr_comment="Accepted. Complete the exit formalities.",
                approved_by=hr,
                approved_at=min(hr_at, now),
                approval_trail=trail(entries),
                created_at=min(filed, now),
            )
        )

    candidates = [
        p
        for p in world.people
        if p.kind == "staff" and p.exit is None and not p.flags & {"five_day", "leave_streak", "recent"}
    ]
    pool = [p for p in candidates if not p.is_head]
    head_candidates = [p for p in candidates if p.is_head]
    rng.shuffle(pool)
    rng.shuffle(head_candidates)
    pool += head_candidates  # a small company has few staff who are not department heads: a head's request goes to HR
    waiting = [("pending", 13), ("dept_approved", 6), ("pending", 2), ("rejected", 41)]
    for (status, age), p in zip(waiting, pool):
        reason = pick(rng, reasons, reason_weights)
        filed = at(today - timedelta(days=age), time(rng.randint(9, 17), rng.randint(0, 59)))
        head = hod_of(p)
        hod_at = office_hours(filed + timedelta(days=1, hours=3))
        entries: list[tuple[str, str, datetime]] = []
        if status == "dept_approved" and head:
            entries = [("hod", head.full_name, hod_at)]
        rows.append(
            ResignationRequest(
                employee=p.emp,
                reason=reason,
                last_working_date=(filed + timedelta(days=30)).date(),
                survey_q1_answer=reason,
                survey_q2_answer=rng.choice(SURVEY_RECOMMEND),
                survey_q3_answer=rng.choice(SURVEY_RETAIN),
                status=status,
                dept_head=head.emp if head and status in ("dept_approved", "rejected") else None,
                dept_head_status="approved" if head and status in ("dept_approved", "rejected") else None,
                dept_head_comment="Recommended" if head and status == "dept_approved" else None,
                dept_head_approved_at=hod_at if head and status in ("dept_approved", "rejected") else None,
                hr_comment="Retention talk held; employee agreed to stay" if status == "rejected" else None,
                rejected_by="hr" if status == "rejected" else None,
                approval_trail=(
                    trail(entries)
                    if status == "dept_approved"
                    else [
                        {
                            "role": "hr",
                            "decision": "rejected",
                            "by": hr,
                            "at": (filed + timedelta(days=3)).isoformat(),
                            "comment": None,
                        }
                    ]
                    if status == "rejected"
                    else []
                ),
                created_at=filed,
            )
        )
        p.flags.add("resigning")
    world.insert(ResignationRequest, rows)
    pending = [r for r in rows if r.status in ("pending", "dept_approved")]
    world.stories["resignations"] = {
        "approved": sum(r.status == "approved" for r in rows),
        "pending": len(pending),
        "oldestPendingDays": max(((now - r.created_at).days for r in pending), default=0),
    }
    world.summary["resignations"] = len(rows)
    world.say(f"  {len(rows)} resignation requests ({len(pending)} waiting)")


def create_headcount_targets(world: World) -> None:
    """The staff headcount each department is meant to have: today's strength plus the gaps hiring is working on. The
    Required Roles page (and so the MD's view of it) counts ACTIVE STAFF only: production workers are hired against open jobs."""
    rng = world.streams("headcount")
    active: dict[tuple[str, str], int] = {}
    for p in world.people:
        if p.kind == "staff" and (p.exit is None or p.notice):
            active[(p.unit, p.dept)] = active.get((p.unit, p.dept), 0) + 1
    rows: list[DepartmentHeadcount] = []
    for (unit, dept), department in sorted(world.departments.items()):
        current = active.get((unit, dept), 0)
        gap = GAPS.get((unit, dept), rng.choice([0, 0, 0, 1]))
        rows.append(
            DepartmentHeadcount(
                department=department,
                required_count=current + gap,
                notes="Hiring in progress" if gap else None,
                updated_at=at(world.plan.today - timedelta(days=rng.randint(5, 60)), time(12, 0)),
            )
        )
    world.insert(DepartmentHeadcount, rows)
    world.stories["headcountGaps"] = {f"{u} {d}": g for (u, d), g in GAPS.items()}


def create_recruitment(world: World) -> None:
    world.say("Recruitment")
    create_jobs(world)
    create_screening(world)
    create_resignations(world)
    create_headcount_targets(world)
