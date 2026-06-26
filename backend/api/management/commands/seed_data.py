"""
python manage.py seed_data

Seeds the database with 1 month of realistic data:
  - 1 branch, 6 departments, designations
  - 10 staff employees + 25 production employees
  - Shifts, leave types, leave balances
  - June 2026 attendance logs (all 35 employees)
  - Payroll run + salary slips for June 2026
  - Biweekly payroll for production (W1 + W2)
  - Advances, leave requests, employee requests
  - Audit logs, HR users, roles
"""

import random
from datetime import date, time, timedelta, datetime
from decimal import Decimal

import bcrypt
from django.core.management.base import BaseCommand
from django.utils import timezone

from api.models import (
    Branch, Department, Designation, Employee,
    ShiftTemplate, EmployeeShiftAssignment,
    LeaveType, LeaveBalance, Holiday, LeaveRequest, EmployeeRequest,
    PayrollRun, EarningItem, DeductionItem, SalarySlip,
    Advance, AdvanceRepayment,
    Role, HRUser, AuditLog,
    AttendanceLog, Attendance,
)


# ── Constants ─────────────────────────────────────────────────────────────────
MONTH = 6
YEAR = 2026
WORKING_DAYS = 26  # June 2026 working days (Mon–Sat, minus holidays)
HOLIDAYS_JUNE = [date(2026, 6, 7)]  # Example: company holiday

STAFF_EMPLOYEES = [
    {"first": "Arjun",    "last": "Ramesh",    "gender": "male",   "role": "HR Manager",          "dept": "Admin & HR",        "salary": 42000, "dob": date(1985, 3, 12)},
    {"first": "Priya",    "last": "Sharma",    "gender": "female", "role": "HR Executive",         "dept": "Admin & HR",        "salary": 28000, "dob": date(1993, 7, 20)},
    {"first": "Karthik",  "last": "Suresh",    "gender": "male",   "role": "Accounts Manager",    "dept": "Accounts",          "salary": 38000, "dob": date(1982, 11, 5)},
    {"first": "Divya",    "last": "Nair",      "gender": "female", "role": "Production Manager",  "dept": "Production",        "salary": 45000, "dob": date(1980, 4, 18)},
    {"first": "Ravi",     "last": "Krishnan",  "gender": "male",   "role": "Quality Manager",     "dept": "Quality Control",   "salary": 36000, "dob": date(1987, 9, 25)},
    {"first": "Meena",    "last": "Pillai",    "gender": "female", "role": "Merchandiser",         "dept": "Merchandising",     "salary": 32000, "dob": date(1991, 2, 14)},
    {"first": "Suresh",   "last": "Babu",      "gender": "male",   "role": "Admin Executive",     "dept": "Admin & HR",        "salary": 22000, "dob": date(1995, 6, 30)},
    {"first": "Lakshmi",  "last": "Devi",      "gender": "female", "role": "Accounts Executive",  "dept": "Accounts",          "salary": 24000, "dob": date(1994, 1, 8)},
    {"first": "Murugan",  "last": "Raj",       "gender": "male",   "role": "Store Manager",       "dept": "Production",        "salary": 30000, "dob": date(1986, 5, 22)},
    {"first": "Kavitha",  "last": "Anand",     "gender": "female", "role": "Finishing Manager",   "dept": "Finishing",         "salary": 29000, "dob": date(1989, 8, 16)},
]

