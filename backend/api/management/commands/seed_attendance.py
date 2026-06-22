import random
from datetime import date, timedelta
from decimal import Decimal
from django.core.management.base import BaseCommand
from api.models import Employee, Attendance, SalaryRecord, Payroll, Department

DEFAULT_DEPARTMENTS = [
    ("Production", "Main garment production unit"),
    ("Quality", "Quality control and inspection"),
    ("HR", "Human resources and administration"),
    ("Finance", "Payroll, accounts and finance"),
    ("Maintenance", "Plant and equipment upkeep"),
    ("Logistics", "Shipping, inventory and dispatch"),
]

class Command(BaseCommand):
    help = "Seed attendance records and optionally generate payroll for current employees"

    def add_arguments(self, parser):
        parser.add_argument(
            "--generate-payroll",
            action="store_true",
            help="Generate salary records for the seeded attendance data",
        )
        parser.add_argument(
            "--clear-payroll",
            action="store_true",
            help="Delete existing SalaryRecord and Payroll entries before seeding",
        )

    def handle(self, *args, **options):
        self.stdout.write("Starting database seeding for attendance and optional payroll...")

        if options.get("clear_payroll"):
            SalaryRecord.objects.all().delete()
            Payroll.objects.all().delete()
            self.stdout.write("Cleared existing salary and payroll records.")

        # Ensure default departments exist
        created_departments = 0
        for name, description in DEFAULT_DEPARTMENTS:
            dept, created = Department.objects.get_or_create(
                name=name,
                defaults={"description": description},
            )
            if created:
                created_departments += 1
        if created_departments:
            self.stdout.write(f"Created {created_departments} default departments.")

        dept = Department.objects.filter(name="Production").first()
        if not dept:
            dept = Department.objects.create(
                name="Production",
                description="Main garment production unit",
            )

        # Get or create our three main employees
        # 1. SURYA M (Monthly staff)
        emp1, created1 = Employee.objects.get_or_create(
            id=1,
            defaults={
                "employee_code": "1/26",
                "first_name": "SURYA",
                "last_name": "M",
                "email": "surya@uktextile.com",
                "phone": "9876543210",
                "role": "QC Supervisor",
                "department": dept,
                "salary_type": "monthly",
                "salary_amount": Decimal("25000.00"),
                "status": "active",
                "join_date": "2026-01-01"
            }
        )
        if created1:
            self.stdout.write("Created employee: SURYA M")

        # 2. AKILAN Y (Monthly staff)
        emp2, created2 = Employee.objects.get_or_create(
            id=2,
            defaults={
                "employee_code": "2/26",
                "first_name": "AKILAN",
                "last_name": "Y",
                "email": "akilan@uktextile.com",
                "phone": "9876543211",
                "role": "Production Manager",
                "department": dept,
                "salary_type": "monthly",
                "salary_amount": Decimal("35000.00"),
                "status": "active",
                "join_date": "2026-01-01"
            }
        )
        if created2:
            self.stdout.write("Created employee: AKILAN Y")

        # 3. RAJESH A (Weekly worker / tailor)
        emp3, created3 = Employee.objects.get_or_create(
            id=3,
            defaults={
                "employee_code": "3/26",
                "first_name": "RAJESH",
                "last_name": "A",
                "email": "rajesh@uktextile.com",
                "phone": "9876543212",
                "role": "Senior Tailor",
                "department": dept,
                "salary_type": "weekly",
                "salary_amount": Decimal("4500.00"), # Weekly base rate
                "status": "active",
                "join_date": "2026-01-01"
            }
        )
        if created3:
            self.stdout.write("Created employee: RAJESH A")

        employees = [emp1, emp2, emp3]

        # Define 3 months: Feb, Mar, Apr 2026
        months = [
            (2, 2026, date(2026, 2, 1), date(2026, 2, 28)),
            (3, 2026, date(2026, 3, 1), date(2026, 3, 31)),
            (4, 2026, date(2026, 4, 1), date(2026, 4, 30)),
        ]

        # Clear existing attendance/salaries for these months to prevent duplicate keys or bloated data
        for month, year, _, _ in months:
            Attendance.objects.filter(date__startswith=f"{year}-{month:02d}").delete()
            SalaryRecord.objects.filter(month=month, year=year).delete()

        # Generate attendance records
        attendance_to_create = []

        for emp in employees:
            # We want slightly different attendance patterns for each employee to look organic
            # Set random seed to make runs reproducible but organic
            random.seed(emp.id)

            for month_num, year, start_date, end_date in months:
                curr_date = start_date
                while curr_date <= end_date:
                    # Exclude Sundays (weekday == 6 in python)
                    if curr_date.weekday() != 6:
                        # 90-95% chance of being present
                        present = random.random() < 0.93
                        hours_worked = Decimal("8.00") if present else Decimal("0.00")
                        notes = "Regular shift" if present else "Absent"

                        attendance_to_create.append(Attendance(
                            employee=emp,
                            date=curr_date.strftime("%Y-%m-%d"),
                            present=present,
                            hours_worked=hours_worked,
                            notes=notes
                        ))
                    curr_date += timedelta(days=1)

        Attendance.objects.bulk_create(attendance_to_create)
        self.stdout.write(f"Generated {len(attendance_to_create)} attendance logs for Feb, Mar, Apr 2026.")

        if options.get("generate_payroll"):
            # Calculate and generate salaries for each month
            for month_num, year, _, _ in months:
                prefix = f"{year}-{month_num:02d}"
                for emp in employees:
                    # Count present days for this employee in this month
                    present_days = Attendance.objects.filter(
                        employee=emp,
                        date__startswith=prefix,
                        present=True
                    ).count()

                    total_working_days = Attendance.objects.filter(
                        employee=emp,
                        date__startswith=prefix
                    ).count()

                    if emp.salary_type == "monthly":
                        # Formula: (Salary / 26 days) * Present Days
                        per_day = emp.salary_amount / Decimal("26.00")
                        calculated_amount = per_day * Decimal(present_days)
                        notes = f"Auto-calculated: worked {present_days}/{total_working_days} days. Monthly Base: ₹{emp.salary_amount:,.2f}"
                    else: # weekly worker
                        # Formula: (Weekly Rate / 6 days) * Present Days in the month
                        per_day = emp.salary_amount / Decimal("6.00")
                        calculated_amount = per_day * Decimal(present_days)
                        notes = f"Auto-calculated: worked {present_days}/{total_working_days} days. Weekly Base: ₹{emp.salary_amount:,.2f}"

                    # Round calculation to 2 decimal places
                    calculated_amount = calculated_amount.quantize(Decimal("0.01"))

                    # Determine payment status:
                    # Let's mark Feb and Mar as "paid", and Apr as "pending"
                    status = "paid" if month_num < 4 else "pending"

                    SalaryRecord.objects.create(
                        employee=emp,
                        month=month_num,
                        year=year,
                        amount=calculated_amount,
                        type=emp.salary_type,
                        status=status,
                        notes=notes
                    )
                    self.stdout.write(f"Generated salary for {emp.first_name}: {month_num}/{year} - INR {calculated_amount} ({status})")

            self.stdout.write(self.style.SUCCESS("Successfully seeded 3 months of attendance and payroll!"))
        else:
            self.stdout.write(self.style.SUCCESS("Successfully seeded 3 months of attendance without payroll generation. Use --generate-payroll to create salary records."))
