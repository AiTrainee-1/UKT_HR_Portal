"""
Migration 0003: Add all enterprise HR & ERP models.

New tables:
  branches, designations, shift_templates, employee_shift_assignments,
  leave_types, leave_balances, holidays, employee_requests,
  payroll_runs, earning_items, deduction_items,
  advances, advance_repayments, salary_slips,
  roles, hr_users, audit_logs

Modified tables:
  employees  — added gender, date_of_birth, emergency_contact, photo_url,
               employment_type, designation_id, branch_id, reporting_manager_id,
               probation_end_date, confirmation_date, uan_number
  departments — added branch_id FK
"""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0002_sessionconfig_attendancelog_worksession_payroll"),
    ]

    operations = [
        # ── branches ────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Branch",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.TextField()),
                ("location", models.TextField(blank=True, null=True)),
                ("address", models.TextField(blank=True, null=True)),
                ("manager_name", models.TextField(blank=True, db_column="manager_name", null=True)),
                ("phone", models.TextField(blank=True, null=True)),
                ("is_active", models.BooleanField(db_column="is_active", default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
            ],
            options={"db_table": "branches"},
        ),

        # ── add branch FK to departments ─────────────────────────────────
        migrations.AddField(
            model_name="department",
            name="branch",
            field=models.ForeignKey(
                blank=True, db_column="branch_id", null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="departments", to="api.branch",
            ),
        ),

        # ── designations ────────────────────────────────────────────────
        migrations.CreateModel(
            name="Designation",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("title", models.TextField()),
                ("level", models.TextField(default="staff")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("department", models.ForeignKey(
                    blank=True, db_column="department_id", null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="designations", to="api.department",
                )),
            ],
            options={"db_table": "designations"},
        ),

        # ── extend employees table ────────────────────────────────────────
        migrations.AddField(model_name="employee", name="gender", field=models.TextField(blank=True, choices=[("male","Male"),("female","Female"),("other","Other")], null=True)),
        migrations.AddField(model_name="employee", name="date_of_birth", field=models.DateField(blank=True, db_column="date_of_birth", null=True)),
        migrations.AddField(model_name="employee", name="emergency_contact", field=models.TextField(blank=True, db_column="emergency_contact", null=True)),
        migrations.AddField(model_name="employee", name="photo_url", field=models.TextField(blank=True, db_column="photo_url", null=True)),
        migrations.AddField(model_name="employee", name="uan_number", field=models.TextField(blank=True, db_column="uan_number", null=True)),
        migrations.AddField(model_name="employee", name="employment_type", field=models.TextField(choices=[("production","Production"),("staff","Staff")], db_column="employment_type", default="staff")),
        migrations.AddField(model_name="employee", name="probation_end_date", field=models.DateField(blank=True, db_column="probation_end_date", null=True)),
        migrations.AddField(model_name="employee", name="confirmation_date", field=models.DateField(blank=True, db_column="confirmation_date", null=True)),
        migrations.AddField(
            model_name="employee", name="designation",
            field=models.ForeignKey(blank=True, db_column="designation_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="employees", to="api.designation"),
        ),
        migrations.AddField(
            model_name="employee", name="branch",
            field=models.ForeignKey(blank=True, db_column="branch_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="employees", to="api.branch"),
        ),
        migrations.AddField(
            model_name="employee", name="reporting_manager",
            field=models.ForeignKey(blank=True, db_column="reporting_manager_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="subordinates", to="api.employee"),
        ),

        # ── shift_templates ──────────────────────────────────────────────
        migrations.CreateModel(
            name="ShiftTemplate",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.TextField()),
                ("shift_type", models.TextField(choices=[("production","Production"),("staff","Staff")], db_column="shift_type", default="staff")),
                ("start_time", models.TimeField(db_column="start_time")),
                ("end_time", models.TimeField(db_column="end_time")),
                ("gender_rule", models.TextField(choices=[("all","All"),("male","Male Only"),("female","Female Only")], db_column="gender_rule", default="all")),
                ("grace_period_minutes", models.IntegerField(db_column="grace_period_minutes", default=15)),
                ("is_default", models.BooleanField(db_column="is_default", default=False)),
                ("is_active", models.BooleanField(db_column="is_active", default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("department", models.ForeignKey(blank=True, db_column="department_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="shifts", to="api.department")),
            ],
            options={"db_table": "shift_templates"},
        ),

        # ── employee_shift_assignments ───────────────────────────────────
        migrations.CreateModel(
            name="EmployeeShiftAssignment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("effective_from", models.DateField(db_column="effective_from")),
                ("effective_to", models.DateField(blank=True, db_column="effective_to", null=True)),
                ("assigned_by", models.TextField(blank=True, db_column="assigned_by", null=True)),
                ("notes", models.TextField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="shift_assignments", to="api.employee")),
                ("shift", models.ForeignKey(db_column="shift_id", on_delete=django.db.models.deletion.CASCADE, related_name="assignments", to="api.shifttemplate")),
            ],
            options={"db_table": "employee_shift_assignments"},
        ),

        # ── leave_types ──────────────────────────────────────────────────
        migrations.CreateModel(
            name="LeaveType",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.TextField()),
                ("code", models.TextField(unique=True)),
                ("max_days_per_year", models.IntegerField(db_column="max_days_per_year", default=12)),
                ("carry_forward", models.BooleanField(db_column="carry_forward", default=False)),
                ("max_carry_forward_days", models.IntegerField(db_column="max_carry_forward_days", default=0)),
                ("is_paid", models.BooleanField(db_column="is_paid", default=True)),
                ("applicable_gender", models.TextField(db_column="applicable_gender", default="all")),
                ("is_active", models.BooleanField(db_column="is_active", default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
            ],
            options={"db_table": "leave_types"},
        ),

        # ── leave_balances ───────────────────────────────────────────────
        migrations.CreateModel(
            name="LeaveBalance",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("year", models.IntegerField()),
                ("allocated", models.DecimalField(decimal_places=1, default=0, max_digits=5)),
                ("used", models.DecimalField(decimal_places=1, default=0, max_digits=5)),
                ("remaining", models.DecimalField(decimal_places=1, default=0, max_digits=5)),
                ("carried_forward", models.DecimalField(db_column="carried_forward", decimal_places=1, default=0, max_digits=5)),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="leave_balances", to="api.employee")),
                ("leave_type", models.ForeignKey(db_column="leave_type_id", on_delete=django.db.models.deletion.CASCADE, related_name="balances", to="api.leavetype")),
            ],
            options={"db_table": "leave_balances", "unique_together": {("employee", "leave_type", "year")}},
        ),

        # ── holidays ─────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Holiday",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.TextField()),
                ("date", models.DateField()),
                ("holiday_type", models.TextField(choices=[("national","National"),("regional","Regional"),("company","Company")], db_column="holiday_type", default="national")),
                ("is_recurring", models.BooleanField(db_column="is_recurring", default=False)),
                ("description", models.TextField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("branch", models.ForeignKey(blank=True, db_column="branch_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="holidays", to="api.branch")),
                ("department", models.ForeignKey(blank=True, db_column="department_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="holidays", to="api.department")),
            ],
            options={"db_table": "holidays"},
        ),

        # ── employee_requests ────────────────────────────────────────────
        migrations.CreateModel(
            name="EmployeeRequest",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("request_type", models.TextField(choices=[("leave","Leave Request"),("salary_enquiry","Salary Enquiry"),("shift_correction","Shift Correction"),("advance","Advance Request"),("permission","Permission Request"),("general","General Query")], db_column="request_type")),
                ("subject", models.TextField()),
                ("description", models.TextField()),
                ("status", models.TextField(choices=[("pending","Pending"),("in_review","In Review"),("approved","Approved"),("rejected","Rejected"),("more_info","More Info Needed")], default="pending")),
                ("hr_notes", models.TextField(blank=True, db_column="hr_notes", null=True)),
                ("handled_by", models.TextField(blank=True, db_column="handled_by", null=True)),
                ("handled_at", models.DateTimeField(blank=True, db_column="handled_at", null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="requests", to="api.employee")),
            ],
            options={"db_table": "employee_requests"},
        ),

        # ── payroll_runs ─────────────────────────────────────────────────
        migrations.CreateModel(
            name="PayrollRun",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("run_code", models.TextField(db_column="run_code", unique=True)),
                ("month", models.IntegerField()),
                ("year", models.IntegerField()),
                ("run_type", models.TextField(choices=[("monthly","Monthly"),("biweekly","Bi-Weekly")], db_column="run_type", default="monthly")),
                ("week_number", models.IntegerField(blank=True, db_column="week_number", null=True)),
                ("status", models.TextField(choices=[("draft","Draft"),("processing","Processing"),("approved","Approved"),("locked","Locked")], default="draft")),
                ("total_employees", models.IntegerField(db_column="total_employees", default=0)),
                ("total_gross", models.DecimalField(db_column="total_gross", decimal_places=2, default=0, max_digits=12)),
                ("total_deductions", models.DecimalField(db_column="total_deductions", decimal_places=2, default=0, max_digits=12)),
                ("total_net", models.DecimalField(db_column="total_net", decimal_places=2, default=0, max_digits=12)),
                ("processed_by", models.TextField(blank=True, db_column="processed_by", null=True)),
                ("approved_by", models.TextField(blank=True, db_column="approved_by", null=True)),
                ("approved_at", models.DateTimeField(blank=True, db_column="approved_at", null=True)),
                ("locked_at", models.DateTimeField(blank=True, db_column="locked_at", null=True)),
                ("notes", models.TextField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
            ],
            options={"db_table": "payroll_runs"},
        ),

        # ── earning_items & deduction_items ───────────────────────────────
        migrations.CreateModel(
            name="EarningItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("item_type", models.TextField(choices=[("basic","Basic Salary"),("hra","HRA"),("allowance","Allowance"),("incentive","Incentive"),("bonus","Bonus"),("ot","Overtime"),("session","Session Pay")], db_column="item_type")),
                ("label", models.TextField()),
                ("amount", models.DecimalField(decimal_places=2, max_digits=10)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="earnings", to="api.employee")),
                ("payroll_run", models.ForeignKey(db_column="payroll_run_id", on_delete=django.db.models.deletion.CASCADE, related_name="earnings", to="api.payrollrun")),
            ],
            options={"db_table": "earning_items"},
        ),
        migrations.CreateModel(
            name="DeductionItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("item_type", models.TextField(choices=[("pf","Provident Fund"),("esi","ESI"),("advance","Advance Recovery"),("loan","Loan Recovery"),("penalty","Penalty"),("other","Other Deduction")], db_column="item_type")),
                ("label", models.TextField()),
                ("amount", models.DecimalField(decimal_places=2, max_digits=10)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="deductions", to="api.employee")),
                ("payroll_run", models.ForeignKey(db_column="payroll_run_id", on_delete=django.db.models.deletion.CASCADE, related_name="deductions", to="api.payrollrun")),
            ],
            options={"db_table": "deduction_items"},
        ),

        # ── advances & repayments ─────────────────────────────────────────
        migrations.CreateModel(
            name="Advance",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("advance_type", models.TextField(choices=[("general","General Advance"),("term","Term Advance (Loan)")], db_column="advance_type")),
                ("amount", models.DecimalField(decimal_places=2, max_digits=10)),
                ("purpose", models.TextField(blank=True, null=True)),
                ("status", models.TextField(choices=[("pending","Pending"),("approved","Approved"),("rejected","Rejected"),("closed","Closed")], default="pending")),
                ("approved_by", models.TextField(blank=True, db_column="approved_by", null=True)),
                ("approved_at", models.DateTimeField(blank=True, db_column="approved_at", null=True)),
                ("disbursed_at", models.DateTimeField(blank=True, db_column="disbursed_at", null=True)),
                ("repayment_start_month", models.IntegerField(blank=True, db_column="repayment_start_month", null=True)),
                ("repayment_start_year", models.IntegerField(blank=True, db_column="repayment_start_year", null=True)),
                ("emi_amount", models.DecimalField(db_column="emi_amount", decimal_places=2, default=0, max_digits=10)),
                ("total_repaid", models.DecimalField(db_column="total_repaid", decimal_places=2, default=0, max_digits=10)),
                ("outstanding", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("notes", models.TextField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="advances", to="api.employee")),
            ],
            options={"db_table": "advances"},
        ),
        migrations.CreateModel(
            name="AdvanceRepayment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("month", models.IntegerField()),
                ("year", models.IntegerField()),
                ("amount", models.DecimalField(decimal_places=2, max_digits=10)),
                ("notes", models.TextField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("advance", models.ForeignKey(db_column="advance_id", on_delete=django.db.models.deletion.CASCADE, related_name="repayments", to="api.advance")),
                ("payroll_run", models.ForeignKey(blank=True, db_column="payroll_run_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="advance_repayments", to="api.payrollrun")),
            ],
            options={"db_table": "advance_repayments"},
        ),

        # ── salary_slips ─────────────────────────────────────────────────
        migrations.CreateModel(
            name="SalarySlip",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("month", models.IntegerField()),
                ("year", models.IntegerField()),
                ("slip_number", models.TextField(db_column="slip_number", unique=True)),
                ("basic", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("hra", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("allowances", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("incentives", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("bonuses", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                ("ot_amount", models.DecimalField(db_column="ot_amount", decimal_places=2, default=0, max_digits=10)),
                ("gross_salary", models.DecimalField(db_column="gross_salary", decimal_places=2, default=0, max_digits=10)),
                ("pf_deduction", models.DecimalField(db_column="pf_deduction", decimal_places=2, default=0, max_digits=10)),
                ("esi_deduction", models.DecimalField(db_column="esi_deduction", decimal_places=2, default=0, max_digits=10)),
                ("advance_deduction", models.DecimalField(db_column="advance_deduction", decimal_places=2, default=0, max_digits=10)),
                ("other_deductions", models.DecimalField(db_column="other_deductions", decimal_places=2, default=0, max_digits=10)),
                ("total_deductions", models.DecimalField(db_column="total_deductions", decimal_places=2, default=0, max_digits=10)),
                ("net_salary", models.DecimalField(db_column="net_salary", decimal_places=2, default=0, max_digits=10)),
                ("working_days", models.IntegerField(db_column="working_days", default=0)),
                ("present_days", models.DecimalField(db_column="present_days", decimal_places=1, default=0, max_digits=4)),
                ("absent_days", models.DecimalField(db_column="absent_days", decimal_places=1, default=0, max_digits=4)),
                ("generated_at", models.DateTimeField(auto_now_add=True, db_column="generated_at")),
                ("emailed_at", models.DateTimeField(blank=True, db_column="emailed_at", null=True)),
                ("employee", models.ForeignKey(db_column="employee_id", on_delete=django.db.models.deletion.CASCADE, related_name="salary_slips", to="api.employee")),
                ("payroll_run", models.ForeignKey(blank=True, db_column="payroll_run_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="salary_slips", to="api.payrollrun")),
            ],
            options={"db_table": "salary_slips", "unique_together": {("employee", "month", "year")}},
        ),

        # ── roles ─────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="Role",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.TextField(unique=True)),
                ("description", models.TextField(blank=True, null=True)),
                ("permissions", models.JSONField(default=dict)),
                ("is_system", models.BooleanField(db_column="is_system", default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
            ],
            options={"db_table": "roles"},
        ),

        # ── hr_users ──────────────────────────────────────────────────────
        migrations.CreateModel(
            name="HRUser",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("username", models.TextField(unique=True)),
                ("email", models.TextField(blank=True, null=True)),
                ("full_name", models.TextField(blank=True, db_column="full_name", null=True)),
                ("password_hash", models.TextField(db_column="password_hash")),
                ("is_active", models.BooleanField(db_column="is_active", default=True)),
                ("is_super_admin", models.BooleanField(db_column="is_super_admin", default=False)),
                ("last_login", models.DateTimeField(blank=True, db_column="last_login", null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
                ("updated_at", models.DateTimeField(auto_now=True, db_column="updated_at")),
                ("branch", models.ForeignKey(blank=True, db_column="branch_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="hr_users", to="api.branch")),
                ("department", models.ForeignKey(blank=True, db_column="department_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="hr_users", to="api.department")),
                ("role", models.ForeignKey(blank=True, db_column="role_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="users", to="api.role")),
            ],
            options={"db_table": "hr_users"},
        ),

        # ── audit_logs ────────────────────────────────────────────────────
        migrations.CreateModel(
            name="AuditLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("user_type", models.TextField(db_column="user_type", default="hr")),
                ("user_id", models.IntegerField(blank=True, db_column="user_id", null=True)),
                ("user_name", models.TextField(db_column="user_name")),
                ("action", models.TextField(choices=[("login","Login"),("logout","Logout"),("create","Create"),("update","Update"),("delete","Delete"),("approve","Approve"),("reject","Reject"),("export","Export"),("lock","Lock")])),
                ("module", models.TextField()),
                ("record_id", models.IntegerField(blank=True, db_column="record_id", null=True)),
                ("record_description", models.TextField(blank=True, db_column="record_description", null=True)),
                ("old_values", models.JSONField(blank=True, db_column="old_values", null=True)),
                ("new_values", models.JSONField(blank=True, db_column="new_values", null=True)),
                ("ip_address", models.TextField(blank=True, db_column="ip_address", null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_column="created_at")),
            ],
            options={"db_table": "audit_logs", "ordering": ["-created_at"]},
        ),

        # ── update leave_requests table (add new FK, total_days) ──────────
        migrations.AddField(
            model_name="leaverequest",
            name="leave_type_ref",
            field=models.ForeignKey(blank=True, db_column="leave_type_ref_id", null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="requests", to="api.leavetype"),
        ),
        migrations.AddField(
            model_name="leaverequest",
            name="total_days",
            field=models.DecimalField(db_column="total_days", decimal_places=1, default=1, max_digits=4),
        ),
        migrations.AddField(
            model_name="leaverequest",
            name="approved_by",
            field=models.TextField(blank=True, db_column="approved_by", null=True),
        ),
    ]