PRODUCTION_EMPLOYEES = [
    {"first": "Selvam",   "last": "K",    "gender": "male",   "role": "Senior Tailor",    "dept": "Sewing",          "salary": 16000, "dob": date(1990, 3, 1)},
    {"first": "Anbu",     "last": "S",    "gender": "male",   "role": "Machine Operator", "dept": "Sewing",          "salary": 13000, "dob": date(1992, 7, 12)},
    {"first": "Geetha",   "last": "R",    "gender": "female", "role": "Machine Operator", "dept": "Sewing",          "salary": 12000, "dob": date(1994, 9, 5)},
    {"first": "Mani",     "last": "P",    "gender": "male",   "role": "Cutter",           "dept": "Cutting",         "salary": 14000, "dob": date(1991, 5, 18)},
    {"first": "Saranya",  "last": "T",    "gender": "female", "role": "Checker",          "dept": "Quality Control", "salary": 11000, "dob": date(1996, 2, 28)},
    {"first": "Rajesh",   "last": "M",    "gender": "male",   "role": "Senior Cutter",    "dept": "Cutting",         "salary": 15500, "dob": date(1989, 11, 14)},
    {"first": "Sumathi",  "last": "V",    "gender": "female", "role": "Tailor",           "dept": "Sewing",          "salary": 10500, "dob": date(1997, 4, 6)},
    {"first": "Pandian",  "last": "A",    "gender": "male",   "role": "Helper",           "dept": "Production",      "salary": 9000,  "dob": date(1999, 1, 20)},
    {"first": "Revathi",  "last": "N",    "gender": "female", "role": "Presser",          "dept": "Finishing",       "salary": 10000, "dob": date(1998, 6, 10)},
    {"first": "Durai",    "last": "S",    "gender": "male",   "role": "Machine Operator", "dept": "Sewing",          "salary": 12500, "dob": date(1993, 8, 25)},
    {"first": "Malathi",  "last": "K",    "gender": "female", "role": "Tailor",           "dept": "Sewing",          "salary": 11000, "dob": date(1995, 3, 17)},
    {"first": "Vel",      "last": "M",    "gender": "male",   "role": "Cutter",           "dept": "Cutting",         "salary": 13500, "dob": date(1990, 12, 4)},
    {"first": "Pushpa",   "last": "R",    "gender": "female", "role": "Checker",          "dept": "Quality Control", "salary": 11500, "dob": date(1994, 7, 22)},
    {"first": "Senthil",  "last": "G",    "gender": "male",   "role": "Senior Tailor",    "dept": "Sewing",          "salary": 16000, "dob": date(1988, 2, 9)},
    {"first": "Kamala",   "last": "D",    "gender": "female", "role": "Presser",          "dept": "Finishing",       "salary": 10000, "dob": date(1997, 10, 31)},
    {"first": "Arun",     "last": "B",    "gender": "male",   "role": "Helper",           "dept": "Production",      "salary": 8500,  "dob": date(2001, 5, 15)},
    {"first": "Nirmala",  "last": "S",    "gender": "female", "role": "Tailor",           "dept": "Sewing",          "salary": 11000, "dob": date(1996, 9, 3)},
    {"first": "Bala",     "last": "K",    "gender": "male",   "role": "Machine Operator", "dept": "Sewing",          "salary": 13000, "dob": date(1992, 4, 27)},
    {"first": "Chitra",   "last": "P",    "gender": "female", "role": "Checker",          "dept": "Quality Control", "salary": 11500, "dob": date(1995, 11, 8)},
    {"first": "Muthu",    "last": "R",    "gender": "male",   "role": "Senior Cutter",    "dept": "Cutting",         "salary": 15000, "dob": date(1987, 6, 19)},
    {"first": "Prema",    "last": "V",    "gender": "female", "role": "Tailor",           "dept": "Sewing",          "salary": 10500, "dob": date(1998, 1, 14)},
    {"first": "Ganesh",   "last": "T",    "gender": "male",   "role": "Helper",           "dept": "Production",      "salary": 9000,  "dob": date(2000, 3, 7)},
    {"first": "Valli",    "last": "M",    "gender": "female", "role": "Presser",          "dept": "Finishing",       "salary": 10000, "dob": date(1997, 7, 21)},
    {"first": "Subash",   "last": "N",    "gender": "male",   "role": "Machine Operator", "dept": "Sewing",          "salary": 12000, "dob": date(1993, 5, 11)},
    {"first": "Usha",     "last": "L",    "gender": "female", "role": "Checker",          "dept": "Quality Control", "salary": 11000, "dob": date(1996, 12, 25)},
]


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def working_dates_in_june():
    """Returns all working dates (Mon–Sat) in June 2026 excluding company holidays."""
    dates = []
    d = date(YEAR, MONTH, 1)
    while d.month == MONTH:
        if d.weekday() != 6 and d not in HOLIDAYS_JUNE:  # skip Sunday
            dates.append(d)
        d += timedelta(days=1)
    return dates


