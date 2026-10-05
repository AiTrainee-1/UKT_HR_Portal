"""The organisation of the demo company: units, departments, designations, shifts, the holiday calendar, company settings,
gate devices, HR roles and the HR / MD accounts.

A throwaway database made by ``e2e_setup.py`` already holds what the migrations seed (a "Head Office" branch, six leave
types, the production shift segments). Those are REUSED and never touched on purge; only what this module creates is
recorded for ``--purge``.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import date, time, timedelta
from decimal import Decimal
from typing import Iterable

import bcrypt

from django.core.management.base import CommandError

from api.models import (
    Branch,
    Department,
    Designation,
    GateDevice,
    GateQRCode,
    Holiday,
    HRUser,
    LeaveType,
    PayrollSettings,
    ReceptionDevice,
    Role,
    ShiftTemplate,
    TeaBreakRule,
)
from api.permission_registry import MODULE_TREE

from .common import DEMO_TAG, MD_USERNAME, QR_TOKEN_PREFIX, World, at

# ─── units and departments ────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class UnitSpec:
    key: str
    name: str
    code: str
    location: str
    address: str
    phone: str
    manager: str
    lat: float
    lng: float


UNITS: tuple[UnitSpec, ...] = (
    UnitSpec(
        "HO",
        "Head Office",
        "HO",
        "Tirupur, Tamil Nadu",
        "12, Kumaran Road, Tirupur - 641601",
        "0421 2234501",
        "S. Ramanathan",
        11.1075,
        77.3398,
    ),
    UnitSpec(
        "U1",
        "Unit 1 - Kangeyam Road",
        "Unit1",
        "Tirupur, Tamil Nadu",
        "88, Kangeyam Road, Veerapandi, Tirupur - 641604",
        "0421 2234510",
        "R. Subramaniam",
        11.0988,
        77.3730,
    ),
    UnitSpec(
        "U2",
        "Unit 2 - Avinashi Road",
        "Unit2",
        "Tirupur, Tamil Nadu",
        "214, Avinashi Road, Neruperichal, Tirupur - 641603",
        "0421 2234520",
        "M. Palanisamy",
        11.1356,
        77.2850,
    ),
    UnitSpec(
        "U3",
        "Unit 3 - Palladam Road",
        "Unit3",
        "Tirupur, Tamil Nadu",
        "5/21, Palladam Road, Karaipudur, Tirupur - 641605",
        "0421 2234530",
        "K. Shanmugam",
        11.0850,
        77.3105,
    ),
)
UNIT_BY_KEY = {u.key: u for u in UNITS}
PRODUCTION_UNITS = ("U1", "U2", "U3")


@dataclass(frozen=True)
class DeptSpec:
    name: str
    prod_weight: float  # share of the unit's production headcount
    staff_weight: float  # share of the unit's staff headcount


DEPARTMENTS: dict[str, tuple[DeptSpec, ...]] = {
    "HO": (
        DeptSpec("Administration", 0, 4),
        DeptSpec("Human Resources", 0, 4),
        DeptSpec("Accounts & Finance", 0, 7),
        DeptSpec("Merchandising", 0, 9),
        DeptSpec("Purchase & Stores", 0, 5),
        DeptSpec("IT & Systems", 0, 3),
    ),
    "U1": (
        DeptSpec("Cutting", 8, 1.5),
        DeptSpec("Stitching", 30, 3),
        DeptSpec("Checking", 8, 1.5),
        DeptSpec("Ironing", 6, 1),
        DeptSpec("Packing", 9, 1.5),
        DeptSpec("Quality Control", 2, 5),
        DeptSpec("Maintenance", 2, 3),
        DeptSpec("Stores", 2, 2),
        DeptSpec("Administration", 0, 4),
    ),
    "U2": (
        DeptSpec("Cutting", 6, 1),
        DeptSpec("Stitching", 24, 2.5),
        DeptSpec("Checking", 6, 1),
        DeptSpec("Ironing", 5, 1),
        DeptSpec("Packing", 7, 1.5),
        DeptSpec("Quality Control", 1, 4),
        DeptSpec("Maintenance", 2, 2),
        DeptSpec("Administration", 0, 3),
    ),
    "U3": (
        DeptSpec("Dyeing", 8, 2),
        DeptSpec("Washing", 10, 1.5),
        DeptSpec("Cutting", 4, 1),
        DeptSpec("Stitching", 10, 1.5),
        DeptSpec("Checking", 4, 1),
        DeptSpec("Packing", 5, 1),
        DeptSpec("Maintenance", 1, 2),
        DeptSpec("Administration", 0, 2),
    ),
}

#: Departments the planted stories rely on, with the fewest people each needs so the story survives a small ``--employees``.
STORY_MINIMUMS: dict[tuple[str, str, str], int] = {
    ("U3", "Washing", "production"): 3,
    ("U1", "Packing", "production"): 2,
    ("U2", "Packing", "production"): 1,
    ("U3", "Packing", "production"): 1,
    ("U1", "Stitching", "production"): 3,
    ("U2", "Stitching", "production"): 2,
    ("U3", "Stitching", "production"): 2,
    ("HO", "Merchandising", "staff"): 2,
    ("U1", "Quality Control", "staff"): 2,
}


@dataclass(frozen=True)
class Desig:
    title: str
    level: str  # junior | mid | senior | manager | executive
    kind: str  # staff | production
    weight: float
    low: int  # staff: monthly salary; production: wage per shift (rupees)
    high: int
    head: bool = False  # the department's head: takes its first staff place and becomes its HOD


def _d(title: str, level: str, kind: str, weight: float, low: int, high: int, head: bool = False) -> Desig:
    return Desig(title, level, kind, weight, low, high, head)


DESIGNATIONS: dict[str, tuple[Desig, ...]] = {
    "Cutting": (
        _d("Cutting Master", "senior", "staff", 1, 32000, 42000, True),
        _d("Cutting Supervisor", "mid", "staff", 1, 22000, 28000),
        _d("Fabric Cutter", "junior", "production", 6, 640, 780),
        _d("Spreader", "junior", "production", 3, 560, 650),
        _d("Cutting Helper", "junior", "production", 4, 520, 600),
    ),
    "Stitching": (
        _d("Production Supervisor", "senior", "staff", 1, 28000, 36000, True),
        _d("Line Supervisor", "mid", "staff", 2, 22000, 28000),
        _d("Senior Operator", "senior", "production", 8, 780, 950),
        _d("Machine Operator", "junior", "production", 14, 650, 780),
        _d("Stitching Helper", "junior", "production", 8, 520, 600),
        _d("Trainee Operator", "junior", "production", 2, 480, 540),
    ),
    "Checking": (
        _d("Checking Supervisor", "mid", "staff", 1, 21000, 27000, True),
        _d("Checker", "junior", "production", 6, 560, 650),
        _d("Trimmer", "junior", "production", 3, 520, 600),
    ),
    "Ironing": (
        _d("Ironing Supervisor", "mid", "staff", 1, 21000, 26000, True),
        _d("Presser", "junior", "production", 5, 560, 680),
        _d("Folder", "junior", "production", 3, 520, 600),
    ),
    "Packing": (
        _d("Packing Supervisor", "mid", "staff", 1, 22000, 28000, True),
        _d("Packer", "junior", "production", 5, 540, 620),
        _d("Loader", "junior", "production", 2, 520, 580),
    ),
    "Dyeing": (
        _d("Dyeing Master", "senior", "staff", 1, 38000, 50000, True),
        _d("Dyeing Operator", "junior", "production", 5, 640, 760),
        _d("Dye House Helper", "junior", "production", 3, 520, 600),
    ),
    "Washing": (
        _d("Washing Supervisor", "mid", "staff", 1, 24000, 30000, True),
        _d("Washing Operator", "junior", "production", 5, 600, 720),
        _d("Washing Helper", "junior", "production", 4, 520, 600),
    ),
    "Quality Control": (
        _d("QC Manager", "manager", "staff", 1, 45000, 60000, True),
        _d("QC Inspector", "mid", "staff", 4, 22000, 30000),
        _d("Quality Checker", "junior", "production", 2, 580, 680),
    ),
    "Maintenance": (
        _d("Maintenance Engineer", "senior", "staff", 1, 32000, 42000, True),
        _d("Mechanic", "mid", "staff", 3, 22000, 30000),
        _d("Electrician", "mid", "staff", 2, 21000, 28000),
        _d("Maintenance Helper", "junior", "production", 3, 520, 600),
    ),
    "Stores": (
        _d("Store Keeper", "mid", "staff", 1, 18000, 24000, True),
        _d("Stores Assistant", "junior", "staff", 1, 15000, 18000),
        _d("Stores Helper", "junior", "production", 2, 520, 580),
    ),
    "Administration": (
        _d("Unit Administrator", "senior", "staff", 1, 34000, 44000, True),
        _d("Admin Executive", "mid", "staff", 2, 18000, 24000),
        _d("Office Assistant", "junior", "staff", 1, 14000, 18000),
    ),
}
HO_DESIGNATIONS: dict[str, tuple[Desig, ...]] = {
    "Administration": (
        _d("General Manager - Operations", "executive", "staff", 1, 110000, 140000, True),
        _d("Admin Manager", "manager", "staff", 1, 50000, 60000),
        _d("Admin Executive", "mid", "staff", 2, 20000, 26000),
        _d("Office Assistant", "junior", "staff", 1, 14000, 18000),
    ),
    "Human Resources": (
        _d("HR Manager", "manager", "staff", 1, 70000, 85000, True),
        _d("HR Executive", "mid", "staff", 2, 28000, 34000),
        _d("Payroll Executive", "mid", "staff", 1, 26000, 32000),
    ),
    "Accounts & Finance": (
        _d("Accounts Manager", "manager", "staff", 1, 65000, 80000, True),
        _d("Senior Accountant", "senior", "staff", 2, 38000, 48000),
        _d("Accounts Executive", "mid", "staff", 3, 24000, 30000),
    ),
    "Merchandising": (
        _d("Merchandising Manager", "manager", "staff", 1, 70000, 90000, True),
        _d("Senior Merchandiser", "senior", "staff", 3, 42000, 55000),
        _d("Merchandiser", "mid", "staff", 4, 28000, 36000),
        _d("Sampling Coordinator", "mid", "staff", 2, 24000, 30000),
    ),
    "Purchase & Stores": (
        _d("Purchase Manager", "manager", "staff", 1, 60000, 75000, True),
        _d("Purchase Executive", "mid", "staff", 2, 26000, 34000),
        _d("Store Keeper", "mid", "staff", 2, 18000, 24000),
    ),
    "IT & Systems": (
        _d("IT Manager", "manager", "staff", 1, 55000, 70000, True),
        _d("IT Executive", "mid", "staff", 2, 28000, 36000),
    ),
}


def designations_for(unit: str, dept: str) -> tuple[Desig, ...]:
    return (HO_DESIGNATIONS if unit == "HO" else DESIGNATIONS)[dept]


# ─── shifts ───────────────────────────────────────────────────────────────────────────────────────────────────

#: key -> (name, type, start, end, grace minutes, first-half end, default?)
SHIFT_DEFS: dict[str, tuple[str, str, time, time, int, time | None, bool]] = {
    "office": ("Office Shift", "staff", time(9, 0), time(18, 0), 15, time(13, 0), True),
    "staff": ("Staff Shift", "staff", time(8, 30), time(17, 30), 15, time(12, 30), True),
    "regular": ("Regular Shift", "production", time(8, 30), time(17, 30), 10, None, True),
    "extended": ("Extended Shift", "production", time(8, 30), time(20, 0), 10, None, False),
}


def shift_keys_for(unit: str) -> tuple[str, ...]:
    return ("office",) if unit == "HO" else ("staff", "regular", "extended")


# ─── holidays ─────────────────────────────────────────────────────────────────────────────────────────────────

#: (month, day, name, type). Moveable festivals are pinned to their 2026 dates and reused for any other year: a demo
#: calendar, not an almanac.
HOLIDAY_TABLE: tuple[tuple[int, int, str, str], ...] = (
    (1, 1, "New Year's Day", "company"),
    (1, 14, "Pongal", "regional"),
    (1, 15, "Thiruvalluvar Day", "regional"),
    (1, 16, "Uzhavar Thirunal", "regional"),
    (1, 26, "Republic Day", "national"),
    (3, 21, "Ramzan (Eid-ul-Fitr)", "national"),
    (4, 3, "Good Friday", "national"),
    (4, 14, "Tamil New Year", "regional"),
    (5, 1, "May Day", "national"),
    (5, 27, "Bakrid (Eid-ul-Adha)", "national"),
    (6, 26, "Muharram", "national"),
    (8, 15, "Independence Day", "national"),
    (8, 26, "Milad-un-Nabi", "national"),
    (9, 4, "Krishna Jayanthi", "regional"),
    (9, 14, "Vinayagar Chathurthi", "regional"),
    (10, 2, "Gandhi Jayanthi", "national"),
    (10, 19, "Ayudha Puja", "regional"),
    (10, 20, "Vijayadasami", "regional"),
    (11, 9, "Deepavali (company holiday)", "company"),
    (12, 25, "Christmas", "national"),
)


def holiday_dates(first: date, last: date) -> dict[date, tuple[str, str]]:
    """The demo calendar between two dates: {date: (name, type)}."""
    out: dict[date, tuple[str, str]] = {}
    for year in range(first.year, last.year + 1):
        for month, day, name, kind in HOLIDAY_TABLE:
            out[date(year, month, day)] = (name, kind)
    return {d: v for d, v in out.items() if first <= d <= last}


# ─── permissions of the HR roles ──────────────────────────────────────────────────────────────────────────────

_TOP_LEVEL_KEYS = tuple(node["key"] for node in MODULE_TREE)


def role_permissions(edit: Iterable[str] = (), view: Iterable[str] = ()) -> dict[str, str]:
    """{module: "hidden" | "view" | "edit"} for every sidebar module (children inherit their parent)."""
    levels = {key: "hidden" for key in _TOP_LEVEL_KEYS}
    levels.update({key: "view" for key in view if key in levels})
    levels.update({key: "edit" for key in edit if key in levels})
    return levels


ROLE_DEFS: dict[str, tuple[str, dict[str, str]]] = {
    "HR Manager": (
        "All people operations: employees, attendance, leave, recruitment, payroll and reports.",
        role_permissions(
            edit=(
                "dashboard",
                "employees",
                "attendance",
                "shifts",
                "leave",
                "casual_leave",
                "missing_punch",
                "requests",
                "promotion",
                "increment",
                "bonus",
                "id_cards",
                "recruitment",
                "payroll",
                "production_payroll",
                "compensation",
                "salary",
                "salary_slip",
                "settlement",
                "outpass_visitors",
                "reports",
                "notifications",
            ),
            view=("settings", "geo_attendance", "login_devices", "mobile_app_login"),
        ),
    ),
    "Payroll Officer": (
        "Payroll, salary slips, settlements and compensation.",
        role_permissions(
            edit=(
                "dashboard",
                "payroll",
                "production_payroll",
                "salary",
                "salary_slip",
                "settlement",
                "bonus",
                "compensation",
            ),
            view=("employees", "attendance", "reports", "increment"),
        ),
    ),
    "Recruitment Executive": (
        "Jobs, applicants, resume screening and joining formalities.",
        role_permissions(edit=("dashboard", "recruitment"), view=("employees", "reports")),
    ),
    "Attendance Executive": (
        "Attendance, shifts, missing punches and geo attendance.",
        role_permissions(
            edit=("dashboard", "attendance", "shifts", "missing_punch", "geo_attendance", "casual_leave"),
            view=("employees", "leave", "reports"),
        ),
    ),
    "Gate Supervisor": (
        "Outpass, visitors and tea-break gate records.",
        role_permissions(edit=("dashboard", "outpass_visitors"), view=("employees",)),
    ),
}

#: username -> (full name, role, unit the account is limited to (None = every unit), home department)
HR_USERS: dict[str, tuple[str, str, str | None, str]] = {
    "hr_demo": ("Priya Venkatesh", "HR Manager", None, "Human Resources"),
    "payroll_demo": ("Karthikeyan R", "Payroll Officer", None, "Accounts & Finance"),
    "recruit_demo": ("Meenakshi S", "Recruitment Executive", None, "Human Resources"),
    "attendance_demo": ("Arun Prakash", "Attendance Executive", "U1", "Administration"),
    "unit2hr_demo": ("Lakshmi Narayanan", "HR Manager", "U2", "Administration"),
    "gate_demo": ("Ganesan P", "Gate Supervisor", None, "Administration"),
}
MD_FULL_NAME = "S. Ramanathan"

LEAVE_TYPE_DEFS = (
    ("AL", "Annual Leave", 18, "all"),
    ("SL", "Sick Leave", 12, "all"),
    ("CL", "Casual Leave", 12, "all"),
    ("EL", "Emergency Leave", 6, "all"),
    ("ML", "Maternity Leave", 180, "female"),
    ("PL", "Paternity Leave", 15, "male"),
)


# ─── builders ─────────────────────────────────────────────────────────────────────────────────────────────────


def _free_code(preferred: str) -> str:
    code = preferred
    suffix = 0
    while Branch.objects.filter(code=code).exists():
        suffix += 1
        code = f"{preferred}{chr(64 + suffix)}"
    return code


def build_branches(world: World) -> None:
    head = Branch.objects.filter(is_head_office=True).order_by("id").first()
    new_rows: list[Branch] = []
    for spec in UNITS:
        if spec.key == "HO" and head is not None:
            world.branches["HO"] = head  # the migrations' own head office: reused, never recorded for purge
            continue
        branch = Branch(
            name=spec.name,
            code=_free_code(spec.code),
            location=spec.location,
            address=f"{spec.address} {DEMO_TAG}",
            manager_name=spec.manager,
            phone=spec.phone,
            is_head_office=spec.key == "HO",
            is_active=True,
            geofence_lat=Decimal(str(spec.lat)),
            geofence_lng=Decimal(str(spec.lng)),
            geofence_radius_m=250,
            created_at=at(world.plan.history_start - timedelta(days=900), time(10, 0)),
        )
        world.branches[spec.key] = branch
        new_rows.append(branch)
    world.insert(Branch, new_rows)


def build_departments(world: World) -> None:
    existing = {
        (d.name, d.branch_id): d
        for d in Department.objects.filter(branch_id__in=[b.pk for b in world.branches.values()])
    }
    fresh: list[Department] = []
    created = at(world.plan.history_start - timedelta(days=800), time(10, 0))
    for unit, specs in DEPARTMENTS.items():
        branch = world.branches[unit]
        for spec in specs:
            found = existing.get((spec.name, branch.pk))
            if found is not None:
                world.departments[(unit, spec.name)] = found
                continue
            dept = Department(
                name=spec.name,
                description=f"{spec.name} - {UNIT_BY_KEY[unit].name} {DEMO_TAG}",
                branch=branch,
                created_at=created,
            )
            world.departments[(unit, spec.name)] = dept
            fresh.append(dept)
    world.insert(Department, fresh)


def build_designations(world: World) -> None:
    rows: list[Designation] = []
    created = at(world.plan.history_start - timedelta(days=800), time(10, 0))
    for (unit, dept_name), dept in world.departments.items():
        for desig in designations_for(unit, dept_name):
            row = Designation(title=desig.title, department=dept, level=desig.level, created_at=created)
            world.designations[(unit, dept_name, desig.title)] = row
            rows.append(row)
    world.insert(Designation, rows)


def build_shifts(world: World) -> None:
    rows: list[ShiftTemplate] = []
    created = at(world.plan.history_start - timedelta(days=700), time(10, 0))
    for unit in UNIT_BY_KEY:
        for key in shift_keys_for(unit):
            name, kind, start, end, grace, first_half_end, default = SHIFT_DEFS[key]
            left_over = ShiftTemplate.objects.filter(branch=world.branches[unit], name=name).first()
            if left_over is not None:
                world.shifts[(unit, key)] = left_over
                continue
            shift = ShiftTemplate(
                name=name,
                branch=world.branches[unit],
                shift_type=kind,
                start_time=start,
                end_time=end,
                gender_rule="all",
                grace_period_minutes=grace,
                first_half_end=first_half_end,
                lunch_duration_minutes=60,
                lunch_grace_minutes=10,
                is_default=default,
                is_active=True,
                created_at=created,
            )
            world.shifts[(unit, key)] = shift
            rows.append(shift)
    world.insert(ShiftTemplate, rows)


def build_holidays(world: World) -> None:
    plan = world.plan
    calendar = holiday_dates(date(plan.history_start.year, 1, 1), date(plan.today.year, 12, 31))
    rows = [
        Holiday(
            name=name,
            date=day,
            holiday_type=kind,
            is_recurring=False,
            description=("Tamil Nadu holiday calendar" if kind != "company" else "Declared by the company")
            + f" {DEMO_TAG}",
            created_at=at(date(day.year, 1, 2), time(11, 0)),
        )
        for day, (name, kind) in sorted(calendar.items())
    ]
    world.insert(Holiday, rows)
    world.holidays = {day: name for day, (name, _kind) in calendar.items()}


def build_leave_types(world: World) -> None:
    existing = {lt.code: lt for lt in LeaveType.objects.all()}
    fresh: list[LeaveType] = []
    for code, name, days, gender in LEAVE_TYPE_DEFS:
        row = existing.get(code)
        if row is None:
            row = LeaveType(
                name=name,
                code=code,
                max_days_per_year=days,
                is_paid=True,
                applicable_gender=gender,
                is_active=True,
                created_at=at(world.plan.history_start - timedelta(days=700), time(10, 0)),
            )
            fresh.append(row)
        world.leave_types[code] = row
    world.insert(LeaveType, fresh)


def build_settings(world: World) -> None:
    """Company settings the payroll and attendance engines read. A settings row that already exists is left as it is
    (the seeder adapts to it); a missing one is created with the rules a Tirupur manufacturer would run."""
    settings = PayrollSettings.objects.filter(pk=1).first()
    if settings is None:
        PayrollSettings.objects.create(
            pk=1,
            company_name="UK Textiles",
            company_tagline="Garments Manufacturing Excellence",
            company_phone="0421 2234500",
            company_email="hr@uktextiles.example",
            company_website="www.uktextiles.example",
            company_address="12, Kumaran Road, Tirupur - 641601",
            slip_company_name="UK TEXTILES - H.O",
            slip_company_address="TIRUPUR",
            attendance_mode="strict",
            pf_rate=Decimal("12"),
            esi_rate=Decimal("0.75"),
            esi_applicable_below=Decimal("21000"),
            staff_payroll_rules_enabled=True,
            prod_pf_rate=Decimal("12"),
            prod_esi_rate=Decimal("0.75"),
            prod_esi_applicable_below=Decimal("21000"),
            prod_payroll_rules_enabled=True,
            ot_detection_enabled=True,
            ot_threshold_minutes=60,
            ot_compensation_type="pay",
            late_free_allowance=3,
            pay_day=5,
            hr_contact_name="HR Department",
            hr_contact_phone="0421 2234505",
            hr_contact_email="hr@uktextiles.example",
            hr_contact_hours="Mon-Sat, 9:00 am - 6:00 pm",
        )
        world.created_singletons["PayrollSettings"] = True
        settings = PayrollSettings.objects.get(pk=1)  # a fresh read turns the TimeField defaults into real times
    else:
        world.created_singletons["PayrollSettings"] = False
        world.say("  PayrollSettings already exists: keeping its rules (the demo adapts to them)")
    if settings.attendance_mode != "strict":
        raise CommandError(
            "The existing payroll settings use the 'simple' attendance mode; the demo generates the strict 4-punch day. "
            "Switch Settings > Attendance to strict (or start from a database without a settings row)."
        )
    world.settings = settings

    rule = TeaBreakRule.objects.filter(pk=1).first()
    if rule is None:
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
        world.created_singletons["TeaBreakRule"] = True
    else:
        world.created_singletons["TeaBreakRule"] = False


def build_gates(world: World) -> None:
    """Gate scanners (the same logins scan outpasses and tea breaks), the permanent gate QR codes and a reception desk."""
    unusable = bcrypt.hashpw(secrets.token_hex(16).encode(), bcrypt.gensalt(rounds=4)).decode()  # nobody knows it
    devices: list[GateDevice] = []
    qrs: list[GateQRCode] = []
    desks: list[ReceptionDevice] = []
    created = at(world.plan.history_start - timedelta(days=600), time(10, 0))
    for unit in UNIT_BY_KEY:
        branch = world.branches[unit]
        names = ["Reception Gate"] if unit == "HO" else ["Main Gate", "Canteen Gate"]
        world.gates[unit] = []
        for n, name in enumerate(names, start=1):
            device = GateDevice(
                name=f"{name} - {'HO' if unit == 'HO' else 'Unit ' + unit[1]}",
                branch=branch,
                username=f"dm-gate-{unit.lower()}-{n}",
                password_hash=unusable,
                login_token=secrets.token_hex(16),
                is_active=True,
                created_by="hr_demo",
                created_at=created,
            )
            world.gates[unit].append(device)
            devices.append(device)
        for kind in ("outpass", "visitor"):
            qrs.append(
                GateQRCode(
                    branch=branch, kind=kind, token=f"{QR_TOKEN_PREFIX}{secrets.token_hex(15)}", created_at=created
                )
            )
    have = set(GateQRCode.objects.values_list("branch_id", "kind"))  # a unit keeps ONE permanent QR per kind
    qrs = [q for q in qrs if (q.branch_id, q.kind) not in have]
    world.insert(GateDevice, devices)
    world.insert(GateQRCode, qrs)
    desks.append(
        ReceptionDevice(
            name="Reception Desk - HO",
            branch=world.branches["HO"],
            username="dm-reception-ho",
            password_hash=unusable,
            login_token=secrets.token_hex(16),
            is_active=True,
            created_by="hr_demo",
            created_at=created,
        )
    )
    world.insert(ReceptionDevice, desks)


def build_accounts(world: World) -> None:
    """The HR roles and accounts, and the Managing Director's account (flagged ``is_md``, no role, no unit: company-wide)."""
    plan = world.plan
    created = at(plan.history_start - timedelta(days=60), time(10, 0))
    existing_roles = {r.name: r for r in Role.objects.filter(name__in=list(ROLE_DEFS))}
    fresh_roles: list[Role] = []
    for name, (description, permissions) in ROLE_DEFS.items():
        role = existing_roles.get(name)
        if role is None:
            role = Role(
                name=name,
                description=f"{description} {DEMO_TAG}",
                permissions=permissions,
                is_system=False,
                created_at=created,
                updated_at=created,
            )
            fresh_roles.append(role)
        world.roles[name] = role
    world.insert(Role, fresh_roles)

    password_hash = bcrypt.hashpw(plan.password.encode(), bcrypt.gensalt(rounds=8)).decode()
    users: list[HRUser] = []
    for username, (full_name, role_name, unit, dept) in HR_USERS.items():
        users.append(
            HRUser(
                username=username,
                email=f"{username.replace('_demo', '')}@uktextiles.example",
                full_name=full_name,
                password_hash=password_hash,
                role=world.roles[role_name],
                department=world.departments.get(("HO", dept)) if unit is None else world.departments.get((unit, dept)),
                branch=world.branches[unit] if unit else None,
                is_active=True,
                is_super_admin=False,
                created_at=created,
                updated_at=created,
            )
        )
    md = HRUser(
        username=MD_USERNAME,
        email="md@uktextiles.example",
        full_name=MD_FULL_NAME,
        password_hash=password_hash,
        role=None,
        department=None,
        branch=None,
        is_active=True,
        is_super_admin=False,
        is_md=True,
        md_assigned_at=created + timedelta(days=1),
        created_at=created,
        updated_at=created,
    )
    users.append(md)
    world.insert(HRUser, users)
    world.hr_users = {u.username: u for u in users}
    world.md_user = md


def hr_name(world: World, username: str) -> str:
    return world.hr_users[username].full_name or username


def build_org(world: World) -> None:
    world.say("Organisation")
    build_branches(world)
    build_departments(world)
    build_designations(world)
    build_shifts(world)
    build_holidays(world)
    build_leave_types(world)
    build_settings(world)
    build_gates(world)
    build_accounts(world)
    world.say(
        f"  {len(world.branches)} units, {len(world.departments)} departments, {len(world.designations)} designations, "
        f"{len(world.shifts)} shifts, {len(world.holidays)} holidays, {len(world.hr_users)} accounts"
    )
