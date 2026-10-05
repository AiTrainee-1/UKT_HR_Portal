"""The gate: visitors who come in, and employees who go out in the middle of their shift (outpasses).

Visitors (``Visitor`` + ``VisitorVisit``): a pool of people and companies, a few of whom come again and again; busy
Tuesdays to Thursdays, quiet Saturdays, a handful of visits after hours.

Outpasses (``OutpassRequest`` -> ``OutpassRecord`` -> ``OutpassGateScan``): requested by an employee who is at work, decided
by the department head or HR, scanned out and back in at a gate kiosk. The data has its stories: a few people who use outpasses
far more than anyone else, two passes whose holder never came back, and requests still waiting after more than a day.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from api.models import OutpassGateScan, OutpassRecord, OutpassRequest, Visitor, VisitorVisit

from .common import VISITOR_TAG, World, at, chance, clipped_normal, pick, s2t, t2s
from .names import AUDITORS, BUYERS, OFFICIALS, SERVICE_COMPANIES, SUPPLIERS, TRANSPORTERS, NameFactory
from .people import Person

VISIT_RATE = 6.0  # visits per working day for a 240-person company
DAY_MULTIPLIER = {0: 1.0, 1: 1.25, 2: 1.2, 3: 1.2, 4: 0.9, 5: 0.4, 6: 0.0}
UNIT_WEIGHT = {"HO": 45, "U1": 25, "U2": 18, "U3": 12}
HOST_DEPARTMENTS = {
    "HO": ("Purchase & Stores", "Merchandising", "Accounts & Finance", "Administration"),
    "U1": ("Stores", "Administration", "Maintenance", "Quality Control"),
    "U2": ("Administration", "Maintenance", "Quality Control"),
    "U3": ("Administration", "Maintenance"),
}
CANDIDATE_JOBS = [
    "Machine Operator",
    "Quality Checker",
    "Packing Helper",
    "Merchandiser",
    "Accounts Executive",
    "Electrician",
]


@dataclass
class VisitorKind:
    name: str
    weight: float
    companies: list[tuple[str, str]]
    purposes: list[str]
    why: list[str]
    hosts: str  # which departments they ask for: purchase | merch | admin | hr | quality | stores


KINDS = [
    VisitorKind(
        "supplier",
        38,
        SUPPLIERS,
        ["Delivery of {biz}", "Discussing rates for {biz}", "Quality complaint on {biz}", "Showing new {biz} samples"],
        ["Supplier visit", "Regular supplier", "Delivery follow-up"],
        "purchase",
    ),
    VisitorKind(
        "buyer",
        8,
        BUYERS,
        [
            "Sample approval for the next season",
            "Order review meeting",
            "Pre-production meeting",
            "Production follow-up",
        ],
        ["Buyer representative", "Buying house visit"],
        "merch",
    ),
    VisitorKind(
        "auditor",
        6,
        AUDITORS,
        ["{biz}", "{biz} - document review", "{biz} - floor walk"],
        ["Scheduled audit", "Compliance visit"],
        "admin",
    ),
    VisitorKind(
        "candidate",
        14,
        [("Walk-in", "interview")],
        ["Interview for {job}", "Appointment letter formalities", "Documents for joining"],
        ["Job candidate", "Referred by an employee"],
        "hr",
    ),
    VisitorKind(
        "transport", 12, TRANSPORTERS, ["Goods pickup", "Parcel delivery", "Courier pickup"], ["Transporter"], "stores"
    ),
    VisitorKind("official", 3, OFFICIALS, ["{biz}"], ["Government officer"], "admin"),
    VisitorKind(
        "service",
        10,
        SERVICE_COMPANIES,
        ["{biz}", "Annual maintenance visit", "Breakdown call"],
        ["Service engineer"],
        "quality",
    ),
    VisitorKind(
        "other",
        9,
        [("Family", "personal")],
        ["Meeting an employee about documents", "Dropping medicines for a family member", "Personal meeting"],
        ["Relative of an employee"],
        "admin",
    ),
]
KIND_BY_NAME = {k.name: k for k in KINDS}

PERSONAL = [
    ("Hospital - doctor's appointment", "Not feeling well"),
    ("Bank - personal work", "Bank work"),
    ("School - child's admission", "Child's school work"),
    ("Home - family emergency", "Family emergency"),
    ("Government office", "Ration card / Aadhaar work"),
    ("Pharmacy", "Medicine for a family member"),
    ("Railway station", "Collecting a parcel"),
]
OFFICIAL = [
    ("Bank - cheque deposit", "Official: depositing cheques"),
    ("Courier office", "Official: courier dispatch"),
    ("Vendor - sample collection", "Official: collecting samples"),
    ("GST / tax office", "Official: documents"),
    ("Other unit - material transfer", "Official: material transfer between units"),
]
EARLY = [("Home - feeling unwell", "Early dismissal: fever"), ("Home - emergency", "Early dismissal: family emergency")]
REJECTION = ["Not possible during the shipment rush", "Please apply a day earlier", "Too many people out already"]
OUTPASS_DAY = {0: 1.2, 1: 0.9, 2: 0.9, 3: 1.0, 4: 1.3, 5: 1.1, 6: 0.0}
OUTPASS_RATE = 0.034  # requests per person at work
NEVER_RETURNED = 3
STALE_PENDING = 5


def _poisson(rng: random.Random, mean: float) -> int:
    limit, k, product = math.exp(-mean), 0, 1.0
    while True:
        product *= rng.random()
        if product <= limit:
            return k
        k += 1


# ─── visitors ─────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Identity:
    name: str
    phone: str
    unit: str
    kind: VisitorKind
    company: str
    business: str
    weight: float
    known_before: bool
    row: Visitor | None = None
    visits: int = 0


def _hosts(world: World) -> dict[str, list[Person]]:
    out: dict[str, list[Person]] = {}
    for unit, depts in HOST_DEPARTMENTS.items():
        pool = [p for p in world.people if p.unit == unit and p.kind == "staff" and p.exit is None and p.dept in depts]
        out[unit] = pool or [p for p in world.people if p.kind == "staff" and p.exit is None]
    return out


def create_visitors(world: World) -> None:
    plan = world.plan
    rng = world.streams("visitors")
    names: NameFactory = world.extra["names"]
    scale = max(0.25, plan.employees / 240)
    pool_size = max(8, round(plan.days * 1.8 * scale))
    regulars = max(2, pool_size // 50)  # people who come far more often than the rest
    hosts = _hosts(world)
    units = list(UNIT_WEIGHT)

    identities: list[Identity] = []
    for rank in range(pool_size):
        kind = pick(rng, KINDS, [k.weight for k in KINDS])
        company, business = rng.choice(kind.companies)
        person = names.person()
        identities.append(
            Identity(
                name=person.full,
                phone=names.phone(),
                unit=pick(rng, units, [UNIT_WEIGHT[u] for u in units]),
                kind=kind,
                company=company,
                business=business,
                weight=(2.0 if rank < regulars else 1.0)
                / (rank + 6) ** 0.7,  # a few come again and again, most once or twice
                known_before=chance(rng, 0.40),
            )
        )
    weights = [i.weight for i in identities]

    visits: list[tuple[datetime, Identity, str]] = []
    for day in sorted(d for d in _window(world)):
        mean = VISIT_RATE * scale * DAY_MULTIPLIER[day.weekday()]
        if day in world.holidays:
            mean *= 0.15
        for _ in range(_poisson(rng, mean) if mean > 0 else 0):
            who = pick(rng, identities, weights)
            clock = s2t(int(clipped_normal(rng, 11.7 * 3600, 2.1 * 3600, 9 * 3600, 17 * 3600 + 1800)))
            visits.append((at(day, clock), who, who.unit))
    after_hours = _after_hours(world, rng, identities)
    visits.extend(after_hours)
    visits.sort(key=lambda v: v[0])
    now = at(plan.today, plan.now)
    visits = [v for v in visits if v[0] <= now]

    first_seen: dict[int, datetime] = {}
    for moment, who, _unit in visits:
        first_seen.setdefault(id(who), moment)
    rows: list[Visitor] = []
    for n, who in enumerate((i for i in identities if id(i) in first_seen), start=1):
        created = first_seen[id(who)]
        if who.known_before:
            created = created - timedelta(days=rng.randint(20, 380))
        who.row = Visitor(name=who.name, phone=who.phone, aadhaar_number=f"{VISITOR_TAG}{n:05d}", created_at=created)
        rows.append(who.row)
    world.insert(Visitor, rows)

    seen: set[int] = set()
    out: list[VisitorVisit] = []
    for moment, who, unit in visits:
        host = rng.choice(hosts[unit]) if hosts.get(unit) else None
        first = id(who) not in seen and not who.known_before
        seen.add(id(who))
        kind = who.kind
        purpose = rng.choice(kind.purposes).format(biz=who.business.capitalize(), job=rng.choice(CANDIDATE_JOBS))
        linked = host is not None and chance(rng, 0.75)
        out.append(
            VisitorVisit(
                visitor=who.row,
                branch=world.branches[unit],
                why_came=f"{kind.name.title()} - {who.company}: {rng.choice(kind.why)}" if first else None,
                whom_to_meet=host.full_name if host else "Reception",
                purpose=f"{purpose} ({who.company})" if kind.name not in ("candidate", "other") else purpose,
                meeting_employee=host.emp if linked else None,
                notified_whatsapp_at=moment + timedelta(seconds=4) if linked and chance(rng, 0.7) else None,
                notified_email_at=moment + timedelta(seconds=6) if linked and chance(rng, 0.25) else None,
                visited_at=moment,
            )
        )
        who.visits += 1
    world.insert(VisitorVisit, out)
    world.summary["visitors"] = len(rows)
    world.summary["visits"] = len(out)
    top = sorted((i for i in identities if i.visits), key=lambda i: -i.visits)[:3]
    world.stories["repeatVisitors"] = [
        {"name": i.name, "company": i.company, "visits": i.visits} for i in top if i.visits > 1
    ]
    world.stories["afterHoursVisits"] = len([v for v in after_hours if v[0] <= now])
    world.say(f"  {len(rows)} visitors, {len(out)} visits ({len(after_hours)} after hours)")


def _window(world: World) -> list[date]:
    plan = world.plan
    return [plan.window_start + timedelta(days=i) for i in range((plan.today - plan.window_start).days + 1)]


def _after_hours(world: World, rng: random.Random, identities: list[Identity]) -> list[tuple[datetime, Identity, str]]:
    """Visits long after the working day: couriers, auditors, service engineers, and one unexplained evening caller."""
    plan = world.plan
    days = [d for d in _window(world) if d != plan.today and d not in world.holidays]
    count = max(4, round(len(days) / 9))
    pool = [i for i in identities if i.kind.name in ("transport", "auditor", "service", "supplier")] or identities
    out: list[tuple[datetime, Identity, str]] = []
    for day in rng.sample(days, min(count, len(days))):
        if day.weekday() == 6:
            clock = s2t(rng.randint(10 * 3600, 14 * 3600))
        elif day.weekday() == 5:
            clock = s2t(rng.randint(15 * 3600 + 1800, 18 * 3600))
        else:
            clock = s2t(rng.randint(18 * 3600 + 2400, 21 * 3600 + 1800))
        who = rng.choice(pool)
        out.append((at(day, clock), who, who.unit))
    return out


# ─── outpasses ────────────────────────────────────────────────────────────────────────────────────────────────


def _request_time(rng: random.Random, record_times: list[time]) -> time | None:
    """When during the shift an employee asks for a pass: late morning or mid-afternoon, between their punches."""
    for _ in range(3):
        band = rng.random()
        centre = 11.5 * 3600 if band < 0.40 else 15.5 * 3600 if band < 0.85 else 9.5 * 3600
        clock = s2t(int(clipped_normal(rng, centre, 2700, 9 * 3600 + 1800, 17 * 3600)))
        low = t2s(record_times[0]) + 20 * 60 if record_times else 0
        high = t2s(record_times[-1]) - 40 * 60 if len(record_times) > 1 else 86399
        if low <= t2s(clock) <= high:
            return clock
    return None


def _trail(role: str, decision: str, by: str, when: datetime, comment: str | None = None) -> list[dict]:
    return [{"role": role, "decision": decision, "by": by, "at": when.isoformat(), "comment": comment}]


def create_outpasses(world: World) -> None:
    plan = world.plan
    rng = world.streams("outpass")
    now = at(plan.today, plan.now)
    people = {p.idx: p for p in world.people}
    heads = world.extra["heads"]
    from .org import hr_name

    requests: list[dict] = []
    for day in sorted(d for d in world.attended if d >= plan.window_start):
        present = world.attended[day]
        weights = [15.0 if "outpass_repeater" in people[i].flags else 1.0 for i in present]
        mean = len(present) * OUTPASS_RATE * OUTPASS_DAY[day.weekday()]
        for _ in range(_poisson(rng, mean) if mean > 0 else 0):
            idx = pick(rng, present, weights)
            p = people[idx]
            clock = _request_time(rng, world.days[idx][day].punches)
            if clock is None or at(day, clock) > now:
                continue
            requests.append({"p": p, "day": day, "created": at(day, clock)})

    # requests still waiting after more than a day (HR has not looked), made on a working day two or three days ago
    stale_days = [d for d in (plan.today - timedelta(days=2), plan.today - timedelta(days=3)) if d in world.attended]
    for n in range(STALE_PENDING if stale_days else 0):
        day = stale_days[n % len(stale_days)]
        p = people[rng.choice(world.attended[day])]
        requests.append({"p": p, "day": day, "created": at(day, s2t(rng.randint(10 * 3600, 15 * 3600))), "stale": True})
    # a couple of requests made in the last half hour, still waiting for their first decision
    for _ in range(2 if world.attended.get(plan.today) else 0):
        p = people[rng.choice(world.attended[plan.today])]
        requests.append(
            {"p": p, "day": plan.today, "created": now - timedelta(minutes=rng.randint(8, 40)), "fresh": True}
        )
    requests.sort(key=lambda r: r["created"])

    records: list[OutpassRecord] = []
    built: list[dict] = []
    for r in requests:
        p, created = r["p"], r["created"]
        kind = pick(rng, ["personal", "official", "early_dismissal"], [52, 33, 15])
        destination, reason = rng.choice({"personal": PERSONAL, "official": OFFICIAL, "early_dismissal": EARLY}[kind])
        head = heads.get((p.unit, p.dept))
        approver_role = "dept_head" if head is not None and head is not p and chance(rng, 0.6) else "hr"
        approver = (
            head.full_name
            if approver_role == "dept_head"
            else hr_name(world, "unit2hr_demo" if p.unit == "U2" else "hr_demo")
        )
        item = {
            "p": p,
            "created": created,
            "kind": kind,
            "destination": destination,
            "reason": reason,
            "role": approver_role,
            "by": approver,
            "status": "pending",
            "approved_at": None,
            "exit": None,
            "enter": None,
            "comment": None,
        }
        undecided = r.get("stale", False) or r.get("fresh", False)
        age_minutes = (now - created).total_seconds() / 60
        if not undecided and age_minutes > 3:
            decided = created + timedelta(minutes=clipped_normal(rng, 14, 9, 2, 55))
            if decided <= now:
                item["status"] = "approved" if chance(rng, 0.90) else "rejected"
                item["approved_at"] = decided
                if item["status"] == "rejected":
                    item["comment"] = rng.choice(REJECTION)
        if item["status"] == "approved":
            if chance(rng, 0.03):
                pass  # approved but never used: the pass expires unscanned
            else:
                exit_at = item["approved_at"] + timedelta(minutes=rng.uniform(2, 25))
                if exit_at <= now:
                    item["exit"] = exit_at
                    if kind != "early_dismissal":
                        stay = clipped_normal(rng, 75 if kind == "personal" else 55, 28, 18, 210)
                        back = exit_at + timedelta(minutes=stay)
                        item["stay"] = stay
                        if back <= now:
                            item["enter"] = back
        built.append(item)

    # two or three passes whose holder never came back (not early dismissals: those are not meant to return)
    candidates = [
        i
        for i in built
        if i["enter"] is not None
        and i["kind"] != "early_dismissal"
        and now - timedelta(days=24) <= i["created"] <= now - timedelta(days=3, hours=2)
    ]
    for item in rng.sample(candidates, min(NEVER_RETURNED, len(candidates))):
        item["enter"] = None

    for item in built:
        if item["status"] == "approved":
            p = item["p"]
            item["record"] = OutpassRecord(
                branch=world.branches[p.unit],
                employee=p.emp,
                employee_name=p.full_name,
                employee_code=p.code,
                destination=item["destination"],
                source="request",
                submitted_at=item["approved_at"],
            )
            records.append(item["record"])
    # the older QR-form exits that never went through a request
    for _ in range(max(2, round(len(records) * 0.07))):
        day = rng.choice(sorted(d for d in world.attended if d >= plan.window_start))
        p = people[rng.choice(world.attended[day])]
        known = chance(rng, 0.85)
        records.append(
            OutpassRecord(
                branch=world.branches[p.unit],
                employee=p.emp if known else None,
                employee_name=p.full_name,
                employee_code=p.code if known else f"{p.code[:3]}9{p.code[4:]}",
                destination=rng.choice(PERSONAL)[0],
                source="qr",
                submitted_at=at(day, s2t(rng.randint(10 * 3600, 16 * 3600))),
            )
        )
    world.insert(OutpassRecord, records)

    req_rows: list[OutpassRequest] = []
    scans: list[OutpassGateScan] = []
    for item in built:
        p = item["p"]
        gate = rng.choice(world.gates[p.unit])
        back_gate = gate if chance(rng, 0.85) else rng.choice(world.gates[p.unit])
        record = item.get("record")
        exit_at, enter_at, approved_at = item["exit"], item["enter"], item["approved_at"]
        status = item["status"]
        trail = (
            []
            if status == "pending"
            else _trail(
                "hod" if item["role"] == "dept_head" else "hr",
                "approved" if status == "approved" else "rejected",
                item["by"],
                approved_at,
                item["comment"],
            )
        )
        qr_generated = enter_at - timedelta(minutes=rng.uniform(1, 8)) if enter_at else None
        planned = item.get("stay")
        req_rows.append(
            OutpassRequest(
                employee=p.emp,
                destination=item["destination"],
                reason=item["reason"],
                status=status,
                source="manual",
                pass_type=item["kind"],
                expected_return_at=(approved_at + timedelta(minutes=(planned or 60) + 5))
                if approved_at and item["kind"] != "early_dismissal"
                else None,
                approver_role=item["role"] if status != "pending" else None,
                approved_by=item["by"] if status != "pending" else None,
                review_comment=item["comment"],
                approval_trail=trail,
                approved_at=approved_at if status == "approved" else None,
                outpass_record=record,
                exit_gate=gate if exit_at else None,
                exited_at=exit_at,
                entry_gate=back_gate if enter_at else None,
                entered_at=enter_at,
                return_qr_generated_at=qr_generated,
                created_at=item["created"],
                updated_at=enter_at or exit_at or approved_at or item["created"],
            )
        )
        if exit_at:
            scans.append(
                OutpassGateScan(
                    gate=gate,
                    employee=p.emp,
                    scan_type="exit",
                    result="success",
                    message=f"Exit recorded via {gate.name}",
                    scanned_at=exit_at,
                )
            )
            if chance(rng, 0.04):  # the same QR shown twice
                scans.append(
                    OutpassGateScan(
                        gate=gate,
                        employee=p.emp,
                        scan_type="exit",
                        result="already_scanned",
                        message=f"Already exited at {exit_at.strftime('%I:%M %p')} via {gate.name}",
                        scanned_at=exit_at + timedelta(minutes=rng.randint(1, 4)),
                    )
                )
        if enter_at:
            scans.append(
                OutpassGateScan(
                    gate=back_gate,
                    employee=p.emp,
                    scan_type="entry",
                    result="success",
                    message=f"Return recorded via {back_gate.name}",
                    scanned_at=enter_at,
                )
            )
        if status == "approved" and not exit_at and approved_at and approved_at + timedelta(minutes=61) <= now:
            scans.append(
                OutpassGateScan(
                    gate=gate,
                    employee=p.emp,
                    scan_type="exit",
                    result="expired",
                    message="This Outpass has expired.",
                    scanned_at=approved_at + timedelta(minutes=rng.randint(62, 90)),
                )
            )
    for _ in range(max(3, len(req_rows) // 150)):  # a QR nobody can read
        day = rng.choice(sorted(d for d in world.attended if d >= plan.window_start))
        gate = rng.choice(world.gates[rng.choice(list(world.gates))])
        scans.append(
            OutpassGateScan(
                gate=gate,
                scan_type="exit",
                result="invalid_qr",
                message="This QR code is not recognized.",
                scanned_at=at(day, s2t(rng.randint(10 * 3600, 17 * 3600))),
            )
        )
    world.insert(OutpassRequest, req_rows, batch_size=1000)
    world.insert(OutpassGateScan, scans, batch_size=2000)

    never_codes = [
        (r.employee.employee_code, r.created_at.date().isoformat())
        for r in req_rows
        if r.exited_at
        and not r.entered_at
        and r.pass_type != "early_dismissal"
        and r.created_at < now - timedelta(days=2)
    ]
    waiting = [r for r in req_rows if r.status == "pending" and now - r.created_at > timedelta(hours=24)]
    world.stories["outpass"] = {
        "neverReturned": never_codes,
        "waitingMoreThan24h": len(waiting),
        "repeatUsers": world.stories.get("outpassRepeatUsers", []),
    }
    world.summary["outpassRequests"] = len(req_rows)
    world.say(f"  {len(req_rows)} outpass requests, {len(records)} outpass records, {len(scans)} gate scans")


def create_gate(world: World) -> None:
    world.say("Visitors and outpasses")
    create_visitors(world)
    create_outpasses(world)