class Command(BaseCommand):
    help = "Seed database with 1 month of realistic HR data (10 staff + 25 production)"

    def add_arguments(self, parser):
        parser.add_argument("--flush", action="store_true", help="Clear existing data before seeding")

    def handle(self, *args, **options):
        if options["flush"]:
            self.stdout.write("Flushing existing data…")
            self._flush()

        self.stdout.write(self.style.MIGRATE_HEADING("Starting seed…"))

        branch      = self._seed_branch()
        departments = self._seed_departments(branch)
        designations = self._seed_designations(departments)
        shifts      = self._seed_shifts(departments)
        leave_types = self._seed_leave_types()
        holidays    = self._seed_holidays(branch)

        staff_emps  = self._seed_employees(departments, designations, branch, "staff")
        prod_emps   = self._seed_employees(departments, designations, branch, "production")
        all_emps    = staff_emps + prod_emps

        self._seed_shift_assignments(all_emps, shifts)
        self._seed_leave_balances(all_emps, leave_types)
        self._seed_attendance(all_emps)
        self._seed_leave_requests(all_emps, leave_types)
        self._seed_employee_requests(all_emps)
        self._seed_advances(all_emps)

        payroll_staff    = self._seed_payroll_run("monthly", staff_emps)
        payroll_prod_w1  = self._seed_payroll_run("biweekly", prod_emps, week=1)
        payroll_prod_w2  = self._seed_payroll_run("biweekly", prod_emps, week=2)

        self._seed_salary_slips(staff_emps, payroll_staff, "staff")
        self._seed_salary_slips(prod_emps, payroll_prod_w1, "production", week=1)
        self._seed_salary_slips(prod_emps, payroll_prod_w2, "production", week=2)

        self._seed_roles_and_hr_users(departments, branch)
        self._seed_audit_logs()

        self.stdout.write(self.style.SUCCESS(
            f"\n✓ Seed complete — {len(staff_emps)} staff + {len(prod_emps)} production employees seeded for June 2026."
        ))

    # ── Flush ────────────────────────────────────────────────────────────────

    def _flush(self):
        models_to_clear = [
            AuditLog, HRUser, Role, SalarySlip, AdvanceRepayment, Advance,
            DeductionItem, EarningItem, PayrollRun, EmployeeRequest,
            LeaveRequest, LeaveBalance, Holiday, LeaveType,
            EmployeeShiftAssignment, ShiftTemplate, AttendanceLog, Attendance,
            Employee, Designation, Department, Branch,
        ]
        for m in models_to_clear:
            m.objects.all().delete()
        self.stdout.write("  Existing data cleared.")

    # ── Branch ───────────────────────────────────────────────────────────────

    def _seed_branch(self):
        branch, _ = Branch.objects.get_or_create(
            name="UKTextiles - Main Plant",
            defaults={
                "location": "Chennai, Tamil Nadu",
                "address": "No. 42, Industrial Estate, Ambattur, Chennai - 600058",
                "manager_name": "Arjun Ramesh",
                "phone": "+91 44 2356 7890",
                "is_active": True,
            }
        )
        self.stdout.write(f"  Branch: {branch.name}")
        return branch

    # ── Departments ───────────────────────────────────────────────────────────

    def _seed_departments(self, branch):
        dept_names = [
            "Admin & HR", "Accounts", "Production",
            "Cutting", "Sewing", "Finishing",
            "Quality Control", "Merchandising",
        ]
        depts = {}
        for name in dept_names:
            d, _ = Department.objects.get_or_create(name=name, defaults={"branch": branch})
            depts[name] = d
        self.stdout.write(f"  Departments: {len(depts)} created")
        return depts

    # ── Designations ──────────────────────────────────────────────────────────

    def _seed_designations(self, departments):
        desig_map = {
            "HR Manager":          ("Admin & HR",      "manager"),
            "HR Executive":        ("Admin & HR",      "mid"),
            "Admin Executive":     ("Admin & HR",      "junior"),
            "Accounts Manager":    ("Accounts",        "manager"),
            "Accounts Executive":  ("Accounts",        "junior"),
            "Production Manager":  ("Production",      "manager"),
            "Store Manager":       ("Production",      "senior"),
            "Helper":              ("Production",      "junior"),
            "Quality Manager":     ("Quality Control", "manager"),
            "Checker":             ("Quality Control", "junior"),
            "Merchandiser":        ("Merchandising",   "mid"),
            "Finishing Manager":   ("Finishing",       "manager"),
            "Presser":             ("Finishing",       "junior"),
            "Senior Tailor":       ("Sewing",          "senior"),
            "Tailor":              ("Sewing",          "junior"),
            "Machine Operator":    ("Sewing",          "junior"),
            "Senior Cutter":       ("Cutting",         "senior"),
            "Cutter":              ("Cutting",         "junior"),
        }
        desigs = {}
        for title, (dept_name, level) in desig_map.items():
            d, _ = Designation.objects.get_or_create(
                title=title,
                defaults={"department": departments.get(dept_name), "level": level}
            )
            desigs[title] = d
        self.stdout.write(f"  Designations: {len(desigs)} created")
        return desigs

    # ── Shifts ────────────────────────────────────────────────────────────────

    def _seed_shifts(self, departments):
        shifts_data = [
            {"name": "Staff Day Shift",             "type": "staff",      "start": time(9, 0),  "end": time(18, 0), "gender": "all",    "grace": 15, "default": True},
            {"name": "Production - Male Shift",     "type": "production", "start": time(9, 0),  "end": time(20, 0), "gender": "male",   "grace": 10, "default": False},
            {"name": "Production - Female Shift",   "type": "production", "start": time(9, 0),  "end": time(19, 0), "gender": "female", "grace": 10, "default": False},
            {"name": "Cutting & Finishing Shift",   "type": "production", "start": time(8, 30), "end": time(17, 30),"gender": "all",    "grace": 15, "default": False},
        ]
        shifts = {}
        for s in shifts_data:
            obj, _ = ShiftTemplate.objects.get_or_create(
                name=s["name"],
                defaults={
                    "shift_type": s["type"],
                    "start_time": s["start"],
                    "end_time": s["end"],
                    "gender_rule": s["gender"],
                    "grace_period_minutes": s["grace"],
                    "is_default": s["default"],
                    "is_active": True,
                }
            )
            shifts[s["name"]] = obj
        self.stdout.write(f"  Shifts: {len(shifts)} created")
        return shifts

    # ── Leave Types ───────────────────────────────────────────────────────────

    def _seed_leave_types(self):
        leave_data = [
            {"name": "Casual Leave",         "code": "CL",  "days": 12, "paid": True,  "carry": False, "gender": "all"},
            {"name": "Sick Leave",            "code": "SL",  "days": 12, "paid": True,  "carry": False, "gender": "all"},
            {"name": "Earned Leave",          "code": "EL",  "days": 15, "paid": True,  "carry": True,  "gender": "all"},
            {"name": "Maternity Leave",       "code": "ML",  "days": 182,"paid": True,  "carry": False, "gender": "female"},
            {"name": "Loss of Pay",           "code": "LOP", "days": 0,  "paid": False, "carry": False, "gender": "all"},
        ]
        types = {}
        for lt in leave_data:
            obj, _ = LeaveType.objects.get_or_create(
                code=lt["code"],
                defaults={
                    "name": lt["name"],
                    "max_days_per_year": lt["days"],
                    "is_paid": lt["paid"],
                    "carry_forward": lt["carry"],
                    "applicable_gender": lt["gender"],
                    "is_active": True,
                }
            )
            types[lt["code"]] = obj
        self.stdout.write(f"  Leave types: {len(types)} created")
        return types

    # ── Holidays ──────────────────────────────────────────────────────────────

    def _seed_holidays(self, branch):
        holidays_data = [
            {"name": "Company Foundation Day", "date": date(2026, 6, 7),  "type": "company"},
            {"name": "Eid al-Adha",            "date": date(2026, 6, 17), "type": "national"},
        ]
        for h in holidays_data:
            Holiday.objects.get_or_create(
                name=h["name"], date=h["date"],
                defaults={"holiday_type": h["type"], "branch": branch, "is_recurring": False}
            )
        self.stdout.write(f"  Holidays: {len(holidays_data)} seeded for June 2026")
        return holidays_data

    # ── Employees ─────────────────────────────────────────────────────────────

    def _seed_employees(self, departments, designations, branch, emp_type):
        source = STAFF_EMPLOYEES if emp_type == "staff" else PRODUCTION_EMPLOYEES
        prefix = "STF" if emp_type == "staff" else "PRD"
        employees = []
        pw_hash = hash_password("emp@123")

        for i, data in enumerate(source, 1):
            code = f"{prefix}{i:03d}"
            emp, created = Employee.objects.get_or_create(
                employee_code=code,
                defaults={
                    "first_name": data["first"],
                    "last_name": data["last"],
                    "gender": data["gender"],
                    "date_of_birth": data["dob"],
                    "email": f"{data['first'].lower()}.{data['last'].lower()}@uktextiles.in",
                    "phone": f"+91 9{random.randint(100000000, 999999999)}",
                    "employment_type": emp_type,
                    "department": departments.get(data["dept"]),
                    "designation": designations.get(data["role"]),
                    "branch": branch,
                    "salary_type": "monthly" if emp_type == "staff" else "biweekly",
                    "salary_amount": Decimal(str(data["salary"])),
                    "status": "active",
                    "join_date": str(date(random.randint(2020, 2024), random.randint(1, 12), random.randint(1, 28))),
                    "address": f"No. {random.randint(1,200)}, Chennai, Tamil Nadu",
                    "bank_name": random.choice(["State Bank of India", "Indian Bank", "Canara Bank", "HDFC Bank"]),
                    "bank_account": f"{random.randint(1000000000, 9999999999)}",
                    "bank_ifsc": f"SBIN{random.randint(1000, 9999)}",
                    "pf_number": f"TN/CHN/{random.randint(100000, 999999)}/000/{i:03d}",
                    "esi_number": f"31-{random.randint(10000000, 99999999)}-{random.randint(10, 99)}",
                    "uan_number": f"10{random.randint(1000000000, 9999999999)}",
                    "password_hash": pw_hash,
                }
            )
            employees.append(emp)

        self.stdout.write(f"  {emp_type.capitalize()} employees: {len(employees)} seeded")
        return employees

    # ── Shift Assignments ─────────────────────────────────────────────────────

    def _seed_shift_assignments(self, employees, shifts):
        for emp in employees:
            if emp.employment_type == "staff":
                shift = shifts["Staff Day Shift"]
            elif emp.gender == "female":
                shift = shifts["Production - Female Shift"]
            else:
                shift = shifts["Production - Male Shift"]

            EmployeeShiftAssignment.objects.get_or_create(
                employee=emp,
                shift=shift,
                effective_from=date(2026, 1, 1),
                defaults={"assigned_by": "hr_admin", "effective_to": None}
            )
        self.stdout.write(f"  Shift assignments: {len(employees)} assigned")

    # ── Leave Balances ────────────────────────────────────────────────────────

    def _seed_leave_balances(self, employees, leave_types):
        count = 0
        for emp in employees:
            for code, lt in leave_types.items():
                if lt.applicable_gender not in ("all", emp.gender):
                    continue
                used = Decimal(str(random.randint(0, 3)))
                allocated = Decimal(str(lt.max_days_per_year))
                LeaveBalance.objects.get_or_create(
                    employee=emp, leave_type=lt, year=YEAR,
                    defaults={
                        "allocated": allocated,
                        "used": used,
                        "remaining": allocated - used,
                        "carried_forward": Decimal("0"),
                    }
                )
                count += 1
        self.stdout.write(f"  Leave balances: {count} records created")

    # ── Attendance ────────────────────────────────────────────────────────────

    def _seed_attendance(self, employees):
        work_dates = working_dates_in_june()
        log_count = 0

        for emp in employees:
            is_female = emp.gender == "female"
            shift_end = time(19, 0) if (emp.employment_type == "production" and is_female) else \
                        time(20, 0) if emp.employment_type == "production" else time(18, 0)

            for d in work_dates:
                # 92% attendance rate — some absences
                if random.random() < 0.08:
                    continue

                # Punch IN — small variation around 9:00
                in_min = random.randint(-5, 20)  # slightly early or late
                in_h, in_m = divmod(9 * 60 + in_min, 60)
                punch_in = time(max(8, in_h), in_m)

                # Punch OUT
                out_min = random.randint(-15, 30)
                out_h, out_m = divmod(shift_end.hour * 60 + shift_end.minute + out_min, 60)
                punch_out = time(min(22, out_h), out_m)

                AttendanceLog.objects.get_or_create(
                    employee=emp, date=d, punch_type="IN",
                    defaults={"punch_time": punch_in, "source": "biometric"}
                )
                AttendanceLog.objects.get_or_create(
                    employee=emp, date=d, punch_type="OUT",
                    defaults={"punch_time": punch_out, "source": "biometric"}
                )
                log_count += 2

        self.stdout.write(f"  Attendance logs: {log_count} punch records created")

    # ── Leave Requests ────────────────────────────────────────────────────────

    def _seed_leave_requests(self, employees, leave_types):
        cl = leave_types["CL"]
        sl = leave_types["SL"]
        statuses = ["approved", "approved", "approved", "rejected", "pending"]

        requests = [
            (employees[0],  cl, "2026-06-02", "2026-06-02", 1, "Personal work",   "approved"),
            (employees[2],  sl, "2026-06-10", "2026-06-11", 2, "Fever",           "approved"),
            (employees[5],  cl, "2026-06-16", "2026-06-16", 1, "Family function", "approved"),
            (employees[7],  cl, "2026-06-23", "2026-06-23", 1, "Personal",        "pending"),
            (employees[10], sl, "2026-06-05", "2026-06-06", 2, "Not well",        "approved"),
            (employees[13], cl, "2026-06-19", "2026-06-19", 1, "Personal work",   "rejected"),
            (employees[18], sl, "2026-06-12", "2026-06-12", 1, "Headache",        "approved"),
            (employees[22], cl, "2026-06-26", "2026-06-27", 2, "Travel",          "pending"),
        ]

        for emp, lt, start, end, days, reason, status in requests:
            LeaveRequest.objects.get_or_create(
                employee=emp, start_date=start, end_date=end,
                defaults={
                    "leave_type_ref": lt,
                    "type": lt.code.lower(),
                    "total_days": Decimal(str(days)),
                    "reason": reason,
                    "status": status,
                    "approved_by": "hr_admin" if status == "approved" else None,
                    "hr_comment": "Approved." if status == "approved" else
                                  "Insufficient balance." if status == "rejected" else None,
                }
            )
        self.stdout.write(f"  Leave requests: {len(requests)} seeded")

    # ── Employee Requests ─────────────────────────────────────────────────────

    def _seed_employee_requests(self, employees):
        requests = [
            (employees[1],  "salary_enquiry",  "June Salary Enquiry",          "When will June salary be credited?",            "approved"),
            (employees[4],  "advance",          "Medical Advance Request",       "Need ₹5000 advance for medical emergency.",      "pending"),
            (employees[8],  "shift_correction", "Punch Missing on June 9",       "I was present on June 9 but punch not recorded.", "in_review"),
            (employees[11], "permission",       "Early Leave - June 20",         "Doctor appointment at 4 PM on June 20.",          "approved"),
            (employees[15], "general",          "Uniform Request",               "Need new uniform — old one is worn out.",          "pending"),
            (employees[20], "salary_enquiry",   "PF Deduction Query",            "Why was extra PF deducted in May slip?",          "approved"),
            (employees[24], "advance",          "Festival Advance",              "Requesting ₹3000 advance for Eid celebration.",   "approved"),
            (employees[3],  "shift_correction", "OT not recorded - June 15",     "Worked until 9 PM but OT not shown.",             "pending"),
        ]

        for emp, rtype, subject, desc, status in requests:
            EmployeeRequest.objects.get_or_create(
                employee=emp, subject=subject,
                defaults={
                    "request_type": rtype,
                    "description": desc,
                    "status": status,
                    "hr_notes": "Resolved." if status == "approved" else
                                "Under review." if status == "in_review" else None,
                    "handled_by": "hr_admin" if status in ("approved", "in_review") else None,
                    "handled_at": timezone.now() if status == "approved" else None,
                }
            )
        self.stdout.write(f"  Employee requests: {len(requests)} seeded")

    # ── Advances ──────────────────────────────────────────────────────────────

    def _seed_advances(self, employees):
        advances_data = [
            (employees[6],  "general", 3000,  "Festival advance",       "approved", 0,    3000),
            (employees[12], "term",    15000, "Medical emergency loan", "approved", 2500, 12500),
            (employees[17], "general", 2000,  "Personal need",          "approved", 0,    2000),
            (employees[21], "term",    10000, "House repair loan",      "approved", 1000, 9000),
            (employees[9],  "general", 5000,  "Medical advance",        "pending",  0,    5000),
        ]

        for emp, atype, amount, purpose, status, repaid, outstanding in advances_data:
            adv, created = Advance.objects.get_or_create(
                employee=emp, purpose=purpose,
                defaults={
                    "advance_type": atype,
                    "amount": Decimal(str(amount)),
                    "status": status,
                    "approved_by": "hr_admin" if status == "approved" else None,
                    "approved_at": timezone.now() if status == "approved" else None,
                    "repayment_start_month": 5,
                    "repayment_start_year": 2026,
                    "emi_amount": Decimal("1000") if atype == "term" else Decimal("0"),
                    "total_repaid": Decimal(str(repaid)),
                    "outstanding": Decimal(str(outstanding)),
                }
            )
            # Add repayment record if already repaid some
            if created and repaid > 0:
                AdvanceRepayment.objects.create(
                    advance=adv, month=5, year=2026, amount=Decimal(str(repaid)),
                    notes="May 2026 EMI"
                )

        self.stdout.write("  Advances: 5 seeded (4 approved, 1 pending)")

    # ── Payroll Runs ──────────────────────────────────────────────────────────

    def _seed_payroll_run(self, run_type, employees, week=None):
        if run_type == "monthly":
            code = f"PAY-{YEAR}-{MONTH:02d}-M"
            label = "Monthly Staff Payroll — June 2026"
        else:
            code = f"PAY-{YEAR}-{MONTH:02d}-W{week}"
            label = f"Production Bi-Weekly W{week} — June 2026"

        # Calculate totals
        total_gross = sum(
            (e.salary_amount or Decimal("0")) / (2 if run_type == "biweekly" else 1)
            for e in employees
        )
        pf_rate = Decimal("0.12")
        esi_rate = Decimal("0.0075")
        total_deductions = sum(
            min(e.salary_amount or Decimal("0"), Decimal("21000")) * esi_rate +
            (e.salary_amount or Decimal("0")) * Decimal("0.50") * pf_rate
            for e in employees
        )
        total_net = total_gross - total_deductions

        run, _ = PayrollRun.objects.get_or_create(
            run_code=code,
            defaults={
                "month": MONTH,
                "year": YEAR,
                "run_type": run_type,
                "week_number": week,
                "status": "locked" if run_type == "monthly" else "approved",
                "total_employees": len(employees),
                "total_gross": total_gross.quantize(Decimal("0.01")),
                "total_deductions": total_deductions.quantize(Decimal("0.01")),
                "total_net": total_net.quantize(Decimal("0.01")),
                "processed_by": "ravi.payroll",
                "approved_by": "hr_admin",
                "approved_at": timezone.make_aware(datetime(2026, 6, 28, 10, 0)),
                "locked_at": timezone.make_aware(datetime(2026, 6, 29, 9, 0)) if run_type == "monthly" else None,
                "notes": label,
            }
        )
        self.stdout.write(f"  Payroll run: {code} (status={run.status})")
        return run

    # ── Salary Slips ─────────────────────────────────────────────────────────

    def _seed_salary_slips(self, employees, payroll_run, emp_type, week=None):
        count = 0
        for emp in employees:
            salary = emp.salary_amount or Decimal("12000")
            divisor = Decimal("2") if emp_type == "production" else Decimal("1")
            gross = (salary / divisor).quantize(Decimal("0.01"))

            basic       = (gross * Decimal("0.50")).quantize(Decimal("0.01"))
            hra         = (gross * Decimal("0.20")).quantize(Decimal("0.01"))
            allowances  = (gross * Decimal("0.20")).quantize(Decimal("0.01"))
            bonuses     = (gross * Decimal("0.10")).quantize(Decimal("0.01"))

            pf          = (basic * Decimal("0.12")).quantize(Decimal("0.01"))
            esi         = (min(gross, Decimal("21000")) * Decimal("0.0075")).quantize(Decimal("0.01"))
            adv_deduct  = Decimal("1000") if emp_type == "production" and employees.index(emp) in [2, 11] else Decimal("0")
            total_ded   = pf + esi + adv_deduct
            net         = (gross - total_ded).quantize(Decimal("0.01"))

            present     = Decimal(str(random.randint(23, 26)))
            absent      = Decimal(str(WORKING_DAYS)) - present

            suffix = f"W{week}" if week else "M"
            slip_num = f"SS/{emp.employee_code}/{YEAR}/{MONTH:02d}/{suffix}"

            SalarySlip.objects.get_or_create(
                slip_number=slip_num,
                defaults={
                    "employee": emp,
                    "payroll_run": payroll_run,
                    "month": MONTH,
                    "year": YEAR,
                    "week_number": week,
                    "basic": basic,
                    "hra": hra,
                    "allowances": allowances,
                    "bonuses": bonuses,
                    "ot_amount": Decimal("0"),
                    "gross_salary": gross,
                    "pf_deduction": pf,
                    "esi_deduction": esi,
                    "advance_deduction": adv_deduct,
                    "other_deductions": Decimal("0"),
                    "total_deductions": total_ded,
                    "net_salary": net,
                    "working_days": WORKING_DAYS,
                    "present_days": present,
                    "absent_days": absent,
                }
            )
            count += 1
        self.stdout.write(f"  Salary slips: {count} for {emp_type} (payroll {payroll_run.run_code})")

    # ── Roles & HR Users ──────────────────────────────────────────────────────

    def _seed_roles_and_hr_users(self, departments, branch):
        full_perm = {
            "employees": {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "payroll":   {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "leave":     {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "reports":   {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "settings":  {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "users":     {"view": True, "create": True, "edit": True, "delete": True, "approve": True},
            "audit":     {"view": True, "create": False,"edit": False, "delete": False,"approve": False},
        }
        exec_perm = {
            "employees": {"view": True, "create": True, "edit": True, "delete": False, "approve": False},
            "payroll":   {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
            "leave":     {"view": True, "create": True, "edit": True, "delete": False, "approve": True},
            "reports":   {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
            "settings":  {"view": False,"create": False,"edit": False, "delete": False, "approve": False},
            "users":     {"view": False,"create": False,"edit": False, "delete": False, "approve": False},
            "audit":     {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
        }
        payroll_perm = {
            "employees": {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
            "payroll":   {"view": True, "create": True, "edit": True, "delete": False, "approve": True},
            "leave":     {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
            "reports":   {"view": True, "create": True, "edit": False, "delete": False, "approve": False},
            "settings":  {"view": False,"create": False,"edit": False, "delete": False, "approve": False},
            "users":     {"view": False,"create": False,"edit": False, "delete": False, "approve": False},
            "audit":     {"view": True, "create": False,"edit": False, "delete": False, "approve": False},
        }

        admin_role, _ = Role.objects.get_or_create(name="HR Admin",         defaults={"permissions": full_perm,    "is_system": True,  "description": "Full access to all modules"})
        exec_role,  _ = Role.objects.get_or_create(name="HR Executive",     defaults={"permissions": exec_perm,    "is_system": False, "description": "Manage employees and leave"})
        pay_role,   _ = Role.objects.get_or_create(name="Payroll Officer",  defaults={"permissions": payroll_perm, "is_system": False, "description": "Manage payroll and reports"})

        users = [
            ("hr_admin",     "admin@uktextiles.in",    "HR Administrator", admin_role, True,  departments["Admin & HR"]),
            ("priya.hr",     "priya@uktextiles.in",    "Priya Sharma",     exec_role,  False, departments["Admin & HR"]),
            ("ravi.payroll", "ravi@uktextiles.in",     "Ravi Krishnan",    pay_role,   False, departments["Accounts"]),
        ]

        for username, email, full_name, role, is_super, dept in users:
            HRUser.objects.get_or_create(
                username=username,
                defaults={
                    "email": email,
                    "full_name": full_name,
                    "password_hash": hash_password("admin123"),
                    "role": role,
                    "department": dept,
                    "branch": branch,
                    "is_active": True,
                    "is_super_admin": is_super,
                    "last_login": timezone.now() - timedelta(hours=random.randint(1, 48)),
                }
            )
        self.stdout.write("  Roles: 3 | HR Users: 3 seeded")

    # ── Audit Logs ────────────────────────────────────────────────────────────

    def _seed_audit_logs(self):
        logs = [
            ("hr_admin",     "login",   "auth",      "HR Admin logged in",                          "192.168.1.10"),
            ("priya.hr",     "create",  "employees", "Created employee PRD001 — Selvam K",          "192.168.1.12"),
            ("hr_admin",     "approve", "leave",     "Approved leave for STF002 — Priya Sharma",    "192.168.1.10"),
            ("ravi.payroll", "create",  "payroll",   "Created payroll run PAY-2026-06-M",           "192.168.1.15"),
            ("hr_admin",     "approve", "payroll",   "Approved payroll run PAY-2026-06-M",          "192.168.1.10"),
            ("ravi.payroll", "lock",    "payroll",   "Locked payroll run PAY-2026-06-M",            "192.168.1.15"),
            ("priya.hr",     "update",  "employees", "Updated salary for PRD014 — Senthil G",       "192.168.1.12"),
            ("ravi.payroll", "export",  "reports",   "Exported payroll report — June 2026 (CSV)",   "192.168.1.15"),
            ("hr_admin",     "approve", "advances",  "Approved advance for PRD007 — Sumathi V",     "192.168.1.10"),
            ("priya.hr",     "create",  "leave",     "Added holiday: Company Foundation Day",       "192.168.1.12"),
        ]

        base_time = timezone.make_aware(datetime(2026, 6, 22, 9, 0))
        for i, (uname, action, module, desc, ip) in enumerate(logs):
            AuditLog.objects.create(
                user_name=uname,
                user_type="hr",
                action=action,
                module=module,
                record_description=desc,
                ip_address=ip,
                created_at=base_time + timedelta(hours=i, minutes=random.randint(0, 59)),
            )
        self.stdout.write(f"  Audit logs: {len(logs)} seeded")
